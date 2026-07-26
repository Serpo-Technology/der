//! Live runtime sessions for renderer backends: open a contract, read the
//! resolved view tree, write element values, dispatch event chains, close.
//! The core functions are host-free so tests drive them directly; the Tauri
//! commands wire in the installed fragment defs, the part routes, and the
//! host dispatcher, and are the surface an external renderer process
//! (or the webview) talks to.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value};
use tauri::Manager;

use super::env::{RuntimeEnv, SystemEnv};
use super::host::{HostDispatcher, PartRoute};
use super::session::{OperationDispatcher, OperationSpec, Session};
use super::templates::instantiate_pack_operations;
use super::view::{resolve_view_tree, ViewContext};

pub struct SessionEntry {
    session: Session,
    fragment_defs: Map<String, Value>,
}

/// Builds a session from a contract: its own operations plus every pack
/// instance's instantiated operations, initial state merged with saved data,
/// and element default seeds. Mirrors the webview's contract preparation.
pub fn open_session_core(
    contract: &Value,
    initial_data: Map<String, Value>,
    fragment_defs: Map<String, Value>,
    env: Box<dyn RuntimeEnv + Send>,
    dispatcher: Option<Box<dyn OperationDispatcher>>,
) -> Result<SessionEntry, String> {
    let elements = contract
        .get("elements")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut operations: Vec<OperationSpec> = contract
        .get("operations")
        .map(|ops| serde_json::from_value(ops.clone()))
        .transpose()
        .map_err(|error| format!("Contract operations are malformed: {}", error))?
        .unwrap_or_default();
    for pack_operation in collect_pack_operations(&elements, &fragment_defs) {
        let spec: OperationSpec = serde_json::from_value(pack_operation)
            .map_err(|error| format!("Pack operation is malformed: {}", error))?;
        operations.push(spec);
    }

    let initial_state = contract
        .get("initialState")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let mut session = Session::new(operations, initial_state, &elements, env);
    // Saved data wins over operation placeholders and element defaults,
    // matching the webview's initialData merge.
    session.overlay_data(initial_data);
    if let Some(dispatcher) = dispatcher {
        session.set_dispatcher(dispatcher);
    }
    Ok(SessionEntry {
        session,
        fragment_defs,
    })
}

/// Walks the element tree collecting instantiated operations of every pack
/// instance, like the webview's expandPackOperations.
fn collect_pack_operations(elements: &[Value], fragment_defs: &Map<String, Value>) -> Vec<Value> {
    let mut collected = Vec::new();
    for element in elements {
        let Some(element_map) = element.as_object() else { continue };
        if let Some(def) = element_map
            .get("type")
            .and_then(Value::as_str)
            .and_then(|element_type| fragment_defs.get(element_type))
            .and_then(Value::as_object)
        {
            if def.get("operations").is_some() {
                collected.extend(instantiate_pack_operations(element_map, def));
            }
        }
        if let Some(children) = element_map.get("children").and_then(Value::as_array) {
            collected.extend(collect_pack_operations(children, fragment_defs));
        }
    }
    collected
}

pub fn resolve_entry_view(entry: &SessionEntry, elements: &[Value]) -> Vec<Value> {
    let ctx = ViewContext {
        state: entry.session.state(),
        fragment_defs: &entry.fragment_defs,
    };
    resolve_view_tree(elements, &ctx)
}

impl SessionEntry {
    pub fn session_mut(&mut self) -> &mut Session {
        &mut self.session
    }

    pub fn session(&self) -> &Session {
        &self.session
    }
}

// ---------------------------------------------------------------------------
// Tauri surface
// ---------------------------------------------------------------------------

type SessionsMap = HashMap<String, (SessionEntry, Vec<Value>)>;

/// Sessions plus each contract's elements (the tree source), keyed by id.
/// Arc so blocking dispatch work can own a handle off the async runtime.
#[derive(Default, Clone)]
pub struct RuntimeSessionsState(Arc<Mutex<SessionsMap>>);

