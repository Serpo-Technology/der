//! The part runner as a process. It loads installed bundles, runs their
//! operations in the hardened wasmtime host, and keeps running jobs alive
//! between steps. It decides nothing about what is installed: a caller asks
//! it to check a module before install and to run what is on disk.
//!
//! Files cross in both directions as paths the caller chose. `granted`
//! maps the grant tokens among a call's inputs to the files they stand
//! for, and the runner stages exactly those into the guest's /in. Files
//! the guest produced are moved into the `handoff` folder the caller made
//! for the call, and the reply names them, so the caller can take them
//! into its own storage and mint the grants.

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{ExecEnv, FragmentError, FragmentErrorKind, FragmentResult, FragmentsState};

/// Everything the runner does for a caller.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Request {
    /// Run one operation of an installed part: a plain call, a job start,
    /// or a job step, as the part's manifest declares it.
    Run {
        fragment_id: String,
        operation: String,
        inputs: Value,
        /// The files behind the grant tokens among the inputs.
        #[serde(default)]
        granted: HashMap<String, PathBuf>,
        /// An empty folder of the caller's for files the call produces.
        handoff: PathBuf,
    },
    /// Compile a module and check its imports against the capabilities a
    /// bundle declares, before that bundle is installed.
    Check {
        wasm_b64: String,
        capabilities: Vec<String>,
    },
    /// Drop the compiled module and the running jobs of a part that was
    /// removed or replaced.
    Forget { fragment_id: String },
}

/// A file a call produced, waiting in the handoff folder.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Produced {
    /// The output whose value is this file.
    pub output: String,
    pub path: PathBuf,
    /// The declared sibling outputs (url, name, size) the part left for
    /// the caller to fill from the file it takes in.
    pub fill: Vec<String>,
}

/// The answer to a `Request`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "reply", content = "data", rename_all = "camelCase")]
pub enum Reply {
    /// The outputs of a run. Each produced file's output holds a
    /// placeholder until the caller has taken the file in.
    Outputs { outputs: Value, produced: Vec<Produced> },
    Done,
    /// The part or its bundle failed in a way the caller can show.
    Failed(FragmentError),
    Error(String),
}

/// What a line that is not a request is answered with.
const UNREADABLE: &str = "The request could not be read";

/// The sibling outputs a caller fills from a produced file.
const FILE_SIBLINGS: [&str; 3] = ["url", "name", "size"];

/// The runner over one folder of installed bundles.
pub struct Service {
    fragments_dir: PathBuf,
    state: FragmentsState,
}

impl Service {
    pub fn new(fragments_dir: impl Into<PathBuf>) -> Self {
        Service {
            fragments_dir: fragments_dir.into(),
            state: FragmentsState::new(),
        }
    }

    /// Answers any request. A run blocks for as long as the guest does,
    /// within its budgets.
    pub fn handle(&self, request: Request) -> Reply {
        let outcome = match request {
            Request::Run {
                fragment_id,
                operation,
                inputs,
                granted,
                handoff,
            } => self.run(&fragment_id, &operation, &inputs, &granted, &handoff),
            Request::Check {
                wasm_b64,
                capabilities,
            } => BASE64
                .decode(wasm_b64)
                .map_err(|_| FragmentError::new(FragmentErrorKind::VerifyFailed, "The module is not readable"))
                .and_then(|wasm| self.state.compile(&wasm, &capabilities))
                .map(|_| Reply::Done),
            Request::Forget { fragment_id } => {
                self.state.forget(&fragment_id);
                Ok(Reply::Done)
            }
        };
        outcome.unwrap_or_else(Reply::Failed)
    }

    fn run(
        &self,
        fragment_id: &str,
        operation: &str,
        inputs: &Value,
        granted: &HashMap<String, PathBuf>,
        handoff: &Path,
    ) -> FragmentResult<Reply> {
        let loaded = self.state.load(&self.fragments_dir, fragment_id)?;
        let resolve = |token: &str| granted.get(token).cloned();
        // Each produced file moves into its own numbered folder, so two
        // outputs keep their names even when the names are equal. The
        // placeholder stands in the outputs until the caller has the file.
        let moved: Mutex<Vec<(String, PathBuf)>> = Mutex::new(Vec::new());
        let register = |produced: &Path| -> Result<Value, String> {
            let mut moved = moved.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let name = produced
                .file_name()
                .ok_or_else(|| "The produced file has no name".to_string())?;
            let folder = handoff.join(moved.len().to_string());
            std::fs::create_dir_all(&folder)
                .map_err(|error| format!("The handoff folder could not be used: {}", error))?;
            let kept = folder.join(name);
            if std::fs::rename(produced, &kept).is_err() {
                std::fs::copy(produced, &kept)
                    .map_err(|error| format!("The produced file could not be handed off: {}", error))?;
            }
            let placeholder = format!("derproduced-{}", uuid::Uuid::new_v4());
            moved.push((placeholder.clone(), kept));
            Ok(serde_json::json!({ "file": placeholder }))
        };
        let outputs = self.state.execute_operation_with(
            &loaded,
            operation,
            inputs,
            &ExecEnv {
                resolve_grant: &resolve,
                register_output: &register,
            },
        )?;

        let declared: Vec<&str> = loaded
            .manifest
            .operations
            .iter()
            .find(|op| op.name == operation)
            .map(|op| op.outputs.iter().map(|output| output.name.as_str()).collect())
            .unwrap_or_default();
        let moved = moved.into_inner().unwrap_or_else(|poisoned| poisoned.into_inner());
        let object = outputs.as_object();
        let produced = moved
            .into_iter()
            .filter_map(|(placeholder, path)| {
                let object = object?;
                let output = object
                    .iter()
                    .find(|(_, value)| value.as_str() == Some(placeholder.as_str()))?
                    .0
                    .clone();
                let fill = FILE_SIBLINGS
                    .iter()
                    .filter(|sibling| declared.contains(*sibling) && !object.contains_key(**sibling))
                    .map(|sibling| sibling.to_string())
                    .collect();
                Some(Produced { output, path, fill })
            })
            .collect();
        Ok(Reply::Outputs { outputs, produced })
    }
}

/// Serves requests over the folder of installed bundles until the input
/// closes. Runs and checks each get their own thread, so a long call never
/// holds up another, and jobs stay alive in this process between steps.
pub fn serve<R, W>(fragments_dir: impl Into<PathBuf>, input: R, output: W) -> std::io::Result<()>
where
    R: BufRead,
    W: Write + Send + 'static,
{
    let service = Arc::new(Service::new(fragments_dir));
    der_wire::serve(
        input,
        output,
        || Reply::Error(UNREADABLE.to_string()),
        |request: Request, responder: der_wire::Responder<Reply>| match request {
            request @ Request::Forget { .. } => responder.answer(service.handle(request)),
            request => {
                let service = service.clone();
                std::thread::spawn(move || responder.answer(service.handle(request)));
            }
        },
    )
}
