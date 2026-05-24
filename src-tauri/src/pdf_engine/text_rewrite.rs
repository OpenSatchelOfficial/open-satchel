//! True text editing — content-stream rewrite in place.
//!
//! Replaces the operands of `Tj` / `TJ` operators in a page's existing
//! content stream with re-encoded replacement text, using the PDF's
//! own font (via its ToUnicode CMap reverse-mapping). Emits the
//! rewritten stream as a new indirect object with the same object
//! number as the original — so readers see the updated content
//! through the incremental update without a separate overlay stream.
//!
//! Contrast with [`super::bake`]:
//! - **Overlay bake** (sessions S5.5-P1/P2): leaves original text
//!   in place, paints a mask rect + draws new text on top. Extracted
//!   text (copy-paste, text-mining) still returns the OLD content;
//!   file size grows by a full overlay stream + font object.
//! - **True text rewrite (here)**: modifies the original text
//!   objects. Extraction returns the NEW content. File size grows
//!   only by the rewritten stream's delta.
//!
//! ## Scope of this session
//!
//! - Single-run paragraph edits (one `Tj`/`TJ` per paragraph) where
//!   the operand's decoded text matches `edit.original_text`.
//! - ASCII / Latin-1 / other characters that the page font's
//!   ToUnicode CMap can reverse-map. If ANY character in
//!   `edit.new_text` can't be encoded in the font's available CIDs,
//!   we return `Err` and the caller falls back to overlay bake.
//! - Multi-run paragraphs (text split across several `TJ` arrays),
//!   multi-page edits: partial support — we rewrite what we can
//!   match, return Err on anything we can't.
//!
//! Future work:
//! - Position-based matching (fall back to bbox intersection when
//!   string match fails, for documents with repeated text).
//! - Multi-run reflow (typical for wrapping paragraphs — the engine
//!   would need a layout pass).
//! - Font-substitution when the original font lacks glyphs for new
//!   characters (fall back to a compatible font with matching metrics).

use crate::error::AppError;
use crate::live::{EditModel, ParagraphEdit};
use crate::pdf_engine::types::WriteSummary;
use crate::pdf_engine::writer::write_incremental_rewrite;
use crate::Result;
use flate2::read::ZlibDecoder;
use lopdf::content::{Content, Operation};
use lopdf::{Document, Object, ObjectId, Stream};
use std::collections::HashMap;
use std::io::{Cursor, Read};

/// Try to bake paragraph edits by rewriting the original content
/// streams in place. On success, returns the full byte stream of the
/// incremental update. On failure (unmappable character, unmatchable
/// paragraph, parse error), returns `Err` — caller falls back to the
/// overlay bake path.
pub fn rewrite_text_edits_in_place(
    original_bytes: &[u8],
    model: &EditModel,
) -> Result<(Vec<u8>, WriteSummary)> {
    let mut cursor = Cursor::new(original_bytes);
    let mut doc = Document::load_from(&mut cursor)
        .map_err(|e| AppError::Pdf(format!("true-text: parse original: {e}")))?;

    let pages = doc.get_pages();

    // (content_stream_obj_id, new_bytes) pairs to supersede.
    let mut rewritten: Vec<(ObjectId, Vec<u8>)> = Vec::new();

    // Iterate page-by-page so we can surface clear errors per page.
    let mut page_indices: Vec<u32> = model
        .pages
        .iter()
        .filter(|(_, pe)| !pe.paragraphs.is_empty())
        .map(|(idx, _)| *idx)
        .collect();
    page_indices.sort_unstable();

    for page_idx in page_indices {
        let page_edits = model
            .pages
            .get(&page_idx)
            .expect("present — filtered above");

        // lopdf's get_pages is 1-indexed.
        let page_id = *pages.get(&(page_idx + 1)).ok_or_else(|| {
            AppError::Pdf(format!(
                "true-text: page {page_idx} out of range (doc has {})",
                pages.len()
            ))
        })?;

        // Walk all font resources on this page, build reverse-CMap for each.
        // Tries ToUnicode first, then falls back to /Encoding-derived
        // tables (WinAnsi, MacRoman, Standard) for standard Type1/TrueType
        // fonts without CMaps.
        let fonts = collect_page_fonts(&doc, page_id);
        if fonts.is_empty() {
            return Err(AppError::Pdf(format!(
                "true-text: page {page_idx} has no decodable fonts — \
                 no font has a ToUnicode CMap or a recognized /Encoding \
                 (WinAnsi/MacRoman/Standard). Likely a CID-keyed font \
                 without CMap, or a custom /Differences-only encoding."
            )));
        }

        // lopdf's get_page_contents returns the Contents stream obj
        // IDs (handles the single-ref AND array cases). Pages may have
        // multiple streams — the original content + any overlay-bake
        // streams appended by prior save attempts that fell back to
        // overlay. We try every edit against every stream (since the
        // clusterer's paragraph might have originated from any of them),
        // and after a successful rewrite we sweep all streams for
        // stale Tj's still matching original_text — those are overlay
        // leftovers and must be blanked so pdfjs's clusterer doesn't
        // surface them as "duplicate" text in the next edit session.
        let content_ids = doc.get_page_contents(page_id);
        if content_ids.is_empty() {
            return Err(AppError::Pdf(format!(
                "true-text: page {page_idx} has no content stream"
            )));
        }

        // Decode every stream once; track modifications in parallel.
        struct StreamState {
            content_id: ObjectId,
            content: Content,
            modified: bool,
        }
        let mut streams: Vec<StreamState> = Vec::with_capacity(content_ids.len());
        for cid in &content_ids {
            let stream = doc
                .get_object(*cid)
                .and_then(Object::as_stream)
                .map_err(|e| {
                    AppError::Pdf(format!("true-text: read content stream {}: {e}", cid.0))
                })?;
            let data = decompress_stream(stream).map_err(|e| {
                AppError::Pdf(format!(
                    "true-text: decompress content stream {}: {e}",
                    cid.0
                ))
            })?;
            let content = Content::decode(&data).map_err(|e| {
                AppError::Pdf(format!("true-text: decode content stream {}: {e}", cid.0))
            })?;
            streams.push(StreamState {
                content_id: *cid,
                content,
                modified: false,
            });
        }

        // Pass 1: apply each edit. Try each stream in order; accept the
        // first one that matches. Edits that match in NO stream are a
        // hard error (caller falls back to overlay).
        for edit in &page_edits.paragraphs {
            // Skip only if NOTHING needs doing — text unchanged AND no
            // position shift. A drag-only edit has new_text == original_text
            // but a non-zero position_delta, and still needs the Tj to be
            // re-located via injected Td ops inside try_rewrite_run.
            let text_unchanged = edit.new_text == edit.original_text;
            let position_unchanged = match &edit.position_delta {
                Some(d) => d.dx.abs() < 0.001 && d.dy.abs() < 0.001,
                None => true,
            };
            if text_unchanged && position_unchanged {
                continue;
            }
            let mut applied = false;
            for s in streams.iter_mut() {
                let hit = try_rewrite_run(&mut s.content.operations, edit, &fonts)?;
                if hit {
                    s.modified = true;
                    applied = true;
                    break;
                }
            }
            if !applied {
                return Err(AppError::Pdf(format!(
                    "true-text: could not find a Tj/TJ whose decoded text \
                     matches original_text for paragraph {:?} on page {}",
                    edit.paragraph_id, page_idx
                )));
            }
        }

        // Pass 2: sweep. Any Tj/TJ whose decoded text STILL matches an
        // edit.original_text is an overlay-bake leftover — stale text
        // from a previous save that fell back to overlay before the
        // multi-run path shipped. Blank these so the next edit session's
        // paragraph clusterer doesn't pick them up as extra runs.
        let originals: Vec<&str> = page_edits
            .paragraphs
            .iter()
            .filter(|e| e.new_text != e.original_text)
            .map(|e| e.original_text.as_str())
            .collect();
        if !originals.is_empty() {
            for s in streams.iter_mut() {
                if strip_stale_overlay_runs(&mut s.content.operations, &fonts, &originals) {
                    s.modified = true;
                }
            }
        }

        // Emit modified streams.
        for s in streams.into_iter() {
            if !s.modified {
                continue;
            }
            let new_bytes = s.content.encode().map_err(|e| {
                AppError::Pdf(format!(
                    "true-text: re-encode content stream {}: {e}",
                    s.content_id.0
                ))
            })?;
            rewritten.push((s.content_id, new_bytes));
        }
    }

    if rewritten.is_empty() {
        // Nothing actually needed rewriting (all edits were no-ops
        // or the model was empty). Fall through to identity round-trip.
        return crate::pdf_engine::writer::write_incremental(original_bytes, &[]);
    }

    // Mutate the in-memory doc with the new streams, then hand off
    // to the writer's supersede-objects path.
    for (id, bytes) in &rewritten {
        // Overwrite the stream contents. The dict keeps /Length updated
        // by the writer when it re-emits.
        if let Ok(stream) = doc.get_object_mut(*id).and_then(Object::as_stream_mut) {
            stream.content = bytes.clone();
            stream.start_position = None;
            // Drop /Filter if present — we emit uncompressed.
            stream.dict.remove(b"Filter");
            stream.dict.remove(b"Length");
        }
    }

    write_incremental_rewrite(original_bytes, &doc, &rewritten)
}

/// Font resources on a page, keyed by the name used in content-stream
/// `Tf` operators (e.g. `F1`, `TT0`). Value carries the reverse CMap
/// for that font (char → CID byte sequence).
struct FontMeta {
    /// Reverse ToUnicode map: Unicode scalar → CID byte sequence.
    /// Multi-byte CIDs are stored as-is (2 bytes for CIDFontType0/2).
    reverse_cmap: HashMap<char, Vec<u8>>,
    /// Forward map used to DECODE the original Tj operand so we can
    /// compare it to `edit.original_text`.
    forward_cmap: HashMap<Vec<u8>, String>,
    /// Byte width of one CID code. 1 for Type1/WinAnsi fonts, 2 for
    /// CID-keyed (Type0) fonts. We read this from /Encoding or from
    /// the codespace-range in the ToUnicode CMap.
    code_width: usize,
}

