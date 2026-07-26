//! Native management surfaces: settings and parts snapshots for the panel,
//! and the actions it sends back. Pure plumbing over the existing settings,
//! oauth, and fragments cores; the same rules and reviews apply as in the
//! webview console, and secrets flow one way (in), never back out
//! unredacted.

use serde_json::{json, Map, Value};
use tauri::Manager;

use super::compose;
use super::sessions::compose_vocabulary;
use super::sidecar;

fn registry_url_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("settings").join("registry.json"))
}

fn load_registry_url(app: &tauri::AppHandle) -> Option<String> {
    let path = registry_url_path(app)?;
    let raw = std::fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&raw).ok()?;
    value
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .map(str::to_string)
}

fn save_registry_url(app: &tauri::AppHandle, url: &str) {
    let Some(path) = registry_url_path(app) else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, json!({ "url": url }).to_string());
}

/// The webview's version ordering: dotted segments compared numerically.
fn version_newer(a: &str, b: &str) -> bool {
    let parse = |text: &str| -> Vec<i64> {
        text.split('.')
            .map(|segment| segment.parse::<i64>().unwrap_or(0))
            .collect()
    };
    let pa = parse(a);
    let pb = parse(b);
    for index in 0..pa.len().max(pb.len()) {
        let na = pa.get(index).copied().unwrap_or(0);
        let nb = pb.get(index).copied().unwrap_or(0);
        if na != nb {
            return na > nb;
        }
    }
    false
}

pub fn settings_snapshot(app: &tauri::AppHandle, note: Option<(&str, &str)>) -> Value {
    let view = serde_json::to_value(crate::settings::build_view(app)).unwrap_or(Value::Null);
    // The mail account travels as the dedicated smtp view; the generic list
    // keeps only HTTP credentials.
    let integrations = serde_json::to_value(
        crate::settings::list_integration_credentials(app.clone())
            .into_iter()
            .filter(|credential| credential.kind != "smtp")
            .collect::<Vec<_>>(),
    )
    .unwrap_or(Value::Null);
    let mut message = json!({
        "cmd": "settings",
        "view": view,
        "integrations": integrations,
        "smtp": crate::mail::redacted_view(app),
    });
    if let Some((kind, text)) = note {
        message["noteKind"] = json!(kind);
        message["note"] = json!(text);
    }
    message
}

fn installed_parts(app: &tauri::AppHandle) -> Vec<Value> {
    let Ok(dir) = app.path().app_data_dir().map(|dir| dir.join("fragments")) else {
        return Vec::new();
    };
    let vocab = compose_vocabulary(app);
    crate::fragments::list_core(&dir)
        .into_iter()
        .filter_map(|entry| {
            let manifest = entry.get("manifest")?;
            let id = manifest.get("id").and_then(Value::as_str)?.to_string();
            let operations: Vec<Value> = manifest
                .get("operations")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|op| {
                    json!({
                        "name": op.get("name").cloned().unwrap_or(Value::Null),
                        "description": op.get("description").cloned().unwrap_or(Value::Null),
                    })
                })
                .collect();
            let fragments: Vec<Value> = manifest
                .get("uiFragments")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|fragment| fragment.get("name").cloned())
                .collect();
            let recipes: Vec<Value> = manifest
                .get("recipes")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|recipe| {
                    let name = recipe.get("name").and_then(Value::as_str).unwrap_or("");
                    let available = vocab
                        .recipes
                        .get(name)
                        .map(|def| compose::recipe_check_ok(def, &vocab))
                        .unwrap_or(false);
                    json!({
                        "name": name,
                        "title": recipe.get("title").cloned().unwrap_or(Value::Null),
                        "description": recipe.get("description").cloned().unwrap_or(Value::Null),
                        "available": available,
                    })
                })
                .collect();
            let service = manifest.get("service").map(|service| {
                let saved = crate::fragments::list_part_credentials(app.clone(), id.clone());
                json!({
                    "baseUrl": service.get("baseUrl").cloned().unwrap_or(Value::Null),
                    "credentials": service.get("credentials").cloned().unwrap_or(json!([])),
                    "saved": saved,
                })
            });
            let mut part = json!({
                "id": id,
                "name": manifest.get("name").cloned().unwrap_or(Value::Null),
                "version": manifest.get("version").cloned().unwrap_or(Value::Null),
                "publisher": manifest.get("publisher").cloned().unwrap_or(Value::Null),
                "description": manifest.get("description").cloned().unwrap_or(Value::Null),
                "operations": operations,
                "fragments": fragments,
                "recipes": recipes,
                "fingerprintGrouped": entry.get("fingerprintGrouped").cloned().unwrap_or(Value::Null),
            });
            if let Some(service) = service {
                part["service"] = service;
            }
            Some(part)
        })
        .collect()
}

