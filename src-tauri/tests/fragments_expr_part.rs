//! Host tests for the committed expression-evaluator bundle: verify,
//! install, evaluate through the sandbox, and error reporting. Hermetic:
//! the bundle carries the compiled wasm.

use dynamic_experience_runtime_lib::fragments::{
    commit_core, execute_in_module, list_core, stage_core, verify_bundle, FragmentErrorKind,
    FragmentsState,
};
use serde_json::{json, Value};

const EXPR_BUNDLE: &str = "../fragments/dist/der-labs.expr-evaluate.derpart";
const STATS_BUNDLE: &str = "../fragments/dist/der-labs.stats-summary.derpart";

fn install(state: &FragmentsState, dir: &std::path::Path, path: &str) -> String {
    let raw = std::fs::read(path).expect("committed bundle present");
    let summary = stage_core(state, dir, &raw, &[]).expect("stage");
    let manifest = commit_core(state, dir, &summary.staging_token, &summary.fingerprint, false)
        .expect("commit");
    manifest.id
}

#[test]
fn bundle_verifies_and_claims_the_expr_namespace() {
    let raw = std::fs::read(EXPR_BUNDLE).expect("committed bundle present");
    let verified = verify_bundle(&raw).expect("bundle verifies");
    assert_eq!(verified.manifest.id, "der-labs.expr-evaluate");
    assert_eq!(verified.manifest.namespace, "expr");
    assert!(verified.manifest.capabilities.is_empty());
}

#[test]
fn evaluates_expressions_in_the_sandbox() {
    let state = FragmentsState::new();
    let dir = tempfile::tempdir().unwrap();
    let id = install(&state, dir.path(), EXPR_BUNDLE);
    let loaded = state.load(dir.path(), &id).expect("load");
    let engine = state.engine();

    let cases = [
        ("2+3*4", 14.0),
        ("(2+3)*4", 20.0),
        ("sqrt(16)+2^3", 12.0),
        ("min(3, max(1, 2)) * 10", 20.0),
        ("round(2.5) + abs(-1.5)", 4.5),
    ];
    for (expression, expected) in cases {
        let result = execute_in_module(
            engine,
            &loaded,
            "expr.evaluate",
            &json!({ "expression": expression }),
        )
        .unwrap_or_else(|e| panic!("{} failed: {:?}", expression, e));
        assert_eq!(
            result.get("value"),
            Some(&Value::from(expected)),
            "{}",
            expression
        );
    }
}

#[test]
fn evaluates_with_variables_from_structured_inputs() {
    let state = FragmentsState::new();
    let dir = tempfile::tempdir().unwrap();
    let id = install(&state, dir.path(), EXPR_BUNDLE);
    let loaded = state.load(dir.path(), &id).unwrap();

    // The executor groups var.<name> inputs into this object shape; strings
    // coerce because element values arrive as text.
    let result = execute_in_module(
        state.engine(),
        &loaded,
        "expr.evaluate",
        &json!({ "expression": "w / (h ^ 2)", "var": { "w": "70", "h": 1.75 } }),
    )
    .expect("bmi evaluates");
    let value = result.get("value").and_then(Value::as_f64).unwrap();
    assert!((value - 22.857).abs() < 0.01);

    let err = execute_in_module(
        state.engine(),
        &loaded,
        "expr.evaluate",
        &json!({ "expression": "x + 1", "var": { "w": 1 } }),
    )
    .unwrap_err();
    assert_eq!(err.kind, FragmentErrorKind::GuestError);
}

#[test]
fn manifest_declares_the_var_prefix() {
    let raw = std::fs::read(EXPR_BUNDLE).unwrap();
    let verified = verify_bundle(&raw).expect("verifies");
    assert_eq!(verified.manifest.version, "1.1.1");
    assert_eq!(
        verified.manifest.operations[0].structured_prefixes,
        vec!["var".to_string()]
    );
}

#[test]
fn malformed_expressions_report_guest_errors() {
    let state = FragmentsState::new();
    let dir = tempfile::tempdir().unwrap();
    let id = install(&state, dir.path(), EXPR_BUNDLE);
    let loaded = state.load(dir.path(), &id).unwrap();

    for expression in ["2+", "1/0", "sqrt(-1)", "wizardry(3)", "2 $ 3"] {
        let err = execute_in_module(
            state.engine(),
            &loaded,
            "expr.evaluate",
            &json!({ "expression": expression }),
        )
        .unwrap_err();
        assert_eq!(err.kind, FragmentErrorKind::GuestError, "{}", expression);
    }
}

#[test]
fn coexists_with_the_stats_part() {
    let state = FragmentsState::new();
    let dir = tempfile::tempdir().unwrap();
    install(&state, dir.path(), STATS_BUNDLE);
    install(&state, dir.path(), EXPR_BUNDLE);

    let listed = list_core(dir.path());
    assert_eq!(listed.len(), 2);

    let trust: Value = serde_json::from_str(
        &std::fs::read_to_string(dir.path().join("trust.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(trust["namespaces"]["stats"]["publisher"], "der-labs");
    assert_eq!(trust["namespaces"]["expr"]["publisher"], "der-labs");
}
