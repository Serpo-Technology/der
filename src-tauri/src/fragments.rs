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
const MAX_INPUT_BYTES_LARGE: usize = 32 << 20;
const MEM_LIMIT_BYTES_LARGE: usize = 512 << 20;
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
    #[serde(default)]
    pub operations: Vec<OpSpec>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ui_fragments: Vec<UiFragmentSpec>,
    /// Present on recipe parts: full experiences shipped as declarative
    /// contracts, instantiated instead of generated.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub recipes: Vec<RecipeSpec>,
    /// Present on integration parts: the service the part talks to and the
    /// credentials the user must provide at install time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service: Option<ServiceSpec>,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ServiceSpec {
    /// Origin/prefix every remote endpoint of this part is confined to.
    pub base_url: String,
    #[serde(default)]
    pub credentials: Vec<CredentialRequirement>,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CredentialRequirement {
    pub name: String,
    /// "bearer" | "header" | "query"
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    pub label: String,
}

/// A composed UI pattern: a template subtree instantiated by the renderer
/// with per-use parameters. Pure JSON; carries no code. A fragment that also
/// ships `operations` is a partial-experience pack: the operation templates
/// instantiate per use with the same `{{id}}` scoping as template ids, so a
/// dropped-in pattern works with no outer wiring. Pack operations compose
/// the installed vocabulary by name only; they may not carry an
/// implementation (remote power stays in integration parts).
#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UiFragmentSpec {
    pub name: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub howto: Option<String>,
    #[serde(default)]
    pub params: Vec<UiParamSpec>,
    pub template: Value,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub operations: Vec<Value>,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UiParamSpec {
    pub name: String,
    #[serde(rename = "type")]
    pub param_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// A full experience shipped as data: a behaviorally proven contract in the
/// model's output vocabulary. The app validates it against the installed part
/// manifests and instantiates it without a model call. Pure JSON; no code.
#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecipeSpec {
    pub name: String,
    pub title: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub keywords: Vec<String>,
    /// Spec header captured when the contract was proven (goal, assumptions,
    /// open questions).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spec: Option<Value>,
    pub contract: Value,
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
    /// Declarative HTTP call for integration parts; executed by the host,
    /// confined to the manifest's service base URL.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote: Option<RemoteSpec>,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSpec {
    /// Path joined to the service base URL; {input} placeholders substitute.
    pub endpoint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    /// Query parameters; values may hold {input} placeholders.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<std::collections::BTreeMap<String, String>>,
    /// Output name -> dot path into the JSON response (array indices as
    /// numerals). Missing paths yield null.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<std::collections::BTreeMap<String, String>>,
    /// POST body fields; values may hold {input} placeholders. Sent as a
    /// JSON object.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<std::collections::BTreeMap<String, String>>,
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

// Segments start lowercase and may continue in camelCase, matching the
// builtin vocabulary (list.updateWhere, date.diffDays).
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
                    .all(|b| b.is_ascii_alphanumeric() || *b == b'_')
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
    let allowed_capability = manifest
        .service
        .as_ref()
        .map(|service| format!("net:{}", service.base_url));
    for capability in &manifest.capabilities {
        let io_large = capability == "io:large" && !manifest.wasm_sha256.is_empty();
        if !io_large && Some(capability) != allowed_capability.as_ref() {
            return Err(fail(
                FragmentErrorKind::VerifyFailed,
                format!(
                    "Capability \"{}\" is not allowed; integration parts may declare exactly net:<service base URL>, and compute parts io:large",
                    capability
                ),
            ));
        }
    }
    if let Some(service) = &manifest.service {
        if !service.base_url.starts_with("https://") {
            return Err(fail(
                FragmentErrorKind::VerifyFailed,
                "Service base URL must be https",
            ));
        }
        if !manifest.capabilities.iter().any(|c| Some(c) == allowed_capability.as_ref()) {
            return Err(fail(
                FragmentErrorKind::VerifyFailed,
                "Integration parts must declare the net:<service base URL> capability",
            ));
        }
        for requirement in &service.credentials {
            if !matches!(requirement.kind.as_str(), "bearer" | "header" | "query") {
                return Err(fail(
                    FragmentErrorKind::VerifyFailed,
                    format!("Credential \"{}\" has unknown kind", requirement.name),
                ));
            }
        }
    }
    let has_remote_ops = manifest.operations.iter().any(|op| op.remote.is_some());
    let has_wasm_ops = manifest.operations.iter().any(|op| op.remote.is_none());
    if has_remote_ops {
        if manifest.service.is_none() {
            return Err(fail(
                FragmentErrorKind::VerifyFailed,
                "Remote operations need a service block",
            ));
        }
        if has_wasm_ops {
            return Err(fail(
                FragmentErrorKind::VerifyFailed,
                "A part mixes remote and compute operations; split it",
            ));
        }
        for op in &manifest.operations {
            let remote = op.remote.as_ref().unwrap();
            if !remote.endpoint.starts_with('/') || remote.endpoint.contains("..") {
                return Err(fail(
                    FragmentErrorKind::VerifyFailed,
                    format!("Operation \"{}\" endpoint must be a relative path without ..", op.name),
                ));
            }
        }
    }
    if !manifest.recipes.is_empty()
        && (!manifest.operations.is_empty()
            || !manifest.ui_fragments.is_empty()
            || manifest.service.is_some())
    {
        return Err(fail(
            FragmentErrorKind::VerifyFailed,
            "A recipe part ships only recipes; publish operations and UI fragments as their own parts",
        ));
    }
    if manifest.operations.is_empty()
        && manifest.ui_fragments.is_empty()
        && manifest.recipes.is_empty()
    {
        return Err(fail(
            FragmentErrorKind::VerifyFailed,
            "Part must declare operations, UI fragments, or recipes",
        ));
    }
    if manifest.operations.len() > MAX_OPERATIONS
        || manifest.ui_fragments.len() > MAX_OPERATIONS
        || manifest.recipes.len() > MAX_OPERATIONS
    {
        return Err(fail(FragmentErrorKind::VerifyFailed, "Part declares too many entries"));
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
    for fragment in &manifest.ui_fragments {
        if !op_name_ok(&fragment.name, &manifest.namespace) {
            return Err(fail(
                FragmentErrorKind::VerifyFailed,
                format!(
                    "UI fragment \"{}\" must live under namespace \"{}.\"",
                    fragment.name, manifest.namespace
                ),
            ));
        }
        if !seen.insert(fragment.name.clone()) {
            return Err(fail(
                FragmentErrorKind::VerifyFailed,
                format!("Duplicate name \"{}\"", fragment.name),
            ));
        }
        if !fragment.template.is_object() {
            return Err(fail(
                FragmentErrorKind::VerifyFailed,
                format!("UI fragment \"{}\" template must be an object", fragment.name),
            ));
        }
        if fragment.operations.len() > MAX_OPERATIONS {
            return Err(fail(
                FragmentErrorKind::VerifyFailed,
                format!("UI fragment \"{}\" declares too many operations", fragment.name),
            ));
        }
        for op in &fragment.operations {
            let id = op.get("id").and_then(Value::as_str).unwrap_or_default();
            let op_name = op
                .get("operationName")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !id.starts_with("{{id}}") || op_name.is_empty() {
                return Err(fail(
                    FragmentErrorKind::VerifyFailed,
                    format!(
                        "UI fragment \"{}\" operations need an id starting with {{{{id}}}} and an operationName",
                        fragment.name
                    ),
                ));
            }
            if op.get("implementation").is_some() {
                return Err(fail(
                    FragmentErrorKind::VerifyFailed,
                    format!(
                        "UI fragment \"{}\" operations compose installed operations by name; an implementation is not allowed",
                        fragment.name
                    ),
                ));
            }
        }
    }
    for recipe in &manifest.recipes {
        if !op_name_ok(&recipe.name, &manifest.namespace) {
            return Err(fail(
                FragmentErrorKind::VerifyFailed,
                format!(
                    "Recipe \"{}\" must live under namespace \"{}.\"",
                    recipe.name, manifest.namespace
                ),
            ));
        }
        if !seen.insert(recipe.name.clone()) {
            return Err(fail(
                FragmentErrorKind::VerifyFailed,
                format!("Duplicate name \"{}\"", recipe.name),
            ));
        }
        if recipe.title.trim().is_empty() || recipe.description.trim().is_empty() {
            return Err(fail(
                FragmentErrorKind::VerifyFailed,
                format!("Recipe \"{}\" needs a title and description", recipe.name),
            ));
        }
        let element_count = recipe
            .contract
            .get("elements")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0);
        if !recipe.contract.is_object() || element_count == 0 {
            return Err(fail(
                FragmentErrorKind::VerifyFailed,
                format!(
                    "Recipe \"{}\" contract must be an object with an elements array",
                    recipe.name
                ),
            ));
        }
    }

    if manifest.operations.is_empty() || has_remote_ops {
        if !wasm.is_empty() || !manifest.wasm_sha256.is_empty() {
            return Err(fail(
                FragmentErrorKind::VerifyFailed,
                "Only compute parts carry a wasm module",
            ));
        }
    } else {
        let wasm_hash = hex_lower(&Sha256::digest(&wasm));
        if wasm_hash != manifest.wasm_sha256.to_lowercase() {
            return Err(fail(FragmentErrorKind::VerifyFailed, "Module hash does not match the manifest"));
        }
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
    mem_limit: usize,
}

impl wasmtime::ResourceLimiter for StoreData {
    fn memory_growing(
        &mut self,
        _current: usize,
        desired: usize,
        _maximum: Option<usize>,
    ) -> wasmtime::Result<bool> {
        if desired > self.mem_limit {
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
    bundle_sha256: String,
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

    /// Loads (verify + compile) an installed fragment. The cache is keyed by
    /// the bundle bytes on disk, so an updated file swaps the compiled guest
    /// on the next call even when the update bypassed the install command.
    pub fn load(&self, dir: &Path, id: &str) -> FragmentResult<Arc<LoadedFragment>> {
        if !id_ok(id) {
            return Err(fail(FragmentErrorKind::NotInstalled, "Invalid part id"));
        }
        let path = dir.join(format!("{}.derpart", id));
        let raw = std::fs::read(&path)
            .map_err(|_| fail(FragmentErrorKind::NotInstalled, format!("Part {} is not installed", id)))?;
        let digest = hex_lower(&Sha256::digest(&raw));
        if let Some(found) = self.loaded.lock().unwrap().get(id) {
            if found.bundle_sha256 == digest {
                return Ok(found.clone());
            }
        }
        let verified = verify_bundle(&raw)?;
        if verified.manifest.id != id {
            return Err(fail(FragmentErrorKind::VerifyFailed, "Bundle id does not match its filename"));
        }
        if verified.wasm.is_empty() {
            return Err(fail(
                FragmentErrorKind::OperationNotFound,
                "Part has no compute module; its operations run elsewhere",
            ));
        }
        let module = self.compile(&verified.wasm)?;
        let loaded = Arc::new(LoadedFragment {
            manifest: verified.manifest,
            module,
            bundle_sha256: digest,
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
    // Parts that declared io:large at install (and were consented to in the
    // review) get media-sized budgets; everything else keeps the tight ones.
    let large_io = loaded
        .manifest
        .capabilities
        .iter()
        .any(|capability| capability == "io:large");
    let (input_cap, input_cap_text, mem_limit, fuel) = if large_io {
        (MAX_INPUT_BYTES_LARGE, "32 MiB", MEM_LIMIT_BYTES_LARGE, FUEL_BUDGET * 10)
    } else {
        (MAX_INPUT_BYTES, "1 MiB", MEM_LIMIT_BYTES, FUEL_BUDGET)
    };
    if request.len() > input_cap {
        return Err(fail(
            FragmentErrorKind::InputTooLarge,
            format!("Operation inputs exceed {}", input_cap_text),
        ));
    }

    let mut store = Store::new(engine, StoreData { grow_denied: false, mem_limit });
    store.limiter(|data| data);
    store
        .set_fuel(fuel)
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
    pub recipes: Vec<Value>,
    pub capabilities: Vec<String>,
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
    // UI-only and integration bundles carry no module to compile.
    if !verified.wasm.is_empty() {
        state.compile(&verified.wasm)?;
    }

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
        recipes: manifest
            .recipes
            .iter()
            .map(|recipe| {
                serde_json::json!({
                    "name": recipe.name,
                    "title": recipe.title,
                    "description": recipe.description,
                })
            })
            .collect(),
        capabilities: manifest.capabilities.clone(),
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
    let integrations = crate::settings::load_integrations(&app);
    let data = execute_part_remote_core(&dir, &integrations, &fragment_id, &operation, &inputs).await?;
    Ok(FragmentExecResult {
        success: true,
        data: Some(data),
        error: None,
        execution_time_ms: started.elapsed().as_millis() as u64,
    })
}

/// The integration-part HTTP path, shared by the command above and the
/// runtime session dispatcher: signed service confinement, projection, and
/// part-scoped credential injection all live here.
pub async fn execute_part_remote_core(
    dir: &Path,
    integrations: &crate::settings::StoredIntegrations,
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
    if !url.starts_with(&service.base_url) {
        return Err(fail(FragmentErrorKind::Io, "Endpoint escaped the service"));
    }

    // Redirects must stay inside the service: a credential in the query
    // string would otherwise travel to wherever the service points.
    let base_for_redirect = service.base_url.clone();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.url().as_str().starts_with(&base_for_redirect) {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .build()
        .map_err(|e| fail(FragmentErrorKind::Io, format!("HTTP client: {}", e)))?;
    let method = remote.method.clone().unwrap_or_else(|| "GET".to_string()).to_uppercase();
    let mut request = match method.as_str() {
        "GET" => client.get(&url),
        "POST" => client.post(&url),
        other => {
            return Err(fail(FragmentErrorKind::Io, format!("Unsupported method {}", other)))
        }
    };
    if let Some(query) = &remote.query {
        let pairs: Vec<(String, String)> = query
            .iter()
            .map(|(key, template)| (key.clone(), substitute_placeholders(template, input_map)))
            .collect();
        request = request.query(&pairs);
    }
    if let Some(body) = &remote.body {
        if method != "POST" {
            return Err(fail(FragmentErrorKind::Io, "A body needs the POST method"));
        }
        let mut object = serde_json::Map::new();
        for (key, template) in body {
            object.insert(
                key.clone(),
                Value::String(substitute_placeholders(template, input_map)),
            );
        }
        request = request.json(&Value::Object(object));
    }

    // Part-scoped secrets, stored as part:<id>:<credential name>.
    for requirement in &service.credentials {
        let store_key = format!("part:{}:{}", fragment_id, requirement.name);
        let secret = integrations
            .credentials
            .get(&store_key)
            .map(|cred| cred.secret.clone())
            .ok_or_else(|| {
                fail(
                    FragmentErrorKind::Io,
                    format!(
                        "This part needs its \"{}\" credential; add it in the Parts view",
                        requirement.label
                    ),
                )
            })?;
        match requirement.kind.as_str() {
            "bearer" => request = request.header("authorization", format!("Bearer {}", secret)),
            "header" => {
                let target = requirement.target.clone().unwrap_or_else(|| "x-api-key".to_string());
                request = request.header(target, secret);
            }
            "query" => {
                let target = requirement.target.clone().unwrap_or_else(|| "key".to_string());
                request = request.query(&[(target, secret)]);
            }
            _ => {}
        }
    }

    let response = request
        .send()
        .await
        .map_err(|e| fail(FragmentErrorKind::Io, format!("Request failed: {}", e)))?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|e| fail(FragmentErrorKind::Io, format!("Response was not JSON: {}", e)))?;
    if !status.is_success() {
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

#[tauri::command]
pub fn set_part_credential(
    app: tauri::AppHandle,
    fragment_id: String,
    name: String,
    secret: String,
) -> Result<Vec<String>, FragmentError> {
    if secret.trim().is_empty() {
        return Err(fail(FragmentErrorKind::Io, "The secret cannot be empty"));
    }
    let mut integrations = crate::settings::load_integrations(&app);
    integrations.credentials.insert(
        format!("part:{}:{}", fragment_id, name),
        crate::settings::IntegrationCredential {
            kind: "partsecret".to_string(),
            target: None,
            base_url: None,
            notes: None,
            secret,
        },
    );
    crate::settings::save_integrations(&app, &integrations)
        .map_err(|e| fail(FragmentErrorKind::Io, e))?;
    Ok(list_part_credentials_core(&app, &fragment_id))
}

fn list_part_credentials_core(app: &tauri::AppHandle, fragment_id: &str) -> Vec<String> {
    let prefix = format!("part:{}:", fragment_id);
    let mut names: Vec<String> = crate::settings::load_integrations(app)
        .credentials
        .keys()
        .filter(|key| key.starts_with(&prefix))
        .map(|key| key[prefix.len()..].to_string())
        .collect();
    names.sort();
    names
}

#[tauri::command]
pub fn list_part_credentials(app: tauri::AppHandle, fragment_id: String) -> Vec<String> {
    list_part_credentials_core(&app, &fragment_id)
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
    fn op_names_allow_camel_case_segments() {
        assert!(super::op_name_ok("date.diffDays", "date"));
        assert!(super::op_name_ok("list.update_where", "list"));
        assert!(super::op_name_ok("fx.rate", "fx"));
        assert!(!super::op_name_ok("date.DiffDays", "date"), "leading uppercase");
        assert!(!super::op_name_ok("other.diffDays", "date"), "outside namespace");
        assert!(!super::op_name_ok("date", "date"), "no segment");
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