async fn registry_entries(app: &tauri::AppHandle, url: &str) -> Result<Vec<Value>, String> {
    let index = crate::fragments::fetch_registry_index(url.to_string()).await?;
    let installed = installed_parts(app);
    let entries = index
        .get("parts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|entry| {
            let id = entry.get("id").and_then(Value::as_str).unwrap_or("");
            let version = entry.get("version").and_then(Value::as_str).unwrap_or("");
            let installed_version = installed
                .iter()
                .find(|part| part.get("id").and_then(Value::as_str) == Some(id))
                .and_then(|part| part.get("version").and_then(Value::as_str))
                .map(str::to_string);
            let update_available = installed_version
                .as_deref()
                .map(|current| version_newer(version, current))
                .unwrap_or(false);
            let mut decorated = entry.clone();
            if let Some(current) = installed_version {
                decorated["installedVersion"] = json!(current);
            }
            decorated["updateAvailable"] = json!(update_available);
            decorated
        })
        .collect();
    Ok(entries)
}

pub async fn parts_snapshot(
    app: &tauri::AppHandle,
    note: Option<(&str, &str)>,
    review: Option<Value>,
) -> Value {
    let registry_url = load_registry_url(app);
    // A saved registry is checked quietly so newer versions show up; the
    // manual fetch reports failures.
    let registry = match &registry_url {
        Some(url) => registry_entries(app, url).await.ok(),
        None => None,
    };
    let mut message = json!({
        "cmd": "parts",
        "installed": installed_parts(app),
        "registryUrl": registry_url,
        "registry": registry,
    });
    if let Some(review) = review {
        message["review"] = review;
    }
    if let Some((kind, text)) = note {
        message["noteKind"] = json!(kind);
        message["note"] = json!(text);
    }
    message
}

fn reserved_operation_names() -> Vec<String> {
    super::manifests::registry()
        .get("operations")
        .and_then(Value::as_object)
        .map(|operations| operations.keys().cloned().collect())
        .unwrap_or_default()
}

fn stage_bytes(app: &tauri::AppHandle, raw: &[u8]) -> Result<Value, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("fragments");
    let state = app.state::<crate::fragments::FragmentsState>();
    let summary = crate::fragments::stage_core(&state, &dir, raw, &reserved_operation_names())
        .map_err(|error| error.message)?;
    serde_json::to_value(summary).map_err(|error| error.to_string())
}

