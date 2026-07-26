//! The manifest checker's Rust port, held to the webview checker by the
//! validation vectors: error paths, codes, and message text match byte for
//! byte (those messages feed the repair round, so wording is semantic), and
//! the in-place mutations (styling and knob normalization, the entry-row
//! alignment fix, duplicate-input dedup, state seeding) match too. The
//! registry snapshot in manifests.rs supplies knob tables, builtin shapes,
//! and transform kinds; installed vocabulary (fragment defs, part
//! operations, credentials) arrives per check.

use serde_json::{json, Map, Value};

use super::expression::parse_row_expression;
use super::manifests;
use super::templates::{expand_ui_fragment, instantiate_pack_operations};
use super::value::{js_to_string, js_truthy};

const STYLE_THEMES: [&str; 4] = ["default", "dark", "paper", "terminal"];
const STYLE_ACCENTS: [&str; 6] = ["blue", "green", "violet", "rose", "amber", "cyan"];

/// A free-form accent: any six-digit hex color the model derives when the
/// palette lacks the requested hue.
fn is_hex_accent(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 7 && bytes[0] == b'#' && bytes[1..].iter().all(u8::is_ascii_hexdigit)
}
/// Transforms that read a row field while the value is still the original
/// object array.
const FIELD_READING_TRANSFORMS: [&str; 6] =
    ["filterBy", "filterContains", "sortBy", "pluck", "sum", "groupSum"];
const SHAPE_PRESERVING_TRANSFORMS: [&str; 6] = [
    "filterBy",
    "filterContains",
    "filterTruthy",
    "filterFalsy",
    "sortBy",
    "deriveField",
];
const INTERACTIVE_TYPES: [&str; 5] = ["button", "input", "select", "textarea", "checkbox"];
const INPUT_LIKE_TYPES: [&str; 4] = ["input", "textarea", "select", "checkbox"];
const LIST_EDIT_OPERATIONS: [&str; 3] = ["list.updateWhere", "list.removeWhere", "list.toggleField"];

pub struct CheckOutcome {
    pub errors: Vec<Value>,
    pub warnings: Vec<Value>,
}

fn as_str<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

/// `String(binding.value ?? binding.sourceId)`: null and absent both fall
/// through to the sourceId.
fn value_or_source_id(binding: &Value) -> String {
    match binding.get("value") {
        Some(value) if !value.is_null() => js_to_string(value),
        _ => as_str(binding, "sourceId").to_string(),
    }
}

/// A set with JS insertion-order iteration.
struct OrderedSet(Vec<String>);

impl OrderedSet {
    fn new() -> Self {
        Self(Vec::new())
    }
    fn add(&mut self, value: &str) {
        if !self.has(value) {
            self.0.push(value.to_string());
        }
    }
    fn has(&self, value: &str) -> bool {
        self.0.iter().any(|existing| existing == value)
    }
    fn join(&self, separator: &str) -> String {
        self.0.join(separator)
    }
    fn len(&self) -> usize {
        self.0.len()
    }
}

/// Insertion-ordered key -> values bookkeeping (Map<string, Set<string>>).
struct FieldsByKey(Vec<(String, Vec<String>)>);

impl FieldsByKey {
    fn new() -> Self {
        Self(Vec::new())
    }
    fn get(&self, key: &str) -> Option<&Vec<String>> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }
    fn entry(&mut self, key: &str, seed: Vec<String>) -> &mut Vec<String> {
        if let Some(index) = self.0.iter().position(|(k, _)| k == key) {
            return &mut self.0[index].1;
        }
        self.0.push((key.to_string(), seed));
        &mut self.0.last_mut().unwrap().1
    }
    fn keys(&self) -> impl Iterator<Item = &String> {
        self.0.iter().map(|(k, _)| k)
    }
}

fn push_unique(list: &mut Vec<String>, value: String) {
    if !list.iter().any(|existing| existing == &value) {
        list.push(value);
    }
}

/// The known shape of a list's rows: fields plus what produced them (the
/// append, or an operation whose manifest declares itemFields).
#[derive(Clone)]
struct RowShape {
    key: String,
    fields: Vec<String>,
    producer: String,
}

fn row_field_hint(shape: &RowShape, field: &str) -> String {
    if shape.producer == "append" {
        format!("bind an existing field or add an item.{} input to the append", field)
    } else {
        "bind one of those fields".to_string()
    }
}

fn joined_fields(shape: &RowShape) -> String {
    if shape.fields.is_empty() {
        "nothing".to_string()
    } else {
        shape.fields.join(", ")
    }
}

/// A dynamic parameter reference: {"source": "state"|"element", "sourceId"}.
fn param_ref_of(value: &Value) -> Option<&Map<String, Value>> {
    let map = value.as_object()?;
    if map.len() != 2 || !map.contains_key("source") || !map.contains_key("sourceId") {
        return None;
    }
    if !map.get("source").is_some_and(Value::is_string) {
        return None;
    }
    Some(map)
}

fn pipeline_steps(binding: &Value) -> Vec<Value> {
    let mut steps: Vec<Value> = binding
        .get("transforms")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if let Some(single) = binding.get("transform").filter(|value| !value.is_null()) {
        steps.push(single.clone());
    }
    steps
}

struct PackOp {
    operation: Value,
    path: String,
}

struct Checker<'a> {
    fragment_defs: &'a Map<String, Value>,
    part_operations: &'a Map<String, Value>,
    credentials: &'a [Value],
    errors: Vec<Value>,
    warnings: Vec<Value>,
    element_ids: OrderedSet,
    operation_ids: OrderedSet,
    referenced_operation_ids: OrderedSet,
    missing_operation_refs: OrderedSet,
    consumed_element_ids: OrderedSet,
    control_candidates: Vec<(String, String, String)>,
    /// key -> first reading property, in read order.
    state_reads: Vec<(String, String)>,
    state_writes: Vec<String>,
    displayed_list_keys: OrderedSet,
    append_fields: FieldsByKey,
    later_fields: FieldsByKey,
    append_elements: FieldsByKey,
    object_array_keys: OrderedSet,
    /// Keys fed by operation outputs whose manifests declare itemFields.
    provided_fields: Vec<(String, (Vec<String>, String))>,
    /// Which list rows trigger each operation id.
    row_shape_by_op: Vec<(String, RowShape)>,
}

