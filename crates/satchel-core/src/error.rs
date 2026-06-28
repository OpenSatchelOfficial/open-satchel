//! Core error type. Every fallible `pub fn` in this crate returns
//! [`CoreError`] — shells map it onto their own error surface (Tauri
//! `AppError`, CLI exit codes, JS exceptions in WASM).

/// The error type for all satchel-core operations.
#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    /// A document source/sink failed to produce or accept bytes.
    /// The string carries the shell-side cause (e.g. an OS error),
    /// already formatted — the core neither knows nor cares whether
    /// bytes come from a file, a blob, or a network stream.
    #[error("document IO: {0}")]
    Io(String),

    /// The document bytes could not be parsed as the claimed format.
    #[error("parse: {0}")]
    Parse(String),

    /// An argument violated a documented precondition.
    #[error("invalid argument: {0}")]
    InvalidArgument(String),

    /// A requested entity (page, object, paragraph) does not exist.
    #[error("not found: {0}")]
    NotFound(String),
}
