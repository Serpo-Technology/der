use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Providers the app understands. "claude-subscription" authenticates with an
/// OAuth bearer token; every other provider uses an API key from the store.
pub const PROVIDERS: &[&str] = &[
    "claude-subscription",
    "anthropic",
    "deepseek",
    "gemini",
    "openai",
    "mercury",
    "local",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmSettings {
    pub provider: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
}

impl Default for LlmSettings {
    fn default() -> Self {
        Self {
            provider: "claude-subscription".to_string(),
            model: String::new(),
            base_url: None,
            temperature: None,
            max_tokens: None,
        }
    }
}

pub fn default_model(provider: &str) -> &'static str {
    match provider {
        "claude-subscription" | "anthropic" => "claude-opus-4-8",
        "deepseek" => "deepseek-chat",
        "gemini" => "gemini-2.0-flash",
        "openai" => "gpt-4o-mini",
        "mercury" => "mercury-2",
        _ => "",
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeOauthTokens {
    pub access_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    /// Unix seconds. None for long-lived manually pasted tokens.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StoredCredentials {
    #[serde(default)]
    pub api_keys: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_oauth: Option<ClaudeOauthTokens>,
}

/// A named credential a remote operation can reference via
/// implementation.auth. Secrets never leave the Rust side unredacted.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationCredential {
    /// "bearer" (Authorization header), "header" (custom header), "query"
    /// (query parameter), or "smtp" (a mail account consumed only by
    /// email.send, never injectable into HTTP requests).
    pub kind: String,
    /// Header or query-parameter name; unused for bearer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    /// The service origin/prefix the secret is confined to; requests using
    /// this credential must target it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    /// Non-secret guidance shown to the model: endpoint shapes, response
    /// fields, units.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    /// Kind-specific non-secret fields (smtp: host, port, security,
    /// username, from).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fields: Option<std::collections::BTreeMap<String, String>>,
    pub secret: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StoredIntegrations {
    #[serde(default)]
    pub credentials: HashMap<String, IntegrationCredential>,
}

fn integrations_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(settings_dir(app)?.join("integrations.json"))
}

pub fn load_integrations(app: &AppHandle) -> StoredIntegrations {
    integrations_path(app)
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

pub fn save_integrations(app: &AppHandle, integrations: &StoredIntegrations) -> Result<(), String> {
    let json = serde_json::to_string_pretty(integrations)
        .map_err(|e| format!("Failed to serialize integrations: {}", e))?;
    fs::write(integrations_path(app)?, json)
        .map_err(|e| format!("Failed to save integrations: {}", e))
}

/// Redacted view: names and shapes only, never secrets.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationCredentialView {
    pub name: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fields: Option<std::collections::BTreeMap<String, String>>,
}

#[tauri::command]
pub fn list_integration_credentials(app: AppHandle) -> Vec<IntegrationCredentialView> {
    let mut views: Vec<IntegrationCredentialView> = load_integrations(&app)
        .credentials
        .into_iter()
        .map(|(name, cred)| IntegrationCredentialView {
            name,
            kind: cred.kind,
            target: cred.target,
            base_url: cred.base_url,
            notes: cred.notes,
            fields: cred.fields,
        })
        .collect();
    views.sort_by(|a, b| a.name.cmp(&b.name));
    views
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
    let name = name.trim().to_string();
    if name.is_empty()
        || name.len() > 64
        || !name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err("Credential names are 1-64 chars of lowercase, digits, and dashes".to_string());
    }
    if !matches!(kind.as_str(), "bearer" | "header" | "query") {
        return Err("Credential kind must be bearer, header, or query".to_string());
    }
    if kind != "bearer" && target.as_deref().map(str::trim).unwrap_or("").is_empty() {
        return Err("Header and query credentials need a target name".to_string());
    }
    if secret.trim().is_empty() {
        return Err("The secret cannot be empty".to_string());
    }
    let base_url = base_url.trim().trim_end_matches('/').to_string();
    if !base_url.starts_with("https://") && !base_url.starts_with("http://") {
        return Err("The service base URL must be http(s); the secret is only ever sent there".to_string());
    }
    let mut integrations = load_integrations(&app);
    integrations.credentials.insert(
        name,
        IntegrationCredential {
            kind,
            target: target.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()),
            base_url: Some(base_url),
            notes: notes.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()),
            fields: None,
            secret,
        },
    );
    save_integrations(&app, &integrations)?;
    Ok(list_integration_credentials(app))
}

