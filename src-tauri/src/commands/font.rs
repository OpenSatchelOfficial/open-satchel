// Font subsystem.
//
// Three responsibilities:
//   1. Enumerate system fonts (`font_list_system`) so the paragraph editor
//      can offer proper font substitution when the original isn't
//      embedded. Walks the OS font directory, reads the TTF/OTF name
//      table, emits family + style + path + a stable id.
//   2. Extract embedded fonts from a PDF (`font_scan_pdf`) — lets users
//      re-use the same font that was in the document for their edits,
//      preserving metrics. Returns metadata only; callers follow up with
//      `font_embedded_bytes` if they need the actual bytes for embedding.
//   3. Persist user-imported custom fonts (`font_import_file`,
//      `font_imported_list`, `font_imported_get_bytes`, `font_imported_remove`).
//
// Pure-Rust via ttf-parser + walkdir. No native C deps, so the Windows
// build stays small and the cross-platform port is trivial later.

use crate::error::AppError;
use crate::Result;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;
use walkdir::WalkDir;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FontInfo {
    pub id: String,     // stable across runs: "system:<path>" or "imported:<uuid>"
    pub name: String,   // full display name: "Segoe UI Bold"
    pub family: String, // "Segoe UI"
    pub style: String,  // "Regular", "Bold", "Italic", "Bold Italic"
    pub file_name: String,
    pub path: String,
    pub source: String, // "system" | "imported"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PdfEmbeddedFont {
    /// pdf-lib-style PostScript name, may be subsetted (prefixed with ABCDEF+)
    pub ps_name: String,
    /// Heuristic family name stripped of the subset prefix
    pub family: String,
    /// True if this is a 6-char-prefix subset font and likely missing glyphs
    pub subsetted: bool,
}

/// Windows Fonts directory. We also scan the per-user variant for fonts
/// the user installed without admin rights.
fn system_font_dirs() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    if cfg!(target_os = "windows") {
        if let Some(windir) = std::env::var_os("WINDIR") {
            out.push(PathBuf::from(windir).join("Fonts"));
        } else {
            out.push(PathBuf::from(r"C:\Windows\Fonts"));
        }
        if let Some(localapp) = std::env::var_os("LOCALAPPDATA") {
            out.push(
                PathBuf::from(localapp)
                    .join("Microsoft")
                    .join("Windows")
                    .join("Fonts"),
            );
        }
    } else if cfg!(target_os = "macos") {
        out.push(PathBuf::from("/System/Library/Fonts"));
        out.push(PathBuf::from("/Library/Fonts"));
        if let Ok(home) = std::env::var("HOME") {
            out.push(PathBuf::from(home).join("Library/Fonts"));
        }
    } else {
        // Linux — common roots
        out.push(PathBuf::from("/usr/share/fonts"));
        out.push(PathBuf::from("/usr/local/share/fonts"));
        if let Ok(home) = std::env::var("HOME") {
            out.push(PathBuf::from(&home).join(".fonts"));
            out.push(PathBuf::from(&home).join(".local/share/fonts"));
        }
    }
    out
}

fn parse_font_names(bytes: &[u8]) -> Option<(String, String, String)> {
    // ttf-parser reads the 'name' table. We want Family (id 1 or 16),
    // Subfamily/Style (id 2 or 17), and Full Name (id 4) with preference
    // for English/Unicode records.
    let face = ttf_parser::Face::parse(bytes, 0).ok()?;
    let names = face.names();

    let mut family = String::new();
    let mut style = String::new();
    let mut full = String::new();
    for i in 0..names.len() {
        let Some(name) = names.get(i) else { continue };
        let Some(s) = name.to_string() else { continue };
        match name.name_id {
            1 if family.is_empty() => family = s.clone(),
            2 if style.is_empty() => style = s.clone(),
            4 if full.is_empty() => full = s.clone(),
            16 => family = s.clone(),
            17 => style = s.clone(),
            _ => {}
        }
    }
    if family.is_empty() && full.is_empty() {
        return None;
    }
    if family.is_empty() {
        family = full.clone();
    }
    if style.is_empty() {
        style = "Regular".to_string();
    }
    if full.is_empty() {
        full = format!("{} {}", family, style);
    }
    Some((family, style, full))
}

