//! Structural validation of model responses: the Rust twin of the zod
//! schemas in src/schemas/contract.ts (LlmContractSchema and
//! ComposedResponseSchema), plus the JSON extraction and problem formatting
//! from llm-json.ts. Issue paths, message text, defaulted output shape, and
//! key order match the webview pipeline byte for byte, because problems feed
//! the repair round and accepted values flow into the checker; the compose
//! vectors freeze all of it.

use serde_json::{Map, Value};

/// Pulls the first balanced JSON object out of a model response, tolerating
/// code fences and surrounding prose.
pub fn extract_json(text: &str) -> Result<String, String> {
    let mut source = text.trim().to_string();
    let fence = regex::Regex::new(r"(?is)```(?:json)?\s*(.*?)```").expect("static regex");
    if let Some(captures) = fence.captures(&source) {
        source = captures.get(1).map(|m| m.as_str()).unwrap_or("").trim().to_string();
    }
    let Some(start) = source.find('{') else {
        return Err("No JSON object found in the response".to_string());
    };
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escaped = false;
    for (index, ch) in source[start..].char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
        } else if ch == '"' {
            in_string = true;
        } else if ch == '{' {
            depth += 1;
        } else if ch == '}' {
            depth -= 1;
            if depth == 0 {
                return Ok(source[start..start + index + ch.len_utf8()].to_string());
            }
        }
    }
    Err("Unbalanced JSON object in the response".to_string())
}

#[derive(Debug, Clone)]
pub struct Issue {
    pub path: Vec<String>,
    pub message: String,
}

impl Issue {
    fn at(path: &[String], message: String) -> Self {
        Self { path: path.to_vec(), message }
    }
    pub fn dotted_path(&self) -> String {
        if self.path.is_empty() {
            "(root)".to_string()
        } else {
            self.path.join(".")
        }
    }
}

fn received_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn type_issue(path: &[String], expected: &str, value: Option<&Value>) -> Issue {
    let received = value.map(received_name).unwrap_or("undefined");
    Issue::at(path, format!("Invalid input: expected {}, received {}", expected, received))
}

fn push_path(path: &[String], segment: impl Into<String>) -> Vec<String> {
    let mut next = path.to_vec();
    next.push(segment.into());
    next
}

struct Ctx {
    issues: Vec<Issue>,
}

fn string_field(
    value: Option<&Value>,
    min1: bool,
    path: &[String],
    ctx: &mut Ctx,
) -> Option<Value> {
    match value {
        Some(Value::String(text)) => {
            if min1 && text.is_empty() {
                ctx.issues.push(Issue::at(
                    path,
                    "Too small: expected string to have >=1 characters".to_string(),
                ));
            }
            Some(Value::String(text.clone()))
        }
        other => {
            ctx.issues.push(type_issue(path, "string", other));
            None
        }
    }
}

fn optional_string(
    value: Option<&Value>,
    min1: bool,
    path: &[String],
    ctx: &mut Ctx,
) -> Option<Value> {
    match value {
        None => None,
        some => string_field(some, min1, path, ctx),
    }
}

fn record_field(value: Option<&Value>, path: &[String], ctx: &mut Ctx) -> Option<Value> {
    match value {
        Some(Value::Object(map)) => Some(Value::Object(map.clone())),
        other => {
            ctx.issues.push(type_issue(path, "record", other));
            None
        }
    }
}

fn string_record_field(value: Option<&Value>, path: &[String], ctx: &mut Ctx) -> Option<Value> {
    match value {
        Some(Value::Object(map)) => {
            for (key, entry) in map {
                if !entry.is_string() {
                    ctx.issues
                        .push(type_issue(&push_path(path, key.clone()), "string", Some(entry)));
                }
            }
            Some(Value::Object(map.clone()))
        }
        other => {
            ctx.issues.push(type_issue(path, "record", other));
            None
        }
    }
}

fn enum_field(
    value: Option<&Value>,
    options: &[&str],
    path: &[String],
    ctx: &mut Ctx,
) -> Option<Value> {
    if let Some(Value::String(text)) = value {
        if options.contains(&text.as_str()) {
            return Some(Value::String(text.clone()));
        }
    }
    let message = if options.len() == 1 {
        format!("Invalid input: expected \"{}\"", options[0])
    } else {
        format!(
            "Invalid option: expected one of {}",
            options.iter().map(|o| format!("\"{}\"", o)).collect::<Vec<_>>().join("|")
        )
    };
    ctx.issues.push(Issue::at(path, message));
    None
}

