//! Host-owned SMTP sending: the platform layer behind the email.send
//! builtin. The mail account is one credential in the shared store (kind
//! "smtp", name "mail"): the password is the secret, the server details are
//! its fields, and it follows the same redaction rules as every other
//! credential. Contracts supply only the message fields, and the first
//! unconfigured send opens the host-drawn account sheet in the app's flow.

use std::collections::BTreeMap;

use lettre::message::Mailbox;
use lettre::transport::smtp::authentication::Credentials;
use lettre::{Message, SmtpTransport, Transport};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::settings::{load_integrations, save_integrations, IntegrationCredential};

/// The reserved credential name the mail account lives under.
pub const ACCOUNT_NAME: &str = "mail";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SmtpConfig {
    pub host: String,
    pub port: Option<u16>,
    pub username: String,
    pub password: String,
    /// "tls" (implicit, usually 465) or "starttls" (usually 587).
    pub security: String,
    /// Default sender, e.g. "Me <me@example.net>".
    pub from: String,
}

impl SmtpConfig {
    fn from_credential(credential: &IntegrationCredential) -> Self {
        let field = |key: &str| -> String {
            credential
                .fields
                .as_ref()
                .and_then(|fields| fields.get(key))
                .cloned()
                .unwrap_or_default()
        };
        SmtpConfig {
            host: field("host"),
            port: field("port").trim().parse::<u16>().ok(),
            username: field("username"),
            password: credential.secret.clone(),
            security: field("security"),
            from: field("from"),
        }
    }

    fn to_credential(&self) -> IntegrationCredential {
        let mut fields = BTreeMap::new();
        fields.insert("host".to_string(), self.host.clone());
        if let Some(port) = self.port {
            fields.insert("port".to_string(), port.to_string());
        }
        fields.insert("username".to_string(), self.username.clone());
        fields.insert(
            "security".to_string(),
            if self.security.is_empty() { "starttls".to_string() } else { self.security.clone() },
        );
        fields.insert("from".to_string(), self.from.clone());
        IntegrationCredential {
            kind: "smtp".to_string(),
            target: None,
            base_url: None,
            notes: None,
            fields: Some(fields),
            secret: self.password.clone(),
        }
    }
}

/// One-time migration from the short-lived settings/smtp.json file into the
/// credential store.
fn migrate_legacy_file(app: &AppHandle) -> Option<SmtpConfig> {
    use tauri::Manager;
    let path = app.path().app_data_dir().ok()?.join("settings").join("smtp.json");
    let config: SmtpConfig = serde_json::from_str(&std::fs::read_to_string(&path).ok()?).ok()?;
    if config.host.is_empty() {
        let _ = std::fs::remove_file(&path);
        return None;
    }
    let mut integrations = load_integrations(app);
    integrations
        .credentials
        .insert(ACCOUNT_NAME.to_string(), config.to_credential());
    if save_integrations(app, &integrations).is_ok() {
        let _ = std::fs::remove_file(&path);
    }
    Some(config)
}

pub fn load_config(app: &AppHandle) -> SmtpConfig {
    let integrations = load_integrations(app);
    match integrations.credentials.get(ACCOUNT_NAME) {
        Some(credential) if credential.kind == "smtp" => SmtpConfig::from_credential(credential),
        _ => migrate_legacy_file(app).unwrap_or_default(),
    }
}

pub fn save_config(app: &AppHandle, config: &SmtpConfig) -> Result<(), String> {
    let mut integrations = load_integrations(app);
    integrations
        .credentials
        .insert(ACCOUNT_NAME.to_string(), config.to_credential());
    save_integrations(app, &integrations)
}

pub fn delete_account(app: &AppHandle) -> Result<(), String> {
    let mut integrations = load_integrations(app);
    integrations.credentials.remove(ACCOUNT_NAME);
    save_integrations(app, &integrations)
}

/// What settings screens see: everything except the password, which only
/// reports whether one is stored.
pub fn redacted_view(app: &AppHandle) -> Value {
    let config = load_config(app);
    json!({
        "host": config.host,
        "port": config.port,
        "username": config.username,
        "hasPassword": !config.password.is_empty(),
        "security": if config.security.is_empty() { "starttls".to_string() } else { config.security },
        "from": config.from,
    })
}

/// Normalizes an incoming save: whitespace trimmed, and an empty password
/// keeps the stored one so the redacted view can round-trip through
/// settings screens without wiping it.
pub fn merge_saved(mut config: SmtpConfig, stored_password: String) -> SmtpConfig {
    if config.password.is_empty() {
        config.password = stored_password;
    }
    config.host = config.host.trim().to_string();
    config.username = config.username.trim().to_string();
    config.from = config.from.trim().to_string();
    config
}

