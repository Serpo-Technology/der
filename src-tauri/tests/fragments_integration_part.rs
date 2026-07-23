//! Host tests for the declarative integration part bundle.

use dynamic_experience_runtime_lib::fragments::{
    commit_core, list_core, stage_core, verify_bundle, FragmentsState,
};

const BUNDLE: &str = "../fragments/dist/der-labs.openweather.derpart";
const FX_BUNDLE: &str = "../fragments/dist/der-labs.frankfurter.derpart";

#[test]
fn integration_bundle_verifies_with_confined_service() {
    let raw = std::fs::read(BUNDLE).expect("committed bundle present");
    let verified = verify_bundle(&raw).expect("verifies");
    assert_eq!(verified.manifest.id, "der-labs.openweather");
    assert!(verified.wasm.is_empty());
    let service = verified.manifest.service.expect("service block");
    assert_eq!(service.base_url, "https://api.openweathermap.org");
    assert_eq!(service.credentials.len(), 1);
    assert_eq!(
        verified.manifest.capabilities,
        vec!["net:https://api.openweathermap.org".to_string()]
    );
    let remote = verified.manifest.operations[0].remote.clone().expect("remote spec");
    assert!(remote.endpoint.starts_with('/'));
}

#[test]
fn integration_bundle_installs_and_lists() {
    let state = FragmentsState::new();
    let dir = tempfile::tempdir().unwrap();
    let raw = std::fs::read(BUNDLE).unwrap();
    let summary = stage_core(&state, dir.path(), &raw, &[]).expect("stage");
    // The review card surfaces the declared network capability.
    assert!(summary.capabilities.iter().any(|c| c.starts_with("net:")));
    commit_core(&state, dir.path(), &summary.staging_token, &summary.fingerprint, false)
        .expect("commit");
    assert_eq!(list_core(dir.path()).len(), 1);
}


#[test]
fn keyless_integration_bundle_verifies() {
    let raw = std::fs::read(FX_BUNDLE).expect("committed bundle present");
    let verified = verify_bundle(&raw).expect("verifies");
    let service = verified.manifest.service.expect("service block");
    assert!(service.credentials.is_empty());
    let remote = verified.manifest.operations[0].remote.clone().expect("remote");
    assert_eq!(remote.project.unwrap().get("rate").unwrap(), "rates.{to}");
}
