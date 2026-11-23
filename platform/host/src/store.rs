//! The host's door to the store service, the platform layer behind the
//! store.* builtins. The record files live in the store service, a
//! separate process. The host says which app each request is for, taken
//! from the dispatcher it made for that app's session, so a contract can
//! never name another app's records.

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use der_store::{Reply, Request};
use serde_json::Value;
use tauri::{AppHandle, Manager};

/// How long a store request may take to answer.
const WAIT: Duration = Duration::from_secs(30);

type Client = der_wire::Client<Request, Reply>;

enum Door {
    Process(Arc<Client>),
    #[cfg(test)]
    Local(der_store::Service),
}

pub struct Store {
    door: Door,
}

impl Store {
    /// The service over this app's stores folder, shared by every caller
    /// in the process.
    pub fn for_app(app: &AppHandle) -> Result<Self, String> {
        static CLIENT: OnceLock<Arc<Client>> = OnceLock::new();
        let dir = app
            .path()
            .app_data_dir()
            .map(|dir| dir.join("stores"))
            .map_err(|e| e.to_string())?;
        let client = match CLIENT.get() {
            Some(client) => client,
            None => {
                let client = crate::services::client("store", crate::services::STORE, Some(&dir))?;
                CLIENT.get_or_init(|| Arc::new(client))
            }
        };
        Ok(Store {
            door: Door::Process(client.clone()),
        })
    }

    /// The service run inside the test process over an explicit stores
    /// folder.
    #[cfg(test)]
    pub fn at(stores_dir: &std::path::Path) -> Self {
        Store {
            door: Door::Local(der_store::Service::new(stores_dir)),
        }
    }

    /// Answers one request with the operation's outputs.
    pub fn call(&self, request: Request) -> Result<Value, String> {
        let reply = match &self.door {
            Door::Process(client) => client.call(request, WAIT)?,
            #[cfg(test)]
            Door::Local(service) => service.handle(request),
        };
        match reply {
            Reply::Outputs(outputs) => Ok(outputs),
            Reply::Error(message) => Err(message),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_request_names_its_app_and_comes_back_as_outputs() {
        let dir = tempfile::tempdir().expect("temp dir");
        let store = Store::at(dir.path());
        let saved = store
            .call(Request::Put {
                experience_id: "app-1".to_string(),
                collection: "notes".to_string(),
                record: json!({ "title": "first" }).as_object().cloned().unwrap(),
            })
            .expect("saves");
        assert_eq!(saved["count"], 1);
        let refused = store
            .call(Request::Put {
                experience_id: String::new(),
                collection: "notes".to_string(),
                record: serde_json::Map::new(),
            })
            .expect_err("no app");
        assert!(refused.contains("needs its owning app"), "{refused}");
    }
}
