//! The transform registry's Rust twin, over JSON values. Every deterministic
//! transform from src/services/operations/transforms.ts is here with
//! JavaScript-identical semantics; formatNumber and formatDate are absent on
//! purpose (locale presentation belongs to the renderer displaying the
//! value). Held to the TypeScript kernel by the conformance vectors.

use serde_json::{Map, Value};

use super::expression::parse_row_expression;
use super::value::{
    field_of, js_math_round, js_to_number, js_to_string, js_truthy, loose_equals,
};

fn as_array(value: &Value) -> Vec<Value> {
    match value {
        Value::Array(items) => items.clone(),
        _ => Vec::new(),
    }
}

fn param<'a>(parameters: &'a Map<String, Value>, name: &str) -> &'a Value {
    parameters.get(name).unwrap_or(&Value::Null)
}

fn number_value(f: f64) -> Value {
    serde_json::Number::from_f64(f)
        .map(Value::Number)
        .unwrap_or(Value::Null)
}

/// Applies one transform. Unknown names pass the value through, matching the
/// pipeline's skip-with-warning behavior in the webview.
pub fn apply_transform(name: &str, value: &Value, parameters: &Map<String, Value>) -> Value {
    match name {
        "count" => Value::from(as_array(value).len() as u64),
        "sum" => {
            let field = param(parameters, "field");
            let total = as_array(value).iter().fold(0.0, |acc, item| {
                let n = js_to_number(&field_of(item, field));
                acc + if n.is_nan() { 0.0 } else { n }
            });
            number_value(total)
        }
        "filterBy" => {
            let wanted = param(parameters, "value");
            let keep_all = matches!(wanted, Value::Null)
                || matches!(wanted, Value::String(s) if s.is_empty());
            if keep_all {
                return Value::Array(as_array(value));
            }
            let field = param(parameters, "field");
            Value::Array(
                as_array(value)
                    .into_iter()
                    .filter(|item| loose_equals(&field_of(item, field), wanted))
                    .collect(),
            )
        }
        "filterContains" => {
            let needle = js_to_string_or_empty(param(parameters, "value")).to_lowercase();
            if needle.is_empty() {
                return Value::Array(as_array(value));
            }
            let field = param(parameters, "field");
            Value::Array(
                as_array(value)
                    .into_iter()
                    .filter(|item| {
                        js_to_string_or_empty(&field_of(item, field))
                            .to_lowercase()
                            .contains(&needle)
                    })
                    .collect(),
            )
        }
        "filterTruthy" => {
            let field = param(parameters, "field");
            Value::Array(
                as_array(value)
                    .into_iter()
                    .filter(|item| js_truthy(&field_of(item, field)))
                    .collect(),
            )
        }
        "filterFalsy" => {
            let field = param(parameters, "field");
            Value::Array(
                as_array(value)
                    .into_iter()
                    .filter(|item| !js_truthy(&field_of(item, field)))
                    .collect(),
            )
        }
        "sortBy" => {
            let field = param(parameters, "field");
            let descending = matches!(param(parameters, "direction"), Value::String(s) if s == "desc");
            let mut items = as_array(value);
            items.sort_by(|a, b| {
                let av = field_of(a, field);
                let bv = field_of(b, field);
                let an = js_to_number(&av);
                let bn = js_to_number(&bv);
                let ordering = if an.is_finite() && bn.is_finite() {
                    an.partial_cmp(&bn).unwrap_or(std::cmp::Ordering::Equal)
                } else {
                    js_string_for_sort(&av).cmp(&js_string_for_sort(&bv))
                };
                if descending {
                    ordering.reverse()
                } else {
                    ordering
                }
            });
            Value::Array(items)
        }
        "groupSum" => {
            let by = param(parameters, "by");
            let field = param(parameters, "field");
            // First-seen key order, like the JS Map.
            let mut order: Vec<String> = Vec::new();
            let mut totals: Map<String, Value> = Map::new();
            for item in as_array(value) {
                // String(x ?? ''): null and missing group under the empty key.
                let key = match field_of(&item, by) {
                    Value::Null => String::new(),
                    other => js_to_string(&other),
                };
                let amount = {
                    let n = js_to_number(&field_of(&item, field));
                    if n.is_nan() { 0.0 } else { n }
                };
                let current = totals
                    .get(&key)
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0);
                if !totals.contains_key(&key) {
                    order.push(key.clone());
                }
                totals.insert(key, number_value(current + amount));
            }
            Value::Array(
                order
                    .into_iter()
                    .map(|key| {
                        let mut row = Map::new();
                        let sum = totals.get(&key).cloned().unwrap_or(Value::Null);
                        row.insert("key".to_string(), Value::String(key));
                        row.insert("sum".to_string(), sum);
                        Value::Object(row)
                    })
                    .collect(),
            )
        }
        "pick" => {
            let source = match value {
                Value::Array(items) => items.first().cloned().unwrap_or(Value::Null),
                other => other.clone(),
            };
            field_of(&source, param(parameters, "field"))
        }
        "pluck" => {
            let field = param(parameters, "field");
            Value::Array(
                as_array(value)
                    .iter()
                    .map(|item| field_of(item, field))
                    .collect(),
            )
        }
        "equals" => Value::Bool(loose_equals(value, param(parameters, "value"))),
        "not" => Value::Bool(!js_truthy(value)),
        "parseNumber" => {
            let n = js_to_number(value);
            number_value(if n.is_nan() { 0.0 } else { n })
        }
        "round" => {
            let n = js_to_number(value);
            if !n.is_finite() {
                return value.clone();
            }
            let decimals = {
                let d = js_to_number(param(parameters, "decimals"));
                if d.is_nan() {
                    0
                } else {
                    d as i32
                }
            };
            let factor = 10f64.powi(decimals);
            let rounded = js_math_round(n * factor) / factor;
            if decimals > 0 {
                Value::String(format!("{:.*}", decimals as usize, rounded))
            } else {
                number_value(rounded)
            }
        }
        "format" => {
            let template = match param(parameters, "template") {
                Value::String(s) => s.clone(),
                _ => return value.clone(),
            };
            let inserted = match value {
                Value::Null => String::new(),
                other => js_to_string(other),
            };
            let mut out = template.replacen("{{value}}", &inserted, 1);
            // Named slots: {{ssid}} fills from parameters.ssid, already
            // resolved when it was a live reference. Left-to-right over the
            // current text, matching the JS regex-replace pass.
            let mut result = String::with_capacity(out.len());
            while let Some(start) = out.find("{{") {
                let Some(rel_end) = out[start + 2..].find("}}") else {
                    break;
                };
                let name = out[start + 2..start + 2 + rel_end].to_string();
                let is_identifier = !name.is_empty()
                    && name
                        .chars()
                        .enumerate()
                        .all(|(i, c)| c == '_' || c.is_ascii_alphabetic() || (i > 0 && c.is_ascii_digit()));
                result.push_str(&out[..start]);
                if is_identifier && name != "value" {
                    match parameters.get(&name) {
                        Some(Value::Null) => {}
                        Some(slot) => result.push_str(&js_to_string(slot)),
                        None => {
                            result.push_str("{{");
                            result.push_str(&name);
                            result.push_str("}}");
                        }
                    }
                } else {
                    result.push_str("{{");
                    result.push_str(&name);
                    result.push_str("}}");
                }
                out = out[start + 4 + rel_end..].to_string();
            }
            result.push_str(&out);
            Value::String(result)
        }
        "map" => {
            let mapping = match param(parameters, "mapping") {
                Value::Object(map) => map,
                _ => return value.clone(),
            };
            match mapping.get(&js_to_string(value)) {
                Some(Value::Null) | None => value.clone(),
                Some(mapped) => mapped.clone(),
            }
        }
        "deriveField" => derive_field(value, parameters),
        _ => value.clone(),
    }
}

