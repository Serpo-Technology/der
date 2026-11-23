//! DER's LLM gateway. It owns the model settings, the API keys, and the
//! Claude sign-in tokens, and it makes every request to a model provider,
//! so a key is read and sent in one place. Everything a caller can ask for
//! is a `Request`, and no `Reply` holds a key or a token: settings screens
//! get short previews. `serve` runs the gateway as a process speaking one
//! JSON line per request and reply, with streamed text as part lines. The
//! crate has no dependency on the desktop shell.

use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

mod chat;
mod oauth;
mod store;

pub use chat::{ChatMessage, ChatRequest, ChatResponse, ChunkSink, SystemBlock};
pub use store::{default_model, ClaudeOauthStatus, Settings, SettingsView, PROVIDERS};

/// Everything the gateway does for a caller.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Request {
    /// Send one chat request to its provider. Text deltas arrive as parts
    /// when the request asks to stream.
    Chat(ChatRequest),
    /// The settings and a preview of each credential.
    SettingsGet,
    /// Save the model settings; answers the refreshed view.
    SettingsSet { settings: Settings },
    /// Save one provider's key or token; answers the refreshed view.
    CredentialSet { provider: String, secret: String },
    /// Remove one provider's key or token; answers the refreshed view.
    CredentialClear { provider: String },
    /// Whether the configured provider can answer.
    Ready,
    /// Start a Claude sign-in; answers the authorize URL to open.
    SignInStart,
    /// Finish the sign-in with the code the callback page showed; answers
    /// the refreshed view.
    SignInFinish { code: String },
}

impl Request {
    /// Whether answering means talking to a provider, which can take as
    /// long as the provider does.
    pub fn uses_network(&self) -> bool {
        matches!(self, Request::Chat(_) | Request::SignInFinish { .. })
    }
}

/// The answer to a `Request`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "reply", content = "data", rename_all = "camelCase")]
pub enum Reply {
    Chat(ChatResponse),
    Settings(SettingsView),
    Ready(bool),
    SignInUrl(String),
    Error(String),
}

/// What a line that is not a request is answered with. The text is fixed so
/// that nothing from the line, which may hold a key, comes back.
const UNREADABLE: &str = "The request could not be read";

/// The gateway over one settings directory.
pub struct Service {
    store: store::Store,
    sign_in: oauth::SignIn,
}

impl Service {
    pub fn new(settings_dir: impl Into<PathBuf>) -> Self {
        Service {
            store: store::Store::new(settings_dir),
            sign_in: oauth::SignIn::default(),
        }
    }

    /// Answers any request. Text deltas of a streamed chat go to `on_part`.
    /// Requests that use the network need an async runtime with IO.
    pub async fn handle(&self, request: Request, on_part: Option<ChunkSink<'_>>) -> Reply {
        match request {
            Request::Chat(chat) => match chat::chat(&self.store, &self.sign_in, chat, on_part).await {
                Ok(response) => Reply::Chat(response),
                Err(message) => Reply::Error(message),
            },
            Request::SignInFinish { code } => match self.sign_in.finish(&self.store, &code).await {
                Ok(()) => Reply::Settings(self.store.view()),
                Err(message) => Reply::Error(message),
            },
            other => self.handle_settings(other),
        }
    }

    /// Answers a request that only touches the gateway's own files or
    /// memory, without an async runtime.
    pub fn handle_settings(&self, request: Request) -> Reply {
        let viewed = |outcome: Result<(), String>| match outcome {
            Ok(()) => Reply::Settings(self.store.view()),
            Err(message) => Reply::Error(message),
        };
        match request {
            Request::Chat(_) | Request::SignInFinish { .. } => {
                Reply::Error("This request needs the network".to_string())
            }
            Request::SettingsGet => Reply::Settings(self.store.view()),
            Request::SettingsSet { settings } => viewed(self.store.save_settings(&settings)),
            Request::CredentialSet { provider, secret } => viewed(self.store.set_credential(&provider, &secret)),
            Request::CredentialClear { provider } => viewed(self.store.clear_credential(&provider)),
            Request::Ready => Reply::Ready(self.store.ready()),
            Request::SignInStart => match self.sign_in.start() {
                Ok(url) => Reply::SignInUrl(url),
                Err(message) => Reply::Error(message),
            },
        }
    }
}

