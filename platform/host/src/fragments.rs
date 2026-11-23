//! The host's side of signed parts: the install and trust commands, the
//! door to the part runner, integration part remotes, part secrets, and
//! the registry client. Guest code runs in the part runner, a separate
//! process, so a part never executes in the process that holds the app's
//! windows, files, and stores. The host verifies bundles, decides what is
//! installed, and owns the file grants: it tells the runner which files a
//! call may read and takes the files a call produced into its own storage.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use der_parts::service::{Reply, Request};
use serde_json::Value;
use tauri::Manager;

use crate::secrets::Secrets;

pub use der_parts::*;

const EXEC_PERMITS: usize = 2;
const EXEC_ACQUIRE_TIMEOUT_MS: u64 = 5000;

/// How long one run may take to answer. A call's own budgets end it within
/// about half a minute; staging and handing off large files add to that.
const RUN_WAIT: Duration = Duration::from_secs(120);
/// How long compiling a module for the install check may take.
const CHECK_WAIT: Duration = Duration::from_secs(120);
const FORGET_WAIT: Duration = Duration::from_secs(30);

fn fail(kind: FragmentErrorKind, message: impl Into<String>) -> FragmentError {
    FragmentError::new(kind, message)
}

/// What the host keeps for parts: the bundles under review before install,
/// and the gate on how many part calls the webview runs at once.
pub struct PartsState {
    staging: Staging,
    exec_permits: Arc<tokio::sync::Semaphore>,
}

impl PartsState {
    pub fn new() -> Self {
        PartsState {
            staging: Staging::default(),
            exec_permits: Arc::new(tokio::sync::Semaphore::new(EXEC_PERMITS)),
        }
    }
}

impl Default for PartsState {
    fn default() -> Self {
        Self::new()
    }
}

type Client = der_wire::Client<Request, Reply>;

#[derive(Clone)]
enum Door {
    Process(Arc<Client>),
    #[cfg(test)]
    Local(Arc<der_parts::service::Service>),
}

/// The host's door to the part runner.
#[derive(Clone)]
pub struct Runner {
    door: Door,
}

impl Runner {
    /// The runner over this app's installed bundles, shared by every
    /// caller in the process.
    pub fn for_app(app: &tauri::AppHandle) -> FragmentResult<Self> {
        static CLIENT: OnceLock<Arc<Client>> = OnceLock::new();
        let dir = fragments_dir(app)?;
        let client = match CLIENT.get() {
            Some(client) => client,
            None => {
                let client = crate::services::client("part runner", crate::services::PARTS, &dir)
                    .map_err(|message| fail(FragmentErrorKind::Io, message))?;
                CLIENT.get_or_init(|| Arc::new(client))
            }
        };
        Ok(Runner {
            door: Door::Process(client.clone()),
        })
    }

    /// The runner run inside the test process over an explicit folder of
    /// installed bundles.
    #[cfg(test)]
    pub fn at(fragments_dir: &Path) -> Self {
        Runner {
            door: Door::Local(Arc::new(der_parts::service::Service::new(fragments_dir))),
        }
    }

    /// Answers one request. Blocks until the runner has.
    pub fn call(&self, request: Request) -> Reply {
        match &self.door {
            Door::Process(client) => {
                let wait = match &request {
                    Request::Run { .. } => RUN_WAIT,
                    Request::Check { .. } => CHECK_WAIT,
                    Request::Forget { .. } => FORGET_WAIT,
                };
                client.call(request, wait).unwrap_or_else(Reply::Error)
            }
            #[cfg(test)]
            Door::Local(service) => service.handle(request),
        }
    }

    /// Compiles a module in the runner and checks its imports against the
    /// capabilities its bundle declares.
    pub fn check(&self, wasm: &[u8], capabilities: &[String]) -> FragmentResult<()> {
        let reply = self.call(Request::Check {
            wasm_b64: BASE64.encode(wasm),
            capabilities: capabilities.to_vec(),
        });
        match reply {
            Reply::Done => Ok(()),
            Reply::Failed(error) => Err(error),
            Reply::Error(message) => Err(fail(FragmentErrorKind::Io, message)),
            Reply::Outputs { .. } => Err(fail(FragmentErrorKind::Io, "The part runner answered out of turn")),
        }
    }

    /// Has the runner drop what it holds for a part that was removed or
    /// replaced. The runner reloads from disk either way, so a failure
    /// here costs memory and nothing else.
    pub fn forget(&self, fragment_id: &str) {
        let _ = self.call(Request::Forget {
            fragment_id: fragment_id.to_string(),
        });
    }
}

/// The folder a call's produced files wait in. The host makes it, names it
/// to the runner, and removes it when the call is over.
struct Handoff {
    root: PathBuf,
}

