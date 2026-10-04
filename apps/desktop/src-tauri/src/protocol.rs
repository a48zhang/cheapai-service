//! Private newline-delimited JSON messages between Tauri and the Runtime.
//!
//! Runtime responses can contain DSH's process-bound authentication cookie.
//! This module deliberately has no `Serialize` implementation for those
//! connection details; only a transport marker and generation may cross into
//! renderer state.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum RuntimeName {
    Bun,
    Node,
}

impl RuntimeName {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Bun => "bun",
            Self::Node => "node",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RuntimeSource {
    Development,
    Sidecar,
}

impl RuntimeSource {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Development => "development",
            Self::Sidecar => "sidecar",
        }
    }
}

pub(crate) enum RuntimeMessage {
    Response(RuntimeResponse),
    Event(RuntimeEvent),
}

pub(crate) enum RuntimeResponse {
    Success { id: String, result: Value },
    Failure { id: String, code: String },
}

#[derive(Debug)]
pub(crate) enum RuntimeEvent {
    Bootstrapped {
        source: String,
        runtime: String,
    },
    StartupFailed {
        code: String,
    },
    Status(DshLifecycleSnapshot),
    DshStream(DshStreamFrame),
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DshStreamFrame {
    pub(crate) generation: u64,
    pub(crate) stream_id: String,
    pub(crate) sequence: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) value: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<DshStreamError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) done: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DshStreamError {
    pub(crate) code: String,
    pub(crate) message: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum DshLifecycleState {
    Starting,
    Ready,
    Stopping,
    Stopped,
    Failed,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DshLifecycleSnapshot {
    pub(crate) state: DshLifecycleState,
    pub(crate) generation: u64,
    pub(crate) stage: Option<String>,
    failure: Option<DshLifecycleFailure>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DshLifecycleFailure {
    code: String,
    stage: String,
    // Never copy Runtime diagnostic messages to the renderer. They can contain
    // local filesystem paths and are not needed for recovery decisions.
    #[allow(dead_code)]
    message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublicDshLifecycleSnapshot {
    pub(crate) state: DshLifecycleState,
    pub(crate) generation: u64,
    pub(crate) stage: Option<String>,
    pub(crate) failure: Option<PublicDshLifecycleFailure>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublicDshLifecycleFailure {
    pub(crate) code: String,
    pub(crate) stage: String,
}

impl From<DshLifecycleSnapshot> for PublicDshLifecycleSnapshot {
    fn from(snapshot: DshLifecycleSnapshot) -> Self {
        Self {
            state: snapshot.state,
            generation: snapshot.generation,
            stage: snapshot.stage,
            failure: snapshot.failure.map(|failure| PublicDshLifecycleFailure {
                code: failure.code,
                stage: failure.stage,
            }),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrivateDshConnectionInfo {
    origin: String,
    http_base_url: String,
    stream_base_url: String,
    port: u16,
    auth: PrivateDshAuthentication,
}

#[derive(Deserialize)]
struct PrivateDshAuthentication {
    #[serde(rename = "type")]
    kind: String,
    cookie: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeCommandResult {
    kind: String,
    status: Option<DshLifecycleSnapshot>,
    connection: Option<PrivateDshConnectionInfo>,
}

#[derive(Debug)]
pub(crate) struct ProtocolError(&'static str);

/// Encode the Runtime bootstrap event. It is sent only over the child's stdin.
pub(crate) fn encode_startup(source: RuntimeSource, runtime: RuntimeName) -> String {
    format!(
        "{{\"type\":\"host.startup\",\"source\":\"{}\",\"runtime\":\"{}\"}}\n",
        source.as_str(),
        runtime.as_str(),
    )
}

/// Encode one supported lifecycle request for the private process pipe.
pub(crate) fn encode_request(id: &str, command: &str) -> String {
    let id = serde_json::to_string(id).expect("a request id is always serializable");
    let command = serde_json::to_string(command).expect("a fixed command is always serializable");
    format!("{{\"type\":\"host.request\",\"id\":{id},\"command\":{command}}}\n")
}

/// Encode the constrained DSH transport command; the logical Remote carrier is
/// passed through unchanged and remains private to the native/Runtime pipe.
pub(crate) fn encode_transport_request(
    id: &str,
    operation: &str,
    payload: Value,
) -> String {
    let value = json!({
        "type": "host.request",
        "id": id,
        "command": "transport",
        "operation": operation,
        "payload": payload,
    });
    format!("{}\n", value)
}

/// Decode a Runtime line without retaining or formatting the original JSON.
pub(crate) fn decode_runtime_message(line: &str) -> Result<RuntimeMessage, ProtocolError> {
    let value: Value = serde_json::from_str(line).map_err(|_| ProtocolError("invalid JSON"))?;
    let record = value.as_object().ok_or(ProtocolError("message is not an object"))?;
    match record.get("type").and_then(Value::as_str) {
        Some("runtime.response") => {
            let id = record
                .get("id")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty() && value.len() <= 128)
                .ok_or(ProtocolError("response id is invalid"))?
                .to_owned();
            match record.get("ok").and_then(Value::as_bool) {
                Some(true) => Ok(RuntimeMessage::Response(RuntimeResponse::Success {
                    id,
                    result: record
                        .get("result")
                        .cloned()
                        .ok_or(ProtocolError("successful response has no result"))?,
                })),
                Some(false) => {
                    let code = record
                        .get("error")
                        .and_then(Value::as_object)
                        .and_then(|error| error.get("code"))
                        .and_then(Value::as_str)
                        .unwrap_or("runtime-error")
                        .chars()
                        .take(64)
                        .collect();
                    Ok(RuntimeMessage::Response(RuntimeResponse::Failure { id, code }))
                }
                None => Err(ProtocolError("response result flag is invalid")),
            }
        }
        Some("runtime.event") => decode_runtime_event(record),
        _ => Err(ProtocolError("message type is unsupported")),
    }
}

fn decode_runtime_event(
    record: &serde_json::Map<String, Value>,
) -> Result<RuntimeMessage, ProtocolError> {
    match record.get("event").and_then(Value::as_str) {
        Some("bootstrapped") => Ok(RuntimeMessage::Event(RuntimeEvent::Bootstrapped {
            source: required_string(record, "source")?,
            runtime: required_string(record, "runtime")?,
        })),
        Some("startup-failed") => {
            let code = record
                .get("error")
                .and_then(Value::as_object)
                .and_then(|error| error.get("code"))
                .and_then(Value::as_str)
                .unwrap_or("startup-failed")
                .chars()
                .take(64)
                .collect();
            Ok(RuntimeMessage::Event(RuntimeEvent::StartupFailed { code }))
        }
        Some("status") => {
            let value = record
                .get("status")
                .cloned()
                .ok_or(ProtocolError("status event has no status"))?;
            let snapshot = serde_json::from_value(value)
                .map_err(|_| ProtocolError("status event is invalid"))?;
            Ok(RuntimeMessage::Event(RuntimeEvent::Status(snapshot)))
        }
        Some("dsh.stream") => {
            let value = Value::Object(record.clone());
            let frame: DshStreamFrame = serde_json::from_value(value)
                .map_err(|_| ProtocolError("DSH stream frame is invalid"))?;
            let variants = [
                frame.value.is_some(),
                frame.error.is_some(),
                frame.done == Some(true),
            ]
            .into_iter()
            .filter(|present| *present)
            .count();
            if frame.generation == 0
                || frame.stream_id.is_empty()
                || frame.stream_id.len() > 128
                || variants != 1
                || frame.done == Some(false)
                || frame.error.as_ref().is_some_and(|error| {
                    error.code.is_empty()
                        || error.code.len() > 64
                        || !error.code.chars().all(|character| {
                            character.is_ascii_alphanumeric()
                                || matches!(character, '-' | '_')
                        })
                        || error.message.len() > 2048
                })
            {
                return Err(ProtocolError("DSH stream frame fields are invalid"));
            }
            Ok(RuntimeMessage::Event(RuntimeEvent::DshStream(frame)))
        }
        _ => Err(ProtocolError("Runtime event is unsupported")),
    }
}

fn required_string(
    record: &serde_json::Map<String, Value>,
    field: &'static str,
) -> Result<String, ProtocolError> {
    record
        .get(field)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or(ProtocolError("Runtime event field is invalid"))
}

/// Read a lifecycle result while dropping all private connection fields.
pub(crate) fn lifecycle_result(
    value: Value,
    expected_kind: &'static str,
) -> Result<(DshLifecycleSnapshot, bool), ProtocolError> {
    let result: RuntimeCommandResult = serde_json::from_value(value)
        .map_err(|_| ProtocolError("Runtime command result is invalid"))?;
    if result.kind != expected_kind {
        return Err(ProtocolError("Runtime command returned the wrong result kind"));
    }
    let status = result
        .status
        .ok_or(ProtocolError("Runtime command result has no status"))?;
    let has_connection = match result.connection {
        Some(connection) => {
            validate_private_connection(&connection)?;
            true
        }
        None => false,
    };
    if expected_kind == "started" && !has_connection {
        return Err(ProtocolError("Runtime start result has no DSH connection"));
    }
    Ok((status, has_connection))
}

fn validate_private_connection(
    connection: &PrivateDshConnectionInfo,
) -> Result<(), ProtocolError> {
    let origin = format!("http://127.0.0.1:{}", connection.port);
    let stream = format!("ws://127.0.0.1:{}", connection.port);
    if connection.port == 0
        || connection.origin != origin
        || connection.http_base_url != format!("{origin}/")
        || connection.stream_base_url != format!("{stream}/")
        || connection.auth.kind != "dsh-browser-cookie"
        || !connection.auth.cookie.starts_with("dsh-auth-")
    {
        return Err(ProtocolError("Runtime DSH connection is invalid"));
    }
    Ok(())
}