fn with_sessions<T>(state: &RuntimeSessionsState, run: impl FnOnce(&mut SessionsMap) -> T) -> T {
    let mut guard = state.0.lock().unwrap();
    run(&mut guard)
}

/// Installed fragment defs and part operation routes, from the manifests on
/// disk; the same vocabulary the webview publishes at startup.
pub(crate) fn installed_vocabulary(
    app: &tauri::AppHandle,
) -> (Map<String, Value>, HashMap<String, PartRoute>) {
    let mut fragment_defs = Map::new();
    let mut parts = HashMap::new();
    let Ok(dir) = app.path().app_data_dir().map(|dir| dir.join("fragments")) else {
        return (fragment_defs, parts);
    };
    for installed in crate::fragments::list_core(&dir) {
        let Some(manifest) = installed.get("manifest") else { continue };
        let fragment_id = manifest
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if let Some(Value::Array(fragments)) = manifest.get("uiFragments") {
            for fragment in fragments {
                if let Some(name) = fragment.get("name").and_then(Value::as_str) {
                    fragment_defs.insert(name.to_string(), fragment.clone());
                }
            }
        }
        if let Some(Value::Array(operations)) = manifest.get("operations") {
            for operation in operations {
                if let Some(name) = operation.get("name").and_then(Value::as_str) {
                    parts.insert(
                        name.to_string(),
                        PartRoute {
                            fragment_id: fragment_id.clone(),
                            remote: operation.get("remote").is_some(),
                        },
                    );
                }
            }
        }
    }
    (fragment_defs, parts)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionOpened {
    pub session_id: String,
    pub tree: Vec<Value>,
    pub state: Map<String, Value>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventOutcome {
    pub failed: Option<String>,
    pub tree: Vec<Value>,
    pub state: Map<String, Value>,
}

#[tauri::command]
pub async fn runtime_open_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, RuntimeSessionsState>,
    contract: Value,
    initial_data: Option<Map<String, Value>>,
    experience_id: Option<String>,
) -> Result<SessionOpened, String> {
    let (fragment_defs, parts) = installed_vocabulary(&app);
    let dispatcher = HostDispatcher {
        app: app.clone(),
        parts,
        experience_id: experience_id.unwrap_or_default(),
    };
    let entry = open_session_core(
        &contract,
        initial_data.unwrap_or_default(),
        fragment_defs,
        Box::new(SystemEnv),
        Some(Box::new(dispatcher)),
    )?;
    let elements = contract
        .get("elements")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let session_id = format!("rs-{}", uuid::Uuid::new_v4());
    let tree = resolve_entry_view(&entry, &elements);
    let session_state = entry.session().state().clone();
    with_sessions(&state, |sessions| {
        sessions.insert(session_id.clone(), (entry, elements));
    });
    Ok(SessionOpened {
        session_id,
        tree,
        state: session_state,
    })
}

#[tauri::command]
pub async fn runtime_resolve_view(
    state: tauri::State<'_, RuntimeSessionsState>,
    session_id: String,
) -> Result<Vec<Value>, String> {
    with_sessions(&state, |sessions| {
        let (entry, elements) = sessions
            .get(&session_id)
            .ok_or_else(|| format!("No open session {}", session_id))?;
        Ok(resolve_entry_view(entry, elements))
    })
}

#[tauri::command]
pub async fn runtime_set_element(
    state: tauri::State<'_, RuntimeSessionsState>,
    session_id: String,
    element_id: String,
    value: Value,
) -> Result<(), String> {
    with_sessions(&state, |sessions| {
        let (entry, _) = sessions
            .get_mut(&session_id)
            .ok_or_else(|| format!("No open session {}", session_id))?;
        entry.session_mut().set_element(&element_id, value);
        Ok(())
    })
}

#[tauri::command]
pub async fn runtime_dispatch_event(
    state: tauri::State<'_, RuntimeSessionsState>,
    session_id: String,
    operation_ids: Vec<String>,
    item: Option<Value>,
) -> Result<EventOutcome, String> {
    // Dispatch may block on part or remote execution; keep it off the async
    // runtime's core threads.
    let sessions = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_sessions(&sessions, |entries| {
            let (entry, elements) = entries
                .get_mut(&session_id)
                .ok_or_else(|| format!("No open session {}", session_id))?;
            let failed = entry
                .session_mut()
                .run_chain(&operation_ids, item.as_ref());
            Ok(EventOutcome {
                failed,
                tree: resolve_entry_view(entry, elements),
                state: entry.session().state().clone(),
            })
        })
    })
    .await
    .map_err(|error| format!("Dispatch task failed: {}", error))?
}

