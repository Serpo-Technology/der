//! Calendar-date arithmetic part for the DER wasm host, guest ABI v1.
//!
//! Exports `memory`, `der_alloc`, and `der_run` and imports nothing. The
//! host writes `{"operation": name, "inputs": object}` into guest memory;
//! the guest answers `{"ok": object}` or `{"err": message}` packed as
//! `(ptr << 32) | len`. Bad input always produces an `err` response.
//!
//! Dates are ISO strings; only the leading `YYYY-MM-DD` is read, so full
//! timestamps work as inputs. The civil-calendar conversions are Howard
//! Hinnant's days_from_civil / civil_from_days algorithms.

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
        "date.diffDays" => diff_days(inputs),
        "date.addDays" => add_days(inputs),
        other => err_response(&format!("unknown operation {}", other)),
    }
}

fn diff_days(inputs: &Map<String, Value>) -> Vec<u8> {
    let from = match date_input(inputs, "from") {
        Ok(days) => days,
        Err(message) => return err_response(&message),
    };
    let to = match date_input(inputs, "to") {
        Ok(days) => days,
        Err(message) => return err_response(&message),
    };
    ok_response(json!({ "days": to - from }))
}

fn add_days(inputs: &Map<String, Value>) -> Vec<u8> {
    let date = match date_input(inputs, "date") {
        Ok(days) => days,
        Err(message) => return err_response(&message),
    };
    let days = match inputs.get("days") {
        Some(Value::Number(n)) => match n.as_f64() {
            Some(f) if f.fract() == 0.0 => f as i64,
            _ => return err_response("days must be a whole number"),
        },
        Some(Value::String(s)) => match s.trim().parse::<i64>() {
            Ok(n) => n,
            Err(_) => return err_response(&format!("days is not a whole number: {}", s)),
        },
        Some(Value::Null) | None => {
            return err_response("days has no value yet; run the operation that sets it first")
        }
        _ => return err_response("days must be a number"),
    };
    let (y, m, d) = civil_from_days(date + days);
    ok_response(json!({ "date": format!("{:04}-{:02}-{:02}", y, m, d) }))
}

/// Reads an input as a civil day count, with the messages tiered like expr:
/// missing/null means "not produced yet", present-but-bad names the value.
fn date_input(inputs: &Map<String, Value>, name: &str) -> Result<i64, String> {
    match inputs.get(name) {
        Some(Value::String(s)) => parse_date(s)
            .ok_or_else(|| format!("{} is not a date: {} (expected YYYY-MM-DD)", name, s)),
        Some(Value::Null) | None => Err(format!(
            "{} has no value yet; run the operation that sets it first",
            name
        )),
        Some(other) => Err(format!("{} is not a date string: {}", name, other)),
    }
}

/// Accepts `YYYY-MM-DD` optionally followed by a time suffix.
fn parse_date(text: &str) -> Option<i64> {
    let s = text.trim();
    let head: Vec<char> = s.chars().take(10).collect();
    if head.len() < 10 || head[4] != '-' || head[7] != '-' {
        return None;
    }
    if s.len() > 10 {
        let next = s.chars().nth(10)?;
        if next != 'T' && next != ' ' {
            return None;
        }
    }
    let year: i64 = s.get(0..4)?.parse().ok()?;
    let month: i64 = s.get(5..7)?.parse().ok()?;
    let day: i64 = s.get(8..10)?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=days_in_month(year, month)).contains(&day) {
        return None;
    }
    Some(days_from_civil(year, month, day))
}

fn is_leap(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap(year) => 29,
        2 => 28,
        _ => 0,
    }
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
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
    use super::{civil_from_days, days_from_civil, parse_date};

    #[test]
    fn civil_round_trips() {
        for (y, m, d) in [(1970, 1, 1), (2000, 2, 29), (2026, 7, 23), (1815, 12, 10)] {
            assert_eq!(civil_from_days(days_from_civil(y, m, d)), (y, m, d));
        }
        assert_eq!(days_from_civil(1970, 1, 1), 0);
    }

    #[test]
    fn parses_dates_and_timestamps() {
        assert_eq!(parse_date("2026-07-23"), Some(days_from_civil(2026, 7, 23)));
        assert_eq!(
            parse_date("2026-07-23T15:30:00Z"),
            Some(days_from_civil(2026, 7, 23))
        );
        assert_eq!(parse_date("2026-02-30"), None);
        assert_eq!(parse_date("not a date"), None);
        assert_eq!(parse_date("2026-07-2"), None);
    }

    #[test]
    fn diffs_span_leap_years() {
        let from = days_from_civil(2024, 2, 28);
        let to = days_from_civil(2024, 3, 1);
        assert_eq!(to - from, 2);
    }
}
