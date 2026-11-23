//! The integration credential store: one JSON file of named records, each
//! holding a secret and the service address that secret belongs to. Callers
//! outside this crate see redacted views and never a secret.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

const FILE_NAME: &str = "integrations.json";

/// The file the mail account lives in, beside the store. Mail owns it.
pub const MAIL_ACCOUNT_FILE: &str = "mail.json";
const MAIL_RECORD_NAME: &str = "mail";

/// A named credential a remote operation can reference via
/// implementation.auth, or a secret an installed part declared.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationCredential {
    /// "bearer" (Authorization header), "header" (custom header), "query"
    /// (query parameter), or "partsecret" (a part's secret, shaped by its
    /// manifest). A record of kind "smtp" is a mail account saved while
    /// mail shared this store; it is never injected, and
    /// `release_mail_account` moves it out.
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
    /// The server details of an "smtp" record; no other kind has any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fields: Option<BTreeMap<String, String>>,
    pub secret: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StoredIntegrations {
    #[serde(default)]
    pub credentials: HashMap<String, IntegrationCredential>,
}

/// Reads the store under `dir`. A missing or unreadable file is an empty
/// store.
pub fn load(dir: &Path) -> StoredIntegrations {
    fs::read_to_string(dir.join(FILE_NAME))
        .ok()
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

/// Writes the store under `dir`, readable by its owner only.
pub fn save(dir: &Path, integrations: &StoredIntegrations) -> Result<(), String> {
    let json = serde_json::to_string_pretty(integrations)
        .map_err(|e| format!("Failed to serialize integrations: {}", e))?;
    fs::create_dir_all(dir).map_err(|e| format!("Failed to create settings directory: {}", e))?;
    write_private(&dir.join(FILE_NAME), &json)
        .map_err(|e| format!("Failed to save integrations: {}", e))
}

fn write_private(path: &Path, contents: &str) -> std::io::Result<()> {
    fs::write(path, contents)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// The mail account as it sits in its own file.
#[derive(Serialize)]
struct MailAccountFile<'a> {
    fields: &'a BTreeMap<String, String>,
    secret: &'a str,
}

/// Moves the mail account out of the store into `MAIL_ACCOUNT_FILE`: the
/// "smtp" record named "mail" is written there as its fields and secret,
/// then removed here. Such a record can only have been saved after the
/// last move, so it replaces a file already present. Returns whether a
/// record moved; the secret never leaves this function.
pub fn release_mail_account(dir: &Path) -> Result<bool, String> {
    let mut integrations = load(dir);
    let Some(record) = integrations
        .credentials
        .get(MAIL_RECORD_NAME)
        .filter(|record| record.kind == "smtp")
    else {
        return Ok(false);
    };
    let no_fields = BTreeMap::new();
    let account = MailAccountFile {
        fields: record.fields.as_ref().unwrap_or(&no_fields),
        secret: &record.secret,
    };
    let json = serde_json::to_string_pretty(&account)
        .map_err(|e| format!("Failed to serialize the mail account: {}", e))?;
    write_private(&dir.join(MAIL_ACCOUNT_FILE), &json)
        .map_err(|e| format!("Failed to save the mail account: {}", e))?;
    integrations.credentials.remove(MAIL_RECORD_NAME);
    save(dir, &integrations)?;
    Ok(true)
}

/// Redacted view: names and shapes only, never secrets.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationCredentialView {
    pub name: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

/// Every record as a redacted view, sorted by name.
pub fn views(integrations: &StoredIntegrations) -> Vec<IntegrationCredentialView> {
    let mut views: Vec<IntegrationCredentialView> = integrations
        .credentials
        .iter()
        .map(|(name, cred)| IntegrationCredentialView {
            name: name.clone(),
            kind: cred.kind.clone(),
            target: cred.target.clone(),
            base_url: cred.base_url.clone(),
            notes: cred.notes.clone(),
        })
        .collect();
    views.sort_by(|a, b| a.name.cmp(&b.name));
    views
}

/// Saves an HTTP credential. The secret is required on every save, so a
/// stored secret can only ever belong to the address it arrived with.
pub fn set_credential(
    integrations: &mut StoredIntegrations,
    name: &str,
    kind: &str,
    target: Option<String>,
    base_url: &str,
    notes: Option<String>,
    secret: String,
) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty()
        || name.len() > 64
        || !name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err("Credential names are 1-64 chars of lowercase, digits, and dashes".to_string());
    }
    if !matches!(kind, "bearer" | "header" | "query") {
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
    integrations.credentials.insert(
        name,
        IntegrationCredential {
            kind: kind.to_string(),
            target: target.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()),
            base_url: Some(base_url),
            notes: notes.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()),
            fields: None,
            secret,
        },
    );
    Ok(())
}

