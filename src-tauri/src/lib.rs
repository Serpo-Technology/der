use std::fs;
use std::collections::HashMap;
use tauri::{Manager, AppHandle, Emitter, menu::{Menu, MenuItem, PredefinedMenuItem}, tray::TrayIconBuilder, webview::WebviewWindowBuilder};
use tauri::utils::config::WebviewUrl;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub mod fragments;
mod llm;
mod oauth;
pub mod runtime;
mod settings;


// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
async fn read_repository_index(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let app_data_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;
    
    let full_path = app_data_dir.join(&path);
    
    fs::read_to_string(full_path)
        .map_err(|e| format!("Failed to read repository index: {}", e))
}

#[tauri::command]
async fn write_repository_index(app: tauri::AppHandle, path: String, data: String) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;
    
    let full_path = app_data_dir.join(&path);
    
    // Create parent directories if they don't exist
    if let Some(parent) = full_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directories: {}", e))?;
    }
    
    fs::write(full_path, data)
        .map_err(|e| format!("Failed to write repository index: {}", e))
}

#[tauri::command]
async fn read_component_manifest(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let app_data_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;
    
    let full_path = app_data_dir.join(&path);
    
    fs::read_to_string(full_path)
        .map_err(|e| format!("Failed to read component manifest: {}", e))
}

#[tauri::command]
async fn write_component_manifest(app: tauri::AppHandle, path: String, data: String) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;
    
    let full_path = app_data_dir.join(&path);
    
    // Create parent directories if they don't exist
    if let Some(parent) = full_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directories: {}", e))?;
    }
    
    fs::write(full_path, data)
        .map_err(|e| format!("Failed to write component manifest: {}", e))
}

#[tauri::command]
async fn delete_component_manifest(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;
    
    let full_path = app_data_dir.join(&path);
    
    // Handle wildcard deletion for versioned components
    if path.contains('*') {
        let parent_dir = full_path.parent()
            .ok_or("Invalid path for wildcard deletion")?;
        
        let pattern = full_path.file_name()
            .and_then(|name| name.to_str())
            .ok_or("Invalid filename pattern")?;
        
        if let Ok(entries) = fs::read_dir(parent_dir) {
            for entry in entries.flatten() {
                let file_name = entry.file_name();
                let file_name_str = file_name.to_string_lossy();
                
                // Simple wildcard matching - replace * with any characters
                let pattern_regex = pattern.replace('*', ".*");
                if regex::Regex::new(&pattern_regex)
                    .map_err(|e| format!("Invalid regex pattern: {}", e))?
                    .is_match(&file_name_str) {
                    fs::remove_file(entry.path())
                        .map_err(|e| format!("Failed to delete file: {}", e))?;
                }
            }
        }
    } else {
        fs::remove_file(full_path)
            .map_err(|e| format!("Failed to delete component manifest: {}", e))?;
    }
    
    Ok(())
}

