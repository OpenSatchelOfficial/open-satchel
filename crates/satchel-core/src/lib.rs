//! # satchel-core
//!
//! The UI-independent document core for Open Satchel. The core knows
//! about documents — never about buttons, windows, files on disk, or
//! the toolkit du jour. Shells (the shipping Tauri app today, a
//! native shell or WASM build later) adapt the outside world to the
//! core's traits and call its functions.
//!
//! Discipline rules from `docs/NATIVE-REWRITE-PLAN.md` §2, enforced
//! mechanically by `scripts/core-gates.mjs` on every verify run:
//!
//! 1. **No UI types in core.**
//! 2. **IO behind traits** — [`io::DocumentSource`] /
//!    [`io::DocumentSink`]; direct `std::fs` is a clippy error here.
//! 3. **No native-only crates** — this crate compiles to
//!    `wasm32-unknown-unknown` on every verify run.
//! 4. **Never require threads** — single-threaded by default;
//!    parallelism only ever behind an opt-in feature.
//! 6. **Every `pub fn` is a future SDK call** — stable, documented,
//!    no internal types leaking through signatures.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod backend;
pub mod cluster;
#[cfg(feature = "crypto")]
pub mod crypto;
pub mod error;
pub mod fallback;
pub mod io;
pub mod ops;
pub mod pdf;

pub use error::CoreError;

/// Convenience alias used across the core's public API.
pub type Result<T> = std::result::Result<T, CoreError>;
