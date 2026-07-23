//! Arithmetic expression evaluator part for the DER wasm host, guest ABI v1.
//!
//! Exports `memory`, `der_alloc`, and `der_run` and imports nothing. The
//! host writes `{"operation": name, "inputs": object}` into guest memory;
//! the guest answers `{"ok": object}` or `{"err": message}` packed as
//! `(ptr << 32) | len`. Bad input always produces an `err` response.
//!
//! Grammar: numbers, + - * / % ^ (right-associative), unary minus,
//! parentheses, the functions sqrt/abs/floor/ceil/round and two-argument
//! min/max/pow, the constants pi and e, and caller-supplied variables
//! (the "var" input object; numeric strings coerce).

use std::alloc::{alloc, Layout};
use std::mem;

use serde_json::{json, Map, Value};

const MAX_EXPRESSION_BYTES: usize = 4096;
const MAX_DEPTH: u32 = 64;

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
        "expr.evaluate" => evaluate(inputs),
        other => err_response(&format!("unknown operation {}", other)),
    }
}

fn read_request(ptr: i32, len: i32) -> Option<&'static [u8]> {
    if ptr <= 0 || len <= 0 {
        return None;
    }
    Some(unsafe { std::slice::from_raw_parts(ptr as u32 as *const u8, len as usize) })
}

fn evaluate(inputs: &Map<String, Value>) -> Vec<u8> {
    let expression = match inputs.get("expression") {
        Some(Value::String(text)) => text.as_str(),
        Some(Value::Number(n)) => {
            // A bare number bound straight through is fine.
            return ok_response(json!({ "value": n }));
        }
        _ => return err_response("expression must be a string"),
    };
    let mut vars: Vec<(String, f64)> = Vec::new();
    if let Some(Value::Object(entries)) = inputs.get("var") {
        for (name, value) in entries {
            let number = match value {
                Value::Number(n) => n.as_f64(),
                Value::String(text) => text.trim().parse::<f64>().ok(),
                _ => None,
            };
            match number {
                Some(number) => vars.push((name.to_ascii_lowercase(), number)),
                None => {
                    return err_response(&format!("variable {} is not a number", name));
                }
            }
        }
    }
    match eval_with(expression, &vars) {
        Ok(value) => ok_response(json!({ "value": value })),
        Err(message) => err_response(&message),
    }
}

/// Evaluates an arithmetic expression with no variables.
pub fn eval(source: &str) -> Result<f64, String> {
    eval_with(source, &[])
}

/// Evaluates an arithmetic expression against named variables. Public so
/// native tests cover the parser without the wasm ABI in the way.
pub fn eval_with(source: &str, vars: &[(String, f64)]) -> Result<f64, String> {
    if source.len() > MAX_EXPRESSION_BYTES {
        return Err("expression is too long".to_string());
    }
    let mut parser = Parser {
        bytes: source.as_bytes(),
        pos: 0,
        depth: 0,
        vars,
    };
    parser.skip_ws();
    if parser.pos == parser.bytes.len() {
        return Err("expression is empty".to_string());
    }
    let value = parser.expr()?;
    parser.skip_ws();
    if parser.pos != parser.bytes.len() {
        return Err(format!(
            "unexpected character '{}'",
            parser.bytes[parser.pos] as char
        ));
    }
    if !value.is_finite() {
        return Err("result is not a finite number".to_string());
    }
    Ok(value)
}

struct Parser<'a> {
    bytes: &'a [u8],
    pos: usize,
    depth: u32,
    vars: &'a [(String, f64)],
}

