//! The renderer protocol end to end without a webview: sessions built from
//! contracts (pack operations included), event chains driven against the
//! resolved view tree, and the dispatcher seam for non-builtin operations.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use dynamic_experience_runtime_lib::runtime::env::ScriptedEnv;
use dynamic_experience_runtime_lib::runtime::session::{
    DispatchRequest, OperationDispatcher, OperationSpec, Session,
};
use dynamic_experience_runtime_lib::runtime::sessions::{open_session_core, resolve_entry_view};
use serde_json::{json, Map, Value};

fn scripted_env() -> Box<ScriptedEnv> {
    Box::new(ScriptedEnv {
        ids: VecDeque::new(),
        randoms: VecDeque::new(),
        epoch_ms: 1753315200000,
        tz_offset_minutes: 0,
    })
}

fn find_node<'a>(tree: &'a [Value], id: &str) -> Option<&'a Value> {
    for node in tree {
        if node.get("id").and_then(Value::as_str) == Some(id) {
            return Some(node);
        }
        if let Some(children) = node.get("children").and_then(Value::as_array) {
            if let Some(found) = find_node(children, id) {
                return Some(found);
            }
        }
        if let Some(rows) = node.get("rows").and_then(Value::as_array) {
            for row in rows {
                if let Some(children) = row.get("children").and_then(Value::as_array) {
                    if let Some(found) = find_node(children, id) {
                        return Some(found);
                    }
                }
            }
        }
    }
    None
}

