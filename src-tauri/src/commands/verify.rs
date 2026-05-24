//! PDF structural inspection commands. Used by the app and release
//! checks to assert what saves actually wrote — annotations, form
//! fields, encryption, page sizes, metadata, XObject counts, OCGs,
//! names tree.
//!
//! All commands take a file path + optional narrowing args and return
//! a serde-serializable summary. Nothing mutates; lopdf parses in
//! place. Errors surface as AppError → Result<T, String> across the
//! IPC boundary.

use crate::error::AppError;
use crate::pdf_engine::render_page_to_png;
use crate::Result;
use lopdf::{Document, Object, ObjectId};
use serde::Serialize;
use sha2::{Digest, Sha256};

// ───────────────────────────────────────────────────────────────────
// Remove watermark text (G5: un-bake watermark drawText ops)
// ───────────────────────────────────────────────────────────────────
//
// Two-stage strip:
//   1. **Marker pass.** Scan for `/Watermark BMC ... EMC` (and the
//      properties-dict variant `/Watermark <<>> BDC ... EMC`) and
//      strip the entire range. Watermarks emitted by Open Satchel
//      from 2026-04-26 onward carry this marker — see the
//      `editSerializer.ts` `__watermark` branch which calls
//      `beginMarkedContent('Watermark')` around the drawText ops.
//      Marker-based stripping is SEMANTIC: body text that happens
//      to share the watermark string isn't touched.
//
//   2. **Text fallback.** For watermarks baked by older builds
//      (no marker) or by other tools, fall back to BT/ET blocks
//      containing the watermark text (literal or hex-uppercase /
//      hex-lowercase encodings). Best-effort:
//        - works for Helvetica/standard-14 fonts
//        - does NOT catch CIDFont-encoded watermarks (needs
//          ToUnicode reverse-mapping; out of scope)
//        - does NOT touch annotations or XObject-baked watermarks
//
// Returns the rewritten bytes. If no matching block is found on any
// page, returns the input unchanged. blocks_removed counts every
// stripped span across both passes.

#[derive(Debug, Serialize)]
pub struct WatermarkRemoveResult {
    pub bytes: Vec<u8>,
    pub blocks_removed: u32,
    pub pages_affected: Vec<u32>,
}

#[tauri::command(rename_all = "snake_case")]
pub fn pdf_remove_watermark_text(
    bytes: Vec<u8>,
    watermark_text: String,
) -> Result<WatermarkRemoveResult> {
    let mut doc = Document::load_mem(&bytes)
        .map_err(|e| AppError::Pdf(format!("remove-watermark: load: {e}")))?;
    let needle_lit = watermark_text.as_bytes().to_vec();
    let needle_hex_upper: Vec<u8> = watermark_text
        .as_bytes()
        .iter()
        .flat_map(|b| format!("{:02X}", b).into_bytes())
        .collect();
    let needle_hex_lower: Vec<u8> = watermark_text
        .as_bytes()
        .iter()
        .flat_map(|b| format!("{:02x}", b).into_bytes())
        .collect();

    let pages = doc.get_pages();
    let mut blocks_removed = 0u32;
    let mut pages_affected: Vec<u32> = Vec::new();
    // Collect the (page_index, content_stream_id) list first to avoid
    // borrow conflicts.
    let mut targets: Vec<(u32, ObjectId)> = Vec::new();
    for (one_idx, page_id) in pages.iter() {
        let p_idx = one_idx - 1;
        let page = match doc.get_object(*page_id).and_then(Object::as_dict) {
            Ok(d) => d,
            Err(_) => continue,
        };
        let contents = match page.get(b"Contents") {
            Ok(c) => c,
            Err(_) => continue,
        };
        match contents {
            Object::Reference(r) => targets.push((p_idx, *r)),
            Object::Array(arr) => {
                for o in arr {
                    if let Object::Reference(r) = o {
                        targets.push((p_idx, *r));
                    }
                }
            }
            _ => {}
        }
    }
    for (p_idx, sid) in targets {
        let original_bytes: Vec<u8> = match doc.get_object(sid) {
            Ok(Object::Stream(s)) => s
                .decompressed_content()
                .unwrap_or_else(|_| s.content.clone()),
            _ => continue,
        };
        // Pass 1 — marker-based strip. Removes /Watermark BMC..EMC
        // and /Watermark <<>> BDC..EMC ranges first.
        let (after_marker, marker_removed) = strip_watermark_marker_ranges(&original_bytes);
        // Pass 2 — text fallback for unmarked / third-party baked
        // watermarks. Only runs against the post-marker bytes so we
        // don't double-count.
        let (rewritten, text_removed) = strip_bt_et_blocks_containing(
            &after_marker,
            &[&needle_lit, &needle_hex_upper, &needle_hex_lower],
        );
        let removed = marker_removed + text_removed;
        if removed > 0 {
            blocks_removed += removed;
            if !pages_affected.contains(&p_idx) {
                pages_affected.push(p_idx);
            }
            // Replace the stream bytes. Clear the /Filter so we
            // don't claim FlateDecode for raw bytes; let the writer
            // re-encode if it wants.
            if let Ok(stream) = doc.get_object_mut(sid).and_then(|o| o.as_stream_mut()) {
                stream.set_plain_content(rewritten);
                let _ = stream.compress();
            }
        }
    }

    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    doc.save_to(&mut std::io::Cursor::new(&mut out))
        .map_err(|e| AppError::Pdf(format!("remove-watermark: save: {e}")))?;
    Ok(WatermarkRemoveResult {
        bytes: out,
        blocks_removed,
        pages_affected,
    })
}

// G5: scan a content stream for `/Watermark BMC ... EMC` and
// `/Watermark <<...>> BDC ... EMC` ranges and remove them whole.
// Returns (rewritten, removed_count). MC sequences nest in PDFs, so
// the matcher tracks depth — we only end the strip when we've
// returned to depth 0.
//
// Why both BMC and BDC: pd-lib's `beginMarkedContent('Watermark')`
// emits BMC; some tools convert BMC↔BDC during round-trips. Matching
// either form keeps the strip robust across re-saves. We leave the
// /Watermark prefix as the discriminator — generic /P or /Artifact
// marked content (used by accessibility tagging) is left alone.
fn strip_watermark_marker_ranges(stream: &[u8]) -> (Vec<u8>, u32) {
    let mut out = Vec::with_capacity(stream.len());
    let mut i = 0;
    let mut removed = 0u32;
    while i < stream.len() {
        // Look for `/Watermark` followed by whitespace then BMC or BDC.
        // The minimal pattern is `/Watermark BMC` (12 bytes). A BDC
        // form looks like `/Watermark <<...>> BDC` and can be much
        // longer — we scan forward for the BMC/BDC keyword.
        if matches_at(stream, i, b"/Watermark")
            && i + 10 < stream.len()
            && is_pdf_ws(stream[i + 10])
        {
            // Find the operator end ("BMC" or "BDC") within a small
            // window — properties dicts are usually <100 bytes.
            let scan_end = (i + 256).min(stream.len());
            let mut start_op_end: Option<usize> = None;
            for j in i + 11..scan_end - 2 {
                if (matches_at(stream, j, b"BMC") || matches_at(stream, j, b"BDC"))
                    && (j + 3 == stream.len() || is_pdf_ws(stream[j + 3]))
                {
                    start_op_end = Some(j + 3);
                    break;
                }
            }
            if let Some(after_open) = start_op_end {
                // Walk forward, tracking nested marked-content depth.
                let mut depth = 1u32;
                let mut k = after_open;
                while k + 3 <= stream.len() {
                    // Increment on any BMC / BDC opener.
                    if (matches_at(stream, k, b"BMC") || matches_at(stream, k, b"BDC"))
                        && k > 0
                        && is_pdf_ws(stream[k - 1])
                        && (k + 3 == stream.len() || is_pdf_ws(stream[k + 3]))
                    {
                        depth += 1;
                        k += 3;
                        continue;
                    }
                    // Decrement on EMC. Stop when we're back to 0.
                    if matches_at(stream, k, b"EMC")
                        && k > 0
                        && is_pdf_ws(stream[k - 1])
                        && (k + 3 == stream.len() || is_pdf_ws(stream[k + 3]))
                    {
                        depth -= 1;
                        if depth == 0 {
                            // Skip past EMC + any trailing whitespace.
                            i = k + 3;
                            while i < stream.len() && is_pdf_ws(stream[i]) {
                                i += 1;
                            }
                            removed += 1;
                            // Note: we don't write any of the BMC/BDC..EMC
                            // bytes to `out`. Continue the outer loop.
                            break;
                        }
                        k += 3;
                        continue;
                    }
                    k += 1;
                }
                if depth != 0 {
                    // Unmatched EMC — give up on this marker. Copy the
                    // /Watermark bytes through so we don't lose data.
                    out.push(stream[i]);
                    i += 1;
                }
                continue;
            }
        }
        out.push(stream[i]);
        i += 1;
    }
    (out, removed)
}

fn matches_at(haystack: &[u8], pos: usize, needle: &[u8]) -> bool {
    if pos + needle.len() > haystack.len() {
        return false;
    }
    &haystack[pos..pos + needle.len()] == needle
}

fn is_pdf_ws(b: u8) -> bool {
    matches!(b, b' ' | b'\n' | b'\r' | b'\t' | 0x0C | 0x00)
}

// Scan a content stream for BT (begin text) ... ET (end text) blocks
// containing any of the needles, and remove the whole block. Returns
// (rewritten, removed_count). Naive byte-search — fine for non-nested
// content streams (BT/ET don't nest in valid PDFs).
fn strip_bt_et_blocks_containing(stream: &[u8], needles: &[&[u8]]) -> (Vec<u8>, u32) {
    let mut out = Vec::with_capacity(stream.len());
    let mut i = 0;
    let mut removed = 0u32;
    while i < stream.len() {
        // Look for "BT" preceded by whitespace or start.
        if i + 2 <= stream.len()
            && &stream[i..i + 2] == b"BT"
            && (i == 0 || matches!(stream[i - 1], b' ' | b'\n' | b'\r' | b'\t'))
        {
            // Find matching "ET" forward.
            let mut j = i + 2;
            while j + 2 <= stream.len() {
                if &stream[j..j + 2] == b"ET"
                    && (j == 0 || matches!(stream[j - 1], b' ' | b'\n' | b'\r' | b'\t'))
                {
                    break;
                }
                j += 1;
            }
            if j + 2 > stream.len() {
                // No matching ET — give up, copy rest.
                out.extend_from_slice(&stream[i..]);
                break;
            }
            let block = &stream[i..j + 2];
            let contains = needles
                .iter()
                .any(|n| !n.is_empty() && block.windows(n.len()).any(|w| w == *n));
            if contains {
                removed += 1;
                // Skip the block + any trailing whitespace newline.
                i = j + 2;
                while i < stream.len() && matches!(stream[i], b' ' | b'\n' | b'\r' | b'\t') {
                    i += 1;
                }
            } else {
                out.extend_from_slice(block);
                i = j + 2;
            }
        } else {
            out.push(stream[i]);
            i += 1;
        }
    }
    (out, removed)
}

