//! Live-edit data model, ported from the shell's `live::model`
//! (src-tauri/src/live/model.rs) — the canonical persistence state
//! and the granular `Op` change unit.
//!
//! Serde shapes match the shell types field-for-field (same renames,
//! same defaults) so frontend payloads and existing session logs
//! parse unchanged. One DELIBERATE behavioral divergence, flagged in
//! `docs/storm/UNDO-UNIFICATION.md`: [`EditModel::apply`] here keeps
//! the model canonical by dropping page entries whose paragraph list
//! becomes empty. The shell's copy leaves empty `PageEdits` behind,
//! which makes "apply then invert" non-identical to the initial
//! state — a property the core's inversion-based undo (see
//! [`crate::ops::log`]) needs to hold exactly.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Axis-aligned box in page space (CSS-style top-left origin, like
/// the frontend's paragraph boxes).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Bbox {
    /// Left edge.
    pub x: f32,
    /// Top edge.
    pub y: f32,
    /// Width.
    pub width: f32,
    /// Height.
    pub height: f32,
}

/// Offset applied to a paragraph after an explicit user move.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PositionDelta {
    /// Horizontal offset.
    pub dx: f32,
    /// Vertical offset.
    pub dy: f32,
}

/// Paragraph text alignment.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TextAlign {
    /// Left-aligned.
    Left,
    /// Centered.
    Center,
    /// Right-aligned.
    Right,
    /// Justified.
    Justify,
}

/// One paragraph-level edit — mirrors the frontend's
/// `_paragraphEdits` entry shape exactly.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ParagraphEdit {
    /// Stable paragraph id (position-based, from the clusterer).
    #[serde(rename = "paragraphId")]
    pub paragraph_id: String,
    /// The paragraph's bounding box.
    pub bbox: Bbox,
    /// Optional mask region painted over the original text.
    #[serde(default, rename = "maskBbox", skip_serializing_if = "Option::is_none")]
    pub mask_bbox: Option<Bbox>,
    /// Text as clustered from the source document.
    #[serde(rename = "originalText")]
    pub original_text: String,
    /// Replacement text.
    #[serde(rename = "newText")]
    pub new_text: String,
    /// Font size in points.
    #[serde(rename = "fontSize")]
    pub font_size: f32,
    /// Text color (hex), when overridden.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Mask/background color (hex), when overridden.
    #[serde(
        default,
        rename = "backgroundColor",
        skip_serializing_if = "Option::is_none"
    )]
    pub background_color: Option<String>,
    /// Font family, when overridden.
    #[serde(
        default,
        rename = "fontFamily",
        skip_serializing_if = "Option::is_none"
    )]
    pub font_family: Option<String>,
    /// Bold flag.
    #[serde(default)]
    pub bold: bool,
    /// Italic flag.
    #[serde(default)]
    pub italic: bool,
    /// Underline flag.
    #[serde(default)]
    pub underline: bool,
    /// Strikethrough flag.
    #[serde(default, rename = "strikethrough")]
    pub strikethrough: bool,
    /// Alignment, when overridden.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub align: Option<TextAlign>,
    /// Line height multiplier, when overridden.
    #[serde(
        default,
        rename = "lineHeight",
        skip_serializing_if = "Option::is_none"
    )]
    pub line_height: Option<f32>,
    /// pdfjs item indices backing this paragraph.
    #[serde(default, rename = "itemIndices", skip_serializing_if = "Vec::is_empty")]
    pub item_indices: Vec<u32>,
    /// Original text per backing item.
    #[serde(
        default,
        rename = "itemOriginalTexts",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub item_original_texts: Vec<String>,
    /// Offset from an explicit user move.
    #[serde(
        default,
        rename = "positionDelta",
        skip_serializing_if = "Option::is_none"
    )]
    pub position_delta: Option<PositionDelta>,
    /// Key into [`EditModel::embedded_fonts`] routing this edit
    /// through the embedded-TrueType bake path.
    #[serde(
        default,
        rename = "customFontId",
        skip_serializing_if = "Option::is_none"
    )]
    pub custom_font_id: Option<String>,
}

/// All paragraph edits on one page.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct PageEdits {
    /// The edits, in application order.
    #[serde(default)]
    pub paragraphs: Vec<ParagraphEdit>,
}

/// Embedded font payload riding inside [`EditModel`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EmbeddedFont {
    /// Subsetted TrueType bytes.
    pub bytes: Vec<u8>,
    /// PostScript name for `/BaseFont`.
    #[serde(rename = "postscriptName")]
    pub postscript_name: String,
    /// Bold flag.
    #[serde(default)]
    pub bold: bool,
    /// Italic flag.
    #[serde(default)]
    pub italic: bool,
}

/// Canonical edit-session state: everything needed to bake the
/// user's edits into the document.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct EditModel {
    /// SHA-256 (hex) of the source document bytes at session open.
    #[serde(rename = "sourceHash")]
    pub source_hash: String,
    /// Per-page edits. Canonical invariant: no entry has an empty
    /// paragraph list (see module docs).
    #[serde(default)]
    pub pages: HashMap<u32, PageEdits>,
    /// Version of the last applied op.
    #[serde(default)]
    pub version: u64,
    /// Embedded font payloads keyed by `custom_font_id`.
    #[serde(default, rename = "embeddedFonts")]
    pub embedded_fonts: HashMap<String, EmbeddedFont>,
}

