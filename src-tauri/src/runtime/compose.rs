//! Compose orchestration: the Rust twin of composeFromDescription and
//! generateValidatedJson. One model call returns the spec header plus either
//! a composed contract or an installed recipe reference; the response runs
//! extraction, structural validation, and the manifest checker, with one
//! repair round (two on cheap fast providers) feeding every problem back
//! before failing. Finalization then normalizes the validated shape into a
//! renderable contract. The compose vectors freeze the prompt text, the
//! acceptance pipeline, finalization, and the repair-loop protocol.

use std::future::Future;
use std::pin::Pin;

use serde_json::{json, Map, Value};

use super::llm_schema::{parse_validated_json, validate_llm_contract, Issue, ParseVerdict, SchemaKind};
use super::manifests;
use super::prompt::{build_base_prompt, render_catalog_text, CREATE_PROMPT_SECTION};
use super::validation::check_against_manifests;
use super::value::js_to_string;

/// The installed vocabulary a compose call sees: UI fragment defs by type,
/// part operation defs by name, redacted credential views, and recipes.
#[derive(Default)]
pub struct ComposeVocabulary {
    pub fragment_defs: Map<String, Value>,
    pub part_operations: Map<String, Value>,
    pub credentials: Vec<Value>,
    pub recipes: Map<String, Value>,
}

pub struct ResolvedRecipeShape {
    pub shape: Option<Value>,
    pub problems: Vec<String>,
    pub warnings: Vec<Value>,
}

fn format_issues(issues: &[Issue]) -> String {
    issues
        .iter()
        .map(|issue| format!("{}: {}", issue.dotted_path(), issue.message))
        .collect::<Vec<_>>()
        .join("\n")
}

