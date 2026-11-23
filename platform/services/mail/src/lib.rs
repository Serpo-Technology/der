//! DER's mail service. It owns the mail account and its password, sends
//! over SMTP, and reads over IMAP, so the account is read and used in one
//! place and mail from the network is parsed there too. Everything a caller
//! can ask for is a `Request`, and no `Reply` holds the password. `serve`
//! runs the service as a process speaking one JSON line per request and
//! reply. The crate has no dependency on the desktop shell.

use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub mod account;
mod transport;

pub use account::{Account, AccountView, ACCOUNT_FILE};

/// Everything the service does for a caller.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Request {
    /// Send one plain-text message. An empty `from` uses the account's
    /// default sender.
    Send {
        #[serde(default)]
        from: String,
        to: String,
        subject: String,
        text: String,
    },
    /// The latest inbox messages, newest first.
    List {
        #[serde(default)]
        limit: String,
    },
    /// One message by the id a list gave, marked read by the fetch.
    Fetch { id: String },
    /// The saved account as a redacted view.
    AccountGet,
    /// Save the account; an empty password keeps the stored one. Answers
    /// the refreshed view.
    AccountSave { account: Account },
    /// Remove the account; answers the now empty view.
    AccountRemove,
}

impl Request {
    /// Whether answering means talking to a mail server, which can take as
    /// long as the server does.
    pub fn uses_network(&self) -> bool {
        matches!(self, Request::Send { .. } | Request::List { .. } | Request::Fetch { .. })
    }
}

/// The answer to a `Request`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "reply", content = "data", rename_all = "camelCase")]
pub enum Reply {
    /// The outputs of a send, a list, or a fetch.
    Outputs(Value),
    Account(AccountView),
    /// The operation needs account details that are not saved: the
    /// outgoing server for a send, or the incoming server (`incoming`) for
    /// a list or a fetch. Carries the view to prefill a setup form with.
    NotSetUp { incoming: bool, account: AccountView },
    Error(String),
}

/// What a line that is not a request is answered with. The text is fixed so
/// that nothing from the line, which may hold a password, comes back.
const UNREADABLE: &str = "The request could not be read";

/// The service over one settings directory.
pub struct Service {
    settings_dir: PathBuf,
}

impl Service {
    pub fn new(settings_dir: impl Into<PathBuf>) -> Self {
        Service {
            settings_dir: settings_dir.into(),
        }
    }

    /// Answers any request. A request that uses the network blocks until
    /// the mail server answers or its timeouts pass.
    pub fn handle(&self, request: Request) -> Reply {
        let dir = self.settings_dir.as_path();
        let outputs = |outcome: Result<Value, String>| match outcome {
            Ok(value) => Reply::Outputs(value),
            Err(message) => Reply::Error(message),
        };
        match request {
            Request::Send {
                from,
                to,
                subject,
                text,
            } => {
                let account = account::read(dir);
                if account.host.is_empty() {
                    return Reply::NotSetUp {
                        incoming: false,
                        account: account.view(),
                    };
                }
                outputs(transport::send(&account, &from, &to, &subject, &text))
            }
            Request::List { limit } => match self.incoming() {
                Ok(account) => outputs(transport::list(&account, &limit)),
                Err(reply) => reply,
            },
            Request::Fetch { id } => match self.incoming() {
                Ok(account) => outputs(transport::fetch(&account, &id)),
                Err(reply) => reply,
            },
            Request::AccountGet => Reply::Account(account::read(dir).view()),
            Request::AccountSave { account } => {
                let merged = account.merged_over(account::read(dir).password);
                match account::write(dir, &merged) {
                    Ok(()) => Reply::Account(merged.view()),
                    Err(message) => Reply::Error(message),
                }
            }
            Request::AccountRemove => match account::remove(dir) {
                Ok(()) => Reply::Account(Account::default().view()),
                Err(message) => Reply::Error(message),
            },
        }
    }

    /// The account, when it names an incoming server.
    fn incoming(&self) -> Result<Account, Reply> {
        let account = account::read(&self.settings_dir);
        if account.imap_host.is_empty() {
            return Err(Reply::NotSetUp {
                incoming: true,
                account: account.view(),
            });
        }
        Ok(account)
    }
}

