//! Runs the committed runtime conformance vectors against the Rust kernel.
//! The same vectors run against the TypeScript kernel in
//! src/services/operations/__tests__/runtime-conformance.test.ts; together
//! they hold the two implementations to identical semantics.

use dynamic_experience_runtime_lib::runtime::expression::parse_row_expression;
use dynamic_experience_runtime_lib::runtime::operations::{execute_builtin, OpEnv};
use dynamic_experience_runtime_lib::runtime::session::{OperationSpec, Session};
use dynamic_experience_runtime_lib::runtime::transforms::{
    apply_legacy_single, apply_pipeline, apply_transform, TransformStep,
};
use serde_json::{Map, Value};

fn env_from(vector: &Value) -> OpEnv {
    OpEnv {
        ids: vector["env"]["ids"]
            .as_array()
            .map(|ids| {
                ids.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
        randoms: vector["env"]["randoms"]
            .as_array()
            .map(|rolls| rolls.iter().filter_map(Value::as_f64).collect())
            .unwrap_or_default(),
        epoch_ms: vector["env"]["epochMs"].as_i64().unwrap_or(0),
        tz_offset_minutes: 0,
    }
}

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
fn operation_vectors_match() {
    let fixtures = fixture("operations.json");
    let vectors = fixtures["operations"].as_array().expect("operation vectors");
    let mut failures = Vec::new();
    for vector in vectors {
        let name = vector["name"].as_str().unwrap_or("?");
        let operation = vector["operation"].as_str().expect("operation name");
        let inputs = params_of(vector, "inputs");
        let mut state = params_of(vector, "state");
        let mut env = env_from(vector);
        let expected_error = vector["error"].as_bool() == Some(true);
        let shape_only: Vec<&str> = vector["shapeOnlyOutputs"]
            .as_array()
            .map(|names| names.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();

        match execute_builtin(operation, &inputs, &mut state, &mut env) {
            Ok(outputs) => {
                if expected_error {
                    failures.push(format!("{}: expected an error", name));
                    continue;
                }
                if !semantically_equal(&Value::Object(state), &vector["expected"]["state"]) {
                    failures.push(format!("{}: state mismatch", name));
                    continue;
                }
                let expected_outputs = vector["expected"]["outputs"]
                    .as_object()
                    .cloned()
                    .unwrap_or_default();
                for (out_name, value) in &outputs {
                    if shape_only.contains(&out_name.as_str()) {
                        let text = value.as_str().unwrap_or("");
                        let ok = match out_name.as_str() {
                            "date" => {
                                text.len() == 10
                                    && text.chars().enumerate().all(|(i, c)| {
                                        if i == 4 || i == 7 { c == '-' } else { c.is_ascii_digit() }
                                    })
                            }
                            "time" => {
                                text.len() == 5
                                    && text.chars().enumerate().all(|(i, c)| {
                                        if i == 2 { c == ':' } else { c.is_ascii_digit() }
                                    })
                            }
                            _ => false,
                        };
                        if !ok {
                            failures.push(format!("{}: {} shape mismatch: {}", name, out_name, text));
                        }
                    } else if !expected_outputs
                        .get(out_name)
                        .is_some_and(|expected| semantically_equal(value, expected))
                    {
                        failures.push(format!("{}: output {} mismatch: {}", name, out_name, value));
                    }
                }
                let mut actual_names: Vec<&str> = outputs.keys().map(String::as_str).collect();
                actual_names.sort_unstable();
                let mut expected_names: Vec<&str> = expected_outputs
                    .keys()
                    .map(String::as_str)
                    .chain(shape_only.iter().copied())
                    .collect();
                expected_names.sort_unstable();
                if actual_names != expected_names {
                    failures.push(format!("{}: output names {:?} expected {:?}", name, actual_names, expected_names));
                }
            }
            Err(error) => {
                if !expected_error {
                    failures.push(format!("{}: unexpected error {}", name, error));
                } else if !semantically_equal(&Value::Object(state), &vector["expected"]["state"]) {
                    failures.push(format!("{}: state changed on error", name));
                }
            }
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

#[test]
fn session_vectors_match() {
    let fixtures = fixture("sessions.json");
    let vectors = fixtures["sessions"].as_array().expect("session vectors");
    let mut failures = Vec::new();
    for vector in vectors {
        let name = vector["name"].as_str().unwrap_or("?");
        let operations: Vec<OperationSpec> =
            serde_json::from_value(vector["operations"].clone()).expect("operations parse");
        let elements = vector["elements"].as_array().cloned().unwrap_or_default();
        let mut session = Session::new(
            operations,
            params_of(vector, "initialState"),
            &elements,
            env_from(vector),
        );
        let mut failed: Vec<String> = Vec::new();

        for event in vector["events"].as_array().unwrap_or(&Vec::new()) {
            match event["do"].as_str() {
                Some("setElement") => {
                    session.set_element(
                        event["elementId"].as_str().unwrap_or(""),
                        event["value"].clone(),
                    );
                }
                Some("chain") => {
                    let ids: Vec<String> = event["operationIds"]
                        .as_array()
                        .map(|ids| {
                            ids.iter()
                                .filter_map(Value::as_str)
                                .map(str::to_string)
                                .collect()
                        })
                        .unwrap_or_default();
                    let item = event.get("item").filter(|value| !value.is_null());
                    if let Some(failed_id) = session.run_chain(&ids, item) {
                        failed.push(failed_id);
                    }
                }
                other => failures.push(format!("{}: unknown event {:?}", name, other)),
            }
        }

        let expected_failed: Vec<String> = vector["expected"]["failed"]
            .as_array()
            .map(|ids| {
                ids.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        if failed != expected_failed {
            failures.push(format!("{}: failed {:?} expected {:?}", name, failed, expected_failed));
        }
        if !semantically_equal(
            &Value::Object(session.state().clone()),
            &vector["expected"]["data"],
        ) {
            failures.push(format!(
                "{}: state mismatch\n  actual: {}\n  expected: {}",
                name,
                Value::Object(session.state().clone()),
                vector["expected"]["data"]
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
