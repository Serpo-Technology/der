//! The pure session-entry layer renderer hosts share: a contract becomes a
//! running session (pack operations instantiated, saved data overlaid,
//! element defaults seeded) plus the view resolution over its state. The
//! desktop core, the wasm build, and the tests all open sessions through
//! here.

use serde_json::{Map, Value};

use crate::env::RuntimeEnv;
use crate::session::{OperationDispatcher, OperationSpec, Session};
use crate::templates::instantiate_pack_operations;
use crate::view::{resolve_view_tree, ViewContext};

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
