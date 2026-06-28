//! PDF structural verification commands. Used by the ribbon-test MCP
//! driver to assert what saves actually wrote — annotations, form
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

#[derive(Debug, serde::Serialize)]
pub struct RedactionOverlapProbe {
    pub page_index: u16,
    pub text: bool,
    pub non_text: bool,
    pub object_types: Vec<String>,
}

/// Outcome of a destructive text strip. The counts let the caller
/// detect the SILENT NO-OP case (Session-1 verifier finding): a strip
/// that "succeeds" but removes zero objects for a REGION leaves that
/// region's original text recoverable under the overlay — the caller
/// must record that as a security degradation, not success.
/// `removed_per_bbox` is aligned with the request's bbox order
/// (per-REGION, so one region stripping fine cannot mask a sibling
/// region on the same page stripping nothing); `removed_by_page` is
/// the per-page aggregate kept for logging.
#[derive(Debug, serde::Serialize)]
pub struct StripTextOutcome {
    pub bytes: Vec<u8>,
    /// Aligned with the request bbox order. An object overlapping two
    /// regions counts toward both.
    pub removed_per_bbox: Vec<usize>,
    /// page_index → count of text objects actually removed.
    pub removed_by_page: std::collections::HashMap<u16, usize>,
    pub removed_total: usize,
}

/// Counts-only variant for the path route (bytes go to disk).
#[derive(Debug, serde::Serialize)]
pub struct StripPathOutcome {
    pub removed_per_bbox: Vec<usize>,
    pub removed_by_page: std::collections::HashMap<u16, usize>,
    pub removed_total: usize,
}

fn aggregate_removed_by_page(
    pages_of: &[u16],
    removed_per_bbox: &[usize],
) -> std::collections::HashMap<u16, usize> {
    let mut by_page: std::collections::HashMap<u16, usize> = std::collections::HashMap::new();
    for (i, page) in pages_of.iter().enumerate() {
        *by_page.entry(*page).or_insert(0) += removed_per_bbox.get(i).copied().unwrap_or(0);
    }
    by_page
}