#[tauri::command]
pub async fn runtime_close_session(
    state: tauri::State<'_, RuntimeSessionsState>,
    session_id: String,
) -> Result<(), String> {
    with_sessions(&state, |sessions| {
        sessions.remove(&session_id);
        Ok(())
    })
}

// ---------------------------------------------------------------------------
// Native compose: the create pipeline with no webview involved.
// ---------------------------------------------------------------------------

/// The model transport for real composition: llm_chat with provider, model,
/// and credentials resolved from stored settings, exactly like the webview's
/// LLMClient.
pub(crate) struct HostLlm {
    pub(crate) app: tauri::AppHandle,
}

impl super::compose::ComposeLlm for HostLlm {
    fn send<'a>(
        &'a mut self,
        messages: Vec<Value>,
        options: super::compose::LlmSendOptions,
        on_chunk: Option<super::compose::ChunkCallback<'a>>,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<super::compose::LlmReply, String>> + Send + 'a>,
    > {
        let app = self.app.clone();
        Box::pin(async move {
            let chat_messages: Vec<crate::llm::ChatMessage> = messages
                .iter()
                .map(|message| crate::llm::ChatMessage {
                    role: message.get("role").and_then(Value::as_str).unwrap_or("user").to_string(),
                    content: message
                        .get("content")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                })
                .collect();
            let system_blocks: Vec<crate::llm::SystemBlock> = options
                .system_blocks
                .iter()
                .map(|block| crate::llm::SystemBlock { text: block.text.clone(), cache: block.cache })
                .collect();
            let request = crate::llm::LlmChatRequest {
                messages: chat_messages,
                system_blocks: Some(system_blocks),
                stream: on_chunk.is_some(),
                provider: None,
                model: None,
                max_tokens: options.max_tokens,
                temperature: None,
                json_mode: Some(options.json_mode),
                base_url: None,
            };
            let response = crate::llm::llm_chat_impl(app, request, on_chunk).await?;
            Ok(super::compose::LlmReply {
                content: response.content,
                provider: Some(response.provider),
            })
        })
    }
}

/// The installed vocabulary compose validates and teaches against.
pub(crate) fn compose_vocabulary(app: &tauri::AppHandle) -> super::compose::ComposeVocabulary {
    let installed = app
        .path()
        .app_data_dir()
        .ok()
        .map(|dir| crate::fragments::list_core(&dir.join("fragments")))
        .unwrap_or_default();
    let credentials: Vec<Value> = crate::settings::list_integration_credentials(app.clone())
        .into_iter()
        .filter_map(|view| serde_json::to_value(view).ok())
        .collect();
    super::compose::vocabulary_from_installed(&installed, credentials)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeResult {
    pub contract: Value,
    pub spec: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recipe_name: Option<String>,
    pub warnings: Vec<Value>,
}

/// One model round trip from description to validated, finalized contract,
/// entirely in the Rust core: prompt, repair loop, manifest checker, and
/// finalization all run host-side.
#[tauri::command]
pub async fn runtime_compose(
    app: tauri::AppHandle,
    description: String,
) -> Result<ComposeResult, String> {
    let vocab = compose_vocabulary(&app);
    let now_iso = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let mut llm = HostLlm { app: app.clone() };
    let outcome =
        super::compose::compose_from_description(&mut llm, &description, &vocab, &now_iso, None)
            .await?;
    Ok(ComposeResult {
        contract: outcome.contract,
        spec: outcome.spec,
        recipe_name: outcome.recipe_name,
        warnings: outcome.warnings,
    })
}
