// Data model for the live-edit session.
//
// Mirrors the shape of the frontend's `_paragraphEdits` exactly so the
// existing serializer can consume it unchanged. EditModel is canonical
// persistence state; Op is the granular change unit used for the op log,
// undo/redo, and for crash-recovery replay.
//
// See docs/LIVE-EDIT-PLAN.md for the design.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub type Bbox = BboxStruct;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct BboxStruct {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PositionDelta {
    pub dx: f32,
    pub dy: f32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TextAlign {
    Left,
    Center,
    Right,
    Justify,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ParagraphEdit {
    #[serde(rename = "paragraphId")]
    pub paragraph_id: String,
    pub bbox: Bbox,
    #[serde(default, rename = "maskBbox", skip_serializing_if = "Option::is_none")]
    pub mask_bbox: Option<Bbox>,
    #[serde(rename = "originalText")]
    pub original_text: String,
    #[serde(rename = "newText")]
    pub new_text: String,
    #[serde(rename = "fontSize")]
    pub font_size: f32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(
        default,
        rename = "backgroundColor",
        skip_serializing_if = "Option::is_none"
    )]
    pub background_color: Option<String>,
    #[serde(
        default,
        rename = "fontFamily",
        skip_serializing_if = "Option::is_none"
    )]
    pub font_family: Option<String>,
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub italic: bool,
    #[serde(default)]
    pub underline: bool,
    #[serde(default, rename = "strikethrough")]
    pub strikethrough: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub align: Option<TextAlign>,
    #[serde(
        default,
        rename = "lineHeight",
        skip_serializing_if = "Option::is_none"
    )]
    pub line_height: Option<f32>,
    #[serde(default, rename = "itemIndices", skip_serializing_if = "Vec::is_empty")]
    pub item_indices: Vec<u32>,
    #[serde(
        default,
        rename = "itemOriginalTexts",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub item_original_texts: Vec<String>,
    #[serde(
        default,
        rename = "positionDelta",
        skip_serializing_if = "Option::is_none"
    )]
    pub position_delta: Option<PositionDelta>,
    /// G2: opaque key into [`EditModel::embedded_fonts`]. When set, the
    /// bake stage routes this edit through the embedded TrueType path
    /// (Type0 + CIDFontType2 + Identity-H CID encoding) instead of the
    /// Standard 14 Type1 path. Frontend computes the key per
    /// (family, bold, italic) tuple — e.g. `"calibri-regular"`,
    /// `"calibri-bold"`. None → falls through to Standard 14 family
    /// detection.
    #[serde(
        default,
        rename = "customFontId",
        skip_serializing_if = "Option::is_none"
    )]
    pub custom_font_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct PageEdits {
    #[serde(default)]
    pub paragraphs: Vec<ParagraphEdit>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct EditModel {
    /// SHA-256 of the original PDF bytes at session open. Kept as hex
    /// so JSON serialization stays human-inspectable.
    #[serde(rename = "sourceHash")]
    pub source_hash: String,
    #[serde(default)]
    pub pages: HashMap<u32, PageEdits>,
    #[serde(default)]
    pub version: u64,
    /// G2: pool of embedded TrueType font payloads, keyed by the
    /// `custom_font_id` set on each edit. The bake stage looks up the
    /// payload here, parses its TTF tables, encodes text as 2-byte
    /// CIDs (Identity-H), and hands the bytes off to the writer for
    /// /FontFile2 emission.
    ///
    /// Frontend pre-resolves each unique non-Standard-14
    /// (family, bold, italic) tuple via `pdfFontResolution.resolveSystemFont`
    /// then `font_subset` (the Tauri Typst-subsetter command) before
    /// packing the bytes here.
    ///
    /// Empty / missing → bake operates in Standard-14-only mode.
    #[serde(default, rename = "embeddedFonts")]
    pub embedded_fonts: HashMap<String, EmbeddedFont>,
}

/// G2: serialization-friendly form of an embedded font payload that
/// rides inside [`EditModel`]. Mirrors
/// [`crate::pdf_engine::types::EmbeddedFontPayload`] but lives in
/// `live::model` because EditModel is the canonical session-state
/// type. Bake converts these to the writer-side payload before
/// emitting the /FontFile2 chain.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EmbeddedFont {
    /// TrueType bytes — already subsetted by `font_subset` so the
    /// payload is the smallest valid font that maps every codepoint
    /// the edits using this font_id touch.
    pub bytes: Vec<u8>,
    /// PostScript-style font name to use as `/BaseFont` (with or
    /// without the AAAAAA+ subset prefix; writer normalizes).
    #[serde(rename = "postscriptName")]
    pub postscript_name: String,
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub italic: bool,
}

/// The granular change units that flow from the frontend to Rust.
/// Applied to EditModel one at a time; captured in the op log for
/// undo/redo + crash-recovery replay.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Op {
    /// Create or replace a paragraph-edit entry wholesale. Used on the
    /// first keystroke into a paragraph and after undo re-enters a
    /// paragraph that had been deleted.
    UpsertEdit { page: u32, edit: ParagraphEdit },
    /// Remove a paragraph-edit entry (text reverted to original).
    DropEdit {
        page: u32,
        #[serde(rename = "paragraphId")]
        paragraph_id: String,
    },
    /// Replace all paragraph edits on a page with the given list.
    /// Issued by the frontend in batches during undo/redo — simpler
    /// than reconstructing individual ops from a before/after snapshot.
    ReplacePage {
        page: u32,
        edits: Vec<ParagraphEdit>,
    },
}

