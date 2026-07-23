use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::AppHandle;

use crate::oauth;
use crate::settings::{self, default_model};

#[derive(Debug, Clone, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SystemBlock {
    pub text: String,
    #[serde(default)]
    pub cache: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmChatRequest {
    pub messages: Vec<ChatMessage>,
    /// Structured system prompt; blocks flagged `cache` become prompt-cache
    /// breakpoints on Anthropic-shaped providers. Other providers receive the
    /// concatenated text as a plain system message.
    #[serde(default)]
    pub system_blocks: Option<Vec<SystemBlock>>,
    /// Stream deltas over the command's channel where the provider supports
    /// it; the full content still returns at the end either way.
    #[serde(default)]
    pub stream: bool,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub temperature: Option<f64>,
    #[serde(default)]
    pub json_mode: Option<bool>,
    #[serde(default)]
    pub base_url: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmChatResponse {
    pub content: String,
    pub provider: String,
    pub model: String,
}

const DEFAULT_MAX_TOKENS: u32 = 8192;

const PLAIN_DEADLINE: Duration = Duration::from_secs(300);
// Streams stay alive as long as tokens flow; local models can run long.
const STREAM_DEADLINE: Duration = Duration::from_secs(1800);

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))
}

fn request_deadline(streaming: bool) -> Duration {
    if streaming { STREAM_DEADLINE } else { PLAIN_DEADLINE }
}

fn api_key(app: &AppHandle, provider: &str) -> Result<String, String> {
    settings::load_credentials(app)
        .api_keys
        .get(provider)
        .cloned()
        .ok_or_else(|| {
            format!(
                "No API key configured for {}. Add one in Settings.",
                provider
            )
        })
}

fn error_body(status: reqwest::StatusCode, body: &str) -> String {
    format!(
        "{} error: {}",
        status,
        body.chars().take(300).collect::<String>()
    )
}

