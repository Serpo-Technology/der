//! Publisher tooling for DER wasm parts: key generation, bundle signing,
//! and key fingerprints.
//!
//! The wire format mirrors the app's verifier exactly. A `.derpart` bundle
//! is a JSON object with the keys formatVersion, manifestB64, wasmB64,
//! publisherKeyB64, and signatureB64. The manifest bytes are embedded and
//! signed verbatim; the Ed25519 signature covers
//! `DERPART-SIG-V1\0 || manifest bytes`.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use clap::{Parser, Subcommand};
use ed25519_dalek::{Signer, SigningKey};
use rand::rngs::OsRng;
use serde::Serialize;
use sha2::{Digest, Sha256};

const SIG_DOMAIN: &[u8] = b"DERPART-SIG-V1\x00";
const FORMAT_VERSION: u32 = 1;
const MAX_MANIFEST_BYTES: usize = 256 << 10;
const MAX_WASM_BYTES: usize = 10 << 20;

#[derive(Parser)]
#[command(name = "fragment-tool", about = "Generate publisher keys and sign DER part bundles", version)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Generate an Ed25519 publisher key pair and print its fingerprint
    Keygen {
        /// Directory the key files are written into
        #[arg(long)]
        out_dir: PathBuf,
        /// Base name for the key files (<name>.key and <name>.pub)
        #[arg(long)]
        name: String,
    },
    /// Sign a manifest and wasm module into a .derpart bundle
    Bundle {
        /// Manifest JSON file; its bytes are embedded and signed verbatim
        #[arg(long)]
        manifest: PathBuf,
        /// Compiled wasm module the manifest's wasmSha256 must match
        /// (omit for UI-only bundles with an empty wasmSha256)
        #[arg(long)]
        wasm: Option<PathBuf>,
        /// Secret key file produced by keygen (<name>.key)
        #[arg(long)]
        key: PathBuf,
        /// Output path for the signed bundle
        #[arg(long)]
        out: PathBuf,
    },
    /// Print the fingerprint of a public key file
    Fingerprint {
        /// Public key file produced by keygen (<name>.pub)
        #[arg(long = "pub")]
        public: PathBuf,
    },
    /// Write a registry index.json describing every .derpart in a directory
    Index {
        /// Directory holding signed .derpart bundles
        #[arg(long)]
        dir: PathBuf,
        /// Output path for the index (bundle URLs are relative to it)
        #[arg(long)]
        out: PathBuf,
    },
}

/// Serialized bundle. Field order and camelCase names match the app's
/// deserializer, which rejects unknown fields.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BundleOut {
    format_version: u32,
    manifest_b64: String,
    wasm_b64: String,
    publisher_key_b64: String,
    signature_b64: String,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let result = match cli.command {
        Command::Keygen { out_dir, name } => keygen(&out_dir, &name),
        Command::Bundle { manifest, wasm, key, out } => bundle(&manifest, wasm.as_deref(), &key, &out),
        Command::Fingerprint { public } => fingerprint(&public),
        Command::Index { dir, out } => index(&dir, &out),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("error: {}", message);
            ExitCode::FAILURE
        }
    }
}

fn keygen(out_dir: &Path, name: &str) -> Result<(), String> {
    fs::create_dir_all(out_dir)
        .map_err(|e| format!("could not create {}: {}", out_dir.display(), e))?;
    let key_path = out_dir.join(format!("{}.key", name));
    let pub_path = out_dir.join(format!("{}.pub", name));
    if key_path.exists() || pub_path.exists() {
        return Err(format!(
            "{} or {} already exists; move it away before generating a new key",
            key_path.display(),
            pub_path.display()
        ));
    }

    let signing = SigningKey::generate(&mut OsRng);
    let verifying_bytes = signing.verifying_key().to_bytes();

    write_secret(&key_path, format!("{}\n", BASE64.encode(signing.to_bytes())).as_bytes())?;
    fs::write(&pub_path, format!("{}\n", BASE64.encode(verifying_bytes)))
        .map_err(|e| format!("could not write {}: {}", pub_path.display(), e))?;

    println!("wrote {}", key_path.display());
    println!("wrote {}", pub_path.display());
    println!("fingerprint: {}", fingerprint_grouped(&verifying_bytes));
    Ok(())
}

