//! The view resolver, the Rust twin of
//! src/services/runtime-view/resolve-view.ts: contract elements plus state
//! become a resolved tree (visibility applied, bindings computed, list rows
//! expanded with item scopes, control values read, event tables in contract
//! order). The protocol is JSON-value semantics with null and absent
//! equivalent for object keys; the view vectors hold both resolvers to the
//! same trees under that equivalence.

use serde_json::{Map, Value};

use super::templates::expand_ui_fragment;
use super::transforms::{apply_legacy_single_with, apply_pipeline_with, TransformStep};
use super::value::{get_value_at_path, js_to_number, js_to_string, js_truthy, loose_equals};

const INPUT_LIKE_TYPES: [&str; 4] = ["input", "textarea", "select", "checkbox"];

pub struct ViewContext<'a> {
    pub state: &'a Map<String, Value>,
    /// Installed fragment defs by type name; the caller supplies them (the
    /// registry lives host-side).
    pub fragment_defs: &'a Map<String, Value>,
}

struct Scope<'a> {
    item: &'a Value,
}

/// Resolves a subtree; invisible elements are omitted entirely.
pub fn resolve_view_tree(elements: &[Value], ctx: &ViewContext) -> Vec<Value> {
    resolve_children(elements, ctx, None)
}

fn resolve_children(elements: &[Value], ctx: &ViewContext, scope: Option<&Scope>) -> Vec<Value> {
    elements
        .iter()
        .filter_map(|element| element.as_object())
        .filter_map(|element| resolve_element(element, ctx, scope))
        .collect()
}

fn resolve_element(
    element: &Map<String, Value>,
    ctx: &ViewContext,
    scope: Option<&Scope>,
) -> Option<Value> {
    if !is_visible(element, ctx, scope) {
        return None;
    }

    let element_type = element.get("type").and_then(Value::as_str).unwrap_or("");
    if let Some(def) = ctx.fragment_defs.get(element_type).and_then(Value::as_object) {
        return match expand_ui_fragment(element, def) {
            Ok(expanded) => resolve_element(expanded.as_object()?, ctx, scope),
            Err(_) => None,
        };
    }

    let mut props = element
        .get("properties")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(Value::Array(bindings)) = element.get("dataBindings") {
        for binding in bindings {
            let Some(binding) = binding.as_object() else { continue };
            let Some(property) = binding.get("property").and_then(Value::as_str) else {
                continue;
            };
            match resolve_data_binding(binding, ctx, scope) {
                Some(value) => {
                    props.insert(property.to_string(), value);
                }
                // Undefined-valued props stay absent, the JSON view of the
                // webview's undefined entries.
                None => {
                    props.remove(property);
                }
            }
        }
    }

    let mut events: Map<String, Value> = Map::new();
    if let Some(Value::Array(bindings)) = element.get("eventBindings") {
        for binding in bindings {
            let (Some(event), Some(operation_id)) = (
                binding.get("event").and_then(Value::as_str),
                binding.get("operationId").and_then(Value::as_str),
            ) else {
                continue;
            };
            let entry = events
                .entry(event.to_string())
                .or_insert_with(|| Value::Array(Vec::new()));
            if let Value::Array(ids) = entry {
                ids.push(Value::String(operation_id.to_string()));
            }
        }
    }

    let id = element.get("id").and_then(Value::as_str).unwrap_or("");
    let mut node = Map::new();
    node.insert("id".to_string(), Value::String(id.to_string()));
    node.insert("type".to_string(), Value::String(element_type.to_string()));
    node.insert("events".to_string(), Value::Object(events));
    if let Some(scope) = scope {
        node.insert("eventItem".to_string(), scope.item.clone());
    }

    if INPUT_LIKE_TYPES.contains(&element_type) && scope.is_none() {
        let state_value = ctx.state.get(&format!("element_{}", id));
        let is_checkbox = element_type == "checkbox"
            || props.get("type").and_then(Value::as_str) == Some("checkbox");
        let control = if is_checkbox {
            let mut control = Map::new();
            control.insert("kind".to_string(), Value::String("checkbox".to_string()));
            control.insert(
                "value".to_string(),
                Value::Bool(state_value.map(js_truthy).unwrap_or(false)),
            );
            control
        } else {
            // state value ?? defaultValue ?? '' with null treated as absent,
            // matching the webview's ?? chain.
            let fallback = element
                .get("properties")
                .and_then(|properties| properties.get("defaultValue"))
                .filter(|value| !value.is_null())
                .cloned();
            let value = state_value
                .filter(|value| !value.is_null())
                .cloned()
                .or(fallback)
                .unwrap_or(Value::String(String::new()));
            let mut control = Map::new();
            control.insert("kind".to_string(), Value::String("value".to_string()));
            control.insert("value".to_string(), value);
            control
        };
        node.insert("control".to_string(), Value::Object(control));
    }

    let children = element
        .get("children")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    if element_type == "list" && !children.is_empty() {
        let rows: Vec<Value> = props
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .enumerate()
            .map(|(index, item)| {
                let key = item
                    .as_object()
                    .and_then(|record| record.get("id"))
                    .map(js_to_string)
                    .unwrap_or_else(|| index.to_string());
                let row_scope = Scope { item: &item };
                let row_children = resolve_children(&children, ctx, Some(&row_scope));
                let mut row = Map::new();
                row.insert("key".to_string(), Value::String(key));
                row.insert("item".to_string(), item);
                row.insert("children".to_string(), Value::Array(row_children));
                Value::Object(row)
            })
            .collect();
        node.insert("props".to_string(), Value::Object(props));
        node.insert("children".to_string(), Value::Array(Vec::new()));
        node.insert("rows".to_string(), Value::Array(rows));
        return Some(Value::Object(node));
    }

    node.insert("props".to_string(), Value::Object(props));
    node.insert(
        "children".to_string(),
        Value::Array(resolve_children(&children, ctx, scope)),
    );
    Some(Value::Object(node))
}

