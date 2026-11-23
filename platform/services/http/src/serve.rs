//! The service as a process. Each line of input is one request and each
//! line of output is one reply, matched by the id the caller chose. Store
//! requests are answered in the order they arrive, so two saves never
//! overwrite each other. HTTP requests run side by side and answer when
//! they finish. The loop ends when the input closes.

use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{Reply, Request, Service};

/// One request on the wire.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestLine {
    pub id: u64,
    pub request: Request,
}

/// One reply on the wire, carrying the id of the request it answers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReplyLine {
    pub id: u64,
    pub reply: Reply,
}

/// What a line that is not a request is answered with. The text is fixed so
/// that nothing from the line, which may hold a secret, comes back.
const UNREADABLE: &str = "The request could not be read";

/// Serves requests over the settings directory until the input closes.
/// Requests still running at that point are dropped, since nobody is left
/// to read their replies.
pub fn serve<R, W>(settings_dir: impl Into<PathBuf>, input: R, output: W) -> std::io::Result<()>
where
    R: BufRead,
    W: Write + Send + 'static,
{
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let service = Arc::new(Service::new(settings_dir));
    let output = Arc::new(Mutex::new(output));
    let mut outcome = Ok(());
    for line in input.lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                outcome = Err(error);
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let written = match serde_json::from_str::<RequestLine>(&line) {
            Ok(RequestLine {
                id,
                request: request @ Request::Http(_),
            }) => {
                let service = service.clone();
                let output = output.clone();
                runtime.spawn(async move {
                    let reply = service.handle(request).await;
                    let _ = write_reply(&output, id, reply);
                });
                Ok(())
            }
            Ok(RequestLine { id, request }) => write_reply(&output, id, service.handle_store(request)),
            Err(_) => match line_id(&line) {
                Some(id) => write_reply(&output, id, Reply::Error(UNREADABLE.to_string())),
                None => Ok(()),
            },
        };
        if let Err(error) = written {
            outcome = Err(error);
            break;
        }
    }
    runtime.shutdown_background();
    outcome
}

fn line_id(line: &str) -> Option<u64> {
    serde_json::from_str::<Value>(line).ok()?.get("id")?.as_u64()
}

fn write_reply<W: Write>(output: &Mutex<W>, id: u64, reply: Reply) -> std::io::Result<()> {
    let mut line = serde_json::to_string(&ReplyLine { id, reply }).map_err(std::io::Error::other)?;
    line.push('\n');
    let mut output = output.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    output.write_all(line.as_bytes())?;
    output.flush()
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;

    use super::*;
    use crate::{Auth, HttpRequest};

    /// The service on a thread, with the caller's ends of its two pipes.
    struct Running {
        requests: Option<std::io::PipeWriter>,
        replies: BufReader<std::io::PipeReader>,
        thread: Option<std::thread::JoinHandle<std::io::Result<()>>>,
    }

    impl Running {
        fn over(settings_dir: &std::path::Path) -> Self {
            let (request_reader, requests) = std::io::pipe().expect("pipe");
            let (replies, reply_writer) = std::io::pipe().expect("pipe");
            let dir = settings_dir.to_path_buf();
            let thread = std::thread::spawn(move || serve(dir, BufReader::new(request_reader), reply_writer));
            Running {
                requests: Some(requests),
                replies: BufReader::new(replies),
                thread: Some(thread),
            }
        }

        fn send_text(&mut self, line: &str) {
            let requests = self.requests.as_mut().expect("input open");
            writeln!(requests, "{line}").expect("writes");
        }

        fn send(&mut self, id: u64, request: Request) {
            self.send_text(&serde_json::to_string(&RequestLine { id, request }).expect("serializes"));
        }

        fn reply(&mut self) -> ReplyLine {
            let mut line = String::new();
            self.replies.read_line(&mut line).expect("reads");
            serde_json::from_str(&line).unwrap_or_else(|error| panic!("{error}: {line:?}"))
        }

        /// Closes the input and waits for the loop to end.
        fn finish(&mut self) -> std::io::Result<()> {
            self.requests = None;
            self.thread.take().expect("running").join().expect("no panic")
        }
    }

    fn save(name: &str, base_url: &str) -> Request {
        Request::CredentialsSet {
            name: name.to_string(),
            kind: "bearer".to_string(),
            target: None,
            base_url: base_url.to_string(),
            notes: None,
            secret: "s3cret-value".to_string(),
        }
    }

    #[test]
    fn store_requests_are_answered_in_order_with_their_ids() {
        let dir = tempfile::tempdir().expect("temp dir");
        let mut service = Running::over(dir.path());
        service.send(7, save("svc", "https://api.service.dev"));
        service.send_text("");
        service.send(8, Request::CredentialsList);
        service.send(9, Request::CredentialsRemove { name: "svc".into() });

        let saved = service.reply();
        assert_eq!(saved.id, 7);
        let Reply::Credentials(views) = saved.reply else {
            panic!("a save answers the list");
        };
        assert_eq!(views[0].name, "svc");
        assert_eq!(service.reply().id, 8);
        assert_eq!(
            service.reply(),
            ReplyLine { id: 9, reply: Reply::Credentials(vec![]) }
        );
        service.finish().expect("ends cleanly when the input closes");
    }

    #[test]
    fn a_line_that_is_not_a_request_is_refused_without_echoing_it() {
        let dir = tempfile::tempdir().expect("temp dir");
        let mut service = Running::over(dir.path());
        service.send_text(r#"{"id":3,"request":{"op":"credentialsSet","name":"svc","secret":12345678}}"#);
        service.send_text("not json at all");
        service.send(4, Request::CredentialsList);

        let refused = service.reply();
        assert_eq!(refused, ReplyLine { id: 3, reply: Reply::Error(UNREADABLE.to_string()) });
        // The line without an id had no reply to address, so the next one
        // is the list.
        assert_eq!(service.reply(), ReplyLine { id: 4, reply: Reply::Credentials(vec![]) });
        service.finish().expect("ends");
    }

    #[test]
    fn an_http_request_goes_out_with_the_stored_secret() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("loopback listener");
        let origin = format!("http://{}", listener.local_addr().expect("local addr"));
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = Vec::new();
            let mut chunk = [0u8; 1024];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let read = stream.read(&mut chunk).expect("read request");
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..read]);
            }
            let body = "{\"ok\":true}";
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).expect("write response");
            String::from_utf8_lossy(&request).to_lowercase()
        });

        let dir = tempfile::tempdir().expect("temp dir");
        let mut service = Running::over(dir.path());
        service.send(1, save("svc", &origin));
        assert_eq!(service.reply().id, 1);
        service.send(
            2,
            Request::Http(HttpRequest {
                method: "GET".into(),
                url: format!("{origin}/v1/items"),
                headers: Vec::new(),
                query: Vec::new(),
                json: None,
                timeout_secs: 15,
                auth: Auth::Credential { name: "svc".into() },
            }),
        );
        let answered = service.reply();
        assert_eq!(answered.id, 2);
        let Reply::Http(reply) = answered.reply else {
            panic!("an HTTP reply: {:?}", answered.reply);
        };
        assert_eq!(reply.status, 200);
        assert_eq!(reply.body, "{\"ok\":true}");
        let request = server.join().expect("server");
        assert!(request.contains("authorization: bearer s3cret-value"), "{request}");
        service.finish().expect("ends");
    }
}
