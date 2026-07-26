//! JavaScript value semantics over JSON values: the coercions the webview
//! runtime performs implicitly (Number(), String(), truthiness, loose
//! equality) made explicit, so transform behavior matches to the bit. The
//! supported envelope is what the conformance vectors cover; exotic
//! coercions outside it (hex number strings, arrays as numbers) are not part
//! of the kernel contract.

use serde_json::Value;

/// Number(value): null and empty strings are 0, booleans are 0/1, numeric
/// strings parse trimmed, everything unparseable is NaN.
pub fn js_to_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(b) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                0.0
            } else {
                trimmed.parse::<f64>().unwrap_or(f64::NAN)
            }
        }
        Value::Array(_) | Value::Object(_) => f64::NAN,
    }
}

/// Number.prototype.toString for the ranges contracts use: integral values
/// print without a decimal part, everything else prints the shortest
/// round-trip representation.
pub fn js_number_to_string(n: f64) -> String {
    if n.is_nan() {
        return "NaN".to_string();
    }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity" } else { "-Infinity" }.to_string();
    }
    if n == n.trunc() && n.abs() < 1e21 {
        return format!("{}", n.trunc() as i128);
    }
    format!("{}", n)
}

/// String(value) for the shapes bindings produce.
pub fn js_to_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => s.clone(),
        // Array.prototype.toString: elements joined with commas, nulls empty.
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_to_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// JavaScript truthiness.
pub fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => {
            let f = n.as_f64().unwrap_or(f64::NAN);
            f != 0.0 && !f.is_nan()
        }
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// The registry's looseEquals: strict equality (numbers compare as doubles)
/// or equal string forms.
pub fn loose_equals(a: &Value, b: &Value) -> bool {
    let strict = match (a, b) {
        (Value::Number(x), Value::Number(y)) => {
            x.as_f64().unwrap_or(f64::NAN) == y.as_f64().unwrap_or(f64::NAN)
        }
        _ => a == b,
    };
    strict || js_to_string(a) == js_to_string(b)
}

/// Resolves a dot path; an empty path returns the value itself and anything
/// unresolvable is Null (the JSON form of undefined).
pub fn get_value_at_path(value: &Value, path: &str) -> Value {
    if path.is_empty() {
        return value.clone();
    }
    let mut current = value;
    for segment in path.split('.') {
        current = match current {
            Value::Object(map) => match map.get(segment) {
                Some(next) => next,
                None => return Value::Null,
            },
            Value::Array(items) => match segment.parse::<usize>().ok().and_then(|i| items.get(i)) {
                Some(next) => next,
                None => return Value::Null,
            },
            _ => return Value::Null,
        };
    }
    current.clone()
}

/// fieldOf: an absent or empty field parameter reads the whole item.
pub fn field_of(item: &Value, field: &Value) -> Value {
    match field {
        Value::Null => item.clone(),
        Value::String(s) if s.is_empty() => item.clone(),
        other => get_value_at_path(item, &js_to_string(other)),
    }
}

/// Math.round: half rounds toward positive infinity, unlike f64::round.
pub fn js_math_round(x: f64) -> f64 {
    (x + 0.5).floor()
}
