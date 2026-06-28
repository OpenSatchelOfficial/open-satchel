// PDF commands.
//
// M1 status: stubs that return errors, signalling the frontend to fall back
// to its pdfjs-based rendering. This establishes the contract that M2+ fills
// in with real implementations (likely backed by pdfium-render for rendering
// and lopdf for structural edits, with MuPDF added in M4 for exotic cases).
//
// The frontend checks for AppError::Pdf variants and degrades gracefully.

use crate::error::AppError;
use crate::Result;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct RenderedPage {
    pub width: u32,
    pub height: u32,
    pub png_bytes: Vec<u8>,
}

/// Count pages in a PDF.
///
/// M1 stub. Real impl in M2 via pdfium-render or lopdf's trailer traversal.
#[tauri::command]
pub fn pdf_page_count(_bytes: Vec<u8>) -> Result<u32> {
    Err(AppError::Pdf(
        "native pdf engine not yet wired (M2); using frontend fallback".into(),
    ))
}

/// Render one page to PNG at the given scale.
///
/// M1 stub. Real impl in M2 via pdfium-render::pdf_to_image.
#[tauri::command]
pub fn pdf_render_page(_bytes: Vec<u8>, _page_index: u32, _scale: f32) -> Result<RenderedPage> {
    Err(AppError::Pdf(
        "native pdf engine not yet wired (M2); using frontend fallback".into(),
    ))
}

/// Extract text from a page, preserving approximate word boxes.
///
/// M1 stub. Real impl in M3 (it's a prerequisite for content-stream editing).
#[tauri::command]
pub fn pdf_extract_text(_bytes: Vec<u8>, _page_index: u32) -> Result<String> {
    Err(AppError::Pdf(
        "native pdf engine not yet wired (M3); using frontend fallback".into(),
    ))
}

/// Look up a system font that can substitute for one of the PDF
/// Standard-14 PostScript names. Used by the PDF/A converter, which
/// must embed every font (Standard-14 is forbidden in PDF/A).
///
/// Returns the substitute font's bytes + the matched display family.
/// Empty Vec means no substitute found (caller surfaces a warning).
///
/// Substitution map:
///   Helvetica family   → Arial / Liberation Sans / DejaVu Sans
///   Times family       → Times New Roman / Liberation Serif
///   Courier family     → Courier New / Liberation Mono
///   Symbol             → Symbol
///   ZapfDingbats       → no good FOSS substitute; returns empty
///
/// We don't bundle Liberation/DejaVu fonts in v1 — every desktop
/// OS ships SOMETHING usable (Arial on Windows, Helvetica on macOS,
/// DejaVu/Liberation on most Linux distros). Bundling is a future
/// licensing-clean step (Liberation Apache-2.0, DejaVu permissive).
#[tauri::command]
pub fn pdfa_get_standard14_substitute(name: String) -> Result<Vec<u8>> {
    use std::fs;

    // Map PostScript name → ordered list of (family-substring, style-substring)
    // candidates. We match case-insensitively against TTF name table records.
    let candidates: Vec<(&str, &str)> = match name.as_str() {
        "Helvetica" | "Arial" => vec![
            ("arial", "regular"),
            ("liberation sans", "regular"),
            ("dejavu sans", "book"),
            ("dejavu sans", "regular"),
            ("helvetica", "regular"),
        ],
        "Helvetica-Bold" | "Arial-Bold" => vec![
            ("arial", "bold"),
            ("liberation sans", "bold"),
            ("dejavu sans", "bold"),
        ],
        "Helvetica-Oblique" | "Arial-Italic" => vec![
            ("arial", "italic"),
            ("liberation sans", "italic"),
            ("dejavu sans", "oblique"),
        ],
        "Helvetica-BoldOblique" | "Arial-BoldItalic" => vec![
            ("arial", "bold italic"),
            ("liberation sans", "bold italic"),
            ("dejavu sans", "bold oblique"),
        ],
        "Times-Roman" | "Times" => vec![
            ("times new roman", "regular"),
            ("liberation serif", "regular"),
            ("dejavu serif", "book"),
            ("dejavu serif", "regular"),
        ],
        "Times-Bold" => vec![
            ("times new roman", "bold"),
            ("liberation serif", "bold"),
            ("dejavu serif", "bold"),
        ],
        "Times-Italic" => vec![
            ("times new roman", "italic"),
            ("liberation serif", "italic"),
            ("dejavu serif", "italic"),
        ],
        "Times-BoldItalic" => vec![
            ("times new roman", "bold italic"),
            ("liberation serif", "bold italic"),
            ("dejavu serif", "bold italic"),
        ],
        "Courier" | "Courier-Roman" => vec![
            ("courier new", "regular"),
            ("liberation mono", "regular"),
            ("dejavu sans mono", "book"),
            ("dejavu sans mono", "regular"),
        ],
        "Courier-Bold" => vec![
            ("courier new", "bold"),
            ("liberation mono", "bold"),
            ("dejavu sans mono", "bold"),
        ],
        "Courier-Oblique" => vec![
            ("courier new", "italic"),
            ("liberation mono", "italic"),
            ("dejavu sans mono", "oblique"),
        ],
        "Courier-BoldOblique" => vec![
            ("courier new", "bold italic"),
            ("liberation mono", "bold italic"),
            ("dejavu sans mono", "bold oblique"),
        ],
        "Symbol" => vec![("symbol", "")],
        // ZapfDingbats has no good FOSS substitute. Acrobat ships it; we
        // can't redistribute Adobe's. Return empty; caller flags as warning.
        "ZapfDingbats" => return Ok(Vec::new()),
        _ => return Ok(Vec::new()),
    };

    // Walk system font dirs looking for a name-table match.
    for dir in font_dirs_for_substitution() {
        if !dir.exists() {
            continue;
        }
        for entry in walkdir::WalkDir::new(&dir)
            .max_depth(3)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            let p = entry.path();
            if !p.is_file() {
                continue;
            }
            let ext = p
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| s.to_ascii_lowercase());
            if !matches!(ext.as_deref(), Some("ttf") | Some("otf")) {
                continue;
            }
            let Ok(bytes) = fs::read(p) else { continue };
            let Ok(face) = ttf_parser::Face::parse(&bytes, 0) else {
                continue;
            };
            let mut family = String::new();
            let mut style = String::new();
            let names = face.names();
            for i in 0..names.len() {
                let Some(n) = names.get(i) else { continue };
                let Some(s) = n.to_string() else { continue };
                match n.name_id {
                    1 if family.is_empty() => family = s.to_lowercase(),
                    2 if style.is_empty() => style = s.to_lowercase(),
                    _ => {}
                }
            }
            if style.is_empty() {
                style = "regular".to_string();
            }

            for (fam_match, style_match) in &candidates {
                // Family: substring match (Liberation/DejaVu have multi-word
                // family names, exact match is too strict).
                // Style: EXACT match. "italic" and "bold italic" both contain
                // "italic", so substring match would mis-pair Helvetica-Oblique
                // → Arial-BoldItalicMT. Style strings are short + standardized
                // ("Regular"/"Bold"/"Italic"/"Bold Italic") so exact equality
                // is reliable.
                if family.contains(fam_match) && style.trim() == style_match.trim() {
                    return Ok(bytes);
                }
            }
        }
    }

    // Nothing matched — return empty so caller surfaces a warning rather
    // than crashing. The user can install Liberation / DejaVu fonts and
    // try again.
    Ok(Vec::new())
}

