//! The HTTP service as a real process: the host executable started with
//! `--service http`, driven through the client the app uses. These tests
//! cover what only a process boundary can show: replies crossing the pipe
//! without a secret, a fresh process after the old one dies, and the
//! process ending when its input closes.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use der_http::{Auth, HttpRequest, Reply, Request};

type Client = der_wire::Client<Request, Reply>;

const HOST: &str = env!("CARGO_BIN_EXE_dynamic-experience-runtime");
const SECRET: &str = "s3cret-value";
const WAIT: Duration = Duration::from_secs(20);

fn save(base_url: &str) -> Request {
    Request::CredentialsSet {
        name: "svc".to_string(),
        kind: "bearer".to_string(),
        target: None,
        base_url: base_url.to_string(),
        notes: None,
        secret: SECRET.to_string(),
    }
}

fn get(url: String) -> Request {
    Request::Http(HttpRequest {
        method: "GET".to_string(),
        url,
        headers: Vec::new(),
        query: Vec::new(),
        json: None,
        timeout_secs: 15,
        auth: Auth::Credential { name: "svc".to_string() },
    })
}

fn listener() -> (TcpListener, String) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("loopback listener");
    let origin = format!("http://{}", listener.local_addr().expect("local addr"));
    (listener, origin)
}

fn read_request(stream: &mut std::net::TcpStream) -> String {
    let mut request = Vec::new();
    let mut chunk = [0u8; 1024];
    while !request.windows(4).any(|window| window == b"\r\n\r\n") {
        let read = stream.read(&mut chunk).expect("read request");
        if read == 0 {
            break;
        }
        request.extend_from_slice(&chunk[..read]);
    }
    String::from_utf8_lossy(&request).to_lowercase()
}

fn client(settings_dir: &std::path::Path) -> Client {
    Client::new("HTTP", HOST, der_wire::service_arguments("http", settings_dir))
}

fn kill(process_id: u32) {
    let status = Command::new("kill")
        .arg("-9")
        .arg(process_id.to_string())
        .status()
        .expect("kill runs");
    assert!(status.success());
}

fn wait_until(what: &str, done: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting until {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn a_saved_secret_goes_out_from_the_service_and_never_comes_back() {
    let (listener, origin) = listener();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept");
        let request = read_request(&mut stream);
        let body = "{\"ok\":true}";
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        stream.write_all(response.as_bytes()).expect("write response");
        request
    });

    let settings = tempfile::tempdir().expect("temp dir");
    let client = client(settings.path());
    assert_eq!(client.process_id(), None, "nothing runs before the first request");

    let saved = client.call(save(&origin), WAIT).expect("answers");
    let line = serde_json::to_string(&saved).expect("serializes");
    assert!(line.contains("\"name\":\"svc\""), "{line}");
    assert!(!line.contains(SECRET), "{line}");
    assert!(client.process_id().is_some());

    let reply = client.call(get(format!("{origin}/v1/items")), WAIT).expect("answers");
    let Reply::Http(reply) = reply else {
        panic!("an HTTP reply: {reply:?}");
    };
    assert_eq!(reply.status, 200);
    assert_eq!(reply.body, "{\"ok\":true}");
    let request = server.join().expect("server");
    assert!(request.contains(&format!("authorization: bearer {SECRET}")), "{request}");

    let outside = client
        .call(get("https://api.elsewhere.dev/v1".to_string()), WAIT)
        .expect("answers");
    let Reply::Error(message) = outside else {
        panic!("a refusal: {outside:?}");
    };
    assert!(message.contains("is confined to"), "{message}");
}

#[test]
fn a_service_that_died_is_started_again_for_the_next_request() {
    let settings = tempfile::tempdir().expect("temp dir");
    let client = client(settings.path());
    client.call(save("https://api.service.dev"), WAIT).expect("answers");
    let first = client.process_id().expect("running");

    kill(first);
    wait_until("the client sees the process gone", || client.process_id().is_none());

    let listed = client.call(Request::CredentialsList, WAIT).expect("answers");
    let Reply::Credentials(views) = listed else {
        panic!("the list: {listed:?}");
    };
    assert_eq!(views.len(), 1, "the store outlives the process");
    let second = client.process_id().expect("running again");
    assert_ne!(first, second);
}

#[test]
fn a_request_in_flight_fails_when_the_service_dies() {
    // A server that accepts and never answers keeps the request in flight.
    let (listener, origin) = listener();
    let settings = tempfile::tempdir().expect("temp dir");
    let client = std::sync::Arc::new(client(settings.path()));
    client.call(save(&origin), WAIT).expect("answers");

    let caller = {
        let client = client.clone();
        std::thread::spawn(move || client.call(get(format!("{origin}/slow")), WAIT))
    };
    let (_held_open, _) = listener.accept().expect("the request arrived");
    kill(client.process_id().expect("running"));

    let outcome = caller.join().expect("caller");
    assert_eq!(outcome, Err("The HTTP service stopped before answering".to_string()));
}

#[test]
fn the_service_ends_when_its_input_closes() {
    let settings = tempfile::tempdir().expect("temp dir");
    let mut service = Command::new(HOST)
        .args(["--service", "http", "--dir"])
        .arg(settings.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("starts");
    drop(service.stdin.take());
    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        if let Some(status) = service.try_wait().expect("wait") {
            break status;
        }
        assert!(Instant::now() < deadline, "the service kept running");
        std::thread::sleep(Duration::from_millis(20));
    };
    assert!(status.success(), "{status:?}");
}

#[test]
fn service_arguments_that_make_no_sense_never_start_the_app() {
    for arguments in [vec!["--service", "smtp"], vec!["--service", "http"], vec!["--service"]] {
        let output = Command::new(HOST)
            .args(&arguments)
            .stdin(Stdio::null())
            .output()
            .expect("runs");
        assert_eq!(output.status.code(), Some(2), "{arguments:?}");
        let message = String::from_utf8_lossy(&output.stderr);
        assert!(message.contains("usage: --service <http|mail|llm|parts|session> [--dir"), "{arguments:?}: {message}");
    }
}