/// Serves requests over the settings directory until the input closes.
/// Account requests are answered in the order they arrive, so two saves
/// never overwrite each other. A request that uses the network runs on its
/// own thread and answers when the mail server has, and one that fails
/// unexpectedly still answers, so its caller is not left waiting.
pub fn serve<R, W>(settings_dir: impl Into<PathBuf>, input: R, output: W) -> std::io::Result<()>
where
    R: BufRead,
    W: Write + Send + 'static,
{
    let service = Arc::new(Service::new(settings_dir));
    der_wire::serve(
        input,
        output,
        || Reply::Error(UNREADABLE.to_string()),
        |request: Request, responder: der_wire::Responder<Reply>| {
            if !request.uses_network() {
                responder.answer(service.handle(request));
                return;
            }
            let service = service.clone();
            std::thread::spawn(move || {
                let handled = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| service.handle(request)));
                responder.answer(handled.unwrap_or_else(|_| {
                    Reply::Error("The mail service failed while handling the request".to_string())
                }));
            });
        },
    )
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead, BufReader, Write};

    use super::*;

    fn account() -> Account {
        Account {
            host: "smtp.example.net".to_string(),
            port: Some(587),
            username: "me@example.net".to_string(),
            password: "mail-passw0rd".to_string(),
            security: "starttls".to_string(),
            from: "Me <me@example.net>".to_string(),
            ..Account::default()
        }
    }

    fn send() -> Request {
        Request::Send {
            from: String::new(),
            to: "you@example.net".to_string(),
            subject: "Hi".to_string(),
            text: "Hello".to_string(),
        }
    }

    #[test]
    fn mail_without_an_account_asks_for_setup() {
        let dir = tempfile::tempdir().expect("temp dir");
        let service = Service::new(dir.path());
        let empty = Account::default().view();
        assert_eq!(
            service.handle(send()),
            Reply::NotSetUp { incoming: false, account: empty.clone() }
        );
        assert_eq!(
            service.handle(Request::List { limit: String::new() }),
            Reply::NotSetUp { incoming: true, account: empty.clone() }
        );
        assert_eq!(
            service.handle(Request::Fetch { id: "7".to_string() }),
            Reply::NotSetUp { incoming: true, account: empty }
        );
    }

    #[test]
    fn a_send_only_account_asks_for_the_incoming_server() {
        let dir = tempfile::tempdir().expect("temp dir");
        let service = Service::new(dir.path());
        service.handle(Request::AccountSave { account: account() });
        let Reply::NotSetUp { incoming, account } = service.handle(Request::List { limit: "5".to_string() }) else {
            panic!("a list needs the incoming server");
        };
        assert!(incoming);
        assert_eq!(account.host, "smtp.example.net");
        assert!(account.has_password);
    }

    #[test]
    fn saving_keeps_the_stored_password_and_no_reply_holds_it() {
        let dir = tempfile::tempdir().expect("temp dir");
        let service = Service::new(dir.path());
        let mut edited = account();
        edited.password = String::new();
        edited.imap_host = " imap.example.net ".to_string();
        let replies = [
            service.handle(Request::AccountSave { account: account() }),
            service.handle(Request::AccountSave { account: edited }),
            service.handle(Request::AccountGet),
            service.handle(Request::Fetch { id: "not a number".to_string() }),
        ];
        assert_eq!(account::read(dir.path()).password, "mail-passw0rd");
        assert_eq!(account::read(dir.path()).imap_host, "imap.example.net");
        for reply in &replies {
            let line = serde_json::to_string(reply).expect("serializes");
            assert!(!line.contains("mail-passw0rd"), "{line}");
        }
        let Reply::Account(view) = &replies[2] else {
            panic!("the view: {:?}", replies[2]);
        };
        assert!(view.has_password);

        assert_eq!(
            service.handle(Request::AccountRemove),
            Reply::Account(Account::default().view())
        );
        assert_eq!(account::read(dir.path()), Account::default());
    }

    #[test]
    fn requests_and_replies_survive_a_line_of_json() {
        let line = serde_json::to_string(&send()).expect("serializes");
        assert!(line.contains("\"op\":\"send\""), "{line}");
        let back: Request = serde_json::from_str(&line).expect("parses");
        assert_eq!(serde_json::to_string(&back).expect("serializes"), line);
        let saved: Request =
            serde_json::from_str(r#"{"op":"accountSave","account":{"host":"smtp.example.net","imapPort":993}}"#)
                .expect("a partial account parses");
        let Request::AccountSave { account } = saved else {
            panic!("an account save");
        };
        assert_eq!(account.imap_port, Some(993));

        for reply in [
            Reply::Outputs(serde_json::json!({ "sent": true, "to": "you@example.net" })),
            Reply::Account(account.view()),
            Reply::NotSetUp { incoming: true, account: Account::default().view() },
            Reply::Error("refused".into()),
        ] {
            let line = serde_json::to_string(&reply).expect("serializes");
            assert!(!line.contains('\n'));
            assert_eq!(serde_json::from_str::<Reply>(&line).expect("parses"), reply);
        }
    }

    #[test]
    fn the_service_answers_over_its_pipes_by_id() {
        let dir = tempfile::tempdir().expect("temp dir");
        let (request_reader, mut requests) = std::io::pipe().expect("pipe");
        let (replies, reply_writer) = std::io::pipe().expect("pipe");
        let settings = dir.path().to_path_buf();
        let thread = std::thread::spawn(move || serve(settings, BufReader::new(request_reader), reply_writer));
        let mut replies = BufReader::new(replies);
        let mut next = || -> der_wire::ReplyLine<Reply> {
            let mut line = String::new();
            replies.read_line(&mut line).expect("reads");
            serde_json::from_str(&line).unwrap_or_else(|error| panic!("{error}: {line:?}"))
        };
        let mut ask = |id: u64, request: Request| {
            let line = serde_json::to_string(&der_wire::RequestLine { id, request }).expect("serializes");
            writeln!(requests, "{line}").expect("writes");
        };

        ask(1, Request::AccountSave { account: account() });
        let saved = next();
        assert_eq!(saved.id, 1);
        assert!(matches!(saved.reply, Reply::Account(ref view) if view.has_password));

        // A request that uses the network answers from its own thread.
        ask(2, Request::List { limit: String::new() });
        let asked = next();
        assert_eq!(asked.id, 2);
        assert!(matches!(asked.reply, Reply::NotSetUp { incoming: true, .. }));

        drop(ask);
        drop(requests);
        thread.join().expect("no panic").expect("ends cleanly when the input closes");
    }
}
