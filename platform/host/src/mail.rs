//! The host's door to the mail service, the platform layer behind the
//! email.* builtins. The account, its password, and all talk to mail
//! servers live in the mail service, a separate process. The host passes
//! message fields and typed account details in and gets operation outputs
//! and redacted views back, so the stored password is never in the host's
//! memory. Contracts supply only the message fields, and the first
//! unconfigured send or list opens the host-drawn account sheet in the
//! app's flow.

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use der_mail::{Reply, Request};
use serde_json::Value;
use tauri::AppHandle;

use crate::secrets::Secrets;

pub use der_mail::Account;

/// How long an account request may take to answer.
const ACCOUNT_WAIT: Duration = Duration::from_secs(30);
/// How long a request that talks to a mail server may take. The service
/// bounds each read and write at 30 seconds, and a list makes several.
const NETWORK_WAIT: Duration = Duration::from_secs(120);

type Client = der_wire::Client<Request, Reply>;

enum Door {
    Process(Arc<Client>),
    #[cfg(test)]
    Local(der_mail::Service),
}

pub struct Mail {
    door: Door,
}

impl Mail {
    /// The service over this app's settings directory, shared by every
    /// caller in the process.
    pub fn for_app(app: &AppHandle) -> Result<Self, String> {
        static CLIENT: OnceLock<Arc<Client>> = OnceLock::new();
        let settings_dir = crate::settings::settings_dir(app)?;
        let client = match CLIENT.get() {
            Some(client) => client,
            None => {
                let client = crate::services::client("mail", crate::services::MAIL, &settings_dir)?;
                CLIENT.get_or_init(|| Arc::new(client))
            }
        };
        Ok(Mail {
            door: Door::Process(client.clone()),
        })
    }

    /// The service run inside the test process over an explicit settings
    /// directory.
    #[cfg(test)]
    pub fn at(settings_dir: &std::path::Path) -> Self {
        Mail {
            door: Door::Local(der_mail::Service::new(settings_dir)),
        }
    }

    /// Answers one request. Blocks until the service has.
    pub fn call(&self, request: Request) -> Reply {
        match &self.door {
            Door::Process(client) => {
                let wait = if request.uses_network() { NETWORK_WAIT } else { ACCOUNT_WAIT };
                client.call(request, wait).unwrap_or_else(Reply::Error)
            }
            #[cfg(test)]
            Door::Local(service) => service.handle(request),
        }
    }

    fn account(&self, request: Request) -> Result<Value, String> {
        match self.call(request) {
            Reply::Account(view) => {
                serde_json::to_value(view).map_err(|e| format!("The mail account could not be read: {}", e))
            }
            Reply::Error(message) => Err(message),
            _ => Err("The mail service answered out of turn".to_string()),
        }
    }
}

/// Moves a mail account saved in the credential store into the mail
/// service's own file. The store writes the file itself, so the password
/// never passes through the host.
pub fn migrate_account(app: &AppHandle) {
    if let Ok(secrets) = Secrets::for_app(app) {
        let _ = secrets.store(der_http::Request::MailAccountRelease);
    }
}

/// What settings screens see: everything except the password, which only
/// reports whether one is stored.
pub fn redacted_view(app: &AppHandle) -> Value {
    Mail::for_app(app)
        .and_then(|mail| mail.account(Request::AccountGet))
        .unwrap_or_else(|_| {
            serde_json::to_value(Account::default().view()).unwrap_or(Value::Null)
        })
}

/// Saves the account and answers the refreshed view. An empty password
/// keeps the stored one.
pub fn save_keeping_password(app: &AppHandle, account: Account) -> Result<Value, String> {
    Mail::for_app(app)?.account(Request::AccountSave { account })
}

pub fn delete_account(app: &AppHandle) -> Result<(), String> {
    Mail::for_app(app)?
        .account(Request::AccountRemove)
        .map(|_| ())
}

fn not_set_up(incoming: bool) -> String {
    if incoming {
        "Incoming mail is not set up; add your IMAP server to the mail account in Settings".to_string()
    } else {
        "Email is not set up; add your mail account under Settings before sending".to_string()
    }
}

