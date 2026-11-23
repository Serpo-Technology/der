//! The host's one door to the integration credential store and to every
//! outbound request that may carry a stored secret. Callers hand over a
//! request and get back a reply that holds no secret.

use std::path::Path;

use der_http::{HttpReply, HttpRequest, Reply, Request, Service};

pub struct Secrets {
    service: Service,
}

impl Secrets {
    /// The service over this app's settings directory.
    pub fn for_app(app: &tauri::AppHandle) -> Result<Self, String> {
        Ok(Secrets::at(&crate::settings::settings_dir(app)?))
    }

    /// The service over an explicit settings directory.
    pub fn at(settings_dir: &Path) -> Self {
        Secrets {
            service: Service::new(settings_dir),
        }
    }

    /// Performs one HTTP request.
    pub async fn http(&self, request: HttpRequest) -> Result<HttpReply, String> {
        match self.service.handle(Request::Http(request)).await {
            Reply::Http(reply) => Ok(reply),
            Reply::Error(message) => Err(message),
            _ => Err("The HTTP service answered out of turn".to_string()),
        }
    }

    /// Answers a store request.
    pub fn store(&self, request: Request) -> Reply {
        self.service.handle_store(request)
    }
}