/// Font dirs we scan when looking for Standard-14 substitutes. Same
/// platform paths as font_list_system but lifted out so the substitution
/// path stays self-contained.
fn font_dirs_for_substitution() -> Vec<std::path::PathBuf> {
    let mut out: Vec<std::path::PathBuf> = Vec::new();
    if cfg!(target_os = "windows") {
        if let Some(windir) = std::env::var_os("WINDIR") {
            out.push(std::path::PathBuf::from(windir).join("Fonts"));
        } else {
            out.push(std::path::PathBuf::from(r"C:\Windows\Fonts"));
        }
    } else if cfg!(target_os = "macos") {
        out.push(std::path::PathBuf::from("/System/Library/Fonts"));
        out.push(std::path::PathBuf::from("/Library/Fonts"));
    } else {
        out.push(std::path::PathBuf::from("/usr/share/fonts"));
        out.push(std::path::PathBuf::from("/usr/local/share/fonts"));
    }
    out
}

/// Bundled, OFL-licensed Noto Sans SC subset (Simplified Chinese).
/// TrueType/glyf outlines with the cmap table preserved — fontkit on
/// the frontend uses that cmap to (a) map source codepoints → Noto GIDs
/// when re-encoding content streams to Identity-H and (b) generate the
/// /ToUnicode CMap that makes the output text-selectable. Covers ASCII +
/// the full CJK Unified Ideographs block (U+4E00–9FFF) + CJK punctuation
/// + fullwidth forms.
///
/// Embedded into the binary via include_bytes! rather than shipped as a
/// Tauri resource so a packaged build binds it with zero resource-path
/// plumbing (the same reliability lesson the exe-dir pdfium discovery
/// taught us — KNOWN-LIMITATIONS / Session 10).
const NOTO_SANS_SC_SUBSET: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/vendor/fonts/NotoSansSC-Subset.ttf"
));