fn collect_page_fonts(doc: &Document, page_id: ObjectId) -> HashMap<String, FontMeta> {
    let mut out = HashMap::new();
    // Walk Resources chain (page then ancestors).
    let fonts_dict = get_page_fonts_dict(doc, page_id);
    let Some(fonts_dict) = fonts_dict else {
        return out;
    };

    for (name, font_ref) in fonts_dict.iter() {
        let font_obj = match font_ref {
            Object::Reference(id) => match doc.get_object(*id) {
                Ok(o) => o,
                Err(_) => continue,
            },
            other => other,
        };
        let Ok(font_dict) = font_obj.as_dict() else {
            continue;
        };

        // Preferred path: ToUnicode CMap (works for any font, including
        // subsetted / CIDKeyed / custom encodings).
        let meta_from_tu = try_build_from_tounicode(doc, font_dict);
        if let Some(meta) = meta_from_tu {
            let name_str = String::from_utf8_lossy(name).into_owned();
            out.insert(name_str, meta);
            continue;
        }

        // Fallback: derive a CMap from the font's /Encoding. Covers the
        // common case of standard Type1 fonts (Helvetica, Arial, Times)
        // using WinAnsiEncoding — the default for most Latin-text PDFs
        // generated by Office, LibreOffice, Chrome print-to-PDF, etc.
        // Without this fallback, true-rewrite would bail on any PDF
        // that uses standard encodings, forcing every edit through
        // overlay bake (which leaves the original text extractable).
        let meta_from_enc = try_build_from_encoding(doc, font_dict);
        if let Some(meta) = meta_from_enc {
            let name_str = String::from_utf8_lossy(name).into_owned();
            out.insert(name_str, meta);
        }
    }
    out
}

/// Build (forward, reverse, code_width) from the font's ToUnicode
/// CMap, if present. Returns None when the font has no ToUnicode or
/// the CMap is unparseable.
fn try_build_from_tounicode(doc: &Document, font_dict: &lopdf::Dictionary) -> Option<FontMeta> {
    let tu_ref = font_dict.get(b"ToUnicode").ok()?;
    let tu_obj = match tu_ref {
        Object::Reference(id) => doc.get_object(*id).ok()?,
        other => other,
    };
    let tu_stream = tu_obj.as_stream().ok()?;
    let tu_bytes = tu_stream.decompressed_content().ok()?;
    let (forward, reverse, code_width) = parse_tounicode_cmap(&tu_bytes);
    if reverse.is_empty() {
        return None;
    }
    Some(FontMeta {
        reverse_cmap: reverse,
        forward_cmap: forward,
        code_width,
    })
}

/// Build (forward, reverse, code_width) from the font's /Encoding
/// dictionary. Handles:
///   - `/Encoding /WinAnsiEncoding`   (most common)
///   - `/Encoding /MacRomanEncoding`
///   - `/Encoding /StandardEncoding`
///   - `/Encoding << /BaseEncoding /WinAnsiEncoding /Differences [...] >>`
///
/// Absent `/Encoding` is treated as WinAnsiEncoding for Type1 fonts —
/// this matches Acrobat's behavior for legacy documents. (Spec actually
/// says "font's built-in encoding", but in practice Type1 fonts in PDF
/// default to something compatible with WinAnsi for the printable range.)
///
/// All standard encodings are single-byte, so `code_width` is 1.
fn try_build_from_encoding(doc: &Document, font_dict: &lopdf::Dictionary) -> Option<FontMeta> {
    // Check /Subtype — this fallback makes sense for Type1 / TrueType
    // (single-byte). CIDType0/CIDType2 fonts need ToUnicode; if we
    // don't have one for those, we can't safely rewrite.
    let subtype = font_dict
        .get(b"Subtype")
        .ok()
        .and_then(|o| o.as_name().ok())
        .unwrap_or(b"");
    let is_single_byte = matches!(subtype, b"Type1" | b"TrueType" | b"MMType1" | b"Type3");
    if !is_single_byte {
        return None;
    }

    let encoding = font_dict.get(b"Encoding").ok();

    // Resolve /Encoding to either a name or a dict.
    let (base_name, differences): (&[u8], Option<&lopdf::Object>) = match encoding {
        Some(Object::Name(n)) => (n.as_slice(), None),
        Some(Object::Reference(id)) => match doc.get_object(*id).ok() {
            Some(Object::Name(n)) => (n.as_slice(), None),
            Some(Object::Dictionary(d)) => {
                let base = d
                    .get(b"BaseEncoding")
                    .ok()
                    .and_then(|o| o.as_name().ok())
                    .unwrap_or(b"WinAnsiEncoding");
                let diffs = d.get(b"Differences").ok();
                (base, diffs)
            }
            _ => (b"WinAnsiEncoding", None),
        },
        Some(Object::Dictionary(d)) => {
            let base = d
                .get(b"BaseEncoding")
                .ok()
                .and_then(|o| o.as_name().ok())
                .unwrap_or(b"WinAnsiEncoding");
            let diffs = d.get(b"Differences").ok();
            (base, diffs)
        }
        _ => (b"WinAnsiEncoding", None), // absent /Encoding → treat as WinAnsi
    };

    let mut table: [Option<char>; 256] = base_encoding_table(base_name)?;

    // Apply /Differences: an array of [code /name1 /name2 ... codeN /nameN ...].
    // Each integer sets the starting code; following names fill successive slots.
    //
    // Glyph-name → Unicode mapping comes from the Adobe Glyph List (AGL).
    // We ship a small built-in subset covering ASCII+Latin-1 + common
    // ligatures + common punctuation — enough for 99% of real-world
    // Differences arrays. Unknown names are left as `None` (we can't
    // round-trip through them). Full AGL is future work.
    if let Some(Object::Array(diff_arr)) = differences {
        let mut cur: usize = 0;
        for item in diff_arr {
            match item {
                Object::Integer(i) => cur = *i as usize,
                Object::Name(n) => {
                    if cur < 256 {
                        if let Some(ch) = glyph_name_to_char(n.as_slice()) {
                            table[cur] = Some(ch);
                        } else {
                            table[cur] = None; // Can't round-trip unknown name.
                        }
                        cur += 1;
                    }
                }
                _ => {}
            }
        }
    }

    let mut forward: HashMap<Vec<u8>, String> = HashMap::new();
    let mut reverse: HashMap<char, Vec<u8>> = HashMap::new();
    for (byte, ch_opt) in table.iter().enumerate() {
        if let Some(ch) = ch_opt {
            let code = vec![byte as u8];
            forward.insert(code.clone(), ch.to_string());
            reverse.insert(*ch, code);
        }
    }

    if reverse.is_empty() {
        return None;
    }

    Some(FontMeta {
        reverse_cmap: reverse,
        forward_cmap: forward,
        code_width: 1,
    })
}

/// Base-encoding byte → char tables. Returns None for unknown names.
/// Tables follow PDF 32000-1 Annex D.
fn base_encoding_table(name: &[u8]) -> Option<[Option<char>; 256]> {
    match name {
        b"WinAnsiEncoding" => Some(build_win_ansi_table()),
        b"MacRomanEncoding" => Some(build_mac_roman_table()),
        b"StandardEncoding" | b"PDFDocEncoding" => Some(build_standard_table()),
        _ => None,
    }
}

/// PDF 32000-1 Annex D.2 WinAnsiEncoding. Matches Windows-1252 in the
/// printable range; control chars (0x00-0x1F, 0x7F) unmapped.
fn build_win_ansi_table() -> [Option<char>; 256] {
    let mut t: [Option<char>; 256] = [None; 256];
    // ASCII printable 0x20-0x7E maps 1:1 to Unicode.
    for b in 0x20u8..=0x7E {
        t[b as usize] = Some(b as char);
    }
    // Windows-1252 specifics 0x80-0x9F.
    let upper_ctrl: &[(u8, char)] = &[
        (0x80, '\u{20AC}'), // €
        (0x82, '\u{201A}'), // ‚
        (0x83, '\u{0192}'), // ƒ
        (0x84, '\u{201E}'), // „
        (0x85, '\u{2026}'), // …
        (0x86, '\u{2020}'), // †
        (0x87, '\u{2021}'), // ‡
        (0x88, '\u{02C6}'), // ˆ
        (0x89, '\u{2030}'), // ‰
        (0x8A, '\u{0160}'), // Š
        (0x8B, '\u{2039}'), // ‹
        (0x8C, '\u{0152}'), // Œ
        (0x8E, '\u{017D}'), // Ž
        (0x91, '\u{2018}'), // '
        (0x92, '\u{2019}'), // '
        (0x93, '\u{201C}'), // "
        (0x94, '\u{201D}'), // "
        (0x95, '\u{2022}'), // •
        (0x96, '\u{2013}'), // –
        (0x97, '\u{2014}'), // —
        (0x98, '\u{02DC}'), // ˜
        (0x99, '\u{2122}'), // ™
        (0x9A, '\u{0161}'), // š
        (0x9B, '\u{203A}'), // ›
        (0x9C, '\u{0153}'), // œ
        (0x9E, '\u{017E}'), // ž
        (0x9F, '\u{0178}'), // Ÿ
    ];
    for (b, c) in upper_ctrl {
        t[*b as usize] = Some(*c);
    }
    // 0xA0-0xFF: ISO Latin-1 Supplement (1:1 with Unicode).
    for b in 0xA0u8..=0xFF {
        t[b as usize] = Some(b as char);
    }
    // Adobe PDF fallback convention (PDF 32000-1 Annex D.2 note):
    // WinAnsi positions with no standard mapping are rendered by
    // Adobe Reader / compliant viewers as U+2022 BULLET. ReportLab
    // relies on this — it emits bullet characters at 0x7F rather than
    // the "correct" 0x95. If we don't mirror the fallback, decoding
    // those Tj's produces a partial string that never matches
    // `original_text`, and every edit on a bulleted ReportLab PDF
    // falls through to overlay.
    //
    // Reverse-map ordering: the reverse_cmap is built by iterating
    // the table in byte order (0..=255). The LAST byte that maps to
    // a given character wins. Adding these fallbacks BEFORE 0x95
    // ensures 0x95 (the canonical bullet slot) remains the encode
    // target for • in round-trips — so if a user types a new bullet
    // into a freshly-edited paragraph, we emit 0x95 not 0x7F.
    for b in [0x7Fu8, 0x81, 0x8D, 0x8F, 0x90, 0x9D] {
        if t[b as usize].is_none() {
            t[b as usize] = Some('\u{2022}');
        }
    }
    t
}