// ───────────────────────────────────────────────────────────────────
// Strip text in bbox (G9: destructive overlay backstop)
// ───────────────────────────────────────────────────────────────────
//
// Loads the PDF via pdfium, removes every Text page-object on
// `page_index` whose bounding box overlaps `bbox` (PDF user space,
// origin bottom-left), regenerates the content stream, and returns
// the cleaned bytes. Used by the JS save path before falling back to
// overlay bake — pre-stripping the original Tj/TJ runs in the bbox
// means the overlay paint goes onto already-clean bytes, with no
// underlying text recoverable via extraction.
//
// **Granularity:** acts on the whole text page-object granularity that
// pdfium reports — typically one BT...ET run per object. For tightly-
// packed paragraphs that share a Tj chain, this strips per the bbox
// intersection. Doesn't surgically split a Tj if the bbox covers only
// part of a Tj's text — the whole object goes. For paragraph-edit use
// (where bbox = whole paragraph), that's the right granularity.
//
// **Implementation note:** content_regeneration_strategy=AUTOMATIC so
// pdfium re-emits the page content stream after the mutation. Without
// that the in-memory object list changes but the on-disk stream stays
// the same — save_to_bytes would emit the original.

#[derive(Debug, serde::Deserialize, serde::Serialize, Clone)]
pub struct StripBbox {
    pub page_index: u16,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    /// Optional coordinate-space hint:
    ///   "pdf"  (default) — bottom-left origin, y grows up. Pass-through.
    ///   "css"            — top-left origin, y grows down. Engine flips
    ///                      using the page's height before bounds-test.
    #[serde(default)]
    pub coord_space: Option<String>,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn pdf_strip_text_in_bboxes(bytes: Vec<u8>, bboxes: Vec<StripBbox>) -> Result<Vec<u8>> {
    crate::pdf_engine::render_thread::submit(move || strip_text_impl(bytes, bboxes)).await
}

/// Path-in/path-out variant of [`pdf_strip_text_in_bboxes`]. Same
/// motivation as `engine_bake_to_path`: for heavy docs the bytes
/// IPC inflates ~6× via JSON-array marshal in BOTH directions, so
/// a 33 MB doc costs ~200 MB IN + ~200 MB OUT just to remove a
/// handful of text bboxes. Path route caps the IPC payload at the
/// JSON paths regardless of doc size.
#[tauri::command(rename_all = "snake_case")]
pub async fn pdf_strip_text_in_bboxes_to_path(
    input_path: String,
    output_path: String,
    bboxes: Vec<StripBbox>,
) -> Result<()> {
    crate::pdf_engine::render_thread::submit(move || {
        let bytes = std::fs::read(&input_path)
            .map_err(|e| AppError::Pdf(format!("strip-text-to-path: read {input_path}: {e}")))?;
        let out = strip_text_impl(bytes, bboxes)?;
        std::fs::write(&output_path, &out)
            .map_err(|e| AppError::Pdf(format!("strip-text-to-path: write {output_path}: {e}")))?;
        Ok(())
    })
    .await
}

fn strip_text_impl(bytes: Vec<u8>, bboxes: Vec<StripBbox>) -> Result<Vec<u8>> {
    use pdfium_render::prelude::*;

    if bboxes.is_empty() {
        return Ok(bytes);
    }

    // Group bboxes by page so each page is loaded + mutated once.
    let mut by_page: std::collections::HashMap<u16, Vec<StripBbox>> =
        std::collections::HashMap::new();
    for b in bboxes {
        by_page.entry(b.page_index).or_default().push(b);
    }

    crate::pdf_engine::render::with_pdfium_pub(move |pdfium| {
        let document = pdfium
            .load_pdf_from_byte_vec(bytes, None)
            .map_err(|e| AppError::Pdf(format!("strip-text: load: {e}")))?;
        let pages = document.pages();
        for (page_idx, page_bboxes) in by_page.iter() {
            let mut page = pages
                .get(*page_idx)
                .map_err(|e| AppError::Pdf(format!("strip-text: page {page_idx}: {e}")))?;
            // Flip CSS-space bboxes to PDF-space using the page's height.
            let page_height = page.height().value;
            let normalized: Vec<StripBbox> = page_bboxes
                .iter()
                .map(|b| {
                    if b.coord_space.as_deref() == Some("css") {
                        let mut nb = b.clone();
                        // CSS y grows down from top; PDF y grows up
                        // from bottom. Flip the box's bottom edge.
                        nb.y = page_height - (b.y + b.height);
                        nb.coord_space = Some("pdf".into());
                        nb
                    } else {
                        b.clone()
                    }
                })
                .collect();
            let page_bboxes: &[StripBbox] = &normalized;
            // AUTOMATIC so pdfium re-emits the content stream after
            // we drop text objects.
            page.set_content_regeneration_strategy(
                PdfPageContentRegenerationStrategy::AutomaticOnEveryChange,
            );

            // Collect indices of text objects whose bounds overlap any
            // of the page's bboxes.
            let mut to_remove: Vec<PdfPageObjectIndex> = Vec::new();
            {
                let objects = page.objects();
                for idx in 0..objects.len() {
                    let Ok(obj) = objects.get(idx) else { continue };
                    if obj.object_type() != PdfPageObjectType::Text {
                        continue;
                    }
                    let Ok(bounds) = obj.bounds() else { continue };
                    if bounds_overlaps_any(&bounds, page_bboxes) {
                        to_remove.push(idx);
                    }
                }
            }
            if to_remove.is_empty() {
                continue;
            }
            // Remove in reverse index order.
            let objects_mut = page.objects_mut();
            for idx in to_remove.iter().rev().copied() {
                if let Ok(removed) = objects_mut.remove_object_at_index(idx) {
                    // pdfium's FPDFPage_RemoveObject already destroyed
                    // the underlying memory — forget the wrapper to
                    // avoid double-free in Drop. Same pattern as
                    // render::remove_text_objects_in_regions.
                    std::mem::forget(removed);
                }
            }
        }
        let mut out: Vec<u8> = Vec::new();
        document
            .save_to_writer(&mut out)
            .map_err(|e| AppError::Pdf(format!("strip-text: save: {e}")))?;
        Ok(out)
    })
}

fn bounds_overlaps_any(b: &pdfium_render::prelude::PdfQuadPoints, list: &[StripBbox]) -> bool {
    let l = b.left().value;
    let r = b.right().value;
    let bot = b.bottom().value;
    let top = b.top().value;
    for sb in list {
        let sl = sb.x;
        let sr = sb.x + sb.width;
        let sb_bot = sb.y;
        let sb_top = sb.y + sb.height;
        if l < sr && r > sl && bot < sb_top && top > sb_bot {
            return true;
        }
    }
    false
}

// ───────────────────────────────────────────────────────────────────
// Decrypt PDF (G4: remove encryption from on-disk-encrypted file)
// ───────────────────────────────────────────────────────────────────
//
// Takes encrypted bytes + password, produces decrypted bytes with
// no /Encrypt dict. Uses lopdf's built-in Document::decrypt.
//
// Returns the bytes; caller writes them back to disk + clears the
// in-memory `state.encryption` to undefined. The next save then
// emits unencrypted output via the normal pd-lib save path.
//
// **Implementation note:** lopdf 0.32 supports revisions 2 and 3
// (RC4-40 / RC4-128 from PDF 1.4-) plus partial 4. AES-256 revisions
// 5 and 6 are handled through a local qpdf fallback until the native
// algorithm-2.B KDF is implemented directly.

/// Detect AES-256 R=5 / R=6 encryption from the trailer-byte signature.
/// Looks for `/V 5 ... /R 5` or `/R 6` in the trailer's /Encrypt dict.
/// Returns `Some(rev)` when the signature is present, `None` otherwise.
fn detect_aes256_high_rev(bytes: &[u8]) -> Option<u8> {
    // Scan the last 16KB of the file (the trailer + xref + Encrypt dict
    // are always near EOF). lopdf's load_mem already failed before we
    // reach this code path, so we work directly on the bytes.
    let tail_start = bytes.len().saturating_sub(16 * 1024);
    let tail = &bytes[tail_start..];
    // Encrypted PDFs are mostly ASCII in the trailer. Use lossy UTF-8 so
    // incidental binary bytes in object streams do not hide /Encrypt.
    let text = String::from_utf8_lossy(tail);
    // Look for `/V 5` (algorithm version 5 — AES-256) AND `/R 6` or
    // `/R 5` (key-derivation revision). Both must be present for
    // R=5/R=6 detection — V=4 fixtures have a /R 4 we DO support via
    // lopdf 0.32.
    let has_v5 = text.contains("/V 5") || text.contains("/V/5");
    if !has_v5 {
        return None;
    }
    // /R 5 → AES-256 Adobe Ext Level 3 (the "weaker" KDF that zga uses
    // before pdfCryptoR6.ts upgrades to R=6).
    // /R 6 → PDF 2.0 hardened KDF (10K SHA-256 rounds + Salt2).
    if text.contains("/R 6") || text.contains("/R/6") {
        return Some(6);
    }
    if text.contains("/R 5") || text.contains("/R/5") {
        return Some(5);
    }
    None
}

#[tauri::command(rename_all = "snake_case")]
pub fn pdf_decrypt_bytes(bytes: Vec<u8>, password: String) -> Result<Vec<u8>> {
    // G4 ergonomic: detect AES-256 R=5 / R=6 BEFORE handing to lopdf
    // so we can try qpdf's battle-tested decrypt path before falling back
    // to a user-readable unsupported message.
    if let Some(rev) = detect_aes256_high_rev(&bytes) {
        return decrypt_with_qpdf(&bytes, &password).map_err(|qpdf_err| {
            AppError::Pdf(format!(
                "decrypt: AES-256 revision {rev} needs qpdf for this build. \
                 qpdf fallback failed: {qpdf_err}. Native follow-up: implement \
                 the R=5/R=6 KDF directly via crate `aes` + the algorithm-2.B \
                 routine pdfCryptoR6.ts already encodes."
            ))
        });
    }

    match decrypt_with_lopdf(&bytes, &password) {
        Ok(out) => Ok(out),
        Err(lopdf_err) => decrypt_with_qpdf(&bytes, &password).map_err(|qpdf_err| {
            AppError::Pdf(format!("{lopdf_err}; qpdf fallback failed: {qpdf_err}"))
        }),
    }
}

fn decrypt_with_lopdf(bytes: &[u8], password: &str) -> Result<Vec<u8>> {
    let mut doc =
        Document::load_mem(bytes).map_err(|e| AppError::Pdf(format!("decrypt: load: {e}")))?;
    // load_mem succeeds even on encrypted files; content streams stay
    // ciphertext until decrypt() is called with the password.
    if doc.is_encrypted() {
        doc.decrypt(password.as_bytes()).map_err(|e| {
            AppError::Pdf(format!(
                "decrypt: wrong password or unsupported algorithm: {e}"
            ))
        })?;
    }
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    doc.save_to(&mut std::io::Cursor::new(&mut out))
        .map_err(|e| AppError::Pdf(format!("decrypt: save: {e}")))?;
    Ok(out)
}

fn decrypt_with_qpdf(bytes: &[u8], password: &str) -> std::result::Result<Vec<u8>, String> {
    use std::process::Command;
    use uuid::Uuid;

    let dir = std::env::temp_dir().join(format!("open-satchel-qpdf-decrypt-{}", Uuid::new_v4()));
    std::fs::create_dir(&dir).map_err(|e| format!("create temp dir: {e}"))?;
    let result = (|| {
        let input = dir.join("input.pdf");
        let output = dir.join("output.pdf");
        let password_file = dir.join("password.txt");
        std::fs::write(&input, bytes).map_err(|e| format!("write input: {e}"))?;
        std::fs::write(&password_file, password.as_bytes())
            .map_err(|e| format!("write password file: {e}"))?;
        let status = Command::new("qpdf")
            .arg(format!(
                "--password-file={}",
                password_file.to_string_lossy()
            ))
            .arg("--decrypt")
            .arg(&input)
            .arg(&output)
            .output()
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    "qpdf not found on PATH".to_string()
                } else {
                    format!("spawn qpdf: {e}")
                }
            })?;
        if !status.status.success() {
            let stderr = String::from_utf8_lossy(&status.stderr);
            let stdout = String::from_utf8_lossy(&status.stdout);
            let detail = if !stderr.trim().is_empty() {
                stderr.trim()
            } else {
                stdout.trim()
            };
            return Err(format!(
                "qpdf exited with status {}{}",
                status.status,
                if detail.is_empty() {
                    String::new()
                } else {
                    format!(": {detail}")
                },
            ));
        }
        std::fs::read(&output).map_err(|e| format!("read output: {e}"))
    })();
    let _ = std::fs::remove_dir_all(&dir);
    result
}

