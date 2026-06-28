//! Parser/store backends.
//!
//! THE ONLY PLACE in satchel-core allowed to name backend crates
//! (`lopdf` today) — `scripts/core-gates.mjs` fails the build if the
//! string `lopdf` appears in core source outside this directory.
//! Everything here is private plumbing behind the
//! [`crate::pdf::store`] traits; nothing backend-flavored may appear
//! in a public signature.

#[cfg(feature = "lopdf-backend")]
pub mod lopdf_store;