/// PDF 32000-1 Annex D.2 MacRomanEncoding.
/// Covers the printable ASCII range plus the Mac-specific upper half.
/// Only the common subset is populated; rare glyphs fall through as
/// unmapped (the fallback will skip them, matching ToUnicode behavior).
fn build_mac_roman_table() -> [Option<char>; 256] {
    let mut t: [Option<char>; 256] = [None; 256];
    for b in 0x20u8..=0x7E {
        t[b as usize] = Some(b as char);
    }
    let upper: &[(u8, char)] = &[
        (0x80, 'Ä'),
        (0x81, 'Å'),
        (0x82, 'Ç'),
        (0x83, 'É'),
        (0x84, 'Ñ'),
        (0x85, 'Ö'),
        (0x86, 'Ü'),
        (0x87, 'á'),
        (0x88, 'à'),
        (0x89, 'â'),
        (0x8A, 'ä'),
        (0x8B, 'ã'),
        (0x8C, 'å'),
        (0x8D, 'ç'),
        (0x8E, 'é'),
        (0x8F, 'è'),
        (0x90, 'ê'),
        (0x91, 'ë'),
        (0x92, 'í'),
        (0x93, 'ì'),
        (0x94, 'î'),
        (0x95, 'ï'),
        (0x96, 'ñ'),
        (0x97, 'ó'),
        (0x98, 'ò'),
        (0x99, 'ô'),
        (0x9A, 'ö'),
        (0x9B, 'õ'),
        (0x9C, 'ú'),
        (0x9D, 'ù'),
        (0x9E, 'û'),
        (0x9F, 'ü'),
        (0xA0, '†'),
        (0xA1, '°'),
        (0xA2, '¢'),
        (0xA3, '£'),
        (0xA4, '§'),
        (0xA5, '•'),
        (0xA6, '¶'),
        (0xA7, 'ß'),
        (0xA8, '®'),
        (0xA9, '©'),
        (0xAA, '™'),
        (0xAB, '´'),
        (0xAC, '¨'),
        (0xAE, 'Æ'),
        (0xAF, 'Ø'),
        (0xB1, '±'),
        (0xB4, '¥'),
        (0xB5, 'µ'),
        (0xBB, 'ª'),
        (0xBC, 'º'),
        (0xBE, 'æ'),
        (0xBF, 'ø'),
        (0xC0, '¿'),
        (0xC1, '¡'),
        (0xC2, '¬'),
        (0xC4, 'ƒ'),
        (0xC7, '«'),
        (0xC8, '»'),
        (0xC9, '…'),
        (0xCA, '\u{00A0}'),
        (0xCB, 'À'),
        (0xCC, 'Ã'),
        (0xCD, 'Õ'),
        (0xCE, 'Œ'),
        (0xCF, 'œ'),
        (0xD0, '–'),
        (0xD1, '—'),
        (0xD2, '\u{201C}'),
        (0xD3, '\u{201D}'),
        (0xD4, '\u{2018}'),
        (0xD5, '\u{2019}'),
        (0xD6, '÷'),
        (0xD8, 'ÿ'),
        (0xD9, 'Ÿ'),
        (0xDA, '/'),
        (0xDB, '€'),
    ];
    for (b, c) in upper {
        t[*b as usize] = Some(*c);
    }
    t
}

/// PDF 32000-1 Annex D.1 StandardEncoding (Adobe). Printable ASCII
/// subset + classic Type1 glyphs. Just the printable 0x20-0x7E plus
/// the common upper range. Rarely used — most modern PDFs use
/// WinAnsiEncoding — so we ship a minimal table.
fn build_standard_table() -> [Option<char>; 256] {
    let mut t: [Option<char>; 256] = [None; 256];
    // Printable ASCII. Standard encoding matches ASCII in 0x20-0x7E.
    for b in 0x20u8..=0x7E {
        t[b as usize] = Some(b as char);
    }
    t
}

/// Minimal Adobe Glyph List subset — enough for /Differences arrays
/// seen in Office, LibreOffice, Chrome, and legal-industry generators.
/// Unknown names return None (we can't round-trip them safely).
fn glyph_name_to_char(name: &[u8]) -> Option<char> {
    // The full AGL is ~4k entries; this is the practical subset.
    // Names are matched byte-for-byte (no normalization). Ordering
    // is rough frequency — common ASCII aliases first.
    let s = std::str::from_utf8(name).ok()?;
    Some(match s {
        "space" => ' ',
        "exclam" => '!',
        "quotedbl" => '"',
        "numbersign" => '#',
        "dollar" => '$',
        "percent" => '%',
        "ampersand" => '&',
        "quoteright" => '\u{2019}',
        "quoteleft" => '\u{2018}',
        "parenleft" => '(',
        "parenright" => ')',
        "asterisk" => '*',
        "plus" => '+',
        "comma" => ',',
        "hyphen" | "minus" => '-',
        "period" => '.',
        "slash" => '/',
        "colon" => ':',
        "semicolon" => ';',
        "less" => '<',
        "equal" => '=',
        "greater" => '>',
        "question" => '?',
        "at" => '@',
        "bracketleft" => '[',
        "backslash" => '\\',
        "bracketright" => ']',
        "asciicircum" => '^',
        "underscore" => '_',
        "grave" => '`',
        "braceleft" => '{',
        "bar" => '|',
        "braceright" => '}',
        "asciitilde" => '~',
        "quotedblleft" => '\u{201C}',
        "quotedblright" => '\u{201D}',
        "quotedblbase" => '\u{201E}',
        "quotesinglbase" => '\u{201A}',
        "guilsinglleft" => '\u{2039}',
        "guilsinglright" => '\u{203A}',
        "guillemotleft" => '«',
        "guillemotright" => '»',
        "endash" => '\u{2013}',
        "emdash" => '\u{2014}',
        "bullet" => '\u{2022}',
        "ellipsis" => '\u{2026}',
        "dagger" => '\u{2020}',
        "daggerdbl" => '\u{2021}',
        "section" => '§',
        "paragraph" => '¶',
        "copyright" => '©',
        "registered" => '®',
        "trademark" => '\u{2122}',
        "degree" => '°',
        "plusminus" => '±',
        "multiply" => '×',
        "divide" => '÷',
        "currency" => '¤',
        "euro" => '€',
        "cent" => '¢',
        "sterling" => '£',
        "yen" => '¥',
        "florin" => 'ƒ',
        "fi" => '\u{FB01}',
        "fl" => '\u{FB02}',
        "AE" => 'Æ',
        "ae" => 'æ',
        "OE" => 'Œ',
        "oe" => 'œ',
        "Lslash" => 'Ł',
        "lslash" => 'ł',
        "Oslash" => 'Ø',
        "oslash" => 'ø',
        "Scaron" => 'Š',
        "scaron" => 'š',
        "Zcaron" => 'Ž',
        "zcaron" => 'ž',
        "Ydieresis" => 'Ÿ',
        "germandbls" => 'ß',
        // Single-letter glyph names: capital and lowercase ASCII.
        s if s.len() == 1 => s.chars().next()?,
        _ => {
            // Digits as words: "zero", "one", ...
            let digit = match s {
                "zero" => Some('0'),
                "one" => Some('1'),
                "two" => Some('2'),
                "three" => Some('3'),
                "four" => Some('4'),
                "five" => Some('5'),
                "six" => Some('6'),
                "seven" => Some('7'),
                "eight" => Some('8'),
                "nine" => Some('9'),
                _ => None,
            };
            digit?
        }
    })
}

