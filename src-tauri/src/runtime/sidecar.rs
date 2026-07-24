//! The native renderer bridge: experience sessions rendered by an external
//! panel process instead of a webview. The bridge owns the sessions and
//! speaks newline-delimited JSON over the panel's stdio: it sends window
//! opens, tree updates, and closes; the panel sends element writes, event
//! dispatches, and window lifecycle. The panel is a pure view: every
//! semantic decision stays in the runtime core, and secrets never leave the
//! host process.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};
use tauri::Manager;

use super::env::SystemEnv;
use super::host::HostDispatcher;
use super::sessions::{open_session_core, resolve_entry_view, SessionEntry};

/// Outbound messages travel through this seam so tests drive the bridge
/// with a recording transport instead of a process.
pub trait SidecarTransport: Send {
    fn send(&mut self, message: &Value) -> Result<(), String>;
}

pub struct WindowSession {
    entry: SessionEntry,
    elements: Vec<Value>,
}

pub struct SidecarBridge {
    windows: HashMap<String, WindowSession>,
    transport: Box<dyn SidecarTransport>,
}

impl SidecarBridge {
    pub fn new(transport: Box<dyn SidecarTransport>) -> Self {
        Self {
            windows: HashMap::new(),
            transport,
        }
    }

    pub fn open_window(
        &mut self,
        window_id: &str,
        title: &str,
        theme: Option<&str>,
        entry: SessionEntry,
        elements: Vec<Value>,
    ) -> Result<(), String> {
        let tree = resolve_entry_view(&entry, &elements);
        self.transport.send(&json!({
            "cmd": "open",
            "windowId": window_id,
            "title": title,
            "theme": theme,
            "tree": tree,
        }))?;
        self.windows
            .insert(window_id.to_string(), WindowSession { entry, elements });
        Ok(())
    }

    pub fn close_window(&mut self, window_id: &str) -> Result<(), String> {
        if self.windows.remove(window_id).is_some() {
            self.transport
                .send(&json!({ "cmd": "close", "windowId": window_id }))?;
        }
        Ok(())
    }

    pub fn window_count(&self) -> usize {
        self.windows.len()
    }