fn split_system(messages: &[ChatMessage]) -> (String, Vec<&ChatMessage>) {
    let system = messages
        .iter()
        .filter(|m| m.role == "system")
        .map(|m| m.content.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    let conversation = messages.iter().filter(|m| m.role != "system").collect();
    (system, conversation)
}

enum AnthropicAuth {
    ApiKey(String),
    Bearer(String),
}

fn build_anthropic_body(
    is_bearer: bool,
    model: &str,
    messages: &[ChatMessage],
    system_blocks: Option<&[SystemBlock]>,
    max_tokens: u32,
) -> Value {
    let (system, conversation) = split_system(messages);

    // Subscription bearer tokens are scoped to CLI-shaped requests; identify as
    // one via the leading system block so inference is accepted.
    let mut blocks: Vec<Value> = Vec::new();
    if is_bearer {
        blocks.push(json!({
            "type": "text",
            "text": "You are Claude Code, Anthropic's official CLI for Claude."
        }));
    }
    match system_blocks {
        Some(structured) => {
            for block in structured {
                let mut value = json!({ "type": "text", "text": block.text });
                if block.cache {
                    value["cache_control"] = json!({ "type": "ephemeral" });
                }
                blocks.push(value);
            }
            if !system.is_empty() {
                blocks.push(json!({ "type": "text", "text": system }));
            }
        }
        None => {
            // Legacy single-string system: stable per mode, so cache it whole.
            if !system.is_empty() {
                blocks.push(json!({
                    "type": "text",
                    "text": system,
                    "cache_control": { "type": "ephemeral" }
                }));
            }
        }
    }

    let mut body = json!({
        "model": model,
        "max_tokens": max_tokens,
        "messages": conversation
            .iter()
            .map(|m| json!({ "role": m.role, "content": m.content }))
            .collect::<Vec<_>>(),
    });
    if !blocks.is_empty() {
        body["system"] = json!(blocks);
    }
    body
}

/// A base URL with no path gets the standard OpenAI-compatible /v1 prefix;
/// an explicit path is respected (users often enter just the origin, e.g.
/// http://localhost:11434 for Ollama).
fn normalize_openai_base(base: &str) -> String {
    let trimmed = base.trim_end_matches('/');
    if let Ok(url) = reqwest::Url::parse(trimmed) {
        if url.path().is_empty() || url.path() == "/" {
            return format!("{}/v1", trimmed);
        }
    }
    trimmed.to_string()
}

/// Splits complete lines off an SSE byte buffer and returns their `data:`
/// payloads; an unterminated tail stays in the buffer so multi-byte
/// characters split across chunks survive.
fn drain_sse_data(buffer: &mut Vec<u8>) -> Vec<String> {
    let mut out = Vec::new();
    while let Some(pos) = buffer.iter().position(|b| *b == b'\n') {
        let line: Vec<u8> = buffer.drain(..=pos).collect();
        let line = String::from_utf8_lossy(&line);
        let line = line.trim_end_matches(['\n', '\r']);
        if let Some(data) = line.strip_prefix("data:") {
            out.push(data.trim_start().to_string());
        }
    }
    out
}

fn anthropic_delta_text(payload: &str) -> Option<String> {
    let value: Value = serde_json::from_str(payload).ok()?;
    if value.get("type")?.as_str()? != "content_block_delta" {
        return None;
    }
    value
        .get("delta")?
        .get("text")
        .and_then(|t| t.as_str())
        .map(|s| s.to_string())
}

fn openai_delta_text(payload: &str) -> Option<String> {
    let value: Value = serde_json::from_str(payload).ok()?;
    value
        .get("choices")?
        .get(0)?
        .get("delta")?
        .get("content")
        .and_then(|c| c.as_str())
        .map(|s| s.to_string())
}

fn openai_delta_reasoning(payload: &str) -> bool {
    let value: Value = match serde_json::from_str(payload) {
        Ok(v) => v,
        Err(_) => return false,
    };
    let delta = &value["choices"][0]["delta"];
    delta["reasoning"].as_str().map_or(false, |s| !s.is_empty())
        || delta["reasoning_content"].as_str().map_or(false, |s| !s.is_empty())
}

const THINKING_ONLY_ERROR: &str =
    "The model spent its entire token budget thinking and returned no answer. Raise max tokens, or use a non-thinking model.";

/// Reads an SSE response to completion, forwarding each extracted text delta
/// over the channel. Returns the accumulated content and whether any
/// reasoning-only deltas were seen (thinking models).
async fn consume_sse(
    response: reqwest::Response,
    extract: fn(&str) -> Option<String>,
    detect_reasoning: fn(&str) -> bool,
    on_chunk: &Channel<String>,
) -> Result<(String, bool), String> {
    let mut stream = response.bytes_stream();
    let mut buffer: Vec<u8> = Vec::new();
    let mut content = String::new();
    let mut saw_reasoning = false;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Stream read failed: {}", e))?;
        buffer.extend_from_slice(&chunk);
        for payload in drain_sse_data(&mut buffer) {
            if payload == "[DONE]" {
                continue;
            }
            saw_reasoning = saw_reasoning || detect_reasoning(&payload);
            if let Some(text) = extract(&payload) {
                if !text.is_empty() {
                    let _ = on_chunk.send(text.clone());
                    content.push_str(&text);
                }
            }
        }
    }
    Ok((content, saw_reasoning))
}

async fn anthropic_chat(
    auth: &AnthropicAuth,
    model: &str,
    messages: &[ChatMessage],
    system_blocks: Option<&[SystemBlock]>,
    max_tokens: u32,
    on_chunk: Option<&Channel<String>>,
) -> Result<String, String> {
    let mut body = build_anthropic_body(
        matches!(auth, AnthropicAuth::Bearer(_)),
        model,
        messages,
        system_blocks,
        max_tokens,
    );
    if on_chunk.is_some() {
        body["stream"] = json!(true);
    }

    let mut request = http_client()?
        .post("https://api.anthropic.com/v1/messages")
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json");
    request = match auth {
        AnthropicAuth::ApiKey(key) => request.header("x-api-key", key),
        AnthropicAuth::Bearer(token) => request
            .header("authorization", format!("Bearer {}", token))
            .header("anthropic-beta", "oauth-2025-04-20"),
    };

    let response = request
        .timeout(request_deadline(on_chunk.is_some()))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Anthropic request failed: {}", e))?;
    let status = response.status();
    if status.as_u16() == 401 {
        let text = response.text().await.unwrap_or_default();
        return Err(format!("unauthorized: {}", error_body(status, &text)));
    }
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(format!("Anthropic {}", error_body(status, &text)));
    }

    if let Some(channel) = on_chunk {
        let (content, _) = consume_sse(response, anthropic_delta_text, |_| false, channel).await?;
        if content.is_empty() {
            return Err("Anthropic returned an empty response.".to_string());
        }
        return Ok(content);
    }

    let text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read Anthropic response: {}", e))?;
    let value: Value =
        serde_json::from_str(&text).map_err(|e| format!("Unexpected Anthropic response: {}", e))?;
    if value["stop_reason"] == json!("refusal") {
        return Err("The model declined this request.".to_string());
    }
    let content = value["content"]
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b["type"] == json!("text"))
                .filter_map(|b| b["text"].as_str())
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();
    if content.is_empty() {
        return Err("Anthropic returned an empty response.".to_string());
    }
    Ok(content)
}