/// formatManifestErrors: the model-facing rendering of checker errors.
pub fn format_manifest_errors(errors: &[Value]) -> String {
    errors
        .iter()
        .map(|error| {
            format!(
                "{}: {}",
                error.get("path").and_then(Value::as_str).unwrap_or(""),
                error.get("message").and_then(Value::as_str).unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Validates a recipe's stored contract against the current vocabulary; every
/// use works on its own copy because validation seeds state keys in place.
pub fn resolve_recipe_shape(def: &Value, vocab: &ComposeVocabulary) -> ResolvedRecipeShape {
    let contract = def.get("contract").cloned().unwrap_or(Value::Null);
    let mut shape = match validate_llm_contract(&contract) {
        Ok(shape) => shape,
        Err(issues) => {
            return ResolvedRecipeShape {
                shape: None,
                problems: vec![format_issues(&issues)],
                warnings: Vec::new(),
            };
        }
    };
    let outcome = check_against_manifests(
        &mut shape,
        &vocab.fragment_defs,
        &vocab.part_operations,
        &vocab.credentials,
    );
    ResolvedRecipeShape {
        shape: Some(shape),
        problems: outcome
            .errors
            .iter()
            .map(|error| {
                format!(
                    "{}: {}",
                    error.get("path").and_then(Value::as_str).unwrap_or(""),
                    error.get("message").and_then(Value::as_str).unwrap_or("")
                )
            })
            .collect(),
        warnings: outcome.warnings,
    }
}

pub fn recipe_check_ok(def: &Value, vocab: &ComposeVocabulary) -> bool {
    resolve_recipe_shape(def, vocab).problems.is_empty()
}

/// The create-mode semantic gate: a recipe answer must name an installed
/// recipe that still validates; a contract answer runs the manifest checker
/// in place. Problems feed the repair round.
pub fn check_composed_candidate(
    candidate: &mut Value,
    vocab: &ComposeVocabulary,
) -> (Vec<String>, Vec<Value>) {
    if let Some(recipe) = candidate.get("recipe") {
        let name = recipe.as_str().unwrap_or("").to_string();
        let Some(def) = vocab.recipes.get(&name).cloned() else {
            let mut names: Vec<&String> = vocab.recipes.keys().collect();
            names.sort();
            let listed = names.iter().map(|n| n.as_str()).collect::<Vec<_>>().join(", ");
            let installed_note = if listed.is_empty() {
                String::new()
            } else {
                format!(" (installed: {})", listed)
            };
            return (
                vec![format!(
                    "recipe: \"{}\" is not an installed app{}; compose a contract instead",
                    name, installed_note
                )],
                Vec::new(),
            );
        };
        let resolved = resolve_recipe_shape(&def, vocab);
        if !resolved.problems.is_empty() {
            return (
                vec![format!(
                    "recipe: \"{}\" cannot open ({}); compose a contract instead",
                    name,
                    resolved.problems.join("; ")
                )],
                Vec::new(),
            );
        }
        return (Vec::new(), Vec::new());
    }
    let Some(contract) = candidate.get_mut("contract") else {
        return (Vec::new(), Vec::new());
    };
    let outcome = check_against_manifests(
        contract,
        &vocab.fragment_defs,
        &vocab.part_operations,
        &vocab.credentials,
    );
    let problems = if outcome.errors.is_empty() {
        Vec::new()
    } else {
        vec![format_manifest_errors(&outcome.errors)]
    };
    (problems, outcome.warnings)
}

fn is_known_element_type(element_type: &str, vocab: &ComposeVocabulary) -> bool {
    manifests::registry()
        .get("elements")
        .and_then(Value::as_object)
        .is_some_and(|elements| elements.contains_key(element_type))
        || manifests::intrinsic_elements().iter().any(|name| *name == element_type)
        || vocab.fragment_defs.contains_key(element_type)
}

fn operation_is_defined(name: &str, vocab: &ComposeVocabulary) -> bool {
    manifests::builtin_def(name).is_some() || vocab.part_operations.contains_key(name)
}

/// postProcess: unique ids, unknown element types degraded to containers,
/// execution types resolved, the default column layout filled, metadata
/// stamped, and legacy triggers normalized into event bindings.
pub fn finalize_contract_shape(
    shape: &Value,
    fallback_description: Option<&str>,
    now_iso: &str,
    vocab: &ComposeVocabulary,
) -> Value {
    let mut seen_ids: Vec<String> = Vec::new();
    let mut unique_id = |id: &str| -> String {
        let mut candidate = id.to_string();
        let mut n = 2;
        while seen_ids.iter().any(|seen| seen == &candidate) {
            candidate = format!("{}-{}", id, n);
            n += 1;
        }
        seen_ids.push(candidate.clone());
        candidate
    };

    fn fix_element(
        element: &Value,
        unique_id: &mut dyn FnMut(&str) -> String,
        vocab: &ComposeVocabulary,
    ) -> Value {
        let mut out = element.as_object().cloned().unwrap_or_default();
        let id = unique_id(element.get("id").and_then(Value::as_str).unwrap_or(""));
        out.insert("id".to_string(), Value::String(id));
        let element_type = element.get("type").and_then(Value::as_str).unwrap_or("").to_string();
        let resolved_type = if is_known_element_type(&element_type, vocab) {
            element_type
        } else if manifests::intrinsic_elements()
            .iter()
            .any(|name| name == &element_type.to_lowercase())
        {
            element_type.to_lowercase()
        } else {
            "container".to_string()
        };
        out.insert("type".to_string(), Value::String(resolved_type));
        if let Some(children) = element.get("children").and_then(Value::as_array) {
            let fixed: Vec<Value> = children
                .iter()
                .map(|child| fix_element(child, unique_id, vocab))
                .collect();
            out.insert("children".to_string(), Value::Array(fixed));
        }
        Value::Object(out)
    }

    let elements: Vec<Value> = shape
        .get("elements")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|element| fix_element(element, &mut unique_id, vocab))
        .collect();

    // Resolve execution types (unknown names were already repaired or errored).
    let operations: Vec<Value> = shape
        .get("operations")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|op| {
            let mut out = op.as_object().cloned().unwrap_or_default();
            let id = unique_id(op.get("id").and_then(Value::as_str).unwrap_or(""));
            out.insert("id".to_string(), Value::String(id));
            let name = op.get("operationName").and_then(Value::as_str).unwrap_or("");
            if operation_is_defined(name, vocab) {
                out.insert("executionType".to_string(), Value::String("builtin".to_string()));
                out.remove("implementation");
            } else if op
                .get("implementation")
                .and_then(|imp| imp.get("endpoint"))
                .is_some()
            {
                out.insert("executionType".to_string(), Value::String("remote".to_string()));
                if let Some(imp) = out.get_mut("implementation").and_then(Value::as_object_mut) {
                    imp.insert("type".to_string(), Value::String("remote".to_string()));
                }
            }
            Value::Object(out)
        })
        .collect();

    // An omitted layout materializes as empty flex properties; fill the
    // standard column so omission renders identically to the explicit form.
    let has_layout_properties = shape
        .get("layout")
        .and_then(|layout| layout.get("properties"))
        .and_then(Value::as_object)
        .is_some_and(|properties| !properties.is_empty());
    let layout = if has_layout_properties {
        shape.get("layout").cloned().unwrap_or(Value::Null)
    } else {
        json!({
            "type": "flex",
            "properties": { "flexDirection": "column", "gap": "12px", "padding": "16px" }
        })
    };

    let metadata_in = shape.get("metadata");
    let mut metadata = Map::new();
    metadata.insert(
        "createdAt".to_string(),
        metadata_in
            .and_then(|m| m.get("createdAt"))
            .cloned()
            .unwrap_or_else(|| Value::String(now_iso.to_string())),
    );
    metadata.insert("updatedAt".to_string(), Value::String(now_iso.to_string()));
    metadata.insert(
        "version".to_string(),
        metadata_in
            .and_then(|m| m.get("version"))
            .cloned()
            .unwrap_or_else(|| shape.get("version").cloned().unwrap_or(Value::Null)),
    );
    let description = metadata_in
        .and_then(|m| m.get("description"))
        .cloned()
        .or_else(|| fallback_description.map(|text| Value::String(text.to_string())));
    if let Some(description) = description {
        metadata.insert("description".to_string(), description);
    }
    if let Some(tags) = metadata_in.and_then(|m| m.get("tags")) {
        metadata.insert("tags".to_string(), tags.clone());
    }
    if let Some(author) = metadata_in.and_then(|m| m.get("author")) {
        metadata.insert("author".to_string(), author.clone());
    }

    let mut contract = Map::new();
    contract.insert(
        "name".to_string(),
        shape.get("name").cloned().unwrap_or(Value::Null),
    );
    contract.insert(
        "version".to_string(),
        shape.get("version").cloned().unwrap_or(Value::Null),
    );
    if let Some(initial) = shape.get("initialState") {
        contract.insert("initialState".to_string(), initial.clone());
    }
    contract.insert("elements".to_string(), Value::Array(elements));
    contract.insert("operations".to_string(), Value::Array(operations));
    contract.insert("layout".to_string(), layout);
    if let Some(styling) = shape.get("styling") {
        contract.insert("styling".to_string(), styling.clone());
    }
    contract.insert("metadata".to_string(), Value::Object(metadata));

    normalize_contract(&Value::Object(contract))
}

/// Converts legacy trigger wiring into event bindings (deduped against ones
/// that already exist) and drops trigger kinds the runtime does not run.
pub fn normalize_contract(contract: &Value) -> Value {
    let mut pending_by_element: Vec<(String, Vec<Value>)> = Vec::new();
    let operations: Vec<Value> = contract
        .get("operations")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|operation| {
            for trigger in operation.get("triggers").and_then(Value::as_array).into_iter().flatten()
            {
                let is_event = trigger.get("type").and_then(Value::as_str) == Some("event");
                let element_id = trigger
                    .get("parameters")
                    .and_then(|parameters| parameters.get("elementId"))
                    .filter(|id| !id.is_null());
                if is_event && element_id.is_some() {
                    let element_id = js_to_string(element_id.expect("checked above"));
                    let event = trigger
                        .get("parameters")
                        .and_then(|parameters| parameters.get("eventType"))
                        .filter(|event| !event.is_null())
                        .map(js_to_string)
                        .unwrap_or_else(|| "click".to_string());
                    let binding = json!({
                        "event": event,
                        "operationId": operation.get("id").cloned().unwrap_or(Value::Null),
                    });
                    match pending_by_element.iter_mut().find(|(id, _)| id == &element_id) {
                        Some((_, list)) => list.push(binding),
                        None => pending_by_element.push((element_id, vec![binding])),
                    }
                }
            }
            let mut out = operation.as_object().cloned().unwrap_or_default();
            out.insert("triggers".to_string(), Value::Array(Vec::new()));
            Value::Object(out)
        })
        .collect();

    fn merge_element(element: &Value, pending_by_element: &[(String, Vec<Value>)]) -> Value {
        let id = element.get("id").and_then(Value::as_str).unwrap_or("");
        let existing: Vec<Value> = element
            .get("eventBindings")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut merged = existing.clone();
        if let Some((_, pending)) = pending_by_element.iter().find(|(key, _)| key == id) {
            for binding in pending {
                let duplicate = existing.iter().any(|candidate| {
                    candidate.get("event") == binding.get("event")
                        && candidate.get("operationId") == binding.get("operationId")
                });
                if !duplicate {
                    merged.push(binding.clone());
                }
            }
        }
        let mut out = element.as_object().cloned().unwrap_or_default();
        out.insert("eventBindings".to_string(), Value::Array(merged));
        if let Some(children) = element.get("children").and_then(Value::as_array) {
            let mapped: Vec<Value> = children
                .iter()
                .map(|child| merge_element(child, pending_by_element))
                .collect();
            out.insert("children".to_string(), Value::Array(mapped));
        }
        Value::Object(out)
    }

    let elements: Vec<Value> = contract
        .get("elements")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|element| merge_element(element, &pending_by_element))
        .collect();

    let mut out = contract.as_object().cloned().unwrap_or_default();
    out.insert("operations".to_string(), Value::Array(operations));
    out.insert("elements".to_string(), Value::Array(elements));
    Value::Object(out)
}

