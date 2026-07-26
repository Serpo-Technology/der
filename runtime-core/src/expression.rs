//! Row-expression parser and evaluator, the Rust twin of
//! src/services/operations/row-expression.ts: the same grammar as the expr
//! compute part (+ - * / % ^, parentheses, unary minus, one-argument
//! sqrt/abs/floor/ceil/round, two-argument min/max/pow, pi and e), the same
//! caps, and the same field semantics (case-insensitive names, numeric
//! strings parse, anything else is an error).

use serde_json::{Map, Value};

const MAX_EXPRESSION_CHARS: usize = 4096;
const MAX_DEPTH: u32 = 64;

#[derive(Debug, Clone)]
enum Node {
    Number(f64),
    Constant(f64),
    Ident(String),
    Unary(Box<Node>),
    Binary(char, Box<Node>, Box<Node>),
    Call(String, Vec<Node>),
}

pub struct ParsedExpression {
    root: Node,
    pub identifiers: Vec<String>,
}

struct Parser<'a> {
    chars: Vec<char>,
    pos: usize,
    depth: u32,
    identifiers: Vec<String>,
    source: &'a str,
}

fn constant(name: &str) -> Option<f64> {
    match name {
        "pi" => Some(std::f64::consts::PI),
        "e" => Some(std::f64::consts::E),
        _ => None,
    }
}

fn one_arg(name: &str) -> bool {
    matches!(name, "sqrt" | "abs" | "floor" | "ceil" | "round")
}

fn two_arg(name: &str) -> bool {
    matches!(name, "min" | "max" | "pow")
}

impl<'a> Parser<'a> {
    fn new(source: &'a str) -> Self {
        Self {
            chars: source.chars().collect(),
            pos: 0,
            depth: 0,
            identifiers: Vec::new(),
            source,
        }
    }

    fn parse(mut self) -> Result<(Node, Vec<String>), String> {
        let node = self.expr()?;
        self.skip_ws();
        if self.pos < self.chars.len() {
            return Err(format!("unexpected character '{}'", self.chars[self.pos]));
        }
        let _ = self.source;
        Ok((node, self.identifiers))
    }

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

    fn peek(&self) -> Option<char> {
        self.chars.get(self.pos).copied()
    }

    fn skip_ws(&mut self) {
        while matches!(self.peek(), Some(c) if c.is_whitespace()) {
            self.pos += 1;
        }
    }

    fn expr(&mut self) -> Result<Node, String> {
        let mut node = self.term()?;
        loop {
            self.skip_ws();
            match self.peek() {
                Some(op @ ('+' | '-')) => {
                    self.pos += 1;
                    node = Node::Binary(op, Box::new(node), Box::new(self.term()?));
                }
                _ => return Ok(node),
            }
        }
    }

    fn term(&mut self) -> Result<Node, String> {
        let mut node = self.power()?;
        loop {
            self.skip_ws();
            match self.peek() {
                Some(op @ ('*' | '/' | '%')) => {
                    self.pos += 1;
                    node = Node::Binary(op, Box::new(node), Box::new(self.power()?));
                }
                _ => return Ok(node),
            }
        }
    }

    fn power(&mut self) -> Result<Node, String> {
        self.enter()?;
        let base = self.unary()?;
        self.skip_ws();
        let node = if self.peek() == Some('^') {
            self.pos += 1;
            Node::Binary('^', Box::new(base), Box::new(self.power()?))
        } else {
            base
        };
        self.leave();
        Ok(node)
    }

    fn unary(&mut self) -> Result<Node, String> {
        self.enter()?;
        self.skip_ws();
        let node = if self.peek() == Some('-') {
            self.pos += 1;
            Node::Unary(Box::new(self.unary()?))
        } else {
            self.primary()?
        };
        self.leave();
        Ok(node)
    }

    fn primary(&mut self) -> Result<Node, String> {
        self.skip_ws();
        match self.peek() {
            Some('(') => {
                self.pos += 1;
                let node = self.expr()?;
                self.skip_ws();
                if self.peek() != Some(')') {
                    return Err("missing closing parenthesis".to_string());
                }
                self.pos += 1;
                Ok(node)
            }
            Some(c) if c.is_ascii_digit() || c == '.' => self.number(),
            Some(c) if c.is_ascii_alphabetic() => self.identifier(),
            Some(c) => Err(format!("unexpected character '{}'", c)),
            None => Err("unexpected end of expression".to_string()),
        }
    }

    fn number(&mut self) -> Result<Node, String> {
        let start = self.pos;
        let mut seen_dot = false;
        while let Some(c) = self.peek() {
            if c.is_ascii_digit() {
                self.pos += 1;
            } else if c == '.' && !seen_dot {
                seen_dot = true;
                self.pos += 1;
            } else {
                break;
            }
        }
        let text: String = self.chars[start..self.pos].iter().collect();
        text.parse::<f64>()
            .ok()
            .filter(|v| v.is_finite())
            .map(Node::Number)
            .ok_or_else(|| format!("invalid number '{}'", text))
    }

