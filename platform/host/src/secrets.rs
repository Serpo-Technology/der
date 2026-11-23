//! The host's one door to the integration credential store and to every
//! outbound request that may carry a stored secret. The store and those
//! requests live in a separate process, the HTTP service: this executable
//! started again with `--service http`. Callers hand over a request and get
//! back a reply that holds no secret, so a stored secret is never in the
//! host's memory after it has been saved.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use der_http::{HttpReply, HttpRequest, Reply, ReplyLine, Request, RequestLine};

const SERVICE_FLAG: &str = "--service";
const SERVICE_NAME: &str = "http";
const SETTINGS_DIR_FLAG: &str = "--settings-dir";

/// How long a store request may take to answer.
const STORE_WAIT: Duration = Duration::from_secs(30);
/// What an HTTP request is given on top of its own timeout.
const HTTP_WAIT_MARGIN: Duration = Duration::from_secs(15);

/// Runs the HTTP service when the arguments ask for it and reports whether
/// they did. The service reads requests on stdin, answers on stdout, and
/// returns when stdin closes, which is when the host that started it exits.
pub fn serve_if_asked() -> bool {
    let arguments: Vec<String> = std::env::args().collect();
    let value_after = |flag: &str| {
        arguments
            .iter()
            .position(|argument| argument == flag)
            .and_then(|at| arguments.get(at + 1))
    };
    if !arguments.iter().any(|argument| argument == SERVICE_FLAG) {
        return false;
    }
    let settings_dir = match (value_after(SERVICE_FLAG), value_after(SETTINGS_DIR_FLAG)) {
        (Some(name), Some(dir)) if name == SERVICE_NAME => PathBuf::from(dir),
        _ => {
            eprintln!("usage: {SERVICE_FLAG} {SERVICE_NAME} {SETTINGS_DIR_FLAG} <directory>");
            std::process::exit(2);
        }
    };
    if let Err(error) = der_http::serve(settings_dir, std::io::stdin().lock(), std::io::stdout()) {
        eprintln!("The HTTP service stopped: {error}");
        std::process::exit(1);
    }
    true
}

type Pending = Arc<Mutex<HashMap<u64, SyncSender<Reply>>>>;

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// One running service process and the requests waiting on it.
struct Link {
    child: Child,
    stdin: ChildStdin,
    pending: Pending,
    alive: Arc<AtomicBool>,
}

impl Drop for Link {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The host's end of the HTTP service. The process starts on the first
/// request and is started again when a request finds it gone.
pub struct Client {
    program: PathBuf,
    settings_dir: PathBuf,
    next_id: AtomicU64,
    link: Mutex<Option<Link>>,
}

impl Client {
    /// A client that runs `program` as the service over `settings_dir`.
    pub fn new(program: impl Into<PathBuf>, settings_dir: impl Into<PathBuf>) -> Self {
        Client {
            program: program.into(),
            settings_dir: settings_dir.into(),
            next_id: AtomicU64::new(1),
            link: Mutex::new(None),
        }
    }

    /// The id of the running service process, when one is running.
    pub fn process_id(&self) -> Option<u32> {
        locked(&self.link)
            .as_ref()
            .filter(|link| link.alive.load(Ordering::SeqCst))
            .map(|link| link.child.id())
    }

    fn start(&self) -> Result<Link, String> {
        let mut child = Command::new(&self.program)
            .arg(SERVICE_FLAG)
            .arg(SERVICE_NAME)
            .arg(SETTINGS_DIR_FLAG)
            .arg(&self.settings_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| format!("The HTTP service could not start: {}", error))?;
        let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
            let _ = child.kill();
            let _ = child.wait();
            return Err("The HTTP service could not start: its pipes are missing".to_string());
        };
        let pending = Pending::default();
        let alive = Arc::new(AtomicBool::new(true));
        let (waiting, running) = (pending.clone(), alive.clone());
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else {
                    break;
                };
                if let Ok(ReplyLine { id, reply }) = serde_json::from_str(&line) {
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
    /// fails, because it may already have gone out.
    pub fn call(&self, request: Request, wait: Duration) -> Result<Reply, String> {
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
            handed_over.ok_or_else(|| "The HTTP service is not answering".to_string())?
        };
        drop(waiter);
        match reply.recv_timeout(wait) {
            Ok(reply) => Ok(reply),
            Err(RecvTimeoutError::Timeout) => {
                locked(&pending).remove(&id);
                Err("The HTTP service did not answer in time".to_string())
            }
            Err(RecvTimeoutError::Disconnected) => {
                Err("The HTTP service stopped before answering".to_string())
            }
        }
    }
}

enum Door {
    Process(Arc<Client>),
    #[cfg(test)]
    Local(der_http::Service),
}

pub struct Secrets {
    door: Door,
}

impl Secrets {
    /// The service over this app's settings directory, shared by every
    /// caller in the process.
    pub fn for_app(app: &tauri::AppHandle) -> Result<Self, String> {
        static CLIENT: OnceLock<Arc<Client>> = OnceLock::new();
        let settings_dir = crate::settings::settings_dir(app)?;
        let client = match CLIENT.get() {
            Some(client) => client,
            None => {
                let program = std::env::current_exe()
                    .map_err(|error| format!("The HTTP service could not start: {}", error))?;
                CLIENT.get_or_init(|| Arc::new(Client::new(program, settings_dir)))
            }
        };
        Ok(Secrets {
            door: Door::Process(client.clone()),
        })
    }

    /// The service run inside the test process over an explicit settings
    /// directory.
    #[cfg(test)]
    pub fn at(settings_dir: &std::path::Path) -> Self {
        Secrets {
            door: Door::Local(der_http::Service::new(settings_dir)),
        }
    }

    /// Performs one HTTP request.
    pub async fn http(&self, request: HttpRequest) -> Result<HttpReply, String> {
        let reply = match &self.door {
            Door::Process(client) => {
                let client = client.clone();
                let wait = Duration::from_secs(request.timeout_secs) + HTTP_WAIT_MARGIN;
                tauri::async_runtime::spawn_blocking(move || client.call(Request::Http(request), wait))
                    .await
                    .map_err(|error| format!("The HTTP request could not run: {}", error))??
            }
            #[cfg(test)]
            Door::Local(service) => service.handle(Request::Http(request)).await,
        };
        match reply {
            Reply::Http(reply) => Ok(reply),
            Reply::Error(message) => Err(message),
            _ => Err("The HTTP service answered out of turn".to_string()),
        }
    }

    /// Answers a store request.
    pub fn store(&self, request: Request) -> Reply {
        match &self.door {
            Door::Process(client) => client
                .call(request, STORE_WAIT)
                .unwrap_or_else(Reply::Error),
            #[cfg(test)]
            Door::Local(service) => service.handle_store(request),
        }
    }
}
