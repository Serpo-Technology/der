//! The C-written part through the hardened wasmtime host: the ABI is
//! language-agnostic, and this bundle (clang + wasm-ld, no Rust) must
//! verify, load under the zero-import rule, and answer with a real PNG.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use dynamic_experience_runtime_lib::fragments::{execute_in_module, FragmentsState};
use serde_json::json;

#[test]
fn c_part_encodes_a_qr_png_under_the_host() {
    let raw = std::fs::read("../../fragments/dist/der-labs.qr.derpart").expect("committed bundle");
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("der-labs.qr.derpart");
    std::fs::write(&path, &raw).unwrap();

    let state = FragmentsState::new();
    let loaded = state.load(dir.path(), "der-labs.qr").expect("verifies and loads");
    let result = execute_in_module(
        state.engine(),
        &loaded,
        "qr.encode",
        &json!({ "text": "https://example.net/derpart", "scale": 4, "border": 2 }),
    )
    .expect("qr.encode runs");

    let b64 = result["base64"].as_str().expect("base64 output");
    let png = BASE64.decode(b64).expect("decodes");
    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n", "PNG signature");
    let modules = result["modules"].as_u64().expect("modules output");
    assert!(modules >= 21, "a real QR grid: {}", modules);
    assert_eq!(
        result["size"].as_u64().unwrap(),
        (modules + 4) * 4,
        "size = (modules + 2*border) * scale"
    );

    // Bad input answers through the envelope, never a trap.
    let err = execute_in_module(state.engine(), &loaded, "qr.encode", &json!({}))
        .expect_err("missing text errors");
    assert!(err.message.contains("text"), "{}", err.message);
}
