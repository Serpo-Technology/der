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
    /// Incoming (IMAP) server; empty when the account is send-only.
    /// Implicit TLS, usually port 993; the same username and password.
    pub imap_host: String,
    pub imap_port: Option<u16>,
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
            imap_host: field("imapHost"),
            imap_port: field("imapPort").trim().parse::<u16>().ok(),
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
        if !self.imap_host.is_empty() {
            fields.insert("imapHost".to_string(), self.imap_host.clone());
        }
        if let Some(port) = self.imap_port {
            fields.insert("imapPort".to_string(), port.to_string());
        }
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
        "imapHost": config.imap_host,
        "imapPort": config.imap_port,
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
    config.imap_host = config.imap_host.trim().to_string();
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

/// Ensures the account has an incoming server, running the in-flow sheet
/// when the panel can present it.
fn ensure_incoming(app: &AppHandle) -> Result<SmtpConfig, String> {
    let mut config = load_config(app);
    if config.imap_host.is_empty() {
        if let Some(saved) = crate::runtime::sidecar::panel_mail_account(app, &redacted_view(app)) {
            save_keeping_password(app, saved)?;
            config = load_config(app);
        }
    }
    if config.imap_host.is_empty() {
        return Err(
            "Incoming mail is not set up; add your IMAP server to the mail account in Settings"
                .to_string(),
        );
    }
    Ok(config)
}

type ImapSession = imap::Session<rustls::StreamOwned<rustls::ClientConnection, std::net::TcpStream>>;

/// Implicit-TLS IMAP connection with the account's credentials. The read
/// side deliberately supports only the TLS port (usually 993).
fn imap_session(config: &SmtpConfig) -> Result<ImapSession, String> {
    let host = config.imap_host.trim();
    let port = config.imap_port.unwrap_or(993);
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let tls_config = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let server_name = rustls::pki_types::ServerName::try_from(host.to_string())
        .map_err(|_| format!("The incoming server name is not valid: {}", host))?;
    let connection = rustls::ClientConnection::new(std::sync::Arc::new(tls_config), server_name)
        .map_err(|e| format!("TLS setup failed: {}", e))?;
    let tcp = std::net::TcpStream::connect((host, port))
        .map_err(|e| format!("Could not reach {}:{}: {}", host, port, e))?;
    let _ = tcp.set_read_timeout(Some(std::time::Duration::from_secs(30)));
    let _ = tcp.set_write_timeout(Some(std::time::Duration::from_secs(30)));
    let stream = rustls::StreamOwned::new(connection, tcp);
    let mut client = imap::Client::new(stream);
    client
        .read_greeting()
        .map_err(|e| format!("The mail server did not answer: {}", e))?;
    client
        .login(&config.username, &config.password)
        .map_err(|(error, _)| format!("Mail sign-in failed: {}", error))
}

/// RFC 2047 encoded-word decoding via a synthetic header, so subjects and
/// names read as text instead of =?UTF-8?...?= runs.
fn decode_word(raw: &[u8]) -> String {
    let mut line = b"X: ".to_vec();
    line.extend_from_slice(raw);
    match mailparse::parse_header(&line) {
        Ok((header, _)) => header.get_value(),
        Err(_) => String::from_utf8_lossy(raw).to_string(),
    }
}

fn first_text_part(mail: &mailparse::ParsedMail, mimetype: &str) -> Option<String> {
    if mail.subparts.is_empty() {
        if mail.ctype.mimetype.eq_ignore_ascii_case(mimetype) {
            return mail.get_body().ok();
        }
        return None;
    }
    mail.subparts
        .iter()
        .find_map(|part| first_text_part(part, mimetype))
}

/// Just enough HTML stripping for a readable fallback body; rich rendering
/// belongs to viewer elements.
fn strip_html(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    let decoded = out
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'");
    let mut lines: Vec<&str> = decoded.lines().map(str::trim).collect();
    lines.retain(|line| !line.is_empty());
    lines.join("\n")
}

fn envelope_fields(fetch: &imap::types::Fetch) -> (String, String, String) {
    let envelope = fetch.envelope();
    let subject = envelope
        .and_then(|e| e.subject.as_ref())
        .map(|s| decode_word(s))
        .unwrap_or_default();
    let from = envelope
        .and_then(|e| e.from.as_ref())
        .and_then(|list| list.first())
        .map(|address| {
            let name = address
                .name
                .as_ref()
                .map(|n| decode_word(n))
                .unwrap_or_default();
            let mailbox = address
                .mailbox
                .as_ref()
                .map(|m| String::from_utf8_lossy(m).to_string())
                .unwrap_or_default();
            let host = address
                .host
                .as_ref()
                .map(|h| String::from_utf8_lossy(h).to_string())
                .unwrap_or_default();
            let email = if mailbox.is_empty() || host.is_empty() {
                String::new()
            } else {
                format!("{}@{}", mailbox, host)
            };
            match (name.is_empty(), email.is_empty()) {
                (false, false) => format!("{} <{}>", name, email),
                (false, true) => name,
                (true, false) => email,
                (true, true) => String::new(),
            }
        })
        .unwrap_or_default();
    let date = envelope
        .and_then(|e| e.date.as_ref())
        .map(|d| String::from_utf8_lossy(d).to_string())
        .unwrap_or_default();
    (subject, from, date)
}