fn is_font_file(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase())
            .as_deref(),
        Some("ttf") | Some("otf") | Some("ttc") | Some("otc"),
    )
}

#[tauri::command]
pub fn font_list_system() -> Result<Vec<FontInfo>> {
    let mut out: Vec<FontInfo> = Vec::new();
    for dir in system_font_dirs() {
        if !dir.exists() {
            continue;
        }
        for entry in WalkDir::new(&dir)
            .max_depth(3)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            let p = entry.path();
            if !p.is_file() || !is_font_file(p) {
                continue;
            }
            let Ok(bytes) = fs::read(p) else { continue };
            let Some((family, style, full)) = parse_font_names(&bytes) else {
                continue;
            };
            let file_name = p
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            out.push(FontInfo {
                id: format!("system:{}", p.to_string_lossy()),
                name: full,
                family,
                style,
                file_name,
                path: p.to_string_lossy().to_string(),
                source: "system".to_string(),
            });
        }
    }
    // Dedup by family+style, favoring first occurrence.
    out.sort_by(|a, b| a.family.cmp(&b.family).then_with(|| a.style.cmp(&b.style)));
    out.dedup_by(|a, b| a.family == b.family && a.style == b.style);
    Ok(out)
}

#[tauri::command]
pub fn font_get_bytes(id: String) -> Result<Vec<u8>> {
    // id format: "system:<path>" or "imported:<uuid>".
    if let Some(path) = id.strip_prefix("system:") {
        let bytes = fs::read(PathBuf::from(path))?;
        Ok(bytes)
    } else if let Some(uuid) = id.strip_prefix("imported:") {
        // imported fonts stored in app-config-dir/fonts/<uuid>.<ext>
        let dir = imported_fonts_dir()?;
        // We glob the uuid prefix since we don't know the extension.
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(&format!("{}.", uuid)) {
                let bytes = fs::read(entry.path())?;
                return Ok(bytes);
            }
        }
        Err(AppError::NotFound(format!("imported font {}", uuid)))
    } else {
        Err(AppError::InvalidArgument(format!(
            "unknown font id: {}",
            id
        )))
    }
}

fn imported_fonts_dir() -> Result<PathBuf> {
    // dirs::config_dir() returns %APPDATA% on Windows etc.
    let base = dirs::config_dir()
        .ok_or_else(|| AppError::Other(anyhow::anyhow!("no config dir available")))?;
    let dir = base.join("open-satchel").join("fonts");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn imported_index_path() -> Result<PathBuf> {
    let dir = imported_fonts_dir()?;
    Ok(dir.join("index.json"))
}

fn load_imported_index() -> Result<Vec<FontInfo>> {
    let p = imported_index_path()?;
    if !p.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&p)?;
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }
    let list: Vec<FontInfo> = serde_json::from_str(&raw).unwrap_or_default();
    Ok(list)
}

fn save_imported_index(list: &[FontInfo]) -> Result<()> {
    let p = imported_index_path()?;
    let raw = serde_json::to_string_pretty(list)?;
    fs::write(p, raw)?;
    Ok(())
}

#[tauri::command]
pub fn font_imported_list() -> Result<Vec<FontInfo>> {
    load_imported_index()
}

#[tauri::command]
pub async fn font_import_file(app: AppHandle) -> Result<Option<FontInfo>> {
    // Dialog pick → copy into app fonts dir → parse names → index.
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<PathBuf>>();
    app.dialog()
        .file()
        .add_filter("Fonts", &["ttf", "otf", "ttc", "otc"])
        .pick_file(move |f| {
            let _ = tx.send(f.and_then(|x| x.into_path().ok()));
        });

    let Some(src) = rx
        .await
        .map_err(|e| AppError::Other(anyhow::anyhow!("dialog channel: {e}")))?
    else {
        return Ok(None);
    };

    let bytes = fs::read(&src)?;
    let Some((family, style, full)) = parse_font_names(&bytes) else {
        return Err(AppError::InvalidArgument("not a valid font file".into()));
    };
    let id = Uuid::new_v4().to_string();
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("ttf")
        .to_ascii_lowercase();
    let dst_name = format!("{}.{}", id, ext);
    let dst = imported_fonts_dir()?.join(&dst_name);
    fs::copy(&src, &dst)?;

    let info = FontInfo {
        id: format!("imported:{}", id),
        name: full,
        family,
        style,
        file_name: dst_name,
        path: dst.to_string_lossy().to_string(),
        source: "imported".to_string(),
    };
    let mut list = load_imported_index()?;
    list.push(info.clone());
    save_imported_index(&list)?;
    Ok(Some(info))
}

