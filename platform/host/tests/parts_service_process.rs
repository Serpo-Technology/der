//! The part runner as a real process: the host executable started with
//! `--service parts`, driven through the client the app uses.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use der_parts::service::{Reply, Request};
use der_parts::{verify_bundle, FragmentErrorKind};
use serde_json::json;

type Client = der_wire::Client<Request, Reply>;

const HOST: &str = env!("CARGO_BIN_EXE_dynamic-experience-runtime");
const RAR_BUNDLE: &str = "../../fragments/dist/der-labs.rar.derpart";
const RAR: &str = "der-labs.rar";
const ARCHIVE: &str = "../services/parts/tests/fixtures/rar/classic.rar";
const WAIT: Duration = Duration::from_secs(120);

fn client(fragments_dir: &std::path::Path) -> Client {
    Client::new("part runner", HOST, der_wire::service_arguments("parts", fragments_dir))
}

#[test]
fn a_part_runs_in_the_runner_process_with_files_crossing_by_path() {
    let fragments = tempfile::tempdir().expect("temp dir");
    std::fs::copy(RAR_BUNDLE, fragments.path().join(format!("{RAR}.derpart"))).expect("install");
    let handoff = tempfile::tempdir().expect("temp dir");
    let client = client(fragments.path());
    assert_eq!(client.process_id(), None, "nothing runs before the first request");

    let archive = std::fs::canonicalize(ARCHIVE).expect("the fixture");
    let reply = client
        .call(
            Request::Run {
                fragment_id: RAR.to_string(),
                operation: "rar.extract".to_string(),
                inputs: json!({ "file": "grant-1", "name": "test.txt" }),
                granted: HashMap::from([("grant-1".to_string(), archive)]),
                handoff: handoff.path().to_path_buf(),
            },
            WAIT,
        )
        .expect("answers");
    let Reply::Outputs { outputs, produced } = reply else {
        panic!("outputs: {reply:?}");
    };
    assert_eq!(produced.len(), 1);
    assert_eq!(produced[0].output, "file");
    assert!(produced[0].path.starts_with(handoff.path()), "{:?}", produced[0].path);
    assert_eq!(std::fs::read(&produced[0].path).expect("the produced file").len(), 20);
    assert!(outputs["file"].as_str().is_some_and(|value| value.starts_with("derproduced-")));
    assert_ne!(client.process_id(), Some(std::process::id()), "the part ran in another process");

    // The same process answers the next call from its compiled module.
    let first = client.process_id();
    let listed = client
        .call(
            Request::Run {
                fragment_id: RAR.to_string(),
                operation: "rar.list".to_string(),
                inputs: json!({ "file": "grant-1" }),
                granted: HashMap::from([("grant-1".to_string(), PathBuf::from(ARCHIVE).canonicalize().expect("fixture"))]),
                handoff: handoff.path().to_path_buf(),
            },
            WAIT,
        )
        .expect("answers");
    assert!(matches!(listed, Reply::Outputs { ref produced, .. } if produced.is_empty()), "{listed:?}");
    assert_eq!(client.process_id(), first);
}

#[test]
fn the_install_check_compiles_in_the_runner_and_installs_nothing() {
    let fragments = tempfile::tempdir().expect("temp dir");
    let client = client(fragments.path());
    let verified = verify_bundle(&std::fs::read(RAR_BUNDLE).expect("bundle")).expect("verifies");
    let wasm_b64 = BASE64.encode(&verified.wasm);

    let declared = client
        .call(
            Request::Check {
                wasm_b64: wasm_b64.clone(),
                capabilities: verified.manifest.capabilities.clone(),
            },
            WAIT,
        )
        .expect("answers");
    assert_eq!(declared, Reply::Done);

    let undeclared = client
        .call(
            Request::Check {
                wasm_b64,
                capabilities: Vec::new(),
            },
            WAIT,
        )
        .expect("answers");
    assert!(
        matches!(undeclared, Reply::Failed(ref error) if error.kind == FragmentErrorKind::AbiMismatch),
        "{undeclared:?}"
    );
    assert_eq!(std::fs::read_dir(fragments.path()).expect("fragments").count(), 0);

    let forgotten = client
        .call(Request::Forget { fragment_id: RAR.to_string() }, WAIT)
        .expect("answers");
    assert_eq!(forgotten, Reply::Done);
}
