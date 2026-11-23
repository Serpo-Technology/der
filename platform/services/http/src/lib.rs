//! DER's outbound HTTP service. It owns the integration credential store
//! and performs every request that may carry a stored secret, so a secret
//! is read, checked against its service address, and injected in one place.
//! Everything a caller can ask for is a `Request`, and no `Reply` holds a
//! secret. The crate has no dependency on the desktop shell.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

pub mod confine;
pub mod request;
pub mod store;

pub use request::{Auth, HttpReply, HttpRequest, PartSecret};
pub use store::{IntegrationCredentialView, PartSecretRef};

/// Everything the service does for a caller.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Request {
    /// Perform one HTTP request.
    Http(HttpRequest),
    /// List every record as a redacted view.
    CredentialsList,
    /// Save an HTTP credential; answers the refreshed list.
    CredentialsSet {
        name: String,
        kind: String,
        #[serde(default)]
        target: Option<String>,
        base_url: String,
        #[serde(default)]
        notes: Option<String>,
        secret: String,
    },
    /// Remove a record by name; answers the refreshed list.
    CredentialsRemove { name: String },
    /// Save a part's secret for the service its part declares.
    PartSecretSet {
        fragment_id: String,
        name: String,
        base_url: String,
        secret: String,
    },
    /// The part's secret names saved for the given service.
    PartSecretNames { fragment_id: String, base_url: String },
    /// Part secrets saved before records carried a service address.
    PartSecretsUnaddressed,
    /// Give one unaddressed part secret its service address.
    PartSecretAdopt {
        fragment_id: String,
        name: String,
        base_url: String,
    },
    /// Move a mail account record out of the store into the mail account
    /// file beside it.
    MailAccountRelease,
}

