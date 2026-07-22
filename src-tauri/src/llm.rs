use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
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

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))
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

async fn anthropic_chat(
    auth: &AnthropicAuth,
    model: &str,
    messages: &[ChatMessage],
    system_blocks: Option<&[SystemBlock]>,
    max_tokens: u32,
) -> Result<String, String> {
    let body = build_anthropic_body(
        matches!(auth, AnthropicAuth::Bearer(_)),
        model,
        messages,
        system_blocks,
        max_tokens,
    );

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
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Anthropic request failed: {}", e))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read Anthropic response: {}", e))?;
    if status.as_u16() == 401 {
        return Err(format!("unauthorized: {}", error_body(status, &text)));
    }
    if !status.is_success() {
        return Err(format!("Anthropic {}", error_body(status, &text)));
    }

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

    let mut request = http_client()?.post(&url).header("content-type", "application/json");
    if let Some(key) = api_key {
        request = request.header("authorization", format!("Bearer {}", key));
    }

    let response = request
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request to {} failed: {}", url, e))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;
    if !status.is_success() {
        return Err(error_body(status, &text));
    }

    let value: Value =
        serde_json::from_str(&text).map_err(|e| format!("Unexpected response: {}", e))?;
    value["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Model returned an empty response.".to_string())
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
            match anthropic_chat(&auth, &model, &request.messages, request.system_blocks.as_deref(), max_tokens).await {
                Err(e) if e.starts_with("unauthorized") => {
                    let token = oauth::claude_access_token(&app, true).await?;
                    let auth = AnthropicAuth::Bearer(token);
                    anthropic_chat(&auth, &model, &request.messages, request.system_blocks.as_deref(), max_tokens).await?
                }
                other => other?,
            }
        }
        "anthropic" => {
            let auth = AnthropicAuth::ApiKey(api_key(&app, "anthropic")?);
            anthropic_chat(&auth, &model, &request.messages, request.system_blocks.as_deref(), max_tokens).await?
        }
        "deepseek" => {
            let key = api_key(&app, "deepseek")?;
            let base = base_url.unwrap_or_else(|| "https://api.deepseek.com/v1".to_string());
            openai_compat_chat(
                &base,
                Some(&key),
                &model,
                flat_messages,
                max_tokens,
                temperature,
                json_mode,
            )
            .await?
        }
        "openai" => {
            let key = api_key(&app, "openai")?;
            let base = base_url.unwrap_or_else(|| "https://api.openai.com/v1".to_string());
            openai_compat_chat(
                &base,
                Some(&key),
                &model,
                flat_messages,
                max_tokens,
                temperature,
                json_mode,
            )
            .await?
        }
        "local" => {
            let base = base_url.ok_or(
                "Local provider needs a base URL (for example http://localhost:11434/v1). Set one in Settings.",
            )?;
            let key = settings::load_credentials(&app).api_keys.get("local").cloned();
            openai_compat_chat(
                &base,
                key.as_deref(),
                &model,
                flat_messages,
                max_tokens,
                temperature,
                json_mode,
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
    fn no_system_at_all_omits_the_field() {
        let body = build_anthropic_body(false, "m", &[msg("user", "hi")], None, 100);
        assert!(body.get("system").is_none());
    }
}