// ---------------------------------------------------------------------------
// The validated-generation loop over a pluggable model transport.
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct SystemBlockSpec {
    pub text: String,
    pub cache: bool,
}

pub struct LlmSendOptions {
    pub json_mode: bool,
    pub max_tokens: Option<u32>,
    pub system_blocks: Vec<SystemBlockSpec>,
}

pub struct LlmReply {
    pub content: String,
    pub provider: Option<String>,
}

type SendFuture<'a> = Pin<Box<dyn Future<Output = Result<LlmReply, String>> + Send + 'a>>;

/// Streamed response text lands here delta by delta on providers that
/// stream; the resolved reply still carries the full content.
pub type ChunkCallback<'a> = &'a mut (dyn FnMut(&str) + Send);

/// The model transport the loop drives: scripted in vectors, llm_chat in
/// production.
pub trait ComposeLlm: Send {
    fn send<'a>(
        &'a mut self,
        messages: Vec<Value>,
        options: LlmSendOptions,
        on_chunk: Option<ChunkCallback<'a>>,
    ) -> SendFuture<'a>;
}

/// Accumulated raw response text, throttled like the webview's onPartial;
/// the attempt number (1-based) distinguishes repair rounds.
pub type PartialCallback<'a> = &'a mut (dyn FnMut(&str, u32) + Send);