impl Checker<'_> {
    fn fail(&mut self, path: &str, message: String, code: &str) {
        self.errors
            .push(json!({ "path": path, "message": message, "code": code }));
    }

    fn warn(&mut self, path: &str, message: String) {
        self.warnings
            .push(json!({ "path": path, "message": message, "code": "MANIFEST_ADJUSTED" }));
    }

    fn operation_def(&self, name: &str) -> Option<Value> {
        manifests::builtin_def(name)
            .cloned()
            .or_else(|| self.part_operations.get(name).cloned())
    }

    fn row_shape_for(&self, key: &str) -> Option<RowShape> {
        if let Some(append) = self.append_fields.get(key) {
            let mut fields = append.clone();
            if let Some(later) = self.later_fields.get(key) {
                for field in later {
                    push_unique(&mut fields, field.clone());
                }
            }
            return Some(RowShape {
                key: key.to_string(),
                fields,
                producer: "append".to_string(),
            });
        }
        self.provided_fields
            .iter()
            .find(|(candidate, _)| candidate == key)
            .map(|(_, (fields, op_name))| RowShape {
                key: key.to_string(),
                fields: fields.clone(),
                producer: op_name.clone(),
            })
    }

    /// The row shape a list element's template sees: the items key's shape,
    /// grown by deriveField steps and voided by reshaping transforms.
    fn shape_of_list(&self, element: &Value) -> Option<RowShape> {
        let bindings = element.get("dataBindings").and_then(Value::as_array)?;
        let items = bindings
            .iter()
            .find(|binding| as_str(binding, "property") == "items")?;
        if as_str(items, "source") != "state" {
            return None;
        }
        let key = as_str(items, "sourceId");
        if key.is_empty() {
            return None;
        }
        let mut shape = self.row_shape_for(key)?;
        for step in pipeline_steps(items) {
            let step_type = as_str(&step, "type").to_string();
            if step_type == "deriveField" {
                if let Some(field) = step
                    .get("parameters")
                    .and_then(|parameters| parameters.get("field"))
                    .and_then(Value::as_str)
                {
                    if !field.is_empty() {
                        push_unique(&mut shape.fields, field.to_string());
                    }
                }
            } else if !SHAPE_PRESERVING_TRANSFORMS.contains(&step_type.as_str()) {
                return None;
            }
        }
        Some(shape)
    }

    fn row_shape_of_op(&self, op_id: &str) -> Option<&RowShape> {
        self.row_shape_by_op
            .iter()
            .find(|(id, _)| id == op_id)
            .map(|(_, shape)| shape)
    }

    fn known_element_ids(&self) -> String {
        let ids = &self.element_ids.0;
        let shown = ids
            .iter()
            .take(30)
            .map(String::as_str)
            .collect::<Vec<_>>()
            .join(", ");
        if ids.len() > 30 {
            format!("{}, ...", shown)
        } else {
            shown
        }
    }

    fn has_state_read(&self, key: &str) -> bool {
        self.state_reads.iter().any(|(k, _)| k == key)
    }

    fn check_param_ref(&mut self, path: &str, reference: &Map<String, Value>) {
        let source = reference.get("source").and_then(Value::as_str).unwrap_or("");
        let source_id = reference.get("sourceId").cloned().unwrap_or(Value::Null);
        // "ui-element" is the operation-input spelling of "element".
        let is_element_ref = source == "element" || source == "ui-element";
        if is_element_ref {
            if let Some(id) = source_id.as_str() {
                self.consumed_element_ids.add(id);
            }
        }
        if source != "state" && !is_element_ref {
            self.fail(
                path,
                format!(
                    "Transform parameter reference source must be \"state\" or \"element\", got \"{}\"",
                    source
                ),
                "INVALID_PARAM_REF",
            );
            return;
        }
        let Some(id) = source_id.as_str().filter(|id| !id.is_empty()) else {
            self.fail(
                path,
                "Transform parameter reference needs a sourceId".to_string(),
                "INVALID_PARAM_REF",
            );
            return;
        };
        if is_element_ref && !self.element_ids.has(id) {
            let listed = self.known_element_ids();
            self.fail(
                path,
                format!(
                    "Transform parameter references unknown element \"{}\"; existing element ids: {}",
                    id, listed
                ),
                "UNKNOWN_ELEMENT",
            );
            return;
        }
        if source == "state" && !self.has_state_read(id) {
            self.state_reads
                .push((id.to_string(), "transform parameter".to_string()));
        }
    }

    fn check_pipeline(&mut self, owner: &str, binding: &Value) {
        for step in pipeline_steps(binding) {
            let step_type = as_str(&step, "type");
            if !manifests::is_known_transform(step_type) {
                self.fail(
                    owner,
                    format!(
                        "Unknown transform \"{}\"; available transforms: {}. Math on values belongs in expr.evaluate.",
                        step_type,
                        manifests::transform_names().join(", ")
                    ),
                    "UNKNOWN_TRANSFORM",
                );
                continue;
            }
            // A deriveField expression that does not parse can never compute;
            // fail here so the repair round sees the exact problem.
            if step_type == "deriveField" {
                let parameters = step.get("parameters");
                let expression =
                    parameters.and_then(|p| p.get("expression")).and_then(Value::as_str);
                let field = parameters.and_then(|p| p.get("field")).and_then(Value::as_str);
                match (expression, field) {
                    (Some(expression), Some(_)) => {
                        if let Err(error) = parse_row_expression(expression) {
                            self.fail(
                                owner,
                                format!(
                                    "deriveField expression \"{}\" is invalid: {}",
                                    expression, error
                                ),
                                "INVALID_EXPRESSION",
                            );
                        }
                    }
                    _ => self.fail(
                        owner,
                        "deriveField needs a \"field\" name and an \"expression\" string in its parameters"
                            .to_string(),
                        "INVALID_EXPRESSION",
                    ),
                }
            }
            if let Some(parameters) = step.get("parameters").and_then(Value::as_object) {
                for value in parameters.values() {
                    if let Some(reference) = param_ref_of(value).cloned() {
                        self.check_param_ref(owner, &reference);
                    }
                }
            }
        }
    }

    fn check_list_field_reads(&mut self, path: &str, binding: &Value) {
        if as_str(binding, "source") != "state" {
            return;
        }
        let source_id = as_str(binding, "sourceId").to_string();
        if source_id.is_empty() {
            return;
        }
        // deriveField adds fields mid-pipeline, so later steps check against
        // a growing copy, never the shared append bookkeeping.
        let Some(mut fields) = self.append_fields.get(&source_id).cloned() else {
            return;
        };
        for step in pipeline_steps(binding) {
            let step_type = as_str(&step, "type").to_string();
            let field = step
                .get("parameters")
                .and_then(|p| p.get("field"))
                .and_then(Value::as_str)
                .map(str::to_string);
            if step_type == "deriveField" {
                let expression = step
                    .get("parameters")
                    .and_then(|p| p.get("expression"))
                    .and_then(Value::as_str);
                if let (Some(expression), Some(field)) =
                    (expression, field.filter(|f| !f.is_empty()))
                {
                    let carried_lower: Vec<String> =
                        fields.iter().map(|name| name.to_lowercase()).collect();
                    // Syntax problems already failed in check_pipeline.
                    if let Ok(parsed) = parse_row_expression(expression) {
                        for identifier in &parsed.identifiers {
                            if !carried_lower.iter().any(|name| name == identifier) {
                                let carried = if fields.is_empty() {
                                    "nothing".to_string()
                                } else {
                                    fields.join(", ")
                                };
                                self.fail(
                                    path,
                                    format!(
                                        "deriveField expression \"{}\" reads \"{}\", but rows of \"{}\" carry: {}; add an item.{} input to the append or fix the expression",
                                        expression, identifier, source_id, carried, identifier
                                    ),
                                    "LIST_FIELD_UNWRITTEN",
                                );
                            }
                        }
                    }
                    fields.push(field);
                }
                continue;
            }
            if FIELD_READING_TRANSFORMS.contains(&step_type.as_str()) {
                if let Some(field) = field.clone().filter(|f| !f.is_empty()) {
                    if !fields.iter().any(|name| name == &field) {
                        let carried = if fields.is_empty() {
                            "nothing".to_string()
                        } else {
                            fields.join(", ")
                        };
                        let set_later = self
                            .later_fields
                            .get(&source_id)
                            .is_some_and(|later| later.iter().any(|name| name == &field));
                        let hint = if set_later {
                            format!(
                                "only a later list operation sets \"{}\", so new rows start without it; give the append an item.{} input with the starting value",
                                field, field
                            )
                        } else {
                            format!(
                                "add an item.{} input to the append, or if \"{}\" is computed from each row's own fields, insert {{\"type\": \"deriveField\", \"parameters\": {{\"field\": \"{}\", \"expression\": \"<arithmetic over {}>\"}}}} before this step",
                                field, field, field, carried
                            )
                        };
                        self.fail(
                            path,
                            format!(
                                "{} reads field \"{}\" from \"{}\", but its rows carry: {}; {}",
                                step_type, field, source_id, carried, hint
                            ),
                            "LIST_FIELD_UNWRITTEN",
                        );
                    }
                }
            }
            // A filter driven by the same control that feeds the append hides
            // the other rows the moment anything is added.
            if step_type == "filterBy" || step_type == "filterContains" {
                if let Some(parameters) = step.get("parameters").and_then(Value::as_object) {
                    for value in parameters.values() {
                        let Some(reference) = param_ref_of(value) else { continue };
                        let ref_source =
                            reference.get("source").and_then(Value::as_str).unwrap_or("");
                        if ref_source != "element" && ref_source != "ui-element" {
                            continue;
                        }
                        let ref_id =
                            js_to_string(reference.get("sourceId").unwrap_or(&Value::Null));
                        let feeds_append = self
                            .append_elements
                            .get(&source_id)
                            .is_some_and(|sources| sources.iter().any(|s| s == &ref_id));
                        if feeds_append {
                            self.fail(
                                path,
                                format!(
                                    "The filter on \"{}\" reads entry control \"{}\", which also feeds its list.append; every add would then hide the other rows. Use a separate filter control bound to its own state key, with an \"All\" option whose value is \"\"",
                                    source_id, ref_id
                                ),
                                "FILTER_BOUND_TO_ENTRY",
                            );
                        }
                    }
                }
            }
            if !SHAPE_PRESERVING_TRANSFORMS.contains(&step_type.as_str()) {
                break;
            }
        }
    }
}

