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
    experience_id: String,
    /// The contract the window currently renders; edits start from it.
    contract: Value,
    /// Streaming assembly: the window shows a growing display-only draft;
    /// interactions are inert and state never persists.
    assembling: bool,
}

/// Fired after every session mutation with the experience id and its state,
/// so native windows persist per-app data exactly like webview windows.
pub type StateChanged = Arc<dyn Fn(&str, &Map<String, Value>) + Send + Sync>;

/// Host presentation step over outgoing trees (granted asset URLs become
/// file URLs the native views can open).
pub type TreeRewriter = Arc<dyn Fn(&mut Vec<Value>) + Send + Sync>;

/// One panel window's session behind its own lock: window events run under
/// it, so a slow chain in one window never stalls another window's events.
pub type WindowCell = Arc<Mutex<WindowSession>>;

/// The clonable handles a window event needs outside the bridge lock.
#[derive(Clone)]
pub struct WindowShared {
    pub transport: Arc<Mutex<Box<dyn SidecarTransport>>>,
    on_change: Option<StateChanged>,
    tree_rewriter: Option<TreeRewriter>,
}

impl WindowShared {
    fn rewritten(&self, mut tree: Vec<Value>) -> Vec<Value> {
        if let Some(rewriter) = &self.tree_rewriter {
            rewriter(&mut tree);
        }
        tree
    }
}

pub struct SidecarBridge {
    windows: HashMap<String, WindowCell>,
    transport: Arc<Mutex<Box<dyn SidecarTransport>>>,
    on_change: Option<StateChanged>,
    tree_rewriter: Option<TreeRewriter>,
    /// Experiences whose assembly window the user closed mid-generation;
    /// further previews stay away, the finished app still opens.
    assembly_dismissed: std::collections::HashSet<String>,
}

impl SidecarBridge {
    pub fn new(transport: Box<dyn SidecarTransport>) -> Self {
        Self {
            windows: HashMap::new(),
            transport: Arc::new(Mutex::new(transport)),
            on_change: None,
            assembly_dismissed: std::collections::HashSet::new(),
            tree_rewriter: None,
        }
    }

    pub fn set_on_change(&mut self, on_change: StateChanged) {
        self.on_change = Some(on_change);
    }

    pub fn set_tree_rewriter(&mut self, rewriter: TreeRewriter) {
        self.tree_rewriter = Some(rewriter);
    }

    /// The handles a per-window worker needs to serve events without the
    /// bridge: the window's own cell plus the shared send-side.
    pub fn window_handles(&self, window_id: &str) -> Option<(WindowCell, WindowShared)> {
        self.windows.get(window_id).map(|cell| {
            (
                cell.clone(),
                WindowShared {
                    transport: self.transport.clone(),
                    on_change: self.on_change.clone(),
                    tree_rewriter: self.tree_rewriter.clone(),
                },
            )
        })
    }

    /// The transport under its own short-lived lock: usable while the
    /// bridge itself is held by a running dispatch (dialog requests).
    pub fn transport_handle(&self) -> Arc<Mutex<Box<dyn SidecarTransport>>> {
        self.transport.clone()
    }

    fn rewritten(&self, mut tree: Vec<Value>) -> Vec<Value> {
        if let Some(rewriter) = &self.tree_rewriter {
            rewriter(&mut tree);
        }
        tree
    }

    #[allow(clippy::too_many_arguments)]
    pub fn open_window(
        &mut self,
        window_id: &str,
        experience_id: &str,
        title: &str,
        entry: SessionEntry,
        elements: Vec<Value>,
        contract: Value,
        assembling: bool,
    ) -> Result<(), String> {
        let tree = self.rewritten(resolve_entry_view(&entry, &elements));
        let (theme, accent, background) = contract_look(&contract);
        self.transport.lock().unwrap().send(&json!({
            "cmd": "open",
            "windowId": window_id,
            "title": title,
            "theme": theme,
            "accent": accent,
            "background": background,
            "tree": tree,
            "assembling": assembling,
        }))?;
        self.windows.insert(
            window_id.to_string(),
            Arc::new(Mutex::new(WindowSession {
                entry,
                elements,
                experience_id: experience_id.to_string(),
                contract,
                assembling,
            })),
        );
        Ok(())
    }

    /// The experience and contract behind a panel window, for edits and
    /// bookmarks initiated from the window itself.
    pub fn window_info(&self, window_id: &str) -> Option<(String, Value)> {
        self.windows.get(window_id).map(|cell| {
            let window = cell.lock().unwrap();
            (window.experience_id.clone(), window.contract.clone())
        })
    }

    /// Sends any prebuilt message to the panel (management snapshots).
    pub fn send_raw(&mut self, message: &Value) -> Result<(), String> {
        self.transport.lock().unwrap().send(message)
    }

    pub fn assembly_dismissed(&self, experience_id: &str) -> bool {
        self.assembly_dismissed.contains(experience_id)
    }

    /// Closes every window still assembling: generation failed, so the
    /// half-built drafts go away with it.
    pub fn close_assembling_windows(&mut self) -> Result<(), String> {
        let assembling: Vec<String> = self
            .windows
            .iter()
            .filter(|(_, cell)| cell.lock().unwrap().assembling)
            .map(|(window_id, _)| window_id.clone())
            .collect();
        for window_id in assembling {
            self.close_window(&window_id)?;
        }
        Ok(())
    }

    pub fn window_for_experience(&self, experience_id: &str) -> Option<String> {
        self.windows
            .iter()
            .find(|(_, cell)| cell.lock().unwrap().experience_id == experience_id)
            .map(|(window_id, _)| window_id.clone())
    }

    pub fn state_of_experience(&self, experience_id: &str) -> Option<Map<String, Value>> {
        self.windows
            .values()
            .find(|cell| cell.lock().unwrap().experience_id == experience_id)
            .map(|cell| cell.lock().unwrap().entry.session().state().clone())
    }

    /// Swaps an open window's session (a contract edit or the next assembly
    /// draft) and shows the fresh tree; the caller rebuilds the entry with
    /// the preserved state.
    pub fn replace_session(
        &mut self,
        experience_id: &str,
        entry: SessionEntry,
        elements: Vec<Value>,
        contract: Value,
        assembling: bool,
    ) -> Result<(), String> {
        let window_id = self
            .window_for_experience(experience_id)
            .ok_or_else(|| format!("No native window for experience {}", experience_id))?;
        if let Some(cell) = self.windows.get(&window_id) {
            let mut window = cell.lock().unwrap();
            window.entry = entry;
            window.elements = elements;
            window.contract = contract;
            window.assembling = assembling;
        }
        self.send_update(&window_id)
    }