impl Handoff {
    fn create() -> FragmentResult<Self> {
        let root = std::env::temp_dir().join(format!("der-handoff-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root)
            .map_err(|e| fail(FragmentErrorKind::Io, format!("Handoff setup failed: {}", e)))?;
        Ok(Handoff { root })
    }

    /// The file a reply names, when it is a plain file one folder below
    /// this handoff folder. The runner's word alone never makes a file
    /// outside it, or a link to one, into a grant.
    fn accept(&self, named: &Path) -> Option<PathBuf> {
        let root = std::fs::canonicalize(&self.root).ok()?;
        let folder = std::fs::canonicalize(named.parent()?).ok()?;
        if folder.parent()? != root {
            return None;
        }
        let file = folder.join(named.file_name()?);
        std::fs::symlink_metadata(&file)
            .ok()?
            .file_type()
            .is_file()
            .then_some(file)
    }
}

impl Drop for Handoff {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// The sibling outputs the host fills from a file it took in.
const FILE_SIBLINGS: [&str; 3] = ["url", "name", "size"];

/// Runs one operation of an installed part in the runner. `resolve` turns
/// a grant token into the file it stands for, and every input that is a
/// live token goes along as a granted file. `register` takes a produced
/// file into the caller's storage and answers its handle, which replaces
/// the placeholder the runner left in the outputs.
pub(crate) fn run_part_core(
    runner: &Runner,
    fragment_id: &str,
    operation: &str,
    inputs: &Value,
    resolve: &dyn Fn(&str) -> Option<PathBuf>,
    register: &dyn Fn(&Path) -> Result<Value, String>,
) -> FragmentResult<Value> {
    let granted: HashMap<String, PathBuf> = inputs
        .as_object()
        .map(|object| {
            object
                .values()
                .filter_map(Value::as_str)
                .filter_map(|token| resolve(token).map(|path| (token.to_string(), path)))
                .collect()
        })
        .unwrap_or_default();
    let handoff = Handoff::create()?;
    let reply = runner.call(Request::Run {
        fragment_id: fragment_id.to_string(),
        operation: operation.to_string(),
        inputs: inputs.clone(),
        granted,
        handoff: handoff.root.clone(),
    });
    let (mut outputs, produced) = match reply {
        Reply::Outputs { outputs, produced } => (outputs, produced),
        Reply::Failed(error) => return Err(error),
        Reply::Error(message) => return Err(fail(FragmentErrorKind::Io, message)),
        Reply::Done => return Err(fail(FragmentErrorKind::Io, "The part runner answered out of turn")),
    };
    for file in produced {
        let path = handoff.accept(&file.path).ok_or_else(|| {
            fail(
                FragmentErrorKind::BadOutput,
                "The part runner named a file outside the folder this call gave it",
            )
        })?;
        let registered = register(&path).map_err(|message| fail(FragmentErrorKind::Io, message))?;
        let Some(object) = outputs.as_object_mut() else {
            break;
        };
        object.insert(file.output, registered.get("file").cloned().unwrap_or(Value::Null));
        for sibling in file.fill {
            if FILE_SIBLINGS.contains(&sibling.as_str()) && !object.contains_key(&sibling) {
                if let Some(value) = registered.get(&sibling) {
                    object.insert(sibling, value.clone());
                }
            }
        }
    }
    Ok(outputs)
}

/// Runs a part operation with the app's file layer attached: grant tokens
/// resolve through the picker's table and produced files register as new
/// grants.
pub fn execute_with_app_files(
    app: &tauri::AppHandle,
    fragment_id: &str,
    operation: &str,
    inputs: &Value,
) -> FragmentResult<Value> {
    let runner = Runner::for_app(app)?;
    let grants = app.state::<crate::files::FileGrants>();
    let resolve = |token: &str| grants.path_of(token);
    let register = |path: &Path| crate::files::register_exec_output(app, path);
    run_part_core(&runner, fragment_id, operation, inputs, &resolve, &register)
}

fn fragments_dir(app: &tauri::AppHandle) -> FragmentResult<PathBuf> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("fragments"))
        .map_err(|e| fail(FragmentErrorKind::Io, e.to_string()))
}

fn require_main_window(window: &tauri::WebviewWindow) -> FragmentResult<()> {
    if window.label() != "main" {
        return Err(fail(
            FragmentErrorKind::TrustViolation,
            "Part management is only available from the main window",
        ));
    }
    Ok(())
}

/// Verifies a picked bundle against the trust store and holds it for
/// review. The runner compiles the module for the capability check, so the
/// host never compiles guest code.
pub fn stage_part(
    app: &tauri::AppHandle,
    raw: &[u8],
    reserved_names: &[String],
) -> FragmentResult<StageSummary> {
    let dir = fragments_dir(app)?;
    let runner = Runner::for_app(app)?;
    let state = app.state::<PartsState>();
    stage_with(&state.staging, &dir, raw, reserved_names, &|wasm, capabilities| {
        runner.check(wasm, capabilities)
    })
}

/// Installs a reviewed bundle.
pub fn commit_part(
    app: &tauri::AppHandle,
    staging_token: &str,
    expected_fingerprint: &str,
    force_downgrade: bool,
) -> FragmentResult<Manifest> {
    let dir = fragments_dir(app)?;
    let state = app.state::<PartsState>();
    let manifest = commit_with(&state.staging, &dir, staging_token, expected_fingerprint, force_downgrade)?;
    if let Ok(runner) = Runner::for_app(app) {
        runner.forget(&manifest.id);
    }
    Ok(manifest)
}

/// Removes a part together with the secrets saved for it, so nothing the
/// part could use outlives it in the credential store.
pub(crate) fn remove_with_secrets_core(
    fragments_dir: &Path,
    secrets: &Secrets,
    id: &str,
) -> FragmentResult<()> {
    remove_installed(fragments_dir, id)?;
    match secrets.store(der_http::Request::PartSecretsRemove {
        fragment_id: id.to_string(),
    }) {
        der_http::Reply::Error(message) => Err(fail(
            FragmentErrorKind::Io,
            format!("The part was removed, but its saved secrets could not be deleted: {}", message),
        )),
        _ => Ok(()),
    }
}

/// Removes an installed part, its saved secrets, and what the runner holds
/// for it.
pub fn remove_part(app: &tauri::AppHandle, id: &str) -> FragmentResult<()> {
    let dir = fragments_dir(app)?;
    let secrets = Secrets::for_app(app).map_err(|e| fail(FragmentErrorKind::Io, e))?;
    let removed = remove_with_secrets_core(&dir, &secrets, id);
    if let Ok(runner) = Runner::for_app(app) {
        runner.forget(id);
    }
    removed
}

#[tauri::command]
pub async fn stage_fragment(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    bundle_b64: String,
    reserved_names: Vec<String>,
) -> Result<StageSummary, FragmentError> {
    require_main_window(&window)?;
    let raw = BASE64
        .decode(&bundle_b64)
        .map_err(|_| fail(FragmentErrorKind::VerifyFailed, "The picked file is not readable"))?;
    stage_part(&app, &raw, &reserved_names)
}

#[tauri::command]
pub async fn commit_fragment(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    staging_token: String,
    expected_fingerprint: String,
    force_downgrade: Option<bool>,
) -> Result<Manifest, FragmentError> {
    require_main_window(&window)?;
    commit_part(&app, &staging_token, &expected_fingerprint, force_downgrade.unwrap_or(false))
}

#[tauri::command]
pub async fn remove_fragment(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    fragment_id: String,
) -> Result<(), FragmentError> {
    require_main_window(&window)?;
    remove_part(&app, &fragment_id)
}

#[tauri::command]
pub async fn replace_publisher_key(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    publisher: String,
    old_fingerprint: String,
    new_fingerprint: String,
    new_key_b64: String,
) -> Result<(), FragmentError> {
    require_main_window(&window)?;
    replace_publisher_key_core(
        &fragments_dir(&app)?,
        &publisher,
        &old_fingerprint,
        &new_fingerprint,
        &new_key_b64,
    )
}

#[tauri::command]
pub async fn list_fragments(app: tauri::AppHandle) -> Result<Vec<Value>, FragmentError> {
    Ok(list_core(&fragments_dir(&app)?))
}

#[tauri::command]
pub async fn execute_fragment(
    app: tauri::AppHandle,
    state: tauri::State<'_, PartsState>,
    fragment_id: String,
    operation: String,
    inputs: Value,
) -> Result<FragmentExecResult, FragmentError> {
    let started = std::time::Instant::now();

    let permit = match tokio::time::timeout(
        Duration::from_millis(EXEC_ACQUIRE_TIMEOUT_MS),
        state.exec_permits.clone().acquire_owned(),
    )
    .await
    {
        Ok(Ok(permit)) => permit,
        _ => {
            return Ok(FragmentExecResult {
                success: false,
                data: None,
                error: Some(fail(FragmentErrorKind::Busy, "Too many parts are running; try again")),
                execution_time_ms: started.elapsed().as_millis() as u64,
            })
        }
    };

    let exec_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        execute_with_app_files(&exec_app, &fragment_id, &operation, &inputs)
    })
    .await
    .map_err(|e| fail(FragmentErrorKind::Io, format!("Execution task failed: {}", e)))?;

    let execution_time_ms = started.elapsed().as_millis() as u64;
    Ok(match result {
        Ok(data) => FragmentExecResult { success: true, data: Some(data), error: None, execution_time_ms },
        Err(error) => FragmentExecResult { success: false, data: None, error: Some(error), execution_time_ms },
    })
}