/// Validates and normalizes a structurally valid contract against the part
/// manifests, the webview checker's exact rules over JSON values. The
/// installed vocabulary is passed in: UI fragment defs by type, part
/// operation defs by name, and configured integration credentials.
pub fn check_against_manifests(
    contract: &mut Value,
    fragment_defs: &Map<String, Value>,
    part_operations: &Map<String, Value>,
    credentials: &[Value],
) -> CheckOutcome {
    let mut checker = Checker {
        fragment_defs,
        part_operations,
        credentials,
        errors: Vec::new(),
        warnings: Vec::new(),
        element_ids: OrderedSet::new(),
        operation_ids: OrderedSet::new(),
        referenced_operation_ids: OrderedSet::new(),
        missing_operation_refs: OrderedSet::new(),
        consumed_element_ids: OrderedSet::new(),
        control_candidates: Vec::new(),
        state_reads: Vec::new(),
        state_writes: Vec::new(),
        displayed_list_keys: OrderedSet::new(),
        append_fields: FieldsByKey::new(),
        later_fields: FieldsByKey::new(),
        append_elements: FieldsByKey::new(),
        provided_fields: Vec::new(),
        row_shape_by_op: Vec::new(),
        object_array_keys: OrderedSet::new(),
    };

    // Styling is cosmetic vocabulary: unknown values normalize with a warning.
    let mut styling_edits: Vec<(String, Option<Value>)> = Vec::new();
    if let Some(styling) = contract.get("styling").and_then(Value::as_object) {
        if let Some(theme) = styling.get("theme").and_then(Value::as_str) {
            if !theme.is_empty() && !STYLE_THEMES.contains(&theme) {
                checker.warn(
                    "styling.theme",
                    format!(
                        "\"{}\" is not one of {}; using \"default\"",
                        theme,
                        STYLE_THEMES.join("|")
                    ),
                );
                styling_edits.push((
                    "theme".to_string(),
                    Some(Value::String("default".to_string())),
                ));
            }
        }
        if let Some(accent) = styling.get("accent").and_then(Value::as_str) {
            if !accent.is_empty() && !STYLE_ACCENTS.contains(&accent) && !is_hex_accent(accent) {
                checker.warn(
                    "styling.accent",
                    format!(
                        "\"{}\" is not one of {} or a hex color like \"#7c3aed\"; accent removed",
                        accent,
                        STYLE_ACCENTS.join("|")
                    ),
                );
                styling_edits.push(("accent".to_string(), None));
            }
        }
        if let Some(background) = styling.get("background").and_then(Value::as_str) {
            if !background.is_empty() && !is_hex_accent(background) {
                checker.warn(
                    "styling.background",
                    format!(
                        "\"{}\" is not a hex color like \"#fef9c3\"; background removed",
                        background
                    ),
                );
                styling_edits.push(("background".to_string(), None));
            }
        }
    }
    if let Some(styling) = contract.get_mut("styling").and_then(Value::as_object_mut) {
        for (key, replacement) in styling_edits {
            match replacement {
                Some(value) => {
                    styling.insert(key, value);
                }
                None => {
                    styling.remove(&key);
                }
            }
        }
    }

    // Partial-experience packs: fragment instances that ship operations.
    // Their instantiated operations validate alongside the contract's own (on
    // fresh copies; the stored contract keeps only the compact instance
    // elements), and every rule below reads the merged list.
    let elements_snapshot: Vec<Value> = contract
        .get("elements")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let pack_ops = collect_pack_ops(&elements_snapshot, "elements", fragment_defs);
    let contract_ops: Vec<Value> = contract
        .get("operations")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let all_ops: Vec<Value> = contract_ops
        .iter()
        .cloned()
        .chain(pack_ops.iter().map(|pack| pack.operation.clone()))
        .collect();

    for key in contract
        .get("initialState")
        .and_then(Value::as_object)
        .map(|seeds| seeds.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default()
    {
        push_unique(&mut checker.state_writes, key);
    }

    // Fields rows of a list-built key actually carry: append item.* inputs
    // (plus the generated id) and initialState seed objects. updateWhere's
    // set.* fields are tracked apart because new rows start without them.
    for op in &all_ops {
        let name = as_str(op, "operationName");
        if !name.starts_with("list.") {
            continue;
        }
        let inputs = op.get("inputs").and_then(Value::as_array).cloned().unwrap_or_default();
        let Some(key_input) = inputs.iter().find(|input| as_str(input, "name") == "key") else {
            continue;
        };
        let key = value_or_source_id(key_input);
        checker.object_array_keys.add(&key);
        if name == "list.append" {
            let fields = checker.append_fields.entry(&key, vec!["id".to_string()]);
            for input in &inputs {
                if let Some(field) = as_str(input, "name").strip_prefix("item.") {
                    push_unique(fields, field.to_string());
                }
            }
        } else {
            let later = checker.later_fields.entry(&key, Vec::new());
            for input in &inputs {
                let input_name = as_str(input, "name");
                if let Some(field) = input_name.strip_prefix("set.") {
                    push_unique(later, field.to_string());
                }
                if input_name == "field" && name == "list.toggleField" {
                    push_unique(later, value_or_source_id(input));
                }
            }
        }
    }
    let seed_arrays: Vec<(String, Vec<Value>)> = contract
        .get("initialState")
        .and_then(Value::as_object)
        .map(|seeds| {
            seeds
                .iter()
                .filter_map(|(key, seed)| seed.as_array().map(|items| (key.clone(), items.clone())))
                .collect()
        })
        .unwrap_or_default();
    for (key, items) in seed_arrays {
        let objects: Vec<&Map<String, Value>> = items.iter().filter_map(Value::as_object).collect();
        if objects.is_empty() {
            continue;
        }
        let fields = checker.append_fields.entry(&key, Vec::new());
        for object in objects {
            for field in object.keys() {
                push_unique(fields, field.clone());
            }
        }
    }

    for op in &all_ops {
        checker.operation_ids.add(as_str(op, "id"));
    }
    // Element ids something consumes: operation inputs and outputs, or live
    // transform parameters. A control outside every one of these does nothing.
    for op in &all_ops {
        for input in op.get("inputs").and_then(Value::as_array).into_iter().flatten() {
            if as_str(input, "source") == "ui-element" {
                checker.consumed_element_ids.add(as_str(input, "sourceId"));
            }
        }
        for output in op.get("outputs").and_then(Value::as_array).into_iter().flatten() {
            if as_str(output, "target") == "ui-element" {
                checker.consumed_element_ids.add(as_str(output, "targetId"));
            }
        }
        // Legacy trigger wiring references elements too; normalization
        // converts it to event bindings only after this check runs.
        for trigger in op.get("triggers").and_then(Value::as_array).into_iter().flatten() {
            if let Some(element_id) = trigger
                .get("parameters")
                .and_then(|parameters| parameters.get("elementId"))
                .and_then(Value::as_str)
            {
                checker.consumed_element_ids.add(element_id);
            }
        }
    }
    // The entry controls feeding each list-built key's append.
    for op in &all_ops {
        if as_str(op, "operationName") != "list.append" {
            continue;
        }
        let inputs = op.get("inputs").and_then(Value::as_array).cloned().unwrap_or_default();
        let Some(key_input) = inputs.iter().find(|input| as_str(input, "name") == "key") else {
            continue;
        };
        let key = value_or_source_id(key_input);
        let sources = checker.append_elements.entry(&key, Vec::new());
        for input in &inputs {
            if as_str(input, "name").starts_with("item.") && as_str(input, "source") == "ui-element"
            {
                push_unique(sources, as_str(input, "sourceId").to_string());
            }
        }
    }

    // Keys fed by operation outputs whose manifests declare their row shape
    // (email.list's messages and the like); list templates bound to them get
    // their item reads validated exactly like append-built keys.
    for op in &all_ops {
        let Some(def) = checker.operation_def(as_str(op, "operationName")) else {
            continue;
        };
        for output in op.get("outputs").and_then(Value::as_array).into_iter().flatten() {
            if as_str(output, "target") != "state" {
                continue;
            }
            let target_id = as_str(output, "targetId");
            if target_id.is_empty() {
                continue;
            }
            let has_transforms = output
                .get("transforms")
                .and_then(Value::as_array)
                .is_some_and(|steps| !steps.is_empty())
                || output.get("transform").is_some_and(|value| !value.is_null());
            if has_transforms {
                continue;
            }
            let output_name = as_str(output, "name");
            let item_fields: Vec<String> = def
                .get("outputs")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .find(|candidate| as_str(candidate, "name") == output_name)
                .and_then(|candidate| candidate.get("itemFields"))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect();
            if !item_fields.is_empty()
                && !checker.provided_fields.iter().any(|(key, _)| key == target_id)
            {
                checker.provided_fields.push((
                    target_id.to_string(),
                    (item_fields, as_str(op, "operationName").to_string()),
                ));
            }
        }
    }

    // Which list rows trigger each operation, so item inputs validate
    // against the rows they actually read from.
    if let Some(elements) = contract.get("elements").and_then(Value::as_array) {
        map_row_ops(&elements.clone(), false, None, &mut checker);
    }

    // The element walk: normalization, bookkeeping, and per-element rules.
    if let Some(elements) = contract.get_mut("elements").and_then(Value::as_array_mut) {
        walk_elements(elements, "elements", false, &mut checker, None);
    }

    // A model that wires events but forgets the operations array needs the
    // fix stated outright, ahead of the per-binding errors.
    if checker.missing_operation_refs.len() > 0 && contract_ops.is_empty() {
        let message = format!(
            "The contract has no \"operations\" array but elements reference {} operation id(s): {}. Add a top-level \"operations\" array with one entry per referenced id.",
            checker.missing_operation_refs.len(),
            checker.missing_operation_refs.join(", ")
        );
        checker.errors.insert(
            0,
            json!({ "path": "operations", "message": message, "code": "MISSING_OPERATIONS" }),
        );
    }

    // Operations against manifests: the contract's own (input dedup mutates
    // in place), then every pack instance's (same rules, pack-flavored paths,
    // on the fresh copies).
    if let Some(operations) = contract.get_mut("operations").and_then(Value::as_array_mut) {
        for (index, op) in operations.iter_mut().enumerate() {
            check_operation(op, &format!("operations.{}", index), &mut checker);
        }
    }
    let mut checked_pack_ops: Vec<PackOp> = Vec::new();
    for pack in pack_ops {
        let mut operation = pack.operation;
        check_operation(&mut operation, &pack.path, &mut checker);
        checked_pack_ops.push(PackOp { operation, path: pack.path });
    }

    let contract_ops_after: Vec<Value> = contract
        .get("operations")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let merged_after: Vec<(Value, String)> = contract_ops_after
        .iter()
        .enumerate()
        .map(|(index, op)| (op.clone(), format!("operations.{}", index)))
        .chain(
            checked_pack_ops
                .iter()
                .map(|pack| (pack.operation.clone(), pack.path.clone())),
        )
        .collect();

    // An operation nothing runs is a dead feature: some binding, tick, or
    // fragment parameter must reference it.
    for (op, op_path) in &merged_after {
        let has_triggers = op
            .get("triggers")
            .and_then(Value::as_array)
            .is_some_and(|triggers| !triggers.is_empty());
        let id = as_str(op, "id");
        if !checker.referenced_operation_ids.has(id) && !has_triggers {
            let message = format!(
                "Nothing runs operation \"{}\"; wire it to an element event (a click, change, or timer tick) or remove it",
                id
            );
            checker.fail(op_path, message, "ORPHAN_OPERATION");
        }
    }

    // Editing a list nothing ever fills is a feature that can never happen.
    for (op, op_path) in &merged_after {
        let name = as_str(op, "operationName");
        if !LIST_EDIT_OPERATIONS.contains(&name) {
            continue;
        }
        let inputs = op.get("inputs").and_then(Value::as_array).cloned().unwrap_or_default();
        let Some(key_input) = inputs.iter().find(|input| as_str(input, "name") == "key") else {
            continue;
        };
        let key = value_or_source_id(key_input);
        if checker.append_fields.get(&key).is_none() {
            let message = format!(
                "{} edits \"{}\" but nothing ever fills it; add a list.append flow with entry controls, or seed initialState.{} with starting rows",
                name, key, key
            );
            checker.fail(op_path, message, "LIST_NEVER_FILLED");
        }
    }

    // Rows someone adds must be visible somewhere.
    let append_keys: Vec<String> = checker.append_elements.keys().cloned().collect();
    for key in append_keys {
        if !checker.displayed_list_keys.has(&key) {
            checker.fail(
                "operations",
                format!(
                    "list.append fills \"{}\" but no list element displays it; bind a list element's \"items\" to \"{}\"",
                    key, key
                ),
                "LIST_NOT_DISPLAYED",
            );
        }
    }

    // A control nothing consumes does nothing when used.
    let candidates = checker.control_candidates.clone();
    for (id, element_type, path) in candidates {
        if checker.consumed_element_ids.has(&id) {
            continue;
        }
        let wiring = if element_type == "button" {
            "give it an eventBinding that runs an operation"
        } else {
            "read it from an operation input ({\"source\": \"ui-element\"}), reference it live from a filter parameter ({\"source\": \"element\"}), or give it a change binding"
        };
        checker.fail(
            &path,
            format!("{} \"{}\" affects nothing: {}, or remove it", element_type, id, wiring),
            "DEAD_CONTROL",
        );
    }

    // Seed state keys that are read but never written. An empty array for an
    // array-shaped reader is the normal omitted-seed case and stays silent; a
    // null seed means a key no operation writes, which usually flags a typo.
    let reads = checker.state_reads.clone();
    for (key, first_reader) in reads {
        if checker.state_writes.iter().any(|written| written == &key) {
            continue;
        }
        let seed = if first_reader == "items" || first_reader == "options" {
            Value::Array(Vec::new())
        } else {
            Value::Null
        };
        let seed_is_null = seed.is_null();
        if let Some(map) = contract.as_object_mut() {
            let initial = map
                .entry("initialState".to_string())
                .or_insert_with(|| Value::Object(Map::new()));
            if let Some(initial) = initial.as_object_mut() {
                initial.insert(key.clone(), seed);
            }
        }
        if seed_is_null {
            checker.warn(
                &format!("initialState.{}", key),
                format!("State key \"{}\" was read but never written; seeded with null", key),
            );
        }
    }

    CheckOutcome {
        errors: checker.errors,
        warnings: checker.warnings,
    }
}

fn collect_pack_ops(
    elements: &[Value],
    parent_path: &str,
    fragment_defs: &Map<String, Value>,
) -> Vec<PackOp> {
    let mut collected = Vec::new();
    for (index, element) in elements.iter().enumerate() {
        let path = format!("{}.{}", parent_path, index);
        let Some(element_map) = element.as_object() else { continue };
        let element_type = as_str(element, "type");
        if let Some(def) = fragment_defs.get(element_type).and_then(Value::as_object) {
            if def.get("operations").and_then(Value::as_array).is_some_and(|ops| !ops.is_empty()) {
                for operation in instantiate_pack_operations(element_map, def) {
                    let op_id = as_str(&operation, "id").to_string();
                    collected.push(PackOp {
                        path: format!("{} ({} operation \"{}\")", path, element_type, op_id),
                        operation,
                    });
                }
            }
        }
        if let Some(children) = element_map.get("children").and_then(Value::as_array) {
            collected.extend(collect_pack_ops(children, &format!("{}.children", path), fragment_defs));
        }
    }
    collected
}

/// An expanded fragment subtree contributes ids, displayed keys, and event
/// wiring: references to "<instance>-..." ids are valid, and a pack's
/// operations are triggered from inside its template.
fn collect_expanded(expanded: &Value, checker: &mut Checker) {
    checker.element_ids.add(as_str(expanded, "id"));
    if as_str(expanded, "type") == "list" {
        for binding in expanded
            .get("dataBindings")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if as_str(binding, "property") == "items" && as_str(binding, "source") == "state" {
                checker.displayed_list_keys.add(as_str(binding, "sourceId"));
            }
        }
    }
    for binding in expanded
        .get("eventBindings")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        checker
            .referenced_operation_ids
            .add(as_str(binding, "operationId"));
    }
    for child in expanded
        .get("children")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        collect_expanded(child, checker);
    }
}