/// String(fieldOf(...) ?? '') as filterContains performs it: null reads as
/// the empty string rather than "null".
fn js_to_string_or_empty(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        other => js_to_string(other),
    }
}

/// String coercion inside sortBy's fallback: String(av ?? '').
fn js_string_for_sort(value: &Value) -> String {
    js_to_string_or_empty(value)
}

fn derive_field(value: &Value, parameters: &Map<String, Value>) -> Value {
    let field = match param(parameters, "field") {
        Value::String(s) if !s.is_empty() => s.clone(),
        _ => return Value::Array(as_array(value)),
    };
    let source = match param(parameters, "expression") {
        Value::String(s) if !s.is_empty() => s.clone(),
        _ => return Value::Array(as_array(value)),
    };
    let parsed = match parse_row_expression(&source) {
        Ok(parsed) => parsed,
        Err(_) => return Value::Array(as_array(value)),
    };
    Value::Array(
        as_array(value)
            .into_iter()
            .map(|item| match item {
                Value::Object(mut row) => {
                    let result = parsed
                        .evaluate(&row)
                        .ok()
                        .map(number_value)
                        .unwrap_or(Value::Null);
                    row.insert(field.clone(), result);
                    Value::Object(row)
                }
                other => other,
            })
            .collect(),
    )
}

