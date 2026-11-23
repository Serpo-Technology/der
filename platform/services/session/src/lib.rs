//! DER's session service: one process holds one app's running session. The
//! contract, the app's state, and the runtime kernel that interprets them
//! live here, apart from the host and from every other app. The process
//! owns nothing on disk and holds no secret and no grant. Whatever an
//! operation needs beyond pure computation (a part, a request, a file, the
//! app's store, mail) it asks of the host, which decides and answers.
//!
//! Every reply that follows a change carries the fresh view tree and state,
//! so the host shows and saves them without asking again.

use std::io::{BufRead, Write};
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};

use der_runtime::entry::{open_session_core, resolve_entry_view, SessionEntry};
use der_runtime::env::SystemEnv;
use der_runtime::session::{DispatchRequest, OperationDispatcher};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Everything the session does for the host.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Request {
    /// Open the session over a contract, replacing one already open.
    /// `initial_data` is the app's saved state and `fragment_defs` are the
    /// installed UI fragments the contract may use.
    Open {
        contract: Value,
        #[serde(default)]
        initial_data: Map<String, Value>,
        #[serde(default)]
        fragment_defs: Map<String, Value>,
    },
    /// Write one element's value, as a control does when the user edits it.
    SetElement { element_id: String, value: Value },
    /// Run a chain of operations in order, stopping at the first failure.
    RunChain {
        operation_ids: Vec<String>,
        #[serde(default)]
        item: Option<Value>,
    },
    /// The current view tree and state.
    View,
}

/// The view tree and state after a request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Snapshot {
    pub tree: Vec<Value>,
    pub state: Map<String, Value>,
}

/// The answer to a `Request`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "reply", content = "data", rename_all = "camelCase")]
pub enum Reply {
    /// The session as it stands after an open, a write, or a view.
    Snapshot(Snapshot),
    /// A chain ran. `failed` names the operation that stopped it and
    /// `error` says why; both are absent when every operation ran.
    Ran {
        failed: Option<String>,
        error: Option<String>,
        snapshot: Snapshot,
    },
    /// No session is open in this process. A process that was started
    /// again says this until the host opens the session anew.
    NotOpen,
    Error(String),
}

/// One operation the session cannot run by itself, put to the host.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostCall {
    pub operation_id: String,
    pub operation_name: String,
    /// The resolved flat inputs.
    pub inputs: Map<String, Value>,
    #[serde(default)]
    pub implementation: Option<Map<String, Value>>,
}

/// The host's answer to a `HostCall`: the operation's outputs, or why it
/// failed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostAnswer {
    Ok(Map<String, Value>),
    Err(String),
}

/// How a session reaches the host for the request it is handling.
pub type HostLink = Arc<dyn Fn(HostCall) -> HostAnswer + Send + Sync>;

/// What a line that is not a request is answered with.
const UNREADABLE: &str = "The request could not be read";

/// The dispatcher inside the session: every operation the kernel cannot
/// run goes to the host through whichever link the current request has.
struct AskHost {
    link: Arc<Mutex<Option<HostLink>>>,
}

impl OperationDispatcher for AskHost {
    fn dispatch(&self, request: &DispatchRequest) -> Result<Map<String, Value>, String> {
        let link = self
            .link
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
            .ok_or_else(|| "This session has no host to ask".to_string())?;
        let answer = link(HostCall {
            operation_id: request.operation_id.to_string(),
            operation_name: request.operation_name.to_string(),
            inputs: request.inputs.clone(),
            implementation: request.implementation.cloned(),
        });
        match answer {
            HostAnswer::Ok(outputs) => Ok(outputs),
            HostAnswer::Err(message) => Err(message),
        }
    }
}

struct Open {
    entry: SessionEntry,
    elements: Vec<Value>,
}

/// One session and the link its operations use to reach the host.
#[derive(Default)]
pub struct Service {
    open: Mutex<Option<Open>>,
    link: Arc<Mutex<Option<HostLink>>>,
}

fn snapshot(open: &Open) -> Snapshot {
    Snapshot {
        tree: resolve_entry_view(&open.entry, &open.elements),
        state: open.entry.session().state().clone(),
    }
}

impl Service {
    pub fn new() -> Self {
        Service::default()
    }