fn fix_centered_entry_rows(element: &mut Value, path: &str, checker: &mut Checker) {
    let element_type = as_str(element, "type");
    if element_type != "container" && element_type != "form" {
        return;
    }
    let centered_row = element.get("properties").and_then(Value::as_object).is_some_and(|props| {
        props.get("align").and_then(Value::as_str) == Some("center")
            && props.get("direction").and_then(Value::as_str) != Some("column")
    });
    if !centered_row {
        return;
    }
    const ROW_INPUT_LIKE: [&str; 3] = ["input", "select", "textarea"];
    let children = element
        .get("children")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let has_labeled_field = children.iter().any(|child| {
        ROW_INPUT_LIKE.contains(&as_str(child, "type"))
            && child
                .get("properties")
                .and_then(|props| props.get("label"))
                .is_some_and(js_truthy)
    });
    let has_other_control = children
        .iter()
        .any(|child| !ROW_INPUT_LIKE.contains(&as_str(child, "type")));
    if has_labeled_field && has_other_control {
        if let Some(props) = element.get_mut("properties").and_then(Value::as_object_mut) {
            props.insert("align".to_string(), Value::String("end".to_string()));
        }
        checker.warn(
            &format!("{}.properties.align", path),
            "Row mixes labeled fields with other controls; align \"center\" floats them, using \"end\""
                .to_string(),
        );
    }
}

