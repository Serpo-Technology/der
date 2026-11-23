//! The host's end of the line protocol: a service process started on
//! demand, with each caller waiting on the reply to its own request.

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::{ReplyLine, RequestLine};

type Pending<P> = Arc<Mutex<HashMap<u64, SyncSender<P>>>>;

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
                if let Ok(ReplyLine { id, reply }) = serde_json::from_str::<ReplyLine<P>>(&line) {
                    if let Some(waiter) = locked(&waiting).remove(&id) {
                        let _ = waiter.send(reply);
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
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let mut line = serde_json::to_string(&RequestLine { id, request })
            .map_err(|error| format!("The request could not be written: {}", error))?;
        line.push('\n');
        let (waiter, reply) = sync_channel(1);
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
        match reply.recv_timeout(wait) {
            Ok(reply) => Ok(reply),
            Err(RecvTimeoutError::Timeout) => {
                locked(&pending).remove(&id);
                Err(format!("The {} service did not answer in time", self.name))
            }
            Err(RecvTimeoutError::Disconnected) => {
                Err(format!("The {} service stopped before answering", self.name))
            }
        }
    }
}
