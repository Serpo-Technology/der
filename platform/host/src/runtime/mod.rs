//! The runtime surface of the desktop core. The semantic kernel lives in
//! the der-runtime crate (host-free, builds native and for wasm32) and is
//! re-exported here so every existing path keeps working; this module adds
//! the host: the dispatcher over parts and platform IO, live sessions, the
//! native panel bridge, management plumbing, and background refresh.

pub use der_runtime::{
    compose, env, expression, llm_schema, manifests, operations, prompt, session, streaming,
    templates, transforms, validation, value, view,
};

pub mod host;
pub mod manage;
pub mod schedule;
pub mod sessions;
pub mod sidecar;