/// Walk up the /Pages tree from `page_id` to find /Resources /Font.
fn get_page_fonts_dict<'a>(doc: &'a Document, page_id: ObjectId) -> Option<&'a lopdf::Dictionary> {
    let mut cur = page_id;
    for _ in 0..16 {
        let dict = doc.get_dictionary(cur).ok()?;
        if let Ok(res) = dict.get(b"Resources") {
            let res_dict = match res {
                Object::Dictionary(d) => Some(d),
                Object::Reference(id) => doc.get_dictionary(*id).ok(),
                _ => None,
            };
            if let Some(res_dict) = res_dict {
                if let Ok(fonts) = res_dict.get(b"Font") {
                    let fonts_dict = match fonts {
                        Object::Dictionary(d) => Some(d),
                        Object::Reference(id) => doc.get_dictionary(*id).ok(),
                        _ => None,
                    };
                    if let Some(d) = fonts_dict {
                        return Some(d);
                    }
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

/// Parse a ToUnicode CMap's bfchar / bfrange mappings.
///
/// Returns `(forward, reverse, code_width)` where:
/// - `forward[cid_bytes] = unicode_string` (covers multi-codepoint
///   ligatures; may have multiple chars per entry)
/// - `reverse[char] = cid_bytes` (only for single-codepoint entries,
///   since a ligature can't be reverse-mapped from one char)
/// - `code_width` is the byte width of one CID code (1 or 2).
fn parse_tounicode_cmap(bytes: &[u8]) -> (HashMap<Vec<u8>, String>, HashMap<char, Vec<u8>>, usize) {
    let text = String::from_utf8_lossy(bytes);
    let mut forward: HashMap<Vec<u8>, String> = HashMap::new();
    let mut reverse: HashMap<char, Vec<u8>> = HashMap::new();

    // Infer code width from codespacerange. Default 2 (most CID fonts).
    let code_width = infer_code_width(&text).unwrap_or(2);

    // bfchar: `<CID> <U+XXXX...>` pairs between beginbfchar/endbfchar.
    for block in extract_blocks(&text, "beginbfchar", "endbfchar") {
        parse_bfchar_block(block, code_width, &mut forward, &mut reverse);
    }
    // bfrange: two shapes — see parse_bfrange_block.
    for block in extract_blocks(&text, "beginbfrange", "endbfrange") {
        parse_bfrange_block(block, code_width, &mut forward, &mut reverse);
    }

    (forward, reverse, code_width)
}

fn infer_code_width(text: &str) -> Option<usize> {
    // Find `N begincodespacerange ... endcodespacerange`. Inside are
    // `<hex_start> <hex_end>` pairs; the hex width tells us code width.
    let start = text.find("begincodespacerange")?;
    let end = text[start..].find("endcodespacerange")? + start;
    let block = &text[start..end];
    // Grab the first `<HEX>` and measure.
    for tok in block.split('<') {
        if let Some(close) = tok.find('>') {
            let hex = &tok[..close];
            if !hex.is_empty() && hex.chars().all(|c| c.is_ascii_hexdigit()) {
                return Some(hex.len() / 2);
            }
        }
    }
    None
}

/// Pull substrings between `begin` and `end` markers.
fn extract_blocks<'a>(text: &'a str, begin: &str, end: &str) -> Vec<&'a str> {
    let mut out = Vec::new();
    let mut cursor = 0;
    while let Some(bs) = text[cursor..].find(begin) {
        let bs = cursor + bs;
        let Some(after_marker_nl) = text[bs..].find('\n') else {
            break;
        };
        let block_start = bs + after_marker_nl + 1;
        let Some(be) = text[block_start..].find(end) else {
            break;
        };
        out.push(&text[block_start..block_start + be]);
        cursor = block_start + be + end.len();
    }
    out
}

fn parse_bfchar_block(
    block: &str,
    code_width: usize,
    forward: &mut HashMap<Vec<u8>, String>,
    reverse: &mut HashMap<char, Vec<u8>>,
) {
    for line in block.lines() {
        // Two hex groups per line: <CID> <UNICODE>
        let groups = extract_hex_groups(line);
        if groups.len() < 2 {
            continue;
        }
        let cid_bytes = hex_to_bytes(&groups[0]);
        if cid_bytes.len() != code_width {
            continue;
        }
        let unicode_str = hex_to_unicode(&groups[1]);
        if unicode_str.is_empty() {
            continue;
        }
        forward.insert(cid_bytes.clone(), unicode_str.clone());
        if unicode_str.chars().count() == 1 {
            reverse.insert(unicode_str.chars().next().unwrap(), cid_bytes);
        }
    }
}

fn parse_bfrange_block(
    block: &str,
    code_width: usize,
    forward: &mut HashMap<Vec<u8>, String>,
    reverse: &mut HashMap<char, Vec<u8>>,
) {
    // Two shapes:
    //   <from> <to> <unicode_start>
    //   <from> <to> [ <u1> <u2> ... ]
    // We parse line-by-line, handling multi-line arrays too.
    let mut rest = block;
    while !rest.is_empty() {
        // Find first `<` — start of `from`.
        let Some(from_lt) = rest.find('<') else { break };
        let Some(from_gt_rel) = rest[from_lt + 1..].find('>') else {
            break;
        };
        let from_gt = from_lt + 1 + from_gt_rel;
        let from_hex = &rest[from_lt + 1..from_gt];

        // Find next `<` — start of `to`.
        let after_from = from_gt + 1;
        let Some(to_lt_rel) = rest[after_from..].find('<') else {
            break;
        };
        let to_lt = after_from + to_lt_rel;
        let Some(to_gt_rel) = rest[to_lt + 1..].find('>') else {
            break;
        };
        let to_gt = to_lt + 1 + to_gt_rel;
        let to_hex = &rest[to_lt + 1..to_gt];

        // Look at what comes next — `<` (unicode_start) or `[` (array).
        let after_to = to_gt + 1;
        let next_meaningful = rest[after_to..]
            .char_indices()
            .find(|(_, c)| !c.is_whitespace())
            .map(|(i, _)| after_to + i);

        let from_bytes = hex_to_bytes(from_hex);
        let to_bytes = hex_to_bytes(to_hex);
        if from_bytes.len() != code_width || to_bytes.len() != code_width {
            break;
        }
        let from_cid = bytes_to_u32(&from_bytes);
        let to_cid = bytes_to_u32(&to_bytes);

        match next_meaningful.and_then(|p| rest[p..].chars().next()) {
            Some('<') => {
                // Contiguous. <unicode_start>
                let Some(ul) = rest[after_to..].find('<') else {
                    break;
                };
                let ul = after_to + ul;
                let Some(ur_rel) = rest[ul + 1..].find('>') else {
                    break;
                };
                let ur = ul + 1 + ur_rel;
                let ustart_hex = &rest[ul + 1..ur];
                let ustart_str = hex_to_unicode(ustart_hex);
                let Some(ustart_char) = ustart_str.chars().next() else {
                    rest = &rest[ur + 1..];
                    continue;
                };
                let ustart_cp = ustart_char as u32;
                for i in 0..=(to_cid.saturating_sub(from_cid)) {
                    let cid = from_cid + i;
                    let ch = char::from_u32(ustart_cp + i);
                    let Some(ch) = ch else { continue };
                    let cid_bytes = u32_to_bytes(cid, code_width);
                    forward.insert(cid_bytes.clone(), ch.to_string());
                    reverse.insert(ch, cid_bytes);
                }
                rest = &rest[ur + 1..];
            }
            Some('[') => {
                // Explicit array. [ <u1> <u2> ... ]
                let lb = next_meaningful.unwrap();
                let Some(rb_rel) = rest[lb..].find(']') else {
                    break;
                };
                let rb = lb + rb_rel;
                let arr = &rest[lb + 1..rb];
                let groups: Vec<String> = extract_hex_groups(arr);
                let expected = (to_cid - from_cid + 1) as usize;
                for (i, hex) in groups.iter().enumerate().take(expected) {
                    let ustr = hex_to_unicode(hex);
                    if ustr.is_empty() {
                        continue;
                    }
                    let cid_bytes = u32_to_bytes(from_cid + i as u32, code_width);
                    forward.insert(cid_bytes.clone(), ustr.clone());
                    if ustr.chars().count() == 1 {
                        reverse.insert(ustr.chars().next().unwrap(), cid_bytes);
                    }
                }
                rest = &rest[rb + 1..];
            }
            _ => break,
        }
    }
}

fn extract_hex_groups(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut in_group = false;
    let mut buf = String::new();
    for ch in s.chars() {
        match ch {
            '<' => {
                in_group = true;
                buf.clear();
            }
            '>' => {
                if in_group && !buf.is_empty() {
                    out.push(buf.clone());
                }
                in_group = false;
                buf.clear();
            }
            _ if in_group && ch.is_ascii_hexdigit() => buf.push(ch),
            _ => {}
        }
    }
    out
}

fn hex_to_bytes(hex: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(hex.len() / 2);
    let bytes = hex.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        let hi = hex_digit(bytes[i]);
        let lo = hex_digit(bytes[i + 1]);
        if let (Some(h), Some(l)) = (hi, lo) {
            out.push((h << 4) | l);
        }
        i += 2;
    }
    out
}

fn hex_digit(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Convert hex like "20AC" → "€" or "D83D DE80" → "🚀" (via surrogate
/// pair). Handles multi-codepoint strings by reading in 4-digit chunks.
fn hex_to_unicode(hex: &str) -> String {
    let cleaned: String = hex.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    let mut out = String::new();
    let bytes = cleaned.as_bytes();
    let mut i = 0;
    while i + 3 < bytes.len() {
        let mut cp: u32 = 0;
        for j in 0..4 {
            cp = cp * 16 + hex_digit(bytes[i + j]).unwrap_or(0) as u32;
        }
        i += 4;
        // Handle UTF-16 surrogate pair if present.
        if (0xD800..=0xDBFF).contains(&cp) && i + 3 < bytes.len() {
            let mut lo: u32 = 0;
            for j in 0..4 {
                lo = lo * 16 + hex_digit(bytes[i + j]).unwrap_or(0) as u32;
            }
            if (0xDC00..=0xDFFF).contains(&lo) {
                let combined = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                if let Some(ch) = char::from_u32(combined) {
                    out.push(ch);
                }
                i += 4;
                continue;
            }
        }
        if let Some(ch) = char::from_u32(cp) {
            out.push(ch);
        }
    }
    out
}

fn bytes_to_u32(bytes: &[u8]) -> u32 {
    let mut out: u32 = 0;
    for b in bytes {
        out = (out << 8) | (*b as u32);
    }
    out
}

fn u32_to_bytes(value: u32, width: usize) -> Vec<u8> {
    let mut out = vec![0u8; width];
    for i in 0..width {
        out[width - 1 - i] = ((value >> (i * 8)) & 0xFF) as u8;
    }
    out
}

/// Walk `operations`, matching a paragraph edit against the content
/// stream's Tj/TJ runs. Returns `true` if a rewrite was applied.
///
/// Two passes, fast-path first:
///   1. **Single-run.** One `Tj` or `TJ` whose decoded text exactly
///      equals `edit.original_text`. Preserves kerning (for `TJ`).
///   2. **Multi-run.** A contiguous slice of `Tj`/`TJ` operators whose
///      concatenated decoded texts equal `edit.original_text` under
///      one of several common separators (`\n`, space, empty). The
///      frontend paragraph clusterer joins multi-line paragraphs with
///      `\n`, so the `\n` case covers virtually every real paragraph
///      that wraps to 2+ lines. The `space` and empty cases catch
///      paragraphs where the PDF emitted multiple Tj's on the same
///      line (common with letter-by-letter kerning).
///
/// When the multi-run path matches, the full `edit.new_text` is placed
/// into the FIRST matched run; subsequent runs are emptied. This
/// coalesces the paragraph — saves lose the original kerning but the
/// content stream carries the correct text and extraction sees it.
fn try_rewrite_run(
    operations: &mut Vec<Operation>,
    edit: &ParagraphEdit,
    fonts: &HashMap<String, FontMeta>,
) -> Result<bool> {
    // Pass 1: single-run (preserves kerning/layout where possible).
    // Returns (first_op_idx, last_op_idx) — these are the same index
    // for a vanilla single-line replacement, and span the inserted
    // (Td, Tj) pairs when new_text contains newlines (G8 splice path).
    if let Some((first, last)) = try_rewrite_single_run(operations, edit, fonts)? {
        apply_position_delta(operations, first, last, edit.position_delta.as_ref());
        return Ok(true);
    }
    // Pass 2: multi-run match.
    if let Some((first, last)) = try_rewrite_multi_run(operations, edit, fonts)? {
        apply_position_delta(operations, first, last, edit.position_delta.as_ref());
        return Ok(true);
    }
    Ok(false)
}

/// Apply `position_delta` to an already-rewritten span [first_op, last_op]
/// in the content stream. Injects a `Td dx -dy` immediately before the
/// first edited Tj and a matching reverse `Td -dx dy` immediately after
/// the last, so text drawn outside the span keeps its original
/// positioning. Intermediate Tm operators inside the span have their
/// translation components shifted too — otherwise an absolute Tm
/// reposition mid-paragraph would clobber the forward Td.
///
/// PDF y-axis is up; UI `dy` is y-down (drag-down = positive). Negate dy.
fn apply_position_delta(
    operations: &mut Vec<Operation>,
    first_op: usize,
    last_op: usize,
    delta: Option<&crate::live::model::PositionDelta>,
) {
    let Some(delta) = delta else { return };
    if delta.dx.abs() < 0.001 && delta.dy.abs() < 0.001 {
        return;
    }
    let dx = delta.dx as f64;
    let dy_pdf = -(delta.dy as f64);

    // 1. Shift any intermediate Tm's e,f components so an absolute
    //    reposition inside the paragraph still honors the drag offset.
    for i in first_op..=last_op {
        let op = &mut operations[i];
        if op.operator == "Tm" && op.operands.len() == 6 {
            // operands: a b c d e f → e,f are translation.
            if let Some(e_obj) = op.operands.get_mut(4) {
                let cur = object_to_f64(e_obj).unwrap_or(0.0);
                *e_obj = Object::Real((cur + dx) as f32);
            }
            if let Some(f_obj) = op.operands.get_mut(5) {
                let cur = object_to_f64(f_obj).unwrap_or(0.0);
                *f_obj = Object::Real((cur + dy_pdf) as f32);
            }
        }
    }

    // 2. Insert reverse Td after last_op FIRST (before inserting forward,
    //    so the last_op index isn't shifted by the forward insertion).
    let reverse = Operation {
        operator: "Td".into(),
        operands: vec![Object::Real((-dx) as f32), Object::Real((-dy_pdf) as f32)],
    };
    operations.insert(last_op + 1, reverse);
    // 3. Insert forward Td before first_op.
    let forward = Operation {
        operator: "Td".into(),
        operands: vec![Object::Real(dx as f32), Object::Real(dy_pdf as f32)],
    };
    operations.insert(first_op, forward);
}

/// Best-effort numeric extract from an lopdf Object. Tm operands are
/// usually Real but sometimes emit as Integer for whole-number
/// translations, so accept both.
fn object_to_f64(obj: &Object) -> Option<f64> {
    match obj {
        Object::Real(r) => Some(*r as f64),
        Object::Integer(i) => Some(*i as f64),
        _ => None,
    }
}

/// After a successful rewrite, scan every Tj/TJ on the page and blank
/// the operand of any whose decoded text still matches one of the
/// originals we just edited. Those are overlay-bake leftovers — stale
/// copies of the original text living in an extra content stream that
/// a prior save (before multi-run support) appended on top.
///
/// Returns true if the operations vector was modified.
///
/// Edge case: a document might legitimately contain the same string
/// multiple times (e.g. "Total:" on a line-item table). If the user
/// edits ONE of those paragraphs, this will also blank the other
/// legitimate occurrences — accepted tradeoff for the overlay-cleanup
/// win. Mitigated in practice because the clusterer passes the full
/// original_text (full paragraph, not single words), and paragraph-
/// level duplicates are rare.
fn strip_stale_overlay_runs(
    operations: &mut Vec<Operation>,
    fonts: &HashMap<String, FontMeta>,
    originals: &[&str],
) -> bool {
    let mut modified = false;
    let mut current_font_name: Option<String> = None;
    for op in operations.iter_mut() {
        match op.operator.as_str() {
            "Tf" => {
                if let Some(Object::Name(n)) = op.operands.first() {
                    current_font_name = Some(String::from_utf8_lossy(n).into_owned());
                }
            }
            "Tj" => {
                let Some(meta) = current_font_name.as_deref().and_then(|n| fonts.get(n)) else {
                    continue;
                };
                let Some(Object::String(bytes, fmt)) = op.operands.first().cloned() else {
                    continue;
                };
                let decoded = decode_text(&bytes, meta);
                if originals.iter().any(|o| *o == decoded) {
                    op.operands = vec![Object::String(Vec::new(), fmt)];
                    modified = true;
                }
            }
            "TJ" => {
                let Some(meta) = current_font_name.as_deref().and_then(|n| fonts.get(n)) else {
                    continue;
                };
                let Some(Object::Array(items)) = op.operands.first().cloned() else {
                    continue;
                };
                let mut combined = Vec::new();
                for it in &items {
                    if let Object::String(b, _) = it {
                        combined.extend_from_slice(b);
                    }
                }
                let decoded = decode_text(&combined, meta);
                if originals.iter().any(|o| *o == decoded) {
                    op.operands = vec![Object::Array(vec![Object::String(
                        Vec::new(),
                        lopdf::StringFormat::Hexadecimal,
                    )])];
                    modified = true;
                }
            }
            _ => {}
        }
    }
    modified
}

/// On a successful rewrite, returns `Some((first_op_idx, last_op_idx))`
/// so the caller can apply per-paragraph transforms (position_delta)
/// scoped to the rewrite's full op span.
///
/// For a vanilla single-line replacement, first==last (the matched
/// Tj/TJ op). For the G8 splice path — where `edit.original_text` is
/// a single-line single-run match but `edit.new_text` contains '\n'
/// separators — first==matched_idx and last==matched_idx + 2*(N-1)
/// where N is the line count, because we splice (Td 0 -leading) +
/// (Tj line_bytes) pairs after the matched op for each subsequent
/// line.
///
/// Returns `None` if no single Tj/TJ matches the full original text.
fn try_rewrite_single_run(
    operations: &mut Vec<Operation>,
    edit: &ParagraphEdit,
    fonts: &HashMap<String, FontMeta>,
) -> Result<Option<(usize, usize)>> {
    // Pass 1 — scan immutably for a Tj/TJ whose decoded text == original.
    // We track the most recent Tf so we can carry the font size into the
    // splice path's leading calculation. We also remember the match's
    // string format so the mutation pass preserves it.
    struct MatchSite {
        idx: usize,
        font_name: String,
        font_size: f32,
        is_tj: bool,
        fmt: lopdf::StringFormat,
    }
    let matched: Option<MatchSite> = {
        let mut current_font_name: Option<String> = None;
        let mut current_font_size: f32 = 10.0;
        let mut found: Option<MatchSite> = None;
        for (idx, op) in operations.iter().enumerate() {
            match op.operator.as_str() {
                "Tf" => {
                    if let Some(Object::Name(n)) = op.operands.first() {
                        current_font_name = Some(String::from_utf8_lossy(n).into_owned());
                    }
                    if let Some(size_obj) = op.operands.get(1) {
                        if let Some(s) = object_to_f64(size_obj) {
                            current_font_size = s as f32;
                        }
                    }
                }
                "Tj" => {
                    let Some(meta) = current_font_name.as_deref().and_then(|n| fonts.get(n)) else {
                        continue;
                    };
                    let Some(Object::String(bytes, fmt)) = op.operands.first() else {
                        continue;
                    };
                    let decoded = decode_text(bytes, meta);
                    if decoded == edit.original_text {
                        found = Some(MatchSite {
                            idx,
                            font_name: current_font_name.clone().unwrap(),
                            font_size: current_font_size,
                            is_tj: true,
                            fmt: *fmt,
                        });
                        break;
                    }
                }
                "TJ" => {
                    let Some(meta) = current_font_name.as_deref().and_then(|n| fonts.get(n)) else {
                        continue;
                    };
                    let Some(Object::Array(items)) = op.operands.first() else {
                        continue;
                    };
                    let mut combined_bytes = Vec::new();
                    let mut first_fmt = lopdf::StringFormat::Hexadecimal;
                    let mut have_fmt = false;
                    for item in items {
                        if let Object::String(b, f) = item {
                            combined_bytes.extend_from_slice(b);
                            if !have_fmt {
                                first_fmt = *f;
                                have_fmt = true;
                            }
                        }
                    }
                    let decoded = decode_text(&combined_bytes, meta);
                    if decoded == edit.original_text {
                        found = Some(MatchSite {
                            idx,
                            font_name: current_font_name.clone().unwrap(),
                            font_size: current_font_size,
                            is_tj: false,
                            fmt: first_fmt,
                        });
                        break;
                    }
                }
                _ => {}
            }
        }
        found
    };

    let Some(m) = matched else {
        return Ok(None);
    };
    // We verified the font in pass 1, so this lookup can't fail.
    let meta = fonts
        .get(&m.font_name)
        .expect("font present in pass 1 but missing in pass 2");

    // G8: original is a single-line single-run match, but new_text
    // contains '\n'. We can't pack '\n' into a Tj — PDF text-show ops
    // have no newline concept. Splice (Td 0 -leading) + (Tj <line>)
    // pairs after the matched op for each subsequent line.
    let needs_multiline_splice = edit.new_text.contains('\n') && !edit.original_text.contains('\n');

    if needs_multiline_splice {
        return splice_multiline_replacement(
            operations,
            m.idx,
            &edit.new_text,
            meta,
            m.font_size,
            m.is_tj,
        )
        .map(Some);
    }

    // Pass 2 — vanilla in-place rewrite.
    let new_bytes = encode_text(&edit.new_text, meta)?;
    let op = &mut operations[m.idx];
    if m.is_tj {
        op.operands = vec![Object::String(new_bytes, m.fmt)];
    } else {
        op.operands = vec![Object::Array(vec![Object::String(
            new_bytes,
            lopdf::StringFormat::Hexadecimal,
        )])];
    }
    Ok(Some((m.idx, m.idx)))
}

/// G8 splice: the matched Tj/TJ at `matched_idx` had decoded text
/// equal to `edit.original_text` (single-line). `new_text` contains
/// '\n' separators. Replace operands[0] of operations[matched_idx]
/// with the encoded first line, then splice
///   `Td 0 -leading`
///   `Tj <encoded_line>`
/// pairs after it for each subsequent line.
///
/// Leading is `font_size * 1.2` (typographic baseline-to-baseline
/// default, capped at a 8-pt floor for tiny fonts). PDF default
/// leading is 0 without an explicit `TL`, so emitting `Td` with an
/// explicit `-leading` is the only portable way to drop a line.
///
/// `Td 0 -leading` resets the text-line-matrix to (line_x, prev_y -
/// leading) — i.e. start of next line at the same x as the original
/// run — which matches Acrobat's "press Enter" paragraph behavior.
///
/// Returns the (first_op_idx, last_op_idx) span of the rewritten +
/// inserted ops so apply_position_delta can bracket the whole thing.
fn splice_multiline_replacement(
    operations: &mut Vec<Operation>,
    matched_idx: usize,
    new_text: &str,
    meta: &FontMeta,
    font_size: f32,
    is_tj: bool,
) -> Result<(usize, usize)> {
    let lines: Vec<&str> = new_text.split('\n').collect();
    debug_assert!(lines.len() > 1, "splice called with <2 lines");
    // Standard typographic leading. 1.2× is the default browsers and
    // most word processors use; capped at 8pt floor so tiny fonts
    // don't collapse lines on top of each other.
    let leading = ((font_size as f64) * 1.2).max(8.0);

    // Replace the matched op's operand with first-line bytes. If
    // the original op was TJ, simplify to plain Tj — the original
    // kerning array would no longer match the new text anyway, and
    // a single Tj is the canonical shape for a fresh single-line run.
    let first_bytes = encode_text(lines[0], meta)?;
    let matched = &mut operations[matched_idx];
    if is_tj {
        let fmt = match matched.operands.first() {
            Some(Object::String(_, f)) => *f,
            _ => lopdf::StringFormat::Hexadecimal,
        };
        matched.operands = vec![Object::String(first_bytes, fmt)];
    } else {
        matched.operator = "Tj".into();
        matched.operands = vec![Object::String(
            first_bytes,
            lopdf::StringFormat::Hexadecimal,
        )];
    }

    // Build (Td 0 -leading) (Tj line_bytes) for each subsequent line.
    let mut inserts: Vec<Operation> = Vec::with_capacity((lines.len() - 1) * 2);
    for line in &lines[1..] {
        let bytes = encode_text(line, meta)?;
        inserts.push(Operation {
            operator: "Td".into(),
            operands: vec![Object::Real(0.0), Object::Real(-leading as f32)],
        });
        inserts.push(Operation {
            operator: "Tj".into(),
            operands: vec![Object::String(bytes, lopdf::StringFormat::Hexadecimal)],
        });
    }

    let last_idx = matched_idx + inserts.len();
    operations.splice((matched_idx + 1)..(matched_idx + 1), inserts);
    Ok((matched_idx, last_idx))
}

/// Collect ordered (op_idx, font_name, is_tj, decoded_text) for every
/// text-show op in the content stream, so the multi-run matcher can
/// walk slices.
struct RunInfo {
    op_idx: usize,
    font_name: String,
    is_tj: bool, // true = Tj, false = TJ
    decoded: String,
}

fn collect_runs(operations: &[Operation], fonts: &HashMap<String, FontMeta>) -> Vec<RunInfo> {
    let mut out = Vec::new();
    let mut current_font_name: Option<String> = None;
    for (idx, op) in operations.iter().enumerate() {
        match op.operator.as_str() {
            "Tf" => {
                if let Some(Object::Name(n)) = op.operands.first() {
                    current_font_name = Some(String::from_utf8_lossy(n).into_owned());
                }
            }
            "Tj" => {
                let Some(fname) = current_font_name.as_deref() else {
                    continue;
                };
                let Some(meta) = fonts.get(fname) else {
                    continue;
                };
                if let Some(Object::String(bytes, _)) = op.operands.first() {
                    let decoded = decode_text(bytes, meta);
                    out.push(RunInfo {
                        op_idx: idx,
                        font_name: fname.to_string(),
                        is_tj: true,
                        decoded,
                    });
                }
            }
            "TJ" => {
                let Some(fname) = current_font_name.as_deref() else {
                    continue;
                };
                let Some(meta) = fonts.get(fname) else {
                    continue;
                };
                if let Some(Object::Array(items)) = op.operands.first() {
                    let mut combined = Vec::new();
                    for it in items {
                        if let Object::String(b, _) = it {
                            combined.extend_from_slice(b);
                        }
                    }
                    let decoded = decode_text(&combined, meta);
                    out.push(RunInfo {
                        op_idx: idx,
                        font_name: fname.to_string(),
                        is_tj: false,
                        decoded,
                    });
                }
            }
            _ => {}
        }
    }
    out
}

/// On success returns `Some((first_op_idx, last_op_idx))` — the indices
/// of the first and last Tj/TJ the rewrite touched, so the caller can
/// bracket them with position_delta transforms.
fn try_rewrite_multi_run(
    operations: &mut Vec<Operation>,
    edit: &ParagraphEdit,
    fonts: &HashMap<String, FontMeta>,
) -> Result<Option<(usize, usize)>> {
    let runs = collect_runs(operations, fonts);
    if runs.len() < 2 {
        return Ok(None);
    }
    // Separator candidates, ordered by frequency in real PDFs:
    //   "\n"  — frontend clusters multi-line paragraphs with \n
    //   " "   — multi-Tj on the same line (rare but seen)
    //   ""    — letter-by-letter kerning (old PDF generators)
    //
    // Each Tj/TJ carries ONE line of glyphs — PDF text ops have no
    // newline concept (line breaks happen via Td/Tm between runs).
    // So for sep='\n' we must split new_text back into N parts; we
    // can't pack a '\n' into a single Tj.
    const SEPS: &[&str] = &["\n", " ", ""];

    for start in 0..runs.len() {
        for end in start..runs.len() {
            for sep in SEPS {
                let combined = runs[start..=end]
                    .iter()
                    .map(|r| r.decoded.as_str())
                    .collect::<Vec<_>>()
                    .join(sep);
                if combined == edit.original_text {
                    let first_idx = runs[start].op_idx;
                    let last_idx = runs[end].op_idx;
                    let applied = apply_multi_run_rewrite(
                        operations,
                        &runs[start..=end],
                        &edit.new_text,
                        sep,
                        fonts,
                    )?;
                    return Ok(if applied {
                        Some((first_idx, last_idx))
                    } else {
                        None
                    });
                }
                // Early exit: once combined is longer than original, trying
                // more end-indices with the same/shorter separators can only
                // grow it further.
                if combined.len() > edit.original_text.len() + 2 {
                    break;
                }
            }
        }
    }
    Ok(None)
}

/// Fan `new_text` across the matched run slice using the same separator
/// that matched the original. Two modes:
///
///   - **sep == "\n"**: split `new_text` into N parts; N must equal
///     the slice length so each Tj gets one line. This preserves line
///     structure. If the user added/removed `\n`s so counts differ,
///     fall back to putting everything in the LAST slot (best heuristic
///     for Western-edit behavior: edits append to the last line) — but
///     only if all prior runs' original text is still a prefix of the
///     new text. Otherwise error out and let overlay take it.
///
///   - **sep == " " or ""**: collapse into a single Tj — the paragraph
///     reflows on render, but within-line text has no notion of line
///     breaks anyway. Put the full new_text into the first run, empty
///     the rest.
fn apply_multi_run_rewrite(
    operations: &mut Vec<Operation>,
    runs: &[RunInfo],
    new_text: &str,
    sep: &str,
    fonts: &HashMap<String, FontMeta>,
) -> Result<bool> {
    if sep == "\n" {
        // Newline-separated (multi-line paragraph). Split new_text.
        let new_parts: Vec<&str> = new_text.split('\n').collect();
        if new_parts.len() == runs.len() {
            // Happy path: same line count. One part per run.
            for (i, run) in runs.iter().enumerate() {
                let meta = fonts.get(&run.font_name).ok_or_else(|| {
                    AppError::Pdf(format!(
                        "true-text: font '{}' vanished between collect+rewrite",
                        run.font_name
                    ))
                })?;
                let bytes = encode_text(new_parts[i], meta)?;
                replace_text_operand(&mut operations[run.op_idx], run.is_tj, bytes);
            }
            return Ok(true);
        }
        // Line count changed. Only safe re-fan if all prior lines
        // are unchanged and the change is confined to the LAST line
        // (typical for append-style edits). Otherwise give up.
        if new_parts.len() > runs.len() {
            let unchanged_prefix = new_parts.len() == runs.len() + (new_parts.len() - runs.len())
                && (0..runs.len() - 1).all(|i| new_parts[i] == runs[i].decoded);
            if !unchanged_prefix {
                return Ok(false); // caller falls back to overlay
            }
            // Put the excess lines in the final Tj as a single string —
            // loses the paragraph-internal line break but preserves content.
            for (i, run) in runs.iter().enumerate() {
                let meta = fonts.get(&run.font_name).ok_or_else(|| {
                    AppError::Pdf(format!("true-text: font '{}' vanished", run.font_name))
                })?;
                let content = if i < runs.len() - 1 {
                    new_parts[i].to_string()
                } else {
                    new_parts[i..].join(" ") // collapse trailing extras
                };
                let bytes = encode_text(&content, meta)?;
                replace_text_operand(&mut operations[run.op_idx], run.is_tj, bytes);
            }
            return Ok(true);
        }
        // Fewer lines than originally. Typical when user deletes a
        // newline. Pack remaining parts into leading runs; empty trailing.
        for (i, run) in runs.iter().enumerate() {
            let meta = fonts.get(&run.font_name).ok_or_else(|| {
                AppError::Pdf(format!("true-text: font '{}' vanished", run.font_name))
            })?;
            let content = new_parts.get(i).copied().unwrap_or("");
            let bytes = encode_text(content, meta)?;
            replace_text_operand(&mut operations[run.op_idx], run.is_tj, bytes);
        }
        return Ok(true);
    }

    // Non-newline separator: collapse into first run, empty the rest.
    let first_meta = fonts.get(&runs[0].font_name).ok_or_else(|| {
        AppError::Pdf(format!("true-text: font '{}' vanished", runs[0].font_name))
    })?;
    let first_bytes = encode_text(new_text, first_meta)?;
    for (i, run) in runs.iter().enumerate() {
        let bytes = if i == 0 {
            first_bytes.clone()
        } else {
            Vec::new()
        };
        replace_text_operand(&mut operations[run.op_idx], run.is_tj, bytes);
    }
    Ok(true)
}

fn replace_text_operand(op: &mut Operation, is_tj: bool, new_bytes: Vec<u8>) {
    if is_tj {
        let fmt = match op.operands.first() {
            Some(Object::String(_, f)) => *f,
            _ => lopdf::StringFormat::Literal,
        };
        op.operands = vec![Object::String(new_bytes, fmt)];
    } else {
        op.operands = vec![Object::Array(vec![Object::String(
            new_bytes,
            lopdf::StringFormat::Hexadecimal,
        )])];
    }
}

/// Decompress a PDF stream through its /Filter chain. Falls back to
/// a manual chain when lopdf's built-in `decompressed_content()`
/// errors — which happens on combinations like `[/ASCII85Decode
/// /FlateDecode]` that lopdf 0.32 doesn't handle natively.
///
/// Supports these filter tokens in chains of up to 4 stages:
///   - FlateDecode / Fl
///   - ASCII85Decode / A85
///   - ASCIIHexDecode / AHx
///
/// Unsupported filters (DCTDecode, CCITTFaxDecode, etc.) still error
/// — those encode raster images, not text content streams, so we
/// wouldn't try to decode them for rewrite anyway.
fn decompress_stream(stream: &Stream) -> std::result::Result<Vec<u8>, String> {
    // Happy path — lopdf handles the common single-filter cases and
    // most pairs. Returns Ok on plain /FlateDecode, /ASCIIHexDecode,
    // and direct-bytes streams.
    if let Ok(data) = stream.decompressed_content() {
        return Ok(data);
    }
    // No /Filter key → the stream is already raw bytes. Common case
    // when we read back a stream we previously rewrote: the writer
    // strips /Filter because we emit uncompressed. Return content as-is.
    // Also covers originally-uncompressed streams that lopdf refuses
    // for unrelated reasons.
    let filters = match extract_filter_chain(&stream.dict) {
        Some(fs) if !fs.is_empty() => fs,
        _ => return Ok(stream.content.clone()),
    };
    // Fallback — walk the filter chain manually.
    let mut data = stream.content.clone();
    for (i, filter) in filters.iter().enumerate() {
        data = match filter.as_slice() {
            b"FlateDecode" | b"Fl" => {
                flate_decode(&data).map_err(|e| format!("stage {i} FlateDecode: {e}"))?
            }
            b"ASCII85Decode" | b"A85" => {
                ascii85_decode(&data).map_err(|e| format!("stage {i} ASCII85Decode: {e}"))?
            }
            b"ASCIIHexDecode" | b"AHx" => {
                ascii_hex_decode(&data).map_err(|e| format!("stage {i} ASCIIHexDecode: {e}"))?
            }
            other => {
                return Err(format!(
                    "unsupported filter /{} at chain stage {i}",
                    String::from_utf8_lossy(other)
                ))
            }
        };
    }
    Ok(data)
}

/// Extract the ordered /Filter list from a stream's dict. Handles the
/// single-Name case (`/Filter /FlateDecode`) and the array case
/// (`/Filter [ /ASCII85Decode /FlateDecode ]`).
fn extract_filter_chain(dict: &lopdf::Dictionary) -> Option<Vec<Vec<u8>>> {
    let f = dict.get(b"Filter").ok()?;
    match f {
        Object::Name(n) => Some(vec![n.clone()]),
        Object::Array(items) => {
            let mut out = Vec::with_capacity(items.len());
            for it in items {
                if let Object::Name(n) = it {
                    out.push(n.clone());
                }
            }
            Some(out)
        }
        _ => None,
    }
}

/// zlib-inflate a buffer.
fn flate_decode(data: &[u8]) -> std::result::Result<Vec<u8>, String> {
    let mut out = Vec::new();
    ZlibDecoder::new(Cursor::new(data))
        .read_to_end(&mut out)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

/// Decode ASCII85 ("base85") per PDF 32000-1 §7.4.3. Terminates on the
/// `~>` sequence; tolerates whitespace inside the stream.
fn ascii85_decode(data: &[u8]) -> std::result::Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(data.len() * 4 / 5);
    let mut group: [u8; 5] = [0; 5];
    let mut glen = 0usize;
    for &b in data {
        // ~> terminates the stream.
        if b == b'~' {
            break;
        }
        // 'z' shortcut for all-zero 4-byte group.
        if glen == 0 && b == b'z' {
            out.extend_from_slice(&[0, 0, 0, 0]);
            continue;
        }
        // Skip whitespace.
        if matches!(b, b' ' | b'\t' | b'\r' | b'\n' | 0x0C) {
            continue;
        }
        if !(b'!'..=b'u').contains(&b) {
            return Err(format!("invalid ASCII85 byte 0x{b:02x}"));
        }
        group[glen] = b - b'!';
        glen += 1;
        if glen == 5 {
            let val: u32 = group[0] as u32 * 85u32.pow(4)
                + group[1] as u32 * 85u32.pow(3)
                + group[2] as u32 * 85u32.pow(2)
                + group[3] as u32 * 85
                + group[4] as u32;
            out.push((val >> 24) as u8);
            out.push((val >> 16) as u8);
            out.push((val >> 8) as u8);
            out.push(val as u8);
            glen = 0;
        }
    }
    if glen > 0 {
        // Final partial group: pad with 'u' (84), decode, truncate.
        for i in glen..5 {
            group[i] = 84;
        }
        let val: u32 = group[0] as u32 * 85u32.pow(4)
            + group[1] as u32 * 85u32.pow(3)
            + group[2] as u32 * 85u32.pow(2)
            + group[3] as u32 * 85
            + group[4] as u32;
        let bytes = [
            (val >> 24) as u8,
            (val >> 16) as u8,
            (val >> 8) as u8,
            val as u8,
        ];
        // A group of glen chars decodes to (glen - 1) bytes.
        out.extend_from_slice(&bytes[..glen.saturating_sub(1)]);
    }
    Ok(out)
}

/// Decode ASCII hex per PDF 32000-1 §7.4.2. Tolerates whitespace;
/// terminates on `>`.
fn ascii_hex_decode(data: &[u8]) -> std::result::Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(data.len() / 2);
    let mut nibble: Option<u8> = None;
    for &b in data {
        if b == b'>' {
            break;
        }
        if matches!(b, b' ' | b'\t' | b'\r' | b'\n' | 0x0C) {
            continue;
        }
        let v = match b {
            b'0'..=b'9' => b - b'0',
            b'a'..=b'f' => b - b'a' + 10,
            b'A'..=b'F' => b - b'A' + 10,
            _ => return Err(format!("invalid hex byte 0x{b:02x}")),
        };
        nibble = match nibble {
            Some(hi) => {
                out.push((hi << 4) | v);
                None
            }
            None => Some(v),
        };
    }
    if let Some(hi) = nibble {
        // Odd-nibble tail: treat missing low nibble as 0.
        out.push(hi << 4);
    }
    Ok(out)
}

/// Enumerate every `Tj` / `TJ` run on every page, returning the decoded
/// Unicode text per run. Returns `Vec<Vec<String>>` keyed by zero-based
/// page index (not 1-based lopdf index).
///
/// Intended for diagnostic / harness use — e.g. the `invoice_loop`
/// binary iterates this to exercise every text run in a corpus of
/// PDFs through the true-rewrite pipeline.
///
/// Pages where `collect_page_fonts` returns empty yield an empty Vec
/// (not an error — the caller decides what to do).
pub fn list_page_text_runs(original_bytes: &[u8]) -> Result<Vec<Vec<String>>> {
    let mut cursor = Cursor::new(original_bytes);
    let doc = Document::load_from(&mut cursor)
        .map_err(|e| AppError::Pdf(format!("list-runs: parse: {e}")))?;
    let pages = doc.get_pages();
    let mut sorted: Vec<(u32, ObjectId)> = pages.into_iter().collect();
    sorted.sort_by_key(|(idx, _)| *idx);

    let mut out: Vec<Vec<String>> = Vec::with_capacity(sorted.len());
    for (_, page_id) in sorted {
        let fonts = collect_page_fonts(&doc, page_id);
        let mut page_runs: Vec<String> = Vec::new();
        if fonts.is_empty() {
            out.push(page_runs);
            continue;
        }
        let content_ids = doc.get_page_contents(page_id);
        for content_id in content_ids {
            let Ok(stream_obj) = doc.get_object(content_id).and_then(Object::as_stream) else {
                continue;
            };
            let Ok(data) = decompress_stream(stream_obj) else {
                continue;
            };
            let Ok(content) = Content::decode(&data) else {
                continue;
            };
            let mut current_font: Option<String> = None;
            for op in &content.operations {
                match op.operator.as_str() {
                    "Tf" => {
                        if let Some(Object::Name(n)) = op.operands.first() {
                            current_font = Some(String::from_utf8_lossy(n).into_owned());
                        }
                    }
                    "Tj" => {
                        let Some(meta) = current_font.as_deref().and_then(|n| fonts.get(n)) else {
                            continue;
                        };
                        if let Some(Object::String(bytes, _)) = op.operands.first() {
                            let text = decode_text(bytes, meta);
                            if !text.is_empty() {
                                page_runs.push(text);
                            }
                        }
                    }
                    "TJ" => {
                        let Some(meta) = current_font.as_deref().and_then(|n| fonts.get(n)) else {
                            continue;
                        };
                        if let Some(Object::Array(items)) = op.operands.first() {
                            let mut combined = Vec::new();
                            for it in items {
                                if let Object::String(b, _) = it {
                                    combined.extend_from_slice(b);
                                }
                            }
                            let text = decode_text(&combined, meta);
                            if !text.is_empty() {
                                page_runs.push(text);
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        out.push(page_runs);
    }
    Ok(out)
}

fn decode_text(bytes: &[u8], meta: &FontMeta) -> String {
    let mut out = String::new();
    let w = meta.code_width;
    let mut i = 0;
    while i + w <= bytes.len() {
        let code = &bytes[i..i + w];
        if let Some(s) = meta.forward_cmap.get(code) {
            out.push_str(s);
        }
        i += w;
    }
    out
}

fn encode_text(text: &str, meta: &FontMeta) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    for ch in text.chars() {
        let Some(cid_bytes) = meta.reverse_cmap.get(&ch) else {
            return Err(AppError::Pdf(format!(
                "true-text: char {:?} (U+{:04X}) not in font's ToUnicode CMap",
                ch, ch as u32
            )));
        };
        out.extend_from_slice(cid_bytes);
    }
    Ok(out)
}

// ── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bfchar_parse_basic() {
        let cmap = b"
/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
3 beginbfchar
<0003> <0020>
<0048> <0048>
<0069> <0069>
endbfchar
endcmap";
        let (forward, reverse, width) = parse_tounicode_cmap(cmap);
        assert_eq!(width, 2);
        assert_eq!(forward.get(&vec![0x00, 0x03]), Some(&" ".to_string()));
        assert_eq!(forward.get(&vec![0x00, 0x48]), Some(&"H".to_string()));
        assert_eq!(reverse.get(&'H'), Some(&vec![0x00, 0x48]));
        assert_eq!(reverse.get(&'i'), Some(&vec![0x00, 0x69]));
    }

    #[test]
    fn bfrange_contiguous() {
        let cmap = b"
1 begincodespacerange <0000> <FFFF> endcodespacerange
1 beginbfrange
<0020> <0024> <0020>
endbfrange";
        let (_, reverse, _) = parse_tounicode_cmap(cmap);
        // 0x0020-0x0024 should map to U+0020-U+0024 (space through $).
        assert_eq!(reverse.get(&' '), Some(&vec![0x00, 0x20]));
        assert_eq!(reverse.get(&'!'), Some(&vec![0x00, 0x21]));
        assert_eq!(reverse.get(&'$'), Some(&vec![0x00, 0x24]));
    }

    #[test]
    fn bfrange_explicit_array() {
        let cmap = b"
1 begincodespacerange <0000> <FFFF> endcodespacerange
1 beginbfrange
<0080> <0082> [<20AC> <201A> <0192>]
endbfrange";
        let (_, reverse, _) = parse_tounicode_cmap(cmap);
        assert_eq!(reverse.get(&'\u{20AC}'), Some(&vec![0x00, 0x80])); // €
        assert_eq!(reverse.get(&'\u{201A}'), Some(&vec![0x00, 0x81])); // ‚
        assert_eq!(reverse.get(&'\u{0192}'), Some(&vec![0x00, 0x82])); // ƒ
    }

    #[test]
    fn encode_text_rejects_unmappable() {
        let mut reverse = HashMap::new();
        reverse.insert('a', vec![0x00, 0x61]);
        let meta = FontMeta {
            reverse_cmap: reverse,
            forward_cmap: HashMap::new(),
            code_width: 2,
        };
        // 'a' maps, 'z' doesn't → error.
        assert!(encode_text("az", &meta).is_err());
        // Pure 'a' works.
        assert_eq!(encode_text("a", &meta).unwrap(), vec![0x00, 0x61]);
    }

    #[test]
    fn splice_multiline_emits_td_between_tj_runs() {
        // Build a tiny FontMeta covering 'a'..='z', '0'..='9', ' '.
        let mut forward: HashMap<Vec<u8>, String> = HashMap::new();
        let mut reverse: HashMap<char, Vec<u8>> = HashMap::new();
        let chars: Vec<char> = ('a'..='z')
            .chain('0'..='9')
            .chain([' '].iter().copied())
            .collect();
        for (i, ch) in chars.iter().enumerate() {
            // Codes 0x0030..= for printable, packed into 2 bytes.
            let code = 0x0030u16 + i as u16;
            let bytes = vec![(code >> 8) as u8, (code & 0xFF) as u8];
            forward.insert(bytes.clone(), ch.to_string());
            reverse.insert(*ch, bytes);
        }
        let meta = FontMeta {
            reverse_cmap: reverse,
            forward_cmap: forward,
            code_width: 2,
        };

        // Build a content stream: Tf F1 12 / Tj <encode("hello")>
        let hello_bytes = encode_text("hello", &meta).unwrap();
        let mut ops = vec![
            Operation {
                operator: "Tf".into(),
                operands: vec![Object::Name(b"F1".to_vec()), Object::Real(12.0)],
            },
            Operation {
                operator: "Tj".into(),
                operands: vec![Object::String(
                    hello_bytes,
                    lopdf::StringFormat::Hexadecimal,
                )],
            },
        ];

        // Splice "hello\nworld\n123" at idx=1 with font_size 12.
        let span =
            splice_multiline_replacement(&mut ops, 1, "hello\nworld\n123", &meta, 12.0, true)
                .unwrap();

        // Expected ops vec layout:
        //   [0] Tf F1 12
        //   [1] Tj "hello"               (rewritten, was the matched op)
        //   [2] Td 0 -14.4               (-leading, 12 * 1.2)
        //   [3] Tj "world"
        //   [4] Td 0 -14.4
        //   [5] Tj "123"
        // span = (1, 5)
        assert_eq!(span, (1, 5), "expected (1, 5), got {:?}", span);
        assert_eq!(ops.len(), 6, "expected 6 ops total, got {}", ops.len());
        assert_eq!(ops[2].operator, "Td");
        assert_eq!(ops[3].operator, "Tj");
        assert_eq!(ops[4].operator, "Td");
        assert_eq!(ops[5].operator, "Tj");

        // Verify the splice's Td translation: 0, -14.4 (12 * 1.2).
        if let [Object::Real(tx), Object::Real(ty)] = ops[2].operands.as_slice() {
            assert!((tx - 0.0).abs() < 0.001);
            assert!(
                (ty - -14.4).abs() < 0.01,
                "expected -14.4 leading, got {}",
                ty
            );
        } else {
            panic!("Td operands not Real, Real");
        }

        // Round-trip: decode each Tj and confirm the lines.
        let mut decoded_lines: Vec<String> = Vec::new();
        for op in &ops {
            if op.operator == "Tj" {
                if let Some(Object::String(b, _)) = op.operands.first() {
                    decoded_lines.push(decode_text(b, &meta));
                }
            }
        }
        assert_eq!(decoded_lines, vec!["hello", "world", "123"]);
    }

    #[test]
    fn splice_multiline_handles_empty_lines() {
        // Confirm that a paragraph with consecutive newlines splits into
        // empty Tj operands rather than dropping or merging the lines.
        let mut forward: HashMap<Vec<u8>, String> = HashMap::new();
        let mut reverse: HashMap<char, Vec<u8>> = HashMap::new();
        for (i, ch) in ('a'..='z').enumerate() {
            let code = 0x0030u16 + i as u16;
            let bytes = vec![(code >> 8) as u8, (code & 0xFF) as u8];
            forward.insert(bytes.clone(), ch.to_string());
            reverse.insert(ch, bytes);
        }
        let meta = FontMeta {
            reverse_cmap: reverse,
            forward_cmap: forward,
            code_width: 2,
        };
        let mut ops = vec![
            Operation {
                operator: "Tf".into(),
                operands: vec![Object::Name(b"F1".to_vec()), Object::Real(10.0)],
            },
            Operation {
                operator: "Tj".into(),
                operands: vec![Object::String(
                    encode_text("aaa", &meta).unwrap(),
                    lopdf::StringFormat::Hexadecimal,
                )],
            },
        ];
        // "aaa\n\nbbb" — empty middle line.
        let span =
            splice_multiline_replacement(&mut ops, 1, "aaa\n\nbbb", &meta, 10.0, true).unwrap();
        // Layout: [0] Tf, [1] Tj "aaa", [2] Td, [3] Tj "", [4] Td, [5] Tj "bbb"
        assert_eq!(span, (1, 5));
        assert_eq!(ops.len(), 6);
        if let Some(Object::String(b, _)) = ops[3].operands.first() {
            assert!(
                b.is_empty(),
                "middle empty-line Tj should have empty operand"
            );
        } else {
            panic!("ops[3] not a Tj string");
        }
    }

    #[test]
    fn decode_round_trips_via_reverse_map() {
        // Build a tiny CMap with bidirectional entries.
        let mut forward = HashMap::new();
        let mut reverse = HashMap::new();
        for (cid, ch) in &[(0x0048, 'H'), (0x0069, 'i')] {
            let bytes = vec![(*cid >> 8) as u8, (*cid & 0xFF) as u8];
            forward.insert(bytes.clone(), ch.to_string());
            reverse.insert(*ch, bytes);
        }
        let meta = FontMeta {
            reverse_cmap: reverse,
            forward_cmap: forward,
            code_width: 2,
        };
        // Encode 'Hi' → [0, 0x48, 0, 0x69] → decode → "Hi".
        let encoded = encode_text("Hi", &meta).unwrap();
        assert_eq!(encoded, vec![0x00, 0x48, 0x00, 0x69]);
        assert_eq!(decode_text(&encoded, &meta), "Hi");
    }
}
