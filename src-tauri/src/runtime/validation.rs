//! The manifest checker's Rust port, grown rule family by rule family under
//! the validation vectors. This module carries the structural spine: the
//! element and operation bookkeeping walk, styling normalization, the
//! entry-row alignment fix, unknown and orphaned operation rules, dead
//! controls, and the seed pass. Error paths, codes, and message text match
//! the webview checker byte for byte, because those messages feed the
//! repair round and their wording is semantic. Families not yet ported
//! stay silent; the vectors are scoped accordingly.

use serde_json::{json, Map, Value};

use super::operations::is_builtin;

const STYLE_THEMES: [&str; 4] = ["default", "dark", "paper", "terminal"];
const STYLE_ACCENTS: [&str; 5] = ["blue", "green", "violet", "rose", "amber"];

pub struct CheckOutcome {
    pub errors: Vec<Value>,
    pub warnings: Vec<Value>,
}

fn error(path: &str, message: String, code: &str) -> Value {
    json!({ "path": path, "message": message, "code": code })
}

fn warning(path: &str, message: String) -> Value {
    json!({ "path": path, "message": message, "code": "MANIFEST_ADJUSTED" })
}

fn as_str<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

/// The registry names the webview checker resolves through getOperationDef.
fn is_registry_operation(name: &str) -> bool {
    is_builtin(name) || name == "http.get"
}

/// Which builtin operations take a required "key" constant that counts as a
/// state write (every state-writing builtin does).
fn writes_key_state(name: &str) -> bool {
    is_builtin(name) && name != "math.add" && name != "time.now" && name != "random.int"
        && name != "random.pick"
}

struct Walkden {
    element_ids: Vec<String>,
    control_candidates: Vec<(String, String, String)>,
    referenced_operation_ids: Vec<String>,
    missing_operation_refs: Vec<String>,
    state_reads: Vec<(String, String)>,
}

impl Walkden {
    fn note_read(&mut self, key: &str, reader: &str) {
        let is_array_reader = reader == "items" || reader == "options";
        if let Some(existing) = self.state_reads.iter_mut().find(|(k, _)| k == key) {
            let existing_reader = existing.1.clone();
            if is_array_reader && existing_reader != "items" && existing_reader != "options" {
                existing.1 = reader.to_string();
            }
        } else {
            self.state_reads.push((key.to_string(), reader.to_string()));
        }
    }
}