    /// DER's own native surface: a prompt, the kept apps, recent creations,
    /// and the ready-made apps installed parts ship. `raise` fronts the home
    /// window; refreshes leave whatever the user is looking at alone.
    #[allow(clippy::too_many_arguments)]
    pub fn send_home(
        &mut self,
        bookmarks: &[Value],
        recipes: &[Value],
        recents: &[Value],
        raise: bool,
        llm_ready: bool,
    ) -> Result<(), String> {
        self.transport.lock().unwrap().send(&json!({
            "cmd": "home",
            "bookmarks": bookmarks,
            "recipes": recipes,
            "recents": recents,
            "raise": raise,
            "llmReady": llm_ready,
        }))
    }

    pub fn send_generation_status(
        &mut self,
        status: &str,
        message: Option<&str>,
    ) -> Result<(), String> {
        self.transport.lock().unwrap().send(&json!({
            "cmd": "generationStatus",
            "status": status,
            "message": message,
        }))
    }

    pub fn close_window(&mut self, window_id: &str) -> Result<(), String> {
        if self.windows.remove(window_id).is_some() {
            self.transport
                .lock()
                .unwrap()
                .send(&json!({ "cmd": "close", "windowId": window_id }))?;
        }
        Ok(())
    }

    pub fn window_count(&self) -> usize {
        self.windows.len()
    }

    /// One inbound panel message: element writes and dispatches mutate the
    /// window's session and answer with a fresh tree; a closed window drops
    /// its session. Home actions (create, openBookmark) are app-level and
    /// return to the caller for relay.
    pub fn handle_event(&mut self, message: &Value) -> Result<Option<Value>, String> {
        let event = message.get("event").and_then(Value::as_str).unwrap_or("");
        let window_id = message
            .get("windowId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        match event {
            "setElement" | "dispatch" => {
                let (cell, shared) = self
                    .window_handles(&window_id)
                    .ok_or_else(|| format!("No native window {}", window_id))?;
                run_window_event(&window_id, &cell, &shared, message).map(|_| None)
            }
            "windowClosed" => {
                if let Some(cell) = self.windows.remove(&window_id) {
                    let window = cell.lock().unwrap();
                    if window.assembling {
                        self.assembly_dismissed.insert(window.experience_id.clone());
                    }
                }
                Ok(None)
            }
            "create" | "openBookmark" | "openRecipe" | "openRecent" | "recentDelete"
            | "editExperience"
            | "bookmarkAdd" | "bookmarkRemove" | "bookmarkBackground" | "openEditor" | "editorValidate" | "editorApply"
            | "editorRegenerate" | "openHome" | "quitApp" => Ok(Some(message.clone())),
            name if super::manage::is_management_event(name) => Ok(Some(message.clone())),
            "log" => Ok(None),
            other => Err(format!("Unknown panel event \"{}\"", other)),
        }
    }

    fn send_update(&mut self, window_id: &str) -> Result<(), String> {
        let (cell, shared) = self
            .window_handles(window_id)
            .ok_or_else(|| format!("No native window {}", window_id))?;
        send_window_update(window_id, &cell, &shared)
    }
}

fn send_window_update(
    window_id: &str,
    cell: &WindowCell,
    shared: &WindowShared,
) -> Result<(), String> {
    let (tree, assembling, look) = {
        let window = cell.lock().unwrap();
        (
            shared.rewritten(resolve_entry_view(&window.entry, &window.elements)),
            window.assembling,
            // Edits can change the look; every update re-states it.
            contract_look(&window.contract),
        )
    };
    let (theme, accent, background) = look;
    shared.transport.lock().unwrap().send(&json!({
        "cmd": "update",
        "windowId": window_id,
        "tree": tree,
        "assembling": assembling,
        "theme": theme,
        "accent": accent,
        "background": background,
    }))
}

/// Hands a window event to that window's worker, spawning it on first use.
/// The worker owns the window's cell and shared handles, so it serves the
/// queue without ever taking the bridge lock; a stale worker (window gone)
/// drains harmlessly against the cell it holds.
fn route_window_event(
    bridge: &Arc<Mutex<SidecarBridge>>,
    workers: &mut HashMap<String, std::sync::mpsc::Sender<Value>>,
    message: Value,
) {
    let window_id = message
        .get("windowId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if window_id.is_empty() {
        eprintln!("native panel window event without a windowId");
        return;
    }
    if let Some(sender) = workers.get(&window_id) {
        if sender.send(message).is_ok() {
            return;
        }
        workers.remove(&window_id);
        return;
    }
    let Some((cell, shared)) = bridge.lock().unwrap().window_handles(&window_id) else {
        eprintln!("native panel event for unknown window {}", window_id);
        return;
    };
    let (tx, rx) = std::sync::mpsc::channel::<Value>();
    let worker_id = window_id.clone();
    let spawned = std::thread::Builder::new()
        .name(format!("der-window-{}", window_id))
        .spawn(move || {
            while let Ok(event) = rx.recv() {
                if let Err(error) = run_window_event(&worker_id, &cell, &shared, &event) {
                    eprintln!("native window event failed: {}", error);
                }
            }
        });
    match spawned {
        Ok(_) => {
            let _ = tx.send(message);
            workers.insert(window_id, tx);
        }
        Err(error) => eprintln!("could not start a window worker: {}", error),
    }
}

fn notify_window_change(cell: &WindowCell, shared: &WindowShared) {
    if let Some(on_change) = &shared.on_change {
        let window = cell.lock().unwrap();
        // Assembly drafts are inert; nothing they hold is worth saving.
        if window.assembling {
            return;
        }
        on_change(&window.experience_id, window.entry.session().state());
    }
}

/// One window event, served under the window's own lock: element writes and
/// dispatch chains mutate the session and answer with a fresh tree. This is
/// what per-window workers run, so one window's slow chain (or open dialog)
/// never stalls another window's events.
pub fn run_window_event(
    window_id: &str,
    cell: &WindowCell,
    shared: &WindowShared,
    message: &Value,
) -> Result<(), String> {
    let event = message.get("event").and_then(Value::as_str).unwrap_or("");
    match event {
        "setElement" => {
            let element_id = message
                .get("elementId")
                .and_then(Value::as_str)
                .ok_or("setElement without an elementId")?;
            let value = message.get("value").cloned().unwrap_or(Value::Null);
            cell.lock()
                .unwrap()
                .entry
                .session_mut()
                .set_element(element_id, value);
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
            let failed = cell
                .lock()
                .unwrap()
                .entry
                .session_mut()
                .run_chain_detailed(&operation_ids, item.as_ref());
            if let Some((operation_id, text)) = failed {
                shared.transport.lock().unwrap().send(&json!({
                    "cmd": "operationFailed",
                    "windowId": window_id,
                    "operationId": operation_id,
                    "message": text,
                }))?;
            }
        }
        other => return Err(format!("Not a window event: \"{}\"", other)),
    }
    notify_window_change(cell, shared);
    send_window_update(window_id, cell, shared)
}