// ───────────────────────────────────────────────────────────────────
// Annotations
// ───────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct AnnotInfo {
    pub page_index: u32,
    pub subtype: String,
    pub rect: Option<[f32; 4]>,
    pub contents: Option<String>,
    pub uri: Option<String>,
    pub color: Option<Vec<f32>>,
    pub ca: Option<f32>,
    pub name: Option<String>,
    pub quad_points: Option<Vec<f32>>,
}

#[tauri::command]
pub fn pdf_verify_annotation(path: String, page_index: Option<u32>) -> Result<Vec<AnnotInfo>> {
    let doc = load(&path)?;
    let pages = doc.get_pages();
    let mut out = Vec::new();
    for (p_one_idx, page_id) in pages.iter() {
        let p_idx = p_one_idx - 1;
        if let Some(want) = page_index {
            if p_idx != want {
                continue;
            }
        }
        let page = match doc.get_object(*page_id).and_then(Object::as_dict) {
            Ok(d) => d,
            Err(_) => continue,
        };
        let annots = match page.get(b"Annots") {
            Ok(Object::Array(a)) => a.clone(),
            Ok(Object::Reference(r)) => match doc.get_object(*r) {
                Ok(Object::Array(a)) => a.clone(),
                _ => continue,
            },
            _ => continue,
        };
        for annot_ref in annots {
            let annot_dict = match resolve_dict(&doc, &annot_ref) {
                Some(d) => d,
                None => continue,
            };
            let subtype = annot_dict
                .get(b"Subtype")
                .ok()
                .and_then(|o| o.as_name().ok())
                .map(|n| String::from_utf8_lossy(n).into_owned())
                .unwrap_or_default();
            let rect = annot_dict
                .get(b"Rect")
                .ok()
                .and_then(|o| o.as_array().ok())
                .and_then(|arr| {
                    if arr.len() != 4 {
                        return None;
                    }
                    Some([
                        obj_to_f32(&arr[0]),
                        obj_to_f32(&arr[1]),
                        obj_to_f32(&arr[2]),
                        obj_to_f32(&arr[3]),
                    ])
                });
            let contents = annot_dict
                .get(b"Contents")
                .ok()
                .and_then(|o| o.as_str().ok())
                .map(|s| String::from_utf8_lossy(s).into_owned());
            let uri = annot_dict
                .get(b"A")
                .ok()
                .and_then(|o| resolve_dict_obj(&doc, o))
                .and_then(|d| d.get(b"URI").ok().cloned())
                .and_then(|o| {
                    o.as_str()
                        .ok()
                        .map(|s| String::from_utf8_lossy(s).into_owned())
                });
            let color = annot_dict
                .get(b"C")
                .ok()
                .and_then(|o| o.as_array().ok())
                .map(|arr| arr.iter().map(obj_to_f32).collect());
            let ca = annot_dict.get(b"CA").ok().map(obj_to_f32);
            let name = annot_dict
                .get(b"NM")
                .ok()
                .and_then(|o| o.as_str().ok())
                .map(|s| String::from_utf8_lossy(s).into_owned());
            let quad_points = annot_dict
                .get(b"QuadPoints")
                .ok()
                .and_then(|o| o.as_array().ok())
                .map(|arr| arr.iter().map(obj_to_f32).collect());
            out.push(AnnotInfo {
                page_index: p_idx,
                subtype,
                rect,
                contents,
                uri,
                color,
                ca,
                name,
                quad_points,
            });
        }
    }
    Ok(out)
}

// ───────────────────────────────────────────────────────────────────
// AcroForm
// ───────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct FieldInfo {
    pub partial_name: Option<String>,
    pub field_type: Option<String>,
    pub rect: Option<[f32; 4]>,
    pub value: Option<String>,
}

#[tauri::command]
pub fn pdf_verify_acroform(path: String) -> Result<Vec<FieldInfo>> {
    let doc = load(&path)?;
    let catalog = doc.catalog().map_err(|e| AppError::Pdf(e.to_string()))?;
    let acro = match catalog.get(b"AcroForm") {
        Ok(o) => resolve_dict_obj(&doc, o),
        Err(_) => None,
    };
    let acro = match acro {
        Some(d) => d,
        None => return Ok(Vec::new()),
    };
    let fields = match acro.get(b"Fields") {
        Ok(Object::Array(a)) => a.clone(),
        Ok(Object::Reference(r)) => match doc.get_object(*r) {
            Ok(Object::Array(a)) => a.clone(),
            _ => return Ok(Vec::new()),
        },
        _ => return Ok(Vec::new()),
    };
    let mut out = Vec::new();
    for field_ref in &fields {
        walk_field(&doc, field_ref, None, &mut out);
    }
    Ok(out)
}

/// Walk an AcroForm field subtree, emitting one FieldInfo per LEAF
/// (terminal) field. Real-world forms (W-9, 1040, every IRS PDF) nest
/// fields several levels deep under group containers — the top-level
/// /Fields entry is a /Kids parent like "topmostSubform[0]" and the
/// actual fillable widgets sit one or two levels below [B20]. We
/// extend the qualified name on each recursion via PDF's standard
/// dot-join.
fn walk_field(doc: &Document, field_ref: &Object, prefix: Option<&str>, out: &mut Vec<FieldInfo>) {
    let field = match resolve_dict(&doc, field_ref) {
        Some(d) => d,
        None => return,
    };

    let local_name = field
        .get(b"T")
        .ok()
        .and_then(|o| o.as_str().ok())
        .map(decode_pdf_text_string);
    let qualified_name: Option<String> = match (prefix, local_name.as_ref()) {
        (Some(p), Some(n)) => Some(format!("{p}.{n}")),
        (Some(p), None) => Some(p.to_string()),
        (None, Some(n)) => Some(n.clone()),
        (None, None) => None,
    };

    let kids: Vec<Object> = match field.get(b"Kids") {
        Ok(Object::Array(a)) => a.clone(),
        Ok(Object::Reference(r)) => match doc.get_object(*r) {
            Ok(Object::Array(a)) => a.clone(),
            _ => Vec::new(),
        },
        _ => Vec::new(),
    };

    // Per PDF spec section 12.7.3.1, a non-terminal field has /Kids
    // entries that are other fields (each with its own /T). A terminal
    // field's /Kids — if any — refers only to widget annotations
    // (no /T). Use the presence of /T on at least one kid as the
    // discriminator.
    let any_kid_has_t = kids.iter().any(|k| {
        resolve_dict(doc, k)
            .and_then(|d| d.get(b"T").ok())
            .is_some()
    });

    if !kids.is_empty() && any_kid_has_t {
        for k in &kids {
            walk_field(doc, k, qualified_name.as_deref(), out);
        }
        return;
    }

    // Terminal field — emit it. /FT and /V are inheritable per PDF
    // 1.7 section 12.7.3.3; many real forms (W-9, 1040) put /FT and
    // /V only on the parent group dict, not on the leaf widget. Walk
    // the /Parent chain when reading those.
    let field_type = read_inheritable_name(doc, &field, b"FT");
    let rect = field
        .get(b"Rect")
        .ok()
        .and_then(|o| o.as_array().ok())
        .and_then(|arr| {
            if arr.len() != 4 {
                return None;
            }
            Some([
                obj_to_f32(&arr[0]),
                obj_to_f32(&arr[1]),
                obj_to_f32(&arr[2]),
                obj_to_f32(&arr[3]),
            ])
        });
    let value = read_inheritable_value(doc, &field);

    out.push(FieldInfo {
        partial_name: qualified_name,
        field_type,
        rect,
        value,
    });
}