async fn send_attempt(
    llm: &mut dyn ComposeLlm,
    conversation: Vec<Value>,
    options: &GenerateOptions,
    attempt: u32,
    on_partial: &mut Option<PartialCallback<'_>>,
) -> Result<LlmReply, String> {
    let send_options = LlmSendOptions {
        json_mode: true,
        max_tokens: options.max_tokens,
        system_blocks: options.system_blocks.clone(),
    };
    match on_partial.as_deref_mut() {
        None => llm.send(conversation, send_options, None).await,
        Some(callback) => {
            let mut accumulated = String::new();
            let mut last_flush: Option<std::time::Instant> = None;
            let reply = {
                let mut chunk = |delta: &str| {
                    accumulated.push_str(delta);
                    let due = last_flush.is_none_or(|at| at.elapsed().as_millis() >= 150);
                    if due {
                        last_flush = Some(std::time::Instant::now());
                        callback(&accumulated, attempt);
                    }
                };
                llm.send(conversation, send_options, Some(&mut chunk)).await
            }?;
            if !accumulated.is_empty() {
                callback(&accumulated, attempt);
            }
            Ok(reply)
        }
    }
}

pub struct GenerateOptions {
    pub label: String,
    pub max_tokens: Option<u32>,
    pub system_blocks: Vec<SystemBlockSpec>,
}

