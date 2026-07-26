//! The runtime kernel behind the same envelope the parts speak: the host
//! writes a JSON request into memory from `der_alloc`, calls `der_run`, and
//! reads the packed `{ok}`/`{err}` response. One import, `env.host_call`,
//! carries operation dispatch and entropy out to whichever host embeds the
//! kernel (Node for the eval harness and the vector suites, a browser for
//! the web face); everything semantic stays inside.

use std::cell::RefCell;
use std::collections::HashMap;

use serde_json::{json, Map, Value};

use der_runtime::entry::{open_session_core, resolve_entry_view, SessionEntry};
use der_runtime::env::{RuntimeEnv, ScriptedEnv};
use der_runtime::session::{DispatchRequest, OperationDispatcher};
use der_runtime::streaming::extract_streaming_contract;
use der_runtime::validation::check_against_manifests;
use der_runtime::vectors::run_family;

#[link(wasm_import_module = "env")]
extern "C" {
    /// The host answers a JSON request with a length-prefixed JSON response
    /// it writes into memory obtained from `der_alloc`: the returned pointer
    /// starts with 4 little-endian length bytes, the payload follows.
    fn host_call(ptr: *const u8, len: usize) -> i32;
}

fn call_host(request: &Value) -> Result<Value, String> {
    let bytes = serde_json::to_vec(request).map_err(|error| error.to_string())?;
    let answer = unsafe { host_call(bytes.as_ptr(), bytes.len()) };
    if answer == 0 {
        return Err("The host did not answer".to_string());
    }
    let base = answer as usize;
    let len = unsafe {
        u32::from_le_bytes(*(base as *const [u8; 4])) as usize
    };
    let payload = unsafe { std::slice::from_raw_parts((base + 4) as *const u8, len) };
    let parsed: Value =
        serde_json::from_slice(payload).map_err(|error| format!("Host reply invalid: {}", error))?;
    // The buffer came from der_alloc inside the import handler; reclaim it.
    unsafe { free_block(base as *mut u8, len + 4) };
    if let Some(err) = parsed.get("err").and_then(Value::as_str) {
        return Err(err.to_string());
    }
    Ok(parsed.get("ok").cloned().unwrap_or(Value::Null))
}

/// Non-builtin operations leave the kernel through the host.
struct HostCallDispatcher;

impl OperationDispatcher for HostCallDispatcher {
    fn dispatch(&self, request: &DispatchRequest) -> Result<Map<String, Value>, String> {
        let reply = call_host(&json!({
            "operation": "dispatch",
            "request": {
                "operationId": request.operation_id,
                "operationName": request.operation_name,
                "inputs": request.inputs,
                "implementation": request.implementation,
            },
        }))?;
        match reply {
            Value::Object(map) => Ok(map),
            _ => Err("The host dispatch returned an invalid result".to_string()),
        }
    }
}

/// Ids, randomness, and the clock from the host, so sessions behave like
/// any production renderer's.
struct HostEnv;

impl RuntimeEnv for HostEnv {
    fn next_id(&mut self) -> String {
        call_host(&json!({ "operation": "env.id" }))
            .ok()
            .and_then(|value| value.as_str().map(str::to_string))
            .unwrap_or_else(|| "id-host-missing".to_string())
    }

    fn next_random(&mut self) -> f64 {
        call_host(&json!({ "operation": "env.random" }))
            .ok()
            .and_then(|value| value.as_f64())
            .unwrap_or(0.0)
    }

    fn epoch_ms(&self) -> i64 {
        call_host(&json!({ "operation": "env.now" }))
            .ok()
            .and_then(|value| value.as_i64())
            .unwrap_or(0)
    }

    fn tz_offset_minutes(&self) -> i32 {
        call_host(&json!({ "operation": "env.tzOffset" }))
            .ok()
            .and_then(|value| value.as_i64())
            .map(|minutes| minutes as i32)
            .unwrap_or(0)
    }
}

struct OpenSession {
    entry: SessionEntry,
    elements: Vec<Value>,
}

thread_local! {
    static SESSIONS: RefCell<HashMap<String, OpenSession>> = RefCell::new(HashMap::new());
}