/// Granted asset URLs become file URLs the native views can open; anything
/// not in the grant table stays as it is (the webview's protocol scope and
/// this table enforce the same boundary).
fn rewrite_granted_srcs(app: &tauri::AppHandle, tree: &mut Vec<Value>) {
    fn decode_percent(encoded: &str) -> Option<String> {
        let bytes = encoded.as_bytes();
        let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
        let mut index = 0;
        while index < bytes.len() {
            if bytes[index] == b'%' && index + 2 < bytes.len() {
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok()?;
                out.push(u8::from_str_radix(hex, 16).ok()?);
                index += 3;
            } else {
                out.push(bytes[index]);
                index += 1;
            }
        }
        String::from_utf8(out).ok()
    }
    fn walk(app: &tauri::AppHandle, nodes: &mut Vec<Value>) {
        for node in nodes {
            let src = node
                .get("props")
                .and_then(|props| props.get("src"))
                .and_then(Value::as_str)
                .map(str::to_string);
            if let Some(src) = src {
                if let Some(encoded) = src.strip_prefix("asset://localhost/") {
                    if let Some(path) = decode_percent(encoded) {
                        let granted = app
                            .state::<crate::files::FileGrants>()
                            .is_granted_path(std::path::Path::new(&path));
                        if granted {
                            if let Some(props) =
                                node.get_mut("props").and_then(Value::as_object_mut)
                            {
                                props.insert(
                                    "src".to_string(),
                                    Value::String(format!("file://{}", path)),
                                );
                            }
                        }
                    }
                }
            }
            if let Some(children) = node.get_mut("children").and_then(Value::as_array_mut) {
                walk(app, children);
            }
            if let Some(rows) = node.get_mut("rows").and_then(Value::as_array_mut) {
                for row in rows {
                    if let Some(children) =
                        row.get_mut("children").and_then(Value::as_array_mut)
                    {
                        walk(app, children);
                    }
                }
            }
        }
    }
    walk(app, tree);
}