    /// Answers one request. `host` is how operations of a chain reach the
    /// host while this request runs. Requests must come one at a time.
    pub fn handle(&self, request: Request, host: Option<HostLink>) -> Reply {
        let mut open = self.open.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        match request {
            Request::Open {
                contract,
                initial_data,
                fragment_defs,
            } => {
                let dispatcher = AskHost {
                    link: self.link.clone(),
                };
                let entry = match open_session_core(
                    &contract,
                    initial_data,
                    fragment_defs,
                    Box::new(SystemEnv),
                    Some(Box::new(dispatcher)),
                ) {
                    Ok(entry) => entry,
                    Err(message) => return Reply::Error(message),
                };
                let elements = contract
                    .get("elements")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let opened = Open { entry, elements };
                let reply = Reply::Snapshot(snapshot(&opened));
                *open = Some(opened);
                reply
            }
            Request::SetElement { element_id, value } => match open.as_mut() {
                Some(session) => {
                    session.entry.session_mut().set_element(&element_id, value);
                    Reply::Snapshot(snapshot(session))
                }
                None => Reply::NotOpen,
            },
            Request::RunChain { operation_ids, item } => match open.as_mut() {
                Some(session) => {
                    self.set_link(host);
                    let outcome = session
                        .entry
                        .session_mut()
                        .run_chain_detailed(&operation_ids, item.as_ref());
                    self.set_link(None);
                    let (failed, error) = match outcome {
                        Some((operation_id, message)) => (Some(operation_id), Some(message)),
                        None => (None, None),
                    };
                    Reply::Ran {
                        failed,
                        error,
                        snapshot: snapshot(session),
                    }
                }
                None => Reply::NotOpen,
            },
            Request::View => match open.as_ref() {
                Some(session) => Reply::Snapshot(snapshot(session)),
                None => Reply::NotOpen,
            },
        }
    }

    fn set_link(&self, link: Option<HostLink>) {
        *self.link.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = link;
    }
}

