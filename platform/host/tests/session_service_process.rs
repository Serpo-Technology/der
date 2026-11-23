//! An app's session as a real process: the host executable started with
//! `--service session`, held through the live session type the app uses.

use std::process::Command;
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use dynamic_experience_runtime_lib::runtime::live::LiveSession;
use dynamic_experience_runtime_lib::runtime::session::{DispatchRequest, OperationDispatcher};
use serde_json::{json, Map, Value};

const HOST: &str = env!("CARGO_BIN_EXE_dynamic-experience-runtime");

/// A counter with one builtin operation and one only the host can run.
fn contract() -> Value {
    json!({
        "initialState": { "count": 1 },
        "elements": [
            { "id": "shown", "type": "text", "bindings": [
                { "property": "content", "source": "state", "sourceId": "count" }
            ] },
            { "id": "name", "type": "input" }
        ],
        "operations": [
            {
                "id": "op-add",
                "operationName": "counter.add",
                "inputs": [
                    { "name": "key", "source": "constant", "value": "count" },
                    { "name": "amount", "source": "constant", "value": 2 }
                ]
            },
            {
                "id": "op-lookup",
                "operationName": "weather.current",
                "inputs": [{ "name": "city", "source": "ui-element", "sourceId": "name" }],
                "outputs": [{ "name": "temp", "target": "state", "targetId": "temp" }]
            }
        ]
    })
}

/// The host's side in these tests: it records what the session asked and
/// answers a fixed temperature, after an optional pause the test controls.
#[derive(Default)]
struct Recorder {
    asked: Mutex<Vec<(String, Map<String, Value>)>>,
    entered: Mutex<Option<Sender<()>>>,
    release: Mutex<Option<std::sync::mpsc::Receiver<()>>>,
    refuse: bool,
}

impl OperationDispatcher for Recorder {
    fn dispatch(&self, request: &DispatchRequest) -> Result<Map<String, Value>, String> {
        self.asked
            .lock()
            .unwrap()
            .push((request.operation_name.to_string(), request.inputs.clone()));
        if let Some(entered) = self.entered.lock().unwrap().take() {
            let _ = entered.send(());
        }
        if let Some(release) = self.release.lock().unwrap().take() {
            let _ = release.recv_timeout(Duration::from_secs(20));
        }
        if self.refuse {
            return Err("The weather service is down".to_string());
        }
        Ok(json!({ "temp": 7 }).as_object().cloned().unwrap())
    }
}

fn open(host: Arc<Recorder>, saved: Map<String, Value>) -> LiveSession {
    let client = der_wire::Client::new("session", HOST, der_wire::service_arguments_without_dir("session"));
    LiveSession::in_process(client, host, &contract(), saved, Map::new()).expect("opens")
}

fn chain(ids: &[&str]) -> Vec<String> {
    ids.iter().map(|id| id.to_string()).collect()
}

fn kill(process_id: u32) {
    let status = Command::new("kill")
        .arg("-9")
        .arg(process_id.to_string())
        .status()
        .expect("kill runs");
    assert!(status.success());
}