fn click_chain(tree: &[Value], id: &str) -> Vec<String> {
    find_node(tree, id)
        .and_then(|node| node.get("events"))
        .and_then(|events| events.get("click").or_else(|| events.get("tick")))
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn the_committed_stopwatch_pack_runs_natively() {
    let raw = std::fs::read("../fragments/dist/der-labs.ui-basics.derpart")
        .expect("committed bundle present");
    let envelope: Value = serde_json::from_slice(&raw).unwrap();
    let manifest: Value = serde_json::from_slice(
        &BASE64
            .decode(envelope["manifestB64"].as_str().unwrap())
            .unwrap(),
    )
    .unwrap();
    let mut fragment_defs = Map::new();
    for fragment in manifest["uiFragments"].as_array().unwrap() {
        fragment_defs.insert(
            fragment["name"].as_str().unwrap().to_string(),
            fragment.clone(),
        );
    }

    let contract = json!({
        "name": "reading-timer",
        "elements": [
            { "id": "sw", "type": "basics.stopwatch", "properties": { "label": "Reading" } }
        ],
        "operations": []
    });
    let elements = contract["elements"].as_array().cloned().unwrap();

    let mut entry = open_session_core(&contract, Map::new(), fragment_defs, scripted_env(), None)
        .expect("session opens");

    // Stopped: Start visible, Stop and the timer gated away entirely.
    let tree = resolve_entry_view(&entry, &elements);
    assert!(find_node(&tree, "sw-start").is_some());
    assert!(find_node(&tree, "sw-stop").is_none());
    assert!(find_node(&tree, "sw-tick").is_none());

    // Start, then two ticks through the pack's own instantiated operations.
    let start_chain = click_chain(&tree, "sw-start");
    assert_eq!(start_chain, vec!["sw-run".to_string()]);
    assert_eq!(entry.session_mut().run_chain(&start_chain, None), None);

    let tree = resolve_entry_view(&entry, &elements);
    assert!(find_node(&tree, "sw-start").is_none());
    assert!(find_node(&tree, "sw-stop").is_some());
    let tick_chain = click_chain(&tree, "sw-tick");
    assert_eq!(tick_chain, vec!["sw-advance".to_string()]);
    assert_eq!(entry.session_mut().run_chain(&tick_chain, None), None);
    assert_eq!(entry.session_mut().run_chain(&tick_chain, None), None);

    let tree = resolve_entry_view(&entry, &elements);
    let display = find_node(&tree, "sw-display").expect("display renders");
    assert_eq!(display["props"]["content"], "2 s");

    // Stop, reset, and the display returns to zero.
    let stop_chain = click_chain(&tree, "sw-stop");
    assert_eq!(entry.session_mut().run_chain(&stop_chain, None), None);
    let tree = resolve_entry_view(&entry, &elements);
    let reset_chain = click_chain(&tree, "sw-reset");
    assert_eq!(entry.session_mut().run_chain(&reset_chain, None), None);
    let tree = resolve_entry_view(&entry, &elements);
    assert_eq!(
        find_node(&tree, "sw-display").unwrap()["props"]["content"],
        "0 s"
    );
}

struct FakeDispatcher {
    calls: Arc<Mutex<Vec<(String, Value)>>>,
    outputs: Map<String, Value>,
    fail_on: Option<String>,
}

impl OperationDispatcher for FakeDispatcher {
    fn dispatch(&self, request: &DispatchRequest) -> Result<Map<String, Value>, String> {
        self.calls.lock().unwrap().push((
            request.operation_name.to_string(),
            Value::Object(request.inputs.clone()),
        ));
        if self.fail_on.as_deref() == Some(request.operation_name) {
            return Err("service unavailable".to_string());
        }
        Ok(self.outputs.clone())
    }
}

fn operations(spec: Value) -> Vec<OperationSpec> {
    serde_json::from_value(spec).expect("operations parse")
}

#[test]
fn non_builtins_route_through_the_dispatcher_with_resolved_inputs() {
    let ops = operations(json!([
        {
            "id": "op-rate",
            "operationName": "fx.rate",
            "inputs": [
                { "name": "from", "source": "constant", "sourceId": "USD" },
                { "name": "to", "source": "state", "sourceId": "target" }
            ],
            "outputs": [ { "name": "rate", "target": "state", "targetId": "rate" } ]
        },
        {
            "id": "op-mark",
            "operationName": "state.set",
            "inputs": [
                { "name": "key", "source": "constant", "sourceId": "updated" },
                { "name": "value", "source": "constant", "sourceId": "yes" }
            ],
            "outputs": []
        }
    ]));
    let calls = Arc::new(Mutex::new(Vec::new()));
    let mut outputs = Map::new();
    outputs.insert("rate".to_string(), json!(0.87));

    let mut initial = Map::new();
    initial.insert("target".to_string(), json!("EUR"));
    let mut session = Session::new(ops, initial, &[], scripted_env());
    session.set_dispatcher(Box::new(FakeDispatcher {
        calls: calls.clone(),
        outputs,
        fail_on: None,
    }));

    let failed = session.run_chain(
        &["op-rate".to_string(), "op-mark".to_string()],
        None,
    );
    assert_eq!(failed, None);
    assert_eq!(session.state().get("rate"), Some(&json!(0.87)));
    assert_eq!(session.state().get("updated"), Some(&json!("yes")));

    let recorded = calls.lock().unwrap();
    assert_eq!(recorded.len(), 1);
    assert_eq!(recorded[0].0, "fx.rate");
    assert_eq!(recorded[0].1, json!({ "from": "USD", "to": "EUR" }));
}

#[test]
fn dispatcher_failures_stop_the_chain_and_local_code_is_refused() {
    let ops = operations(json!([
        {
            "id": "op-broken",
            "operationName": "wiki.summary",
            "inputs": [],
            "outputs": []
        },
        {
            "id": "op-after",
            "operationName": "state.set",
            "inputs": [
                { "name": "key", "source": "constant", "sourceId": "ran" },
                { "name": "value", "source": "constant", "sourceId": "yes" }
            ],
            "outputs": []
        },
        {
            "id": "op-code",
            "operationName": "custom.thing",
            "inputs": [],
            "outputs": [],
            "implementation": { "type": "local", "code": "return {}" }
        }
    ]));
    let calls = Arc::new(Mutex::new(Vec::new()));
    let mut session = Session::new(ops, Map::new(), &[], scripted_env());
    session.set_dispatcher(Box::new(FakeDispatcher {
        calls: calls.clone(),
        outputs: Map::new(),
        fail_on: Some("wiki.summary".to_string()),
    }));

    let failed = session.run_chain(&["op-broken".to_string(), "op-after".to_string()], None);
    assert_eq!(failed, Some("op-broken".to_string()));
    assert!(session.state().get("ran").is_none());

    let error = session.run_operation("op-code", None).unwrap_err();
    assert!(error.contains("webview"), "got: {}", error);
    // Local code never reaches the dispatcher.
    assert_eq!(calls.lock().unwrap().len(), 1);
}
