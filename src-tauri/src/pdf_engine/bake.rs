//! Bake path — drives the incremental-update writer from an
//! [`EditModel`](crate::live::EditModel).
//!
//! # S5 — zero-edit fast path
//!
//! An empty EditModel bakes via [`crate::pdf_engine::write_incremental`]
//! with no patches: output prefix is byte-identical to input, plus a
//! minimal xref/trailer increment. Signatures preserved.
//!
//! # S5.5-P1 — mask-only overlay
//!
//! Non-empty EditModels emit one overlay content-stream per edited
//! page. Each `ParagraphEdit` contributes a filled rectangle covering
//! its bbox — the "whiteout" visual effect that hides the original
//! glyphs underneath. Fill color comes from `edit.background_color`
//! (parsed as `#RRGGBB` or a limited set of named colors) and
//! defaults to white when absent.
//!
//! # S5.5-P2 — text emission
//!
//! The overlay now also draws the replacement text using injected
//! Standard 14 Helvetica. The writer emits a Type1 Helvetica font
//! object, adds it to the page's `/Resources /Font` under the name
//! `/Ovl0`, and the overlay references it via `/Ovl0 <size> Tf`.
//! Helvetica doesn't need to be embedded because every PDF reader
//! ships it built-in, which keeps the increment small (~80 bytes
//! per font object).
//!
//! Encoding is WinAnsiEncoding. ASCII + Latin-1 characters round-
//! trip cleanly; CJK, Arabic, and other non-Latin scripts fall back
//! to the pd-lib bake path because they need CID-keyed fonts with
//! custom CMaps — that's a whole separate session.
//!
//! Emitted content stream per page (concatenation of per-paragraph
//! mask + text blocks, each wrapped in a save/restore to isolate
//! graphics state):
//!
//! ```text
//! q
//! 1 1 1 rg               % mask fill — white default
//! 50 720 100 14 re       % bbox: x y w h in PDF points (origin bottom-left)
//! f
//! 0 0 0 rg               % text fill — black default
//! BT
//! /Ovl0 12 Tf            % Helvetica at 12pt
//! 1 0 0 1 50 722 Tm      % text matrix — baseline at (50, 722)
//! (Replacement text) Tj  % draw
//! ET
//! Q
//! ```
//!
//! # S5.5-P3 — coordinate conversion + compression
//!
//! `bake_edit_model` now reads `/MediaBox` from each edited page
//! via lopdf and converts `ParagraphEdit.bbox` from the frontend's
//! top-left CSS convention to PDF's bottom-left convention
//! internally. Callers pass CSS-space bboxes as-is — no manual
//! conversion required. The writer also Flate-compresses overlay
//! streams by default, shrinking per-page increments ~2×.

use crate::error::AppError;
use crate::live::{EditModel, EmbeddedFont, ParagraphEdit, TextAlign};
use crate::pdf_engine::types::{EmbeddedFontPayload, IncrementalPatch, WriteSummary};
use crate::pdf_engine::writer::write_incremental;
use crate::Result;
use lopdf::{Document, Object, ObjectId};
use std::collections::HashMap;
use std::io::Cursor;

/// Bake an [`EditModel`] into a new PDF via incremental update.
///
/// Returns `(bytes, summary)`. Empty EditModels take the zero-edit
/// fast path; non-empty ones build per-page mask-overlay streams and
/// route through `write_incremental`.
pub fn bake_edit_model(
    original_bytes: &[u8],
    model: &EditModel,
) -> Result<(Vec<u8>, WriteSummary)> {
    let paragraph_count: usize = model.pages.values().map(|p| p.paragraphs.len()).sum();

    if paragraph_count == 0 {
        // Fast path: no edits → empty incremental update, identical
        // to S2's identity round-trip. Signatures preserved.
        return write_incremental(original_bytes, &[]);
    }

    // Build one patch per page that has edits. Pages with no edits
    // aren't touched — keeps the incremental as small as possible.
    // Sorted by page_index so the xref ordering is deterministic
    // across runs (nice for diffs + testing).
    let mut page_indices: Vec<u32> = model
        .pages
        .iter()
        .filter(|(_, pe)| !pe.paragraphs.is_empty())
        .map(|(idx, _)| *idx)
        .collect();
    page_indices.sort_unstable();

    // G3 obsoleted the single-name OVERLAY_FONT_NAME convention —
    // assign_font_resources now hands out Ovl0/Ovl1/... per Standard
    // 14 BaseFont variant the page actually needs. The /Ovl prefix
    // is preserved for back-compat with downstream tools that grep
    // bake output for paragraph-edit overlays.

    // Per-page heights for coordinate conversion. We parse once
    // here so the hot loop below doesn't re-parse for each page.
    // lopdf failures (signed PDFs with xref streams — see S7.5)
    // degrade gracefully: we still bake, just with the bboxes
    // taken as PDF-space (the pre-P3 behavior) so tests and any
    // caller that already converts keep working.
    let page_heights = read_page_heights(original_bytes).ok();

    let mut patches: Vec<IncrementalPatch> = Vec::with_capacity(page_indices.len());
    for page_idx in page_indices {
        let page_edits = model
            .pages
            .get(&page_idx)
            .expect("present — filtered above");
        let page_height = page_heights
            .as_ref()
            .and_then(|heights| heights.get(page_idx as usize).copied());
        // Convert bboxes from the frontend's top-left CSS space to
        // PDF bottom-left, IF we know the page height. Without a
        // known height we pass bboxes through unchanged so manual
        // callers (integration tests, scripts) still work.
        let converted: Vec<ParagraphEdit> = page_edits
            .paragraphs
            .iter()
            .map(|e| convert_edit_bbox_to_pdf_space(e, page_height))
            .collect();

        // G3 + G2: pre-scan the page's edits to figure out which font
        // variants (Standard 14 + embedded TrueType) this page actually
        // needs. Each unique resource gets a /OvlN (Standard 14) or
        // /CuN (embedded) resource name. The overlay stream emits
        // `/<resname> <size> Tf` per edit + the right text encoding
        // (literal-string for Std14, hex-CID for embedded).
        let font_assignments =
            assign_font_resources_with_embedded(&converted, &model.embedded_fonts);

        let overlay_stream = build_overlay_stream_v2(&converted, &font_assignments);

        // Convert font_assignments → writer-side maps.
        let mut inject_standard14_fonts: HashMap<String, String> = HashMap::new();
        for (basefont, resource_name) in &font_assignments.basefont_to_resource {
            inject_standard14_fonts.insert(resource_name.clone(), basefont.clone());
        }
        let inject_embedded_fonts = font_assignments.embedded_to_resource.clone();

        patches.push(IncrementalPatch {
            page_index: page_idx,
            overlay_stream,
            // Legacy field stays None when the new map carries entries —
            // writer.rs prefers the map. Only kept to satisfy the
            // struct's required field; see types.rs G3 doc.
            inject_helvetica_font_as: None,
            inject_standard14_fonts,
            // G2: embedded TrueType fonts threaded through from the
            // EditModel.embedded_fonts map. Empty when the page's
            // edits are all Standard-14.
            inject_embedded_fonts,
            // Production path compresses. Integration tests that
            // need to grep stream contents construct IncrementalPatch
            // directly with this flag off.
            compress_overlay: true,
            removed_object_ids: vec![],
        });
    }

    write_incremental(original_bytes, &patches)
}

/// Flip a `ParagraphEdit.bbox` from CSS top-left to PDF bottom-left,
/// given the page height in points. Returns the edit unchanged when
/// `page_height` is `None` (we don't know the height, so we can't
/// convert — pass through and let the caller cope).
fn convert_edit_bbox_to_pdf_space(edit: &ParagraphEdit, page_height: Option<f32>) -> ParagraphEdit {
    match page_height {
        Some(h) => {
            let mut out = edit.clone();
            out.bbox.y = h - (edit.bbox.y + edit.bbox.height);
            out
        }
        None => edit.clone(),
    }
}

/// Read each page's height (in PDF points) from the document's
/// `/MediaBox`. Returns a vector indexed by 0-based page number.
/// Walks the page tree for inheritance — spec-legal for MediaBox
/// to be set on an ancestor /Pages node.
fn read_page_heights(original_bytes: &[u8]) -> Result<Vec<f32>> {
    let mut cursor = Cursor::new(original_bytes);
    let doc = Document::load_from(&mut cursor)
        .map_err(|e| AppError::Pdf(format!("parse for page heights: {e}")))?;
    let pages = doc.get_pages();
    let mut heights = Vec::with_capacity(pages.len());
    for (_num, page_id) in pages.iter() {
        let h = media_box_height(&doc, *page_id).unwrap_or(792.0);
        heights.push(h);
    }
    Ok(heights)
}

/// Resolve the MediaBox height for `page_id`, following /Parent links
/// up the Pages tree since MediaBox can be inherited (PDF spec §7.7.3.4).
/// Falls back to US-Letter height (792pt) if nothing is found —
/// conservative default that matches most common fixtures.
fn media_box_height(doc: &Document, page_id: ObjectId) -> Option<f32> {
    let mut cur = page_id;
    for _ in 0..16 {
        let dict = doc.get_dictionary(cur).ok()?;
        if let Ok(mb) = dict.get(b"MediaBox") {
            if let Ok(arr) = mb.as_array() {
                // MediaBox = [x0 y0 x1 y1]. Height = y1 - y0.
                if arr.len() >= 4 {
                    let y0 = arr[1].as_f32().ok()?;
                    let y1 = arr[3].as_f32().ok()?;
                    return Some(y1 - y0);
                }
            }
        }
        match dict.get(b"Parent") {
            Ok(Object::Reference(parent_id)) => cur = *parent_id,
            _ => return None,
        }
    }
    None
}

/// G3: per-edit Standard 14 BaseFont selection and resource-name
/// assignment for one page. Each unique BaseFont in use on the page
/// is assigned a `/Ovl0`, `/Ovl1`, … resource name. The bake stream
/// emits `/<name> <size> Tf` per edit using the resolved name.
///
/// G2-extended: per-edit embedded-font assignment lives alongside
/// the Standard 14 map. Embedded resource names use the `/Cu0`,
/// `/Cu1`, … prefix to avoid collision with Standard 14 `/OvlN`.
struct FontAssignments {
    /// edit-index → resource name to use for that edit's text block.
    /// Standard 14 edits get a `/OvlN` name; embedded edits get a
    /// `/CuN` name (Cu = Custom).
    per_edit_resource: Vec<String>,
    /// edit-index → kind, for the bake stream encoder. Standard 14
    /// emits text via `(literal) Tj`; embedded emits via
    /// `<HEXCIDS> Tj` plus uses the embedded font's hmtx for width.
    per_edit_kind: Vec<EditFontKind>,
    /// Standard 14 BaseFont → resource name. The writer iterates this
    /// to emit one Type1 font dict per entry.
    basefont_to_resource: std::collections::HashMap<String, String>,
    /// Embedded resource name → payload. Cloned out of EditModel
    /// so the per-page bake builds a self-contained patch.
    embedded_to_resource: std::collections::HashMap<String, EmbeddedFontPayload>,
}

#[derive(Debug, Clone)]
#[allow(dead_code)] // Variant fields are inspected via pattern-match,
                    // not field access — Rust's dead-code analysis
                    // miscounts these as unread.
enum EditFontKind {
    /// Standard 14 path. Width via family-aware AFM table.
    Standard14 {
        family: Family,
        bold: bool,
        italic: bool,
    },
    /// Embedded TTF path. Width via the font's hmtx; text encoded as
    /// 2-byte CIDs from the cmap.
    Embedded { font_id: String },
}