/// Serves one session until the input closes. Requests run one at a time
/// in the order they arrive, on a thread of their own, so the reading loop
/// stays free to pass the host's answers to a chain that is waiting on one.
pub fn serve<R, W>(input: R, output: W) -> std::io::Result<()>
where
    R: BufRead,
    W: Write + Send + 'static,
{
    let service = Service::new();
    let (queue, requests) = channel::<(Request, der_wire::Responder<Reply>)>();
    let worker = std::thread::spawn(move || {
        for (request, responder) in requests {
            let caller = responder.caller();
            let host: HostLink = Arc::new(move |call: HostCall| {
                let body = match serde_json::to_value(&call) {
                    Ok(body) => body,
                    Err(error) => return HostAnswer::Err(format!("The call could not be written: {}", error)),
                };
                match caller.call(body) {
                    Ok(answer) => serde_json::from_value(answer)
                        .unwrap_or_else(|_| HostAnswer::Err("The host's answer could not be read".to_string())),
                    Err(message) => HostAnswer::Err(message),
                }
            });
            responder.answer(service.handle(request, Some(host)));
        }
    });
    let outcome = der_wire::serve(
        input,
        output,
        || Reply::Error(UNREADABLE.to_string()),
        |request: Request, responder: der_wire::Responder<Reply>| {
            let _ = queue.send((request, responder));
        },
    );
    drop(queue);
    let _ = worker.join();
    outcome
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead, BufReader, Write};

    use serde_json::json;

    use super::*;

    /// A counter with one builtin operation and one the host has to run.
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
                },
                {
                    "id": "op-after",
                    "operationName": "counter.add",
                    "inputs": [
                        { "name": "key", "source": "constant", "value": "count" },
                        { "name": "amount", "source": "constant", "value": 10 }
                    ]
                }
            ]
        })
    }

    fn open(service: &Service) -> Snapshot {
        let reply = service.handle(
            Request::Open {
                contract: contract(),
                initial_data: Map::new(),
                fragment_defs: Map::new(),
            },
            None,
        );
        let Reply::Snapshot(snapshot) = reply else {
            panic!("a snapshot: {reply:?}");
        };
        snapshot
    }

    fn run(service: &Service, operation_ids: &[&str], host: Option<HostLink>) -> Reply {
        service.handle(
            Request::RunChain {
                operation_ids: operation_ids.iter().map(|id| id.to_string()).collect(),
                item: None,
            },
            host,
        )
    }

    #[test]
    fn a_session_that_is_not_open_says_so() {
        let service = Service::new();
        assert_eq!(service.handle(Request::View, None), Reply::NotOpen);
        assert_eq!(run(&service, &["op-add"], None), Reply::NotOpen);
        let set = service.handle(
            Request::SetElement {
                element_id: "name".to_string(),
                value: json!("Oslo"),
            },
            None,
        );
        assert_eq!(set, Reply::NotOpen);
    }

    #[test]
    fn builtin_operations_run_inside_the_session_without_the_host() {
        let service = Service::new();
        let opened = open(&service);
        assert_eq!(opened.state["count"], 1);
        assert_eq!(opened.tree.len(), 2);

        let asked = Arc::new(Mutex::new(0));
        let counting: HostLink = {
            let asked = asked.clone();
            Arc::new(move |_call| {
                *asked.lock().unwrap() += 1;
                HostAnswer::Err("not expected".to_string())
            })
        };
        let Reply::Ran { failed, error, snapshot } = run(&service, &["op-add"], Some(counting)) else {
            panic!("the chain ran");
        };
        assert_eq!((failed, error), (None, None));
        assert_eq!(snapshot.state["count"], 3.0);
        assert_eq!(*asked.lock().unwrap(), 0, "a builtin never reaches the host");
        assert_eq!(service.handle(Request::View, None), Reply::Snapshot(snapshot));
    }

    #[test]
    fn an_operation_the_kernel_cannot_run_is_put_to_the_host() {
        let service = Service::new();
        open(&service);
        service.handle(
            Request::SetElement {
                element_id: "name".to_string(),
                value: json!("Oslo"),
            },
            None,
        );
        let calls: Arc<Mutex<Vec<HostCall>>> = Arc::new(Mutex::new(Vec::new()));
        let host: HostLink = {
            let calls = calls.clone();
            Arc::new(move |call| {
                calls.lock().unwrap().push(call);
                HostAnswer::Ok(json!({ "temp": 7 }).as_object().cloned().unwrap())
            })
        };
        let Reply::Ran { failed, snapshot, .. } = run(&service, &["op-lookup", "op-after"], Some(host)) else {
            panic!("the chain ran");
        };
        assert_eq!(failed, None);
        assert_eq!(snapshot.state["temp"], 7);
        assert_eq!(snapshot.state["count"], 11.0, "the chain went on after the host answered");
        let calls = calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].operation_id, "op-lookup");
        assert_eq!(calls[0].operation_name, "weather.current");
        assert_eq!(calls[0].inputs["city"], "Oslo");
    }

    #[test]
    fn a_refusal_from_the_host_stops_the_chain_with_its_message() {
        let service = Service::new();
        open(&service);
        let host: HostLink = Arc::new(|_call| HostAnswer::Err("The weather service is down".to_string()));
        let Reply::Ran { failed, error, snapshot } = run(&service, &["op-lookup", "op-after"], Some(host)) else {
            panic!("the chain ran");
        };
        assert_eq!(failed.as_deref(), Some("op-lookup"));
        assert_eq!(error.as_deref(), Some("The weather service is down"));
        assert_eq!(snapshot.state["count"], 1, "nothing after the failure ran");

        let Reply::Ran { failed, error, .. } = run(&service, &["op-lookup"], None) else {
            panic!("the chain ran");
        };
        assert_eq!(failed.as_deref(), Some("op-lookup"));
        assert!(error.is_some_and(|message| message.contains("no host to ask")));
    }

    #[test]
    fn saved_data_comes_back_over_the_contract_seeds() {
        let service = Service::new();
        let mut saved = Map::new();
        saved.insert("count".to_string(), json!(40));
        let reply = service.handle(
            Request::Open {
                contract: contract(),
                initial_data: saved,
                fragment_defs: Map::new(),
            },
            None,
        );
        assert!(matches!(reply, Reply::Snapshot(ref snapshot) if snapshot.state["count"] == 40));
    }

    #[test]
    fn the_session_asks_the_host_over_its_pipes_and_takes_the_answer() {
        let (request_reader, mut requests) = std::io::pipe().expect("pipe");
        let (replies, reply_writer) = std::io::pipe().expect("pipe");
        let thread = std::thread::spawn(move || serve(BufReader::new(request_reader), reply_writer));
        let mut replies = BufReader::new(replies);
        let mut next = || -> Value {
            let mut line = String::new();
            replies.read_line(&mut line).expect("reads");
            serde_json::from_str(&line).unwrap_or_else(|error| panic!("{error}: {line:?}"))
        };
        let mut send = |line: Value| writeln!(requests, "{line}").expect("writes");

        send(json!({ "id": 1, "request": { "op": "view" } }));
        assert_eq!(next(), json!({ "id": 1, "reply": { "reply": "notOpen" } }));
        send(json!({ "id": 2, "request": { "op": "open", "contract": contract() } }));
        let opened = next();
        assert_eq!(opened["reply"]["data"]["state"]["count"], 1);

        send(json!({ "id": 3, "request": { "op": "runChain", "operationIds": ["op-lookup", "op-after"] } }));
        let call = next();
        assert_eq!(call["id"], 3);
        assert_eq!(call["body"]["operationName"], "weather.current");
        send(json!({ "id": 3, "answer": call["call"], "body": { "ok": { "temp": 7 } } }));
        let ran = next();
        assert_eq!(ran["id"], 3);
        assert_eq!(ran["reply"]["reply"], "ran");
        assert_eq!(ran["reply"]["data"]["snapshot"]["state"]["temp"], 7);
        assert_eq!(ran["reply"]["data"]["snapshot"]["state"]["count"], 11.0);
        assert!(ran["reply"]["data"]["failed"].is_null());

        drop(send);
        drop(requests);
        thread.join().expect("no panic").expect("ends cleanly when the input closes");
    }
}