/// The structural spine of checkAgainstManifests, mutating the contract in
/// place exactly like the webview (styling normalization, entry-row align,
/// state seeding).
pub fn check_structural(contract: &mut Value) -> CheckOutcome {
    let mut errors: Vec<Value> = Vec::new();
    let mut warnings: Vec<Value> = Vec::new();

    // Styling is cosmetic vocabulary: unknown values normalize with a warning.
    if let Some(styling) = contract.get_mut("styling").and_then(Value::as_object_mut) {
        if let Some(theme) = styling.get("theme").and_then(Value::as_str).map(str::to_string) {
            if !theme.is_empty() && !STYLE_THEMES.contains(&theme.as_str()) {
                warnings.push(warning(
                    "styling.theme",
                    format!(
                        "\"{}\" is not one of {}; using \"default\"",
                        theme,
                        STYLE_THEMES.join("|")
                    ),
                ));
                styling.insert("theme".to_string(), Value::String("default".to_string()));
            }
        }
        if let Some(accent) = styling.get("accent").and_then(Value::as_str).map(str::to_string) {
            if !accent.is_empty() && !STYLE_ACCENTS.contains(&accent.as_str()) {
                warnings.push(warning(
                    "styling.accent",
                    format!(
                        "\"{}\" is not one of {}; accent removed",
                        accent,
                        STYLE_ACCENTS.join("|")
                    ),
                ));
                styling.remove("accent");
            }
        }
    }

    let operations: Vec<Value> = contract
        .get("operations")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let operation_ids: Vec<String> = operations
        .iter()
        .map(|op| as_str(op, "id").to_string())
        .collect();

    let mut walk = Walkden {
        element_ids: Vec::new(),
        control_candidates: Vec::new(),
        referenced_operation_ids: Vec::new(),
        missing_operation_refs: Vec::new(),
        state_reads: Vec::new(),
    };

    // Element walk: entry-row alignment, ids, control candidates, state
    // reads, and event references, in the webview's visit order.
    walk_elements(
        contract.get_mut("elements").and_then(Value::as_array_mut),
        "elements",
        false,
        &operation_ids,
        &mut walk,
        &mut errors,
        &mut warnings,
    );

    // A model that wires events but forgets the operations array needs the
    // fix stated outright, ahead of the per-binding errors.
    if !walk.missing_operation_refs.is_empty() && operations.is_empty() {
        errors.insert(
            0,
            error(
                "operations",
                format!(
                    "The contract has no \"operations\" array but elements reference {} operation id(s): {}. Add a top-level \"operations\" array with one entry per referenced id.",
                    walk.missing_operation_refs.len(),
                    walk.missing_operation_refs.join(", ")
                ),
                "MISSING_OPERATIONS",
            ),
        );
    }

    // Operations against manifests: the spine covers name resolution, element
    // references, and the write bookkeeping the seed pass needs.
    let mut state_writes: Vec<String> = contract
        .get("initialState")
        .and_then(Value::as_object)
        .map(|seed| seed.keys().cloned().collect())
        .unwrap_or_default();
    let mut consumed_element_ids: Vec<String> = Vec::new();
    for op in &operations {
        for input in op.get("inputs").and_then(Value::as_array).into_iter().flatten() {
            if as_str(input, "source") == "ui-element" {
                consumed_element_ids.push(as_str(input, "sourceId").to_string());
            }
        }
        for output in op.get("outputs").and_then(Value::as_array).into_iter().flatten() {
            if as_str(output, "target") == "ui-element" {
                consumed_element_ids.push(as_str(output, "targetId").to_string());
            }
        }
    }

    for (index, op) in operations.iter().enumerate() {
        let op_path = format!("operations.{}", index);
        let name = as_str(op, "operationName");
        let implementation = op.get("implementation").and_then(Value::as_object);
        let has_endpoint = implementation.is_some_and(|imp| imp.get("endpoint").is_some());
        let has_code = implementation.is_some_and(|imp| imp.get("code").is_some());
        if !is_registry_operation(name) && !has_endpoint && !has_code {
            errors.push(error(
                &op_path,
                format!(
                    "\"{}\" is not a builtin operation and has no remote endpoint. Use an exact builtin name from the catalog or a remote implementation.",
                    name
                ),
                "UNKNOWN_OPERATION_NAME",
            ));
            continue;
        }

        for (input_index, input) in op
            .get("inputs")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
        {
            let source = as_str(input, "source");
            let source_id = as_str(input, "sourceId");
            if source == "ui-element" && !walk.element_ids.iter().any(|id| id == source_id) {
                let shown: Vec<&str> = walk.element_ids.iter().map(String::as_str).take(30).collect();
                let listed = if walk.element_ids.len() > 30 {
                    format!("{}, ...", shown.join(", "))
                } else {
                    shown.join(", ")
                };
                errors.push(error(
                    &format!("{}.inputs.{}", op_path, input_index),
                    format!(
                        "References unknown element \"{}\"; existing element ids: {}",
                        source_id, listed
                    ),
                    "UNKNOWN_ELEMENT",
                ));
            }
            if source == "state" && !source_id.is_empty() {
                let known = walk.state_reads.iter().any(|(key, _)| key == source_id);
                if !known {
                    walk.note_read(source_id, &format!("input:{}", as_str(input, "name")));
                }
            }
        }

        for output in op.get("outputs").and_then(Value::as_array).into_iter().flatten() {
            if as_str(output, "target") == "state" {
                state_writes.push(as_str(output, "targetId").to_string());
            }
        }
        if writes_key_state(name) {
            if let Some(key_input) = op
                .get("inputs")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .find(|input| as_str(input, "name") == "key")
            {
                if as_str(key_input, "source") == "constant" {
                    let key = key_input
                        .get("value")
                        .and_then(Value::as_str)
                        .unwrap_or(as_str(key_input, "sourceId"));
                    state_writes.push(key.to_string());
                }
            }
        }
    }

    // An operation nothing runs is a dead feature.
    for (index, op) in operations.iter().enumerate() {
        let id = as_str(op, "id");
        let has_triggers = op
            .get("triggers")
            .and_then(Value::as_array)
            .is_some_and(|triggers| !triggers.is_empty());
        if !walk.referenced_operation_ids.iter().any(|r| r == id) && !has_triggers {
            errors.push(error(
                &format!("operations.{}", index),
                format!(
                    "Nothing runs operation \"{}\"; wire it to an element event (a click, change, or timer tick) or remove it",
                    id
                ),
                "ORPHAN_OPERATION",
            ));
        }
    }

    // A control nothing consumes does nothing when used.
    for (id, element_type, path) in &walk.control_candidates {
        if consumed_element_ids.iter().any(|c| c == id) {
            continue;
        }
        let wiring = if element_type == "button" {
            "give it an eventBinding that runs an operation"
        } else {
            "read it from an operation input ({\"source\": \"ui-element\"}), reference it live from a filter parameter ({\"source\": \"element\"}), or give it a change binding"
        };
        errors.push(error(
            path,
            format!("{} \"{}\" affects nothing: {}, or remove it", element_type, id, wiring),
            "DEAD_CONTROL",
        ));
    }

    // Seed state keys that are read but never written.
    for (key, first_reader) in &walk.state_reads {
        if state_writes.iter().any(|written| written == key) {
            continue;
        }
        let seed = if first_reader == "items" || first_reader == "options" {
            Value::Array(Vec::new())
        } else {
            Value::Null
        };
        let seed_is_null = seed.is_null();
        let initial = contract
            .as_object_mut()
            .expect("contract object")
            .entry("initialState".to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        if let Some(map) = initial.as_object_mut() {
            map.insert(key.clone(), seed);
        }
        if seed_is_null {
            warnings.push(warning(
                &format!("initialState.{}", key),
                format!("State key \"{}\" was read but never written; seeded with null", key),
            ));
        }
    }

    CheckOutcome { errors, warnings }
}

#[allow(clippy::too_many_arguments)]
fn walk_elements(
    elements: Option<&mut Vec<Value>>,
    parent_path: &str,
    in_list_template: bool,
    operation_ids: &[String],
    walk: &mut Walkden,
    errors: &mut Vec<Value>,
    warnings: &mut Vec<Value>,
) {
    let Some(elements) = elements else { return };
    for (index, element) in elements.iter_mut().enumerate() {
        let path = format!("{}.{}", parent_path, index);
        fix_centered_entry_rows(element, &path, warnings);

        let id = as_str(element, "id").to_string();
        let element_type = as_str(element, "type").to_string();
        walk.element_ids.push(id.clone());

        const INTERACTIVE_TYPES: [&str; 5] = ["button", "input", "select", "textarea", "checkbox"];
        let event_bindings = element
            .get("eventBindings")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if INTERACTIVE_TYPES.contains(&element_type.as_str())
            && !in_list_template
            && event_bindings.is_empty()
        {
            walk.control_candidates
                .push((id.clone(), element_type.clone(), path.clone()));
        }

        for binding in element
            .get("dataBindings")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if as_str(binding, "source") == "state" {
                let source_id = as_str(binding, "sourceId");
                if !source_id.is_empty() {
                    walk.note_read(source_id, as_str(binding, "property"));
                }
            }
        }

        if let Some(conditions) = element.get("visibleWhen") {
            let listed: Vec<&Value> = match conditions {
                Value::Array(list) => list.iter().collect(),
                other => vec![other],
            };
            for condition in listed {
                if as_str(condition, "source") == "state" {
                    let source_id = as_str(condition, "sourceId");
                    let known = walk.state_reads.iter().any(|(key, _)| key == source_id);
                    if !known {
                        walk.note_read(source_id, "visibleWhen");
                    }
                }
            }
        }

        for (binding_index, binding) in event_bindings.iter().enumerate() {
            let operation_id = as_str(binding, "operationId").to_string();
            walk.referenced_operation_ids.push(operation_id.clone());
            if !operation_ids.iter().any(|known| known == &operation_id) {
                walk.missing_operation_refs.push(operation_id.clone());
                let defined = if operation_ids.is_empty() {
                    "none".to_string()
                } else {
                    operation_ids.join(", ")
                };
                errors.push(error(
                    &format!("{}.eventBindings.{}", path, binding_index),
                    format!(
                        "Event \"{}\" references unknown operation \"{}\"; defined operation ids: {}",
                        as_str(binding, "event"),
                        operation_id,
                        defined
                    ),
                    "UNKNOWN_OPERATION",
                ));
            }
        }

        let child_template = in_list_template
            || (element_type == "list"
                && element
                    .get("children")
                    .and_then(Value::as_array)
                    .is_some_and(|children| !children.is_empty()));
        walk_elements(
            element.get_mut("children").and_then(Value::as_array_mut),
            &format!("{}.children", path),
            child_template,
            operation_ids,
            walk,
            errors,
            warnings,
        );
    }
}