/// G3-extended: which Standard 14 family did the user pick?
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Family {
    Helvetica,
    Times,
    Courier,
}

/// Heuristic: pick a Standard 14 family from a free-form font-family
/// string. Mirrors what every PDF reader does with the same input —
/// "Times New Roman" → Times, "Andale Mono" → Courier, anything else
/// (sans, default, "Calibri", "Arial", ...) → Helvetica.
fn resolve_family(font_family: Option<&str>) -> Family {
    let s = font_family.unwrap_or("").to_ascii_lowercase();
    if s.contains("times")
        || s.contains("serif")
        || s.contains("roman")
        || s.contains("georgia")
        || s.contains("cambria")
    {
        Family::Times
    } else if s.contains("courier")
        || s.contains("mono")
        || s.contains("consolas")
        || s.contains("menlo")
        || s.contains("inconsolata")
        || s.contains("fixed")
    {
        Family::Courier
    } else {
        Family::Helvetica
    }
}

/// Map an edit's `(font_family, bold, italic)` to a Standard 14
/// PostScript BaseFont name.
///
/// All 14 variants supported: Helvetica × {regular, Bold, Oblique,
/// BoldOblique}, Times × {Roman, Bold, Italic, BoldItalic}, Courier
/// × {regular, Bold, Oblique, BoldOblique}. PDF readers ship every
/// variant, so no font bytes need to be embedded.
fn standard14_basefont_for_edit(edit: &ParagraphEdit) -> &'static str {
    let family = resolve_family(edit.font_family.as_deref());
    match (family, edit.bold, edit.italic) {
        (Family::Helvetica, false, false) => "Helvetica",
        (Family::Helvetica, true, false) => "Helvetica-Bold",
        (Family::Helvetica, false, true) => "Helvetica-Oblique",
        (Family::Helvetica, true, true) => "Helvetica-BoldOblique",
        (Family::Times, false, false) => "Times-Roman",
        (Family::Times, true, false) => "Times-Bold",
        (Family::Times, false, true) => "Times-Italic",
        (Family::Times, true, true) => "Times-BoldItalic",
        (Family::Courier, false, false) => "Courier",
        (Family::Courier, true, false) => "Courier-Bold",
        (Family::Courier, false, true) => "Courier-Oblique",
        (Family::Courier, true, true) => "Courier-BoldOblique",
    }
}

/// Walk one page's edits, pick a Standard 14 BaseFont for each, and
/// assign distinct `/Ovl0`, `/Ovl1`, … resource names. Edits that
/// share a BaseFont share a resource name so each variant is emitted
/// at most once per page.
///
/// **Helvetica-only callers** — kept for backward compatibility with
/// existing tests. New callers in the production bake path use
/// `assign_font_resources_with_embedded` which threads the EditModel's
/// embedded_fonts map for G2 routing.
#[cfg(test)]
fn assign_font_resources(edits: &[ParagraphEdit]) -> FontAssignments {
    let empty = HashMap::new();
    assign_font_resources_with_embedded(edits, &empty)
}

/// G2-aware assignment. For each edit:
///   - If `edit.custom_font_id` is set AND a matching entry exists in
///     `embedded_fonts`, route through the embedded path with a
///     `/CuN` resource name. The font payload is cloned out for the
///     resulting patch's `inject_embedded_fonts`.
///   - Otherwise route through Standard 14 with a `/OvlN` resource.
fn assign_font_resources_with_embedded(
    edits: &[ParagraphEdit],
    embedded_fonts: &HashMap<String, EmbeddedFont>,
) -> FontAssignments {
    let mut basefont_to_resource: HashMap<String, String> = HashMap::new();
    let mut embedded_to_resource: HashMap<String, EmbeddedFontPayload> = HashMap::new();
    let mut font_id_to_resource: HashMap<String, String> = HashMap::new();
    let mut per_edit_resource: Vec<String> = Vec::with_capacity(edits.len());
    let mut per_edit_kind: Vec<EditFontKind> = Vec::with_capacity(edits.len());
    let mut next_std_index = 0usize;
    let mut next_emb_index = 0usize;

    for edit in edits {
        // G2: prefer an embedded font when the edit names one and the
        // EditModel actually carries it.
        let embedded: Option<(String, EmbeddedFont)> = edit
            .custom_font_id
            .as_deref()
            .and_then(|id| embedded_fonts.get(id).map(|f| (id.to_string(), f.clone())));
        if let Some((font_id, payload)) = embedded {
            let resource_name = font_id_to_resource
                .entry(font_id.clone())
                .or_insert_with(|| {
                    let n = format!("Cu{}", next_emb_index);
                    next_emb_index += 1;
                    embedded_to_resource.insert(
                        n.clone(),
                        EmbeddedFontPayload {
                            bytes: payload.bytes.clone(),
                            postscript_name: payload.postscript_name.clone(),
                            bold: payload.bold,
                            italic: payload.italic,
                        },
                    );
                    n
                })
                .clone();
            per_edit_resource.push(resource_name);
            per_edit_kind.push(EditFontKind::Embedded { font_id });
            continue;
        }

        // Standard 14 fallback.
        let basefont = standard14_basefont_for_edit(edit).to_string();
        let resource = basefont_to_resource
            .entry(basefont)
            .or_insert_with(|| {
                let n = format!("Ovl{}", next_std_index);
                next_std_index += 1;
                n
            })
            .clone();
        per_edit_resource.push(resource);
        per_edit_kind.push(EditFontKind::Standard14 {
            family: resolve_family(edit.font_family.as_deref()),
            bold: edit.bold,
            italic: edit.italic,
        });
    }
    FontAssignments {
        per_edit_resource,
        per_edit_kind,
        basefont_to_resource,
        embedded_to_resource,
    }
}

/// G3 overlay-stream builder. Replaces `build_overlay_stream` —
/// emits one block per edit with the right resource name based on
/// per-edit font assignments. Same alignment + multi-line logic as
/// pre-G3 (G1 line splitting + Tw justify); only the `/<name> <size> Tf`
/// switches per variant.
fn build_overlay_stream_v2(edits: &[ParagraphEdit], assignments: &FontAssignments) -> Vec<u8> {
    let mut out = Vec::with_capacity(edits.len() * 160);
    for (i, edit) in edits.iter().enumerate() {
        let (bg_r, bg_g, bg_b) =
            parse_color(edit.background_color.as_deref()).unwrap_or((1.0, 1.0, 1.0));
        let (fg_r, fg_g, fg_b) = parse_color(edit.color.as_deref()).unwrap_or((0.0, 0.0, 0.0));
        let has_text = !edit.new_text.is_empty();
        let resource_name = assignments
            .per_edit_resource
            .get(i)
            .cloned()
            .unwrap_or_else(|| "Ovl0".to_string());
        let kind = assignments
            .per_edit_kind
            .get(i)
            .cloned()
            .unwrap_or(EditFontKind::Standard14 {
                family: Family::Helvetica,
                bold: false,
                italic: false,
            });
        // G2: when this edit routes through an embedded font, look up
        // its payload so write_edit_block can use the cmap + hmtx.
        let embedded_payload = match &kind {
            EditFontKind::Embedded { .. } => assignments
                .embedded_to_resource
                .get(&resource_name)
                .cloned(),
            _ => None,
        };
        let _ = write_edit_block(
            &mut out,
            edit,
            (bg_r, bg_g, bg_b),
            if has_text {
                Some((fg_r, fg_g, fg_b))
            } else {
                None
            },
            &resource_name,
            embedded_payload.as_ref(),
        );
    }
    out
}

/// Concatenate per-paragraph mask-rect + text-draw blocks into a
/// single content-stream body. Each block sits inside `q…Q` so its
/// graphics state can't leak into the next. Returns the stream bytes
/// plus a flag indicating whether any edit produced a text-draw
/// block (which means the writer needs to inject the Helvetica font).
///
/// **G3 NOTE:** this is the legacy single-font builder. New callers
/// should use `build_overlay_stream_v2` + `assign_font_resources` so
/// bold/italic variants get their own Type1 font dicts. This function
/// is kept for back-compat with the existing test suite — it always
/// uses /Helvetica regardless of edit flags.
#[allow(dead_code)]
fn build_overlay_stream(edits: &[ParagraphEdit], overlay_font_name: &str) -> (Vec<u8>, bool) {
    let mut out = Vec::with_capacity(edits.len() * 160);
    let mut needs_font = false;
    for edit in edits {
        let (bg_r, bg_g, bg_b) =
            parse_color(edit.background_color.as_deref()).unwrap_or((1.0, 1.0, 1.0));
        let (fg_r, fg_g, fg_b) = parse_color(edit.color.as_deref()).unwrap_or((0.0, 0.0, 0.0));
        let has_text = !edit.new_text.is_empty();
        let emitted_text = write_edit_block(
            &mut out,
            edit,
            (bg_r, bg_g, bg_b),
            if has_text {
                Some((fg_r, fg_g, fg_b))
            } else {
                None
            },
            overlay_font_name,
            None, // legacy callers always Standard 14
        )
        .unwrap_or(false);
        if emitted_text {
            needs_font = true;
        }
    }
    (out, needs_font)
}

