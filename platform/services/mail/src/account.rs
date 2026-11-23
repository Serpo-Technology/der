//! The mail account and the file it lives in: settings/mail.json, readable
//! by its owner only. The password is the file's secret and the server
//! details are its string fields. Callers outside this crate see an
//! `AccountView`, which says only whether a password is stored.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// The file the account lives in.
pub const ACCOUNT_FILE: &str = "mail.json";
/// An older file holding the account in the `Account` shape.
const LEGACY_FILE: &str = "smtp.json";

/// The account as a settings screen sends it and as the transports use it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Account {
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

/// What settings screens see: everything except the password, which only
/// reports whether one is stored.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    pub host: String,
    pub port: Option<u16>,
    pub username: String,
    pub has_password: bool,
    pub security: String,
    pub from: String,
    pub imap_host: String,
    pub imap_port: Option<u16>,
}

/// The account as its file holds it.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct AccountRecord {
    fields: BTreeMap<String, String>,
    secret: String,
}

impl Account {
    fn from_record(record: &AccountRecord) -> Self {
        let field = |key: &str| -> String { record.fields.get(key).cloned().unwrap_or_default() };
        Account {
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

    pub fn view(&self) -> AccountView {
        AccountView {
            host: self.host.clone(),
            port: self.port,
            username: self.username.clone(),
            has_password: !self.password.is_empty(),
            security: if self.security.is_empty() { "starttls".to_string() } else { self.security.clone() },
            from: self.from.clone(),
            imap_host: self.imap_host.clone(),
            imap_port: self.imap_port,
        }
    }

    /// Normalizes an incoming save: whitespace trimmed, and an empty
    /// password keeps the stored one so the redacted view can round-trip
    /// through settings screens without wiping it.
    pub fn merged_over(mut self, stored_password: String) -> Account {
        if self.password.is_empty() {
            self.password = stored_password;
        }
        self.host = self.host.trim().to_string();
        self.username = self.username.trim().to_string();
        self.from = self.from.trim().to_string();
        self.imap_host = self.imap_host.trim().to_string();
        self
    }
}

/// Converts an older settings/smtp.json when no account file exists. The
/// older file is removed either way, so its password does not linger.
fn adopt_legacy(dir: &Path) {
    let legacy = dir.join(LEGACY_FILE);
    let Ok(text) = fs::read_to_string(&legacy) else {
        return;
    };
    if dir.join(ACCOUNT_FILE).exists() {
        let _ = fs::remove_file(&legacy);
        return;
    }
    let Ok(account) = serde_json::from_str::<Account>(&text) else {
        return;
    };
    if account.host.is_empty() || write(dir, &account).is_ok() {
        let _ = fs::remove_file(&legacy);
    }
}

/// The saved account; an empty one when none is saved.
pub fn read(dir: &Path) -> Account {
    adopt_legacy(dir);
    fs::read_to_string(dir.join(ACCOUNT_FILE))
        .ok()
        .and_then(|json| serde_json::from_str::<AccountRecord>(&json).ok())
        .map(|record| Account::from_record(&record))
        .unwrap_or_default()
}

pub fn write(dir: &Path, account: &Account) -> Result<(), String> {
    let json = serde_json::to_string_pretty(&account.to_record())
        .map_err(|e| format!("Failed to serialize the mail account: {}", e))?;
    fs::create_dir_all(dir).map_err(|e| format!("Failed to create settings directory: {}", e))?;
    let path = dir.join(ACCOUNT_FILE);
    fs::write(&path, json).map_err(|e| format!("Failed to save the mail account: {}", e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

pub fn remove(dir: &Path) -> Result<(), String> {
    match fs::remove_file(dir.join(ACCOUNT_FILE)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Failed to remove the mail account: {}", error)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account() -> Account {
        Account {
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
    fn an_empty_password_keeps_the_stored_one() {
        let incoming = Account {
            host: " smtp.example.net ".to_string(),
            username: "me@example.net".to_string(),
            password: String::new(),
            security: "starttls".to_string(),
            from: " Me <me@example.net> ".to_string(),
            imap_host: " imap.example.net ".to_string(),
            ..Account::default()
        };
        let merged = incoming.merged_over("stored-secret".to_string());
        assert_eq!(merged.password, "stored-secret");
        assert_eq!(merged.host, "smtp.example.net");
        assert_eq!(merged.from, "Me <me@example.net>");
        assert_eq!(merged.imap_host, "imap.example.net");
    }

    #[test]
    fn a_typed_password_replaces_the_stored_one() {
        let incoming = Account {
            password: "fresh".to_string(),
            ..Account::default()
        };
        assert_eq!(incoming.merged_over("stored-secret".to_string()).password, "fresh");
    }

    #[test]
    fn the_account_round_trips_through_its_file() {
        let dir = tempfile::tempdir().expect("temp dir");
        assert_eq!(read(dir.path()), Account::default());
        let saved = account();
        write(dir.path(), &saved).expect("saves");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(dir.path().join(ACCOUNT_FILE))
                .expect("metadata")
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        assert_eq!(read(dir.path()), saved);

        remove(dir.path()).expect("removes");
        assert_eq!(read(dir.path()), Account::default());
        remove(dir.path()).expect("removing a missing account is fine");
    }

    #[test]
    fn the_file_is_the_shape_the_credential_store_releases() {
        let dir = tempfile::tempdir().expect("temp dir");
        fs::write(
            dir.path().join(ACCOUNT_FILE),
            r#"{"fields":{"host":"smtp.example.net","port":"587","imapHost":"imap.example.net","imapPort":"993"},"secret":"mail-passw0rd"}"#,
        )
        .expect("writes");
        let account = read(dir.path());
        assert_eq!(account.host, "smtp.example.net");
        assert_eq!(account.port, Some(587));
        assert_eq!(account.imap_port, Some(993));
        assert_eq!(account.password, "mail-passw0rd");
    }

    #[test]
    fn the_view_reports_a_password_without_holding_it() {
        let view = serde_json::to_string(&account().view()).expect("serializes");
        assert!(view.contains("\"hasPassword\":true"), "{view}");
        assert!(view.contains("\"imapHost\":\"imap.example.net\""), "{view}");
        assert!(!view.contains("mail-passw0rd"), "{view}");
        let empty = serde_json::to_value(Account::default().view()).expect("serializes");
        assert_eq!(empty["hasPassword"], false);
        assert_eq!(empty["security"], "starttls");
        assert!(empty["port"].is_null());
    }

    #[test]
    fn a_legacy_account_file_converts_once() {
        let dir = tempfile::tempdir().expect("temp dir");
        let legacy = dir.path().join(LEGACY_FILE);
        fs::write(&legacy, serde_json::to_string(&account()).expect("json")).expect("writes");
        assert_eq!(read(dir.path()), account());
        assert!(!legacy.exists());

        // A leftover legacy file never replaces the account file.
        let mut other = account();
        other.host = "other.example.net".to_string();
        fs::write(&legacy, serde_json::to_string(&other).expect("json")).expect("writes");
        assert_eq!(read(dir.path()).host, "smtp.example.net");
        assert!(!legacy.exists());
    }
}
