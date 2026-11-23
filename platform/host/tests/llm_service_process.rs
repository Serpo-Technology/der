//! The LLM gateway as a real process: the host executable started with
//! `--service llm`, driven through the client the app uses.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::Duration;

use der_llm::{ChatMessage, ChatRequest, Reply, Request, Settings};

type Client = der_wire::Client<Request, Reply>;

const HOST: &str = env!("CARGO_BIN_EXE_dynamic-experience-runtime");
const KEY: &str = "sk-local-0123456789abcdef";
const WAIT: Duration = Duration::from_secs(60);

fn client(settings_dir: &std::path::Path) -> Client {
    Client::new("LLM", HOST, der_wire::service_arguments("llm", settings_dir))
}

/// A loopback provider that streams the given deltas for one request and
/// returns the request it received, lowercased.
fn streaming_provider(deltas: &'static [&'static str]) -> (String, std::thread::JoinHandle<String>) {
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
        String::from_utf8_lossy(&request).to_lowercase()
    });
    (origin, server)
}

fn chat() -> Request {
    Request::Chat(ChatRequest {
        messages: vec![ChatMessage {
            role: "user".to_string(),
            content: "Hello".to_string(),
        }],
        system_blocks: None,
        stream: true,
        provider: None,
        model: None,
        max_tokens: None,
        temperature: None,
        json_mode: None,
        base_url: None,
    })
}

#[test]
fn a_streamed_chat_crosses_the_process_in_parts_and_the_key_stays_behind() {
    let (origin, server) = streaming_provider(&["Hel", "lo ", "there"]);
    let settings = tempfile::tempdir().expect("temp dir");
    let client = client(settings.path());
    assert_eq!(client.process_id(), None, "nothing runs before the first request");

    let saved = [
        client
            .call(
                Request::SettingsSet {
                    settings: Settings {
                        provider: "local".to_string(),
                        model: "test-model".to_string(),
                        base_url: Some(origin),
                        temperature: None,
                        max_tokens: None,
                    },
                },
                WAIT,
            )
            .expect("answers"),
        client
            .call(
                Request::CredentialSet {
                    provider: "local".to_string(),
                    secret: KEY.to_string(),
                },
                WAIT,
            )
            .expect("answers"),
        client.call(Request::SettingsGet, WAIT).expect("answers"),
    ];
    for reply in &saved {
        let line = serde_json::to_string(reply).expect("serializes");
        assert!(!line.contains(KEY), "{line}");
    }
    assert!(serde_json::to_string(&saved[2]).expect("serializes").contains("sk-loc...cdef"));
    assert_eq!(client.call(Request::Ready, WAIT), Ok(Reply::Ready(true)));

    let mut parts: Vec<String> = Vec::new();
    let reply = client
        .call_streamed(chat(), WAIT, &mut |part| parts.push(part.to_string()))
        .expect("answers");
    let Reply::Chat(response) = reply else {
        panic!("a chat reply: {reply:?}");
    };
    assert_eq!(response.content, "Hello there");
    assert_eq!(response.model, "test-model");
    assert_eq!(parts, vec!["Hel", "lo ", "there"]);
    let request = server.join().expect("server");
    assert!(request.contains(&format!("authorization: bearer {KEY}")), "{request}");
}

#[test]
fn a_sign_in_starts_in_the_gateway_and_finishing_checks_the_state_there() {
    let settings = tempfile::tempdir().expect("temp dir");
    let client = client(settings.path());
    let Reply::SignInUrl(url) = client.call(Request::SignInStart, WAIT).expect("answers") else {
        panic!("an authorize URL");
    };
    assert!(url.starts_with("https://claude.ai/oauth/authorize?"), "{url}");
    assert!(url.contains("code_challenge="), "{url}");

    // The state is checked before anything is sent, so this never leaves
    // the machine.
    let finished = client
        .call(
            Request::SignInFinish {
                code: "code#someone-elses-state".to_string(),
            },
            WAIT,
        )
        .expect("answers");
    let Reply::Error(message) = finished else {
        panic!("a refusal: {finished:?}");
    };
    assert!(message.contains("state mismatch"), "{message}");
}