#[tauri::command(rename_all = "snake_case")]
pub async fn pdf_strip_text_in_bboxes(
    bytes: Vec<u8>,
    bboxes: Vec<StripBbox>,
) -> Result<StripTextOutcome> {
    let pages_of: Vec<u16> = bboxes.iter().map(|b| b.page_index).collect();
    let (out, removed_per_bbox) =
        crate::pdf_engine::render_thread::submit(move || strip_text_impl(bytes, bboxes)).await?;
    let removed_by_page = aggregate_removed_by_page(&pages_of, &removed_per_bbox);
    // NOTE: removed_total can exceed the count of distinct objects
    // removed when one object overlaps multiple regions — it is a
    // per-region attribution sum, not a distinct-object count.
    let removed_total = removed_per_bbox.iter().sum();
    Ok(StripTextOutcome {
        bytes: out,
        removed_per_bbox,
        removed_by_page,
        removed_total,
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn pdf_probe_redaction_overlaps(
    bytes: Vec<u8>,
    bboxes: Vec<StripBbox>,
) -> Result<Vec<RedactionOverlapProbe>> {
    crate::pdf_engine::render_thread::submit(move || probe_redaction_overlaps_impl(bytes, bboxes))
        .await
}

/// One region to fill-probe, expressed as a NORMALIZED fraction [0,1] of the
/// RENDERED page with a TOP-LEFT origin (matches the rendered bitmap's pixel
/// frame, so no page→device mapping is needed). The verifier derives it from
/// a frame the burn does NOT own (CropBox geometry / the user's display mark),
/// which is the whole point of the GATE-2 independent positive control.
#[derive(Debug, serde::Deserialize, Clone)]
pub struct NormRegion {
    pub page_index: u16,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Debug, serde::Serialize)]
pub struct RegionFillProbe {
    pub page_index: u16,
    /// fraction of sampled pixels within `tolerance` of the fill color.
    pub fill_fraction: f32,
    pub sampled: u32,
    /// first sampled pixel that was NOT the fill color (rgb), if any.
    pub bad_pixel: Option<[u8; 3]>,
    /// the source page carried a /Rotate — the caller decides how to treat it.
    pub rotated: bool,
}

fn probe_region_fill_impl(
    bytes: Vec<u8>,
    regions: Vec<NormRegion>,
    fill: [u8; 3],
    tolerance: u8,
) -> Result<Vec<RegionFillProbe>> {
    use pdfium_render::prelude::*;

    if regions.is_empty() {
        return Ok(Vec::new());
    }

    let mut by_page: std::collections::HashMap<u16, Vec<(usize, NormRegion)>> =
        std::collections::HashMap::new();
    for (i, r) in regions.into_iter().enumerate() {
        by_page.entry(r.page_index).or_default().push((i, r));
    }

    crate::pdf_engine::render::with_pdfium_pub(move |pdfium| {
        let document = pdfium
            .load_pdf_from_byte_vec(bytes, None)
            .map_err(|e| AppError::Pdf(format!("region-fill: load: {e}")))?;
        let pages = document.pages();
        let scale = 2.0_f32;
        let tol = tolerance as i32;
        let mut results: Vec<(usize, RegionFillProbe)> = Vec::new();

        for (page_idx, regs) in by_page.iter() {
            let page = pages
                .get(*page_idx)
                .map_err(|e| AppError::Pdf(format!("region-fill: page {page_idx}: {e}")))?;
            let rotated = !matches!(
                page.rotation().unwrap_or(PdfPageRenderRotation::None),
                PdfPageRenderRotation::None
            );
            // scale_page_by_factor renders the page at its NATURAL display
            // size × factor, so pdfium applies /Rotate and the bitmap is the
            // visible (display) page in correct orientation for any rotation.
            // The caller's region is a normalized fraction of that visible
            // page, so no rotated-dimension bookkeeping is needed here.
            let cfg = PdfRenderConfig::new()
                .scale_page_by_factor(scale)
                .render_form_data(true);
            let bitmap = page
                .render_with_config(&cfg)
                .map_err(|e| AppError::Pdf(format!("region-fill: render page {page_idx}: {e}")))?;
            let img = bitmap.as_image().to_rgba8();
            let bw = img.width() as f32;
            let bh = img.height() as f32;

            for (i, r) in regs {
                // Region → pixel box (top-left), inset 5% to dodge edge
                // anti-aliasing (the burn over-paints +1px beyond the rect so
                // the interior is solid fill; a DISPLACED burn leaves the whole
                // rect un-filled, which the fraction catches regardless).
                let rx = (r.x * bw).clamp(0.0, bw);
                let ry = (r.y * bh).clamp(0.0, bh);
                let rw = (r.width * bw).max(0.0);
                let rh = (r.height * bh).max(0.0);
                let x0 = (rx + rw * 0.05).floor().max(0.0) as u32;
                let y0 = (ry + rh * 0.05).floor().max(0.0) as u32;
                let x1 = (((rx + rw - rw * 0.05).ceil() as i64).min(img.width() as i64)).max(0) as u32;
                let y1 = (((ry + rh - rh * 0.05).ceil() as i64).min(img.height() as i64)).max(0) as u32;

                let mut sampled: u32 = 0;
                let mut good: u32 = 0;
                let mut bad_pixel: Option<[u8; 3]> = None;
                if x1 > x0 && y1 > y0 {
                    let stepx = (((x1 - x0) / 50).max(1)) as u32;
                    let stepy = (((y1 - y0) / 50).max(1)) as u32;
                    let mut yy = y0;
                    while yy < y1 {
                        let mut xx = x0;
                        while xx < x1 {
                            let p = img.get_pixel(xx, yy);
                            sampled += 1;
                            if (p[0] as i32 - fill[0] as i32).abs() <= tol
                                && (p[1] as i32 - fill[1] as i32).abs() <= tol
                                && (p[2] as i32 - fill[2] as i32).abs() <= tol
                            {
                                good += 1;
                            } else if bad_pixel.is_none() {
                                bad_pixel = Some([p[0], p[1], p[2]]);
                            }
                            xx += stepx;
                        }
                        yy += stepy;
                    }
                }
                let fill_fraction = if sampled > 0 {
                    good as f32 / sampled as f32
                } else {
                    0.0
                };
                results.push((
                    *i,
                    RegionFillProbe {
                        page_index: *page_idx,
                        fill_fraction,
                        sampled,
                        bad_pixel,
                        rotated,
                    },
                ));
            }
        }

        results.sort_by_key(|(i, _)| *i);
        Ok(results.into_iter().map(|(_, p)| p).collect())
    })
}

/// GATE-2 independent positive control: render the OUTPUT page with pdfium (a
/// DIFFERENT engine + coordinate frame than the pdfjs burn) and report, per
/// region, what fraction of pixels are the fill color. The verifier asserts a
/// rasterized region is (near-)uniformly fill; a displaced burn that the
/// pdfjs-frame layers certify clean shows non-fill here, so the false-cert is
/// caught by a witness the burn does not own.
#[tauri::command(rename_all = "snake_case")]
pub async fn pdf_probe_region_fill(
    bytes: Vec<u8>,
    regions: Vec<NormRegion>,
    fill: [u8; 3],
    tolerance: Option<u8>,
) -> Result<Vec<RegionFillProbe>> {
    let tol = tolerance.unwrap_or(28);
    crate::pdf_engine::render_thread::submit(move || {
        probe_region_fill_impl(bytes, regions, fill, tol)
    })
    .await
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
) -> Result<StripPathOutcome> {
    // Was `Result<()>` — returning counts is additive for callers that
    // ignored the void response; new callers use them for the silent
    // no-op-strip security record.
    let pages_of: Vec<u16> = bboxes.iter().map(|b| b.page_index).collect();
    let removed_per_bbox = crate::pdf_engine::render_thread::submit(move || {
        let bytes = std::fs::read(&input_path)
            .map_err(|e| AppError::Pdf(format!("strip-text-to-path: read {input_path}: {e}")))?;
        let (out, removed) = strip_text_impl(bytes, bboxes)?;
        std::fs::write(&output_path, &out)
            .map_err(|e| AppError::Pdf(format!("strip-text-to-path: write {output_path}: {e}")))?;
        Ok(removed)
    })
    .await?;
    let removed_by_page = aggregate_removed_by_page(&pages_of, &removed_per_bbox);
    let removed_total = removed_per_bbox.iter().sum();
    Ok(StripPathOutcome {
        removed_per_bbox,
        removed_by_page,
        removed_total,
    })
}

/// Returns `(bytes, removed_per_bbox)` where `removed_per_bbox` is
/// aligned with the INPUT bbox order and counts the text objects
/// removed that overlapped each region. Per-REGION counts (verifier
/// gate-3 finding): per-page totals masked the case where one region
/// on a multi-edit page stripped fine while another stripped nothing
/// — the zero-removal region's original text stayed recoverable with
/// no signal. An object overlapping two regions counts toward both.
///
/// TODO(1.1 — pdfium STRATEGY): replace this pdfium-backed strip with
/// a pure-Rust implementation. 1.0 ships the lean V8-free pdfium
/// build; 1.1 drops the native dependency from the redaction path
/// entirely. The seam is exactly this function: keep the signature
/// `(bytes, bboxes) -> (bytes, removed_per_bbox)` and reimplement on
/// lopdf + the `pdf_engine::text_rewrite` operand machinery (drop
/// Tj/TJ/'/" runs whose device-space quads intersect a bbox; split
/// runs on partial overlap; preserve the CSS→PDF coord flip and
/// per-region attribution above). The downstream permanence verifier
/// (`permanence_check_impl` + the TS layers) is implementation-
/// agnostic and stays as the safety net. Acceptance is pinned by the
/// ignored test `pure_rust_strip_acceptance_pin` — un-ignore it when
/// this function no longer references `pdfium_render`; it must then
/// pass with the pdfium DLL ABSENT.
fn strip_text_impl(bytes: Vec<u8>, bboxes: Vec<StripBbox>) -> Result<(Vec<u8>, Vec<usize>)> {
    use pdfium_render::prelude::*;

    if bboxes.is_empty() {
        return Ok((bytes, Vec::new()));
    }

    // Group bboxes by page (each page loaded + mutated once), keeping
    // each bbox's index in the ORIGINAL request order for attribution.
    let bbox_count = bboxes.len();
    let mut by_page: std::collections::HashMap<u16, Vec<(usize, StripBbox)>> =
        std::collections::HashMap::new();
    for (orig_idx, b) in bboxes.into_iter().enumerate() {
        by_page.entry(b.page_index).or_default().push((orig_idx, b));
    }

    crate::pdf_engine::render::with_pdfium_pub(move |pdfium| {
        let document = pdfium
            .load_pdf_from_byte_vec(bytes, None)
            .map_err(|e| AppError::Pdf(format!("strip-text: load: {e}")))?;
        let pages = document.pages();
        let mut removed_per_bbox: Vec<usize> = vec![0; bbox_count];
        for (page_idx, page_bboxes) in by_page.iter() {
            let mut page = pages
                .get(*page_idx)
                .map_err(|e| AppError::Pdf(format!("strip-text: page {page_idx}: {e}")))?;
            // Flip CSS-space bboxes to PDF-space using the page's height.
            let page_height = page.height().value;
            let normalized: Vec<(usize, StripBbox)> = page_bboxes
                .iter()
                .map(|(orig_idx, b)| {
                    if b.coord_space.as_deref() == Some("css") {
                        let mut nb = b.clone();
                        // CSS y grows down from top; PDF y grows up
                        // from bottom. Flip the box's bottom edge.
                        nb.y = page_height - (b.y + b.height);
                        nb.coord_space = Some("pdf".into());
                        (*orig_idx, nb)
                    } else {
                        (*orig_idx, b.clone())
                    }
                })
                .collect();
            let plain: Vec<StripBbox> = normalized.iter().map(|(_, b)| b.clone()).collect();
            // AUTOMATIC so pdfium re-emits the content stream after
            // we drop text objects.
            page.set_content_regeneration_strategy(
                PdfPageContentRegenerationStrategy::AutomaticOnEveryChange,
            );

            // Collect text objects whose bounds overlap any of the
            // page's bboxes, keeping the bounds for per-region
            // attribution after removal succeeds.
            let mut to_remove: Vec<(PdfPageObjectIndex, PdfQuadPoints)> = Vec::new();
            {
                let objects = page.objects();
                for idx in 0..objects.len() {
                    let Ok(obj) = objects.get(idx) else { continue };
                    if obj.object_type() != PdfPageObjectType::Text {
                        continue;
                    }
                    let Ok(bounds) = obj.bounds() else { continue };
                    if bounds_overlaps_any(&bounds, &plain) {
                        to_remove.push((idx, bounds));
                    }
                }
            }
            if to_remove.is_empty() {
                continue;
            }
            // Remove in reverse index order.
            let objects_mut = page.objects_mut();
            for (idx, bounds) in to_remove.iter().rev() {
                if let Ok(removed) = objects_mut.remove_object_at_index(*idx) {
                    // pdfium's FPDFPage_RemoveObject already destroyed
                    // the underlying memory — forget the wrapper to
                    // avoid double-free in Drop. Same pattern as
                    // render::remove_text_objects_in_regions.
                    std::mem::forget(removed);
                    // Attribute to every region this object overlapped.
                    for (orig_idx, nb) in &normalized {
                        if bounds_overlaps_any(bounds, std::slice::from_ref(nb)) {
                            removed_per_bbox[*orig_idx] += 1;
                        }
                    }
                }
            }
        }
        let mut out: Vec<u8> = Vec::new();
        document
            .save_to_writer(&mut out)
            .map_err(|e| AppError::Pdf(format!("strip-text: save: {e}")))?;
        Ok((out, removed_per_bbox))
    })
}

fn probe_redaction_overlaps_impl(
    bytes: Vec<u8>,
    bboxes: Vec<StripBbox>,
) -> Result<Vec<RedactionOverlapProbe>> {
    use pdfium_render::prelude::*;

    if bboxes.is_empty() {
        return Ok(Vec::new());
    }

    let mut by_page: std::collections::HashMap<u16, Vec<StripBbox>> =
        std::collections::HashMap::new();
    for b in bboxes {
        by_page.entry(b.page_index).or_default().push(b);
    }

    crate::pdf_engine::render::with_pdfium_pub(move |pdfium| {
        let document = pdfium
            .load_pdf_from_byte_vec(bytes, None)
            .map_err(|e| AppError::Pdf(format!("redaction-probe: load: {e}")))?;
        let pages = document.pages();
        let mut out: Vec<RedactionOverlapProbe> = Vec::new();

        for (page_idx, page_bboxes) in by_page.iter() {
            let page = pages
                .get(*page_idx)
                .map_err(|e| AppError::Pdf(format!("redaction-probe: page {page_idx}: {e}")))?;
            let page_height = page.height().value;
            let normalized: Vec<StripBbox> = page_bboxes
                .iter()
                .map(|b| {
                    if b.coord_space.as_deref() == Some("css") {
                        let mut nb = b.clone();
                        nb.y = page_height - (b.y + b.height);
                        nb.coord_space = Some("pdf".into());
                        nb
                    } else {
                        b.clone()
                    }
                })
                .collect();

            let mut probe = RedactionOverlapProbe {
                page_index: *page_idx,
                text: false,
                non_text: false,
                object_types: Vec::new(),
            };
            let objects = page.objects();
            for idx in 0..objects.len() {
                let Ok(obj) = objects.get(idx) else { continue };
                let Ok(bounds) = obj.bounds() else { continue };
                if !bounds_overlaps_any(&bounds, &normalized) {
                    continue;
                }
                let kind = obj.object_type();
                let kind_name = format!("{kind:?}");
                if !probe.object_types.iter().any(|s| s == &kind_name) {
                    probe.object_types.push(kind_name);
                }
                if kind == PdfPageObjectType::Text {
                    probe.text = true;
                } else {
                    probe.non_text = true;
                }
            }
            out.push(probe);
        }

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
// Glyph-procedure detector (cidredact §9a — fail-closed raster routing)
// ───────────────────────────────────────────────────────────────────
//
// The redaction permanence verdict (pdfjs decoded layers + the pdfium
// geometry witness) shares one blind spot: a glyph drawn NOT as
// extractable text but as a Type3 glyph-procedure, a Form XObject, or an
// image mask. pdfjs harvests no Unicode for it (custom /Differences names,
// no /ToUnicode) and pdfium may classify it as a non-text object, so
// NEITHER the text/geometry witnesses fire — the secret is visually
// readable yet evades the harvest AND the strip. This detector runs at
// APPLY time over the pages that carry a redaction rect and flags any that
// reference one of those constructs, so the caller can route the page to
// the proven raster/flatten path (the same engine Legal Guarantee uses)
// BEFORE the witnesses run, instead of relying on a witness that is blind
// to the construct.
//
// Deliberately CONSERVATIVE and PAGE-level: full content-stream parsing
// with CTM tracking (to region-scope the construct under the exact rect)
// is multi-day work; a false positive here only means "this page
// rasterizes," which is the SAFE direction (the page already carries a
// redaction). Pure lopdf — no pdfium — so it cannot itself be defeated by
// a pdfium classification gap. A parse failure on the caller side fails
// closed (rasterize every redacted page); a parse failure here returns no
// flags only because load already succeeded for the verdict layers.

#[derive(Debug, Default)]
struct GlyphFlags {
    type3: bool,
    image_mask: bool,
    form_glyph: bool,
    constructs: Vec<String>,
}

impl GlyphFlags {
    fn any(&self) -> bool {
        self.type3 || self.image_mask || self.form_glyph
    }
    fn note(&mut self, s: String) {
        if !self.constructs.contains(&s) {
            self.constructs.push(s);
        }
    }
}

#[derive(Debug, serde::Serialize)]
pub struct GlyphProcedureProbe {
    pub page_index: u16,
    /// the page (or a Form XObject it draws) uses a Type3 font.
    pub type3: bool,
    /// the page paints an image mask (XObject stencil or inline image mask).
    pub image_mask: bool,
    /// a Form XObject the page draws itself bears a Type3 font or image mask.
    pub form_glyph: bool,
    /// human-readable list of the constructs found (for the fidelity record).
    pub constructs: Vec<String>,
}

/// Resolve a page's effective /Resources dictionary, honoring inheritance
/// up the /Parent chain (a page may omit /Resources and inherit it from a
/// /Pages node). Depth-bounded against malformed cyclic parents.
fn resolve_page_resources<'a>(doc: &'a Document, page_id: ObjectId) -> Option<&'a lopdf::Dictionary> {
    let mut cur = page_id;
    for _ in 0..32 {
        let dict = doc.get_object(cur).ok().and_then(|o| o.as_dict().ok())?;
        if let Ok(res) = dict.get(b"Resources") {
            if let Some(rd) = resolve_dict(doc, res) {
                return Some(rd);
            }
        }
        match dict.get(b"Parent") {
            Ok(Object::Reference(r)) => cur = *r,
            _ => break,
        }
    }
    None
}

/// Resolve any object (incl. a Stream, whose dict `as_dict` does not return)
/// to its dictionary.
fn obj_to_dict<'a>(doc: &'a Document, obj: &'a Object) -> Option<&'a lopdf::Dictionary> {
    match obj {
        Object::Dictionary(d) => Some(d),
        Object::Stream(s) => Some(&s.dict),
        Object::Reference(r) => match doc.get_object(*r) {
            Ok(Object::Dictionary(d)) => Some(d),
            Ok(Object::Stream(s)) => Some(&s.dict),
            _ => None,
        },
        _ => None,
    }
}

fn name_eq(obj: &Object, want: &[u8]) -> bool {
    matches!(obj.as_name(), Ok(n) if n == want)
}

/// True if `bytes` contains an inline image mask — `BI … /ImageMask true …
/// ID` or its abbreviated `/IM true` form. Conservative substring scan over
/// already-decompressed content; a glyph painted as an inline stencil one
/// indirection below the page is what this catches when it is NOT inside a
/// Type3 font (those are caught by the Type3 check directly).
fn content_has_inline_mask(bytes: &[u8]) -> bool {
    if find_subslice(bytes, b"/ImageMask").is_some() {
        return true;
    }
    // `/IM` followed by whitespace then `true` (the inline-image abbreviation).
    let mut i = 0;
    while let Some(rel) = find_subslice(&bytes[i..], b"/IM") {
        let p = i + rel;
        let mut k = p + 3;
        // Reject `/ImageMask`/`/IMa…` — require a delimiter after `/IM`.
        if bytes.get(k).map(|b| b.is_ascii_alphabetic()).unwrap_or(false) {
            i = p + 3;
            continue;
        }
        while k < bytes.len() && is_pdf_ws(bytes[k]) {
            k += 1;
        }
        if bytes[k..].starts_with(b"true") {
            return true;
        }
        i = p + 3;
    }
    false
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|w| w == needle)
}

/// Recursively walk a /Resources dictionary looking for the glyph-procedure
/// constructs. `visited` guards against Form-XObject cycles; `depth` bounds
/// pathological nesting.
fn scan_resources_for_glyph_procs(
    doc: &Document,
    resources: &lopdf::Dictionary,
    depth: u32,
    visited: &mut std::collections::HashSet<ObjectId>,
    flags: &mut GlyphFlags,
) {
    if depth > 12 {
        return;
    }

    // 1. Type3 fonts — the primary blind spot (CharProc glyphs).
    if let Some(fonts) = resources.get(b"Font").ok().and_then(|o| obj_to_dict(doc, o)) {
        for (_name, fref) in fonts.iter() {
            let Some(fdict) = obj_to_dict(doc, fref) else { continue };
            if fdict.get(b"Subtype").map(|o| name_eq(o, b"Type3")).unwrap_or(false) {
                flags.type3 = true;
                let has_cp = fdict.get(b"CharProcs").is_ok();
                flags.note(format!(
                    "Type3 font (glyph-procedure{})",
                    if has_cp { " /CharProcs" } else { "" }
                ));
            }
        }
    }

    // 2. XObjects — image masks (stencil glyphs) + Form XObjects (recurse).
    if let Some(xobjs) = resources.get(b"XObject").ok().and_then(|o| obj_to_dict(doc, o)) {
        for (_name, xref) in xobjs.iter() {
            // Track the referenced object id so a self-referential form does
            // not loop.
            let xid = if let Object::Reference(r) = xref { Some(*r) } else { None };
            if let Some(id) = xid {
                if !visited.insert(id) {
                    continue;
                }
            }
            let Some(xdict) = obj_to_dict(doc, xref) else { continue };
            let subtype_image = xdict.get(b"Subtype").map(|o| name_eq(o, b"Image")).unwrap_or(false);
            let subtype_form = xdict.get(b"Subtype").map(|o| name_eq(o, b"Form")).unwrap_or(false);

            if subtype_image {
                let is_mask = matches!(xdict.get(b"ImageMask"), Ok(Object::Boolean(true)))
                    || matches!(xdict.get(b"IM"), Ok(Object::Boolean(true)));
                if is_mask {
                    flags.image_mask = true;
                    flags.note("image-mask XObject (stencil glyph)".to_string());
                }
            } else if subtype_form {
                // Recurse into the form's own resources + scan its content for
                // inline masks. Anything the form bears bubbles up as form_glyph.
                let mut sub = GlyphFlags::default();
                if let Some(fres) = xdict.get(b"Resources").ok().and_then(|o| resolve_dict(doc, o)) {
                    scan_resources_for_glyph_procs(doc, fres, depth + 1, visited, &mut sub);
                }
                if let Some(id) = xid {
                    if let Ok(Object::Stream(s)) = doc.get_object(id) {
                        let content = s.decompressed_content().unwrap_or_else(|_| s.content.clone());
                        if content_has_inline_mask(&content) {
                            sub.image_mask = true;
                            sub.note("inline image mask in Form XObject".to_string());
                        }
                    }
                }
                if sub.any() {
                    flags.form_glyph = true;
                    flags.type3 |= sub.type3;
                    flags.image_mask |= sub.image_mask;
                    for c in sub.constructs {
                        flags.note(format!("Form XObject → {c}"));
                    }
                }
            }
        }
    }
}

/// Scan a page's concatenated content stream for an inline image mask drawn
/// directly on the page (not inside a font/form).
fn scan_page_content_for_inline_mask(doc: &Document, page_id: ObjectId, flags: &mut GlyphFlags) {
    if let Ok(content) = doc.get_page_content(page_id) {
        if content_has_inline_mask(&content) {
            flags.image_mask = true;
            flags.note("inline image mask in page content".to_string());
        }
    }
}

fn probe_glyph_procedures_impl(doc: &Document, pages: &[u16]) -> Vec<GlyphProcedureProbe> {
    let page_map = doc.get_pages(); // 1-based page number → ObjectId
    let mut out: Vec<GlyphProcedureProbe> = Vec::new();
    let mut seen_pages = std::collections::HashSet::new();
    for &p in pages {
        if !seen_pages.insert(p) {
            continue;
        }
        let one = (p as u32) + 1;
        let Some(page_id) = page_map.get(&one).copied() else { continue };
        let mut flags = GlyphFlags::default();
        let mut visited = std::collections::HashSet::new();
        if let Some(res) = resolve_page_resources(doc, page_id) {
            scan_resources_for_glyph_procs(doc, res, 0, &mut visited, &mut flags);
        }
        scan_page_content_for_inline_mask(doc, page_id, &mut flags);
        if flags.any() {
            out.push(GlyphProcedureProbe {
                page_index: p,
                type3: flags.type3,
                image_mask: flags.image_mask,
                form_glyph: flags.form_glyph,
                constructs: flags.constructs,
            });
        }
    }
    out
}

/// Detect, on the given (0-based) redacted page indices, whether the page
/// bears a Type3 glyph-procedure font, an image-mask stencil, or a Form
/// XObject carrying either — the constructs both the pdfjs and pdfium
/// redaction witnesses can be blind to. Returns one entry PER FLAGGED PAGE
/// (pages with no such construct are omitted). The redaction pipeline merges
/// the flagged pages into its rasterize set so they are flattened by the
/// proven raster path rather than reaching a clean verdict via a blind
/// witness (cidredact, KNOWN-LIMITATIONS §9a). Pure lopdf; synchronous.
#[tauri::command(rename_all = "snake_case")]
pub fn pdf_probe_glyph_procedures(
    bytes: Vec<u8>,
    pages: Vec<u16>,
) -> Result<Vec<GlyphProcedureProbe>> {
    let doc = Document::load_mem(&bytes)
        .map_err(|e| AppError::Pdf(format!("glyph-procedure probe: load: {e}")))?;
    Ok(probe_glyph_procedures_impl(&doc, &pages))
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
// 5 and 6 are now decrypted NATIVELY (in-process) for the standard
// StdCF/AESV3 shape via `commands::aes256_decrypt` — the algorithm-2.B
// (R6) / Adobe-Ext-3 (R5) KDF ported from `pdfCryptoR6.ts`. qpdf remains
// a DEEP fallback only for exotic crypt-filter variants native declines
// (non-StdCF, StmF != StrF, EncryptMetadata=false, object-stream xref).

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

/// User-facing, actionable message when an AES-256 R=5/R=6 file cannot
/// be opened because the bundled build has no native R=5/R=6 KDF and the
/// `qpdf` fallback was unavailable. Session 9 (open-reliability): an
/// encrypted file that can't open must fail LOUDLY with a gated reason a
/// non-developer can act on — never silently. The decision (epic § Session
/// 9 deliverable 2) is "bundle qpdf OR surface a clear install message";
/// 1.0 ships the gated message and Session 10 owns bundling qpdf per-OS.
///
/// `qpdf_err` is the underlying spawn/exit detail (e.g.
/// "qpdf not found on PATH") so the surfaced toast says exactly why.
fn aes256_qpdf_required_message(rev: u8, qpdf_err: &str) -> String {
    // NOTE (NOT shown to the user): the native R=5/R=6 KDF
    // (`commands::aes256_decrypt`) now handles the standard StdCF/AESV3
    // shape in-process, so this gated message only reaches the user for
    // exotic crypt-filter variants native declined AND qpdf is missing.
    format!(
        "This PDF uses AES-256 (revision {rev}) encryption, which this build opens with the \
         free qpdf tool — and qpdf was not available ({qpdf_err}). Install qpdf and add it to \
         your PATH (https://qpdf.sourceforge.io/), then reopen the file. A future release will \
         bundle qpdf so this step is not needed."
    )
}

/// Generic user-actionable "install qpdf" message for the lopdf-fallback
/// decrypt path (AES-128 / RC4 variants lopdf rejects but qpdf could open)
/// when qpdf is missing. Same loud-and-gated bar as the AES-256 branch —
/// a non-developer is told exactly what to do, not handed an lopdf error.
fn qpdf_required_message(qpdf_err: &str) -> String {
    format!(
        "This PDF is encrypted with an algorithm this build opens with the free qpdf tool, \
         and qpdf was not available ({qpdf_err}). Install qpdf and add it to your PATH \
         (https://qpdf.sourceforge.io/), then reopen the file. A future release will bundle qpdf."
    )
}

/// The single sentinel for "qpdf could not be located". `find_qpdf`
/// returns this when discovery fails, and the spawn path returns it on
/// `ErrorKind::NotFound`. Both decrypt callers branch on it to choose
/// the gated install message vs. the password/variant message. Keeping
/// it a single constant prevents the Session-9 contract from drifting
/// when qpdf discovery changes (preflight P1).
const QPDF_NOT_FOUND: &str = "qpdf not found on PATH";

/// Choose the user-facing error for a failed AES-256 R5/R6 decrypt. A
/// missing qpdf gets the gated, actionable install message; a qpdf that
/// ran but rejected the input is almost always a wrong password.
fn aes256_decrypt_message(rev: u8, qpdf_err: &str) -> String {
    if qpdf_err.contains(QPDF_NOT_FOUND) {
        aes256_qpdf_required_message(rev, qpdf_err)
    } else {
        format!(
            "Could not unlock this AES-256 (revision {rev}) PDF — the password is wrong, \
             or the file uses an unsupported encryption variant ({qpdf_err})."
        )
    }
}

/// Choose the user-facing error for a failed lopdf-fallback decrypt
/// (AES-128 / RC4 variants lopdf rejected). Missing qpdf → gated install
/// message; a real qpdf failure keeps both engines' detail.
fn generic_decrypt_message(lopdf_err: &str, qpdf_err: &str) -> String {
    if qpdf_err.contains(QPDF_NOT_FOUND) {
        qpdf_required_message(qpdf_err)
    } else {
        format!("{lopdf_err}; qpdf fallback failed: {qpdf_err}")
    }
}

/// Locate a qpdf executable. Mirrors the LibreOffice graceful-absent
/// pattern (`commands::libreoffice::find_soffice`): probe (1) next to
/// the running executable — where a future per-OS bundle would drop it —
/// then (2) a repo-local `tools/qpdf/bin/`, then (3) PATH, then (4) the
/// OS-standard install locations. Returns `None` when qpdf is nowhere to
/// be found; the caller surfaces the gated "install qpdf" message.
///
/// qpdf is NOT bundled in 1.0 (it pulls several support DLLs — bundling
/// it is owner/Session-11 follow-up). This discovery makes the bundle
/// path READY: drop qpdf beside the exe (or in `tools/qpdf/bin`) and it
/// is used with no PATH change.
fn find_qpdf() -> Option<std::path::PathBuf> {
    use std::path::PathBuf;
    let exe_name = if cfg!(windows) { "qpdf.exe" } else { "qpdf" };

    // 1. Next to the current executable (packaged-app layout).
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let cand = dir.join(exe_name);
            if cand.exists() {
                return Some(cand);
            }
        }
    }

    // 2. Repo-local tools/qpdf/bin — dev/bundle-staging fast-path.
    if let Some(dir) = find_repo_tools_subdir("qpdf") {
        let cand = dir.join("bin").join(exe_name);
        if cand.exists() {
            return Some(cand);
        }
    }

    // 3. $PATH via where/which.
    let finder = if cfg!(windows) { "where" } else { "which" };
    if let Ok(out) = std::process::Command::new(finder).arg("qpdf").output() {
        if out.status.success() {
            if let Ok(s) = String::from_utf8(out.stdout) {
                if let Some(line) = s.lines().next() {
                    let p = PathBuf::from(line.trim());
                    if p.exists() {
                        return Some(p);
                    }
                }
            }
        }
    }

    // 4. OS-standard install locations.
    let hardcoded: Vec<PathBuf> = if cfg!(windows) {
        vec![
            PathBuf::from(r"C:\Program Files\qpdf\bin\qpdf.exe"),
            PathBuf::from(r"C:\Program Files (x86)\qpdf\bin\qpdf.exe"),
        ]
    } else if cfg!(target_os = "macos") {
        vec![
            PathBuf::from("/opt/homebrew/bin/qpdf"),
            PathBuf::from("/usr/local/bin/qpdf"),
        ]
    } else {
        vec![
            PathBuf::from("/usr/bin/qpdf"),
            PathBuf::from("/usr/local/bin/qpdf"),
        ]
    };
    hardcoded.into_iter().find(|p| p.exists())
}

/// Walk up from `CARGO_MANIFEST_DIR` (or cwd) looking for a
/// `tools/<name>` directory. Sibling of the render module's
/// `find_repo_tools_dir`, generalized for the qpdf staging dir.
fn find_repo_tools_subdir(name: &str) -> Option<std::path::PathBuf> {
    let start = std::env::var_os("CARGO_MANIFEST_DIR")
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::current_dir().ok())?;
    let mut cur = start.as_path();
    loop {
        let candidate = cur.join("tools").join(name);
        if candidate.exists() {
            return Some(candidate);
        }
        cur = cur.parent()?;
    }
}