async fn openai_compat_chat(
    base_url: &str,
    api_key: Option<&str>,
    model: &str,
    messages: &[ChatMessage],
    max_tokens: u32,
    temperature: Option<f64>,
    json_mode: bool,
    on_chunk: Option<&Channel<String>>,
) -> Result<String, String> {
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let mut body = json!({
        "model": model,
        "max_tokens": max_tokens,
        "messages": messages
            .iter()
            .map(|m| json!({ "role": m.role, "content": m.content }))
            .collect::<Vec<_>>(),
    });
    if let Some(t) = temperature {
        body["temperature"] = json!(t);
    }
    if json_mode {
        body["response_format"] = json!({ "type": "json_object" });
    }
    if on_chunk.is_some() {
        body["stream"] = json!(true);
    }

    let mut request = http_client()?.post(&url).header("content-type", "application/json");
    if let Some(key) = api_key {
        request = request.header("authorization", format!("Bearer {}", key));
    }

    let response = request
        .timeout(request_deadline(on_chunk.is_some()))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request to {} failed: {}", url, e))?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(error_body(status, &text));
    }

    if let Some(channel) = on_chunk {
        let (content, saw_reasoning) =
            consume_sse(response, openai_delta_text, openai_delta_reasoning, channel).await?;
        if content.is_empty() {
            return Err(if saw_reasoning {
                THINKING_ONLY_ERROR.to_string()
            } else {
                "Model returned an empty response.".to_string()
            });
        }
        return Ok(content);
    }

    let text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;
    let value: Value =
        serde_json::from_str(&text).map_err(|e| format!("Unexpected response: {}", e))?;
    let message = &value["choices"][0]["message"];
    let content = message["content"].as_str().unwrap_or_default();
    if content.is_empty() {
        let thought = message["reasoning"]
            .as_str()
            .or_else(|| message["reasoning_content"].as_str())
            .unwrap_or_default();
        if !thought.is_empty() {
            return Err(THINKING_ONLY_ERROR.to_string());
        }
        return Err("Model returned an empty response.".to_string());
    }
    Ok(content.to_string())
}

async fn gemini_chat(
    api_key: &str,
    model: &str,
    messages: &[ChatMessage],
    max_tokens: u32,
    temperature: Option<f64>,
    json_mode: bool,
) -> Result<String, String> {
    let (system, conversation) = split_system(messages);
    let contents: Vec<Value> = conversation
        .iter()
        .map(|m| {
            json!({
                "role": if m.role == "assistant" { "model" } else { "user" },
                "parts": [{ "text": m.content }],
            })
        })
        .collect();

    let mut generation_config = json!({ "maxOutputTokens": max_tokens });
    if let Some(t) = temperature {
        generation_config["temperature"] = json!(t);
    }
    if json_mode {
        generation_config["responseMimeType"] = json!("application/json");
    }

    let mut body = json!({ "contents": contents, "generationConfig": generation_config });
    if !system.is_empty() {
        body["systemInstruction"] = json!({ "parts": [{ "text": system }] });
    }

    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent",
        model
    );
    let response = http_client()?
        .post(&url)
        .header("x-goog-api-key", api_key)
        .header("content-type", "application/json")
        .timeout(request_deadline(false))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Gemini request failed: {}", e))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read Gemini response: {}", e))?;
    if !status.is_success() {
        return Err(format!("Gemini {}", error_body(status, &text)));
    }

    let value: Value =
        serde_json::from_str(&text).map_err(|e| format!("Unexpected Gemini response: {}", e))?;
    let content = value["candidates"][0]["content"]["parts"]
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter_map(|p| p["text"].as_str())
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();
    if content.is_empty() {
        return Err("Gemini returned an empty response.".to_string());
    }
    Ok(content)
}

#[tauri::command]
pub async fn llm_chat(app: AppHandle, request: LlmChatRequest) -> Result<LlmChatResponse, String> {
    llm_chat_impl(app, request, None).await
}