// ---------------------------------------------------------------------------
// Registry client: untrusted transport for signed bundles. The index only
// aids discovery; installation authority stays with bundle signatures and
// the pinned trust store.
// ---------------------------------------------------------------------------

const MAX_INDEX_BYTES: usize = 1 << 20;
const MAX_BUNDLE_DOWNLOAD_BYTES: usize = 12 << 20;

/// Validates a registry index body and resolves bundle URLs against the
/// index URL. Returns the entries as JSON for the UI.
pub fn parse_registry_index(index_url: &str, body: &str) -> Result<Value, String> {
    let value: Value = serde_json::from_str(body).map_err(|e| format!("index is not JSON: {}", e))?;
    if value.get("formatVersion").and_then(Value::as_u64) != Some(1) {
        return Err("index formatVersion is not 1".to_string());
    }
    let base = reqwest::Url::parse(index_url).map_err(|e| format!("bad index URL: {}", e))?;
    let mut parts: Vec<Value> = Vec::new();
    for part in value.get("parts").and_then(Value::as_array).unwrap_or(&Vec::new()) {
        let mut part = part.clone();
        let bundle_url = part
            .get("bundleUrl")
            .and_then(Value::as_str)
            .ok_or_else(|| "index entry has no bundleUrl".to_string())?;
        let absolute = base
            .join(bundle_url)
            .map_err(|e| format!("bad bundleUrl {}: {}", bundle_url, e))?;
        if absolute.scheme() != "https" && absolute.scheme() != "http" {
            return Err(format!("bundleUrl must be http(s), got {}", absolute));
        }
        part["bundleUrl"] = Value::String(absolute.to_string());
        parts.push(part);
    }
    Ok(serde_json::json!({ "formatVersion": 1, "parts": parts }))
}

fn registry_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))
}

/// Registries are untrusted transport (the signature and trust flow judges
/// installs), so plain HTTP is fine where it is the honest scheme: bare
/// URLs default to https, loopback hosts to http.
pub(crate) fn normalize_registry_url(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        return trimmed.to_string();
    }
    let loopback = trimmed.starts_with("localhost")
        || trimmed.starts_with("127.0.0.1")
        || trimmed.starts_with("[::1]");
    let scheme = if loopback { "http" } else { "https" };
    format!("{}://{}", scheme, trimmed)
}

fn registry_request_error(url: &str, error: reqwest::Error) -> String {
    let mut message = format!("Registry request failed: {}", error);
    if ["https://localhost", "https://127.0.0.1", "https://[::1]"]
        .iter()
        .any(|prefix| url.starts_with(prefix))
    {
        message.push_str(
            "; local registries usually speak plain HTTP, so try the http:// form of this URL",
        );
    }
    message
}

#[tauri::command]
pub async fn fetch_registry_index(url: String) -> Result<Value, String> {
    let url = normalize_registry_url(&url);
    let response = registry_client()?
        .get(&url)
        .send()
        .await
        .map_err(|e| registry_request_error(&url, e))?;
    if !response.status().is_success() {
        return Err(format!("Registry answered {}", response.status()));
    }
    let body = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read the index: {}", e))?;
    if body.len() > MAX_INDEX_BYTES {
        return Err("Registry index is unreasonably large".to_string());
    }
    parse_registry_index(&url, &String::from_utf8_lossy(&body))
}

