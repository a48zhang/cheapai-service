mod account;
mod credentials;
mod native;
mod protocol;
mod runtime;
mod updates;

use tauri::{Manager, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

pub fn run() {
    let mut app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let account = account::AccountHost::new(app.handle()).map_err(|error| {
                std::io::Error::new(std::io::ErrorKind::Other, error.message)
            })?;
            app.manage(account);
            app.manage(updates::UpdateService::default());
            let host = runtime::RuntimeHost::new();
            app.manage(host.clone());
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                host.launch(app_handle).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            runtime::runtime_start,
            runtime::runtime_stop,
            runtime::runtime_status,
            runtime::runtime_restart,
            runtime::runtime_set_task_activity,
            runtime::dsh_transport_call,
            runtime::dsh_transport_open,
            runtime::dsh_transport_uplink,
            runtime::dsh_transport_end,
            runtime::dsh_transport_cancel,
            account::desktop_account_login,
            account::desktop_account_restore,
            account::desktop_account_refresh,
            account::desktop_account_logout,
            updates::desktop_update_check,
            updates::desktop_update_download,
            updates::desktop_update_install,
            native::choose_workspace_directory,
            native::open_cheapai_registration,
            native::open_cheapai_console,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build cheapai.dev desktop application");

    app.run(|app_handle, event| match event {
        tauri::RunEvent::WindowEvent {
            event: WindowEvent::CloseRequested { api, .. },
            ..
        } => {
            let host = app_handle.state::<runtime::RuntimeHost>().inner().clone();
            let status = tauri::async_runtime::block_on(host.current_status());
            if let Some(message) = exit_confirmation_message(&status) {
                api.prevent_close();
                show_exit_confirmation(app_handle, host, message);
            }
        }
        tauri::RunEvent::ExitRequested {
            api,
            code: None,
            ..
        } => {
            let host = app_handle.state::<runtime::RuntimeHost>().inner().clone();
            let status = tauri::async_runtime::block_on(host.current_status());
            if let Some(message) = exit_confirmation_message(&status) {
                api.prevent_exit();
                show_exit_confirmation(app_handle, host, message);
            }
        }
        tauri::RunEvent::Exit => {
            let host = app_handle.state::<runtime::RuntimeHost>().inner().clone();
            let app = app_handle.clone();
            tauri::async_runtime::block_on(host.shutdown(&app));
        }
        _ => {}
    });
}

fn exit_confirmation_message(status: &runtime::RuntimePublicStatus) -> Option<String> {
    let activity_unknown = matches!(status.process, runtime::RuntimeProcessState::Ready)
        && status.dsh.state == protocol::DshLifecycleState::Ready
        && !status.activity_known;
    if status.active_task_count > 0 {
        Some(format!(
            "{} DSH task(s) are running. Stop them and exit?",
            status.active_task_count
        ))
    } else if activity_unknown {
        Some("Task status has not yet been confirmed. Stop the local service and exit?".to_owned())
    } else {
        None
    }
}

fn show_exit_confirmation(
    app_handle: &tauri::AppHandle,
    host: runtime::RuntimeHost,
    message: String,
) {
    if !host.begin_close_confirmation() {
        return;
    }
    let host_for_dialog = host.clone();
    let app_for_dialog = app_handle.clone();
    app_handle
        .dialog()
        .message(message)
        .title("Exit cheapai.dev?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancel)
        .show(move |confirmed| {
            if confirmed {
                tauri::async_runtime::spawn(async move {
                    host_for_dialog.shutdown(&app_for_dialog).await;
                    app_for_dialog.exit(0);
                });
            } else {
                host_for_dialog.finish_close_confirmation();
            }
        });
}