fn scripted_env(config: &Value) -> Box<dyn RuntimeEnv + Send> {
    Box::new(ScriptedEnv {
        ids: config["ids"]
            .as_array()
            .map(|ids| ids.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default(),
        randoms: config["randoms"]
            .as_array()
            .map(|rolls| rolls.iter().filter_map(Value::as_f64).collect())
            .unwrap_or_default(),
        epoch_ms: config["epochMs"].as_i64().unwrap_or(0),
        tz_offset_minutes: config["tzOffsetMinutes"].as_i64().unwrap_or(0) as i32,
    })
}

fn session_reply(session: &OpenSession) -> Value {
    json!({
        "tree": resolve_entry_view(&session.entry, &session.elements),
        "state": session.entry.session().state().clone(),
    })
}

fn run_operation(request: &Value) -> Result<Value, String> {
    let operation = request
        .get("operation")
        .and_then(Value::as_str)
        .ok_or("Request has no operation")?;
    let text = |key: &str| request.get(key).and_then(Value::as_str).unwrap_or("").to_string();

    match operation {
        // -------------------------------------------------------------
        // Capture surface: the vector generator computes expectations by
        // asking the kernel, so the corpus is authored by the reference
        // implementation itself.
        // -------------------------------------------------------------
        "capture.transform" => {
            let parameters = request
                .get("parameters")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            Ok(json!({
                "value": der_runtime::transforms::apply_transform(
                    &text("name"),
                    request.get("value").unwrap_or(&Value::Null),
                    &parameters,
                )
            }))
        }
        "capture.pipeline" => {
            let steps: Vec<der_runtime::transforms::TransformStep> =
                serde_json::from_value(request.get("steps").cloned().unwrap_or(Value::Null))
                    .map_err(|error| format!("steps: {}", error))?;
            Ok(json!({
                "value": der_runtime::transforms::apply_pipeline(
                    request.get("value").unwrap_or(&Value::Null),
                    &steps,
                )
            }))
        }
        "capture.legacySingle" => {
            let step: der_runtime::transforms::TransformStep =
                serde_json::from_value(request.get("step").cloned().unwrap_or(Value::Null))
                    .map_err(|error| format!("step: {}", error))?;
            Ok(json!({
                "value": der_runtime::transforms::apply_legacy_single(
                    request.get("value").unwrap_or(&Value::Null),
                    &step,
                )
            }))
        }
        "capture.expressionParse" => {
            match der_runtime::expression::parse_row_expression(&text("expression")) {
                Ok(parsed) => Ok(json!({ "identifiers": parsed.identifiers })),
                Err(error) => Ok(json!({ "parseError": error })),
            }
        }
        "capture.expressionEval" => {
            let row = request
                .get("row")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            match der_runtime::expression::parse_row_expression(&text("expression")) {
                Ok(parsed) => match parsed.evaluate(&row) {
                    Ok(value) => Ok(json!({ "value": value })),
                    Err(error) => Ok(json!({ "evalError": error })),
                },
                Err(error) => Ok(json!({ "parseError": error })),
            }
        }
        "capture.operation" => {
            let inputs = request
                .get("inputs")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let mut state = request
                .get("state")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let mut env = der_runtime::vectors::env_from(request);
            match der_runtime::operations::execute_builtin(
                &text("name"),
                &inputs,
                &mut state,
                &mut env,
            ) {
                Ok(outputs) => Ok(json!({ "state": state, "outputs": outputs })),
                Err(error) => Ok(json!({ "state": state, "error": error })),
            }
        }
        "capture.session" => {
            let operations: Vec<der_runtime::session::OperationSpec> =
                serde_json::from_value(request.get("operations").cloned().unwrap_or(Value::Null))
                    .map_err(|error| format!("operations: {}", error))?;
            let elements = request
                .get("elements")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let initial_state = request
                .get("initialState")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let mut session = der_runtime::session::Session::new(
                operations,
                initial_state,
                &elements,
                Box::new(der_runtime::vectors::env_from(request)),
            );
            let mut failed: Vec<String> = Vec::new();
            for event in request.get("events").and_then(Value::as_array).into_iter().flatten() {
                match event.get("do").and_then(Value::as_str) {
                    Some("setElement") => session.set_element(
                        event.get("elementId").and_then(Value::as_str).unwrap_or(""),
                        event.get("value").cloned().unwrap_or(Value::Null),
                    ),
                    Some("chain") => {
                        let ids: Vec<String> = event
                            .get("operationIds")
                            .and_then(Value::as_array)
                            .map(|ids| {
                                ids.iter()
                                    .filter_map(Value::as_str)
                                    .map(str::to_string)
                                    .collect()
                            })
                            .unwrap_or_default();
                        let item = event.get("item").filter(|value| !value.is_null());
                        if let Some(failed_id) = session.run_chain(&ids, item) {
                            failed.push(failed_id);
                        }
                    }
                    other => return Err(format!("Unknown session event {:?}", other)),
                }
            }
            Ok(json!({ "failed": failed, "data": session.state().clone() }))
        }
        "capture.templateFragment" => {
            let instance = request
                .get("instance")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let def = request
                .get("def")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            match der_runtime::templates::expand_ui_fragment(&instance, &def) {
                Ok(expanded) => Ok(json!({ "value": expanded })),
                Err(error) => Ok(json!({ "expandError": error })),
            }
        }
        "capture.templatePack" => {
            let instance = request
                .get("instance")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let def = request
                .get("def")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            Ok(json!({
                "value": der_runtime::templates::instantiate_pack_operations(&instance, &def)
            }))
        }
        "capture.view" => {
            let elements = request
                .get("elements")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let state = request
                .get("state")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let fragment_defs = request
                .get("fragmentDefs")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let ctx = der_runtime::view::ViewContext {
                state: &state,
                fragment_defs: &fragment_defs,
            };
            let tree = der_runtime::vectors::strip_null_keys(&Value::Array(
                der_runtime::view::resolve_view_tree(&elements, &ctx),
            ));
            Ok(json!({ "tree": tree }))
        }
        "capture.streamingPartial" => {
            Ok(json!({ "partial": der_runtime::streaming::parse_partial_json(&text("raw")) }))
        }
        "capture.promptSections" => Ok(json!({
            "create": der_runtime::prompt::CREATE_PROMPT_SECTION,
            "blueprint": der_runtime::prompt::BLUEPRINT_PROMPT_SECTION,
            "edit": der_runtime::prompt::EDIT_PROMPT_SECTION,
        })),
        "capture.promptBase" => {
            let vocab = der_runtime::vectors::compose_vocabulary(request);
            let compact = request.get("compact").and_then(Value::as_bool).unwrap_or(false);
            Ok(json!({
                "base": der_runtime::prompt::build_base_prompt(
                    &der_runtime::prompt::render_catalog_text(&vocab, compact),
                    compact,
                )
            }))
        }
        "capture.parseValidated" => {
            let vocab = der_runtime::vectors::compose_vocabulary(request);
            let schema_name = text("schema");
            let schema = if schema_name == "contract" {
                der_runtime::llm_schema::SchemaKind::Contract
            } else {
                der_runtime::llm_schema::SchemaKind::Composed
            };
            let mut semantic = der_runtime::vectors::compose_semantic(
                if schema_name == "contract" { "contract" } else { "composed" },
                &vocab,
            );
            match der_runtime::llm_schema::parse_validated_json(&text("raw"), &schema, &mut semantic)
            {
                der_runtime::llm_schema::ParseVerdict::Ok(value) => {
                    Ok(json!({ "ok": true, "value": value }))
                }
                der_runtime::llm_schema::ParseVerdict::Problem(problem) => {
                    Ok(json!({ "ok": false, "problem": problem }))
                }
            }
        }
        "capture.checkComposed" => {
            let vocab = der_runtime::vectors::compose_vocabulary(request);
            let mut value = request.get("value").cloned().unwrap_or(Value::Null);
            let (problems, warnings) =
                der_runtime::compose::check_composed_candidate(&mut value, &vocab);
            Ok(json!({ "problems": problems, "warnings": warnings, "value": value }))
        }
        "capture.finalize" => {
            let vocab = der_runtime::vectors::compose_vocabulary(request);
            Ok(json!({
                "contract": der_runtime::compose::finalize_contract_shape(
                    request.get("shape").unwrap_or(&Value::Null),
                    request.get("description").and_then(Value::as_str),
                    &text("nowIso"),
                    &vocab,
                )
            }))
        }
        "capture.composeLoop" => {
            let vocab = der_runtime::vectors::compose_vocabulary(request);
            let schema_name = text("schema");
            let schema = if schema_name == "contract" {
                der_runtime::llm_schema::SchemaKind::Contract
            } else {
                der_runtime::llm_schema::SchemaKind::Composed
            };
            let responses: Vec<String> = request
                .get("responses")
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            let mut llm = der_runtime::vectors::ScriptedLlm {
                provider: text("provider"),
                responses,
                index: 0,
                calls: Vec::new(),
            };
            let messages = request
                .get("messages")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let options = der_runtime::compose::GenerateOptions {
                label: "Contract".to_string(),
                max_tokens: Some(16000),
                system_blocks: vec![
                    der_runtime::compose::SystemBlockSpec {
                        text: "BASE".to_string(),
                        cache: true,
                    },
                    der_runtime::compose::SystemBlockSpec {
                        text: "MODE".to_string(),
                        cache: false,
                    },
                ],
            };
            let mut semantic = der_runtime::vectors::compose_semantic(
                if schema_name == "contract" { "contract" } else { "composed" },
                &vocab,
            );
            let outcome = der_runtime::vectors::block_on(
                der_runtime::compose::generate_validated_json(
                    &mut llm,
                    messages,
                    schema,
                    options,
                    &mut semantic,
                    None,
                ),
            );
            let outcome_json = match outcome {
                Ok(value) => json!({ "ok": true, "value": value }),
                Err(error) => json!({ "ok": false, "error": error }),
            };
            Ok(json!({ "outcome": outcome_json, "calls": llm.calls }))
        }
        "capture.judgeComposed" => {
            let vocab = der_runtime::vectors::compose_vocabulary(request);
            let expect_recipe = request.get("expectRecipe").and_then(Value::as_str);
            let mut noop = |_value: &mut Value| Vec::<String>::new();
            let parsed = der_runtime::llm_schema::parse_validated_json(
                &text("raw"),
                &der_runtime::llm_schema::SchemaKind::Composed,
                &mut noop,
            );
            let mut value = match parsed {
                der_runtime::llm_schema::ParseVerdict::Problem(problem) => {
                    let verdict = if problem.starts_with("The response was not parseable JSON:") {
                        "unparseable"
                    } else {
                        "schema"
                    };
                    return Ok(json!({ "verdict": verdict, "errors": problem }));
                }
                der_runtime::llm_schema::ParseVerdict::Ok(value) => value,
            };
            if let Some(name) = value.get("recipe").and_then(Value::as_str).map(str::to_string) {
                if Some(name.as_str()) != expect_recipe {
                    let errors = match expect_recipe {
                        Some(expected) => format!("reused {}, expected {}", name, expected),
                        None => format!("reused {} where composing was expected", name),
                    };
                    return Ok(json!({
                        "verdict": "recipe-mismatch",
                        "recipe": name,
                        "errors": errors,
                    }));
                }
                let (problems, _warnings) =
                    der_runtime::compose::check_composed_candidate(&mut value, &vocab);
                if !problems.is_empty() {
                    return Ok(json!({
                        "verdict": "manifest",
                        "recipe": name,
                        "errors": problems.join("\n"),
                    }));
                }
                let contract = vocab
                    .recipes
                    .get(&name)
                    .and_then(|def| def.get("contract"))
                    .cloned()
                    .unwrap_or(Value::Null);
                return Ok(json!({
                    "verdict": "pass",
                    "recipe": name,
                    "adjustments": 0,
                    "contract": contract,
                }));
            }
            if let Some(expected) = expect_recipe {
                return Ok(json!({
                    "verdict": "no-reuse",
                    "errors": format!("composed a contract where recipe {} was expected", expected),
                }));
            }
            let mut contract = value.get("contract").cloned().unwrap_or(Value::Null);
            let outcome = check_against_manifests(
                &mut contract,
                &vocab.fragment_defs,
                &vocab.part_operations,
                &vocab.credentials,
            );
            if !outcome.errors.is_empty() {
                return Ok(json!({
                    "verdict": "manifest",
                    "errors": der_runtime::compose::format_manifest_errors(&outcome.errors),
                }));
            }
            Ok(json!({
                "verdict": "pass",
                "adjustments": outcome.warnings.len(),
                "contract": contract,
            }))
        }
        "vectors.runFamily" => {
            let family = text("family");
            let fixtures = request.get("fixtures").cloned().unwrap_or(Value::Null);
            let failures = run_family(&family, &fixtures)?;
            Ok(json!({ "failures": failures }))
        }
        "contract.check" => {
            // The human checker: structural schema then the manifest gate,
            // with the same string verdicts as the runtime_check_contract
            // command in the desktop core.
            let vocab = der_runtime::vectors::compose_vocabulary(request);
            let raw =
                serde_json::to_string(request.get("contract").unwrap_or(&Value::Null))
                    .map_err(|error| error.to_string())?;
            let verdict = der_runtime::compose::check_contract_json(&raw, &vocab);
            Ok(json!({
                "shape": verdict.shape,
                "errors": verdict.errors,
                "warnings": verdict.warnings,
            }))
        }
        "validate.check" => {
            let mut contract = request.get("contract").cloned().unwrap_or(Value::Null);
            let empty = Map::new();
            let fragment_defs = request
                .get("fragmentDefs")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or(empty.clone());
            let part_operations = request
                .get("partOperations")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or(empty);
            let credentials: Vec<Value> = request
                .get("credentials")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let outcome = check_against_manifests(
                &mut contract,
                &fragment_defs,
                &part_operations,
                &credentials,
            );
            Ok(json!({
                "errors": outcome.errors,
                "warnings": outcome.warnings,
                "contract": contract,
            }))
        }
        "streaming.extract" => {
            let accumulated = text("accumulated");
            Ok(json!({ "contract": extract_streaming_contract(&accumulated) }))
        }
        "session.open" => {
            let session_id = text("sessionId");
            if session_id.is_empty() {
                return Err("session.open needs a sessionId".to_string());
            }
            let contract = request.get("contract").cloned().unwrap_or(Value::Null);
            let initial_data = request
                .get("initialData")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let fragment_defs = request
                .get("fragmentDefs")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let env: Box<dyn RuntimeEnv + Send> = match request.get("env") {
                Some(config) if config.is_object() => scripted_env(config),
                _ => Box::new(HostEnv),
            };
            let entry = open_session_core(
                &contract,
                initial_data,
                fragment_defs,
                env,
                Some(Box::new(HostCallDispatcher)),
            )?;
            let elements = contract
                .get("elements")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let _ = entry.session();
            let session = OpenSession { entry, elements };
            let reply = session_reply(&session);
            SESSIONS.with(|sessions| sessions.borrow_mut().insert(session_id, session));
            Ok(reply)
        }
        "session.setElement" => SESSIONS.with(|sessions| {
            let mut sessions = sessions.borrow_mut();
            let session = sessions
                .get_mut(&text("sessionId"))
                .ok_or("No such session")?;
            session
                .entry
                .session_mut()
                .set_element(&text("elementId"), request.get("value").cloned().unwrap_or(Value::Null));
            Ok(session_reply(session))
        }),
        "session.dispatch" => SESSIONS.with(|sessions| {
            let mut sessions = sessions.borrow_mut();
            let session = sessions
                .get_mut(&text("sessionId"))
                .ok_or("No such session")?;
            let operation_ids: Vec<String> = request
                .get("operationIds")
                .and_then(Value::as_array)
                .map(|ids| ids.iter().filter_map(Value::as_str).map(str::to_string).collect())
                .unwrap_or_default();
            let item = request.get("item").filter(|value| !value.is_null()).cloned();
            let outcome = session
                .entry
                .session_mut()
                .run_chain_detailed(&operation_ids, item.as_ref());
            let (failed, error) = match outcome {
                Some((operation_id, message)) => (Some(operation_id), Some(message)),
                None => (None, None),
            };
            let mut reply = session_reply(session);
            reply["failed"] = json!(failed);
            reply["error"] = json!(error);
            Ok(reply)
        }),
        "session.resolve" => SESSIONS.with(|sessions| {
            let sessions = sessions.borrow();
            let session = sessions.get(&text("sessionId")).ok_or("No such session")?;
            Ok(session_reply(session))
        }),
        "session.close" => {
            SESSIONS.with(|sessions| sessions.borrow_mut().remove(&text("sessionId")));
            Ok(json!({}))
        }
        other => Err(format!("Unknown kernel operation {}", other)),
    }
}

// ---------------------------------------------------------------------------
// The envelope ABI, shared with the parts.
// ---------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn der_alloc(len: usize) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(len.max(1));
    let ptr = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    ptr
}