#[tauri::command]
pub async fn download_registry_bundle(url: String) -> Result<String, String> {
    let url = normalize_registry_url(&url);
    let response = registry_client()?
        .get(&url)
        .send()
        .await
        .map_err(|e| registry_request_error(&url, e))?;
    if !response.status().is_success() {
        return Err(format!("Bundle download answered {}", response.status()));
    }
    let body = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read the bundle: {}", e))?;
    if body.len() > MAX_BUNDLE_DOWNLOAD_BYTES {
        return Err("Bundle exceeds the download size limit".to_string());
    }
    Ok(BASE64.encode(&body))
}

#[cfg(test)]
mod registry_tests {
    use super::normalize_registry_url;
    use super::parse_registry_index;

    #[test]
    fn bare_registry_urls_get_a_scheme_and_loopback_stays_http() {
        assert_eq!(
            normalize_registry_url("registry.example.io/index.json"),
            "https://registry.example.io/index.json"
        );
        assert_eq!(
            normalize_registry_url("localhost:8940/index.json"),
            "http://localhost:8940/index.json"
        );
        assert_eq!(
            normalize_registry_url("127.0.0.1:8940/index.json"),
            "http://127.0.0.1:8940/index.json"
        );
        assert_eq!(
            normalize_registry_url("  https://kept.example.io/index.json "),
            "https://kept.example.io/index.json"
        );
        assert_eq!(
            normalize_registry_url("http://localhost:8940/index.json"),
            "http://localhost:8940/index.json"
        );
    }

    #[test]
    fn resolves_relative_bundle_urls_and_checks_version() {
        let body = r#"{"formatVersion":1,"parts":[{"id":"a.b","bundleUrl":"a.b.derpart"}]}"#;
        let parsed =
            parse_registry_index("https://example.com/reg/index.json", body).expect("parses");
        assert_eq!(
            parsed["parts"][0]["bundleUrl"],
            "https://example.com/reg/a.b.derpart"
        );

        let bad = r#"{"formatVersion":2,"parts":[]}"#;
        assert!(parse_registry_index("https://example.com/index.json", bad).is_err());

        let scheme = r#"{"formatVersion":1,"parts":[{"bundleUrl":"file:///etc/passwd"}]}"#;
        assert!(parse_registry_index("https://example.com/index.json", scheme).is_err());
    }
}


// ---------------------------------------------------------------------------
// Integration part execution: declarative HTTP confined to the signed
// service base URL, with per-part secrets injected host-side.
// ---------------------------------------------------------------------------

fn substitute_placeholders(template: &str, inputs: &serde_json::Map<String, Value>) -> String {
    substitute(template, inputs, false)
}

/// Endpoint-path variant: substituted values are percent-encoded so a topic
/// like "Ada Lovelace" forms a valid URL and cannot smuggle path segments.
/// Query values stay raw (reqwest encodes them) and projection paths must
/// match response keys byte for byte.
fn substitute_placeholders_encoded(template: &str, inputs: &serde_json::Map<String, Value>) -> String {
    substitute(template, inputs, true)
}

fn substitute(template: &str, inputs: &serde_json::Map<String, Value>, encode: bool) -> String {
    let mut out = template.to_string();
    for (name, value) in inputs {
        let placeholder = format!("{{{}}}", name);
        if out.contains(&placeholder) {
            let raw = match value {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            let substituted = if encode { percent_encode(&raw) } else { raw };
            out = out.replace(&placeholder, &substituted);
        }
    }
    out
}

fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(byte as char)
            }
            other => out.push_str(&format!("%{:02X}", other)),
        }
    }
    out
}

/// Applies a remote projection. A path that resolves to nothing fails the
/// whole call: a silent null would flow downstream as data and surface far
/// from its cause (an upstream response missing an expected field must stop
/// the operation here, where the response can still be described).
pub fn apply_projection(
    body: &Value,
    projection: &std::collections::BTreeMap<String, String>,
    input_map: &serde_json::Map<String, Value>,
) -> Result<Value, String> {
    let mut out = serde_json::Map::new();
    for (name, path) in projection {
        let resolved = substitute_placeholders(path, input_map);
        let value = project_path(body, &resolved);
        if value.is_null() {
            let shape = match body {
                Value::Object(map) => {
                    format!("fields: {}", map.keys().cloned().collect::<Vec<_>>().join(", "))
                }
                other => format!("{}", other.to_string().chars().take(120).collect::<String>()),
            };
            return Err(format!(
                "The service response had no value at \"{}\" (needed for \"{}\"); it contains {}",
                resolved, name, shape
            ));
        }
        out.insert(name.clone(), value);
    }
    Ok(Value::Object(out))
}

/// Resolves a dot path (array indices as numerals) into a JSON value.
pub fn project_path(value: &Value, path: &str) -> Value {
    let mut current = value;
    for segment in path.split('.') {
        current = match current {
            Value::Object(map) => match map.get(segment) {
                Some(next) => next,
                None => return Value::Null,
            },
            Value::Array(items) => match segment.parse::<usize>().ok().and_then(|i| items.get(i)) {
                Some(next) => next,
                None => return Value::Null,
            },
            _ => return Value::Null,
        };
    }
    current.clone()
}

#[tauri::command]
pub async fn execute_part_remote(
    app: tauri::AppHandle,
    fragment_id: String,
    operation: String,
    inputs: Value,
) -> Result<FragmentExecResult, FragmentError> {
    let started = std::time::Instant::now();
    let dir = fragments_dir(&app)?;
    let secrets = Secrets::for_app(&app).map_err(|e| fail(FragmentErrorKind::Io, e))?;
    let data = execute_part_remote_core(&dir, &secrets, &fragment_id, &operation, &inputs).await?;
    Ok(FragmentExecResult {
        success: true,
        data: Some(data),
        error: None,
        execution_time_ms: started.elapsed().as_millis() as u64,
    })
}