fn string_array_field(value: Option<&Value>, path: &[String], ctx: &mut Ctx) -> Option<Value> {
    match value {
        Some(Value::Array(items)) => {
            let mut out = Vec::new();
            for (index, item) in items.iter().enumerate() {
                match item {
                    Value::String(text) => out.push(Value::String(text.clone())),
                    other => {
                        ctx.issues.push(type_issue(
                            &push_path(path, index.to_string()),
                            "string",
                            Some(other),
                        ));
                    }
                }
            }
            Some(Value::Array(out))
        }
        other => {
            ctx.issues.push(type_issue(path, "array", other));
            None
        }
    }
}

/// `new Date(value)` and toISOString, the shapes JS accepts for the
/// metadata stamps: RFC3339 forms, date-only strings, and epoch numbers.
fn coerce_date(value: Option<&Value>, path: &[String], ctx: &mut Ctx) -> Option<Value> {
    use chrono::{DateTime, NaiveDate, NaiveDateTime, TimeZone, Utc};
    let parsed: Option<DateTime<Utc>> = match value {
        Some(Value::String(text)) => DateTime::parse_from_rfc3339(text)
            .map(|dt| dt.with_timezone(&Utc))
            .ok()
            .or_else(|| {
                NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M:%S%.f")
                    .ok()
                    .map(|naive| Utc.from_utc_datetime(&naive))
            })
            .or_else(|| {
                NaiveDate::parse_from_str(text, "%Y-%m-%d")
                    .ok()
                    .and_then(|date| date.and_hms_opt(0, 0, 0))
                    .map(|naive| Utc.from_utc_datetime(&naive))
            }),
        Some(Value::Number(number)) => number
            .as_f64()
            .and_then(|ms| Utc.timestamp_millis_opt(ms as i64).single()),
        _ => None,
    };
    match parsed {
        Some(stamp) => Some(Value::String(
            stamp.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
        )),
        None => {
            ctx.issues.push(Issue::at(
                path,
                "Invalid input: expected date, received Date".to_string(),
            ));
            None
        }
    }
}

fn transform_function(value: &Value, path: &[String], ctx: &mut Ctx) -> Option<Value> {
    let Some(map) = value.as_object() else {
        ctx.issues.push(type_issue(path, "object", Some(value)));
        return None;
    };
    let mut out = Map::new();
    if let Some(kind) = string_field(map.get("type"), true, &push_path(path, "type"), ctx) {
        out.insert("type".to_string(), kind);
    }
    let parameters = match map.get("parameters") {
        None => Some(Value::Object(Map::new())),
        some => record_field(some, &push_path(path, "parameters"), ctx),
    };
    if let Some(parameters) = parameters {
        out.insert("parameters".to_string(), parameters);
    }
    Some(Value::Object(out))
}

fn transform_pipeline(value: &Value, path: &[String], ctx: &mut Ctx) -> Option<Value> {
    let Some(items) = value.as_array() else {
        ctx.issues.push(type_issue(path, "array", Some(value)));
        return None;
    };
    let mut out = Vec::new();
    for (index, item) in items.iter().enumerate() {
        if let Some(step) = transform_function(item, &push_path(path, index.to_string()), ctx) {
            out.push(step);
        }
    }
    Some(Value::Array(out))
}

/// Shared shape of data/input/output bindings: name/property + source or
/// target enums, sourceId/targetId, optional value and pipelines.
struct BindingSpec<'a> {
    first_key: &'a str,
    source_key: &'a str,
    source_options: &'a [&'a str],
    id_key: &'a str,
    id_min1: bool,
    has_value: bool,
    extra_optional_string: Option<&'a str>,
}