#[tauri::command]
pub fn delete_integration_credential(
    app: AppHandle,
    name: String,
) -> Result<Vec<IntegrationCredentialView>, String> {
    let mut integrations = load_integrations(&app);
    integrations.credentials.remove(&name);
    save_integrations(&app, &integrations)?;
    Ok(list_integration_credentials(app))
}

fn settings_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?
        .join("settings");
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create settings directory: {}", e))?;
    Ok(dir)
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(settings_dir(app)?.join("llm.json"))
}

fn credentials_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(settings_dir(app)?.join("credentials.json"))
}

pub fn load_settings(app: &AppHandle) -> LlmSettings {
    settings_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_settings(app: &AppHandle, settings: &LlmSettings) -> Result<(), String> {
    let json = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;
    fs::write(settings_path(app)?, json).map_err(|e| format!("Failed to save settings: {}", e))
}

pub fn load_credentials(app: &AppHandle) -> StoredCredentials {
    credentials_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_credentials(app: &AppHandle, credentials: &StoredCredentials) -> Result<(), String> {
    let path = credentials_path(app)?;
    let json = serde_json::to_string_pretty(credentials)
        .map_err(|e| format!("Failed to serialize credentials: {}", e))?;
    fs::write(&path, json).map_err(|e| format!("Failed to save credentials: {}", e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn redact(secret: &str) -> String {
    let chars: Vec<char> = secret.chars().collect();
    if chars.len() <= 10 {
        return "***".to_string();
    }
    let head: String = chars[..6].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{}...{}", head, tail)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeOauthStatus {
    pub signed_in: bool,
    pub has_refresh_token: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    pub token_preview: String,
}

/// What the webview sees: full non-secret settings, redacted credential previews.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmSettingsView {
    pub settings: LlmSettings,
    pub providers: Vec<String>,
    pub api_keys: HashMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claude_oauth: Option<ClaudeOauthStatus>,
}

pub fn build_view(app: &AppHandle) -> LlmSettingsView {
    let settings = load_settings(app);
    let credentials = load_credentials(app);
    let api_keys = credentials
        .api_keys
        .iter()
        .map(|(k, v)| (k.clone(), redact(v)))
        .collect();
    let claude_oauth = credentials.claude_oauth.as_ref().map(|t| ClaudeOauthStatus {
        signed_in: true,
        has_refresh_token: t.refresh_token.is_some(),
        expires_at: t.expires_at,
        token_preview: redact(&t.access_token),
    });
    LlmSettingsView {
        settings,
        providers: PROVIDERS.iter().map(|p| p.to_string()).collect(),
        api_keys,
        claude_oauth,
    }
}

#[tauri::command]
pub async fn get_llm_settings(app: AppHandle) -> Result<LlmSettingsView, String> {
    Ok(build_view(&app))
}

#[tauri::command]
pub async fn set_llm_settings(app: AppHandle, settings: LlmSettings) -> Result<LlmSettingsView, String> {
    if !PROVIDERS.contains(&settings.provider.as_str()) {
        return Err(format!("Unknown provider: {}", settings.provider));
    }
    save_settings(&app, &settings)?;
    Ok(build_view(&app))
}

/// For "claude-subscription" the value is treated as a long-lived OAuth token
/// (the `claude setup-token` fallback); everything else is a plain API key.
#[tauri::command]
pub async fn set_llm_credential(
    app: AppHandle,
    provider: String,
    secret: String,
) -> Result<LlmSettingsView, String> {
    let secret = secret.trim().to_string();
    if secret.is_empty() {
        return Err("Credential is empty".to_string());
    }
    let mut credentials = load_credentials(&app);
    if provider == "claude-subscription" {
        credentials.claude_oauth = Some(ClaudeOauthTokens {
            access_token: secret,
            refresh_token: None,
            expires_at: None,
        });
    } else {
        credentials.api_keys.insert(provider, secret);
    }
    save_credentials(&app, &credentials)?;
    Ok(build_view(&app))
}

#[tauri::command]
pub async fn clear_llm_credential(app: AppHandle, provider: String) -> Result<LlmSettingsView, String> {
    let mut credentials = load_credentials(&app);
    if provider == "claude-subscription" {
        credentials.claude_oauth = None;
    } else {
        credentials.api_keys.remove(&provider);
    }
    save_credentials(&app, &credentials)?;
    Ok(build_view(&app))
}