/// The integration-part HTTP path, shared by the command above and the
/// runtime session dispatcher. The verified manifest resolves the request
/// here; the HTTP service performs it, holding the part's secrets and
/// keeping the request and its redirects inside the declared service.
pub(crate) async fn execute_part_remote_core(
    dir: &Path,
    secrets: &Secrets,
    fragment_id: &str,
    operation: &str,
    inputs: &Value,
) -> Result<Value, FragmentError> {
    let path = dir.join(format!("{}.derpart", fragment_id));
    let raw = std::fs::read(&path)
        .map_err(|_| fail(FragmentErrorKind::NotInstalled, format!("Part {} is not installed", fragment_id)))?;
    let verified = verify_bundle(&raw)?;
    if verified.manifest.id != fragment_id {
        return Err(fail(FragmentErrorKind::VerifyFailed, "Bundle id does not match its filename"));
    }
    let service = verified
        .manifest
        .service
        .clone()
        .ok_or_else(|| fail(FragmentErrorKind::OperationNotFound, "Part has no service block"))?;
    let op = verified
        .manifest
        .operations
        .iter()
        .find(|op| op.name == operation)
        .ok_or_else(|| fail(FragmentErrorKind::OperationNotFound, format!("No operation {}", operation)))?;
    let remote = op
        .remote
        .clone()
        .ok_or_else(|| fail(FragmentErrorKind::OperationNotFound, "Operation is not remote"))?;

    let empty = serde_json::Map::new();
    let input_map = inputs.as_object().unwrap_or(&empty);
    let endpoint = substitute_placeholders_encoded(&remote.endpoint, input_map);
    if endpoint.contains("..") {
        return Err(fail(FragmentErrorKind::Io, "Endpoint escaped its path"));
    }
    let url = format!("{}{}", service.base_url.trim_end_matches('/'), endpoint);
    let method = remote.method.clone().unwrap_or_else(|| "GET".to_string()).to_uppercase();
    if !matches!(method.as_str(), "GET" | "POST") {
        return Err(fail(FragmentErrorKind::Io, format!("Unsupported method {}", method)));
    }
    let query: Vec<(String, String)> = remote
        .query
        .iter()
        .flatten()
        .map(|(key, template)| (key.clone(), substitute_placeholders(template, input_map)))
        .collect();
    let json = match &remote.body {
        Some(_) if method != "POST" => {
            return Err(fail(FragmentErrorKind::Io, "A body needs the POST method"));
        }
        Some(body) => {
            let mut object = serde_json::Map::new();
            for (key, template) in body {
                object.insert(
                    key.clone(),
                    Value::String(substitute_placeholders(template, input_map)),
                );
            }
            Some(Value::Object(object))
        }
        None => None,
    };

    // The part's secrets are stored as part:<id>:<credential name>. The
    // service uses one only when its record was saved for this base URL.
    let reply = secrets
        .http(der_http::HttpRequest {
            method,
            url,
            headers: Vec::new(),
            query,
            json,
            timeout_secs: 20,
            auth: der_http::Auth::Part {
                fragment_id: fragment_id.to_string(),
                base_url: service.base_url.clone(),
                secrets: service
                    .credentials
                    .iter()
                    .map(|requirement| der_http::PartSecret {
                        name: requirement.name.clone(),
                        kind: requirement.kind.clone(),
                        target: requirement.target.clone(),
                        label: requirement.label.clone(),
                    })
                    .collect(),
            },
        })
        .await
        .map_err(|message| fail(FragmentErrorKind::Io, message))?;
    let body: Value = serde_json::from_str(&reply.body).map_err(|e| {
        fail(FragmentErrorKind::Io, format!("Response was not JSON: {}", e))
    })?;
    if !(200..300).contains(&reply.status) {
        let status = reqwest::StatusCode::from_u16(reply.status)
            .map(|status| status.to_string())
            .unwrap_or_else(|_| reply.status.to_string());
        return Err(fail(
            FragmentErrorKind::Io,
            format!("Service answered {}: {}", status, body.to_string().chars().take(200).collect::<String>()),
        ));
    }

    match &remote.project {
        Some(projection) => apply_projection(&body, projection, input_map)
            .map_err(|message| fail(FragmentErrorKind::Io, message)),
        None => Ok(body),
    }
}

/// The service block of an installed integration part, read from its
/// verified bundle.
fn installed_service(dir: &Path, fragment_id: &str) -> FragmentResult<ServiceSpec> {
    if !id_ok(fragment_id) {
        return Err(fail(FragmentErrorKind::NotInstalled, "Invalid part id"));
    }
    let raw = std::fs::read(dir.join(format!("{}.derpart", fragment_id))).map_err(|_| {
        fail(
            FragmentErrorKind::NotInstalled,
            format!("Part {} is not installed", fragment_id),
        )
    })?;
    let verified = verify_bundle(&raw)?;
    if verified.manifest.id != fragment_id {
        return Err(fail(FragmentErrorKind::VerifyFailed, "Bundle id does not match its filename"));
    }
    verified
        .manifest
        .service
        .ok_or_else(|| fail(FragmentErrorKind::OperationNotFound, "Part has no service block"))
}

