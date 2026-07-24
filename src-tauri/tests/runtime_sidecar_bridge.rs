//! The native panel bridge over a recording transport: opens send trees,
//! panel events mutate the session and answer with fresh trees, failures
//! surface, and closed windows drop their sessions.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use dynamic_experience_runtime_lib::runtime::env::ScriptedEnv;
use dynamic_experience_runtime_lib::runtime::sessions::open_session_core;
use dynamic_experience_runtime_lib::runtime::sidecar::{SidecarBridge, SidecarTransport};
use serde_json::{json, Map, Value};

#[derive(Clone, Default)]
struct Recorder(Arc<Mutex<Vec<Value>>>);

impl SidecarTransport for Recorder {
    fn send(&mut self, message: &Value) -> Result<(), String> {
        self.0.lock().unwrap().push(message.clone());
        Ok(())
    }
}

fn counter_contract() -> Value {
    json!({
        "name": "counter",
        "elements": [
            {
                "id": "count-text",
                "type": "text",
                "dataBindings": [
                    { "property": "content", "source": "state", "sourceId": "clicks",
                      "transforms": [ { "type": "format", "parameters": { "template": "Clicks: {{value}}" } } ] }
                ]
            },
            {
                "id": "click-btn",
                "type": "button",
                "properties": { "text": "Click" },
                "eventBindings": [ { "event": "click", "operationId": "op-add" } ]
            },
            { "id": "note-in", "type": "input", "properties": { "label": "Note" } }
        ],
        "operations": [
            { "id": "op-add", "operationName": "counter.add",
              "inputs": [ { "name": "key", "source": "constant", "sourceId": "clicks" } ], "outputs": [] },
            { "id": "op-boom", "operationName": "random.pick",
              "inputs": [ { "name": "list", "source": "state", "sourceId": "empty" } ], "outputs": [] }
        ]
    })
}

fn open_bridge() -> (SidecarBridge, Recorder) {
    let recorder = Recorder::default();
    let mut bridge = SidecarBridge::new(Box::new(recorder.clone()));
    let contract = counter_contract();
    let entry = open_session_core(
        &contract,
        Map::new(),
        Map::new(),
        Box::new(ScriptedEnv {
            ids: VecDeque::new(),
            randoms: VecDeque::new(),
            epoch_ms: 0,
            tz_offset_minutes: 0,
        }),
        None,
    )
    .expect("session opens");
    let elements = contract["elements"].as_array().cloned().unwrap();
    bridge
        .open_window("w1", "exp-counter", "Counter", None, entry, elements)
        .expect("window opens");
    (bridge, recorder)
}

fn content_of(tree: &Value) -> String {
    tree.as_array()
        .and_then(|nodes| nodes.first())
        .and_then(|node| node["props"]["content"].as_str())
        .unwrap_or_default()
        .to_string()
}

#[test]
fn dispatch_events_update_the_tree() {
    let (mut bridge, recorder) = open_bridge();
    {
        let sent = recorder.0.lock().unwrap();
        assert_eq!(sent[0]["cmd"], "open");
        assert_eq!(sent[0]["title"], "Counter");
    }

    bridge
        .handle_event(&json!({
            "event": "dispatch", "windowId": "w1", "operationIds": ["op-add"]
        }))
        .expect("dispatch handled");
    bridge
        .handle_event(&json!({
            "event": "dispatch", "windowId": "w1", "operationIds": ["op-add"]
        }))
        .expect("dispatch handled");

    let sent = recorder.0.lock().unwrap();
    let last = sent.last().unwrap();
    assert_eq!(last["cmd"], "update");
    assert_eq!(content_of(&last["tree"]), "Clicks: 2");
}

