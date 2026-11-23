//! Host-owned mail: the platform layer behind the email.* builtins. The
//! mail account lives in its own file, settings/mail.json, readable by its
//! owner only: the password beside the server details. Settings screens see
//! a redacted view. Contracts supply only the message fields, and the first
//! unconfigured send opens the host-drawn account sheet in the app's flow.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use lettre::message::Mailbox;
use lettre::transport::smtp::authentication::Credentials;
use lettre::{Message, SmtpTransport, Transport};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::secrets::Secrets;
use crate::settings::settings_dir;

const ACCOUNT_FILE: &str = der_http::store::MAIL_ACCOUNT_FILE;
const LEGACY_FILE: &str = "smtp.json";

/// The account as its file holds it: the password is the secret and the
/// server details are string fields.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct AccountRecord {
    fields: BTreeMap<String, String>,
    secret: String,
}

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
    fn from_record(record: &AccountRecord) -> Self {
        let field = |key: &str| -> String { record.fields.get(key).cloned().unwrap_or_default() };
        SmtpConfig {
            host: field("host"),
            port: field("port").trim().parse::<u16>().ok(),
            username: field("username"),
            password: record.secret.clone(),
            security: field("security"),
            from: field("from"),
            imap_host: field("imapHost"),
            imap_port: field("imapPort").trim().parse::<u16>().ok(),
        }
    }

    fn to_record(&self) -> AccountRecord {
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
        AccountRecord {
            fields,
            secret: self.password.clone(),
        }
    }
}

fn read_account(dir: &Path) -> SmtpConfig {
    fs::read_to_string(dir.join(ACCOUNT_FILE))
        .ok()
        .and_then(|json| serde_json::from_str::<AccountRecord>(&json).ok())
        .map(|record| SmtpConfig::from_record(&record))
        .unwrap_or_default()
}

fn write_account(dir: &Path, config: &SmtpConfig) -> Result<(), String> {
    let json = serde_json::to_string_pretty(&config.to_record())
        .map_err(|e| format!("Failed to serialize the mail account: {}", e))?;
    let path = dir.join(ACCOUNT_FILE);
    fs::write(&path, json).map_err(|e| format!("Failed to save the mail account: {}", e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn remove_account(dir: &Path) -> Result<(), String> {
    match fs::remove_file(dir.join(ACCOUNT_FILE)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Failed to remove the mail account: {}", error)),
    }
}

/// Brings an account saved in an older place into the account file. The
/// credential store releases a mail record it holds, and it writes the file
/// itself so the password never crosses back. A settings/smtp.json file
/// converts when no account file exists, and is removed either way.
pub(crate) fn migrate_account_core(dir: &Path, secrets: &Secrets) {
    let _ = secrets.store(der_http::Request::MailAccountRelease);
    let legacy = dir.join(LEGACY_FILE);
    let Ok(text) = fs::read_to_string(&legacy) else {
        return;
    };
    if dir.join(ACCOUNT_FILE).exists() {
        let _ = fs::remove_file(&legacy);
        return;
    }
    let Ok(config) = serde_json::from_str::<SmtpConfig>(&text) else {
        return;
    };
    if config.host.is_empty() || write_account(dir, &config).is_ok() {
        let _ = fs::remove_file(&legacy);
    }
}

pub fn migrate_account(app: &AppHandle) {
    if let (Ok(dir), Ok(secrets)) = (settings_dir(app), Secrets::for_app(app)) {
        migrate_account_core(&dir, &secrets);
    }
}

pub fn load_config(app: &AppHandle) -> SmtpConfig {
    settings_dir(app)
        .map(|dir| read_account(&dir))
        .unwrap_or_default()
}

pub fn save_config(app: &AppHandle, config: &SmtpConfig) -> Result<(), String> {
    write_account(&settings_dir(app)?, config)
}

pub fn delete_account(app: &AppHandle) -> Result<(), String> {
    remove_account(&settings_dir(app)?)
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
        // In-flow setup: the panel draws the account sheet, the password
        // goes straight into the account file, and the send continues.
        // Without a panel the error points at Settings.
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

    fn account() -> SmtpConfig {
        SmtpConfig {
            host: "smtp.example.net".to_string(),
            port: Some(587),
            username: "me@example.net".to_string(),
            password: "mail-passw0rd".to_string(),
            security: "starttls".to_string(),
            from: "Me <me@example.net>".to_string(),
            imap_host: "imap.example.net".to_string(),
            imap_port: Some(993),
        }
    }

    #[test]
    fn the_account_round_trips_through_its_file() {
        let dir = tempfile::tempdir().expect("temp dir");
        assert!(read_account(dir.path()).host.is_empty());
        let config = account();
        write_account(dir.path(), &config).expect("saves");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(dir.path().join(ACCOUNT_FILE))
                .expect("metadata")
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let back = read_account(dir.path());
        assert_eq!(back.host, config.host);
        assert_eq!(back.port, config.port);
        assert_eq!(back.username, config.username);
        assert_eq!(back.password, config.password);
        assert_eq!(back.security, config.security);
        assert_eq!(back.from, config.from);
        assert_eq!(back.imap_host, config.imap_host);
        assert_eq!(back.imap_port, config.imap_port);

        remove_account(dir.path()).expect("removes");
        assert!(read_account(dir.path()).host.is_empty());
        remove_account(dir.path()).expect("removing a missing account is fine");
    }

    #[test]
    fn an_account_in_the_credential_store_moves_into_the_file() {
        use der_http::store::{self, IntegrationCredential, StoredIntegrations};
        let dir = tempfile::tempdir().expect("temp dir");
        let record = account().to_record();
        let mut integrations = StoredIntegrations::default();
        integrations.credentials.insert(
            "mail".to_string(),
            IntegrationCredential {
                kind: "smtp".to_string(),
                target: None,
                base_url: None,
                notes: None,
                fields: Some(record.fields),
                secret: record.secret,
            },
        );
        store::save(dir.path(), &integrations).expect("seeds the store");

        migrate_account_core(dir.path(), &Secrets::at(dir.path()));
        let moved = read_account(dir.path());
        assert_eq!(moved.host, "smtp.example.net");
        assert_eq!(moved.port, Some(587));
        assert_eq!(moved.imap_port, Some(993));
        assert_eq!(moved.password, "mail-passw0rd");
        assert!(store::load(dir.path()).credentials.is_empty());
    }

    #[test]
    fn a_legacy_account_file_converts_once() {
        let dir = tempfile::tempdir().expect("temp dir");
        let legacy = dir.path().join(LEGACY_FILE);
        fs::write(&legacy, serde_json::to_string(&account()).expect("json")).expect("writes");
        migrate_account_core(dir.path(), &Secrets::at(dir.path()));
        assert!(!legacy.exists());
        assert_eq!(read_account(dir.path()).password, "mail-passw0rd");

        // A leftover legacy file never replaces the account file.
        let mut other = account();
        other.host = "other.example.net".to_string();
        fs::write(&legacy, serde_json::to_string(&other).expect("json")).expect("writes");
        migrate_account_core(dir.path(), &Secrets::at(dir.path()));
        assert!(!legacy.exists());
        assert_eq!(read_account(dir.path()).host, "smtp.example.net");
    }

    #[test]
    fn html_fallback_bodies_strip_to_readable_text() {
        let html = "<div><p>Hello &amp; welcome,</p>\n<p>see you <b>soon</b>.</p></div>";
        assert_eq!(strip_html(html), "Hello & welcome,\nsee you soon.");
    }
}
