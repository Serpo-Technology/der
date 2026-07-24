//! The experience runtime kernel: transform and row-expression semantics
//! implemented over JSON values. The webview runtime implements the same
//! kernel in TypeScript; the conformance vectors in runtime-conformance/
//! hold the two to identical behavior, JavaScript edge cases included, so
//! every renderer backend computes exactly what the webview computes.

pub mod env;
pub mod expression;
pub mod host;
pub mod operations;
pub mod session;
pub mod sessions;
pub mod sidecar;
pub mod templates;
pub mod transforms;
pub mod value;
pub mod view;