    /// One inbound panel message: element writes and dispatches mutate the
    /// window's session and answer with a fresh tree; a closed window drops
    /// its session.
    pub fn handle_event(&mut self, message: &Value) -> Result<(), String> {
        let event = message.get("event").and_then(Value::as_str).unwrap_or("");
        let window_id = message
            .get("windowId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        match event {
            "setElement" => {
                let element_id = message
                    .get("elementId")
                    .and_then(Value::as_str)
                    .ok_or("setElement without an elementId")?;
                let value = message.get("value").cloned().unwrap_or(Value::Null);
                let window = self
                    .windows
                    .get_mut(&window_id)
                    .ok_or_else(|| format!("No native window {}", window_id))?;
                window.entry.session_mut().set_element(element_id, value);
                self.send_update(&window_id)
            }
            "dispatch" => {
                let operation_ids: Vec<String> = message
                    .get("operationIds")
                    .and_then(Value::as_array)
                    .map(|ids| {
                        ids.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default();
                let item = message.get("item").filter(|value| !value.is_null()).cloned();
                let window = self
                    .windows
                    .get_mut(&window_id)
                    .ok_or_else(|| format!("No native window {}", window_id))?;
                let failed = window
                    .entry
                    .session_mut()
                    .run_chain(&operation_ids, item.as_ref());
                if let Some(operation_id) = failed {
                    self.transport.send(&json!({
                        "cmd": "operationFailed",
                        "windowId": window_id,
                        "operationId": operation_id,
                    }))?;
                }
                self.send_update(&window_id)
            }
            "windowClosed" => {
                self.windows.remove(&window_id);
                Ok(())
            }
            "log" => Ok(()),
            other => Err(format!("Unknown panel event \"{}\"", other)),
        }
    }

    fn send_update(&mut self, window_id: &str) -> Result<(), String> {
        let window = self
            .windows
            .get(window_id)
            .ok_or_else(|| format!("No native window {}", window_id))?;
        let tree = resolve_entry_view(&window.entry, &window.elements);
        self.transport.send(&json!({
            "cmd": "update",
            "windowId": window_id,
            "tree": tree,
        }))
    }
}

// ---------------------------------------------------------------------------
// Process transport and the Tauri surface
// ---------------------------------------------------------------------------

struct ProcessTransport {
    stdin: std::process::ChildStdin,
}

impl SidecarTransport for ProcessTransport {
    fn send(&mut self, message: &Value) -> Result<(), String> {
        let line = serde_json::to_string(message).map_err(|error| error.to_string())?;
        writeln!(self.stdin, "{}", line).map_err(|error| format!("Panel write failed: {}", error))
    }
}

struct RunningSidecar {
    bridge: Arc<Mutex<SidecarBridge>>,
    child: Child,
}

#[derive(Default)]
pub struct NativeRendererState(Mutex<Option<RunningSidecar>>);

/// The panel binary: DER_NATIVE_RENDERER wins; otherwise the dev build
/// locations relative to the repository layout.
fn panel_binary() -> Result<std::path::PathBuf, String> {
    if let Ok(path) = std::env::var("DER_NATIVE_RENDERER") {
        let path = std::path::PathBuf::from(path);
        if path.exists() {
            return Ok(path);
        }
        return Err(format!("DER_NATIVE_RENDERER points at nothing: {}", path.display()));
    }
    for candidate in [
        "../native/macos/.build/release/DerNativePanel",
        "../native/macos/.build/debug/DerNativePanel",
        "native/macos/.build/release/DerNativePanel",
        "native/macos/.build/debug/DerNativePanel",
    ] {
        let path = std::path::PathBuf::from(candidate);
        if path.exists() {
            return Ok(path);
        }
    }
    Err("The native panel is not built; run \"swift build\" in native/macos first".to_string())
}

fn ensure_running(state: &NativeRendererState) -> Result<Arc<Mutex<SidecarBridge>>, String> {
    let mut guard = state.0.lock().unwrap();
    if let Some(running) = guard.as_mut() {
        if running.child.try_wait().map_err(|error| error.to_string())?.is_none() {
            return Ok(running.bridge.clone());
        }
        // The panel exited; drop its sessions and start fresh.
        *guard = None;
    }

    let binary = panel_binary()?;
    let mut child = Command::new(&binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| format!("Could not start the native panel: {}", error))?;
    let stdin = child.stdin.take().ok_or("Panel has no stdin")?;
    let stdout = child.stdout.take().ok_or("Panel has no stdout")?;

    let bridge = Arc::new(Mutex::new(SidecarBridge::new(Box::new(ProcessTransport {
        stdin,
    }))));
    let reader_bridge = bridge.clone();
    std::thread::Builder::new()
        .name("der-native-panel-reader".into())
        .spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                match serde_json::from_str::<Value>(&line) {
                    Ok(message) => {
                        if let Err(error) = reader_bridge.lock().unwrap().handle_event(&message) {
                            eprintln!("native panel event failed: {}", error);
                        }
                    }
                    Err(error) => eprintln!("native panel sent invalid JSON: {}", error),
                }
            }
        })
        .map_err(|error| error.to_string())?;

    *guard = Some(RunningSidecar {
        bridge: bridge.clone(),
        child,
    });
    Ok(bridge)
}

#[tauri::command]
pub async fn open_native_experience_window(
    app: tauri::AppHandle,
    state: tauri::State<'_, NativeRendererState>,
    contract: Value,
    title: String,
    initial_data: Option<Map<String, Value>>,
) -> Result<String, String> {
    let bridge = ensure_running(&state)?;
    let (fragment_defs, parts) = super::sessions::installed_vocabulary(&app);
    let dispatcher = HostDispatcher {
        app: app.clone(),
        parts,
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
    let theme = contract
        .get("styling")
        .and_then(|styling| styling.get("theme"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let window_id = format!("nw-{}", uuid::Uuid::new_v4());
    tauri::async_runtime::spawn_blocking(move || {
        bridge.lock().unwrap().open_window(
            &window_id,
            &title,
            theme.as_deref(),
            entry,
            elements,
        )?;
        Ok(window_id)
    })
    .await
    .map_err(|error| format!("Native open failed: {}", error))?
}