fn binding_object(
    value: &Value,
    spec: &BindingSpec,
    path: &[String],
    ctx: &mut Ctx,
) -> Option<Value> {
    let Some(map) = value.as_object() else {
        ctx.issues.push(type_issue(path, "object", Some(value)));
        return None;
    };
    let mut out = Map::new();
    if let Some(first) = string_field(map.get(spec.first_key), true, &push_path(path, spec.first_key), ctx)
    {
        out.insert(spec.first_key.to_string(), first);
    }
    if let Some(source) = enum_field(
        map.get(spec.source_key),
        spec.source_options,
        &push_path(path, spec.source_key),
        ctx,
    ) {
        out.insert(spec.source_key.to_string(), source);
    }
    if let Some(id) = string_field(map.get(spec.id_key), spec.id_min1, &push_path(path, spec.id_key), ctx)
    {
        out.insert(spec.id_key.to_string(), id);
    }
    if let Some(extra) = spec.extra_optional_string {
        if let Some(text) = optional_string(map.get(extra), false, &push_path(path, extra), ctx) {
            out.insert(extra.to_string(), text);
        }
    }
    if spec.has_value {
        if let Some(raw) = map.get("value") {
            out.insert("value".to_string(), raw.clone());
        }
    }
    if let Some(raw) = map.get("transform") {
        if let Some(step) = transform_function(raw, &push_path(path, "transform"), ctx) {
            out.insert("transform".to_string(), step);
        }
    }
    if let Some(raw) = map.get("transforms") {
        if let Some(steps) = transform_pipeline(raw, &push_path(path, "transforms"), ctx) {
            out.insert("transforms".to_string(), steps);
        }
    }
    Some(Value::Object(out))
}

fn event_binding(value: &Value, path: &[String], ctx: &mut Ctx) -> Option<Value> {
    let Some(map) = value.as_object() else {
        ctx.issues.push(type_issue(path, "object", Some(value)));
        return None;
    };
    let mut out = Map::new();
    if let Some(event) = string_field(map.get("event"), true, &push_path(path, "event"), ctx) {
        out.insert("event".to_string(), event);
    }
    if let Some(op) = string_field(map.get("operationId"), true, &push_path(path, "operationId"), ctx)
    {
        out.insert("operationId".to_string(), op);
    }
    if let Some(raw) = map.get("parameters") {
        if let Some(parameters) = record_field(Some(raw), &push_path(path, "parameters"), ctx) {
            out.insert("parameters".to_string(), parameters);
        }
    }
    Some(Value::Object(out))
}

const CONDITION_OPERATORS: [&str; 10] = [
    "truthy", "falsy", "empty", "notEmpty", "equals", "notEquals", "gt", "gte", "lt", "lte",
];

fn visibility_condition(value: &Value, path: &[String], ctx: &mut Ctx) -> Option<Value> {
    let Some(map) = value.as_object() else {
        ctx.issues.push(type_issue(path, "object", Some(value)));
        return None;
    };
    let mut out = Map::new();
    if let Some(source) = enum_field(map.get("source"), &["state", "item"], &push_path(path, "source"), ctx)
    {
        out.insert("source".to_string(), source);
    }
    if let Some(id) = string_field(map.get("sourceId"), true, &push_path(path, "sourceId"), ctx) {
        out.insert("sourceId".to_string(), id);
    }
    if let Some(operator) = enum_field(
        map.get("operator"),
        &CONDITION_OPERATORS,
        &push_path(path, "operator"),
        ctx,
    ) {
        out.insert("operator".to_string(), operator);
    }
    if let Some(raw) = map.get("value") {
        out.insert("value".to_string(), raw.clone());
    }
    if let Some(raw) = map.get("transforms") {
        if let Some(steps) = transform_pipeline(raw, &push_path(path, "transforms"), ctx) {
            out.insert("transforms".to_string(), steps);
        }
    }
    Some(Value::Object(out))
}