/// Send, parse, and repair: one round on default providers, two on the cheap
/// fast ones whose misses are usually one field.
pub async fn generate_validated_json(
    llm: &mut dyn ComposeLlm,
    messages: Vec<Value>,
    schema: SchemaKind,
    options: GenerateOptions,
    semantic: &mut (dyn FnMut(&mut Value) -> Vec<String> + Send),
    mut on_partial: Option<PartialCallback<'_>>,
) -> Result<Value, String> {
    let mut conversation = messages;

    let first_reply = send_attempt(llm, conversation.clone(), &options, 1, &mut on_partial).await?;
    let mut last_provider = first_reply.provider.clone();
    let mut raw = first_reply.content;
    let mut verdict = parse_validated_json(&raw, &schema, semantic);
    if let ParseVerdict::Ok(value) = verdict {
        return Ok(value);
    }

    let cheap_fast = matches!(last_provider.as_deref(), Some("local") | Some("mercury"));
    let max_repairs = if cheap_fast { 2 } else { 1 };
    for round in 0..max_repairs {
        let ParseVerdict::Problem(problem) = &verdict else { unreachable!() };
        conversation.push(json!({ "role": "assistant", "content": raw }));
        conversation.push(json!({
            "role": "user",
            "content": format!(
                "Your previous response had problems:\n{}\n\nReturn the corrected JSON object only. No prose, no code fences.",
                problem
            ),
        }));
        let reply =
            send_attempt(llm, conversation.clone(), &options, round + 2, &mut on_partial).await?;
        last_provider = reply.provider.clone();
        raw = reply.content;
        verdict = parse_validated_json(&raw, &schema, semantic);
        if let ParseVerdict::Ok(value) = verdict {
            return Ok(value);
        }
    }

    let ParseVerdict::Problem(problem) = verdict else { unreachable!() };
    // Local servers silently truncate prompts that exceed their context
    // window, which reads as model failure; point at the likely cause.
    let local_hint = if last_provider.as_deref() == Some("local") {
        " If your local server truncates long prompts (Ollama logs \"truncating input prompt\"), raise its context window: restart Ollama with OLLAMA_CONTEXT_LENGTH=16384."
    } else {
        ""
    };
    Err(format!(
        "{} generation failed after a repair attempt. {}{}",
        options.label, problem, local_hint
    ))
}

/// The installed vocabulary as compose sees it, from decoded part manifests
/// (the same list the session loader reads) plus redacted credential views.
pub fn vocabulary_from_installed(installed: &[Value], credentials: Vec<Value>) -> ComposeVocabulary {
    let mut vocab = ComposeVocabulary { credentials, ..Default::default() };
    for entry in installed {
        let Some(manifest) = entry.get("manifest") else { continue };
        for fragment in manifest
            .get("uiFragments")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(name) = fragment.get("name").and_then(Value::as_str) {
                vocab.fragment_defs.insert(name.to_string(), fragment.clone());
            }
        }
        for operation in manifest
            .get("operations")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(name) = operation.get("name").and_then(Value::as_str) {
                vocab.part_operations.insert(name.to_string(), operation.clone());
            }
        }
        for recipe in manifest
            .get("recipes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(name) = recipe.get("name").and_then(Value::as_str) {
                vocab.recipes.insert(name.to_string(), recipe.clone());
            }
        }
    }
    vocab
}

pub struct ComposeOutcome {
    pub contract: Value,
    pub spec: Value,
    pub recipe_name: Option<String>,
    pub warnings: Vec<Value>,
}

pub struct EditOutcome {
    pub contract: Value,
    pub warnings: Vec<Value>,
}

fn collect_stable_kinds(current: &Value, kinds: &mut Vec<(String, String)>) {
    fn walk_elements(elements: &[Value], kinds: &mut Vec<(String, String)>) {
        for element in elements {
            let id = element.get("id").and_then(Value::as_str).unwrap_or("");
            let element_type = element.get("type").and_then(Value::as_str).unwrap_or("");
            kinds.push((format!("element:{}", id), element_type.to_string()));
            if let Some(children) = element.get("children").and_then(Value::as_array) {
                walk_elements(children, kinds);
            }
        }
    }
    walk_elements(
        current.get("elements").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]),
        kinds,
    );
    for op in current.get("operations").and_then(Value::as_array).into_iter().flatten() {
        let id = op.get("id").and_then(Value::as_str).unwrap_or("");
        let name = op.get("operationName").and_then(Value::as_str).unwrap_or("");
        kinds.push((format!("operation:{}", id), name.to_string()));
    }
}

