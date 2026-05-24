//! Font extraction — Session 8.
//!
//! Pulls embedded font bytes out of a PDF so the frontend can
//! register them via the `FontFace` API and render the paragraph-
//! edit overlay in the PDF's actual typeface. Combined with the
//! S6 selective-op render, this closes the "seamless edit" loop:
//! the background stays native (pdfium render, no mask) AND the
//! overlay glyphs match the original font's metrics exactly.
//!
//! # What gets extracted
//!
//! PDF font objects have a `FontDescriptor` dict pointing at one of:
//! - `/FontFile` — raw Type1 / PostScript Type1
//! - `/FontFile2` — TrueType / OpenType
//! - `/FontFile3` — CFF / OpenType-CFF
//!
//! Browsers accept TrueType (`font/ttf`) and OpenType (`font/otf`)
//! directly; PostScript Type1 via `FontFile` is less useful since
//! browsers dropped Type1 support. S8 extracts all three and labels
//! the format so the frontend can decide whether to use or skip.
//!
//! # Subsetting caveat (S8.5)
//!
//! Embedded fonts are almost always SUBSETTED — they contain only
//! the glyphs used on the page, not the full character repertoire.
//! A paragraph edit that types a character outside the subset falls
//! back to a system font mid-word, producing a visible glyph
//! mismatch. S8 ships the extraction; S8.5 handles the subset-
//! fallback UX (detect unmapped chars at input time, swap to a
//! compatible system font paragraph-wide or refill the subset).

use crate::error::AppError;
use crate::Result;
use lopdf::{Document, Object};
use std::io::Cursor;

