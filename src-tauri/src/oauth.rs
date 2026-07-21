use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::settings::{self, ClaudeOauthTokens, LlmSettingsView};

/// Public client id of Anthropic's CLI OAuth app; the flow mirrors the one the
/// CLI itself performs, with the code displayed on the callback page for the
/// user to paste back.
const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL: &str = "https://claude.ai/oauth/authorize";
const TOKEN_URL: &str = "https://console.anthropic.com/v1/oauth/token";
const REDIRECT_URI: &str = "https://console.anthropic.com/oauth/code/callback";
const SCOPES: &str = "org:create_api_key user:profile user:inference";

pub struct PendingAuth {
    verifier: String,
    state: String,
}

#[derive(Default)]
pub struct PendingOauth(pub Mutex<Option<PendingAuth>>);

fn random_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// Percent-encode a query component (RFC 3986 unreserved set kept literal).
fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{:02X}", byte)),
        }
    }
    out
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<i64>,
}

fn tokens_from_response(response: TokenResponse, previous_refresh: Option<String>) -> ClaudeOauthTokens {
    ClaudeOauthTokens {
        access_token: response.access_token,
        refresh_token: response.refresh_token.or(previous_refresh),
        expires_at: response
            .expires_in
            .map(|s| chrono::Utc::now().timestamp() + s),
    }
}

async fn exchange(body: serde_json::Value) -> Result<TokenResponse, String> {
    let response = http_client()?
        .post(TOKEN_URL)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Token request failed: {}", e))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read token response: {}", e))?;
    if !status.is_success() {
        return Err(format!(
            "Token endpoint returned {}: {}",
            status,
            text.chars().take(300).collect::<String>()
        ));
    }
    serde_json::from_str(&text).map_err(|e| format!("Unexpected token response: {}", e))
}

/// Starts the browser sign-in and returns the authorize URL (shown in the UI
/// in case the browser did not open).
#[tauri::command]
pub async fn claude_oauth_start(
    app: AppHandle,
    pending: State<'_, PendingOauth>,
) -> Result<String, String> {
    let verifier = random_token();
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state = random_token();

    let url = format!(
        "{}?code=true&client_id={}&response_type=code&redirect_uri={}&scope={}&code_challenge={}&code_challenge_method=S256&state={}",
        AUTHORIZE_URL,
        CLIENT_ID,
        encode(REDIRECT_URI),
        encode(SCOPES),
        challenge,
        state
    );

    *pending
        .0
        .lock()
        .map_err(|_| "OAuth state lock poisoned".to_string())? = Some(PendingAuth { verifier, state });

    app.opener()
        .open_url(url.clone(), None::<&str>)
        .map_err(|e| format!("Failed to open browser: {}", e))?;
    Ok(url)
}

/// Completes the sign-in with the `code#state` string the callback page shows.
#[tauri::command]
pub async fn claude_oauth_finish(
    app: AppHandle,
    pending: State<'_, PendingOauth>,
    code: String,
) -> Result<LlmSettingsView, String> {
    let auth = pending
        .0
        .lock()
        .map_err(|_| "OAuth state lock poisoned".to_string())?
        .take()
        .ok_or("No sign-in in progress. Click \"Sign in with Claude\" first.")?;

    let raw = code.trim();
    if raw.is_empty() {
        return Err("Paste the code shown after authorizing in the browser.".to_string());
    }
    let (code_part, state_part) = match raw.split_once('#') {
        Some((c, s)) => (c.trim(), Some(s.trim())),
        None => (raw, None),
    };
    if let Some(returned_state) = state_part {
        if !returned_state.is_empty() && returned_state != auth.state {
            return Err("Sign-in state mismatch. Start the sign-in again.".to_string());
        }
    }

    let response = exchange(json!({
        "grant_type": "authorization_code",
        "code": code_part,
        "state": state_part.unwrap_or(&auth.state),
        "client_id": CLIENT_ID,
        "redirect_uri": REDIRECT_URI,
        "code_verifier": auth.verifier,
    }))
    .await?;

    let mut credentials = settings::load_credentials(&app);
    credentials.claude_oauth = Some(tokens_from_response(response, None));
    settings::save_credentials(&app, &credentials)?;
    Ok(settings::build_view(&app))
}

async fn refresh(app: &AppHandle, refresh_token: String) -> Result<ClaudeOauthTokens, String> {
    let response = exchange(json!({
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": CLIENT_ID,
    }))
    .await
    .map_err(|e| format!("Claude session refresh failed ({}). Sign in again in Settings.", e))?;

    let tokens = tokens_from_response(response, Some(refresh_token));
    let mut credentials = settings::load_credentials(app);
    credentials.claude_oauth = Some(tokens.clone());
    settings::save_credentials(app, &credentials)?;
    Ok(tokens)
}

/// Returns a currently valid access token, refreshing it when close to expiry.
/// `force_refresh` retries the refresh grant even if the token looks fresh
/// (used after a 401).
pub async fn claude_access_token(app: &AppHandle, force_refresh: bool) -> Result<String, String> {
    let tokens = settings::load_credentials(app)
        .claude_oauth
        .ok_or("Claude subscription is not connected. Sign in from Settings.")?;

    let near_expiry = tokens
        .expires_at
        .map(|at| chrono::Utc::now().timestamp() > at - 120)
        .unwrap_or(false);

    if force_refresh || near_expiry {
        match tokens.refresh_token.clone() {
            Some(rt) => return Ok(refresh(app, rt).await?.access_token),
            None if near_expiry => {
                return Err(
                    "Claude session expired and no refresh token is stored. Sign in again in Settings."
                        .to_string(),
                )
            }
            None => {}
        }
    }
    Ok(tokens.access_token)
}