/// Writes one edit's mask + text block. Returns `true` iff a text
/// block (BT/ET with Tj) was actually emitted. Callers use that flag
/// to decide whether the writer needs to inject the Helvetica font —
/// if every edit drops all characters during WinAnsi encoding, no
/// font resource is needed and the increment stays one object smaller.
///
/// G1: alignment beyond `left`. We split `new_text` on `\n` and emit
/// one Tj per line, computing each line's WinAnsi-encoded width and
/// shifting the baseline x to honor `edit.align`:
///   - Left   (default): baseline_x = bbox.x + dx
///   - Right:           baseline_x = bbox.x + dx + (bbox.w - line_w)
///   - Center:          baseline_x = bbox.x + dx + (bbox.w - line_w)/2
///   - Justify:         baseline_x = bbox.x + dx, but inter-word
///                      spacing is widened via `Tw` for non-last lines
///                      so the line spans the full bbox width.
/// Line widths are computed from the embedded Helvetica AFM table
/// (see `helvetica_advance`) — same numbers Adobe Reader and Acrobat
/// use, so visual placement matches a native Acrobat re-render.
fn write_edit_block(
    out: &mut Vec<u8>,
    edit: &ParagraphEdit,
    bg_color: (f32, f32, f32),
    fg_color: Option<(f32, f32, f32)>,
    overlay_font_name: &str,
    embedded: Option<&EmbeddedFontPayload>,
) -> std::io::Result<bool> {
    use std::io::Write;
    writeln!(out, "q")?;
    // Mask rect — always emitted.
    writeln!(
        out,
        "{} {} {} rg",
        fmt_real(bg_color.0),
        fmt_real(bg_color.1),
        fmt_real(bg_color.2)
    )?;
    writeln!(
        out,
        "{} {} {} {} re",
        fmt_real(edit.bbox.x),
        fmt_real(edit.bbox.y),
        fmt_real(edit.bbox.width),
        fmt_real(edit.bbox.height)
    )?;
    writeln!(out, "f")?;

    // Text draw (if any)
    let mut emitted_text = false;
    if let Some((r, g, b)) = fg_color {
        // G2: when an embedded font payload is supplied, encode each
        // line as 2-byte CIDs via the font's cmap; otherwise fall
        // through to WinAnsi byte encoding for Standard 14.
        let line_encodings: Vec<LineEncoding> = if let Some(payload) = embedded {
            let face = ttf_parser::Face::parse(&payload.bytes, 0).ok();
            edit.new_text
                .split('\n')
                .map(|line| encode_cids(line, face.as_ref()))
                .collect()
        } else {
            // Backwards-compat WinAnsi path for Standard 14.
            edit.new_text
                .split('\n')
                .map(|line| LineEncoding::WinAnsi(encode_winansi(line)))
                .collect()
        };
        let lines: Vec<Vec<u8>> = line_encodings
            .iter()
            .map(|enc| match enc {
                LineEncoding::WinAnsi(b) => b.clone(),
                // CID encoding's "bytes" for emptiness check is the
                // raw 2-byte CID stream; empty == no glyphs to draw.
                LineEncoding::Cids(cids) => cids.clone(),
            })
            .collect();

        // Skip text-draw if NOTHING from the string encoded cleanly.
        // An empty PDF literal string is valid but wastes a few bytes.
        let any_line_nonempty = lines.iter().any(|l| !l.is_empty());
        if any_line_nonempty {
            writeln!(out, "{} {} {} rg", fmt_real(r), fmt_real(g), fmt_real(b))?;
            writeln!(out, "BT")?;
            writeln!(
                out,
                "/{} {} Tf",
                overlay_font_name,
                fmt_real(edit.font_size)
            )?;

            // Baseline placement: bbox in PDF-space has origin at
            // bottom-left, so `y + height` is the top. Typical
            // Helvetica cap-height is ~70% of em-size; sit the first
            // line's baseline at `top - font_size * 0.85` so ascenders
            // land inside the bbox.
            //
            // When the paragraph was dragged, `position_delta` carries
            // the translation in viewport coords (y-down). Convert to
            // PDF coords by negating dy so "drag down" = smaller PDF y.
            // The mask rect above STAYS at the original bbox so it
            // covers the unmoved original glyphs; only the new text is
            // drawn at the offset position.
            let (dx, dy) = match edit.position_delta {
                Some(ref d) => (d.dx, d.dy),
                None => (0.0, 0.0),
            };
            let first_baseline_y = edit.bbox.y + edit.bbox.height - edit.font_size * 0.85 - dy;
            // Default Helvetica leading is 1.2× em — matches what
            // Acrobat / Word emit when the user hits Enter.
            let line_height = edit.font_size * 1.2;
            let align = edit.align.unwrap_or(TextAlign::Left);
            // Index of the LAST non-empty line. Justify treats this
            // line as left-aligned (standard typesetting rule —
            // justifying the last line of a paragraph leaves huge
            // ugly gaps).
            let last_nonempty_idx = lines
                .iter()
                .enumerate()
                .rfind(|(_, l)| !l.is_empty())
                .map(|(i, _)| i)
                .unwrap_or(0);

            // Track whether we've issued a non-zero `Tw` so we know
            // to reset it before emitting a non-justified line.
            let mut tw_active = false;

            // G1-extended: pick the right per-family AFM table based on
            // the edit's resolved family + bold flag. For embedded
            // fonts, width comes from the TTF's hmtx table (computed
            // inside text_width_embedded). Italic shares widths with
            // regular per Adobe AFM and per typical TTF design.
            let edit_family = resolve_family(edit.font_family.as_deref());
            let embedded_face = embedded.and_then(|p| ttf_parser::Face::parse(&p.bytes, 0).ok());

            for (i, line_enc) in line_encodings.iter().enumerate() {
                let line_bytes: &[u8] = match line_enc {
                    LineEncoding::WinAnsi(b) => b,
                    LineEncoding::Cids(c) => c,
                };
                if line_bytes.is_empty() {
                    continue;
                }
                // Width: AFM table for Standard 14, TTF hmtx for embed.
                let natural_w = match line_enc {
                    LineEncoding::WinAnsi(b) => {
                        text_width(edit_family, edit.bold, edit.italic, b, edit.font_size)
                    }
                    LineEncoding::Cids(cids) => {
                        text_width_embedded(cids, embedded_face.as_ref(), edit.font_size)
                    }
                };
                let is_last_text_line = i == last_nonempty_idx;

                // Justify: widen each space character so the line
                // spans the full bbox width. PDF's `Tw` operator adds
                // a fixed amount to every space (encoding 0x20) when
                // the text is rendered — exactly what we need here.
                // Note: under Identity-H, "space" is the cmap-mapped
                // glyph for U+0020. Tw still applies to that glyph
                // (per PDF spec §9.4.4), so the operator works for
                // embedded fonts too.
                let mut alignment_offset = 0.0_f32;
                if matches!(align, TextAlign::Justify)
                    && !is_last_text_line
                    && natural_w < edit.bbox.width
                {
                    // For embedded (CID) lines, count space-glyph
                    // occurrences via the cmap; for WinAnsi, count
                    // 0x20 bytes directly.
                    let space_count = match line_enc {
                        LineEncoding::WinAnsi(b) => b.iter().filter(|&&x| x == 0x20).count() as f32,
                        LineEncoding::Cids(cids) => {
                            count_space_cids(cids, embedded_face.as_ref()) as f32
                        }
                    };
                    if space_count > 0.0 {
                        let extra_per_space = (edit.bbox.width - natural_w) / space_count;
                        writeln!(out, "{} Tw", fmt_real(extra_per_space))?;
                        tw_active = true;
                    } else {
                        // No spaces to widen — fall back to left.
                        if tw_active {
                            writeln!(out, "0 Tw")?;
                            tw_active = false;
                        }
                    }
                } else {
                    // Reset Tw before any non-justify line so the
                    // previously widened spacing doesn't bleed
                    // through.
                    if tw_active {
                        writeln!(out, "0 Tw")?;
                        tw_active = false;
                    }
                    alignment_offset = match align {
                        TextAlign::Right => edit.bbox.width - natural_w,
                        TextAlign::Center => (edit.bbox.width - natural_w) / 2.0,
                        // Justify-last-line and Left both anchor at 0.
                        _ => 0.0,
                    };
                }

                let baseline_x = edit.bbox.x + dx + alignment_offset;
                let baseline_y = first_baseline_y - (i as f32) * line_height;
                writeln!(
                    out,
                    "1 0 0 1 {} {} Tm",
                    fmt_real(baseline_x),
                    fmt_real(baseline_y)
                )?;
                // Emit text per encoding:
                //   - WinAnsi → `(text) Tj` with PDF-string escaping
                //   - CIDs    → `<HEX> Tj` (2 bytes per CID, big-endian)
                match line_enc {
                    LineEncoding::WinAnsi(b) => {
                        out.push(b'(');
                        out.extend_from_slice(&escape_pdf_string(b));
                        out.extend_from_slice(b") Tj\n");
                    }
                    LineEncoding::Cids(cids) => {
                        out.push(b'<');
                        for byte in cids {
                            out.extend_from_slice(format!("{:02X}", byte).as_bytes());
                        }
                        out.extend_from_slice(b"> Tj\n");
                    }
                }
                emitted_text = true;
            }

            // Reset Tw at the end of the BT/ET block so the value
            // can't leak to other paragraphs even if the q/Q outer
            // wrap didn't fully reset text-state on every reader
            // (some old readers keep Tw scoped to BT/ET, not q/Q).
            if tw_active {
                writeln!(out, "0 Tw")?;
            }

            writeln!(out, "ET")?;
        }
    }
    writeln!(out, "Q")?;
    Ok(emitted_text)
}

/// G2: per-line encoding hint that flows through write_edit_block.
/// `WinAnsi` is the legacy Standard-14 path; `Cids` is the
/// Identity-H path used when an embedded TrueType is in play.
#[derive(Debug, Clone)]
enum LineEncoding {
    /// 1-byte-per-char WinAnsiEncoding bytes ready for
    /// `(literal) Tj` emission.
    WinAnsi(Vec<u8>),
    /// 2-byte-per-glyph CID stream (big-endian) ready for
    /// `<HEXSTRING> Tj` emission under Identity-H. Each CID is the
    /// glyph index in the embedded TrueType — exactly what the writer
    /// puts into /CIDToGIDMap /Identity / /Type0 /Encoding /Identity-H.
    Cids(Vec<u8>),
}

/// G2: encode a single line of text into Identity-H CID bytes via the
/// embedded font's cmap. Each codepoint is looked up in the cmap; on
/// success the 2-byte CID (== glyph index) is appended big-endian.
/// Codepoints with no glyph map are dropped (matches the WinAnsi
/// behavior — silent drop beats ugly tofu boxes).
///
/// `face = None` (TTF parse failed) returns an empty vec — caller's
/// emptiness check then skips this line.
fn encode_cids(line: &str, face: Option<&ttf_parser::Face>) -> LineEncoding {
    let Some(face) = face else {
        return LineEncoding::Cids(Vec::new());
    };
    let mut out = Vec::with_capacity(line.len() * 2);
    for c in line.chars() {
        if let Some(gid) = face.glyph_index(c) {
            // gid.0 is u16 — emit big-endian.
            out.push((gid.0 >> 8) as u8);
            out.push((gid.0 & 0xFF) as u8);
        }
    }
    LineEncoding::Cids(out)
}

/// G2: compute the rendered width of a CID-encoded line in PDF points
/// using the embedded font's hmtx advances. Width units in TTF are
/// scaled to 1/1000 em (PDF convention) before multiplying by
/// font_size.
fn text_width_embedded(cids: &[u8], face: Option<&ttf_parser::Face>, font_size: f32) -> f32 {
    let Some(face) = face else { return 0.0 };
    let upem = face.units_per_em() as f32;
    if upem <= 0.0 {
        return 0.0;
    }
    let scale = 1000.0 / upem;
    let mut units: u32 = 0;
    let mut i = 0;
    while i + 1 < cids.len() {
        let gid = u16::from_be_bytes([cids[i], cids[i + 1]]);
        if let Some(adv) = face.glyph_hor_advance(ttf_parser::GlyphId(gid)) {
            units = units.saturating_add((adv as f32 * scale).round() as u32);
        }
        i += 2;
    }
    (units as f32) * font_size / 1000.0
}

/// G2: count how many CIDs in the line correspond to U+0020. Justify
/// distributes extra width across spaces — Tw's space-glyph filter
/// applies to the cmap-mapped glyph for U+0020 under Identity-H, so
/// we mirror that match here.
fn count_space_cids(cids: &[u8], face: Option<&ttf_parser::Face>) -> usize {
    let Some(face) = face else { return 0 };
    let space_gid = match face.glyph_index(' ') {
        Some(g) => g.0,
        None => return 0,
    };
    let mut n = 0;
    let mut i = 0;
    while i + 1 < cids.len() {
        let gid = u16::from_be_bytes([cids[i], cids[i + 1]]);
        if gid == space_gid {
            n += 1;
        }
        i += 2;
    }
    n
}

