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
    /// Streaming assembly: the window shows a growing display-only draft;
    /// interactions are inert and state never persists.
    assembling: bool,
}

/// Fired after every session mutation with the experience id and its state,
/// so native windows persist per-app data exactly like webview windows.
pub type StateChanged = Box<dyn Fn(&str, &Map<String, Value>) + Send>;

pub struct SidecarBridge {
    windows: HashMap<String, WindowSession>,
    transport: Box<dyn SidecarTransport>,
    on_change: Option<StateChanged>,
    /// Experiences whose assembly window the user closed mid-generation;
    /// further previews stay away, the finished app still opens.
    assembly_dismissed: std::collections::HashSet<String>,
}

impl SidecarBridge {
    pub fn new(transport: Box<dyn SidecarTransport>) -> Self {
        Self {
            windows: HashMap::new(),
            transport,
            on_change: None,
            assembly_dismissed: std::collections::HashSet::new(),
        }
    }

    pub fn set_on_change(&mut self, on_change: StateChanged) {
        self.on_change = Some(on_change);
    }

    pub fn open_window(
        &mut self,
        window_id: &str,
        experience_id: &str,
        title: &str,
        theme: Option<&str>,
        entry: SessionEntry,
        elements: Vec<Value>,
        assembling: bool,
    ) -> Result<(), String> {
        let tree = resolve_entry_view(&entry, &elements);
        self.transport.send(&json!({
            "cmd": "open",
            "windowId": window_id,
            "title": title,
            "theme": theme,
            "tree": tree,
            "assembling": assembling,
        }))?;
        self.windows.insert(
            window_id.to_string(),
            WindowSession {
                entry,
                elements,
                experience_id: experience_id.to_string(),
                assembling,
            },
        );
        Ok(())
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
            .filter(|(_, window)| window.assembling)
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
            .find(|(_, window)| window.experience_id == experience_id)
            .map(|(window_id, _)| window_id.clone())
    }

    pub fn state_of_experience(&self, experience_id: &str) -> Option<Map<String, Value>> {
        self.windows
            .values()
            .find(|window| window.experience_id == experience_id)
            .map(|window| window.entry.session().state().clone())
    }

    /// Swaps an open window's session (a contract edit or the next assembly
    /// draft) and shows the fresh tree; the caller rebuilds the entry with
    /// the preserved state.
    pub fn replace_session(
        &mut self,
        experience_id: &str,
        entry: SessionEntry,
        elements: Vec<Value>,
        assembling: bool,
    ) -> Result<(), String> {
        let window_id = self
            .window_for_experience(experience_id)
            .ok_or_else(|| format!("No native window for experience {}", experience_id))?;
        if let Some(window) = self.windows.get_mut(&window_id) {
            window.entry = entry;
            window.elements = elements;
            window.assembling = assembling;
        }
        self.send_update(&window_id)
    }

    /// DER's own native surface: a prompt, the kept apps, recent creations,
    /// and the ready-made apps installed parts ship.
    pub fn send_home(
        &mut self,
        bookmarks: &[Value],
        recipes: &[Value],
        recents: &[Value],
    ) -> Result<(), String> {
        self.transport.send(&json!({
            "cmd": "home",
            "bookmarks": bookmarks,
            "recipes": recipes,
            "recents": recents,
        }))
    }

