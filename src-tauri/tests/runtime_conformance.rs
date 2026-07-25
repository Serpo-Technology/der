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
fn validation_vectors_match() {
    use dynamic_experience_runtime_lib::runtime::validation::check_against_manifests;
    let fixtures = fixture("validation.json");
    let vectors = fixtures["validation"].as_array().expect("validation vectors");
    let mut failures = Vec::new();
    for vector in vectors {
        let name = vector["name"].as_str().unwrap_or("?");
        let mut contract = vector["contract"].clone();
        let empty = serde_json::Map::new();
        let fragment_defs = vector["fragmentDefs"].as_object().unwrap_or(&empty);
        let part_operations = vector["partOperations"].as_object().unwrap_or(&empty);
        let credentials: Vec<Value> = vector["credentials"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let outcome =
            check_against_manifests(&mut contract, fragment_defs, part_operations, &credentials);
        if !semantically_equal(&Value::Array(outcome.errors.clone()), &vector["expected"]["errors"]) {
            failures.push(format!(
                "{}: errors mismatch
  actual: {}
  expected: {}",
                name,
                Value::Array(outcome.errors),
                vector["expected"]["errors"]
            ));
            continue;
        }
        if !semantically_equal(&Value::Array(outcome.warnings.clone()), &vector["expected"]["warnings"]) {
            failures.push(format!(
                "{}: warnings mismatch
  actual: {}
  expected: {}",
                name,
                Value::Array(outcome.warnings),
                vector["expected"]["warnings"]
            ));
            continue;
        }
        if !semantically_equal(&contract, &vector["expected"]["mutated"]) {
            failures.push(format!(
                "{}: mutation mismatch
  actual: {}
  expected: {}",
                name, contract, vector["expected"]["mutated"]
            ));
        }
    }
    assert!(failures.is_empty(), "
{}", failures.join("
"));
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

// ---------------------------------------------------------------------------
// Compose orchestration vectors
// ---------------------------------------------------------------------------

fn compose_vocabulary(vector: &Value) -> dynamic_experience_runtime_lib::runtime::compose::ComposeVocabulary {
    use dynamic_experience_runtime_lib::runtime::compose::ComposeVocabulary;
    ComposeVocabulary {
        fragment_defs: vector["fragmentDefs"].as_object().cloned().unwrap_or_default(),
        part_operations: vector["partOperations"].as_object().cloned().unwrap_or_default(),
        credentials: vector["credentials"].as_array().cloned().unwrap_or_default(),
        recipes: vector["recipes"].as_object().cloned().unwrap_or_default(),
    }
}

#[test]
fn compose_prompt_vectors_match() {
    use dynamic_experience_runtime_lib::runtime::prompt::{
        build_base_prompt, render_catalog_text, BLUEPRINT_PROMPT_SECTION, CREATE_PROMPT_SECTION,
        EDIT_PROMPT_SECTION,
    };
    let fixtures = fixture("compose.json");
    assert_eq!(
        fixtures["promptSections"]["create"].as_str().unwrap(),
        CREATE_PROMPT_SECTION
    );
    assert_eq!(
        fixtures["promptSections"]["blueprint"].as_str().unwrap(),
        BLUEPRINT_PROMPT_SECTION
    );
    assert_eq!(fixtures["promptSections"]["edit"].as_str().unwrap(), EDIT_PROMPT_SECTION);

    let mut failures = Vec::new();
    for vector in fixtures["prompts"].as_array().expect("prompt vectors") {
        let name = vector["name"].as_str().unwrap_or("?");
        let vocab = compose_vocabulary(vector);
        let base = build_base_prompt(&render_catalog_text(&vocab, false), false);
        let expected = vector["expected"]["base"].as_str().unwrap_or("");
        if base != expected {
            let mismatch = base
                .lines()
                .zip(expected.lines())
                .enumerate()
                .find(|(_, (actual, wanted))| actual != wanted);
            failures.push(format!(
                "{}: base prompt mismatch at {:?}",
                name,
                mismatch.map(|(index, (actual, wanted))| format!(
                    "line {}: actual {:?} expected {:?}",
                    index, actual, wanted
                ))
            ));
        }
        if let Some(expected_compact) = vector["expected"]["compactCreateSystem"].as_str() {
            let compact = format!(
                "{}\n\n{}",
                build_base_prompt(&render_catalog_text(&vocab, true), true),
                CREATE_PROMPT_SECTION
            );
            if compact != expected_compact {
                failures.push(format!("{}: compact create prompt mismatch", name));
            }
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

fn compose_semantic<'a>(
    schema: &'a str,
    vocab: &'a dynamic_experience_runtime_lib::runtime::compose::ComposeVocabulary,
) -> impl FnMut(&mut Value) -> Vec<String> + 'a {
    use dynamic_experience_runtime_lib::runtime::compose::{
        check_composed_candidate, format_manifest_errors,
    };
    use dynamic_experience_runtime_lib::runtime::validation::check_against_manifests;
    move |value: &mut Value| {
        if schema == "composed" {
            check_composed_candidate(value, vocab).0
        } else {
            let outcome = check_against_manifests(
                value,
                &vocab.fragment_defs,
                &vocab.part_operations,
                &vocab.credentials,
            );
            if outcome.errors.is_empty() {
                Vec::new()
            } else {
                vec![format_manifest_errors(&outcome.errors)]
            }
        }
    }
}

#[test]
fn compose_response_vectors_match() {
    use dynamic_experience_runtime_lib::runtime::llm_schema::{
        parse_validated_json, ParseVerdict, SchemaKind,
    };
    let fixtures = fixture("compose.json");
    let mut failures = Vec::new();
    for vector in fixtures["responses"].as_array().expect("response vectors") {
        let name = vector["name"].as_str().unwrap_or("?");
        let vocab = compose_vocabulary(vector);
        let schema_name = vector["schema"].as_str().unwrap_or("composed");
        let schema = if schema_name == "composed" { SchemaKind::Composed } else { SchemaKind::Contract };
        let raw = vector["raw"].as_str().unwrap_or("");
        let mut semantic = compose_semantic(schema_name, &vocab);
        let verdict = parse_validated_json(raw, &schema, &mut semantic);
        let expected = &vector["expected"];
        match verdict {
            ParseVerdict::Ok(value) => {
                if expected["ok"] != Value::Bool(true) {
                    failures.push(format!("{}: expected failure, got ok", name));
                } else if !semantically_equal(&value, &expected["value"]) {
                    failures.push(format!(
                        "{}: value mismatch\n  actual: {}\n  expected: {}",
                        name, value, expected["value"]
                    ));
                }
            }
            ParseVerdict::Problem(problem) => {
                if expected["ok"] != Value::Bool(false) {
                    failures.push(format!("{}: expected ok, got problem {}", name, problem));
                } else if let Some(prefix) = expected["problemPrefix"].as_str() {
                    if !problem.starts_with(prefix) {
                        failures.push(format!("{}: problem lacks prefix: {}", name, problem));
                    }
                } else if Some(problem.as_str()) != expected["problem"].as_str() {
                    failures.push(format!(
                        "{}: problem mismatch\n  actual: {}\n  expected: {}",
                        name, problem, expected["problem"]
                    ));
                }
            }
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

#[test]
fn compose_finalize_vectors_match() {
    use dynamic_experience_runtime_lib::runtime::compose::finalize_contract_shape;
    let fixtures = fixture("compose.json");
    let mut failures = Vec::new();
    for vector in fixtures["finalize"].as_array().expect("finalize vectors") {
        let name = vector["name"].as_str().unwrap_or("?");
        let vocab = compose_vocabulary(vector);
        let description = vector["description"].as_str();
        let had_created_at = vector["shape"]["metadata"]["createdAt"].is_string();
        let mut contract = finalize_contract_shape(
            &vector["shape"],
            description,
            "2026-01-01T00:00:00.000Z",
            &vocab,
        );
        if let Some(metadata) = contract.get_mut("metadata").and_then(Value::as_object_mut) {
            metadata.insert("updatedAt".to_string(), Value::String("<stamped>".to_string()));
            if !had_created_at {
                metadata.insert("createdAt".to_string(), Value::String("<stamped>".to_string()));
            }
        }
        if !semantically_equal(&contract, &vector["expected"]) {
            failures.push(format!(
                "{}: contract mismatch\n  actual: {}\n  expected: {}",
                name, contract, vector["expected"]
            ));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

struct ScriptedLlm {
    provider: String,
    responses: Vec<String>,
    index: usize,
    calls: Vec<Value>,
}

impl dynamic_experience_runtime_lib::runtime::compose::ComposeLlm for ScriptedLlm {
    fn send<'a>(
        &'a mut self,
        messages: Vec<Value>,
        options: dynamic_experience_runtime_lib::runtime::compose::LlmSendOptions,
        _on_chunk: Option<dynamic_experience_runtime_lib::runtime::compose::ChunkCallback<'a>>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<dynamic_experience_runtime_lib::runtime::compose::LlmReply, String>> + Send + 'a>>
    {
        let blocks: Vec<Value> = options
            .system_blocks
            .iter()
            .map(|block| {
                if block.cache {
                    serde_json::json!({ "text": block.text, "cache": true })
                } else {
                    serde_json::json!({ "text": block.text })
                }
            })
            .collect();
        self.calls.push(serde_json::json!({
            "messages": messages,
            "systemBlocks": blocks,
            "jsonMode": options.json_mode,
            "maxTokens": options.max_tokens,
        }));
        let content = self.responses[self.index.min(self.responses.len() - 1)].clone();
        self.index += 1;
        let provider = Some(self.provider.clone());
        Box::pin(async move {
            Ok(dynamic_experience_runtime_lib::runtime::compose::LlmReply { content, provider })
        })
    }
}

fn block_on<F: std::future::Future>(future: F) -> F::Output {
    use std::task::{Context, Poll, Waker};
    let mut future = Box::pin(future);
    let waker = Waker::noop();
    let mut cx = Context::from_waker(waker);
    loop {
        match future.as_mut().poll(&mut cx) {
            Poll::Ready(output) => return output,
            Poll::Pending => std::thread::yield_now(),
        }
    }
}

#[test]
fn compose_loop_vectors_match() {
    use dynamic_experience_runtime_lib::runtime::compose::{
        generate_validated_json, GenerateOptions, SystemBlockSpec,
    };
    use dynamic_experience_runtime_lib::runtime::llm_schema::SchemaKind;
    let fixtures = fixture("compose.json");
    let mut failures = Vec::new();
    for vector in fixtures["loop"].as_array().expect("loop vectors") {
        let name = vector["name"].as_str().unwrap_or("?");
        let vocab = compose_vocabulary(vector);
        let schema_name = vector["schema"].as_str().unwrap_or("composed");
        let schema = if schema_name == "composed" { SchemaKind::Composed } else { SchemaKind::Contract };
        let responses: Vec<String> = vector["responses"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter_map(|r| r.as_str().map(str::to_string))
            .collect();
        let mut llm = ScriptedLlm {
            provider: vector["provider"].as_str().unwrap_or("").to_string(),
            responses,
            index: 0,
            calls: Vec::new(),
        };
        let messages = vec![serde_json::json!({
            "role": "user",
            "content": "Build an app for this request:\n\ntest request",
        })];
        let options = GenerateOptions {
            label: "Contract".to_string(),
            max_tokens: Some(16000),
            system_blocks: vec![
                SystemBlockSpec { text: "BASE".to_string(), cache: true },
                SystemBlockSpec { text: "MODE".to_string(), cache: false },
            ],
        };
        let mut semantic = compose_semantic(schema_name, &vocab);
        let outcome = block_on(generate_validated_json(
            &mut llm,
            messages,
            schema,
            options,
            &mut semantic,
            None,
        ));
        let expected = &vector["expected"];
        match outcome {
            Ok(value) => {
                if expected["ok"] != Value::Bool(true) {
                    failures.push(format!("{}: expected failure, got ok", name));
                } else if !semantically_equal(&value, &expected["value"]) {
                    failures.push(format!(
                        "{}: value mismatch\n  actual: {}\n  expected: {}",
                        name, value, expected["value"]
                    ));
                }
            }
            Err(error) => {
                if expected["ok"] != Value::Bool(false) {
                    failures.push(format!("{}: expected ok, got error {}", name, error));
                } else if Some(error.as_str()) != expected["error"].as_str() {
                    failures.push(format!(
                        "{}: error mismatch\n  actual: {}\n  expected: {}",
                        name, error, expected["error"]
                    ));
                }
            }
        }
        let calls = Value::Array(llm.calls.clone());
        if !semantically_equal(&calls, &expected["calls"]) {
            failures.push(format!(
                "{}: calls mismatch\n  actual: {}\n  expected: {}",
                name, calls, expected["calls"]
            ));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}