/// The app-level look a contract declares: theme, accent, and free-form
/// background, as the panel applies them to window chrome and controls.
fn contract_look(contract: &Value) -> (Option<String>, Option<String>, Option<String>) {
    let styling = contract.get("styling");
    let read = |key: &str| {
        styling
            .and_then(|styling| styling.get(key))
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    (read("theme"), read("accent"), read("background"))
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
    /// The bridge's transport, reachable without the bridge lock so dialog
    /// requests go out while a dispatch holds the bridge.
    transport: Arc<Mutex<Box<dyn SidecarTransport>>>,
    child: Child,
}

#[derive(Default)]
pub struct NativeRendererState(Mutex<Option<RunningSidecar>>);

/// Dialog requests waiting on the panel's answer, by request id.
#[derive(Default)]
pub struct PendingDialogs(Mutex<HashMap<String, std::sync::mpsc::Sender<Option<String>>>>);

fn resolve_pending_dialog(app: &tauri::AppHandle, message: &Value, answer: Option<String>) {
    let request_id = message
        .get("requestId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let sender = app
        .state::<PendingDialogs>()
        .0
        .lock()
        .unwrap()
        .remove(&request_id);
    if let Some(sender) = sender {
        let _ = sender.send(answer);
    }
}

fn resolve_file_dialog(app: &tauri::AppHandle, message: &Value) {
    let path = message
        .get("path")
        .and_then(Value::as_str)
        .map(str::to_string);
    resolve_pending_dialog(app, message, path);
}

/// The account sheet's answer travels as the serialized config; a cancel
/// resolves with nothing.
fn resolve_mail_dialog(app: &tauri::AppHandle, message: &Value) {
    let account = message
        .get("account")
        .filter(|value| value.is_object())
        .map(|value| value.to_string());
    resolve_pending_dialog(app, message, account);
}

/// True when the experience currently has an open native window; a busy
/// bridge counts as open so the scheduler never stalls behind a dialog.
pub fn experience_window_open(app: &tauri::AppHandle, experience_id: &str) -> bool {
    let bridge = {
        let state = app.state::<NativeRendererState>();
        let guard = state.0.lock().unwrap();
        match guard.as_ref() {
            Some(running) => running.bridge.clone(),
            None => return false,
        }
    };
    let open = match bridge.try_lock() {
        Ok(bridge) => bridge.window_for_experience(experience_id).is_some(),
        Err(_) => true,
    };
    open
}

/// True when the panel is running and can present dialogs as the active app.
pub fn panel_available(app: &tauri::AppHandle) -> bool {
    if !crate::native_mode() {
        return false;
    }
    app.state::<NativeRendererState>().0.lock().unwrap().is_some()
}

fn panel_dialog(app: &tauri::AppHandle, mut request: Value) -> Result<Option<String>, String> {
    // Only the transport, never the bridge: the caller is usually a dispatch
    // that already holds the bridge lock.
    let transport = {
        let state = app.state::<NativeRendererState>();
        let guard = state.0.lock().unwrap();
        match guard.as_ref() {
            Some(running) => running.transport.clone(),
            None => return Err("The panel is not running".to_string()),
        }
    };
    let request_id = uuid::Uuid::new_v4().to_string();
    request["requestId"] = json!(request_id);
    let (sender, receiver) = std::sync::mpsc::channel::<Option<String>>();
    app.state::<PendingDialogs>()
        .0
        .lock()
        .unwrap()
        .insert(request_id.clone(), sender);
    transport.lock().unwrap().send(&request)?;
    let outcome = receiver
        .recv_timeout(std::time::Duration::from_secs(300))
        .map_err(|_| "The dialog timed out".to_string());
    app.state::<PendingDialogs>().0.lock().unwrap().remove(&request_id);
    outcome
}

/// The panel presents the open dialog (it is the active app, so the dialog
/// fronts instead of bouncing the Dock).
pub fn panel_pick_file(app: &tauri::AppHandle, kind: &str) -> Result<Option<String>, String> {
    panel_dialog(app, json!({ "cmd": "pickFile", "kind": kind }))
}

pub fn panel_save_file(app: &tauri::AppHandle, name: &str) -> Result<Option<String>, String> {
    panel_dialog(app, json!({ "cmd": "saveFile", "name": name }))
}

/// The panel presents the mail-account sheet: the password goes from the
/// sheet straight into the credential store, so an unconfigured email.send
/// can complete its setup inside the app's own flow.
pub fn panel_mail_account(app: &tauri::AppHandle, prefill: &Value) -> Option<crate::mail::SmtpConfig> {
    if !panel_available(app) {
        return None;
    }
    let reply = panel_dialog(app, json!({ "cmd": "mailAccount", "account": prefill })).ok()??;
    serde_json::from_str(&reply).ok()
}

/// The panel bundled next to the app executable (Contents/MacOS in a
/// packaged build); how installed apps find their renderer.
pub(crate) fn bundled_panel() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let candidate = exe.parent()?.join("DerNativePanel");
    candidate.exists().then_some(candidate)
}

/// The panel binary: DER_NATIVE_RENDERER wins, then the bundled copy next
/// to the executable, then the dev build locations in the repository.
fn panel_binary() -> Result<std::path::PathBuf, String> {
    if let Ok(path) = std::env::var("DER_NATIVE_RENDERER") {
        let path = std::path::PathBuf::from(path);
        if path.exists() {
            return Ok(path);
        }
        return Err(format!("DER_NATIVE_RENDERER points at nothing: {}", path.display()));
    }
    if let Some(bundled) = bundled_panel() {
        return Ok(bundled);
    }
    for candidate in [
        "../macos/.build/release/DerNativePanel",
        "../macos/.build/debug/DerNativePanel",
        "platform/macos/.build/release/DerNativePanel",
        "platform/macos/.build/debug/DerNativePanel",
    ] {
        let path = std::path::PathBuf::from(candidate);
        if path.exists() {
            return Ok(path);
        }
    }
    Err("The native panel is not built; run \"swift build\" in platform/macos first".to_string())
}

/// Home actions arrive from the panel and go back into the app: create and
/// openRecipe run the native pipeline, openBookmark and openRecent open kept
/// apps natively.
/// A failed open is a message on the home, never only a line on stderr.
fn surface_open_failure(app: &tauri::AppHandle, error: &str) {
    let state = app.state::<NativeRendererState>();
    let bridge = {
        let guard = state.0.lock().unwrap();
        match guard.as_ref() {
            Some(running) => running.bridge.clone(),
            None => return,
        }
    };
    let _ = bridge
        .lock()
        .unwrap()
        .send_generation_status("failed", Some(&format!("Could not open the app: {}", error)));
}

fn relay_home_event(app: &tauri::AppHandle, event: &Value) {
    match event.get("event").and_then(Value::as_str) {
        Some("create") => {
            let prompt = event
                .get("prompt")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if prompt.trim().is_empty() {
                return;
            }
            native_create(app, prompt);
        }
        Some("openRecipe") => {
            let Some(name) = event.get("name").and_then(Value::as_str) else {
                return;
            };
            native_open_recipe(app, name.to_string());
        }
        Some("openRecent") => {
            let Some(experience_id) = event.get("id").and_then(Value::as_str) else {
                return;
            };
            let app = app.clone();
            let experience_id = experience_id.to_string();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = open_saved_experience(&app, &experience_id).await {
                    surface_open_failure(&app, &error);
                }
            });
        }
        Some("recentDelete") => {
            let Some(experience_id) = event.get("id").and_then(Value::as_str) else {
                return;
            };
            crate::delete_experience_record(app, experience_id);
            refresh_native_home(app);
        }
        Some("editExperience") => {
            let window_id = event.get("windowId").and_then(Value::as_str).unwrap_or("");
            let instruction = event
                .get("instruction")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            if window_id.is_empty() || instruction.is_empty() {
                return;
            }
            native_edit(app, window_id.to_string(), instruction);
        }
        Some("bookmarkAdd") => {
            let window_id = event.get("windowId").and_then(Value::as_str).unwrap_or("");
            if window_id.is_empty() {
                return;
            }
            native_bookmark_window(app, window_id.to_string());
        }
        Some("openEditor") => {
            let window_id = event.get("windowId").and_then(Value::as_str).unwrap_or("");
            if window_id.is_empty() {
                return;
            }
            send_editor_snapshot(app, window_id, None);
        }
        Some("editorValidate") => {
            let window_id = event
                .get("windowId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let raw = event.get("json").and_then(Value::as_str).unwrap_or("").to_string();
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let vocab = super::sessions::compose_vocabulary(&app);
                let verdict = super::compose::check_contract_json(&raw, &vocab);
                send_panel_message(
                    &app,
                    &json!({
                        "cmd": "editorVerdict",
                        "windowId": window_id,
                        "errors": verdict.errors,
                        "warnings": verdict.warnings,
                    }),
                );
            });
        }
        Some("editorApply") => {
            let window_id = event
                .get("windowId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let raw = event.get("json").and_then(Value::as_str).unwrap_or("").to_string();
            native_editor_apply(app, window_id, raw);
        }
        Some("editorRegenerate") => {
            let window_id = event
                .get("windowId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let raw = event
                .get("blueprint")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            native_editor_regenerate(app, window_id, raw);
        }
        Some("bookmarkBackground") => {
            let Some(bookmark_id) = event.get("id").and_then(Value::as_str) else {
                return;
            };
            let minutes = event.get("minutes").and_then(Value::as_u64).unwrap_or(0) as u32;
            if let Err(error) = crate::set_bookmark_background_record(app, bookmark_id, minutes) {
                eprintln!("Failed to set background refresh on {}: {}", bookmark_id, error);
            }
            refresh_native_home(app);
        }
        Some("bookmarkRemove") => {
            let Some(bookmark_id) = event.get("id").and_then(Value::as_str) else {
                return;
            };
            let app = app.clone();
            let bookmark_id = bookmark_id.to_string();
            tauri::async_runtime::spawn(async move {
                if let Err(error) =
                    crate::delete_bookmarked_experience(app.clone(), bookmark_id.clone()).await
                {
                    eprintln!("Failed to remove bookmark {}: {}", bookmark_id, error);
                }
                refresh_native_home(&app);
            });
        }
        Some(name) if super::manage::is_management_event(name) => {
            super::manage::dispatch(app, event.clone());
        }
        Some("openHome") => {
            show_native_home(app);
        }
        Some("quitApp") => {
            // The panel asked to quit DER: the core exits and the panel
            // follows on its stdin EOF.
            app.exit(0);
        }
        Some("openBookmark") => {
            let Some(bookmark_id) = event.get("id").and_then(Value::as_str) else {
                return;
            };
            let app = app.clone();
            let bookmark_id = bookmark_id.to_string();
            tauri::async_runtime::spawn(async move {
                match crate::load_bookmarked_experience(app.clone(), bookmark_id.clone()).await {
                    Ok(Some(bookmark)) => {
                        let contract = bookmark.get("contract").cloned().unwrap_or(Value::Null);
                        let title = bookmark
                            .get("name")
                            .and_then(Value::as_str)
                            .map(str::to_string);
                        if let Err(error) = crate::open_experience_window_impl(
                            &app,
                            &bookmark_id,
                            contract,
                            title,
                            false,
                        ) {
                            surface_open_failure(&app, &error);
                        }
                    }
                    Ok(None) => eprintln!("Bookmark {} not found", bookmark_id),
                    Err(error) => eprintln!("Failed to load bookmark {}: {}", bookmark_id, error),
                }
            });
        }
        _ => {}
    }
}