impl<'a> Parser<'a> {
    fn enter(&mut self) -> Result<(), String> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err("expression is too deeply nested".to_string());
        }
        Ok(())
    }

    fn leave(&mut self) {
        self.depth -= 1;
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn skip_ws(&mut self) {
        while matches!(self.peek(), Some(b' ') | Some(b'\t') | Some(b'\n') | Some(b'\r')) {
            self.pos += 1;
        }
    }

    fn expr(&mut self) -> Result<f64, String> {
        self.enter()?;
        let mut value = self.term()?;
        loop {
            self.skip_ws();
            match self.peek() {
                Some(b'+') => {
                    self.pos += 1;
                    value += self.term()?;
                }
                Some(b'-') => {
                    self.pos += 1;
                    value -= self.term()?;
                }
                _ => break,
            }
        }
        self.leave();
        Ok(value)
    }

    fn term(&mut self) -> Result<f64, String> {
        let mut value = self.power()?;
        loop {
            self.skip_ws();
            match self.peek() {
                Some(b'*') => {
                    self.pos += 1;
                    value *= self.power()?;
                }
                Some(b'/') => {
                    self.pos += 1;
                    let divisor = self.power()?;
                    if divisor == 0.0 {
                        return Err("division by zero".to_string());
                    }
                    value /= divisor;
                }
                Some(b'%') => {
                    self.pos += 1;
                    let divisor = self.power()?;
                    if divisor == 0.0 {
                        return Err("division by zero".to_string());
                    }
                    value %= divisor;
                }
                _ => break,
            }
        }
        Ok(value)
    }

    fn power(&mut self) -> Result<f64, String> {
        self.enter()?;
        let base = self.unary()?;
        self.skip_ws();
        let value = if self.peek() == Some(b'^') {
            self.pos += 1;
            let exponent = self.power()?;
            base.powf(exponent)
        } else {
            base
        };
        self.leave();
        Ok(value)
    }

    fn unary(&mut self) -> Result<f64, String> {
        self.enter()?;
        self.skip_ws();
        let value = if self.peek() == Some(b'-') {
            self.pos += 1;
            -self.unary()?
        } else {
            self.primary()?
        };
        self.leave();
        Ok(value)
    }

    fn primary(&mut self) -> Result<f64, String> {
        self.skip_ws();
        match self.peek() {
            Some(b'(') => {
                self.pos += 1;
                let value = self.expr()?;
                self.skip_ws();
                if self.peek() != Some(b'(').map(|_| b')').or(Some(b')')) {
                    // placeholder never taken; real check below
                }
                if self.peek() != Some(b')') {
                    return Err("missing closing parenthesis".to_string());
                }
                self.pos += 1;
                Ok(value)
            }
            Some(byte) if byte.is_ascii_digit() || byte == b'.' => self.number(),
            Some(byte) if byte.is_ascii_alphabetic() => self.identifier(),
            Some(byte) => Err(format!("unexpected character '{}'", byte as char)),
            None => Err("unexpected end of expression".to_string()),
        }
    }

    fn number(&mut self) -> Result<f64, String> {
        let start = self.pos;
        let mut seen_dot = false;
        while let Some(byte) = self.peek() {
            if byte.is_ascii_digit() {
                self.pos += 1;
            } else if byte == b'.' && !seen_dot {
                seen_dot = true;
                self.pos += 1;
            } else {
                break;
            }
        }
        let text = std::str::from_utf8(&self.bytes[start..self.pos])
            .map_err(|_| "invalid number".to_string())?;
        text.parse::<f64>()
            .map_err(|_| format!("invalid number '{}'", text))
    }

    fn identifier(&mut self) -> Result<f64, String> {
        let start = self.pos;
        while matches!(self.peek(), Some(byte) if byte.is_ascii_alphanumeric() || byte == b'_') {
            self.pos += 1;
        }
        let name = std::str::from_utf8(&self.bytes[start..self.pos])
            .map_err(|_| "invalid identifier".to_string())?
            .to_ascii_lowercase();
        self.skip_ws();
        if self.peek() == Some(b'(') {
            self.pos += 1;
            let mut args = vec![self.expr()?];
            loop {
                self.skip_ws();
                match self.peek() {
                    Some(b',') => {
                        self.pos += 1;
                        args.push(self.expr()?);
                    }
                    Some(b')') => {
                        self.pos += 1;
                        break;
                    }
                    _ => return Err(format!("unterminated call to {}", name)),
                }
            }
            return apply_function(&name, &args);
        }
        if let Some((_, value)) = self.vars.iter().find(|(var, _)| var == &name) {
            return Ok(*value);
        }
        match name.as_str() {
            "pi" => Ok(std::f64::consts::PI),
            "e" => Ok(std::f64::consts::E),
            other => {
                let known = self
                    .vars
                    .iter()
                    .map(|(var, _)| var.as_str())
                    .collect::<Vec<_>>()
                    .join(", ");
                Err(if known.is_empty() {
                    format!("unknown name '{}'", other)
                } else {
                    format!("unknown name '{}'; variables: {}", other, known)
                })
            }
        }
    }
}

