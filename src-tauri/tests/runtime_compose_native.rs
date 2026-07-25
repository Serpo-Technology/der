//! Creation with no webview involved: a scripted model answer runs through
//! the Rust compose pipeline (prompt vocabulary from the committed signed
//! bundles, structural validation, the manifest checker, finalization) and
//! the finalized contract opens as a live native session with its view tree
//! resolved. Composed contracts and installed-recipe reuse both prove out.

use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use dynamic_experience_runtime_lib::runtime::compose::{
    compose_from_description, vocabulary_from_installed, ComposeLlm, ComposeVocabulary, LlmReply,
    LlmSendOptions,
};
use dynamic_experience_runtime_lib::runtime::env::ScriptedEnv;
use dynamic_experience_runtime_lib::runtime::prompt::render_catalog_text;
use dynamic_experience_runtime_lib::runtime::sessions::{open_session_core, resolve_entry_view};
use serde_json::{json, Value};

fn decoded_manifest(bundle: &str) -> Value {
    let raw = std::fs::read(format!("../fragments/dist/{}", bundle)).expect("committed bundle");
    let envelope: Value = serde_json::from_slice(&raw).expect("bundle envelope parses");
    serde_json::from_slice(
        &BASE64
            .decode(envelope["manifestB64"].as_str().unwrap())
            .expect("manifest decodes"),
    )
    .expect("manifest parses")
}

fn installed_vocabulary() -> ComposeVocabulary {
    let installed = vec![
        json!({ "manifest": decoded_manifest("der-labs.ui-basics.derpart") }),
        json!({ "manifest": decoded_manifest("der-labs.starter-apps.derpart") }),
    ];
    vocabulary_from_installed(&installed, Vec::new())
}

struct ScriptedLlm {
    responses: VecDeque<String>,
    calls: usize,
}

impl ComposeLlm for ScriptedLlm {
    fn send(
        &mut self,
        _messages: Vec<Value>,
        _options: LlmSendOptions,
    ) -> Pin<Box<dyn Future<Output = Result<LlmReply, String>> + Send + '_>> {
        self.calls += 1;
        let content = self.responses.pop_front().expect("scripted response available");
        Box::pin(async move {
            Ok(LlmReply {
                content,
                provider: Some("anthropic".to_string()),
            })
        })
    }
}

fn block_on<F: Future>(future: F) -> F::Output {
    use std::task::{Context, Poll, Waker};
    let mut future = Box::pin(future);
    let waker = Waker::noop();
    let mut cx = Context::from_waker(waker);
    loop {
        match future.as_mut().poll(&mut cx) {
            Poll::Ready(output) => return output,
            Poll::Pending => std::thread::yield_now(),
        }
    }
}

fn scripted_env() -> Box<ScriptedEnv> {
    Box::new(ScriptedEnv {
        ids: VecDeque::new(),
        randoms: VecDeque::new(),
        epoch_ms: 1753315200000,
        tz_offset_minutes: 0,
    })
}

fn count_nodes(tree: &[Value]) -> usize {
    tree.iter()
        .map(|node| {
            1 + node
                .get("children")
                .and_then(Value::as_array)
                .map(|children| count_nodes(children))
                .unwrap_or(0)
        })
        .sum()
}

