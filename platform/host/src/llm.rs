//! The host's door to the LLM gateway. The model settings, the API keys,
//! the Claude sign-in tokens, and every request to a model provider live in
//! the gateway, a separate process. The host passes chat requests and
//! typed credentials in and gets content, text deltas, and redacted views
//! back, so a stored key or token is never in the host's memory.

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use der_llm::{Reply, Request};
use tauri::ipc::Channel;
use tauri::AppHandle;

pub use der_llm::{ChatMessage, ChatRequest, ChatResponse, ChunkSink, SettingsView, SystemBlock};

/// How long a settings or credential request may take to answer.
const SETTINGS_WAIT: Duration = Duration::from_secs(30);
/// How long finishing a sign-in may take: one token exchange, which the
/// gateway bounds at 30 seconds.
const SIGN_IN_WAIT: Duration = Duration::from_secs(60);
/// What a chat is given on top of the gateway's own deadline, which leaves
/// room for a token refresh before the request.
const CHAT_WAIT_MARGIN: Duration = Duration::from_secs(90);
/// The gateway's deadlines for one provider request, plain and streamed.
const PLAIN_DEADLINE: Duration = Duration::from_secs(300);
const STREAM_DEADLINE: Duration = Duration::from_secs(1800);

type Client = der_wire::Client<Request, Reply>;

#[derive(Clone)]
enum Door {
    Process(Arc<Client>),
    #[cfg(test)]
    Local(Arc<der_llm::Service>),
}

#[derive(Clone)]
pub struct Llm {
    door: Door,
}

fn wait_for(request: &Request) -> Duration {
    match request {
        Request::Chat(chat) if chat.stream => STREAM_DEADLINE + CHAT_WAIT_MARGIN,
        Request::Chat(_) => PLAIN_DEADLINE + CHAT_WAIT_MARGIN,
        Request::SignInFinish { .. } => SIGN_IN_WAIT,
        _ => SETTINGS_WAIT,
    }
}

impl Llm {
    /// The gateway over this app's settings directory, shared by every
    /// caller in the process.
    pub fn for_app(app: &AppHandle) -> Result<Self, String> {
        static CLIENT: OnceLock<Arc<Client>> = OnceLock::new();
        let settings_dir = crate::settings::settings_dir(app)?;
        let client = match CLIENT.get() {
            Some(client) => client,
            None => {
                let client = crate::services::client("LLM", crate::services::LLM, &settings_dir)?;
                CLIENT.get_or_init(|| Arc::new(client))
            }
        };
        Ok(Llm {
            door: Door::Process(client.clone()),
        })
    }

    /// The gateway run inside the test process over an explicit settings
    /// directory.
    #[cfg(test)]
    pub fn at(settings_dir: &std::path::Path) -> Self {
        Llm {
            door: Door::Local(Arc::new(der_llm::Service::new(settings_dir))),
        }
    }

    /// Answers one request. Blocks until the gateway has.
    pub fn call(&self, request: Request) -> Reply {
        self.call_streamed(request, &mut |_| {})
    }

    /// Like `call`, handing each text delta of a streamed chat to `on_part`
    /// as it arrives.
    pub fn call_streamed(&self, request: Request, on_part: ChunkSink<'_>) -> Reply {
        match &self.door {
            Door::Process(client) => {
                let wait = wait_for(&request);
                client
                    .call_streamed(request, wait, on_part)
                    .unwrap_or_else(Reply::Error)
            }
            #[cfg(test)]
            Door::Local(service) => tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("runtime")
                .block_on(service.handle(request, Some(on_part))),
        }
    }

    /// Runs a blocking call off the async threads.
    async fn ask(&self, request: Request) -> Result<Reply, String> {
        let llm = self.clone();
        tauri::async_runtime::spawn_blocking(move || llm.call(request))
            .await
            .map_err(|error| format!("The LLM request could not run: {}", error))
    }
}

fn view_of(reply: Reply) -> Result<SettingsView, String> {
    match reply {
        Reply::Settings(view) => Ok(view),
        Reply::Error(message) => Err(message),
        _ => Err("The LLM gateway answered out of turn".to_string()),
    }
}

/// The settings and a preview of each credential, after `request` has been
/// applied.
pub async fn settings_request(app: &AppHandle, request: Request) -> Result<SettingsView, String> {
    view_of(Llm::for_app(app)?.ask(request).await?)
}

/// What settings screens see. A gateway that cannot answer shows as one
/// with nothing saved.
pub fn settings_view(app: &AppHandle) -> SettingsView {
    Llm::for_app(app)
        .and_then(|llm| view_of(llm.call(Request::SettingsGet)))
        .unwrap_or_else(|_| SettingsView::empty())
}

/// True when the configured provider can answer: signed in for the Claude
/// subscription, a stored key for API providers, a base URL for local. The
/// native home gates its create field on this.
pub fn ready(app: &AppHandle) -> bool {
    Llm::for_app(app).is_ok_and(|llm| llm.call(Request::Ready) == Reply::Ready(true))
}

/// Starts a Claude sign-in and answers the authorize URL to open.
pub async fn sign_in_start(app: &AppHandle) -> Result<String, String> {
    match Llm::for_app(app)?.ask(Request::SignInStart).await? {
        Reply::SignInUrl(url) => Ok(url),
        Reply::Error(message) => Err(message),
        _ => Err("The LLM gateway answered out of turn".to_string()),
    }
}

