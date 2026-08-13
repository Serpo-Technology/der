//! Image conversion bits for the DER wasm host, guest ABI v1: probe,
//! resize, and convert between png, jpeg, gif, webp, and bmp. Inputs are
//! either a granted file (the host stages it under /in and this code
//! answers a produced /out file) or legacy base64 payloads, which still
//! answer base64; the io:large capability raises the host budgets because
//! photos are megabytes.

use std::alloc::{alloc, Layout};
use std::io::Cursor;
use std::mem;

use image::{DynamicImage, ImageFormat, ImageReader};
use serde_json::{json, Map, Value};

const MAX_IMAGE_BYTES: usize = 24 * 1024 * 1024;

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
        "image.info" => info(inputs),
        "image.resize" => resize(inputs),
        "image.convert" => convert(inputs),
        other => err_response(&format!("unknown operation {}", other)),
    }
}

/// The staged /in path when the operation ran in file mode; None for the
/// legacy base64 flow. Output routing follows the same mode.
fn file_input(inputs: &Map<String, Value>) -> Option<String> {
    match inputs.get("file") {
        Some(Value::String(path)) if path.starts_with("/in/") => Some(path.clone()),
        _ => None,
    }
}

/// The input's file stem, for naming the produced /out file.
fn input_stem(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or("image");
    let stem = name.rsplit_once('.').map(|(stem, _)| stem).unwrap_or(name);
    if stem.is_empty() { "image".to_string() } else { stem.to_string() }
}

fn decode_image(inputs: &Map<String, Value>) -> Result<(DynamicImage, ImageFormat), String> {
    let bytes = if let Some(path) = file_input(inputs) {
        std::fs::read(&path).map_err(|error| format!("could not read the picked file: {}", error))?
    } else {
        let data = match inputs.get("base64") {
            Some(Value::String(text)) => text,
            _ => {
                return Err(
                    "the operation needs a picked file (bind \"file\" from file.pick) or base64 data"
                        .to_string(),
                )
            }
        };
        base64_decode(data).ok_or("base64 does not decode")?
    };
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("the image is larger than 24 MB".to_string());
    }
    let reader = ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|_| "the data is not a readable image".to_string())?;
    let format = reader.format().ok_or("the image format is not recognized")?;
    let image = reader
        .decode()
        .map_err(|error| format!("the image does not decode: {}", error))?;
    Ok((image, format))
}

fn format_name(format: ImageFormat) -> &'static str {
    match format {
        ImageFormat::Png => "png",
        ImageFormat::Jpeg => "jpeg",
        ImageFormat::Gif => "gif",
        ImageFormat::WebP => "webp",
        ImageFormat::Bmp => "bmp",
        _ => "other",
    }
}

fn parse_format(name: &str) -> Option<ImageFormat> {
    match name.to_ascii_lowercase().as_str() {
        "png" => Some(ImageFormat::Png),
        "jpeg" | "jpg" => Some(ImageFormat::Jpeg),
        "gif" => Some(ImageFormat::Gif),
        "webp" => Some(ImageFormat::WebP),
        "bmp" => Some(ImageFormat::Bmp),
        _ => None,
    }
}

fn encode(image: &DynamicImage, format: ImageFormat) -> Result<Vec<u8>, String> {
    let mut out = Cursor::new(Vec::new());
    // JPEG cannot carry alpha; flatten first.
    if format == ImageFormat::Jpeg {
        DynamicImage::ImageRgb8(image.to_rgb8())
            .write_to(&mut out, format)
            .map_err(|error| format!("encoding failed: {}", error))?;
    } else {
        image
            .write_to(&mut out, format)
            .map_err(|error| format!("encoding failed: {}", error))?;
    }
    Ok(out.into_inner())
}

fn info(inputs: &Map<String, Value>) -> Vec<u8> {
    match decode_image(inputs) {
        Ok((image, format)) => ok_response(json!({
            "width": image.width(),
            "height": image.height(),
            "format": format_name(format),
        })),
        Err(message) => err_response(&message),
    }
}