fn apply_function(name: &str, args: &[f64]) -> Result<f64, String> {
    let one = |args: &[f64]| -> Result<f64, String> {
        if args.len() != 1 {
            return Err(format!("{} takes one argument", name));
        }
        Ok(args[0])
    };
    let two = |args: &[f64]| -> Result<(f64, f64), String> {
        if args.len() != 2 {
            return Err(format!("{} takes two arguments", name));
        }
        Ok((args[0], args[1]))
    };
    match name {
        "sqrt" => {
            let x = one(args)?;
            if x < 0.0 {
                return Err("sqrt of a negative number".to_string());
            }
            Ok(x.sqrt())
        }
        "abs" => Ok(one(args)?.abs()),
        "floor" => Ok(one(args)?.floor()),
        "ceil" => Ok(one(args)?.ceil()),
        "round" => Ok(one(args)?.round()),
        "min" => {
            let (a, b) = two(args)?;
            Ok(a.min(b))
        }
        "max" => {
            let (a, b) = two(args)?;
            Ok(a.max(b))
        }
        "pow" => {
            let (a, b) = two(args)?;
            Ok(a.powf(b))
        }
        other => Err(format!("unknown function '{}'", other)),
    }
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
    use super::eval;

    #[test]
    fn precedence_and_grouping() {
        assert_eq!(eval("2+3*4").unwrap(), 14.0);
        assert_eq!(eval("(2+3)*4").unwrap(), 20.0);
        assert_eq!(eval("10%3").unwrap(), 1.0);
        assert_eq!(eval("2^10").unwrap(), 1024.0);
        assert_eq!(eval("2^3^2").unwrap(), 512.0);
        assert_eq!(eval("-3^2").unwrap(), 9.0);
        assert_eq!(eval("-(3^2)").unwrap(), -9.0);
        assert_eq!(eval(" 1.5 + 2.25 ").unwrap(), 3.75);
    }

    #[test]
    fn functions_and_constants() {
        assert_eq!(eval("sqrt(16)+2^3").unwrap(), 12.0);
        assert_eq!(eval("min(3, max(1, 2))").unwrap(), 2.0);
        assert_eq!(eval("round(2.5)").unwrap(), 3.0);
        assert_eq!(eval("abs(-4)*ceil(1.2)").unwrap(), 8.0);
        assert!((eval("pi").unwrap() - std::f64::consts::PI).abs() < 1e-12);
        assert_eq!(eval("pow(2, 8)").unwrap(), 256.0);
    }

    #[test]
    fn variables_resolve_case_insensitively() {
        let vars = vec![("w".to_string(), 70.0), ("h".to_string(), 1.75)];
        let bmi = super::eval_with("w / (h ^ 2)", &vars).unwrap();
        assert!((bmi - 22.857).abs() < 0.01);
        assert_eq!(super::eval_with("W + 1", &vars).unwrap(), 71.0);
        let err = super::eval_with("x + 1", &vars).unwrap_err();
        assert!(err.contains("variables: w, h"));
    }

    #[test]
    fn errors_are_messages_not_panics() {
        assert!(eval("2+").is_err());
        assert!(eval("1/0").is_err());
        assert!(eval("7 % 0").is_err());
        assert!(eval("sqrt(-1)").is_err());
        assert!(eval("nope(1)").is_err());
        assert!(eval("bogus").is_err());
        assert!(eval("2 $ 3").is_err());
        assert!(eval("min(1)").is_err());
        assert!(eval("(1+2").is_err());
        assert!(eval("").is_err());
        assert!(eval(&"(".repeat(100)).is_err());
        assert!(eval(&"1".repeat(5000)).is_err());
    }
}
