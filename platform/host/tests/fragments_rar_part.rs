//! The RAR part end to end in the wasmtime host: libarchive's readers on
//! wasip1 listing and extracting the committed RAR4 and RAR5 fixtures,
//! with the archive arriving as a grant and entries leaving as grants.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use dynamic_experience_runtime_lib::fragments::{
    verify_bundle, ExecEnv, FragmentsState, LoadedFragment,
};
use serde_json::{json, Value};

const BUNDLE: &str = "../../fragments/dist/der-labs.rar.derpart";

fn shared() -> &'static (FragmentsState, LoadedFragment) {
    use std::sync::OnceLock;
    static SHARED: OnceLock<(FragmentsState, LoadedFragment)> = OnceLock::new();
    SHARED.get_or_init(|| {
        let state = FragmentsState::new();
        let raw = std::fs::read(BUNDLE).expect("committed rar bundle present");
        let verified = verify_bundle(&raw).expect("bundle verifies");
        let module = state
            .compile(&verified.wasm, &verified.manifest.capabilities)
            .expect("rar module passes the capability verifier");
        (state, LoadedFragment::for_tests(verified.manifest, module))
    })
}

fn run_op(
    kept: &Mutex<Vec<PathBuf>>,
    keep_dir: &Path,
    operation: &str,
    inputs: Value,
) -> Result<Value, String> {
    let (state, loaded) = shared();
    let resolve = |token: &str| {
        token
            .strip_prefix("granted-")
            .map(|name| PathBuf::from("tests/fixtures/rar").join(name))
            .filter(|path| path.is_file())
    };
    let register = |produced: &Path| {
        let name = produced
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let target = keep_dir.join(&name);
        std::fs::copy(produced, &target).map_err(|e| e.to_string())?;
        let size = std::fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
        kept.lock().unwrap().push(target);
        Ok(json!({
            "file": format!("produced-{}", name),
            "url": format!("asset://{}", name),
            "name": name,
            "size": size,
        }))
    };
    let exec_env = ExecEnv { resolve_grant: &resolve, register_output: &register };
    state
        .execute_operation_with(loaded, operation, &inputs, &exec_env)
        .map_err(|error| error.message)
}

fn keep_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("der-rar-{}-{}", tag, std::process::id()));
    std::fs::create_dir_all(&dir).expect("keep dir");
    dir
}

#[test]
fn lists_a_rar5_archive() {
    let kept = Mutex::new(Vec::new());
    let result = run_op(
        &kept,
        &keep_dir("list5"),
        "rar.list",
        json!({ "file": "granted-multi.rar" }),
    )
    .expect("lists");
    assert_eq!(result["count"], 4);
    let entries = result["entries"].as_array().expect("entries");
    assert_eq!(entries[0]["name"], "test1.bin");
    assert_eq!(entries[0]["size"], 4096);
    assert_eq!(entries[0]["kind"], "file");
}

#[test]
fn lists_a_classic_rar_with_folders() {
    let kept = Mutex::new(Vec::new());
    let result = run_op(
        &kept,
        &keep_dir("list4"),
        "rar.list",
        json!({ "file": "granted-classic.rar" }),
    )
    .expect("lists");
    let entries = result["entries"].as_array().expect("entries");
    let names: Vec<&str> = entries.iter().filter_map(|e| e["name"].as_str()).collect();
    assert!(names.contains(&"test.txt"));
    assert!(names.contains(&"testdir"));
    let dir = entries.iter().find(|e| e["name"] == "testdir").expect("dir row");
    assert_eq!(dir["kind"], "folder");
}

#[test]
fn extracts_an_entry_as_a_grant() {
    let kept = Mutex::new(Vec::new());
    let dir = keep_dir("extract");
    let result = run_op(
        &kept,
        &dir,
        "rar.extract",
        json!({ "file": "granted-classic.rar", "name": "test.txt" }),
    )
    .expect("extracts");
    assert_eq!(result["file"], "produced-test.txt");
    assert_eq!(result["size"], 20);
    let bytes = std::fs::read(&kept.lock().unwrap()[0]).expect("extracted bytes");
    assert_eq!(bytes.len(), 20);
    assert!(std::str::from_utf8(&bytes).is_ok(), "text entry decodes");
}

#[test]
fn extracts_from_rar5() {
    let kept = Mutex::new(Vec::new());
    let result = run_op(
        &kept,
        &keep_dir("extract5"),
        "rar.extract",
        json!({ "file": "granted-multi.rar", "name": "test2.bin" }),
    )
    .expect("extracts");
    assert_eq!(result["size"], 4096);
    let bytes = std::fs::read(&kept.lock().unwrap()[0]).expect("bytes");
    assert_eq!(bytes.len(), 4096);
}

#[test]
fn a_missing_entry_names_the_fix() {
    let kept = Mutex::new(Vec::new());
    let error = run_op(
        &kept,
        &keep_dir("missing"),
        "rar.extract",
        json!({ "file": "granted-multi.rar", "name": "nope.txt" }),
    )
    .expect_err("refuses");
    assert!(error.contains("no entry"), "got: {}", error);
    assert!(error.contains("rar.list"), "got: {}", error);
}

#[test]
fn a_folder_entry_refuses() {
    let kept = Mutex::new(Vec::new());
    let error = run_op(
        &kept,
        &keep_dir("folder"),
        "rar.extract",
        json!({ "file": "granted-classic.rar", "name": "testdir" }),
    )
    .expect_err("refuses");
    assert!(error.contains("folder"), "got: {}", error);
}
