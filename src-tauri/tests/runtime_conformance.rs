//! Runs the committed runtime conformance vectors against the Rust kernel.
//! The same vectors run against the TypeScript kernel in
//! src/services/operations/__tests__/runtime-conformance.test.ts; together
//! they hold the two implementations to identical semantics.

use dynamic_experience_runtime_lib::runtime::expression::parse_row_expression;
use dynamic_experience_runtime_lib::runtime::transforms::{
    apply_legacy_single, apply_pipeline, apply_transform, TransformStep,
};
use serde_json::{Map, Value};

fn fixture(name: &str) -> Value {
    let raw = std::fs::read_to_string(format!("../runtime-conformance/{}", name))
        .expect("conformance fixtures present");
    serde_json::from_str(&raw).expect("fixtures parse")
}

/// JSON equality with numbers compared as doubles: the fixtures write 6
/// where a computation produces 6.0, and both mean the same JS number.
fn semantically_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => {
            x.as_f64().unwrap_or(f64::NAN) == y.as_f64().unwrap_or(f64::NAN)
        }
        (Value::Array(xs), Value::Array(ys)) => {
            xs.len() == ys.len() && xs.iter().zip(ys).all(|(x, y)| semantically_equal(x, y))
        }
        (Value::Object(xs), Value::Object(ys)) => {
            xs.len() == ys.len()
                && xs
                    .iter()
                    .all(|(k, x)| ys.get(k).is_some_and(|y| semantically_equal(x, y)))
        }
        _ => a == b,
    }
}

fn params_of(vector: &Value, key: &str) -> Map<String, Value> {
    vector
        .get(key)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

#[test]
fn transform_vectors_match() {
    let fixtures = fixture("transforms.json");
    let vectors = fixtures["transforms"].as_array().expect("transform vectors");
    let mut failures = Vec::new();
    for vector in vectors {
        let name = vector["name"].as_str().unwrap_or("?");
        let transform = vector["transform"].as_str().expect("transform name");
        let parameters = params_of(vector, "parameters");
        let actual = apply_transform(transform, &vector["input"], &parameters);
        if !semantically_equal(&actual, &vector["expected"]) {
            failures.push(format!(
                "{}: expected {} got {}",
                name, vector["expected"], actual
            ));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

#[test]
fn pipeline_vectors_match() {
    let fixtures = fixture("transforms.json");
    let vectors = fixtures["pipelines"].as_array().expect("pipeline vectors");
    let mut failures = Vec::new();
    for vector in vectors {
        let name = vector["name"].as_str().unwrap_or("?");
        let steps: Vec<TransformStep> =
            serde_json::from_value(vector["steps"].clone()).expect("steps parse");
        let legacy = vector["legacySingle"].as_bool().unwrap_or(false);
        let actual = if legacy {
            apply_legacy_single(&vector["input"], &steps[0])
        } else {
            apply_pipeline(&vector["input"], &steps)
        };
        if !semantically_equal(&actual, &vector["expected"]) {
            failures.push(format!(
                "{}: expected {} got {}",
                name, vector["expected"], actual
            ));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

#[test]
fn expression_vectors_match() {
    let fixtures = fixture("expressions.json");
    let vectors = fixtures["expressions"].as_array().expect("expression vectors");
    let mut failures = Vec::new();
    for vector in vectors {
        let name = vector["name"].as_str().unwrap_or("?");
        let source = vector["expression"].as_str().expect("expression");
        let parsed = match parse_row_expression(source) {
            Ok(parsed) => {
                if vector["parseError"].as_bool() == Some(true) {
                    failures.push(format!("{}: expected a parse error", name));
                    continue;
                }
                parsed
            }
            Err(error) => {
                if vector["parseError"].as_bool() != Some(true) {
                    failures.push(format!("{}: unexpected parse error {}", name, error));
                }
                continue;
            }
        };

        let mut identifiers = parsed.identifiers.clone();
        identifiers.sort();
        let expected_identifiers: Vec<String> = vector["identifiers"]
            .as_array()
            .map(|ids| {
                ids.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        if identifiers != expected_identifiers {
            failures.push(format!(
                "{}: identifiers {:?} expected {:?}",
                name, identifiers, expected_identifiers
            ));
        }

        let Some(row) = vector.get("row").and_then(Value::as_object) else {
            continue;
        };
        match parsed.evaluate(row) {
            Ok(value) => {
                if vector["evalError"].as_bool() == Some(true) {
                    failures.push(format!("{}: expected an evaluation error", name));
                } else {
                    let expected = vector["value"].as_f64().unwrap_or(f64::NAN);
                    if value != expected {
                        failures.push(format!("{}: value {} expected {}", name, value, expected));
                    }
                }
            }
            Err(error) => {
                if vector["evalError"].as_bool() != Some(true) {
                    failures.push(format!("{}: unexpected evaluation error {}", name, error));
                }
            }
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}