#[test]
fn element_writes_update_and_failures_surface() {
    let (mut bridge, recorder) = open_bridge();

    bridge
        .handle_event(&json!({
            "event": "setElement", "windowId": "w1", "elementId": "note-in", "value": "hello"
        }))
        .expect("write handled");
    {
        let sent = recorder.0.lock().unwrap();
        let last = sent.last().unwrap();
        assert_eq!(last["cmd"], "update");
        let control = last["tree"][2]["control"]["value"].as_str().unwrap();
        assert_eq!(control, "hello");
    }

    bridge
        .handle_event(&json!({
            "event": "dispatch", "windowId": "w1", "operationIds": ["op-boom", "op-add"]
        }))
        .expect("failure handled");
    let sent = recorder.0.lock().unwrap();
    let failure = sent
        .iter()
        .find(|message| message["cmd"] == "operationFailed")
        .expect("failure surfaced");
    assert_eq!(failure["operationId"], "op-boom");
    // The chain stopped: the counter never advanced.
    assert_eq!(content_of(&sent.last().unwrap()["tree"]), "Clicks: ");
}

#[test]
fn session_mutations_fire_the_persistence_callback() {
    let (mut bridge, _recorder) = open_bridge();
    let saved: Arc<Mutex<Vec<(String, Value)>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = saved.clone();
    bridge.set_on_change(Box::new(move |experience_id, state| {
        sink.lock()
            .unwrap()
            .push((experience_id.to_string(), Value::Object(state.clone())));
    }));

    bridge
        .handle_event(&json!({
            "event": "dispatch", "windowId": "w1", "operationIds": ["op-add"]
        }))
        .expect("dispatch handled");

    let saved = saved.lock().unwrap();
    assert_eq!(saved.len(), 1);
    assert_eq!(saved[0].0, "exp-counter");
    assert_eq!(saved[0].1["clicks"], json!(1.0));
}

#[test]
fn replacing_a_session_preserves_state_and_updates_the_view() {
    let (mut bridge, recorder) = open_bridge();
    bridge
        .handle_event(&json!({
            "event": "dispatch", "windowId": "w1", "operationIds": ["op-add"]
        }))
        .expect("dispatch handled");

    // A contract edit rebuilds the session with the preserved state, the
    // way the native update command does it.
    let preserved = bridge.state_of_experience("exp-counter").expect("state");
    let contract = counter_contract();
    let entry = open_session_core(
        &contract,
        preserved,
        Map::new(),
        Box::new(ScriptedEnv {
            ids: VecDeque::new(),
            randoms: VecDeque::new(),
            epoch_ms: 0,
            tz_offset_minutes: 0,
        }),
        None,
    )
    .expect("rebuilt session");
    let elements = contract["elements"].as_array().cloned().unwrap();
    bridge
        .replace_session("exp-counter", entry, elements)
        .expect("session replaced");

    let sent = recorder.0.lock().unwrap();
    let last = sent.last().unwrap();
    assert_eq!(last["cmd"], "update");
    // Restored data beats the rebuilt session's placeholders.
    assert_eq!(content_of(&last["tree"]), "Clicks: 1");
}

#[test]
fn home_actions_return_to_the_caller() {
    let (mut bridge, _recorder) = open_bridge();
    let relayed = bridge
        .handle_event(&json!({ "event": "create", "prompt": "a todo app" }))
        .expect("handled")
        .expect("relayed");
    assert_eq!(relayed["prompt"], "a todo app");

    let handled = bridge
        .handle_event(&json!({
            "event": "dispatch", "windowId": "w1", "operationIds": ["op-add"]
        }))
        .expect("handled");
    assert!(handled.is_none());
}

#[test]
fn closed_windows_drop_their_sessions() {
    let (mut bridge, _recorder) = open_bridge();
    assert_eq!(bridge.window_count(), 1);
    bridge
        .handle_event(&json!({ "event": "windowClosed", "windowId": "w1" }))
        .expect("close handled");
    assert_eq!(bridge.window_count(), 0);
    let error = bridge
        .handle_event(&json!({
            "event": "dispatch", "windowId": "w1", "operationIds": ["op-add"]
        }))
        .unwrap_err();
    assert!(error.contains("No native window"), "got: {}", error);
}