/// Read /V from a field dict, falling back through /Parent. Per PDF
/// 1.7 section 12.7.3.3 the value of an AcroForm field is inherited
/// from the parent group when the leaf doesn't carry its own. Real
/// forms (W-9, 1040) typically put /V only on the parent.
fn read_inheritable_value(doc: &Document, field: &lopdf::Dictionary) -> Option<String> {
    let read_v = |d: &lopdf::Dictionary| -> Option<String> {
        match d.get(b"V").ok()? {
            Object::String(s, _) => Some(decode_pdf_text_string(s)),
            Object::Name(n) => Some(String::from_utf8_lossy(n).into_owned()),
            _ => None,
        }
    };
    if let Some(s) = read_v(field) {
        return Some(s);
    }
    // resolve_dict returns Option<&Dictionary>; clone to avoid the
    // lifetime tangle when walking a chain. Dictionaries are small
    // HashMap<Vec<u8>, Object> values, so the per-step copy is
    // cheaper than the I/O it took to load them.
    let mut cursor: Option<lopdf::Dictionary> = field
        .get(b"Parent")
        .ok()
        .and_then(|p| resolve_dict(doc, p))
        .cloned();
    let mut depth = 0;
    while let Some(d) = cursor {
        if let Some(s) = read_v(&d) {
            return Some(s);
        }
        if depth > 12 {
            break;
        }
        depth += 1;
        cursor = d
            .get(b"Parent")
            .ok()
            .and_then(|p| resolve_dict(doc, p))
            .cloned();
    }
    None
}

/// Read a /Name attribute (e.g. /FT) inherited through /Parent.
fn read_inheritable_name(doc: &Document, field: &lopdf::Dictionary, key: &[u8]) -> Option<String> {
    if let Ok(n) = field.get(key).and_then(|o| o.as_name()) {
        return Some(String::from_utf8_lossy(n).into_owned());
    }
    let mut cursor: Option<lopdf::Dictionary> = field
        .get(b"Parent")
        .ok()
        .and_then(|p| resolve_dict(doc, p))
        .cloned();
    let mut depth = 0;
    while let Some(d) = cursor {
        if let Ok(n) = d.get(key).and_then(|o| o.as_name()) {
            return Some(String::from_utf8_lossy(n).into_owned());
        }
        if depth > 12 {
            break;
        }
        depth += 1;
        cursor = d
            .get(b"Parent")
            .ok()
            .and_then(|p| resolve_dict(doc, p))
            .cloned();
    }
    None
}

// ───────────────────────────────────────────────────────────────────
// Encryption
// ───────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct EncryptionInfo {
    pub present: bool,
    pub filter: Option<String>,
    pub v: Option<i64>,
    pub r: Option<i64>,
    pub length: Option<i64>,
    pub p: Option<i64>,
    // Decoded from /P bits per PDF 1.7 spec §7.6.3.2 Table 22. Bit-set =
    // allowed. Unset = forbidden. Null when /Encrypt is absent.
    pub allow_print: Option<bool>,       // bit 3  (value 4)
    pub allow_modify: Option<bool>,      // bit 4  (value 8)
    pub allow_copy: Option<bool>,        // bit 5  (value 16)
    pub allow_annot_forms: Option<bool>, // bit 6  (value 32)
    pub allow_fill_forms: Option<bool>,  // bit 9  (value 256)
    pub allow_extract: Option<bool>,     // bit 10 (value 512)
    pub allow_assemble: Option<bool>,    // bit 11 (value 1024)
    pub allow_print_high: Option<bool>,  // bit 12 (value 2048)
}

#[tauri::command]
pub fn pdf_verify_encryption(path: String) -> Result<EncryptionInfo> {
    let doc = load(&path)?;
    let enc = match doc.trailer.get(b"Encrypt") {
        Ok(o) => resolve_dict_obj(&doc, o),
        Err(_) => None,
    };
    let enc = match enc {
        Some(d) => d,
        None => {
            return Ok(EncryptionInfo {
                present: false,
                filter: None,
                v: None,
                r: None,
                length: None,
                p: None,
                allow_print: None,
                allow_modify: None,
                allow_copy: None,
                allow_annot_forms: None,
                allow_fill_forms: None,
                allow_extract: None,
                allow_assemble: None,
                allow_print_high: None,
            })
        }
    };
    let p = enc.get(b"P").ok().and_then(|o| o.as_i64().ok());
    let bit = |mask: i64| p.map(|pv| (pv & mask) != 0);
    Ok(EncryptionInfo {
        present: true,
        filter: enc
            .get(b"Filter")
            .ok()
            .and_then(|o| o.as_name().ok())
            .map(|n| String::from_utf8_lossy(n).into_owned()),
        v: enc.get(b"V").ok().and_then(|o| o.as_i64().ok()),
        r: enc.get(b"R").ok().and_then(|o| o.as_i64().ok()),
        length: enc.get(b"Length").ok().and_then(|o| o.as_i64().ok()),
        p,
        allow_print: bit(4),
        allow_modify: bit(8),
        allow_copy: bit(16),
        allow_annot_forms: bit(32),
        allow_fill_forms: bit(256),
        allow_extract: bit(512),
        allow_assemble: bit(1024),
        allow_print_high: bit(2048),
    })
}

// ───────────────────────────────────────────────────────────────────
// Names tree (/Names /Dests, /Names /JavaScript, etc.)
// ───────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct NamesEntry {
    pub name: String,
    /// Raw pretty-printed destination reference. Verifiers pattern-match
    /// on this rather than parsing every flavor of /Dest array/ref.
    pub dest_preview: String,
}

#[tauri::command]
pub fn pdf_verify_names_tree(path: String, key: String) -> Result<Vec<NamesEntry>> {
    let doc = load(&path)?;
    let catalog = doc.catalog().map_err(|e| AppError::Pdf(e.to_string()))?;
    let names = match catalog.get(b"Names") {
        Ok(o) => resolve_dict_obj(&doc, o),
        Err(_) => None,
    };
    let names = match names {
        Some(d) => d,
        None => return Ok(Vec::new()),
    };
    let subtree = match names.get(key.as_bytes()) {
        Ok(o) => resolve_dict_obj(&doc, o),
        Err(_) => None,
    };
    let subtree = match subtree {
        Some(d) => d,
        None => return Ok(Vec::new()),
    };
    let mut out = Vec::new();
    collect_names_tree(&doc, subtree, &mut out);
    Ok(out)
}

fn collect_names_tree(doc: &Document, node: &lopdf::Dictionary, out: &mut Vec<NamesEntry>) {
    if let Ok(Object::Array(kids)) = node.get(b"Kids") {
        for kid in kids.clone() {
            if let Some(child) = resolve_dict(doc, &kid) {
                collect_names_tree(doc, child, out);
            }
        }
    }
    if let Ok(Object::Array(names_arr)) = node.get(b"Names") {
        let mut i = 0;
        while i + 1 < names_arr.len() {
            let name = match &names_arr[i] {
                Object::String(s, _) => String::from_utf8_lossy(s).into_owned(),
                _ => String::new(),
            };
            let preview = format!("{:?}", &names_arr[i + 1])
                .chars()
                .take(120)
                .collect();
            out.push(NamesEntry {
                name,
                dest_preview: preview,
            });
            i += 2;
        }
    }
}

// ───────────────────────────────────────────────────────────────────
// Page size / boxes
// ───────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct PageSize {
    pub page_index: u32,
    pub media_box: Option<[f32; 4]>,
    pub crop_box: Option<[f32; 4]>,
    pub rotation: Option<i64>,
}

#[tauri::command]
pub fn pdf_verify_page_size(path: String, page_index: Option<u32>) -> Result<Vec<PageSize>> {
    let doc = load(&path)?;
    let pages = doc.get_pages();
    let mut out = Vec::new();
    for (p_one_idx, page_id) in pages.iter() {
        let p_idx = p_one_idx - 1;
        if let Some(want) = page_index {
            if p_idx != want {
                continue;
            }
        }
        let page = match doc.get_object(*page_id).and_then(Object::as_dict) {
            Ok(d) => d,
            Err(_) => continue,
        };
        let media = inherited_box(&doc, page, b"MediaBox");
        let crop = inherited_box(&doc, page, b"CropBox");
        let rotation = page.get(b"Rotate").ok().and_then(|o| o.as_i64().ok());
        out.push(PageSize {
            page_index: p_idx,
            media_box: media,
            crop_box: crop,
            rotation,
        });
    }
    Ok(out)
}

fn inherited_box(doc: &Document, page: &lopdf::Dictionary, key: &[u8]) -> Option<[f32; 4]> {
    if let Ok(o) = page.get(key) {
        if let Ok(arr) = o.as_array() {
            if arr.len() == 4 {
                return Some([
                    obj_to_f32(&arr[0]),
                    obj_to_f32(&arr[1]),
                    obj_to_f32(&arr[2]),
                    obj_to_f32(&arr[3]),
                ]);
            }
        }
    }
    if let Ok(parent_obj) = page.get(b"Parent") {
        if let Some(parent) = resolve_dict_obj(doc, parent_obj) {
            return inherited_box(doc, parent, key);
        }
    }
    None
}

// ───────────────────────────────────────────────────────────────────
// Metadata (/Info + optional XMP preview)
// ───────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct PdfMetadata {
    pub title: Option<String>,
    pub author: Option<String>,
    pub subject: Option<String>,
    pub keywords: Option<String>,
    pub creator: Option<String>,
    pub producer: Option<String>,
    pub creation_date: Option<String>,
    pub mod_date: Option<String>,
    pub xmp_preview: Option<String>,
}