/// Saves a part secret together with the service address its part declares,
/// so the record alone says where the secret may go.
pub(crate) fn set_part_credential_core(
    dir: &Path,
    secrets: &Secrets,
    fragment_id: &str,
    name: &str,
    secret: String,
) -> FragmentResult<()> {
    if secret.trim().is_empty() {
        return Err(fail(FragmentErrorKind::Io, "The secret cannot be empty"));
    }
    let service = installed_service(dir, fragment_id)?;
    if !service.credentials.iter().any(|requirement| requirement.name == name) {
        return Err(fail(
            FragmentErrorKind::Io,
            format!("This part declares no credential named \"{}\"", name),
        ));
    }
    match secrets.store(der_http::Request::PartSecretSet {
        fragment_id: fragment_id.to_string(),
        name: name.to_string(),
        base_url: service.base_url,
        secret,
    }) {
        der_http::Reply::Done => Ok(()),
        der_http::Reply::Error(message) => Err(fail(FragmentErrorKind::Io, message)),
        _ => Err(fail(FragmentErrorKind::Io, "The credential store answered out of turn")),
    }
}

/// The part's saved credential names. A record saved for another service
/// address counts as missing, which is how the Parts view asks for it again.
pub(crate) fn list_part_credentials_in(dir: &Path, secrets: &Secrets, fragment_id: &str) -> Vec<String> {
    let Ok(service) = installed_service(dir, fragment_id) else {
        return Vec::new();
    };
    match secrets.store(der_http::Request::PartSecretNames {
        fragment_id: fragment_id.to_string(),
        base_url: service.base_url,
    }) {
        der_http::Reply::Names(names) => names,
        _ => Vec::new(),
    }
}

/// Part secrets saved before records carried an address take the address
/// of the part installed for them. Records whose part is gone, or no longer
/// declares that credential, stay unusable. Returns how many records were
/// offered an address.
pub(crate) fn backfill_part_secret_addresses_core(dir: &Path, secrets: &Secrets) -> usize {
    let der_http::Reply::Unaddressed(records) =
        secrets.store(der_http::Request::PartSecretsUnaddressed)
    else {
        return 0;
    };
    let mut offered = 0;
    for record in records {
        let Ok(service) = installed_service(dir, &record.fragment_id) else {
            continue;
        };
        if !service.credentials.iter().any(|requirement| requirement.name == record.name) {
            continue;
        }
        let reply = secrets.store(der_http::Request::PartSecretAdopt {
            fragment_id: record.fragment_id,
            name: record.name,
            base_url: service.base_url,
        });
        match reply {
            der_http::Reply::Error(message) => {
                eprintln!("Failed to save a part secret address: {}", message)
            }
            _ => offered += 1,
        }
    }
    offered
}

/// Runs the address backfill against the stored records at startup.
pub fn backfill_part_secret_addresses(app: &tauri::AppHandle) {
    let (Ok(dir), Ok(secrets)) = (fragments_dir(app), Secrets::for_app(app)) else {
        return;
    };
    backfill_part_secret_addresses_core(&dir, &secrets);
}

#[tauri::command]
pub fn set_part_credential(
    app: tauri::AppHandle,
    fragment_id: String,
    name: String,
    secret: String,
) -> Result<Vec<String>, FragmentError> {
    let dir = fragments_dir(&app)?;
    let secrets = Secrets::for_app(&app).map_err(|e| fail(FragmentErrorKind::Io, e))?;
    set_part_credential_core(&dir, &secrets, &fragment_id, &name, secret)?;
    Ok(list_part_credentials_in(&dir, &secrets, &fragment_id))
}

#[tauri::command]
pub fn list_part_credentials(app: tauri::AppHandle, fragment_id: String) -> Vec<String> {
    let (Ok(dir), Ok(secrets)) = (fragments_dir(&app), Secrets::for_app(&app)) else {
        return Vec::new();
    };
    list_part_credentials_in(&dir, &secrets, &fragment_id)
}

#[cfg(test)]
mod remote_tests {
    use super::project_path;
    use serde_json::json;

    #[test]
    fn placeholders_substitute_in_projection_paths() {
        let mut inputs = serde_json::Map::new();
        inputs.insert("to".to_string(), json!("EUR"));
        assert_eq!(super::substitute_placeholders("rates.{to}", &inputs), "rates.EUR");
    }


    #[test]
    fn endpoint_substitution_percent_encodes_values() {
        let mut inputs = serde_json::Map::new();
        inputs.insert("topic".to_string(), json!("Ada Lovelace"));
        assert_eq!(
            super::substitute_placeholders_encoded("/api/rest_v1/page/summary/{topic}", &inputs),
            "/api/rest_v1/page/summary/Ada%20Lovelace"
        );
        inputs.insert("topic".to_string(), json!("a/b?c=d"));
        assert_eq!(
            super::substitute_placeholders_encoded("/summary/{topic}", &inputs),
            "/summary/a%2Fb%3Fc%3Dd"
        );
    }

    #[test]
    fn projection_walks_objects_and_arrays() {
        let body = json!({"main": {"temp": 21.4}, "weather": [{"description": "clear sky"}], "name": "Istanbul"});
        assert_eq!(project_path(&body, "main.temp"), json!(21.4));
        assert_eq!(project_path(&body, "weather.0.description"), json!("clear sky"));
        assert_eq!(project_path(&body, "name"), json!("Istanbul"));
        assert_eq!(project_path(&body, "missing.path"), serde_json::Value::Null);
    }

    #[test]
    fn projection_collects_named_values() {
        let body = json!({"rates": {"EUR": 0.87}, "date": "2026-07-23"});
        let mut projection = std::collections::BTreeMap::new();
        projection.insert("rate".to_string(), "rates.{to}".to_string());
        projection.insert("date".to_string(), "date".to_string());
        let mut inputs = serde_json::Map::new();
        inputs.insert("to".to_string(), json!("EUR"));
        let data = super::apply_projection(&body, &projection, &inputs).unwrap();
        assert_eq!(data, json!({"rate": 0.87, "date": "2026-07-23"}));
    }

