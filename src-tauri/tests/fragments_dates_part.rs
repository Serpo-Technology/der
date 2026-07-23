//! Host tests for the committed dates bundle: verify, install, and run both
//! operations through the sandbox. Hermetic: the bundle carries the wasm.

use dynamic_experience_runtime_lib::fragments::{
    commit_core, execute_in_module, stage_core, verify_bundle, FragmentsState,
};
use serde_json::json;

const DATES_BUNDLE: &str = "../fragments/dist/der-labs.dates.derpart";

fn install(state: &FragmentsState, dir: &std::path::Path) -> String {
    let raw = std::fs::read(DATES_BUNDLE).expect("committed bundle present");
    let summary = stage_core(state, dir, &raw, &[]).expect("stage");
    let manifest = commit_core(state, dir, &summary.staging_token, &summary.fingerprint, false)
        .expect("commit");
    manifest.id
}

#[test]
fn bundle_verifies_and_claims_the_date_namespace() {
    let raw = std::fs::read(DATES_BUNDLE).expect("committed bundle present");
    let verified = verify_bundle(&raw).expect("bundle verifies");
    assert_eq!(verified.manifest.id, "der-labs.dates");
    assert_eq!(verified.manifest.namespace, "date");
    assert!(verified.manifest.capabilities.is_empty());
}

#[test]
fn installs_and_runs_both_operations() {
    let state = FragmentsState::new();
    let dir = tempfile::tempdir().unwrap();
    let id = install(&state, dir.path());
    let loaded = state.load(dir.path(), &id).expect("load");
    let engine = state.engine();

    let diff = execute_in_module(
        engine,
        &loaded,
        "date.diffDays",
        &json!({ "from": "2026-07-23", "to": "2036-07-23" }),
    )
    .expect("diff runs");
    assert_eq!(diff["days"], json!(3653));

    let shifted = execute_in_module(
        engine,
        &loaded,
        "date.addDays",
        &json!({ "date": "2026-07-23T10:00:00Z", "days": 10 }),
    )
    .expect("addDays runs");
    assert_eq!(shifted["date"], json!("2026-08-02"));
}

#[test]
fn bad_dates_report_guest_errors() {
    let state = FragmentsState::new();
    let dir = tempfile::tempdir().unwrap();
    let id = install(&state, dir.path());
    let loaded = state.load(dir.path(), &id).expect("load");
    let engine = state.engine();

    let err = execute_in_module(
        engine,
        &loaded,
        "date.diffDays",
        &json!({ "from": "soon", "to": "2026-07-23" }),
    )
    .expect_err("bad date fails");
    assert!(err.message.contains("from is not a date"), "got: {}", err.message);
}
