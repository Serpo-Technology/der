//! The host's part of the Claude subscription sign-in: opening the browser
//! and passing the pasted code on. The verifier, the token exchange, and
//! the tokens stay in the LLM gateway.

use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use crate::llm::{self, SettingsView};

/// Starts the browser sign-in and returns the authorize URL (shown in the UI
/// in case the browser did not open).
#[tauri::command]
pub async fn claude_oauth_start(app: AppHandle) -> Result<String, String> {
    let url = llm::sign_in_start(&app).await?;
    app.opener()
        .open_url(url.clone(), None::<&str>)
        .map_err(|e| format!("Failed to open browser: {}", e))?;
    Ok(url)
}

/// Completes the sign-in with the `code#state` string the callback page shows.
#[tauri::command]
pub async fn claude_oauth_finish(app: AppHandle, code: String) -> Result<SettingsView, String> {
    llm::settings_request(&app, der_llm::Request::SignInFinish { code }).await
}
