//! What the gateway keeps on disk: the model settings (settings/llm.json)
//! and the credentials (settings/credentials.json, readable by its owner
//! only), which are the API keys and the Claude sign-in tokens. Callers
//! outside this crate see a `SettingsView`, where every secret is a short
//! preview.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

const SETTINGS_FILE: &str = "llm.json";
const CREDENTIALS_FILE: &str = "credentials.json";

/// Providers the gateway understands. "claude-subscription" authenticates
/// with an OAuth bearer token; every other provider uses an API key.
pub const PROVIDERS: &[&str] = &[
    "claude-subscription",
    "anthropic",
    "deepseek",
    "gemini",
    "openai",
    "mercury",
    "local",
];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub provider: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
}

impl Default for Settings {
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
pub(crate) struct ClaudeOauthTokens {
    pub access_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    /// Unix seconds. None for long-lived manually pasted tokens.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredCredentials {
    #[serde(default)]
    pub api_keys: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_oauth: Option<ClaudeOauthTokens>,
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeOauthStatus {
    pub signed_in: bool,
    pub has_refresh_token: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    pub token_preview: String,
}

/// What settings screens see: the full non-secret settings and a redacted
/// preview of each credential.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    pub settings: Settings,
    pub providers: Vec<String>,
    pub api_keys: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_oauth: Option<ClaudeOauthStatus>,
}

impl SettingsView {
    /// The view of a gateway with nothing saved.
    pub fn empty() -> Self {
        SettingsView {
            settings: Settings::default(),
            providers: PROVIDERS.iter().map(|p| p.to_string()).collect(),
            api_keys: HashMap::new(),
            claude_oauth: None,
        }
    }
}

/// The two files under one settings directory.
pub(crate) struct Store {
    dir: PathBuf,
    /// Held across each read-modify-write of the credentials file, so a
    /// token refresh and a settings save never overwrite each other.
    writing: Mutex<()>,
}

impl Store {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Store {
            dir: dir.into(),
            writing: Mutex::new(()),
        }
    }

    pub fn settings(&self) -> Settings {
        fs::read_to_string(self.dir.join(SETTINGS_FILE))
            .ok()
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default()
    }

    pub fn save_settings(&self, settings: &Settings) -> Result<(), String> {
        if !PROVIDERS.contains(&settings.provider.as_str()) {
            return Err(format!("Unknown provider: {}", settings.provider));
        }
        let json = serde_json::to_string_pretty(settings)
            .map_err(|e| format!("Failed to serialize settings: {}", e))?;
        fs::create_dir_all(&self.dir).map_err(|e| format!("Failed to create settings directory: {}", e))?;
        fs::write(self.dir.join(SETTINGS_FILE), json).map_err(|e| format!("Failed to save settings: {}", e))
    }

    pub fn credentials(&self) -> StoredCredentials {
        fs::read_to_string(self.dir.join(CREDENTIALS_FILE))
            .ok()
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default()
    }

    /// Reads the credentials, applies `change`, and writes them back.
    pub fn update_credentials(&self, change: impl FnOnce(&mut StoredCredentials)) -> Result<(), String> {
        let _writing = self.writing.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut credentials = self.credentials();
        change(&mut credentials);
        let json = serde_json::to_string_pretty(&credentials)
            .map_err(|e| format!("Failed to serialize credentials: {}", e))?;
        fs::create_dir_all(&self.dir).map_err(|e| format!("Failed to create settings directory: {}", e))?;
        let path = self.dir.join(CREDENTIALS_FILE);
        fs::write(&path, json).map_err(|e| format!("Failed to save credentials: {}", e))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }

    /// Saves one provider's credential. For "claude-subscription" the value
    /// is a long-lived OAuth token (the `claude setup-token` fallback);
    /// everything else is a plain API key.
    pub fn set_credential(&self, provider: &str, secret: &str) -> Result<(), String> {
        let secret = secret.trim().to_string();
        if secret.is_empty() {
            return Err("Credential is empty".to_string());
        }
        self.update_credentials(|credentials| {
            if provider == "claude-subscription" {
                credentials.claude_oauth = Some(ClaudeOauthTokens {
                    access_token: secret,
                    refresh_token: None,
                    expires_at: None,
                });
            } else {
                credentials.api_keys.insert(provider.to_string(), secret);
            }
        })
    }

    pub fn clear_credential(&self, provider: &str) -> Result<(), String> {
        self.update_credentials(|credentials| {
            if provider == "claude-subscription" {
                credentials.claude_oauth = None;
            } else {
                credentials.api_keys.remove(provider);
            }
        })
    }