// Operation execution types
#[derive(Debug, Serialize, Deserialize)]
struct OperationRequest {
    operation_id: String,
    operation_name: String,
    operation_type: String, // "remote", "local", "repository"
    inputs: HashMap<String, Value>,
    implementation: OperationImplementation,
}

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct OperationImplementation {
    #[serde(rename = "type", default)]
    pub(crate) impl_type: String,
    #[serde(default)]
    pub(crate) endpoint: Option<String>,
    #[serde(default)]
    pub(crate) method: Option<String>,
    #[serde(default)]
    pub(crate) headers: Option<HashMap<String, String>>,
    #[serde(default)]
    pub(crate) code: Option<String>,
    #[serde(default)]
    pub(crate) repository_id: Option<String>,
    /// Named integration credential injected at request time; the secret
    /// never appears in the contract.
    #[serde(default)]
    pub(crate) auth: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct OperationResult {
    success: bool,
    data: Option<Value>,
    error: Option<String>,
    execution_time_ms: u64,
}

// Execute operation command
#[tauri::command]
async fn execute_operation(app: tauri::AppHandle, request: OperationRequest) -> Result<OperationResult, String> {
    let start_time = std::time::Instant::now();
    
    let result = match request.operation_type.as_str() {
        "remote" => execute_remote_operation(&app, &request).await,
        "local" => execute_local_operation(&request).await,
        "repository" => execute_repository_operation(&request).await,
        _ => Err(format!("Unknown operation type: {}", request.operation_type)),
    };
    
    let execution_time = start_time.elapsed().as_millis() as u64;
    
    match result {
        Ok(data) => Ok(OperationResult {
            success: true,
            data: Some(data),
            error: None,
            execution_time_ms: execution_time,
        }),
        Err(error) => Ok(OperationResult {
            success: false,
            data: None,
            error: Some(error),
            execution_time_ms: execution_time,
        }),
    }
}

async fn execute_remote_operation(app: &tauri::AppHandle, request: &OperationRequest) -> Result<Value, String> {
    let integrations = settings::load_integrations(app);
    execute_remote_core(&request.inputs, &request.implementation, &integrations).await
}

/// The confined remote HTTP path, shared by the execute_operation command
/// and the runtime session dispatcher. Credential injection and base-URL
/// confinement live here and nowhere else.
pub(crate) async fn execute_remote_core(
    inputs: &HashMap<String, Value>,
    implementation: &OperationImplementation,
    integrations: &settings::StoredIntegrations,
) -> Result<Value, String> {
    let endpoint_template = implementation.endpoint
        .as_ref()
        .ok_or("Remote operation missing endpoint")?;

    let method = implementation.method
        .clone()
        .unwrap_or_else(|| "GET".to_string())
        .to_uppercase();

    // Substitute {name} placeholders from inputs; leftovers travel as query
    // parameters (GET/DELETE) or as a JSON body.
    let mut endpoint = endpoint_template.clone();
    let mut remaining: HashMap<String, Value> = HashMap::new();
    for (name, value) in inputs {
        let placeholder = format!("{{{}}}", name);
        if endpoint.contains(&placeholder) {
            let raw = match value {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            endpoint = endpoint.replace(&placeholder, &raw);
        } else {
            remaining.insert(name.clone(), value.clone());
        }
    }
    if !endpoint.starts_with("http://") && !endpoint.starts_with("https://") {
        return Err(format!("Remote endpoint must be an http(s) URL: {}", endpoint));
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let mut req = match method.as_str() {
        "GET" => client.get(&endpoint),
        "POST" => client.post(&endpoint),
        "PUT" => client.put(&endpoint),
        "PATCH" => client.patch(&endpoint),
        "DELETE" => client.delete(&endpoint),
        other => return Err(format!("Unsupported HTTP method: {}", other)),
    };
    if let Some(headers) = &implementation.headers {
        for (key, value) in headers {
            req = req.header(key, value);
        }
    }
    if let Some(auth_name) = &implementation.auth {
        let credential = integrations.credentials.get(auth_name).ok_or_else(|| {
            format!(
                "No integration credential named \"{}\"; add it in Settings under Integrations",
                auth_name
            )
        })?;
        if let Some(base) = &credential.base_url {
            if !endpoint.starts_with(base.as_str()) {
                return Err(format!(
                    "Credential \"{}\" is confined to {}; refusing to send it to {}",
                    auth_name, base, endpoint
                ));
            }
        }
        match credential.kind.as_str() {
            "bearer" => {
                req = req.header("authorization", format!("Bearer {}", credential.secret));
            }
            "header" => {
                let target = credential.target.clone().unwrap_or_else(|| "x-api-key".to_string());
                req = req.header(target, credential.secret.clone());
            }
            "query" => {
                let target = credential.target.clone().unwrap_or_else(|| "key".to_string());
                req = req.query(&[(target, credential.secret.clone())]);
            }
            other => return Err(format!("Unknown credential kind \"{}\"", other)),
        }
    }
    if method == "GET" || method == "DELETE" {
        let query: Vec<(String, String)> = remaining
            .iter()
            .map(|(k, v)| (
                k.clone(),
                match v {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                },
            ))
            .collect();
        if !query.is_empty() {
            req = req.query(&query);
        }
    } else {
        req = req.json(&remaining);
    }

    let response = req.send().await.map_err(|e| format!("Request failed: {}", e))?;
    let status = response.status();
    let text = response.text().await.map_err(|e| format!("Failed to read response: {}", e))?;
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, text.chars().take(300).collect::<String>()));
    }
    Ok(serde_json::from_str(&text).unwrap_or_else(|_| serde_json::json!({ "raw": text })))
}

async fn execute_local_operation(request: &OperationRequest) -> Result<Value, String> {
    let code = request.implementation.code
        .as_ref()
        .ok_or("Local operation missing code")?;
    
    // For security, we'll execute a limited set of predefined local operations
    // In a real implementation, this might use a sandboxed JavaScript engine
    let result = match request.operation_name.as_str() {
        "system_info" => {
            serde_json::json!({
                "success": true,
                "platform": std::env::consts::OS,
                "arch": std::env::consts::ARCH,
                "timestamp": chrono::Utc::now().to_rfc3339()
            })
        },
        _ => {
            // For other operations, return a generic success response
            serde_json::json!({
                "success": true,
                "message": format!("Local operation {} executed", request.operation_name),
                "code_preview": &code[..std::cmp::min(100, code.len())],
                "inputs": request.inputs
            })
        }
    };
    
    Ok(result)
}

async fn execute_repository_operation(request: &OperationRequest) -> Result<Value, String> {
    let repository_id = request.implementation.repository_id
        .as_ref()
        .ok_or("Repository operation missing repository ID")?;
    
    // Mock repository operation execution
    // In a real implementation, this would load the operation from the repository
    // and execute it in a controlled environment
    let mock_response = serde_json::json!({
        "success": true,
        "message": format!("Repository operation {} executed", request.operation_name),
        "repository_id": repository_id,
        "inputs": request.inputs,
        "timestamp": chrono::Utc::now().to_rfc3339()
    });
    
    // Simulate processing time
    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
    
    Ok(mock_response)
}

// Save and load experience state
#[tauri::command]
async fn save_experience_state(
    app: tauri::AppHandle,
    experience_id: String,
    state: Value
) -> Result<(), String> {
    write_experience_state_file(&app, &experience_id, &state)
}

/// Per-app state file write, shared by the webview save command and the
/// native panel bridge.
pub(crate) fn write_experience_state_file(
    app: &AppHandle,
    experience_id: &str,
    state: &Value,
) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    let state_dir = app_data_dir.join("experience_states");
    fs::create_dir_all(&state_dir)
        .map_err(|e| format!("Failed to create state directory: {}", e))?;

    let state_file = state_dir.join(format!("{}.json", experience_id));
    let state_json = serde_json::to_string_pretty(state)
        .map_err(|e| format!("Failed to serialize state: {}", e))?;

    fs::write(state_file, state_json)
        .map_err(|e| format!("Failed to save experience state: {}", e))
}

/// Native mode: experiences open in native panel windows by default and the
/// panel shows DER's home. DER_NATIVE_MODE decides when set (1 turns it on,
/// anything else off), the --native argument turns it on, and a packaged
/// build with the panel in its bundle runs native-first out of the box.
pub(crate) fn native_mode() -> bool {
    if let Ok(value) = std::env::var("DER_NATIVE_MODE") {
        return value == "1";
    }
    if std::env::args().any(|argument| argument == "--native") {
        return true;
    }
    !cfg!(debug_assertions) && runtime::sidecar::bundled_panel().is_some()
}

