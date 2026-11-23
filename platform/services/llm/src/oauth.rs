//! The Claude subscription sign-in (OAuth with PKCE) and the tokens it
//! yields. The verifier of a sign-in in progress and the tokens stay in
//! this process; a caller gets the authorize URL to open and, afterward,
//! the redacted settings view.

use std::sync::Mutex;
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::store::{ClaudeOauthTokens, Store};

/// Public client id of Anthropic's CLI OAuth app; the flow mirrors the one the
/// CLI itself performs, with the code displayed on the callback page for the
/// user to paste back.
const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL: &str = "https://claude.ai/oauth/authorize";
const TOKEN_URL: &str = "https://console.anthropic.com/v1/oauth/token";
const REDIRECT_URI: &str = "https://console.anthropic.com/oauth/code/callback";
const SCOPES: &str = "org:create_api_key user:profile user:inference";

struct PendingAuth {
    verifier: String,
    state: String,
}

/// The sign-in in progress, if any, and the lock that keeps two requests
/// from refreshing the tokens at once.
#[derive(Default)]
pub(crate) struct SignIn {
    pending: Mutex<Option<PendingAuth>>,
    refreshing: tokio::sync::Mutex<()>,
}

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

/// The code and the state in what the callback page shows, which is
/// `code#state` or the code alone.
fn split_pasted(raw: &str) -> (&str, Option<&str>) {
    match raw.split_once('#') {
        Some((code, state)) => (code.trim(), Some(state.trim())),
        None => (raw, None),
    }
}

impl SignIn {
    /// Starts a sign-in and returns the authorize URL for the user's
    /// browser. Starting again replaces the sign-in in progress.
    pub fn start(&self) -> Result<String, String> {
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

        *self
            .pending
            .lock()
            .map_err(|_| "OAuth state lock poisoned".to_string())? = Some(PendingAuth { verifier, state });
        Ok(url)
    }

    /// Completes the sign-in with the `code#state` string the callback page
    /// shows and saves the tokens.
    pub async fn finish(&self, store: &Store, code: &str) -> Result<(), String> {
        let auth = self
            .pending
            .lock()
            .map_err(|_| "OAuth state lock poisoned".to_string())?
            .take()
            .ok_or("No sign-in in progress. Click \"Sign in with Claude\" first.")?;

        let raw = code.trim();
        if raw.is_empty() {
            return Err("Paste the code shown after authorizing in the browser.".to_string());
        }
        let (code_part, state_part) = split_pasted(raw);
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

        let tokens = tokens_from_response(response, None);
        store.update_credentials(|credentials| credentials.claude_oauth = Some(tokens))
    }

    async fn refresh(&self, store: &Store, refresh_token: String) -> Result<ClaudeOauthTokens, String> {
        let response = exchange(json!({
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": CLIENT_ID,
        }))
        .await
        .map_err(|e| format!("Claude session refresh failed ({}). Sign in again in Settings.", e))?;

        let tokens = tokens_from_response(response, Some(refresh_token));
        let saved = tokens.clone();
        store.update_credentials(|credentials| credentials.claude_oauth = Some(saved))?;
        Ok(tokens)
    }

    /// Returns a currently valid access token, refreshing it when close to
    /// expiry. `force_refresh` retries the refresh grant even if the token
    /// looks fresh (used after a 401). One request refreshes at a time, so
    /// a second one finds the fresh tokens the first saved.
    pub async fn access_token(&self, store: &Store, force_refresh: bool) -> Result<String, String> {
        let _refreshing = self.refreshing.lock().await;
        let tokens = store
            .credentials()
            .claude_oauth
            .ok_or("Claude subscription is not connected. Sign in from Settings.")?;

        let near_expiry = tokens
            .expires_at
            .map(|at| chrono::Utc::now().timestamp() > at - 120)
            .unwrap_or(false);

        if force_refresh || near_expiry {
            match tokens.refresh_token.clone() {
                Some(rt) => return Ok(self.refresh(store, rt).await?.access_token),
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
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(future)
    }

    fn query(url: &str, name: &str) -> String {
        let (_, query) = url.split_once('?').expect("a query");
        query
            .split('&')
            .find_map(|pair| pair.strip_prefix(&format!("{name}=")))
            .unwrap_or_else(|| panic!("{name} in {url}"))
            .to_string()
    }

    #[test]
    fn a_started_sign_in_gives_an_authorize_url_with_a_challenge() {
        let sign_in = SignIn::default();
        let url = sign_in.start().expect("starts");
        assert!(url.starts_with("https://claude.ai/oauth/authorize?"), "{url}");
        assert_eq!(query(&url, "client_id"), CLIENT_ID);
        assert_eq!(query(&url, "code_challenge_method"), "S256");
        assert_eq!(query(&url, "code_challenge").len(), 43, "a SHA-256 digest in base64url");
        assert_eq!(query(&url, "redirect_uri"), "https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback");

        let again = sign_in.start().expect("starts");
        assert_ne!(query(&url, "state"), query(&again, "state"));
        assert_ne!(query(&url, "code_challenge"), query(&again, "code_challenge"));
    }

    #[test]
    fn finishing_needs_a_sign_in_in_progress_a_code_and_the_same_state() {
        let dir = tempfile::tempdir().expect("temp dir");
        let store = Store::new(dir.path());
        let sign_in = SignIn::default();

        let none = block_on(sign_in.finish(&store, "code")).expect_err("nothing started");
        assert!(none.contains("No sign-in in progress"), "{none}");

        sign_in.start().expect("starts");
        let empty = block_on(sign_in.finish(&store, "   ")).expect_err("no code");
        assert!(empty.contains("Paste the code"), "{empty}");

        sign_in.start().expect("starts");
        let mismatch = block_on(sign_in.finish(&store, "code#someone-elses-state")).expect_err("state");
        assert!(mismatch.contains("state mismatch"), "{mismatch}");
        assert!(store.credentials().claude_oauth.is_none());
    }

    #[test]
    fn a_pasted_token_is_used_as_is_and_a_missing_one_points_at_settings() {
        let dir = tempfile::tempdir().expect("temp dir");
        let store = Store::new(dir.path());
        let sign_in = SignIn::default();
        let missing = block_on(sign_in.access_token(&store, false)).expect_err("not connected");
        assert!(missing.contains("not connected"), "{missing}");

        store.set_credential("claude-subscription", "pasted-token").expect("saves");
        assert_eq!(block_on(sign_in.access_token(&store, false)), Ok("pasted-token".to_string()));
        // Without a refresh token a forced refresh has nothing to do.
        assert_eq!(block_on(sign_in.access_token(&store, true)), Ok("pasted-token".to_string()));
    }

    #[test]
    fn an_expired_session_without_a_refresh_token_asks_for_a_new_sign_in() {
        let dir = tempfile::tempdir().expect("temp dir");
        let store = Store::new(dir.path());
        store
            .update_credentials(|credentials| {
                credentials.claude_oauth = Some(ClaudeOauthTokens {
                    access_token: "old".to_string(),
                    refresh_token: None,
                    expires_at: Some(chrono::Utc::now().timestamp() - 10),
                })
            })
            .expect("saves");
        let expired = block_on(SignIn::default().access_token(&store, false)).expect_err("expired");
        assert!(expired.contains("Sign in again"), "{expired}");
    }
}