fn ui_element(value: &Value, path: &[String], ctx: &mut Ctx) -> Option<Value> {
    let Some(map) = value.as_object() else {
        ctx.issues.push(type_issue(path, "object", Some(value)));
        return None;
    };
    let mut out = Map::new();
    if let Some(id) = string_field(map.get("id"), true, &push_path(path, "id"), ctx) {
        out.insert("id".to_string(), id);
    }
    if let Some(kind) = string_field(map.get("type"), true, &push_path(path, "type"), ctx) {
        out.insert("type".to_string(), kind);
    }
    let properties = match map.get("properties") {
        None => Some(Value::Object(Map::new())),
        some => record_field(some, &push_path(path, "properties"), ctx),
    };
    if let Some(properties) = properties {
        out.insert("properties".to_string(), properties);
    }
    let data_bindings = match map.get("dataBindings") {
        None => Some(Value::Array(Vec::new())),
        Some(raw) if !raw.is_array() => {
            ctx.issues
                .push(type_issue(&push_path(path, "dataBindings"), "array", Some(raw)));
            None
        }
        Some(raw) => {
            let items = raw.as_array().expect("checked above");
            let mut collected = Vec::new();
            for (index, item) in items.iter().enumerate() {
                let binding_path = push_path(&push_path(path, "dataBindings"), index.to_string());
                if let Some(binding) = binding_object(
                    item,
                    &BindingSpec {
                        first_key: "property",
                        source_key: "source",
                        source_options: &["operation", "state", "constant", "item"],
                        id_key: "sourceId",
                        id_min1: false,
                        has_value: true,
                        extra_optional_string: None,
                    },
                    &binding_path,
                    ctx,
                ) {
                    collected.push(binding);
                }
            }
            Some(Value::Array(collected))
        }
    };
    if let Some(bindings) = data_bindings {
        out.insert("dataBindings".to_string(), bindings);
    }
    let event_bindings = match map.get("eventBindings") {
        None => Some(Value::Array(Vec::new())),
        Some(raw) if !raw.is_array() => {
            ctx.issues
                .push(type_issue(&push_path(path, "eventBindings"), "array", Some(raw)));
            None
        }
        Some(raw) => {
            let items = raw.as_array().expect("checked above");
            let mut collected = Vec::new();
            for (index, item) in items.iter().enumerate() {
                let binding_path = push_path(&push_path(path, "eventBindings"), index.to_string());
                if let Some(binding) = event_binding(item, &binding_path, ctx) {
                    collected.push(binding);
                }
            }
            Some(Value::Array(collected))
        }
    };
    if let Some(bindings) = event_bindings {
        out.insert("eventBindings".to_string(), bindings);
    }
    if let Some(raw) = map.get("visibleWhen") {
        // A union collapses its option failures into one opaque issue.
        let mut probe = Ctx { issues: Vec::new() };
        let gate_path = push_path(path, "visibleWhen");
        let resolved = match raw {
            Value::Array(items) => {
                let mut collected = Vec::new();
                let mut all_ok = true;
                for (index, item) in items.iter().enumerate() {
                    let before = probe.issues.len();
                    match visibility_condition(item, &push_path(&gate_path, index.to_string()), &mut probe)
                    {
                        Some(condition) if probe.issues.len() == before => collected.push(condition),
                        _ => {
                            all_ok = false;
                            break;
                        }
                    }
                }
                if all_ok { Some(Value::Array(collected)) } else { None }
            }
            other => {
                let before = probe.issues.len();
                match visibility_condition(other, &gate_path, &mut probe) {
                    Some(condition) if probe.issues.len() == before => Some(condition),
                    _ => None,
                }
            }
        };
        match resolved {
            Some(gate) => {
                out.insert("visibleWhen".to_string(), gate);
            }
            None => ctx.issues.push(Issue::at(&gate_path, "Invalid input".to_string())),
        }
    }
    if let Some(raw) = map.get("children") {
        let children_path = push_path(path, "children");
        let Some(items) = raw.as_array() else {
            ctx.issues.push(type_issue(&children_path, "array", Some(raw)));
            return Some(Value::Object(out));
        };
        let mut collected = Vec::new();
        for (index, item) in items.iter().enumerate() {
            if let Some(child) = ui_element(item, &push_path(&children_path, index.to_string()), ctx) {
                collected.push(child);
            }
        }
        out.insert("children".to_string(), Value::Array(collected));
    }
    Some(Value::Object(out))
}

