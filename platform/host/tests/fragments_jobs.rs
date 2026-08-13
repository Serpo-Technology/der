//! Job-scoped instances: a start parks a live guest in the registry, steps
//! run against its persistent memory, the done step harvests /out as a
//! grant and tears the job down, and abandoned jobs reap. Driven by the
//! committed wasip1 fixture's counting job.

use std::path::Path;

use dynamic_experience_runtime_lib::fragments::{ExecEnv, FragmentsState, Manifest};
use serde_json::{json, Value};

const FIXTURE_WASM: &str = "tests/fixtures/wasi_echo.wasm";

fn job_manifest() -> Manifest {
    serde_json::from_value(json!({
        "formatVersion": 1,
        "abiVersion": 1,
        "id": "test.counting",
        "name": "Counting",
        "version": "1.0.0",
        "publisher": "test",
        "description": "job fixture",
        "namespace": "fx",
        "capabilities": ["wasi:files"],
        "wasmSha256": "unchecked-in-unit-tests",
        "createdAt": "2026-07-27T00:00:00Z",
        "operations": [
            {
                "name": "fx.count",
                "description": "starts counting",
                "job": "start",
                "inputs": [{ "name": "totalSteps", "type": "number", "required": true }],
                "outputs": [{ "name": "job", "type": "job" }]
            },
            {
                "name": "fx.countStep",
                "description": "advances the count",
                "job": "step",
                "inputs": [{ "name": "job", "type": "job", "required": true }],
                "outputs": [
                    { "name": "progress", "type": "number" },
                    { "name": "done", "type": "boolean" },
                    { "name": "file", "type": "file" }
                ]
            }
        ]
    }))
    .expect("manifest parses")
}

fn load(state: &FragmentsState) -> dynamic_experience_runtime_lib::fragments::LoadedFragment {
    let wasm = std::fs::read(FIXTURE_WASM).expect("committed fixture present");
    let module = state
        .compile(&wasm, &["wasi:files".to_string()])
        .expect("fixture verifies");
    dynamic_experience_runtime_lib::fragments::LoadedFragment::for_tests(job_manifest(), module)
}

fn keep_dir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("der-job-test-{}", uuid_ish()));
    std::fs::create_dir_all(&dir).expect("keep dir");
    dir
}

fn uuid_ish() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    format!(
        "{}-{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
    )
}

#[test]
fn a_job_counts_across_steps_and_delivers_its_file_at_done() {
    let state = FragmentsState::new();
    let loaded = load(&state);
    let dir = keep_dir();
    let register = |produced: &Path| {
        let kept = dir.join("count.txt");
        std::fs::copy(produced, &kept).map_err(|e| e.to_string())?;
        Ok(json!({ "file": "derfile-count-token", "url": "asset://count", "name": "count.txt", "size": 9 }))
    };
    let resolve = |_token: &str| None;
    let exec_env = ExecEnv { resolve_grant: &resolve, register_output: &register };

    let started = state
        .execute_operation_with(&loaded, "fx.count", &json!({ "totalSteps": 3 }), &exec_env)
        .expect("job starts");
    let token = started["job"].as_str().expect("token issued").to_string();
    assert!(token.starts_with("derjob-"));

    let step = |state: &FragmentsState| {
        state.execute_operation_with(
            &loaded,
            "fx.countStep",
            &json!({ "job": token }),
            &exec_env,
        )
    };

    let one = step(&state).expect("first step");
    assert_eq!(one["done"], Value::Bool(false));
    assert!((one["progress"].as_f64().unwrap() - 1.0 / 3.0).abs() < 1e-9);

    let two = step(&state).expect("second step");
    assert_eq!(two["done"], Value::Bool(false));

    let three = step(&state).expect("final step");
    assert_eq!(three["done"], Value::Bool(true));
    assert_eq!(three["file"], "derfile-count-token");
    assert_eq!(
        std::fs::read_to_string(dir.join("count.txt")).expect("kept"),
        "counted 3"
    );

    // The job is gone after done: another step refuses.
    let after = step(&state).expect_err("job ended");
    assert!(after.message.contains("No running job"));
}

#[test]
fn an_unknown_token_refuses() {
    let state = FragmentsState::new();
    let loaded = load(&state);
    let error = state
        .execute_operation_with(
            &loaded,
            "fx.countStep",
            &json!({ "job": "derjob-nope" }),
            &ExecEnv::none(),
        )
        .expect_err("must refuse");
    assert!(error.message.contains("No running job"));
}

#[test]
fn a_failing_step_ends_the_job() {
    let state = FragmentsState::new();
    let loaded = load(&state);
    // totalSteps 0 makes the START fail inside the guest; the registry
    // never holds the job.
    let error = state
        .execute_operation_with(&loaded, "fx.count", &json!({ "totalSteps": 0 }), &ExecEnv::none())
        .expect_err("start refuses");
    assert!(error.message.contains("totalSteps"));
}

#[test]
fn abandoned_jobs_reap() {
    let state = FragmentsState::new();
    let loaded = load(&state);
    let started = state
        .execute_operation_with(&loaded, "fx.count", &json!({ "totalSteps": 5 }), &ExecEnv::none())
        .expect("job starts");
    let token = started["job"].as_str().expect("token").to_string();

    std::thread::sleep(std::time::Duration::from_millis(20));
    state.reap_jobs_older_than(std::time::Duration::from_millis(1));

    let error = state
        .execute_operation_with(
            &loaded,
            "fx.countStep",
            &json!({ "job": token }),
            &ExecEnv::none(),
        )
        .expect_err("reaped");
    assert!(error.message.contains("No running job"));
}

#[test]
fn the_job_cap_refuses_the_next_start() {
    let state = FragmentsState::new();
    let loaded = load(&state);
    for _ in 0..8 {
        state
            .execute_operation_with(&loaded, "fx.count", &json!({ "totalSteps": 9 }), &ExecEnv::none())
            .expect("starts under the cap");
    }
    let error = state
        .execute_operation_with(&loaded, "fx.count", &json!({ "totalSteps": 9 }), &ExecEnv::none())
        .expect_err("cap reached");
    assert!(error.message.contains("Too many jobs"));
}
