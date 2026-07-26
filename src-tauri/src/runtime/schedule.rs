//! Background refresh: the host runs a bookmarked app's timer chains on a
//! user-chosen cadence while the app is closed, so inboxes and tickers stay
//! fresh from the tray. The timer element is the app's own declaration of
//! periodic work; enabling background refresh is a per-bookmark user choice
//! and an open window always wins (its renderer owns the timers).

use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde_json::Value;

use super::sessions::{resolve_entry_view, SessionEntry};

/// The visible timer chains of a resolved tree: each entry is one timer's
/// tick operation ids, in document order. The resolver already applies
/// visibleWhen gating, so a hidden timer never appears here.
fn collect_timer_chains(tree: &[Value], chains: &mut Vec<Vec<String>>) {
    for node in tree {
        if node.get("type").and_then(Value::as_str) == Some("timer") {
            let tick: Vec<String> = node
                .get("events")
                .and_then(|events| events.get("tick"))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect();
            if !tick.is_empty() {
                chains.push(tick);
            }
        }
        if let Some(children) = node.get("children").and_then(Value::as_array) {
            collect_timer_chains(children, chains);
        }
        for row in node.get("rows").and_then(Value::as_array).into_iter().flatten() {
            if let Some(children) = row.get("children").and_then(Value::as_array) {
                collect_timer_chains(children, chains);
            }
        }
    }
}

/// One background beat: every visible timer's tick chain runs once, exactly
/// as a renderer moment would fire them. Returns how many chains ran.
pub fn run_timer_chains(entry: &mut SessionEntry, elements: &[Value]) -> usize {
    let tree = resolve_entry_view(entry, elements);
    let mut chains: Vec<Vec<String>> = Vec::new();
    collect_timer_chains(&tree, &mut chains);
    for chain in &chains {
        entry.session_mut().run_chain(chain, None);
    }
    chains.len()
}

/// Refreshes one bookmarked experience headlessly: saved state in, timer
/// chains once, state persisted back. Skipped while the app has an open
/// native window (its renderer owns the timers there).
pub fn refresh_experience(app: &tauri::AppHandle, experience_id: &str) -> Result<usize, String> {
    if super::sidecar::experience_window_open(app, experience_id) {
        return Ok(0);
    }
    let contract = crate::bookmark_contract(app, experience_id)
        .ok_or_else(|| format!("No bookmark {}", experience_id))?;
    let initial_data = crate::read_experience_state(app, experience_id)
        .and_then(|state| state.as_object().cloned())
        .unwrap_or_default();
    let elements = contract
        .get("elements")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let (mut entry, _) = super::sidecar::build_entry(app, &contract, initial_data)?;
    let ran = run_timer_chains(&mut entry, &elements);
    if ran > 0 {
        let state = Value::Object(entry.session().state().clone());
        crate::write_experience_state_file(app, experience_id, &state)?;
    }
    Ok(ran)
}

/// The scheduler loop: once a minute, every bookmark with background refresh
/// enabled and due gets one beat. Cadences start counting at launch, so a
/// restart never fires a burst.
pub fn spawn(app: tauri::AppHandle) {
    std::thread::Builder::new()
        .name("der-background-refresh".into())
        .spawn(move || {
            let mut last_run: HashMap<String, Instant> = HashMap::new();
            let started = Instant::now();
            loop {
                std::thread::sleep(Duration::from_secs(60));
                for bookmark in crate::read_bookmarks(&app) {
                    let Some(minutes) = bookmark.background_minutes.filter(|m| *m > 0) else {
                        continue;
                    };
                    let due = last_run
                        .get(&bookmark.id)
                        .copied()
                        .unwrap_or(started)
                        .elapsed()
                        >= Duration::from_secs(u64::from(minutes) * 60);
                    if !due {
                        continue;
                    }
                    last_run.insert(bookmark.id.clone(), Instant::now());
                    match refresh_experience(&app, &bookmark.id) {
                        Ok(_) => {}
                        Err(error) => {
                            eprintln!("Background refresh of {} failed: {}", bookmark.id, error)
                        }
                    }
                }
            }
        })
        .ok();
}
