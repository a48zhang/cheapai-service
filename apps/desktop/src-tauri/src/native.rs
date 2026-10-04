use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tokio::sync::oneshot;

const REGISTRATION_URL: &str = "https://cheapai.dev/register";
const CONSOLE_URL: &str = "https://cheapai.dev/dashboard";

#[tauri::command]
pub(crate) async fn choose_workspace_directory(
    app: AppHandle,
) -> Result<Option<String>, String> {
    let (sender, receiver) = oneshot::channel();
    let selected = app
        .dialog()
        .file()
        .set_title("Choose a workspace directory")
        .set_can_create_directories(false)
        .pick_folder(move |selected| {
            let _ = sender.send(selected);
        });
    let selected = receiver
        .await
        .map_err(|_| "The directory picker did not return a result".to_owned())?;

    let Some(selected) = selected else {
        return Ok(None);
    };
    let Some(path) = selected.as_path() else {
        return Err("The selected directory path is unavailable".to_owned());
    };
    if !path.is_absolute() || !path.is_dir() {
        return Err("The selected directory path is invalid".to_owned());
    }
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub(crate) fn open_cheapai_registration(app: AppHandle) -> Result<(), String> {
    open_approved_url(&app, REGISTRATION_URL)
}

#[tauri::command]
pub(crate) fn open_cheapai_console(app: AppHandle) -> Result<(), String> {
    open_approved_url(&app, CONSOLE_URL)
}

fn open_approved_url(app: &AppHandle, url: &'static str) -> Result<(), String> {
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| "Could not open the requested cheapai.dev page".to_owned())
}
