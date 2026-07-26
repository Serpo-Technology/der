//! Builtin operation semantics, the Rust twin of the executable parts in
//! src/services/operations/registry.ts: structured input assembly plus the
//! state-writing builtins, over an injected environment for ids, randomness,
//! and the clock so behavior is deterministic under the conformance vectors.
//! http.get is absent on purpose: it is network IO routed through the host's
//! confined HTTP machinery, outside the pure kernel.

use serde_json::{Map, Value};

use super::env::RuntimeEnv;
use super::value::{get_value_at_path, js_to_number, js_to_string, js_truthy, loose_equals};

/// The builtins this kernel executes. http.get is deliberately absent: it is
/// network IO owned by the host's confined HTTP path, reached through the
/// session's dispatcher rather than the pure kernel.
pub fn is_builtin(operation: &str) -> bool {
    matches!(
        operation,
        "state.set"
            | "counter.add"
            | "list.append"
            | "list.updateWhere"
            | "list.removeWhere"
            | "list.toggleField"
            | "math.add"
            | "time.now"
            | "random.int"
            | "random.pick"
            | "todos.add"
            | "todos.toggle"
            | "todos.remove"
    )
}

fn structured_prefixes(operation: &str) -> &'static [&'static str] {
    match operation {
        "list.append" => &["item"],
        "list.updateWhere" => &["set"],
        _ => &[],
    }
}

/// Groups prefixed inputs into objects: {"key": k, "item.title": t} becomes
/// {"key": k, "item": {"title": t}}. Unresolved fields stay null, exactly
/// like the webview's assembleStructured.
pub fn assemble_structured(inputs: &Map<String, Value>, prefixes: &[&str]) -> Map<String, Value> {
    if prefixes.is_empty() {
        return inputs.clone();
    }
    let mut flat = Map::new();
    let mut groups: Map<String, Value> = Map::new();
    for (name, value) in inputs {
        let matched = prefixes
            .iter()
            .find(|prefix| name.starts_with(&format!("{}.", prefix)));
        if let Some(prefix) = matched {
            let field = name[prefix.len() + 1..].to_string();
            let entry = groups
                .entry(prefix.to_string())
                .or_insert_with(|| Value::Object(Map::new()));
            if let Value::Object(group) = entry {
                group.insert(field, value.clone());
            }
        } else {
            flat.insert(name.clone(), value.clone());
        }
    }
    for (prefix, group) in groups {
        flat.insert(prefix, group);
    }
    flat
}

fn is_blank(value: &Value) -> bool {
    match value {
        Value::Null => true,
        other => js_to_string(other).trim().is_empty(),
    }
}

fn key_of(inputs: &Map<String, Value>) -> String {
    match inputs.get("key") {
        None | Some(Value::Null) => String::new(),
        Some(other) => js_to_string(other),
    }
}

fn read_list(state: &Map<String, Value>, key: &str) -> Vec<Value> {
    match state.get(key) {
        Some(Value::Array(items)) => items.clone(),
        _ => Vec::new(),
    }
}

fn field_or(inputs: &Map<String, Value>, name: &str, fallback: &str) -> String {
    match inputs.get(name) {
        Some(value) if !is_blank(value) => js_to_string(value),
        _ => fallback.to_string(),
    }
}

fn number_value(f: f64) -> Value {
    serde_json::Number::from_f64(f)
        .map(Value::Number)
        .unwrap_or(Value::Null)
}

fn outputs(entries: Vec<(&str, Value)>) -> Map<String, Value> {
    entries
        .into_iter()
        .map(|(name, value)| (name.to_string(), value))
        .collect()
}