/// Serves requests over the settings directory until the input closes.
/// Settings and credential requests are answered in the order they arrive.
/// Requests that use the network run side by side and answer when the
/// provider has; the ones still running when the input closes are dropped,
/// since nobody is left to read their replies.
pub fn serve<R, W>(settings_dir: impl Into<PathBuf>, input: R, output: W) -> std::io::Result<()>
where
    R: BufRead,
    W: Write + Send + 'static,
{
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let service = Arc::new(Service::new(settings_dir));
    let outcome = der_wire::serve(
        input,
        output,
        || Reply::Error(UNREADABLE.to_string()),
        |request: Request, responder: der_wire::Responder<Reply>| {
            if !request.uses_network() {
                responder.answer(service.handle_settings(request));
                return;
            }
            let service = service.clone();
            runtime.spawn(async move {
                let reply = {
                    let mut forward = |text: &str| responder.part(text);
                    service.handle(request, Some(&mut forward)).await
                };
                responder.answer(reply);
            });
        },
    );
    runtime.shutdown_background();
    outcome
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;

    use super::*;

    const KEY: &str = "sk-local-0123456789abcdef";

    /// A loopback server answering one request with `response` and
    /// returning the request it received, lowercased.
    fn provider(response: String) -> (String, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("loopback listener");
        let origin = format!("http://{}", listener.local_addr().expect("local addr"));
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                let read = stream.read(&mut chunk).expect("read request");
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..read]);
                let text = String::from_utf8_lossy(&request).to_lowercase();
                if let Some((head, body)) = text.split_once("\r\n\r\n") {
                    let length = head
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length:"))
                        .and_then(|value| value.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    if body.len() >= length {
                        break;
                    }
                }
            }
            stream.write_all(response.as_bytes()).expect("write response");
            String::from_utf8_lossy(&request).to_lowercase()
        });
        (origin, server)
    }

    fn json_response(body: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
    }

    fn sse_response(deltas: &[&str]) -> String {
        let mut body = String::new();
        for delta in deltas {
            let event = serde_json::json!({ "choices": [{ "delta": { "content": delta } }] });
            body.push_str(&format!("data: {event}\n\n"));
        }
        body.push_str("data: [DONE]\n\n");
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
    }

    fn local(base_url: &str) -> Request {
        Request::SettingsSet {
            settings: Settings {
                provider: "local".to_string(),
                model: "test-model".to_string(),
                base_url: Some(base_url.to_string()),
                temperature: None,
                max_tokens: None,
            },
        }
    }

    fn ask(stream: bool) -> ChatRequest {
        ChatRequest {
            messages: vec![ChatMessage {
                role: "user".to_string(),
                content: "Hello".to_string(),
            }],
            system_blocks: None,
            stream,
            provider: None,
            model: None,
            max_tokens: None,
            temperature: None,
            json_mode: None,
            base_url: None,
        }
    }

    fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(future)
    }

    #[test]
    fn a_chat_goes_to_the_saved_local_address_with_the_stored_key() {
        let (origin, server) = provider(json_response(
            r#"{"choices":[{"message":{"role":"assistant","content":"Hi there"}}]}"#,
        ));
        let dir = tempfile::tempdir().expect("temp dir");
        let service = Service::new(dir.path());
        service.handle_settings(local(&origin));
        service.handle_settings(Request::CredentialSet {
            provider: "local".to_string(),
            secret: KEY.to_string(),
        });

        let reply = block_on(service.handle(Request::Chat(ask(false)), None));
        assert_eq!(
            reply,
            Reply::Chat(ChatResponse {
                content: "Hi there".to_string(),
                provider: "local".to_string(),
                model: "test-model".to_string(),
            })
        );
        let request = server.join().expect("server");
        assert!(request.starts_with("post /v1/chat/completions "), "{request}");
        assert!(request.contains(&format!("authorization: bearer {KEY}")), "{request}");
        assert!(request.contains("\"model\":\"test-model\""), "{request}");
    }

    #[test]
    fn a_streamed_chat_hands_over_each_delta_and_returns_the_whole_text() {
        let (origin, server) = provider(sse_response(&["Hel", "lo ", "there"]));
        let dir = tempfile::tempdir().expect("temp dir");
        let service = Service::new(dir.path());
        service.handle_settings(local(&origin));

        let mut parts: Vec<String> = Vec::new();
        let mut collect = |text: &str| parts.push(text.to_string());
        let reply = block_on(service.handle(Request::Chat(ask(true)), Some(&mut collect)));
        let Reply::Chat(response) = reply else {
            panic!("a chat reply: {reply:?}");
        };
        assert_eq!(response.content, "Hello there");
        assert_eq!(parts, vec!["Hel", "lo ", "there"]);
        let request = server.join().expect("server");
        assert!(request.contains("\"stream\":true"), "{request}");
        assert!(!request.contains("authorization:"), "no key is saved for local: {request}");
    }

    #[test]
    fn a_request_cannot_say_where_a_key_is_sent() {
        let dir = tempfile::tempdir().expect("temp dir");
        let service = Service::new(dir.path());
        service.handle_settings(Request::CredentialSet {
            provider: "openai".to_string(),
            secret: KEY.to_string(),
        });
        let mut request = ask(false);
        request.provider = Some("openai".to_string());
        request.base_url = Some("https://api.elsewhere.dev/v1".to_string());
        let reply = block_on(service.handle(Request::Chat(request), None));
        let Reply::Error(message) = reply else {
            panic!("a refusal: {reply:?}");
        };
        assert!(message.contains("cannot name a base URL"), "{message}");
    }

    #[test]
    fn a_provider_without_its_key_points_at_settings() {
        let dir = tempfile::tempdir().expect("temp dir");
        let service = Service::new(dir.path());
        for (provider, expected) in [
            ("openai", "No API key configured for openai"),
            ("claude-subscription", "not connected"),
            ("local", "Local provider needs a base URL"),
            ("nobody", "Unknown provider: nobody"),
        ] {
            let mut request = ask(false);
            request.provider = Some(provider.to_string());
            request.model = Some("test-model".to_string());
            let reply = block_on(service.handle(Request::Chat(request), None));
            let Reply::Error(message) = reply else {
                panic!("{provider}: {reply:?}");
            };
            assert!(message.contains(expected), "{provider}: {message}");
        }
    }

    #[test]
    fn no_reply_to_a_settings_request_holds_a_key_or_a_token() {
        let dir = tempfile::tempdir().expect("temp dir");
        let service = Service::new(dir.path());
        let replies = [
            service.handle_settings(Request::CredentialSet {
                provider: "openai".to_string(),
                secret: KEY.to_string(),
            }),
            service.handle_settings(Request::CredentialSet {
                provider: "claude-subscription".to_string(),
                secret: KEY.to_string(),
            }),
            service.handle_settings(Request::SettingsGet),
            service.handle_settings(Request::Ready),
            service.handle_settings(Request::SignInStart),
            service.handle_settings(Request::CredentialClear {
                provider: "openai".to_string(),
            }),
        ];
        for reply in &replies {
            let line = serde_json::to_string(reply).expect("serializes");
            assert!(!line.contains(KEY), "{line}");
        }
        assert!(matches!(replies[4], Reply::SignInUrl(ref url) if url.contains("code_challenge=")));
    }

    #[test]
    fn requests_and_replies_survive_a_line_of_json() {
        let line = serde_json::to_string(&Request::Chat(ask(true))).expect("serializes");
        assert!(line.contains("\"op\":\"chat\""), "{line}");
        assert!(line.contains("\"stream\":true"), "{line}");
        let back: Request = serde_json::from_str(&line).expect("parses");
        assert_eq!(serde_json::to_string(&back).expect("serializes"), line);
        // What a settings screen sends parses with everything else left out.
        let webview: Request =
            serde_json::from_str(r#"{"op":"chat","messages":[{"role":"user","content":"Hi"}],"maxTokens":512}"#)
                .expect("parses");
        assert!(matches!(webview, Request::Chat(ref chat) if chat.max_tokens == Some(512) && !chat.stream));

        for reply in [
            Reply::Chat(ChatResponse {
                content: "Hi".into(),
                provider: "local".into(),
                model: "m".into(),
            }),
            Reply::Settings(SettingsView::empty()),
            Reply::Ready(true),
            Reply::SignInUrl("https://claude.ai/oauth/authorize?x=1".into()),
            Reply::Error("refused".into()),
        ] {
            let line = serde_json::to_string(&reply).expect("serializes");
            assert!(!line.contains('\n'));
            assert_eq!(serde_json::from_str::<Reply>(&line).expect("parses"), reply);
        }
    }

    #[test]
    fn the_gateway_streams_parts_then_the_reply_over_its_pipes() {
        let (origin, server) = provider(sse_response(&["one ", "two"]));
        let dir = tempfile::tempdir().expect("temp dir");
        let (request_reader, mut requests) = std::io::pipe().expect("pipe");
        let (replies, reply_writer) = std::io::pipe().expect("pipe");
        let settings = dir.path().to_path_buf();
        let thread = std::thread::spawn(move || serve(settings, BufReader::new(request_reader), reply_writer));
        let mut replies = BufReader::new(replies);
        let mut next = || -> serde_json::Value {
            let mut line = String::new();
            replies.read_line(&mut line).expect("reads");
            serde_json::from_str(&line).unwrap_or_else(|error| panic!("{error}: {line:?}"))
        };
        let mut send = |id: u64, request: Request| {
            let line = serde_json::to_string(&der_wire::RequestLine { id, request }).expect("serializes");
            writeln!(requests, "{line}").expect("writes");
        };

        send(1, local(&origin));
        assert_eq!(next()["id"], 1);
        send(2, Request::Chat(ask(true)));
        assert_eq!(next(), serde_json::json!({ "id": 2, "part": "one " }));
        assert_eq!(next(), serde_json::json!({ "id": 2, "part": "two" }));
        let done = next();
        assert_eq!(done["id"], 2);
        assert_eq!(done["reply"]["reply"], "chat");
        assert_eq!(done["reply"]["data"]["content"], "one two");
        server.join().expect("server");

        drop(send);
        drop(requests);
        thread.join().expect("no panic").expect("ends cleanly when the input closes");
    }
}