/// An id kept across the edit must keep its kind of part; the problems feed
/// the repair round like every other rule.
fn check_id_stability(candidate: &Value, stable_kinds: &[(String, String)]) -> Vec<String> {
    let mut problems = Vec::new();
    fn known<'a>(kinds: &'a [(String, String)], key: &str) -> Option<&'a str> {
        kinds.iter().find(|(k, _)| k == key).map(|(_, kind)| kind.as_str())
    }
    fn check_element(
        element: &Value,
        path: &str,
        kinds: &[(String, String)],
        problems: &mut Vec<String>,
    ) {
        let id = element.get("id").and_then(Value::as_str).unwrap_or("");
        let element_type = element.get("type").and_then(Value::as_str).unwrap_or("");
        if let Some(kind) = known(kinds, &format!("element:{}", id)) {
            if kind != element_type {
                problems.push(format!(
                    "{}: element id \"{}\" was type \"{}\" and must keep it (use a new id for a different part; reused ids preserve user state)",
                    path, id, kind
                ));
            }
        }
        for (index, child) in element
            .get("children")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
        {
            check_element(child, &format!("{}.children.{}", path, index), kinds, problems);
        }
    }
    for (index, element) in candidate
        .get("elements")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        check_element(element, &format!("elements.{}", index), stable_kinds, &mut problems);
    }
    for (index, op) in candidate
        .get("operations")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        let id = op.get("id").and_then(Value::as_str).unwrap_or("");
        let name = op.get("operationName").and_then(Value::as_str).unwrap_or("");
        if let Some(kind) = known(stable_kinds, &format!("operation:{}", id)) {
            if kind != name {
                problems.push(format!(
                    "operations.{}: operation id \"{}\" was \"{}\" and must keep it (use a new id for a different operation)",
                    index, id, kind
                ));
            }
        }
    }
    problems
}

/// Applies a natural-language edit to an existing contract. Preservation is
/// a property of id stability: kept elements and operations keep their ids
/// and kinds, removals surface as warnings, and the creation metadata rides
/// through finalization.
pub async fn edit_contract(
    llm: &mut dyn ComposeLlm,
    current: &Value,
    instruction: &str,
    vocab: &ComposeVocabulary,
    now_iso: &str,
    on_partial: Option<PartialCallback<'_>>,
) -> Result<EditOutcome, String> {
    let catalog = render_catalog_text(vocab, false);
    let current_pretty =
        serde_json::to_string_pretty(current).map_err(|error| error.to_string())?;
    let messages = vec![json!({
        "role": "user",
        "content": format!(
            "Current contract:\n{}\n\nApply this change and return the complete updated contract:\n{}",
            current_pretty, instruction
        ),
    })];

    let mut stable_kinds: Vec<(String, String)> = Vec::new();
    collect_stable_kinds(current, &mut stable_kinds);

    let mut warnings: Vec<Value> = Vec::new();
    let mut semantic = |candidate: &mut Value| {
        let outcome = check_against_manifests(
            candidate,
            &vocab.fragment_defs,
            &vocab.part_operations,
            &vocab.credentials,
        );
        warnings = outcome.warnings;
        let mut problems = if outcome.errors.is_empty() {
            Vec::new()
        } else {
            vec![format_manifest_errors(&outcome.errors)]
        };
        problems.extend(check_id_stability(candidate, &stable_kinds));
        problems
    };
    let shape = generate_validated_json(
        llm,
        messages,
        SchemaKind::Contract,
        GenerateOptions {
            label: "Contract".to_string(),
            max_tokens: Some(16000),
            system_blocks: vec![
                SystemBlockSpec { text: build_base_prompt(&catalog, false), cache: true },
                SystemBlockSpec {
                    text: super::prompt::EDIT_PROMPT_SECTION.to_string(),
                    cache: false,
                },
            ],
        },
        &mut semantic,
        on_partial,
    )
    .await?;

    // Ids that disappeared are legitimate removals; note them for the caller.
    let mut remaining: Vec<(String, String)> = Vec::new();
    collect_stable_kinds(&shape, &mut remaining);
    for (key, _) in &stable_kinds {
        if !remaining.iter().any(|(kept, _)| kept == key) {
            let (kind, id) = key.split_once(':').unwrap_or(("element", key));
            let path = if kind == "element" { "elements" } else { "operations" };
            warnings.push(json!({
                "path": path,
                "message": format!("Edit removed {} \"{}\"", kind, id),
                "code": "EDIT_REMOVED_PART",
            }));
        }
    }

    // Preserve creation metadata; finalization stamps updatedAt.
    let mut merged = shape;
    if merged.get("metadata").is_none() {
        let current_metadata = current.get("metadata");
        let mut metadata = Map::new();
        metadata.insert(
            "createdAt".to_string(),
            current_metadata
                .and_then(|m| m.get("createdAt"))
                .cloned()
                .unwrap_or_else(|| Value::String(now_iso.to_string())),
        );
        metadata.insert("updatedAt".to_string(), Value::String(now_iso.to_string()));
        metadata.insert(
            "version".to_string(),
            current_metadata
                .and_then(|m| m.get("version"))
                .cloned()
                .unwrap_or_else(|| merged.get("version").cloned().unwrap_or(Value::Null)),
        );
        for key in ["description", "tags", "author"] {
            if let Some(value) = current_metadata.and_then(|m| m.get(key)) {
                metadata.insert(key.to_string(), value.clone());
            }
        }
        if let Some(map) = merged.as_object_mut() {
            map.insert("metadata".to_string(), Value::Object(metadata));
        }
    }
    let fallback = current
        .get("metadata")
        .and_then(|m| m.get("description"))
        .and_then(Value::as_str)
        .or_else(|| current.get("name").and_then(Value::as_str));
    let contract = finalize_contract_shape(&merged, fallback, now_iso, vocab);
    Ok(EditOutcome { contract, warnings })
}

