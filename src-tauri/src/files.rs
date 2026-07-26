//! User-mediated file access: the platform IO layer that compute parts and
//! viewer elements compose with. Contracts never see paths: a pick grants a
//! token and a renderer URL, reads are confined to granted tokens, and
//! saves land only where the user points the save panel. The webview
//! invokes these as commands; the native dispatcher calls the same cores.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

/// Paths the user granted this session, by opaque token.
#[derive(Default)]
pub struct FileGrants(Mutex<HashMap<String, PathBuf>>);

impl FileGrants {
    fn grant(&self, path: PathBuf) -> String {
        let token = format!("derfile-{}", uuid::Uuid::new_v4());
        self.0.lock().unwrap().insert(token.clone(), path);
        token
    }
    pub fn path_of(&self, token: &str) -> Option<PathBuf> {
        self.0.lock().unwrap().get(token).cloned()
    }
    pub fn is_granted_path(&self, path: &Path) -> bool {
        self.0.lock().unwrap().values().any(|granted| granted == path)
    }
}

const MAX_READ_BYTES: u64 = 64 * 1024 * 1024;

fn mime_of(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "md" | "markdown" => "text/markdown",
        "txt" => "text/plain",
        "csv" => "text/csv",
        "json" => "application/json",
        "html" | "htm" => "text/html",
        _ => "application/octet-stream",
    }
}

fn filters_for(kind: &str) -> Option<(&'static str, &'static [&'static str])> {
    match kind {
        "pdf" => Some(("PDF", &["pdf"])),
        "image" => Some(("Images", &["png", "jpg", "jpeg", "gif", "webp", "bmp"])),
        "video" => Some(("Video", &["mp4", "mov", "m4v", "webm"])),
        "markdown" => Some(("Markdown", &["md", "markdown", "txt"])),
        "text" => Some(("Text", &["txt", "md", "csv", "json", "html"])),
        _ => None,
    }
}

/// The renderer-facing URL for a granted path: the webview loads it over
/// the asset protocol, so the path also joins the protocol scope.
fn asset_url(app: &AppHandle, path: &Path) -> String {
    let _ = app.asset_protocol_scope().allow_file(path);
    let encoded: String = path
        .to_string_lossy()
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b'.' | b'-' | b'_' => {
                (byte as char).to_string()
            }
            other => format!("%{:02X}", other),
        })
        .collect();
    format!("asset://localhost/{}", encoded)
}

pub fn pick_core(app: &AppHandle, kind: &str) -> Result<Value, String> {
    // In native mode the panel is the active app and presents the dialog;
    // a dialog from this background process would open behind the windows
    // and bounce the Dock instead.
    let path: PathBuf = if crate::runtime::sidecar::panel_available(app) {
        match crate::runtime::sidecar::panel_pick_file(app, kind)? {
            Some(path) => PathBuf::from(path),
            None => return Err("No file was chosen".to_string()),
        }
    } else {
        let mut dialog = app.dialog().file();
        if let Some((label, extensions)) = filters_for(kind) {
            dialog = dialog.add_filter(label, extensions);
        }
        let Some(picked) = dialog.blocking_pick_file() else {
            return Err("No file was chosen".to_string());
        };
        picked
            .into_path()
            .map_err(|error| format!("The picked file has no usable path: {}", error))?
    };
    let size = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    let mime = mime_of(&path).to_string();
    let url = asset_url(app, &path);
    let token = app.state::<FileGrants>().grant(path);
    Ok(json!({
        "file": token,
        "url": url,
        "name": name,
        "size": size,
        "mime": mime,
    }))
}

pub fn read_core(app: &AppHandle, token: &str) -> Result<Value, String> {
    let Some(path) = app.state::<FileGrants>().path_of(token) else {
        return Err(
            "file.read only reads files the user picked in this session; feed it file.pick's \"file\" output".to_string(),
        );
    };
    let size = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
    if size > MAX_READ_BYTES {
        return Err(format!(
            "The file is {} MB; file.read handles up to {} MB",
            size / (1024 * 1024),
            MAX_READ_BYTES / (1024 * 1024)
        ));
    }
    let bytes =
        std::fs::read(&path).map_err(|error| format!("Could not read the file: {}", error))?;
    // Text files also arrive as text, so string-shaped parts chain without
    // a decode step; binary files leave "text" null.
    let text = String::from_utf8(bytes.clone()).ok();
    Ok(json!({
        "base64": BASE64.encode(&bytes),
        "text": text,
        "name": path.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default(),
        "mime": mime_of(&path),
        "size": size,
    }))
}

pub fn save_core(app: &AppHandle, base64_data: &str, suggested_name: &str) -> Result<Value, String> {
    let bytes = BASE64
        .decode(base64_data.trim())
        .map_err(|_| "file.save needs base64 data; feed it a converter's output".to_string())?;
    let path: PathBuf = if crate::runtime::sidecar::panel_available(app) {
        match crate::runtime::sidecar::panel_save_file(app, suggested_name)? {
            Some(path) => PathBuf::from(path),
            None => return Err("Saving was cancelled".to_string()),
        }
    } else {
        let mut dialog = app.dialog().file();
        if !suggested_name.is_empty() {
            dialog = dialog.set_file_name(suggested_name);
        }
        let Some(target) = dialog.blocking_save_file() else {
            return Err("Saving was cancelled".to_string());
        };
        target
            .into_path()
            .map_err(|error| format!("The chosen location has no usable path: {}", error))?
    };
    std::fs::write(&path, &bytes).map_err(|error| format!("Could not save: {}", error))?;
    Ok(json!({
        "saved": true,
        "name": path.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default(),
    }))
}

/// Maps granted tokens to file URLs for the native renderer; the panel gets
/// a URL it can hand PDFKit, AVKit, or AsyncImage.
pub fn token_to_file_url(app: &AppHandle, value: &str) -> Option<String> {
    if !value.starts_with("derfile-") {
        return None;
    }
    let path = app.state::<FileGrants>().path_of(value)?;
    Some(format!("file://{}", path.to_string_lossy()))
}

#[tauri::command]
pub async fn file_pick(app: AppHandle, kind: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || pick_core(&app, kind.as_deref().unwrap_or("")))
        .await
        .map_err(|error| format!("file.pick failed: {}", error))?
}

#[tauri::command]
pub async fn file_read(app: AppHandle, file: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || read_core(&app, &file))
        .await
        .map_err(|error| format!("file.read failed: {}", error))?
}

#[tauri::command]
pub async fn file_save(
    app: AppHandle,
    data: String,
    name: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        save_core(&app, &data, name.as_deref().unwrap_or(""))
    })
    .await
    .map_err(|error| format!("file.save failed: {}", error))?
}