#[tauri::command]
pub fn pdf_verify_metadata(path: String) -> Result<PdfMetadata> {
    let doc = load(&path)?;
    let info_obj = doc.trailer.get(b"Info").ok().cloned();
    let info = info_obj.as_ref().and_then(|o| resolve_dict_obj(&doc, o));

    fn s(dict: Option<&lopdf::Dictionary>, key: &[u8]) -> Option<String> {
        let bytes = dict?.get(key).ok()?.as_str().ok()?;
        Some(decode_pdf_text_string(bytes))
    }

    // XMP: search catalog for /Metadata (stream). Return first 8KB of
    // the decoded stream — enough for tests to find specific tags
    // (dc:title / dc:creator / etc.) which can land past the first
    // 300-char namespace-declaration block. Cap at 8KB to keep the
    // IPC payload bounded for huge XMP bodies (some tagged PDFs have
    // 20KB+ of XMP).
    let xmp_preview = doc
        .catalog()
        .ok()
        .and_then(|c| c.get(b"Metadata").ok().cloned())
        .and_then(|o| {
            if let Object::Reference(r) = o {
                doc.get_object(r)
                    .ok()
                    .and_then(|inner| inner.as_stream().ok())
            } else {
                None
            }
        })
        .and_then(|s| {
            s.decompressed_content()
                .ok()
                .or_else(|| Some(s.content.clone()))
        })
        .map(|bytes| String::from_utf8_lossy(&bytes[..bytes.len().min(8192)]).into_owned());

    Ok(PdfMetadata {
        title: s(info, b"Title"),
        author: s(info, b"Author"),
        subject: s(info, b"Subject"),
        keywords: s(info, b"Keywords"),
        creator: s(info, b"Creator"),
        producer: s(info, b"Producer"),
        creation_date: s(info, b"CreationDate"),
        mod_date: s(info, b"ModDate"),
        xmp_preview,
    })
}

// ───────────────────────────────────────────────────────────────────
// XObject counts (images vs forms)
// ───────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct XObjectCounts {
    pub page_index: u32,
    pub image_count: u32,
    pub form_count: u32,
    pub image_names: Vec<String>,
}

#[tauri::command]
pub fn pdf_verify_xobject_count(
    path: String,
    page_index: Option<u32>,
) -> Result<Vec<XObjectCounts>> {
    let doc = load(&path)?;
    let pages = doc.get_pages();
    let mut out = Vec::new();
    for (p_one_idx, page_id) in pages.iter() {
        let p_idx = p_one_idx - 1;
        if let Some(want) = page_index {
            if p_idx != want {
                continue;
            }
        }
        let page = match doc.get_object(*page_id).and_then(Object::as_dict) {
            Ok(d) => d,
            Err(_) => continue,
        };
        // Resources may be inherited or direct.
        let resources = page
            .get(b"Resources")
            .ok()
            .and_then(|o| resolve_dict_obj(&doc, o));
        let mut img = 0u32;
        let mut frm = 0u32;
        let mut img_names: Vec<String> = Vec::new();
        if let Some(res) = resources {
            let xobject = res
                .get(b"XObject")
                .ok()
                .and_then(|o| resolve_dict_obj(&doc, o));
            if let Some(xo) = xobject {
                for (name, val) in xo.iter() {
                    let stream = match val {
                        Object::Reference(r) => doc
                            .get_object(*r)
                            .ok()
                            .and_then(|o| o.as_stream().ok())
                            .cloned(),
                        Object::Stream(s) => Some(s.clone()),
                        _ => None,
                    };
                    if let Some(s) = stream {
                        match s.dict.get(b"Subtype").ok().and_then(|o| o.as_name().ok()) {
                            Some(b"Image") => {
                                img += 1;
                                img_names.push(String::from_utf8_lossy(name).into_owned());
                            }
                            Some(b"Form") => frm += 1,
                            _ => {}
                        }
                    }
                }
            }
        }
        out.push(XObjectCounts {
            page_index: p_idx,
            image_count: img,
            form_count: frm,
            image_names: img_names,
        });
    }
    Ok(out)
}

// ───────────────────────────────────────────────────────────────────
// OCGs (Optional Content Groups — layers)
// ───────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct OcgInfo {
    pub name: String,
    pub default_on: bool,
}