/// Sends one chat through the gateway. Text deltas go to `on_chunk` when
/// the request asks to stream and a sink is given; the full content
/// returns at the end either way.
async fn chat(
    llm: Llm,
    mut request: ChatRequest,
    on_chunk: Option<ChunkSink<'_>>,
) -> Result<ChatResponse, String> {
    request.stream = request.stream && on_chunk.is_some();
    let reply = match on_chunk {
        Some(sink) if request.stream => {
            // The call blocks on its own thread and sends each delta over a
            // channel, so the sink runs here and need not outlive the call.
            let (parts, mut arriving) = tokio::sync::mpsc::unbounded_channel::<String>();
            let call = tauri::async_runtime::spawn_blocking(move || {
                let mut forward = move |part: &str| {
                    let _ = parts.send(part.to_string());
                };
                llm.call_streamed(Request::Chat(request), &mut forward)
            });
            while let Some(part) = arriving.recv().await {
                sink(&part);
            }
            call.await
                .map_err(|error| format!("The LLM request could not run: {}", error))?
        }
        _ => llm.ask(Request::Chat(request)).await?,
    };
    match reply {
        Reply::Chat(response) => Ok(response),
        Reply::Error(message) => Err(message),
        _ => Err("The LLM gateway answered out of turn".to_string()),
    }
}

pub(crate) async fn llm_chat_impl(
    app: AppHandle,
    request: ChatRequest,
    on_chunk: Option<ChunkSink<'_>>,
) -> Result<ChatResponse, String> {
    chat(Llm::for_app(&app)?, request, on_chunk).await
}

#[tauri::command]
pub async fn llm_chat(app: AppHandle, request: ChatRequest) -> Result<ChatResponse, String> {
    llm_chat_impl(app, request, None).await
}

#[tauri::command]
pub async fn llm_chat_stream(
    app: AppHandle,
    request: ChatRequest,
    on_chunk: Channel<String>,
) -> Result<ChatResponse, String> {
    let mut forward = move |delta: &str| {
        let _ = on_chunk.send(delta.to_string());
    };
    llm_chat_impl(app, request, Some(&mut forward)).await
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;

    use der_llm::Settings;

    use super::*;

    /// A loopback provider that streams the given deltas for one request.
    fn streaming_provider(deltas: &'static [&'static str]) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("loopback listener");
        let origin = format!("http://{}", listener.local_addr().expect("local addr"));
        std::thread::spawn(move || {
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
            let mut body = String::new();
            for delta in deltas {
                let event = serde_json::json!({ "choices": [{ "delta": { "content": delta } }] });
                body.push_str(&format!("data: {event}\n\n"));
            }
            body.push_str("data: [DONE]\n\n");
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).expect("write response");
        });
        origin
    }

    fn local_gateway(dir: &std::path::Path, base_url: &str) -> Llm {
        let llm = Llm::at(dir);
        let saved = llm.call(Request::SettingsSet {
            settings: Settings {
                provider: "local".to_string(),
                model: "test-model".to_string(),
                base_url: Some(base_url.to_string()),
                temperature: None,
                max_tokens: None,
            },
        });
        assert!(matches!(saved, Reply::Settings(_)), "{saved:?}");
        llm
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

    #[test]
    fn a_streamed_chat_reaches_the_sink_in_order_and_returns_the_whole_text() {
        let dir = tempfile::tempdir().expect("temp dir");
        let llm = local_gateway(dir.path(), &streaming_provider(&["Hel", "lo ", "there"]));
        let mut parts: Vec<String> = Vec::new();
        let mut sink = |part: &str| parts.push(part.to_string());
        let response = tauri::async_runtime::block_on(chat(llm, ask(true), Some(&mut sink))).expect("answers");
        assert_eq!(response.content, "Hello there");
        assert_eq!(response.provider, "local");
        assert_eq!(parts, vec!["Hel", "lo ", "there"]);
    }

    #[test]
    fn a_chat_without_a_sink_does_not_ask_the_provider_to_stream() {
        let dir = tempfile::tempdir().expect("temp dir");
        // No provider is listening, so the request fails at the connection.
        // The failure message shows the gateway was asked, and nothing
        // panics on the missing sink.
        let llm = local_gateway(dir.path(), "http://127.0.0.1:9");
        let error = tauri::async_runtime::block_on(chat(llm, ask(true), None)).expect_err("nothing listens");
        assert!(error.contains("/v1/chat/completions"), "{error}");
    }

    #[test]
    fn settings_requests_answer_with_previews() {
        let dir = tempfile::tempdir().expect("temp dir");
        let llm = Llm::at(dir.path());
        let view = view_of(llm.call(Request::CredentialSet {
            provider: "openai".to_string(),
            secret: "sk-test-0123456789abcdef".to_string(),
        }))
        .expect("the view");
        assert_eq!(view.api_keys["openai"], "sk-tes...cdef");
        assert_eq!(llm.call(Request::Ready), Reply::Ready(false), "the default provider needs a sign-in");
        assert!(view_of(Reply::Ready(true)).is_err());
    }
}