    pub fn send_generation_status(
        &mut self,
        status: &str,
        message: Option<&str>,
    ) -> Result<(), String> {
        self.transport.send(&json!({
            "cmd": "generationStatus",
            "status": status,
            "message": message,
        }))
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

    fn notify_change(&self, window_id: &str) {
        if let (Some(on_change), Some(window)) = (&self.on_change, self.windows.get(window_id)) {
            // Assembly drafts are inert; nothing they hold is worth saving.
            if window.assembling {
                return;
            }
            on_change(&window.experience_id, window.entry.session().state());
        }
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
                self.notify_change(&window_id);
                self.send_update(&window_id).map(|_| None)
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
                self.notify_change(&window_id);
                self.send_update(&window_id).map(|_| None)
            }
            "windowClosed" => {
                if let Some(window) = self.windows.remove(&window_id) {
                    if window.assembling {
                        self.assembly_dismissed.insert(window.experience_id);
                    }
                }
                Ok(None)
            }
            "create" | "openBookmark" | "openManage" | "openRecipe" | "openRecent" => {
                Ok(Some(message.clone()))
            }
            "log" => Ok(None),
            other => Err(format!("Unknown panel event \"{}\"", other)),
        }
    }

    fn send_update(&mut self, window_id: &str) -> Result<(), String> {
        let window = self
            .windows
            .get(window_id)
            .ok_or_else(|| format!("No native window {}", window_id))?;
        let tree = resolve_entry_view(&window.entry, &window.elements);
        let assembling = window.assembling;
        self.transport.send(&json!({
            "cmd": "update",
            "windowId": window_id,
            "tree": tree,
            "assembling": assembling,
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

/// Home actions arrive from the panel and go back into the app: create and
/// openRecipe run the native pipeline, openBookmark and openRecent open kept
/// apps natively.
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
                    eprintln!("Failed to open {} natively: {}", experience_id, error);
                }
            });
        }
        Some("openManage") => {
            // The deliberate bridge to the webview management console:
            // settings, parts, and the contract editors live there.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
                use tauri::Emitter;
                let _ = window.emit("show-settings", ());
            }
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
                            eprintln!("Failed to open {} natively: {}", bookmark_id, error);
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
    bridge.lock().unwrap().set_on_change(Box::new(move |experience_id, state| {
        let snapshot = Value::Object(state.clone());
        if let Err(error) =
            crate::write_experience_state_file(&persist_app, experience_id, &snapshot)
        {
            eprintln!("Failed to save native app state: {}", error);
        }
    }));

    let reader_bridge = bridge.clone();
    let reader_app = app.clone();
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
                        let outcome = reader_bridge.lock().unwrap().handle_event(&message);
                        match outcome {
                            Ok(Some(event)) => relay_home_event(&reader_app, &event),
                            Ok(None) => {}
                            Err(error) => eprintln!("native panel event failed: {}", error),
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

fn build_entry(
    app: &tauri::AppHandle,
    contract: &Value,
    initial_data: Map<String, Value>,
) -> Result<(SessionEntry, Vec<Value>), String> {
    let (fragment_defs, parts) = super::sessions::installed_vocabulary(app);
    let dispatcher = HostDispatcher {
        app: app.clone(),
        parts,
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

fn contract_theme(contract: &Value) -> Option<String> {
    contract
        .get("styling")
        .and_then(|styling| styling.get("theme"))
        .and_then(Value::as_str)
        .map(str::to_string)
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
    let (entry, elements) = build_entry(app, &contract, initial_data)?;
    let title = title.unwrap_or_else(|| {
        contract
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("Experience")
            .to_string()
    });
    let theme = contract_theme(&contract);
    let mut bridge = bridge.lock().unwrap();
    if bridge.window_for_experience(experience_id).is_some() {
        return bridge.replace_session(experience_id, entry, elements, false);
    }
    let window_id = format!("nw-{}", uuid::Uuid::new_v4());
    bridge.open_window(
        &window_id,
        experience_id,
        &title,
        theme.as_deref(),
        entry,
        elements,
        false,
    )
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
    let theme = contract_theme(&contract);
    let mut bridge = bridge.lock().unwrap();
    if bridge.window_for_experience(experience_id).is_some() {
        return bridge.replace_session(experience_id, entry, elements, true);
    }
    let window_id = format!("nw-{}", uuid::Uuid::new_v4());
    bridge.open_window(
        &window_id,
        experience_id,
        title,
        theme.as_deref(),
        entry,
        elements,
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
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let bookmarks = crate::list_bookmarked_experiences(app.clone())
            .await
            .unwrap_or_default();
        let recipes = installed_recipes(&app);
        let recents = recent_experiences(&app);
        match ensure_running(&app) {
            Ok(bridge) => {
                if let Err(error) =
                    bridge.lock().unwrap().send_home(&bookmarks, &recipes, &recents)
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

/// Keeps an already-shown native home current; silent outside native mode
/// or before the panel started.
pub fn refresh_native_home(app: &tauri::AppHandle) {
    if !crate::native_mode() {
        return;
    }
    let state = app.state::<NativeRendererState>();
    let running = state.0.lock().unwrap().is_some();
    if running {
        show_native_home(app);
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
        let (entry, elements) = build_entry(&app, &contract, preserved)?;
        let outcome = {
            let mut guard = bridge.lock().unwrap();
            guard.replace_session(&experience_id, entry, elements, false)
        };
        outcome
    })
    .await
    .map_err(|error| format!("Native update failed: {}", error))?
}