#[tauri::command]
fn runtime_native_mode() -> bool {
    native_mode()
}

fn read_experience_state(app: &AppHandle, experience_id: &str) -> Option<Value> {
    let app_data_dir = app.path().app_data_dir().ok()?;
    let state_file = app_data_dir
        .join("experience_states")
        .join(format!("{}.json", experience_id));
    let state_json = fs::read_to_string(state_file).ok()?;
    serde_json::from_str(&state_json).ok()
}

#[tauri::command]
async fn load_experience_state(
    app: tauri::AppHandle,
    experience_id: String
) -> Result<Option<Value>, String> {
    Ok(read_experience_state(&app, &experience_id))
}

// Save full experience (contract + state + metadata)
#[tauri::command]
async fn save_experience(
    app: tauri::AppHandle,
    experience_id: String,
    contract: Value,
    state: Value,
    metadata: Option<Value>
) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    let experiences_dir = app_data_dir.join("experiences");
    fs::create_dir_all(&experiences_dir)
        .map_err(|e| format!("Failed to create experiences directory: {}", e))?;

    let experience_file = experiences_dir.join(format!("{}.json", experience_id));
    let mut obj = serde_json::Map::new();
    obj.insert("experienceId".to_string(), Value::String(experience_id));
    obj.insert("contract".to_string(), contract);
    obj.insert("state".to_string(), state);
    obj.insert("metadata".to_string(), metadata.unwrap_or_else(|| serde_json::json!({})));

    let json = serde_json::to_string_pretty(&Value::Object(obj))
        .map_err(|e| format!("Failed to serialize experience: {}", e))?;

    fs::write(experience_file, json)
        .map_err(|e| format!("Failed to save experience: {}", e))
}

// Load full experience
#[tauri::command]
async fn load_experience(
    app: tauri::AppHandle,
    experience_id: String
) -> Result<Option<Value>, String> {
    let app_data_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    let experience_file = app_data_dir.join("experiences").join(format!("{}.json", experience_id));

    if !experience_file.exists() {
        return Ok(None);
    }

    let json = fs::read_to_string(experience_file)
        .map_err(|e| format!("Failed to read experience: {}", e))?;
    let value: Value = serde_json::from_str(&json)
        .map_err(|e| format!("Failed to parse experience: {}", e))?;
    Ok(Some(value))
}

// Bookmark data structures
#[derive(Debug, Serialize, Deserialize)]
struct BookmarkedExperience {
    id: String,
    name: String,
    description: Option<String>,
    contract: Value,
    created_at: String,
    last_accessed_at: String,
    tags: Option<Vec<String>>,
    thumbnail: Option<String>,
}

/// Share envelope wire format: camelCase keys with absent (never null)
/// optional fields, matching the webview's types. Reading tolerates the
/// legacy snake_case date keys so exports from older builds still import.
#[derive(Debug, Serialize, Deserialize)]
struct ShareableContract {
    contract: Value,
    metadata: ShareMetadata,
    #[serde(default = "default_share_version")]
    version: String,
    #[serde(default)]
    checksum: String,
}

