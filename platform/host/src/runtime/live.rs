//! A live session as the host holds it. An app's session runs in a process
//! of its own, the session service: the contract, the app's state, and the
//! kernel that interprets them live there, apart from the host and from
//! every other app. The host keeps what the session last reported (its
//! view tree and state), sends it the user's actions, and answers the
//! operations it cannot run by itself through the dispatcher made for that
//! app. A session can also run inside the host process: assembly drafts,
//! which are inert, and tests use that.

use std::sync::Arc;
use std::time::Duration;

use der_session::{HostAnswer, HostCall, Reply, Request, Snapshot};
use serde_json::{Map, Value};

use super::env::SystemEnv;
use super::host::HostDispatcher;
use super::session::{DispatchRequest, OperationDispatcher};
use super::sessions::{open_session_core, resolve_entry_view, SessionEntry};

/// How long opening, a write, or a view may take to answer.
const QUICK_WAIT: Duration = Duration::from_secs(60);
/// How long a chain may run. A chain can wait on the user, as when an
/// operation opens a file dialog, so the limit is only a backstop.
const CHAIN_WAIT: Duration = Duration::from_secs(24 * 60 * 60);

type Client = der_wire::Client<Request, Reply>;

/// Answers the operations a session puts to the host.
pub type HostSide = Arc<dyn OperationDispatcher + Sync>;

/// A session running in the host process.
pub struct LocalSession {
    entry: SessionEntry,
    elements: Vec<Value>,
}

/// A session running in a process of its own.
pub struct ProcessSession {
    client: Client,
    host: HostSide,
    contract: Value,
    fragment_defs: Map<String, Value>,
    /// What the session last reported. A fresh process is opened with this
    /// state when the old one is found gone.
    tree: Vec<Value>,
    state: Map<String, Value>,
}

pub enum LiveSession {
    Local(LocalSession),
    Process(ProcessSession),
}

impl ProcessSession {
    fn keep(&mut self, snapshot: Snapshot) {
        self.tree = snapshot.tree;
        self.state = snapshot.state;
    }

    /// One request to the process, answering the operations it asks of the
    /// host while the request runs.
    fn call(&self, request: Request) -> Result<Reply, String> {
        let wait = match &request {
            Request::RunChain { .. } => CHAIN_WAIT,
            _ => QUICK_WAIT,
        };
        let host = self.host.clone();
        self.client.call_with(request, wait, &mut |_| {}, &mut |body| {
            let answer = match serde_json::from_value::<HostCall>(body) {
                Ok(call) => {
                    let outcome = host.dispatch(&DispatchRequest {
                        operation_id: &call.operation_id,
                        operation_name: &call.operation_name,
                        inputs: &call.inputs,
                        implementation: call.implementation.as_ref(),
                    });
                    match outcome {
                        Ok(outputs) => HostAnswer::Ok(outputs),
                        Err(message) => HostAnswer::Err(message),
                    }
                }
                Err(_) => HostAnswer::Err("The session's call could not be read".to_string()),
            };
            serde_json::to_value(answer).unwrap_or(Value::Null)
        })
    }

    fn open(&mut self, initial_data: Map<String, Value>) -> Result<(), String> {
        let opened = self.call(Request::Open {
            contract: self.contract.clone(),
            initial_data,
            fragment_defs: self.fragment_defs.clone(),
        })?;
        match opened {
            Reply::Snapshot(snapshot) => {
                self.keep(snapshot);
                Ok(())
            }
            Reply::Error(message) => Err(message),
            _ => Err("The session service answered out of turn".to_string()),
        }
    }

    /// One request, with the session opened again first when the process
    /// turns out to be a fresh one. That happens after the old process
    /// died: the new one starts from the state the old one last reported.
    fn ask(&mut self, request: Request) -> Result<Reply, String> {
        match self.call(request.clone())? {
            Reply::NotOpen => {
                self.open(self.state.clone())?;
                self.call(request)
            }
            reply => Ok(reply),
        }
    }
}

impl LiveSession {
    /// A session in the host process over an entry the caller built.
    pub fn local(entry: SessionEntry, elements: Vec<Value>) -> Self {
        LiveSession::Local(LocalSession { entry, elements })
    }

