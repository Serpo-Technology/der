//! The host's one door to the integration credential store and to every
//! outbound request that may carry a stored secret. The store and those
//! requests live in the HTTP service, a separate process. Callers hand over
//! a request and get back a reply that holds no secret, so a stored secret
//! is never in the host's memory after it has been saved.

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use der_http::{HttpReply, HttpRequest, Reply, Request};

/// How long a store request may take to answer.
const STORE_WAIT: Duration = Duration::from_secs(30);
/// What an HTTP request is given on top of its own timeout.
const HTTP_WAIT_MARGIN: Duration = Duration::from_secs(15);

type Client = der_wire::Client<Request, Reply>;

enum Door {
    Process(Arc<Client>),
    #[cfg(test)]
    Local(der_http::Service),
}

pub struct Secrets {
    door: Door,
}

impl Secrets {
    /// The service over this app's settings directory, shared by every
    /// caller in the process.
    pub fn for_app(app: &tauri::AppHandle) -> Result<Self, String> {
        static CLIENT: OnceLock<Arc<Client>> = OnceLock::new();
        let settings_dir = crate::settings::settings_dir(app)?;
        let client = match CLIENT.get() {
            Some(client) => client,
            None => {
                let client = crate::services::client("HTTP", crate::services::HTTP, &settings_dir)?;
                CLIENT.get_or_init(|| Arc::new(client))
            }
        };
        Ok(Secrets {
            door: Door::Process(client.clone()),
        })
    }

    /// The service run inside the test process over an explicit settings
    /// directory.
    #[cfg(test)]
    pub fn at(settings_dir: &std::path::Path) -> Self {
        Secrets {
            door: Door::Local(der_http::Service::new(settings_dir)),
        }
    }

    /// Performs one HTTP request.
    pub async fn http(&self, request: HttpRequest) -> Result<HttpReply, String> {
        let reply = match &self.door {
            Door::Process(client) => {
                let client = client.clone();
                let wait = Duration::from_secs(request.timeout_secs) + HTTP_WAIT_MARGIN;
                tauri::async_runtime::spawn_blocking(move || client.call(Request::Http(request), wait))
                    .await
                    .map_err(|error| format!("The HTTP request could not run: {}", error))??
            }
            #[cfg(test)]
            Door::Local(service) => service.handle(Request::Http(request)).await,
        };
        match reply {
            Reply::Http(reply) => Ok(reply),
            Reply::Error(message) => Err(message),
            _ => Err("The HTTP service answered out of turn".to_string()),
        }
    }

    /// Answers a store request.
    pub fn store(&self, request: Request) -> Reply {
        match &self.door {
            Door::Process(client) => client
                .call(request, STORE_WAIT)
                .unwrap_or_else(Reply::Error),
            #[cfg(test)]
            Door::Local(service) => service.handle_store(request),
        }
    }
}