fn llm_operation(value: &Value, path: &[String], ctx: &mut Ctx) -> Option<Value> {
    let Some(map) = value.as_object() else {
        ctx.issues.push(type_issue(path, "object", Some(value)));
        return None;
    };
    let mut out = Map::new();
    if let Some(id) = string_field(map.get("id"), true, &push_path(path, "id"), ctx) {
        out.insert("id".to_string(), id);
    }
    if let Some(name) = string_field(map.get("operationName"), true, &push_path(path, "operationName"), ctx)
    {
        out.insert("operationName".to_string(), name);
    }
    let inputs = match map.get("inputs") {
        None => Some(Value::Array(Vec::new())),
        Some(raw) if !raw.is_array() => {
            ctx.issues.push(type_issue(&push_path(path, "inputs"), "array", Some(raw)));
            None
        }
        Some(raw) => {
            let items = raw.as_array().expect("checked above");
            let mut collected = Vec::new();
            for (index, item) in items.iter().enumerate() {
                let input_path = push_path(&push_path(path, "inputs"), index.to_string());
                if let Some(binding) = binding_object(
                    item,
                    &BindingSpec {
                        first_key: "name",
                        source_key: "source",
                        source_options: &["ui-element", "state", "constant", "item"],
                        id_key: "sourceId",
                        id_min1: false,
                        has_value: true,
                        extra_optional_string: None,
                    },
                    &input_path,
                    ctx,
                ) {
                    collected.push(binding);
                }
            }
            Some(Value::Array(collected))
        }
    };
    if let Some(inputs) = inputs {
        out.insert("inputs".to_string(), inputs);
    }
    let outputs = match map.get("outputs") {
        None => Some(Value::Array(Vec::new())),
        Some(raw) if !raw.is_array() => {
            ctx.issues.push(type_issue(&push_path(path, "outputs"), "array", Some(raw)));
            None
        }
        Some(raw) => {
            let items = raw.as_array().expect("checked above");
            let mut collected = Vec::new();
            for (index, item) in items.iter().enumerate() {
                let output_path = push_path(&push_path(path, "outputs"), index.to_string());
                if let Some(binding) = binding_object(
                    item,
                    &BindingSpec {
                        first_key: "name",
                        source_key: "target",
                        source_options: &["ui-element", "state"],
                        id_key: "targetId",
                        id_min1: true,
                        has_value: false,
                        extra_optional_string: Some("property"),
                    },
                    &output_path,
                    ctx,
                ) {
                    collected.push(binding);
                }
            }
            Some(Value::Array(collected))
        }
    };
    if let Some(outputs) = outputs {
        out.insert("outputs".to_string(), outputs);
    }
    let triggers = match map.get("triggers") {
        None => Value::Array(Vec::new()),
        Some(Value::Array(items)) => Value::Array(items.clone()),
        Some(other) => {
            ctx.issues.push(type_issue(&push_path(path, "triggers"), "array", Some(other)));
            Value::Array(Vec::new())
        }
    };
    out.insert("triggers".to_string(), triggers);
    if map.get("executionType").is_some() {
        if let Some(kind) = enum_field(
            map.get("executionType"),
            &["builtin", "remote"],
            &push_path(path, "executionType"),
            ctx,
        ) {
            out.insert("executionType".to_string(), kind);
        }
    }
    if let Some(raw) = map.get("implementation") {
        let imp_path = push_path(path, "implementation");
        let Some(imp) = raw.as_object() else {
            ctx.issues.push(type_issue(&imp_path, "object", Some(raw)));
            return Some(Value::Object(out));
        };
        let mut imp_out = Map::new();
        if let Some(kind) = enum_field(imp.get("type"), &["remote"], &push_path(&imp_path, "type"), ctx)
        {
            imp_out.insert("type".to_string(), kind);
        }
        if let Some(endpoint) = string_field(imp.get("endpoint"), false, &push_path(&imp_path, "endpoint"), ctx)
        {
            imp_out.insert("endpoint".to_string(), endpoint);
        }
        if let Some(method) = optional_string(imp.get("method"), false, &push_path(&imp_path, "method"), ctx)
        {
            imp_out.insert("method".to_string(), method);
        }
        if let Some(raw_headers) = imp.get("headers") {
            if let Some(headers) =
                string_record_field(Some(raw_headers), &push_path(&imp_path, "headers"), ctx)
            {
                imp_out.insert("headers".to_string(), headers);
            }
        }
        if let Some(auth) = optional_string(imp.get("auth"), false, &push_path(&imp_path, "auth"), ctx) {
            imp_out.insert("auth".to_string(), auth);
        }
        // The strict shape: any other key is unrecognized.
        const KNOWN: [&str; 5] = ["type", "endpoint", "method", "headers", "auth"];
        let unknown: Vec<&String> = imp.keys().filter(|key| !KNOWN.contains(&key.as_str())).collect();
        if !unknown.is_empty() {
            let listed = unknown
                .iter()
                .map(|key| format!("\"{}\"", key))
                .collect::<Vec<_>>()
                .join(", ");
            let label = if unknown.len() == 1 { "Unrecognized key" } else { "Unrecognized keys" };
            ctx.issues
                .push(Issue::at(&imp_path, format!("{}: {}", label, listed)));
        }
        out.insert("implementation".to_string(), Value::Object(imp_out));
    }
    Some(Value::Object(out))
}

