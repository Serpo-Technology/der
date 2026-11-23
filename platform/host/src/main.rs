// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Started as one of the host's services, this process serves requests
    // and never becomes the app.
    if dynamic_experience_runtime_lib::services::serve_if_asked() {
        return;
    }
    dynamic_experience_runtime_lib::run()
}
