//! The per-app record store: a host-owned builtin layer for data that
//! outgrows the state map (archives, journals, libraries). Each experience
//! gets its own directory of collections; contracts compose small
//! declarative reads and writes while the host owns the files, so one app
//! can never touch another's records.

use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};

use crate::runtime::value::js_to_string;

fn sanitize_segment(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.len() > 64
        || !trimmed
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(format!(
            "Collection names are 1-64 letters, digits, dashes, and underscores; got: {}",
            if trimmed.is_empty() { "(empty)" } else { trimmed }
        ));
    }
    Ok(trimmed.to_string())
}

fn collection_path(base: &Path, experience_id: &str, collection: &str) -> Result<PathBuf, String> {
    let experience = sanitize_segment(experience_id)
        .map_err(|_| "The store needs its owning app; open the experience normally".to_string())?;
    let collection = sanitize_segment(collection)?;
    let dir = base.join(experience);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Store directory: {}", e))?;
    Ok(dir.join(format!("{}.json", collection)))
}

fn read_collection(path: &Path) -> Vec<Value> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Vec<Value>>(&text).ok())
        .unwrap_or_default()
}

fn write_collection(path: &Path, records: &[Value]) -> Result<(), String> {
    let text = serde_json::to_string_pretty(records).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| format!("Store write: {}", e))
}

/// Upserts one record: a matching "id" replaces in place, anything else
/// appends with a generated id. Returns {record, count}.
pub fn put_core(
    base: &Path,
    experience_id: &str,
    collection: &str,
    record: &Map<String, Value>,
    new_id: impl FnOnce() -> String,
) -> Result<Value, String> {
    let path = collection_path(base, experience_id, collection)?;
    let mut records = read_collection(&path);
    let mut stored = record.clone();
    let id = match stored.get("id") {
        Some(Value::Null) | None => {
            let id = new_id();
            stored.insert("id".to_string(), Value::String(id.clone()));
            id
        }
        Some(value) => js_to_string(value),
    };
    match records
        .iter_mut()
        .find(|existing| existing.get("id").map(js_to_string).as_deref() == Some(id.as_str()))
    {
        Some(existing) => *existing = Value::Object(stored.clone()),
        None => records.push(Value::Object(stored.clone())),
    }
    write_collection(&path, &records)?;
    Ok(json!({ "record": stored, "count": records.len() }))
}

/// Declarative query: an optional single filter (equals or contains on one
/// field), an optional sort, and paging. Filter semantics mirror the
/// transforms: empty filter values keep everything, contains is
/// case-insensitive, equals compares loosely across the string boundary.
#[allow(clippy::too_many_arguments)]
pub fn query_core(
    base: &Path,
    experience_id: &str,
    collection: &str,
    field: &str,
    equals: &Value,
    contains: &str,
    sort_by: &str,
    direction: &str,
    limit: &str,
    offset: &str,
) -> Result<Value, String> {
    let path = collection_path(base, experience_id, collection)?;
    let mut records = read_collection(&path);

    if !field.is_empty() {
        let needle = contains.to_lowercase();
        let wants_equals = !equals.is_null() && !js_to_string(equals).is_empty();
        if wants_equals {
            let wanted = js_to_string(equals);
            records.retain(|record| {
                record
                    .get(field)
                    .map(js_to_string)
                    .is_some_and(|value| value == wanted)
            });
        } else if !needle.is_empty() {
            records.retain(|record| {
                record
                    .get(field)
                    .map(|value| js_to_string(value).to_lowercase())
                    .is_some_and(|value| value.contains(&needle))
            });
        }
    }

    if !sort_by.is_empty() {
        let descending = direction.eq_ignore_ascii_case("desc");
        records.sort_by(|a, b| {
            let left = a.get(sort_by).cloned().unwrap_or(Value::Null);
            let right = b.get(sort_by).cloned().unwrap_or(Value::Null);
            let ordering = match (left.as_f64(), right.as_f64()) {
                (Some(l), Some(r)) => l.partial_cmp(&r).unwrap_or(std::cmp::Ordering::Equal),
                _ => js_to_string(&left).cmp(&js_to_string(&right)),
            };
            if descending { ordering.reverse() } else { ordering }
        });
    }

    let total = records.len();
    let offset: usize = offset.trim().parse().unwrap_or(0);
    let sliced: Vec<Value> = records.into_iter().skip(offset).collect();
    let limit: usize = limit.trim().parse().unwrap_or(0);
    let items: Vec<Value> = if limit > 0 {
        sliced.into_iter().take(limit).collect()
    } else {
        sliced
    };
    Ok(json!({ "items": items, "count": items.len(), "total": total }))
}

