//! The mail service as a real process: the host executable started with
//! `--service mail`, driven through the client the app uses.

use std::net::TcpListener;
use std::time::Duration;

use der_mail::{Account, Reply, Request};

type Client = der_wire::Client<Request, Reply>;

const HOST: &str = env!("CARGO_BIN_EXE_dynamic-experience-runtime");
const PASSWORD: &str = "mail-passw0rd";
const WAIT: Duration = Duration::from_secs(60);

fn client(settings_dir: &std::path::Path) -> Client {
    Client::new("mail", HOST, der_wire::service_arguments("mail", settings_dir))
}

fn account(imap_port: Option<u16>) -> Account {
    Account {
        host: "smtp.example.net".to_string(),
        username: "me@example.net".to_string(),
        password: PASSWORD.to_string(),
        from: "me@example.net".to_string(),
        imap_host: if imap_port.is_some() { "127.0.0.1".to_string() } else { String::new() },
        imap_port,
        ..Account::default()
    }
}

#[test]
fn the_account_is_saved_by_the_service_and_its_password_never_comes_back() {
    let settings = tempfile::tempdir().expect("temp dir");
    let client = client(settings.path());
    assert_eq!(client.process_id(), None, "nothing runs before the first request");

    let asked = client
        .call(Request::List { limit: String::new() }, WAIT)
        .expect("answers");
    assert!(matches!(asked, Reply::NotSetUp { incoming: true, .. }), "{asked:?}");

    let replies = [
        client.call(Request::AccountSave { account: account(None) }, WAIT).expect("answers"),
        client.call(Request::AccountGet, WAIT).expect("answers"),
    ];
    for reply in &replies {
        let line = serde_json::to_string(reply).expect("serializes");
        assert!(line.contains("\"hasPassword\":true"), "{line}");
        assert!(!line.contains(PASSWORD), "{line}");
    }
    let saved = std::fs::read_to_string(settings.path().join(der_mail::ACCOUNT_FILE)).expect("the account file");
    assert!(saved.contains(PASSWORD), "the password lives in the service's file");

    let removed = client.call(Request::AccountRemove, WAIT).expect("answers");
    assert!(matches!(removed, Reply::Account(ref view) if !view.has_password), "{removed:?}");
    assert!(!settings.path().join(der_mail::ACCOUNT_FILE).exists());
}

#[test]
fn reading_mail_reaches_the_server_and_reports_what_went_wrong() {
    // A server that accepts and hangs up. The connection gets as far as the
    // TLS handshake, which shows the TLS setup works in the host's build,
    // and the failure comes back as an answer.
    let listener = TcpListener::bind("127.0.0.1:0").expect("loopback listener");
    let port = listener.local_addr().expect("local addr").port();
    let server = std::thread::spawn(move || {
        let (stream, _) = listener.accept().expect("the service connected");
        drop(stream);
    });

    let settings = tempfile::tempdir().expect("temp dir");
    let client = client(settings.path());
    client
        .call(Request::AccountSave { account: account(Some(port)) }, WAIT)
        .expect("answers");
    let reply = client
        .call(Request::List { limit: "5".to_string() }, WAIT)
        .expect("the service answers");
    server.join().expect("server");
    let Reply::Error(message) = reply else {
        panic!("an error: {reply:?}");
    };
    assert!(message.contains("The mail server did not answer"), "{message}");
    assert!(!message.contains(PASSWORD), "{message}");
    assert!(client.process_id().is_some(), "the service is still running");
}