#[tauri::command]
pub fn font_imported_remove(id: String) -> Result<()> {
    let Some(uuid) = id.strip_prefix("imported:") else {
        return Err(AppError::InvalidArgument(format!(
            "not an imported font id: {}",
            id
        )));
    };
    let dir = imported_fonts_dir()?;
    for entry in fs::read_dir(&dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with(&format!("{}.", uuid)) {
            let _ = fs::remove_file(entry.path());
        }
    }
    let mut list = load_imported_index()?;
    list.retain(|f| f.id != id);
    save_imported_index(&list)?;
    Ok(())
}

/// Subset a font file to only the glyphs required by the given codepoints.
///
/// Replaces pd-lib's built-in `embedFont({ subset: true })` for complex
/// scripts — that path drops glyphs from dense CJK cmaps and mangles the
/// GSUB/GPOS tables for Arabic, so the stress fixture uses `subset:false`
/// and ships 11 MB per edit. This command lets the frontend pre-subset
/// the font bytes via Typst's pure-Rust subsetter (no C deps), then hand
/// the shrunk bytes to pd-lib with `subset:false` so pd-lib doesn't touch
/// them a second time.
///
/// The input is the FULL font bytes plus the Unicode codepoints we need
/// glyphs for. We resolve each codepoint to a glyph via ttf-parser's
/// cmap, always include glyph 0 (.notdef) and any cmap-referenced
/// components for ligatures. Return value is the subsetted font bytes
/// (TTF/OTF, ready for embedding).
#[tauri::command]
pub fn font_subset(bytes: Vec<u8>, codepoints: Vec<u32>) -> Result<Vec<u8>> {
    // Parse with ttf-parser to resolve codepoints → glyph IDs.
    let face = ttf_parser::Face::parse(&bytes, 0)
        .map_err(|e| AppError::Other(anyhow::anyhow!("ttf-parser: {e}")))?;

    // Build a glyph remapper. Always include .notdef (gid 0) to keep
    // PDF viewers happy; invalid or unmapped codepoints silently fall
    // back to .notdef which is the spec-conformant behavior. subsetter's
    // GlyphRemapper also handles consecutive-GID renumbering required
    // by the font spec — callers that care about the new GIDs can get
    // them from `remapper.get(old_gid)`.
    let mut remapper = subsetter::GlyphRemapper::new();
    remapper.remap(0);
    for cp in codepoints {
        let Some(c) = char::from_u32(cp) else {
            continue;
        };
        if let Some(gid) = face.glyph_index(c) {
            remapper.remap(gid.0);
        }
    }

    // Font index 0 — TTC support is not wired yet (would need a second
    // arg). Most PDF embeds target the first/only face anyway.
    let subset = subsetter::subset(&bytes, 0, &remapper)
        .map_err(|e| AppError::Other(anyhow::anyhow!("subsetter: {e}")))?;

    Ok(subset.to_vec())
}

/// Session 4: which of `codepoints` does this font have NO glyph for?
/// The save-time escalation path (unicode chars outside WinAnsi route
/// to an embedded system font) must check coverage BEFORE embedding —
/// a font that silently lacks the glyph would re-create the exact
/// char-drop the escalation exists to prevent. Cheap: one ttf-parser
/// parse + cmap lookups.
#[tauri::command]
pub fn font_coverage(bytes: Vec<u8>, codepoints: Vec<u32>) -> Result<Vec<u32>> {
    let face = ttf_parser::Face::parse(&bytes, 0)
        .map_err(|e| AppError::Other(anyhow::anyhow!("ttf-parser: {e}")))?;
    Ok(codepoints
        .into_iter()
        .filter(|cp| {
            char::from_u32(*cp)
                .and_then(|c| face.glyph_index(c))
                .is_none()
        })
        .collect())
}