/// The answer to a `Request`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "reply", content = "data", rename_all = "camelCase")]
pub enum Reply {
    Http(HttpReply),
    Credentials(Vec<IntegrationCredentialView>),
    Names(Vec<String>),
    Unaddressed(Vec<PartSecretRef>),
    Done,
    Error(String),
}

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

    /// Answers any request. HTTP requests need an async runtime with IO.
    pub async fn handle(&self, request: Request) -> Reply {
        match request {
            Request::Http(http) => {
                let integrations = store::load(&self.settings_dir);
                match request::perform(&integrations, http).await {
                    Ok(reply) => Reply::Http(reply),
                    Err(message) => Reply::Error(message),
                }
            }
            other => self.handle_store(other),
        }
    }

    /// Answers a store request without an async runtime.
    pub fn handle_store(&self, request: Request) -> Reply {
        let dir = self.settings_dir.as_path();
        match request {
            Request::Http(_) => Reply::Error("An HTTP request is not a store request".to_string()),
            Request::CredentialsList => Reply::Credentials(store::views(&store::load(dir))),
            Request::CredentialsSet {
                name,
                kind,
                target,
                base_url,
                notes,
                secret,
            } => {
                let mut integrations = store::load(dir);
                let saved =
                    store::set_credential(&mut integrations, &name, &kind, target, &base_url, notes, secret)
                        .and_then(|()| store::save(dir, &integrations));
                match saved {
                    Ok(()) => Reply::Credentials(store::views(&integrations)),
                    Err(message) => Reply::Error(message),
                }
            }
            Request::CredentialsRemove { name } => {
                let mut integrations = store::load(dir);
                integrations.credentials.remove(&name);
                match store::save(dir, &integrations) {
                    Ok(()) => Reply::Credentials(store::views(&integrations)),
                    Err(message) => Reply::Error(message),
                }
            }
            Request::PartSecretSet {
                fragment_id,
                name,
                base_url,
                secret,
            } => {
                let mut integrations = store::load(dir);
                let saved =
                    store::set_part_secret(&mut integrations, &fragment_id, &name, &base_url, secret)
                        .and_then(|()| store::save(dir, &integrations));
                match saved {
                    Ok(()) => Reply::Done,
                    Err(message) => Reply::Error(message),
                }
            }
            Request::PartSecretNames {
                fragment_id,
                base_url,
            } => Reply::Names(store::part_secret_names(&store::load(dir), &fragment_id, &base_url)),
            Request::PartSecretsUnaddressed => {
                Reply::Unaddressed(store::unaddressed_part_secrets(&store::load(dir)))
            }
            Request::PartSecretAdopt {
                fragment_id,
                name,
                base_url,
            } => {
                let mut integrations = store::load(dir);
                if store::adopt_part_secret_address(&mut integrations, &fragment_id, &name, &base_url) {
                    if let Err(message) = store::save(dir, &integrations) {
                        return Reply::Error(message);
                    }
                }
                Reply::Done
            }
            Request::MailAccountRelease => match store::release_mail_account(dir) {
                Ok(_) => Reply::Done,
                Err(message) => Reply::Error(message),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(name: &str, secret: &str) -> Request {
        Request::CredentialsSet {
            name: name.to_string(),
            kind: "bearer".to_string(),
            target: None,
            base_url: "https://api.service.dev".to_string(),
            notes: None,
            secret: secret.to_string(),
        }
    }

    #[test]
    fn store_requests_round_trip_through_the_settings_directory() {
        let dir = tempfile::tempdir().expect("temp dir");
        let service = Service::new(dir.path());
        assert_eq!(service.handle_store(Request::CredentialsList), Reply::Credentials(vec![]));

        let Reply::Credentials(saved) = service.handle_store(set("svc", "s3cret-value")) else {
            panic!("a save answers the list");
        };
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].name, "svc");
        assert_eq!(saved[0].base_url.as_deref(), Some("https://api.service.dev"));

        let refused = service.handle_store(set("Bad Name", "x"));
        assert!(matches!(refused, Reply::Error(_)), "{refused:?}");

        let removed = service.handle_store(Request::CredentialsRemove { name: "svc".into() });
        assert_eq!(removed, Reply::Credentials(vec![]));
    }

    #[test]
    fn part_secret_requests_save_list_and_adopt() {
        let dir = tempfile::tempdir().expect("temp dir");
        let service = Service::new(dir.path());
        let names = |base_url: &str| {
            service.handle_store(Request::PartSecretNames {
                fragment_id: "labs.weather".into(),
                base_url: base_url.into(),
            })
        };
        let saved = service.handle_store(Request::PartSecretSet {
            fragment_id: "labs.weather".into(),
            name: "api-key".into(),
            base_url: "https://a.dev".into(),
            secret: "s3cret-value".into(),
        });
        assert_eq!(saved, Reply::Done);
        assert_eq!(names("https://a.dev"), Reply::Names(vec!["api-key".into()]));
        assert_eq!(names("https://b.dev"), Reply::Names(vec![]));

        // A record already holding an address keeps it.
        let adopt = service.handle_store(Request::PartSecretAdopt {
            fragment_id: "labs.weather".into(),
            name: "api-key".into(),
            base_url: "https://b.dev".into(),
        });
        assert_eq!(adopt, Reply::Done);
        assert_eq!(names("https://a.dev"), Reply::Names(vec!["api-key".into()]));
        assert_eq!(
            service.handle_store(Request::PartSecretsUnaddressed),
            Reply::Unaddressed(vec![])
        );
    }

    #[test]
    fn no_reply_to_a_store_request_holds_the_secret() {
        let dir = tempfile::tempdir().expect("temp dir");
        let service = Service::new(dir.path());
        let replies = [
            service.handle_store(set("svc", "s3cret-value")),
            service.handle_store(Request::PartSecretSet {
                fragment_id: "labs.weather".into(),
                name: "api-key".into(),
                base_url: "https://a.dev".into(),
                secret: "s3cret-value".into(),
            }),
            service.handle_store(Request::CredentialsList),
            service.handle_store(Request::PartSecretsUnaddressed),
            service.handle_store(Request::MailAccountRelease),
        ];
        for reply in replies {
            let line = serde_json::to_string(&reply).expect("serializes");
            assert!(!line.contains("s3cret-value"), "{line}");
        }
    }

    #[test]
    fn requests_and_replies_survive_a_line_of_json() {
        let request = Request::Http(HttpRequest {
            method: "GET".into(),
            url: "https://api.service.dev/v1".into(),
            headers: vec![("x-trace".into(), "abc".into())],
            query: vec![("q".into(), "oslo".into())],
            json: None,
            timeout_secs: 20,
            auth: Auth::Part {
                fragment_id: "labs.weather".into(),
                base_url: "https://api.service.dev".into(),
                secrets: vec![PartSecret {
                    name: "api-key".into(),
                    kind: "query".into(),
                    target: Some("appid".into()),
                    label: "API key".into(),
                }],
            },
        });
        let line = serde_json::to_string(&request).expect("serializes");
        assert!(!line.contains('\n'));
        assert!(line.contains("\"op\":\"http\""), "{line}");
        assert!(line.contains("\"fragmentId\":\"labs.weather\""), "{line}");
        let back: Request = serde_json::from_str(&line).expect("parses");
        assert_eq!(serde_json::to_string(&back).expect("serializes"), line);

        for reply in [
            Reply::Http(HttpReply { status: 200, body: "{}".into() }),
            Reply::Names(vec!["api-key".into()]),
            Reply::Done,
            Reply::Error("refused".into()),
        ] {
            let line = serde_json::to_string(&reply).expect("serializes");
            assert_eq!(serde_json::from_str::<Reply>(&line).expect("parses"), reply);
        }
    }

    #[test]
    fn an_http_request_is_not_a_store_request() {
        let dir = tempfile::tempdir().expect("temp dir");
        let reply = Service::new(dir.path()).handle_store(Request::Http(HttpRequest {
            method: "GET".into(),
            url: "https://api.service.dev/v1".into(),
            headers: Vec::new(),
            query: Vec::new(),
            json: None,
            timeout_secs: 15,
            auth: Auth::None,
        }));
        assert!(matches!(reply, Reply::Error(_)), "{reply:?}");
    }
}