    pub fn view(&self) -> SettingsView {
        let credentials = self.credentials();
        SettingsView {
            settings: self.settings(),
            providers: PROVIDERS.iter().map(|p| p.to_string()).collect(),
            api_keys: credentials
                .api_keys
                .iter()
                .map(|(provider, key)| (provider.clone(), redact(key)))
                .collect(),
            claude_oauth: credentials.claude_oauth.as_ref().map(|tokens| ClaudeOauthStatus {
                signed_in: true,
                has_refresh_token: tokens.refresh_token.is_some(),
                expires_at: tokens.expires_at,
                token_preview: redact(&tokens.access_token),
            }),
        }
    }

    /// True when the configured provider can answer: signed in for the
    /// Claude subscription, a stored key for API providers, a base URL for
    /// local.
    pub fn ready(&self) -> bool {
        let settings = self.settings();
        let credentials = self.credentials();
        match settings.provider.as_str() {
            "claude-subscription" => credentials.claude_oauth.is_some(),
            "local" => settings
                .base_url
                .as_deref()
                .is_some_and(|url| !url.trim().is_empty()),
            provider => credentials
                .api_keys
                .get(provider)
                .is_some_and(|key| !key.trim().is_empty()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "sk-test-0123456789abcdef";

    #[test]
    fn a_saved_key_shows_only_as_a_preview() {
        let dir = tempfile::tempdir().expect("temp dir");
        let store = Store::new(dir.path());
        assert_eq!(store.view(), SettingsView::empty());

        store.set_credential("openai", &format!("  {KEY} ")).expect("saves");
        store.set_credential("mercury", "short").expect("saves");
        assert_eq!(store.credentials().api_keys["openai"], KEY);
        let view = store.view();
        assert_eq!(view.api_keys["openai"], "sk-tes...cdef");
        assert_eq!(view.api_keys["mercury"], "***");
        assert!(!serde_json::to_string(&view).expect("serializes").contains(KEY));

        assert!(store.set_credential("openai", "  ").is_err(), "an empty credential is refused");
        store.clear_credential("openai").expect("clears");
        assert!(!store.view().api_keys.contains_key("openai"));
    }

    #[cfg(unix)]
    #[test]
    fn the_credentials_file_is_readable_by_its_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("temp dir");
        Store::new(dir.path()).set_credential("openai", KEY).expect("saves");
        let mode = fs::metadata(dir.path().join(CREDENTIALS_FILE))
            .expect("metadata")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn a_pasted_claude_token_counts_as_signed_in_without_a_refresh_token() {
        let dir = tempfile::tempdir().expect("temp dir");
        let store = Store::new(dir.path());
        store.set_credential("claude-subscription", KEY).expect("saves");
        let status = store.view().claude_oauth.expect("signed in");
        assert!(status.signed_in);
        assert!(!status.has_refresh_token);
        assert_eq!(status.token_preview, "sk-tes...cdef");
        store.clear_credential("claude-subscription").expect("clears");
        assert_eq!(store.view().claude_oauth, None);
    }

    #[test]
    fn settings_round_trip_and_refuse_an_unknown_provider() {
        let dir = tempfile::tempdir().expect("temp dir");
        let store = Store::new(dir.path());
        let settings = Settings {
            provider: "local".to_string(),
            model: "llama3".to_string(),
            base_url: Some("http://localhost:11434".to_string()),
            temperature: Some(0.2),
            max_tokens: Some(4096),
        };
        store.save_settings(&settings).expect("saves");
        assert_eq!(store.settings(), settings);
        let unknown = Settings {
            provider: "nobody".to_string(),
            ..settings
        };
        assert_eq!(store.save_settings(&unknown), Err("Unknown provider: nobody".to_string()));
    }

    #[test]
    fn ready_follows_the_configured_provider() {
        let dir = tempfile::tempdir().expect("temp dir");
        let store = Store::new(dir.path());
        assert!(!store.ready(), "the default provider needs a sign-in");
        store.set_credential("claude-subscription", KEY).expect("saves");
        assert!(store.ready());

        let mut settings = Settings {
            provider: "openai".to_string(),
            ..Settings::default()
        };
        store.save_settings(&settings).expect("saves");
        assert!(!store.ready(), "openai needs its own key");
        store.set_credential("openai", KEY).expect("saves");
        assert!(store.ready());

        settings.provider = "local".to_string();
        store.save_settings(&settings).expect("saves");
        assert!(!store.ready(), "local needs a base URL");
        settings.base_url = Some("http://localhost:11434".to_string());
        store.save_settings(&settings).expect("saves");
        assert!(store.ready());
    }
}