/// The store key of a part's secret.
pub fn part_secret_key(fragment_id: &str, name: &str) -> String {
    format!("part:{}:{}", fragment_id, name)
}

/// Whether a stored part secret belongs to the service at `base_url`.
pub fn saved_for_service(record: &IntegrationCredential, base_url: &str) -> bool {
    record
        .base_url
        .as_deref()
        .is_some_and(|saved| saved.trim_end_matches('/') == base_url.trim_end_matches('/'))
}

/// Saves a part secret together with the service address its part
/// declares, so the record alone says where the secret may go.
pub fn set_part_secret(
    integrations: &mut StoredIntegrations,
    fragment_id: &str,
    name: &str,
    base_url: &str,
    secret: String,
) -> Result<(), String> {
    if secret.trim().is_empty() {
        return Err("The secret cannot be empty".to_string());
    }
    if base_url.trim().is_empty() {
        return Err("A part secret needs the service address of its part".to_string());
    }
    integrations.credentials.insert(
        part_secret_key(fragment_id, name),
        IntegrationCredential {
            kind: "partsecret".to_string(),
            target: None,
            base_url: Some(base_url.to_string()),
            notes: None,
            fields: None,
            secret,
        },
    );
    Ok(())
}

/// The part's saved secret names. A record saved for another service
/// address counts as missing.
pub fn part_secret_names(
    integrations: &StoredIntegrations,
    fragment_id: &str,
    base_url: &str,
) -> Vec<String> {
    let prefix = part_secret_key(fragment_id, "");
    let mut names: Vec<String> = integrations
        .credentials
        .iter()
        .filter(|(key, record)| key.starts_with(&prefix) && saved_for_service(record, base_url))
        .map(|(key, _)| key[prefix.len()..].to_string())
        .collect();
    names.sort();
    names
}

/// Removes every secret saved for a part, whatever service it was saved
/// for. Returns how many records went.
pub fn remove_part_secrets(integrations: &mut StoredIntegrations, fragment_id: &str) -> usize {
    let prefix = part_secret_key(fragment_id, "");
    let before = integrations.credentials.len();
    integrations
        .credentials
        .retain(|key, record| !(record.kind == "partsecret" && key.starts_with(&prefix)));
    before - integrations.credentials.len()
}

/// A part secret named by its part and its declared credential name.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartSecretRef {
    pub fragment_id: String,
    pub name: String,
}

/// Part secrets saved before records carried a service address.
pub fn unaddressed_part_secrets(integrations: &StoredIntegrations) -> Vec<PartSecretRef> {
    let mut refs: Vec<PartSecretRef> = integrations
        .credentials
        .iter()
        .filter(|(_, record)| record.kind == "partsecret" && record.base_url.is_none())
        .filter_map(|(key, _)| {
            let (fragment_id, name) = key.strip_prefix("part:")?.split_once(':')?;
            Some(PartSecretRef {
                fragment_id: fragment_id.to_string(),
                name: name.to_string(),
            })
        })
        .collect();
    refs.sort_by(|a, b| (&a.fragment_id, &a.name).cmp(&(&b.fragment_id, &b.name)));
    refs
}