/// Return a bundled CJK substitute font for PDF/A conversion.
///
/// Real-world CJK PDFs routinely reference a Chinese/Japanese/Korean
/// font by name (STSong-Light, SimSun, …) or as a bare CIDFontType2 with
/// no embedded FontFile2 — Acrobat renders them with a system CJK font,
/// but PDF/A §6.3.4 forbids relying on a non-embedded font, so such files
/// fail conversion today. The PDF/A converter routes any bare CID font it
/// can recover text from (it carries a /ToUnicode CMap) to this provider,
/// embeds the returned bytes as an Identity-H CIDFontType2, re-encodes the
/// content stream to the new GIDs, and generates a /ToUnicode CMap — so
/// the output is both PDF/A-conformant and text-selectable.
///
/// `base_font` is accepted for future per-family routing (Simplified vs
/// Traditional vs Japanese) but currently always returns the Simplified-
/// Chinese face — the only CJK font bundled this session. Traditional /
/// Japanese / Korean and CFF-keyed (FontFile3) sources stay recorded
/// residuals (KNOWN-LIMITATIONS §4).
#[tauri::command]
pub fn pdfa_get_cjk_substitute(base_font: String) -> Result<Vec<u8>> {
    let _ = base_font; // reserved for SC/TC/JP/KR routing
    Ok(NOTO_SANS_SC_SUBSET.to_vec())
}

/// Load the system sRGB ICC profile bytes for embedding in PDF/A
/// /OutputIntents. Tries platform-typical paths first; falls back
/// to the bundled resources/ profile if shipped.
///
/// Why load from system instead of bundling: the well-known
/// distributable ICC profiles (color.org's sRGB v4) are behind
/// Cloudflare and the curl-bundled-then-redistribute path needs
/// a license review (ICC profiles have their own license terms,
/// most permissive but worth reading). System profile is always
/// present on Windows + most Linux distros.
///
/// Returns ICC bytes (typically 60–70KB on Windows, 3–6KB for the
/// minimal Microsoft profile). Validates via "acsp" magic at
/// offset 36 before returning so callers can trust the bytes.
#[tauri::command]
pub fn pdfa_get_srgb_icc() -> Result<Vec<u8>> {
    use std::fs;

    // Platform-typical paths in priority order. The bundled
    // resource path is a future addition (resources/ dir).
    let candidates: Vec<std::path::PathBuf> = {
        #[cfg(target_os = "windows")]
        {
            vec![std::path::PathBuf::from(
                r"C:\Windows\System32\spool\drivers\color\sRGB Color Space Profile.icm",
            )]
        }
        #[cfg(target_os = "macos")]
        {
            vec![
                std::path::PathBuf::from("/System/Library/ColorSync/Profiles/sRGB Profile.icc"),
                std::path::PathBuf::from("/Library/ColorSync/Profiles/sRGB Profile.icc"),
            ]
        }
        #[cfg(target_os = "linux")]
        {
            vec![
                std::path::PathBuf::from("/usr/share/color/icc/sRGB.icc"),
                std::path::PathBuf::from("/usr/share/color/icc/colord/sRGB.icc"),
                std::path::PathBuf::from("/usr/share/icc/sRGB.icc"),
            ]
        }
    };

    for path in &candidates {
        if let Ok(bytes) = fs::read(path) {
            // Validate ICC magic ("acsp" at offset 36).
            if bytes.len() >= 40 && &bytes[36..40] == b"acsp" {
                return Ok(bytes);
            }
        }
    }

    Err(AppError::Pdf(format!(
        "No sRGB ICC profile found on system. Tried: {}",
        candidates
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The bundled CJK substitute must be a real, parseable TrueType font
    /// with cmap coverage for common Chinese characters. This is the
    /// supply-chain gate: if the vendored font is corrupt, missing, or the
    /// wrong flavour (CFF instead of glyf), CJK PDF/A conversion silently
    /// regresses. ttf-parser is already a dependency.
    #[test]
    fn cjk_substitute_is_a_valid_cjk_truetype_font() {
        let bytes = pdfa_get_cjk_substitute("STSong-Light".to_string()).expect("provider");
        assert!(
            bytes.len() > 100_000,
            "CJK substitute suspiciously small ({} bytes) — bundled font missing?",
            bytes.len()
        );
        let face = ttf_parser::Face::parse(&bytes, 0).expect("vendored font must parse");
        // glyf-based (FontFile2), not CFF — PDF/A CIDFontType2 needs TrueType outlines.
        assert!(
            face.tables().glyf.is_some(),
            "bundled CJK font must have glyf outlines (FontFile2-eligible)"
        );
        // cmap coverage for representative Hanzi (中文档案机密) + ASCII.
        for c in ['中', '文', '档', '案', '机', '密', 'A', '0'] {
            assert!(
                face.glyph_index(c).is_some(),
                "bundled CJK font lacks a glyph for U+{:04X} ({})",
                c as u32,
                c
            );
        }
    }
}