/// One panel management action; every branch answers with a fresh snapshot
/// so the native windows never go stale.
pub async fn handle_action(app: &tauri::AppHandle, event: &Value) {
    let name = event.get("event").and_then(Value::as_str).unwrap_or("");
    let text = |key: &str| -> String {
        event.get(key).and_then(Value::as_str).unwrap_or("").to_string()
    };
    match name {
        "openSettings" => {
            let snapshot = settings_snapshot(app, None);
            sidecar::send_panel_message(app, &snapshot);
        }
        "settingsSave" => {
            let outcome = match serde_json::from_value::<crate::settings::LlmSettings>(
                event.get("settings").cloned().unwrap_or(Value::Null),
            ) {
                Ok(settings) => crate::settings::set_llm_settings(app.clone(), settings)
                    .await
                    .map(|_| ()),
                Err(error) => Err(format!("Settings are malformed: {}", error)),
            };
            let note = match outcome {
                Ok(()) => ("info", "Settings saved".to_string()),
                Err(error) => ("error", error),
            };
            let snapshot = settings_snapshot(app, Some((note.0, &note.1)));
            sidecar::send_panel_message(app, &snapshot);
            sidecar::refresh_native_home(app);
        }
        "settingsSetKey" => {
            let outcome =
                crate::settings::set_llm_credential(app.clone(), text("provider"), text("value"))
                    .await;
            let note = match outcome {
                Ok(_) => ("info", "Credential saved".to_string()),
                Err(error) => ("error", error),
            };
            let snapshot = settings_snapshot(app, Some((note.0, &note.1)));
            sidecar::send_panel_message(app, &snapshot);
            sidecar::refresh_native_home(app);
        }
        "settingsClearKey" => {
            let outcome =
                crate::settings::clear_llm_credential(app.clone(), text("provider")).await;
            let note = match outcome {
                Ok(_) => ("info", "Credential cleared".to_string()),
                Err(error) => ("error", error),
            };
            let snapshot = settings_snapshot(app, Some((note.0, &note.1)));
            sidecar::send_panel_message(app, &snapshot);
            sidecar::refresh_native_home(app);
        }
        "oauthStart" => {
            let pending = app.state::<crate::oauth::PendingOauth>();
            let outcome = crate::oauth::claude_oauth_start(app.clone(), pending).await;
            let mut snapshot = match &outcome {
                Ok(_) => settings_snapshot(
                    app,
                    Some(("info", "Authorize in the browser, then paste the code here")),
                ),
                Err(error) => settings_snapshot(app, Some(("error", error))),
            };
            if let Ok(url) = outcome {
                snapshot["authorizeUrl"] = json!(url);
            }
            sidecar::send_panel_message(app, &snapshot);
        }
        "oauthFinish" => {
            let pending = app.state::<crate::oauth::PendingOauth>();
            let outcome =
                crate::oauth::claude_oauth_finish(app.clone(), pending, text("code")).await;
            let note = match outcome {
                Ok(_) => ("info", "Signed in with Claude".to_string()),
                Err(error) => ("error", error),
            };
            let snapshot = settings_snapshot(app, Some((note.0, &note.1)));
            sidecar::send_panel_message(app, &snapshot);
            sidecar::refresh_native_home(app);
        }
        "integrationSave" => {
            let target = Some(text("target")).filter(|t| !t.trim().is_empty());
            let notes = Some(text("notes")).filter(|n| !n.trim().is_empty());
            let outcome = crate::settings::set_integration_credential(
                app.clone(),
                text("name"),
                text("kind"),
                target,
                text("baseUrl"),
                notes,
                text("secret"),
            );
            let note = match outcome {
                Ok(_) => ("info", "Integration credential saved".to_string()),
                Err(error) => ("error", error),
            };
            let snapshot = settings_snapshot(app, Some((note.0, &note.1)));
            sidecar::send_panel_message(app, &snapshot);
        }
        "smtpSave" => {
            let port_of = |key: &str| {
                event
                    .get(key)
                    .and_then(Value::as_str)
                    .and_then(|value| value.trim().parse::<u16>().ok())
                    .or_else(|| event.get(key).and_then(Value::as_u64).map(|value| value as u16))
            };
            let config = crate::mail::SmtpConfig {
                host: text("host"),
                port: port_of("port"),
                username: text("username"),
                password: text("password"),
                security: text("security"),
                from: text("from"),
                imap_host: text("imapHost"),
                imap_port: port_of("imapPort"),
            };
            let note = match crate::mail::save_keeping_password(app, config) {
                Ok(_) => ("info", "Mail account saved".to_string()),
                Err(error) => ("error", error),
            };
            let snapshot = settings_snapshot(app, Some((note.0, &note.1)));
            sidecar::send_panel_message(app, &snapshot);
        }
        "smtpRemove" => {
            let note = match crate::mail::delete_account(app) {
                Ok(()) => ("info", "Mail account removed".to_string()),
                Err(error) => ("error", error),
            };
            let snapshot = settings_snapshot(app, Some((note.0, &note.1)));
            sidecar::send_panel_message(app, &snapshot);
        }
        "integrationDelete" => {
            let outcome = crate::settings::delete_integration_credential(app.clone(), text("name"));
            let note = match outcome {
                Ok(_) => ("info", "Integration credential removed".to_string()),
                Err(error) => ("error", error),
            };
            let snapshot = settings_snapshot(app, Some((note.0, &note.1)));
            sidecar::send_panel_message(app, &snapshot);
        }
        "openParts" => {
            let snapshot = parts_snapshot(app, None, None).await;
            sidecar::send_panel_message(app, &snapshot);
        }
        "partsFetchRegistry" => {
            let url = text("url");
            let trimmed = url.trim();
            let snapshot = if trimmed.is_empty() {
                parts_snapshot(app, Some(("error", "Enter a registry URL")), None).await
            } else {
                match registry_entries(app, trimmed).await {
                    Ok(_) => {
                        save_registry_url(app, trimmed);
                        parts_snapshot(app, None, None).await
                    }
                    Err(error) => parts_snapshot(app, Some(("error", &error)), None).await,
                }
            };
            sidecar::send_panel_message(app, &snapshot);
        }
        "partsInstallRegistry" => {
            let staged = match crate::fragments::download_registry_bundle(text("bundleUrl")).await {
                Ok(b64) => {
                    use base64::Engine as _;
                    base64::engine::general_purpose::STANDARD
                        .decode(b64)
                        .map_err(|_| "The downloaded bundle is not readable".to_string())
                        .and_then(|raw| stage_bytes(app, &raw))
                }
                Err(error) => Err(error),
            };
            let snapshot = match staged {
                Ok(review) => parts_snapshot(app, None, Some(review)).await,
                Err(error) => parts_snapshot(app, Some(("error", &error)), None).await,
            };
            sidecar::send_panel_message(app, &snapshot);
        }
        "partsInstallFile" => {
            let staged = std::fs::read(text("path"))
                .map_err(|_| "The picked file is not readable".to_string())
                .and_then(|raw| stage_bytes(app, &raw));
            let snapshot = match staged {
                Ok(review) => parts_snapshot(app, None, Some(review)).await,
                Err(error) => parts_snapshot(app, Some(("error", &error)), None).await,
            };
            sidecar::send_panel_message(app, &snapshot);
        }
        "partsCommit" => {
            let outcome = (|| -> Result<String, String> {
                let dir = app
                    .path()
                    .app_data_dir()
                    .map_err(|error| error.to_string())?
                    .join("fragments");
                let state = app.state::<crate::fragments::FragmentsState>();
                let manifest = crate::fragments::commit_core(
                    &state,
                    &dir,
                    &text("token"),
                    &text("fingerprint"),
                    event.get("forceDowngrade").and_then(Value::as_bool).unwrap_or(false),
                )
                .map_err(|error| error.message)?;
                Ok(format!("Installed {} {}", manifest.name, manifest.version))
            })();
            let snapshot = match outcome {
                Ok(message) => parts_snapshot(app, Some(("info", &message)), None).await,
                Err(error) => parts_snapshot(app, Some(("error", &error)), None).await,
            };
            sidecar::send_panel_message(app, &snapshot);
            sidecar::refresh_native_home(app);
        }
        "partsRemove" => {
            let outcome = (|| -> Result<(), String> {
                let dir = app
                    .path()
                    .app_data_dir()
                    .map_err(|error| error.to_string())?
                    .join("fragments");
                let state = app.state::<crate::fragments::FragmentsState>();
                crate::fragments::remove_core(&state, &dir, &text("id"))
                    .map_err(|error| error.message)
            })();
            let snapshot = match outcome {
                Ok(()) => parts_snapshot(app, Some(("info", "Part removed")), None).await,
                Err(error) => parts_snapshot(app, Some(("error", &error)), None).await,
            };
            sidecar::send_panel_message(app, &snapshot);
            sidecar::refresh_native_home(app);
        }
        "partsSaveSecret" => {
            let outcome = crate::fragments::set_part_credential(
                app.clone(),
                text("fragmentId"),
                text("name"),
                text("secret"),
            );
            let note = match outcome {
                Ok(_) => ("info", "Part secret saved".to_string()),
                Err(error) => ("error", error.message),
            };
            let snapshot = parts_snapshot(app, Some((note.0, &note.1)), None).await;
            sidecar::send_panel_message(app, &snapshot);
        }
        "partsOpenRecipe" => {
            sidecar::native_open_recipe(app, text("name"));
        }
        other => {
            eprintln!("Unknown management action \"{}\"", other);
        }
    }
}

/// A management event from the panel runs off the reader thread.
pub fn dispatch(app: &tauri::AppHandle, event: Value) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        handle_action(&app, &event).await;
    });
}

pub fn is_management_event(name: &str) -> bool {
    matches!(
        name,
        "openSettings"
            | "settingsSave"
            | "settingsSetKey"
            | "settingsClearKey"
            | "oauthStart"
            | "oauthFinish"
            | "integrationSave"
            | "integrationDelete"
            | "smtpSave"
            | "smtpRemove"
            | "openParts"
            | "partsFetchRegistry"
            | "partsInstallRegistry"
            | "partsInstallFile"
            | "partsCommit"
            | "partsRemove"
            | "partsSaveSecret"
            | "partsOpenRecipe"
    )
}

// Keep Map in the public signature surface for future snapshot filters.
#[allow(dead_code)]
type SnapshotExtras = Map<String, Value>;
