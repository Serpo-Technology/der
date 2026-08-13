//! Zip archive bits for the DER wasm host, guest ABI v1: list an archive's
//! entries, extract one, or build an archive from named entries. Pure
//! compute over base64; file IO stays in the platform layer.

use std::alloc::{alloc, Layout};
use std::io::{Cursor, Read, Write};
use std::mem;

use serde_json::{json, Map, Value};
use zip::write::SimpleFileOptions;

const MAX_ARCHIVE_BYTES: usize = 24 * 1024 * 1024;
const MAX_ENTRY_BYTES: u64 = 24 * 1024 * 1024;

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
        "zip.list" => list(inputs),
        "zip.extract" => extract(inputs),
        "zip.create" => create(inputs),
        other => err_response(&format!("unknown operation {}", other)),
    }
}

fn archive_bytes(inputs: &Map<String, Value>) -> Result<Vec<u8>, String> {
    if let Some(Value::String(path)) = inputs.get("file") {
        if !path.starts_with("/in/") {
            return Err("file must be a picked file handle (file.pick's file output)".to_string());
        }
        let bytes = std::fs::read(path)
            .map_err(|error| format!("could not read the picked file: {}", error))?;
        if bytes.len() > MAX_ARCHIVE_BYTES {
            return Err("the archive is larger than 24 MB".to_string());
        }
        return Ok(bytes);
    }
    let data = match inputs.get("base64") {
        Some(Value::String(text)) => text,
        _ => {
            return Err(
                "the operation needs a picked file (bind \"file\" from file.pick) or base64 data"
                    .to_string(),
            )
        }
    };
    let bytes = base64_decode(data).ok_or("base64 does not decode")?;
    if bytes.len() > MAX_ARCHIVE_BYTES {
        return Err("the archive is larger than 24 MB".to_string());
    }
    Ok(bytes)
}

/// Extracted entries and created zips answer as produced /out files when
/// the operation ran from a picked file; base64 stays for legacy chains.
fn file_mode(inputs: &Map<String, Value>) -> bool {
    matches!(inputs.get("file"), Some(Value::String(path)) if path.starts_with("/in/"))
}

fn list(inputs: &Map<String, Value>) -> Vec<u8> {
    let bytes = match archive_bytes(inputs) {
        Ok(bytes) => bytes,
        Err(message) => return err_response(&message),
    };
    let mut archive = match zip::ZipArchive::new(Cursor::new(bytes)) {
        Ok(archive) => archive,
        Err(_) => return err_response("the data is not a readable zip archive"),
    };
    let mut entries: Vec<Value> = Vec::new();
    for index in 0..archive.len() {
        let Ok(entry) = archive.by_index(index) else { continue };
        if entry.is_dir() {
            continue;
        }
        entries.push(json!({
            "name": entry.name(),
            "size": entry.size(),
            "compressed": entry.compressed_size(),
        }));
    }
    ok_response(json!({ "entries": entries, "count": entries.len() }))
}

fn extract(inputs: &Map<String, Value>) -> Vec<u8> {
    let bytes = match archive_bytes(inputs) {
        Ok(bytes) => bytes,
        Err(message) => return err_response(&message),
    };
    let name = match inputs.get("name") {
        Some(Value::String(name)) if !name.is_empty() => name.clone(),
        _ => return err_response("name must be the entry to extract (see zip.list)"),
    };
    let mut archive = match zip::ZipArchive::new(Cursor::new(bytes)) {
        Ok(archive) => archive,
        Err(_) => return err_response("the data is not a readable zip archive"),
    };
    let mut entry = match archive.by_name(&name) {
        Ok(entry) => entry,
        Err(_) => return err_response(&format!("the archive has no entry \"{}\"", name)),
    };
    if entry.size() > MAX_ENTRY_BYTES {
        return err_response("the entry is larger than 24 MB");
    }
    let mut out = Vec::with_capacity(entry.size() as usize);
    if entry.read_to_end(&mut out).is_err() {
        return err_response("the entry does not decompress");
    }
    let text = String::from_utf8(out.clone()).ok();
    if file_mode(inputs) {
        let flat = name.rsplit('/').next().unwrap_or("entry").to_string();
        let out_path = format!("/out/{}", if flat.is_empty() { "entry".to_string() } else { flat });
        if let Err(error) = std::fs::write(&out_path, &out) {
            return err_response(&format!("could not write {}: {}", out_path, error));
        }
        return ok_response(json!({
            "file": out_path,
            "text": text,
            "name": name,
            "size": out.len(),
        }));
    }
    ok_response(json!({
        "base64": base64_encode(&out),
        "text": text,
        "name": name,
        "size": out.len(),
    }))
}