/// The latest inbox messages, newest first: {messages: [{id, from,
/// subject, date, seen}], count}. Ids are IMAP UIDs as strings.
pub fn list_core(app: &AppHandle, limit_text: &str) -> Result<Value, String> {
    let config = ensure_incoming(app)?;
    let limit: u32 = limit_text
        .trim()
        .parse()
        .ok()
        .filter(|n| (1..=200).contains(n))
        .unwrap_or(30);
    let mut session = imap_session(&config)?;
    let mailbox = session
        .select("INBOX")
        .map_err(|e| format!("Could not open the inbox: {}", e))?;
    let mut messages: Vec<Value> = Vec::new();
    if mailbox.exists > 0 {
        let start = mailbox.exists.saturating_sub(limit - 1).max(1);
        let range = format!("{}:{}", start, mailbox.exists);
        let fetches = session
            .fetch(&range, "(UID ENVELOPE FLAGS)")
            .map_err(|e| format!("Could not read the inbox: {}", e))?;
        for fetch in fetches.iter() {
            let (subject, from, date) = envelope_fields(fetch);
            let seen = fetch
                .flags()
                .iter()
                .any(|flag| matches!(flag, imap::types::Flag::Seen));
            messages.push(json!({
                "id": fetch.uid.unwrap_or(0).to_string(),
                "from": from,
                "subject": subject,
                "date": date,
                "seen": seen,
            }));
        }
    }
    messages.reverse();
    let _ = session.logout();
    Ok(json!({ "messages": messages, "count": messages.len() }))
}

/// One message by UID, marked read by the fetch: {id, from, subject, date,
/// text, seen}.
pub fn fetch_core(app: &AppHandle, id_text: &str) -> Result<Value, String> {
    let config = ensure_incoming(app)?;
    let uid = id_text.trim();
    if uid.is_empty() || !uid.bytes().all(|b| b.is_ascii_digit()) {
        return Err("email.fetch needs a message \"id\" from email.list".to_string());
    }
    let mut session = imap_session(&config)?;
    session
        .select("INBOX")
        .map_err(|e| format!("Could not open the inbox: {}", e))?;
    let fetches = session
        .uid_fetch(uid, "(UID ENVELOPE BODY[])")
        .map_err(|e| format!("Could not read the message: {}", e))?;
    let fetch = fetches
        .iter()
        .next()
        .ok_or_else(|| format!("No message with id {}", uid))?;
    let (subject, from, date) = envelope_fields(fetch);
    let raw = fetch.body().unwrap_or_default();
    let parsed = mailparse::parse_mail(raw)
        .map_err(|e| format!("The message could not be parsed: {}", e))?;
    let text = first_text_part(&parsed, "text/plain")
        .or_else(|| first_text_part(&parsed, "text/html").map(|html| strip_html(&html)))
        .unwrap_or_default();
    let _ = session.logout();
    Ok(json!({
        "id": uid,
        "from": from,
        "subject": subject,
        "date": date,
        "text": text,
        "seen": true,
    }))
}

#[tauri::command]
pub async fn mail_list(app: AppHandle, limit: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || list_core(&app, limit.as_deref().unwrap_or("")))
        .await
        .map_err(|e| format!("mail.list failed: {}", e))?
}

#[tauri::command]
pub async fn mail_fetch(app: AppHandle, id: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || fetch_core(&app, &id))
        .await
        .map_err(|e| format!("mail.fetch failed: {}", e))?
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
            imap_host: " imap.example.net ".to_string(),
            ..SmtpConfig::default()
        };
        let merged = merge_saved(incoming, "stored-secret".to_string());
        assert_eq!(merged.password, "stored-secret");
        assert_eq!(merged.host, "smtp.example.net");
        assert_eq!(merged.from, "Me <me@example.net>");
        assert_eq!(merged.imap_host, "imap.example.net");
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
            imap_host: "imap.example.net".to_string(),
            imap_port: Some(993),
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
        assert_eq!(back.imap_host, config.imap_host);
        assert_eq!(back.imap_port, config.imap_port);
    }

    #[test]
    fn html_fallback_bodies_strip_to_readable_text() {
        let html = "<div><p>Hello &amp; welcome,</p>\n<p>see you <b>soon</b>.</p></div>";
        assert_eq!(strip_html(html), "Hello & welcome,\nsee you soon.");
    }
}