fn contract_metadata(value: &Value, path: &[String], ctx: &mut Ctx) -> Option<Value> {
    let Some(map) = value.as_object() else {
        ctx.issues.push(type_issue(path, "object", Some(value)));
        return None;
    };
    let mut out = Map::new();
    if let Some(created) = coerce_date(map.get("createdAt"), &push_path(path, "createdAt"), ctx) {
        out.insert("createdAt".to_string(), created);
    }
    if let Some(updated) = coerce_date(map.get("updatedAt"), &push_path(path, "updatedAt"), ctx) {
        out.insert("updatedAt".to_string(), updated);
    }
    let version = match map.get("version") {
        None => Some(Value::String("1.0.0".to_string())),
        some => string_field(some, false, &push_path(path, "version"), ctx),
    };
    if let Some(version) = version {
        out.insert("version".to_string(), version);
    }
    if let Some(author) = optional_string(map.get("author"), false, &push_path(path, "author"), ctx) {
        out.insert("author".to_string(), author);
    }
    if let Some(description) =
        optional_string(map.get("description"), false, &push_path(path, "description"), ctx)
    {
        out.insert("description".to_string(), description);
    }
    if let Some(raw) = map.get("tags") {
        if let Some(tags) = string_array_field(Some(raw), &push_path(path, "tags"), ctx) {
            out.insert("tags".to_string(), tags);
        }
    }
    Some(Value::Object(out))
}

/// LlmContractSchema: the model's contract vocabulary, defaults filled.
pub fn validate_llm_contract(value: &Value) -> Result<Value, Vec<Issue>> {
    let mut ctx = Ctx { issues: Vec::new() };
    let out = llm_contract(value, &[], &mut ctx);
    match out {
        Some(contract) if ctx.issues.is_empty() => Ok(contract),
        _ => Err(ctx.issues),
    }
}