/// Runs a mail operation. When the service answers that the account is not
/// set up, `ask` gets the redacted account to prefill a form with and may
/// return what the user typed: that is saved and the operation runs once
/// more. Without an answer the error points at Settings.
fn run_with_setup(
    mail: &Mail,
    request: Request,
    ask: impl FnOnce(&Value) -> Option<Account>,
) -> Result<Value, String> {
    let (incoming, account) = match mail.call(request.clone()) {
        Reply::Outputs(outputs) => return Ok(outputs),
        Reply::Error(message) => return Err(message),
        Reply::Account(_) => return Err("The mail service answered out of turn".to_string()),
        Reply::NotSetUp { incoming, account } => (incoming, account),
    };
    let prefill = serde_json::to_value(account).unwrap_or(Value::Null);
    let Some(typed) = ask(&prefill) else {
        return Err(not_set_up(incoming));
    };
    mail.account(Request::AccountSave { account: typed })?;
    match mail.call(request) {
        Reply::Outputs(outputs) => Ok(outputs),
        Reply::Error(message) => Err(message),
        Reply::NotSetUp { incoming, .. } => Err(not_set_up(incoming)),
        Reply::Account(_) => Err("The mail service answered out of turn".to_string()),
    }
}

/// Runs a mail operation with the in-flow setup: the panel draws the
/// account sheet when it can, and what the user types goes straight to the
/// mail service.
fn run(app: &AppHandle, request: Request) -> Result<Value, String> {
    run_with_setup(&Mail::for_app(app)?, request, |prefill| {
        crate::runtime::sidecar::panel_mail_account(app, prefill)
    })
}

pub fn send_core(
    app: &AppHandle,
    from: &str,
    to: &str,
    subject: &str,
    text: &str,
) -> Result<Value, String> {
    run(
        app,
        Request::Send {
            from: from.to_string(),
            to: to.to_string(),
            subject: subject.to_string(),
            text: text.to_string(),
        },
    )
}

/// The latest inbox messages, newest first: {messages: [{id, from,
/// subject, date, seen}], count}. Ids are IMAP UIDs as strings.
pub fn list_core(app: &AppHandle, limit_text: &str) -> Result<Value, String> {
    run(
        app,
        Request::List {
            limit: limit_text.to_string(),
        },
    )
}

/// One message by UID, marked read by the fetch: {id, from, subject, date,
/// text, seen}.
pub fn fetch_core(app: &AppHandle, id_text: &str) -> Result<Value, String> {
    run(app, Request::Fetch { id: id_text.to_string() })
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
pub fn smtp_save(app: AppHandle, config: Account) -> Result<Value, String> {
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

    fn list() -> Request {
        Request::List { limit: String::new() }
    }

    fn send() -> Request {
        Request::Send {
            from: String::new(),
            to: "nobody".to_string(),
            subject: "Hi".to_string(),
            text: "Hello".to_string(),
        }
    }

    fn typed() -> Account {
        Account {
            host: "smtp.example.net".to_string(),
            username: "me@example.net".to_string(),
            password: "mail-passw0rd".to_string(),
            from: "me@example.net".to_string(),
            ..Account::default()
        }
    }

    #[test]
    fn the_credential_store_releases_into_the_file_mail_reads() {
        assert_eq!(der_http::store::MAIL_ACCOUNT_FILE, der_mail::ACCOUNT_FILE);
    }

    #[test]
    fn an_unanswered_setup_points_at_settings() {
        let dir = tempfile::tempdir().expect("temp dir");
        let mail = Mail::at(dir.path());
        let sending = run_with_setup(&mail, send(), |_| None).expect_err("not set up");
        assert!(sending.contains("Email is not set up"), "{sending}");
        let reading = run_with_setup(&mail, list(), |_| None).expect_err("not set up");
        assert!(reading.contains("Incoming mail is not set up"), "{reading}");
    }

    #[test]
    fn what_the_user_types_is_saved_and_the_operation_runs_again() {
        let dir = tempfile::tempdir().expect("temp dir");
        let mail = Mail::at(dir.path());
        let mut prefilled = None;
        let outcome = run_with_setup(&mail, send(), |prefill| {
            prefilled = Some(prefill.clone());
            Some(typed())
        });
        // The second run got past the account check and reached the
        // message, whose recipient is not an address.
        let error = outcome.expect_err("the recipient is refused");
        assert!(error.contains("The recipient address is not valid"), "{error}");
        assert_eq!(prefilled.expect("the form was offered")["hasPassword"], false);

        let view = mail.account(Request::AccountGet).expect("the view");
        assert_eq!(view["host"], "smtp.example.net");
        assert_eq!(view["hasPassword"], true);
        assert!(!view.to_string().contains("mail-passw0rd"), "{view}");
    }

    #[test]
    fn a_setup_that_leaves_out_the_incoming_server_still_points_at_settings() {
        let dir = tempfile::tempdir().expect("temp dir");
        let mail = Mail::at(dir.path());
        let error = run_with_setup(&mail, list(), |_| Some(typed())).expect_err("no incoming server");
        assert!(error.contains("Incoming mail is not set up"), "{error}");
    }
}
