//! Host tests for recipe bundles: declarative full-experience payloads with
//! no module. Bundles are built and signed in-test with a fixed key, so each
//! verifier rule is exercised on its own.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use dynamic_experience_runtime_lib::fragments::{
    commit_core, list_core, stage_core, verify_bundle, FragmentErrorKind, FragmentsState,
};
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{json, Value};

const SIG_DOMAIN: &[u8] = b"DERPART-SIG-V1\x00";

fn signed_bundle(manifest: &Value) -> Vec<u8> {
    let signing = SigningKey::from_bytes(&[7u8; 32]);
    let manifest_bytes = serde_json::to_vec(manifest).unwrap();
    let mut preimage = SIG_DOMAIN.to_vec();
    preimage.extend_from_slice(&manifest_bytes);
    let signature = signing.sign(&preimage);
    serde_json::to_vec(&json!({
        "formatVersion": 1,
        "manifestB64": BASE64.encode(&manifest_bytes),
        "wasmB64": "",
        "publisherKeyB64": BASE64.encode(signing.verifying_key().to_bytes()),
        "signatureB64": BASE64.encode(signature.to_bytes()),
    }))
    .unwrap()
}

fn minimal_contract() -> Value {
    json!({
        "name": "counter",
        "version": "1.0.0",
        "elements": [
            { "id": "count-text", "type": "text",
              "dataBindings": [ { "property": "content", "source": "state", "sourceId": "clicks" } ] },
            { "id": "click-btn", "type": "button", "properties": { "text": "Click" },
              "eventBindings": [ { "event": "click", "operationId": "op-add" } ] }
        ],
        "operations": [
            { "id": "op-add", "operationName": "counter.add",
              "inputs": [ { "name": "key", "source": "constant", "sourceId": "clicks" } ] }
        ]
    })
}

fn recipe_manifest() -> Value {
    json!({
        "formatVersion": 1,
        "abiVersion": 1,
        "id": "test.starter",
        "name": "Starter Apps",
        "version": "1.0.0",
        "publisher": "test-pub",
        "description": "Proven apps ready to open.",
        "namespace": "starter",
        "capabilities": [],
        "wasmSha256": "",
        "recipes": [
            {
                "name": "starter.counter",
                "title": "Click Counter",
                "description": "Counts button clicks.",
                "keywords": ["counter", "clicks"],
                "spec": { "goal": "Count clicks", "assumptions": [], "openQuestions": [] },
                "contract": minimal_contract()
            }
        ]
    })
}

#[test]
fn committed_starter_bundle_verifies() {
    let raw = std::fs::read("../fragments/dist/der-labs.starter-apps.derpart")
        .expect("committed bundle present");
    let verified = verify_bundle(&raw).expect("verifies");
    assert_eq!(verified.manifest.id, "der-labs.starter-apps");
    assert_eq!(verified.manifest.namespace, "apps");
    assert_eq!(verified.manifest.recipes.len(), 1);
    assert_eq!(verified.manifest.recipes[0].name, "apps.expense_tracker");
    assert!(verified.wasm.is_empty());
}

#[test]
fn recipe_bundle_verifies_stages_and_installs() {
    let raw = signed_bundle(&recipe_manifest());
    let verified = verify_bundle(&raw).expect("verifies");
    assert_eq!(verified.manifest.recipes.len(), 1);
    assert_eq!(verified.manifest.recipes[0].name, "starter.counter");
    assert!(verified.wasm.is_empty());

    let state = FragmentsState::new();
    let dir = tempfile::tempdir().unwrap();
    let summary = stage_core(&state, dir.path(), &raw, &[]).expect("stage");
    assert_eq!(summary.recipes.len(), 1);
    assert_eq!(summary.recipes[0]["title"], "Click Counter");
    commit_core(&state, dir.path(), &summary.staging_token, &summary.fingerprint, false)
        .expect("commit");

    let listed = list_core(dir.path());
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0]["manifest"]["recipes"][0]["name"], "starter.counter");

    // No module to execute: the wasm path refuses recipe parts.
    let err = match state.load(dir.path(), "test.starter") {
        Err(err) => err,
        Ok(_) => panic!("load should refuse a recipe part"),
    };
    assert_eq!(err.kind, FragmentErrorKind::OperationNotFound);
}

#[test]
fn recipe_parts_carry_nothing_else() {
    let mut manifest = recipe_manifest();
    manifest["operations"] = json!([
        { "name": "starter.noop", "description": "n/a" }
    ]);
    let err = verify_bundle(&signed_bundle(&manifest)).unwrap_err();
    assert_eq!(err.kind, FragmentErrorKind::VerifyFailed);
    assert!(err.message.contains("only recipes"), "got: {}", err.message);

    let mut manifest = recipe_manifest();
    manifest["service"] = json!({ "baseUrl": "https://example.com" });
    manifest["capabilities"] = json!(["net:https://example.com"]);
    let err = verify_bundle(&signed_bundle(&manifest)).unwrap_err();
    assert_eq!(err.kind, FragmentErrorKind::VerifyFailed);
    assert!(err.message.contains("only recipes"), "got: {}", err.message);
}

#[test]
fn recipe_names_titles_and_contracts_are_checked() {
    let mut manifest = recipe_manifest();
    manifest["recipes"][0]["name"] = json!("other.counter");
    let err = verify_bundle(&signed_bundle(&manifest)).unwrap_err();
    assert!(err.message.contains("namespace"), "got: {}", err.message);

    let mut manifest = recipe_manifest();
    manifest["recipes"][0]["description"] = json!("  ");
    let err = verify_bundle(&signed_bundle(&manifest)).unwrap_err();
    assert!(err.message.contains("title and description"), "got: {}", err.message);

    let mut manifest = recipe_manifest();
    manifest["recipes"][0]["contract"] = json!({ "name": "empty", "elements": [] });
    let err = verify_bundle(&signed_bundle(&manifest)).unwrap_err();
    assert!(err.message.contains("elements"), "got: {}", err.message);

    let mut manifest = recipe_manifest();
    let duplicate = manifest["recipes"][0].clone();
    manifest["recipes"].as_array_mut().unwrap().push(duplicate);
    let err = verify_bundle(&signed_bundle(&manifest)).unwrap_err();
    assert!(err.message.contains("Duplicate"), "got: {}", err.message);
}
