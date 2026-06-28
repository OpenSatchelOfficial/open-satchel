//! Core-owned types for text extraction and paragraph clustering.

use serde::{Deserialize, Serialize};

/// One extracted text run, in VISUAL page space (top-left origin,
/// y grows downward, units = PDF points at scale 1 — i.e. what the
/// page looks like after `/Rotate` is applied).
///
/// Mirrors the fields of a pdfjs text item that the TS clusterer
/// actually consumes; extraction backends (pdfium) group raw glyphs
/// into these.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextItem {
    /// The run's text.
    pub text: String,
    /// Left edge of the run.
    pub x: f64,
    /// Baseline y, measured downward from the page top (the TS
    /// equivalent is `pageHeight - transform[5]`).
    #[serde(rename = "baselineY")]
    pub baseline_y: f64,
    /// Advance width of the run.
    pub width: f64,
    /// Font size in points.
    #[serde(rename = "fontSize")]
    pub font_size: f64,
    /// Font name as reported by the backend (may carry a subset
    /// prefix like `ABCDEF+Calibri-Bold`).
    #[serde(rename = "fontName")]
    pub font_name: String,
    /// True when a hard line break follows this run (pdfjs
    /// `hasEOL`).
    #[serde(rename = "hasEOL")]
    pub has_eol: bool,
}

/// Page-level context for clustering + classification.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct PageContext {
    /// Zero-based page index (used in paragraph ids).
    pub page_index: u32,
    /// Visual page width (post-rotation) at scale 1.
    pub page_width: f64,
    /// Visual page height (post-rotation) at scale 1.
    pub page_height: f64,
}

/// One visual line inside a paragraph.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Line {
    /// Top y of the line.
    pub y: f64,
    /// Median font size of the line's items.
    #[serde(rename = "fontSize")]
    pub font_size: f64,
    /// Concatenated text of the line.
    pub text: String,
    /// Indices into the input `TextItem` slice.
    #[serde(rename = "itemIndices")]
    pub item_indices: Vec<usize>,
    /// Left edge.
    pub x: f64,
    /// Width.
    pub width: f64,
}

/// Axis-aligned bounding box (visual space, top-left origin).
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct Rect {
    /// Left edge.
    pub x: f64,
    /// Top edge.
    pub y: f64,
    /// Width.
    pub width: f64,
    /// Height.
    pub height: f64,
}

/// A clustered paragraph — the port of the TS `ParagraphBox`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParagraphBox {
    /// Position-based reproducible id (`p_<page>_<x>_<y>`).
    pub id: String,
    /// Indices into the input `TextItem` slice.
    #[serde(rename = "itemIndices")]
    pub item_indices: Vec<usize>,
    /// The paragraph's lines, top-down.
    pub lines: Vec<Line>,
    /// Union bounding box.
    pub bbox: Rect,
    /// Full text (lines joined with `\n`).
    #[serde(rename = "originalText")]
    pub original_text: String,
    /// Median font size.
    #[serde(rename = "fontSize")]
    pub font_size: f64,
    /// Most common font name among items.
    #[serde(rename = "fontName")]
    pub font_name: String,
    /// Normalized CSS-ish font family stack.
    #[serde(rename = "fontFamily")]
    pub font_family: String,
    /// Bold heuristic (name regex or heading-size).
    pub bold: bool,
    /// Italic heuristic (name regex).
    pub italic: bool,
    /// Layout classification (filled by
    /// [`classify_layouts`](crate::cluster::classify_layouts)).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layout: Option<ParagraphLayout>,
}

/// Layout role taxonomy — port of `PdfLayoutRole`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LayoutRole {
    /// Default prose flow.
    SingleColumnBody,
    /// Text inside a detected column band.
    MultiColumn,
    /// Page-top furniture.
    Header,
    /// Page-bottom furniture.
    Footer,
    /// Bulleted/numbered list item.
    ListItem,
    /// Cell in an aligned row/column grid.
    TableCell,
    /// Invoice label/value or amount row.
    InvoicePair,
    /// Form-like label or blank-field marker.
    FormField,
    /// Signature/certification wording.
    SignatureArea,
    /// Repeated page furniture (page numbers etc.).
    RepeatedFurniture,
    /// Same-baseline peer without a safe flow structure.
    Ambiguous,
}

impl LayoutRole {
    /// Stable snake_case name (matches the TS string union).
    pub fn as_str(&self) -> &'static str {
        match self {
            LayoutRole::SingleColumnBody => "single_column_body",
            LayoutRole::MultiColumn => "multi_column",
            LayoutRole::Header => "header",
            LayoutRole::Footer => "footer",
            LayoutRole::ListItem => "list_item",
            LayoutRole::TableCell => "table_cell",
            LayoutRole::InvoicePair => "invoice_pair",
            LayoutRole::FormField => "form_field",
            LayoutRole::SignatureArea => "signature_area",
            LayoutRole::RepeatedFurniture => "repeated_furniture",
            LayoutRole::Ambiguous => "ambiguous",
        }
    }
}

/// Detected paragraph alignment (Session 5, R5a) — port of
/// `PdfDetectedAlign`. TRI-STATE by contract (gate-2 P1): `Left` is
/// emitted only on POSITIVE evidence (flush to the measure's left /
/// shared left edges); `None`/absent means UNKNOWN (no measure, weak
/// evidence, indented geometry) — never silently rebranded as left.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DetectedAlign {
    /// Positive left evidence (flush left anchor / shared left edges).
    Left,
    /// Line centers share the measure's center.
    Center,
    /// Lines share a flush right edge away from the measure's left.
    Right,
    /// Non-last lines fill the measure flush to both edges.
    Justify,
}

/// Conservative layout/safety classification — port of
/// `PdfParagraphLayout`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParagraphLayout {
    /// The detected role.
    pub role: LayoutRole,
    /// Whether opt-in auto-layout may move this paragraph.
    #[serde(rename = "safeForAutoReflow")]
    pub safe_for_auto_reflow: bool,
    /// Classifier confidence in (0, 1].
    pub confidence: f64,
    /// Human-readable reasons, first = primary.
    pub reasons: Vec<String>,
    /// Flow membership id (column flows, body).
    #[serde(rename = "flowId", skip_serializing_if = "Option::is_none")]
    pub flow_id: Option<String>,
    /// Column index inside a multi-column region.
    #[serde(rename = "columnIndex", skip_serializing_if = "Option::is_none")]
    pub column_index: Option<usize>,
    /// Row-group index on the page.
    #[serde(rename = "rowIndex", skip_serializing_if = "Option::is_none")]
    pub row_index: Option<usize>,
    /// True for repeated page furniture.
    #[serde(rename = "repeatedFurniture", skip_serializing_if = "Option::is_none")]
    pub repeated_furniture: Option<bool>,
    /// Detected alignment (Session 5, R5a). Present only when
    /// confidently non-left — mirrors the TS classifier exactly.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub align: Option<DetectedAlign>,
}
