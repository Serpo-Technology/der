//! The host dispatcher: routes a session's non-builtin operations to the
//! machinery that already runs them for the webview, with the same
//! confinement. Wasm compute parts execute in the hardened wasmtime host,
//! integration part remotes go through the signed service path with
//! part-scoped credentials, contract remote endpoints and http.get go
//! through the shared confined HTTP core. Local code stays webview-only.

use std::collections::HashMap;

use serde_json::{Map, Value};
use tauri::Manager;

use super::session::{DispatchRequest, OperationDispatcher};
use super::value::js_to_string;
use crate::fragments::{execute_in_module, execute_part_remote_core, FragmentsState};

/// Where an installed part operation runs, derived from the installed
/// manifests at session open.
#[derive(Clone)]
pub struct PartRoute {
    pub fragment_id: String,
    pub remote: bool,
}

pub struct HostDispatcher {
    pub app: tauri::AppHandle,
    pub parts: HashMap<String, PartRoute>,
}

impl OperationDispatcher for HostDispatcher {
    fn dispatch(&self, request: &DispatchRequest) -> Result<Map<String, Value>, String> {
        if let Some(route) = self.parts.get(request.operation_name) {
            return if route.remote {
                self.dispatch_part_remote(route, request)
            } else {
                self.dispatch_part_wasm(route, request)
            };
        }
        if request.operation_name == "http.get" {
            return self.dispatch_http_get(request);
        }
        if let Some(outcome) = self.dispatch_file_op(request) {
            return outcome;
        }
        if let Some(implementation) = request.implementation {
            if implementation.get("endpoint").is_some() {
                return self.dispatch_remote(request.inputs, implementation);
            }
        }
        Err(format!(
            "Unknown operation \"{}\" ({}): not a builtin and no runnable implementation",
            request.operation_name, request.operation_id
        ))
    }
}

impl HostDispatcher {
    fn dispatch_part_wasm(
        &self,
        route: &PartRoute,
        request: &DispatchRequest,
    ) -> Result<Map<String, Value>, String> {
        let dir = self.fragments_dir()?;
        let state = self.app.state::<FragmentsState>();
        let loaded = state
            .load(&dir, &route.fragment_id)
            .map_err(|error| error.message)?;
        let result = execute_in_module(
            state.engine(),
            &loaded,
            request.operation_name,
            &Value::Object(request.inputs.clone()),
        )
        .map_err(|error| error.message)?;
        as_outputs(result)
    }

    fn dispatch_part_remote(
        &self,
        route: &PartRoute,
        request: &DispatchRequest,
    ) -> Result<Map<String, Value>, String> {
        let dir = self.fragments_dir()?;
        let integrations = crate::settings::load_integrations(&self.app);
        let data = tauri::async_runtime::block_on(execute_part_remote_core(
            &dir,
            &integrations,
            &route.fragment_id,
            request.operation_name,
            &Value::Object(request.inputs.clone()),
        ))
        .map_err(|error| error.message)?;
        as_outputs(data)
    }

    /// The user-mediated file IO layer: dialogs and grant-confined reads,
    /// shared with the webview's commands.
    fn dispatch_file_op(
        &self,
        request: &DispatchRequest,
    ) -> Option<Result<Map<String, Value>, String>> {
        let text = |key: &str| {
            request
                .inputs
                .get(key)
                .map(super::value::js_to_string)
                .unwrap_or_default()
        };
        let result = match request.operation_name {
            "file.pick" => crate::files::pick_core(&self.app, &text("kind")),
            "file.read" => crate::files::read_core(&self.app, &text("file")),
            "file.save" => crate::files::save_core(&self.app, &text("data"), &text("name")),
            "email.send" => crate::mail::send_core(
                &self.app,
                &text("from"),
                &text("to"),
                &text("subject"),
                &text("text"),
            ),
            _ => return None,
        };
        Some(result.and_then(as_outputs))
    }

    /// Mirrors the webview's http.get builtin: the url input becomes a GET
    /// against the shared confined HTTP core.
    fn dispatch_http_get(&self, request: &DispatchRequest) -> Result<Map<String, Value>, String> {
        let url = match request.inputs.get("url") {
            None | Some(Value::Null) => String::new(),
            Some(value) => js_to_string(value),
        };
        if !url.starts_with("http://") && !url.starts_with("https://") {
            return Err(format!(
                "http.get needs an http(s) URL, got: {}",
                if url.is_empty() { "(empty)" } else { &url }
            ));
        }
        let mut implementation = Map::new();
        implementation.insert("type".to_string(), Value::String("remote".to_string()));
        implementation.insert("endpoint".to_string(), Value::String(url));
        implementation.insert("method".to_string(), Value::String("GET".to_string()));
        let data = self.remote_core(&HashMap::new(), &implementation)?;
        let mut outputs = Map::new();
        outputs.insert("response".to_string(), data);
        Ok(outputs)
    }

    /// A contract remote operation: object payloads pass through as outputs,
    /// anything else lands under a stable "response" key, matching the
    /// webview executor.
    fn dispatch_remote(
        &self,
        inputs: &Map<String, Value>,
        implementation: &Map<String, Value>,
    ) -> Result<Map<String, Value>, String> {
        let flat: HashMap<String, Value> = inputs
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        let data = self.remote_core(&flat, implementation)?;
        match data {
            Value::Object(map) => Ok(map),
            other => {
                let mut outputs = Map::new();
                outputs.insert("response".to_string(), other);
                Ok(outputs)
            }
        }
    }

    fn remote_core(
        &self,
        inputs: &HashMap<String, Value>,
        implementation: &Map<String, Value>,
    ) -> Result<Value, String> {
        let implementation: crate::OperationImplementation =
            serde_json::from_value(Value::Object(implementation.clone()))
                .map_err(|error| format!("Invalid remote implementation: {}", error))?;
        let integrations = crate::settings::load_integrations(&self.app);
        tauri::async_runtime::block_on(crate::execute_remote_core(
            inputs,
            &implementation,
            &integrations,
        ))
    }

    fn fragments_dir(&self) -> Result<std::path::PathBuf, String> {
        self.app
            .path()
            .app_data_dir()
            .map(|dir| dir.join("fragments"))
            .map_err(|error| error.to_string())
    }
}

/// Wasm and part-remote results must be output objects, like the webview's
/// FragmentsService requires.
fn as_outputs(data: Value) -> Result<Map<String, Value>, String> {
    match data {
        Value::Object(map) => Ok(map),
        _ => Err("The part returned an invalid result".to_string()),
    }
}