fn alive(process_id: u32) -> bool {
    Command::new("kill")
        .arg("-0")
        .arg(process_id.to_string())
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn wait_until(what: &str, done: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting until {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn a_session_runs_in_its_own_process_and_asks_the_host_for_what_it_cannot_do() {
    let host = Arc::new(Recorder::default());
    let mut session = open(host.clone(), Map::new());
    let process_id = session.process_id().expect("a process");
    assert_ne!(process_id, std::process::id());
    assert_eq!(session.state()["count"], 1);
    assert_eq!(session.tree().len(), 2);

    // A builtin runs inside the session; the host is never asked.
    assert_eq!(session.run_chain_detailed(&chain(&["op-add"]), None), None);
    assert_eq!(session.state()["count"], 3.0);
    assert!(host.asked.lock().unwrap().is_empty());

    // What the kernel cannot run goes to the host, with the session's
    // resolved inputs, and the chain goes on with the answer.
    session.set_element("name", json!("Oslo")).expect("writes");
    assert_eq!(session.run_chain_detailed(&chain(&["op-lookup", "op-add"]), None), None);
    assert_eq!(session.state()["temp"], 7);
    assert_eq!(session.state()["count"], 5.0);
    let asked = host.asked.lock().unwrap().clone();
    assert_eq!(asked.len(), 1);
    assert_eq!(asked[0].0, "weather.current");
    assert_eq!(asked[0].1["city"], "Oslo");

    drop(session);
    wait_until("the session process is gone with its session", || !alive(process_id));
}

#[test]
fn a_refusal_from_the_host_stops_the_chain_with_its_message() {
    let host = Arc::new(Recorder {
        refuse: true,
        ..Recorder::default()
    });
    let mut session = open(host, Map::new());
    let failed = session.run_chain_detailed(&chain(&["op-lookup", "op-add"]), None);
    assert_eq!(
        failed,
        Some(("op-lookup".to_string(), "The weather service is down".to_string()))
    );
    assert_eq!(session.state()["count"], 1, "nothing after the failure ran");
}

#[test]
fn two_apps_get_two_processes_and_keep_their_own_state() {
    let mut first = open(Arc::new(Recorder::default()), Map::new());
    let mut saved = Map::new();
    saved.insert("count".to_string(), json!(40));
    let second = open(Arc::new(Recorder::default()), saved);
    assert_ne!(first.process_id(), second.process_id());

    assert_eq!(first.run_chain(&chain(&["op-add"]), None), None);
    assert_eq!(first.state()["count"], 3.0);
    assert_eq!(second.state()["count"], 40, "saved state came back, and the other app's chain did not touch it");
}

#[test]
fn a_session_whose_process_died_comes_back_with_the_state_it_last_reported() {
    let mut session = open(Arc::new(Recorder::default()), Map::new());
    assert_eq!(session.run_chain(&chain(&["op-add"]), None), None);
    session.set_element("name", json!("Oslo")).expect("writes");
    let first = session.process_id().expect("a process");

    kill(first);
    wait_until("the host sees the process gone", || session.process_id().is_none());

    // The next action finds a fresh process, opens the session in it with
    // the last reported state, and runs.
    assert_eq!(session.run_chain(&chain(&["op-add"]), None), None);
    assert_eq!(session.state()["count"], 5.0);
    assert_eq!(session.state()["element_name"], "Oslo");
    let second = session.process_id().expect("a process again");
    assert_ne!(first, second);
}

#[test]
fn a_chain_in_flight_fails_when_the_session_process_dies() {
    let (entered, has_entered) = channel();
    let (release, released) = channel();
    let host = Arc::new(Recorder {
        entered: Mutex::new(Some(entered)),
        release: Mutex::new(Some(released)),
        ..Recorder::default()
    });
    let mut session = open(host, Map::new());
    let process_id = session.process_id().expect("a process");

    let runner = std::thread::spawn(move || {
        let failed = session.run_chain_detailed(&chain(&["op-lookup", "op-add"]), None);
        (failed, session)
    });
    has_entered
        .recv_timeout(Duration::from_secs(20))
        .expect("the session asked the host");
    kill(process_id);
    // The killed process stays in the process table until the session's
    // client reaps it, so give its pipes a moment to close instead.
    std::thread::sleep(Duration::from_millis(300));
    release.send(()).expect("the host finishes answering");

    let (failed, mut session) = runner.join().expect("no panic");
    let (operation_id, message) = failed.expect("the chain failed");
    assert_eq!(operation_id, "op-lookup");
    assert!(message.contains("stopped before answering"), "{message}");
    assert_eq!(session.state()["count"], 1, "the state is what was last reported");

    // The session is usable again from that state.
    assert_eq!(session.run_chain(&chain(&["op-add"]), None), None);
    assert_eq!(session.state()["count"], 3.0);
}
