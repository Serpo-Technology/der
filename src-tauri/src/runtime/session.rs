//! A headless experience session: state initialization, declarative input
//! resolution, builtin execution, and output routing, mirroring the webview's
//! ExperienceStateManager plus OperationExecutor seam exactly (the quirks
//! included: constants use a present "value" field even when null, an output
//! name missing from a result routes the whole result, and ui-element
//! property outputs merge into a sub-object). Operations the kernel cannot
//! run here (local code, remote endpoints, installed part operations,
//! http.get) fail with a resolution error; the host dispatcher owns those.

use serde_json::{Map, Value};

use super::env::RuntimeEnv;
use super::operations::{execute_builtin, is_builtin};
use super::transforms::{apply_legacy_single_with, apply_pipeline_with, TransformStep};
use super::value::get_value_at_path;

/// One non-builtin execution request. The host dispatcher routes it: wasm
/// compute parts, integration part remotes, contract remote endpoints, and
/// http.get; secrets and confinement stay host-side.
pub struct DispatchRequest<'a> {
    pub operation_id: &'a str,
    pub operation_name: &'a str,
    /// Resolved flat inputs (structured prefixes still flat).
    pub inputs: &'a Map<String, Value>,
    pub implementation: Option<&'a Map<String, Value>>,
}

pub trait OperationDispatcher: Send {
    fn dispatch(&self, request: &DispatchRequest) -> Result<Map<String, Value>, String>;
}

fn deserialize_present<'de, D>(deserializer: D) -> Result<Option<Value>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    // A present null must stay Some(Null): the webview distinguishes a
    // constant whose typed value IS null from one with no typed value.
    serde::Deserialize::deserialize(deserializer).map(Some)
}

#[derive(serde::Deserialize, Clone)]
pub struct InputBinding {
    pub name: String,
    #[serde(default)]
    pub source: String,
    #[serde(rename = "sourceId", default)]
    pub source_id: String,
    #[serde(default, deserialize_with = "deserialize_present")]
    pub value: Option<Value>,
    #[serde(default)]
    pub transforms: Option<Vec<TransformStep>>,
    #[serde(default)]
    pub transform: Option<TransformStep>,
}

#[derive(serde::Deserialize, Clone)]
pub struct OutputBinding {
    pub name: String,
    #[serde(default)]
    pub target: String,
    #[serde(rename = "targetId", default)]
    pub target_id: String,
    #[serde(default)]
    pub property: Option<String>,
    #[serde(default)]
    pub transforms: Option<Vec<TransformStep>>,
    #[serde(default)]
    pub transform: Option<TransformStep>,
}

#[derive(serde::Deserialize, Clone)]
pub struct OperationSpec {
    pub id: String,
    #[serde(rename = "operationName")]
    pub operation_name: String,
    #[serde(rename = "executionType", default)]
    pub execution_type: Option<String>,
    #[serde(default)]
    pub inputs: Vec<InputBinding>,
    #[serde(default)]
    pub outputs: Vec<OutputBinding>,
    #[serde(default)]
    pub implementation: Option<Map<String, Value>>,
}

pub struct Session {
    operations: Vec<OperationSpec>,
    state: Map<String, Value>,
    env: Box<dyn RuntimeEnv + Send>,
    dispatcher: Option<Box<dyn OperationDispatcher>>,
}

impl Session {
    /// Mirrors initializeState: contract seeds, then per-operation output
    /// placeholders, then element defaultValue seeds down the tree.
    pub fn new(
        operations: Vec<OperationSpec>,
        initial_state: Map<String, Value>,
        elements: &[Value],
        env: Box<dyn RuntimeEnv + Send>,
    ) -> Self {
        let mut state = initial_state;
        for operation in &operations {
            for output in &operation.outputs {
                state.insert(
                    format!("operation_{}_{}", operation.id, output.name),
                    Value::Null,
                );
            }
        }
        seed_element_defaults(elements, &mut state);
        Self { operations, state, env, dispatcher: None }
    }

    pub fn set_dispatcher(&mut self, dispatcher: Box<dyn OperationDispatcher>) {
        self.dispatcher = Some(dispatcher);
    }

    pub fn state(&self) -> &Map<String, Value> {
        &self.state
    }

    /// The auto-controlled input write: element values live under element_<id>.
    pub fn set_element(&mut self, element_id: &str, value: Value) {
        self.state
            .insert(format!("element_{}", element_id), value);
    }

    /// Runs operation ids in order with the chain rule: the first failure
    /// stops the rest, earlier state writes stand. Returns the failed id.
    pub fn run_chain(&mut self, operation_ids: &[String], item: Option<&Value>) -> Option<String> {
        for operation_id in operation_ids {
            if self.run_operation(operation_id, item).is_err() {
                return Some(operation_id.clone());
            }
        }
        None
    }