#[tauri::command]
pub fn pdf_verify_ocgs(path: String) -> Result<Vec<OcgInfo>> {
    let doc = load(&path)?;
    let catalog = doc.catalog().map_err(|e| AppError::Pdf(e.to_string()))?;
    let ocp = match catalog.get(b"OCProperties") {
        Ok(o) => resolve_dict_obj(&doc, o),
        Err(_) => None,
    };
    let ocp = match ocp {
        Some(d) => d,
        None => return Ok(Vec::new()),
    };
    let ocgs = match ocp.get(b"OCGs") {
        Ok(Object::Array(a)) => a.clone(),
        Ok(Object::Reference(r)) => match doc.get_object(*r) {
            Ok(Object::Array(a)) => a.clone(),
            _ => return Ok(Vec::new()),
        },
        _ => return Ok(Vec::new()),
    };
    let default = ocp.get(b"D").ok().and_then(|o| resolve_dict_obj(&doc, o));
    let off_set: std::collections::HashSet<ObjectId> = default
        .and_then(|d| d.get(b"OFF").ok().cloned())
        .and_then(|o| match o {
            Object::Array(a) => Some(a),
            Object::Reference(r) => doc
                .get_object(r)
                .ok()
                .and_then(|o| o.as_array().ok().cloned()),
            _ => None,
        })
        .map(|a| {
            a.iter()
                .filter_map(|o| match o {
                    Object::Reference(r) => Some(*r),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default();

    let mut out = Vec::new();
    for ocg_ref in ocgs {
        let id = match ocg_ref {
            Object::Reference(r) => r,
            _ => continue,
        };
        let ocg = match doc.get_object(id).and_then(Object::as_dict) {
            Ok(d) => d,
            Err(_) => continue,
        };
        let name = ocg
            .get(b"Name")
            .ok()
            .and_then(|o| o.as_str().ok())
            .map(|s| String::from_utf8_lossy(s).into_owned())
            .unwrap_or_default();
        out.push(OcgInfo {
            name,
            default_on: !off_set.contains(&id),
        });
    }
    Ok(out)
}

// ───────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────

fn load(path: &str) -> Result<Document> {
    Document::load(path).map_err(|e| AppError::Pdf(format!("verify load {path}: {e}")))
}

fn resolve_dict<'a>(doc: &'a Document, obj: &'a Object) -> Option<&'a lopdf::Dictionary> {
    match obj {
        Object::Dictionary(d) => Some(d),
        Object::Reference(r) => doc.get_object(*r).ok().and_then(|o| o.as_dict().ok()),
        _ => None,
    }
}

fn resolve_dict_obj<'a>(doc: &'a Document, obj: &'a Object) -> Option<&'a lopdf::Dictionary> {
    resolve_dict(doc, obj)
}

fn obj_to_f32(o: &Object) -> f32 {
    match o {
        Object::Real(r) => *r,
        Object::Integer(i) => *i as f32,
        _ => 0.0,
    }
}

// ───────────────────────────────────────────────────────────────────
// Watermark text verification
// ───────────────────────────────────────────────────────────────────
//
// Scans a page's content stream for text-show ops (Tj/TJ/'/") whose
// operand contains the search text. Used by the P1 Watermark test pass
// to confirm that a dialog's Apply actually caused the watermark string
// to land in the page's content stream after save.
//
// Coarse: decodes raw operand bytes as UTF-8 lossy. The Open Satchel
// watermark path writes via pd-lib drawText using standard/Impact
// fonts, which emit Latin-1-compatible bytes, so plain substring
// matching works. Does NOT decode CMap-indexed glyph codes — a PDF
// whose watermark font is fully subsetted would fail; deferred.

#[derive(Debug, Serialize)]
pub struct WatermarkMatch {
    pub page_index: u32,
    pub found: bool,
    pub text_matches: Vec<String>,
}

#[tauri::command]
pub fn pdf_verify_watermark_text(
    path: String,
    page_index: Option<u32>,
    text: String,
) -> Result<Vec<WatermarkMatch>> {
    let doc = load(&path)?;
    let pages = doc.get_pages();
    // Pre-compute the literal and hex representations of the search
    // text. pd-lib may emit either form in a Tj operand depending on
    // the font encoding; for standard Helvetica ("CONFIDENTIAL") the
    // bytes ARE the ASCII codes, so hex-upper ends up as `<434F...>`.
    let literal = text.clone().into_bytes();
    let hex_upper: Vec<u8> = text
        .as_bytes()
        .iter()
        .flat_map(|b| format!("{:02X}", b).into_bytes())
        .collect();
    let hex_lower: Vec<u8> = text
        .as_bytes()
        .iter()
        .flat_map(|b| format!("{:02x}", b).into_bytes())
        .collect();

    let mut out = Vec::new();
    for (p_one_idx, page_id) in pages.iter() {
        let p_idx = p_one_idx - 1;
        if let Some(want) = page_index {
            if p_idx != want {
                continue;
            }
        }
        let bytes = match read_page_content_bytes(&doc, page_id) {
            Some(b) => b,
            None => {
                out.push(WatermarkMatch {
                    page_index: p_idx,
                    found: false,
                    text_matches: Vec::new(),
                });
                continue;
            }
        };
        let mut matches: Vec<String> = Vec::new();
        if byte_contains(&bytes, &literal) {
            matches.push(format!("literal:{text}"));
        }
        if byte_contains(&bytes, &hex_upper) {
            matches.push(format!("hex_upper:{}", String::from_utf8_lossy(&hex_upper)));
        }
        if byte_contains(&bytes, &hex_lower) {
            matches.push(format!("hex_lower:{}", String::from_utf8_lossy(&hex_lower)));
        }
        out.push(WatermarkMatch {
            page_index: p_idx,
            found: !matches.is_empty(),
            text_matches: matches,
        });
    }
    Ok(out)
}

fn byte_contains(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || haystack.len() < needle.len() {
        return false;
    }
    haystack.windows(needle.len()).any(|w| w == needle)
}

// ── PDF text string decode ──────────────────────────────────────────
// PDF text strings (PDF 1.7 §7.9.2) come in two flavors:
//   1. PDFDocEncoding (byte ≈ Latin-1 with a few reassignments). No BOM.
//   2. UTF-16 BE with a `\xFE\xFF` BOM prefix.
// pd-lib uses #2 for /Info and XMP when any non-ASCII is present, and
// also sometimes for plain ASCII (paranoid encoding). Decode both.

fn decode_pdf_text_string(b: &[u8]) -> String {
    if b.len() >= 2 && b[0] == 0xFE && b[1] == 0xFF {
        let tail = &b[2..];
        if tail.len() % 2 == 0 {
            let chars: Vec<u16> = tail
                .chunks_exact(2)
                .map(|c| u16::from_be_bytes([c[0], c[1]]))
                .collect();
            return String::from_utf16_lossy(&chars);
        }
    }
    // UTF-8 LE BOM (rarely used but spec-legal in PDF 2.0 XMP): EF BB BF
    if b.len() >= 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF {
        return String::from_utf8_lossy(&b[3..]).into_owned();
    }
    // Assume PDFDocEncoding ≈ Latin-1 (close enough for ASCII content).
    // Rust's String::from_utf8_lossy does UTF-8 interpretation — for
    // high-bit bytes that's wrong, but for pure ASCII it matches PDFDoc.
    String::from_utf8_lossy(b).into_owned()
}

fn read_page_content_bytes(doc: &Document, page_id: &ObjectId) -> Option<Vec<u8>> {
    let page = doc.get_object(*page_id).and_then(Object::as_dict).ok()?;
    let contents = page.get(b"Contents").ok()?;
    let stream_ids: Vec<ObjectId> = match contents {
        Object::Reference(r) => vec![*r],
        Object::Array(arr) => arr
            .iter()
            .filter_map(|o| match o {
                Object::Reference(r) => Some(*r),
                _ => None,
            })
            .collect(),
        _ => return None,
    };
    let mut out = Vec::new();
    for sid in stream_ids {
        if let Ok(stream) = doc.get_object(sid).and_then(Object::as_stream) {
            let bytes = stream
                .decompressed_content()
                .unwrap_or_else(|_| stream.content.clone());
            out.extend_from_slice(&bytes);
            out.push(b' ');
        }
    }
    Some(out)
}

// ───────────────────────────────────────────────────────────────────
// Page count
// ───────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn pdf_verify_page_count(path: String) -> Result<u32> {
    let doc = load(&path)?;
    Ok(doc.get_pages().len() as u32)
}

// ───────────────────────────────────────────────────────────────────
// Page order — content-stream hashes per page
// ───────────────────────────────────────────────────────────────────
//
// For each page, hash the concatenated decompressed content stream
// bytes. Stable across move/duplicate (the content stream is what
// "this page" really IS), so callers can compare pre/post order to
// confirm Page Manager's reorder, delete, and duplicate worked.

#[derive(Debug, Serialize)]
pub struct PageHash {
    pub page_index: u32,
    pub content_sha256: String,
    pub content_len: u64,
}

#[tauri::command]
pub fn pdf_verify_page_order(path: String) -> Result<Vec<PageHash>> {
    let doc = load(&path)?;
    let pages = doc.get_pages();
    let mut out: Vec<PageHash> = Vec::with_capacity(pages.len());
    for (one_idx, page_id) in pages.iter() {
        let p_idx = one_idx - 1;
        let bytes = read_page_content_bytes(&doc, page_id).unwrap_or_default();
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        let digest = hasher.finalize();
        out.push(PageHash {
            page_index: p_idx,
            content_sha256: hex_lower(&digest),
            content_len: bytes.len() as u64,
        });
    }
    Ok(out)
}

// ───────────────────────────────────────────────────────────────────
// Page labels (/PageLabels number tree)
// ───────────────────────────────────────────────────────────────────
//
// PDF 1.7 §12.4.2: /PageLabels lives in the catalog as a number tree.
// Leaf entries map first-page-of-range → label dict { S, P, St }:
//   S  — numbering style (D, R, r, A, a)
//   P  — prefix string
//   St — start number (default 1)
// We walk the tree depth-first via /Kids and /Nums, returning each
// range's start index + its dict's fields.

#[derive(Debug, Serialize)]
pub struct PageLabelEntry {
    pub start_index: i64,
    pub style: Option<String>,
    pub prefix: Option<String>,
    pub start: Option<i64>,
}

#[tauri::command]
pub fn pdf_verify_page_labels(path: String) -> Result<Vec<PageLabelEntry>> {
    let doc = load(&path)?;
    let catalog = doc.catalog().map_err(|e| AppError::Pdf(e.to_string()))?;
    let labels = match catalog.get(b"PageLabels") {
        Ok(o) => resolve_dict_obj(&doc, o),
        Err(_) => None,
    };
    let labels = match labels {
        Some(d) => d,
        None => return Ok(Vec::new()),
    };
    let mut out: Vec<PageLabelEntry> = Vec::new();
    collect_page_labels(&doc, labels, &mut out);
    Ok(out)
}

// Resolve the per-page display label for every page by applying the
// /PageLabels range entries. Each range entry kicks in at start_index
// and continues until the next range starts (or end-of-doc). Inside a
// range, the page number = (page_index_in_doc - range_start) + St.
//
// Returns one entry per page in document order. Empty-tree PDFs get
// the standard 1-based decimal default ("1", "2", "3", ...).

#[derive(Debug, Serialize)]
pub struct ResolvedLabel {
    pub page_index: u32,
    pub label: String,
}

#[tauri::command]
pub fn pdf_resolve_page_labels(path: String) -> Result<Vec<ResolvedLabel>> {
    let doc = load(&path)?;
    let total = doc.get_pages().len() as u32;
    let entries = pdf_verify_page_labels(path)?;
    // Sort entries by start_index for the range walk.
    let mut ranges = entries;
    ranges.sort_by_key(|e| e.start_index);
    let mut out: Vec<ResolvedLabel> = Vec::with_capacity(total as usize);
    for p in 0..total {
        // Pick the most recent range whose start_index <= p.
        let active = ranges
            .iter()
            .rev()
            .find(|r| r.start_index >= 0 && (r.start_index as u32) <= p);
        let label = match active {
            Some(r) => {
                let st = r.start.unwrap_or(1) as i64;
                let n = (p as i64 - r.start_index) + st;
                let prefix = r.prefix.clone().unwrap_or_default();
                let style = r.style.as_deref().unwrap_or("");
                let body = format_label(n, style);
                format!("{prefix}{body}")
            }
            None => format!("{}", p + 1),
        };
        out.push(ResolvedLabel {
            page_index: p,
            label,
        });
    }
    Ok(out)
}

fn format_label(n: i64, style: &str) -> String {
    if n < 1 {
        return String::new();
    }
    match style {
        "D" => format!("{}", n),
        "R" => to_roman_upper(n as u32),
        "r" => to_roman_lower(n as u32),
        "A" => to_alpha_upper(n as u32),
        "a" => to_alpha_lower(n as u32),
        "" => String::new(), // No style: prefix only (e.g. "Cover")
        _ => format!("{}", n),
    }
}

fn to_roman_upper(mut n: u32) -> String {
    let pairs = [
        (1000, "M"),
        (900, "CM"),
        (500, "D"),
        (400, "CD"),
        (100, "C"),
        (90, "XC"),
        (50, "L"),
        (40, "XL"),
        (10, "X"),
        (9, "IX"),
        (5, "V"),
        (4, "IV"),
        (1, "I"),
    ];
    let mut s = String::new();
    for (v, sym) in pairs {
        while n >= v {
            s.push_str(sym);
            n -= v;
        }
    }
    s
}

fn to_roman_lower(n: u32) -> String {
    to_roman_upper(n).to_lowercase()
}

fn to_alpha_upper(n: u32) -> String {
    // PDF spec: A, B, ..., Z, AA, BB, ..., ZZ, AAA, ...
    if n == 0 {
        return String::new();
    }
    let count = ((n - 1) / 26) + 1;
    let letter = (b'A' + (((n - 1) % 26) as u8)) as char;
    std::iter::repeat(letter).take(count as usize).collect()
}

fn to_alpha_lower(n: u32) -> String {
    to_alpha_upper(n).to_lowercase()
}

fn collect_page_labels(doc: &Document, node: &lopdf::Dictionary, out: &mut Vec<PageLabelEntry>) {
    if let Ok(Object::Array(kids)) = node.get(b"Kids") {
        for kid in kids.clone() {
            if let Some(child) = resolve_dict(doc, &kid) {
                collect_page_labels(doc, child, out);
            }
        }
    }
    if let Ok(Object::Array(nums)) = node.get(b"Nums") {
        let mut i = 0;
        while i + 1 < nums.len() {
            let idx = match &nums[i] {
                Object::Integer(n) => *n,
                _ => -1,
            };
            let label = resolve_dict(doc, &nums[i + 1]);
            let style = label
                .and_then(|d| d.get(b"S").ok())
                .and_then(|o| o.as_name().ok())
                .map(|n| String::from_utf8_lossy(n).into_owned());
            let prefix = label
                .and_then(|d| d.get(b"P").ok())
                .and_then(|o| o.as_str().ok())
                .map(decode_pdf_text_string);
            let start = label
                .and_then(|d| d.get(b"St").ok())
                .and_then(|o| o.as_i64().ok());
            out.push(PageLabelEntry {
                start_index: idx,
                style,
                prefix,
                start,
            });
            i += 2;
        }
    }
}

// ───────────────────────────────────────────────────────────────────
// Initial view (/PageLayout, /PageMode, /OpenAction)
// ───────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct InitialView {
    pub page_layout: Option<String>,
    pub page_mode: Option<String>,
    pub open_action_kind: Option<String>,
    pub open_action_preview: Option<String>,
}

#[tauri::command]
pub fn pdf_verify_initial_view(path: String) -> Result<InitialView> {
    let doc = load(&path)?;
    let catalog = doc.catalog().map_err(|e| AppError::Pdf(e.to_string()))?;
    let page_layout = catalog
        .get(b"PageLayout")
        .ok()
        .and_then(|o| o.as_name().ok())
        .map(|n| String::from_utf8_lossy(n).into_owned());
    let page_mode = catalog
        .get(b"PageMode")
        .ok()
        .and_then(|o| o.as_name().ok())
        .map(|n| String::from_utf8_lossy(n).into_owned());
    // /OpenAction is either a destination (array) or an action dict.
    let (open_action_kind, open_action_preview) = match catalog.get(b"OpenAction") {
        Ok(o) => {
            let resolved = match o {
                Object::Reference(r) => doc.get_object(*r).ok().cloned(),
                other => Some(other.clone()),
            };
            match resolved {
                Some(Object::Array(arr)) => {
                    // /OpenAction = [ pageRef /XYZ x y z ] — inspect the
                    // destination-mode name at index 1 (or index 0 for
                    // some named-dest references). Report the mode name
                    // ("XYZ", "Fit", "FitH", "FitR", etc.) so verifiers
                    // can pin specific positioning rather than just
                    // "this is an array".
                    let mode = arr.iter().find_map(|el| match el {
                        Object::Name(n) => Some(String::from_utf8_lossy(n).into_owned()),
                        _ => None,
                    });
                    (
                        mode.or_else(|| Some("dest_array".to_string())),
                        Some(format!("{:?}", o).chars().take(160).collect()),
                    )
                }
                Some(Object::Dictionary(d)) => {
                    let kind = d
                        .get(b"S")
                        .ok()
                        .and_then(|so| so.as_name().ok())
                        .map(|n| format!("action:{}", String::from_utf8_lossy(n)));
                    (kind, Some(format!("{:?}", d).chars().take(160).collect()))
                }
                _ => (None, None),
            }
        }
        Err(_) => (None, None),
    };
    Ok(InitialView {
        page_layout,
        page_mode,
        open_action_kind,
        open_action_preview,
    })
}

// ───────────────────────────────────────────────────────────────────
// pages_have_text — substring check per page
// ───────────────────────────────────────────────────────────────────
//
// For each (page_index, substring) pair, decompresses the content
// stream and looks for the substring as bytes. Same coarse approach
// as pdf_verify_watermark_text — works for standard-encoded fonts but
// will miss CID-font-encoded text. Used for Page Numbers / Bates bake
// verification, where the bake writes via pd-lib drawText with
// Helvetica.

#[derive(Debug, Serialize)]
pub struct PageTextMatch {
    pub page_index: u32,
    pub substring: String,
    pub found: bool,
}

#[tauri::command]
pub fn pdf_verify_pages_have_text(
    path: String,
    pairs: Vec<(u32, String)>,
) -> Result<Vec<PageTextMatch>> {
    let doc = load(&path)?;
    let pages = doc.get_pages();
    // Resolve pages to a vec of (index, page_id).
    let mut by_idx: std::collections::HashMap<u32, ObjectId> = std::collections::HashMap::new();
    for (one_idx, pid) in pages.iter() {
        by_idx.insert(one_idx - 1, *pid);
    }
    let mut out: Vec<PageTextMatch> = Vec::with_capacity(pairs.len());
    for (idx, sub) in pairs {
        let pid = match by_idx.get(&idx) {
            Some(p) => *p,
            None => {
                out.push(PageTextMatch {
                    page_index: idx,
                    substring: sub,
                    found: false,
                });
                continue;
            }
        };
        let bytes = read_page_content_bytes(&doc, &pid).unwrap_or_default();
        let needle_lit = sub.as_bytes();
        let needle_hex_upper: Vec<u8> = sub
            .as_bytes()
            .iter()
            .flat_map(|b| format!("{:02X}", b).into_bytes())
            .collect();
        let needle_hex_lower: Vec<u8> = sub
            .as_bytes()
            .iter()
            .flat_map(|b| format!("{:02x}", b).into_bytes())
            .collect();
        let found = byte_contains(&bytes, needle_lit)
            || byte_contains(&bytes, &needle_hex_upper)
            || byte_contains(&bytes, &needle_hex_lower);
        out.push(PageTextMatch {
            page_index: idx,
            substring: sub,
            found,
        });
    }
    Ok(out)
}

// ───────────────────────────────────────────────────────────────────
// Forensic full-file grep — for redaction permanence audit
// ───────────────────────────────────────────────────────────────────
//
// Scan the entire saved PDF (every byte, before and after stream
// decompression) for a substring under multiple encodings the original
// text might survive as. Stricter than pdf_verify_pages_have_text —
// that scans only page content streams; this scans raw file bytes
// AND every decompressed Flate/ASCII85 stream so leaked tokens hiding
// in hidden objects (orphaned XObjects, dropped form fields, leftover
// /Metadata, rasterization artifacts) still get caught.
//
// Encoding variants tested:
//   • literal ASCII bytes
//   • UTF-16 BE (PDF text-string canonical) with FE FF BOM
//   • UTF-16 BE without BOM
//   • hex-uppercase (PDFHexString form)
//   • hex-lowercase
//
// "Found in raw bytes" alone is enough to fail; we also report which
// stream id contained the leak (for debugging).
#[derive(Debug, Serialize)]
pub struct GrepHit {
    pub kind: &'static str,
    pub variant: &'static str,
    pub object_id: Option<u32>,
}

#[derive(Debug, Serialize)]
pub struct GrepFullFileResult {
    pub needle: String,
    pub raw_hits: Vec<GrepHit>,
    pub stream_hits: Vec<GrepHit>,
    pub total_streams_scanned: usize,
    pub total_streams_decompressed: usize,
    pub leaked: bool,
}

fn make_variants(needle: &str) -> Vec<(&'static str, Vec<u8>)> {
    let mut out: Vec<(&'static str, Vec<u8>)> = Vec::with_capacity(5);
    out.push(("literal", needle.as_bytes().to_vec()));
    // UTF-16 BE with BOM (pd-lib's canonical text-string form).
    let mut be = vec![0xFEu8, 0xFFu8];
    for c in needle.encode_utf16() {
        be.push((c >> 8) as u8);
        be.push((c & 0xFF) as u8);
    }
    out.push(("utf16be_bom", be));
    // UTF-16 BE without BOM (some emitters omit it).
    let mut be_nobom = Vec::new();
    for c in needle.encode_utf16() {
        be_nobom.push((c >> 8) as u8);
        be_nobom.push((c & 0xFF) as u8);
    }
    out.push(("utf16be_nobom", be_nobom));
    // Hex-encoded literal (PDFHexString).
    out.push((
        "hex_upper",
        needle
            .as_bytes()
            .iter()
            .flat_map(|b| format!("{:02X}", b).into_bytes())
            .collect(),
    ));
    out.push((
        "hex_lower",
        needle
            .as_bytes()
            .iter()
            .flat_map(|b| format!("{:02x}", b).into_bytes())
            .collect(),
    ));
    out
}

#[tauri::command]
pub fn pdf_grep_full_file(path: String, needle: String) -> Result<GrepFullFileResult> {
    let raw = std::fs::read(&path).map_err(|e| AppError::Pdf(format!("read {path}: {e}")))?;
    let variants = make_variants(&needle);

    let mut raw_hits: Vec<GrepHit> = Vec::new();
    for (variant, bytes) in &variants {
        if byte_contains(&raw, bytes) {
            raw_hits.push(GrepHit {
                kind: "raw_file",
                variant,
                object_id: None,
            });
        }
    }

    // Walk every stream object, attempt to decompress, scan again.
    let mut stream_hits: Vec<GrepHit> = Vec::new();
    let mut total_streams = 0usize;
    let mut total_decompressed = 0usize;
    if let Ok(doc) = lopdf::Document::load_mem(&raw) {
        for (id, obj) in doc.objects.iter() {
            let stream = match obj {
                Object::Stream(s) => s,
                _ => continue,
            };
            total_streams += 1;
            // Try decompressed bytes first; fall back to raw stream
            // bytes if decompression fails.
            let decoded = stream.decompressed_content().ok();
            if decoded.is_some() {
                total_decompressed += 1;
            }
            let scan_targets: Vec<&Vec<u8>> = match decoded.as_ref() {
                Some(d) => vec![d, &stream.content],
                None => vec![&stream.content],
            };
            for buf in scan_targets {
                for (variant, bytes) in &variants {
                    if byte_contains(buf, bytes) {
                        stream_hits.push(GrepHit {
                            kind: "stream",
                            variant,
                            object_id: Some(id.0 as u32),
                        });
                    }
                }
            }
        }
    }

    let leaked = !raw_hits.is_empty() || !stream_hits.is_empty();
    Ok(GrepFullFileResult {
        needle,
        raw_hits,
        stream_hits,
        total_streams_scanned: total_streams,
        total_streams_decompressed: total_decompressed,
        leaked,
    })
}

// ───────────────────────────────────────────────────────────────────
// Standalone PNG render (pdfium → file on disk)
// ───────────────────────────────────────────────────────────────────
//
// Wraps pdf_engine::render_page_to_png and writes the bytes out to
// `out_path`. Distinct from the in-app pdfjs screenshot — this lets
// tests visually diff a saved PDF without reopening it in the editor
// (so no risk of in-flight UI state contaminating the snapshot). DPI
// is converted to pdfium's `scale` arg as `dpi / 72.0`.

#[derive(Debug, Serialize)]
pub struct RenderResult {
    pub out_path: String,
    pub bytes_written: u64,
    pub scale: f32,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn pdf_render_page_png(
    path: String,
    page_index: u16,
    dpi: Option<f32>,
    out_path: String,
) -> Result<RenderResult> {
    let scale = dpi.unwrap_or(150.0) / 72.0;
    crate::pdf_engine::render_thread::submit(move || {
        let png = render_page_to_png(&path, page_index, scale)
            .map_err(|e| AppError::Pdf(format!("render: {e}")))?;
        let bytes_written = png.len() as u64;
        std::fs::write(&out_path, &png)
            .map_err(|e| AppError::Pdf(format!("write {out_path}: {e}")))?;
        Ok(RenderResult {
            out_path,
            bytes_written,
            scale,
        })
    })
    .await
}

// ───────────────────────────────────────────────────────────────────
// XObject hash dump + replacement check
// ───────────────────────────────────────────────────────────────────
//
// Walk every page's resources for image XObjects, hash each stream's
// decompressed bytes (SHA-256), and report whether the original/new
// hashes are present. For the Replace-Image flow, the test:
//   1. pre-replacement: hash the JPEG it picked (computed externally)
//   2. pre-replacement: pdf_verify_xobject_replaced(path, original=<old hash>, new=<external pre-pick hash>)
//      — original_present should be TRUE, new_present FALSE
//   3. (run the replace flow)
//   4. post-save: same call → original_present FALSE, new_present TRUE

#[derive(Debug, Serialize)]
pub struct XObjectHash {
    pub page_index: u32,
    pub xobject_name: String,
    pub sha256: String,
    pub byte_len: u64,
    pub subtype: Option<String>,
    pub filter: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct XObjectReplaceResult {
    pub all: Vec<XObjectHash>,
    pub original_present: bool,
    pub new_present: bool,
}

#[tauri::command(rename_all = "snake_case")]
pub fn pdf_verify_xobject_replaced(
    path: String,
    original_hash: Option<String>,
    new_hash: Option<String>,
) -> Result<XObjectReplaceResult> {
    let doc = load(&path)?;
    let pages = doc.get_pages();
    let mut all: Vec<XObjectHash> = Vec::new();
    let mut seen_streams: std::collections::HashSet<ObjectId> = std::collections::HashSet::new();
    for (one_idx, page_id) in pages.iter() {
        let p_idx = one_idx - 1;
        let page = match doc.get_object(*page_id).and_then(Object::as_dict) {
            Ok(d) => d,
            Err(_) => continue,
        };
        let resources = page
            .get(b"Resources")
            .ok()
            .and_then(|o| resolve_dict_obj(&doc, o));
        let xobject = match resources.and_then(|r| r.get(b"XObject").ok()) {
            Some(o) => resolve_dict_obj(&doc, o),
            None => None,
        };
        let xobject = match xobject {
            Some(x) => x,
            None => continue,
        };
        for (name, val) in xobject.iter() {
            // Track each unique stream object id once. Many XObjects
            // are shared across pages — without dedup the same image
            // reports per page.
            let (sid, stream) = match val {
                Object::Reference(r) => {
                    if !seen_streams.insert(*r) {
                        continue;
                    }
                    let s = doc
                        .get_object(*r)
                        .ok()
                        .and_then(|o| o.as_stream().ok())
                        .cloned();
                    (Some(*r), s)
                }
                Object::Stream(s) => (None, Some(s.clone())),
                _ => (None, None),
            };
            let _ = sid;
            let stream = match stream {
                Some(s) => s,
                None => continue,
            };
            let subtype = stream
                .dict
                .get(b"Subtype")
                .ok()
                .and_then(|o| o.as_name().ok())
                .map(|n| String::from_utf8_lossy(n).into_owned());
            let filter = stream.dict.get(b"Filter").ok().and_then(|o| match o {
                Object::Name(n) => Some(String::from_utf8_lossy(n).into_owned()),
                Object::Array(a) => a
                    .first()
                    .and_then(|f| f.as_name().ok())
                    .map(|n| String::from_utf8_lossy(n).into_owned()),
                _ => None,
            });
            // Hash the raw stream bytes (pre-decompression) — that is
            // what the user picked from disk for replace-image: the
            // engine writes those bytes into the XObject's /Filter
            // FlateDecode/DCTDecode body verbatim. Decompression would
            // diverge for DCT (JPEG) since we'd be hashing raw image
            // pixels not file bytes.
            let mut hasher = Sha256::new();
            hasher.update(&stream.content);
            let digest = hasher.finalize();
            all.push(XObjectHash {
                page_index: p_idx,
                xobject_name: String::from_utf8_lossy(name).into_owned(),
                sha256: hex_lower(&digest),
                byte_len: stream.content.len() as u64,
                subtype,
                filter,
            });
        }
    }
    let needle_lower = |s: &Option<String>| s.as_ref().map(|x| x.to_lowercase());
    let orig = needle_lower(&original_hash);
    let new_ = needle_lower(&new_hash);
    let original_present = orig
        .as_ref()
        .map(|h| all.iter().any(|x| x.sha256 == *h))
        .unwrap_or(false);
    let new_present = new_
        .as_ref()
        .map(|h| all.iter().any(|x| x.sha256 == *h))
        .unwrap_or(false);
    Ok(XObjectReplaceResult {
        all,
        original_present,
        new_present,
    })
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

// ── G5: marker-based watermark strip tests ─────────────────────────

#[cfg(test)]
mod g5_marker_strip_tests {
    use super::strip_watermark_marker_ranges;

    #[test]
    fn bmc_form_strips_full_range() {
        // pd-lib's beginMarkedContent('Watermark') emits `/Watermark BMC`
        // before the BT/ET block, then EMC after. The whole span goes.
        let stream =
            b"q\n/Watermark BMC\nBT\n/F1 24 Tf\n100 200 Td\n(CONFIDENTIAL) Tj\nET\nEMC\nQ\n";
        let (out, removed) = strip_watermark_marker_ranges(stream);
        let s = std::str::from_utf8(&out).expect("ascii");
        assert_eq!(removed, 1, "exactly one marker block removed");
        assert!(
            !s.contains("CONFIDENTIAL"),
            "watermark text still present: {s}"
        );
        assert!(!s.contains("BMC"), "BMC opener still present: {s}");
        assert!(!s.contains("EMC"), "EMC closer still present: {s}");
        assert!(s.contains("q\n"), "outer save state preserved");
        assert!(s.contains("Q\n"), "outer restore state preserved");
    }

    #[test]
    fn bdc_form_with_props_dict_strips_full_range() {
        // BDC takes a properties dictionary. /Watermark <</A 1>> BDC ... EMC
        let stream =
            b"BT\nbody\nET\n/Watermark <</Type /Pagination>> BDC\nBT\n(WM) Tj\nET\nEMC\ntrailer\n";
        let (out, removed) = strip_watermark_marker_ranges(stream);
        let s = std::str::from_utf8(&out).expect("ascii");
        assert_eq!(removed, 1);
        assert!(!s.contains("WM"));
        assert!(!s.contains("BDC"));
        assert!(s.contains("body"), "non-watermark body kept: {s}");
        assert!(s.contains("trailer"), "trailing content kept: {s}");
    }

    #[test]
    fn nested_bmc_inside_watermark_only_pops_at_outer_emc() {
        // PDF spec allows nested marked content. Stripping must walk
        // the full tree until depth returns to 0.
        let stream = b"/Watermark BMC\nq\n/Span BMC\n(nested) Tj\nEMC\n(outer wm) Tj\nEMC\nQ\n";
        let (out, removed) = strip_watermark_marker_ranges(stream);
        let s = std::str::from_utf8(&out).expect("ascii");
        assert_eq!(removed, 1);
        assert!(
            !s.contains("nested"),
            "nested span content should also go: {s}"
        );
        assert!(
            !s.contains("outer wm"),
            "outer watermark content should go: {s}"
        );
    }

    #[test]
    fn does_not_strip_unrelated_p_or_artifact_marked_content() {
        // /P BDC ... EMC and /Artifact BDC ... EMC are accessibility
        // tagging — leave them alone.
        let stream = b"/P <</MCID 0>> BDC\nBT\n(real body text) Tj\nET\nEMC\n";
        let (out, removed) = strip_watermark_marker_ranges(stream);
        assert_eq!(removed, 0, "non-watermark MC must stay");
        assert_eq!(out.as_slice(), stream as &[u8], "stream unchanged");
    }

    #[test]
    fn body_text_matching_the_watermark_string_is_preserved() {
        // The hallmark of the marker pass: body text containing the
        // watermark string is left alone because no /Watermark marker
        // wraps it.
        let stream = b"BT\n(CONFIDENTIAL: see below) Tj\nET\n";
        let (out, removed) = strip_watermark_marker_ranges(stream);
        assert_eq!(removed, 0);
        assert_eq!(out.as_slice(), stream as &[u8]);
    }

    #[test]
    fn multiple_watermark_markers_on_one_page_all_strip() {
        let stream = b"/Watermark BMC\n(A) Tj\nEMC\nbody\n/Watermark BMC\n(B) Tj\nEMC\n";
        let (out, removed) = strip_watermark_marker_ranges(stream);
        let s = std::str::from_utf8(&out).expect("ascii");
        assert_eq!(removed, 2);
        assert!(!s.contains("(A)"));
        assert!(!s.contains("(B)"));
        assert!(s.contains("body"));
    }

    #[test]
    fn malformed_unmatched_marker_falls_through_safely() {
        // /Watermark BMC with no EMC — the function should fail
        // gracefully and copy the bytes through unchanged rather
        // than entering an infinite loop or panicking.
        let stream = b"/Watermark BMC\n(orphan) Tj\n(no emc here)";
        let (out, removed) = strip_watermark_marker_ranges(stream);
        // Either stripped to EOF or left untouched — both are safe
        // outcomes; we just need to confirm no panic and that the
        // function terminates.
        let _ = out;
        let _ = removed;
    }
}

// ── G4 AES-256 R=5/R=6 detection tests ─────────────────────────

#[cfg(test)]
mod g4_high_rev_detect_tests {
    use super::detect_aes256_high_rev;

    fn pdf_with_encrypt_dict(v: &str, r: &str) -> Vec<u8> {
        let mut bytes = Vec::new();
        // Pad with junk so the trailer scan has to actually find the dict.
        bytes.extend_from_slice(b"%PDF-1.7\n");
        bytes.extend_from_slice(&[0u8; 1024]);
        bytes.extend_from_slice(format!(
            "trailer\n<<\n  /Encrypt <<\n    /Filter /Standard\n    /V {v}\n    /R {r}\n    /Length 256\n  >>\n  /Size 10\n>>\nstartxref\n0\n%%EOF",
        ).as_bytes());
        bytes
    }

    #[test]
    fn detects_aes256_r5_signature() {
        let bytes = pdf_with_encrypt_dict("5", "5");
        assert_eq!(detect_aes256_high_rev(&bytes), Some(5));
    }

    #[test]
    fn detects_aes256_r6_signature() {
        let bytes = pdf_with_encrypt_dict("5", "6");
        assert_eq!(detect_aes256_high_rev(&bytes), Some(6));
    }

    #[test]
    fn does_not_detect_v4_r4_pdfs() {
        // V=4 R=4 = AES-128, lopdf 0.32 supports it. Must NOT hit the
        // gate; should return None so the existing decrypt path runs.
        let bytes = pdf_with_encrypt_dict("4", "4");
        assert_eq!(detect_aes256_high_rev(&bytes), None);
    }

    #[test]
    fn does_not_detect_rc4_v2_r3() {
        let bytes = pdf_with_encrypt_dict("2", "3");
        assert_eq!(detect_aes256_high_rev(&bytes), None);
    }

    #[test]
    fn does_not_detect_unencrypted_pdf() {
        // Plain PDF without /Encrypt dict.
        let bytes = b"%PDF-1.7\nbody\ntrailer\n<<\n  /Size 10\n>>\nstartxref\n0\n%%EOF".to_vec();
        assert_eq!(detect_aes256_high_rev(&bytes), None);
    }

    #[test]
    fn handles_compact_dict_form() {
        // No spaces: /V/5 /R/6 — XML-style key concatenation.
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"%PDF-1.7\n");
        bytes.extend_from_slice(&[0u8; 1024]);
        bytes.extend_from_slice(b"<</Filter/Standard/V/5/R/6/Length 256>>\nstartxref\n0\n%%EOF");
        // Note: the compact form `/V/5` matches the `/V/5` branch.
        assert_eq!(detect_aes256_high_rev(&bytes), Some(6));
    }

    #[test]
    fn requires_v5_not_just_r5() {
        // A V=4 fixture that happens to contain "/R 5" in some other
        // dict (e.g. an /OutputIntent revision). Without /V 5 the
        // detector must return None to avoid false positives.
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"%PDF-1.7\n");
        bytes.extend_from_slice(&[0u8; 1024]);
        bytes.extend_from_slice(
            b"<</Filter/Standard/V 4/R 4>>\n%% other obj: /R 5 /Subtype /Foo\nstartxref\n0\n%%EOF",
        );
        assert_eq!(detect_aes256_high_rev(&bytes), None);
    }
}