#[tauri::command(rename_all = "snake_case")]
pub fn pdf_decrypt_bytes(bytes: Vec<u8>, password: String) -> Result<Vec<u8>> {
    // G4 ergonomic: detect AES-256 R=5 / R=6 BEFORE handing to lopdf
    // so we can try qpdf's battle-tested decrypt path before falling back
    // to a user-readable, ACTIONABLE message (Session 9: loud + gated, the
    // user is told to install qpdf rather than getting a silent failure).
    if let Some(rev) = detect_aes256_high_rev(&bytes) {
        // §1/§9d: try the NATIVE algorithm-2.B (R6) / Adobe-Ext-3 (R5) KDF
        // first — closes the limitation in-process for the standard
        // StdCF/AESV3 shape and removes the qpdf dependency for the common
        // gov/hospital case. qpdf stays a DEEP fallback for exotic crypt
        // filters native declines, so this strictly widens coverage.
        use crate::commands::aes256_decrypt::{decrypt_aes256_native, NativeDecryptOutcome};
        match decrypt_aes256_native(&bytes, &password, rev) {
            NativeDecryptOutcome::Ok(out) => return Ok(out),
            NativeDecryptOutcome::WrongPassword => {
                // Native verified the password against both /U and /O —
                // qpdf would reject it too, so surface the precise reason
                // rather than the misleading "install qpdf" detour.
                return Err(AppError::Pdf(format!(
                    "Could not unlock this AES-256 (revision {rev}) PDF — the password is wrong."
                )));
            }
            // An exotic crypt-filter variant native declined — fall through
            // to qpdf, preserving the Session-9 gated-install-message contract.
            NativeDecryptOutcome::Unsupported(_reason) => {
                return decrypt_with_qpdf(&bytes, &password)
                    .map_err(|qpdf_err| AppError::Pdf(aes256_decrypt_message(rev, &qpdf_err)));
            }
        }
    }

    match decrypt_with_lopdf(&bytes, &password) {
        Ok(out) => Ok(out),
        // Session 9: a missing-qpdf failure here (AES-128/RC4 lopdf
        // rejected but qpdf could open) must also be loud + actionable, not
        // a developer-facing lopdf error. A genuine qpdf failure (wrong
        // password, real qpdf error) keeps the detailed message.
        Err(lopdf_err) => decrypt_with_qpdf(&bytes, &password)
            .map_err(|qpdf_err| AppError::Pdf(generic_decrypt_message(&lopdf_err.to_string(), &qpdf_err))),
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

    // Locate qpdf (next-to-exe → tools/qpdf → PATH → OS dirs). When it is
    // nowhere to be found, return the single sentinel the callers branch
    // on for the gated install message (preflight P1: keep the contract).
    let qpdf = find_qpdf().ok_or_else(|| QPDF_NOT_FOUND.to_string())?;

    let dir = std::env::temp_dir().join(format!("open-satchel-qpdf-decrypt-{}", Uuid::new_v4()));
    std::fs::create_dir(&dir).map_err(|e| format!("create temp dir: {e}"))?;
    let result = (|| {
        let input = dir.join("input.pdf");
        let output = dir.join("output.pdf");
        let password_file = dir.join("password.txt");
        std::fs::write(&input, bytes).map_err(|e| format!("write input: {e}"))?;
        std::fs::write(&password_file, password.as_bytes())
            .map_err(|e| format!("write password file: {e}"))?;
        let status = Command::new(&qpdf)
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
                    // The located binary vanished between find + spawn
                    // (TOCTOU) — treat as missing, same gated sentinel.
                    QPDF_NOT_FOUND.to_string()
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

/// First consumer migrated onto the satchel-core parser/store facade
/// (NATIVE-REWRITE-PLAN §2): the shell reads bytes, the core does the
/// document logic (`pdf::info::read_document_info`), the lopdf
/// backend stays behind core-owned traits. Decoding rules (UTF-16 BE
/// BOM text strings, 8 KB XMP preview cap) live in the core now —
/// `decode_pdf_text_string` below remains only for the OTHER
/// not-yet-migrated readers in this file.
#[tauri::command]
pub fn pdf_verify_metadata(path: String) -> Result<PdfMetadata> {
    use satchel_core::backend::lopdf_store::LopdfDocumentStore;
    use satchel_core::pdf::info::read_document_info;
    use satchel_core::pdf::store::DocumentStore;

    let bytes =
        std::fs::read(&path).map_err(|e| AppError::Pdf(format!("verify load {path}: {e}")))?;
    let handle = LopdfDocumentStore
        .open(&bytes)
        .map_err(|e| AppError::Pdf(format!("verify load {path}: {e}")))?;
    let info = read_document_info(handle.as_ref());
    Ok(PdfMetadata {
        title: info.title,
        author: info.author,
        subject: info.subject,
        keywords: info.keywords,
        creator: info.creator,
        producer: info.producer,
        creation_date: info.creation_date,
        mod_date: info.mod_date,
        xmp_preview: info.xmp_preview,
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
// Open health (Session 9: damaged / hybrid-xref / unreachable page tree)
// ───────────────────────────────────────────────────────────────────
//
// Discriminate a DAMAGED open from a genuinely-empty one so the live
// open path can fail LOUDLY with a gated reason instead of presenting a
// structurally-broken document as a clean empty tab (the silent 0-page
// pathology — os-signed-L2-FP2.pdf: catalog references /Pages but the
// page-tree objects are unreachable). This mirrors the satchel-core
// `lopdf.page_tree.unreachable` recorder, but as a value the shipping
// TS load path can branch on (satchel-core is not wired into the live
// open).
//
// It NEVER attempts lenient full-scan recovery — that would resurrect
// superseded incremental-update revisions on signed files, the exact
// redaction-leak vector Session 3 closed. The decision (epic § Session 9
// deliverable 1) is the conservative gated-UX branch: surface, don't
// recover.

#[derive(Debug, Serialize)]
pub struct OpenHealth {
    /// Pages reachable by walking the page tree from the catalog.
    pub page_count: u32,
    /// The catalog references a /Pages root but the walk yielded 0
    /// pages — a damaged / hybrid-xref / undecodable-ObjStm document, not
    /// a genuinely empty one. The TS load path THROWS a gated error on
    /// this rather than opening a silent empty tab.
    pub page_tree_unreachable: bool,
    /// lopdf could parse the trailer + xref at all. `false` means the
    /// file is malformed below the page-tree level (the TS path's pdfjs
    /// fallback will reject it loudly).
    pub parse_ok: bool,
}

fn open_health_impl(raw: &[u8]) -> OpenHealth {
    let doc = lopdf::Document::load_mem(raw).ok();
    let parse_ok = doc.is_some();
    let (page_count, claims_pages) = match doc.as_ref() {
        Some(d) => {
            let n = d.get_pages().len() as u32;
            // Catalog claims a /Pages root? (matches satchel-core's
            // catalog_claims_pages: a /Pages entry on the catalog dict.)
            let claims = d
                .catalog()
                .ok()
                .map(|c| c.has(b"Pages"))
                .unwrap_or(false);
            (n, claims)
        }
        None => (0, false),
    };
    OpenHealth {
        page_count,
        page_tree_unreachable: page_count == 0 && claims_pages,
        parse_ok,
    }
}

#[tauri::command]
pub fn pdf_open_health(path: String) -> Result<OpenHealth> {
    let raw = std::fs::read(&path).map_err(|e| AppError::Pdf(format!("read {path}: {e}")))?;
    Ok(open_health_impl(&raw))
}

#[cfg(test)]
mod open_health_tests {
    use super::open_health_impl;
    use lopdf::{dictionary, Document};

    /// The os-signed-L2-FP2.pdf pathology in miniature: lopdf loads the
    /// trailer + catalog, but the catalog's /Pages points at an object
    /// that is never defined, so the page-tree walk yields 0 pages.
    fn unreachable_page_tree_pdf() -> Vec<u8> {
        let mut doc = Document::with_version("1.7");
        let catalog_id = doc.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => (999u32, 0u16),
        });
        doc.trailer.set("Root", catalog_id);
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).expect("save");
        bytes
    }

    /// A healthy one-page document.
    fn healthy_pdf() -> Vec<u8> {
        let mut doc = Document::with_version("1.7");
        let pages_id = doc.new_object_id();
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
        });
        let pages = dictionary! {
            "Type" => "Pages",
            "Kids" => vec![page_id.into()],
            "Count" => 1,
        };
        doc.objects.insert(pages_id, lopdf::Object::Dictionary(pages));
        let catalog_id = doc.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        doc.trailer.set("Root", catalog_id);
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).expect("save");
        bytes
    }

    #[test]
    fn unreachable_page_tree_is_flagged_not_silent() {
        let h = open_health_impl(&unreachable_page_tree_pdf());
        assert!(h.parse_ok, "lopdf loads the trailer even with a broken page tree");
        assert_eq!(h.page_count, 0, "page tree is unreachable");
        assert!(
            h.page_tree_unreachable,
            "catalog claims /Pages but 0 pages resolved — must be flagged for the gated open"
        );
    }

    #[test]
    fn healthy_doc_is_not_flagged() {
        let h = open_health_impl(&healthy_pdf());
        assert!(h.parse_ok);
        assert_eq!(h.page_count, 1);
        assert!(!h.page_tree_unreachable, "a healthy doc must not be flagged damaged");
    }

    #[test]
    fn garbage_does_not_claim_unreachable() {
        // Not a PDF at all: parse fails, and we must NOT assert the
        // page tree is "unreachable" (the TS path's pdfjs fallback owns
        // the malformed-bytes rejection).
        let h = open_health_impl(b"this is not a pdf");
        assert!(!h.parse_ok);
        assert!(!h.page_tree_unreachable);
        assert_eq!(h.page_count, 0);
    }
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

fn push_needle_encodings(
    out: &mut Vec<(&'static str, Vec<u8>)>,
    needle: &str,
    labels: [&'static str; 5],
) {
    out.push((labels[0], needle.as_bytes().to_vec()));
    // UTF-16 BE with BOM (pd-lib's canonical text-string form).
    let mut be = vec![0xFEu8, 0xFFu8];
    for c in needle.encode_utf16() {
        be.push((c >> 8) as u8);
        be.push((c & 0xFF) as u8);
    }
    out.push((labels[1], be));
    // UTF-16 BE without BOM (some emitters omit it).
    let mut be_nobom = Vec::new();
    for c in needle.encode_utf16() {
        be_nobom.push((c >> 8) as u8);
        be_nobom.push((c & 0xFF) as u8);
    }
    out.push((labels[2], be_nobom));
    // Hex-encoded literal (PDFHexString).
    out.push((
        labels[3],
        needle
            .as_bytes()
            .iter()
            .flat_map(|b| format!("{:02X}", b).into_bytes())
            .collect(),
    ));
    out.push((
        labels[4],
        needle
            .as_bytes()
            .iter()
            .flat_map(|b| format!("{:02x}", b).into_bytes())
            .collect(),
    ));
}

fn make_variants(needle: &str) -> Vec<(&'static str, Vec<u8>)> {
    let mut out: Vec<(&'static str, Vec<u8>)> = Vec::with_capacity(15);
    push_needle_encodings(
        &mut out,
        needle,
        ["literal", "utf16be_bom", "utf16be_nobom", "hex_upper", "hex_lower"],
    );
    // Gate-2 P2: the decoded TS layers compare case-insensitively, but
    // this byte scanner was exact-case only — a file carrying
    // "CONFIDENTIAL" passed a scan for "Confidential". Case-folded
    // variants close the asymmetry (whitespace variance is out of reach
    // for a byte grep; the decoded layers own that).
    let lower = needle.to_lowercase();
    if lower != needle {
        push_needle_encodings(
            &mut out,
            &lower,
            ["literal_lc", "utf16be_bom_lc", "utf16be_nobom_lc", "hex_upper_lc", "hex_lower_lc"],
        );
    }
    let upper = needle.to_uppercase();
    if upper != needle && upper != lower {
        push_needle_encodings(
            &mut out,
            &upper,
            ["literal_uc", "utf16be_bom_uc", "utf16be_nobom_uc", "hex_upper_uc", "hex_lower_uc"],
        );
    }
    out
}

/// PDF RunLengthDecode (PDF 32000-1 §7.4.5). lopdf 0.32 decodes
/// Flate + LZW but NOT RunLength, so a needle inside a RunLength stream
/// was scanned only as opaque encoded bytes (R9c). A length byte L:
///   0..=127   → copy the next L+1 bytes literally,
///   129..=255 → repeat the next single byte (257 - L) times,
///   128       → end-of-data.
/// Returns None on a truncated run or if the output would exceed `cap`
/// (a cheap decompression-bomb guard — a stray 0x81 repeats a byte 256×).
fn rle_decode_capped(input: &[u8], cap: usize) -> Option<Vec<u8>> {
    let mut out: Vec<u8> = Vec::new();
    let mut i = 0usize;
    while i < input.len() {
        let len = input[i];
        i += 1;
        if len == 128 {
            break; // EOD
        } else if len < 128 {
            let n = len as usize + 1;
            if i + n > input.len() {
                return None;
            }
            out.extend_from_slice(&input[i..i + n]);
            i += n;
        } else {
            let count = 257 - len as usize;
            if i >= input.len() {
                return None;
            }
            let b = input[i];
            i += 1;
            out.extend(std::iter::repeat(b).take(count));
        }
        if out.len() > cap {
            return None;
        }
    }
    Some(out)
}

/// Does this stream declare `name` among its /Filter(s)? Handles the
/// single-Name and Array-of-Names forms.
fn stream_declares_filter(stream: &lopdf::Stream, name: &[u8]) -> bool {
    match stream.dict.get(b"Filter") {
        Ok(Object::Name(n)) => n.as_slice() == name,
        Ok(Object::Array(arr)) => arr
            .iter()
            .any(|o| matches!(o, Object::Name(n) if n.as_slice() == name)),
        _ => false,
    }
}

/// Dead-revision sweep: lopdf materialises only xref-LIVE objects, so a
/// Flate-compressed stream that belongs to a superseded incremental
/// revision is invisible to BOTH the raw byte grep (the bytes are
/// compressed) and the parsed-stream walk (the object is not in the
/// live xref chain). This walks every `stream`…`endstream` candidate in
/// the RAW bytes, attempts zlib inflation, and greps the inflated
/// payload. Live streams get re-scanned too — a duplicate hit is
/// harmless; the dead objects nothing else can see are the point.
/// Partial inflation (corrupt tail) is still scanned — a leak in the
/// recovered prefix is a leak.
fn scan_dead_streams(raw: &[u8], variants: &[(&'static str, Vec<u8>)]) -> Vec<GrepHit> {
    use std::io::Read;
    let kw: &[u8] = b"stream";
    let end_kw: &[u8] = b"endstream";
    let mut hits: Vec<GrepHit> = Vec::new();
    let mut i = 0usize;
    while i + kw.len() <= raw.len() {
        if &raw[i..i + kw.len()] != kw {
            i += 1;
            continue;
        }
        // Skip the tail of an "endstream" token.
        if i >= 3 && &raw[i - 3..i] == b"end" {
            i += kw.len();
            continue;
        }
        // Spec shape: the stream keyword is followed by CRLF or LF.
        let mut j = i + kw.len();
        if j < raw.len() && raw[j] == b'\r' {
            j += 1;
        }
        if j >= raw.len() || raw[j] != b'\n' {
            i += kw.len();
            continue;
        }
        j += 1;
        let Some(rel) = raw[j..].windows(end_kw.len()).position(|w| w == end_kw) else {
            // No endstream anywhere after this point — no later
            // candidate can have one either.
            break;
        };
        let data = &raw[j..j + rel];
        let mut inflated = Vec::new();
        let _ = flate2::read::ZlibDecoder::new(data).read_to_end(&mut inflated);
        if !inflated.is_empty() {
            for (variant, bytes) in variants {
                if byte_contains(&inflated, bytes) {
                    hits.push(GrepHit {
                        kind: "dead_stream",
                        variant,
                        object_id: None,
                    });
                }
            }
        }
        // R9c: a dead stream may be RunLength-encoded (not Flate). The
        // raw sweep has no /Filter to read, so attempt a RunLength decode
        // too — a needle in a RunLength superseded revision is invisible
        // to both the raw grep (encoded) and Zlib inflation. RLE-decoding
        // non-RLE bytes yields garbage that simply won't match the needle.
        if let Some(rle) = rle_decode_capped(data, 50 * 1024 * 1024) {
            if !rle.is_empty() && rle.as_slice() != data {
                for (variant, bytes) in variants {
                    if byte_contains(&rle, bytes) {
                        hits.push(GrepHit {
                            kind: "dead_stream",
                            variant,
                            object_id: None,
                        });
                    }
                }
            }
        }
        i = j + rel + end_kw.len();
    }
    hits
}

/// Shared scan core for one needle: raw-byte scan over the whole file
/// plus a per-stream scan (decompressed where possible) of an already-
/// parsed document, plus the dead-revision sweep over raw stream
/// candidates. Returns (raw_hits, stream_hits, streams_scanned,
/// streams_decompressed).
fn scan_needle(
    raw: &[u8],
    doc: Option<&lopdf::Document>,
    needle: &str,
) -> (Vec<GrepHit>, Vec<GrepHit>, usize, usize) {
    let variants = make_variants(needle);

    let mut raw_hits: Vec<GrepHit> = Vec::new();
    for (variant, bytes) in &variants {
        if byte_contains(raw, bytes) {
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
    if let Some(doc) = doc {
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
            // R9c: lopdf 0.32 decodes Flate + LZW but NOT RunLength, so a
            // needle inside a RunLength-encoded stream was scanned only as
            // opaque bytes. Decode RunLength ourselves when lopdf declined
            // and the stream declares that filter.
            let rle: Option<Vec<u8>> = if decoded.is_none()
                && stream_declares_filter(stream, b"RunLengthDecode")
            {
                let out = rle_decode_capped(&stream.content, 50 * 1024 * 1024);
                if out.is_some() {
                    total_decompressed += 1;
                }
                out
            } else {
                None
            };
            let mut scan_targets: Vec<&Vec<u8>> = match decoded.as_ref() {
                Some(d) => vec![d, &stream.content],
                None => vec![&stream.content],
            };
            if let Some(r) = rle.as_ref() {
                scan_targets.push(r);
            }
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

    // Session-3 (live-suite finding): a delete saved as an incremental
    // update leaves the ORIGINAL content stream as a dead object —
    // Flate-compressed (raw grep blind) and absent from the live xref
    // (stream walk blind). Sweep every raw stream candidate through
    // inflation so prior-revision leaks are caught.
    stream_hits.extend(scan_dead_streams(raw, &variants));

    (raw_hits, stream_hits, total_streams, total_decompressed)
}

#[tauri::command]
pub fn pdf_grep_full_file(path: String, needle: String) -> Result<GrepFullFileResult> {
    let raw = std::fs::read(&path).map_err(|e| AppError::Pdf(format!("read {path}: {e}")))?;
    let doc = lopdf::Document::load_mem(&raw).ok();
    let (raw_hits, stream_hits, total_streams, total_decompressed) =
        scan_needle(&raw, doc.as_ref(), &needle);

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
// Session-3: redaction permanence check (refuse-on-survival witness)
// ───────────────────────────────────────────────────────────────────
//
// One call answers "does this redacted output still carry the needle
// ANYWHERE?" across layers the byte-grep alone cannot see:
//
//   • raw file bytes + every stream, 5 encoding variants (shared core
//     with pdf_grep_full_file);
//   • every PARSED string/name object — lopdf has already resolved
//     literal-string escapes (`(S\145CRET)`) and name `#xx` escapes
//     that defeat a raw byte scan; this walks dictionaries, arrays,
//     stream dicts and the trailer (so /Info, annotation /Contents,
//     form /V values are covered even when escape-encoded);
//   • startxref/%%EOF shape-matched markers — a redaction save in this
//     app is always a FULL regeneration (pdfium save_to_writer, pd-lib
//     full save, or a fresh raster doc), so a marker count > 1 means a
//     prior revision survived and its dead objects may still carry the
//     content. (Shape-matched, not a plain substring count: the token
//     must be followed by whitespace, digits, whitespace, %%EOF.)
//
// `parse_ok: false` is itself a red flag for a redaction output (our
// writers emit parseable PDFs) — the TS caller treats it as failure.

#[derive(Debug, Serialize)]
pub struct PermanenceNeedleResult {
    pub needle: String,
    pub raw_hits: Vec<GrepHit>,
    pub stream_hits: Vec<GrepHit>,
    pub string_object_hits: Vec<GrepHit>,
    pub leaked: bool,
}

#[derive(Debug, Serialize)]
pub struct PermanenceCheckResult {
    pub needles: Vec<PermanenceNeedleResult>,
    pub startxref_markers: usize,
    pub parse_ok: bool,
    pub total_streams_scanned: usize,
    pub total_streams_decompressed: usize,
    /// Count of /Filespec / /EmbeddedFile objects. Attachments are
    /// CONTAINER formats (zip/docx/…) the byte-grep is blind to — the
    /// caller surfaces their presence as a security-severity record
    /// instead of pretending they were scanned.
    pub embedded_files: usize,
    pub leaked: bool,
}

/// Recursively visit the decoded byte payload of every String and Name
/// object reachable from `obj` (dicts, arrays, stream dicts).
fn visit_object_strings(obj: &Object, f: &mut dyn FnMut(&'static str, &[u8])) {
    match obj {
        Object::String(bytes, _) => f("string_object", bytes),
        Object::Name(bytes) => f("name_object", bytes),
        Object::Array(items) => {
            for it in items {
                visit_object_strings(it, f);
            }
        }
        Object::Dictionary(dict) => {
            for (_k, v) in dict.iter() {
                visit_object_strings(v, f);
            }
        }
        Object::Stream(s) => {
            for (_k, v) in s.dict.iter() {
                visit_object_strings(v, f);
            }
        }
        _ => {}
    }
}

/// Count `startxref <ws> <digits> <ws> %%EOF` shapes in the raw bytes.
fn count_startxref_markers(raw: &[u8]) -> usize {
    let pat = b"startxref";
    let is_ws = |b: u8| b == b'\r' || b == b'\n' || b == b' ' || b == b'\t';
    let mut count = 0usize;
    let mut i = 0usize;
    while i + pat.len() <= raw.len() {
        if &raw[i..i + pat.len()] != pat {
            i += 1;
            continue;
        }
        let mut j = i + pat.len();
        let ws_start = j;
        while j < raw.len() && is_ws(raw[j]) {
            j += 1;
        }
        let saw_ws = j > ws_start;
        let digit_start = j;
        while j < raw.len() && raw[j].is_ascii_digit() {
            j += 1;
        }
        let saw_shape = saw_ws && j > digit_start;
        while j < raw.len() && is_ws(raw[j]) {
            j += 1;
        }
        if saw_shape && raw[j..].starts_with(b"%%EOF") {
            count += 1;
        }
        i += pat.len();
    }
    count
}

fn permanence_check_impl(raw: &[u8], needles: &[String]) -> PermanenceCheckResult {
    let doc = lopdf::Document::load_mem(raw).ok();
    let parse_ok = doc.is_some();
    let startxref_markers = count_startxref_markers(raw);

    let mut embedded_files = 0usize;
    if let Some(doc) = doc.as_ref() {
        for (_id, obj) in doc.objects.iter() {
            let dict = match obj {
                Object::Dictionary(d) => d,
                Object::Stream(s) => &s.dict,
                _ => continue,
            };
            let is_filespec = matches!(
                dict.get(b"Type"),
                Ok(Object::Name(n)) if n == b"Filespec" || n == b"EmbeddedFile"
            );
            if is_filespec || dict.has(b"EF") {
                embedded_files += 1;
            }
        }
    }

    // String/name decoded payloads only need the literal + UTF-16
    // variants — lopdf has already undone hex/escape encodings.
    let mut total_streams = 0usize;
    let mut total_decompressed = 0usize;
    let mut results: Vec<PermanenceNeedleResult> = Vec::with_capacity(needles.len());
    for needle in needles {
        let (raw_hits, stream_hits, scanned, decompressed) =
            scan_needle(raw, doc.as_ref(), needle);
        total_streams = scanned;
        total_decompressed = decompressed;

        let mut string_object_hits: Vec<GrepHit> = Vec::new();
        if let Some(doc) = doc.as_ref() {
            let variants: Vec<(&'static str, Vec<u8>)> = make_variants(needle)
                .into_iter()
                // Excludes hex_* AND the case-folded hex_*_lc/_uc forms —
                // lopdf already undid hex encodings in decoded payloads.
                .filter(|(name, _)| !name.starts_with("hex_"))
                .collect();
            let mut check = |kind: &'static str, payload: &[u8], object_id: Option<u32>| {
                for (variant, bytes) in &variants {
                    if byte_contains(payload, bytes) {
                        string_object_hits.push(GrepHit {
                            kind,
                            variant,
                            object_id,
                        });
                    }
                }
            };
            for (id, obj) in doc.objects.iter() {
                let oid = Some(id.0 as u32);
                visit_object_strings(obj, &mut |kind, payload| check(kind, payload, oid));
            }
            for (_k, v) in doc.trailer.iter() {
                visit_object_strings(v, &mut |kind, payload| check(kind, payload, None));
            }
        }

        let leaked =
            !raw_hits.is_empty() || !stream_hits.is_empty() || !string_object_hits.is_empty();
        results.push(PermanenceNeedleResult {
            needle: needle.clone(),
            raw_hits,
            stream_hits,
            string_object_hits,
            leaked,
        });
    }

    let leaked = results.iter().any(|r| r.leaked);
    PermanenceCheckResult {
        needles: results,
        startxref_markers,
        parse_ok,
        total_streams_scanned: total_streams,
        total_streams_decompressed: total_decompressed,
        embedded_files,
        leaked,
    }
}

#[tauri::command(rename_all = "snake_case")]
pub fn pdf_redaction_permanence_check(
    bytes: Option<Vec<u8>>,
    path: Option<String>,
    needles: Vec<String>,
) -> Result<PermanenceCheckResult> {
    let raw: Vec<u8> = match (bytes, path) {
        (Some(b), _) if !b.is_empty() => b,
        (_, Some(p)) => std::fs::read(&p).map_err(|e| AppError::Pdf(format!("read {p}: {e}")))?,
        _ => {
            return Err(AppError::Pdf(
                "pdf_redaction_permanence_check: provide bytes or path".into(),
            ))
        }
    };
    Ok(permanence_check_impl(&raw, &needles))
}

#[cfg(test)]
mod redaction_permanence_tests {
    use super::*;
    use lopdf::{dictionary, Document, Stream};

    /// Minimal one-page document with an /Info /Title and a content
    /// stream, built with lopdf so the bytes parse cleanly.
    fn build_doc(title: &str, stream_text: &str, compress: bool) -> Vec<u8> {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let content_id = doc.add_object(Stream::new(
            dictionary! {},
            format!("BT ({stream_text}) Tj ET").into_bytes(),
        ));
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
            "Contents" => content_id,
        });
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![page_id.into()],
                "Count" => 1,
            }),
        );
        let catalog_id = doc.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        let info_id = doc.add_object(dictionary! {
            "Title" => Object::string_literal(title),
        });
        doc.trailer.set("Root", catalog_id);
        doc.trailer.set("Info", info_id);
        if compress {
            doc.compress();
        }
        let mut out = Vec::new();
        doc.save_to(&mut out).expect("save");
        out
    }

    /// Replace exactly one occurrence of `from` with the SAME-LENGTH
    /// `to` so xref offsets stay valid.
    fn splice(bytes: &mut [u8], from: &[u8], to: &[u8]) {
        assert_eq!(from.len(), to.len(), "splice must preserve length");
        let pos = bytes
            .windows(from.len())
            .position(|w| w == from)
            .expect("splice needle present");
        bytes[pos..pos + from.len()].copy_from_slice(to);
    }

    #[test]
    fn clean_doc_is_not_leaked_and_single_revision() {
        let raw = build_doc("Quarterly report", "hello world", false);
        let res = permanence_check_impl(&raw, &["SECRET-NOPE".into()]);
        assert!(res.parse_ok);
        assert!(!res.leaked, "clean doc must not leak: {res:?}");
        assert_eq!(res.startxref_markers, 1, "lopdf save is one revision");
    }

    #[test]
    fn octal_escaped_literal_caught_by_string_object_scan() {
        // `(S\145CRET-OCT)` decodes to SECRET-OCT but defeats every
        // raw-byte variant. Same-length splice keeps the xref valid.
        let mut raw = build_doc("SECRET-OCTAAA", "hello", false);
        splice(&mut raw, b"(SECRET-OCTAAA)", b"(S\\105CRET-OCT)");
        let res = permanence_check_impl(&raw, &["SECRET-OCT".into()]);
        assert!(res.parse_ok);
        let n = &res.needles[0];
        assert!(
            n.raw_hits.is_empty(),
            "raw grep must NOT see the escaped form: {:?}",
            n.raw_hits
        );
        assert!(
            n.string_object_hits.iter().any(|h| h.kind == "string_object"),
            "decoded string-object scan must catch it: {n:?}"
        );
        assert!(res.leaked);
    }

    #[test]
    fn needle_in_compressed_stream_caught_by_stream_scan() {
        let raw = build_doc("Quarterly report", "SECRET-STREAM token", true);
        let res = permanence_check_impl(&raw, &["SECRET-STREAM".into()]);
        assert!(res.parse_ok);
        let n = &res.needles[0];
        assert!(
            n.stream_hits.iter().any(|h| h.kind == "stream"),
            "decompressed stream scan must catch it: {n:?}"
        );
        assert!(res.leaked);
    }

    #[test]
    fn case_folded_survivor_caught_by_byte_scan() {
        // Gate-2 P2: the file carries "SECRET-CASED" but the needle the
        // TS layer hands over is mixed-case. Exact-case-only scanning
        // passed this file; the case-folded variants must catch it.
        let raw = build_doc("Quarterly report", "SECRET-CASED token", false);
        let res = permanence_check_impl(&raw, &["Secret-Cased".into()]);
        assert!(res.parse_ok);
        let n = &res.needles[0];
        assert!(
            n.raw_hits.iter().any(|h| h.variant == "literal_uc")
                || n.stream_hits.iter().any(|h| h.variant == "literal_uc"),
            "uppercase variant must catch the cased survivor: {n:?}"
        );
        assert!(res.leaked);
    }

    #[test]
    fn appended_revision_marker_detected() {
        let mut raw = build_doc("Quarterly report", "hello", false);
        raw.extend_from_slice(b"\nstartxref\n123\n%%EOF\n");
        let res = permanence_check_impl(&raw, &[]);
        assert_eq!(res.startxref_markers, 2, "incremental tail must count");
    }

    #[test]
    fn malformed_startxref_shapes_do_not_count() {
        let mut raw = build_doc("Quarterly report", "hello", false);
        raw.extend_from_slice(b"\nstartxref junk %%EOF\n"); // no digits
        raw.extend_from_slice(b"\nstartxref123\n%%EOF\n"); // no whitespace
        let res = permanence_check_impl(&raw, &[]);
        assert_eq!(res.startxref_markers, 1);
    }

    #[test]
    fn embedded_files_are_counted() {
        let raw = build_doc("Quarterly report", "hello", false);
        let clean = permanence_check_impl(&raw, &[]);
        assert_eq!(clean.embedded_files, 0);

        let mut doc = Document::load_mem(&raw).expect("reload");
        doc.add_object(dictionary! {
            "Type" => "Filespec",
            "F" => Object::string_literal("leak.zip"),
        });
        let mut with_attachment = Vec::new();
        doc.save_to(&mut with_attachment).expect("save");
        let res = permanence_check_impl(&with_attachment, &[]);
        assert_eq!(res.embedded_files, 1, "Filespec object must be counted");
    }

    #[test]
    fn multiple_needles_report_independently() {
        let raw = build_doc("Has SECRET-A only", "hello", false);
        let res = permanence_check_impl(&raw, &["SECRET-A".into(), "SECRET-B".into()]);
        assert!(res.needles[0].leaked, "SECRET-A is in /Title");
        assert!(!res.needles[1].leaked, "SECRET-B is nowhere");
        assert!(res.leaked, "doc-level leaked is the OR of needles");
    }

    fn zlib(data: &[u8]) -> Vec<u8> {
        use flate2::{write::ZlibEncoder, Compression};
        use std::io::Write;
        let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
        enc.write_all(data).expect("deflate write");
        enc.finish().expect("deflate finish")
    }

    /// Session-3 live-suite finding: a delete saved as an INCREMENTAL
    /// update leaves the original content stream as a DEAD object —
    /// Flate-compressed (raw grep blind) and superseded in the live
    /// xref (lopdf stream walk blind). Only the dead-stream sweep can
    /// see it. This builds a real two-revision file: rev 1 carries the
    /// needle in a compressed stream; rev 2 replaces that object with
    /// a clean compressed stream via a classic appended xref + /Prev.
    #[test]
    fn dead_revision_compressed_stream_caught_by_dead_stream_sweep() {
        // The padding makes the stream genuinely compressible — deflate
        // emits a STORED (verbatim) block for tiny inputs, which would
        // leave the needle visible to the raw grep and defeat the
        // point of this test.
        let body = format!("{}SECRET-DEADREV gone", "lorem ipsum dolor sit amet ".repeat(8));
        let mut raw = build_doc("Quarterly report", &body, true);

        let doc = Document::load_mem(&raw).expect("rev1 parses");
        let stream_id = doc
            .objects
            .iter()
            .find(|(_, o)| matches!(o, Object::Stream(_)))
            .map(|(id, _)| *id)
            .expect("rev1 has a content stream");
        let root_id = doc
            .trailer
            .get(b"Root")
            .and_then(|o| o.as_reference())
            .expect("rev1 trailer Root");
        let size = doc.max_id + 1;
        let prev = {
            let s = raw
                .windows(9)
                .rposition(|w| w == b"startxref")
                .expect("rev1 startxref");
            std::str::from_utf8(&raw[s + 9..])
                .expect("ascii tail")
                .split_whitespace()
                .next()
                .expect("offset digits")
                .parse::<usize>()
                .expect("offset parses")
        };

        // Rev 2: replacement (clean) stream object + xref + /Prev.
        let clean = zlib(b"BT (clean) Tj ET");
        let obj_offset = raw.len() + 1; // the leading \n below
        let mut rev2 = format!(
            "\n{} {} obj\n<< /Length {} /Filter /FlateDecode >>\nstream\n",
            stream_id.0,
            stream_id.1,
            clean.len()
        )
        .into_bytes();
        rev2.extend_from_slice(&clean);
        rev2.extend_from_slice(b"\nendstream\nendobj\n");
        let xref_offset = raw.len() + rev2.len();
        rev2.extend_from_slice(
            format!(
                "xref\n0 1\n0000000000 65535 f \n{} 1\n{:010} {:05} n \n\
                 trailer\n<< /Size {} /Root {} {} R /Prev {} >>\nstartxref\n{}\n%%EOF\n",
                stream_id.0,
                obj_offset,
                stream_id.1,
                size,
                root_id.0,
                root_id.1,
                prev,
                xref_offset
            )
            .as_bytes(),
        );
        raw.extend_from_slice(&rev2);

        let res = permanence_check_impl(&raw, &["SECRET-DEADREV".into()]);
        assert_eq!(res.startxref_markers, 2, "two revisions present");
        let n = &res.needles[0];
        assert!(
            n.raw_hits.is_empty(),
            "compressed needle must be invisible to the raw grep: {:?}",
            n.raw_hits
        );
        assert!(
            !n.stream_hits.iter().any(|h| h.kind == "stream"),
            "live stream walk must NOT see the superseded object: {:?}",
            n.stream_hits
        );
        assert!(
            n.stream_hits.iter().any(|h| h.kind == "dead_stream"),
            "dead-stream sweep must catch the prior-revision leak: {n:?}"
        );
        assert!(res.leaked);
    }

    /// PDF RunLengthDecode round-trip + the literal/EOD/repeat shapes.
    #[test]
    fn rle_decode_handles_literal_repeat_and_eod() {
        // Literal run of 6 bytes "SECRET" (len byte 5 = copy 5+1), then
        // EOD (128). Trailing bytes after EOD are ignored.
        let enc = vec![0x05u8, b'S', b'E', b'C', b'R', b'E', b'T', 128, b'X'];
        assert_eq!(super::rle_decode_capped(&enc, 4096).as_deref(), Some(&b"SECRET"[..]));
        // Repeat run: 0xFE (=254) repeats the next byte 257-254=3 times.
        let enc2 = vec![0xFEu8, b'Z', 128];
        assert_eq!(super::rle_decode_capped(&enc2, 4096).as_deref(), Some(&b"ZZZ"[..]));
        // Truncated literal run → None (malformed).
        assert_eq!(super::rle_decode_capped(&[0x05u8, b'A', b'B'], 4096), None);
        // Cap guard: a repeat that overflows the cap → None (bomb guard).
        assert_eq!(super::rle_decode_capped(&[0x81u8, b'A'], 1), None);
    }

    /// R9c: a needle inside a RunLength-encoded stream (which lopdf 0.32
    /// cannot decompress) is caught by the parsed-stream scan now that we
    /// decode RunLength ourselves.
    #[test]
    fn runlength_encoded_needle_caught_by_parsed_scan() {
        let mut doc = Document::with_version("1.5");
        // RLE("SECRET") = [5, S,E,C,R,E,T, EOD]
        let content = vec![0x05u8, b'S', b'E', b'C', b'R', b'E', b'T', 128];
        doc.add_object(Stream::new(
            dictionary! { "Filter" => "RunLengthDecode" },
            content,
        ));
        let (_raw_hits, stream_hits, _scanned, decompressed) =
            super::scan_needle(b"", Some(&doc), "SECRET");
        assert!(
            stream_hits.iter().any(|h| h.kind == "stream" && h.variant == "literal"),
            "RunLength-encoded needle must be caught: {stream_hits:?}"
        );
        assert_eq!(decompressed, 1, "the RunLength stream counts as decoded, not undecodable");
    }

    /// R9c: a needle in a RunLength-encoded DEAD stream (raw sweep, no
    /// /Filter to read) is caught by the dead-stream RunLength fallback.
    #[test]
    fn runlength_dead_stream_needle_caught_by_sweep() {
        let mut raw = Vec::new();
        raw.extend_from_slice(b"7 0 obj\n<< /Length 8 /Filter /RunLengthDecode >>\nstream\n");
        raw.extend_from_slice(&[0x05u8, b'S', b'E', b'C', b'R', b'E', b'T', 128]);
        raw.extend_from_slice(b"\nendstream\nendobj\n");
        let hits = super::scan_dead_streams(&raw, &super::make_variants("SECRET"));
        assert!(
            hits.iter().any(|h| h.kind == "dead_stream" && h.variant == "literal"),
            "RunLength dead-stream leak must be caught: {hits:?}"
        );
    }

    /// 1.1 pin (pdfium STRATEGY): `strip_text_impl` must go pure-Rust.
    /// This is the acceptance contract, not a 1.0 gate — see the
    /// TODO(1.1) on `strip_text_impl`. When un-ignored it must pass in
    /// an environment WITHOUT the pdfium DLL: same signature, per-region
    /// attribution intact, and the output green under the permanence
    /// check.
    #[test]
    #[ignore = "1.1 target: un-ignore when strip_text_impl no longer references pdfium_render; must pass with the pdfium DLL absent"]
    fn pure_rust_strip_acceptance_pin() {
        // One Helvetica line at (72, 700) so the bbox geometry is exact.
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let font_id = doc.add_object(dictionary! {
            "Type" => "Font",
            "Subtype" => "Type1",
            "BaseFont" => "Helvetica",
        });
        let resources_id = doc.add_object(dictionary! {
            "Font" => dictionary! { "F1" => font_id },
        });
        let content_id = doc.add_object(Stream::new(
            dictionary! {},
            b"BT /F1 12 Tf 72 700 Td (SSN: 123-45-6789) Tj ET".to_vec(),
        ));
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
            "Resources" => resources_id,
            "Contents" => content_id,
        });
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![page_id.into()],
                "Count" => 1,
            }),
        );
        let catalog_id = doc.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        doc.trailer.set("Root", catalog_id);
        let mut raw = Vec::new();
        doc.save_to(&mut raw).expect("save fixture");

        let bbox = StripBbox {
            page_index: 0,
            x: 70.0,
            y: 694.0,
            width: 240.0,
            height: 20.0,
            coord_space: None,
        };
        let (out, removed) = strip_text_impl(raw, vec![bbox]).expect("strip");
        assert!(
            removed.first().copied().unwrap_or(0) >= 1,
            "the overlapping text object must be attributed to region 0: {removed:?}"
        );
        let res = permanence_check_impl(&out, &["123-45-6789".into()]);
        assert!(
            !res.leaked,
            "stripped output must be green under the permanence check: {res:?}"
        );
        assert_eq!(res.startxref_markers, 1, "strip output is a full regeneration");
    }
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

// ── Core-facade migration equivalence tests ────────────────────────

#[cfg(test)]
mod core_facade_migration_tests {
    use super::*;

    /// The committed real-PDF fixture (signed PDF/A-1b invoice).
    fn fixture_path() -> std::path::PathBuf {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../test-files/fidelity/pdfa-1b-invoice/original.pdf")
    }

    /// The PRE-migration pdf_verify_metadata algorithm, reproduced
    /// verbatim so the facade-backed implementation can be proven
    /// equivalent on a real document, not just synthetic dicts.
    fn legacy_metadata(path: &str) -> PdfMetadata {
        let doc = load(path).expect("legacy load");
        let info_obj = doc.trailer.get(b"Info").ok().cloned();
        let info = info_obj.as_ref().and_then(|o| resolve_dict_obj(&doc, o));
        fn s(dict: Option<&lopdf::Dictionary>, key: &[u8]) -> Option<String> {
            let bytes = dict?.get(key).ok()?.as_str().ok()?;
            Some(decode_pdf_text_string(bytes))
        }
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
        PdfMetadata {
            title: s(info, b"Title"),
            author: s(info, b"Author"),
            subject: s(info, b"Subject"),
            keywords: s(info, b"Keywords"),
            creator: s(info, b"Creator"),
            producer: s(info, b"Producer"),
            creation_date: s(info, b"CreationDate"),
            mod_date: s(info, b"ModDate"),
            xmp_preview,
        }
    }

    #[test]
    fn facade_metadata_matches_legacy_on_real_fixture() {
        let path = fixture_path();
        assert!(path.exists(), "fixture missing: {}", path.display());
        let path_str = path.to_string_lossy().into_owned();

        // The healthy PDF/A-1b invoice must read with ZERO fallbacks
        // — its XMP stream is legitimately unfiltered (PDF/A
        // requirement), which must NOT be mistaken for a degraded
        // decode (regression guard for the lopdf.xmp.raw_content
        // false positive caught 2026-06-11).
        let (new, fallbacks) =
            satchel_core::fallback::capture(|| pdf_verify_metadata(path_str.clone()).unwrap());
        assert!(
            fallbacks.is_empty(),
            "healthy fixture should read fallback-free, got: {fallbacks:?}"
        );
        let old = legacy_metadata(&path_str);

        assert_eq!(new.title, old.title);
        assert_eq!(new.author, old.author);
        assert_eq!(new.subject, old.subject);
        assert_eq!(new.keywords, old.keywords);
        assert_eq!(new.creator, old.creator);
        assert_eq!(new.producer, old.producer);
        assert_eq!(new.creation_date, old.creation_date);
        assert_eq!(new.mod_date, old.mod_date);
        assert_eq!(new.xmp_preview, old.xmp_preview);
        // A PDF/A-1b document must actually carry XMP — guard against
        // the test silently passing on None == None.
        assert!(new.xmp_preview.is_some(), "fixture should carry XMP");
    }

    #[test]
    fn facade_page_count_matches_legacy_on_real_fixture() {
        use satchel_core::backend::lopdf_store::LopdfDocumentStore;
        use satchel_core::pdf::store::DocumentStore;
        let path = fixture_path();
        let bytes = std::fs::read(&path).expect("read fixture");
        let handle = LopdfDocumentStore.open(&bytes).expect("facade open");
        let legacy = load(&path.to_string_lossy()).expect("legacy load");
        assert_eq!(handle.page_count(), legacy.get_pages().len() as u32);
        assert!(handle.page_count() > 0);
    }
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

    #[test]
    fn qpdf_required_message_is_user_actionable() {
        // Session 9: an encrypted file that can't open must fail LOUDLY
        // with a message a non-developer can act on. The message must name
        // the encryption, the revision, the missing tool, the install
        // action, and must NOT leak the internal "implement the KDF"
        // developer follow-up to the user.
        let msg = super::aes256_qpdf_required_message(6, "qpdf not found on PATH");
        assert!(msg.contains("AES-256"), "names the encryption: {msg}");
        assert!(msg.contains("revision 6"), "names the revision: {msg}");
        assert!(msg.contains("qpdf"), "names the tool: {msg}");
        assert!(msg.to_lowercase().contains("install"), "tells the user to install: {msg}");
        assert!(msg.contains("PATH"), "tells the user where it must live: {msg}");
        assert!(
            msg.contains("qpdf not found on PATH"),
            "surfaces the underlying reason: {msg}"
        );
        // The developer-only native-KDF follow-up must stay out of the
        // user-facing string.
        assert!(!msg.contains("algorithm-2.B"), "no internal follow-up leaked: {msg}");
        assert!(!msg.to_lowercase().contains("kdf"), "no internal jargon leaked: {msg}");
    }

    #[test]
    fn generic_qpdf_required_message_is_user_actionable() {
        // The lopdf-fallback path (AES-128/RC4) must also be loud + gated.
        let msg = super::qpdf_required_message("qpdf not found on PATH");
        assert!(msg.contains("qpdf"), "names the tool: {msg}");
        assert!(msg.to_lowercase().contains("install"), "tells the user to install: {msg}");
        assert!(msg.contains("PATH"), "tells the user where it must live: {msg}");
        assert!(msg.contains("qpdf not found on PATH"), "surfaces the reason: {msg}");
    }

    // ── Session 10: qpdf discovery must not break the Session-9 gated
    // message contract. `decrypt_with_qpdf` now routes through
    // `find_qpdf`; when qpdf is absent it returns the single sentinel
    // `QPDF_NOT_FOUND`, and BOTH decrypt callers must still select the
    // gated install message on that sentinel (preflight P1).

    #[test]
    fn qpdf_not_found_sentinel_matches_the_caller_substring() {
        // The constant is the one source of truth; if it drifts away from
        // "not found on PATH", the gated-message branch silently breaks.
        assert!(super::QPDF_NOT_FOUND.contains("not found on PATH"));
        assert!(super::QPDF_NOT_FOUND.contains("qpdf"));
    }

    #[test]
    fn missing_qpdf_routes_to_gated_install_message_both_paths() {
        let err = super::QPDF_NOT_FOUND; // what decrypt_with_qpdf returns when absent
        // AES-256 R5/R6 path.
        let aes = super::aes256_decrypt_message(6, err);
        assert!(aes.to_lowercase().contains("install"), "AES path gated: {aes}");
        assert!(aes.contains("AES-256"), "AES path names encryption: {aes}");
        assert!(!aes.contains("password is wrong"), "AES path is NOT the wrong-password msg: {aes}");
        // lopdf-fallback path.
        let generic = super::generic_decrypt_message("lopdf rejected", err);
        assert!(generic.to_lowercase().contains("install"), "lopdf path gated: {generic}");
        assert!(generic.contains("qpdf"), "lopdf path names the tool: {generic}");
    }

    #[test]
    fn present_but_failed_qpdf_keeps_detail_not_install_message() {
        // qpdf ran and rejected the input (wrong password / bad variant) —
        // must NOT tell the user to install qpdf.
        let err = "qpdf exited with status exit code: 2: invalid password";
        let aes = super::aes256_decrypt_message(6, err);
        assert!(
            aes.contains("password is wrong") || aes.contains("unsupported"),
            "wrong-password msg, not install: {aes}"
        );
        let generic = super::generic_decrypt_message("lopdf rejected", err);
        assert!(generic.contains("qpdf fallback failed"), "keeps both engines' detail: {generic}");
    }
}

// ── Glyph-procedure detector tests (cidredact §9a) ─────────────────
//
// These read the COMMITTED synthetic fixtures under test-pdfs/redaction-glyph/
// (generated deterministically by scripts/gen-glyph-redaction-fixtures.py).
// The detector must FLAG the Type3 / image-mask / form-glyph constructs and
// NOT flag plain text or a plain-text Form XObject — the no-regression
// contract that keeps ordinary redactions on the selective text-strip path.
#[cfg(test)]
mod glyph_procedure_detector_tests {
    use super::*;

    fn glyph_fixture(name: &str) -> Vec<u8> {
        let p = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../test-pdfs/redaction-glyph")
            .join(name);
        std::fs::read(&p).unwrap_or_else(|e| panic!("fixture {} missing: {e}", p.display()))
    }

    fn probe(name: &str) -> Vec<GlyphProcedureProbe> {
        let doc = Document::load_mem(&glyph_fixture(name)).expect("load fixture");
        probe_glyph_procedures_impl(&doc, &[0])
    }

    #[test]
    fn type3_inline_glyph_is_flagged() {
        let probes = probe("type3-inline.pdf");
        assert_eq!(probes.len(), 1, "exactly the redacted page flagged");
        assert!(probes[0].type3, "Type3 inline-image glyph must flag type3");
        assert!(!probes[0].constructs.is_empty());
    }

    #[test]
    fn type3_mask_glyph_is_flagged() {
        let probes = probe("type3-mask.pdf");
        assert_eq!(probes.len(), 1);
        assert!(probes[0].type3, "Type3 image-mask glyph must flag type3");
    }

    #[test]
    fn type3_form_glyph_is_flagged() {
        let probes = probe("type3-form.pdf");
        assert_eq!(probes.len(), 1);
        assert!(probes[0].type3, "Type3 form-xobject glyph must flag type3");
    }

    #[test]
    fn page_level_image_mask_is_flagged() {
        let probes = probe("imagemask-glyph.pdf");
        assert_eq!(probes.len(), 1);
        assert!(probes[0].image_mask, "page image-mask stencil must flag image_mask");
        assert!(!probes[0].type3, "no Type3 font in this fixture");
    }

    #[test]
    fn plain_text_is_not_flagged() {
        let probes = probe("plain-text.pdf");
        assert!(probes.is_empty(), "plain text must NOT route to raster (no regression)");
    }

    #[test]
    fn plain_text_form_xobject_is_not_flagged() {
        // A Form XObject holding only extractable TEXT (no Type3/mask inside)
        // is handled by the existing strip path (pdfjs recurses). The detector
        // must leave it alone so ordinary form-bearing pages keep their text.
        let probes = probe("formxobject-text.pdf");
        assert!(
            probes.is_empty(),
            "a plain-text Form XObject must NOT be flagged, got: {:?}",
            probes
        );
    }

    #[test]
    fn unredacted_pages_are_not_inspected() {
        // Only the page indices passed in are inspected — a Type3 fixture
        // probed for a NON-redacted page index returns nothing.
        let doc = Document::load_mem(&glyph_fixture("type3-inline.pdf")).unwrap();
        let probes = probe_glyph_procedures_impl(&doc, &[7]);
        assert!(probes.is_empty(), "out-of-range / unredacted page yields no flag");
    }

    #[test]
    fn inline_mask_scanner_rejects_imagemask_substring() {
        // `/ImageMask` IS a mask; a bare `/IM` not followed by `true` is not.
        assert!(content_has_inline_mask(b"BI /W 4 /H 4 /ImageMask true ID xx EI"));
        assert!(content_has_inline_mask(b"BI /W 4 /IM true /D [0 1] ID xx EI"));
        assert!(!content_has_inline_mask(b"/IMacros 3 0 R /Other stuff"));
        assert!(!content_has_inline_mask(b"BT /F1 12 Tf (hello) Tj ET"));
    }
}