/// Removes the record with the given id. Returns {removed, count}.
pub fn remove_core(
    base: &Path,
    experience_id: &str,
    collection: &str,
    id: &str,
) -> Result<Value, String> {
    let path = collection_path(base, experience_id, collection)?;
    let mut records = read_collection(&path);
    let before = records.len();
    records.retain(|record| record.get("id").map(js_to_string).as_deref() != Some(id));
    let removed = records.len() != before;
    if removed {
        write_collection(&path, &records)?;
    }
    Ok(json!({ "removed": removed, "count": records.len() }))
}

pub(crate) fn stores_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("stores"))
        .map_err(|e| e.to_string())
}

fn generated_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[tauri::command]
pub fn store_put(
    app: AppHandle,
    experience_id: String,
    collection: String,
    record: Map<String, Value>,
) -> Result<Value, String> {
    put_core(&stores_dir(&app)?, &experience_id, &collection, &record, generated_id)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn store_query(
    app: AppHandle,
    experience_id: String,
    collection: String,
    field: Option<String>,
    equals: Option<Value>,
    contains: Option<String>,
    sort_by: Option<String>,
    direction: Option<String>,
    limit: Option<String>,
    offset: Option<String>,
) -> Result<Value, String> {
    query_core(
        &stores_dir(&app)?,
        &experience_id,
        &collection,
        field.as_deref().unwrap_or(""),
        &equals.unwrap_or(Value::Null),
        contains.as_deref().unwrap_or(""),
        sort_by.as_deref().unwrap_or(""),
        direction.as_deref().unwrap_or(""),
        limit.as_deref().unwrap_or(""),
        offset.as_deref().unwrap_or(""),
    )
}

#[tauri::command]
pub fn store_remove(
    app: AppHandle,
    experience_id: String,
    collection: String,
    id: String,
) -> Result<Value, String> {
    remove_core(&stores_dir(&app)?, &experience_id, &collection, &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_base(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("der-store-test-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn record(pairs: &[(&str, Value)]) -> Map<String, Value> {
        pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.clone()))
            .collect()
    }

    #[test]
    fn records_upsert_and_survive_rereads() {
        let base = temp_base("upsert");
        let put = put_core(&base, "app-1", "notes", &record(&[("text", json!("first"))]), || {
            "n-1".to_string()
        })
        .unwrap();
        assert_eq!(put["record"]["id"], json!("n-1"));
        put_core(
            &base,
            "app-1",
            "notes",
            &record(&[("id", json!("n-1")), ("text", json!("edited"))]),
            || "unused".to_string(),
        )
        .unwrap();
        let all = query_core(&base, "app-1", "notes", "", &Value::Null, "", "", "", "", "").unwrap();
        assert_eq!(all["total"], json!(1));
        assert_eq!(all["items"][0]["text"], json!("edited"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn queries_filter_sort_and_page_and_removal_deletes() {
        let base = temp_base("query");
        for (id, text, rank) in [("a", "Buy milk", 2), ("b", "Call the bank", 1), ("c", "milk run", 3)] {
            put_core(
                &base,
                "app-1",
                "notes",
                &record(&[("id", json!(id)), ("text", json!(text)), ("rank", json!(rank))]),
                || "unused".to_string(),
            )
            .unwrap();
        }
        let milk =
            query_core(&base, "app-1", "notes", "text", &Value::Null, "MILK", "", "", "", "")
                .unwrap();
        assert_eq!(milk["count"], json!(2));
        let sorted =
            query_core(&base, "app-1", "notes", "", &Value::Null, "", "rank", "desc", "2", "")
                .unwrap();
        assert_eq!(sorted["items"][0]["id"], json!("c"));
        assert_eq!(sorted["count"], json!(2));
        assert_eq!(sorted["total"], json!(3));
        let removed = remove_core(&base, "app-1", "notes", "b").unwrap();
        assert_eq!(removed["removed"], json!(true));
        assert_eq!(removed["count"], json!(2));
        // Another app's store is untouched by construction: its directory
        // never even exists.
        let other = query_core(&base, "app-2", "notes", "", &Value::Null, "", "", "", "", "").unwrap();
        assert_eq!(other["total"], json!(0));
        let _ = std::fs::remove_dir_all(&base);
    }
}