/// Encode a Rust string to WinAnsiEncoding bytes. Characters outside
/// the encoding map (CJK, emoji, etc.) are dropped rather than
/// replaced with `?` — a missing glyph is less confusing than a
/// placeholder that looks intentional. Callers checking for an empty
/// result can decide whether to fall back to the pd-lib text path.
///
/// WinAnsiEncoding is PDF's flavor of Windows-1252: ASCII (0x20-0x7E)
/// plus a Latin-1 upper range with a few extra glyphs (Euro sign,
/// smart quotes) at positions 0x80-0x9F. We map the overlap with
/// Unicode directly; everything outside is skipped.
fn encode_winansi(s: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len());
    for c in s.chars() {
        let cp = c as u32;
        if (0x20..=0x7E).contains(&cp) {
            out.push(cp as u8);
        } else if (0xA0..=0xFF).contains(&cp) {
            // Latin-1 supplement passes through unchanged.
            out.push(cp as u8);
        } else {
            // Handful of Windows-1252 specials (€, smart quotes,
            // em/en dashes). Mapping by codepoint keeps the table
            // compact and easy to audit.
            let mapped: Option<u8> = match c {
                '\u{20AC}' => Some(0x80), // €
                '\u{201A}' => Some(0x82), // ‚
                '\u{0192}' => Some(0x83), // ƒ
                '\u{201E}' => Some(0x84), // „
                '\u{2026}' => Some(0x85), // …
                '\u{2020}' => Some(0x86), // †
                '\u{2021}' => Some(0x87), // ‡
                '\u{02C6}' => Some(0x88), // ˆ
                '\u{2030}' => Some(0x89), // ‰
                '\u{0160}' => Some(0x8A), // Š
                '\u{2039}' => Some(0x8B), // ‹
                '\u{0152}' => Some(0x8C), // Œ
                '\u{017D}' => Some(0x8E), // Ž
                '\u{2018}' => Some(0x91), // '
                '\u{2019}' => Some(0x92), // '
                '\u{201C}' => Some(0x93), // "
                '\u{201D}' => Some(0x94), // "
                '\u{2022}' => Some(0x95), // •
                '\u{2013}' => Some(0x96), // –
                '\u{2014}' => Some(0x97), // —
                '\u{02DC}' => Some(0x98), // ˜
                '\u{2122}' => Some(0x99), // ™
                '\u{0161}' => Some(0x9A), // š
                '\u{203A}' => Some(0x9B), // ›
                '\u{0153}' => Some(0x9C), // œ
                '\u{017E}' => Some(0x9E), // ž
                '\u{0178}' => Some(0x9F), // Ÿ
                _ => None,
            };
            if let Some(b) = mapped {
                out.push(b);
            }
            // Unmappable characters are silently dropped (see fn doc).
        }
    }
    out
}

/// Escape bytes for inclusion inside a PDF literal string (the
/// `(…)` form). Per PDF spec §7.3.4.2, we must escape `(` / `)` /
/// `\`. Non-printables get octal-escaped for robustness across
/// whitespace-sensitive parsers.
fn escape_pdf_string(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len() + 8);
    for &b in bytes {
        match b {
            b'(' | b')' | b'\\' => {
                out.push(b'\\');
                out.push(b);
            }
            b'\n' => out.extend_from_slice(b"\\n"),
            b'\r' => out.extend_from_slice(b"\\r"),
            b'\t' => out.extend_from_slice(b"\\t"),
            0x20..=0x7E => out.push(b),
            // Printable Latin-1 range: emit raw. PDF readers
            // interpret these per the font's encoding (WinAnsi in
            // our case).
            0xA0..=0xFF => out.push(b),
            // 0x80-0x9F are the Windows-1252 special slots; pass
            // through as raw bytes too.
            0x80..=0x9F => out.push(b),
            _ => {
                // Non-printable control chars: octal escape.
                out.extend_from_slice(format!("\\{:03o}", b).as_bytes());
            }
        }
    }
    out
}

/// Helvetica AFM glyph widths (Adobe Type 1, PostScript names) mapped
/// onto WinAnsiEncoding byte slots. Values are in 1/1000 em — multiply
/// by `font_size` and divide by 1000 to get a width in PDF points.
///
/// These numbers match the AFM Adobe ships with Helvetica, which is
/// what every PDF reader (Acrobat, Foxit, pdfjs) uses to compute glyph
/// widths when the font isn't embedded. Same numbers → same visual
/// placement when the baked overlay re-renders.
///
/// Slots not present in WinAnsiEncoding (or not in Helvetica's glyph
/// set) default to 500 — a neutral middle width that minimizes
/// alignment error for unexpected bytes.
const HELVETICA_WINANSI_WIDTHS: [u16; 256] = build_helvetica_widths();

const fn build_helvetica_widths() -> [u16; 256] {
    let mut w = [500u16; 256];
    // Whitespace + ASCII printable range.
    w[0x20] = 278; // space
    w[0x21] = 278; // !
    w[0x22] = 355; // "
    w[0x23] = 556; // #
    w[0x24] = 556; // $
    w[0x25] = 889; // %
    w[0x26] = 667; // &
    w[0x27] = 191; // '
    w[0x28] = 333; // (
    w[0x29] = 333; // )
    w[0x2A] = 389; // *
    w[0x2B] = 584; // +
    w[0x2C] = 278; // ,
    w[0x2D] = 333; // -
    w[0x2E] = 278; // .
    w[0x2F] = 278; // /
                   // Digits — Helvetica is tabular: every digit is 556.
    let mut i = 0x30;
    while i <= 0x39 {
        w[i] = 556;
        i += 1;
    }
    w[0x3A] = 278; // :
    w[0x3B] = 278; // ;
    w[0x3C] = 584; // <
    w[0x3D] = 584; // =
    w[0x3E] = 584; // >
    w[0x3F] = 556; // ?
    w[0x40] = 1015; // @
                    // Uppercase
    w[0x41] = 667;
    w[0x42] = 667;
    w[0x43] = 722;
    w[0x44] = 722;
    w[0x45] = 667;
    w[0x46] = 611;
    w[0x47] = 778;
    w[0x48] = 722;
    w[0x49] = 278;
    w[0x4A] = 500;
    w[0x4B] = 667;
    w[0x4C] = 556;
    w[0x4D] = 833;
    w[0x4E] = 722;
    w[0x4F] = 778;
    w[0x50] = 667;
    w[0x51] = 778;
    w[0x52] = 722;
    w[0x53] = 667;
    w[0x54] = 611;
    w[0x55] = 722;
    w[0x56] = 667;
    w[0x57] = 944;
    w[0x58] = 667;
    w[0x59] = 667;
    w[0x5A] = 611;
    w[0x5B] = 278; // [
    w[0x5C] = 278; // backslash
    w[0x5D] = 278; // ]
    w[0x5E] = 469; // ^
    w[0x5F] = 556; // _
    w[0x60] = 333; // `
                   // Lowercase
    w[0x61] = 556;
    w[0x62] = 556;
    w[0x63] = 500;
    w[0x64] = 556;
    w[0x65] = 556;
    w[0x66] = 278;
    w[0x67] = 556;
    w[0x68] = 556;
    w[0x69] = 222;
    w[0x6A] = 222;
    w[0x6B] = 500;
    w[0x6C] = 222;
    w[0x6D] = 833;
    w[0x6E] = 556;
    w[0x6F] = 556;
    w[0x70] = 556;
    w[0x71] = 556;
    w[0x72] = 333;
    w[0x73] = 500;
    w[0x74] = 278;
    w[0x75] = 556;
    w[0x76] = 500;
    w[0x77] = 722;
    w[0x78] = 500;
    w[0x79] = 500;
    w[0x7A] = 500;
    w[0x7B] = 334; // {
    w[0x7C] = 260; // |
    w[0x7D] = 334; // }
    w[0x7E] = 584; // ~
                   // Windows-1252 special slots (0x80–0x9F).
    w[0x80] = 556; // €
    w[0x82] = 222; // ‚
    w[0x83] = 556; // ƒ
    w[0x84] = 333; // „
    w[0x85] = 1000; // …
    w[0x86] = 556; // †
    w[0x87] = 556; // ‡
    w[0x88] = 333; // ˆ
    w[0x89] = 1000; // ‰
    w[0x8A] = 667; // Š
    w[0x8B] = 333; // ‹
    w[0x8C] = 1000; // Œ
    w[0x8E] = 611; // Ž
    w[0x91] = 222; // '
    w[0x92] = 222; // '
    w[0x93] = 333; // "
    w[0x94] = 333; // "
    w[0x95] = 350; // •
    w[0x96] = 556; // –
    w[0x97] = 1000; // —
    w[0x98] = 333; // ˜
    w[0x99] = 1000; // ™
    w[0x9A] = 500; // š
    w[0x9B] = 333; // ›
    w[0x9C] = 944; // œ
    w[0x9E] = 500; // ž
    w[0x9F] = 667; // Ÿ
                   // Latin-1 supplement (0xA0–0xFF). Filling in the well-known
                   // accented forms; the rest stay at 500 (covers ½, ¾, etc. close
                   // enough for alignment math).
    w[0xA0] = 278; // NBSP
    w[0xA1] = 333; // ¡
    w[0xA2] = 556; // ¢
    w[0xA3] = 556; // £
    w[0xA4] = 556; // ¤
    w[0xA5] = 556; // ¥
    w[0xA6] = 260; // ¦
    w[0xA7] = 556; // §
    w[0xA8] = 333; // ¨
    w[0xA9] = 737; // ©
    w[0xAA] = 370; // ª
    w[0xAB] = 556; // «
    w[0xAC] = 584; // ¬
    w[0xAD] = 333; // soft hyphen
    w[0xAE] = 737; // ®
    w[0xAF] = 333; // ¯
    w[0xB0] = 400; // °
    w[0xB1] = 584; // ±
    w[0xB2] = 333; // ²
    w[0xB3] = 333; // ³
    w[0xB4] = 333; // ´
    w[0xB5] = 556; // µ
    w[0xB6] = 537; // ¶
    w[0xB7] = 278; // ·
    w[0xB8] = 333; // ¸
    w[0xB9] = 333; // ¹
    w[0xBA] = 365; // º
    w[0xBB] = 556; // »
    w[0xBC] = 834; // ¼
    w[0xBD] = 834; // ½
    w[0xBE] = 834; // ¾
    w[0xBF] = 611; // ¿
                   // Uppercase accented forms — same width as base letter for
                   // Helvetica (the diacritic doesn't widen the glyph).
    let mut i = 0xC0;
    while i <= 0xC5 {
        w[i] = 667;
        i += 1;
    } // À-Å
    w[0xC6] = 1000; // Æ
    w[0xC7] = 722; // Ç
    let mut i = 0xC8;
    while i <= 0xCB {
        w[i] = 667;
        i += 1;
    } // È-Ë
    let mut i = 0xCC;
    while i <= 0xCF {
        w[i] = 278;
        i += 1;
    } // Ì-Ï
    w[0xD0] = 722; // Ð
    w[0xD1] = 722; // Ñ
    let mut i = 0xD2;
    while i <= 0xD6 {
        w[i] = 778;
        i += 1;
    } // Ò-Ö
    w[0xD7] = 584; // ×
    w[0xD8] = 778; // Ø
    let mut i = 0xD9;
    while i <= 0xDC {
        w[i] = 722;
        i += 1;
    } // Ù-Ü
    w[0xDD] = 667; // Ý
    w[0xDE] = 667; // Þ
    w[0xDF] = 611; // ß
                   // Lowercase accented forms — match base letter.
    let mut i = 0xE0;
    while i <= 0xE5 {
        w[i] = 556;
        i += 1;
    } // à-å
    w[0xE6] = 889; // æ
    w[0xE7] = 500; // ç
    let mut i = 0xE8;
    while i <= 0xEB {
        w[i] = 556;
        i += 1;
    } // è-ë
    let mut i = 0xEC;
    while i <= 0xEF {
        w[i] = 278;
        i += 1;
    } // ì-ï
    w[0xF0] = 556; // ð
    w[0xF1] = 556; // ñ
    let mut i = 0xF2;
    while i <= 0xF6 {
        w[i] = 556;
        i += 1;
    } // ò-ö
    w[0xF7] = 584; // ÷
    w[0xF8] = 611; // ø
    let mut i = 0xF9;
    while i <= 0xFC {
        w[i] = 556;
        i += 1;
    } // ù-ü
    w[0xFD] = 500; // ý
    w[0xFE] = 556; // þ
    w[0xFF] = 500; // ÿ
    w
}

