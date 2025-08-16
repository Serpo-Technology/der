use std::fs;
use std::path::Path;
use tauri::Manager;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            read_repository_index,
            write_repository_index,
            read_component_manifest,
            write_component_manifest,
            delete_component_manifest
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