#[test]
fn composed_pack_contract_opens_as_a_native_session() {
    let vocab = installed_vocabulary();
    // The catalog teaches the installed vocabulary the scripted answer uses.
    let catalog = render_catalog_text(&vocab, false);
    assert!(catalog.contains("basics.stopwatch"));
    assert!(catalog.contains("INSTALLED APPS"));

    let composed = json!({
        "spec": {
            "goal": "Time focused work sessions",
            "assumptions": ["A single stopwatch covers the request"]
        },
        "contract": {
            "name": "focus-timer",
            "elements": [
                { "id": "heading", "type": "text", "properties": { "content": "Focus", "role": "title" } },
                { "id": "watch", "type": "basics.stopwatch", "properties": {} }
            ],
            "operations": []
        }
    });
    let mut llm = ScriptedLlm {
        responses: VecDeque::from([composed.to_string()]),
        calls: 0,
    };
    let outcome = block_on(compose_from_description(
        &mut llm,
        "a stopwatch for focus sessions",
        &vocab,
        "2026-07-25T12:00:00.000Z",
    ))
    .expect("compose succeeds");
    assert_eq!(llm.calls, 1);
    assert!(outcome.recipe_name.is_none());
    assert_eq!(outcome.contract["name"], json!("focus-timer"));
    assert_eq!(outcome.contract["elements"][1]["type"], json!("basics.stopwatch"));
    assert_eq!(
        outcome.contract["metadata"]["description"],
        json!("Time focused work sessions")
    );

    // The finalized contract is everything a native renderer needs: the pack
    // instance expands, its operations instantiate, and the tree resolves.
    let entry = open_session_core(
        &outcome.contract,
        serde_json::Map::new(),
        vocab.fragment_defs.clone(),
        scripted_env(),
        None,
    )
    .expect("session opens");
    let elements = outcome.contract["elements"].as_array().unwrap().clone();
    let tree = resolve_entry_view(&entry, &elements);
    assert!(count_nodes(&tree) > 2, "pack instance expanded into a subtree");
}

#[test]
fn recipe_reuse_composes_and_opens_natively() {
    let vocab = installed_vocabulary();
    let reply = json!({
        "spec": {
            "goal": "Track expenses",
            "assumptions": ["Reusing the installed expense tracker"]
        },
        "recipe": "apps.expense_tracker"
    });
    let mut llm = ScriptedLlm {
        responses: VecDeque::from([reply.to_string()]),
        calls: 0,
    };
    let outcome = block_on(compose_from_description(
        &mut llm,
        "an expense tracker",
        &vocab,
        "2026-07-25T12:00:00.000Z",
    ))
    .expect("recipe reuse succeeds");
    assert_eq!(outcome.recipe_name.as_deref(), Some("apps.expense_tracker"));
    assert!(outcome.contract["elements"].as_array().is_some_and(|e| !e.is_empty()));

    let entry = open_session_core(
        &outcome.contract,
        serde_json::Map::new(),
        vocab.fragment_defs.clone(),
        scripted_env(),
        None,
    )
    .expect("recipe session opens");
    let elements = outcome.contract["elements"].as_array().unwrap().clone();
    let tree = resolve_entry_view(&entry, &elements);
    assert!(!tree.is_empty());
}

#[test]
fn a_repair_round_fixes_a_rejected_composition() {
    let vocab = installed_vocabulary();
    let broken = json!({
        "spec": { "goal": "Ghost app" },
        "contract": {
            "name": "ghost",
            "elements": [
                { "id": "b", "type": "button", "properties": { "text": "Go" },
                  "eventBindings": [{ "event": "click", "operationId": "op-missing" }] }
            ],
            "operations": []
        }
    });
    let fixed = json!({
        "spec": { "goal": "Counter app" },
        "contract": {
            "name": "counter",
            "elements": [
                { "id": "count", "type": "text",
                  "dataBindings": [{ "property": "content", "source": "state", "sourceId": "n" }] },
                { "id": "b", "type": "button", "properties": { "text": "Go" },
                  "eventBindings": [{ "event": "click", "operationId": "op-add" }] }
            ],
            "operations": [
                { "id": "op-add", "operationName": "counter.add",
                  "inputs": [{ "name": "key", "source": "constant", "sourceId": "n" }] }
            ]
        }
    });
    let mut llm = ScriptedLlm {
        responses: VecDeque::from([broken.to_string(), fixed.to_string()]),
        calls: 0,
    };
    let outcome = block_on(compose_from_description(
        &mut llm,
        "a counter",
        &vocab,
        "2026-07-25T12:00:00.000Z",
    ))
    .expect("repair round recovers");
    assert_eq!(llm.calls, 2);
    assert_eq!(outcome.contract["operations"][0]["executionType"], json!("builtin"));
}