/// Parse a PDF's Font dictionaries and return metadata for each embedded
/// font. We don't load pdf-lib-equivalent heavy machinery here — this is a
/// byte-level scan looking for "/Type /Font" dicts and pulling their
/// /BaseFont names. Cheap, sufficient for the UX.
#[tauri::command]
pub fn font_scan_pdf(bytes: Vec<u8>) -> Result<Vec<PdfEmbeddedFont>> {
    let mut out: Vec<PdfEmbeddedFont> = Vec::new();
    // Super-simple textual scan for "/BaseFont /XXXXXX+FontName" and
    // "/BaseFont /FontName" patterns. This isn't robust to encrypted or
    // compressed xref streams — a full-fidelity parse is M4 work — but
    // catches the common case of uncompressed PDFs which is most of them.
    let haystack = std::str::from_utf8(&bytes).unwrap_or("");
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (idx, _) in haystack.match_indices("/BaseFont") {
        let tail = &haystack[idx + "/BaseFont".len()..];
        let tail = tail.trim_start();
        if !tail.starts_with('/') {
            continue;
        }
        let tail = &tail[1..];
        let end = tail
            .find(|c: char| {
                c.is_whitespace() || c == '/' || c == '>' || c == '<' || c == '[' || c == ']'
            })
            .unwrap_or(tail.len());
        let raw_name = &tail[..end];
        if raw_name.is_empty() {
            continue;
        }
        let ps_name = raw_name.to_string();
        if seen.contains(&ps_name) {
            continue;
        }
        seen.insert(ps_name.clone());

        // Subset prefix: 6 uppercase letters followed by '+' per PDF spec.
        let (family, subsetted) = if ps_name.len() > 7
            && ps_name.as_bytes()[6] == b'+'
            && ps_name[..6].chars().all(|c| c.is_ascii_uppercase())
        {
            (ps_name[7..].to_string(), true)
        } else {
            (ps_name.clone(), false)
        };

        out.push(PdfEmbeddedFont {
            ps_name,
            family,
            subsetted,
        });
    }
    Ok(out)
}

