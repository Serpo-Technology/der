//! Fragment template expansion and pack operation instantiation, the Rust
//! twin of src/services/fragments/ui-fragments.ts: "{{id}}"-scoped ids,
//! "{{param}}" substitution with type preservation for exact placeholders,
//! unmatched placeholders preserved, and the instance's visibility gate
//! carried onto the expansion.

use serde_json::{Map, Value};

use super::value::js_to_string;

fn substitute(value: &Value, params: &Map<String, Value>) -> Value {
    match value {
        Value::String(text) => {
            // A string that IS exactly one placeholder takes the parameter's
            // value with its type preserved.
            if text.starts_with("{{") && text.ends_with("}}") && text.len() > 4 {
                let name = &text[2..text.len() - 2];
                if name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                {
                    if let Some(replacement) = params.get(name) {
                        return replacement.clone();
                    }
                    return value.clone();
                }
            }
            Value::String(substitute_text(text, params))
        }
        Value::Array(items) => {
            Value::Array(items.iter().map(|item| substitute(item, params)).collect())
        }
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, entry)| (key.clone(), substitute(entry, params)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn substitute_text(text: &str, params: &Map<String, Value>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        match after.find("}}") {
            Some(end)
                if after[..end]
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                    && end > 0 =>
            {
                let name = &after[..end];
                match params.get(name) {
                    // Unmatched placeholders stay, so format templates like
                    // "{{value}}" survive fragment substitution untouched.
                    Some(replacement) => out.push_str(&js_to_string(replacement)),
                    None => {
                        out.push_str("{{");
                        out.push_str(name);
                        out.push_str("}}");
                    }
                }
                rest = &after[end + 2..];
            }
            _ => {
                out.push_str("{{");
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

fn instance_params(element: &Map<String, Value>, def: &Map<String, Value>) -> Map<String, Value> {
    let mut params = Map::new();
    params.insert(
        "id".to_string(),
        element.get("id").cloned().unwrap_or(Value::Null),
    );
    if let Some(Value::Array(param_specs)) = def.get("params") {
        for spec in param_specs {
            if let (Some(name), Some(default)) =
                (spec.get("name").and_then(Value::as_str), spec.get("default"))
            {
                params.insert(name.to_string(), default.clone());
            }
        }
    }
    if let Some(Value::Object(properties)) = element.get("properties") {
        for (key, value) in properties {
            params.insert(key.clone(), value.clone());
        }
    }
    params
}

fn fill_structural_defaults(element: &mut Value) {
    if let Value::Object(map) = element {
        map.entry("properties".to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        map.entry("dataBindings".to_string())
            .or_insert_with(|| Value::Array(Vec::new()));
        map.entry("eventBindings".to_string())
            .or_insert_with(|| Value::Array(Vec::new()));
        if let Some(Value::Array(children)) = map.get_mut("children") {
            for child in children {
                fill_structural_defaults(child);
            }
        }
    }
}

/// Instantiates a fragment element into its expanded subtree; errors mirror
/// the webview's (an invalid template refuses to expand).
pub fn expand_ui_fragment(
    element: &Map<String, Value>,
    def: &Map<String, Value>,
) -> Result<Value, String> {
    let params = instance_params(element, def);
    let template = def
        .get("template")
        .ok_or_else(|| "UI fragment has no template".to_string())?;
    let mut expanded = substitute(template, &params);
    let expanded_type = expanded.get("type").and_then(Value::as_str);
    let instance_type = element.get("type").and_then(Value::as_str);
    if !expanded.is_object() || expanded_type == instance_type {
        return Err("UI fragment has an invalid template".to_string());
    }
    fill_structural_defaults(&mut expanded);
    if let (Some(gate), Some(map)) = (element.get("visibleWhen"), expanded.as_object_mut()) {
        if !map.contains_key("visibleWhen") {
            map.insert("visibleWhen".to_string(), gate.clone());
        }
    }
    Ok(expanded)
}

/// A pack's operation templates become concrete bindings for one instance;
/// any implementation is dropped, like the webview expansion.
pub fn instantiate_pack_operations(
    element: &Map<String, Value>,
    def: &Map<String, Value>,
) -> Vec<Value> {
    let params = instance_params(element, def);
    let Some(Value::Array(templates)) = def.get("operations") else {
        return Vec::new();
    };
    templates
        .iter()
        .map(|template| {
            let mut operation = substitute(template, &params);
            if let Some(map) = operation.as_object_mut() {
                map.remove("implementation");
                map.entry("inputs".to_string())
                    .or_insert_with(|| Value::Array(Vec::new()));
                map.entry("outputs".to_string())
                    .or_insert_with(|| Value::Array(Vec::new()));
                map.entry("triggers".to_string())
                    .or_insert_with(|| Value::Array(Vec::new()));
            }
            operation
        })
        .collect()
}
