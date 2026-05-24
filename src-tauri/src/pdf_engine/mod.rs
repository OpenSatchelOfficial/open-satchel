//! Rust-native PDF engine — parse, write, selective-op render, bake.
//!
//! The engine is live: `commands::engine::engine_bake_from_bytes` is
//! invoked by the frontend save path for paragraph edits (see
//! `src/formats/pdf/index.ts`), and `engine_render_page_with_skips_from_bytes`
//! powers the hybrid editor's truth-layer overlay. The original
//! sessions-based rollout (S2 writer → S3 renderer → S5 bake → S6
//! selective-op → S7 signed-source) all landed on main; `.5` follow-
//! ups (S5.5-P1/P2/P3, S6.5, S7.5, S8.5) layered the real
//! functionality on top.
//!
//! Downstream modules depend on the types in [`self::types`]; commands
//! live in [`commands::engine`](crate::commands::engine). The engine
//! is the default save path for non-signed PDFs; pd-lib remains as a
//! fallback when bake returns an error.

pub mod bake;
pub mod fonts;
pub mod linearize;
pub mod render;
pub mod render_cache;
pub mod render_pool;
pub mod render_thread;
pub mod text_rewrite;
pub mod types;
pub mod writer;

pub use bake::bake_edit_model;
pub use fonts::{
    extract_fonts_for_page, extract_fonts_from_bytes, ExtractedFont, ExtractedFontFormat,
};
pub use render::{
    list_page_text_objects, page_count, render_page_to_png, render_page_to_png_with_skips,
    render_page_to_png_with_skips_from_bytes, PageTextObjectInfo, SkipBbox,
};
pub use text_rewrite::{list_page_text_runs, rewrite_text_edits_in_place};
pub use types::{IncrementalPatch, WriteSummary};
pub use writer::write_incremental;