/// The granular change unit. Applied one at a time; logged for
/// undo/redo and crash-recovery replay.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Op {
    /// Create or replace one paragraph edit wholesale.
    UpsertEdit {
        /// Zero-based page index.
        page: u32,
        /// The edit payload. Boxed: the log stores ops by the
        /// thousands and the other variants are pointer-sized
        /// (clippy::large_enum_variant). Serde sees through the Box —
        /// wire shape is unchanged from the shell's `live::model`.
        edit: Box<ParagraphEdit>,
    },
    /// Remove one paragraph edit (text reverted to original).
    DropEdit {
        /// Zero-based page index.
        page: u32,
        /// Id of the edit to remove.
        #[serde(rename = "paragraphId")]
        paragraph_id: String,
    },
    /// Replace all paragraph edits on a page.
    ReplacePage {
        /// Zero-based page index.
        page: u32,
        /// The page's complete new edit list.
        edits: Vec<ParagraphEdit>,
    },
}

impl EditModel {
    /// Apply one op. Keeps the model canonical: a page entry whose
    /// paragraph list would become empty is removed entirely.
    pub fn apply(&mut self, op: &Op) {
        match op {
            Op::UpsertEdit { page, edit } => {
                let entry = self.pages.entry(*page).or_default();
                if let Some(slot) = entry
                    .paragraphs
                    .iter_mut()
                    .find(|p| p.paragraph_id == edit.paragraph_id)
                {
                    *slot = (**edit).clone();
                } else {
                    entry.paragraphs.push((**edit).clone());
                }
            }
            Op::DropEdit { page, paragraph_id } => {
                if let Some(entry) = self.pages.get_mut(page) {
                    entry.paragraphs.retain(|p| &p.paragraph_id != paragraph_id);
                    if entry.paragraphs.is_empty() {
                        self.pages.remove(page);
                    }
                }
            }
            Op::ReplacePage { page, edits } => {
                if edits.is_empty() {
                    self.pages.remove(page);
                } else {
                    self.pages.insert(
                        *page,
                        PageEdits {
                            paragraphs: edits.clone(),
                        },
                    );
                }
            }
        }
    }

    /// Look up the current edit for `paragraph_id` on `page`.
    pub fn find_edit(&self, page: u32, paragraph_id: &str) -> Option<&ParagraphEdit> {
        self.pages
            .get(&page)?
            .paragraphs
            .iter()
            .find(|p| p.paragraph_id == paragraph_id)
    }

    /// True when no page carries any edit.
    pub fn is_empty(&self) -> bool {
        self.pages.values().all(|p| p.paragraphs.is_empty())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn sample_edit(id: &str, text: &str) -> ParagraphEdit {
        ParagraphEdit {
            paragraph_id: id.to_string(),
            bbox: Bbox {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 20.0,
            },
            original_text: "original".to_string(),
            new_text: text.to_string(),
            font_size: 12.0,
            ..Default::default()
        }
    }

    #[test]
    fn upsert_then_drop_removes_empty_page_entry() {
        let mut m = EditModel::default();
        m.apply(&Op::UpsertEdit {
            page: 0,
            edit: Box::new(sample_edit("p1", "hello")),
        });
        assert_eq!(m.pages.get(&0).unwrap().paragraphs.len(), 1);
        m.apply(&Op::DropEdit {
            page: 0,
            paragraph_id: "p1".to_string(),
        });
        // Canonical form: the page entry is GONE, not empty.
        assert!(m.pages.is_empty());
        assert_eq!(m, EditModel::default());
    }

    #[test]
    fn upsert_replaces_existing_by_id() {
        let mut m = EditModel::default();
        m.apply(&Op::UpsertEdit {
            page: 0,
            edit: Box::new(sample_edit("p1", "v1")),
        });
        m.apply(&Op::UpsertEdit {
            page: 0,
            edit: Box::new(sample_edit("p1", "v2")),
        });
        let ps = &m.pages.get(&0).unwrap().paragraphs;
        assert_eq!(ps.len(), 1);
        assert_eq!(ps[0].new_text, "v2");
    }

    #[test]
    fn replace_page_with_empty_list_removes_entry() {
        let mut m = EditModel::default();
        m.apply(&Op::UpsertEdit {
            page: 0,
            edit: Box::new(sample_edit("p1", "a")),
        });
        m.apply(&Op::ReplacePage {
            page: 0,
            edits: vec![],
        });
        assert!(m.pages.is_empty());
    }

    #[test]
    fn serde_wire_shape_matches_shell_model() {
        // Field renames must stay identical to live::model so the
        // frontend payloads parse unchanged after the migration.
        let op = Op::UpsertEdit {
            page: 2,
            edit: Box::new(sample_edit("p_0_10_20", "x")),
        };
        let json = serde_json::to_value(&op).unwrap();
        assert_eq!(json["type"], "upsert_edit");
        assert_eq!(json["page"], 2);
        assert_eq!(json["edit"]["paragraphId"], "p_0_10_20");
        assert_eq!(json["edit"]["originalText"], "original");
        assert_eq!(json["edit"]["newText"], "x");
        assert_eq!(json["edit"]["fontSize"], 12.0);
        // Skipped-when-default fields must actually be skipped.
        assert!(json["edit"].get("maskBbox").is_none());
        assert!(json["edit"].get("positionDelta").is_none());
    }
}
