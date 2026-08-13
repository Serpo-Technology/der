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
    /// Input-name prefixes assembled into objects before execution, from
    /// the part's manifest (the webview executor does the same).
    pub structured_prefixes: Vec<String>,
}

pub struct HostDispatcher {
    pub app: tauri::AppHandle,
    pub parts: HashMap<String, PartRoute>,
    /// The owning experience; per-app stores are confined to it.
    pub experience_id: String,
}

impl OperationDispatcher for HostDispatcher {
    fn dispatch(&self, request: &DispatchRequest) -> Result<Map<String, Value>, String> {
        if let Some(route) = self.parts.get(request.operation_name) {
            let prefixes: Vec<&str> =
                route.structured_prefixes.iter().map(String::as_str).collect();
            let assembled = super::operations::assemble_structured(request.inputs, &prefixes);
            return if route.remote {
                self.dispatch_part_remote(route, request, &assembled)
            } else {
                self.dispatch_part_wasm(route, request, &assembled)
            };
        }
        if request.operation_name == "http.get" {
            return self.dispatch_http_get(request);
        }
        if let Some(outcome) = self.dispatch_file_op(request) {
            return outcome;
        }
        if let Some(outcome) = self.dispatch_store_op(request) {
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
        inputs: &Map<String, Value>,
    ) -> Result<Map<String, Value>, String> {
        let dir = self.fragments_dir()?;
        let state = self.app.state::<FragmentsState>();
        let loaded = state
            .load(&dir, &route.fragment_id)
            .map_err(|error| error.message)?;
        let result = crate::fragments::execute_with_app_files(
            &self.app,
            state.engine(),
            &loaded,
            request.operation_name,
            &Value::Object(inputs.clone()),
        )
        .map_err(|error| error.message)?;
        as_outputs(result)
    }

    fn dispatch_part_remote(
        &self,
        route: &PartRoute,
        request: &DispatchRequest,
        inputs: &Map<String, Value>,
    ) -> Result<Map<String, Value>, String> {
        let dir = self.fragments_dir()?;
        let integrations = crate::settings::load_integrations(&self.app);
        let data = tauri::async_runtime::block_on(execute_part_remote_core(
            &dir,
            &integrations,
            &route.fragment_id,
            request.operation_name,
            &Value::Object(inputs.clone()),
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
            "email.list" => crate::mail::list_core(&self.app, &text("limit")),
            "email.fetch" => crate::mail::fetch_core(&self.app, &text("id")),
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

    /// The per-app record store: collections confined to the owning
    /// experience, shared with the webview's commands.
    fn dispatch_store_op(
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
        let base = match crate::store::stores_dir(&self.app) {
            Ok(dir) => dir,
            Err(error) => return Some(Err(error)),
        };
        let result = match request.operation_name {
            "store.put" => {
                // The session hands dispatched inputs flat; assemble the
                // record.* prefix here like the webview executor does.
                let mut record = match request.inputs.get("record") {
                    Some(Value::Object(map)) => map.clone(),
                    _ => Map::new(),
                };
                for (name, value) in request.inputs.iter() {
                    if let Some(field) = name.strip_prefix("record.") {
                        record.insert(field.to_string(), value.clone());
                    }
                }
                crate::store::put_core(&base, &self.experience_id, &text("collection"), &record, || {
                    uuid::Uuid::new_v4().to_string()
                })
            }
            "store.query" => crate::store::query_core(
                &base,
                &self.experience_id,
                &text("collection"),
                &text("field"),
                request.inputs.get("equals").unwrap_or(&Value::Null),
                &text("contains"),
                &text("sortBy"),
                &text("direction"),
                &text("limit"),
                &text("offset"),
            ),
            "store.remove" => {
                crate::store::remove_core(&base, &self.experience_id, &text("collection"), &text("id"))
            }
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
        // Non-JSON responses arrive as {"raw": text}; "body" carries the
        // text either way so HTML pages read without an unwrapping step.
        let body = match data.get("raw").and_then(Value::as_str) {
            Some(raw) if data.as_object().map(|map| map.len()) == Some(1) => raw.to_string(),
            _ => serde_json::to_string(&data).unwrap_or_default(),
        };
        let mut outputs = Map::new();
        outputs.insert("response".to_string(), data);
        outputs.insert("body".to_string(), Value::String(body));
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