fn default_share_version() -> String {
    "1.0.0".to_string()
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShareMetadata {
    title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    author: Option<String>,
    #[serde(alias = "created_at")]
    created_at: String,
    #[serde(alias = "shared_at")]
    shared_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tags: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    category: Option<String>,
}

// Bookmark experience
#[tauri::command]
async fn bookmark_experience(
    app: tauri::AppHandle,
    experience_id: String,
    name: String,
    description: Option<String>,
    contract: Value,
    tags: Option<Vec<String>>
) -> Result<String, String> {
    let app_data_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;
    
    let bookmarks_dir = app_data_dir.join("bookmarks");
    fs::create_dir_all(&bookmarks_dir)
        .map_err(|e| format!("Failed to create bookmarks directory: {}", e))?;
    
    let now = chrono::Utc::now().to_rfc3339();
    let bookmark = BookmarkedExperience {
        id: experience_id.clone(),
        name,
        description,
        contract,
        created_at: now.clone(),
        last_accessed_at: now,
        tags,
        thumbnail: None,
    };
    
    let bookmark_file = bookmarks_dir.join(format!("{}.json", experience_id));
    let bookmark_json = serde_json::to_string_pretty(&bookmark)
        .map_err(|e| format!("Failed to serialize bookmark: {}", e))?;
    
    fs::write(bookmark_file, bookmark_json)
        .map_err(|e| format!("Failed to save bookmark: {}", e))?;

    // Every creator (direct, import, duplicate) lands here, so the tray
    // reflects new apps immediately.
    rebuild_tray_menu(&app);
    Ok(experience_id)
}

// Load bookmarked experience
#[tauri::command]
async fn load_bookmarked_experience(
    app: tauri::AppHandle,
    experience_id: String
) -> Result<Option<Value>, String> {
    let app_data_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;
    
    let bookmark_file = app_data_dir.join("bookmarks").join(format!("{}.json", experience_id));
    
    if !bookmark_file.exists() {
        return Ok(None);
    }
    
    let bookmark_json = fs::read_to_string(bookmark_file)
        .map_err(|e| format!("Failed to read bookmark: {}", e))?;
    
    let mut bookmark: BookmarkedExperience = serde_json::from_str(&bookmark_json)
        .map_err(|e| format!("Failed to parse bookmark: {}", e))?;
    
    // Update last accessed time
    bookmark.last_accessed_at = chrono::Utc::now().to_rfc3339();
    
    // Save updated bookmark
    let updated_json = serde_json::to_string_pretty(&bookmark)
        .map_err(|e| format!("Failed to serialize updated bookmark: {}", e))?;
    
    let bookmark_file = app_data_dir.join("bookmarks").join(format!("{}.json", experience_id));
    fs::write(bookmark_file, updated_json)
        .map_err(|e| format!("Failed to update bookmark: {}", e))?;
    
    Ok(Some(serde_json::to_value(bookmark).unwrap()))
}

// List all bookmarked experiences
#[tauri::command]
async fn list_bookmarked_experiences_detailed(app: AppHandle) -> Result<Vec<Value>, String> {
    let experiences = read_bookmarks(&app)
        .into_iter()
        .map(|bookmark| {
            serde_json::json!({
                "id": bookmark.id,
                "name": bookmark.name,
                "description": bookmark.description,
                "createdAt": bookmark.created_at,
                "lastAccessedAt": bookmark.last_accessed_at,
                "tags": bookmark.tags,
                "thumbnail": bookmark.thumbnail
            })
        })
        .collect();
    Ok(experiences)
}

/// Reads every bookmark record, most recently accessed first.
fn read_bookmarks(app: &AppHandle) -> Vec<BookmarkedExperience> {
    let Ok(app_data_dir) = app.path().app_data_dir() else {
        return Vec::new();
    };
    let bookmarks_dir = app_data_dir.join("bookmarks");
    let mut bookmarks: Vec<BookmarkedExperience> = Vec::new();

    if let Ok(entries) = fs::read_dir(bookmarks_dir) {
        for entry in entries.flatten() {
            if entry.path().extension().map(|ext| ext == "json").unwrap_or(false) {
                if let Ok(content) = fs::read_to_string(entry.path()) {
                    if let Ok(bookmark) = serde_json::from_str::<BookmarkedExperience>(&content) {
                        bookmarks.push(bookmark);
                    }
                }
            }
        }
    }

    bookmarks.sort_by(|a, b| b.last_accessed_at.cmp(&a.last_accessed_at));
    bookmarks
}

// Delete bookmarked experience
#[tauri::command]
async fn delete_bookmarked_experience(
    app: tauri::AppHandle,
    experience_id: String
) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;
    
    let bookmark_file = app_data_dir.join("bookmarks").join(format!("{}.json", experience_id));

    if bookmark_file.exists() {
        fs::remove_file(bookmark_file)
            .map_err(|e| format!("Failed to delete bookmark: {}", e))?;
    }

    // The app's saved state goes with it.
    let state_file = app_data_dir
        .join("experience_states")
        .join(format!("{}.json", experience_id));
    if state_file.exists() {
        let _ = fs::remove_file(state_file);
    }

    rebuild_tray_menu(&app);
    Ok(())
}