/// Single-call creation against the installed vocabulary: the spec header
/// plus either a composed contract or an installed recipe reference, both
/// finalized into a renderable contract.
pub async fn compose_from_description(
    llm: &mut dyn ComposeLlm,
    description: &str,
    vocab: &ComposeVocabulary,
    now_iso: &str,
    on_partial: Option<PartialCallback<'_>>,
) -> Result<ComposeOutcome, String> {
    let catalog = render_catalog_text(vocab, false);
    let messages = vec![json!({
        "role": "user",
        "content": format!("Build an app for this request:\n\n{}", description),
    })];
    let mut warnings: Vec<Value> = Vec::new();
    let mut semantic = |candidate: &mut Value| {
        let (problems, checked_warnings) = check_composed_candidate(candidate, vocab);
        warnings = checked_warnings;
        problems
    };
    let composed = generate_validated_json(
        llm,
        messages,
        SchemaKind::Composed,
        GenerateOptions {
            label: "Contract".to_string(),
            max_tokens: Some(16000),
            system_blocks: vec![
                SystemBlockSpec { text: build_base_prompt(&catalog, false), cache: true },
                SystemBlockSpec { text: CREATE_PROMPT_SECTION.to_string(), cache: false },
            ],
        },
        &mut semantic,
        on_partial,
    )
    .await?;

    let spec = composed.get("spec").cloned().unwrap_or(Value::Null);
    let goal = spec.get("goal").and_then(Value::as_str).unwrap_or("");
    let effective_description = if goal.is_empty() { description } else { goal };

    if let Some(recipe) = composed.get("recipe").and_then(Value::as_str) {
        let def = vocab.recipes.get(recipe).cloned();
        let resolved = def.as_ref().map(|def| resolve_recipe_shape(def, vocab));
        let Some(resolved) = resolved.filter(|resolved| resolved.shape.is_some()) else {
            return Err(format!("Recipe \"{}\" is no longer available", recipe));
        };
        let shape = resolved.shape.expect("checked above");
        let contract =
            finalize_contract_shape(&shape, Some(effective_description), now_iso, vocab);
        return Ok(ComposeOutcome {
            contract,
            spec,
            recipe_name: Some(recipe.to_string()),
            warnings: resolved.warnings,
        });
    }

    let contract_shape = composed.get("contract").cloned().unwrap_or(Value::Null);
    let contract =
        finalize_contract_shape(&contract_shape, Some(effective_description), now_iso, vocab);
    Ok(ComposeOutcome { contract, spec, recipe_name: None, warnings })
}
