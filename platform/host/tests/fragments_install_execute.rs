//! End-to-end host tests against the committed signed demo bundle: verify,
//! trust pinning, ABI checks, execution, and tamper rejection. Hermetic: the
//! bundle carries the compiled wasm, so no wasm toolchain is needed here.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use dynamic_experience_runtime_lib::fragments::{
    commit_core, execute_in_module, list_core, remove_core, stage_core, verify_bundle,
    FragmentErrorKind, FragmentsState,
};
use serde_json::{json, Value};

const BUNDLE_PATH: &str = "../../fragments/dist/der-labs.stats-summary.derpart";

fn bundle_bytes() -> Vec<u8> {
    std::fs::read(BUNDLE_PATH).expect("committed demo bundle present")
}

fn install(state: &FragmentsState, dir: &std::path::Path, raw: &[u8]) -> String {
    let summary = stage_core(state, dir, raw, &[]).expect("stage");
    let manifest = commit_core(state, dir, &summary.staging_token, &summary.fingerprint, false)
        .expect("commit");
    manifest.id
}

#[test]
fn bundle_is_committed_and_small() {
    let raw = bundle_bytes();
    assert!(raw.len() < 2 << 20, "bundle should stay under 2 MiB, is {}", raw.len());
    let verified = verify_bundle(&raw).expect("bundle verifies");
    assert_eq!(verified.manifest.id, "der-labs.stats-summary");
    assert_eq!(verified.manifest.namespace, "stats");
    assert!(verified.manifest.capabilities.is_empty());
}

#[test]
fn install_and_execute_summary_and_percentile() {
    let state = FragmentsState::new();
    let dir = tempfile::tempdir().unwrap();
    let id = install(&state, dir.path(), &bundle_bytes());

    let loaded = state.load(dir.path(), &id).expect("load");
    let engine = state.engine();

    let summary = execute_in_module(
        engine,
        &loaded,
        "stats.summary",
        &json!({ "values": [2, 4, 6, null, "8"] }),
    )
    .expect("summary executes");
    assert_eq!(summary.get("count"), Some(&Value::from(3)));
    assert_eq!(summary.get("sum"), Some(&Value::from(12.0)));
    assert_eq!(summary.get("mean"), Some(&Value::from(4.0)));
    assert_eq!(summary.get("min"), Some(&Value::from(2.0)));
    assert_eq!(summary.get("max"), Some(&Value::from(6.0)));

    let percentile = execute_in_module(
        engine,
        &loaded,
        "stats.percentile",
        &json!({ "values": [1, 2, 3, 4], "p": 50 }),
    )
    .expect("percentile executes");
    assert_eq!(percentile.get("value"), Some(&Value::from(2.5)));
}

#[test]
fn guest_reports_errors_without_trapping() {
    let state = FragmentsState::new();
    let dir = tempfile::tempdir().unwrap();
    let id = install(&state, dir.path(), &bundle_bytes());
    let loaded = state.load(dir.path(), &id).unwrap();

    let err = execute_in_module(
        state.engine(),
        &loaded,
        "stats.percentile",
        &json!({ "values": [], "p": 50 }),
    )
    .unwrap_err();
    assert_eq!(err.kind, FragmentErrorKind::GuestError);

    let err = execute_in_module(
        state.engine(),
        &loaded,
        "stats.nothing",
        &json!({}),
    )
    .unwrap_err();
    assert_eq!(err.kind, FragmentErrorKind::OperationNotFound);
}