// Generate checksum for contract
fn generate_checksum(data: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    
    let mut hasher = DefaultHasher::new();
    data.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

// Share experience
#[tauri::command]
async fn share_experience(
    app: tauri::AppHandle,
    experience_id: String,
    title: String,
    description: Option<String>,
    author: Option<String>,
    tags: Option<Vec<String>>,
    category: Option<String>
) -> Result<Value, String> {
    // Load the bookmarked experience
    let bookmark_result = load_bookmarked_experience(app.clone(), experience_id.clone()).await?;
    let bookmark = bookmark_result.ok_or("Experience not found")?;
    
    let contract = bookmark.get("contract")
        .ok_or("Contract not found in bookmark")?
        .clone();
    
    let now = chrono::Utc::now().to_rfc3339();
    let metadata = ShareMetadata {
        title: title.clone(),
        description,
        author,
        created_at: bookmark.get("createdAt")
            .and_then(|t| t.as_str())
            .unwrap_or(&now)
            .to_string(),
        shared_at: now,
        tags,
        category,
    };
    
    let contract_json = serde_json::to_string(&contract)
        .map_err(|e| format!("Failed to serialize contract: {}", e))?;
    
    let checksum = generate_checksum(&contract_json);
    
    let shareable = ShareableContract {
        contract,
        metadata,
        version: "1.0.0".to_string(),
        checksum,
    };
    
    Ok(serde_json::to_value(shareable).unwrap())
}

// Import shared experience
#[tauri::command]
async fn import_shared_experience(
    app: tauri::AppHandle,
    shareable_contract: Value
) -> Result<Value, String> {
    let shareable: ShareableContract = serde_json::from_value(shareable_contract)
        .map_err(|e| format!("Failed to parse shareable contract: {}", e))?;

    // The webview validates and normalizes the contract against the
    // installed parts before invoking this command; comparing a checksum
    // against re-serialized JSON here would reject every legitimate
    // re-encoding of the same contract.

    // Generate new experience ID
    let experience_id = format!("imported-{}", uuid::Uuid::new_v4().to_string());
    
    // Create bookmark from imported experience
    let bookmark_result = bookmark_experience(
        app,
        experience_id.clone(),
        shareable.metadata.title,
        shareable.metadata.description,
        shareable.contract,
        shareable.metadata.tags
    ).await?;
    
    Ok(serde_json::json!({
        "success": true,
        "experienceId": bookmark_result,
        "message": "Experience imported successfully"
    }))
}

// Duplicate experience
#[tauri::command]
async fn duplicate_experience(
    app: tauri::AppHandle,
    experience_id: String,
    new_name: Option<String>
) -> Result<String, String> {
    // Load the original experience
    let bookmark_result = load_bookmarked_experience(app.clone(), experience_id.clone()).await?;
    let bookmark = bookmark_result.ok_or("Experience not found")?;
    
    let original_name = bookmark.get("name")
        .and_then(|n| n.as_str())
        .unwrap_or("Unnamed");
    
    let duplicate_name = new_name.unwrap_or_else(|| format!("{} (Copy)", original_name));
    let duplicate_id = format!("dup-{}", uuid::Uuid::new_v4().to_string());
    
    let contract = bookmark.get("contract")
        .ok_or("Contract not found in bookmark")?
        .clone();
    
    let description = bookmark.get("description")
        .and_then(|d| d.as_str())
        .map(|s| s.to_string());
    
    let tags = bookmark.get("tags")
        .and_then(|t| t.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect());
    
    // Create new bookmark
    bookmark_experience(
        app,
        duplicate_id.clone(),
        duplicate_name,
        description,
        contract,
        tags
    ).await?;
    
    Ok(duplicate_id)
}

// (SQLite is initialized via the JS plugin on first use.)

// Update experience with versioning
#[derive(Debug, Serialize, Deserialize)]
struct ExperienceVersion {
    version: u32,
    contract: Value,
    blueprint: Option<Value>,
    created_at: String,
    changes_summary: Option<String>,
}

#[tauri::command]
async fn update_experience(
    app: tauri::AppHandle,
    experience_id: String,
    new_contract: Option<Value>,
    new_blueprint: Option<Value>,
    _preserve_user_edits: bool,
    changes_summary: Option<String>
) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;
    
    // Load current bookmark
    let bookmark_result = load_bookmarked_experience(app.clone(), experience_id.clone()).await?;
    let mut bookmark_value = bookmark_result.ok_or("Experience not found")?;
    
    // Create versions directory
    let versions_dir = app_data_dir.join("versions").join(&experience_id);
    fs::create_dir_all(&versions_dir)
        .map_err(|e| format!("Failed to create versions directory: {}", e))?;
    
    // Get current version number
    let mut current_version = 1u32;
    if let Ok(entries) = fs::read_dir(&versions_dir) {
        for entry in entries.flatten() {
            if let Some(file_name) = entry.file_name().to_str() {
                if let Some(version_str) = file_name.strip_suffix(".json") {
                    if let Ok(version) = version_str.parse::<u32>() {
                        current_version = current_version.max(version + 1);
                    }
                }
            }
        }
    }
    
    // Save current state as a version
    let current_contract = bookmark_value.get("contract").cloned().unwrap_or(serde_json::Value::Null);
    let version = ExperienceVersion {
        version: current_version - 1,
        contract: current_contract,
        blueprint: None, // Will be populated when blueprint support is added
        created_at: chrono::Utc::now().to_rfc3339(),
        changes_summary: Some("Previous version before update".to_string()),
    };
    
    let version_file = versions_dir.join(format!("{}.json", current_version - 1));
    let version_json = serde_json::to_string_pretty(&version)
        .map_err(|e| format!("Failed to serialize version: {}", e))?;
    
    fs::write(version_file, version_json)
        .map_err(|e| format!("Failed to save version: {}", e))?;
    
    // Update bookmark with new data
    if let Some(contract) = new_contract {
        if let Some(bookmark_obj) = bookmark_value.as_object_mut() {
            bookmark_obj.insert("contract".to_string(), contract);
        }
    }
    
    // Update last accessed time
    if let Some(bookmark_obj) = bookmark_value.as_object_mut() {
        bookmark_obj.insert("last_accessed_at".to_string(), 
            serde_json::Value::String(chrono::Utc::now().to_rfc3339()));
    }
    
    // Save updated bookmark
    let bookmark_file = app_data_dir.join("bookmarks").join(format!("{}.json", experience_id));
    let bookmark_json = serde_json::to_string_pretty(&bookmark_value)
        .map_err(|e| format!("Failed to serialize updated bookmark: {}", e))?;
    
    fs::write(bookmark_file, bookmark_json)
        .map_err(|e| format!("Failed to save updated bookmark: {}", e))?;
    
    // Save new version
    let new_version = ExperienceVersion {
        version: current_version,
        contract: bookmark_value.get("contract").cloned().unwrap_or(serde_json::Value::Null),
        blueprint: new_blueprint,
        created_at: chrono::Utc::now().to_rfc3339(),
        changes_summary,
    };
    
    let new_version_file = versions_dir.join(format!("{}.json", current_version));
    let new_version_json = serde_json::to_string_pretty(&new_version)
        .map_err(|e| format!("Failed to serialize new version: {}", e))?;
    
    fs::write(new_version_file, new_version_json)
        .map_err(|e| format!("Failed to save new version: {}", e))?;
    
    Ok(())
}

// Get experience versions
#[tauri::command]
async fn get_experience_versions(
    app: tauri::AppHandle,
    experience_id: String
) -> Result<Vec<Value>, String> {
    let app_data_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;
    
    let versions_dir = app_data_dir.join("versions").join(&experience_id);
    let mut versions = Vec::new();
    
    if versions_dir.exists() {
        if let Ok(entries) = fs::read_dir(versions_dir) {
            for entry in entries.flatten() {
                if let Some(extension) = entry.path().extension() {
                    if extension == "json" {
                        if let Ok(content) = fs::read_to_string(entry.path()) {
                            if let Ok(version) = serde_json::from_str::<ExperienceVersion>(&content) {
                                versions.push(serde_json::json!({
                                    "version": version.version,
                                    "createdAt": version.created_at,
                                    "changesSummary": version.changes_summary
                                }));
                            }
                        }
                    }
                }
            }
        }
    }
    
    // Sort by version number
    versions.sort_by(|a, b| {
        let a_version = a.get("version").and_then(|v| v.as_u64()).unwrap_or(0);
        let b_version = b.get("version").and_then(|v| v.as_u64()).unwrap_or(0);
        b_version.cmp(&a_version) // Descending order (newest first)
    });
    
    Ok(versions)
}