#[derive(serde::Deserialize, Clone)]
pub struct TransformStep {
    #[serde(rename = "type")]
    pub step_type: String,
    #[serde(default)]
    pub parameters: Map<String, Value>,
}

/// Live parameter resolution: (source, sourceId) against current state, the
/// webview's TransformContext.lookup.
pub type ParamLookup<'a> = &'a dyn Fn(&str, &str) -> Value;

/// A parameter of exactly the shape {"source": "state"|"element", "sourceId"}
/// is a live reference; matches the webview's isParamRef byte for byte.
fn param_ref_of(value: &Value) -> Option<(&str, &str)> {
    let map = value.as_object()?;
    if map.len() != 2 {
        return None;
    }
    let source = map.get("source")?.as_str()?;
    let source_id = map.get("sourceId")?.as_str()?;
    // "ui-element" is the operation-input spelling of the same thing.
    if source == "state" || source == "element" || source == "ui-element" {
        Some((source, source_id))
    } else {
        None
    }
}

/// Replaces live references with looked-up values. Without a lookup a
/// reference still resolves, to null, exactly as the webview resolves it to
/// undefined when no context is supplied.
fn resolve_parameters(
    parameters: &Map<String, Value>,
    lookup: Option<ParamLookup>,
) -> Map<String, Value> {
    let mut resolved = parameters.clone();
    for (_, value) in resolved.iter_mut() {
        if let Some((source, source_id)) = param_ref_of(value) {
            *value = match lookup {
                Some(lookup) => lookup(source, source_id),
                None => Value::Null,
            };
        }
    }
    resolved
}

/// A transforms pipeline runs every step null-safely, like the webview's
/// applyTransformPipeline.
pub fn apply_pipeline(value: &Value, steps: &[TransformStep]) -> Value {
    apply_pipeline_with(value, steps, None)
}

pub fn apply_pipeline_with(
    value: &Value,
    steps: &[TransformStep],
    lookup: Option<ParamLookup>,
) -> Value {
    steps.iter().fold(value.clone(), |current, step| {
        let parameters = resolve_parameters(&step.parameters, lookup);
        apply_transform(&step.step_type, &current, &parameters)
    })
}

/// The legacy singular transform skips null input entirely.
pub fn apply_legacy_single(value: &Value, step: &TransformStep) -> Value {
    apply_legacy_single_with(value, step, None)
}

pub fn apply_legacy_single_with(
    value: &Value,
    step: &TransformStep,
    lookup: Option<ParamLookup>,
) -> Value {
    if value.is_null() {
        return value.clone();
    }
    let parameters = resolve_parameters(&step.parameters, lookup);
    apply_transform(&step.step_type, value, &parameters)
}