    /// An inert session in the host process: no dispatcher, so nothing in
    /// it can reach beyond the kernel. Assembly drafts are shown this way.
    pub fn inert(contract: &Value, fragment_defs: Map<String, Value>) -> Result<Self, String> {
        let entry = open_session_core(contract, Map::new(), fragment_defs, Box::new(SystemEnv), None)?;
        let elements = contract
            .get("elements")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        Ok(LiveSession::local(entry, elements))
    }

    /// Opens a session in the process `client` runs. `host` answers the
    /// operations the session cannot run by itself.
    pub fn in_process(
        client: Client,
        host: HostSide,
        contract: &Value,
        initial_data: Map<String, Value>,
        fragment_defs: Map<String, Value>,
    ) -> Result<Self, String> {
        let mut session = ProcessSession {
            client,
            host,
            contract: contract.clone(),
            fragment_defs,
            tree: Vec::new(),
            state: Map::new(),
        };
        session.open(initial_data)?;
        Ok(LiveSession::Process(session))
    }

    /// Opens an app's session in a process of its own, with the host
    /// dispatcher made for that app: the experience id is fixed here, so
    /// the session cannot ask for another app's store.
    pub fn for_app(
        app: &tauri::AppHandle,
        experience_id: &str,
        contract: &Value,
        initial_data: Map<String, Value>,
    ) -> Result<Self, String> {
        let (fragment_defs, parts) = super::sessions::installed_vocabulary(app);
        let dispatcher = HostDispatcher {
            app: app.clone(),
            parts,
            experience_id: experience_id.to_string(),
        };
        let client = crate::services::client("session", crate::services::SESSION, None)?;
        LiveSession::in_process(client, Arc::new(dispatcher), contract, initial_data, fragment_defs)
    }

    /// The id of the session's own process, when it runs in one.
    pub fn process_id(&self) -> Option<u32> {
        match self {
            LiveSession::Local(_) => None,
            LiveSession::Process(session) => session.client.process_id(),
        }
    }

    /// The resolved view tree.
    pub fn tree(&self) -> Vec<Value> {
        match self {
            LiveSession::Local(session) => resolve_entry_view(&session.entry, &session.elements),
            LiveSession::Process(session) => session.tree.clone(),
        }
    }

    pub fn state(&self) -> &Map<String, Value> {
        match self {
            LiveSession::Local(session) => session.entry.session().state(),
            LiveSession::Process(session) => &session.state,
        }
    }

    /// Writes one element's value, as a control does when the user edits it.
    pub fn set_element(&mut self, element_id: &str, value: Value) -> Result<(), String> {
        match self {
            LiveSession::Local(session) => {
                session.entry.session_mut().set_element(element_id, value);
                Ok(())
            }
            LiveSession::Process(session) => {
                let reply = session.ask(Request::SetElement {
                    element_id: element_id.to_string(),
                    value,
                })?;
                match reply {
                    Reply::Snapshot(snapshot) => {
                        session.keep(snapshot);
                        Ok(())
                    }
                    Reply::Error(message) => Err(message),
                    _ => Err("The session service answered out of turn".to_string()),
                }
            }
        }
    }

    /// Runs a chain in order. Answers the id of the operation that stopped
    /// it and why, or nothing when every operation ran. A session process
    /// that fails counts as the chain's first operation failing.
    pub fn run_chain_detailed(
        &mut self,
        operation_ids: &[String],
        item: Option<&Value>,
    ) -> Option<(String, String)> {
        match self {
            LiveSession::Local(session) => session
                .entry
                .session_mut()
                .run_chain_detailed(operation_ids, item),
            LiveSession::Process(session) => {
                let first = operation_ids.first().cloned().unwrap_or_default();
                let reply = session.ask(Request::RunChain {
                    operation_ids: operation_ids.to_vec(),
                    item: item.cloned(),
                });
                match reply {
                    Ok(Reply::Ran {
                        failed,
                        error,
                        snapshot,
                    }) => {
                        session.keep(snapshot);
                        failed.map(|operation_id| (operation_id, error.unwrap_or_default()))
                    }
                    Ok(Reply::Error(message)) | Err(message) => Some((first, message)),
                    Ok(_) => Some((first, "The session service answered out of turn".to_string())),
                }
            }
        }
    }

    /// Runs a chain and answers the id of the operation that stopped it.
    pub fn run_chain(&mut self, operation_ids: &[String], item: Option<&Value>) -> Option<String> {
        self.run_chain_detailed(operation_ids, item)
            .map(|(operation_id, _)| operation_id)
    }
}
