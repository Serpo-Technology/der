//! Host tests for the wasm-less UI fragment bundle: verify, install, list,
//! and the no-operations execution guard.

use dynamic_experience_runtime_lib::fragments::{
    commit_core, list_core, stage_core, verify_bundle, FragmentErrorKind, FragmentsState,
};

const UI_BUNDLE: &str = "../fragments/dist/der-labs.ui-basics.derpart";

#[test]
fn ui_only_bundle_verifies_without_a_module() {
    let raw = std::fs::read(UI_BUNDLE).expect("committed bundle present");
    let verified = verify_bundle(&raw).expect("verifies");
    assert_eq!(verified.manifest.id, "der-labs.ui-basics");
    assert!(verified.manifest.operations.is_empty());
    assert_eq!(verified.manifest.ui_fragments.len(), 3);
    assert!(verified.wasm.is_empty());

    // The stopwatch is a partial-experience pack: it ships {{id}}-scoped
    // operation templates alongside its template.
    let stopwatch = verified
        .manifest
        .ui_fragments
        .iter()
        .find(|fragment| fragment.name == "basics.stopwatch")
        .expect("stopwatch fragment present");
    assert_eq!(stopwatch.operations.len(), 4);
    assert!(stopwatch
        .operations
        .iter()
        .all(|op| op["id"].as_str().unwrap_or_default().starts_with("{{id}}")));
}

#[test]
fn installs_and_refuses_to_execute() {
    let state = FragmentsState::new();
    let dir = tempfile::tempdir().unwrap();
    let raw = std::fs::read(UI_BUNDLE).unwrap();
    let summary = stage_core(&state, dir.path(), &raw, &[]).expect("stage");
    commit_core(&state, dir.path(), &summary.staging_token, &summary.fingerprint, false)
        .expect("commit");

    assert_eq!(list_core(dir.path()).len(), 1);

    let err = match state.load(dir.path(), "der-labs.ui-basics") {
        Err(err) => err,
        Ok(_) => panic!("load should refuse a UI-only part"),
    };
    assert_eq!(err.kind, FragmentErrorKind::OperationNotFound);
}