/// An entry in the append-only op log. `undo_boundary=true` marks the
/// end of a logical undo unit per the user's preference setting.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    pub version: u64,
    pub op: Op,
    #[serde(default, rename = "undoBoundary")]
    pub undo_boundary: bool,
    /// Unix epoch seconds.
    pub timestamp: u64,
}

impl EditModel {
    pub fn apply(&mut self, op: &Op) {
        match op {
            Op::UpsertEdit { page, edit } => {
                let entry = self.pages.entry(*page).or_default();
                if let Some(slot) = entry
                    .paragraphs
                    .iter_mut()
                    .find(|p| p.paragraph_id == edit.paragraph_id)
                {
                    *slot = edit.clone();
                } else {
                    entry.paragraphs.push(edit.clone());
                }
            }
            Op::DropEdit { page, paragraph_id } => {
                if let Some(entry) = self.pages.get_mut(page) {
                    entry.paragraphs.retain(|p| &p.paragraph_id != paragraph_id);
                }
            }
            Op::ReplacePage { page, edits } => {
                let entry = self.pages.entry(*page).or_default();
                entry.paragraphs = edits.clone();
            }
        }
    }

    /// Rebuild a model from a replay of its op log.
    pub fn from_ops(source_hash: String, ops: impl IntoIterator<Item = LogEntry>) -> Self {
        let mut model = EditModel {
            source_hash,
            ..Default::default()
        };
        let mut last_version = 0u64;
        for entry in ops {
            model.apply(&entry.op);
            last_version = last_version.max(entry.version);
        }
        model.version = last_version;
        model
    }

    pub fn is_empty(&self) -> bool {
        self.pages.values().all(|p| p.paragraphs.is_empty())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_edit(id: &str, text: &str) -> ParagraphEdit {
        ParagraphEdit {
            paragraph_id: id.to_string(),
            bbox: Bbox {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 20.0,
            },
            mask_bbox: None,
            original_text: "original".to_string(),
            new_text: text.to_string(),
            font_size: 12.0,
            color: None,
            background_color: None,
            font_family: None,
            bold: false,
            italic: false,
            underline: false,
            strikethrough: false,
            align: None,
            line_height: None,
            item_indices: vec![],
            item_original_texts: vec![],
            position_delta: None,
            custom_font_id: None,
        }
    }

    #[test]
    fn upsert_then_drop_works() {
        let mut m = EditModel::default();
        m.apply(&Op::UpsertEdit {
            page: 0,
            edit: sample_edit("p1", "hello"),
        });
        assert_eq!(m.pages.get(&0).unwrap().paragraphs.len(), 1);
        m.apply(&Op::DropEdit {
            page: 0,
            paragraph_id: "p1".to_string(),
        });
        assert_eq!(m.pages.get(&0).unwrap().paragraphs.len(), 0);
    }

    #[test]
    fn upsert_replaces_existing_by_id() {
        let mut m = EditModel::default();
        m.apply(&Op::UpsertEdit {
            page: 0,
            edit: sample_edit("p1", "v1"),
        });
        m.apply(&Op::UpsertEdit {
            page: 0,
            edit: sample_edit("p1", "v2"),
        });
        let ps = &m.pages.get(&0).unwrap().paragraphs;
        assert_eq!(ps.len(), 1);
        assert_eq!(ps[0].new_text, "v2");
    }

    #[test]
    fn replace_page_overwrites_all_edits() {
        let mut m = EditModel::default();
        m.apply(&Op::UpsertEdit {
            page: 0,
            edit: sample_edit("p1", "a"),
        });
        m.apply(&Op::UpsertEdit {
            page: 0,
            edit: sample_edit("p2", "b"),
        });
        m.apply(&Op::ReplacePage {
            page: 0,
            edits: vec![sample_edit("p3", "c")],
        });
        let ps = &m.pages.get(&0).unwrap().paragraphs;
        assert_eq!(ps.len(), 1);
        assert_eq!(ps[0].paragraph_id, "p3");
    }

    #[test]
    fn from_ops_replays_correctly() {
        let ops = vec![
            LogEntry {
                version: 1,
                op: Op::UpsertEdit {
                    page: 0,
                    edit: sample_edit("p1", "x"),
                },
                undo_boundary: false,
                timestamp: 0,
            },
            LogEntry {
                version: 2,
                op: Op::UpsertEdit {
                    page: 0,
                    edit: sample_edit("p1", "y"),
                },
                undo_boundary: true,
                timestamp: 0,
            },
        ];
        let m = EditModel::from_ops("hash".into(), ops);
        assert_eq!(m.version, 2);
        assert_eq!(m.source_hash, "hash");
        assert_eq!(m.pages.get(&0).unwrap().paragraphs[0].new_text, "y");
    }
}