fn ensure_running(app: &tauri::AppHandle) -> Result<Arc<Mutex<SidecarBridge>>, String> {
    let state = app.state::<NativeRendererState>();
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
    let persist_app = app.clone();
    bridge.lock().unwrap().set_on_change(Arc::new(move |experience_id: &str, state: &Map<String, Value>| {
        let snapshot = Value::Object(state.clone());
        if let Err(error) =
            crate::write_experience_state_file(&persist_app, experience_id, &snapshot)
        {
            eprintln!("Failed to save native app state: {}", error);
        }
    }));
    let rewrite_app = app.clone();
    bridge
        .lock()
        .unwrap()
        .set_tree_rewriter(Arc::new(move |tree: &mut Vec<Value>| rewrite_granted_srcs(&rewrite_app, tree)));

    // App-level events (home actions, management, window lifecycle) run on
    // one sequential worker so their ordering holds. Window events run on a
    // worker PER WINDOW under that window's own lock, so a slow chain or an
    // open dialog in one app never stalls another app's clicks. The reader
    // stays free throughout, which is what lets a dialog-blocked chain
    // receive its reply.
    let (work_tx, work_rx) = std::sync::mpsc::channel::<Value>();
    let worker_bridge = bridge.clone();
    let worker_app = app.clone();
    std::thread::Builder::new()
        .name("der-native-panel-worker".into())
        .spawn(move || {
            while let Ok(message) = work_rx.recv() {
                let outcome = worker_bridge.lock().unwrap().handle_event(&message);
                match outcome {
                    Ok(Some(event)) => relay_home_event(&worker_app, &event),
                    Ok(None) => {}
                    Err(error) => eprintln!("native panel event failed: {}", error),
                }
            }
        })
        .map_err(|error| error.to_string())?;

    let reader_app = app.clone();
    let reader_bridge = bridge.clone();
    std::thread::Builder::new()
        .name("der-native-panel-reader".into())
        .spawn(move || {
            let mut window_workers: HashMap<String, std::sync::mpsc::Sender<Value>> =
                HashMap::new();
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                match serde_json::from_str::<Value>(&line) {
                    Ok(message) => {
                        let event = message.get("event").and_then(Value::as_str).unwrap_or("");
                        match event {
                            "fileDialog" => resolve_file_dialog(&reader_app, &message),
                            "mailAccount" => resolve_mail_dialog(&reader_app, &message),
                            "setElement" | "dispatch" => {
                                route_window_event(
                                    &reader_bridge,
                                    &mut window_workers,
                                    message,
                                );
                            }
                            "windowClosed" => {
                                // The window's queue ends; queued events on
                                // the dropped sender still finish against
                                // the cell they hold.
                                if let Some(window_id) =
                                    message.get("windowId").and_then(Value::as_str)
                                {
                                    window_workers.remove(window_id);
                                }
                                if work_tx.send(message).is_err() {
                                    break;
                                }
                            }
                            _ => {
                                if work_tx.send(message).is_err() {
                                    break;
                                }
                            }
                        }
                    }
                    Err(error) => eprintln!("native panel sent invalid JSON: {}", error),
                }
            }
        })
        .map_err(|error| error.to_string())?;

    let transport = bridge.lock().unwrap().transport_handle();
    *guard = Some(RunningSidecar {
        bridge: bridge.clone(),
        transport,
        child,
    });
    Ok(bridge)
}

pub(crate) fn build_entry(
    app: &tauri::AppHandle,
    experience_id: &str,
    contract: &Value,
    initial_data: Map<String, Value>,
) -> Result<(SessionEntry, Vec<Value>), String> {
    let (fragment_defs, parts) = super::sessions::installed_vocabulary(app);
    let dispatcher = HostDispatcher {
        app: app.clone(),
        parts,
        experience_id: experience_id.to_string(),
    };
    let entry = open_session_core(
        contract,
        initial_data,
        fragment_defs,
        Box::new(SystemEnv),
        Some(Box::new(dispatcher)),
    )?;
    let elements = contract
        .get("elements")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok((entry, elements))
}


/// Opens (or refreshes) the native window for an experience, restoring its
/// saved per-app state. The native-mode default path for every experience.
pub fn open_native_for_experience(
    app: &tauri::AppHandle,
    experience_id: &str,
    contract: Value,
    title: Option<String>,
    saved_state: Option<Value>,
) -> Result<(), String> {
    let bridge = ensure_running(app)?;
    let initial_data = saved_state
        .and_then(|state| state.as_object().cloned())
        .unwrap_or_default();
    let (entry, elements) = build_entry(app, experience_id, &contract, initial_data)?;
    let title = title.unwrap_or_else(|| {
        contract
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("Experience")
            .to_string()
    });
    let mut bridge = bridge.lock().unwrap();
    if bridge.window_for_experience(experience_id).is_some() {
        return bridge.replace_session(experience_id, entry, elements, contract, false);
    }
    let window_id = format!("nw-{}", uuid::Uuid::new_v4());
    bridge.open_window(
        &window_id,
        experience_id,
        &title,
        entry,
        elements,
        contract,
        false,
    )
}

/// Sends a prebuilt message to the panel when it is running; management
/// snapshots use this.
pub fn send_panel_message(app: &tauri::AppHandle, message: &Value) {
    let state = app.state::<NativeRendererState>();
    let bridge = {
        let guard = state.0.lock().unwrap();
        match guard.as_ref() {
            Some(running) => running.bridge.clone(),
            None => match ensure_running(app) {
                Ok(bridge) => bridge,
                Err(error) => {
                    eprintln!("{}", error);
                    return;
                }
            },
        }
    };
    let outcome = bridge.lock().unwrap().send_raw(message);
    if let Err(error) = outcome {
        eprintln!("Panel message failed: {}", error);
    }
}

fn send_edit_status(app: &tauri::AppHandle, window_id: &str, status: &str, message: Option<&str>) {
    send_panel_message(
        app,
        &json!({
            "cmd": "editStatus",
            "windowId": window_id,
            "status": status,
            "message": message,
        }),
    );
}

