//! Signed Wasm operation parts: verification, trust pinning, and a hardened
//! wasmtime host.
//!
//! A part ships as a single `.derpart` JSON bundle whose manifest bytes are
//! stored verbatim and signed (Ed25519 over `DERPART-SIG-V1\0 || manifest`).
//! The manifest binds the module by sha256. Guests implement a minimal ABI
//! (`memory`, `der_alloc`, `der_run`) with an empty import section, which is
//! the capability guarantee: a v1 part can compute and nothing else. Fuel,
//! an epoch deadline, a memory limiter, and per-call instances bound what a
//! hostile module can cost.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::Manager;
use wasmtime::{Config, Engine, Instance, Module, Store};

const SIG_DOMAIN: &[u8] = b"DERPART-SIG-V1\x00";
const FORMAT_VERSION: u32 = 1;
const ABI_VERSION: u32 = 1;
const MAX_BUNDLE_BYTES: usize = 32 << 20;
const MAX_MANIFEST_BYTES: usize = 256 << 10;
const MAX_WASM_BYTES: usize = 10 << 20;
const MAX_INPUT_BYTES: usize = 1 << 20;
const MAX_OUTPUT_BYTES: u32 = 4 << 20;
const MAX_OPERATIONS: usize = 64;
const MEM_LIMIT_BYTES: usize = 64 << 20;
const FUEL_BUDGET: u64 = 500_000_000;
const EPOCH_TICK_MS: u64 = 100;
const EPOCH_DEADLINE_TICKS: u64 = 20; // roughly two seconds of wall clock
const MAX_GUEST_ERR_BYTES: usize = 1024;
const EXEC_PERMITS: usize = 2;
const EXEC_ACQUIRE_TIMEOUT_MS: u64 = 5000;

const RESERVED_NAMESPACES: &[&str] = &[
    "state", "counter", "list", "math", "http", "todos", "ui", "der", "core", "builtin",
];

