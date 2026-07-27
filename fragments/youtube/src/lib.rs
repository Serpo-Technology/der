//! YouTube link parsing part for the DER wasm host, guest ABI v1.
//!
//! Exports `memory`, `der_alloc`, and `der_run` and imports nothing. The
//! host writes `{"operation": name, "inputs": object}` into guest memory;
//! the guest answers `{"ok": object}` or `{"err": message}` packed as
//! `(ptr << 32) | len`. Bad input always produces an `err` response.
//!
//! `youtube.parse` accepts every common link form (watch, youtu.be,
//! shorts, live, embed, /v/, music.youtube, a bare video id) plus `t=` /
//! `start=` timestamps, and answers the canonical urls a player needs.
//! The embed url uses the youtube-nocookie.com host, YouTube's
//! reduced-tracking embed domain.

use std::alloc::{alloc, Layout};
use std::mem;

use serde_json::{json, Map, Value};

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
        "youtube.parse" => parse_operation(inputs),
        other => err_response(&format!("unknown operation {}", other)),
    }
}

fn parse_operation(inputs: &Map<String, Value>) -> Vec<u8> {
    let url = match inputs.get("url") {
        Some(Value::String(s)) => s.trim().to_string(),
        Some(Value::Null) | None => {
            return err_response("url has no value yet; run the operation that sets it first")
        }
        Some(other) => return err_response(&format!("url is not a string: {}", other)),
    };
    if url.is_empty() {
        return err_response("url is empty; paste a YouTube video link first");
    }
    match parse_link(&url) {
        Some((id, start)) => {
            let embed = if start > 0 {
                format!("https://www.youtube-nocookie.com/embed/{}?start={}", id, start)
            } else {
                format!("https://www.youtube-nocookie.com/embed/{}", id)
            };
            ok_response(json!({
                "videoId": id,
                "embedUrl": embed,
                "watchUrl": format!("https://www.youtube.com/watch?v={}", id),
                "thumbnailUrl": format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", id),
                "startSeconds": start,
            }))
        }
        None => err_response(&format!(
            "not a YouTube link: {} (paste a video link like https://www.youtube.com/watch?v=... or https://youtu.be/...)",
            url
        )),
    }
}

fn is_video_id(text: &str) -> bool {
    text.len() == 11
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Returns (video id, start seconds) for every accepted link form.
fn parse_link(raw: &str) -> Option<(String, i64)> {
    let text = raw.trim();
    if is_video_id(text) {
        return Some((text.to_string(), 0));
    }

    let rest = text
        .strip_prefix("https://")
        .or_else(|| text.strip_prefix("http://"))
        .unwrap_or(text);
    // Fragments can carry a timestamp (#t=90); split them off but keep them
    // for the time lookup below.
    let (rest, fragment) = match rest.split_once('#') {
        Some((head, frag)) => (head, Some(frag)),
        None => (rest, None),
    };
    let (location, query) = match rest.split_once('?') {
        Some((head, query)) => (head, Some(query)),
        None => (rest, None),
    };
    let (host, path) = match location.split_once('/') {
        Some((host, path)) => (host, path),
        None => (location, ""),
    };
    let host = host
        .strip_prefix("www.")
        .or_else(|| host.strip_prefix("m."))
        .or_else(|| host.strip_prefix("music."))
        .unwrap_or(host)
        .to_ascii_lowercase();

    let id = match host.as_str() {
        "youtu.be" => first_segment(path).filter(|seg| is_video_id(seg)),
        "youtube.com" | "youtube-nocookie.com" => {
            let mut segments = path.split('/').filter(|seg| !seg.is_empty());
            match segments.next() {
                Some("watch") => query.and_then(|q| query_param(q, "v")).filter(|v| is_video_id(v)),
                Some("shorts") | Some("live") | Some("embed") | Some("v") => {
                    segments.next().map(str::to_string).filter(|seg| is_video_id(seg))
                }
                _ => None,
            }
        }
        _ => None,
    }?;

    let start = query
        .and_then(|q| query_param(q, "t").or_else(|| query_param(q, "start")))
        .or_else(|| fragment.and_then(|f| query_param(f, "t").or_else(|| query_param(f, "start"))))
        .and_then(|value| parse_time(&value))
        .unwrap_or(0);

    Some((id, start))
}

fn first_segment(path: &str) -> Option<String> {
    path.split('/').find(|seg| !seg.is_empty()).map(str::to_string)
}

fn query_param(query: &str, name: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        (key == name && !value.is_empty()).then(|| value.to_string())
    })
}

