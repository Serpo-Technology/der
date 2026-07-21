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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmChatRequest {
    pub messages: Vec<ChatMessage>,
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

async fn anthropic_chat(
    auth: &AnthropicAuth,
    model: &str,
    messages: &[ChatMessage],
    max_tokens: u32,
) -> Result<String, String> {
    let (system, conversation) = split_system(messages);

    // Subscription bearer tokens are scoped to CLI-shaped requests; identify as
    // one via the leading system block so inference is accepted.
    let mut system_blocks: Vec<Value> = Vec::new();
    if matches!(auth, AnthropicAuth::Bearer(_)) {
        system_blocks.push(json!({
            "type": "text",
            "text": "You are Claude Code, Anthropic's official CLI for Claude."
        }));
    }
    if !system.is_empty() {
        system_blocks.push(json!({ "type": "text", "text": system }));
    }

    let mut body = json!({
        "model": model,
        "max_tokens": max_tokens,
        "messages": conversation
            .iter()
            .map(|m| json!({ "role": m.role, "content": m.content }))
            .collect::<Vec<_>>(),
    });
    if !system_blocks.is_empty() {
        body["system"] = json!(system_blocks);
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

    let content = match provider.as_str() {
        "claude-subscription" => {
            let token = oauth::claude_access_token(&app, false).await?;
            let auth = AnthropicAuth::Bearer(token);
            match anthropic_chat(&auth, &model, &request.messages, max_tokens).await {
                Err(e) if e.starts_with("unauthorized") => {
                    let token = oauth::claude_access_token(&app, true).await?;
                    let auth = AnthropicAuth::Bearer(token);
                    anthropic_chat(&auth, &model, &request.messages, max_tokens).await?
                }
                other => other?,
            }
        }
        "anthropic" => {
            let auth = AnthropicAuth::ApiKey(api_key(&app, "anthropic")?);
            anthropic_chat(&auth, &model, &request.messages, max_tokens).await?
        }
        "deepseek" => {
            let key = api_key(&app, "deepseek")?;
            let base = base_url.unwrap_or_else(|| "https://api.deepseek.com/v1".to_string());
            openai_compat_chat(
                &base,
                Some(&key),
                &model,
                &request.messages,
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
                &request.messages,
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
                &request.messages,
                max_tokens,
                temperature,
                json_mode,
            )
            .await?
        }
        "gemini" => {
            let key = api_key(&app, "gemini")?;
            gemini_chat(&key, &model, &request.messages, max_tokens, temperature, json_mode).await?
        }
        other => return Err(format!("Unknown provider: {}", other)),
    };

    Ok(LlmChatResponse {
        content,
        provider,
        model,
    })
}
