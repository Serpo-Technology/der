// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Started as the HTTP service, this process serves requests and never
    // becomes the app.
    if dynamic_experience_runtime_lib::secrets::serve_if_asked() {
        return;
    }
    dynamic_experience_runtime_lib::run()
}