#[tauri::command]
pub async fn llm_chat_stream(
    app: AppHandle,
    request: LlmChatRequest,
    on_chunk: Channel<String>,
) -> Result<LlmChatResponse, String> {
    llm_chat_impl(app, request, Some(on_chunk)).await
}

async fn llm_chat_impl(
    app: AppHandle,
    request: LlmChatRequest,
    on_chunk: Option<Channel<String>>,
) -> Result<LlmChatResponse, String> {
    if request.messages.is_empty() {
        return Err("No messages to send.".to_string());
    }

    let stored = settings::load_settings(&app);
    let provider = request
        .provider
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| stored.provider.clone());
    let model = request
        .model
        .filter(|m| !m.is_empty())
        .or_else(|| Some(stored.model.clone()).filter(|m| !m.is_empty()))
        .unwrap_or_else(|| default_model(&provider).to_string());
    if model.is_empty() {
        return Err(format!("No model configured for {}. Set one in Settings.", provider));
    }
    let max_tokens = request
        .max_tokens
        .or(stored.max_tokens)
        .unwrap_or(DEFAULT_MAX_TOKENS);
    let temperature = request.temperature.or(stored.temperature);
    let json_mode = request.json_mode.unwrap_or(false);
    let base_url = request.base_url.or(stored.base_url);

    let chunk_sink = if request.stream { on_chunk.as_ref() } else { None };

    // Providers without system-block support get the structured prompt as one
    // plain system message ahead of the conversation.
    let merged: Vec<ChatMessage>;
    let flat_messages: &[ChatMessage] = match &request.system_blocks {
        Some(blocks) if !blocks.is_empty() => {
            let joined = blocks
                .iter()
                .map(|b| b.text.as_str())
                .collect::<Vec<_>>()
                .join("\n\n");
            let mut v = Vec::with_capacity(request.messages.len() + 1);
            v.push(ChatMessage { role: "system".to_string(), content: joined });
            v.extend(request.messages.iter().cloned());
            merged = v;
            &merged
        }
        _ => &request.messages,
    };

    let content = match provider.as_str() {
        "claude-subscription" => {
            let token = oauth::claude_access_token(&app, false).await?;
            let auth = AnthropicAuth::Bearer(token);
            match anthropic_chat(&auth, &model, &request.messages, request.system_blocks.as_deref(), max_tokens, chunk_sink).await {
                Err(e) if e.starts_with("unauthorized") => {
                    let token = oauth::claude_access_token(&app, true).await?;
                    let auth = AnthropicAuth::Bearer(token);
                    anthropic_chat(&auth, &model, &request.messages, request.system_blocks.as_deref(), max_tokens, chunk_sink).await?
                }
                other => other?,
            }
        }
        "anthropic" => {
            let auth = AnthropicAuth::ApiKey(api_key(&app, "anthropic")?);
            anthropic_chat(&auth, &model, &request.messages, request.system_blocks.as_deref(), max_tokens, chunk_sink).await?
        }
        "deepseek" => {
            let key = api_key(&app, "deepseek")?;
            let base = normalize_openai_base(
                &base_url.unwrap_or_else(|| "https://api.deepseek.com/v1".to_string()),
            );
            openai_compat_chat(
                &base,
                Some(&key),
                &model,
                flat_messages,
                max_tokens,
                temperature,
                json_mode,
                chunk_sink,
            )
            .await?
        }
        "openai" => {
            let key = api_key(&app, "openai")?;
            let base = normalize_openai_base(
                &base_url.unwrap_or_else(|| "https://api.openai.com/v1".to_string()),
            );
            openai_compat_chat(
                &base,
                Some(&key),
                &model,
                flat_messages,
                max_tokens,
                temperature,
                json_mode,
                chunk_sink,
            )
            .await?
        }
        "local" => {
            let base = normalize_openai_base(&base_url.ok_or(
                "Local provider needs a base URL (for example http://localhost:11434/v1). Set one in Settings.",
            )?);
            let key = settings::load_credentials(&app).api_keys.get("local").cloned();
            openai_compat_chat(
                &base,
                key.as_deref(),
                &model,
                flat_messages,
                max_tokens,
                temperature,
                json_mode,
                chunk_sink,
            )
            .await?
        }
        "gemini" => {
            let key = api_key(&app, "gemini")?;
            gemini_chat(&key, &model, flat_messages, max_tokens, temperature, json_mode).await?
        }
        other => return Err(format!("Unknown provider: {}", other)),
    };

    Ok(LlmChatResponse {
        content,
        provider,
        model,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(role: &str, content: &str) -> ChatMessage {
        ChatMessage { role: role.to_string(), content: content.to_string() }
    }

    #[test]
    fn legacy_system_string_becomes_one_cached_block() {
        let body = build_anthropic_body(
            false,
            "m",
            &[msg("system", "SYS"), msg("user", "hi")],
            None,
            100,
        );
        let system = body["system"].as_array().unwrap();
        assert_eq!(system.len(), 1);
        assert_eq!(system[0]["text"], "SYS");
        assert_eq!(system[0]["cache_control"]["type"], "ephemeral");
        assert_eq!(body["messages"].as_array().unwrap().len(), 1);
        assert_eq!(body["messages"][0]["role"], "user");
    }

    #[test]
    fn structured_blocks_cache_only_where_flagged() {
        let blocks = vec![
            SystemBlock { text: "BASE".to_string(), cache: true },
            SystemBlock { text: "MODE".to_string(), cache: false },
        ];
        let body = build_anthropic_body(false, "m", &[msg("user", "hi")], Some(&blocks), 100);
        let system = body["system"].as_array().unwrap();
        assert_eq!(system.len(), 2);
        assert_eq!(system[0]["text"], "BASE");
        assert_eq!(system[0]["cache_control"]["type"], "ephemeral");
        assert_eq!(system[1]["text"], "MODE");
        assert!(system[1].get("cache_control").is_none());
    }

    #[test]
    fn bearer_identity_block_leads_and_stays_uncached() {
        let blocks = vec![SystemBlock { text: "BASE".to_string(), cache: true }];
        let body = build_anthropic_body(true, "m", &[msg("user", "hi")], Some(&blocks), 100);
        let system = body["system"].as_array().unwrap();
        assert_eq!(
            system[0]["text"],
            "You are Claude Code, Anthropic's official CLI for Claude."
        );
        assert!(system[0].get("cache_control").is_none());
        assert_eq!(system[1]["text"], "BASE");
        assert_eq!(system[1]["cache_control"]["type"], "ephemeral");
    }

    #[test]
    fn reasoning_deltas_are_detected_but_carry_no_text() {
        let thinking = r#"{"choices":[{"delta":{"reasoning":"hmm","content":null}}]}"#;
        assert!(openai_delta_reasoning(thinking));
        assert_eq!(openai_delta_text(thinking), None);
        let answering = r#"{"choices":[{"delta":{"content":"{"}}]}"#;
        assert!(!openai_delta_reasoning(answering));
    }

    #[test]
    fn bare_origins_get_the_standard_v1_path() {
        assert_eq!(normalize_openai_base("http://localhost:11434"), "http://localhost:11434/v1");
        assert_eq!(normalize_openai_base("http://localhost:11434/"), "http://localhost:11434/v1");
        assert_eq!(normalize_openai_base("http://localhost:11434/v1"), "http://localhost:11434/v1");
        assert_eq!(
            normalize_openai_base("http://box.local:8080/serve/v1/"),
            "http://box.local:8080/serve/v1"
        );
    }

    #[test]
    fn sse_buffer_drains_complete_lines_and_keeps_the_tail() {
        let mut buffer = b"event: x\ndata: {\"a\":1}\n\ndata: par".to_vec();
        let drained = drain_sse_data(&mut buffer);
        assert_eq!(drained, vec!["{\"a\":1}".to_string()]);
        assert_eq!(buffer, b"data: par".to_vec());

        buffer.extend_from_slice(b"tial\n");
        let drained = drain_sse_data(&mut buffer);
        assert_eq!(drained, vec!["partial".to_string()]);
        assert!(buffer.is_empty());
    }

    #[test]
    fn provider_delta_extractors_pull_text_only_from_text_deltas() {
        let anthropic =
            r#"{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}"#;
        assert_eq!(anthropic_delta_text(anthropic), Some("hi".to_string()));
        assert_eq!(anthropic_delta_text(r#"{"type":"message_start"}"#), None);

        let openai = r#"{"choices":[{"delta":{"content":"yo"}}]}"#;
        assert_eq!(openai_delta_text(openai), Some("yo".to_string()));
        assert_eq!(openai_delta_text(r#"{"choices":[{"delta":{}}]}"#), None);
    }

    #[test]
    fn no_system_at_all_omits_the_field() {
        let body = build_anthropic_body(false, "m", &[msg("user", "hi")], None, 100);
        assert!(body.get("system").is_none());
    }
}