/// Writes the secret key with owner-only permissions from the start.
fn write_secret(path: &Path, contents: &[u8]) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::io::Write as _;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .map_err(|e| format!("could not create {}: {}", path.display(), e))?;
        file.write_all(contents)
            .map_err(|e| format!("could not write {}: {}", path.display(), e))?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        fs::write(path, contents).map_err(|e| format!("could not write {}: {}", path.display(), e))
    }
}

fn bundle(manifest_path: &Path, wasm_path: Option<&Path>, key_path: &Path, out_path: &Path) -> Result<(), String> {
    // The manifest bytes are read once and embedded verbatim; they are
    // never re-serialized, so the signature stays valid byte for byte.
    let manifest_bytes = fs::read(manifest_path)
        .map_err(|e| format!("could not read {}: {}", manifest_path.display(), e))?;
    if manifest_bytes.len() > MAX_MANIFEST_BYTES {
        return Err(format!("manifest exceeds the {} byte limit", MAX_MANIFEST_BYTES));
    }
    let wasm = match wasm_path {
        Some(path) => fs::read(path).map_err(|e| format!("could not read {}: {}", path.display(), e))?,
        None => Vec::new(),
    };
    if wasm.len() > MAX_WASM_BYTES {
        return Err(format!("wasm module exceeds the {} byte limit", MAX_WASM_BYTES));
    }

    // Parse a copy only to cross-check the hash binding before signing.
    let parsed: serde_json::Value = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| format!("manifest is not valid JSON: {}", e))?;
    let declared = parsed
        .get("wasmSha256")
        .and_then(|v| v.as_str())
        .ok_or("manifest has no wasmSha256 string field")?;
    let actual = if wasm.is_empty() { String::new() } else { hex_lower(&Sha256::digest(&wasm)) };
    if declared.to_lowercase() != actual {
        return Err(format!(
            "wasmSha256 mismatch: the manifest declares {} but the module hashes to {}; update the wasmSha256 field to the second value and rerun",
            declared, actual
        ));
    }

    let signing = read_signing_key(key_path)?;
    let mut preimage = Vec::with_capacity(SIG_DOMAIN.len() + manifest_bytes.len());
    preimage.extend_from_slice(SIG_DOMAIN);
    preimage.extend_from_slice(&manifest_bytes);
    let signature = signing.sign(&preimage);
    let verifying_bytes = signing.verifying_key().to_bytes();

    let bundle = BundleOut {
        format_version: FORMAT_VERSION,
        manifest_b64: BASE64.encode(&manifest_bytes),
        wasm_b64: BASE64.encode(&wasm),
        publisher_key_b64: BASE64.encode(verifying_bytes),
        signature_b64: BASE64.encode(signature.to_bytes()),
    };
    let json = serde_json::to_string(&bundle).map_err(|e| format!("could not serialize the bundle: {}", e))?;

    if let Some(parent) = out_path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("could not create {}: {}", parent.display(), e))?;
        }
    }
    fs::write(out_path, &json)
        .map_err(|e| format!("could not write {}: {}", out_path.display(), e))?;

    println!("wrote {} ({} bytes)", out_path.display(), json.len());
    println!("wasm sha256: {}", actual);
    println!("publisher fingerprint: {}", fingerprint_grouped(&verifying_bytes));
    Ok(())
}

fn fingerprint(pub_path: &Path) -> Result<(), String> {
    let key = read_key_file(pub_path)?;
    println!("{}", fingerprint_grouped(&key));
    Ok(())
}