fn llm_contract(value: &Value, path: &[String], ctx: &mut Ctx) -> Option<Value> {
    let Some(map) = value.as_object() else {
        ctx.issues.push(type_issue(path, "object", Some(value)));
        return None;
    };
    let mut out = Map::new();
    if let Some(name) = string_field(map.get("name"), true, &push_path(path, "name"), ctx) {
        out.insert("name".to_string(), name);
    }
    let version = match map.get("version") {
        None => Some(Value::String("1.0.0".to_string())),
        some => string_field(some, false, &push_path(path, "version"), ctx),
    };
    if let Some(version) = version {
        out.insert("version".to_string(), version);
    }
    if let Some(raw) = map.get("initialState") {
        if let Some(initial) = record_field(Some(raw), &push_path(path, "initialState"), ctx) {
            out.insert("initialState".to_string(), initial);
        }
    }
    let elements_path = push_path(path, "elements");
    match map.get("elements") {
        Some(Value::Array(items)) => {
            if items.is_empty() {
                ctx.issues.push(Issue::at(
                    &elements_path,
                    "Too small: expected array to have >=1 items".to_string(),
                ));
            }
            let mut collected = Vec::new();
            for (index, item) in items.iter().enumerate() {
                if let Some(element) =
                    ui_element(item, &push_path(&elements_path, index.to_string()), ctx)
                {
                    collected.push(element);
                }
            }
            out.insert("elements".to_string(), Value::Array(collected));
        }
        other => {
            ctx.issues.push(type_issue(&elements_path, "array", other));
        }
    }
    let operations_path = push_path(path, "operations");
    match map.get("operations") {
        None => {
            out.insert("operations".to_string(), Value::Array(Vec::new()));
        }
        Some(Value::Array(items)) => {
            let mut collected = Vec::new();
            for (index, item) in items.iter().enumerate() {
                if let Some(op) =
                    llm_operation(item, &push_path(&operations_path, index.to_string()), ctx)
                {
                    collected.push(op);
                }
            }
            out.insert("operations".to_string(), Value::Array(collected));
        }
        Some(other) => {
            ctx.issues.push(type_issue(&operations_path, "array", Some(other)));
        }
    }
    let layout = match map.get("layout") {
        None => {
            let mut layout = Map::new();
            layout.insert("type".to_string(), Value::String("flex".to_string()));
            layout.insert("properties".to_string(), Value::Object(Map::new()));
            Some(Value::Object(layout))
        }
        Some(raw) if !raw.is_object() => {
            ctx.issues.push(type_issue(&push_path(path, "layout"), "object", Some(raw)));
            None
        }
        Some(raw) => {
            let layout_path = push_path(path, "layout");
            let layout_map = raw.as_object().expect("checked above");
            let mut layout_out = Map::new();
            let kind = match layout_map.get("type") {
                None => Some(Value::String("flex".to_string())),
                some => enum_field(some, &["grid", "flex", "absolute"], &push_path(&layout_path, "type"), ctx),
            };
            if let Some(kind) = kind {
                layout_out.insert("type".to_string(), kind);
            }
            let properties = match layout_map.get("properties") {
                None => Some(Value::Object(Map::new())),
                some => record_field(some, &push_path(&layout_path, "properties"), ctx),
            };
            if let Some(properties) = properties {
                layout_out.insert("properties".to_string(), properties);
            }
            Some(Value::Object(layout_out))
        }
    };
    if let Some(layout) = layout {
        out.insert("layout".to_string(), layout);
    }
    let styling = match map.get("styling") {
        None => {
            let mut styling = Map::new();
            styling.insert("theme".to_string(), Value::String("default".to_string()));
            Some(Value::Object(styling))
        }
        Some(raw) if !raw.is_object() => {
            ctx.issues.push(type_issue(&push_path(path, "styling"), "object", Some(raw)));
            None
        }
        Some(raw) => {
            let styling_path = push_path(path, "styling");
            let styling_map = raw.as_object().expect("checked above");
            let mut styling_out = Map::new();
            let theme = match styling_map.get("theme") {
                None => Some(Value::String("default".to_string())),
                some => string_field(some, false, &push_path(&styling_path, "theme"), ctx),
            };
            if let Some(theme) = theme {
                styling_out.insert("theme".to_string(), theme);
            }
            if let Some(accent) =
                optional_string(styling_map.get("accent"), false, &push_path(&styling_path, "accent"), ctx)
            {
                styling_out.insert("accent".to_string(), accent);
            }
            if let Some(raw_styles) = styling_map.get("customStyles") {
                if let Some(styles) =
                    record_field(Some(raw_styles), &push_path(&styling_path, "customStyles"), ctx)
                {
                    styling_out.insert("customStyles".to_string(), styles);
                }
            }
            Some(Value::Object(styling_out))
        }
    };
    if let Some(styling) = styling {
        out.insert("styling".to_string(), styling);
    }
    if let Some(raw) = map.get("metadata") {
        if let Some(metadata) = contract_metadata(raw, &push_path(path, "metadata"), ctx) {
            out.insert("metadata".to_string(), metadata);
        }
    }
    Some(Value::Object(out))
}

const COMPOSED_REFINE_MESSAGE: &str =
    "Respond with exactly one of \"contract\" (a composed app) or \"recipe\" (an installed app name)";

