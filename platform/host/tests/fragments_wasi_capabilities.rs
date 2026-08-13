//! The granted-capability execution paths, driven by the committed wasip1
//! fixture: a file staged from a grant token into the /in preopen comes
//! back as a produced /out file registered through the exec environment,
//! and a net capability bridges the guest's stdio to a host-connected
//! loopback stream.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use dynamic_experience_runtime_lib::fragments::{
    execute_in_module_with, ExecEnv, FragmentsState, Manifest,
};
use serde_json::{json, Value};

const FIXTURE_WASM: &str = "tests/fixtures/wasi_echo.wasm";

fn fixture_manifest(capabilities: &[&str]) -> Manifest {
    serde_json::from_value(json!({
        "formatVersion": 1,
        "abiVersion": 1,
        "id": "test.wasi-echo",
        "name": "Wasi Echo",
        "version": "1.0.0",
        "publisher": "test",
        "description": "capability fixture",
        "namespace": "fx",
        "capabilities": capabilities,
        "wasmSha256": "unchecked-in-unit-tests",
        "createdAt": "2026-07-27T00:00:00Z",
        "operations": [
            {
                "name": "fx.upper",
                "description": "uppercases a granted file",
                "inputs": [{ "name": "file", "type": "file", "required": true }],
                "outputs": [
                    { "name": "file", "type": "file" },
                    { "name": "url", "type": "string" },
                    { "name": "name", "type": "string" },
                    { "name": "size", "type": "number" },
                    { "name": "text", "type": "string" }
                ]
            },
            {
                "name": "fx.greet",
                "description": "answers one line from the stream",
                "inputs": [],
                "outputs": [{ "name": "greeting", "type": "string" }]
            }
        ]
    }))
    .expect("manifest parses")
}

fn load_fixture(
    state: &FragmentsState,
    capabilities: &[&str],
) -> dynamic_experience_runtime_lib::fragments::LoadedFragment {
    let wasm = std::fs::read(FIXTURE_WASM).expect("committed fixture present");
    let caps: Vec<String> = capabilities.iter().map(|c| c.to_string()).collect();
    let module = state.compile(&wasm, &caps).expect("fixture verifies");
    dynamic_experience_runtime_lib::fragments::LoadedFragment::for_tests(
        fixture_manifest(capabilities),
        module,
    )
}

#[test]
fn granted_file_flows_in_and_the_produced_file_comes_back_as_a_grant() {
    let state = FragmentsState::new();
    let loaded = load_fixture(&state, &["wasi:files"]);

    let input_dir = std::env::temp_dir().join(format!("der-test-{}", std::process::id()));
    std::fs::create_dir_all(&input_dir).expect("input dir");
    let input_path = input_dir.join("notes.txt");
    std::fs::write(&input_path, "hello capability").expect("input file");

    let registered: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());
    let resolve = |token: &str| {
        (token == "derfile-test-token").then(|| input_path.clone())
    };
    let register = |produced: &Path| {
        let kept = input_dir.join("kept-upper.txt");
        std::fs::copy(produced, &kept).map_err(|e| e.to_string())?;
        registered.lock().unwrap().push(kept.clone());
        Ok(json!({
            "file": "derfile-produced-token",
            "url": "asset://kept-upper.txt",
            "name": "upper.txt",
            "size": std::fs::metadata(&kept).map(|m| m.len()).unwrap_or(0),
        }))
    };
    let exec_env = ExecEnv { resolve_grant: &resolve, register_output: &register };

    let result = execute_in_module_with(
        state.engine(),
        &loaded,
        "fx.upper",
        &json!({ "file": "derfile-test-token" }),
        &exec_env,
    )
    .expect("runs under wasi:files");

    assert_eq!(result["text"], "HELLO CAPABILITY");
    assert_eq!(result["file"], "derfile-produced-token");
    assert_eq!(result["name"], "upper.txt");
    assert_eq!(result["url"], "asset://kept-upper.txt");
    let kept = registered.lock().unwrap();
    assert_eq!(kept.len(), 1);
    assert_eq!(
        std::fs::read_to_string(&kept[0]).expect("kept file"),
        "HELLO CAPABILITY"
    );
}

#[test]
fn an_unresolved_token_refuses_with_a_pick_hint() {
    let state = FragmentsState::new();
    let loaded = load_fixture(&state, &["wasi:files"]);
    let error = execute_in_module_with(
        state.engine(),
        &loaded,
        "fx.upper",
        &json!({ "file": "derfile-unknown" }),
        &ExecEnv::none(),
    )
    .expect_err("must refuse");
    assert!(error.message.contains("needs a picked file"));
}

#[test]
fn a_net_capability_bridges_stdio_to_the_declared_endpoint() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("loopback listener");
    let port = listener.local_addr().expect("addr").port();
    let server = std::thread::spawn(move || {
        use std::io::{Read, Write};
        let (mut socket, _addr) = listener.accept().expect("accepts");
        socket.write_all(b"hello from the server\n").expect("greets");
        let mut reply = [0u8; 32];
        let n = socket.read(&mut reply).unwrap_or(0);
        String::from_utf8_lossy(&reply[..n]).to_string()
    });

    let state = FragmentsState::new();
    // The shared fixture links the file helpers too, so its import set
    // needs both grants; a real protocol part would declare net alone.
    let capability = format!("net:127.0.0.1:{}", port);
    let loaded = load_fixture(&state, &["wasi:files", capability.as_str()]);

    let result = execute_in_module_with(
        state.engine(),
        &loaded,
        "fx.greet",
        &json!({}),
        &ExecEnv::none(),
    )
    .expect("runs under the net grant");

    assert_eq!(result["greeting"], "hello from the server");
    let reply = server.join().expect("server thread");
    assert_eq!(reply, "HELLO BACK\n");
}