/// Accepts plain seconds ("90", "90s") and h/m/s forms ("1h2m3s", "2m10s").
fn parse_time(text: &str) -> Option<i64> {
    let cleaned = text.trim();
    if cleaned.is_empty() {
        return None;
    }
    if cleaned.bytes().all(|b| b.is_ascii_digit()) {
        return cleaned.parse().ok();
    }
    let mut total: i64 = 0;
    let mut number: i64 = 0;
    let mut has_digits = false;
    for ch in cleaned.chars() {
        match ch {
            '0'..='9' => {
                number = number.checked_mul(10)?.checked_add(ch as i64 - '0' as i64)?;
                has_digits = true;
            }
            'h' | 'H' => {
                if !has_digits {
                    return None;
                }
                total = total.checked_add(number.checked_mul(3600)?)?;
                number = 0;
                has_digits = false;
            }
            'm' | 'M' => {
                if !has_digits {
                    return None;
                }
                total = total.checked_add(number.checked_mul(60)?)?;
                number = 0;
                has_digits = false;
            }
            's' | 'S' => {
                if !has_digits {
                    return None;
                }
                total = total.checked_add(number)?;
                number = 0;
                has_digits = false;
            }
            _ => return None,
        }
    }
    if has_digits {
        total = total.checked_add(number)?;
    }
    Some(total)
}

fn read_request(ptr: i32, len: i32) -> Option<&'static [u8]> {
    if ptr <= 0 || len <= 0 {
        return None;
    }
    Some(unsafe { std::slice::from_raw_parts(ptr as u32 as *const u8, len as usize) })
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

#[cfg(test)]
mod tests {
    use super::{parse_link, parse_time};

    #[test]
    fn parses_every_link_form() {
        let id = "dQw4w9WgXcQ";
        for url in [
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "http://youtube.com/watch?feature=share&v=dQw4w9WgXcQ",
            "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RD123",
            "https://youtu.be/dQw4w9WgXcQ",
            "youtu.be/dQw4w9WgXcQ",
            "https://www.youtube.com/shorts/dQw4w9WgXcQ",
            "https://www.youtube.com/live/dQw4w9WgXcQ",
            "https://www.youtube.com/embed/dQw4w9WgXcQ",
            "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
            "https://www.youtube.com/v/dQw4w9WgXcQ",
            "dQw4w9WgXcQ",
        ] {
            assert_eq!(parse_link(url), Some((id.to_string(), 0)), "{}", url);
        }
    }

    #[test]
    fn reads_timestamps() {
        assert_eq!(
            parse_link("https://youtu.be/dQw4w9WgXcQ?t=43"),
            Some(("dQw4w9WgXcQ".into(), 43))
        );
        assert_eq!(
            parse_link("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1h2m3s"),
            Some(("dQw4w9WgXcQ".into(), 3723))
        );
        assert_eq!(
            parse_link("https://www.youtube.com/watch?v=dQw4w9WgXcQ#t=90"),
            Some(("dQw4w9WgXcQ".into(), 90))
        );
        assert_eq!(parse_time("2m10s"), Some(130));
        assert_eq!(parse_time("90s"), Some(90));
        assert_eq!(parse_time("bogus"), None);
    }

    #[test]
    fn rejects_everything_else() {
        for url in [
            "https://example.com/watch?v=dQw4w9WgXcQ",
            "https://www.youtube.com/playlist?list=PL123",
            "https://www.youtube.com/watch?v=short",
            "https://vimeo.com/12345",
            "not a link",
            "",
        ] {
            assert_eq!(parse_link(url), None, "{}", url);
        }
    }
}