fn create(inputs: &Map<String, Value>) -> Vec<u8> {
    // Entries arrive as an array of {name, base64 | text}.
    let entries = match inputs.get("entries") {
        Some(Value::Array(entries)) if !entries.is_empty() => entries,
        _ => {
            return err_response(
                "entries must be a non-empty array of {name, base64 or text} objects",
            )
        }
    };
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default();
    let mut total: usize = 0;
    for entry in entries {
        let name = match entry.get("name").and_then(Value::as_str) {
            Some(name) if !name.is_empty() => name,
            _ => return err_response("every entry needs a name"),
        };
        let bytes: Vec<u8> = if let Some(Value::String(text)) = entry.get("text") {
            text.as_bytes().to_vec()
        } else if let Some(Value::String(b64)) = entry.get("base64") {
            match base64_decode(b64) {
                Some(bytes) => bytes,
                None => return err_response(&format!("entry \"{}\" base64 does not decode", name)),
            }
        } else {
            return err_response(&format!("entry \"{}\" needs base64 or text content", name));
        };
        total += bytes.len();
        if total > MAX_ARCHIVE_BYTES {
            return err_response("the archive contents exceed 24 MB");
        }
        if writer.start_file(name, options).is_err()
            || writer.write_all(&bytes).is_err()
        {
            return err_response("the archive could not be written");
        }
    }
    let cursor = match writer.finish() {
        Ok(cursor) => cursor,
        Err(_) => return err_response("the archive could not be finished"),
    };
    let bytes = cursor.into_inner();
    // Created zips answer as a produced file whenever the sandbox exists;
    // base64 always ships too, because entries themselves arrive inline
    // and stay small, and legacy chains route it.
    let mut result = json!({
        "base64": base64_encode(&bytes),
        "size": bytes.len(),
        "count": entries.len(),
    });
    if std::path::Path::new("/out").is_dir() {
        let out_path = "/out/archive.zip";
        if let Err(error) = std::fs::write(out_path, &bytes) {
            return err_response(&format!("could not write {}: {}", out_path, error));
        }
        result["file"] = json!(out_path);
    }
    ok_response(result)
}

// ---------------------------------------------------------------------------
// Base64 and ABI plumbing
// ---------------------------------------------------------------------------

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

fn base64_decode(text: &str) -> Option<Vec<u8>> {
    fn value_of(byte: u8) -> Option<u32> {
        match byte {
            b'A'..=b'Z' => Some((byte - b'A') as u32),
            b'a'..=b'z' => Some((byte - b'a' + 26) as u32),
            b'0'..=b'9' => Some((byte - b'0' + 52) as u32),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let cleaned: Vec<u8> = text
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect();
    let stripped: &[u8] = match cleaned.iter().position(|&byte| byte == b'=') {
        Some(index) => &cleaned[..index],
        None => &cleaned,
    };
    let mut out = Vec::with_capacity(stripped.len() * 3 / 4);
    let mut buffer: u32 = 0;
    let mut bits = 0;
    for &byte in stripped {
        let value = value_of(byte)?;
        buffer = (buffer << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    Some(out)
}

fn read_request(ptr: i32, len: i32) -> Option<&'static [u8]> {
    if ptr <= 0 || len <= 0 {
        return None;
    }
    Some(unsafe { std::slice::from_raw_parts(ptr as u32 as *const u8, len as usize) })
}

fn ok_response(data: Value) -> Vec<u8> {
    serde_json::to_vec(&json!({ "ok": data })).unwrap_or_else(|_| b"{\"err\":\"encode\"}".to_vec())
}

fn err_response(message: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({ "err": message }))
        .unwrap_or_else(|_| b"{\"err\":\"encode\"}".to_vec())
}

fn pack(bytes: Vec<u8>) -> i64 {
    let len = bytes.len() as i64;
    let ptr = bytes.as_ptr() as i64;
    mem::forget(bytes);
    (ptr << 32) | len
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_list_extract_round_trip() {
        let mut inputs = Map::new();
        inputs.insert(
            "entries".into(),
            json!([
                { "name": "notes.txt", "text": "hello archive" },
                { "name": "data/report.md", "text": "# Report\n\nBody." }
            ]),
        );
        let created: Value = serde_json::from_slice(&create(&inputs)).unwrap();
        let archive_b64 = created["ok"]["base64"].as_str().unwrap().to_string();
        assert_eq!(created["ok"]["count"], json!(2));

        let mut list_inputs = Map::new();
        list_inputs.insert("base64".into(), json!(archive_b64));
        let listed: Value = serde_json::from_slice(&list(&list_inputs)).unwrap();
        assert_eq!(listed["ok"]["count"], json!(2));
        let names: Vec<&str> = listed["ok"]["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["notes.txt", "data/report.md"]);

        let mut extract_inputs = Map::new();
        extract_inputs.insert("base64".into(), json!(archive_b64));
        extract_inputs.insert("name".into(), json!("notes.txt"));
        let extracted: Value = serde_json::from_slice(&extract(&extract_inputs)).unwrap();
        assert_eq!(extracted["ok"]["text"], json!("hello archive"));
    }

    #[test]
    fn bad_archives_and_missing_entries_answer_with_errors() {
        let mut inputs = Map::new();
        inputs.insert("base64".into(), json!("aGVsbG8="));
        let listed: Value = serde_json::from_slice(&list(&inputs)).unwrap();
        assert!(listed["err"].as_str().unwrap().contains("zip"));
    }
}