/// A binding resolving to the webview's undefined is None here: the prop
/// stays absent instead of null.
fn resolve_data_binding(
    binding: &Map<String, Value>,
    ctx: &ViewContext,
    scope: Option<&Scope>,
) -> Option<Value> {
    let source = binding.get("source").and_then(Value::as_str).unwrap_or("");
    let source_id = binding.get("sourceId").and_then(Value::as_str).unwrap_or("");
    let raw: Option<Value> = match source {
        "state" => ctx.state.get(source_id).cloned(),
        "operation" => ctx.state.get(&format!("operation_{}", source_id)).cloned(),
        "constant" => Some(
            binding
                .get("value")
                .cloned()
                .unwrap_or(Value::String(source_id.to_string())),
        ),
        "item" => match scope {
            Some(scope) => match get_value_at_path(scope.item, source_id) {
                Value::Null => None,
                value => Some(value),
            },
            None => None,
        },
        _ => Some(Value::Null),
    };

    let transforms: Option<Vec<TransformStep>> = binding
        .get("transforms")
        .and_then(|steps| serde_json::from_value(steps.clone()).ok());
    let single: Option<TransformStep> = binding
        .get("transform")
        .and_then(|step| serde_json::from_value(step.clone()).ok());
    let has_pipeline = transforms.as_ref().is_some_and(|steps| !steps.is_empty());

    if !has_pipeline && single.is_none() {
        return raw;
    }

    let lookup = |ref_source: &str, ref_id: &str| -> Value {
        let key = if ref_source == "element" {
            format!("element_{}", ref_id)
        } else {
            ref_id.to_string()
        };
        ctx.state.get(&key).cloned().unwrap_or(Value::Null)
    };
    let input = raw.unwrap_or(Value::Null);
    if has_pipeline {
        return Some(apply_pipeline_with(&input, &transforms.unwrap(), Some(&lookup)));
    }
    // The legacy singular transform skips null (and the webview's undefined).
    Some(apply_legacy_single_with(&input, &single.unwrap(), Some(&lookup)))
}

fn is_visible(element: &Map<String, Value>, ctx: &ViewContext, scope: Option<&Scope>) -> bool {
    let Some(raw) = element.get("visibleWhen") else {
        return true;
    };
    let conditions: Vec<&Value> = match raw {
        Value::Array(list) => list.iter().collect(),
        other => vec![other],
    };
    conditions
        .iter()
        .all(|condition| evaluate_condition(condition, ctx, scope))
}

fn evaluate_condition(condition: &Value, ctx: &ViewContext, scope: Option<&Scope>) -> bool {
    let source = condition.get("source").and_then(Value::as_str).unwrap_or("");
    let source_id = condition.get("sourceId").and_then(Value::as_str).unwrap_or("");
    // Missing state keys are the webview's undefined: distinct from null in
    // numeric comparisons (Number(undefined) is NaN, Number(null) is 0).
    let read: Option<Value> = if source == "state" {
        ctx.state.get(source_id).cloned()
    } else {
        match scope {
            Some(scope) => match get_value_at_path(scope.item, source_id) {
                Value::Null => None,
                value => Some(value),
            },
            None => None,
        }
    };

    let transforms: Option<Vec<TransformStep>> = condition
        .get("transforms")
        .and_then(|steps| serde_json::from_value(steps.clone()).ok());
    let (value, was_undefined) = match transforms {
        Some(steps) if !steps.is_empty() => {
            let lookup = |ref_source: &str, ref_id: &str| -> Value {
                let key = if ref_source == "element" {
                    format!("element_{}", ref_id)
                } else {
                    ref_id.to_string()
                };
                ctx.state.get(&key).cloned().unwrap_or(Value::Null)
            };
            let input = read.clone().unwrap_or(Value::Null);
            (apply_pipeline_with(&input, &steps, Some(&lookup)), false)
        }
        _ => (read.clone().unwrap_or(Value::Null), read.is_none()),
    };

    let wanted = condition.get("value").unwrap_or(&Value::Null);
    let number = |v: &Value, undefined: bool| -> f64 {
        if undefined {
            f64::NAN
        } else {
            js_to_number(v)
        }
    };
    match condition.get("operator").and_then(Value::as_str) {
        Some("truthy") => js_truthy(&value) && !was_undefined,
        Some("falsy") => !(js_truthy(&value) && !was_undefined),
        Some("empty") => match &value {
            Value::Array(items) => items.is_empty(),
            Value::Null => true,
            other => js_to_string(other).is_empty(),
        },
        Some("notEmpty") => match &value {
            Value::Array(items) => !items.is_empty(),
            Value::Null => false,
            other => !js_to_string(other).is_empty(),
        },
        Some("equals") => loose_equals(&value, wanted),
        Some("notEquals") => !loose_equals(&value, wanted),
        Some("gt") => number(&value, was_undefined) > js_to_number(wanted),
        Some("gte") => number(&value, was_undefined) >= js_to_number(wanted),
        Some("lt") => number(&value, was_undefined) < js_to_number(wanted),
        Some("lte") => number(&value, was_undefined) <= js_to_number(wanted),
        _ => true,
    }
}
