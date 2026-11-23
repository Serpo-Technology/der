//! The line protocol between DER's host and its service processes. A
//! service reads one JSON request per line on its input and writes one JSON
//! reply per line on its output, and each reply carries the id of the
//! request it answers. A reply that arrives in pieces sends any number of
//! part lines for its id first, and a request whose handler ends without
//! answering gets a failed line, so its caller is never left waiting.
//! `serve` is the service's end and `Client` is the host's end. Both are generic over the request and reply types, so every
//! service speaks the same framing with its own vocabulary.

mod client;
mod serve;

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub use client::Client;
pub use serve::{serve, Responder};

/// One request on the wire.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestLine<R> {
    pub id: u64,
    pub request: R,
}

/// One reply on the wire, carrying the id of the request it answers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReplyLine<P> {
    pub id: u64,
    pub reply: P,
}

/// One piece of a streamed reply on the wire: text the service has so far
/// for the request with this id. The reply line still follows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PartLine {
    pub id: u64,
    pub part: String,
}

/// What a request gets when its handler ended without answering it, for
/// example because it panicked.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FailedLine {
    pub id: u64,
    pub failed: bool,
}

const SERVICE_FLAG: &str = "--service";
const SETTINGS_DIR_FLAG: &str = "--settings-dir";

/// The arguments that start an executable as the named service over a
/// settings directory.
pub fn service_arguments(name: &str, settings_dir: &Path) -> Vec<OsString> {
    vec![
        SERVICE_FLAG.into(),
        name.into(),
        SETTINGS_DIR_FLAG.into(),
        settings_dir.into(),
    ]
}

/// What a process's arguments ask of it.
#[derive(Debug, Clone, PartialEq)]
pub enum Asked {
    /// No service was asked for.
    Nothing,
    /// Run the named service over the settings directory.
    Service { name: String, settings_dir: PathBuf },
    /// A service was asked for without a name or a settings directory.
    Malformed,
}

/// Reads the arguments `service_arguments` writes.
pub fn asked(arguments: &[String]) -> Asked {
    let value_after = |flag: &str| {
        arguments
            .iter()
            .position(|argument| argument == flag)
            .and_then(|at| arguments.get(at + 1))
    };
    if !arguments.iter().any(|argument| argument == SERVICE_FLAG) {
        return Asked::Nothing;
    }
    match (value_after(SERVICE_FLAG), value_after(SETTINGS_DIR_FLAG)) {
        (Some(name), Some(dir)) if !name.starts_with("--") => Asked::Service {
            name: name.clone(),
            settings_dir: PathBuf::from(dir),
        },
        _ => Asked::Malformed,
    }
}

/// The usage line for an executable that can run as one of `names`.
pub fn usage(names: &[&str]) -> String {
    format!("usage: {SERVICE_FLAG} <{}> {SETTINGS_DIR_FLAG} <directory>", names.join("|"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(arguments: &[OsString]) -> Vec<String> {
        arguments
            .iter()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn written_arguments_read_back() {
        let mut arguments = vec!["/path/to/host".to_string()];
        arguments.extend(strings(&service_arguments("http", Path::new("/data/settings"))));
        assert_eq!(
            asked(&arguments),
            Asked::Service {
                name: "http".to_string(),
                settings_dir: PathBuf::from("/data/settings"),
            }
        );
    }

    #[test]
    fn arguments_without_a_service_ask_nothing() {
        assert_eq!(asked(&["/path/to/host".to_string(), "--native".to_string()]), Asked::Nothing);
    }

    #[test]
    fn a_service_without_its_name_or_directory_is_malformed() {
        for arguments in [
            vec!["--service"],
            vec!["--service", "http"],
            vec!["--service", "--settings-dir", "/data"],
            vec!["--service", "http", "--settings-dir"],
        ] {
            let arguments: Vec<String> = arguments.into_iter().map(str::to_string).collect();
            assert_eq!(asked(&arguments), Asked::Malformed, "{arguments:?}");
        }
    }
}