/// A conversational edit from a native window: the Rust edit pipeline
/// rewrites the contract, the record updates, and the window's session
/// rebuilds with its state preserved.
pub fn native_edit(app: &tauri::AppHandle, window_id: String, instruction: String) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<NativeRendererState>();
        let bridge = {
            let guard = state.0.lock().unwrap();
            match guard.as_ref() {
                Some(running) => running.bridge.clone(),
                None => return,
            }
        };
        let info = bridge.lock().unwrap().window_info(&window_id);
        let Some((experience_id, current)) = info else {
            return;
        };
        send_edit_status(&app, &window_id, "started", None);
        let vocab = super::sessions::compose_vocabulary(&app);
        let now_iso = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
        let mut llm = super::sessions::HostLlm { app: app.clone() };
        let outcome = super::compose::edit_contract(
            &mut llm,
            &current,
            &instruction,
            &vocab,
            &now_iso,
            None,
        )
        .await;
        match outcome {
            Ok(outcome) => {
                let description = outcome
                    .contract
                    .get("metadata")
                    .and_then(|m| m.get("description"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                persist_created_experience(
                    &app,
                    &experience_id,
                    &outcome.contract,
                    &description,
                    &now_iso,
                    None,
                )
                .await;
                let preserved = bridge.lock().unwrap().state_of_experience(&experience_id);
                let rebuilt = build_entry(
                    &app,
                    &experience_id,
                    &outcome.contract,
                    preserved.unwrap_or_default(),
                );
                match rebuilt {
                    Ok((entry, elements)) => {
                        let replaced = bridge.lock().unwrap().replace_session(
                            &experience_id,
                            entry,
                            elements,
                            outcome.contract,
                            false,
                        );
                        match replaced {
                            Ok(()) => {
                                let note = if outcome.warnings.is_empty() {
                                    "Edit applied".to_string()
                                } else {
                                    format!(
                                        "Edit applied ({} adjustment{})",
                                        outcome.warnings.len(),
                                        if outcome.warnings.len() == 1 { "" } else { "s" }
                                    )
                                };
                                send_edit_status(&app, &window_id, "done", Some(&note));
                                refresh_native_home(&app);
                            }
                            Err(error) => {
                                send_edit_status(&app, &window_id, "failed", Some(&error));
                            }
                        }
                    }
                    Err(error) => send_edit_status(&app, &window_id, "failed", Some(&error)),
                }
            }
            Err(error) => send_edit_status(&app, &window_id, "failed", Some(&error)),
        }
    });
}

/// The editor snapshot for a window: the current contract pretty-printed
/// and the blueprint projected from it.
fn send_editor_snapshot(app: &tauri::AppHandle, window_id: &str, note: Option<(&str, &str)>) {
    let state = app.state::<NativeRendererState>();
    let bridge = {
        let guard = state.0.lock().unwrap();
        match guard.as_ref() {
            Some(running) => running.bridge.clone(),
            None => return,
        }
    };
    let Some((experience_id, contract)) = bridge.lock().unwrap().window_info(window_id) else {
        return;
    };
    let description = contract
        .get("metadata")
        .and_then(|m| m.get("description"))
        .and_then(Value::as_str)
        .or_else(|| contract.get("name").and_then(Value::as_str))
        .unwrap_or("")
        .to_string();
    let blueprint = super::compose::derive_blueprint(&contract, &description);
    let mut message = json!({
        "cmd": "editor",
        "windowId": window_id,
        "experienceId": experience_id,
        "name": contract.get("name").cloned().unwrap_or(Value::Null),
        "contractJson": serde_json::to_string_pretty(&contract).unwrap_or_default(),
        "blueprintJson": serde_json::to_string_pretty(&blueprint).unwrap_or_default(),
    });
    if let Some((kind, text)) = note {
        message["noteKind"] = json!(kind);
        message["note"] = json!(text);
    }
    send_panel_message(app, &message);
}

fn send_editor_status(app: &tauri::AppHandle, window_id: &str, status: &str, message: Option<&str>) {
    send_panel_message(
        app,
        &json!({
            "cmd": "editorStatus",
            "windowId": window_id,
            "status": status,
            "message": message,
        }),
    );
}

/// Applies the finished contract of an editor action to the app: record
/// persisted, session rebuilt with preserved state, editor refreshed.
async fn land_edited_contract(
    app: &tauri::AppHandle,
    window_id: &str,
    contract: Value,
    now_iso: &str,
) -> Result<(), String> {
    let state = app.state::<NativeRendererState>();
    let bridge = {
        let guard = state.0.lock().unwrap();
        match guard.as_ref() {
            Some(running) => running.bridge.clone(),
            None => return Err("The panel is not running".to_string()),
        }
    };
    let Some((experience_id, _)) = bridge.lock().unwrap().window_info(window_id) else {
        return Err("The window is gone".to_string());
    };
    let description = contract
        .get("metadata")
        .and_then(|m| m.get("description"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    persist_created_experience(app, &experience_id, &contract, &description, now_iso, None).await;
    let preserved = bridge.lock().unwrap().state_of_experience(&experience_id);
    let (entry, elements) = build_entry(app, &experience_id, &contract, preserved.unwrap_or_default())?;
    let outcome = {
        let mut guard = bridge.lock().unwrap();
        guard.replace_session(&experience_id, entry, elements, contract, false)
    };
    outcome?;
    refresh_native_home(app);
    Ok(())
}

/// A hand-edited contract applies only when it passes the same gates the
/// model faces; the verdict shows every problem otherwise.
pub fn native_editor_apply(app: &tauri::AppHandle, window_id: String, raw: String) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let vocab = super::sessions::compose_vocabulary(&app);
        let verdict = super::compose::check_contract_json(&raw, &vocab);
        if verdict.shape.is_none() {
            send_panel_message(
                &app,
                &json!({
                    "cmd": "editorVerdict",
                    "windowId": window_id,
                    "errors": verdict.errors,
                    "warnings": verdict.warnings,
                }),
            );
            send_editor_status(&app, &window_id, "failed", Some("The contract has problems"));
            return;
        }
        let now_iso = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
        let contract = super::compose::finalize_contract_shape(
            &verdict.shape.expect("checked above"),
            None,
            &now_iso,
            &vocab,
        );
        match land_edited_contract(&app, &window_id, contract, &now_iso).await {
            Ok(()) => {
                send_editor_snapshot(&app, &window_id, Some(("info", "Contract applied")));
                send_editor_status(&app, &window_id, "done", Some("Contract applied"));
            }
            Err(error) => send_editor_status(&app, &window_id, "failed", Some(&error)),
        }
    });
}

/// Regenerates the contract from an edited blueprint through the model,
/// then lands it like any edit.
pub fn native_editor_regenerate(app: &tauri::AppHandle, window_id: String, raw: String) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let blueprint: Value = match serde_json::from_str(&raw) {
            Ok(value) => value,
            Err(error) => {
                send_editor_status(
                    &app,
                    &window_id,
                    "failed",
                    Some(&format!("The blueprint is not parseable JSON: {}", error)),
                );
                return;
            }
        };
        send_editor_status(&app, &window_id, "started", Some("Regenerating from the blueprint"));
        let vocab = super::sessions::compose_vocabulary(&app);
        let now_iso = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
        let mut llm = super::sessions::HostLlm { app: app.clone() };
        let outcome = super::compose::generate_from_blueprint(
            &mut llm,
            &blueprint,
            &vocab,
            &now_iso,
            None,
        )
        .await;
        match outcome {
            Ok(outcome) => match land_edited_contract(&app, &window_id, outcome.contract, &now_iso)
                .await
            {
                Ok(()) => {
                    send_editor_snapshot(&app, &window_id, Some(("info", "Regenerated")));
                    send_editor_status(&app, &window_id, "done", Some("Regenerated"));
                }
                Err(error) => send_editor_status(&app, &window_id, "failed", Some(&error)),
            },
            Err(error) => send_editor_status(&app, &window_id, "failed", Some(&error)),
        }
    });
}