/// Runs one builtin against the state map. Inputs are the executor-resolved
/// flat inputs; structured assembly happens here, matching the webview seam.
pub fn execute_builtin(
    operation: &str,
    raw_inputs: &Map<String, Value>,
    state: &mut Map<String, Value>,
    env: &mut dyn RuntimeEnv,
) -> Result<Map<String, Value>, String> {
    let inputs = assemble_structured(raw_inputs, structured_prefixes(operation));
    match operation {
        "state.set" => {
            let key = key_of(&inputs);
            match inputs.get("value") {
                // An absent value stores undefined in the webview, which
                // serializes to no key at all; mirror the JSON-visible truth.
                None => {
                    state.remove(&key);
                    Ok(outputs(vec![("value", Value::Null)]))
                }
                Some(value) => {
                    state.insert(key, value.clone());
                    Ok(outputs(vec![("value", value.clone())]))
                }
            }
        }
        "counter.add" => {
            let key = key_of(&inputs);
            let current = {
                let n = js_to_number(state.get(&key).unwrap_or(&Value::Null));
                if n.is_nan() {
                    0.0
                } else {
                    n
                }
            };
            let amount = match inputs.get("amount") {
                None => 1.0,
                Some(value) => {
                    let n = js_to_number(value);
                    if n.is_nan() {
                        0.0
                    } else {
                        n
                    }
                }
            };
            let next = current + amount;
            state.insert(key, number_value(next));
            Ok(outputs(vec![("value", number_value(next))]))
        }
        "list.append" => {
            let key = key_of(&inputs);
            let list = read_list(state, &key);
            let fields = match inputs.get("item") {
                Some(Value::Object(map)) => map.clone(),
                _ => Map::new(),
            };
            let meaningful: Vec<(&String, &Value)> =
                fields.iter().filter(|(name, _)| *name != "id").collect();
            if meaningful.is_empty() || meaningful.iter().all(|(_, value)| is_blank(value)) {
                return Ok(outputs(vec![
                    ("list", Value::Array(list)),
                    ("item", Value::Null),
                    ("reset", Value::String(String::new())),
                ]));
            }
            let mut item = fields;
            item.insert("id".to_string(), Value::String(env.next_id()));
            let mut next = list;
            next.push(Value::Object(item.clone()));
            state.insert(key, Value::Array(next.clone()));
            Ok(outputs(vec![
                ("list", Value::Array(next)),
                ("item", Value::Object(item)),
                ("reset", Value::String(String::new())),
            ]))
        }
        "list.updateWhere" => {
            let key = key_of(&inputs);
            let field = field_or(&inputs, "field", "id");
            let updates = match inputs.get("set") {
                Some(Value::Object(map)) => map.clone(),
                _ => Map::new(),
            };
            let wanted = inputs.get("value").unwrap_or(&Value::Null);
            let mut count: u64 = 0;
            let next: Vec<Value> = read_list(state, &key)
                .into_iter()
                .map(|item| {
                    if loose_equals(&get_value_at_path(&item, &field), wanted) {
                        count += 1;
                        if let Value::Object(mut row) = item {
                            for (name, value) in &updates {
                                row.insert(name.clone(), value.clone());
                            }
                            return Value::Object(row);
                        }
                    }
                    item
                })
                .collect();
            state.insert(key, Value::Array(next.clone()));
            Ok(outputs(vec![
                ("list", Value::Array(next)),
                ("count", Value::from(count)),
            ]))
        }
        "list.removeWhere" => {
            let key = key_of(&inputs);
            let field = field_or(&inputs, "field", "id");
            let wanted = inputs.get("value").unwrap_or(&Value::Null);
            let next: Vec<Value> = read_list(state, &key)
                .into_iter()
                .filter(|item| !loose_equals(&get_value_at_path(item, &field), wanted))
                .collect();
            state.insert(key, Value::Array(next.clone()));
            Ok(outputs(vec![("list", Value::Array(next))]))
        }
        "list.toggleField" => {
            let key = key_of(&inputs);
            let field = field_or(&inputs, "field", "completed");
            let wanted = inputs.get("id").unwrap_or(&Value::Null);
            let next: Vec<Value> = read_list(state, &key)
                .into_iter()
                .map(|item| {
                    if loose_equals(&get_value_at_path(&item, "id"), wanted) {
                        if let Value::Object(mut row) = item {
                            let current = row.get(&field).cloned().unwrap_or(Value::Null);
                            row.insert(field.clone(), Value::Bool(!js_truthy(&current)));
                            return Value::Object(row);
                        }
                    }
                    item
                })
                .collect();
            state.insert(key, Value::Array(next.clone()));
            Ok(outputs(vec![("list", Value::Array(next))]))
        }
        "math.add" => {
            let coerce = |name: &str| {
                let n = js_to_number(inputs.get(name).unwrap_or(&Value::Null));
                if n.is_nan() {
                    0.0
                } else {
                    n
                }
            };
            Ok(outputs(vec![(
                "result",
                number_value(coerce("a") + coerce("b")),
            )]))
        }
        "time.now" => {
            let utc = chrono::DateTime::from_timestamp_millis(env.epoch_ms())
                .ok_or_else(|| "invalid clock instant".to_string())?;
            let local = utc + chrono::Duration::minutes(env.tz_offset_minutes() as i64);
            Ok(outputs(vec![
                (
                    "iso",
                    Value::String(
                        utc.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                    ),
                ),
                ("date", Value::String(local.format("%Y-%m-%d").to_string())),
                ("time", Value::String(local.format("%H:%M").to_string())),
                ("epoch", Value::from(env.epoch_ms())),
            ]))
        }
        "random.int" => {
            let min = js_to_number(inputs.get("min").unwrap_or(&Value::Null));
            let max = js_to_number(inputs.get("max").unwrap_or(&Value::Null));
            if !min.is_finite() || !max.is_finite() {
                return Err("random.int needs numeric min and max".to_string());
            }
            let lo = min.min(max).ceil();
            let hi = min.max(max).floor();
            let value = lo + (env.next_random() * (hi - lo + 1.0)).floor();
            Ok(outputs(vec![("value", number_value(value))]))
        }
        "random.pick" => {
            let list = match inputs.get("list") {
                Some(Value::Array(items)) => items.clone(),
                _ => Vec::new(),
            };
            if list.is_empty() {
                return Err("The list is empty; add entries before picking".to_string());
            }
            let index = (env.next_random() * list.len() as f64).floor() as usize;
            Ok(outputs(vec![
                ("value", list[index].clone()),
                ("index", Value::from(index as u64)),
            ]))
        }
        "todos.add" => {
            let title = js_to_string(inputs.get("title").unwrap_or(&Value::Null));
            let title = if matches!(inputs.get("title"), None | Some(Value::Null)) {
                String::new()
            } else {
                title.trim().to_string()
            };
            let todos = read_list(state, "todos");
            if title.is_empty() {
                return Ok(outputs(vec![
                    ("todos", Value::Array(todos)),
                    ("todo", Value::Null),
                    ("reset", Value::String(String::new())),
                ]));
            }
            let mut todo = Map::new();
            todo.insert("id".to_string(), Value::String(env.next_id()));
            todo.insert("title".to_string(), Value::String(title));
            todo.insert("completed".to_string(), Value::Bool(false));
            let mut next = todos;
            next.push(Value::Object(todo.clone()));
            state.insert("todos".to_string(), Value::Array(next.clone()));
            Ok(outputs(vec![
                ("todos", Value::Array(next)),
                ("todo", Value::Object(todo)),
                ("reset", Value::String(String::new())),
            ]))
        }
        "todos.toggle" => {
            let wanted = inputs.get("id").unwrap_or(&Value::Null);
            let next: Vec<Value> = read_list(state, "todos")
                .into_iter()
                .map(|item| {
                    if loose_equals(&get_value_at_path(&item, "id"), wanted) {
                        if let Value::Object(mut row) = item {
                            let current = row.get("completed").cloned().unwrap_or(Value::Null);
                            row.insert("completed".to_string(), Value::Bool(!js_truthy(&current)));
                            return Value::Object(row);
                        }
                    }
                    item
                })
                .collect();
            state.insert("todos".to_string(), Value::Array(next.clone()));
            Ok(outputs(vec![("todos", Value::Array(next))]))
        }
        "todos.remove" => {
            let wanted = inputs.get("id").unwrap_or(&Value::Null);
            let next: Vec<Value> = read_list(state, "todos")
                .into_iter()
                .filter(|item| !loose_equals(&get_value_at_path(item, "id"), wanted))
                .collect();
            state.insert("todos".to_string(), Value::Array(next.clone()));
            Ok(outputs(vec![("todos", Value::Array(next))]))
        }
        other => Err(format!("Unknown builtin operation \"{}\"", other)),
    }
}