// ---------------------------------------------------------------------------
// Wire formats
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Bundle {
    format_version: u32,
    manifest_b64: String,
    wasm_b64: String,
    publisher_key_b64: String,
    signature_b64: String,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub format_version: u32,
    pub abi_version: u32,
    pub id: String,
    pub name: String,
    pub version: String,
    pub publisher: String,
    pub description: String,
    pub namespace: String,
    pub capabilities: Vec<String>,
    pub wasm_sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    pub operations: Vec<OpSpec>,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OpSpec {
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub inputs: Vec<IoSpec>,
    #[serde(default)]
    pub outputs: Vec<IoSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub howto: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub example: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub structured_prefixes: Vec<String>,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IoSpec {
    pub name: String,
    #[serde(rename = "type")]
    pub io_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum FragmentErrorKind {
    NotInstalled,
    VerifyFailed,
    AbiMismatch,
    OperationNotFound,
    InputTooLarge,
    CompileFailed,
    Trap,
    FuelExhausted,
    Timeout,
    Oom,
    BadOutput,
    GuestError,
    Busy,
    TrustViolation,
    Io,
}

#[derive(Serialize, Clone, Debug)]
pub struct FragmentError {
    pub kind: FragmentErrorKind,
    pub message: String,
}

impl FragmentError {
    fn new(kind: FragmentErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into() }
    }
}

pub type FragmentResult<T> = Result<T, FragmentError>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FragmentExecResult {
    pub success: bool,
    pub data: Option<Value>,
    pub error: Option<FragmentError>,
    pub execution_time_ms: u64,
}

// ---------------------------------------------------------------------------
// Trust store
// ---------------------------------------------------------------------------

#[derive(Deserialize, Serialize, Default, Clone)]
struct TrustStore {
    #[serde(default = "trust_version")]
    version: u32,
    #[serde(default)]
    publishers: HashMap<String, PublisherPin>,
    #[serde(default)]
    namespaces: HashMap<String, NamespaceClaim>,
    #[serde(default)]
    installed: HashMap<String, InstalledPin>,
}

fn trust_version() -> u32 {
    1
}

#[derive(Deserialize, Serialize, Clone)]
struct PublisherPin {
    key: String,
    fingerprint: String,
    first_seen: String,
}

#[derive(Deserialize, Serialize, Clone)]
struct NamespaceClaim {
    publisher: String,
    fragment_id: String,
}

#[derive(Deserialize, Serialize, Clone)]
struct InstalledPin {
    publisher: String,
    version: String,
    bundle_sha256: String,
    installed_at: String,
}

fn load_trust(dir: &Path) -> TrustStore {
    let path = dir.join("trust.json");
    std::fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

fn save_trust(dir: &Path, trust: &TrustStore) -> FragmentResult<()> {
    std::fs::create_dir_all(dir)
        .map_err(|e| FragmentError::new(FragmentErrorKind::Io, e.to_string()))?;
    let path = dir.join("trust.json");
    let json = serde_json::to_string_pretty(trust)
        .map_err(|e| FragmentError::new(FragmentErrorKind::Io, e.to_string()))?;
    std::fs::write(&path, json)
        .map_err(|e| FragmentError::new(FragmentErrorKind::Io, e.to_string()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

pub struct VerifiedBundle {
    pub manifest: Manifest,
    pub wasm: Vec<u8>,
    pub publisher_key: [u8; 32],
    pub fingerprint: String,
    pub bundle_sha256: String,
    pub raw: Vec<u8>,
}

impl std::fmt::Debug for VerifiedBundle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VerifiedBundle")
            .field("id", &self.manifest.id)
            .field("fingerprint", &self.fingerprint)
            .field("wasm_bytes", &self.wasm.len())
            .finish()
    }
}

fn fail(kind: FragmentErrorKind, message: impl Into<String>) -> FragmentError {
    FragmentError::new(kind, message)
}

fn id_ok(id: &str) -> bool {
    let bytes = id.as_bytes();
    if bytes.is_empty() || bytes.len() > 64 {
        return false;
    }
    let first_ok = bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit();
    first_ok
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-'))
}

fn namespace_ok(ns: &str) -> bool {
    let bytes = ns.as_bytes();
    bytes.len() >= 2
        && bytes.len() <= 32
        && bytes[0].is_ascii_lowercase()
        && bytes[1..].iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_')
}

fn op_name_ok(name: &str, namespace: &str) -> bool {
    if !name.starts_with(&format!("{}.", namespace)) {
        return false;
    }
    let segments: Vec<&str> = name.split('.').collect();
    segments.len() >= 2
        && segments.iter().all(|segment| {
            let bytes = segment.as_bytes();
            !bytes.is_empty()
                && bytes[0].is_ascii_lowercase()
                && bytes[1..]
                    .iter()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_')
        })
}

pub fn fingerprint_hex(public_key: &[u8; 32]) -> String {
    let digest = Sha256::digest(public_key);
    hex_lower(&digest)
}

pub fn fingerprint_grouped(public_key: &[u8; 32]) -> String {
    let hex = fingerprint_hex(public_key);
    hex.as_bytes()
        .chunks(4)
        .map(|chunk| std::str::from_utf8(chunk).unwrap_or_default())
        .collect::<Vec<_>>()
        .join(" ")
}

fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Verifies a raw `.derpart` file: structure, sizes, signature over the
/// verbatim manifest bytes, wasm hash binding, and manifest invariants.
pub fn verify_bundle(raw: &[u8]) -> FragmentResult<VerifiedBundle> {
    if raw.len() > MAX_BUNDLE_BYTES {
        return Err(fail(FragmentErrorKind::VerifyFailed, "Bundle exceeds the size limit"));
    }
    let bundle: Bundle = serde_json::from_slice(raw)
        .map_err(|e| fail(FragmentErrorKind::VerifyFailed, format!("Not a valid part bundle: {}", e)))?;
    if bundle.format_version != FORMAT_VERSION {
        return Err(fail(
            FragmentErrorKind::VerifyFailed,
            format!("Unsupported bundle format {}", bundle.format_version),
        ));
    }

    let manifest_bytes = BASE64
        .decode(&bundle.manifest_b64)
        .map_err(|_| fail(FragmentErrorKind::VerifyFailed, "Manifest is not valid base64"))?;
    if manifest_bytes.len() > MAX_MANIFEST_BYTES {
        return Err(fail(FragmentErrorKind::VerifyFailed, "Manifest exceeds the size limit"));
    }
    let wasm = BASE64
        .decode(&bundle.wasm_b64)
        .map_err(|_| fail(FragmentErrorKind::VerifyFailed, "Module is not valid base64"))?;
    if wasm.len() > MAX_WASM_BYTES {
        return Err(fail(FragmentErrorKind::VerifyFailed, "Module exceeds the size limit"));
    }
    let key_bytes: [u8; 32] = BASE64
        .decode(&bundle.publisher_key_b64)
        .ok()
        .and_then(|k| k.try_into().ok())
        .ok_or_else(|| fail(FragmentErrorKind::VerifyFailed, "Publisher key must be 32 bytes"))?;
    let sig_bytes: [u8; 64] = BASE64
        .decode(&bundle.signature_b64)
        .ok()
        .and_then(|s| s.try_into().ok())
        .ok_or_else(|| fail(FragmentErrorKind::VerifyFailed, "Signature must be 64 bytes"))?;

    let key = VerifyingKey::from_bytes(&key_bytes)
        .map_err(|_| fail(FragmentErrorKind::VerifyFailed, "Publisher key is not a valid Ed25519 key"))?;
    let mut preimage = Vec::with_capacity(SIG_DOMAIN.len() + manifest_bytes.len());
    preimage.extend_from_slice(SIG_DOMAIN);
    preimage.extend_from_slice(&manifest_bytes);
    key.verify_strict(&preimage, &Signature::from_bytes(&sig_bytes))
        .map_err(|_| fail(FragmentErrorKind::VerifyFailed, "Signature verification failed"))?;

    let manifest: Manifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| fail(FragmentErrorKind::VerifyFailed, format!("Manifest invalid: {}", e)))?;

    if manifest.format_version != FORMAT_VERSION {
        return Err(fail(FragmentErrorKind::VerifyFailed, "Manifest format version mismatch"));
    }
    if manifest.abi_version != ABI_VERSION {
        return Err(fail(
            FragmentErrorKind::AbiMismatch,
            format!("Part targets ABI {} but this app supports {}", manifest.abi_version, ABI_VERSION),
        ));
    }
    if !id_ok(&manifest.id) {
        return Err(fail(FragmentErrorKind::VerifyFailed, "Part id contains invalid characters"));
    }
    if !namespace_ok(&manifest.namespace) {
        return Err(fail(FragmentErrorKind::VerifyFailed, "Part namespace is invalid"));
    }
    if RESERVED_NAMESPACES.contains(&manifest.namespace.as_str()) {
        return Err(fail(
            FragmentErrorKind::VerifyFailed,
            format!("Namespace \"{}\" is reserved", manifest.namespace),
        ));
    }
    if !manifest.capabilities.is_empty() {
        return Err(fail(
            FragmentErrorKind::VerifyFailed,
            "This app supports only pure-compute parts (capabilities must be empty)",
        ));
    }
    if manifest.operations.is_empty() || manifest.operations.len() > MAX_OPERATIONS {
        return Err(fail(FragmentErrorKind::VerifyFailed, "Part must declare 1-64 operations"));
    }
    let mut seen = std::collections::HashSet::new();
    for op in &manifest.operations {
        if !op_name_ok(&op.name, &manifest.namespace) {
            return Err(fail(
                FragmentErrorKind::VerifyFailed,
                format!("Operation \"{}\" must live under namespace \"{}.\"", op.name, manifest.namespace),
            ));
        }
        if !seen.insert(op.name.clone()) {
            return Err(fail(
                FragmentErrorKind::VerifyFailed,
                format!("Duplicate operation \"{}\"", op.name),
            ));
        }
    }

    let wasm_hash = hex_lower(&Sha256::digest(&wasm));
    if wasm_hash != manifest.wasm_sha256.to_lowercase() {
        return Err(fail(FragmentErrorKind::VerifyFailed, "Module hash does not match the manifest"));
    }

    Ok(VerifiedBundle {
        fingerprint: fingerprint_hex(&key_bytes),
        bundle_sha256: hex_lower(&Sha256::digest(raw)),
        manifest,
        wasm,
        publisher_key: key_bytes,
        raw: raw.to_vec(),
    })
}

/// Checks the module implements ABI v1 and imports nothing.
fn check_abi(module: &Module) -> FragmentResult<()> {
    if module.imports().len() > 0 {
        let names: Vec<String> = module
            .imports()
            .map(|i| format!("{}::{}", i.module(), i.name()))
            .take(5)
            .collect();
        return Err(fail(
            FragmentErrorKind::AbiMismatch,
            format!("Part imports host functions, which v1 forbids: {}", names.join(", ")),
        ));
    }
    let mut has_memory = false;
    let mut has_alloc = false;
    let mut has_run = false;
    for export in module.exports() {
        match export.name() {
            "memory" => has_memory = export.ty().memory().is_some(),
            "der_alloc" => {
                has_alloc = export
                    .ty()
                    .func()
                    .is_some_and(|f| f.params().len() == 1 && f.results().len() == 1)
            }
            "der_run" => {
                has_run = export
                    .ty()
                    .func()
                    .is_some_and(|f| f.params().len() == 2 && f.results().len() == 1)
            }
            _ => {}
        }
    }
    if !(has_memory && has_alloc && has_run) {
        return Err(fail(
            FragmentErrorKind::AbiMismatch,
            "Part must export memory, der_alloc(i32)->i32, and der_run(i32,i32)->i64",
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Host state and execution
// ---------------------------------------------------------------------------

struct StoreData {
    grow_denied: bool,
}

impl wasmtime::ResourceLimiter for StoreData {
    fn memory_growing(
        &mut self,
        _current: usize,
        desired: usize,
        _maximum: Option<usize>,
    ) -> wasmtime::Result<bool> {
        if desired > MEM_LIMIT_BYTES {
            self.grow_denied = true;
            return Ok(false);
        }
        Ok(true)
    }

    fn table_growing(
        &mut self,
        _current: usize,
        desired: usize,
        _maximum: Option<usize>,
    ) -> wasmtime::Result<bool> {
        Ok(desired <= 10_000)
    }
}

pub struct LoadedFragment {
    pub manifest: Manifest,
    module: Module,
}

struct StagedBundle {
    verified: VerifiedBundle,
    publisher_status: String,
    is_downgrade: bool,
}

pub struct FragmentsState {
    engine: Engine,
    loaded: Mutex<HashMap<String, Arc<LoadedFragment>>>,
    staged: Mutex<HashMap<String, StagedBundle>>,
    exec_permits: Arc<tokio::sync::Semaphore>,
}

impl FragmentsState {
    pub fn new() -> Self {
        // Threads support is not even compiled in (no "threads" cargo
        // feature), which is stronger than disabling it here.
        let mut config = Config::new();
        config.consume_fuel(true);
        config.epoch_interruption(true);
        config.max_wasm_stack(512 * 1024);
        config.wasm_memory64(false);
        config.wasm_multi_memory(false);
        config.wasm_relaxed_simd(false);
        let engine = Engine::new(&config).expect("wasmtime engine");

        // Wall-clock backstop: bump the epoch on a fixed tick for the app's
        // lifetime so runaway guests trap at their deadline.
        let ticker = engine.clone();
        std::thread::Builder::new()
            .name("der-fragment-epoch".into())
            .spawn(move || loop {
                std::thread::sleep(Duration::from_millis(EPOCH_TICK_MS));
                ticker.increment_epoch();
            })
            .expect("epoch ticker thread");

        Self {
            engine,
            loaded: Mutex::new(HashMap::new()),
            staged: Mutex::new(HashMap::new()),
            exec_permits: Arc::new(tokio::sync::Semaphore::new(EXEC_PERMITS)),
        }
    }

    pub fn engine(&self) -> &Engine {
        &self.engine
    }

    pub fn compile(&self, wasm: &[u8]) -> FragmentResult<Module> {
        let module = Module::new(&self.engine, wasm)
            .map_err(|e| fail(FragmentErrorKind::CompileFailed, format!("Module rejected: {}", e)))?;
        check_abi(&module)?;
        Ok(module)
    }

    /// Loads (verify + compile) an installed fragment, caching per session.
    pub fn load(&self, dir: &Path, id: &str) -> FragmentResult<Arc<LoadedFragment>> {
        if !id_ok(id) {
            return Err(fail(FragmentErrorKind::NotInstalled, "Invalid part id"));
        }
        if let Some(found) = self.loaded.lock().unwrap().get(id) {
            return Ok(found.clone());
        }
        let path = dir.join(format!("{}.derpart", id));
        let raw = std::fs::read(&path)
            .map_err(|_| fail(FragmentErrorKind::NotInstalled, format!("Part {} is not installed", id)))?;
        let verified = verify_bundle(&raw)?;
        if verified.manifest.id != id {
            return Err(fail(FragmentErrorKind::VerifyFailed, "Bundle id does not match its filename"));
        }
        let module = self.compile(&verified.wasm)?;
        let loaded = Arc::new(LoadedFragment {
            manifest: verified.manifest,
            module,
        });
        self.loaded.lock().unwrap().insert(id.to_string(), loaded.clone());
        Ok(loaded)
    }

    fn evict(&self, id: &str) {
        self.loaded.lock().unwrap().remove(id);
    }
}

impl Default for FragmentsState {
    fn default() -> Self {
        Self::new()
    }
}

fn map_wasm_error(err: wasmtime::Error, data: &StoreData) -> FragmentError {
    if data.grow_denied {
        return fail(FragmentErrorKind::Oom, "Part exceeded its memory limit");
    }
    if let Some(trap) = err.downcast_ref::<wasmtime::Trap>() {
        return match trap {
            wasmtime::Trap::OutOfFuel => {
                fail(FragmentErrorKind::FuelExhausted, "Part exceeded its compute budget")
            }
            wasmtime::Trap::Interrupt => {
                fail(FragmentErrorKind::Timeout, "Part exceeded its time limit")
            }
            wasmtime::Trap::StackOverflow => fail(FragmentErrorKind::Trap, "Part overflowed its stack"),
            other => fail(FragmentErrorKind::Trap, format!("Part trapped: {}", other)),
        };
    }
    fail(FragmentErrorKind::Trap, format!("Part failed: {}", err))
}

/// Runs one operation in a fresh, hardened instance.
pub fn execute_in_module(
    engine: &Engine,
    loaded: &LoadedFragment,
    operation: &str,
    inputs: &Value,
) -> FragmentResult<Value> {
    if !loaded.manifest.operations.iter().any(|op| op.name == operation) {
        return Err(fail(
            FragmentErrorKind::OperationNotFound,
            format!("Part {} has no operation \"{}\"", loaded.manifest.id, operation),
        ));
    }

    let envelope = serde_json::json!({ "operation": operation, "inputs": inputs });
    let request = serde_json::to_vec(&envelope)
        .map_err(|e| fail(FragmentErrorKind::Io, e.to_string()))?;
    if request.len() > MAX_INPUT_BYTES {
        return Err(fail(FragmentErrorKind::InputTooLarge, "Operation inputs exceed 1 MiB"));
    }

    let mut store = Store::new(engine, StoreData { grow_denied: false });
    store.limiter(|data| data);
    store
        .set_fuel(FUEL_BUDGET)
        .map_err(|e| fail(FragmentErrorKind::Io, e.to_string()))?;
    store.set_epoch_deadline(EPOCH_DEADLINE_TICKS);

    let instance = Instance::new(&mut store, &loaded.module, &[])
        .map_err(|e| map_wasm_error(e, store.data()))?;
    let memory = instance
        .get_memory(&mut store, "memory")
        .ok_or_else(|| fail(FragmentErrorKind::AbiMismatch, "Part exports no memory"))?;
    let der_alloc = instance
        .get_typed_func::<i32, i32>(&mut store, "der_alloc")
        .map_err(|_| fail(FragmentErrorKind::AbiMismatch, "der_alloc has the wrong signature"))?;
    let der_run = instance
        .get_typed_func::<(i32, i32), i64>(&mut store, "der_run")
        .map_err(|_| fail(FragmentErrorKind::AbiMismatch, "der_run has the wrong signature"))?;

    let len = request.len() as i32;
    let ptr = der_alloc
        .call(&mut store, len)
        .map_err(|e| map_wasm_error(e, store.data()))?;
    if ptr == 0 {
        return Err(fail(FragmentErrorKind::Oom, "Part could not allocate the request"));
    }
    let ptr_u = ptr as u32 as u64;
    if ptr_u + request.len() as u64 > memory.data_size(&store) as u64 {
        return Err(fail(FragmentErrorKind::BadOutput, "Part returned an out-of-bounds buffer"));
    }
    memory
        .write(&mut store, ptr_u as usize, &request)
        .map_err(|_| fail(FragmentErrorKind::BadOutput, "Writing the request failed"))?;

    let packed = der_run
        .call(&mut store, (ptr, len))
        .map_err(|e| map_wasm_error(e, store.data()))?;

    // Decode as unsigned bit pattern; signed shifts would smear the pointer.
    let packed = packed as u64;
    let out_ptr = (packed >> 32) as u32;
    let out_len = (packed & 0xFFFF_FFFF) as u32;
    if out_ptr == 0 || out_len == 0 {
        return Err(fail(FragmentErrorKind::BadOutput, "Part returned an empty result"));
    }
    if out_len > MAX_OUTPUT_BYTES {
        return Err(fail(FragmentErrorKind::BadOutput, "Part result exceeds 4 MiB"));
    }
    if out_ptr as u64 + out_len as u64 > memory.data_size(&store) as u64 {
        return Err(fail(FragmentErrorKind::BadOutput, "Part returned an out-of-bounds result"));
    }
    let mut out = vec![0u8; out_len as usize];
    memory
        .read(&store, out_ptr as usize, &mut out)
        .map_err(|_| fail(FragmentErrorKind::BadOutput, "Reading the result failed"))?;

    let text = std::str::from_utf8(&out)
        .map_err(|_| fail(FragmentErrorKind::BadOutput, "Part result is not UTF-8"))?;
    let parsed: Value = serde_json::from_str(text)
        .map_err(|_| fail(FragmentErrorKind::BadOutput, "Part result is not valid JSON"))?;

    if let Some(err) = parsed.get("err") {
        let mut message = err.as_str().unwrap_or("Part reported an error").to_string();
        message.truncate(MAX_GUEST_ERR_BYTES);
        return Err(fail(FragmentErrorKind::GuestError, message));
    }
    match parsed.get("ok") {
        Some(ok) if ok.is_object() => Ok(ok.clone()),
        _ => Err(fail(FragmentErrorKind::BadOutput, "Part result must be {\"ok\": {...}} or {\"err\": \"...\"}")),
    }
}

// ---------------------------------------------------------------------------
// Install / trust flows (AppHandle-free cores)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageSummary {
    pub staging_token: String,
    pub id: String,
    pub name: String,
    pub version: String,
    pub publisher: String,
    pub description: String,
    pub namespace: String,
    pub operations: Vec<Value>,
    pub fingerprint: String,
    pub fingerprint_grouped: String,
    pub publisher_status: String,
    pub is_downgrade: bool,
}

fn semver_downgrade(new_version: &str, old_version: &str) -> bool {
    match (semver::Version::parse(new_version), semver::Version::parse(old_version)) {
        (Ok(new_v), Ok(old_v)) => new_v < old_v,
        _ => false,
    }
}

pub fn stage_core(
    state: &FragmentsState,
    fragments_dir: &Path,
    raw: &[u8],
    reserved_names: &[String],
) -> FragmentResult<StageSummary> {
    let verified = verify_bundle(raw)?;
    let trust = load_trust(fragments_dir);
    let manifest = &verified.manifest;

    // Exact-collision guard against the TS-side builtin registry.
    for op in &manifest.operations {
        if reserved_names.iter().any(|reserved| reserved == &op.name) {
            return Err(fail(
                FragmentErrorKind::VerifyFailed,
                format!("Operation \"{}\" collides with a builtin part", op.name),
            ));
        }
    }

    let publisher_status = match trust.publishers.get(&manifest.publisher) {
        None => "new",
        Some(pin) if pin.fingerprint == verified.fingerprint => "known",
        Some(_) => "keyMismatch",
    };
    if let Some(claim) = trust.namespaces.get(&manifest.namespace) {
        if claim.publisher != manifest.publisher {
            return Err(fail(
                FragmentErrorKind::TrustViolation,
                format!(
                    "Namespace \"{}\" already belongs to publisher \"{}\"",
                    manifest.namespace, claim.publisher
                ),
            ));
        }
    }
    let is_downgrade = trust
        .installed
        .get(&manifest.id)
        .map(|pin| semver_downgrade(&manifest.version, &pin.version))
        .unwrap_or(false);

    // Compiling here both validates the ABI up front and warms nothing: the
    // staged module is dropped; the session cache fills on first execution.
    state.compile(&verified.wasm)?;

    let token = format!(
        "stage-{}-{}",
        verified.bundle_sha256.chars().take(12).collect::<String>(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or_default()
    );
    let summary = StageSummary {
        staging_token: token.clone(),
        id: manifest.id.clone(),
        name: manifest.name.clone(),
        version: manifest.version.clone(),
        publisher: manifest.publisher.clone(),
        description: manifest.description.clone(),
        namespace: manifest.namespace.clone(),
        operations: manifest
            .operations
            .iter()
            .map(|op| serde_json::json!({ "name": op.name, "description": op.description }))
            .collect(),
        fingerprint: verified.fingerprint.clone(),
        fingerprint_grouped: fingerprint_grouped(&verified.publisher_key),
        publisher_status: publisher_status.to_string(),
        is_downgrade,
    };
    state.staged.lock().unwrap().insert(
        token,
        StagedBundle { verified, publisher_status: publisher_status.to_string(), is_downgrade },
    );
    Ok(summary)
}

pub fn commit_core(
    state: &FragmentsState,
    fragments_dir: &Path,
    staging_token: &str,
    expected_fingerprint: &str,
    force_downgrade: bool,
) -> FragmentResult<Manifest> {
    let staged = state
        .staged
        .lock()
        .unwrap()
        .remove(staging_token)
        .ok_or_else(|| fail(FragmentErrorKind::VerifyFailed, "Install session expired; pick the file again"))?;

    if staged.verified.fingerprint != expected_fingerprint {
        return Err(fail(
            FragmentErrorKind::TrustViolation,
            "The bundle changed since it was reviewed",
        ));
    }
    if staged.publisher_status == "keyMismatch" {
        return Err(fail(
            FragmentErrorKind::TrustViolation,
            "This publisher is pinned to a different key; replace the key explicitly first",
        ));
    }
    if staged.is_downgrade && !force_downgrade {
        return Err(fail(
            FragmentErrorKind::TrustViolation,
            "This would downgrade an installed part; confirm the downgrade to proceed",
        ));
    }

    let manifest = staged.verified.manifest.clone();
    let mut trust = load_trust(fragments_dir);
    let now = chrono::Utc::now().to_rfc3339();

    trust.publishers.entry(manifest.publisher.clone()).or_insert_with(|| PublisherPin {
        key: BASE64.encode(staged.verified.publisher_key),
        fingerprint: staged.verified.fingerprint.clone(),
        first_seen: now.clone(),
    });
    trust.namespaces.entry(manifest.namespace.clone()).or_insert_with(|| NamespaceClaim {
        publisher: manifest.publisher.clone(),
        fragment_id: manifest.id.clone(),
    });
    trust.installed.insert(
        manifest.id.clone(),
        InstalledPin {
            publisher: manifest.publisher.clone(),
            version: manifest.version.clone(),
            bundle_sha256: staged.verified.bundle_sha256.clone(),
            installed_at: now,
        },
    );

    std::fs::create_dir_all(fragments_dir)
        .map_err(|e| fail(FragmentErrorKind::Io, e.to_string()))?;
    let path = fragments_dir.join(format!("{}.derpart", manifest.id));
    std::fs::write(&path, &staged.verified.raw)
        .map_err(|e| fail(FragmentErrorKind::Io, e.to_string()))?;
    save_trust(fragments_dir, &trust)?;

    state.evict(&manifest.id);
    Ok(manifest)
}

pub fn remove_core(state: &FragmentsState, fragments_dir: &Path, id: &str) -> FragmentResult<()> {
    if !id_ok(id) {
        return Err(fail(FragmentErrorKind::NotInstalled, "Invalid part id"));
    }
    let path = fragments_dir.join(format!("{}.derpart", id));
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| fail(FragmentErrorKind::Io, e.to_string()))?;
    }
    let mut trust = load_trust(fragments_dir);
    // Publisher pins and namespace claims survive removal by design.
    trust.installed.remove(id);
    save_trust(fragments_dir, &trust)?;
    state.evict(id);
    Ok(())
}

pub fn list_core(fragments_dir: &Path) -> Vec<Value> {
    let mut parts = Vec::new();
    let Ok(entries) = std::fs::read_dir(fragments_dir) else {
        return parts;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().map(|ext| ext == "derpart").unwrap_or(false) {
            if let Ok(raw) = std::fs::read(&path) {
                if let Ok(verified) = verify_bundle(&raw) {
                    let stem_matches = path
                        .file_stem()
                        .and_then(|stem| stem.to_str())
                        .map(|stem| stem == verified.manifest.id)
                        .unwrap_or(false);
                    if stem_matches {
                        parts.push(serde_json::json!({
                            "manifest": verified.manifest,
                            "fingerprint": verified.fingerprint,
                            "fingerprintGrouped": fingerprint_grouped(&verified.publisher_key),
                        }));
                    }
                }
            }
        }
    }
    parts
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

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

#[tauri::command]
pub async fn stage_fragment(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, FragmentsState>,
    bundle_b64: String,
    reserved_names: Vec<String>,
) -> Result<StageSummary, FragmentError> {
    require_main_window(&window)?;
    let dir = fragments_dir(&app)?;
    let raw = BASE64
        .decode(&bundle_b64)
        .map_err(|_| fail(FragmentErrorKind::VerifyFailed, "The picked file is not readable"))?;
    stage_core(&state, &dir, &raw, &reserved_names)
}

#[tauri::command]
pub async fn commit_fragment(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, FragmentsState>,
    staging_token: String,
    expected_fingerprint: String,
    force_downgrade: Option<bool>,
) -> Result<Manifest, FragmentError> {
    require_main_window(&window)?;
    let dir = fragments_dir(&app)?;
    commit_core(&state, &dir, &staging_token, &expected_fingerprint, force_downgrade.unwrap_or(false))
}

#[tauri::command]
pub async fn remove_fragment(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, FragmentsState>,
    fragment_id: String,
) -> Result<(), FragmentError> {
    require_main_window(&window)?;
    let dir = fragments_dir(&app)?;
    remove_core(&state, &dir, &fragment_id)
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
    let dir = fragments_dir(&app)?;
    let mut trust = load_trust(&dir);
    let pin = trust
        .publishers
        .get_mut(&publisher)
        .ok_or_else(|| fail(FragmentErrorKind::NotInstalled, "Unknown publisher"))?;
    if pin.fingerprint != old_fingerprint {
        return Err(fail(FragmentErrorKind::TrustViolation, "Current key does not match"));
    }
    let key_bytes: [u8; 32] = BASE64
        .decode(&new_key_b64)
        .ok()
        .and_then(|k| k.try_into().ok())
        .ok_or_else(|| fail(FragmentErrorKind::VerifyFailed, "New key must be 32 bytes"))?;
    if fingerprint_hex(&key_bytes) != new_fingerprint {
        return Err(fail(FragmentErrorKind::VerifyFailed, "New key does not match its fingerprint"));
    }
    pin.key = new_key_b64;
    pin.fingerprint = new_fingerprint;
    save_trust(&dir, &trust)
}

#[tauri::command]
pub async fn list_fragments(app: tauri::AppHandle) -> Result<Vec<Value>, FragmentError> {
    Ok(list_core(&fragments_dir(&app)?))
}

#[tauri::command]
pub async fn execute_fragment(
    app: tauri::AppHandle,
    state: tauri::State<'_, FragmentsState>,
    fragment_id: String,
    operation: String,
    inputs: Value,
) -> Result<FragmentExecResult, FragmentError> {
    let started = std::time::Instant::now();
    let dir = fragments_dir(&app)?;

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

    let engine = state.engine.clone();
    let loaded = state.load(&dir, &fragment_id);
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let loaded = loaded?;
        execute_in_module(&engine, &loaded, &operation, &inputs)
    })
    .await
    .map_err(|e| fail(FragmentErrorKind::Io, format!("Execution task failed: {}", e)))?;

    let execution_time_ms = started.elapsed().as_millis() as u64;
    Ok(match result {
        Ok(data) => FragmentExecResult { success: true, data: Some(data), error: None, execution_time_ms },
        Err(error) => FragmentExecResult { success: false, data: None, error: Some(error), execution_time_ms },
    })
}
