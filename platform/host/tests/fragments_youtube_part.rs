//! Host tests for the committed youtube bundle: verify, install, and parse
//! links through the sandbox. Hermetic: the bundle carries the wasm.

use dynamic_experience_runtime_lib::fragments::{
    commit_core, execute_in_module, stage_core, verify_bundle, FragmentsState,
};
use serde_json::json;

const YOUTUBE_BUNDLE: &str = "../../fragments/dist/der-labs.youtube.derpart";

fn install(state: &FragmentsState, dir: &std::path::Path) -> String {
    let raw = std::fs::read(YOUTUBE_BUNDLE).expect("committed bundle present");
    let summary = stage_core(state, dir, &raw, &[]).expect("stage");
    let manifest = commit_core(state, dir, &summary.staging_token, &summary.fingerprint, false)
        .expect("commit");
    manifest.id
}

#[test]
fn bundle_verifies_and_claims_the_youtube_namespace() {
    let raw = std::fs::read(YOUTUBE_BUNDLE).expect("committed bundle present");
    let verified = verify_bundle(&raw).expect("bundle verifies");
    assert_eq!(verified.manifest.id, "der-labs.youtube");
    assert_eq!(verified.manifest.namespace, "youtube");
    assert!(verified.manifest.capabilities.is_empty());
}

#[test]
fn parses_watch_short_and_timestamped_links() {
    let state = FragmentsState::new();
    let dir = tempfile::tempdir().unwrap();
    let id = install(&state, dir.path());
    let loaded = state.load(dir.path(), &id).expect("load");
    let engine = state.engine();

    let watch = execute_in_module(
        engine,
        &loaded,
        "youtube.parse",
        &json!({ "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }),
    )
    .expect("watch link parses");
    assert_eq!(watch["videoId"], json!("dQw4w9WgXcQ"));
    assert_eq!(
        watch["embedUrl"],
        json!("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ")
    );
    assert_eq!(watch["startSeconds"], json!(0));

    let timed = execute_in_module(
        engine,
        &loaded,
        "youtube.parse",
        &json!({ "url": "https://youtu.be/dQw4w9WgXcQ?t=1m30s" }),
    )
    .expect("short link parses");
    assert_eq!(
        timed["embedUrl"],
        json!("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=90")
    );
    assert_eq!(
        timed["thumbnailUrl"],
        json!("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg")
    );
}

#[test]
fn other_links_report_guest_errors() {
    let state = FragmentsState::new();
    let dir = tempfile::tempdir().unwrap();
    let id = install(&state, dir.path());
    let loaded = state.load(dir.path(), &id).expect("load");
    let engine = state.engine();

    let err = execute_in_module(
        engine,
        &loaded,
        "youtube.parse",
        &json!({ "url": "https://vimeo.com/12345" }),
    )
    .expect_err("non-YouTube link fails");
    assert!(err.message.contains("not a YouTube link"), "got: {}", err.message);
}