/// Maps operations triggered from list rows to their row shape, ahead of
/// the operation checks.
fn map_row_ops(
    elements: &[Value],
    in_template: bool,
    shape: Option<&RowShape>,
    checker: &mut Checker,
) {
    for element in elements {
        if in_template {
            if let Some(shape) = shape {
                for binding in element
                    .get("eventBindings")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    let op_id = as_str(binding, "operationId");
                    if !checker.row_shape_by_op.iter().any(|(id, _)| id == op_id) {
                        checker.row_shape_by_op.push((op_id.to_string(), shape.clone()));
                    }
                }
            }
        }
        let children = element.get("children").and_then(Value::as_array);
        if let Some(children) = children {
            if children.is_empty() {
                continue;
            }
            let is_template = as_str(element, "type") == "list";
            let child_template = in_template || is_template;
            let child_shape = if is_template {
                checker.shape_of_list(element)
            } else {
                shape.cloned()
            };
            map_row_ops(children, child_template, child_shape.as_ref(), checker);
        }
    }
}

fn walk_elements(
    elements: &mut [Value],
    parent_path: &str,
    in_list_template: bool,
    checker: &mut Checker,
    row_shape: Option<&RowShape>,
) {
    for (index, element) in elements.iter_mut().enumerate() {
        let path = format!("{}.{}", parent_path, index);
        fix_centered_entry_rows(element, &path, checker);

        let id = as_str(element, "id").to_string();
        let element_type = as_str(element, "type").to_string();
        checker.element_ids.add(&id);

        if element_type == "list" {
            for binding in element
                .get("dataBindings")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if as_str(binding, "property") == "items" && as_str(binding, "source") == "state" {
                    checker.displayed_list_keys.add(as_str(binding, "sourceId"));
                }
            }
        }

        // Row controls act through their template's item scope; top-level
        // controls must be consumed by something to matter.
        let event_bindings = element
            .get("eventBindings")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if INTERACTIVE_TYPES.contains(&element_type.as_str())
            && !in_list_template
            && event_bindings.is_empty()
        {
            checker
                .control_candidates
                .push((id.clone(), element_type.clone(), path.clone()));
        }

        // Installed UI fragments: enforce their parameter contract.
        let fragment_def = checker
            .fragment_defs
            .get(&element_type)
            .and_then(Value::as_object)
            .cloned();
        if let Some(def) = fragment_def {
            if let Some(element_map) = element.as_object() {
                // Template problems surface through the checks below.
                if let Ok(expanded) = expand_ui_fragment(element_map, &def) {
                    collect_expanded(&expanded, checker);
                }
            }
            let props = element
                .get("properties")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            for param in def.get("params").and_then(Value::as_array).into_iter().flatten() {
                let param_name = as_str(param, "name");
                let value = props.get(param_name);
                let required = param.get("required").and_then(Value::as_bool).unwrap_or(false);
                let is_empty = value.is_none() || value.and_then(Value::as_str) == Some("");
                if required && is_empty {
                    checker.fail(
                        &format!("{}.properties.{}", path, param_name),
                        format!(
                            "UI fragment {} requires the \"{}\" parameter",
                            element_type, param_name
                        ),
                        "MISSING_FRAGMENT_PARAM",
                    );
                    continue;
                }
                if let Some(value) = value {
                    if as_str(param, "type") == "operationId" {
                        if let Some(op_id) = value.as_str() {
                            checker.referenced_operation_ids.add(op_id);
                        }
                        let known = value
                            .as_str()
                            .is_some_and(|op_id| checker.operation_ids.has(op_id));
                        if !known {
                            let defined = if checker.operation_ids.len() == 0 {
                                "none".to_string()
                            } else {
                                checker.operation_ids.join(", ")
                            };
                            let message = format!(
                                "\"{}\" is not a defined operation id; defined: {}",
                                js_to_string(value),
                                defined
                            );
                            checker.fail(
                                &format!("{}.properties.{}", path, param_name),
                                message,
                                "UNKNOWN_OPERATION",
                            );
                        }
                    }
                }
            }
        }

        // Knob normalization against the element manifest.
        if let Some(knobs) = manifests::element_knobs(&element_type) {
            for knob in knobs.clone() {
                if as_str(&knob, "type") != "enum" {
                    continue;
                }
                let knob_name = as_str(&knob, "name").to_string();
                let Some(value) = element
                    .get("properties")
                    .and_then(|props| props.get(&knob_name))
                    .cloned()
                else {
                    continue;
                };
                let allowed: Vec<&str> = knob
                    .get("values")
                    .and_then(Value::as_array)
                    .map(|values| values.iter().filter_map(Value::as_str).collect())
                    .unwrap_or_default();
                if allowed.contains(&js_to_string(&value).as_str()) {
                    continue;
                }
                let default = knob.get("default").cloned();
                let default_text = default
                    .as_ref()
                    .map(js_to_string)
                    .unwrap_or_else(|| "undefined".to_string());
                checker.warn(
                    &format!("{}.properties.{}", path, knob_name),
                    format!(
                        "\"{}\" is not one of {}; using \"{}\"",
                        js_to_string(&value),
                        allowed.join("|"),
                        default_text
                    ),
                );
                if let Some(props) = element.get_mut("properties").and_then(Value::as_object_mut) {
                    match default {
                        Some(default) => {
                            props.insert(knob_name.clone(), default);
                        }
                        None => {
                            props.remove(&knob_name);
                        }
                    }
                }
            }
        }

        let data_bindings = element
            .get("dataBindings")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for (binding_index, binding) in data_bindings.iter().enumerate() {
            let binding_path = format!("{}.dataBindings.{}", path, binding_index);
            checker.check_pipeline(&binding_path, binding);
            checker.check_list_field_reads(&binding_path, binding);

            // Inside list templates auto-control is off and item bindings
            // drive the control; the ban applies only outside them.
            let property = as_str(binding, "property");
            if !in_list_template
                && INPUT_LIKE_TYPES.contains(&element_type.as_str())
                && (property == "value" || property == "checked")
            {
                checker.fail(
                    &binding_path,
                    format!(
                        "{} elements are auto-controlled; never bind \"{}\". Read the element from operations ({{\"source\": \"ui-element\"}}) or from transform parameters ({{\"source\": \"element\", \"sourceId\": \"{}\"}}).",
                        element_type, property, id
                    ),
                    "BOUND_INPUT_VALUE",
                );
            }

            // Text-bound pipelines must end in a single value, or React
            // receives a list where a string belongs.
            if property == "content" || property == "text" {
                if let Some(last) = pipeline_steps(binding).last() {
                    let last_type = as_str(last, "type");
                    if manifests::transform_output(last_type) == Some("array") {
                        checker.fail(
                            &binding_path,
                            format!(
                                "The \"{}\" pipeline ends in \"{}\", which returns a list; append a reducing step such as count, sum, or pick",
                                property, last_type
                            ),
                            "PIPELINE_ENDS_IN_ARRAY",
                        );
                    }
                }
            }

            let source = as_str(binding, "source");
            let source_id = as_str(binding, "sourceId");
            if source == "state" && !source_id.is_empty() {
                // Array-shaped readers win so the seed becomes [] regardless
                // of order.
                let is_array_reader = property == "items" || property == "options";
                match checker.state_reads.iter_mut().find(|(key, _)| key == source_id) {
                    Some((_, existing)) => {
                        if is_array_reader && existing != "items" && existing != "options" {
                            *existing = property.to_string();
                        }
                    }
                    None => {
                        checker
                            .state_reads
                            .push((source_id.to_string(), property.to_string()));
                    }
                }
            }
            if source == "item" && !in_list_template {
                checker.warn(
                    &binding_path,
                    "\"item\" binding outside a list template resolves to nothing".to_string(),
                );
            } else if source == "item" {
                if let Some(shape) = row_shape {
                    let field = source_id.split('.').next().unwrap_or("");
                    if !field.is_empty() && !shape.fields.iter().any(|f| f == field) {
                        checker.fail(
                            &binding_path,
                            format!(
                                "Row binding reads item field \"{}\", but rows of \"{}\" carry: {}; {}",
                                field,
                                shape.key,
                                joined_fields(shape),
                                row_field_hint(shape, field)
                            ),
                            "LIST_FIELD_UNWRITTEN",
                        );
                    }
                }
            }
        }

        let conditions: Vec<Value> = match element.get("visibleWhen") {
            Some(Value::Array(list)) => list.clone(),
            Some(single) if !single.is_null() => vec![single.clone()],
            _ => Vec::new(),
        };
        for (condition_index, condition) in conditions.iter().enumerate() {
            let condition_path = format!("{}.visibleWhen.{}", path, condition_index);
            checker.check_pipeline(&condition_path, condition);
            checker.check_list_field_reads(&condition_path, condition);
            if as_str(condition, "source") == "state" {
                let source_id = as_str(condition, "sourceId");
                if !checker.has_state_read(source_id) {
                    checker
                        .state_reads
                        .push((source_id.to_string(), "visibleWhen".to_string()));
                }
            } else if !in_list_template {
                checker.warn(
                    &condition_path,
                    "\"item\" condition outside a list template resolves to nothing".to_string(),
                );
            } else if let Some(shape) = row_shape {
                let field_owner = as_str(condition, "sourceId").to_string();
                let field = field_owner.split('.').next().unwrap_or("");
                if !field.is_empty() && !shape.fields.iter().any(|f| f == field) {
                    checker.fail(
                        &condition_path,
                        format!(
                            "Row condition reads item field \"{}\", but rows of \"{}\" carry: {}; {}",
                            field,
                            shape.key,
                            joined_fields(shape),
                            row_field_hint(shape, field)
                        ),
                        "LIST_FIELD_UNWRITTEN",
                    );
                }
            }
        }

        for (binding_index, binding) in event_bindings.iter().enumerate() {
            let operation_id = as_str(binding, "operationId").to_string();
            checker.referenced_operation_ids.add(&operation_id);
            if !checker.operation_ids.has(&operation_id) {
                checker.missing_operation_refs.add(&operation_id);
                let defined = if checker.operation_ids.len() == 0 {
                    "none".to_string()
                } else {
                    checker.operation_ids.join(", ")
                };
                checker.fail(
                    &format!("{}.eventBindings.{}", path, binding_index),
                    format!(
                        "Event \"{}\" references unknown operation \"{}\"; defined operation ids: {}",
                        as_str(binding, "event"),
                        operation_id,
                        defined
                    ),
                    "UNKNOWN_OPERATION",
                );
            }
        }

        let is_template = element_type == "list"
            && element
                .get("children")
                .and_then(Value::as_array)
                .is_some_and(|children| !children.is_empty());
        let child_template = in_list_template || is_template;
        // A nested list rebinds the row scope; an unknown inner shape must
        // not inherit the outer one.
        let child_shape = if is_template {
            checker.shape_of_list(element)
        } else {
            row_shape.cloned()
        };
        if let Some(children) = element.get_mut("children").and_then(Value::as_array_mut) {
            walk_elements(
                children,
                &format!("{}.children", path),
                child_template,
                checker,
                child_shape.as_ref(),
            );
        }
    }
}

