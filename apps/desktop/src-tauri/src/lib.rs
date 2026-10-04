mod credentials;
mod protocol;
mod runtime;

use tauri::Manager;

pub fn run() {
    let mut app = tauri::Builder::default()
        .setup(|app| {
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
            runtime::dsh_transport_call,
            runtime::dsh_transport_open,
            runtime::dsh_transport_uplink,
            runtime::dsh_transport_end,
            runtime::dsh_transport_cancel,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build cheapai.dev desktop application");

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            let host = app_handle.state::<runtime::RuntimeHost>().inner().clone();
            let app = app_handle.clone();
            tauri::async_runtime::block_on(host.shutdown(&app));
        }
    });
}
