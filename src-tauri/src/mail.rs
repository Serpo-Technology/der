//! Host-owned SMTP sending: the platform layer behind the email.send
//! builtin. The server, account, and password live in settings like every
//! other secret; contracts supply only the message fields, so mail can
//! only ever leave through the server the user configured.

use lettre::message::Mailbox;
use lettre::transport::smtp::authentication::Credentials;
use lettre::{Message, SmtpTransport, Transport};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;

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

fn config_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("App data dir: {}", e))?
        .join("settings");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Settings dir: {}", e))?;
    Ok(dir.join("smtp.json"))
}

pub fn load_config(app: &AppHandle) -> SmtpConfig {
    let Ok(path) = config_path(app) else {
        return SmtpConfig::default();
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn save_config(app: &AppHandle, config: &SmtpConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let text = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| format!("Could not save SMTP settings: {}", e))
}

/// What the panel sees: everything except the password, which only reports
/// whether one is stored.
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

pub fn send_core(
    app: &AppHandle,
    from: &str,
    to: &str,
    subject: &str,
    text: &str,
) -> Result<Value, String> {
    let config = load_config(app);
    if config.host.is_empty() {
        return Err(
            "Email is not set up; add your SMTP server under Settings before sending".to_string(),
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
    let transport = builder
        .timeout(Some(std::time::Duration::from_secs(30)))
        .build();

    transport
        .send(&message)
        .map_err(|e| format!("Sending failed: {}", e))?;
    Ok(json!({ "sent": true, "to": to.trim() }))
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

#[tauri::command]
pub fn smtp_get(app: AppHandle) -> Value {
    redacted_view(&app)
}

#[tauri::command]
pub fn smtp_save(app: AppHandle, config: SmtpConfig) -> Result<Value, String> {
    save_keeping_password(&app, config)
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
}
