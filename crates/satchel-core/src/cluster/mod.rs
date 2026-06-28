//! Paragraph clustering + layout intelligence — the core port of the
//! frontend's `pdfParagraphs.ts` (`clusterParagraphs`) and
//! `pdfLayoutIntelligence.ts` (`classifyPdfParagraphLayouts`).
//!
//! The TS implementation consumes pdfjs text items; this port
//! consumes core-owned [`types::TextItem`]s produced by an
//! extraction backend (pdfium via `satchel-pdfium` today). The
//! algorithm is ported signal-for-signal with the same defaults; the
//! differential harness (`scripts/storm/cluster-differential.mjs`)
//! measures parity against the living TS oracle over the corpus.
//!
//! Rotation: extraction backends normalize `/Rotate` 90/180/270 into
//! VISUAL page space ([`types::TextItem`] coordinates are always
//! top-left-origin of the page as displayed), so — unlike the
//! WebView pipeline, which gates rotated pages as unsafe — this
//! pipeline's geometry is simply correct on rotated pages.

pub mod algorithm;
pub mod layout;
pub mod types;

pub use algorithm::{cluster_paragraphs, ClusteringOptions};
pub use layout::classify_layouts;
pub use types::{DetectedAlign, Line, PageContext, ParagraphBox, ParagraphLayout, TextItem};
