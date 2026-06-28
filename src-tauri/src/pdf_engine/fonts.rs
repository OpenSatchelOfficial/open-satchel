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

// ── Session 4: targeted extraction for save-time re-embedding ─────
//
// The overlay bake substitutes Standard-14 for any custom family it
// cannot resolve from SYSTEM fonts — but the document usually carries
// the real font right there in its own Font dicts. This walks every
// font object in the document (not per-page resources: the family may
// be used on any page) looking for a BaseFont whose subset-stripped
// name matches the requested family, and judges whether the embedded
// program is REUSABLE for new text: TrueType only (the engine's
// embedded path is FontFile2 + CIDFontType2), and it must carry a
// unicode cmap (encode_cids maps chars→GIDs through it; fontkit-style
// subsets strip cmap and are NOT reusable — that exact case is the
// committed custom-fonts.pdf adversarial fixture).

/// Outcome of a targeted font-payload extraction. `Unusable` means
/// the family IS embedded but cannot be re-encoded for new text —
/// the caller records `font.doc_embed_unusable` with the reason.
/// `NotFound` means the document simply doesn't embed the family —
/// silent, the caller proceeds to system-font resolution.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum DocFontExtraction {
    Usable {
        bytes: Vec<u8>,
        ps_name: String,
        /// Requested codepoints the font has NO glyph for. Non-empty
        /// means re-embedding would drop characters — the caller must
        /// treat it as unusable for THIS text and fall through.
        missing_codepoints: Vec<u32>,
    },
    Unusable {
        ps_name: String,
        reason: String,
    },
    NotFound,
}

/// Strip the `ABCDEF+` subset tag from a BaseFont name.
fn strip_subset_tag(name: &str) -> &str {
    let b = name.as_bytes();
    if b.len() > 7 && b[6] == b'+' && b[..6].iter().all(|c| c.is_ascii_uppercase()) {
        &name[7..]
    } else {
        name
    }
}

/// Normalized family equality: lowercase, whitespace/hyphen/underscore
/// stripped. Deliberately EXACT (no substring fuzz) — extraction
/// reuses the document's own font, so a near-miss family must not
/// silently borrow a different embedded face.
fn family_eq(a: &str, b: &str) -> bool {
    let norm = |s: &str| {
        s.chars()
            .filter(|c| !c.is_whitespace() && *c != '-' && *c != '_')
            .flat_map(|c| c.to_lowercase())
            .collect::<String>()
    };
    !a.trim().is_empty() && norm(a) == norm(b)
}

