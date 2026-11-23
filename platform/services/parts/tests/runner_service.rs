//! The part runner's requests, answered by the service the runner process
//! runs: files arrive by the paths the caller granted, produced files wait
//! in the caller's handoff folder, and module checks happen without an
//! install.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use der_parts::service::{serve, Produced, Reply, Request, Service};
use der_parts::{verify_bundle, FragmentErrorKind};
use serde_json::json;

const RAR_BUNDLE: &str = "../../../fragments/dist/der-labs.rar.derpart";
const RAR: &str = "der-labs.rar";
const ARCHIVE: &str = "tests/fixtures/rar/classic.rar";

/// A folder of installed bundles holding the committed archive part.
fn installed() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("temp dir");
    std::fs::copy(RAR_BUNDLE, dir.path().join(format!("{RAR}.derpart"))).expect("install");
    dir
}

fn extract(handoff: &Path, granted: HashMap<String, PathBuf>) -> Request {
    Request::Run {
        fragment_id: RAR.to_string(),
        operation: "rar.extract".to_string(),
        inputs: json!({ "file": "token-for-the-archive", "name": "test.txt" }),
        granted,
        handoff: handoff.to_path_buf(),
    }
}

fn the_archive() -> HashMap<String, PathBuf> {
    HashMap::from([("token-for-the-archive".to_string(), PathBuf::from(ARCHIVE))])
}

#[test]
fn a_granted_file_goes_in_and_a_produced_file_waits_in_the_handoff_folder() {
    let fragments = installed();
    let handoff = tempfile::tempdir().expect("temp dir");
    let service = Service::new(fragments.path());

    let reply = service.handle(extract(handoff.path(), the_archive()));
    let Reply::Outputs { outputs, produced } = reply else {
        panic!("outputs: {reply:?}");
    };
    assert_eq!(produced.len(), 1, "{produced:?}");
    let Produced { output, path, fill } = &produced[0];
    assert_eq!(output, "file");
    assert_eq!(path.parent().and_then(Path::parent), Some(handoff.path()));
    assert_eq!(path.file_name().and_then(|name| name.to_str()), Some("test.txt"));
    assert_eq!(std::fs::read(path).expect("the produced file").len(), 20);
    // The output holds a placeholder until the caller takes the file in.
    let placeholder = outputs["file"].as_str().expect("a placeholder");
    assert!(placeholder.starts_with("derproduced-"), "{placeholder}");
    // Every sibling the part left out is the caller's to fill.
    for sibling in fill {
        assert!(outputs.get(sibling).is_none(), "{sibling} is both filled and left to fill");
    }
}

#[test]
fn a_token_the_caller_did_not_grant_stages_nothing() {
    let fragments = installed();
    let handoff = tempfile::tempdir().expect("temp dir");
    let reply = Service::new(fragments.path()).handle(extract(handoff.path(), HashMap::new()));
    let Reply::Failed(error) = reply else {
        panic!("a failure: {reply:?}");
    };
    assert!(error.message.contains("needs a picked file"), "{}", error.message);
    assert_eq!(std::fs::read_dir(handoff.path()).expect("handoff").count(), 0);
}

#[test]
fn a_part_that_is_not_installed_and_an_unknown_operation_fail_by_kind() {
    let fragments = installed();
    let handoff = tempfile::tempdir().expect("temp dir");
    let service = Service::new(fragments.path());
    let run = |fragment_id: &str, operation: &str| {
        service.handle(Request::Run {
            fragment_id: fragment_id.to_string(),
            operation: operation.to_string(),
            inputs: json!({}),
            granted: HashMap::new(),
            handoff: handoff.path().to_path_buf(),
        })
    };
    let Reply::Failed(missing) = run("der-labs.absent", "x.y") else {
        panic!("a failure");
    };
    assert_eq!(missing.kind, FragmentErrorKind::NotInstalled);
    let Reply::Failed(unknown) = run(RAR, "rar.nope") else {
        panic!("a failure");
    };
    assert_eq!(unknown.kind, FragmentErrorKind::OperationNotFound);
}

#[test]
fn a_module_is_checked_against_its_capabilities_without_an_install() {
    let fragments = tempfile::tempdir().expect("temp dir");
    let service = Service::new(fragments.path());
    let verified = verify_bundle(&std::fs::read(RAR_BUNDLE).expect("bundle")).expect("verifies");
    let wasm_b64 = BASE64.encode(&verified.wasm);

    let declared = service.handle(Request::Check {
        wasm_b64: wasm_b64.clone(),
        capabilities: verified.manifest.capabilities.clone(),
    });
    assert_eq!(declared, Reply::Done);

    // The same module with nothing declared imports more than it may.
    let undeclared = service.handle(Request::Check {
        wasm_b64,
        capabilities: Vec::new(),
    });
    let Reply::Failed(error) = undeclared else {
        panic!("a failure: {undeclared:?}");
    };
    assert_eq!(error.kind, FragmentErrorKind::AbiMismatch);

    let garbage = service.handle(Request::Check {
        wasm_b64: "not base64 at all!".to_string(),
        capabilities: Vec::new(),
    });
    assert!(matches!(garbage, Reply::Failed(ref error) if error.kind == FragmentErrorKind::VerifyFailed));
    assert_eq!(std::fs::read_dir(fragments.path()).expect("fragments").count(), 0, "nothing is installed");
}

#[test]
fn the_runner_answers_over_its_pipes_by_id() {
    let fragments = installed();
    let handoff = tempfile::tempdir().expect("temp dir");
    let (request_reader, mut requests) = std::io::pipe().expect("pipe");
    let (replies, reply_writer) = std::io::pipe().expect("pipe");
    let dir = fragments.path().to_path_buf();
    let thread = std::thread::spawn(move || serve(dir, BufReader::new(request_reader), reply_writer));
    let mut replies = BufReader::new(replies);
    let mut next = || -> der_wire::ReplyLine<Reply> {
        let mut line = String::new();
        replies.read_line(&mut line).expect("reads");
        serde_json::from_str(&line).unwrap_or_else(|error| panic!("{error}: {line:?}"))
    };
    let mut send = |id: u64, request: Request| {
        let line = serde_json::to_string(&der_wire::RequestLine { id, request }).expect("serializes");
        assert!(line.contains("\"fragmentId\""), "{line}");
        writeln!(requests, "{line}").expect("writes");
    };

    send(1, extract(handoff.path(), the_archive()));
    let ran = next();
    assert_eq!(ran.id, 1);
    assert!(matches!(ran.reply, Reply::Outputs { ref produced, .. } if produced.len() == 1), "{:?}", ran.reply);
    send(2, Request::Forget { fragment_id: RAR.to_string() });
    assert_eq!(next(), der_wire::ReplyLine { id: 2, reply: Reply::Done });

    drop(send);
    drop(requests);
    thread.join().expect("no panic").expect("ends cleanly when the input closes");
}
