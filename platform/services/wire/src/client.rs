//! The host's end of the line protocol: a service process started on
//! demand, with each caller waiting on the reply to its own request.

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::RequestLine;

/// What the service sends for one request: pieces of a streamed reply,
/// then the reply.
enum Event<P> {
    Part(String),
    Reply(P),
    Failed,
}

/// A line from the service: a reply line, a part line, or a failed line.
#[derive(Deserialize)]
#[serde(bound(deserialize = "P: DeserializeOwned"))]
struct Incoming<P> {
    id: u64,
    reply: Option<P>,
    part: Option<String>,
    failed: Option<bool>,
}

type Pending<P> = Arc<Mutex<HashMap<u64, Sender<Event<P>>>>>;

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// One running service process and the requests waiting on it.
struct Link<P> {
    child: Child,
    stdin: ChildStdin,
    pending: Pending<P>,
    alive: Arc<AtomicBool>,
}

impl<P> Drop for Link<P> {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// A service process and the way to ask it things. The process starts on
/// the first request and is started again when a request finds it gone.
pub struct Client<R, P> {
    /// What error messages call the service, as in "The HTTP service".
    name: String,
    program: PathBuf,
    arguments: Vec<OsString>,
    next_id: AtomicU64,
    link: Mutex<Option<Link<P>>>,
    request: std::marker::PhantomData<fn(R)>,
}

impl<R, P> Client<R, P>
where
    R: Serialize,
    P: DeserializeOwned + Send + 'static,
{
    /// A client that runs `program` with `arguments` as the service.
    pub fn new(name: impl Into<String>, program: impl Into<PathBuf>, arguments: Vec<OsString>) -> Self {
        Client {
            name: name.into(),
            program: program.into(),
            arguments,
            next_id: AtomicU64::new(1),
            link: Mutex::new(None),
            request: std::marker::PhantomData,
        }
    }

    /// The id of the running service process, when one is running.
    pub fn process_id(&self) -> Option<u32> {
        locked(&self.link)
            .as_ref()
            .filter(|link| link.alive.load(Ordering::SeqCst))
            .map(|link| link.child.id())
    }

    fn start(&self) -> Result<Link<P>, String> {
        let mut child = Command::new(&self.program)
            .args(&self.arguments)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| format!("The {} service could not start: {}", self.name, error))?;
        let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("The {} service could not start: its pipes are missing", self.name));
        };
        let pending = Pending::<P>::default();
        let alive = Arc::new(AtomicBool::new(true));
        let (waiting, running) = (pending.clone(), alive.clone());
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else {
                    break;
                };
                let Ok(incoming) = serde_json::from_str::<Incoming<P>>(&line) else {
                    continue;
                };
                if let Some(reply) = incoming.reply {
                    if let Some(waiter) = locked(&waiting).remove(&incoming.id) {
                        let _ = waiter.send(Event::Reply(reply));
                    }
                } else if let Some(part) = incoming.part {
                    if let Some(waiter) = locked(&waiting).get(&incoming.id) {
                        let _ = waiter.send(Event::Part(part));
                    }
                } else if incoming.failed == Some(true) {
                    if let Some(waiter) = locked(&waiting).remove(&incoming.id) {
                        let _ = waiter.send(Event::Failed);
                    }
                }
            }
            // The process is gone: dropping the senders tells every request
            // still waiting that no reply is coming.
            running.store(false, Ordering::SeqCst);
            locked(&waiting).clear();
        });
        Ok(Link {
            child,
            stdin,
            pending,
            alive,
        })
    }

    /// Sends one request and waits up to `wait` for its reply. A request
    /// that could not be handed to a running process starts a fresh one
    /// and is sent once more. A request the process took and then died on
    /// fails, because it may already have had its effect.
    pub fn call(&self, request: R, wait: Duration) -> Result<P, String> {
        self.call_streamed(request, wait, &mut |_| {})
    }

    /// Like `call`, for a reply that arrives in pieces: `on_part` gets each
    /// piece as the service sends it, on the calling thread, before the
    /// reply is returned. `wait` bounds the whole exchange.
    pub fn call_streamed(
        &self,
        request: R,
        wait: Duration,
        on_part: &mut dyn FnMut(&str),
    ) -> Result<P, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let mut line = serde_json::to_string(&RequestLine { id, request })
            .map_err(|error| format!("The request could not be written: {}", error))?;
        line.push('\n');
        let (waiter, events) = channel();
        let pending = {
            let mut link = locked(&self.link);
            let mut handed_over = None;
            for _attempt in 0..2 {
                if !link.as_ref().is_some_and(|link| link.alive.load(Ordering::SeqCst)) {
                    *link = None;
                    *link = Some(self.start()?);
                }
                let Some(running) = link.as_mut() else {
                    break;
                };
                locked(&running.pending).insert(id, waiter.clone());
                let written = running
                    .stdin
                    .write_all(line.as_bytes())
                    .and_then(|()| running.stdin.flush());
                if written.is_ok() && running.alive.load(Ordering::SeqCst) {
                    handed_over = Some(running.pending.clone());
                    break;
                }
                locked(&running.pending).remove(&id);
                *link = None;
            }
            handed_over.ok_or_else(|| format!("The {} service is not answering", self.name))?
        };
        drop(waiter);
        let deadline = Instant::now() + wait;
        loop {
            match events.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(Event::Part(text)) => on_part(&text),
                Ok(Event::Reply(reply)) => return Ok(reply),
                Ok(Event::Failed) => {
                    return Err(format!("The {} service failed while handling the request", self.name));
                }
                Err(RecvTimeoutError::Timeout) => {
                    locked(&pending).remove(&id);
                    return Err(format!("The {} service did not answer in time", self.name));
                }
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(format!("The {} service stopped before answering", self.name));
                }
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    /// A client whose service is a shell script: it reads the first request
    /// line and then writes the given lines.
    fn scripted(lines: &str) -> Client<String, String> {
        let script = format!("read request; printf '%s\\n' {lines}");
        Client::new("test", "/bin/sh", vec!["-c".into(), script.into()])
    }

    const WAIT: Duration = Duration::from_secs(10);

    #[test]
    fn a_reply_comes_back_to_the_request_with_its_id() {
        let client = scripted(r#"'{"id":9,"reply":"someone else"}' '{"id":1,"reply":"mine"}'"#);
        assert_eq!(client.call("hello".to_string(), WAIT), Ok("mine".to_string()));
    }

    #[test]
    fn parts_arrive_in_order_before_the_reply() {
        let client = scripted(r#"'{"id":1,"part":"a"}' '{"id":1,"part":"b"}' '{"id":1,"reply":"done"}'"#);
        let mut parts = Vec::new();
        let reply = client.call_streamed("hello".to_string(), WAIT, &mut |part| parts.push(part.to_string()));
        assert_eq!(reply, Ok("done".to_string()));
        assert_eq!(parts, vec!["a", "b"]);
    }

    #[test]
    fn a_failed_line_ends_the_wait_with_an_error() {
        let client = scripted(r#"'{"id":1,"failed":true}'"#);
        assert_eq!(
            client.call("hello".to_string(), WAIT),
            Err("The test service failed while handling the request".to_string())
        );
    }

    #[test]
    fn a_service_that_exits_without_answering_ends_the_wait() {
        let client = scripted("'not a line of the protocol'");
        assert_eq!(
            client.call("hello".to_string(), WAIT),
            Err("The test service stopped before answering".to_string())
        );
    }

    #[test]
    fn a_service_that_never_answers_runs_into_the_deadline() {
        let client: Client<String, String> =
            Client::new("test", "/bin/sh", vec!["-c".into(), "read request; sleep 30".into()]);
        assert_eq!(
            client.call("hello".to_string(), Duration::from_millis(300)),
            Err("The test service did not answer in time".to_string())
        );
    }

    #[test]
    fn a_program_that_cannot_start_is_reported() {
        let client: Client<String, String> = Client::new("test", "/nonexistent/der-service", Vec::new());
        let error = client.call("hello".to_string(), WAIT).expect_err("cannot start");
        assert!(error.starts_with("The test service could not start"), "{error}");
    }
}