/// Keeps an app: the window's experience joins the bookmarks, the tray
/// rebuilds, and the home refreshes.
pub fn native_bookmark_window(app: &tauri::AppHandle, window_id: String) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<NativeRendererState>();
        let bridge = {
            let guard = state.0.lock().unwrap();
            match guard.as_ref() {
                Some(running) => running.bridge.clone(),
                None => return,
            }
        };
        let info = bridge.lock().unwrap().window_info(&window_id);
        let Some((experience_id, contract)) = info else {
            return;
        };
        let name = contract
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("Untitled app")
            .to_string();
        let description = contract
            .get("metadata")
            .and_then(|m| m.get("description"))
            .and_then(Value::as_str)
            .map(str::to_string);
        if let Err(error) = crate::bookmark_experience(
            app.clone(),
            experience_id,
            name,
            description,
            contract,
            None,
        )
        .await
        {
            eprintln!("Failed to bookmark: {}", error);
        }
        refresh_native_home(&app);
    });
}

/// A streaming assembly draft lands in its native window: the display-only
/// contract opens the window on the first parseable partial and replaces the
/// tree on every one after, until the finished app takes over. Drafts the
/// user closed stay closed.
pub fn show_assembly_preview(
    app: &tauri::AppHandle,
    experience_id: &str,
    contract: Value,
    title: &str,
) -> Result<(), String> {
    let bridge = ensure_running(app)?;
    {
        let guard = bridge.lock().unwrap();
        if guard.assembly_dismissed(experience_id) {
            return Ok(());
        }
    }
    // Display drafts carry no operations, so the session is inert by
    // construction; no dispatcher is wired on purpose.
    let (fragment_defs, _) = super::sessions::installed_vocabulary(app);
    let entry = open_session_core(
        &contract,
        Map::new(),
        fragment_defs,
        Box::new(SystemEnv),
        None,
    )?;
    let elements = contract
        .get("elements")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut bridge = bridge.lock().unwrap();
    if bridge.window_for_experience(experience_id).is_some() {
        return bridge.replace_session(experience_id, entry, elements, contract, true);
    }
    let window_id = format!("nw-{}", uuid::Uuid::new_v4());
    bridge.open_window(
        &window_id,
        experience_id,
        title,
        entry,
        elements,
        contract,
        true,
    )
}

/// Ready-made apps from the installed manifests (recipe parts).
fn installed_recipes(app: &tauri::AppHandle) -> Vec<Value> {
    let Ok(dir) = app.path().app_data_dir().map(|dir| dir.join("fragments")) else {
        return Vec::new();
    };
    let mut recipes = Vec::new();
    for installed in crate::fragments::list_core(&dir) {
        if let Some(Value::Array(entries)) = installed
            .get("manifest")
            .and_then(|manifest| manifest.get("recipes"))
        {
            for entry in entries {
                recipes.push(json!({
                    "name": entry.get("name").cloned().unwrap_or(Value::Null),
                    "title": entry.get("title").cloned().unwrap_or(Value::Null),
                    "description": entry.get("description").cloned().unwrap_or(Value::Null),
                }));
            }
        }
    }
    recipes
}

/// Apps created on this machine, newest first, for the home's recent list.
fn recent_experiences(app: &tauri::AppHandle) -> Vec<Value> {
    let Ok(dir) = app.path().app_data_dir().map(|dir| dir.join("experiences")) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut records: Vec<(std::time::SystemTime, Value)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(&path) else { continue };
        let Ok(record) = serde_json::from_str::<Value>(&raw) else { continue };
        let Some(id) = record.get("experienceId").and_then(Value::as_str) else { continue };
        let name = record
            .get("metadata")
            .and_then(|metadata| metadata.get("name"))
            .and_then(Value::as_str)
            .or_else(|| {
                record
                    .get("contract")
                    .and_then(|contract| contract.get("name"))
                    .and_then(Value::as_str)
            })
            .unwrap_or("Untitled app");
        let description = record
            .get("metadata")
            .and_then(|metadata| metadata.get("description"))
            .and_then(Value::as_str);
        let modified = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        records.push((
            modified,
            json!({ "id": id, "name": name, "description": description }),
        ));
    }
    records.sort_by(|a, b| b.0.cmp(&a.0));
    records.into_iter().map(|(_, record)| record).take(6).collect()
}

/// Shows DER's native home: the prompt, every bookmarked app, recently
/// created apps, and the installed ready-made apps.
pub fn show_native_home(app: &tauri::AppHandle) {
    send_native_home(app, true);
}

fn send_native_home(app: &tauri::AppHandle, raise: bool) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let bookmarks: Vec<Value> = crate::list_bookmarked_experiences_detailed(app.clone())
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|bookmark| {
                json!({
                    "id": bookmark.get("id").cloned().unwrap_or(Value::Null),
                    "name": bookmark.get("name").cloned().unwrap_or(Value::Null),
                    "backgroundMinutes": bookmark.get("backgroundMinutes").cloned().unwrap_or(Value::Null),
                })
            })
            .collect();
        let recipes = installed_recipes(&app);
        let recents = recent_experiences(&app);
        let llm_ready = crate::settings::llm_ready(&app);
        match ensure_running(&app) {
            Ok(bridge) => {
                if let Err(error) = bridge
                    .lock()
                    .unwrap()
                    .send_home(&bookmarks, &recipes, &recents, raise, llm_ready)
                {
                    eprintln!("Failed to show the native home: {}", error);
                }
            }
            Err(error) => eprintln!("{}", error),
        }
    });
}

/// The generation pipeline reports its lifecycle here so the native home
/// shows progress and failures instead of an eternal working note. A failed
/// generation takes its half-built drafts with it.
#[tauri::command]
pub async fn native_generation_status(
    app: tauri::AppHandle,
    status: String,
    message: Option<String>,
) -> Result<(), String> {
    generation_status(&app, &status, message.as_deref());
    Ok(())
}

/// Keeps an already-shown native home current without fronting it; silent
/// outside native mode or before the panel started.
pub fn refresh_native_home(app: &tauri::AppHandle) {
    if !crate::native_mode() {
        return;
    }
    let state = app.state::<NativeRendererState>();
    let running = state.0.lock().unwrap().is_some();
    if running {
        send_native_home(app, false);
    }
}

fn generation_status(app: &tauri::AppHandle, status: &str, message: Option<&str>) {
    let state = app.state::<NativeRendererState>();
    let bridge = {
        let guard = state.0.lock().unwrap();
        match guard.as_ref() {
            Some(running) => running.bridge.clone(),
            None => return,
        }
    };
    let mut guard = bridge.lock().unwrap();
    if status == "failed" {
        let _ = guard.close_assembling_windows();
    }
    let _ = guard.send_generation_status(status, message);
}

