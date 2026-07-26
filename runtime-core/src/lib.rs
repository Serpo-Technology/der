//! The DER runtime kernel, host-free: everything semantic about running a
//! contract lives here, held to the committed conformance corpus. Hosts
//! (the desktop core natively, the wasm build elsewhere) add IO around it:
//! dispatchers for non-builtin operations, an entropy and clock source
//! behind the RuntimeEnv trait, and transports for the compose loop.

pub mod compose;
pub mod entry;
pub mod env;
pub mod expression;
pub mod llm_schema;
pub mod manifests;
pub mod operations;
pub mod prompt;
pub mod session;
pub mod streaming;
pub mod templates;
pub mod transforms;
pub mod validation;
pub mod vectors;
pub mod value;
pub mod view;