/// Format of an extracted font, suitable for the frontend's
/// `@font-face src: format('...')` declaration.
#[derive(Debug, Clone, Copy, serde::Serialize)]
pub enum ExtractedFontFormat {
    /// `FontFile` — Type1 / PostScript Type1. Browser support dropped.
    Type1,
    /// `FontFile2` — TrueType. Widely browser-supported.
    TrueType,
    /// `FontFile3` — CFF / OpenType-CFF. Browser-supported.
    OpenType,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ExtractedFont {
    /// PostScript name as recorded in the PDF's Font dict (e.g.
    /// `AAABBB+Helvetica-Bold`). The `AAABBB+` prefix indicates
    /// a subset; frontend may want to strip before using.
    pub ps_name: String,
    /// Object number + generation of the FontDescriptor in the PDF.
    /// Useful for disambiguation when multiple fonts share a PS name.
    pub font_descriptor_id: (u32, u16),
    /// Font program format.
    pub format: ExtractedFontFormat,
    /// Raw font-program bytes. Length varies wildly by font family
    /// and subset completeness — a subsetted Helvetica may be <5 KB,
    /// a full-embedded CJK font can be 10+ MB.
    pub bytes: Vec<u8>,
}

/// List every embedded font on the given page, extract the
/// associated font-program bytes, and return them. Empty vec if
/// the page uses only non-embedded fonts (Standard 14, system-
/// substitute names).
pub fn extract_fonts_for_page(pdf_path: &str, page_index: u32) -> Result<Vec<ExtractedFont>> {
    let bytes =
        std::fs::read(pdf_path).map_err(|e| AppError::Pdf(format!("read {pdf_path}: {e}")))?;
    extract_fonts_from_bytes(&bytes, page_index)
}

/// Same as [`extract_fonts_for_page`] but takes the PDF bytes
/// directly. Used by the bytes-based IPC command the frontend uses —
/// the frontend holds in-memory `pdfBytes` (possibly with uncommitted
/// edits merged) and routing through a temp file would both add
/// latency and miss uncommitted state.
pub fn extract_fonts_from_bytes(bytes: &[u8], page_index: u32) -> Result<Vec<ExtractedFont>> {
    let mut cursor = Cursor::new(bytes);
    let doc = Document::load_from(&mut cursor)
        .map_err(|e| AppError::Pdf(format!("parse pdf bytes: {e}")))?;

    let pages = doc.get_pages();
    let (_page_num, page_id) = pages
        .iter()
        .nth(page_index as usize)
        .map(|(n, id)| (*n, *id))
        .ok_or_else(|| {
            AppError::Pdf(format!(
                "page {page_index} out of range (document has {} page(s))",
                pages.len()
            ))
        })?;

    // Collect the Font resources on this page. The Resources dict
    // can be inherited from parent Pages nodes, so we walk up.
    let fonts_dict = get_page_fonts_dict(&doc, page_id)?;

    let mut extracted = Vec::new();
    if let Some(fonts_dict) = fonts_dict {
        for (_font_key, font_ref) in fonts_dict.iter() {
            let Ok(font_obj) = deref(&doc, font_ref) else {
                continue;
            };
            let Object::Dictionary(font_dict) = font_obj else {
                continue;
            };

            // PostScript name — usually present directly as
            // /BaseFont. Fall back to empty if missing.
            let ps_name = font_dict
                .get(b"BaseFont")
                .ok()
                .and_then(|o| o.as_name().ok())
                .map(|n| String::from_utf8_lossy(n).into_owned())
                .unwrap_or_default();

            // FontDescriptor: either on the main Font dict, or on
            // the DescendantFonts[0] for Type0 (CID-keyed).
            let desc_ref = font_dict.get(b"FontDescriptor").ok().cloned().or_else(|| {
                font_dict.get(b"DescendantFonts").ok().and_then(|df| {
                    if let Ok(arr) = df.as_array() {
                        arr.first().cloned().and_then(|o| {
                            // Deref to get the CID font dict,
                            // then pull its FontDescriptor.
                            if let Ok(cid_font) = deref(&doc, &o) {
                                if let Object::Dictionary(d) = cid_font {
                                    return d.get(b"FontDescriptor").ok().cloned();
                                }
                            }
                            None
                        })
                    } else {
                        None
                    }
                })
            });
            let Some(desc_ref) = desc_ref else { continue };
            let desc_id = match &desc_ref {
                Object::Reference(id) => *id,
                _ => (0, 0),
            };
            let Ok(desc_obj) = deref(&doc, &desc_ref) else {
                continue;
            };
            let Object::Dictionary(desc_dict) = desc_obj else {
                continue;
            };

            // Try FontFile, FontFile2, FontFile3 in order.
            for (key, format) in [
                (b"FontFile" as &[u8], ExtractedFontFormat::Type1),
                (b"FontFile2" as &[u8], ExtractedFontFormat::TrueType),
                (b"FontFile3" as &[u8], ExtractedFontFormat::OpenType),
            ] {
                if let Ok(stream_ref) = desc_dict.get(key) {
                    if let Ok(Object::Stream(stream)) = deref(&doc, stream_ref) {
                        // lopdf's get_stream / decompressed_content
                        // handles Filter chains (usually just /FlateDecode
                        // for font programs).
                        let Ok(font_bytes) = stream.decompressed_content() else {
                            continue;
                        };
                        extracted.push(ExtractedFont {
                            ps_name: ps_name.clone(),
                            font_descriptor_id: desc_id,
                            format,
                            bytes: font_bytes,
                        });
                        break;
                    }
                }
            }
        }
    }
    Ok(extracted)
}

/// Resolve a reference (or return the object directly if it's
/// already resolved). Returns an owned Object.
fn deref(doc: &Document, obj: &Object) -> Result<Object> {
    match obj {
        Object::Reference(id) => doc
            .get_object(*id)
            .cloned()
            .map_err(|e| AppError::Pdf(format!("deref {id:?}: {e}"))),
        other => Ok(other.clone()),
    }
}

/// Traverse up the Pages tree from `page_id` to find the nearest
/// /Resources/Font dict. PDF allows resources to be inherited from
/// parent Pages nodes.
fn get_page_fonts_dict(doc: &Document, page_id: (u32, u16)) -> Result<Option<lopdf::Dictionary>> {
    let mut cur = page_id;
    let mut hops = 0;
    loop {
        if hops > 8 {
            return Err(AppError::Pdf("page tree too deep".into()));
        }
        let Ok(obj) = doc.get_object(cur) else {
            return Ok(None);
        };
        let Object::Dictionary(d) = obj else {
            return Ok(None);
        };

        if let Ok(res) = d.get(b"Resources") {
            let res_obj = deref(doc, res)?;
            if let Object::Dictionary(res_dict) = res_obj {
                if let Ok(fonts) = res_dict.get(b"Font") {
                    let fonts_obj = deref(doc, fonts)?;
                    if let Object::Dictionary(fd) = fonts_obj {
                        return Ok(Some(fd));
                    }
                }
            }
        }

        // No Resources here — walk up via /Parent.
        if let Ok(parent) = d.get(b"Parent") {
            if let Object::Reference(id) = parent {
                cur = *id;
                hops += 1;
                continue;
            }
        }
        return Ok(None);
    }
}
