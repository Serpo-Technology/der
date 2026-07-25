//! The registry snapshot: knob tables, builtin operation shapes, transform
//! output kinds, and the style vocabulary, generated from the TypeScript
//! registry into runtime-conformance/registry.json and embedded here at
//! compile time so both checkers read one source of truth.

use std::sync::OnceLock;

use serde_json::Value;

static REGISTRY: OnceLock<Value> = OnceLock::new();

pub fn registry() -> &'static Value {
    REGISTRY.get_or_init(|| {
        serde_json::from_str(include_str!("../../../runtime-conformance/registry.json"))
            .expect("registry snapshot parses")
    })
}

pub fn builtin_def(name: &str) -> Option<&'static Value> {
    registry().get("operations").and_then(|ops| ops.get(name))
}

pub fn element_knobs(element_type: &str) -> Option<&'static Vec<Value>> {
    registry()
        .get("elements")
        .and_then(|elements| elements.get(element_type))
        .and_then(|manifest| manifest.get("knobs"))
        .and_then(Value::as_array)
}

pub fn transform_output(name: &str) -> Option<&'static str> {
    registry()
        .get("transforms")
        .and_then(Value::as_array)
        .and_then(|transforms| {
            transforms
                .iter()
                .find(|entry| entry.get("name").and_then(Value::as_str) == Some(name))
        })
        .and_then(|entry| entry.get("output"))
        .and_then(Value::as_str)
}

pub fn is_known_transform(name: &str) -> bool {
    transform_output(name).is_some()
}

/// The registry's transform names in declaration order, for the
/// unknown-transform message.
pub fn transform_names() -> Vec<&'static str> {
    registry()
        .get("transforms")
        .and_then(Value::as_array)
        .map(|transforms| {
            transforms
                .iter()
                .filter_map(|entry| entry.get("name").and_then(Value::as_str))
                .collect()
        })
        .unwrap_or_default()
}

/// Plain HTML tag names the renderer accepts as element types.
pub fn intrinsic_elements() -> Vec<&'static str> {
    registry()
        .get("intrinsicElements")
        .and_then(Value::as_array)
        .map(|names| names.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default()
}

pub fn expr_reserved(identifier: &str) -> bool {
    registry()
        .get("exprReserved")
        .and_then(Value::as_array)
        .is_some_and(|reserved| {
            reserved
                .iter()
                .any(|entry| entry.as_str() == Some(identifier))
        })
}
