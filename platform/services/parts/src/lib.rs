//! Signed Wasm operation parts: verification, trust pinning, and a hardened
//! wasmtime host. `service` runs the host as a process of its own, the part
//! runner, so guest code never executes in the process that holds the
//! app's windows, files, and stores. The crate has no dependency on the
//! desktop shell.
//!
//! A part ships as a single `.derpart` JSON bundle whose manifest bytes are
//! stored verbatim and signed (Ed25519 over `DERPART-SIG-V1\0 || manifest`).
//! The manifest binds the module by sha256. Guests implement a minimal ABI
//! (`memory`, `der_alloc`, `der_run`) with an empty import section, which is
//! the capability guarantee: a v1 part can compute and nothing else. Fuel,
//! an epoch deadline, a memory limiter, and per-call instances bound what a
//! hostile module can cost.

pub mod service;

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
use wasmtime::{Config, Engine, Linker, Module, Store};
use wasmtime_wasi::p1::{self as wasi_p1, WasiP1Ctx};
use wasmtime_wasi::WasiCtxBuilder;

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
/// Parts doing real file or stream work get half a minute instead.
const EPOCH_DEADLINE_TICKS_HEAVY: u64 = 300;
const MAX_GUEST_ERR_BYTES: usize = 1024;

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
    /// Job-scoped execution: "start" builds a live instance and answers a
    /// job token; "step" runs against that instance until a step reports
    /// done. Long work makes progress across many short steps instead of
    /// one long call.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job: Option<String>,
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

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
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

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct FragmentError {
    pub kind: FragmentErrorKind,
    pub message: String,
}

