//! The host's service processes. Each one is this executable started again
//! with `--service <name>`: it serves requests over its pipes and never
//! becomes the app. A service holds what the host should not, and ends when
//! its input closes, which is when the host that started it exits.

use std::path::Path;

use serde::de::DeserializeOwned;
use serde::Serialize;

use der_wire::{Asked, Client};

/// The credential store and every request that may carry a stored secret.
pub const HTTP: &str = "http";
/// The mail account, sending, and reading.
pub const MAIL: &str = "mail";
/// The model settings, keys, and sign-in tokens, and every request to a
/// model provider.
pub const LLM: &str = "llm";

fn refuse() -> ! {
    eprintln!("{}", der_wire::usage(&[HTTP, MAIL, LLM]));
    std::process::exit(2);
}

/// Runs the service the arguments ask for and reports whether they asked
/// for one. The service reads requests on stdin and answers on stdout.
pub fn serve_if_asked() -> bool {
    let arguments: Vec<String> = std::env::args().collect();
    let (name, settings_dir) = match der_wire::asked(&arguments) {
        Asked::Nothing => return false,
        Asked::Service { name, settings_dir } => (name, settings_dir),
        Asked::Malformed => refuse(),
    };
    let outcome = match name.as_str() {
        HTTP => der_http::serve(settings_dir, std::io::stdin().lock(), std::io::stdout()),
        MAIL => der_mail::serve(settings_dir, std::io::stdin().lock(), std::io::stdout()),
        LLM => der_llm::serve(settings_dir, std::io::stdin().lock(), std::io::stdout()),
        _ => refuse(),
    };
    if let Err(error) = outcome {
        eprintln!("The {name} service stopped: {error}");
        std::process::exit(1);
    }
    true
}

/// A client that runs this executable as the named service over a settings
/// directory. `label` is what error messages call it.
pub fn client<R, P>(label: &str, name: &str, settings_dir: &Path) -> Result<Client<R, P>, String>
where
    R: Serialize,
    P: DeserializeOwned + Send + 'static,
{
    let program = std::env::current_exe()
        .map_err(|error| format!("The {} service could not start: {}", label, error))?;
    Ok(Client::new(label, program, der_wire::service_arguments(name, settings_dir)))
}