// Restore experience to specific version
#[tauri::command]
async fn restore_experience_version(
    app: tauri::AppHandle,
    experience_id: String,
    version: u32
) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;
    
    let version_file = app_data_dir.join("versions").join(&experience_id).join(format!("{}.json", version));
    
    if !version_file.exists() {
        return Err(format!("Version {} not found", version));
    }
    
    let version_json = fs::read_to_string(version_file)
        .map_err(|e| format!("Failed to read version: {}", e))?;
    
    let version_data: ExperienceVersion = serde_json::from_str(&version_json)
        .map_err(|e| format!("Failed to parse version: {}", e))?;
    
    // Update the experience with the version data
    update_experience(
        app,
        experience_id,
        Some(version_data.contract),
        version_data.blueprint,
        false,
        Some(format!("Restored to version {}", version))
    ).await
}

// Save and load contracts
#[tauri::command]
async fn save_contract(
    app: tauri::AppHandle,
    contract: Value
) -> Result<String, String> {
    let contract_id = contract.get("name")
        .and_then(|n| n.as_str())
        .unwrap_or("unnamed")
        .to_string();
    
    let app_data_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;
    
    let contracts_dir = app_data_dir.join("contracts");
    fs::create_dir_all(&contracts_dir)
        .map_err(|e| format!("Failed to create contracts directory: {}", e))?;
    
    let contract_file = contracts_dir.join(format!("{}.json", contract_id));
    let contract_json = serde_json::to_string_pretty(&contract)
        .map_err(|e| format!("Failed to serialize contract: {}", e))?;
    
    fs::write(contract_file, contract_json)
        .map_err(|e| format!("Failed to save contract: {}", e))?;
    
    Ok(contract_id)
}

#[tauri::command]
async fn load_contract(
    app: tauri::AppHandle,
    contract_id: String
) -> Result<Option<Value>, String> {
    let app_data_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;
    
    let contract_file = app_data_dir.join("contracts").join(format!("{}.json", contract_id));
    
    if !contract_file.exists() {
        return Ok(None);
    }
    
    let contract_json = fs::read_to_string(contract_file)
        .map_err(|e| format!("Failed to read contract: {}", e))?;
    
    let contract: Value = serde_json::from_str(&contract_json)
        .map_err(|e| format!("Failed to parse contract: {}", e))?;
    
    Ok(Some(contract))
}

// Query repository for components
#[tauri::command]
async fn query_repository(
    _app: tauri::AppHandle,
    criteria: Value
) -> Result<Vec<Value>, String> {
    // Mock repository query
    // In a real implementation, this would search the component repository
    let mock_components = vec![
        serde_json::json!({
            "id": "button-component",
            "name": "Button",
            "type": "ui-element",
            "version": "1.0.0",
            "capabilities": ["clickable", "styled"],
            "description": "Standard button component"
        }),
        serde_json::json!({
            "id": "input-component",
            "name": "Input",
            "type": "ui-element", 
            "version": "1.0.0",
            "capabilities": ["text-input", "validation"],
            "description": "Text input component"
        }),
        serde_json::json!({
            "id": "api-fetch-operation",
            "name": "API Fetch",
            "type": "operation",
            "version": "1.0.0",
            "capabilities": ["http-request", "json-parsing"],
            "description": "Fetch data from remote API"
        })
    ];
    
    // Simple filtering based on criteria
    let filtered_components: Vec<Value> = if let Some(component_type) = criteria.get("type") {
        mock_components.into_iter()
            .filter(|comp| comp.get("type") == Some(component_type))
            .collect()
    } else {
        mock_components
    };
    
    Ok(filtered_components)
}

// System tray commands
#[tauri::command]
async fn show_main_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn hide_main_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn list_bookmarked_experiences(app: AppHandle) -> Result<Vec<Value>, String> {
    let app_data_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;
    
    let contracts_dir = app_data_dir.join("contracts");
    let mut experiences = Vec::new();
    
    if contracts_dir.exists() {
        if let Ok(entries) = fs::read_dir(contracts_dir) {
            for entry in entries.flatten() {
                if let Some(extension) = entry.path().extension() {
                    if extension == "json" {
                        if let Ok(content) = fs::read_to_string(entry.path()) {
                            if let Ok(contract) = serde_json::from_str::<Value>(&content) {
                                experiences.push(serde_json::json!({
                                    "id": entry.file_name().to_string_lossy().trim_end_matches(".json"),
                                    "name": contract.get("name").unwrap_or(&serde_json::Value::String("Unnamed".to_string())),
                                    "description": contract.get("metadata").and_then(|m| m.get("description")).unwrap_or(&serde_json::Value::String("No description".to_string())),
                                    "lastModified": contract.get("metadata").and_then(|m| m.get("updatedAt")).unwrap_or(&serde_json::Value::String("Unknown".to_string()))
                                }));
                            }
                        }
                    }
                }
            }
        }
    }
    
    Ok(experiences)
}

const TRAY_APP_LIMIT: usize = 12;

fn truncate_label(name: &str, max: usize) -> String {
    if name.chars().count() <= max {
        name.to_string()
    } else {
        let cut: String = name.chars().take(max.saturating_sub(3)).collect();
        format!("{}...", cut.trim_end())
    }
}