/// Find the embedded font program for `family` anywhere in the
/// document and judge its reusability for `codepoints`.
pub fn extract_font_payload_from_bytes(
    bytes: &[u8],
    family: &str,
    codepoints: &[u32],
) -> Result<DocFontExtraction> {
    let mut cursor = Cursor::new(bytes);
    let doc = Document::load_from(&mut cursor)
        .map_err(|e| AppError::Pdf(format!("extract-font-payload: parse pdf: {e}")))?;

    // Best result wins: Usable > Unusable > NotFound. A Type0 font
    // and its CIDFontType2 descendant both match the family and share
    // the descriptor — dedupe by descriptor id so we judge each
    // program once.
    let mut best: DocFontExtraction = DocFontExtraction::NotFound;
    let mut seen_descriptors: std::collections::HashSet<(u32, u16)> = Default::default();

    for (_, obj) in doc.objects.iter() {
        let Object::Dictionary(font_dict) = obj else {
            continue;
        };
        let is_font = font_dict
            .get(b"Type")
            .ok()
            .and_then(|t| t.as_name().ok())
            .map(|n| n == b"Font")
            .unwrap_or(false);
        if !is_font {
            continue;
        }
        let Some(ps_name) = font_dict
            .get(b"BaseFont")
            .ok()
            .and_then(|o| o.as_name().ok())
            .map(|n| String::from_utf8_lossy(n).into_owned())
        else {
            continue;
        };
        if !family_eq(strip_subset_tag(&ps_name), family) {
            continue;
        }

        // Descriptor: direct (simple fonts) or via DescendantFonts[0]
        // (Type0). Same walk as extract_fonts_from_bytes above.
        let desc_ref = font_dict.get(b"FontDescriptor").ok().cloned().or_else(|| {
            font_dict.get(b"DescendantFonts").ok().and_then(|df| {
                let arr = match df {
                    Object::Reference(id) => doc
                        .get_object(*id)
                        .ok()
                        .and_then(|o| o.as_array().ok())
                        .cloned(),
                    Object::Array(a) => Some(a.clone()),
                    _ => None,
                }?;
                let first = arr.first()?;
                if let Ok(Object::Dictionary(d)) = deref(&doc, first) {
                    d.get(b"FontDescriptor").ok().cloned()
                } else {
                    None
                }
            })
        });
        let Some(desc_ref) = desc_ref else {
            // Embedded family match with no descriptor = a
            // non-embedded (e.g. Standard-14-style) reference.
            continue;
        };
        if let Object::Reference(id) = &desc_ref {
            if !seen_descriptors.insert(*id) {
                continue;
            }
        }
        let Ok(Object::Dictionary(desc_dict)) = deref(&doc, &desc_ref) else {
            continue;
        };

        let unusable = |reason: &str| DocFontExtraction::Unusable {
            ps_name: ps_name.clone(),
            reason: reason.to_string(),
        };

        // Reusability requires TrueType (FontFile2): the engine's
        // embedded chain emits CIDFontType2, whose glyph source must
        // be a TrueType program.
        if desc_dict.get(b"FontFile").is_ok() && desc_dict.get(b"FontFile2").is_err() {
            best = unusable("embedded program is Type1 (FontFile); engine re-embed needs TrueType");
            continue;
        }
        if desc_dict.get(b"FontFile3").is_ok() && desc_dict.get(b"FontFile2").is_err() {
            best = unusable("embedded program is CFF (FontFile3); engine re-embed needs TrueType");
            continue;
        }
        let Ok(ff_ref) = desc_dict.get(b"FontFile2") else {
            continue;
        };
        let Ok(Object::Stream(stream)) = deref(&doc, ff_ref) else {
            best = unusable("FontFile2 reference does not resolve to a stream");
            continue;
        };
        let Ok(font_bytes) = stream.decompressed_content() else {
            best = unusable("FontFile2 stream failed to decompress");
            continue;
        };
        let Ok(face) = ttf_parser::Face::parse(&font_bytes, 0) else {
            best = unusable("FontFile2 bytes do not parse as TrueType");
            continue;
        };
        let has_unicode_cmap = face
            .tables()
            .cmap
            .map(|c| c.subtables.into_iter().any(|s| s.is_unicode()))
            .unwrap_or(false);
        if !has_unicode_cmap {
            // The fontkit-subset case: glyphs only, no unicode cmap —
            // encode_cids cannot map new text through it.
            best = unusable(
                "font program has no unicode cmap (typical of subset embeds); new text cannot be re-encoded through it",
            );
            continue;
        }
        let missing: Vec<u32> = codepoints
            .iter()
            .copied()
            .filter(|cp| {
                char::from_u32(*cp)
                    .and_then(|c| face.glyph_index(c))
                    .is_none()
            })
            .collect();
        return Ok(DocFontExtraction::Usable {
            bytes: font_bytes,
            ps_name,
            missing_codepoints: missing,
        });
    }
    Ok(best)
}