fn resize(inputs: &Map<String, Value>) -> Vec<u8> {
    let (image, format) = match decode_image(inputs) {
        Ok(pair) => pair,
        Err(message) => return err_response(&message),
    };
    let max_width = number_input(inputs, "maxWidth").unwrap_or(0.0) as u32;
    let max_height = number_input(inputs, "maxHeight").unwrap_or(0.0) as u32;
    if max_width == 0 && max_height == 0 {
        return err_response("resize needs maxWidth or maxHeight");
    }
    let bound_w = if max_width == 0 { u32::MAX } else { max_width };
    let bound_h = if max_height == 0 { u32::MAX } else { max_height };
    let resized = image.thumbnail(bound_w, bound_h);
    let target = inputs
        .get("format")
        .and_then(Value::as_str)
        .and_then(parse_format)
        .unwrap_or(format);
    match encode(&resized, target) {
        Ok(bytes) => emit(inputs, bytes, resized.width(), resized.height(), target),
        Err(message) => err_response(&message),
    }
}

/// Answers in the caller's mode: a produced /out file for staged inputs,
/// base64 for the legacy flow.
fn emit(
    inputs: &Map<String, Value>,
    bytes: Vec<u8>,
    width: u32,
    height: u32,
    target: ImageFormat,
) -> Vec<u8> {
    if let Some(path) = file_input(inputs) {
        let ext = match target {
            ImageFormat::Jpeg => "jpg",
            other => format_name(other),
        };
        let out_path = format!("/out/{}.{}", input_stem(&path), ext);
        if let Err(error) = std::fs::write(&out_path, &bytes) {
            return err_response(&format!("could not write {}: {}", out_path, error));
        }
        return ok_response(json!({
            "file": out_path,
            "width": width,
            "height": height,
            "format": format_name(target),
            "size": bytes.len(),
        }));
    }
    ok_response(json!({
        "base64": base64_encode(&bytes),
        "width": width,
        "height": height,
        "format": format_name(target),
        "size": bytes.len(),
    }))
}

fn convert(inputs: &Map<String, Value>) -> Vec<u8> {
    let (image, _) = match decode_image(inputs) {
        Ok(pair) => pair,
        Err(message) => return err_response(&message),
    };
    let Some(target) = inputs.get("format").and_then(Value::as_str).and_then(parse_format) else {
        return err_response("format must be png, jpeg, gif, webp, or bmp");
    };
    match encode(&image, target) {
        Ok(bytes) => emit(inputs, bytes, image.width(), image.height(), target),
        Err(message) => err_response(&message),
    }
}

fn number_input(inputs: &Map<String, Value>, key: &str) -> Option<f64> {
    match inputs.get(key) {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(text)) => text.trim().parse().ok(),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Base64 and the guest ABI plumbing
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

    fn tiny_png() -> String {
        // A 2x1 png rendered by the image crate itself keeps the fixture honest.
        let mut buffer = image::RgbaImage::new(2, 1);
        buffer.put_pixel(0, 0, image::Rgba([255, 0, 0, 255]));
        buffer.put_pixel(1, 0, image::Rgba([0, 0, 255, 255]));
        let mut out = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(buffer)
            .write_to(&mut out, ImageFormat::Png)
            .unwrap();
        base64_encode(&out.into_inner())
    }

    #[test]
    fn info_reports_dimensions_and_format() {
        let mut inputs = Map::new();
        inputs.insert("base64".into(), json!(tiny_png()));
        let out: Value = serde_json::from_slice(&info(&inputs)).unwrap();
        assert_eq!(out["ok"]["width"], json!(2));
        assert_eq!(out["ok"]["format"], json!("png"));
    }

    #[test]
    fn convert_produces_the_requested_format() {
        let mut inputs = Map::new();
        inputs.insert("base64".into(), json!(tiny_png()));
        inputs.insert("format".into(), json!("jpeg"));
        let out: Value = serde_json::from_slice(&convert(&inputs)).unwrap();
        assert_eq!(out["ok"]["format"], json!("jpeg"));
        let bytes = base64_decode(out["ok"]["base64"].as_str().unwrap()).unwrap();
        assert_eq!(&bytes[..2], &[0xff, 0xd8], "JPEG magic");
    }

    #[test]
    fn resize_bounds_the_larger_side() {
        let mut buffer = image::RgbaImage::new(64, 32);
        buffer.put_pixel(0, 0, image::Rgba([1, 2, 3, 255]));
        let mut out = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(buffer)
            .write_to(&mut out, ImageFormat::Png)
            .unwrap();
        let mut inputs = Map::new();
        inputs.insert("base64".into(), json!(base64_encode(&out.into_inner())));
        inputs.insert("maxWidth".into(), json!(16));
        let result: Value = serde_json::from_slice(&resize(&inputs)).unwrap();
        assert_eq!(result["ok"]["width"], json!(16));
        assert_eq!(result["ok"]["height"], json!(8));
    }
}