    #[test]
    fn projection_miss_fails_and_names_the_path() {
        // A response without the expected field (base currency omitted from
        // its own rates table, an upstream serving a default payload) must
        // fail the call, never hand a null downstream.
        let body = json!({"amount": 1.0, "base": "EUR", "date": "2026-07-23", "rates": {"USD": 1.16}});
        let mut projection = std::collections::BTreeMap::new();
        projection.insert("rate".to_string(), "rates.{to}".to_string());
        let mut inputs = serde_json::Map::new();
        inputs.insert("to".to_string(), json!("EUR"));
        let err = super::apply_projection(&body, &projection, &inputs).unwrap_err();
        assert!(err.contains("rates.EUR"), "path missing from: {}", err);
        assert!(err.contains("rates"), "fields missing from: {}", err);
    }
}

#[cfg(test)]
mod part_secret_tests {
    use std::path::Path;

    use der_http::store::{self, part_secret_key, IntegrationCredential};
    use serde_json::json;

    use super::{
        backfill_part_secret_addresses_core, execute_part_remote_core, list_part_credentials_in,
        set_part_credential_core, verify_bundle, Manifest,
    };
    use crate::secrets::Secrets;

    const BUNDLE: &str = "../../fragments/dist/der-labs.openweather.derpart";
    const PART: &str = "der-labs.openweather";
    const SERVICE: &str = "https://api.openweathermap.org";

    /// A fragments directory with the committed openweather part installed,
    /// an empty settings directory beside it, and the part's manifest.
    struct Installed {
        fragments: tempfile::TempDir,
        settings: tempfile::TempDir,
        manifest: Manifest,
    }

    impl Installed {
        fn new() -> Self {
            let raw = std::fs::read(BUNDLE).expect("committed bundle present");
            let fragments = tempfile::tempdir().expect("temp dir");
            std::fs::write(fragments.path().join(format!("{PART}.derpart")), &raw).expect("install");
            Installed {
                fragments,
                settings: tempfile::tempdir().expect("temp dir"),
                manifest: verify_bundle(&raw).expect("verifies").manifest,
            }
        }

        fn dir(&self) -> &Path {
            self.fragments.path()
        }

        fn secrets(&self) -> Secrets {
            Secrets::at(self.settings.path())
        }

        fn credential_name(&self) -> String {
            self.manifest.service.as_ref().expect("service block").credentials[0]
                .name
                .clone()
        }

        /// Writes records straight into the store, the way an older build
        /// or another address would have left them.
        fn seed(&self, records: &[(String, Option<&str>)]) {
            let mut integrations = store::load(self.settings.path());
            for (key, base_url) in records {
                integrations.credentials.insert(
                    key.clone(),
                    IntegrationCredential {
                        kind: "partsecret".to_string(),
                        target: None,
                        base_url: base_url.map(str::to_string),
                        notes: None,
                        fields: None,
                        secret: "s3cret-value".to_string(),
                    },
                );
            }
            store::save(self.settings.path(), &integrations).expect("seeds");
        }

        fn saved_address(&self, key: &str) -> Option<String> {
            store::load(self.settings.path()).credentials[key].base_url.clone()
        }

        fn run(&self) -> Result<(), String> {
            tauri::async_runtime::block_on(execute_part_remote_core(
                self.dir(),
                &self.secrets(),
                PART,
                &self.manifest.operations[0].name,
                &json!({}),
            ))
            .map(|_| ())
            .map_err(|error| error.message)
        }
    }

    #[test]
    fn saving_records_the_service_address_of_the_part() {
        let part = Installed::new();
        let name = part.credential_name();
        set_part_credential_core(part.dir(), &part.secrets(), PART, &name, "s3cret-value".into())
            .expect("saves");
        assert_eq!(part.saved_address(&part_secret_key(PART, &name)).as_deref(), Some(SERVICE));
        assert_eq!(list_part_credentials_in(part.dir(), &part.secrets(), PART), vec![name]);
    }

    #[test]
    fn saving_needs_an_installed_part_and_a_declared_name() {
        let part = Installed::new();
        let name = part.credential_name();
        let undeclared =
            set_part_credential_core(part.dir(), &part.secrets(), PART, "other", "x".into())
                .expect_err("the part declares no such credential");
        assert!(undeclared.message.contains("declares no credential"), "{}", undeclared.message);
        let missing =
            set_part_credential_core(part.dir(), &part.secrets(), "der-labs.absent", &name, "x".into())
                .expect_err("the part is not installed");
        assert!(missing.message.contains("is not installed"), "{}", missing.message);
        assert!(store::load(part.settings.path()).credentials.is_empty());
    }

    #[test]
    fn a_secret_saved_for_another_address_is_not_sent() {
        for base_url in [None, Some("https://api.elsewhere.dev"), Some("https://api.openweathermap.org.elsewhere.dev")] {
            let part = Installed::new();
            part.seed(&[(part_secret_key(PART, &part.credential_name()), base_url)]);
            let error = part.run().expect_err("the record does not belong to this service");
            assert!(error.contains("saved for another service address"), "{base_url:?}: {error}");
            assert!(
                list_part_credentials_in(part.dir(), &part.secrets(), PART).is_empty(),
                "{base_url:?} counts as missing"
            );
        }
    }

    #[test]
    fn removing_a_part_removes_the_secrets_saved_for_it() {
        let part = Installed::new();
        let name = part.credential_name();
        part.seed(&[
            (part_secret_key(PART, &name), Some(SERVICE)),
            (part_secret_key(PART, "old"), None),
            (part_secret_key("der-labs.other", &name), Some(SERVICE)),
        ]);

        super::remove_with_secrets_core(part.dir(), &part.secrets(), PART).expect("removes");
        assert!(!part.dir().join(format!("{PART}.derpart")).exists());
        let left = store::load(part.settings.path()).credentials;
        assert_eq!(left.len(), 1, "{:?}", left.keys());
        assert!(left.contains_key(&part_secret_key("der-labs.other", &name)));
    }