fn check_operation(op: &mut Value, op_path: &str, checker: &mut Checker) {
    let name = as_str(op, "operationName").to_string();
    let op_id = as_str(op, "id").to_string();
    let def = checker.operation_def(&name);
    let implementation = op.get("implementation").cloned().unwrap_or(Value::Null);
    let endpoint = as_str(&implementation, "endpoint").to_string();
    let has_endpoint = !endpoint.is_empty();
    let has_code = implementation.get("code").is_some_and(js_truthy);

    let placeholder =
        regex::Regex::new(r"(?i)https?://(api\.)?example\.(com|org|net)").expect("static regex");
    if placeholder.is_match(&endpoint) {
        checker.fail(
            &format!("{}.implementation.endpoint", op_path),
            format!(
                "\"{}\" is a placeholder, not a real service. Use an installed integration part if one fits, a real documented API recorded in the assumptions, or leave the feature out.",
                endpoint
            ),
            "PLACEHOLDER_ENDPOINT",
        );
    }

    // An auth reference must name a configured HTTP credential. The store
    // also holds non-injectable kinds (the smtp mail account, part-scoped
    // secrets); those are invisible here and in the taught names.
    if let Some(auth) = implementation.get("auth").and_then(Value::as_str) {
        let injectable = |credential: &&Value| {
            matches!(as_str(credential, "kind"), "bearer" | "header" | "query")
        };
        let credential = checker
            .credentials
            .iter()
            .filter(injectable)
            .find(|credential| as_str(credential, "name") == auth)
            .cloned();
        match credential {
            None => {
                let known: Vec<&str> = checker
                    .credentials
                    .iter()
                    .filter(injectable)
                    .map(|credential| as_str(credential, "name"))
                    .collect();
                let message = if known.is_empty() {
                    format!(
                        "\"{}\" is not a configured integration credential; none are configured, so omit auth or ask the user to add one in Settings",
                        auth
                    )
                } else {
                    format!(
                        "\"{}\" is not a configured integration credential; available: {}",
                        auth,
                        known.join(", ")
                    )
                };
                checker.fail(&format!("{}.implementation.auth", op_path), message, "UNKNOWN_CREDENTIAL");
            }
            Some(credential) => {
                let base_url = as_str(&credential, "baseUrl");
                if !base_url.is_empty() && !endpoint.starts_with(base_url) {
                    checker.fail(
                        &format!("{}.implementation.endpoint", op_path),
                        format!(
                            "Credential \"{}\" is confined to {}; the endpoint must start with it",
                            auth, base_url
                        ),
                        "CREDENTIAL_CONFINEMENT",
                    );
                }
            }
        }
    }

    if def.is_none() && !has_endpoint && !has_code {
        checker.fail(
            op_path,
            format!(
                "\"{}\" is not a builtin operation and has no remote endpoint. Use an exact builtin name from the catalog or a remote implementation.",
                name
            ),
            "UNKNOWN_OPERATION_NAME",
        );
        return;
    }

    // Input bindings: pipelines, references, duplicates (deduped in place;
    // inputs the manifest rejects are dropped with their error).
    let inputs: Vec<Value> = op.get("inputs").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut seen_input_names: Vec<String> = Vec::new();
    let mut kept_inputs: Vec<Value> = Vec::new();
    for (input_index, input) in inputs.iter().enumerate() {
        let input_path = format!("{}.inputs.{}", op_path, input_index);
        checker.check_pipeline(&input_path, input);
        checker.check_list_field_reads(&input_path, input);

        let source = as_str(input, "source");
        let source_id = as_str(input, "sourceId").to_string();
        let input_name = as_str(input, "name").to_string();
        if source == "item" {
            if let Some(shape) = checker.row_shape_of_op(&op_id).cloned() {
                let field = source_id.split('.').next().unwrap_or("");
                if !field.is_empty() && !shape.fields.iter().any(|f| f == field) {
                    checker.fail(
                        &input_path,
                        format!(
                            "Input \"{}\" reads item field \"{}\", but rows of \"{}\" carry: {}; {}",
                            input_name,
                            field,
                            shape.key,
                            joined_fields(&shape),
                            row_field_hint(&shape, field)
                        ),
                        "LIST_FIELD_UNWRITTEN",
                    );
                }
            }
        }
        if source == "ui-element" && !checker.element_ids.has(&source_id) {
            let listed = checker.known_element_ids();
            checker.fail(
                &input_path,
                format!(
                    "References unknown element \"{}\"; existing element ids: {}",
                    source_id, listed
                ),
                "UNKNOWN_ELEMENT",
            );
        }
        if source == "state" && !source_id.is_empty() && !checker.has_state_read(&source_id) {
            checker
                .state_reads
                .push((source_id.clone(), format!("input:{}", input_name)));
        }

        if let Some(def) = &def {
            let def_inputs = def.get("inputs").and_then(Value::as_array).cloned().unwrap_or_default();
            let flat_names: Vec<&str> = def_inputs
                .iter()
                .filter_map(|spec| spec.get("name").and_then(Value::as_str))
                .filter(|spec_name| !spec_name.contains('<'))
                .collect();
            let prefixes: Vec<&str> = def
                .get("structuredPrefixes")
                .and_then(Value::as_array)
                .map(|list| list.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            let accepted = {
                let mut names: Vec<String> =
                    flat_names.iter().map(|spec_name| spec_name.to_string()).collect();
                names.extend(prefixes.iter().map(|prefix| format!("{}.<field>", prefix)));
                if names.is_empty() {
                    "none".to_string()
                } else {
                    names.join(", ")
                }
            };
            match input_name.find('.') {
                Some(dot) if dot > 0 => {
                    let prefix = &input_name[..dot];
                    if !prefixes.contains(&prefix) {
                        if !prefixes.is_empty() {
                            let listed = prefixes
                                .iter()
                                .map(|p| format!("{}.<field>", p))
                                .collect::<Vec<_>>()
                                .join(", ");
                            checker.fail(
                                &input_path,
                                format!(
                                    "\"{}\" uses prefix \"{}\" but {} accepts {}",
                                    input_name, prefix, name, listed
                                ),
                                "INVALID_PREFIX",
                            );
                            continue;
                        }
                        checker.fail(
                            &input_path,
                            format!(
                                "{} has no input \"{}\"; it accepts: {}",
                                name, input_name, accepted
                            ),
                            "UNKNOWN_INPUT",
                        );
                        continue;
                    }
                    if input_name[dot + 1..].contains('.') {
                        checker.warn(
                            &input_path,
                            format!("Nested field \"{}\" flattened to a single level", input_name),
                        );
                    }
                }
                _ => {
                    if !flat_names.contains(&input_name.as_str()) {
                        checker.fail(
                            &input_path,
                            format!(
                                "{} has no input \"{}\"; it accepts: {}",
                                name, input_name, accepted
                            ),
                            "UNKNOWN_INPUT",
                        );
                        continue;
                    }
                }
            }

            // A numbers-array input reading a list-built state key (objects
            // by construction) silently computes over nothing without a
            // projection.
            let spec = def_inputs
                .iter()
                .find(|spec| spec.get("name").and_then(Value::as_str) == Some(&input_name));
            let wants_numbers = spec.is_some_and(|spec| {
                spec.get("type").and_then(Value::as_str) == Some("array")
                    && spec
                        .get("description")
                        .and_then(Value::as_str)
                        .is_some_and(|description| description.to_lowercase().contains("number"))
            });
            let has_transforms = !pipeline_steps(input).is_empty();
            if wants_numbers
                && !has_transforms
                && source == "state"
                && checker.object_array_keys.has(&source_id)
            {
                checker.fail(
                    &input_path,
                    format!(
                        "\"{}\" holds objects (built by a list operation); project the numeric field first, e.g. transforms [{{\"type\": \"pluck\", \"parameters\": {{\"field\": \"<field>\"}}}}]",
                        source_id
                    ),
                    "NEEDS_PROJECTION",
                );
            }
        }

        if seen_input_names.iter().any(|seen| seen == &input_name) {
            checker.warn(
                &input_path,
                format!("Duplicate input \"{}\"; the last one wins", input_name),
            );
            if let Some(existing) = kept_inputs
                .iter()
                .position(|kept| as_str(kept, "name") == input_name)
            {
                kept_inputs.remove(existing);
            }
        }
        push_unique(&mut seen_input_names, input_name);
        kept_inputs.push(input.clone());
    }
    if let Some(map) = op.as_object_mut() {
        map.insert("inputs".to_string(), Value::Array(kept_inputs.clone()));
    }

    if let Some(def) = &def {
        let def_inputs = def.get("inputs").and_then(Value::as_array).cloned().unwrap_or_default();
        // Required flat inputs present?
        for spec in &def_inputs {
            let spec_name = as_str(spec, "name");
            let required = spec.get("required").and_then(Value::as_bool).unwrap_or(false);
            if required
                && !spec_name.contains('<')
                && !seen_input_names.iter().any(|seen| seen == spec_name)
            {
                checker.fail(
                    op_path,
                    format!("{} requires input \"{}\"", name, spec_name),
                    "MISSING_INPUT",
                );
            }
        }
        // A structured prefix demands at least one field only when its
        // placeholder spec is required (list.append's item.<field> is; expr's
        // var.<name> is optional).
        let prefixes: Vec<String> = def
            .get("structuredPrefixes")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        for prefix in prefixes {
            let dotted = format!("{}.", prefix);
            let placeholder = def_inputs
                .iter()
                .find(|spec| as_str(spec, "name").starts_with(&dotted));
            let optional = placeholder
                .is_some_and(|spec| spec.get("required").and_then(Value::as_bool) == Some(false));
            if optional {
                continue;
            }
            if !seen_input_names.iter().any(|seen| seen.starts_with(&dotted)) {
                checker.fail(
                    op_path,
                    format!("{} needs at least one \"{}.<field>\" input", name, prefix),
                    "MISSING_INPUT",
                );
            }
        }
        // Outputs must exist on the manifest.
        let output_names: Vec<&str> = def
            .get("outputs")
            .and_then(Value::as_array)
            .map(|outputs| {
                outputs
                    .iter()
                    .filter_map(|output| output.get("name").and_then(Value::as_str))
                    .collect()
            })
            .unwrap_or_default();
        let op_outputs = op.get("outputs").and_then(Value::as_array).cloned().unwrap_or_default();
        for (output_index, output) in op_outputs.iter().enumerate() {
            let output_name = as_str(output, "name");
            // "reset" is a universal output (clears the routed control).
            if output_name == "reset" {
                continue;
            }
            if !output_names.contains(&output_name) {
                let provides = if output_names.is_empty() {
                    "none".to_string()
                } else {
                    output_names.join(", ")
                };
                checker.fail(
                    &format!("{}.outputs.{}", op_path, output_index),
                    format!("{} has no output \"{}\"; it provides: {}", name, output_name, provides),
                    "UNKNOWN_OUTPUT",
                );
            }
        }

        // A constant expr.evaluate expression can be linted against its bound
        // variables here; at runtime a mismatch surfaces only when someone
        // clicks the button.
        if name == "expr.evaluate" {
            let expression = kept_inputs.iter().find(|input| {
                as_str(input, "name") == "expression" && as_str(input, "source") == "constant"
            });
            let bound: Vec<String> = seen_input_names
                .iter()
                .filter_map(|seen| seen.strip_prefix("var.").map(str::to_string))
                .collect();
            if let Some(expression) = expression {
                let source_text = value_or_source_id(expression);
                if !source_text.is_empty() {
                    let identifier_re =
                        regex::Regex::new(r"[A-Za-z_][A-Za-z0-9_]*").expect("static regex");
                    let mut seen_identifiers: Vec<String> = Vec::new();
                    for capture in identifier_re.find_iter(&source_text) {
                        let identifier = capture.as_str().to_string();
                        if seen_identifiers.iter().any(|seen| seen == &identifier) {
                            continue;
                        }
                        seen_identifiers.push(identifier.clone());
                        if manifests::expr_reserved(&identifier) {
                            continue;
                        }
                        if !bound.iter().any(|name| name == &identifier) {
                            let binds = if bound.is_empty() {
                                "no variables".to_string()
                            } else {
                                format!("only: {}", bound.join(", "))
                            };
                            checker.fail(
                                op_path,
                                format!(
                                    "expr.evaluate expression uses \"{}\" but binds {}; add an input named \"var.{}\" or rename it in the expression",
                                    identifier, binds, identifier
                                ),
                                "EXPR_UNBOUND_VARIABLE",
                            );
                        }
                    }
                }
            }
        }
    }

    // Output pipelines and element references apply to every execution type.
    let op_outputs = op.get("outputs").and_then(Value::as_array).cloned().unwrap_or_default();
    for (output_index, output) in op_outputs.iter().enumerate() {
        let output_path = format!("{}.outputs.{}", op_path, output_index);
        checker.check_pipeline(&output_path, output);
        let target_id = as_str(output, "targetId");
        if as_str(output, "target") == "ui-element" && !checker.element_ids.has(target_id) {
            let listed = checker.known_element_ids();
            checker.fail(
                &output_path,
                format!(
                    "References unknown element \"{}\"; existing element ids: {}",
                    target_id, listed
                ),
                "UNKNOWN_ELEMENT",
            );
        }
    }

    // Track state writes for the seed check.
    for output in &op_outputs {
        if as_str(output, "target") == "state" {
            push_unique(&mut checker.state_writes, as_str(output, "targetId").to_string());
        }
    }
    if def.is_some() {
        if let Some(key_input) = kept_inputs.iter().find(|input| as_str(input, "name") == "key") {
            if as_str(key_input, "source") == "constant" {
                push_unique(&mut checker.state_writes, value_or_source_id(key_input));
            }
        }
    }
}
