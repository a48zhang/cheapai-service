use std::{env, sync::Arc, time::Duration};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::{oneshot, Mutex};

use crate::runtime::{RuntimeHost, RuntimeProcessState};
use crate::protocol::DshLifecycleState;

const UPDATE_ENDPOINT_ENV: &str = "SUB2API_DESKTOP_UPDATE_ENDPOINT";
const UPDATE_PUBKEY_ENV: &str = "SUB2API_DESKTOP_UPDATE_PUBKEY";
const UPDATE_PROGRESS_EVENT: &str = "desktop-update-download-progress";
const MAX_TASK_CONFIRMATIONS: usize = 3;

#[derive(Clone, Default)]
pub(crate) struct UpdateService {
    state: Arc<Mutex<UpdateServiceState>>,
}

#[derive(Default)]
struct UpdateServiceState {
    generation: u64,
    pending: Option<PendingUpdate>,
    installing: bool,
}

struct PendingUpdate {
    generation: u64,
    update: Update,
    downloaded: Option<Arc<Vec<u8>>>,
    downloading: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateCheckResult {
    pub(crate) status: &'static str,
    pub(crate) current_version: String,
    pub(crate) offer: Option<UpdateOffer>,
    pub(crate) error: Option<UpdateError>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateOffer {
    pub(crate) offer_id: u64,
    pub(crate) current_version: String,
    pub(crate) version: String,
    pub(crate) date: Option<String>,
    pub(crate) notes: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateActionResult {
    pub(crate) status: &'static str,
    pub(crate) offer_id: u64,
    pub(crate) version: Option<String>,
    pub(crate) error: Option<UpdateError>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateError {
    pub(crate) code: &'static str,
    pub(crate) message: &'static str,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateDownloadProgress {
    offer_id: u64,
    chunk_length: usize,
    content_length: Option<u64>,
}

enum UpdaterConfiguration {
    Ready(tauri_plugin_updater::Updater),
    Unavailable,
    Invalid,
}

#[tauri::command]
pub(crate) async fn desktop_update_check(
    app: AppHandle,
    service: State<'_, UpdateService>,
) -> Result<UpdateCheckResult, UpdateError> {
    Ok(check_update(app, service).await)
}

async fn check_update(
    app: AppHandle,
    service: State<'_, UpdateService>,
) -> UpdateCheckResult {
    let current_version = app.package_info().version.to_string();
    let generation = {
        let mut state = service.state.lock().await;
        if state.installing {
            return check_result(
                "busy",
                current_version,
                None,
                Some(update_error("install-in-progress", "An update is already being installed.")),
            );
        }
        state.generation = state.generation.wrapping_add(1).max(1);
        state.pending = None;
        state.generation
    };

    let updater = match configured_updater(&app) {
        UpdaterConfiguration::Ready(updater) => updater,
        UpdaterConfiguration::Unavailable => {
            return check_result(
                "unavailable",
                current_version,
                None,
                Some(update_error(
                    "not-configured",
                    "The update source is not configured for this build.",
                )),
            )
        }
        UpdaterConfiguration::Invalid => {
            return check_result(
                "unavailable",
                current_version,
                None,
                Some(update_error(
                    "invalid-configuration",
                    "The configured update source is invalid.",
                )),
            )
        }
    };

    match updater.check().await {
        Ok(None) => {
            let state = service.state.lock().await;
            if state.generation != generation {
                return check_result("stale", current_version, None, None);
            }
            check_result("current", current_version, None, None)
        }
        Ok(Some(update)) => {
            let offer = UpdateOffer {
                offer_id: generation,
                current_version: update.current_version.clone(),
                version: update.version.clone(),
                date: update.date.as_ref().map(ToString::to_string),
                notes: update.body.clone(),
            };
            let mut state = service.state.lock().await;
            if state.generation != generation || state.installing {
                return check_result("stale", current_version, None, None);
            }
            state.pending = Some(PendingUpdate {
                generation,
                update,
                downloaded: None,
                downloading: false,
            });
            check_result("available", current_version, Some(offer), None)
        }
        Err(_) => {
            let state = service.state.lock().await;
            if state.generation != generation {
                return check_result("stale", current_version, None, None);
            }
            check_result(
                "failed",
                current_version,
                None,
                Some(update_error("check-failed", "Could not check for updates.")),
            )
        }
    }
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn desktop_update_download(
    app: AppHandle,
    service: State<'_, UpdateService>,
    offer_id: u64,
) -> Result<UpdateActionResult, UpdateError> {
    Ok(download_update(app, service, offer_id).await)
}

async fn download_update(
    app: AppHandle,
    service: State<'_, UpdateService>,
    offer_id: u64,
) -> UpdateActionResult {
    let update = {
        let mut state = service.state.lock().await;
        if state.installing {
            return action_result(
                "busy",
                offer_id,
                None,
                Some(update_error("install-in-progress", "An update is already being installed.")),
            );
        }
        if state.generation != offer_id {
            return action_result("stale", offer_id, None, Some(stale_error()));
        }
        let Some(pending) = state.pending.as_mut() else {
            return action_result("stale", offer_id, None, Some(stale_error()));
        };
        if pending.generation != offer_id {
            return action_result("stale", offer_id, None, Some(stale_error()));
        }
        if pending.downloaded.is_some() {
            return action_result("downloaded", offer_id, Some(pending.update.version.clone()), None);
        }
        if pending.downloading {
            return action_result(
                "busy",
                offer_id,
                Some(pending.update.version.clone()),
                Some(update_error("download-in-progress", "This update is already downloading.")),
            );
        }
        pending.downloading = true;
        pending.update.clone()
    };

    let version = update.version.clone();
    let progress_app = app.clone();
    let downloaded = update
        .download(
            move |chunk_length, content_length| {
                let _ = progress_app.emit(
                    UPDATE_PROGRESS_EVENT,
                    UpdateDownloadProgress {
                        offer_id,
                        chunk_length,
                        content_length,
                    },
                );
            },
            || {},
        )
        .await;

    let mut state = service.state.lock().await;
    if state.generation != offer_id {
        return action_result("stale", offer_id, None, Some(stale_error()));
    }
    let Some(pending) = state.pending.as_mut() else {
        return action_result("stale", offer_id, None, Some(stale_error()));
    };
    if pending.generation != offer_id {
        return action_result("stale", offer_id, None, Some(stale_error()));
    }
    pending.downloading = false;
    match downloaded {
        Ok(bytes) => {
            pending.downloaded = Some(Arc::new(bytes));
            action_result("downloaded", offer_id, Some(version), None)
        }
        Err(_) => action_result(
            "failed",
            offer_id,
            Some(version),
            Some(update_error("download-failed", "The update could not be downloaded or verified.")),
        ),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn desktop_update_install(
    app: AppHandle,
    service: State<'_, UpdateService>,
    host: State<'_, RuntimeHost>,
    offer_id: u64,
) -> Result<UpdateActionResult, UpdateError> {
    Ok(install_update(app, service, host, offer_id).await)
}

async fn install_update(
    app: AppHandle,
    service: State<'_, UpdateService>,
    host: State<'_, RuntimeHost>,
    offer_id: u64,
) -> UpdateActionResult {
    let (update, bytes, version) = {
        let mut state = service.state.lock().await;
        if state.installing {
            return action_result(
                "busy",
                offer_id,
                None,
                Some(update_error("install-in-progress", "An update is already being installed.")),
            );
        }
        let Some(pending) = state.pending.as_ref() else {
            return action_result("stale", offer_id, None, Some(stale_error()));
        };
        if pending.generation != offer_id || state.generation != offer_id {
            return action_result("stale", offer_id, None, Some(stale_error()));
        }
        let Some(bytes) = pending.downloaded.clone() else {
            return action_result(
                "failed",
                offer_id,
                Some(pending.update.version.clone()),
                Some(update_error("not-downloaded", "Download and verify the update before installing it.")),
            );
        };
        let update = pending.update.clone();
        let version = pending.update.version.clone();
        state.installing = true;
        (update, bytes, version)
    };

    match prepare_dsh_for_install(&app, &host).await {
        Ok(true) => {}
        Ok(false) => {
            clear_installing(&service).await;
            return action_result("cancelled", offer_id, Some(version), None);
        }
        Err(error) => {
            clear_installing(&service).await;
            return action_result("failed", offer_id, Some(version), Some(error));
        }
    }

    match update.install(bytes.as_slice()) {
        Ok(()) => {
            app.exit(0);
            action_result("installing", offer_id, Some(version), None)
        }
        Err(_) => {
            clear_installing(&service).await;
            action_result(
                "failed",
                offer_id,
                Some(version),
                Some(update_error("install-failed", "The update installer could not be started.")),
            )
        }
    }
}

fn configured_updater(app: &AppHandle) -> UpdaterConfiguration {
    let endpoint = match env::var(UPDATE_ENDPOINT_ENV) {
        Ok(value) if !value.trim().is_empty() => value.trim().to_owned(),
        _ => return UpdaterConfiguration::Unavailable,
    };
    let pubkey = match env::var(UPDATE_PUBKEY_ENV) {
        Ok(value) if !value.trim().is_empty() => value.trim().to_owned(),
        _ => return UpdaterConfiguration::Unavailable,
    };
    let endpoint = match endpoint.parse::<tauri::Url>() {
        Ok(endpoint) => endpoint,
        Err(_) => return UpdaterConfiguration::Invalid,
    };
    if endpoint.scheme() != "https"
        || endpoint.host_str().is_none()
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
    {
        return UpdaterConfiguration::Invalid;
    }
    let builder = match app.updater_builder().endpoints(vec![endpoint]) {
        Ok(builder) => builder,
        Err(_) => return UpdaterConfiguration::Invalid,
    };
    match builder.pubkey(pubkey).timeout(Duration::from_secs(45)).build() {
        Ok(updater) => UpdaterConfiguration::Ready(updater),
        Err(_) => UpdaterConfiguration::Invalid,
    }
}

async fn prepare_dsh_for_install(
    app: &AppHandle,
    host: &RuntimeHost,
) -> Result<bool, UpdateError> {
    let mut confirmed_count = 0;
    let mut confirmed_unknown_activity = false;
    let mut confirmation_generation = None;
    for _ in 0..MAX_TASK_CONFIRMATIONS {
        let status = host.query_status(app).await;
        if confirmation_generation != Some(status.dsh.generation) {
            confirmation_generation = Some(status.dsh.generation);
            confirmed_count = 0;
            confirmed_unknown_activity = false;
        }
        if matches!(status.process, RuntimeProcessState::Starting) {
            return Err(update_error(
                "runtime-starting",
                "Wait for the local Runtime to finish starting, then try again.",
            ));
        }
        if !status.activity_known
            && !matches!(status.dsh.state, DshLifecycleState::Stopped)
            && !confirmed_unknown_activity
        {
            if !confirm_stop_unknown_activity(app).await {
                return Ok(false);
            }
            confirmed_unknown_activity = true;
            continue;
        }
        if status.activity_known && status.active_task_count > confirmed_count {
            let count = status.active_task_count;
            if !confirm_stop_active_tasks(app, count).await {
                return Ok(false);
            }
            confirmed_count = count;
            continue;
        }
        host.stop_for_update(app).await.map_err(|_| {
            update_error(
                "dsh-stop-failed",
                "DSH could not be stopped safely; the update was not installed.",
            )
        })?;
        return Ok(true);
    }
    Err(update_error(
        "tasks-changing",
        "DSH task activity is changing; stop or finish the tasks, then try again.",
    ))
}

async fn confirm_stop_unknown_activity(app: &AppHandle) -> bool {
    let (sender, receiver) = oneshot::channel();
    app.dialog()
        .message(
            "The number of active DSH tasks is unknown. Stop DSH and install this update? Any active work will not resume automatically.",
        )
        .title("Install desktop update?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancel)
        .show(move |confirmed| {
            let _ = sender.send(confirmed);
        });
    receiver.await.unwrap_or(false)
}

async fn confirm_stop_active_tasks(app: &AppHandle, count: u64) -> bool {
    let (sender, receiver) = oneshot::channel();
    app.dialog()
        .message(format!(
            "{count} DSH task(s) are running. Stop DSH and install this update? Active work will not resume automatically."
        ))
        .title("Install desktop update?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancel)
        .show(move |confirmed| {
            let _ = sender.send(confirmed);
        });
    receiver.await.unwrap_or(false)
}

async fn clear_installing(service: &UpdateService) {
    service.state.lock().await.installing = false;
}

fn check_result(
    status: &'static str,
    current_version: String,
    offer: Option<UpdateOffer>,
    error: Option<UpdateError>,
) -> UpdateCheckResult {
    UpdateCheckResult {
        status,
        current_version,
        offer,
        error,
    }
}

fn action_result(
    status: &'static str,
    offer_id: u64,
    version: Option<String>,
    error: Option<UpdateError>,
) -> UpdateActionResult {
    UpdateActionResult {
        status,
        offer_id,
        version,
        error,
    }
}

fn update_error(code: &'static str, message: &'static str) -> UpdateError {
    UpdateError { code, message }
}

fn stale_error() -> UpdateError {
    update_error("stale-offer", "This update offer has expired; check for updates again.")
}