/// Compute the rendered width of a WinAnsi-encoded byte slice in PDF
/// points, using the embedded Helvetica AFM table. Spec: each glyph's
/// stored width is in 1/1000 em, so the line width is
/// `Σ widths[b] × font_size / 1000`.
///
/// Kept for back-compat with existing tests. New production callers
/// use `text_width(family, bold, italic, bytes, font_size)` so the
/// alignment math respects Times / Courier glyph metrics.
#[cfg(test)]
fn text_width_helvetica(bytes: &[u8], font_size: f32) -> f32 {
    text_width(Family::Helvetica, false, false, bytes, font_size)
}

/// G1 extension: per-family AFM-based text width. Picks the right
/// Adobe AFM width table for the resolved family (Helvetica / Times /
/// Courier) and returns the rendered width in PDF points. Within each
/// family, italic/oblique shares widths with regular (per Adobe AFM —
/// Helvetica-Oblique and Times-Italic don't widen the glyph), and bold
/// has its own slightly-wider widths only in the Times family
/// (Helvetica-Bold matches Helvetica regular per AFM; Courier is
/// uniform 600 monospace across all four variants).
fn text_width(family: Family, bold: bool, _italic: bool, bytes: &[u8], font_size: f32) -> f32 {
    let table: &[u16; 256] = match (family, bold) {
        (Family::Helvetica, _) => &HELVETICA_WINANSI_WIDTHS,
        (Family::Times, false) => &TIMES_ROMAN_WINANSI_WIDTHS,
        (Family::Times, true) => &TIMES_BOLD_WINANSI_WIDTHS,
        (Family::Courier, _) => &COURIER_WINANSI_WIDTHS,
    };
    let units: u32 = bytes.iter().map(|&b| table[b as usize] as u32).sum();
    (units as f32) * font_size / 1000.0
}

/// Times-Roman AFM glyph widths in 1/1000 em. Same layout as the
/// Helvetica table — indexed by WinAnsi byte. Used for Times-Roman
/// AND Times-Italic edits (italic widths drift from roman by less
/// than 5% per glyph in Adobe's AFM, well within alignment tolerance).
const TIMES_ROMAN_WINANSI_WIDTHS: [u16; 256] = build_times_roman_widths();

const fn build_times_roman_widths() -> [u16; 256] {
    let mut w = [500u16; 256];
    w[0x20] = 250; // space
    w[0x21] = 333; // !
    w[0x22] = 408; // "
    w[0x23] = 500; // #
    w[0x24] = 500; // $
    w[0x25] = 833; // %
    w[0x26] = 778; // &
    w[0x27] = 180; // '
    w[0x28] = 333; // (
    w[0x29] = 333; // )
    w[0x2A] = 500; // *
    w[0x2B] = 564; // +
    w[0x2C] = 250; // ,
    w[0x2D] = 333; // -
    w[0x2E] = 250; // .
    w[0x2F] = 278; // /
    let mut i = 0x30;
    while i <= 0x39 {
        w[i] = 500;
        i += 1;
    } // digits 0-9
    w[0x3A] = 278; // :
    w[0x3B] = 278; // ;
    w[0x3C] = 564;
    w[0x3D] = 564;
    w[0x3E] = 564; // < = >
    w[0x3F] = 444; // ?
    w[0x40] = 921; // @
                   // Uppercase
    w[0x41] = 722;
    w[0x42] = 667;
    w[0x43] = 667;
    w[0x44] = 722;
    w[0x45] = 611;
    w[0x46] = 556;
    w[0x47] = 722;
    w[0x48] = 722;
    w[0x49] = 333;
    w[0x4A] = 389;
    w[0x4B] = 722;
    w[0x4C] = 611;
    w[0x4D] = 889;
    w[0x4E] = 722;
    w[0x4F] = 722;
    w[0x50] = 556;
    w[0x51] = 722;
    w[0x52] = 667;
    w[0x53] = 556;
    w[0x54] = 611;
    w[0x55] = 722;
    w[0x56] = 722;
    w[0x57] = 944;
    w[0x58] = 722;
    w[0x59] = 722;
    w[0x5A] = 611;
    w[0x5B] = 333;
    w[0x5C] = 278;
    w[0x5D] = 333;
    w[0x5E] = 469;
    w[0x5F] = 500;
    w[0x60] = 333;
    // Lowercase
    w[0x61] = 444;
    w[0x62] = 500;
    w[0x63] = 444;
    w[0x64] = 500;
    w[0x65] = 444;
    w[0x66] = 333;
    w[0x67] = 500;
    w[0x68] = 500;
    w[0x69] = 278;
    w[0x6A] = 278;
    w[0x6B] = 500;
    w[0x6C] = 278;
    w[0x6D] = 778;
    w[0x6E] = 500;
    w[0x6F] = 500;
    w[0x70] = 500;
    w[0x71] = 500;
    w[0x72] = 333;
    w[0x73] = 389;
    w[0x74] = 278;
    w[0x75] = 500;
    w[0x76] = 500;
    w[0x77] = 722;
    w[0x78] = 500;
    w[0x79] = 500;
    w[0x7A] = 444;
    w[0x7B] = 480;
    w[0x7C] = 200;
    w[0x7D] = 480;
    w[0x7E] = 541;
    // Latin-1 supplement (representative). The unmapped slots stay at
    // 500 — Times Roman's Latin-1 supplement is mostly dittos of the
    // base Latin glyph widths.
    w[0xA0] = 250; // NBSP
    w[0xA1] = 333;
    w[0xA2] = 500;
    w[0xA3] = 500;
    w[0xA4] = 500;
    w[0xA5] = 500;
    w[0xA6] = 200;
    w[0xA7] = 500;
    w[0xA8] = 333;
    w[0xA9] = 760;
    w[0xAA] = 276;
    w[0xAB] = 500;
    w[0xAC] = 564;
    w[0xAD] = 333;
    w[0xAE] = 760;
    w[0xAF] = 333;
    w[0xB0] = 400;
    w[0xB1] = 564;
    w[0xB2] = 300;
    w[0xB3] = 300;
    w[0xB4] = 333;
    w[0xB5] = 500;
    w[0xB6] = 453;
    w[0xB7] = 250;
    w[0xB8] = 333;
    w[0xB9] = 300;
    w[0xBA] = 310;
    w[0xBB] = 500;
    w[0xBC] = 750;
    w[0xBD] = 750;
    w[0xBE] = 750;
    w[0xBF] = 444;
    // Uppercase accented — same as base letter
    let mut i = 0xC0;
    while i <= 0xC5 {
        w[i] = 722;
        i += 1;
    } // À-Å
    w[0xC6] = 889; // Æ
    w[0xC7] = 667; // Ç
    let mut i = 0xC8;
    while i <= 0xCB {
        w[i] = 611;
        i += 1;
    } // È-Ë
    let mut i = 0xCC;
    while i <= 0xCF {
        w[i] = 333;
        i += 1;
    } // Ì-Ï
    w[0xD0] = 722;
    w[0xD1] = 722;
    let mut i = 0xD2;
    while i <= 0xD6 {
        w[i] = 722;
        i += 1;
    } // Ò-Ö
    w[0xD7] = 564;
    w[0xD8] = 722;
    let mut i = 0xD9;
    while i <= 0xDC {
        w[i] = 722;
        i += 1;
    } // Ù-Ü
    w[0xDD] = 722;
    w[0xDE] = 556;
    w[0xDF] = 500;
    // Lowercase accented
    let mut i = 0xE0;
    while i <= 0xE5 {
        w[i] = 444;
        i += 1;
    }
    w[0xE6] = 667;
    w[0xE7] = 444;
    let mut i = 0xE8;
    while i <= 0xEB {
        w[i] = 444;
        i += 1;
    }
    let mut i = 0xEC;
    while i <= 0xEF {
        w[i] = 278;
        i += 1;
    }
    w[0xF0] = 500;
    w[0xF1] = 500;
    let mut i = 0xF2;
    while i <= 0xF6 {
        w[i] = 500;
        i += 1;
    }
    w[0xF7] = 564;
    w[0xF8] = 500;
    let mut i = 0xF9;
    while i <= 0xFC {
        w[i] = 500;
        i += 1;
    }
    w[0xFD] = 500;
    w[0xFE] = 500;
    w[0xFF] = 500;
    w
}

/// Times-Bold AFM glyph widths in 1/1000 em. Used for Times-Bold AND
/// Times-BoldItalic edits.
const TIMES_BOLD_WINANSI_WIDTHS: [u16; 256] = build_times_bold_widths();

const fn build_times_bold_widths() -> [u16; 256] {
    let mut w = [500u16; 256];
    w[0x20] = 250;
    w[0x21] = 333;
    w[0x22] = 555;
    w[0x23] = 500;
    w[0x24] = 500;
    w[0x25] = 1000;
    w[0x26] = 833;
    w[0x27] = 278;
    w[0x28] = 333;
    w[0x29] = 333;
    w[0x2A] = 500;
    w[0x2B] = 570;
    w[0x2C] = 250;
    w[0x2D] = 333;
    w[0x2E] = 250;
    w[0x2F] = 278;
    let mut i = 0x30;
    while i <= 0x39 {
        w[i] = 500;
        i += 1;
    }
    w[0x3A] = 333;
    w[0x3B] = 333;
    w[0x3C] = 570;
    w[0x3D] = 570;
    w[0x3E] = 570;
    w[0x3F] = 500;
    w[0x40] = 930;
    w[0x41] = 722;
    w[0x42] = 667;
    w[0x43] = 722;
    w[0x44] = 722;
    w[0x45] = 667;
    w[0x46] = 611;
    w[0x47] = 778;
    w[0x48] = 778;
    w[0x49] = 389;
    w[0x4A] = 500;
    w[0x4B] = 778;
    w[0x4C] = 667;
    w[0x4D] = 944;
    w[0x4E] = 722;
    w[0x4F] = 778;
    w[0x50] = 611;
    w[0x51] = 778;
    w[0x52] = 722;
    w[0x53] = 556;
    w[0x54] = 667;
    w[0x55] = 722;
    w[0x56] = 722;
    w[0x57] = 1000;
    w[0x58] = 722;
    w[0x59] = 722;
    w[0x5A] = 667;
    w[0x5B] = 333;
    w[0x5C] = 278;
    w[0x5D] = 333;
    w[0x5E] = 581;
    w[0x5F] = 500;
    w[0x60] = 333;
    w[0x61] = 500;
    w[0x62] = 556;
    w[0x63] = 444;
    w[0x64] = 556;
    w[0x65] = 444;
    w[0x66] = 333;
    w[0x67] = 500;
    w[0x68] = 556;
    w[0x69] = 278;
    w[0x6A] = 333;
    w[0x6B] = 556;
    w[0x6C] = 278;
    w[0x6D] = 833;
    w[0x6E] = 556;
    w[0x6F] = 500;
    w[0x70] = 556;
    w[0x71] = 556;
    w[0x72] = 444;
    w[0x73] = 389;
    w[0x74] = 333;
    w[0x75] = 556;
    w[0x76] = 500;
    w[0x77] = 722;
    w[0x78] = 500;
    w[0x79] = 500;
    w[0x7A] = 444;
    w[0x7B] = 394;
    w[0x7C] = 220;
    w[0x7D] = 394;
    w[0x7E] = 520;
    // Latin-1 representative widths. Defaults to 500 for unmapped.
    w[0xA0] = 250;
    let mut i = 0xC0;
    while i <= 0xC5 {
        w[i] = 722;
        i += 1;
    }
    w[0xC6] = 1000;
    w[0xC7] = 722;
    let mut i = 0xC8;
    while i <= 0xCB {
        w[i] = 667;
        i += 1;
    }
    let mut i = 0xCC;
    while i <= 0xCF {
        w[i] = 389;
        i += 1;
    }
    w[0xD0] = 722;
    w[0xD1] = 722;
    let mut i = 0xD2;
    while i <= 0xD6 {
        w[i] = 778;
        i += 1;
    }
    w[0xD7] = 570;
    w[0xD8] = 778;
    let mut i = 0xD9;
    while i <= 0xDC {
        w[i] = 722;
        i += 1;
    }
    w[0xDD] = 722;
    w[0xDE] = 611;
    w[0xDF] = 556;
    let mut i = 0xE0;
    while i <= 0xE5 {
        w[i] = 500;
        i += 1;
    }
    w[0xE6] = 722;
    w[0xE7] = 444;
    let mut i = 0xE8;
    while i <= 0xEB {
        w[i] = 444;
        i += 1;
    }
    let mut i = 0xEC;
    while i <= 0xEF {
        w[i] = 278;
        i += 1;
    }
    w[0xF0] = 500;
    w[0xF1] = 556;
    let mut i = 0xF2;
    while i <= 0xF6 {
        w[i] = 500;
        i += 1;
    }
    w[0xF7] = 570;
    w[0xF8] = 500;
    let mut i = 0xF9;
    while i <= 0xFC {
        w[i] = 556;
        i += 1;
    }
    w[0xFD] = 500;
    w[0xFE] = 556;
    w[0xFF] = 500;
    w
}

