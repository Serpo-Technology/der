//! The line protocol between DER's host and its service processes. A
//! service reads one JSON request per line on its input and writes one JSON
//! reply per line on its output, and each reply carries the id of the
//! request it answers. A reply that arrives in pieces sends any number of
//! part lines for its id first, and a request whose handler ends without
//! answering gets a failed line, so its caller is never left waiting. A
//! service that needs something only the host may do sends a call line
//! while it handles a request and waits for the host's answer line.
//! `serve` is the service's end and `Client` is the host's end. Both are generic over the request and reply types, so every
//! service speaks the same framing with its own vocabulary.

mod client;
mod serve;

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub use client::Client;
pub use serve::{serve, Caller, Responder};

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

/// A question the service puts to the host while it handles the request
/// with this id. `call` numbers the question so its answer finds it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CallLine {
    pub id: u64,
    pub call: u64,
    pub body: serde_json::Value,
}

/// The host's answer to the call with the same numbers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AnswerLine {
    pub id: u64,
    pub answer: u64,
    pub body: serde_json::Value,
}

const SERVICE_FLAG: &str = "--service";
const DIR_FLAG: &str = "--dir";

/// The arguments that start an executable as the named service over the
/// directory that holds what the service owns.
pub fn service_arguments(name: &str, dir: &Path) -> Vec<OsString> {
    vec![SERVICE_FLAG.into(), name.into(), DIR_FLAG.into(), dir.into()]
}

/// The arguments that start an executable as a named service that owns
/// nothing on disk.
pub fn service_arguments_without_dir(name: &str) -> Vec<OsString> {
    vec![SERVICE_FLAG.into(), name.into()]
}

/// What a process's arguments ask of it.
#[derive(Debug, Clone, PartialEq)]
pub enum Asked {
    /// No service was asked for.
    Nothing,
    /// Run the named service, over the directory when one is given.
    Service { name: String, dir: Option<PathBuf> },
    /// A service was asked for without a name, or the directory flag came
    /// without a directory.
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
    let names_a_dir = arguments.iter().any(|argument| argument == DIR_FLAG);
    match (value_after(SERVICE_FLAG), value_after(DIR_FLAG)) {
        (Some(name), dir) if !name.starts_with("--") && dir.is_some() == names_a_dir => Asked::Service {
            name: name.clone(),
            dir: dir.map(PathBuf::from),
        },
        _ => Asked::Malformed,
    }
}

/// The usage line for an executable that can run as one of `names`.
pub fn usage(names: &[&str]) -> String {
    format!("usage: {SERVICE_FLAG} <{}> [{DIR_FLAG} <directory>]", names.join("|"))
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
                dir: Some(PathBuf::from("/data/settings")),
            }
        );
        let mut bare = vec!["/path/to/host".to_string()];
        bare.extend(strings(&service_arguments_without_dir("session")));
        assert_eq!(
            asked(&bare),
            Asked::Service {
                name: "session".to_string(),
                dir: None,
            }
        );
    }

    #[test]
    fn arguments_without_a_service_ask_nothing() {
        assert_eq!(asked(&["/path/to/host".to_string(), "--native".to_string()]), Asked::Nothing);
    }

    #[test]
    fn a_service_without_its_name_or_a_flag_without_its_directory_is_malformed() {
        for arguments in [
            vec!["--service"],
            vec!["--service", "--dir", "/data"],
            vec!["--service", "http", "--dir"],
        ] {
            let arguments: Vec<String> = arguments.into_iter().map(str::to_string).collect();
            assert_eq!(asked(&arguments), Asked::Malformed, "{arguments:?}");
        }
    }
}
