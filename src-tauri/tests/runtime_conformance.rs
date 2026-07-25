//! Runs the committed runtime conformance vectors against the Rust kernel.
//! The same vectors run against the TypeScript kernel in
//! src/services/operations/__tests__/runtime-conformance.test.ts; together
//! they hold the two implementations to identical semantics.

use dynamic_experience_runtime_lib::runtime::expression::parse_row_expression;
use dynamic_experience_runtime_lib::runtime::env::ScriptedEnv;
use dynamic_experience_runtime_lib::runtime::operations::execute_builtin;
use dynamic_experience_runtime_lib::runtime::session::{OperationSpec, Session};
use dynamic_experience_runtime_lib::runtime::transforms::{
    apply_legacy_single, apply_pipeline, apply_transform, TransformStep,
};
use serde_json::{Map, Value};

fn env_from(vector: &Value) -> ScriptedEnv {
    ScriptedEnv {
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
            Box::new(env_from(vector)),
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

/// Object keys holding null and absent keys are equivalent in the view
/// protocol; arrays keep nulls as real entries.
fn strip_null_keys(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(strip_null_keys).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(_, entry)| !entry.is_null())
                .map(|(key, entry)| (key.clone(), strip_null_keys(entry)))
                .collect(),
        ),
        other => other.clone(),
    }
}

#[test]
fn template_vectors_match() {
    use dynamic_experience_runtime_lib::runtime::templates::{
        expand_ui_fragment, instantiate_pack_operations,
    };
    let fixtures = fixture("templates.json");
    let vectors = fixtures["templates"].as_array().expect("template vectors");
    let mut failures = Vec::new();
    for vector in vectors {
        let name = vector["name"].as_str().unwrap_or("?");
        let def = vector["def"].as_object().expect("def");
        let instance = vector["instance"].as_object().expect("instance");
        let actual = match vector["kind"].as_str() {
            Some("fragment") => match expand_ui_fragment(instance, def) {
                Ok(expanded) => expanded,
                Err(error) => {
                    failures.push(format!("{}: expansion failed: {}", name, error));
                    continue;
                }
            },
            _ => Value::Array(instantiate_pack_operations(instance, def)),
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
fn view_vectors_match() {
    use dynamic_experience_runtime_lib::runtime::view::{resolve_view_tree, ViewContext};
    let fixtures = fixture("views.json");
    let vectors = fixtures["views"].as_array().expect("view vectors");
    let mut failures = Vec::new();
    for vector in vectors {
        let name = vector["name"].as_str().unwrap_or("?");
        let elements = vector["elements"].as_array().cloned().unwrap_or_default();
        let state = params_of(vector, "state");
        let fragment_defs = params_of(vector, "fragmentDefs");
        let ctx = ViewContext {
            state: &state,
            fragment_defs: &fragment_defs,
        };
        let tree = strip_null_keys(&Value::Array(resolve_view_tree(&elements, &ctx)));
        if !semantically_equal(&tree, &vector["expected"]) {
            failures.push(format!(
                "{}: tree mismatch\n  actual: {}\n  expected: {}",
                name, tree, vector["expected"]
            ));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

#[test]
fn streaming_vectors_match() {
    use dynamic_experience_runtime_lib::runtime::streaming::{
        extract_streaming_contract, parse_partial_json,
    };
    let fixtures = fixture("streaming.json");
    let vectors = fixtures["streaming"].as_array().expect("streaming vectors");
    let mut failures = Vec::new();
    for vector in vectors {
        let name = vector["name"].as_str().unwrap_or("?");
        let raw = vector["raw"].as_str().expect("raw text");
        let expected_recovered = vector["partialRecovered"].as_bool() == Some(true);

        match parse_partial_json(raw) {
            Some(partial) => {
                if !expected_recovered {
                    failures.push(format!("{}: unexpected recovery", name));
                } else if !semantically_equal(&partial, &vector["partial"]) {
                    failures.push(format!(
                        "{}: partial mismatch\n  actual: {}\n  expected: {}",
                        name, partial, vector["partial"]
                    ));
                }
            }
            None => {
                if expected_recovered {
                    failures.push(format!("{}: expected recovery", name));
                }
            }
        }

        match extract_streaming_contract(raw) {
            Some(contract) => {
                if vector["contract"].is_null() {
                    failures.push(format!("{}: unexpected contract", name));
                } else if !semantically_equal(&contract, &vector["contract"]) {
                    failures.push(format!(
                        "{}: contract mismatch\n  actual: {}\n  expected: {}",
                        name, contract, vector["contract"]
                    ));
                }
            }
            None => {
                if !vector["contract"].is_null() {
                    failures.push(format!("{}: expected a contract", name));
                }
            }
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
