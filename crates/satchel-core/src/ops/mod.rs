//! Canonical operation log — ONE history, owned by the core.
//!
//! [`model`] ports the live-edit data model (`live::model` in the
//! Tauri shell) into the core: every edit is an [`model::Op`] applied
//! to an [`model::EditModel`]. [`log`] adds what the shell never had:
//! inversion-based undo/redo and checkpointed replay on a single
//! append-only history.
//!
//! The serde wire shapes match the shell's `live::model` types
//! byte-for-byte (same rename attributes), so frontend payloads and
//! existing on-disk session logs parse unchanged when the shell
//! migrates onto these types. Until that migration the shell keeps
//! its own copy; `docs/storm/UNDO-UNIFICATION.md` maps every
//! existing history (frontend `lib/undo-redo.ts`, Fabric object
//! state, live-edit op log) onto this module.

pub mod log;
pub mod model;

pub use log::{Checkpoint, OpLog, OpLogEntry};
pub use model::{Bbox, EditModel, EmbeddedFont, Op, PageEdits, ParagraphEdit, PositionDelta, TextAlign};