/// Frees a block produced by `der_alloc` (the host calls this after copying
/// a response out; the kernel calls it for host replies).
#[no_mangle]
pub extern "C" fn der_free(ptr: *mut u8, len: usize) {
    unsafe { free_block(ptr, len) };
}

unsafe fn free_block(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        drop(Vec::from_raw_parts(ptr, 0, len.max(1)));
    }
}

#[no_mangle]
pub extern "C" fn der_run(ptr: *const u8, len: usize) -> i64 {
    let request_bytes = unsafe { std::slice::from_raw_parts(ptr, len) }.to_vec();
    unsafe { free_block(ptr as *mut u8, len) };
    let response = match serde_json::from_slice::<Value>(&request_bytes) {
        Ok(request) => match run_operation(&request) {
            Ok(ok) => json!({ "ok": ok }),
            Err(err) => json!({ "err": err }),
        },
        Err(error) => json!({ "err": format!("Invalid request: {}", error) }),
    };
    let bytes = serde_json::to_vec(&response).unwrap_or_else(|_| b"{\"err\":\"encode\"}".to_vec());
    let out_len = bytes.len();
    let out_ptr = der_alloc(out_len);
    unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), out_ptr, out_len) };
    ((out_ptr as i64) << 32) | (out_len as i64)
}
