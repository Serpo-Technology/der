//! Statistics part for the DER wasm host, guest ABI v1.
//!
//! The module exports `memory`, `der_alloc`, and `der_run` and imports
//! nothing. The host writes a JSON request envelope
//! `{"operation": name, "inputs": object}` into guest memory and calls
//! `der_run`; the guest answers with `{"ok": object}` or
//! `{"err": message}` and packs the response buffer as
//! `(ptr << 32) | len` in the i64 return value. Bad input always produces
//! an `err` response instead of a panic.

use std::alloc::{alloc, Layout};
use std::cmp::Ordering;
use std::mem;

use serde_json::{json, Map, Value};

/// Allocates `size` bytes for the host to write the request into.
/// Returns 0 when the size is not positive or allocation fails.
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

/// Runs one operation. The request buffer at (ptr, len) was produced by
/// `der_alloc` and filled by the host. The response buffer is leaked on
/// purpose: the host copies it out and drops the whole instance.
#[no_mangle]
pub extern "C" fn der_run(ptr: i32, len: i32) -> i64 {
    pack(handle(ptr, len))
}

fn handle(ptr: i32, len: i32) -> Vec<u8> {
    let request = match read_request(ptr, len) {
        Some(bytes) => bytes,
        None => return err_response("empty request"),
    };
    let envelope: Value = match serde_json::from_slice(request) {
        Ok(value) => value,
        Err(_) => return err_response("request is not valid JSON"),
    };
    let operation = match envelope.get("operation").and_then(Value::as_str) {
        Some(name) => name,
        None => return err_response("request has no operation name"),
    };
    let empty = Map::new();
    let inputs = envelope
        .get("inputs")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    match operation {
        "stats.summary" => summary(inputs),
        "stats.percentile" => percentile(inputs),
        other => err_response(&format!("unknown operation {}", other)),
    }
}

fn read_request(ptr: i32, len: i32) -> Option<&'static [u8]> {
    if ptr <= 0 || len <= 0 {
        return None;
    }
    Some(unsafe { std::slice::from_raw_parts(ptr as u32 as *const u8, len as usize) })
}

/// Collects the numeric entries of the `values` input. Entries that are
/// not JSON numbers are skipped; a missing or non-array input yields an
/// empty list.
fn numbers(inputs: &Map<String, Value>) -> Vec<f64> {
    inputs
        .get("values")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_f64).collect())
        .unwrap_or_default()
}

fn summary(inputs: &Map<String, Value>) -> Vec<u8> {
    let values = numbers(inputs);
    if values.is_empty() {
        return ok_response(json!({
            "count": 0, "sum": 0, "mean": 0, "min": 0, "max": 0
        }));
    }
    let count = values.len();
    let sum: f64 = values.iter().sum();
    let mean = sum / count as f64;
    let mut min = values[0];
    let mut max = values[0];
    for value in &values[1..] {
        if *value < min {
            min = *value;
        }
        if *value > max {
            max = *value;
        }
    }
    ok_response(json!({
        "count": count, "sum": sum, "mean": mean, "min": min, "max": max
    }))
}

fn percentile(inputs: &Map<String, Value>) -> Vec<u8> {
    let mut values = numbers(inputs);
    if values.is_empty() {
        return err_response("values is empty");
    }
    let p = match inputs.get("p").and_then(Value::as_f64) {
        Some(p) if (0.0..=100.0).contains(&p) => p,
        _ => return err_response("p must be between 0 and 100"),
    };
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));

    // Linear interpolation between closest ranks on the sorted values.
    let last = values.len() - 1;
    let rank = p / 100.0 * last as f64;
    let lo = (rank.floor() as usize).min(last);
    let hi = (rank.ceil() as usize).min(last);
    let frac = rank - lo as f64;
    let value = values[lo] + (values[hi] - values[lo]) * frac;
    ok_response(json!({ "value": value }))
}

fn ok_response(data: Value) -> Vec<u8> {
    to_bytes(json!({ "ok": data }))
}

fn err_response(message: &str) -> Vec<u8> {
    to_bytes(json!({ "err": message }))
}

fn to_bytes(value: Value) -> Vec<u8> {
    serde_json::to_vec(&value)
        .unwrap_or_else(|_| br#"{"err":"response serialization failed"}"#.to_vec())
}

fn pack(response: Vec<u8>) -> i64 {
    let out_ptr = response.as_ptr() as u32 as u64;
    let out_len = response.len() as u32 as u64;
    mem::forget(response);
    ((out_ptr << 32) | out_len) as i64
}