/// Gives an unaddressed part secret its service address. A record that
/// already has one is left alone, so an address never changes without the
/// secret being entered again. Returns whether the record changed.
pub fn adopt_part_secret_address(
    integrations: &mut StoredIntegrations,
    fragment_id: &str,
    name: &str,
    base_url: &str,
) -> bool {
    if base_url.trim().is_empty() {
        return false;
    }
    match integrations
        .credentials
        .get_mut(&part_secret_key(fragment_id, name))
    {
        Some(record) if record.kind == "partsecret" && record.base_url.is_none() => {
            record.base_url = Some(base_url.to_string());
            true
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn part_record(base_url: Option<&str>) -> IntegrationCredential {
        IntegrationCredential {
            kind: "partsecret".to_string(),
            target: None,
            base_url: base_url.map(str::to_string),
            notes: None,
            fields: None,
            secret: "s3cret-value".to_string(),
        }
    }

    #[test]
    fn a_saved_store_reads_back_and_views_hold_no_secret() {
        let dir = tempfile::tempdir().expect("temp dir");
        let mut integrations = StoredIntegrations::default();
        set_credential(
            &mut integrations,
            " weather ",
            "query",
            Some(" appid ".to_string()),
            " https://api.service.dev/ ",
            Some("  ".to_string()),
            "s3cret-value".to_string(),
        )
        .expect("saves");
        save(dir.path(), &integrations).expect("writes");

        let back = load(dir.path());
        let record = &back.credentials["weather"];
        assert_eq!(record.base_url.as_deref(), Some("https://api.service.dev"));
        assert_eq!(record.target.as_deref(), Some("appid"));
        assert_eq!(record.notes, None);
        assert_eq!(record.secret, "s3cret-value");

        let listed = serde_json::to_string(&views(&back)).expect("serializes");
        assert!(listed.contains("\"baseUrl\":\"https://api.service.dev\""), "{listed}");
        assert!(!listed.contains("s3cret-value"), "{listed}");
    }

    #[cfg(unix)]
    #[test]
    fn the_store_file_is_readable_by_its_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("temp dir");
        save(dir.path(), &StoredIntegrations::default()).expect("writes");
        let mode = fs::metadata(dir.path().join(FILE_NAME)).expect("metadata").permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    fn mail_record() -> IntegrationCredential {
        let mut fields = BTreeMap::new();
        fields.insert("host".to_string(), "smtp.example.net".to_string());
        fields.insert("port".to_string(), "587".to_string());
        IntegrationCredential {
            kind: "smtp".to_string(),
            target: None,
            base_url: None,
            notes: None,
            fields: Some(fields),
            secret: "mail-passw0rd".to_string(),
        }
    }

    #[test]
    fn the_mail_account_moves_out_of_the_store_into_its_own_file() {
        let dir = tempfile::tempdir().expect("temp dir");
        let mut integrations = StoredIntegrations::default();
        integrations.credentials.insert("mail".to_string(), mail_record());
        set_credential(&mut integrations, "weather", "bearer", None, "https://a.dev", None, "x".into())
            .expect("saves");
        save(dir.path(), &integrations).expect("writes");
        // A file from an earlier move is older than the record.
        fs::write(dir.path().join(MAIL_ACCOUNT_FILE), "{\"secret\":\"older\"}").expect("writes");

        assert_eq!(release_mail_account(dir.path()), Ok(true));
        let account: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(dir.path().join(MAIL_ACCOUNT_FILE)).expect("the account file"),
        )
        .expect("json");
        assert_eq!(account["fields"]["host"], "smtp.example.net");
        assert_eq!(account["fields"]["port"], "587");
        assert_eq!(account["secret"], "mail-passw0rd");

        let back = load(dir.path());
        assert!(!back.credentials.contains_key("mail"));
        assert!(back.credentials.contains_key("weather"));
        let stored = fs::read_to_string(dir.path().join(FILE_NAME)).expect("the store");
        assert!(!stored.contains("mail-passw0rd"), "{stored}");

        assert_eq!(release_mail_account(dir.path()), Ok(false));
    }

    #[cfg(unix)]
    #[test]
    fn the_released_mail_account_is_readable_by_its_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("temp dir");
        let mut integrations = StoredIntegrations::default();
        integrations.credentials.insert("mail".to_string(), mail_record());
        save(dir.path(), &integrations).expect("writes");
        release_mail_account(dir.path()).expect("moves");
        let mode = fs::metadata(dir.path().join(MAIL_ACCOUNT_FILE))
            .expect("metadata")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn an_http_credential_named_mail_stays_in_the_store() {
        let dir = tempfile::tempdir().expect("temp dir");
        let mut integrations = StoredIntegrations::default();
        set_credential(&mut integrations, "mail", "bearer", None, "https://a.dev", None, "x".into())
            .expect("saves");
        save(dir.path(), &integrations).expect("writes");
        assert_eq!(release_mail_account(dir.path()), Ok(false));
        assert_eq!(load(dir.path()).credentials["mail"].kind, "bearer");
        assert!(!dir.path().join(MAIL_ACCOUNT_FILE).exists());
    }

    #[test]
    fn saving_a_credential_enforces_its_rules() {
        let mut integrations = StoredIntegrations::default();
        let mut put = |name: &str, kind: &str, target: Option<&str>, base: &str, secret: &str| {
            set_credential(
                &mut integrations,
                name,
                kind,
                target.map(str::to_string),
                base,
                None,
                secret.to_string(),
            )
        };
        assert!(put("Weather", "bearer", None, "https://a.dev", "x").is_err(), "uppercase name");
        assert!(put("part:x:y", "bearer", None, "https://a.dev", "x").is_err(), "reserved shape");
        assert!(put("w", "smtp", None, "https://a.dev", "x").is_err(), "kind");
        assert!(put("w", "header", None, "https://a.dev", "x").is_err(), "missing target");
        assert!(put("w", "bearer", None, "https://a.dev", " ").is_err(), "empty secret");
        assert!(put("w", "bearer", None, "a.dev", "x").is_err(), "no scheme");
        assert!(put("w", "bearer", None, "https://a.dev", "x").is_ok());
    }

    #[test]
    fn part_secret_names_count_only_records_saved_for_the_service() {
        let mut integrations = StoredIntegrations::default();
        set_part_secret(&mut integrations, "labs.weather", "api-key", "https://a.dev", "x".into())
            .expect("saves");
        integrations
            .credentials
            .insert(part_secret_key("labs.weather", "moved"), part_record(Some("https://b.dev")));
        integrations
            .credentials
            .insert(part_secret_key("labs.weather", "old"), part_record(None));
        integrations
            .credentials
            .insert(part_secret_key("labs.other", "api-key"), part_record(Some("https://a.dev")));
        assert_eq!(
            part_secret_names(&integrations, "labs.weather", "https://a.dev/"),
            vec!["api-key".to_string()]
        );
        assert!(set_part_secret(&mut integrations, "labs.weather", "k", " ", "x".into()).is_err());
        assert!(set_part_secret(&mut integrations, "labs.weather", "k", "https://a.dev", "".into()).is_err());
    }

    #[test]
    fn removing_a_parts_secrets_leaves_every_other_record() {
        let mut integrations = StoredIntegrations::default();
        for (part, name, base) in [
            ("labs.weather", "api-key", Some("https://a.dev")),
            ("labs.weather", "moved", Some("https://b.dev")),
            ("labs.weather", "old", None),
            ("labs.weather2", "api-key", Some("https://a.dev")),
        ] {
            integrations
                .credentials
                .insert(part_secret_key(part, name), part_record(base));
        }
        set_credential(&mut integrations, "weather", "bearer", None, "https://a.dev", None, "x".into())
            .expect("saves");

        assert_eq!(remove_part_secrets(&mut integrations, "labs.weather"), 3);
        let mut left: Vec<&str> = integrations.credentials.keys().map(String::as_str).collect();
        left.sort();
        assert_eq!(left, vec!["part:labs.weather2:api-key", "weather"]);
        assert_eq!(remove_part_secrets(&mut integrations, "labs.weather"), 0);
    }

    #[test]
    fn only_an_unaddressed_part_secret_adopts_an_address() {
        let mut integrations = StoredIntegrations::default();
        integrations
            .credentials
            .insert(part_secret_key("labs.weather", "old"), part_record(None));
        integrations
            .credentials
            .insert(part_secret_key("labs.weather", "kept"), part_record(Some("https://b.dev")));
        assert_eq!(
            unaddressed_part_secrets(&integrations),
            vec![PartSecretRef { fragment_id: "labs.weather".into(), name: "old".into() }]
        );
        assert!(adopt_part_secret_address(&mut integrations, "labs.weather", "old", "https://a.dev"));
        assert!(!adopt_part_secret_address(&mut integrations, "labs.weather", "old", "https://c.dev"));
        assert!(!adopt_part_secret_address(&mut integrations, "labs.weather", "kept", "https://a.dev"));
        assert!(!adopt_part_secret_address(&mut integrations, "labs.weather", "absent", "https://a.dev"));
        let base = |name: &str| {
            integrations.credentials[&part_secret_key("labs.weather", name)]
                .base_url
                .clone()
        };
        assert_eq!(base("old").as_deref(), Some("https://a.dev"));
        assert_eq!(base("kept").as_deref(), Some("https://b.dev"));
        assert!(unaddressed_part_secrets(&integrations).is_empty());
    }
}
