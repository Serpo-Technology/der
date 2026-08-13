//! Runs the committed runtime conformance vectors against the Rust kernel
//! through the shared runner in der-runtime's vectors module; the same
//! runner drives the wasm build's Node suite, so the corpus means one
//! thing everywhere.

use der_runtime::vectors::run_family;
use serde_json::Value;

fn fixture(name: &str) -> Value {
    let raw = std::fs::read_to_string(format!("../../runtime-conformance/{}", name))
        .expect("conformance fixtures present");
    serde_json::from_str(&raw).expect("fixtures parse")
}

fn assert_family(family: &str, file: &str) {
    let failures = run_family(family, &fixture(file)).expect("known family");
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

#[test]
fn transform_vectors_match() {
    assert_family("transform", "transforms.json");
}

#[test]
fn pipeline_vectors_match() {
    assert_family("pipeline", "transforms.json");
}

#[test]
fn operation_vectors_match() {
    assert_family("operation", "operations.json");
}

#[test]
fn session_vectors_match() {
    assert_family("session", "sessions.json");
}

#[test]
fn template_vectors_match() {
    assert_family("template", "templates.json");
}

#[test]
fn view_vectors_match() {
    assert_family("view", "views.json");
}

#[test]
fn validation_vectors_match() {
    assert_family("validation", "validation.json");
}

#[test]
fn streaming_vectors_match() {
    assert_family("streaming", "streaming.json");
}

#[test]
fn expression_vectors_match() {
    assert_family("expression", "expressions.json");
}

#[test]
fn compose_prompt_vectors_match() {
    assert_family("composePrompt", "compose.json");
}

#[test]
fn compose_response_vectors_match() {
    assert_family("composeResponse", "compose.json");
}

#[test]
fn compose_finalize_vectors_match() {
    assert_family("composeFinalize", "compose.json");
}

#[test]
fn compose_loop_vectors_match() {
    assert_family("composeLoop", "compose.json");
}
