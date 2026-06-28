//! PDF domain — core-owned object model, the parser/store facade,
//! and pure document logic.
//!
//! Nothing in this module (or its children outside `crate::backend`)
//! may name an `lopdf` type: the facade traits in [`store`] are the
//! only seam backends implement, so swapping lopdf for the future
//! own-parser is a backend change, not core surgery. Enforced by the
//! lopdf leak gate in `scripts/core-gates.mjs`.

pub mod info;
pub mod object;
pub mod store;