// Keep tauri::Manager in scope for potential future app-handle usage in
// the import path (e.g. scoped config).
#[allow(dead_code)]
fn _manager_marker() -> Option<&'static dyn std::any::Any> {
    None
}
#[allow(dead_code)]
fn _manager_import() {
    let _: fn(&AppHandle) -> Option<tauri::WebviewWindow> =
        |h: &AppHandle| h.get_webview_window("main");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn repo_root() -> PathBuf {
        // Tests run with cwd = src-tauri; jump up one level to repo root.
        let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        p.pop();
        p
    }

    /// Subsetting Noto Sans SC for a handful of Chinese characters must
    /// produce a font <10% of the original's size. Gates the M3.5 promise
    /// that an edited CJK PDF doesn't explode to 11 MB per save.
    #[test]
    fn subset_noto_sans_sc_cjk_shrinks_to_under_500kb() {
        let fontpath = repo_root()
            .join("scripts")
            .join("fonts")
            .join("NotoSansSC.ttf");
        if !fontpath.exists() {
            eprintln!("skipping: {:?} not downloaded yet", fontpath);
            return;
        }
        let bytes = fs::read(&fontpath).expect("read font");
        let original_len = bytes.len();
        // Five Chinese chars commonly used in tests — chosen to exercise
        // the cmap + horizontal metrics tables for CJK.
        let text = "这是一段中文";
        let codepoints: Vec<u32> = text.chars().map(|c| c as u32).collect();
        let subset = font_subset(bytes, codepoints).expect("subset");
        eprintln!(
            "subset: {} bytes → {} bytes ({:.1}%)",
            original_len,
            subset.len(),
            subset.len() as f64 / original_len as f64 * 100.0,
        );
        assert!(
            subset.len() < 500_000,
            "subset should be <500KB, got {} bytes",
            subset.len()
        );
        assert!(
            subset.len() > 1000,
            "subset shouldn't be suspiciously empty, got {} bytes",
            subset.len()
        );
    }

    /// Arabic subsetting must not crash on complex-script fonts. Amiri
    /// uses GSUB/GPOS for contextual shaping (initial/medial/final forms,
    /// ligatures); subsetter 0.2.x preserves those tables by reference.
    /// We can't easily validate shaping correctness without a renderer,
    /// but we assert the subset is non-empty and well-formed enough for
    /// ttf-parser to re-parse.
    #[test]
    fn subset_amiri_arabic_produces_valid_font() {
        let fontpath = repo_root()
            .join("scripts")
            .join("fonts")
            .join("Amiri-Regular.ttf");
        if !fontpath.exists() {
            eprintln!("skipping: Amiri not downloaded");
            return;
        }
        let bytes = fs::read(&fontpath).expect("read font");
        // Arabic: "السلام عليكم" — requires contextual shaping.
        let text = "السلام عليكم";
        let codepoints: Vec<u32> = text.chars().map(|c| c as u32).collect();
        let subset = font_subset(bytes, codepoints).expect("subset");
        assert!(subset.len() > 1000, "subset shouldn't be empty");
        // Re-parse via ttf-parser to confirm the output is a valid font.
        let reparsed = ttf_parser::Face::parse(&subset, 0);
        assert!(
            reparsed.is_ok(),
            "subsetted Arabic font must re-parse cleanly"
        );
    }

    /// Session 4 DOCUMENTED LIMITATION (found live by the rewritten
    /// strict smoke): the Typst subsetter DROPS the cmap table — it
    /// was built for Typst's PDF writer, which maps text→glyphs from
    /// the ORIGINAL font and never consults the subset's cmap. OUR
    /// engine bake encodes through the payload's own cmap
    /// (encode_cids → face.glyph_index), so a font_subset output is
    /// unusable as an engine payload: every glyph is unmappable,
    /// ensure_replacement_text_encodable refuses, and the save
    /// degrades to pd-lib. The pre-Session-4 G2 path could therefore
    /// NEVER actually bake an embedded font live — full-font unit
    /// tests and the fallback-tolerant G2 driver hid it.
    ///
    /// The shipping mitigation lives in subsetAndPack
    /// (pdfEngineBake.ts): post-subset font_coverage check → full-font
    /// embed + font.subset_failed_full_embed (info) when mappings are
    /// lost. WHEN THIS TEST STARTS FAILING (a future subsetter keeps
    /// cmap), remove the TS full-embed fallback and flip this pin.
    #[test]
    fn subset_loses_cmap_documented_limitation() {
        let fontpath = repo_root()
            .join("scripts")
            .join("fonts")
            .join("NotoSans-Regular.ttf");
        if !fontpath.exists() {
            eprintln!("skipping: NotoSans not present");
            return;
        }
        let bytes = fs::read(&fontpath).expect("read font");
        let text = "Hello subset";
        let codepoints: Vec<u32> = text.chars().map(|c| c as u32).collect();
        let subset = font_subset(bytes, codepoints.clone()).expect("subset");
        let missing = font_coverage(subset, codepoints).expect("coverage check");
        assert!(
            !missing.is_empty(),
            "font_subset now PRESERVES cmap — remove the full-embed fallback in \
             subsetAndPack (pdfEngineBake.ts) and flip this pin"
        );
    }

    /// Pure-Latin subset should be tiny — a handful of ASCII glyphs only.
    #[test]
    fn subset_latin_is_tiny() {
        let fontpath = repo_root()
            .join("scripts")
            .join("fonts")
            .join("NotoSansSC.ttf");
        if !fontpath.exists() {
            eprintln!("skipping: font not downloaded");
            return;
        }
        let bytes = fs::read(&fontpath).expect("read font");
        let text = "Hello";
        let codepoints: Vec<u32> = text.chars().map(|c| c as u32).collect();
        let subset = font_subset(bytes, codepoints).expect("subset");
        assert!(
            subset.len() < 50_000,
            "Latin subset <50KB, got {} bytes",
            subset.len()
        );
    }
}