fn create_tray_menu(app: &AppHandle) -> Result<Menu<tauri::Wry>, tauri::Error> {
    let show_window = MenuItem::with_id(app, "show_window", "Open DER", true, None::<&str>)?;
    let new_experience = MenuItem::with_id(app, "new_experience", "New Experience", true, None::<&str>)?;
    let bookmarks = MenuItem::with_id(app, "bookmarks", "Bookmarked Experiences", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[
        &show_window,
        &PredefinedMenuItem::separator(app)?,
        &new_experience,
    ])?;

    // The user's saved apps, most recently used first.
    let apps: Vec<BookmarkedExperience> = read_bookmarks(app)
        .into_iter()
        .take(TRAY_APP_LIMIT)
        .collect();
    if !apps.is_empty() {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
        for bookmark in &apps {
            let item = MenuItem::with_id(
                app,
                format!("bookmark:{}", bookmark.id),
                truncate_label(&bookmark.name, 40),
                true,
                None::<&str>,
            )?;
            menu.append(&item)?;
        }
    }

    menu.append(&bookmarks)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&quit)?;

    Ok(menu)
}

/// Rebuilds the tray menu so it reflects the current bookmarks.
fn rebuild_tray_menu(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id("main") {
        match create_tray_menu(app) {
            Ok(menu) => {
                let _ = tray.set_menu(Some(menu));
            }
            Err(e) => eprintln!("Failed to rebuild tray menu: {}", e),
        }
    }
    // The native home lists the same bookmarks; keep it current too.
    runtime::sidecar::refresh_native_home(app);
}

#[tauri::command]
async fn refresh_tray_menu(app: AppHandle) -> Result<(), String> {
    rebuild_tray_menu(&app);
    Ok(())
}

// No explicit tray click handler required; menu shows via macOS left click automatically

fn handle_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    // Native mode has one front door: every tray surface is the native
    // home (create prompt and the app list live there); the webview main
    // window stays a management console reached from the home.
    if native_mode() {
        match event.id.as_ref() {
            "show_window" | "new_experience" | "bookmarks" => {
                runtime::sidecar::show_native_home(app);
                return;
            }
            _ => {}
        }
    }
    match event.id.as_ref() {
        "show_window" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        "new_experience" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
                // Emit event to switch to create mode
                let _ = window.emit("navigate-to-create", ());
            }
        }
        "bookmarks" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
                // Emit event to show bookmarks
                let _ = window.emit("show-bookmarks", ());
            }
        }
        "quit" => {
            app.exit(0);
        }
        id if id.starts_with("bookmark:") => {
            let bookmark_id = id.trim_start_matches("bookmark:").to_string();
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                match load_bookmarked_experience(app.clone(), bookmark_id.clone()).await {
                    Ok(Some(bookmark)) => {
                        let contract = bookmark.get("contract").cloned().unwrap_or(Value::Null);
                        let title = bookmark
                            .get("name")
                            .and_then(|n| n.as_str())
                            .map(|s| s.to_string());
                        if let Err(e) =
                            open_experience_window_impl(&app, &bookmark_id, contract, title, false)
                        {
                            eprintln!("Failed to open app window for {}: {}", bookmark_id, e);
                        }
                    }
                    Ok(None) => eprintln!("Bookmark {} not found", bookmark_id),
                    Err(e) => eprintln!("Failed to load bookmark {}: {}", bookmark_id, e),
                }
            });
        }
        _ => {}
    }
}

