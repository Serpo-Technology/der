//! Background refresh beats without a host: a visible timer's tick chain
//! runs once per beat against a headless session, and visibility gating
//! keeps paused timers paused.

use std::collections::VecDeque;

use dynamic_experience_runtime_lib::runtime::env::ScriptedEnv;
use dynamic_experience_runtime_lib::runtime::schedule::run_timer_chains;
use dynamic_experience_runtime_lib::runtime::sessions::open_session_core;
use serde_json::{json, Map, Value};

fn scripted_env() -> Box<ScriptedEnv> {
    Box::new(ScriptedEnv {
        ids: VecDeque::new(),
        randoms: VecDeque::new(),
        epoch_ms: 1753315200000,
        tz_offset_minutes: 0,
    })
}

fn ticker_contract(gated: bool) -> Value {
    let mut timer = json!({
        "id": "beat",
        "type": "timer",
        "properties": { "interval": 60000 },
        "eventBindings": [{ "event": "tick", "operationId": "op-count" }],
    });
    if gated {
        timer["visibleWhen"] = json!({
            "source": "state",
            "sourceId": "running",
            "operator": "truthy",
        });
    }
    json!({
        "name": "ticker",
        "elements": [
            timer,
            {
                "id": "shown",
                "type": "text",
                "dataBindings": [{ "property": "content", "source": "state", "sourceId": "beats" }],
            },
        ],
        "operations": [
            {
                "id": "op-count",
                "operationName": "counter.add",
                "inputs": [{ "name": "key", "source": "constant", "sourceId": "beats" }],
                "outputs": [],
            },
        ],
        "initialState": { "beats": 0, "running": false },
    })
}

fn elements_of(contract: &Value) -> Vec<Value> {
    contract
        .get("elements")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

#[test]
fn a_visible_timer_chain_runs_once_per_beat() {
    let contract = ticker_contract(false);
    let elements = elements_of(&contract);
    let mut entry =
        open_session_core(&contract, Map::new(), Map::new(), scripted_env(), None).unwrap();

    assert_eq!(run_timer_chains(&mut entry, &elements), 1);
    assert_eq!(run_timer_chains(&mut entry, &elements), 1);
    assert_eq!(entry.session().state().get("beats").and_then(Value::as_f64), Some(2.0));
}

#[test]
fn a_gated_timer_stays_paused_in_the_background() {
    let contract = ticker_contract(true);
    let elements = elements_of(&contract);
    let mut entry =
        open_session_core(&contract, Map::new(), Map::new(), scripted_env(), None).unwrap();

    assert_eq!(run_timer_chains(&mut entry, &elements), 0);
    assert_eq!(entry.session().state().get("beats").and_then(Value::as_f64), Some(0.0));

    // Saved state with the flag on resumes the beats, exactly like an app
    // the user left running.
    let mut resumed = Map::new();
    resumed.insert("running".to_string(), json!(true));
    let mut entry =
        open_session_core(&contract, resumed, Map::new(), scripted_env(), None).unwrap();
    assert_eq!(run_timer_chains(&mut entry, &elements), 1);
    assert_eq!(entry.session().state().get("beats").and_then(Value::as_f64), Some(1.0));
}