impl FragmentError {
    pub fn new(kind: FragmentErrorKind, message: impl Into<String>) -> Self {
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

pub fn id_ok(id: &str) -> bool {
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
        let compute = !manifest.wasm_sha256.is_empty();
        let known_compute = compute
            && (capability == "io:large" || capability_imports(capability).is_some());
        if !known_compute && Some(capability) != allowed_capability.as_ref() {
            return Err(fail(
                FragmentErrorKind::VerifyFailed,
                format!(
                    "Capability \"{}\" is not allowed; integration parts may declare exactly net:<service base URL>, and compute parts io:large, wasi:clocks, wasi:random, wasi:files, or net:<host>:<port>",
                    capability
                ),
            ));
        }
    }
    for op in &manifest.operations {
        match op.job.as_deref() {
            None => {}
            Some("start") => {
                if manifest.wasm_sha256.is_empty() {
                    return Err(fail(
                        FragmentErrorKind::VerifyFailed,
                        format!("Operation \"{}\" declares a job but the part has no compute module", op.name),
                    ));
                }
            }
            Some("step") => {
                if !op.inputs.iter().any(|input| input.io_type == "job") {
                    return Err(fail(
                        FragmentErrorKind::VerifyFailed,
                        format!("Step operation \"{}\" needs an input of type \"job\"", op.name),
                    ));
                }
            }
            Some(other) => {
                return Err(fail(
                    FragmentErrorKind::VerifyFailed,
                    format!("Operation \"{}\" declares job \"{}\"; only \"start\" and \"step\" exist", op.name, other),
                ));
            }
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

/// The WASI imports each capability grants, over `wasi_snapshot_preview1`.
/// The verifier is the gate: a module may import exactly what its declared
/// (and install-consented) capabilities cover, and nothing else. Declaring
/// any `wasi:*` capability also grants the base set below, because every
/// wasi-libc build links runtime plumbing regardless of what it uses.
const WASI_MODULE: &str = "wasi_snapshot_preview1";

const WASI_BASE_IMPORTS: &[&str] = &[
    "proc_exit",
    "environ_get",
    "environ_sizes_get",
    "args_get",
    "args_sizes_get",
    "sched_yield",
    "poll_oneoff",
    "fd_write",
    "fd_close",
    "fd_fdstat_get",
    "fd_seek",
    "fd_prestat_get",
    "fd_prestat_dir_name",
];

/// Filesystem imports live behind wasi:files. The real boundary is the
/// per-call sandbox (a /in staging dir holding exactly the granted files
/// and a fresh /out); within it the grant is generous, matching what
/// wasi-libc emits for ordinary file work.
const WASI_FILES_IMPORTS: &[&str] = &[
    "path_open",
    "fd_read",
    "fd_pread",
    "fd_pwrite",
    "fd_tell",
    "fd_sync",
    "fd_datasync",
    "fd_advise",
    "fd_allocate",
    "fd_readdir",
    "fd_filestat_get",
    "fd_filestat_set_size",
    "fd_filestat_set_times",
    "fd_fdstat_set_flags",
    "path_filestat_get",
    "path_filestat_set_times",
    "path_create_directory",
    "path_remove_directory",
    "path_unlink_file",
    "path_rename",
];

/// A compute-part net capability: `net:<host>:<port>`, one declared
/// endpoint the host connects for the call and bridges to the guest's
/// stdio. Distinguished from the integration form by having no scheme.
fn parse_compute_net(capability: &str) -> Option<(String, u16)> {
    let rest = capability.strip_prefix("net:")?;
    if rest.contains("://") {
        return None;
    }
    let (host, port) = rest.rsplit_once(':')?;
    if host.is_empty() {
        return None;
    }
    port.parse::<u16>().ok().map(|port| (host.to_string(), port))
}

fn capability_imports(capability: &str) -> Option<&'static [&'static str]> {
    match capability {
        "wasi:clocks" => Some(&["clock_time_get", "clock_res_get"]),
        "wasi:random" => Some(&["random_get"]),
        "wasi:files" => Some(WASI_FILES_IMPORTS),
        _ => {
            // The stream bridge needs reads; writes are already in base.
            parse_compute_net(capability).map(|_| &["fd_read"] as &'static [&'static str])
        }
    }
}

/// The capability that would grant an import, for refusal messages.
fn granting_capability(name: &str) -> Option<&'static str> {
    for capability in ["wasi:clocks", "wasi:random", "wasi:files"] {
        if capability_imports(capability).is_some_and(|list| list.contains(&name)) {
            return Some(capability);
        }
    }
    if name == "fd_read" {
        return Some("wasi:files");
    }
    None
}

/// Checks the module implements the part ABI and that every import is
/// covered by the manifest's declared capabilities. No declarations means
/// no imports: the pure-compute default every part had under v1.
fn check_abi(module: &Module, capabilities: &[String]) -> FragmentResult<()> {
    let wasi_declared = capabilities.iter().any(|c| c.starts_with("wasi:"));
    let mut allowed: Vec<&str> = Vec::new();
    if wasi_declared {
        allowed.extend_from_slice(WASI_BASE_IMPORTS);
        for capability in capabilities {
            if let Some(imports) = capability_imports(capability) {
                allowed.extend_from_slice(imports);
            }
        }
    }
    for import in module.imports() {
        let covered = import.module() == WASI_MODULE && allowed.contains(&import.name());
        if covered {
            continue;
        }
        let hint = if import.module() == WASI_MODULE {
            match granting_capability(import.name()) {
                Some(capability) => format!("; declaring the {} capability grants it", capability),
                None => "; no capability grants it".to_string(),
            }
        } else {
            "; parts import WASI only".to_string()
        };
        return Err(fail(
            FragmentErrorKind::AbiMismatch,
            format!(
                "Part imports {}::{}, which its declared capabilities do not cover{}",
                import.module(),
                import.name(),
                hint
            ),
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

/// How the executor reaches the file grant system: the caller resolves
/// grant tokens to real paths and takes produced files into app-owned
/// storage. Tests hand in fakes; hosts without a file layer use `none`.
pub struct ExecEnv<'a> {
    pub resolve_grant: &'a dyn Fn(&str) -> Option<PathBuf>,
    pub register_output: &'a dyn Fn(&Path) -> Result<Value, String>,
}

impl ExecEnv<'_> {
    pub fn none() -> ExecEnv<'static> {
        ExecEnv {
            resolve_grant: &|_token| None,
            register_output: &|_path| Err("This host has no file layer".to_string()),
        }
    }
}

/// The per-call filesystem sandbox behind wasi:files: /in holds exactly the
/// granted input files (hardlinked when possible), /out starts empty and is
/// harvested after the call. Dropped with the call, so nothing lingers.
struct FileSandbox {
    root: PathBuf,
}

impl FileSandbox {
    fn create() -> FragmentResult<Self> {
        let root = std::env::temp_dir().join(format!("der-exec-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("in"))
            .and_then(|_| std::fs::create_dir_all(root.join("out")))
            .map_err(|e| fail(FragmentErrorKind::Io, format!("Sandbox setup failed: {}", e)))?;
        Ok(Self { root })
    }

    /// Stages one granted file and answers its guest path.
    fn stage_input(&self, source: &Path) -> FragmentResult<String> {
        let name = source
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "input".to_string());
        let target = self.root.join("in").join(&name);
        if std::fs::hard_link(source, &target).is_err() {
            std::fs::copy(source, &target).map_err(|e| {
                fail(FragmentErrorKind::Io, format!("Could not stage the file: {}", e))
            })?;
        }
        Ok(format!("/in/{}", name))
    }

    /// A produced guest path back on the host side, confined to /out.
    fn produced(&self, guest_path: &str) -> Option<PathBuf> {
        let rel = guest_path.strip_prefix("/out/")?;
        if rel.is_empty() || rel.contains("..") {
            return None;
        }
        let real = self.root.join("out").join(rel);
        real.is_file().then_some(real)
    }
}

impl Drop for FileSandbox {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// One half of a host-connected stream bridged into the guest's stdio
/// under a net:<host>:<port> capability. The trait wants repeatable
/// streams; a socket has one, so the first taker gets it and later takers
/// see an ended stream.
struct BridgedIn(Mutex<Option<Box<dyn tokio::io::AsyncRead + Send + Sync + Unpin>>>);
struct BridgedOut(Mutex<Option<Box<dyn tokio::io::AsyncWrite + Send + Sync + Unpin>>>);

impl wasmtime_wasi::cli::IsTerminal for BridgedIn {
    fn is_terminal(&self) -> bool {
        false
    }
}
impl wasmtime_wasi::cli::IsTerminal for BridgedOut {
    fn is_terminal(&self) -> bool {
        false
    }
}

impl wasmtime_wasi::cli::StdinStream for BridgedIn {
    fn async_stream(&self) -> Box<dyn tokio::io::AsyncRead + Send + Sync> {
        match self.0.lock().unwrap().take() {
            Some(stream) => stream,
            None => Box::new(tokio::io::empty()),
        }
    }
}

impl wasmtime_wasi::cli::StdoutStream for BridgedOut {
    fn async_stream(&self) -> Box<dyn tokio::io::AsyncWrite + Send + Sync> {
        match self.0.lock().unwrap().take() {
            Some(stream) => stream,
            None => Box::new(tokio::io::sink()),
        }
    }
}

/// The TLS setup for a part's socket to a remote host. The crypto provider
/// is named here because rustls cannot choose one by itself in a build that
/// links more than one, and it panics when asked to.
fn socket_tls_config() -> Result<tokio_rustls::rustls::ClientConfig, String> {
    let roots = tokio_rustls::rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    let config = tokio_rustls::rustls::ClientConfig::builder_with_provider(Arc::new(
        tokio_rustls::rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|e| format!("TLS setup failed: {}", e))?
    .with_root_certificates(roots)
    .with_no_client_auth();
    Ok(config)
}

/// Connects the declared endpoint for a net-capable call: TLS for remote
/// hosts, plain TCP on loopback (local services rarely speak TLS and local
/// trust is different). The stream's halves become the guest's stdio.
fn connect_bridge(host: &str, port: u16) -> FragmentResult<(BridgedIn, BridgedOut)> {
    use tokio::io::split;
    use tokio::net::TcpStream;

    let is_loopback = matches!(host, "localhost" | "127.0.0.1" | "::1");
    let target = format!("{}:{}", host, port);
    let connect = async {
        let tcp = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            TcpStream::connect(&target),
        )
        .await
        .map_err(|_| format!("Connecting to {} timed out", target))?
        .map_err(|e| format!("Could not connect to {}: {}", target, e))?;
        if is_loopback {
            let (read, write) = split(tcp);
            let read: Box<dyn tokio::io::AsyncRead + Send + Sync + Unpin> = Box::new(read);
            let write: Box<dyn tokio::io::AsyncWrite + Send + Sync + Unpin> = Box::new(write);
            return Ok::<_, String>((read, write));
        }
        let config = socket_tls_config()?;
        let server_name = tokio_rustls::rustls::pki_types::ServerName::try_from(host.to_string())
            .map_err(|_| format!("{} is not a valid TLS host name", host))?;
        let tls = tokio_rustls::TlsConnector::from(Arc::new(config))
            .connect(server_name, tcp)
            .await
            .map_err(|e| format!("TLS to {} failed: {}", target, e))?;
        let (read, write) = split(tls);
        let read: Box<dyn tokio::io::AsyncRead + Send + Sync + Unpin> = Box::new(read);
        let write: Box<dyn tokio::io::AsyncWrite + Send + Sync + Unpin> = Box::new(write);
        Ok((read, write))
    };
    let (read, write) = wasmtime_wasi::runtime::in_tokio(connect)
        .map_err(|message| fail(FragmentErrorKind::Io, message))?;
    Ok((
        BridgedIn(Mutex::new(Some(read))),
        BridgedOut(Mutex::new(Some(write))),
    ))
}

struct StoreData {
    grow_denied: bool,
    mem_limit: usize,
    wasi: WasiP1Ctx,
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

impl LoadedFragment {
    /// Test constructor: a manifest and compiled module with no bundle
    /// behind them.
    pub fn for_tests(manifest: Manifest, module: Module) -> Self {
        Self { manifest, module, bundle_sha256: "test".to_string() }
    }
}

struct StagedBundle {
    verified: VerifiedBundle,
    publisher_status: String,
    is_downgrade: bool,
}

/// Bundles a user is reviewing before install, by staging token. Staging
/// and committing need no engine, so the process that decides what gets
/// installed need not be the one that runs it.
#[derive(Default)]
pub struct Staging {
    staged: Mutex<HashMap<String, StagedBundle>>,
}

pub struct FragmentsState {
    engine: Engine,
    loaded: Mutex<HashMap<String, Arc<LoadedFragment>>>,
    staging: Staging,
    /// Live job instances by token, each behind its own lock so parallel
    /// jobs step independently.
    jobs: Mutex<HashMap<String, Arc<Mutex<JobInstance>>>>,
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
            staging: Staging::default(),
            jobs: Mutex::new(HashMap::new()),
        }
    }

    pub fn engine(&self) -> &Engine {
        &self.engine
    }

    pub fn compile(&self, wasm: &[u8], capabilities: &[String]) -> FragmentResult<Module> {
        let module = Module::new(&self.engine, wasm)
            .map_err(|e| fail(FragmentErrorKind::CompileFailed, format!("Module rejected: {}", e)))?;
        check_abi(&module, capabilities)?;
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
        let module = self.compile(&verified.wasm, &verified.manifest.capabilities)?;
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

    /// Drops what is held for a part: its compiled module and its running
    /// jobs. Called when the part is removed or replaced.
    pub fn forget(&self, id: &str) {
        self.evict(id);
        self.jobs
            .lock()
            .unwrap()
            .retain(|_token, cell| cell.lock().unwrap().fragment_id != id);
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
const MAX_JOBS: usize = 8;
const JOB_IDLE_SECS: u64 = 120;

/// A live guest: store, instance handles, and the call's sandbox. Plain
/// calls build one, use it, and drop it; job starts park it in the state's
/// registry so steps run against the same memory.
struct RunningInstance {
    store: Store<StoreData>,
    memory: wasmtime::Memory,
    der_alloc: wasmtime::TypedFunc<i32, i32>,
    der_run: wasmtime::TypedFunc<(i32, i32), i64>,
    sandbox: Option<FileSandbox>,
    fuel: u64,
    deadline_ticks: u64,
    input_cap: usize,
    input_cap_text: &'static str,
}

struct JobInstance {
    run: RunningInstance,
    fragment_id: String,
    last_step: std::time::Instant,
}

/// Stages file-typed inputs into the sandbox and rewrites tokens to guest
/// paths; everything else passes through untouched.
fn stage_file_inputs(
    spec: Option<&OpSpec>,
    sandbox: Option<&FileSandbox>,
    inputs: &Value,
    exec_env: &ExecEnv<'_>,
) -> FragmentResult<Value> {
    let mut staged = inputs.clone();
    if let (Some(sandbox), Some(spec)) = (sandbox, spec) {
        for input in &spec.inputs {
            if input.io_type != "file" {
                continue;
            }
            let Some(object) = staged.as_object_mut() else { break };
            let Some(Value::String(token)) = object.get(&input.name) else { continue };
            let Some(real) = (exec_env.resolve_grant)(token) else {
                return Err(fail(
                    FragmentErrorKind::BadOutput,
                    format!("\"{}\" needs a picked file; run file.pick first", input.name),
                ));
            };
            let guest_path = sandbox.stage_input(&real)?;
            object.insert(input.name.clone(), Value::String(guest_path));
        }
    }
    Ok(staged)
}

/// Builds the guest for one call or one job: budgets from the declared
/// capabilities, the wasi context from the sandbox and net grants, and
/// reactor initialization for wasip1 std builds.
fn build_instance(engine: &Engine, loaded: &LoadedFragment) -> FragmentResult<RunningInstance> {
    let capabilities = &loaded.manifest.capabilities;
    let wants_files = capabilities.iter().any(|c| c == "wasi:files");
    let net_endpoint = capabilities.iter().find_map(|c| parse_compute_net(c));
    let large_io = capabilities.iter().any(|c| c == "io:large");

    let (input_cap, input_cap_text, mem_limit, fuel) = if large_io {
        (MAX_INPUT_BYTES_LARGE, "32 MiB", MEM_LIMIT_BYTES_LARGE, FUEL_BUDGET * 10)
    } else {
        (MAX_INPUT_BYTES, "1 MiB", MEM_LIMIT_BYTES, FUEL_BUDGET)
    };
    // Streaming a real file or speaking a protocol round trip needs wall
    // clock the compute-only deadline never allowed for.
    let deadline_ticks = if large_io || wants_files || net_endpoint.is_some() {
        EPOCH_DEADLINE_TICKS_HEAVY
    } else {
        EPOCH_DEADLINE_TICKS
    };

    let sandbox = if wants_files { Some(FileSandbox::create()?) } else { None };

    let mut builder = WasiCtxBuilder::new();
    if let Some(sandbox) = &sandbox {
        use wasmtime_wasi::{DirPerms, FilePerms};
        builder
            .preopened_dir(sandbox.root.join("in"), "/in", DirPerms::READ, FilePerms::READ)
            .and_then(|b| {
                b.preopened_dir(
                    sandbox.root.join("out"),
                    "/out",
                    DirPerms::all(),
                    FilePerms::all(),
                )
            })
            .map_err(|e| fail(FragmentErrorKind::Io, format!("Sandbox preopen failed: {}", e)))?;
    }
    if let Some((host, port)) = &net_endpoint {
        let (bridged_in, bridged_out) = connect_bridge(host, *port)?;
        builder.stdin(bridged_in);
        builder.stdout(bridged_out);
    }
    let wasi = builder.build_p1();
    let mut store = Store::new(engine, StoreData { grow_denied: false, mem_limit, wasi });
    store.limiter(|data| data);
    store
        .set_fuel(fuel)
        .map_err(|e| fail(FragmentErrorKind::Io, e.to_string()))?;
    store.set_epoch_deadline(deadline_ticks);

    let mut linker: Linker<StoreData> = Linker::new(engine);
    wasi_p1::add_to_linker_sync(&mut linker, |data| &mut data.wasi)
        .map_err(|e| fail(FragmentErrorKind::Io, e.to_string()))?;
    let instance = linker
        .instantiate(&mut store, &loaded.module)
        .map_err(|e| map_wasm_error(e, store.data()))?;
    if let Ok(initialize) = instance.get_typed_func::<(), ()>(&mut store, "_initialize") {
        initialize
            .call(&mut store, ())
            .map_err(|e| map_wasm_error(e, store.data()))?;
    }
    let memory = instance
        .get_memory(&mut store, "memory")
        .ok_or_else(|| fail(FragmentErrorKind::AbiMismatch, "Part exports no memory"))?;
    let der_alloc = instance
        .get_typed_func::<i32, i32>(&mut store, "der_alloc")
        .map_err(|_| fail(FragmentErrorKind::AbiMismatch, "der_alloc has the wrong signature"))?;
    let der_run = instance
        .get_typed_func::<(i32, i32), i64>(&mut store, "der_run")
        .map_err(|_| fail(FragmentErrorKind::AbiMismatch, "der_run has the wrong signature"))?;
    Ok(RunningInstance {
        store,
        memory,
        der_alloc,
        der_run,
        sandbox,
        fuel,
        deadline_ticks,
        input_cap,
        input_cap_text,
    })
}

/// One envelope through the guest: budgets re-armed, request written,
/// der_run called, the {ok}/{err} reply decoded.
fn call_operation(
    run: &mut RunningInstance,
    operation: &str,
    staged_inputs: &Value,
) -> FragmentResult<Value> {
    let envelope = serde_json::json!({ "operation": operation, "inputs": staged_inputs });
    let request = serde_json::to_vec(&envelope)
        .map_err(|e| fail(FragmentErrorKind::Io, e.to_string()))?;
    if request.len() > run.input_cap {
        return Err(fail(
            FragmentErrorKind::InputTooLarge,
            format!("Operation inputs exceed {}", run.input_cap_text),
        ));
    }
    let store = &mut run.store;
    store
        .set_fuel(run.fuel)
        .map_err(|e| fail(FragmentErrorKind::Io, e.to_string()))?;
    store.set_epoch_deadline(run.deadline_ticks);

    let len = request.len() as i32;
    let ptr = run
        .der_alloc
        .call(&mut *store, len)
        .map_err(|e| map_wasm_error(e, store.data()))?;
    if ptr == 0 {
        return Err(fail(FragmentErrorKind::Oom, "Part could not allocate the request"));
    }
    let ptr_u = ptr as u32 as u64;
    if ptr_u + request.len() as u64 > run.memory.data_size(&*store) as u64 {
        return Err(fail(FragmentErrorKind::BadOutput, "Part returned an out-of-bounds buffer"));
    }
    run.memory
        .write(&mut *store, ptr_u as usize, &request)
        .map_err(|_| fail(FragmentErrorKind::BadOutput, "Writing the request failed"))?;

    let packed = run
        .der_run
        .call(&mut *store, (ptr, len))
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
    if out_ptr as u64 + out_len as u64 > run.memory.data_size(&*store) as u64 {
        return Err(fail(FragmentErrorKind::BadOutput, "Part returned an out-of-bounds result"));
    }
    let mut out = vec![0u8; out_len as usize];
    run.memory
        .read(&*store, out_ptr as usize, &mut out)
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
        _ => Err(fail(
            FragmentErrorKind::BadOutput,
            "Part result must be {\"ok\": {...}} or {\"err\": \"...\"}",
        )),
    }
}

/// Produced files come home: a file-typed output holding a /out guest path
/// becomes a fresh grant with the same handle shape file.pick produces,
/// and declared url/name/size sibling outputs fill from it.
fn harvest_file_outputs(
    sandbox: Option<&FileSandbox>,
    spec: Option<&OpSpec>,
    result: &mut Value,
    exec_env: &ExecEnv<'_>,
) -> FragmentResult<()> {
    let (Some(sandbox), Some(spec)) = (sandbox, spec) else { return Ok(()) };
    for output in &spec.outputs {
        if output.io_type != "file" {
            continue;
        }
        let Some(object) = result.as_object_mut() else { break };
        let Some(Value::String(guest_path)) = object.get(&output.name) else { continue };
        let Some(real) = sandbox.produced(guest_path) else {
            return Err(fail(
                FragmentErrorKind::BadOutput,
                format!(
                    "Output \"{}\" names {}, which the part did not write under /out",
                    output.name, guest_path
                ),
            ));
        };
        let registered = (exec_env.register_output)(&real)
            .map_err(|message| fail(FragmentErrorKind::Io, message))?;
        let declared: Vec<&str> = spec.outputs.iter().map(|o| o.name.as_str()).collect();
        let token = registered.get("file").cloned().unwrap_or(Value::Null);
        object.insert(output.name.clone(), token);
        for sibling in ["url", "name", "size"] {
            if declared.contains(&sibling) && !object.contains_key(sibling) {
                if let Some(value) = registered.get(sibling) {
                    object.insert(sibling.to_string(), value.clone());
                }
            }
        }
    }
    Ok(())
}

impl FragmentsState {
    /// Drops jobs nothing has stepped lately: a closed window stops its
    /// timer, the timer stops the steps, and the reaper collects the rest.
    pub fn reap_jobs_older_than(&self, idle: std::time::Duration) {
        self.jobs
            .lock()
            .unwrap()
            .retain(|_token, cell| cell.lock().unwrap().last_step.elapsed() <= idle);
    }

    /// Starts a job: the instance stays live in the registry and the start
    /// operation's outputs carry the host-generated job token.
    pub fn start_job(
        &self,
        loaded: &LoadedFragment,
        operation: &str,
        inputs: &Value,
        exec_env: &ExecEnv<'_>,
    ) -> FragmentResult<Value> {
        self.reap_jobs_older_than(std::time::Duration::from_secs(JOB_IDLE_SECS));
        if self.jobs.lock().unwrap().len() >= MAX_JOBS {
            return Err(fail(
                FragmentErrorKind::Busy,
                "Too many jobs are running; finish or cancel one first",
            ));
        }
        let op_spec = loaded
            .manifest
            .operations
            .iter()
            .find(|op| op.name == operation)
            .ok_or_else(|| {
                fail(FragmentErrorKind::OperationNotFound, format!("Part has no operation {}", operation))
            })?;
        let mut run = build_instance(&self.engine, loaded)?;
        let staged = stage_file_inputs(Some(op_spec), run.sandbox.as_ref(), inputs, exec_env)?;
        let mut result = call_operation(&mut run, operation, &staged)?;
        let token = format!("derjob-{}", uuid::Uuid::new_v4());
        if let Some(object) = result.as_object_mut() {
            object.insert("job".to_string(), Value::String(token.clone()));
        }
        self.jobs.lock().unwrap().insert(
            token,
            Arc::new(Mutex::new(JobInstance {
                run,
                fragment_id: loaded.manifest.id.clone(),
                last_step: std::time::Instant::now(),
            })),
        );
        Ok(result)
    }

    /// One step against a live job. A done step harvests file outputs and
    /// tears the job down; a failing step tears it down too, so the error
    /// on the strip is also the job's end.
    pub fn step_job(
        &self,
        loaded: &LoadedFragment,
        operation: &str,
        inputs: &Value,
        exec_env: &ExecEnv<'_>,
    ) -> FragmentResult<Value> {
        let op_spec = loaded
            .manifest
            .operations
            .iter()
            .find(|op| op.name == operation)
            .ok_or_else(|| {
                fail(FragmentErrorKind::OperationNotFound, format!("Part has no operation {}", operation))
            })?;
        let token = op_spec
            .inputs
            .iter()
            .find(|input| input.io_type == "job")
            .and_then(|input| inputs.get(&input.name))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let cell = self.jobs.lock().unwrap().get(&token).cloned().ok_or_else(|| {
            fail(
                FragmentErrorKind::OperationNotFound,
                "No running job for this step; start it first (a finished or failed job is gone)",
            )
        })?;
        let mut job = cell.lock().unwrap();
        if job.fragment_id != loaded.manifest.id {
            return Err(fail(
                FragmentErrorKind::OperationNotFound,
                "This job belongs to a different part",
            ));
        }
        job.last_step = std::time::Instant::now();
        let outcome = call_operation(&mut job.run, operation, inputs);
        let mut result = match outcome {
            Ok(result) => result,
            Err(error) => {
                drop(job);
                self.jobs.lock().unwrap().remove(&token);
                return Err(error);
            }
        };
        let done = result.get("done").and_then(Value::as_bool).unwrap_or(false);
        if done {
            let harvest =
                harvest_file_outputs(job.run.sandbox.as_ref(), Some(op_spec), &mut result, exec_env);
            drop(job);
            self.jobs.lock().unwrap().remove(&token);
            harvest?;
        }
        Ok(result)
    }

    /// Routes an operation by its declared execution model: plain calls get
    /// a fresh instance, job starts park one, steps run against it.
    pub fn execute_operation_with(
        &self,
        loaded: &LoadedFragment,
        operation: &str,
        inputs: &Value,
        exec_env: &ExecEnv<'_>,
    ) -> FragmentResult<Value> {
        let mode = loaded
            .manifest
            .operations
            .iter()
            .find(|op| op.name == operation)
            .and_then(|op| op.job.as_deref());
        match mode {
            Some("start") => self.start_job(loaded, operation, inputs, exec_env),
            Some("step") => self.step_job(loaded, operation, inputs, exec_env),
            _ => execute_in_module_with(&self.engine, loaded, operation, inputs, exec_env),
        }
    }
}

pub fn execute_in_module(
    engine: &Engine,
    loaded: &LoadedFragment,
    operation: &str,
    inputs: &Value,
) -> FragmentResult<Value> {
    execute_in_module_with(engine, loaded, operation, inputs, &ExecEnv::none())
}

pub fn execute_in_module_with(
    engine: &Engine,
    loaded: &LoadedFragment,
    operation: &str,
    inputs: &Value,
    exec_env: &ExecEnv<'_>,
) -> FragmentResult<Value> {
    let op_spec = loaded.manifest.operations.iter().find(|op| op.name == operation);
    if op_spec.is_none() {
        return Err(fail(
            FragmentErrorKind::OperationNotFound,
            format!("Part has no operation {}", operation),
        ));
    }
    let mut run = build_instance(engine, loaded)?;
    let staged = stage_file_inputs(op_spec, run.sandbox.as_ref(), inputs, exec_env)?;
    let mut result = call_operation(&mut run, operation, &staged)?;
    harvest_file_outputs(run.sandbox.as_ref(), op_spec, &mut result, exec_env)?;
    Ok(result)
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

/// Stages a bundle with this state's own engine checking the module.
pub fn stage_core(
    state: &FragmentsState,
    fragments_dir: &Path,
    raw: &[u8],
    reserved_names: &[String],
) -> FragmentResult<StageSummary> {
    stage_with(&state.staging, fragments_dir, raw, reserved_names, &|wasm, capabilities| {
        state.compile(wasm, capabilities).map(|_| ())
    })
}

/// Verifies a bundle against the trust store and holds it for review.
/// `check_module` compiles the module and checks its imports against the
/// declared capabilities, wherever the engine lives.
pub fn stage_with(
    staging: &Staging,
    fragments_dir: &Path,
    raw: &[u8],
    reserved_names: &[String],
    check_module: &dyn Fn(&[u8], &[String]) -> FragmentResult<()>,
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
        check_module(&verified.wasm, &verified.manifest.capabilities)?;
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
    staging.staged.lock().unwrap().insert(
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
    let manifest = commit_with(
        &state.staging,
        fragments_dir,
        staging_token,
        expected_fingerprint,
        force_downgrade,
    )?;
    state.evict(&manifest.id);
    Ok(manifest)
}

/// Installs a staged bundle: pins its publisher and namespace, records it
/// as installed, and writes the bundle file.
pub fn commit_with(
    staging: &Staging,
    fragments_dir: &Path,
    staging_token: &str,
    expected_fingerprint: &str,
    force_downgrade: bool,
) -> FragmentResult<Manifest> {
    let staged = staging
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
    Ok(manifest)
}

pub fn remove_core(state: &FragmentsState, fragments_dir: &Path, id: &str) -> FragmentResult<()> {
    remove_installed(fragments_dir, id)?;
    state.evict(id);
    Ok(())
}

/// Removes an installed bundle and its installed record.
pub fn remove_installed(fragments_dir: &Path, id: &str) -> FragmentResult<()> {
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
    save_trust(fragments_dir, &trust)
}

/// Replaces a publisher's pinned key after the user confirmed both
/// fingerprints.
pub fn replace_publisher_key_core(
    fragments_dir: &Path,
    publisher: &str,
    old_fingerprint: &str,
    new_fingerprint: &str,
    new_key_b64: &str,
) -> FragmentResult<()> {
    let mut trust = load_trust(fragments_dir);
    let pin = trust
        .publishers
        .get_mut(publisher)
        .ok_or_else(|| fail(FragmentErrorKind::NotInstalled, "Unknown publisher"))?;
    if pin.fingerprint != old_fingerprint {
        return Err(fail(FragmentErrorKind::TrustViolation, "Current key does not match"));
    }
    let key_bytes: [u8; 32] = BASE64
        .decode(new_key_b64)
        .ok()
        .and_then(|k| k.try_into().ok())
        .ok_or_else(|| fail(FragmentErrorKind::VerifyFailed, "New key must be 32 bytes"))?;
    if fingerprint_hex(&key_bytes) != new_fingerprint {
        return Err(fail(FragmentErrorKind::VerifyFailed, "New key does not match its fingerprint"));
    }
    pin.key = new_key_b64.to_string();
    pin.fingerprint = new_fingerprint.to_string();
    save_trust(fragments_dir, &trust)
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

#[cfg(test)]
mod capability_tests {
    use super::*;

    fn manifest(capabilities: &[&str]) -> Manifest {
        serde_json::from_value(serde_json::json!({
            "formatVersion": 1,
            "abiVersion": 1,
            "id": "test.caps",
            "name": "Caps",
            "version": "1.0.0",
            "publisher": "test",
            "description": "capability test part",
            "namespace": "caps",
            "capabilities": capabilities,
            "wasmSha256": "unchecked-in-unit-tests",
            "createdAt": "2026-07-27T00:00:00Z",
            "operations": [{
                "name": "caps.tick",
                "description": "returns after touching the clock",
                "inputs": [],
                "outputs": [{ "name": "ticked", "type": "boolean" }]
            }]
        }))
        .expect("manifest parses")
    }

    /// A minimal ABI-complete part that imports and calls the WASI clock.
    const CLOCK_WAT: &str = r#"(module
        (import "wasi_snapshot_preview1" "clock_time_get"
            (func $clock (param i32 i64 i32) (result i32)))
        (memory (export "memory") 1)
        (data (i32.const 2048) "{\"ok\":{\"ticked\":true}}")
        (func (export "der_alloc") (param i32) (result i32) (i32.const 4096))
        (func (export "der_run") (param i32 i32) (result i64)
            (drop (call $clock (i32.const 0) (i64.const 1) (i32.const 1024)))
            (i64.or (i64.shl (i64.const 2048) (i64.const 32)) (i64.const 22))))"#;

    #[test]
    fn undeclared_wasi_import_is_refused_naming_the_capability() {
        let state = FragmentsState::new();
        let wasm = wat::parse_str(CLOCK_WAT).expect("wat compiles");
        let error = state.compile(&wasm, &[]).expect_err("must refuse");
        assert!(error.message.contains("wasi_snapshot_preview1::clock_time_get"));
        assert!(error.message.contains("declaring the wasi:clocks capability grants it"));
    }

    #[test]
    fn non_wasi_imports_are_refused_regardless_of_declarations() {
        let state = FragmentsState::new();
        let wasm = wat::parse_str(
            r#"(module
                (import "env" "host_call" (func (param i32 i32) (result i32)))
                (memory (export "memory") 1)
                (func (export "der_alloc") (param i32) (result i32) (i32.const 0))
                (func (export "der_run") (param i32 i32) (result i64) (i64.const 0)))"#,
        )
        .expect("wat compiles");
        let error = state
            .compile(&wasm, &["wasi:clocks".to_string()])
            .expect_err("must refuse");
        assert!(error.message.contains("env::host_call"));
        assert!(error.message.contains("parts import WASI only"));
    }

    #[test]
    fn granted_clock_part_links_and_runs() {
        let state = FragmentsState::new();
        let wasm = wat::parse_str(CLOCK_WAT).expect("wat compiles");
        let capabilities = vec!["wasi:clocks".to_string()];
        let module = state.compile(&wasm, &capabilities).expect("verifies");
        let loaded = LoadedFragment {
            manifest: manifest(&["wasi:clocks"]),
            module,
            bundle_sha256: "test".to_string(),
        };
        let result = execute_in_module(
            state.engine(),
            &loaded,
            "caps.tick",
            &serde_json::json!({}),
        )
        .expect("runs under the grant");
        assert_eq!(result, serde_json::json!({ "ticked": true }));
    }

    #[test]
    fn zero_import_modules_still_pass_with_no_declarations() {
        let state = FragmentsState::new();
        let wasm = wat::parse_str(
            r#"(module
                (memory (export "memory") 1)
                (func (export "der_alloc") (param i32) (result i32) (i32.const 0))
                (func (export "der_run") (param i32 i32) (result i64) (i64.const 0)))"#,
        )
        .expect("wat compiles");
        state.compile(&wasm, &[]).expect("verifies clean");
    }
}

#[cfg(test)]
mod name_tests {
    #[test]
    fn op_names_allow_camel_case_segments() {
        assert!(super::op_name_ok("date.diffDays", "date"));
        assert!(super::op_name_ok("list.update_where", "list"));
        assert!(super::op_name_ok("fx.rate", "fx"));
        assert!(!super::op_name_ok("date.DiffDays", "date"), "leading uppercase");
        assert!(!super::op_name_ok("other.diffDays", "date"), "outside namespace");
        assert!(!super::op_name_ok("date", "date"), "no segment");
    }
}

#[cfg(test)]
mod socket_tls_tests {
    #[test]
    fn the_socket_tls_setup_names_its_provider() {
        super::socket_tls_config().expect("builds without a process-wide provider");
    }
}