    fn identifier(&mut self) -> Result<Node, String> {
        let start = self.pos;
        while matches!(self.peek(), Some(c) if c.is_ascii_alphanumeric() || c == '_') {
            self.pos += 1;
        }
        let name: String = self.chars[start..self.pos]
            .iter()
            .collect::<String>()
            .to_ascii_lowercase();
        self.skip_ws();
        if self.peek() == Some('(') {
            self.pos += 1;
            let mut args = vec![self.expr()?];
            loop {
                self.skip_ws();
                match self.peek() {
                    Some(',') => {
                        self.pos += 1;
                        args.push(self.expr()?);
                    }
                    Some(')') => {
                        self.pos += 1;
                        break;
                    }
                    _ => return Err(format!("unterminated call to {}", name)),
                }
            }
            if one_arg(&name) {
                if args.len() != 1 {
                    return Err(format!("{} takes one argument", name));
                }
            } else if two_arg(&name) {
                if args.len() != 2 {
                    return Err(format!("{} takes two arguments", name));
                }
            } else {
                return Err(format!("unknown function '{}'", name));
            }
            return Ok(Node::Call(name, args));
        }
        if let Some(value) = constant(&name) {
            return Ok(Node::Constant(value));
        }
        if !self.identifiers.contains(&name) {
            self.identifiers.push(name.clone());
        }
        Ok(Node::Ident(name))
    }
}

/// Field names match case-insensitively; numbers and numeric strings are the
/// only accepted shapes, exactly like the TypeScript kernel.
fn numeric_field(row: &Map<String, Value>, name: &str) -> Result<f64, String> {
    let raw = row.get(name).or_else(|| {
        row.iter()
            .find(|(key, _)| key.to_ascii_lowercase() == name)
            .map(|(_, value)| value)
    });
    match raw {
        Some(Value::Number(n)) => {
            let f = n.as_f64().unwrap_or(f64::NAN);
            if f.is_finite() {
                return Ok(f);
            }
        }
        Some(Value::String(s)) => {
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                if let Ok(parsed) = trimmed.parse::<f64>() {
                    if parsed.is_finite() {
                        return Ok(parsed);
                    }
                }
            }
        }
        _ => {}
    }
    Err(format!("row has no numeric \"{}\"", name))
}

fn evaluate_node(node: &Node, row: &Map<String, Value>) -> Result<f64, String> {
    match node {
        Node::Number(v) | Node::Constant(v) => Ok(*v),
        Node::Ident(name) => numeric_field(row, name),
        Node::Unary(operand) => Ok(-evaluate_node(operand, row)?),
        Node::Call(name, args) => {
            let values: Result<Vec<f64>, String> =
                args.iter().map(|arg| evaluate_node(arg, row)).collect();
            let values = values?;
            match name.as_str() {
                "sqrt" => {
                    if values[0] < 0.0 {
                        Err("sqrt of a negative number".to_string())
                    } else {
                        Ok(values[0].sqrt())
                    }
                }
                "abs" => Ok(values[0].abs()),
                "floor" => Ok(values[0].floor()),
                "ceil" => Ok(values[0].ceil()),
                "round" => Ok(crate::value::js_math_round(values[0])),
                "min" => Ok(values[0].min(values[1])),
                "max" => Ok(values[0].max(values[1])),
                "pow" => Ok(values[0].powf(values[1])),
                other => Err(format!("unknown function '{}'", other)),
            }
        }
        Node::Binary(op, left, right) => {
            let l = evaluate_node(left, row)?;
            let r = evaluate_node(right, row)?;
            match op {
                '+' => Ok(l + r),
                '-' => Ok(l - r),
                '*' => Ok(l * r),
                '/' => {
                    if r == 0.0 {
                        Err("division by zero".to_string())
                    } else {
                        Ok(l / r)
                    }
                }
                '%' => {
                    if r == 0.0 {
                        Err("division by zero".to_string())
                    } else {
                        Ok(l % r)
                    }
                }
                '^' => Ok(l.powf(r)),
                other => Err(format!("unknown operator '{}'", other)),
            }
        }
    }
}

impl ParsedExpression {
    pub fn evaluate(&self, row: &Map<String, Value>) -> Result<f64, String> {
        evaluate_node(&self.root, row)
    }
}

pub fn parse_row_expression(source: &str) -> Result<ParsedExpression, String> {
    if source.chars().count() > MAX_EXPRESSION_CHARS {
        return Err("expression is too long".to_string());
    }
    if source.trim().is_empty() {
        return Err("expression is empty".to_string());
    }
    let (root, identifiers) = Parser::new(source).parse()?;
    Ok(ParsedExpression { root, identifiers })
}
