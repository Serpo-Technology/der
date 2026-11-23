//! The settings commands both faces call. Nothing secret is kept here: the
//! integration credentials live in the HTTP service and the model settings,
//! API keys, and sign-in tokens live in the LLM gateway, so each command
//! passes its request on and returns a redacted view.

use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use crate::llm;
use crate::secrets::Secrets;

pub use der_http::store::IntegrationCredentialView;
pub use der_llm::{Settings as LlmSettings, SettingsView as LlmSettingsView};

/// True when the configured provider can actually answer. The native home
/// gates its create field on this.
pub fn llm_ready(app: &AppHandle) -> bool {
    llm::ready(app)
}

fn credential_views(reply: der_http::Reply) -> Result<Vec<IntegrationCredentialView>, String> {
    match reply {
        der_http::Reply::Credentials(views) => Ok(views),
        der_http::Reply::Error(message) => Err(message),
        _ => Err("The credential store answered out of turn".to_string()),
    }
}

#[tauri::command]
pub fn list_integration_credentials(app: AppHandle) -> Vec<IntegrationCredentialView> {
    Secrets::for_app(&app)
        .and_then(|secrets| credential_views(secrets.store(der_http::Request::CredentialsList)))
        .unwrap_or_default()
}

#[tauri::command]
pub fn set_integration_credential(
    app: AppHandle,
    name: String,
    kind: String,
    target: Option<String>,
    base_url: String,
    notes: Option<String>,
    secret: String,
) -> Result<Vec<IntegrationCredentialView>, String> {
    credential_views(Secrets::for_app(&app)?.store(der_http::Request::CredentialsSet {
        name,
        kind,
        target,
        base_url,
        notes,
        secret,
    }))
}

#[tauri::command]
pub fn delete_integration_credential(
    app: AppHandle,
    name: String,
) -> Result<Vec<IntegrationCredentialView>, String> {
    credential_views(
        Secrets::for_app(&app)?.store(der_http::Request::CredentialsRemove { name }),
    )
}

pub(crate) fn settings_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?
        .join("settings");
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create settings directory: {}", e))?;
    Ok(dir)
}

/// What settings screens see: the full non-secret settings and a redacted
/// preview of each credential.
pub fn build_view(app: &AppHandle) -> LlmSettingsView {
    llm::settings_view(app)
}

#[tauri::command]
pub async fn get_llm_settings(app: AppHandle) -> Result<LlmSettingsView, String> {
    llm::settings_request(&app, der_llm::Request::SettingsGet).await
}

#[tauri::command]
pub async fn set_llm_settings(app: AppHandle, settings: LlmSettings) -> Result<LlmSettingsView, String> {
    llm::settings_request(&app, der_llm::Request::SettingsSet { settings }).await
}

/// For "claude-subscription" the value is treated as a long-lived OAuth token
/// (the `claude setup-token` fallback); everything else is a plain API key.
#[tauri::command]
pub async fn set_llm_credential(
    app: AppHandle,
    provider: String,
    secret: String,
) -> Result<LlmSettingsView, String> {
    llm::settings_request(&app, der_llm::Request::CredentialSet { provider, secret }).await
}

#[tauri::command]
pub async fn clear_llm_credential(app: AppHandle, provider: String) -> Result<LlmSettingsView, String> {
    llm::settings_request(&app, der_llm::Request::CredentialClear { provider }).await
}