/// Opens (or focuses) the OS window for an experience, injecting the contract
/// and any previously saved per-app state into the webview bootstrap.
fn open_experience_window_impl(
    app: &AppHandle,
    experience_id: &str,
    contract: Value,
    title: Option<String>,
    assembling: bool,
) -> Result<(), String> {
    if native_mode() {
        // Streaming assembly drafts render natively too: each call lands the
        // grown display contract in the experience's assembly window.
        if assembling {
            let window_title = title.unwrap_or_else(|| "Assembling".to_string());
            return runtime::sidecar::show_assembly_preview(
                app,
                experience_id,
                contract,
                &window_title,
            );
        }
        let saved_state = read_experience_state(app, experience_id);
        return runtime::sidecar::open_native_for_experience(
            app,
            experience_id,
            contract,
            title,
            saved_state,
        );
    }
    let label = format!("exp-{}", experience_id);
    if let Some(existing) = app.get_webview_window(&label) {
        existing.show().map_err(|e| e.to_string())?;
        existing.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let saved_state = read_experience_state(app, experience_id).unwrap_or(Value::Null);
    let bootstrap = serde_json::json!({
        "experienceId": experience_id,
        "contract": contract,
        "state": saved_state,
        "assembling": assembling
    });
    let init_script = format!("window.__DER_BOOTSTRAP = {};", bootstrap);

    let mut builder = WebviewWindowBuilder::new(
        app,
        label,
        WebviewUrl::App("index.html".into())
    )
    .initialization_script(&init_script)
    .inner_size(900.0, 700.0)
    .visible(true);

    if let Some(t) = title {
        builder = builder.title(&t);
    }

    builder.build().map_err(|e| e.to_string())?;
    Ok(())
}

// Open an OS window for a specific experience id with an initial contract
#[tauri::command]
async fn open_experience_window(
    app: AppHandle,
    experience_id: String,
    contract: Value,
    title: Option<String>,
    assembling: Option<bool>
) -> Result<(), String> {
    open_experience_window_impl(&app, &experience_id, contract, title, assembling.unwrap_or(false))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(oauth::PendingOauth::default())
        .manage(fragments::FragmentsState::new())
        .manage(runtime::sessions::RuntimeSessionsState::default())
        .manage(runtime::sidecar::NativeRendererState::default())
        .setup(|app| {
            if native_mode() {
                runtime::sidecar::show_native_home(app.handle());
            }

            // Create tray menu
            let menu = create_tray_menu(app.handle())?;

            // On macOS with config-based tray, an icon with id "main" is created.
            // Attach our menu to it if present; otherwise, create a new tray with id "main".
            if let Some(tray) = app.tray_by_id("main") {
                let _ = tray.set_menu(Some(menu));
                let _ = tray.set_show_menu_on_left_click(true);
                let _ = tray.set_tooltip(Some("Dynamic Experience Runtime"));
            } else {
                let _tray = TrayIconBuilder::with_id("main")
                    .menu(&menu)
                    .show_menu_on_left_click(true)
                    .tooltip("Dynamic Experience Runtime")
                    .build(app)?;
            }
            
            // Hide the window on startup - it will be shown via system tray
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.hide();
            }
            
            Ok(())
        })
        // rely on native tray menu behavior; no custom tray click handler
        .on_menu_event(handle_menu_event)
        .invoke_handler(tauri::generate_handler![
            greet,
            read_repository_index,
            write_repository_index,
            read_component_manifest,
            write_component_manifest,
            delete_component_manifest,
            execute_operation,
            save_experience_state,
            load_experience_state,
            save_experience,
            load_experience,
            save_contract,
            load_contract,
            query_repository,
            show_main_window,
            hide_main_window,
            list_bookmarked_experiences,
            bookmark_experience,
            load_bookmarked_experience,
            list_bookmarked_experiences_detailed,
            delete_bookmarked_experience,
            share_experience,
            import_shared_experience,
            duplicate_experience,
            update_experience,
            get_experience_versions,
            restore_experience_version,
            open_experience_window,
            refresh_tray_menu,
            fragments::stage_fragment,
            fragments::fetch_registry_index,
            fragments::execute_part_remote,
            fragments::set_part_credential,
            fragments::list_part_credentials,
            fragments::download_registry_bundle,
            fragments::commit_fragment,
            fragments::remove_fragment,
            fragments::replace_publisher_key,
            fragments::list_fragments,
            fragments::execute_fragment,
            llm::llm_chat,
            llm::llm_chat_stream,
            settings::get_llm_settings,
            settings::list_integration_credentials,
            settings::set_integration_credential,
            settings::delete_integration_credential,
            settings::set_llm_settings,
            settings::set_llm_credential,
            settings::clear_llm_credential,
            oauth::claude_oauth_start,
            oauth::claude_oauth_finish,
            runtime::sessions::runtime_open_session,
            runtime::sessions::runtime_resolve_view,
            runtime::sessions::runtime_set_element,
            runtime::sessions::runtime_dispatch_event,
            runtime::sessions::runtime_close_session,
            runtime::sessions::runtime_compose,
            runtime::sidecar::open_native_experience_window,
            runtime::sidecar::native_update_experience_contract,
            runtime::sidecar::native_generation_status,
            runtime_native_mode
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Reopen { .. } = event {
                if native_mode() {
                    runtime::sidecar::show_native_home(app);
                } else if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        });
}

#[cfg(test)]
mod share_wire_tests {
    use super::ShareableContract;

    // Exactly the envelope the webview sends on import (hydrated camelCase
    // metadata, dates as ISO strings, empty checksum for bare pastes); the
    // matching TypeScript assertion lives in the PersistenceService tests.
    #[test]
    fn accepts_the_webview_import_payload() {
        let payload = serde_json::json!({
            "contract": { "name": "counter", "elements": [], "operations": [] },
            "metadata": {
                "title": "Click Counter",
                "createdAt": "2026-07-20T10:00:00.000Z",
                "sharedAt": "2026-07-23T09:30:00.000Z"
            },
            "version": "1.0.0",
            "checksum": ""
        });
        let parsed: ShareableContract = serde_json::from_value(payload).expect("parses");
        assert_eq!(parsed.metadata.title, "Click Counter");
        assert_eq!(parsed.metadata.created_at, "2026-07-20T10:00:00.000Z");
        assert!(parsed.metadata.description.is_none());
    }

    // Exports from older builds carried snake_case date keys and nulls for
    // absent options; they must keep importing.
    #[test]
    fn accepts_the_legacy_export_shape() {
        let payload = serde_json::json!({
            "contract": { "name": "counter", "elements": [], "operations": [] },
            "metadata": {
                "title": "My Counter",
                "description": null,
                "author": null,
                "created_at": "2026-07-20T10:00:00.000000+00:00",
                "shared_at": "2026-07-23T09:30:00.000000+00:00",
                "tags": null,
                "category": null
            },
            "version": "1.0.0",
            "checksum": "1a2b3c"
        });
        let parsed: ShareableContract = serde_json::from_value(payload).expect("parses");
        assert_eq!(parsed.metadata.shared_at, "2026-07-23T09:30:00.000000+00:00");
        assert!(parsed.metadata.tags.is_none());
    }

    // New exports write the canonical shape: camelCase keys, no null fields.
    #[test]
    fn serializes_camel_case_without_nulls() {
        let shareable = ShareableContract {
            contract: serde_json::json!({ "name": "counter" }),
            metadata: super::ShareMetadata {
                title: "My Counter".to_string(),
                description: None,
                author: None,
                created_at: "2026-07-20T10:00:00Z".to_string(),
                shared_at: "2026-07-23T09:30:00Z".to_string(),
                tags: None,
                category: None,
            },
            version: "1.0.0".to_string(),
            checksum: "1a2b3c".to_string(),
        };
        let value = serde_json::to_value(&shareable).expect("serializes");
        let metadata = value.get("metadata").unwrap().as_object().unwrap();
        assert!(metadata.contains_key("createdAt"));
        assert!(metadata.contains_key("sharedAt"));
        assert!(!metadata.contains_key("created_at"));
        assert!(!metadata.contains_key("description"));
        assert!(!metadata.values().any(|v| v.is_null()));
    }
}