/// ComposedResponseSchema: the create-mode response, spec header plus exactly
/// one of contract or recipe.
pub fn validate_composed_response(value: &Value) -> Result<Value, Vec<Issue>> {
    let mut ctx = Ctx { issues: Vec::new() };
    let Some(map) = value.as_object() else {
        return Err(vec![type_issue(&[], "object", Some(value))]);
    };
    let mut out = Map::new();
    let spec = match map.get("spec") {
        None => {
            let mut spec = Map::new();
            spec.insert("goal".to_string(), Value::String(String::new()));
            spec.insert("assumptions".to_string(), Value::Array(Vec::new()));
            spec.insert("openQuestions".to_string(), Value::Array(Vec::new()));
            Some(Value::Object(spec))
        }
        Some(raw) if !raw.is_object() => {
            ctx.issues
                .push(type_issue(&["spec".to_string()], "object", Some(raw)));
            None
        }
        Some(raw) => {
            let spec_path = vec!["spec".to_string()];
            let spec_map = raw.as_object().expect("checked above");
            let mut spec_out = Map::new();
            let goal = match spec_map.get("goal") {
                None => Some(Value::String(String::new())),
                some => string_field(some, false, &push_path(&spec_path, "goal"), &mut ctx),
            };
            if let Some(goal) = goal {
                spec_out.insert("goal".to_string(), goal);
            }
            let assumptions = match spec_map.get("assumptions") {
                None => Some(Value::Array(Vec::new())),
                some => string_array_field(some, &push_path(&spec_path, "assumptions"), &mut ctx),
            };
            if let Some(assumptions) = assumptions {
                spec_out.insert("assumptions".to_string(), assumptions);
            }
            let questions = match spec_map.get("openQuestions") {
                None => Some(Value::Array(Vec::new())),
                some => string_array_field(some, &push_path(&spec_path, "openQuestions"), &mut ctx),
            };
            if let Some(questions) = questions {
                spec_out.insert("openQuestions".to_string(), questions);
            }
            Some(Value::Object(spec_out))
        }
    };
    if let Some(spec) = spec {
        out.insert("spec".to_string(), spec);
    }
    let has_contract = map.get("contract").is_some();
    if let Some(raw) = map.get("contract") {
        if let Some(contract) = llm_contract(raw, &["contract".to_string()], &mut ctx) {
            out.insert("contract".to_string(), contract);
        }
    }
    let has_recipe = map.get("recipe").is_some();
    if has_recipe {
        if let Some(recipe) =
            string_field(map.get("recipe"), true, &["recipe".to_string()], &mut ctx)
        {
            out.insert("recipe".to_string(), recipe);
        }
    }
    // Refinements run only when the base object parses.
    if ctx.issues.is_empty() && has_contract == has_recipe {
        ctx.issues.push(Issue { path: Vec::new(), message: COMPOSED_REFINE_MESSAGE.to_string() });
    }
    if ctx.issues.is_empty() {
        Ok(Value::Object(out))
    } else {
        Err(ctx.issues)
    }
}

/// Compact JSON of the object containing an issue path, so repair messages
/// point at the fragment instead of only a dotted path.
fn snippet_near(candidate: &Value, path: &[String]) -> Option<String> {
    let container = &path[..path.len().saturating_sub(1)];
    let mut current = candidate;
    for segment in container {
        current = match current {
            Value::Object(map) => map.get(segment)?,
            Value::Array(items) => items.get(segment.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    let text = serde_json::to_string(current).ok()?;
    if text.is_empty() {
        return None;
    }
    Some(if text.chars().count() > 200 {
        let cut: String = text.chars().take(200).collect();
        format!("{}...", cut)
    } else {
        text
    })
}

pub enum SchemaKind {
    Composed,
    Contract,
}

pub enum ParseVerdict {
    Ok(Value),
    Problem(String),
}

/// The response-acceptance stage: extract, parse, validate structurally,
/// then semantically. The semantic check may mutate the value in place;
/// mutations survive only when no problems remain.
pub fn parse_validated_json(
    raw: &str,
    schema: &SchemaKind,
    semantic: &mut dyn FnMut(&mut Value) -> Vec<String>,
) -> ParseVerdict {
    let extracted = match extract_json(raw) {
        Ok(text) => text,
        Err(error) => {
            return ParseVerdict::Problem(format!("The response was not parseable JSON: {}", error));
        }
    };
    let candidate: Value = match serde_json::from_str(&extracted) {
        Ok(value) => value,
        Err(error) => {
            return ParseVerdict::Problem(format!("The response was not parseable JSON: {}", error));
        }
    };
    let validated = match schema {
        SchemaKind::Composed => validate_composed_response(&candidate),
        SchemaKind::Contract => validate_llm_contract(&candidate),
    };
    let mut value = match validated {
        Ok(value) => value,
        Err(issues) => {
            let lines: Vec<String> = issues
                .iter()
                .take(5)
                .map(|issue| {
                    let path = issue.dotted_path();
                    match snippet_near(&candidate, &issue.path) {
                        Some(snippet) => {
                            format!("{}: {} (the object there is: {})", path, issue.message, snippet)
                        }
                        None => format!("{}: {}", path, issue.message),
                    }
                })
                .collect();
            return ParseVerdict::Problem(format!("The JSON failed validation:\n{}", lines.join("\n")));
        }
    };
    let problems = semantic(&mut value);
    if !problems.is_empty() {
        return ParseVerdict::Problem(format!(
            "The JSON violates part manifests:\n{}",
            problems.join("\n")
        ));
    }
    ParseVerdict::Ok(value)
}
