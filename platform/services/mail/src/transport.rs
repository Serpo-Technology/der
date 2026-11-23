//! The two transports: sending over SMTP and reading over IMAP. Both take
//! the account as an argument and answer the outputs of their operation as
//! JSON, so nothing here reads or writes the account file.

use std::sync::Arc;

use lettre::message::Mailbox;
use lettre::transport::smtp::authentication::Credentials;
use lettre::{Message, SmtpTransport, Transport};
use serde_json::{json, Value};

use crate::account::Account;

fn smtp_transport(account: &Account) -> Result<SmtpTransport, String> {
    let mut builder = if account.security == "tls" {
        SmtpTransport::relay(&account.host)
    } else {
        SmtpTransport::starttls_relay(&account.host)
    }
    .map_err(|e| format!("SMTP connection setup failed: {}", e))?;
    if let Some(port) = account.port {
        builder = builder.port(port);
    }
    if !account.username.is_empty() {
        builder = builder.credentials(Credentials::new(
            account.username.clone(),
            account.password.clone(),
        ));
    }
    Ok(builder
        .timeout(Some(std::time::Duration::from_secs(30)))
        .build())
}

/// Sends one plain-text message: {sent, to}. An empty `from` uses the
/// account's default sender.
pub fn send(account: &Account, from: &str, to: &str, subject: &str, text: &str) -> Result<Value, String> {
    let sender = if from.trim().is_empty() { account.from.clone() } else { from.to_string() };
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

    smtp_transport(account)?
        .send(&message)
        .map_err(|e| format!("Sending failed: {}", e))?;
    Ok(json!({ "sent": true, "to": to.trim() }))
}

/// The TLS setup for the incoming connection. The crypto provider is named
/// here because rustls cannot choose one by itself in a build that links
/// more than one, and it panics when asked to.
fn tls_config() -> Result<Arc<rustls::ClientConfig>, String> {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|e| format!("TLS setup failed: {}", e))?
    .with_root_certificates(roots)
    .with_no_client_auth();
    Ok(Arc::new(config))
}

type ImapSession = imap::Session<rustls::StreamOwned<rustls::ClientConnection, std::net::TcpStream>>;

/// Implicit-TLS IMAP connection with the account's credentials. The read
/// side deliberately supports only the TLS port (usually 993).
fn imap_session(account: &Account) -> Result<ImapSession, String> {
    let host = account.imap_host.trim();
    let port = account.imap_port.unwrap_or(993);
    let server_name = rustls::pki_types::ServerName::try_from(host.to_string())
        .map_err(|_| format!("The incoming server name is not valid: {}", host))?;
    let connection = rustls::ClientConnection::new(tls_config()?, server_name)
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
        .login(&account.username, &account.password)
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
pub fn list(account: &Account, limit_text: &str) -> Result<Value, String> {
    let limit: u32 = limit_text
        .trim()
        .parse()
        .ok()
        .filter(|n| (1..=200).contains(n))
        .unwrap_or(30);
    let mut session = imap_session(account)?;
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
pub fn fetch(account: &Account, id_text: &str) -> Result<Value, String> {
    let uid = id_text.trim();
    if uid.is_empty() || !uid.bytes().all(|b| b.is_ascii_digit()) {
        return Err("email.fetch needs a message \"id\" from email.list".to_string());
    }
    let mut session = imap_session(account)?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn html_fallback_bodies_strip_to_readable_text() {
        let html = "<div><p>Hello &amp; welcome,</p>\n<p>see you <b>soon</b>.</p></div>";
        assert_eq!(strip_html(html), "Hello & welcome,\nsee you soon.");
    }

    #[test]
    fn the_incoming_tls_setup_names_its_provider() {
        tls_config().expect("builds without a process-wide provider");
    }

    #[test]
    fn a_send_checks_its_addresses_before_connecting() {
        let account = Account {
            host: "smtp.example.net".to_string(),
            ..Account::default()
        };
        let no_sender = send(&account, " ", "you@example.net", "Hi", "Hello").expect_err("no sender");
        assert!(no_sender.contains("needs a sender"), "{no_sender}");
        let bad_sender = send(&account, "not an address", "you@example.net", "Hi", "Hello").expect_err("sender");
        assert!(bad_sender.contains("The sender address is not valid"), "{bad_sender}");
        let bad_recipient = send(&account, "me@example.net", "nobody", "Hi", "Hello").expect_err("recipient");
        assert!(bad_recipient.contains("The recipient address is not valid"), "{bad_recipient}");
    }

    #[test]
    fn a_fetch_needs_a_numeric_id_before_connecting() {
        let account = Account {
            imap_host: "imap.example.net".to_string(),
            ..Account::default()
        };
        for id in ["", " ", "12a", "1 OR 1"] {
            let error = fetch(&account, id).expect_err("refused");
            assert!(error.contains("needs a message \"id\""), "{id:?}: {error}");
        }
    }
}