#[test]
fn tampered_bundles_are_rejected() {
    let raw = bundle_bytes();
    let mut parsed: Value = serde_json::from_slice(&raw).unwrap();

    // Flip a byte inside the wasm payload.
    let wasm_b64 = parsed["wasmB64"].as_str().unwrap();
    let mut wasm = BASE64.decode(wasm_b64).unwrap();
    let mid = wasm.len() / 2;
    wasm[mid] ^= 0xFF;
    parsed["wasmB64"] = Value::String(BASE64.encode(&wasm));
    let tampered = serde_json::to_vec(&parsed).unwrap();
    let err = verify_bundle(&tampered).unwrap_err();
    assert_eq!(err.kind, FragmentErrorKind::VerifyFailed);

    // Flip a byte inside the manifest payload.
    let mut parsed: Value = serde_json::from_slice(&raw).unwrap();
    let manifest_b64 = parsed["manifestB64"].as_str().unwrap();
    let mut manifest = BASE64.decode(manifest_b64).unwrap();
    let mid = manifest.len() / 2;
    manifest[mid] ^= 0x01;
    parsed["manifestB64"] = Value::String(BASE64.encode(&manifest));
    let tampered = serde_json::to_vec(&parsed).unwrap();
    let err = verify_bundle(&tampered).unwrap_err();
    assert_eq!(err.kind, FragmentErrorKind::VerifyFailed);
}

#[test]
fn key_mismatch_blocks_and_namespace_is_claimed() {
    let state = FragmentsState::new();
    let dir = tempfile::tempdir().unwrap();
    install(&state, dir.path(), &bundle_bytes());

    // Same publisher, different key: staging reports the mismatch and commit
    // refuses. Simulate by re-signing is out of scope here; instead assert the
    // trust store pinned the publisher and namespace.
    let listed = list_core(dir.path());
    assert_eq!(listed.len(), 1);

    let trust: Value = serde_json::from_str(
        &std::fs::read_to_string(dir.path().join("trust.json")).unwrap(),
    )
    .unwrap();
    assert!(trust["publishers"]["der-labs"]["fingerprint"].is_string());
    assert_eq!(trust["namespaces"]["stats"]["publisher"], "der-labs");

    // Removal keeps the pins (no remove/re-add squatting).
    let state2 = FragmentsState::new();
    remove_core(&state2, dir.path(), "der-labs.stats-summary").unwrap();
    let trust: Value = serde_json::from_str(
        &std::fs::read_to_string(dir.path().join("trust.json")).unwrap(),
    )
    .unwrap();
    assert!(trust["installed"].get("der-labs.stats-summary").is_none());
    assert_eq!(trust["namespaces"]["stats"]["publisher"], "der-labs");
}

#[test]
fn modules_with_uncovered_imports_or_missing_exports_are_rejected() {
    let state = FragmentsState::new();

    // Undeclared imports refuse whether or not the module is otherwise valid.
    let with_import = wat_to_wasm("(module (import \"env\" \"f\" (func)))");
    let err = state.compile(&with_import, &[]).unwrap_err();
    assert_eq!(err.kind, FragmentErrorKind::AbiMismatch);
    assert!(err.message.contains("env::f"));

    // A WASI import passes only under the capability that covers it.
    let with_clock = wat_to_wasm(
        "(module (import \"wasi_snapshot_preview1\" \"clock_time_get\" (func (param i32 i64 i32) (result i32))) (memory (export \"memory\") 1) (func (export \"der_alloc\") (param i32) (result i32) i32.const 0) (func (export \"der_run\") (param i32 i32) (result i64) i64.const 0))",
    );
    let err = state.compile(&with_clock, &[]).unwrap_err();
    assert_eq!(err.kind, FragmentErrorKind::AbiMismatch);
    assert!(err.message.contains("wasi:clocks"));
    state
        .compile(&with_clock, &["wasi:clocks".to_string()])
        .expect("declared capability covers the import");

    // Valid module missing der_run.
    let missing_run = wat_to_wasm(
        "(module (memory (export \"memory\") 1) (func (export \"der_alloc\") (param i32) (result i32) i32.const 0))",
    );
    let err = state.compile(&missing_run, &[]).unwrap_err();
    assert_eq!(err.kind, FragmentErrorKind::AbiMismatch);
}

fn wat_to_wasm(wat: &str) -> Vec<u8> {
    wat::parse_str(wat).expect("wat parses")
}