    pub fn run_operation(&mut self, operation_id: &str, item: Option<&Value>) -> Result<(), String> {
        let operation = self
            .operations
            .iter()
            .find(|op| op.id == operation_id)
            .cloned()
            .ok_or_else(|| format!("Operation {} not found in contract", operation_id))?;

        let implementation = operation.implementation.as_ref();
        let has_code = implementation.is_some_and(|imp| imp.get("code").is_some());
        if matches!(operation.execution_type.as_deref(), Some("local")) || has_code {
            return Err(format!(
                "Local operation {} runs only in the webview renderer",
                operation.id
            ));
        }

        let inputs = self.resolve_inputs(&operation, item);
        let result = if is_builtin(&operation.operation_name) {
            execute_builtin(
                &operation.operation_name,
                &inputs,
                &mut self.state,
                self.env.as_mut(),
            )?
        } else if let Some(dispatcher) = &self.dispatcher {
            dispatcher.dispatch(&DispatchRequest {
                operation_id: &operation.id,
                operation_name: &operation.operation_name,
                inputs: &inputs,
                implementation,
            })?
        } else {
            let has_endpoint = implementation.is_some_and(|imp| imp.get("endpoint").is_some());
            return Err(if has_endpoint
                || matches!(operation.execution_type.as_deref(), Some("remote"))
            {
                format!("Remote operation {} needs the host dispatcher", operation.id)
            } else {
                format!(
                    "Unknown operation \"{}\" ({}): not a builtin and no runnable implementation",
                    operation.operation_name, operation.id
                )
            });
        };
        self.route_outputs(&operation, &Value::Object(result));
        Ok(())
    }

    fn resolve_inputs(&self, operation: &OperationSpec, item: Option<&Value>) -> Map<String, Value> {
        let mut inputs = Map::new();
        for binding in &operation.inputs {
            inputs.insert(binding.name.clone(), self.resolve_input(binding, item));
        }
        inputs
    }

    fn resolve_input(&self, binding: &InputBinding, item: Option<&Value>) -> Value {
        let raw = match binding.source.as_str() {
            "ui-element" => self.read(&format!("element_{}", binding.source_id)),
            "state" => self.read(&binding.source_id),
            "constant" => match &binding.value {
                Some(value) => value.clone(),
                None => Value::String(binding.source_id.clone()),
            },
            "item" => match item {
                Some(scope) => get_value_at_path(scope, &binding.source_id),
                None => Value::Null,
            },
            _ => Value::Null,
        };
        let lookup = |source: &str, source_id: &str| -> Value {
            if source == "element" {
                self.read(&format!("element_{}", source_id))
            } else {
                self.read(source_id)
            }
        };
        self.apply_binding(&raw, &binding.transforms, &binding.transform, Some(&lookup))
    }

    /// updateStateFromOperationResult: the whole-result mirror, per-output
    /// routing (output transforms run WITHOUT live lookup, as the webview
    /// passes no context there), and per-output operation_ keys.
    fn route_outputs(&mut self, operation: &OperationSpec, result: &Value) {
        self.state
            .insert(format!("operation_{}", operation.id), result.clone());
        for output in &operation.outputs {
            let extracted = extract_result_value(result, &output.name);
            let value =
                self.apply_binding(&extracted, &output.transforms, &output.transform, None);
            match output.target.as_str() {
                "state" => {
                    self.state.insert(output.target_id.clone(), value.clone());
                }
                "ui-element" => {
                    let element_key = format!("element_{}", output.target_id);
                    match &output.property {
                        Some(property) => {
                            let mut object = match self.state.get(&element_key) {
                                Some(Value::Object(existing)) => existing.clone(),
                                // undefined becomes {value: undefined}, which
                                // serializes to an empty object; null and
                                // primitives keep their value entry.
                                None => Map::new(),
                                Some(existing) => {
                                    let mut wrapped = Map::new();
                                    wrapped.insert("value".to_string(), existing.clone());
                                    wrapped
                                }
                            };
                            object.insert(property.clone(), value.clone());
                            self.state.insert(element_key, Value::Object(object));
                        }
                        None => {
                            self.state.insert(element_key, value.clone());
                        }
                    }
                }
                _ => {}
            }
            self.state.insert(
                format!("operation_{}_{}", operation.id, output.name),
                value,
            );
        }
    }

    fn apply_binding(
        &self,
        value: &Value,
        transforms: &Option<Vec<TransformStep>>,
        single: &Option<TransformStep>,
        lookup: Option<super::transforms::ParamLookup>,
    ) -> Value {
        if let Some(steps) = transforms {
            if !steps.is_empty() {
                return apply_pipeline_with(value, steps, lookup);
            }
        }
        if let Some(step) = single {
            return apply_legacy_single_with(value, step, lookup);
        }
        value.clone()
    }

    fn read(&self, key: &str) -> Value {
        self.state.get(key).cloned().unwrap_or(Value::Null)
    }
}

fn seed_element_defaults(elements: &[Value], state: &mut Map<String, Value>) {
    for element in elements {
        if let Some(default) = element
            .get("properties")
            .and_then(|props| props.get("defaultValue"))
        {
            if let Some(id) = element.get("id").and_then(Value::as_str) {
                state.insert(format!("element_{}", id), default.clone());
            }
        }
        if let Some(children) = element.get("children").and_then(Value::as_array) {
            seed_element_defaults(children, state);
        }
    }
}

/// extractResultValue: a missing output name routes the whole result.
fn extract_result_value(result: &Value, output_name: &str) -> Value {
    match result {
        Value::Object(map) => match map.get(output_name) {
            Some(value) => value.clone(),
            None => result.clone(),
        },
        other => other.clone(),
    }
}