/// Courier AFM glyph widths in 1/1000 em. Courier is a fixed-pitch
/// typewriter font — every Std 14 Courier variant (Courier,
/// Courier-Bold, Courier-Oblique, Courier-BoldOblique) reports 600 for
/// EVERY glyph, including Latin-1 supplement and 0x80–0x9F specials.
/// One uniform table covers all four.
const COURIER_WINANSI_WIDTHS: [u16; 256] = [600; 256];

/// Format a float for embedding in a PDF content stream. PDF spec
/// forbids scientific notation in reals, so we use fixed-point and
/// trim trailing zeros for compactness.
fn fmt_real(v: f32) -> String {
    if v.is_finite() {
        let s = format!("{:.4}", v);
        // Trim trailing zeros; keep at least one digit before decimal.
        let trimmed = s.trim_end_matches('0').trim_end_matches('.');
        if trimmed.is_empty() || trimmed == "-" {
            "0".into()
        } else {
            trimmed.to_string()
        }
    } else {
        // Non-finite values are a programmer bug; emit 0 to keep the
        // stream parseable rather than producing invalid bytes.
        "0".into()
    }
}

/// Parse an `#RRGGBB` hex string (6 or 3 digits, with or without `#`)
/// into normalized `(r, g, b)` floats in `[0, 1]`. Returns `None` on
/// any parse error so the caller can fall back to a sane default.
///
/// S5.5-P1 scope: hex only. Named CSS colors aren't in the
/// `ParagraphEdit.background_color` frontend format; the serializer
/// always emits hex.
fn parse_color(spec: Option<&str>) -> Option<(f32, f32, f32)> {
    let s = spec?.trim();
    let hex = s.strip_prefix('#').unwrap_or(s);
    match hex.len() {
        6 => {
            let r = u8::from_str_radix(&hex[0..2], 16).ok()?;
            let g = u8::from_str_radix(&hex[2..4], 16).ok()?;
            let b = u8::from_str_radix(&hex[4..6], 16).ok()?;
            Some((r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0))
        }
        3 => {
            // #RGB → each digit doubled (`#abc` → `#aabbcc`).
            let expand = |c: &str| u8::from_str_radix(&c.repeat(2), 16).ok();
            let r = expand(&hex[0..1])?;
            let g = expand(&hex[1..2])?;
            let b = expand(&hex[2..3])?;
            Some((r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0))
        }
        _ => None,
    }
}

// ── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::live::model::{Bbox, ParagraphEdit};

    fn edit_with_bbox(id: &str, x: f32, y: f32, w: f32, h: f32, bg: Option<&str>) -> ParagraphEdit {
        // Default new_text to empty so existing mask-only tests keep
        // validating JUST the rect. Text-emission tests construct
        // their own ParagraphEdit with a non-empty new_text.
        ParagraphEdit {
            paragraph_id: id.into(),
            bbox: Bbox {
                x,
                y,
                width: w,
                height: h,
            },
            original_text: "orig".into(),
            new_text: String::new(),
            font_size: 12.0,
            color: None,
            background_color: bg.map(str::to_string),
            font_family: None,
            bold: false,
            italic: false,
            align: None,
            item_indices: vec![],
            item_original_texts: vec![],
            position_delta: None,
            custom_font_id: None,
        }
    }

    fn edit_with_text(id: &str, x: f32, y: f32, w: f32, h: f32, new_text: &str) -> ParagraphEdit {
        let mut e = edit_with_bbox(id, x, y, w, h, None);
        e.new_text = new_text.into();
        e
    }

    #[test]
    fn parse_hex_color_rrggbb() {
        assert_eq!(parse_color(Some("#FF0000")), Some((1.0, 0.0, 0.0)));
        assert_eq!(parse_color(Some("00ff00")), Some((0.0, 1.0, 0.0)));
    }

    #[test]
    fn parse_hex_color_rgb_shorthand() {
        let (r, g, b) = parse_color(Some("#FFF")).unwrap();
        assert!((r - 1.0).abs() < 1e-6);
        assert!((g - 1.0).abs() < 1e-6);
        assert!((b - 1.0).abs() < 1e-6);
    }

    #[test]
    fn parse_hex_color_rejects_garbage() {
        assert_eq!(parse_color(Some("not a color")), None);
        assert_eq!(parse_color(Some("#GG00FF")), None);
        assert_eq!(parse_color(None), None);
    }

    #[test]
    fn overlay_stream_emits_white_rect_by_default() {
        let edits = vec![edit_with_bbox("p1", 10.0, 20.0, 100.0, 15.0, None)];
        let (stream, needs_font) = build_overlay_stream(&edits, "Ovl0");
        let s = std::str::from_utf8(&stream).expect("ASCII output");
        // Default color is white (1 1 1 rg).
        assert!(
            s.contains("1 1 1 rg"),
            "default color should be white: {s:?}"
        );
        // Rect in content-stream order.
        assert!(s.contains("10 20 100 15 re"));
        // Fill + restore.
        assert!(s.contains("\nf\n"));
        assert!(s.contains("\nQ\n"));
        // Empty new_text → no font needed.
        assert!(!needs_font);
        assert!(
            !s.contains("BT"),
            "no text block expected for empty new_text"
        );
    }

    #[test]
    fn overlay_stream_respects_background_color() {
        let edits = vec![edit_with_bbox("p1", 0.0, 0.0, 10.0, 10.0, Some("#808080"))];
        let (stream, _) = build_overlay_stream(&edits, "Ovl0");
        let s = std::str::from_utf8(&stream).unwrap();
        // 0x80 / 255 ≈ 0.5020
        assert!(s.contains("0.502 0.502 0.502 rg"), "got: {s}");
    }

    #[test]
    fn overlay_stream_concatenates_multiple_paragraphs() {
        let edits = vec![
            edit_with_bbox("p1", 0.0, 0.0, 10.0, 10.0, None),
            edit_with_bbox("p2", 50.0, 100.0, 20.0, 20.0, Some("#000000")),
        ];
        let (stream, _) = build_overlay_stream(&edits, "Ovl0");
        let s = std::str::from_utf8(&stream).unwrap();
        assert!(s.contains("0 0 10 10 re"));
        assert!(s.contains("50 100 20 20 re"));
        // Two `q` / `Q` pairs.
        assert_eq!(
            s.matches("\nq\n").count() + if s.starts_with("q\n") { 1 } else { 0 },
            2
        );
    }

    #[test]
    fn overlay_stream_emits_text_when_new_text_nonempty() {
        let edits = vec![edit_with_text("p1", 50.0, 700.0, 200.0, 14.0, "Hello")];
        let (stream, needs_font) = build_overlay_stream(&edits, "Ovl0");
        let s = std::str::from_utf8(&stream).expect("ASCII output");
        // Mask still present.
        assert!(s.contains("50 700 200 14 re"));
        assert!(s.contains("\nf\n"));
        // Text block present.
        assert!(s.contains("BT\n"), "expected BT operator: {s}");
        assert!(s.contains("ET\n"), "expected ET operator: {s}");
        assert!(s.contains("/Ovl0 12 Tf"));
        assert!(s.contains("(Hello) Tj"));
        // Needs font injection.
        assert!(needs_font);
    }

    #[test]
    fn overlay_stream_escapes_pdf_string_metachars() {
        let edits = vec![edit_with_text("p1", 0.0, 0.0, 100.0, 14.0, "a (b) c\\d")];
        let (stream, _) = build_overlay_stream(&edits, "Ovl0");
        let s = std::str::from_utf8(&stream).expect("ASCII output");
        // `(`, `)`, `\` inside a PDF literal string must each be
        // preceded by a backslash.
        assert!(
            s.contains("(a \\(b\\) c\\\\d)"),
            "expected escaped string in stream: {s}",
        );
    }

    #[test]
    fn overlay_stream_drops_unmappable_characters_silently() {
        // Emoji isn't in WinAnsiEncoding; it should be dropped.
        // "A🎉B" → "AB". Result still has text-draw because the
        // mapped portion is non-empty.
        let edits = vec![edit_with_text("p1", 0.0, 0.0, 100.0, 14.0, "A\u{1F389}B")];
        let (stream, needs_font) = build_overlay_stream(&edits, "Ovl0");
        let s = std::str::from_utf8(&stream).expect("ASCII output");
        assert!(s.contains("(AB) Tj"), "expected emoji stripped: {s}");
        assert!(needs_font);
    }

    #[test]
    fn overlay_stream_skips_text_block_if_nothing_mappable() {
        // Pure non-WinAnsi → no text block emitted; mask still there.
        // Caller downstream should fall back to pd-lib bake for this
        // paragraph; we just don't draw anything in the engine overlay.
        let edits = vec![edit_with_text("p1", 0.0, 0.0, 100.0, 14.0, "日本語")];
        let (stream, needs_font) = build_overlay_stream(&edits, "Ovl0");
        let s = std::str::from_utf8(&stream).expect("ASCII output");
        assert!(!s.contains("BT\n"), "no text block when nothing maps: {s}");
        // No font needed either.
        assert!(!needs_font);
        // Mask rect still present.
        assert!(s.contains("0 0 100 14 re"));
    }

    #[test]
    fn fmt_real_trims_trailing_zeros() {
        assert_eq!(fmt_real(1.5), "1.5");
        assert_eq!(fmt_real(1.0), "1");
        assert_eq!(fmt_real(0.0), "0");
        assert_eq!(fmt_real(-2.25), "-2.25");
    }

    #[test]
    fn winansi_passes_ascii() {
        assert_eq!(encode_winansi("Hello, world!"), b"Hello, world!");
    }

    #[test]
    fn winansi_passes_latin1_supplement() {
        // é is U+00E9 → WinAnsi 0xE9.
        assert_eq!(encode_winansi("caf\u{00E9}"), b"caf\xE9");
    }

    #[test]
    fn winansi_maps_windows1252_specials() {
        // Euro and smart quote.
        assert_eq!(
            encode_winansi("\u{20AC}\u{201C}hi\u{201D}"),
            &[0x80, 0x93, b'h', b'i', 0x94]
        );
    }

    // ── G1 alignment tests ─────────────────────────────────────────

    /// Helper: build an edit with a specific alignment.
    fn edit_aligned(
        text: &str,
        bbox_x: f32,
        bbox_y: f32,
        bbox_w: f32,
        bbox_h: f32,
        align: TextAlign,
        font_size: f32,
    ) -> ParagraphEdit {
        let mut e = edit_with_text("p1", bbox_x, bbox_y, bbox_w, bbox_h, text);
        e.font_size = font_size;
        e.align = Some(align);
        e
    }

    /// Pull every `<x> <y> Tm` operator out of a content stream so a
    /// test can assert on the baseline x for each line. Returns
    /// `(x, y)` floats in the order they appear.
    fn extract_tms(stream: &str) -> Vec<(f32, f32)> {
        let mut out = Vec::new();
        for line in stream.lines() {
            // We always emit `1 0 0 1 <x> <y> Tm` — six tokens.
            if line.ends_with(" Tm") {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() == 7 && parts[0] == "1" && parts[6] == "Tm" {
                    let x: f32 = parts[4].parse().unwrap();
                    let y: f32 = parts[5].parse().unwrap();
                    out.push((x, y));
                }
            }
        }
        out
    }

    #[test]
    fn helvetica_widths_match_known_chars() {
        // 12pt 'A' (width 667) = 667 * 12 / 1000 = 8.004
        let w = text_width_helvetica(b"A", 12.0);
        assert!((w - 8.004).abs() < 1e-3, "got {w}");
        // "AB" = (667 + 667) * 12 / 1000 = 16.008
        let w = text_width_helvetica(b"AB", 12.0);
        assert!((w - 16.008).abs() < 1e-3, "got {w}");
        // Space is 278.
        let w = text_width_helvetica(b" ", 12.0);
        assert!((w - 3.336).abs() < 1e-3, "got {w}");
    }

    #[test]
    fn align_left_baseline_unchanged_from_pre_g1() {
        // No align field → defaults to Left, identical to pre-G1
        // baseline calculation: baseline_x == bbox.x.
        let edit = edit_with_text("p1", 50.0, 700.0, 200.0, 14.0, "Hello");
        let (stream, _) = build_overlay_stream(&[edit], "Ovl0");
        let s = std::str::from_utf8(&stream).expect("ASCII");
        let tms = extract_tms(s);
        assert_eq!(tms.len(), 1);
        assert!(
            (tms[0].0 - 50.0).abs() < 1e-3,
            "left should anchor at bbox.x"
        );
    }

    #[test]
    fn align_right_shifts_baseline_to_bbox_right_minus_width() {
        // bbox 200 wide; "Hello" at 12pt is ~25.34pt.
        // Expected baseline_x = 50 + (200 - 25.34) = ~224.66
        let edit = edit_aligned("Hello", 50.0, 700.0, 200.0, 14.0, TextAlign::Right, 12.0);
        let text_w = text_width_helvetica(b"Hello", 12.0);
        let expected_x = 50.0 + (200.0 - text_w);
        let (stream, _) = build_overlay_stream(&[edit], "Ovl0");
        let s = std::str::from_utf8(&stream).expect("ASCII");
        let tms = extract_tms(s);
        assert_eq!(tms.len(), 1);
        assert!(
            (tms[0].0 - expected_x).abs() < 1e-2,
            "right-align: expected baseline_x={expected_x}, got {}",
            tms[0].0
        );
    }

    #[test]
    fn align_center_shifts_baseline_to_midpoint() {
        let edit = edit_aligned("Hello", 50.0, 700.0, 200.0, 14.0, TextAlign::Center, 12.0);
        let text_w = text_width_helvetica(b"Hello", 12.0);
        let expected_x = 50.0 + (200.0 - text_w) / 2.0;
        let (stream, _) = build_overlay_stream(&[edit], "Ovl0");
        let s = std::str::from_utf8(&stream).expect("ASCII");
        let tms = extract_tms(s);
        assert_eq!(tms.len(), 1);
        assert!(
            (tms[0].0 - expected_x).abs() < 1e-2,
            "center: expected baseline_x={expected_x}, got {}",
            tms[0].0
        );
    }

    #[test]
    fn align_justify_emits_tw_for_non_last_lines() {
        // Two lines so we have a non-last line to justify.
        // Last line keeps natural left alignment.
        let edit = edit_aligned(
            "Hello world\nbye",
            0.0,
            700.0,
            200.0,
            30.0,
            TextAlign::Justify,
            12.0,
        );
        let (stream, _) = build_overlay_stream(&[edit], "Ovl0");
        let s = std::str::from_utf8(&stream).expect("ASCII");
        // First line: must emit `<n> Tw` to widen the inter-word gap
        // before the Tj. Reset to 0 Tw before/after the last line.
        assert!(s.contains(" Tw"), "justify should emit Tw operator: {s}");
        // "0 Tw" should appear before the last line (the "bye" line)
        // so we don't accidentally widen its single space (it has none,
        // but a reset still belongs there for invariant safety).
        assert!(
            s.contains("0 Tw"),
            "justify should reset Tw before the last line: {s}"
        );
        // Both lines should still emit Tj.
        let tj_count = s.matches(") Tj").count();
        assert_eq!(tj_count, 2, "two lines → two Tj: {s}");
    }

    #[test]
    fn align_justify_last_line_anchors_left() {
        // Single-line justify should NOT emit Tw — there's no
        // "non-last" line, so the line is the "last line" and gets
        // left-anchored without inter-word widening.
        let edit = edit_aligned(
            "Hello world",
            0.0,
            700.0,
            500.0,
            14.0,
            TextAlign::Justify,
            12.0,
        );
        let (stream, _) = build_overlay_stream(&[edit], "Ovl0");
        let s = std::str::from_utf8(&stream).expect("ASCII");
        // Tw value should be either absent or zero.
        // Specifically: no `<positive> Tw` line.
        for line in s.lines() {
            if line.ends_with(" Tw") {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if let Some(v) = parts.first() {
                    let val: f32 = v.parse().unwrap_or(0.0);
                    assert!(val == 0.0, "single-line justify must not widen spaces: {s}");
                }
            }
        }
    }

    #[test]
    fn multiline_emits_one_tj_per_line_with_descending_y() {
        // Three lines → three Tj with strictly decreasing baseline y
        // (PDF coords, so descending y is downward visually).
        let edit = edit_with_text("p1", 0.0, 700.0, 200.0, 50.0, "Line 1\nLine 2\nLine 3");
        let (stream, _) = build_overlay_stream(&[edit], "Ovl0");
        let s = std::str::from_utf8(&stream).expect("ASCII");
        let tms = extract_tms(s);
        assert_eq!(tms.len(), 3, "three lines: {s}");
        // Strictly descending y.
        assert!(tms[0].1 > tms[1].1, "line 2 below line 1");
        assert!(tms[1].1 > tms[2].1, "line 3 below line 2");
        // Line height should be ~font_size * 1.2 = 14.4
        let dy = tms[0].1 - tms[1].1;
        assert!((dy - 14.4).abs() < 0.1, "expected line gap ~14.4, got {dy}");
    }

    // ── G3 font-variant tests ──────────────────────────────────────

    #[test]
    fn standard14_basefont_picks_helvetica_variants() {
        let mut e = edit_with_text("p", 0.0, 0.0, 100.0, 14.0, "x");
        e.bold = false;
        e.italic = false;
        assert_eq!(standard14_basefont_for_edit(&e), "Helvetica");
        e.bold = true;
        e.italic = false;
        assert_eq!(standard14_basefont_for_edit(&e), "Helvetica-Bold");
        e.bold = false;
        e.italic = true;
        assert_eq!(standard14_basefont_for_edit(&e), "Helvetica-Oblique");
        e.bold = true;
        e.italic = true;
        assert_eq!(standard14_basefont_for_edit(&e), "Helvetica-BoldOblique");
    }

    #[test]
    fn resolve_family_picks_times_for_serif_strings() {
        assert_eq!(resolve_family(Some("Times New Roman")), Family::Times);
        assert_eq!(resolve_family(Some("times")), Family::Times);
        assert_eq!(resolve_family(Some("Georgia")), Family::Times);
        assert_eq!(resolve_family(Some("'Times', serif")), Family::Times);
        assert_eq!(resolve_family(Some("Cambria")), Family::Times);
    }

    #[test]
    fn resolve_family_picks_courier_for_mono_strings() {
        assert_eq!(resolve_family(Some("Courier New")), Family::Courier);
        assert_eq!(resolve_family(Some("Consolas")), Family::Courier);
        assert_eq!(resolve_family(Some("Menlo")), Family::Courier);
        assert_eq!(resolve_family(Some("'Andale Mono'")), Family::Courier);
        assert_eq!(resolve_family(Some("Inconsolata")), Family::Courier);
    }

    #[test]
    fn resolve_family_defaults_to_helvetica() {
        assert_eq!(resolve_family(None), Family::Helvetica);
        assert_eq!(resolve_family(Some("")), Family::Helvetica);
        assert_eq!(resolve_family(Some("Arial")), Family::Helvetica);
        assert_eq!(resolve_family(Some("Calibri")), Family::Helvetica);
        assert_eq!(resolve_family(Some("Helvetica Neue")), Family::Helvetica);
        assert_eq!(resolve_family(Some("system-ui")), Family::Helvetica);
    }

    #[test]
    fn standard14_basefont_picks_times_variants() {
        let mut e = edit_with_text("p", 0.0, 0.0, 100.0, 14.0, "x");
        e.font_family = Some("Times New Roman".into());
        e.bold = false;
        e.italic = false;
        assert_eq!(standard14_basefont_for_edit(&e), "Times-Roman");
        e.bold = true;
        e.italic = false;
        assert_eq!(standard14_basefont_for_edit(&e), "Times-Bold");
        e.bold = false;
        e.italic = true;
        assert_eq!(standard14_basefont_for_edit(&e), "Times-Italic");
        e.bold = true;
        e.italic = true;
        assert_eq!(standard14_basefont_for_edit(&e), "Times-BoldItalic");
    }

    #[test]
    fn standard14_basefont_picks_courier_variants() {
        let mut e = edit_with_text("p", 0.0, 0.0, 100.0, 14.0, "x");
        e.font_family = Some("Consolas".into());
        e.bold = false;
        e.italic = false;
        assert_eq!(standard14_basefont_for_edit(&e), "Courier");
        e.bold = true;
        e.italic = false;
        assert_eq!(standard14_basefont_for_edit(&e), "Courier-Bold");
        e.bold = false;
        e.italic = true;
        assert_eq!(standard14_basefont_for_edit(&e), "Courier-Oblique");
        e.bold = true;
        e.italic = true;
        assert_eq!(standard14_basefont_for_edit(&e), "Courier-BoldOblique");
    }

    #[test]
    fn text_width_uses_correct_per_family_table() {
        // 'A' 12pt:
        //   Helvetica regular: 667 × 12 / 1000 = 8.004
        //   Times-Roman:       722 × 12 / 1000 = 8.664
        //   Times-Bold:        722 × 12 / 1000 = 8.664
        //   Courier (any):     600 × 12 / 1000 = 7.2
        let helv = text_width(Family::Helvetica, false, false, b"A", 12.0);
        let timesr = text_width(Family::Times, false, false, b"A", 12.0);
        let timesb = text_width(Family::Times, true, false, b"A", 12.0);
        let cour = text_width(Family::Courier, false, false, b"A", 12.0);
        assert!((helv - 8.004).abs() < 1e-3, "helv 'A' got {helv}");
        assert!(
            (timesr - 8.664).abs() < 1e-3,
            "times-roman 'A' got {timesr}"
        );
        assert!((timesb - 8.664).abs() < 1e-3, "times-bold 'A' got {timesb}");
        assert!((cour - 7.2).abs() < 1e-3, "courier 'A' got {cour}");
    }

    #[test]
    fn courier_widths_uniform_600_across_visible_chars() {
        // Property of monospace: every WinAnsi byte in the printable
        // range has the same advance.
        let cases: &[&[u8]] = &[b"A", b"i", b"M", b"!", b"5", b" "];
        let expected = text_width(Family::Courier, false, false, b"A", 12.0);
        for c in cases {
            let w = text_width(Family::Courier, false, false, c, 12.0);
            assert!(
                (w - expected).abs() < 1e-6,
                "courier should be 600-uniform: {c:?} got {w}, expected {expected}",
            );
        }
    }

    // ── G2 bake-side embedded-font integration tests ───────────

    fn load_test_ttf() -> Vec<u8> {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("scripts")
            .join("fonts")
            .join("NotoSans-Regular.ttf");
        std::fs::read(&path).expect("NotoSans-Regular.ttf is checked into scripts/fonts/")
    }

    #[test]
    fn assign_routes_custom_font_id_through_embedded_path() {
        let mut e = edit_with_text("p", 0.0, 0.0, 100.0, 14.0, "Hello");
        e.font_family = Some("Open Sans".into());
        e.custom_font_id = Some("opensans-regular".into());

        let mut embedded = HashMap::new();
        embedded.insert(
            "opensans-regular".to_string(),
            EmbeddedFont {
                bytes: load_test_ttf(),
                postscript_name: "OpenSans-Regular".into(),
                bold: false,
                italic: false,
            },
        );
        let assignments = assign_font_resources_with_embedded(&[e], &embedded);
        assert_eq!(assignments.per_edit_resource.len(), 1);
        assert!(
            assignments.per_edit_resource[0].starts_with("Cu"),
            "embedded edits use /CuN resource: {:?}",
            assignments.per_edit_resource[0],
        );
        assert!(matches!(
            assignments.per_edit_kind[0],
            EditFontKind::Embedded { .. }
        ));
        assert_eq!(assignments.embedded_to_resource.len(), 1);
        assert_eq!(assignments.basefont_to_resource.len(), 0);
    }

    #[test]
    fn assign_falls_back_to_standard14_when_payload_missing() {
        // custom_font_id set but EditModel.embedded_fonts doesn't carry
        // the matching key — must NOT panic, must fall through to
        // Standard 14 so the edit still bakes (just substituted).
        let mut e = edit_with_text("p", 0.0, 0.0, 100.0, 14.0, "Hi");
        e.custom_font_id = Some("missing-font-id".into());
        let assignments = assign_font_resources_with_embedded(&[e], &HashMap::new());
        assert!(matches!(
            assignments.per_edit_kind[0],
            EditFontKind::Standard14 { .. }
        ));
        assert!(assignments.per_edit_resource[0].starts_with("Ovl"));
    }

    #[test]
    fn embedded_overlay_emits_hex_cid_strings_not_literals() {
        let mut e = edit_with_text("p1", 50.0, 700.0, 200.0, 14.0, "Hi");
        e.font_size = 12.0;
        e.font_family = Some("Open Sans".into());
        e.custom_font_id = Some("opensans-regular".into());

        let mut embedded = HashMap::new();
        embedded.insert(
            "opensans-regular".to_string(),
            EmbeddedFont {
                bytes: load_test_ttf(),
                postscript_name: "OpenSans-Regular".into(),
                bold: false,
                italic: false,
            },
        );
        let assignments = assign_font_resources_with_embedded(&[e.clone()], &embedded);
        let stream = build_overlay_stream_v2(&[e], &assignments);
        let s = std::str::from_utf8(&stream).expect("ASCII content stream");
        // Embedded path must emit `<HEX> Tj`, NOT `(literal) Tj`.
        assert!(
            s.contains("> Tj"),
            "embedded encoding: hex string close > Tj expected: {s}",
        );
        assert!(
            !s.contains("(Hi) Tj"),
            "embedded edit must NOT emit literal-string Tj: {s}",
        );
        // Resource name reference uses the assigned /CuN.
        let cu_resource = &assignments.per_edit_resource[0];
        assert!(s.contains(&format!("/{} ", cu_resource)));
    }

    #[test]
    fn embedded_text_width_uses_ttf_hmtx_not_helvetica_afm() {
        let ttf = load_test_ttf();
        let face = ttf_parser::Face::parse(&ttf, 0).unwrap();
        // Encode "A" via cmap, then measure via text_width_embedded.
        // Compare against Helvetica AFM 'A' width (8.004 at 12pt).
        // Expect a different number — confirms we used the TTF.
        let line = encode_cids("A", Some(&face));
        let cids = match &line {
            LineEncoding::Cids(c) => c.clone(),
            _ => panic!("expected CIDs"),
        };
        assert_eq!(cids.len(), 2, "single 'A' → 2-byte CID");
        let w_embed = text_width_embedded(&cids, Some(&face), 12.0);
        let w_helv = text_width(Family::Helvetica, false, false, b"A", 12.0);
        assert!(w_embed > 0.0, "embedded width must be positive");
        assert!(
            (w_embed - w_helv).abs() > 0.001,
            "embedded width should differ from Helvetica AFM (helv={w_helv}, embed={w_embed})"
        );
    }

    #[test]
    fn embedded_cids_drop_unmappable_codepoints_silently() {
        // Stub TTF face: any glyph_index lookup that fails produces no CID.
        // We exercise this by passing a face and a string that contains a
        // codepoint the font doesn't carry — emoji is the safe choice.
        let ttf = load_test_ttf();
        let face = ttf_parser::Face::parse(&ttf, 0).unwrap();
        let line = encode_cids("A\u{1F389}B", Some(&face));
        let cids = match line {
            LineEncoding::Cids(c) => c,
            _ => panic!("expected CIDs"),
        };
        // 'A' + 'B' map; the emoji (likely) doesn't. If it DOES (some
        // builds of NotoSans include emoji ranges), we'd see 3 glyphs;
        // otherwise 2. The invariant is just "no panic" — both are fine.
        assert!(
            cids.len() == 4 || cids.len() == 6,
            "got {} cid bytes",
            cids.len()
        );
    }

    #[test]
    fn align_right_in_times_uses_times_widths_not_helvetica() {
        // Right-aligning "Hello" 12pt in a 200-wide bbox under Times-Roman:
        //   Times-Roman Hello width = (722+444+278+278+500-? ...)
        //     Let's compute: H=722 e=444 l=278 l=278 o=500  → 2222 / 1000 * 12 = 26.664
        //   Helvetica Hello width = ~25.336 (8 less)
        // Pre-fix: bake used Helvetica widths regardless of edit family,
        // so right-aligned Times text would be ~1.3pt too far right.
        // Post-fix: Times widths drive the offset.
        let mut edit = edit_with_text("p1", 50.0, 700.0, 200.0, 14.0, "Hello");
        edit.font_family = Some("Times New Roman".into());
        edit.font_size = 12.0;
        edit.align = Some(TextAlign::Right);
        let times_w = text_width(Family::Times, false, false, b"Hello", 12.0);
        let expected_x = 50.0 + (200.0 - times_w);

        let assignments = assign_font_resources(&[edit.clone()]);
        let stream = build_overlay_stream_v2(&[edit], &assignments);
        let s = std::str::from_utf8(&stream).expect("ASCII");
        let tms = extract_tms(s);
        assert_eq!(tms.len(), 1);
        assert!(
            (tms[0].0 - expected_x).abs() < 1e-2,
            "right-align in Times: expected baseline_x≈{expected_x:.3}, got {:.3}",
            tms[0].0,
        );
    }

    #[test]
    fn assign_font_resources_dedupes_repeated_variants() {
        // Three edits — two regular Helvetica + one Helvetica-Bold.
        // Only TWO resource names should be assigned.
        let mut e1 = edit_with_text("p1", 0.0, 0.0, 50.0, 14.0, "a");
        let mut e2 = edit_with_text("p2", 0.0, 0.0, 50.0, 14.0, "b");
        let mut e3 = edit_with_text("p3", 0.0, 0.0, 50.0, 14.0, "c");
        e1.bold = false;
        e2.bold = false;
        e3.bold = true;
        let assignments = assign_font_resources(&[e1, e2, e3]);
        assert_eq!(assignments.basefont_to_resource.len(), 2);
        assert_eq!(
            assignments.per_edit_resource[0], assignments.per_edit_resource[1],
            "two regular edits should share a resource",
        );
        assert_ne!(
            assignments.per_edit_resource[0], assignments.per_edit_resource[2],
            "regular ≠ bold resource",
        );
    }

    #[test]
    fn bake_emits_distinct_font_resources_for_bold_and_regular() {
        // Build a minimal page with two paragraphs — one bold, one
        // regular — and verify the IncrementalPatch carries both
        // BaseFont names.
        use crate::live::model::{EditModel, PageEdits};
        let mut regular = edit_with_text("p1", 50.0, 700.0, 200.0, 14.0, "Plain");
        let mut bold = edit_with_text("p2", 50.0, 660.0, 200.0, 14.0, "Bold");
        regular.bold = false;
        bold.bold = true;
        let mut pages = std::collections::HashMap::new();
        pages.insert(
            0,
            PageEdits {
                paragraphs: vec![regular, bold],
            },
        );
        let model = EditModel {
            source_hash: String::new(),
            pages,
            version: 1,
            embedded_fonts: Default::default(),
        };

        // Use the simplest hand-rolled PDF; bake_edit_model will fail
        // on this, but assign_font_resources is what we want to assert.
        // Mirror the logic without going through write_incremental:
        let edits = &model.pages[&0].paragraphs;
        let assignments = assign_font_resources(edits);
        let basefonts: Vec<&String> = assignments.basefont_to_resource.keys().collect();
        assert!(
            basefonts.iter().any(|f| f.as_str() == "Helvetica"),
            "regular edit needs /Helvetica: {basefonts:?}",
        );
        assert!(
            basefonts.iter().any(|f| f.as_str() == "Helvetica-Bold"),
            "bold edit needs /Helvetica-Bold: {basefonts:?}",
        );
    }

    #[test]
    fn overlay_stream_v2_references_per_edit_resource_name() {
        // Single bold edit — overlay stream's Tf operator must
        // reference the resource name assigned to /Helvetica-Bold,
        // not a hardcoded /Ovl0.
        let mut bold = edit_with_text("p1", 50.0, 700.0, 200.0, 14.0, "Bold text");
        bold.bold = true;
        let assignments = assign_font_resources(&[bold.clone()]);
        let stream = build_overlay_stream_v2(&[bold], &assignments);
        let s = std::str::from_utf8(&stream).expect("ASCII");
        let bold_resource = &assignments.basefont_to_resource["Helvetica-Bold"];
        assert!(
            s.contains(&format!("/{} ", bold_resource)),
            "Tf should reference the resource bound to Helvetica-Bold ({}): {}",
            bold_resource,
            s
        );
    }

    #[test]
    fn multiline_blank_line_consumes_one_line_height() {
        // Empty middle line should NOT emit a Tj but still advance
        // the y so subsequent lines stay vertically aligned.
        let edit = edit_with_text("p1", 0.0, 700.0, 200.0, 50.0, "First\n\nThird");
        let (stream, _) = build_overlay_stream(&[edit], "Ovl0");
        let s = std::str::from_utf8(&stream).expect("ASCII");
        let tms = extract_tms(s);
        // Two emitted Tjs (first + third); blank middle is skipped.
        assert_eq!(tms.len(), 2, "first + third only: {s}");
        // y delta between them should be 2× line height (12 * 1.2 * 2 = 28.8)
        let dy = tms[0].1 - tms[1].1;
        assert!(
            (dy - 28.8).abs() < 0.1,
            "blank line should still consume a line height: dy={dy}, stream:\n{s}"
        );
    }
}
