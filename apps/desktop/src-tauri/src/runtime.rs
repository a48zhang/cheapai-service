//! Owns the Runtime sidecar and its private control pipe.
//!
//! Renderer-facing DSH calls and stream frames are endpoint- and
//! generation-scoped. Loopback URLs and the process-bound DSH cookie stay in
//! Runtime responses handled within this module.

use std::{
    collections::HashMap,
    fs,
    path::{Component, Path, PathBuf},
    process::{ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{oneshot, Mutex, RwLock},
    time::{sleep, timeout},
};

use crate::protocol::{
    self, DshLifecycleSnapshot, DshLifecycleState, DshStreamFrame, PublicDshLifecycleSnapshot,
    RuntimeEvent, RuntimeMessage, RuntimeName, RuntimeResponse, RuntimeSource,
};

const RUNTIME_BOOTSTRAP_TIMEOUT: Duration = Duration::from_secs(15);
const RUNTIME_REQUEST_TIMEOUT: Duration = Duration::from_secs(35);
const RUNTIME_STOP_REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
const RUNTIME_EXIT_GRACE: Duration = Duration::from_secs(8);
const RUNTIME_KILL_GRACE: Duration = Duration::from_secs(1);
const DSH_TERMINATION_GRACE: Duration = Duration::from_millis(250);
const RUNTIME_STATUS_EVENT: &str = "desktop-runtime-status";
const DSH_STREAM_EVENT: &str = "desktop-dsh-stream";
const MAX_CONTROL_LINE_BYTES: usize = 1024 * 1024;
const MAX_ACTIVE_DSH_STREAMS: usize = 64;

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RuntimeProcessState {
    Starting,
    Ready,
    Failed,
    Stopped,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimePublicStatus {
    pub(crate) process: RuntimeProcessState,
    pub(crate) dsh: PublicDshLifecycleSnapshot,
    pub(crate) connection: Option<NativeConnectionDescription>,
    pub(crate) active_task_count: u64,
    pub(crate) activity_known: bool,
    pub(crate) problem: Option<RuntimePublicProblem>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeConnectionDescription {
    /// DSH traffic must go through the native IPC transport.
    pub(crate) transport: &'static str,
    pub(crate) generation: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimePublicProblem {
    pub(crate) code: String,
    pub(crate) message: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeHostError {
    pub(crate) code: String,
    pub(crate) message: &'static str,
}

impl NativeHostError {
    pub(crate) fn new(code: impl Into<String>, message: &'static str) -> Self {
        Self {
            code: code.into(),
            message,
        }
    }

    fn unavailable() -> Self {
        Self::new("runtime-unavailable", "The local Runtime is unavailable")
    }

    fn protocol() -> Self {
        Self::new("runtime-protocol-error", "The local Runtime returned an invalid response")
    }

    fn stale_connection() -> Self {
        Self::new("dsh-generation-stale", "The DSH connection has changed")
    }

    fn invalid_transport_request() -> Self {
        Self::new("dsh-transport-refused", "The DSH transport request is not allowed")
    }

    fn host_shutting_down() -> Self {
        Self::new("runtime-shutting-down", "The local Runtime is shutting down")
    }

    fn restart_failed() -> Self {
        Self::new("runtime-restart-failed", "The local Runtime could not be restarted")
    }

    fn shutdown_failed() -> Self {
        Self::new("runtime-shutdown-failed", "The local Runtime could not stop safely")
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DshTransportStreamResponse {
    pub(crate) generation: u64,
    pub(crate) stream_id: String,
}

#[derive(Clone)]
pub(crate) struct RuntimeHost {
    inner: Arc<RuntimeHostInner>,
}

struct RuntimeHostInner {
    status: RwLock<RuntimePublicStatus>,
    child: Mutex<Option<(u64, Child)>>,
    stdin: Mutex<Option<ChildStdin>>,
    owned_dsh_process: Mutex<Option<OwnedDshProcess>>,
    dsh_cleanup_operation: Mutex<()>,
    dsh_generation_binding: Mutex<Option<DshGenerationBinding>>,
    next_public_generation: AtomicU64,
    pending: Mutex<HashMap<String, PendingRuntimeRequest>>,
    streams: Mutex<HashMap<String, ActiveDshStream>>,
    bootstrap_waiter: Mutex<Option<(u64, oneshot::Sender<Result<(), NativeHostError>>)>>,
    expected_startup: Mutex<Option<(u64, RuntimeSource, RuntimeName)>>,
    lifecycle_operation: Mutex<()>,
    request_sequence: AtomicU64,
    process_epoch: AtomicU64,
    launch_started: AtomicBool,
    intentional_shutdown: AtomicBool,
    process_ended: AtomicBool,
    close_confirmation_open: AtomicBool,
}

#[derive(Clone, Copy)]
struct DshGenerationBinding {
    process_epoch: u64,
    runtime_generation: u64,
    public_generation: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct OwnedDshProcess {
    process_epoch: u64,
    runtime_generation: u64,
    process_id: u32,
}

struct PendingRuntimeRequest {
    process_epoch: u64,
    generation: Option<u64>,
    sender: oneshot::Sender<Result<Value, NativeHostError>>,
}

struct ActiveDshStream {
    generation: u64,
    last_sequence: Option<u64>,
    uplink_ended: bool,
    uplink_ending: bool,
}

impl RuntimeHost {
    pub(crate) fn new() -> Self {
        Self {
            inner: Arc::new(RuntimeHostInner {
                status: RwLock::new(initial_status()),
                child: Mutex::new(None),
                stdin: Mutex::new(None),
                owned_dsh_process: Mutex::new(None),
                dsh_cleanup_operation: Mutex::new(()),
                dsh_generation_binding: Mutex::new(None),
                next_public_generation: AtomicU64::new(1),
                pending: Mutex::new(HashMap::new()),
                streams: Mutex::new(HashMap::new()),
                bootstrap_waiter: Mutex::new(None),
                expected_startup: Mutex::new(None),
                lifecycle_operation: Mutex::new(()),
                request_sequence: AtomicU64::new(1),
                process_epoch: AtomicU64::new(0),
                launch_started: AtomicBool::new(false),
                intentional_shutdown: AtomicBool::new(false),
                process_ended: AtomicBool::new(false),
                close_confirmation_open: AtomicBool::new(false),
            }),
        }
    }

    /// Start exactly one application-owned Runtime and wait for its private
    /// control channel to acknowledge the startup event.
    pub(crate) async fn launch(&self, app: AppHandle) {
        let _lifecycle = self.inner.lifecycle_operation.lock().await;
        self.launch_runtime(app).await;
    }

    async fn launch_runtime(&self, app: AppHandle) {
        if self.inner.intentional_shutdown.load(Ordering::SeqCst) {
            return;
        }
        if self.inner.launch_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let epoch = {
            let mut status = self.inner.status.write().await;
            let epoch = self.inner.process_epoch.fetch_add(1, Ordering::SeqCst) + 1;
            self.inner.process_ended.store(false, Ordering::SeqCst);
            status.process = RuntimeProcessState::Starting;
            status.connection = None;
            status.active_task_count = 0;
            status.activity_known = false;
            status.problem = None;
            status.dsh.state = DshLifecycleState::Stopped;
            status.dsh.stage = None;
            status.dsh.failure = None;
            epoch
        };
        emit_status(&self.inner, &app).await;

        let spec = match RuntimeLaunchSpec::resolve(&app) {
            Ok(spec) => spec,
            Err(code) => {
                self.fail_launch(code, &app, epoch).await;
                return;
            }
        };
        *self.inner.expected_startup.lock().await = Some((epoch, spec.source, spec.runtime));

        let mut command = Command::new(&spec.executable);
        if spec.source == RuntimeSource::Development && spec.runtime == RuntimeName::Node {
            command.arg("--experimental-transform-types");
        }
        command
            .arg(&spec.entry)
            .current_dir(&spec.current_directory)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(resource_directory) = spec.resource_directory.as_ref() {
            command.env("SUB2API_DSH_RESOURCE_DIRECTORY", resource_directory);
            command.env("SUB2API_DSH_RUNTIME_EXECUTABLE", &spec.executable);
        }
        command.env("SUB2API_DSH_HOME", &spec.dsh_home);
        command.env(
            "SUB2API_DSH_WORKSPACE_DIRECTORY",
            &spec.workspace_directory,
        );

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(_) => {
                self.fail_launch("runtime-launch-failed", &app, epoch).await;
                return;
            }
        };
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        if stdin.is_none() || stdout.is_none() || stderr.is_none() {
            let _ = child.start_kill();
            let _ = timeout(RUNTIME_KILL_GRACE, child.wait()).await;
            self.fail_launch("runtime-pipe-failed", &app, epoch).await;
            return;
        }
        if self.inner.intentional_shutdown.load(Ordering::SeqCst) {
            let _ = child.start_kill();
            let _ = child.wait().await;
            return;
        }
        *self.inner.child.lock().await = Some((epoch, child));
        *self.inner.stdin.lock().await = stdin;
        if self.inner.intentional_shutdown.load(Ordering::SeqCst) {
            self.stop_and_reap_runtime(&app).await;
            return;
        }

        let (bootstrap_sender, bootstrap_receiver) = oneshot::channel();
        *self.inner.bootstrap_waiter.lock().await = Some((epoch, bootstrap_sender));

        let stdout = stdout.expect("the Runtime was checked to have stdout");
        let stderr = stderr.expect("the Runtime was checked to have stderr");
        tokio::spawn(read_runtime_stdout(
            stdout,
            self.inner.clone(),
            app.clone(),
            epoch,
        ));
        tokio::spawn(discard_runtime_stderr(stderr));
        tokio::spawn(monitor_runtime_process(
            self.inner.clone(),
            app.clone(),
            epoch,
        ));

        if self
            .write_line_for_epoch(&protocol::encode_startup(spec.source, spec.runtime), epoch, false)
            .await
            .is_err()
        {
            if !self.inner.intentional_shutdown.load(Ordering::SeqCst) {
                self.fail_process("runtime-control-pipe-failed", &app, epoch).await;
            }
            return;
        }

        match timeout(RUNTIME_BOOTSTRAP_TIMEOUT, bootstrap_receiver).await {
            Ok(Ok(Ok(()))) => self
                .update_process_state(RuntimeProcessState::Ready, None, &app, epoch)
                .await,
            Ok(Ok(Err(error))) if !self.inner.intentional_shutdown.load(Ordering::SeqCst) => {
                self.fail_launch(error.code, &app, epoch).await
            }
            Ok(Err(_)) if !self.inner.intentional_shutdown.load(Ordering::SeqCst) => {
                self.fail_process("runtime-bootstrap-lost", &app, epoch).await
            }
            Err(_) if !self.inner.intentional_shutdown.load(Ordering::SeqCst) => {
                self.fail_process("runtime-bootstrap-timeout", &app, epoch).await
            }
            _ => {}
        }
    }

    pub(crate) async fn start_dsh(
        &self,
        app: &AppHandle,
    ) -> Result<RuntimePublicStatus, NativeHostError> {
        let epoch = self.inner.process_epoch.load(Ordering::SeqCst);
        let response = self.request("start", RUNTIME_REQUEST_TIMEOUT).await?;
        let (snapshot, has_connection) = protocol::lifecycle_result(response, "started")
            .map_err(|_| NativeHostError::protocol())?;
        self.update_dsh_status(snapshot, has_connection, app, epoch).await;
        Ok(self.snapshot().await)
    }

    pub(crate) async fn stop_dsh(
        &self,
        app: &AppHandle,
    ) -> Result<RuntimePublicStatus, NativeHostError> {
        let epoch = self.inner.process_epoch.load(Ordering::SeqCst);
        let response = self
            .request("stop", RUNTIME_STOP_REQUEST_TIMEOUT)
            .await?;
        let (snapshot, _) = protocol::lifecycle_result(response, "stopped")
            .map_err(|_| NativeHostError::protocol())?;
        self.update_dsh_status(snapshot, false, app, epoch).await;
        Ok(self.snapshot().await)
    }

    pub(crate) async fn query_status(&self, app: &AppHandle) -> RuntimePublicStatus {
        if matches!(
            self.inner.status.read().await.process,
            RuntimeProcessState::Ready
        ) {
            let epoch = self.inner.process_epoch.load(Ordering::SeqCst);
            if let Ok(response) = self
                .request("status", RUNTIME_STOP_REQUEST_TIMEOUT)
                .await
            {
                if let Ok((snapshot, _)) = protocol::lifecycle_result(response, "status") {
                    self.update_dsh_status(snapshot, false, app, epoch).await;
                }
            }
        }
        self.snapshot().await
    }

    pub(crate) async fn set_task_activity(
        &self,
        generation: u64,
        count: u64,
        known: Option<bool>,
        app: &AppHandle,
    ) -> Result<RuntimePublicStatus, NativeHostError> {
        if self.inner.intentional_shutdown.load(Ordering::SeqCst) {
            return Err(NativeHostError::host_shutting_down());
        }
        {
            let mut status = self.inner.status.write().await;
            if !matches!(status.process, RuntimeProcessState::Ready)
                || status.dsh.state != DshLifecycleState::Ready
                || status.dsh.generation != generation
                || status
                    .connection
                    .as_ref()
                    .map_or(true, |connection| connection.generation != generation)
            {
                return Err(NativeHostError::stale_connection());
            }
            if known.unwrap_or(true) {
                status.active_task_count = count;
                status.activity_known = true;
            } else {
                status.activity_known = false;
            }
        }
        emit_status(&self.inner, app).await;
        Ok(self.snapshot().await)
    }

    async fn transport_call(
        &self,
        generation: u64,
        request_id: String,
        channel: String,
        endpoint: String,
        payload: Value,
    ) -> Result<Value, NativeHostError> {
        if !valid_id(&request_id) || !allowed_endpoint("call", &channel, &endpoint) {
            return Err(NativeHostError::invalid_transport_request());
        }
        self.ensure_transport_generation(generation).await?;
        let runtime_generation = runtime_generation_for_public(&self.inner, generation)
            .await
            .ok_or_else(NativeHostError::stale_connection)?;
        let carrier = json!({
            "generation": runtime_generation,
            "requestId": request_id,
            "channel": channel,
            "endpoint": endpoint,
            "payload": payload,
        });
        let response = self
            .request_transport("call", carrier, generation, RUNTIME_REQUEST_TIMEOUT)
            .await?;
        let mut value = transport_value(response)?;
        if value.get("generation").and_then(Value::as_u64) != Some(runtime_generation)
            || value.get("requestId").and_then(Value::as_str) != Some(request_id.as_str())
            || value.get("value").is_none()
        {
            return Err(NativeHostError::protocol());
        }
        if !self.transport_generation_is_current(generation).await {
            return Err(NativeHostError::stale_connection());
        }
        value
            .as_object_mut()
            .ok_or_else(NativeHostError::protocol)?
            .insert("generation".to_owned(), json!(generation));
        Ok(value)
    }

    async fn transport_open(
        &self,
        app: &AppHandle,
        generation: u64,
        stream_id: String,
        channel: String,
        endpoint: String,
        payload: Value,
    ) -> Result<DshTransportStreamResponse, NativeHostError> {
        if !valid_id(&stream_id) || !allowed_endpoint("open", &channel, &endpoint) {
            return Err(NativeHostError::invalid_transport_request());
        }
        self.ensure_transport_generation(generation).await?;
        let runtime_generation = runtime_generation_for_public(&self.inner, generation)
            .await
            .ok_or_else(NativeHostError::stale_connection)?;
        {
            let mut streams = self.inner.streams.lock().await;
            if streams.contains_key(&stream_id) || streams.len() >= MAX_ACTIVE_DSH_STREAMS {
                return Err(NativeHostError::invalid_transport_request());
            }
            streams.insert(
                stream_id.clone(),
                ActiveDshStream {
                    generation,
                    last_sequence: None,
                    uplink_ended: false,
                    uplink_ending: false,
                },
            );
        }

        let carrier = json!({
            "generation": runtime_generation,
            "streamId": stream_id,
            "channel": channel,
            "endpoint": endpoint,
            "payload": payload,
        });
        let response = self
            .request_transport("open", carrier, generation, RUNTIME_REQUEST_TIMEOUT)
            .await;
        let result = match response.and_then(transport_value) {
            Ok(value) if stream_ack_matches(&value, runtime_generation, &stream_id) => Ok(()),
            Ok(_) => Err(NativeHostError::protocol()),
            Err(error) => Err(error),
        };
        if let Err(error) = result {
            if self.transport_generation_is_current(generation).await {
                let cancel = json!({ "generation": runtime_generation, "streamId": stream_id });
                let _ = self
                    .request_transport("cancel", cancel, generation, RUNTIME_STOP_REQUEST_TIMEOUT)
                    .await;
            }
            terminate_stream(&self.inner, app, &stream_id, Some(generation)).await;
            return Err(error);
        }
        if !self.transport_generation_is_current(generation).await {
            terminate_stream(&self.inner, app, &stream_id, Some(generation)).await;
            return Err(NativeHostError::stale_connection());
        }
        Ok(DshTransportStreamResponse {
            generation,
            stream_id,
        })
    }

    async fn transport_uplink(
        &self,
        generation: u64,
        stream_id: String,
        value: Value,
    ) -> Result<DshTransportStreamResponse, NativeHostError> {
        self.ensure_active_stream(generation, &stream_id, false).await?;
        let runtime_generation = runtime_generation_for_public(&self.inner, generation)
            .await
            .ok_or_else(NativeHostError::stale_connection)?;
        let payload = json!({
            "generation": runtime_generation,
            "streamId": stream_id,
            "value": value,
        });
        let response = self
            .request_transport("uplink", payload, generation, RUNTIME_REQUEST_TIMEOUT)
            .await?;
        let ack = transport_value(response)?;
        if !stream_ack_matches(&ack, runtime_generation, &stream_id) {
            return Err(NativeHostError::protocol());
        }
        Ok(DshTransportStreamResponse {
            generation,
            stream_id,
        })
    }

    async fn transport_end(
        &self,
        generation: u64,
        stream_id: String,
    ) -> Result<DshTransportStreamResponse, NativeHostError> {
        self.ensure_active_stream(generation, &stream_id, false).await?;
        let runtime_generation = runtime_generation_for_public(&self.inner, generation)
            .await
            .ok_or_else(NativeHostError::stale_connection)?;
        {
            let mut streams = self.inner.streams.lock().await;
            let stream = streams
                .get_mut(&stream_id)
                .ok_or_else(NativeHostError::stale_connection)?;
            if stream.uplink_ended || stream.uplink_ending {
                return Err(NativeHostError::invalid_transport_request());
            }
            stream.uplink_ending = true;
        }
        let payload = json!({ "generation": runtime_generation, "streamId": stream_id });
        let response = self
            .request_transport("end", payload, generation, RUNTIME_STOP_REQUEST_TIMEOUT)
            .await;
        match response.and_then(transport_value) {
            Ok(ack) if stream_ack_matches(&ack, runtime_generation, &stream_id) => {
                if let Some(stream) = self.inner.streams.lock().await.get_mut(&stream_id) {
                    if stream.generation == generation {
                        stream.uplink_ending = false;
                        stream.uplink_ended = true;
                    }
                }
                Ok(DshTransportStreamResponse {
                    generation,
                    stream_id,
                })
            }
            Ok(_) => {
                clear_stream_ending(&self.inner, generation, &stream_id).await;
                Err(NativeHostError::protocol())
            }
            Err(error) => {
                clear_stream_ending(&self.inner, generation, &stream_id).await;
                Err(error)
            }
        }
    }

    async fn transport_cancel(
        &self,
        app: &AppHandle,
        generation: u64,
        stream_id: String,
    ) -> Result<DshTransportStreamResponse, NativeHostError> {
        self.ensure_active_stream(generation, &stream_id, true).await?;
        let runtime_generation = runtime_generation_for_public(&self.inner, generation)
            .await
            .ok_or_else(NativeHostError::stale_connection)?;
        let payload = json!({ "generation": runtime_generation, "streamId": stream_id });
        let response = self
            .request_transport("cancel", payload, generation, RUNTIME_STOP_REQUEST_TIMEOUT)
            .await?;
        let ack = transport_value(response)?;
        if !stream_ack_matches(&ack, runtime_generation, &stream_id) {
            return Err(NativeHostError::protocol());
        }
        terminate_stream(&self.inner, app, &stream_id, Some(generation)).await;
        Ok(DshTransportStreamResponse {
            generation,
            stream_id,
        })
    }

    /// Explicitly replace a failed or unhealthy Runtime. DSH work is stopped;
    /// no request or task is replayed in the new process.
    pub(crate) async fn restart_runtime(
        &self,
        app: &AppHandle,
    ) -> Result<RuntimePublicStatus, NativeHostError> {
        let _lifecycle = self.inner.lifecycle_operation.lock().await;
        if self.inner.intentional_shutdown.load(Ordering::SeqCst) {
            return Err(NativeHostError::host_shutting_down());
        }

        self.inner
            .intentional_shutdown
            .store(true, Ordering::SeqCst);
        let stopped = self.stop_and_reap_runtime(app).await;
        self.inner.launch_started.store(false, Ordering::SeqCst);
        self.inner.intentional_shutdown.store(false, Ordering::SeqCst);
        stopped.map_err(|_| NativeHostError::restart_failed())?;
        self.launch_runtime(app.clone()).await;

        let status = self.snapshot().await;
        if matches!(status.process, RuntimeProcessState::Ready) {
            Ok(status)
        } else {
            Err(NativeHostError::restart_failed())
        }
    }

    /// Stop DSH through Runtime, close the private pipe, and force-reap the
    /// Runtime after a bounded graceful period.
    pub(crate) async fn shutdown(&self, app: &AppHandle) {
        let _lifecycle = self.inner.lifecycle_operation.lock().await;
        self.inner
            .intentional_shutdown
            .store(true, Ordering::SeqCst);
        let _ = self.stop_and_reap_runtime(app).await;
    }

    /// Stop DSH and the Runtime before a platform updater replaces app files.
    /// The Runtime remains stopped; only an explicit restart launches it again.
    pub(crate) async fn stop_for_update(
        &self,
        app: &AppHandle,
    ) -> Result<(), NativeHostError> {
        let _lifecycle = self.inner.lifecycle_operation.lock().await;
        if self.inner.intentional_shutdown.load(Ordering::SeqCst) {
            return Err(NativeHostError::host_shutting_down());
        }
        self.inner
            .intentional_shutdown
            .store(true, Ordering::SeqCst);
        let result = self.stop_and_reap_runtime(app).await;
        // Failed cleanup leaves the Runtime unavailable, but the user can
        // recover explicitly through runtime_restart rather than being trapped.
        self.inner.launch_started.store(false, Ordering::SeqCst);
        self.inner.intentional_shutdown.store(false, Ordering::SeqCst);
        result
    }

    async fn stop_and_reap_runtime(&self, app: &AppHandle) -> Result<(), NativeHostError> {
        let initial_status = self.snapshot().await;
        let process_epoch = self.inner.process_epoch.load(Ordering::SeqCst);
        let had_owned_dsh = owned_dsh_process_for_epoch(&self.inner, process_epoch)
            .await
            .is_some();
        let dsh_may_be_running = had_owned_dsh
            || matches!(
                initial_status.dsh.state,
                DshLifecycleState::Starting
                    | DshLifecycleState::Ready
                    | DshLifecycleState::Stopping
            );
        let mut dsh_stopped = !dsh_may_be_running;
        if matches!(initial_status.process, RuntimeProcessState::Ready) && dsh_may_be_running {
            if let Ok(response) = self
                .request("stop", RUNTIME_STOP_REQUEST_TIMEOUT)
                .await
            {
                if let Ok((snapshot, _)) = protocol::lifecycle_result(response, "stopped") {
                    self.update_dsh_status(snapshot, false, app, process_epoch)
                        .await;
                    dsh_stopped = matches!(
                        self.inner.status.read().await.dsh.state,
                        DshLifecycleState::Stopped
                    );
                }
            }
        }
        if let Some(mut stdin) = self.inner.stdin.lock().await.take() {
            let _ = stdin.shutdown().await;
        }

        let mut child_guard = self.inner.child.lock().await;
        let mut runtime_reaped = true;
        if let Some((_, child)) = child_guard.as_mut() {
            runtime_reaped = matches!(timeout(RUNTIME_EXIT_GRACE, child.wait()).await, Ok(Ok(_)));
            if !runtime_reaped {
                let _ = child.start_kill();
                runtime_reaped = matches!(
                    timeout(RUNTIME_KILL_GRACE, child.wait()).await,
                    Ok(Ok(_))
                );
            }
        }
        if runtime_reaped {
            child_guard.take();
        }
        drop(child_guard);
        let tree_reaped = terminate_owned_dsh_process(&self.inner, process_epoch).await;
        let remaining_owned_dsh = owned_dsh_process_for_epoch(&self.inner, process_epoch)
            .await
            .is_some();
        let reported_stopped = matches!(
            self.inner.status.read().await.dsh.state,
            DshLifecycleState::Stopped
        ) && !remaining_owned_dsh;
        dsh_stopped |= reported_stopped || (had_owned_dsh && tree_reaped);

        fail_pending(&self.inner, None, NativeHostError::unavailable()).await;
        finish_all_streams(&self.inner, app).await;

        let stopped_safely = {
            let mut status = self.inner.status.write().await;
            apply_shutdown_result(&mut status, runtime_reaped, dsh_stopped)
        };
        emit_status(&self.inner, app).await;
        if stopped_safely {
            Ok(())
        } else {
            Err(NativeHostError::shutdown_failed())
        }
    }

    async fn request(
        &self,
        command: &'static str,
        duration: Duration,
    ) -> Result<Value, NativeHostError> {
        self.request_message(command, None, None, None, duration).await
    }

    async fn request_transport(
        &self,
        operation: &'static str,
        payload: Value,
        generation: u64,
        duration: Duration,
    ) -> Result<Value, NativeHostError> {
        self.request_message(
            "transport",
            Some(operation),
            Some(payload),
            Some(generation),
            duration,
        )
        .await
    }

    /// Account credentials travel only on the native-owned private pipe.
    /// Availability depends on sidecar bootstrap, never on DSH authentication.
    pub(crate) async fn request_account(
        &self,
        operation: &'static str,
        payload: Value,
    ) -> Result<Value, NativeHostError> {
        if !matches!(operation, "login" | "restore" | "getAccount" | "getKey" | "logout") {
            return Err(NativeHostError::new("invalid-account-operation", "Account operation is unavailable"));
        }
        // The window can request restore while startup is still bootstrapping.
        // Wait for the sidecar only; authentication must not depend on DSH ready.
        timeout(RUNTIME_BOOTSTRAP_TIMEOUT, async {
            loop {
                let state = self.inner.status.read().await.process;
                match state {
                    RuntimeProcessState::Ready => return Ok(()),
                    RuntimeProcessState::Starting => sleep(Duration::from_millis(50)).await,
                    _ => return Err(NativeHostError::unavailable()),
                }
            }
        }).await.map_err(|_| NativeHostError::unavailable())??;
        let _lifecycle = self.inner.lifecycle_operation.lock().await;
        let response = self.request_message("account", Some(operation), Some(payload), None, RUNTIME_REQUEST_TIMEOUT).await?;
        if response.get("kind").and_then(Value::as_str) != Some("account") {
            return Err(NativeHostError::new("invalid-account-response", "Account response is invalid"));
        }
        let value = response.get("value").ok_or_else(|| NativeHostError::new("invalid-account-response", "Account response is invalid"))?;
        if value.get("operation").and_then(Value::as_str) != Some(operation) {
            return Err(NativeHostError::new("invalid-account-response", "Account response is invalid"));
        }
        value.get("result").cloned().ok_or_else(|| NativeHostError::new("invalid-account-response", "Account response is invalid"))
    }

    async fn request_message(
        &self,
        command: &'static str,
        operation: Option<&'static str>,
        payload: Option<Value>,
        generation: Option<u64>,
        duration: Duration,
    ) -> Result<Value, NativeHostError> {
        if self.inner.intentional_shutdown.load(Ordering::SeqCst) && command != "stop" {
            return Err(NativeHostError::host_shutting_down());
        }
        if !matches!(
            self.inner.status.read().await.process,
            RuntimeProcessState::Ready
        ) {
            return Err(NativeHostError::unavailable());
        }
        if let Some(generation) = generation {
            self.ensure_transport_generation(generation).await?;
        }

        let process_epoch = self.inner.process_epoch.load(Ordering::SeqCst);
        let sequence = self.inner.request_sequence.fetch_add(1, Ordering::Relaxed);
        let id = format!("native-{}-{sequence}", std::process::id());
        let (sender, receiver) = oneshot::channel();
        self.inner.pending.lock().await.insert(
            id.clone(),
            PendingRuntimeRequest {
                process_epoch,
                generation,
                sender,
            },
        );
        if self.inner.process_epoch.load(Ordering::SeqCst) != process_epoch {
            self.inner.pending.lock().await.remove(&id);
            return Err(NativeHostError::unavailable());
        }
        if let Some(generation) = generation {
            if !self.transport_generation_is_current(generation).await {
                self.inner.pending.lock().await.remove(&id);
                return Err(NativeHostError::stale_connection());
            }
        }
        let line = match (operation, payload) {
            (Some(operation), Some(payload)) if command == "transport" => {
                protocol::encode_transport_request(&id, operation, payload)
            }
            (Some(operation), Some(payload)) if command == "account" => {
                format!("{}\n", json!({"type":"host.request", "id":id, "command":"account", "operation":operation, "payload":payload}))
            }
            (None, None) => protocol::encode_request(&id, command),
            _ => {
                self.inner.pending.lock().await.remove(&id);
                return Err(NativeHostError::invalid_transport_request());
            }
        };
        if self
            .write_line_for_epoch(&line, process_epoch, command == "stop")
            .await
            .is_err()
        {
            self.inner.pending.lock().await.remove(&id);
            return Err(NativeHostError::unavailable());
        }

        match timeout(duration, receiver).await {
            Ok(Ok(Ok(result))) => {
                if let Some(generation) = generation {
                    self.ensure_transport_generation(generation).await?;
                }
                Ok(result)
            }
            Ok(Ok(Err(error))) => Err(error),
            Ok(Err(_)) => Err(NativeHostError::unavailable()),
            Err(_) => {
                self.inner.pending.lock().await.remove(&id);
                Err(NativeHostError::new(
                    "runtime-request-timeout",
                    "The local Runtime did not answer in time",
                ))
            }
        }
    }

    async fn ensure_transport_generation(&self, generation: u64) -> Result<(), NativeHostError> {
        if self.transport_generation_is_current(generation).await {
            Ok(())
        } else {
            Err(NativeHostError::stale_connection())
        }
    }

    async fn transport_generation_is_current(&self, generation: u64) -> bool {
        let status = self.inner.status.read().await;
        !self.inner.intentional_shutdown.load(Ordering::SeqCst)
            && matches!(status.process, RuntimeProcessState::Ready)
            && status.dsh.state == DshLifecycleState::Ready
            && status.dsh.generation == generation
            && status
                .connection
                .as_ref()
                .is_some_and(|connection| connection.generation == generation)
    }

    async fn ensure_active_stream(
        &self,
        generation: u64,
        stream_id: &str,
        allow_uplink_ended: bool,
    ) -> Result<(), NativeHostError> {
        self.ensure_transport_generation(generation).await?;
        let streams = self.inner.streams.lock().await;
        match streams.get(stream_id) {
            Some(stream)
                if stream.generation == generation
                    && (allow_uplink_ended || (!stream.uplink_ended && !stream.uplink_ending)) =>
            {
                Ok(())
            }
            _ => Err(NativeHostError::stale_connection()),
        }
    }

    async fn write_line_for_epoch(
        &self,
        line: &str,
        epoch: u64,
        allow_during_shutdown: bool,
    ) -> Result<(), ()> {
        let mut guard = self.inner.stdin.lock().await;
        if self.inner.process_epoch.load(Ordering::SeqCst) != epoch {
            return Err(());
        }
        if self.inner.intentional_shutdown.load(Ordering::SeqCst) && !allow_during_shutdown {
            return Err(());
        }
        let stdin = guard.as_mut().ok_or(())?;
        stdin.write_all(line.as_bytes()).await.map_err(|_| ())?;
        stdin.flush().await.map_err(|_| ())
    }

    async fn snapshot(&self) -> RuntimePublicStatus {
        self.inner.status.read().await.clone()
    }

    pub(crate) async fn current_status(&self) -> RuntimePublicStatus {
        self.snapshot().await
    }

    pub(crate) async fn active_task_count(&self) -> u64 {
        self.inner.status.read().await.active_task_count
    }

    pub(crate) fn begin_close_confirmation(&self) -> bool {
        self.inner
            .close_confirmation_open
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    pub(crate) fn finish_close_confirmation(&self) {
        self.inner
            .close_confirmation_open
            .store(false, Ordering::SeqCst);
    }

    async fn update_process_state(
        &self,
        process: RuntimeProcessState,
        problem: Option<RuntimePublicProblem>,
        app: &AppHandle,
        epoch: u64,
    ) {
        {
            let mut status = self.inner.status.write().await;
            if self.inner.process_epoch.load(Ordering::SeqCst) != epoch {
                return;
            }
            status.process = process;
            status.problem = problem;
            if !matches!(process, RuntimeProcessState::Ready) {
                status.connection = None;
                status.active_task_count = 0;
                status.activity_known = false;
            }
        }
        emit_status(&self.inner, app).await;
    }

    async fn update_dsh_status(
        &self,
        snapshot: DshLifecycleSnapshot,
        connected: bool,
        app: &AppHandle,
        epoch: u64,
    ) {
        let runtime_generation = snapshot.generation;
        let runtime_state = snapshot.state;
        let process_id = snapshot.process_id;
        let Some(generation) = bind_public_generation(&self.inner, epoch, runtime_generation).await
        else {
            return;
        };
        let mut public: PublicDshLifecycleSnapshot = snapshot.into();
        public.generation = generation;
        let active_generation = {
            let mut status = self.inner.status.write().await;
            if self.inner.process_epoch.load(Ordering::SeqCst) != epoch
                || generation < status.dsh.generation
            {
                return;
            }
            if generation != status.dsh.generation || public.state != DshLifecycleState::Ready {
                status.active_task_count = 0;
                status.activity_known = false;
            }
            let connection = if connected && public.state == DshLifecycleState::Ready {
                Some(NativeConnectionDescription {
                    transport: "tauri-ipc",
                    generation,
                })
            } else if public.state != DshLifecycleState::Ready {
                None
            } else {
                status
                    .connection
                    .take()
                    .filter(|connection| connection.generation == generation)
            };
            status.connection = connection;
            status.dsh = public;
            status.connection.as_ref().map(|connection| connection.generation)
        };
        remember_owned_dsh_process(
            &self.inner,
            epoch,
            runtime_generation,
            runtime_state,
            process_id,
        )
        .await;
        invalidate_transports(&self.inner, app, active_generation).await;
        emit_status(&self.inner, app).await;
    }

    async fn fail_launch(&self, code: &str, app: &AppHandle, epoch: u64) {
        if self.inner.process_epoch.load(Ordering::SeqCst) != epoch {
            return;
        }
        {
            let mut child_guard = self.inner.child.lock().await;
            if let Some((child_epoch, child)) = child_guard.as_mut() {
                if *child_epoch == epoch {
                    let _ = child.start_kill();
                }
            }
        }
        self.update_process_state(
            RuntimeProcessState::Failed,
            Some(RuntimePublicProblem {
                code: safe_code(code),
                message: "The local Runtime could not start",
            }),
            app,
            epoch,
        )
        .await;
        let _ = terminate_owned_dsh_process(&self.inner, epoch).await;
        self.complete_bootstrap(epoch, Err(NativeHostError::new(
            safe_code(code),
            "The local Runtime could not start",
        )))
        .await;
        fail_pending(&self.inner, None, NativeHostError::unavailable()).await;
        finish_all_streams(&self.inner, app).await;
    }

    async fn fail_process(&self, code: &str, app: &AppHandle, epoch: u64) {
        if self.inner.process_epoch.load(Ordering::SeqCst) != epoch
            || self.inner.intentional_shutdown.load(Ordering::SeqCst)
        {
            return;
        }
        self.inner.process_ended.store(true, Ordering::SeqCst);
        {
            let mut child_guard = self.inner.child.lock().await;
            if let Some((child_epoch, child)) = child_guard.as_mut() {
                if *child_epoch == epoch {
                    let _ = child.start_kill();
                }
            }
        }
        {
            let mut status = self.inner.status.write().await;
            if self.inner.process_epoch.load(Ordering::SeqCst) != epoch {
                return;
            }
            status.process = RuntimeProcessState::Failed;
            status.connection = None;
            status.active_task_count = 0;
            status.activity_known = false;
            status.dsh.state = DshLifecycleState::Failed;
            status.dsh.stage = Some("process-exit".to_owned());
            status.dsh.failure = None;
            status.problem = Some(RuntimePublicProblem {
                code: safe_code(code),
                message: "The local Runtime stopped unexpectedly",
            });
        }
        let _ = terminate_owned_dsh_process(&self.inner, epoch).await;
        self.complete_bootstrap(epoch, Err(NativeHostError::new(
            safe_code(code),
            "The local Runtime could not start",
        )))
        .await;
        fail_pending(&self.inner, None, NativeHostError::unavailable()).await;
        finish_all_streams(&self.inner, app).await;
        emit_status(&self.inner, app).await;
    }

    async fn complete_bootstrap(&self, epoch: u64, result: Result<(), NativeHostError>) {
        complete_bootstrap_waiter(&self.inner, epoch, result).await;
    }

}

#[tauri::command]
pub(crate) async fn runtime_start(
    app: AppHandle,
    host: State<'_, RuntimeHost>,
) -> Result<RuntimePublicStatus, NativeHostError> {
    host.start_dsh(&app).await
}

#[tauri::command]
pub(crate) async fn runtime_stop(
    app: AppHandle,
    host: State<'_, RuntimeHost>,
) -> Result<RuntimePublicStatus, NativeHostError> {
    host.stop_dsh(&app).await
}

#[tauri::command]
pub(crate) async fn runtime_status(
    app: AppHandle,
    host: State<'_, RuntimeHost>,
) -> RuntimePublicStatus {
    host.query_status(&app).await
}

#[tauri::command]
pub(crate) async fn runtime_restart(
    app: AppHandle,
    host: State<'_, RuntimeHost>,
) -> Result<RuntimePublicStatus, NativeHostError> {
    host.restart_runtime(&app).await
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn runtime_set_task_activity(
    app: AppHandle,
    host: State<'_, RuntimeHost>,
    generation: u64,
    count: u64,
    known: Option<bool>,
) -> Result<RuntimePublicStatus, NativeHostError> {
    host.set_task_activity(generation, count, known, &app).await
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn dsh_transport_call(
    host: State<'_, RuntimeHost>,
    generation: u64,
    request_id: String,
    channel: String,
    endpoint: String,
    payload: Value,
) -> Result<Value, NativeHostError> {
    host.transport_call(generation, request_id, channel, endpoint, payload)
        .await
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn dsh_transport_open(
    app: AppHandle,
    host: State<'_, RuntimeHost>,
    generation: u64,
    stream_id: String,
    channel: String,
    endpoint: String,
    payload: Value,
) -> Result<DshTransportStreamResponse, NativeHostError> {
    host.transport_open(&app, generation, stream_id, channel, endpoint, payload)
        .await
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn dsh_transport_uplink(
    host: State<'_, RuntimeHost>,
    generation: u64,
    stream_id: String,
    value: Value,
) -> Result<DshTransportStreamResponse, NativeHostError> {
    host.transport_uplink(generation, stream_id, value).await
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn dsh_transport_end(
    host: State<'_, RuntimeHost>,
    generation: u64,
    stream_id: String,
) -> Result<DshTransportStreamResponse, NativeHostError> {
    host.transport_end(generation, stream_id).await
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn dsh_transport_cancel(
    app: AppHandle,
    host: State<'_, RuntimeHost>,
    generation: u64,
    stream_id: String,
) -> Result<DshTransportStreamResponse, NativeHostError> {
    host.transport_cancel(&app, generation, stream_id).await
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':')
        })
}

fn allowed_endpoint(operation: &str, channel: &str, endpoint: &str) -> bool {
    if channel != "/api" {
        return false;
    }
    let unary = match endpoint {
        "session/list"
        | "session/search"
        | "session/create"
        | "session/rename"
        | "session/fork"
        | "session/selectModel"
        | "session/modelCatalog"
        | "session/canOpenWorkspacePath"
        | "session/prompt"
        | "session/attachment"
        | "session/updateQueue"
        | "session/cancel"
        | "session/page"
        | "session/projections"
        | "userQuestions/answer"
        | "$events/result"
        | "workspace/create"
        | "workspace/initializeDefault"
        | "workspace/rename"
        | "workspace/delete"
        | "workspace/insertBefore"
        | "workspace/insertSessionBefore"
        | "workspace/archiveSession"
        | "workspace/unarchiveSession"
        | "workspace/pinSession"
        | "workspace/unpinSession"
        | "workspaceFiles/list"
        | "workspaceFiles/stat" => true,
        _ => false,
    };
    let stream = matches!(
        endpoint,
        "session/follow"
            | "session/control"
            | "$events"
            | "workspace/follow"
            | "workspaceFiles/changes"
            | "userQuestions/attachWait"
    );
    match operation {
        "call" => unary,
        "open" => stream,
        _ => false,
    }
}

fn transport_value(result: Value) -> Result<Value, NativeHostError> {
    let object = result
        .as_object()
        .ok_or_else(NativeHostError::protocol)?;
    if object.get("kind").and_then(Value::as_str) != Some("transport") {
        return Err(NativeHostError::protocol());
    }
    object
        .get("value")
        .cloned()
        .ok_or_else(NativeHostError::protocol)
}

fn stream_ack_matches(value: &Value, generation: u64, stream_id: &str) -> bool {
    value.get("generation").and_then(Value::as_u64) == Some(generation)
        && value.get("streamId").and_then(Value::as_str) == Some(stream_id)
}

async fn clear_stream_ending(inner: &RuntimeHostInner, generation: u64, stream_id: &str) {
    if let Some(stream) = inner.streams.lock().await.get_mut(stream_id) {
        if stream.generation == generation {
            stream.uplink_ending = false;
        }
    }
}

async fn terminate_stream(
    inner: &RuntimeHostInner,
    app: &AppHandle,
    stream_id: &str,
    expected_generation: Option<u64>,
) {
    let terminal = {
        let mut streams = inner.streams.lock().await;
        match streams.get(stream_id) {
            Some(stream)
                if expected_generation.map_or(true, |generation| {
                    generation == stream.generation
                }) => {}
            _ => return,
        }
        streams.remove(stream_id).map(|stream| DshStreamFrame {
            generation: stream.generation,
            stream_id: stream_id.to_owned(),
            sequence: stream.last_sequence.map_or(0, |sequence| sequence.saturating_add(1)),
            value: None,
            error: None,
            done: Some(true),
        })
    };
    if let Some(frame) = terminal {
        let _ = app.emit(DSH_STREAM_EVENT, frame);
    }
}

async fn finish_all_streams(inner: &RuntimeHostInner, app: &AppHandle) {
    let stream_ids: Vec<String> = inner.streams.lock().await.keys().cloned().collect();
    for stream_id in stream_ids {
        terminate_stream(inner, app, &stream_id, None).await;
    }
}

async fn invalidate_transports(
    inner: &RuntimeHostInner,
    app: &AppHandle,
    active_generation: Option<u64>,
) {
    let stale_pending = {
        let mut pending = inner.pending.lock().await;
        let stale_ids: Vec<String> = pending
            .iter()
            .filter_map(|(id, request)| {
                request
                    .generation
                    .filter(|generation| Some(*generation) != active_generation)
                    .map(|_| id.clone())
            })
            .collect();
        stale_ids
            .into_iter()
            .filter_map(|id| pending.remove(&id))
            .collect::<Vec<_>>()
    };
    for request in stale_pending {
        let _ = request.sender.send(Err(NativeHostError::stale_connection()));
    }
    let stale_streams: Vec<String> = inner
        .streams
        .lock()
        .await
        .iter()
        .filter_map(|(id, stream)| {
            (Some(stream.generation) != active_generation).then(|| id.clone())
        })
        .collect();
    for stream_id in stale_streams {
        terminate_stream(inner, app, &stream_id, None).await;
    }
}

async fn fail_pending(
    inner: &RuntimeHostInner,
    generation: Option<u64>,
    error: NativeHostError,
) {
    let failed = {
        let mut pending = inner.pending.lock().await;
        let ids: Vec<String> = pending
            .iter()
            .filter_map(|(id, request)| {
                (generation.is_none() || request.generation == generation).then(|| id.clone())
            })
            .collect();
        ids.into_iter()
            .filter_map(|id| pending.remove(&id))
            .collect::<Vec<_>>()
    };
    for request in failed {
        let _ = request.sender.send(Err(error.clone()));
    }
}

fn initial_status() -> RuntimePublicStatus {
    RuntimePublicStatus {
        process: RuntimeProcessState::Starting,
        dsh: PublicDshLifecycleSnapshot {
            state: DshLifecycleState::Stopped,
            generation: 0,
            stage: None,
            failure: None,
        },
        connection: None,
        active_task_count: 0,
        activity_known: false,
        problem: None,
    }
}

async fn remember_owned_dsh_process(
    inner: &RuntimeHostInner,
    process_epoch: u64,
    runtime_generation: u64,
    state: DshLifecycleState,
    process_id: Option<u32>,
) {
    if inner.process_epoch.load(Ordering::SeqCst) != process_epoch {
        return;
    }
    let mut owned = inner.owned_dsh_process.lock().await;
    if inner.process_epoch.load(Ordering::SeqCst) != process_epoch {
        return;
    }
    let current = *owned;
    if let Some(process_id) = process_id.filter(|pid| *pid > 1) {
        if current.map_or(true, |current| {
            current.process_epoch != process_epoch
                || runtime_generation >= current.runtime_generation
        }) {
            *owned = Some(OwnedDshProcess {
                process_epoch,
                runtime_generation,
                process_id,
            });
        }
        return;
    }
    if current.is_some_and(|current| {
        current.process_epoch == process_epoch
            && (runtime_generation > current.runtime_generation
                || (runtime_generation == current.runtime_generation
                    && matches!(state, DshLifecycleState::Stopped | DshLifecycleState::Failed)))
    }) {
        *owned = None;
    }
}

async fn owned_dsh_process_for_epoch(
    inner: &RuntimeHostInner,
    process_epoch: u64,
) -> Option<OwnedDshProcess> {
    if inner.process_epoch.load(Ordering::SeqCst) != process_epoch {
        return None;
    }
    let owned = *inner.owned_dsh_process.lock().await;
    owned.filter(|owned| owned.process_epoch == process_epoch)
}

async fn terminate_owned_dsh_process(
    inner: &RuntimeHostInner,
    process_epoch: u64,
) -> bool {
    let _cleanup = inner.dsh_cleanup_operation.lock().await;
    if inner.process_epoch.load(Ordering::SeqCst) != process_epoch {
        return true;
    }
    let Some(owned) = owned_dsh_process_for_epoch(inner, process_epoch).await else {
        return true;
    };
    if owned.process_id <= 1 {
        return false;
    }

    #[cfg(unix)]
    let stopped = terminate_unix_process_group(inner, owned).await;
    #[cfg(windows)]
    let stopped = terminate_windows_process_tree(inner, owned).await;
    #[cfg(not(any(unix, windows)))]
    let stopped = false;

    if stopped {
        let mut current = inner.owned_dsh_process.lock().await;
        if *current == Some(owned) {
            *current = None;
        }
    }
    stopped
}

#[cfg(unix)]
async fn terminate_unix_process_group(
    inner: &RuntimeHostInner,
    owned: OwnedDshProcess,
) -> bool {
    if !owned_process_is_current(inner, owned).await {
        return true;
    }
    let target = format!("-{}", owned.process_id);
    let mut probe = Command::new("/bin/kill");
    probe.arg("-0").arg("--").arg(&target);
    match process_group_exists(probe).await {
        Some(false) => return true,
        None => return false,
        Some(true) => {}
    }

    if !owned_process_is_current(inner, owned).await {
        return true;
    }
    let mut terminate = Command::new("/bin/kill");
    terminate.arg("-TERM").arg("--").arg(&target);
    if !matches!(run_cleanup_command(terminate).await, Some(status) if status.success()) {
        return false;
    }
    sleep(DSH_TERMINATION_GRACE).await;
    if !owned_process_is_current(inner, owned).await {
        return true;
    }
    let mut probe = Command::new("/bin/kill");
    probe.arg("-0").arg("--").arg(&target);
    match process_group_exists(probe).await {
        Some(false) => return true,
        None => return false,
        Some(true) => {}
    }
    if !owned_process_is_current(inner, owned).await {
        return true;
    }
    let mut kill = Command::new("/bin/kill");
    kill.arg("-KILL").arg("--").arg(&target);
    if !matches!(run_cleanup_command(kill).await, Some(status) if status.success()) {
        return false;
    }
    timeout(RUNTIME_KILL_GRACE, async {
        loop {
            if !owned_process_is_current(inner, owned).await {
                return true;
            }
            let mut probe = Command::new("/bin/kill");
            probe.arg("-0").arg("--").arg(&target);
            match process_group_exists(probe).await {
                Some(false) => return true,
                None => return false,
                Some(true) => sleep(Duration::from_millis(25)).await,
            }
        }
    })
    .await
    .unwrap_or(false)
}

#[cfg(unix)]
async fn process_group_exists(command: Command) -> Option<bool> {
    run_cleanup_command(command)
        .await
        .map(|status| status.success())
}

#[cfg(windows)]
async fn terminate_windows_process_tree(
    inner: &RuntimeHostInner,
    owned: OwnedDshProcess,
) -> bool {
    if !owned_process_is_current(inner, owned).await {
        return true;
    }
    let mut taskkill = Command::new("taskkill.exe");
    taskkill
        .arg("/PID")
        .arg(owned.process_id.to_string())
        .arg("/T")
        .arg("/F");
    matches!(run_cleanup_command(taskkill).await, Some(status) if status.success())
}

async fn owned_process_is_current(inner: &RuntimeHostInner, owned: OwnedDshProcess) -> bool {
    if inner.process_epoch.load(Ordering::SeqCst) != owned.process_epoch {
        return false;
    }
    inner.owned_dsh_process.lock().await.as_ref() == Some(&owned)
}

fn apply_shutdown_result(
    status: &mut RuntimePublicStatus,
    runtime_reaped: bool,
    dsh_stopped: bool,
) -> bool {
    let stopped_safely = runtime_reaped && dsh_stopped;
    status.process = if runtime_reaped {
        RuntimeProcessState::Stopped
    } else {
        RuntimeProcessState::Failed
    };
    status.dsh.state = if dsh_stopped {
        DshLifecycleState::Stopped
    } else {
        DshLifecycleState::Failed
    };
    status.dsh.stage = Some(if stopped_safely {
        "shutdown".to_owned()
    } else {
        "shutdown-incomplete".to_owned()
    });
    status.dsh.failure = None;
    status.connection = None;
    status.active_task_count = 0;
    status.activity_known = false;
    status.problem = if stopped_safely {
        None
    } else {
        Some(RuntimePublicProblem {
            code: "runtime-shutdown-failed".to_owned(),
            message: "The local Runtime could not stop safely",
        })
    };
    stopped_safely
}

fn apply_process_exit(status: &mut RuntimePublicStatus, intentional: bool) {
    status.process = if intentional {
        RuntimeProcessState::Stopped
    } else {
        RuntimeProcessState::Failed
    };
    status.connection = None;
    status.active_task_count = 0;
    status.activity_known = false;
    status.dsh.state = if intentional {
        DshLifecycleState::Stopped
    } else {
        DshLifecycleState::Failed
    };
    status.dsh.stage = Some("process-exit".to_owned());
    status.dsh.failure = None;
    status.problem = if intentional {
        None
    } else {
        Some(RuntimePublicProblem {
            code: "runtime-process-exited".to_owned(),
            message: "The local Runtime stopped unexpectedly",
        })
    };
}

async fn run_cleanup_command(mut command: Command) -> Option<ExitStatus> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = command.spawn().ok()?;
    match timeout(RUNTIME_KILL_GRACE, child.wait()).await {
        Ok(Ok(status)) => Some(status),
        _ => {
            let _ = child.start_kill();
            let _ = timeout(RUNTIME_KILL_GRACE, child.wait()).await;
            None
        }
    }
}

async fn emit_status(inner: &RuntimeHostInner, app: &AppHandle) {
    let status = inner.status.read().await.clone();
    let _ = app.emit(RUNTIME_STATUS_EVENT, status);
}

async fn complete_bootstrap_waiter(
    inner: &RuntimeHostInner,
    epoch: u64,
    result: Result<(), NativeHostError>,
) {
    let waiter = {
        let mut guard = inner.bootstrap_waiter.lock().await;
        if guard.as_ref().is_some_and(|(waiter_epoch, _)| *waiter_epoch == epoch) {
            guard.take()
        } else {
            None
        }
    };
    if let Some((_, sender)) = waiter {
        let _ = sender.send(result);
    }
}

async fn read_runtime_stdout<R>(
    stdout: R,
    inner: Arc<RuntimeHostInner>,
    app: AppHandle,
    epoch: u64,
) where
    R: AsyncRead + Unpin,
{
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    loop {
        if inner.process_epoch.load(Ordering::SeqCst) != epoch {
            return;
        }
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => break,
            Ok(read) if read > MAX_CONTROL_LINE_BYTES => {
                handle_protocol_failure(&inner, &app, epoch).await;
            }
            Ok(_) => match protocol::decode_runtime_message(line.trim_end()) {
                Ok(message) => handle_runtime_message(message, &inner, &app, epoch).await,
                Err(_) => handle_protocol_failure(&inner, &app, epoch).await,
            },
            Err(_) => break,
        }
        if inner.process_epoch.load(Ordering::SeqCst) != epoch
            || inner.process_ended.load(Ordering::SeqCst)
        {
            break;
        }
    }
    mark_process_ended(&inner, &app, epoch).await;
}

async fn discard_runtime_stderr<R>(mut stderr: R)
where
    R: AsyncRead + Unpin,
{
    let mut buffer = [0_u8; 4096];
    loop {
        match stderr.read(&mut buffer).await {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
    }
}

async fn monitor_runtime_process(inner: Arc<RuntimeHostInner>, app: AppHandle, epoch: u64) {
    loop {
        sleep(Duration::from_millis(250)).await;
        if inner.process_epoch.load(Ordering::SeqCst) != epoch {
            return;
        }
        let exited = {
            let mut child = inner.child.lock().await;
            match child.as_mut() {
                Some((child_epoch, child)) if *child_epoch == epoch => match child.try_wait() {
                    Ok(Some(_)) => true,
                    Ok(None) => false,
                    Err(_) => true,
                },
                _ => return,
            }
        };
        if exited {
            if inner.process_epoch.load(Ordering::SeqCst) == epoch
                && !inner.process_ended.load(Ordering::SeqCst)
            {
                mark_process_ended(&inner, &app, epoch).await;
            }
            return;
        }
    }
}

async fn handle_runtime_message(
    message: RuntimeMessage,
    inner: &Arc<RuntimeHostInner>,
    app: &AppHandle,
    epoch: u64,
) {
    if inner.process_epoch.load(Ordering::SeqCst) != epoch {
        return;
    }
    match message {
        RuntimeMessage::Response(RuntimeResponse::Success { id, result }) => {
            respond_to_pending(inner, &id, epoch, Ok(result)).await;
        }
        RuntimeMessage::Response(RuntimeResponse::Failure { id, code }) => {
            respond_to_pending(
                inner,
                &id,
                epoch,
                Err(NativeHostError::new(
                    safe_code(&code),
                    "The local Runtime rejected the request",
                )),
            )
            .await;
        }
        RuntimeMessage::Event(RuntimeEvent::Bootstrapped { source, runtime }) => {
            let expected = *inner.expected_startup.lock().await;
            let valid = expected.is_some_and(|(expected_epoch, expected_source, expected_runtime)| {
                expected_epoch == epoch
                    && source == expected_source.as_str()
                    && runtime == expected_runtime.as_str()
            });
            if valid {
                complete_bootstrap_waiter(inner, epoch, Ok(())).await;
            } else {
                complete_bootstrap_waiter(inner, epoch, Err(NativeHostError::protocol())).await;
                set_failure_state(
                    inner,
                    app,
                    "runtime-bootstrap-invalid",
                    "The local Runtime startup message was invalid",
                    epoch,
                )
                .await;
            }
        }
        RuntimeMessage::Event(RuntimeEvent::StartupFailed { code }) => {
            complete_bootstrap_waiter(inner, epoch, Err(NativeHostError::new(
                    safe_code(&code),
                    "The local Runtime could not initialize",
                )))
            .await;
            set_failure_state(
                inner,
                app,
                &code,
                "The local Runtime could not initialize",
                epoch,
            )
            .await;
        }
        RuntimeMessage::Event(RuntimeEvent::Status(snapshot)) => {
            update_status_from_event(inner, snapshot, app, epoch).await;
            emit_status(inner, app).await;
        }
        RuntimeMessage::Event(RuntimeEvent::AccountState(state)) => {
            app.state::<crate::account::AccountHost>()
                .accept_runtime_state(state, epoch, app)
                .await;
        }
        RuntimeMessage::Event(RuntimeEvent::DshStream(frame)) => {
            forward_dsh_stream(inner, app, frame, epoch).await;
        }
    }
}

async fn respond_to_pending(
    inner: &RuntimeHostInner,
    id: &str,
    epoch: u64,
    result: Result<Value, NativeHostError>,
) {
    let request = { inner.pending.lock().await.remove(id) };
    if let Some(request) = request {
        let result = match request.generation {
            _ if request.process_epoch != epoch
                || inner.process_epoch.load(Ordering::SeqCst) != epoch =>
            {
                Err(NativeHostError::unavailable())
            }
            Some(generation) if !generation_is_current(inner, generation).await => {
                Err(NativeHostError::stale_connection())
            }
            _ => result,
        };
        let _ = request.sender.send(result);
    }
}

async fn generation_is_current(inner: &RuntimeHostInner, generation: u64) -> bool {
    let status = inner.status.read().await;
    !inner.intentional_shutdown.load(Ordering::SeqCst)
        && matches!(status.process, RuntimeProcessState::Ready)
        && status.dsh.state == DshLifecycleState::Ready
        && status.dsh.generation == generation
        && status
            .connection
            .as_ref()
            .is_some_and(|connection| connection.generation == generation)
}

async fn bind_public_generation(
    inner: &RuntimeHostInner,
    process_epoch: u64,
    runtime_generation: u64,
) -> Option<u64> {
    if inner.process_epoch.load(Ordering::SeqCst) != process_epoch {
        return None;
    }
    let mut binding = inner.dsh_generation_binding.lock().await;
    if let Some(current) = *binding {
        if current.process_epoch == process_epoch {
            if runtime_generation < current.runtime_generation {
                return None;
            }
            if runtime_generation == current.runtime_generation {
                return Some(current.public_generation);
            }
        }
    }
    let public_generation = inner
        .next_public_generation
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |current| {
            current.checked_add(1)
        })
        .ok()?;
    let next = DshGenerationBinding {
        process_epoch,
        runtime_generation,
        public_generation,
    };
    if inner.process_epoch.load(Ordering::SeqCst) != process_epoch {
        return None;
    }
    *binding = Some(next);
    Some(public_generation)
}

async fn runtime_generation_for_public(inner: &RuntimeHostInner, public_generation: u64) -> Option<u64> {
    let process_epoch = inner.process_epoch.load(Ordering::SeqCst);
    let binding = inner.dsh_generation_binding.lock().await;
    binding
        .as_ref()
        .filter(|binding| {
            binding.process_epoch == process_epoch
                && binding.public_generation == public_generation
        })
        .map(|binding| binding.runtime_generation)
}

async fn public_generation_for_runtime(
    inner: &RuntimeHostInner,
    process_epoch: u64,
    runtime_generation: u64,
) -> Option<u64> {
    if inner.process_epoch.load(Ordering::SeqCst) != process_epoch {
        return None;
    }
    let binding = inner.dsh_generation_binding.lock().await;
    binding
        .as_ref()
        .filter(|binding| {
            binding.process_epoch == process_epoch
                && binding.runtime_generation == runtime_generation
        })
        .map(|binding| binding.public_generation)
}

async fn forward_dsh_stream(
    inner: &Arc<RuntimeHostInner>,
    app: &AppHandle,
    mut frame: DshStreamFrame,
    epoch: u64,
) {
    let Some(public_generation) =
        public_generation_for_runtime(inner, epoch, frame.generation).await
    else {
        return;
    };
    frame.generation = public_generation;
    let mut invalid_sequence = false;
    {
        let status = inner.status.read().await;
        if inner.process_epoch.load(Ordering::SeqCst) != epoch
            || !matches!(status.process, RuntimeProcessState::Ready)
            || status.dsh.state != DshLifecycleState::Ready
            || status.dsh.generation != frame.generation
            || status
                .connection
                .as_ref()
                .map_or(true, |connection| connection.generation != frame.generation)
        {
            return;
        }
        let mut streams = inner.streams.lock().await;
        let Some(stream) = streams.get_mut(&frame.stream_id) else {
            return;
        };
        if stream.generation != frame.generation {
            return;
        }
        let expected = stream.last_sequence.map_or(Some(0), |sequence| sequence.checked_add(1));
        if expected != Some(frame.sequence) {
            invalid_sequence = true;
        } else {
            stream.last_sequence = Some(frame.sequence);
            if frame.error.is_some() || frame.done == Some(true) {
                streams.remove(&frame.stream_id);
            }
            let _ = app.emit(DSH_STREAM_EVENT, frame.clone());
        }
    }
    if invalid_sequence {
        terminate_stream(inner, app, &frame.stream_id, Some(frame.generation)).await;
    }
}

async fn update_status_from_event(
    inner: &Arc<RuntimeHostInner>,
    snapshot: DshLifecycleSnapshot,
    app: &AppHandle,
    epoch: u64,
) {
    let runtime_generation = snapshot.generation;
    let runtime_state = snapshot.state;
    let process_id = snapshot.process_id;
    let Some(generation) = bind_public_generation(inner, epoch, runtime_generation).await else {
        return;
    };
    let mut public: PublicDshLifecycleSnapshot = snapshot.into();
    public.generation = generation;
    let active_generation = {
        let mut status = inner.status.write().await;
        if inner.process_epoch.load(Ordering::SeqCst) != epoch
            || !matches!(
            status.process,
            RuntimeProcessState::Starting | RuntimeProcessState::Ready
        )
        {
            return;
        }
        if generation < status.dsh.generation {
            return;
        }
        if generation != status.dsh.generation || public.state != DshLifecycleState::Ready {
            status.active_task_count = 0;
            status.activity_known = false;
        }
        status.connection = if public.state == DshLifecycleState::Ready {
            Some(NativeConnectionDescription {
                transport: "tauri-ipc",
                generation,
            })
        } else {
            None
        };
        status.dsh = public;
        status.connection.as_ref().map(|connection| connection.generation)
    };
    remember_owned_dsh_process(inner, epoch, runtime_generation, runtime_state, process_id).await;
    invalidate_transports(inner, app, active_generation).await;
}

async fn set_failure_state(
    inner: &RuntimeHostInner,
    app: &AppHandle,
    code: &str,
    message: &'static str,
    epoch: u64,
) {
    if inner.process_epoch.load(Ordering::SeqCst) != epoch {
        return;
    }
    inner.process_ended.store(true, Ordering::SeqCst);
    {
        let mut child_guard = inner.child.lock().await;
        if let Some((child_epoch, child)) = child_guard.as_mut() {
            if *child_epoch == epoch {
                let _ = child.start_kill();
            }
        }
    }
    {
        let mut status = inner.status.write().await;
        if inner.process_epoch.load(Ordering::SeqCst) != epoch {
            return;
        }
        status.process = RuntimeProcessState::Failed;
        status.connection = None;
        status.active_task_count = 0;
        status.activity_known = false;
        status.dsh.state = DshLifecycleState::Failed;
        status.dsh.stage = Some("runtime-protocol-error".to_owned());
        status.problem = Some(RuntimePublicProblem {
            code: safe_code(code),
            message,
        });
    }
    let _ = terminate_owned_dsh_process(inner, epoch).await;
    complete_bootstrap_waiter(
        inner,
        epoch,
        Err(NativeHostError::new(
            safe_code(code),
            "The local Runtime could not initialize",
        )),
    )
    .await;
    fail_pending(inner, None, NativeHostError::unavailable()).await;
    finish_all_streams(inner, app).await;
    emit_status(inner, app).await;
}

async fn handle_protocol_failure(inner: &RuntimeHostInner, app: &AppHandle, epoch: u64) {
    set_failure_state(
        inner,
        app,
        "runtime-protocol-error",
        "The local Runtime control channel returned invalid data",
        epoch,
    )
    .await;
}

async fn mark_process_ended(inner: &RuntimeHostInner, app: &AppHandle, epoch: u64) {
    if inner.process_epoch.load(Ordering::SeqCst) != epoch
        || inner.process_ended.swap(true, Ordering::SeqCst)
    {
        return;
    }
    let intentional = inner.intentional_shutdown.load(Ordering::SeqCst);
    if !intentional {
        let mut child_guard = inner.child.lock().await;
        if let Some((child_epoch, child)) = child_guard.as_mut() {
            if *child_epoch == epoch {
                let _ = child.start_kill();
            }
        }
    }
    {
        let mut status = inner.status.write().await;
        if inner.process_epoch.load(Ordering::SeqCst) != epoch {
            return;
        }
        apply_process_exit(&mut status, intentional);
    }
    if !intentional {
        let _ = terminate_owned_dsh_process(inner, epoch).await;
    }
    complete_bootstrap_waiter(inner, epoch, Err(NativeHostError::unavailable())).await;
    fail_pending(inner, None, NativeHostError::unavailable()).await;
    finish_all_streams(inner, app).await;
    emit_status(inner, app).await;
}

fn safe_code(value: &str) -> String {
    let safe = value
        .chars()
        .take(64)
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'));
    if safe && !value.is_empty() {
        value.chars().take(64).collect()
    } else {
        "runtime-error".to_owned()
    }
}

struct RuntimeLaunchSpec {
    executable: PathBuf,
    entry: PathBuf,
    current_directory: PathBuf,
    dsh_home: PathBuf,
    workspace_directory: PathBuf,
    resource_directory: Option<PathBuf>,
    source: RuntimeSource,
    runtime: RuntimeName,
}

#[derive(Deserialize)]
struct PackagedRuntimeManifest {
    schema_version: u32,
    runtime: ManifestRuntime,
    runtime_entry: String,
}

#[derive(Deserialize)]
struct ManifestRuntime {
    name: RuntimeName,
    executable: String,
}

impl RuntimeLaunchSpec {
    fn resolve(app: &AppHandle) -> Result<Self, &'static str> {
        if cfg!(debug_assertions) {
            return Self::development(app);
        }

        let resource_directory = app
            .path()
            .resource_dir()
            .map_err(|_| "runtime-resource-directory-unavailable")?;
        let runtime_root = resource_directory.join("resources/generated/runtime");
        let manifest_path = runtime_root.join("desktop-runtime.json");
        let manifest_bytes = fs::read(&manifest_path)
            .map_err(|_| "runtime-manifest-missing")?;
        let manifest: PackagedRuntimeManifest = serde_json::from_slice(&manifest_bytes)
            .map_err(|_| "runtime-manifest-invalid")?;
        if manifest.schema_version != 1 {
            return Err("runtime-manifest-version-unsupported");
        }
        let root = runtime_root
            .canonicalize()
            .map_err(|_| "runtime-resource-directory-unavailable")?;
        let executable = resolve_manifest_file(&root, &manifest.runtime.executable)?;
        let entry = resolve_manifest_file(&root, &manifest.runtime_entry)?;
        let app_data = app
            .path()
            .app_data_dir()
            .map_err(|_| "runtime-app-data-directory-unavailable")?;
        let workspace_directory = app
            .path()
            .home_dir()
            .map_err(|_| "runtime-workspace-directory-unavailable")?;
        let dsh_home = app_data.join("dsh");
        fs::create_dir_all(&dsh_home).map_err(|_| "runtime-app-data-directory-unavailable")?;

        Ok(Self {
            executable,
            entry,
            current_directory: root,
            dsh_home,
            workspace_directory,
            resource_directory: Some(resource_directory),
            source: RuntimeSource::Sidecar,
            runtime: manifest.runtime.name,
        })
    }

    fn development(app: &AppHandle) -> Result<Self, &'static str> {
        let repository_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()
            .map_err(|_| "runtime-development-root-unavailable")?;
        let runtime_root = repository_root.join("apps/desktop-runtime");
        let entry = runtime_root.join("src/index.ts");
        let dsh_home = app
            .path()
            .app_data_dir()
            .map_err(|_| "runtime-development-home-unavailable")?
            .join("dsh-development");
        let workspace_directory = app
            .path()
            .home_dir()
            .map_err(|_| "runtime-workspace-directory-unavailable")?;
        fs::create_dir_all(&dsh_home).map_err(|_| "runtime-development-home-unavailable")?;
        let executable = std::env::var_os("SUB2API_DESKTOP_RUNTIME_EXECUTABLE")
            .map(PathBuf::from)
            .ok_or("runtime-development-executable-missing")?;
        if !executable.is_absolute() || !executable.is_file() {
            return Err("runtime-development-executable-invalid");
        }
        let runtime = match std::env::var("SUB2API_DESKTOP_RUNTIME_NAME") {
            Ok(name) if name == "bun" => RuntimeName::Bun,
            Ok(name) if name == "node" => RuntimeName::Node,
            Err(std::env::VarError::NotPresent) => RuntimeName::Node,
            _ => return Err("runtime-development-name-invalid"),
        };

        Ok(Self {
            executable,
            entry,
            current_directory: runtime_root,
            dsh_home,
            workspace_directory,
            resource_directory: None,
            source: RuntimeSource::Development,
            runtime,
        })
    }
}

fn resolve_manifest_file(root: &Path, relative: &str) -> Result<PathBuf, &'static str> {
    let path = Path::new(relative);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("runtime-manifest-path-invalid");
    }
    let resolved = root
        .join(path)
        .canonicalize()
        .map_err(|_| "runtime-resource-file-missing")?;
    if !resolved.starts_with(root) || !resolved.is_file() {
        return Err("runtime-manifest-path-invalid");
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_exit_clears_connection_and_marks_activity_unknown() {
        let mut status = initial_status();
        status.process = RuntimeProcessState::Ready;
        status.dsh.state = DshLifecycleState::Ready;
        status.connection = Some(NativeConnectionDescription {
            transport: "tauri-ipc",
            generation: 4,
        });
        status.active_task_count = 2;
        status.activity_known = true;

        apply_process_exit(&mut status, false);

        assert!(matches!(status.process, RuntimeProcessState::Failed));
        assert_eq!(status.dsh.state, DshLifecycleState::Failed);
        assert!(status.connection.is_none());
        assert_eq!(status.active_task_count, 0);
        assert!(!status.activity_known);
        assert_eq!(
            status.problem.as_ref().map(|problem| problem.code.as_str()),
            Some("runtime-process-exited")
        );
    }

    #[test]
    fn repeated_stop_outcome_keeps_owned_services_stopped() {
        let mut status = initial_status();
        status.process = RuntimeProcessState::Ready;
        status.dsh.state = DshLifecycleState::Ready;
        status.active_task_count = 1;
        status.activity_known = true;

        assert!(apply_shutdown_result(&mut status, true, true));
        assert!(apply_shutdown_result(&mut status, true, true));

        assert!(matches!(status.process, RuntimeProcessState::Stopped));
        assert_eq!(status.dsh.state, DshLifecycleState::Stopped);
        assert_eq!(status.dsh.stage.as_deref(), Some("shutdown"));
        assert_eq!(status.active_task_count, 0);
        assert!(!status.activity_known);
        assert!(status.problem.is_none());
    }

    #[test]
    fn restarted_process_epoch_cannot_reuse_prior_dsh_generation() {
        let host = RuntimeHost::new();
        tauri::async_runtime::block_on(async {
            host.inner.process_epoch.store(10, Ordering::SeqCst);
            let previous = bind_public_generation(&host.inner, 10, 7)
                .await
                .expect("first process generation binds");

            host.inner.process_epoch.store(11, Ordering::SeqCst);
            assert_eq!(
                public_generation_for_runtime(&host.inner, 10, 7).await,
                None
            );
            assert_eq!(runtime_generation_for_public(&host.inner, previous).await, None);

            let restarted = bind_public_generation(&host.inner, 11, 1)
                .await
                .expect("new process generation binds");
            assert!(restarted > previous);
            assert_eq!(
                public_generation_for_runtime(&host.inner, 11, 1).await,
                Some(restarted)
            );
        });
    }
}
