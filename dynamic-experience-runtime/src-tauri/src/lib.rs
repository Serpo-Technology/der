use std::fs;
use std::collections::HashMap;
use tauri::{Manager, AppHandle, Emitter, menu::{Menu, MenuItem, PredefinedMenuItem}, tray::{TrayIconBuilder, TrayIconEvent}, image::Image};
use serde::{Deserialize, Serialize};
use serde_json::Value;

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
struct OperationImplementation {
    #[serde(rename = "type")]
    impl_type: String,
    endpoint: Option<String>,
    method: Option<String>,
    headers: Option<HashMap<String, String>>,
    code: Option<String>,
    repository_id: Option<String>,
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
async fn execute_operation(request: OperationRequest) -> Result<OperationResult, String> {
    let start_time = std::time::Instant::now();
    
    let result = match request.operation_type.as_str() {
        "remote" => execute_remote_operation(&request).await,
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

async fn execute_remote_operation(request: &OperationRequest) -> Result<Value, String> {
    let endpoint = request.implementation.endpoint
        .as_ref()
        .ok_or("Remote operation missing endpoint")?;
    
    let default_method = "POST".to_string();
    let method = request.implementation.method
        .as_ref()
        .unwrap_or(&default_method);
    
    // For now, return a mock response
    // In a real implementation, this would use reqwest or similar HTTP client
    let mock_response = serde_json::json!({
        "success": true,
        "message": format!("Remote operation {} executed", request.operation_name),
        "endpoint": endpoint,
        "method": method,
        "inputs": request.inputs,
        "timestamp": chrono::Utc::now().to_rfc3339()
    });
    
    // Simulate network delay
    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    
    Ok(mock_response)
}

async fn execute_local_operation(request: &OperationRequest) -> Result<Value, String> {
    let code = request.implementation.code
        .as_ref()
        .ok_or("Local operation missing code")?;
    
    // For security, we'll execute a limited set of predefined local operations
    // In a real implementation, this might use a sandboxed JavaScript engine
    let result = match request.operation_name.as_str() {
        "file_read" => {
            if let Some(path) = request.inputs.get("path") {
                if let Some(path_str) = path.as_str() {
                    match fs::read_to_string(path_str) {
                        Ok(content) => serde_json::json!({
                            "success": true,
                            "content": content,
                            "path": path_str
                        }),
                        Err(e) => return Err(format!("Failed to read file: {}", e)),
                    }
                } else {
                    return Err("Invalid path parameter".to_string());
                }
            } else {
                return Err("Missing path parameter".to_string());
            }
        },
        "file_write" => {
            let path = request.inputs.get("path")
                .and_then(|p| p.as_str())
                .ok_or("Missing or invalid path parameter")?;
            let content = request.inputs.get("content")
                .and_then(|c| c.as_str())
                .ok_or("Missing or invalid content parameter")?;
            
            match fs::write(path, content) {
                Ok(_) => serde_json::json!({
                    "success": true,
                    "message": "File written successfully",
                    "path": path
                }),
                Err(e) => return Err(format!("Failed to write file: {}", e)),
            }
        },
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
    let app_data_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;
    
    let state_dir = app_data_dir.join("experience_states");
    fs::create_dir_all(&state_dir)
        .map_err(|e| format!("Failed to create state directory: {}", e))?;
    
    let state_file = state_dir.join(format!("{}.json", experience_id));
    let state_json = serde_json::to_string_pretty(&state)
        .map_err(|e| format!("Failed to serialize state: {}", e))?;
    
    fs::write(state_file, state_json)
        .map_err(|e| format!("Failed to save experience state: {}", e))
}

#[tauri::command]
async fn load_experience_state(
    app: tauri::AppHandle,
    experience_id: String
) -> Result<Option<Value>, String> {
    let app_data_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;
    
    let state_file = app_data_dir.join("experience_states").join(format!("{}.json", experience_id));
    
    if !state_file.exists() {
        return Ok(None);
    }
    
    let state_json = fs::read_to_string(state_file)
        .map_err(|e| format!("Failed to read experience state: {}", e))?;
    
    let state: Value = serde_json::from_str(&state_json)
        .map_err(|e| format!("Failed to parse experience state: {}", e))?;
    
    Ok(Some(state))
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

fn create_tray_menu(app: &AppHandle) -> Result<Menu<tauri::Wry>, tauri::Error> {
    println!("Creating tray menu items...");
    let show_window = MenuItem::with_id(app, "show_window", "Open DER", true, None::<&str>)?;
    println!("Created show_window menu item");
    let new_experience = MenuItem::with_id(app, "new_experience", "New Experience", true, None::<&str>)?;
    println!("Created new_experience menu item");
    let bookmarks = MenuItem::with_id(app, "bookmarks", "Bookmarked Experiences", true, None::<&str>)?;
    println!("Created bookmarks menu item");
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    println!("Created quit menu item");
    
    let menu = Menu::with_items(app, &[
        &show_window,
        &PredefinedMenuItem::separator(app)?,
        &new_experience,
        &bookmarks,
        &PredefinedMenuItem::separator(app)?,
        &quit,
    ])?;
    println!("Menu created with 6 items (4 menu items + 2 separators)");
    
    Ok(menu)
}

fn handle_tray_event(app: &AppHandle, event: TrayIconEvent) {
    println!("Handling tray event: {:?}", event);
    match event {
        TrayIconEvent::Click { button, .. } => {
            println!("Tray click detected: {:?}", button);
            match button {
                tauri::tray::MouseButton::Left => {
                    println!("Left click - showing main window");
                    // Left click - show main window
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                        println!("Window shown and focused");
                    } else {
                        println!("No main window found!");
                    }
                }
                tauri::tray::MouseButton::Right => {
                    println!("Right click detected - context menu should appear");
                    // Context menu should appear automatically with global menu handler
                }
                _ => {
                    println!("Other button click: {:?}", button);
                }
            }
        }
        TrayIconEvent::Enter { .. } => {
            println!("Mouse entered tray icon area");
        }
        TrayIconEvent::Leave { .. } => {
            println!("Mouse left tray icon area");
        }
        TrayIconEvent::Move { .. } => {
            // Ignore move events to reduce noise
        }
        _ => {
            println!("Other tray event: {:?}", event);
        }
    }
}

fn handle_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    println!("Menu event received: {:?}", event.id);
    match event.id.as_ref() {
        "show_window" => {
            println!("Show window menu item clicked");
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
                println!("Window shown via menu");
            }
        }
        "new_experience" => {
            println!("New experience menu item clicked");
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
                // Emit event to switch to create mode
                let _ = window.emit("navigate-to-create", ());
                println!("Window shown and navigate-to-create event emitted");
            }
        }
        "bookmarks" => {
            println!("Bookmarks menu item clicked");
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
                // Emit event to show bookmarks
                let _ = window.emit("show-bookmarks", ());
                println!("Window shown and show-bookmarks event emitted");
            }
        }
        "quit" => {
            println!("Quit menu item clicked");
            app.exit(0);
        }
        _ => {
            println!("Unknown menu item: {:?}", event.id);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            println!("Setting up application...");
            
            // Create tray menu
            let menu = create_tray_menu(app.handle())?;
            println!("Tray menu created successfully");
            
            // Create tray icon with menu - simple approach
            let _tray = TrayIconBuilder::with_id("main-tray")
                .menu(&menu)
                .tooltip("Dynamic Experience Runtime")
                .build(app)?;
            
            println!("Tray icon created successfully");
            
            // Hide the window on startup - it will be shown via system tray
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.hide();
                println!("Main window hidden");
            } else {
                println!("Warning: No main window found to hide");
            }
            
            Ok(())
        })
        .on_tray_icon_event(handle_tray_event)
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
            save_contract,
            load_contract,
            query_repository,
            show_main_window,
            hide_main_window,
            list_bookmarked_experiences
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