fn read_signing_key(path: &Path) -> Result<SigningKey, String> {
    Ok(SigningKey::from_bytes(&read_key_file(path)?))
}

/// Reads a base64 key file and returns the raw 32 bytes.
fn read_key_file(path: &Path) -> Result<[u8; 32], String> {
    let text = fs::read_to_string(path)
        .map_err(|e| format!("could not read {}: {}", path.display(), e))?;
    let bytes = BASE64
        .decode(text.trim())
        .map_err(|_| format!("{} is not valid base64", path.display()))?;
    bytes
        .try_into()
        .map_err(|_| format!("{} must decode to exactly 32 bytes", path.display()))
}

/// sha256 of the raw 32-byte public key, lowercase hex, grouped in fours.
/// Matches the app's fingerprint display exactly.
fn fingerprint_grouped(public_key: &[u8; 32]) -> String {
    let hex = hex_lower(&Sha256::digest(public_key));
    hex.as_bytes()
        .chunks(4)
        .map(|chunk| std::str::from_utf8(chunk).unwrap_or_default())
        .collect::<Vec<_>>()
        .join(" ")
}

fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}


#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IndexEntry {
    id: String,
    name: String,
    version: String,
    publisher: String,
    namespace: String,
    description: String,
    operations: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    recipes: Vec<String>,
    bundle_url: String,
    bundle_sha256: String,
    bundle_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IndexOut {
    format_version: u32,
    parts: Vec<IndexEntry>,
}

fn index(dir: &Path, out: &Path) -> Result<(), String> {
    let mut parts: Vec<IndexEntry> = Vec::new();
    let entries = fs::read_dir(dir).map_err(|e| format!("cannot read {}: {}", dir.display(), e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("derpart") {
            continue;
        }
        let raw = fs::read(&path).map_err(|e| format!("cannot read {}: {}", path.display(), e))?;
        let envelope: serde_json::Value = serde_json::from_slice(&raw)
            .map_err(|e| format!("{} is not a bundle: {}", path.display(), e))?;
        let manifest_bytes = envelope
            .get("manifestB64")
            .and_then(|v| v.as_str())
            .and_then(|b64| BASE64.decode(b64).ok())
            .ok_or_else(|| format!("{} has no readable manifest", path.display()))?;
        let manifest: serde_json::Value = serde_json::from_slice(&manifest_bytes)
            .map_err(|e| format!("{} manifest is not JSON: {}", path.display(), e))?;
        let text = |key: &str| {
            manifest
                .get(key)
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string()
        };
        let operations = manifest
            .get("operations")
            .and_then(|v| v.as_array())
            .map(|ops| {
                ops.iter()
                    .filter_map(|op| op.get("name").and_then(|n| n.as_str()))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        let recipes = manifest
            .get("recipes")
            .and_then(|v| v.as_array())
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(|entry| entry.get("name").and_then(|n| n.as_str()))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        let file_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_string();
        parts.push(IndexEntry {
            id: text("id"),
            name: text("name"),
            version: text("version"),
            publisher: text("publisher"),
            namespace: text("namespace"),
            description: text("description"),
            operations,
            recipes,
            bundle_url: file_name,
            bundle_sha256: Sha256::digest(&raw)
                .iter()
                .map(|byte| format!("{:02x}", byte))
                .collect::<String>(),
            bundle_bytes: raw.len() as u64,
        });
    }
    parts.sort_by(|a, b| a.id.cmp(&b.id));
    let part_count = parts.len();
    let json = serde_json::to_string_pretty(&IndexOut { format_version: 1, parts })
        .map_err(|e| format!("cannot serialize index: {}", e))?;
    fs::write(out, format!("{}\n", json))
        .map_err(|e| format!("cannot write {}: {}", out.display(), e))?;
    println!("wrote {} ({} parts)", out.display(), part_count);
    Ok(())
}