/// Path variant — heavy documents must not marshal their whole byte
/// buffer through the JSON IPC just to look up one font program.
pub fn extract_font_payload_from_path(
    pdf_path: &str,
    family: &str,
    codepoints: &[u32],
) -> Result<DocFontExtraction> {
    let bytes =
        std::fs::read(pdf_path).map_err(|e| AppError::Pdf(format!("read {pdf_path}: {e}")))?;
    extract_font_payload_from_bytes(&bytes, family, codepoints)
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

#[cfg(test)]
mod session4_extraction_tests {
    use super::*;

    fn fixture(rel: &str) -> Vec<u8> {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(rel);
        std::fs::read(&path).unwrap_or_else(|e| panic!("fixture missing: {path:?}: {e}"))
    }

    #[test]
    fn strip_subset_tag_variants() {
        assert_eq!(strip_subset_tag("ABCDEF+Verdanq"), "Verdanq");
        assert_eq!(strip_subset_tag("Verdanq"), "Verdanq");
        assert_eq!(strip_subset_tag("abcdef+x"), "abcdef+x");
        assert_eq!(strip_subset_tag("ABC+Font"), "ABC+Font");
    }

    #[test]
    fn family_eq_normalized_exact_no_fuzz() {
        assert!(family_eq("Verdanq", "verdanq"));
        assert!(family_eq("Open Sans", "open-sans"));
        // No substring fuzz: extraction must not borrow a different face.
        assert!(!family_eq("Verdan", "Verdanq"));
        assert!(!family_eq("", ""));
    }

    #[test]
    fn full_embed_fixture_is_usable_with_coverage() {
        // custom-fonts-full.pdf embeds the donor with subset:false —
        // cmap intact, so the document's own Verdanq is reusable.
        let bytes = fixture("test-files/hardening/custom-fonts-full.pdf");
        let cps: Vec<u32> = "FULLFONT FOLLOWER hotel".chars().map(|c| c as u32).collect();
        match extract_font_payload_from_bytes(&bytes, "Verdanq", &cps).expect("extraction runs") {
            DocFontExtraction::Usable {
                bytes,
                ps_name,
                missing_codepoints,
            } => {
                assert!(ps_name.contains("Verdanq"), "ps_name: {ps_name}");
                assert!(missing_codepoints.is_empty(), "missing: {missing_codepoints:?}");
                let face = ttf_parser::Face::parse(&bytes, 0).expect("usable bytes parse");
                assert!(face.glyph_index('F').is_some());
            }
            other => panic!("expected Usable, got {other:?}"),
        }
    }

    #[test]
    fn full_embed_fixture_reports_uncovered_codepoints() {
        let bytes = fixture("test-files/hardening/custom-fonts-full.pdf");
        // U+1F600 (emoji) is not in Verdana.
        let cps: Vec<u32> = vec!['F' as u32, 0x1F600];
        match extract_font_payload_from_bytes(&bytes, "Verdanq", &cps).expect("extraction runs") {
            DocFontExtraction::Usable {
                missing_codepoints, ..
            } => assert_eq!(missing_codepoints, vec![0x1F600]),
            other => panic!("expected Usable with missing list, got {other:?}"),
        }
    }

    #[test]
    fn subset_fixture_is_unusable_no_cmap() {
        // custom-fonts.pdf is the adversarial twin: fontkit subset,
        // sfnt has NO cmap → extraction must fail LOUDLY (Unusable),
        // never silently return glyph-blind bytes.
        let bytes = fixture("test-files/hardening/custom-fonts.pdf");
        let cps: Vec<u32> = "CUSTOM".chars().map(|c| c as u32).collect();
        match extract_font_payload_from_bytes(&bytes, "Verdanq", &cps).expect("extraction runs") {
            DocFontExtraction::Unusable { ps_name, reason } => {
                assert!(ps_name.contains("Verdanq"));
                assert!(reason.contains("cmap"), "reason: {reason}");
            }
            other => panic!("expected Unusable(no cmap), got {other:?}"),
        }
    }

    #[test]
    fn unembedded_family_is_not_found() {
        let bytes = fixture("test-files/hardening/custom-fonts.pdf");
        match extract_font_payload_from_bytes(&bytes, "Comic Sans MS", &[]).expect("runs") {
            DocFontExtraction::NotFound => {}
            other => panic!("expected NotFound, got {other:?}"),
        }
        // Standard-14 reference without an embedded program is also
        // NotFound (the Helvetica footer font has no FontDescriptor).
        match extract_font_payload_from_bytes(&bytes, "Helvetica", &[]).expect("runs") {
            DocFontExtraction::NotFound => {}
            other => panic!("expected NotFound for unembedded Helvetica, got {other:?}"),
        }
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