    #[test]
    fn backfill_gives_old_records_the_address_of_their_part() {
        let part = Installed::new();
        let name = part.credential_name();
        part.seed(&[
            (part_secret_key(PART, &name), None),
            (part_secret_key(PART, "undeclared"), None),
            (part_secret_key("der-labs.absent", &name), None),
            (part_secret_key(PART, "kept"), Some("https://api.elsewhere.dev")),
        ]);

        assert_eq!(backfill_part_secret_addresses_core(part.dir(), &part.secrets()), 1);
        assert_eq!(part.saved_address(&part_secret_key(PART, &name)).as_deref(), Some(SERVICE));
        assert_eq!(part.saved_address(&part_secret_key(PART, "undeclared")), None);
        assert_eq!(part.saved_address(&part_secret_key("der-labs.absent", &name)), None);
        assert_eq!(
            part.saved_address(&part_secret_key(PART, "kept")).as_deref(),
            Some("https://api.elsewhere.dev")
        );
        assert_eq!(
            backfill_part_secret_addresses_core(part.dir(), &part.secrets()),
            0,
            "a second run finds nothing to do"
        );
    }
}


#[cfg(test)]
mod runner_tests {
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;

    use serde_json::json;

    use super::{run_part_core, Handoff, Runner};

    const RAR_BUNDLE: &str = "../../fragments/dist/der-labs.rar.derpart";
    const RAR: &str = "der-labs.rar";
    const ARCHIVE: &str = "../services/parts/tests/fixtures/rar/classic.rar";

    fn installed() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::copy(RAR_BUNDLE, dir.path().join(format!("{RAR}.derpart"))).expect("install");
        dir
    }

    #[test]
    fn a_granted_file_goes_in_and_the_produced_file_becomes_the_callers() {
        let fragments = installed();
        let kept_dir = tempfile::tempdir().expect("temp dir");
        let runner = Runner::at(fragments.path());
        let asked: Mutex<Vec<String>> = Mutex::new(Vec::new());
        let resolve = |token: &str| {
            asked.lock().unwrap().push(token.to_string());
            (token == "grant-1").then(|| PathBuf::from(ARCHIVE))
        };
        let taken: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());
        let register = |produced: &Path| {
            let name = produced.file_name().expect("name").to_string_lossy().to_string();
            let kept = kept_dir.path().join(&name);
            std::fs::rename(produced, &kept).map_err(|e| e.to_string())?;
            taken.lock().unwrap().push(produced.to_path_buf());
            Ok(json!({ "file": "grant-2", "url": "asset://kept", "name": name, "size": 20 }))
        };

        let outputs = run_part_core(
            &runner,
            RAR,
            "rar.extract",
            &json!({ "file": "grant-1", "name": "test.txt" }),
            &resolve,
            &register,
        )
        .expect("extracts");
        assert_eq!(outputs["file"], "grant-2", "the placeholder gave way to the caller's handle");
        assert_eq!(outputs["name"], "test.txt");
        assert_eq!(std::fs::read(kept_dir.path().join("test.txt")).expect("kept").len(), 20);
        // Every string input was offered to the resolver; only the live
        // token came back as a file.
        let mut offered = asked.lock().unwrap().clone();
        offered.sort();
        assert_eq!(offered, vec!["grant-1", "test.txt"]);
        // The handoff folder is gone with the call.
        let handoff = taken.lock().unwrap()[0].parent().and_then(Path::parent).expect("handoff").to_path_buf();
        assert!(!handoff.exists(), "{handoff:?}");
    }

    #[test]
    fn a_failing_part_reports_its_own_error() {
        let fragments = installed();
        let runner = Runner::at(fragments.path());
        let error = run_part_core(
            &runner,
            RAR,
            "rar.extract",
            &json!({ "file": "not-a-grant", "name": "test.txt" }),
            &|_token| None,
            &|_path| Err("nothing should be produced".to_string()),
        )
        .expect_err("no file was granted");
        assert!(error.message.contains("needs a picked file"), "{}", error.message);
    }

    #[test]
    fn only_a_plain_file_one_folder_below_the_handoff_is_accepted() {
        let handoff = Handoff::create().expect("handoff");
        let slot = handoff.root.join("0");
        std::fs::create_dir_all(&slot).expect("slot");
        let inside = slot.join("out.txt");
        std::fs::write(&inside, b"ok").expect("writes");
        assert!(handoff.accept(&inside).is_some());

        let elsewhere = tempfile::tempdir().expect("temp dir");
        let private = elsewhere.path().join("private.txt");
        std::fs::write(&private, b"secret").expect("writes");
        assert!(handoff.accept(&private).is_none(), "a file outside the folder");

        let top_level = handoff.root.join("loose.txt");
        std::fs::write(&top_level, b"x").expect("writes");
        assert!(handoff.accept(&top_level).is_none(), "a file not in a slot");

        let deep = slot.join("deeper");
        std::fs::create_dir_all(&deep).expect("deeper");
        std::fs::write(deep.join("far.txt"), b"x").expect("writes");
        assert!(handoff.accept(&deep.join("far.txt")).is_none(), "a file too deep");

        assert!(handoff.accept(&slot.join("missing.txt")).is_none(), "a file that is not there");
        assert!(handoff.accept(&slot.join("..").join("..").join("escape.txt")).is_none(), "a path that climbs out");

        #[cfg(unix)]
        {
            let link = slot.join("link.txt");
            std::os::unix::fs::symlink(&private, &link).expect("symlink");
            assert!(handoff.accept(&link).is_none(), "a link to a file outside");
            let linked_slot = handoff.root.join("1");
            std::os::unix::fs::symlink(elsewhere.path(), &linked_slot).expect("symlink");
            assert!(handoff.accept(&linked_slot.join("private.txt")).is_none(), "a slot that is a link");
        }

        let root = handoff.root.clone();
        drop(handoff);
        assert!(!root.exists(), "the folder goes with the call");
    }
}
