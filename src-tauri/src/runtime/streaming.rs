//! Best-effort parsing of a truncated JSON stream, the Rust twin of
//! src/services/ai-interpreter/partial-json.ts: auto-closes open strings,
//! arrays, and objects, backs up to the previous structural boundary when
//! the tail is unparseable, and shapes the result into an inert
//! display-only contract (operations and event bindings stripped, unknown
//! transform steps dropped). Indexing runs over UTF-16 code units to match
//! the webview's string semantics exactly; cuts landing inside a surrogate
//! pair are outside the contract envelope.

use serde_json::{Map, Value};

/// Every transform name the webview registry declares, including the
/// presentation transforms the kernel does not execute; the streaming
/// filter keeps steps by NAME, not by executability.
fn is_registry_transform(name: &str) -> bool {
    matches!(
        name,
        "count"
            | "sum"
            | "filterBy"
            | "filterContains"
            | "filterTruthy"
            | "filterFalsy"
            | "sortBy"
            | "deriveField"
            | "pick"
            | "pluck"
            | "equals"
            | "not"
            | "parseNumber"
            | "round"
            | "format"
            | "formatNumber"
            | "formatDate"
            | "map"
    )
}

fn units_of(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

fn string_of(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

/// Closes whatever is open; None when the tail cannot be patched.
fn complete_json(source: &[u16]) -> Option<String> {
    let mut stack: Vec<u16> = Vec::new();
    let mut in_string = false;
    let mut escaped = false;

    for &unit in source {
        if in_string {
            if escaped {
                escaped = false;
            } else if unit == b'\\' as u16 {
                escaped = true;
            } else if unit == b'"' as u16 {
                in_string = false;
            }
            continue;
        }
        if unit == b'"' as u16 {
            in_string = true;
        } else if unit == b'{' as u16 {
            stack.push(b'}' as u16);
        } else if unit == b'[' as u16 {
            stack.push(b']' as u16);
        } else if unit == b'}' as u16 || unit == b']' as u16 {
            if stack.pop() != Some(unit) {
                return None;
            }
        }
    }

    let mut candidate: Vec<u16> = source.to_vec();
    if escaped {
        candidate.pop();
    }
    if in_string {
        candidate.push(b'"' as u16);
    }
    let mut text = string_of(&candidate);
    // A dangling separator cannot precede a closer. The webview applies
    // both patches in sequence, so a comma strip can expose a colon.
    let trimmed = text.trim_end();
    if trimmed.ends_with(',') {
        text = trimmed[..trimmed.len() - 1].to_string();
    }
    let trimmed = text.trim_end();
    if trimmed.ends_with(':') {
        text = format!("{}null", trimmed);
    }
    stack.reverse();
    text.push_str(&string_of(&stack));
    Some(text)
}

fn last_index_of(units: &[u16], wanted: u16, from: Option<usize>) -> Option<usize> {
    let mut end = match from {
        Some(from) => {
            if units.is_empty() {
                return None;
            }
            from.min(units.len() - 1)
        }
        None => units.len().checked_sub(1)?,
    };
    loop {
        if units[end] == wanted {
            return Some(end);
        }
        if end == 0 {
            return None;
        }
        end -= 1;
    }
}

/// Parses as much of a truncated JSON object as possible; None when nothing
/// object-shaped can be recovered yet.
pub fn parse_partial_json(text: &str) -> Option<Value> {
    let units = units_of(text);
    let start = units.iter().position(|&unit| unit == b'{' as u16)?;
    let mut source: Vec<u16> = units[start..].to_vec();

    for _ in 0..48 {
        if source.is_empty() {
            break;
        }
        if let Some(completed) = complete_json(&source) {
            if let Ok(value) = serde_json::from_str::<Value>(&completed) {
                return Some(value);
            }
        }
        // Back up to just before the last structural boundary and retry:
        // this drops a cut-off number, literal, or dangling key.
        let comma = last_index_of(&source, b',' as u16, None);
        let brace = if source.len() >= 2 {
            last_index_of(&source, b'{' as u16, Some(source.len() - 2))
        } else {
            None
        };
        let bracket = if source.len() >= 2 {
            last_index_of(&source, b'[' as u16, Some(source.len() - 2))
        } else {
            None
        };
        let cut = [comma, brace, bracket]
            .into_iter()
            .flatten()
            .max()
            .unwrap_or(0);
        if cut == 0 {
            return None;
        }
        let keep = if source[cut] == b',' as u16 { cut } else { cut + 1 };
        source.truncate(keep);
    }
    None
}

fn sanitize_binding(binding: &Value) -> Option<Value> {
    let map = binding.as_object()?;
    let property = map.get("property")?.as_str()?;
    let source = map.get("source")?.as_str()?;
    let source_id = map.get("sourceId")?.as_str()?;

    let mut out = Map::new();
    out.insert("property".to_string(), Value::String(property.to_string()));
    out.insert("source".to_string(), Value::String(source.to_string()));
    out.insert("sourceId".to_string(), Value::String(source_id.to_string()));
    if let Some(value) = map.get("value") {
        out.insert("value".to_string(), value.clone());
    }
    if let Some(Value::Array(steps)) = map.get("transforms") {
        let kept: Vec<Value> = steps
            .iter()
            .filter(|step| {
                step.get("type")
                    .and_then(Value::as_str)
                    .is_some_and(is_registry_transform)
            })
            .cloned()
            .collect();
        if !kept.is_empty() {
            out.insert("transforms".to_string(), Value::Array(kept));
        }
    }
    Some(Value::Object(out))
}

fn sanitize_element(element: &Value) -> Option<Value> {
    let map = element.as_object()?;
    let id = map.get("id")?.as_str().filter(|id| !id.is_empty())?;
    let element_type = map
        .get("type")?
        .as_str()
        .filter(|element_type| !element_type.is_empty())?;

    let children: Vec<Value> = map
        .get("children")
        .and_then(Value::as_array)
        .map(|entries| entries.iter().filter_map(sanitize_element).collect())
        .unwrap_or_default();

    let mut out = Map::new();
    out.insert("id".to_string(), Value::String(id.to_string()));
    out.insert("type".to_string(), Value::String(element_type.to_string()));
    out.insert(
        "properties".to_string(),
        map.get("properties")
            .and_then(Value::as_object)
            .cloned()
            .map(Value::Object)
            .unwrap_or_else(|| Value::Object(Map::new())),
    );
    out.insert(
        "dataBindings".to_string(),
        Value::Array(
            map.get("dataBindings")
                .and_then(Value::as_array)
                .map(|entries| entries.iter().filter_map(sanitize_binding).collect())
                .unwrap_or_default(),
        ),
    );
    out.insert("eventBindings".to_string(), Value::Array(Vec::new()));
    if !children.is_empty() {
        out.insert("children".to_string(), Value::Array(children));
    }
    Some(Value::Object(out))
}

/// Shapes a partial model response into an inert display-only contract;
/// None until at least one well-formed element survives.
pub fn extract_streaming_contract(raw: &str) -> Option<Value> {
    let parsed = parse_partial_json(raw)?;
    let parsed = parsed.as_object()?;

    // Compose responses nest the contract; contract-only responses do not.
    let candidate: &Map<String, Value> = match parsed.get("contract").and_then(Value::as_object) {
        Some(nested) => nested,
        None => parsed,
    };
    let elements: Vec<Value> = candidate
        .get("elements")?
        .as_array()?
        .iter()
        .filter_map(sanitize_element)
        .collect();
    if elements.is_empty() {
        return None;
    }

    let name = candidate
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .unwrap_or("new-app");

    let mut layout_properties = Map::new();
    layout_properties.insert("flexDirection".to_string(), Value::String("column".to_string()));
    layout_properties.insert("gap".to_string(), Value::String("12px".to_string()));
    layout_properties.insert("padding".to_string(), Value::String("16px".to_string()));
    let mut layout = Map::new();
    layout.insert("type".to_string(), Value::String("flex".to_string()));
    layout.insert("properties".to_string(), Value::Object(layout_properties));

    let mut contract = Map::new();
    contract.insert("name".to_string(), Value::String(name.to_string()));
    contract.insert("version".to_string(), Value::String("1.0.0".to_string()));
    contract.insert("elements".to_string(), Value::Array(elements));
    contract.insert("operations".to_string(), Value::Array(Vec::new()));
    contract.insert("layout".to_string(), Value::Object(layout));
    if let Some(styling) = candidate.get("styling").filter(|value| value.is_object()) {
        contract.insert("styling".to_string(), styling.clone());
    }
    Some(Value::Object(contract))
}
