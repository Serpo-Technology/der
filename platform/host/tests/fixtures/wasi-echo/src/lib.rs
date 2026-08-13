//! Test fixture part exercising the granted WASI capabilities, ABI v1 over
//! wasip1 (std available, reactor initialization handled by the host).
//!
//! `fx.upper` reads its granted input file from the /in preopen, writes the
//! uppercased text to /out, and answers with the produced file's guest path
//! (the host rewrites it into a grant token). `fx.greet` reads one line
//! from stdin and answers it, with stdio bridged to a host-connected
//! socket under a net capability.

use std::alloc::{alloc, Layout};
use std::io::{BufRead, Write};
use std::mem;

use serde_json::{json, Value};

#[no_mangle]
pub extern "C" fn der_alloc(size: i32) -> i32 {
    if size <= 0 {
        return 0;
    }
    let layout = match Layout::from_size_align(size as usize, 1) {
        Ok(layout) => layout,
        Err(_) => return 0,
    };
    let ptr = unsafe { alloc(layout) };
    if ptr.is_null() {
        return 0;
    }
    ptr as i32
}

#[no_mangle]
pub extern "C" fn der_run(ptr: i32, len: i32) -> i64 {
    pack(handle(ptr, len))
}

fn handle(ptr: i32, len: i32) -> Vec<u8> {
    if ptr <= 0 || len <= 0 {
        return err("empty request");
    }
    let bytes = unsafe { std::slice::from_raw_parts(ptr as u32 as *const u8, len as usize) };
    let envelope: Value = match serde_json::from_slice(bytes) {
        Ok(value) => value,
        Err(_) => return err("request is not valid JSON"),
    };
    let inputs = envelope.get("inputs").cloned().unwrap_or(json!({}));
    match envelope.get("operation").and_then(Value::as_str) {
        Some("fx.upper") => upper(&inputs),
        Some("fx.greet") => greet(),
        Some("fx.count") => count_start(&inputs),
        Some("fx.countStep") => count_step(),
        _ => err("unknown operation"),
    }
}

/// Job state living in the instance across steps: the whole point of a
/// job-scoped instance is that this survives between der_run calls.
static TOTAL: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
static DONE_STEPS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

fn count_start(inputs: &Value) -> Vec<u8> {
    let total = inputs.get("totalSteps").and_then(Value::as_u64).unwrap_or(0) as u32;
    if total == 0 {
        return err("totalSteps must be a positive number");
    }
    TOTAL.store(total, std::sync::atomic::Ordering::SeqCst);
    DONE_STEPS.store(0, std::sync::atomic::Ordering::SeqCst);
    ok(json!({}))
}

fn count_step() -> Vec<u8> {
    let total = TOTAL.load(std::sync::atomic::Ordering::SeqCst);
    if total == 0 {
        return err("no job was started in this instance");
    }
    let done = DONE_STEPS.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    let finished = done >= total;
    if finished {
        if let Err(error) = std::fs::write("/out/count.txt", format!("counted {}", done)) {
            return err(&format!("could not write /out/count.txt: {}", error));
        }
        return ok(json!({
            "progress": 1.0,
            "done": true,
            "file": "/out/count.txt",
        }));
    }
    ok(json!({
        "progress": done as f64 / total as f64,
        "done": false,
    }))
}

fn upper(inputs: &Value) -> Vec<u8> {
    let path = match inputs.get("file").and_then(Value::as_str) {
        Some(path) if !path.is_empty() => path,
        _ => return err("file has no value yet; run the operation that sets it first"),
    };
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) => return err(&format!("could not read {}: {}", path, error)),
    };
    let upper = text.to_uppercase();
    if let Err(error) = std::fs::write("/out/upper.txt", &upper) {
        return err(&format!("could not write /out/upper.txt: {}", error));
    }
    ok(json!({ "file": "/out/upper.txt", "text": upper }))
}

fn greet() -> Vec<u8> {
    let stdin = std::io::stdin();
    let mut line = String::new();
    if let Err(error) = stdin.lock().read_line(&mut line) {
        return err(&format!("could not read the stream: {}", error));
    }
    let mut stdout = std::io::stdout();
    if stdout.write_all(b"HELLO BACK\n").is_err() || stdout.flush().is_err() {
        return err("could not write the stream");
    }
    ok(json!({ "greeting": line.trim() }))
}

fn ok(data: Value) -> Vec<u8> {
    serde_json::to_vec(&json!({ "ok": data })).unwrap_or_default()
}

fn err(message: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({ "err": message })).unwrap_or_default()
}

fn pack(response: Vec<u8>) -> i64 {
    let out_ptr = response.as_ptr() as u32 as u64;
    let out_len = response.len() as u32 as u64;
    mem::forget(response);
    ((out_ptr << 32) | out_len) as i64
}