fn fix_centered_entry_rows(element: &mut Value, path: &str, warnings: &mut Vec<Value>) {
    let element_type = as_str(element, "type").to_string();
    if element_type != "container" && element_type != "form" {
        return;
    }
    let is_centered_row = element
        .get("properties")
        .and_then(Value::as_object)
        .is_some_and(|props| {
            props.get("align").and_then(Value::as_str) == Some("center")
                && props.get("direction").and_then(Value::as_str) != Some("column")
        });
    if !is_centered_row {
        return;
    }
    const INPUT_LIKE: [&str; 3] = ["input", "select", "textarea"];
    let children = element
        .get("children")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let has_labeled_field = children.iter().any(|child| {
        INPUT_LIKE.contains(&as_str(child, "type"))
            && child
                .get("properties")
                .and_then(|props| props.get("label"))
                .is_some_and(|label| super::value::js_truthy(label))
    });
    let has_other_control = children
        .iter()
        .any(|child| !INPUT_LIKE.contains(&as_str(child, "type")));
    if has_labeled_field && has_other_control {
        if let Some(props) = element
            .get_mut("properties")
            .and_then(Value::as_object_mut)
        {
            props.insert("align".to_string(), Value::String("end".to_string()));
        }
        warnings.push(warning(
            &format!("{}.properties.align", path),
            "Row mixes labeled fields with other controls; align \"center\" floats them, using \"end\"".to_string(),
        ));
    }
}