pub fn save_keeping_password(app: &AppHandle, config: SmtpConfig) -> Result<Value, String> {
    let merged = merge_saved(config, load_config(app).password);
    save_config(app, &merged)?;
    Ok(redacted_view(app))
}

fn transport_for(config: &SmtpConfig) -> Result<SmtpTransport, String> {
    let mut builder = if config.security == "tls" {
        SmtpTransport::relay(&config.host)
    } else {
        SmtpTransport::starttls_relay(&config.host)
    }
    .map_err(|e| format!("SMTP connection setup failed: {}", e))?;
    if let Some(port) = config.port {
        builder = builder.port(port);
    }
    if !config.username.is_empty() {
        builder = builder.credentials(Credentials::new(
            config.username.clone(),
            config.password.clone(),
        ));
    }
    Ok(builder
        .timeout(Some(std::time::Duration::from_secs(30)))
        .build())
}

pub fn send_core(
    app: &AppHandle,
    from: &str,
    to: &str,
    subject: &str,
    text: &str,
) -> Result<Value, String> {
    let mut config = load_config(app);
    if config.host.is_empty() {
        // In-flow setup: the panel draws the account sheet, the secret goes
        // straight into the store, and the send continues. Without a panel
        // the error points at Settings.
        match crate::runtime::sidecar::panel_mail_account(app, &redacted_view(app)) {
            Some(saved) => {
                save_keeping_password(app, saved)?;
                config = load_config(app);
            }
            None => {}
        }
    }
    if config.host.is_empty() {
        return Err(
            "Email is not set up; add your mail account under Settings before sending".to_string(),
        );
    }
    let sender = if from.trim().is_empty() { config.from.clone() } else { from.to_string() };
    if sender.trim().is_empty() {
        return Err("email.send needs a sender: set a default in Settings or bind \"from\"".to_string());
    }
    let from_box: Mailbox = sender
        .parse()
        .map_err(|_| format!("The sender address is not valid: {}", sender))?;
    let to_box: Mailbox = to
        .trim()
        .parse()
        .map_err(|_| format!("The recipient address is not valid: {}", to))?;

    let message = Message::builder()
        .from(from_box)
        .to(to_box)
        .subject(subject)
        .body(text.to_string())
        .map_err(|e| format!("The message could not be built: {}", e))?;

    transport_for(&config)?
        .send(&message)
        .map_err(|e| format!("Sending failed: {}", e))?;
    Ok(json!({ "sent": true, "to": to.trim() }))
}

#[tauri::command]
pub fn smtp_get(app: AppHandle) -> Value {
    redacted_view(&app)
}

#[tauri::command]
pub fn smtp_save(app: AppHandle, config: SmtpConfig) -> Result<Value, String> {
    save_keeping_password(&app, config)
}

#[tauri::command]
pub fn smtp_delete(app: AppHandle) -> Result<Value, String> {
    delete_account(&app)?;
    Ok(redacted_view(&app))
}

#[tauri::command]
pub async fn email_send(
    app: AppHandle,
    from: Option<String>,
    to: String,
    subject: String,
    text: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        send_core(&app, from.as_deref().unwrap_or(""), &to, &subject, &text)
    })
    .await
    .map_err(|e| format!("email.send failed: {}", e))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_password_keeps_the_stored_one() {
        let incoming = SmtpConfig {
            host: " smtp.example.net ".to_string(),
            username: "me@example.net".to_string(),
            password: String::new(),
            security: "starttls".to_string(),
            from: " Me <me@example.net> ".to_string(),
            port: None,
        };
        let merged = merge_saved(incoming, "stored-secret".to_string());
        assert_eq!(merged.password, "stored-secret");
        assert_eq!(merged.host, "smtp.example.net");
        assert_eq!(merged.from, "Me <me@example.net>");
    }

    #[test]
    fn a_typed_password_replaces_the_stored_one() {
        let incoming = SmtpConfig {
            password: "fresh".to_string(),
            ..SmtpConfig::default()
        };
        let merged = merge_saved(incoming, "stored-secret".to_string());
        assert_eq!(merged.password, "fresh");
    }

    #[test]
    fn the_account_round_trips_through_the_credential_record() {
        let config = SmtpConfig {
            host: "smtp.example.net".to_string(),
            port: Some(587),
            username: "me@example.net".to_string(),
            password: "secret".to_string(),
            security: "starttls".to_string(),
            from: "Me <me@example.net>".to_string(),
        };
        let credential = config.to_credential();
        assert_eq!(credential.kind, "smtp");
        let back = SmtpConfig::from_credential(&credential);
        assert_eq!(back.host, config.host);
        assert_eq!(back.port, config.port);
        assert_eq!(back.username, config.username);
        assert_eq!(back.password, config.password);
        assert_eq!(back.security, config.security);
        assert_eq!(back.from, config.from);
    }
}