fn truncated_title(prompt: &str) -> String {
    let chars: Vec<char> = prompt.chars().collect();
    if chars.len() > 48 {
        format!("{}...", chars[..45].iter().collect::<String>())
    } else {
        prompt.to_string()
    }
}

async fn persist_created_experience(
    app: &tauri::AppHandle,
    experience_id: &str,
    contract: &Value,
    description: &str,
    now_iso: &str,
    recipe_name: Option<&str>,
) {
    let name = contract
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("Untitled app");
    let mut metadata = json!({
        "name": name,
        "description": description,
        "createdAt": now_iso,
    });
    if let Some(recipe) = recipe_name {
        metadata["recipeName"] = json!(recipe);
    }
    if let Err(error) = crate::save_experience(
        app.clone(),
        experience_id.to_string(),
        contract.clone(),
        json!({}),
        Some(metadata),
    )
    .await
    {
        eprintln!("Failed to save created experience: {}", error);
    }
}

/// Creation without a webview: the Rust compose pipeline streams, every
/// parseable partial lands in the native assembly window, and the finished
/// app takes the window over live. The home shows the lifecycle and its
/// recent list picks up the result.
pub fn native_create(app: &tauri::AppHandle, prompt: String) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        generation_status(&app, "started", None);
        let experience_id = format!(
            "exp-{}-{}",
            chrono::Utc::now().timestamp_millis(),
            &uuid::Uuid::new_v4().simple().to_string()[..9]
        );
        let title = truncated_title(&prompt);
        let vocab = super::sessions::compose_vocabulary(&app);
        let now_iso = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
        let mut llm = super::sessions::HostLlm { app: app.clone() };

        let preview_app = app.clone();
        let preview_id = experience_id.clone();
        let preview_title = title.clone();
        let mut on_partial = move |accumulated: &str, _attempt: u32| {
            let Some(preview) = super::streaming::extract_streaming_contract(accumulated) else {
                return;
            };
            if let Err(error) =
                show_assembly_preview(&preview_app, &preview_id, preview, &preview_title)
            {
                eprintln!("Assembly preview failed: {}", error);
            }
        };

        let outcome = super::compose::compose_from_description(
            &mut llm,
            &prompt,
            &vocab,
            &now_iso,
            Some(&mut on_partial),
        )
        .await;

        match outcome {
            Ok(outcome) => {
                let description = outcome
                    .spec
                    .get("goal")
                    .and_then(Value::as_str)
                    .filter(|goal| !goal.is_empty())
                    .unwrap_or(&prompt)
                    .to_string();
                persist_created_experience(
                    &app,
                    &experience_id,
                    &outcome.contract,
                    &description,
                    &now_iso,
                    outcome.recipe_name.as_deref(),
                )
                .await;
                let final_title = outcome
                    .contract
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or(title);
                if let Err(error) = open_native_for_experience(
                    &app,
                    &experience_id,
                    outcome.contract,
                    Some(final_title),
                    None,
                ) {
                    generation_status(&app, "failed", Some(&error));
                    return;
                }
                generation_status(&app, "done", None);
                refresh_native_home(&app);
            }
            Err(error) => {
                generation_status(&app, "failed", Some(&error));
            }
        }
    });
}

/// Opens an installed ready-made app natively: the proven contract is
/// revalidated against the installed parts and finalized without a model
/// call, then persisted and opened like any created app.
pub fn native_open_recipe(app: &tauri::AppHandle, name: String) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let vocab = super::sessions::compose_vocabulary(&app);
        let Some(def) = vocab.recipes.get(&name).cloned() else {
            generation_status(&app, "failed", Some(&format!("\"{}\" is not installed", name)));
            return;
        };
        let resolved = super::compose::resolve_recipe_shape(&def, &vocab);
        let Some(shape) = resolved.shape.filter(|_| resolved.problems.is_empty()) else {
            generation_status(
                &app,
                "failed",
                Some(&format!("\"{}\" cannot open ({})", name, resolved.problems.join("; "))),
            );
            return;
        };
        let now_iso = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
        let description = def
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let contract = super::compose::finalize_contract_shape(
            &shape,
            Some(&description),
            &now_iso,
            &vocab,
        );
        let experience_id = format!(
            "exp-{}-{}",
            chrono::Utc::now().timestamp_millis(),
            &uuid::Uuid::new_v4().simple().to_string()[..9]
        );
        persist_created_experience(&app, &experience_id, &contract, &description, &now_iso, Some(&name))
            .await;
        let title = contract
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("Experience")
            .to_string();
        if let Err(error) =
            open_native_for_experience(&app, &experience_id, contract, Some(title), None)
        {
            eprintln!("Failed to open recipe {} natively: {}", name, error);
        } else {
            refresh_native_home(&app);
        }
    });
}

/// Reopens a saved experience record with its per-app state restored.
async fn open_saved_experience(app: &tauri::AppHandle, experience_id: &str) -> Result<(), String> {
    let record = crate::load_experience(app.clone(), experience_id.to_string())
        .await?
        .ok_or_else(|| format!("Experience {} not found", experience_id))?;
    let contract = record.get("contract").cloned().unwrap_or(Value::Null);
    let title = record
        .get("metadata")
        .and_then(|metadata| metadata.get("name"))
        .and_then(Value::as_str)
        .or_else(|| contract.get("name").and_then(Value::as_str))
        .map(str::to_string);
    let saved_state = crate::read_experience_state(app, experience_id);
    open_native_for_experience(app, experience_id, contract, title, saved_state)
}

#[tauri::command]
pub async fn open_native_experience_window(
    app: tauri::AppHandle,
    experience_id: String,
    contract: Value,
    title: String,
    initial_data: Option<Map<String, Value>>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        open_native_for_experience(
            &app,
            &experience_id,
            contract,
            Some(title),
            initial_data.map(Value::Object),
        )
    })
    .await
    .map_err(|error| format!("Native open failed: {}", error))?
}

/// A contract edit lands in the open native window: the session rebuilds
/// with the preserved state and the fresh tree replaces the view.
#[tauri::command]
pub async fn native_update_experience_contract(
    app: tauri::AppHandle,
    experience_id: String,
    contract: Value,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<NativeRendererState>();
        let bridge = {
            let guard = state.0.lock().unwrap();
            match guard.as_ref() {
                Some(running) => running.bridge.clone(),
                None => return Ok(()),
            }
        };
        let preserved = bridge
            .lock()
            .unwrap()
            .state_of_experience(&experience_id);
        let Some(preserved) = preserved else {
            return Ok(());
        };
        let (entry, elements) = build_entry(&app, &experience_id, &contract, preserved)?;
        let outcome = {
            let mut guard = bridge.lock().unwrap();
            guard.replace_session(&experience_id, entry, elements, contract, false)
        };
        outcome
    })
    .await
    .map_err(|error| format!("Native update failed: {}", error))?
}
