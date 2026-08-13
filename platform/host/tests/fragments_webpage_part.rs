//! Host tests for the committed webpage bundle: verify, install, and
//! extract blocks through the sandbox. Hermetic: the bundle carries the
//! wasm, and io:large raises the input budget for real page sizes.

use dynamic_experience_runtime_lib::fragments::{
    commit_core, execute_in_module, stage_core, verify_bundle, FragmentsState,
};
use serde_json::json;

const WEBPAGE_BUNDLE: &str = "../../fragments/dist/der-labs.webpage.derpart";

fn install(state: &FragmentsState, dir: &std::path::Path) -> String {
    let raw = std::fs::read(WEBPAGE_BUNDLE).expect("committed bundle present");
    let summary = stage_core(state, dir, &raw, &[]).expect("stage");
    let manifest = commit_core(state, dir, &summary.staging_token, &summary.fingerprint, false)
        .expect("commit");
    manifest.id
}

#[test]
fn bundle_verifies_and_declares_large_io() {
    let raw = std::fs::read(WEBPAGE_BUNDLE).expect("committed bundle present");
    let verified = verify_bundle(&raw).expect("bundle verifies");
    assert_eq!(verified.manifest.id, "der-labs.webpage");
    assert_eq!(verified.manifest.namespace, "page");
    assert_eq!(verified.manifest.capabilities, vec!["io:large".to_string()]);
}

#[test]
fn extracts_blocks_with_resolved_urls() {
    let state = FragmentsState::new();
    let dir = tempfile::tempdir().unwrap();
    let id = install(&state, dir.path());
    let loaded = state.load(dir.path(), &id).expect("load");
    let engine = state.engine();

    let html = "<html><head><title>Guide</title></head><body>\
        <nav><a href=\"/skip\">Skip me</a></nav>\
        <h1>Welcome</h1><p>Hello world.</p>\
        <ul><li><a href=\"next.html\">Next page</a></li></ul>\
        </body></html>";
    let result = execute_in_module(
        engine,
        &loaded,
        "page.blocks",
        &json!({ "html": html, "url": "https://example.org/docs/start.html" }),
    )
    .expect("page parses");

    assert_eq!(result["title"], json!("Guide"));
    assert_eq!(result["count"], json!(3));
    let blocks = result["blocks"].as_array().expect("blocks array");
    assert_eq!(blocks[0]["kind"], json!("heading"));
    assert_eq!(blocks[0]["text"], json!("Welcome"));
    assert_eq!(blocks[1]["kind"], json!("paragraph"));
    assert_eq!(blocks[2]["kind"], json!("link"));
    assert_eq!(blocks[2]["href"], json!("https://example.org/docs/next.html"));
}

#[test]
fn missing_html_reports_a_guest_error() {
    let state = FragmentsState::new();
    let dir = tempfile::tempdir().unwrap();
    let id = install(&state, dir.path());
    let loaded = state.load(dir.path(), &id).expect("load");
    let engine = state.engine();

    let err = execute_in_module(engine, &loaded, "page.blocks", &json!({}))
        .expect_err("missing html fails");
    assert!(
        err.message.contains("html has no value yet"),
        "got: {}",
        err.message
    );
}
