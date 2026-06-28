//! Tauri commands for the PDF engine.
//!
//! The engine is live. The frontend save path
//! (`src/formats/pdf/index.ts`) invokes `engine_bake_from_bytes` for
//! paragraph edits — producing a signature-safe incremental update —
//! and falls back to pd-lib only on engine errors. The hybrid editor
//! (`EditableParagraphLayer`) invokes
//! `engine_render_page_with_skips_from_bytes` for its truth-layer
//! overlay. Font extraction + selective-op rendering are both wired
//! via the bytes-based variants; the path-based variants are kept
//! for tests and scripts.

use crate::error::AppError;
use crate::live::EditModel;
use crate::pdf_engine::linearize::{parse_linearization_hint, LinearizationInfo};
use crate::pdf_engine::{
    bake_edit_model, extract_fonts_for_page, extract_fonts_from_bytes, list_page_text_objects,
    page_count, render_page_to_png, render_page_to_png_with_skips,
    render_page_to_png_with_skips_from_bytes, rewrite_text_edits_in_place, write_incremental,
    ExtractedFont, IncrementalPatch, PageTextObjectInfo, SkipBbox, WriteSummary,
};
use crate::Result;
use serde::Serialize;
use tauri::ipc::Response;

/// Response shape: output bytes plus a summary of what the writer
/// did. The frontend will use the summary in telemetry when the
/// engine flag flips on.
#[derive(Debug, Serialize)]
pub struct EngineSaveResult {
    pub bytes: Vec<u8>,
    pub summary: WriteSummary,
    /// Session-1 degradation channel: every fallback the engine
    /// recorded while producing these bytes (font substitution,
    /// geometry defaults, encoding drops, …). Captured around the
    /// worker-thread closure — the fallback sink is thread-local, so
    /// the capture MUST wrap the same thread that runs the engine.
    /// Empty on a clean run. NOTE: events recorded before a command
    /// ERROR are dropped by design — the error string itself is the
    /// observable, recorded TS-side as the fallback reason.
    pub degradations: Vec<satchel_core::fallback::FallbackEvent>,
}

/// Response for the path-in/path-out bake/rewrite commands.
/// `WriteSummary` is FLATTENED so existing frontend readers of
/// `total_bytes` / `appended_bytes` / … keep working unchanged —
/// `degradations` is purely additive on the wire.
#[derive(Debug, Serialize)]
pub struct EnginePathSaveResult {
    #[serde(flatten)]
    pub summary: WriteSummary,
    pub degradations: Vec<satchel_core::fallback::FallbackEvent>,
}

/// Read `path`, append an incremental update that applies `patches`,
/// and return the combined bytes. S2 requires `patches` to be empty
/// (see [`write_incremental`] for the full scope commitment).
#[tauri::command]
pub async fn engine_save_incremental(
    path: String,
    patches: Vec<IncrementalPatch>,
) -> Result<EngineSaveResult> {
    let original = tokio::fs::read(&path)
        .await
        .map_err(|e| AppError::Pdf(format!("read {path}: {e}")))?;
    let (result, degradations) =
        satchel_core::fallback::capture(|| write_incremental(&original, &patches));
    let (bytes, summary) = result?;
    Ok(EngineSaveResult {
        bytes,
        summary,
        degradations,
    })
}

/// Render a single page to PNG via pdfium. Runs on the dedicated
/// pdfium thread (see `render_thread.rs`) to prevent pdfium's C
/// library from corrupting Tauri's IPC thread pool.
///
/// Returns a `tauri::ipc::Response` so the PNG ships as raw bytes
/// (application/octet-stream), NOT JSON-array-of-u8. A 5MB landscape
/// PNG inflates to ~30MB JSON ASCII through the default Vec<u8> path,
/// which both blocks the WebView while V8 parses it AND leaves the
/// inflated string sitting in heap until GC. `Response` ships the
/// raw bytes via the channel protocol — JS gets an ArrayBuffer back
/// at zero serialization cost.
#[tauri::command]
pub async fn engine_render_page(path: String, page_index: u16, scale: f32) -> Result<Response> {
    let png = crate::pdf_engine::render_thread::submit(move || {
        render_page_to_png(&path, page_index, scale)
    })
    .await?;
    Ok(Response::new(png))
}

/// Bytes-based variant of [`engine_render_page`] — renders a page
/// from in-memory PDF bytes without writing to a temp file. Used by
/// the heavy-PDF view path that swaps pdfjs for pdfium when the
/// document is large + the user is in view-only mode.
///
/// Internally a thin wrapper around
/// [`render_page_to_png_with_skips_from_bytes`] with an empty skip
/// list — same render config, same PNG output, just no text-region
/// removal.
#[tauri::command]
pub async fn engine_render_page_from_bytes(
    bytes: Vec<u8>,
    page_index: u16,
    scale: f32,
) -> Result<Response> {
    let png = crate::pdf_engine::render_thread::submit(move || {
        render_page_to_png_with_skips_from_bytes(bytes, page_index, scale, &[])
    })
    .await?;
    Ok(Response::new(png))
}

/// Probe a PDF for page count. Cheap — no rendering.
#[tauri::command]
pub async fn engine_page_count(path: String) -> Result<u16> {
    crate::pdf_engine::render_thread::submit(move || page_count(&path)).await
}

/// Probe a PDF for "Fast Web View" linearization. Reads the first
/// few KB of the file, parses the linearization hint dict if present,
/// and returns total page count + page-1 byte range. Frontends can
/// use this for an Acrobat-style "page 1 in 200ms" open path on huge
/// linearized docs without having to wait for the full xref parse.
///
/// Returns `Ok(None)` if the file isn't linearized — the typical
/// 95% of PDFs in the wild. Caller should fall through to its
/// regular open path in that case.
#[tauri::command]
pub async fn engine_probe_linearization(path: String) -> Result<Option<LinearizationInfo>> {
    let info = tokio::task::spawn_blocking(move || -> Result<Option<LinearizationInfo>> {
        // Read only the first 8KB — that's all the parser ever
        // looks at, and we don't want to load 100MB of file just
        // to find out it isn't linearized.
        use std::io::Read;
        let mut f =
            std::fs::File::open(&path).map_err(|e| AppError::Pdf(format!("open {path}: {e}")))?;
        let mut buf = vec![0u8; 8192];
        let n = f
            .read(&mut buf)
            .map_err(|e| AppError::Pdf(format!("read {path}: {e}")))?;
        buf.truncate(n);
        parse_linearization_hint(&buf)
    })
    .await
    .map_err(|e| AppError::Pdf(format!("linearize-probe task panicked: {e}")))??;
    Ok(info)
}

/// Cached variant of [`engine_render_page`]. Hits the bounded LRU
/// in `pdf_engine::render_cache` first; cache misses run pdfium and
/// store the PNG bytes for next time. Multiple concurrent misses for
/// DIFFERENT keys run in parallel — the cache mutex is released while
/// the actual pdfium render is in flight. Same-key concurrent misses
/// race; whichever completes second wins (cheap and harmless).
///
/// Use this from the in-app viewer + sidebar thumbnail strip + any
/// hover-to-preview flow. The path-based variant lets pdfium re-load
/// the file directly (faster than shipping the full byte buffer
/// across the IPC boundary every time).
#[tauri::command]
pub async fn engine_render_page_lru(path: String, page_index: u16, scale: f32) -> Result<Response> {
    let png = tokio::task::spawn_blocking(move || {
        crate::pdf_engine::render_cache::get_or_render(&path, page_index, scale)
    })
    .await
    .map_err(|e| AppError::Pdf(format!("render-lru task panicked: {e}")))??;
    Ok(Response::new(png))
}

/// Drop every cache entry for a path. Save-after-edit invalidates
/// the prior renders — the bytes on disk are different now. The
/// frontend save path should call this immediately after writing.
#[tauri::command]
pub async fn engine_invalidate_render_cache(path: String) -> Result<()> {
    crate::pdf_engine::render_cache::invalidate_path(&path)
}

/// Diagnostic: returns (current entry count, capacity). Used by
/// the perf bench + telemetry.
#[tauri::command]
pub async fn engine_render_cache_stats() -> Result<(usize, usize)> {
    crate::pdf_engine::render_cache::stats()
}

/// Tear down idle pdfium worker child processes. The pool itself
/// stays alive (next render lazily respawns) — this just frees the
/// OS-level RSS held by workers that are not actively rendering.
///
/// Call this from a tab-close path on heavy docs: after the user
/// closes a 33 MB doc we don't need four pdfium_worker.exe
/// processes pinning ~50 MB each until app quit.
///
/// Returns the number of workers that were reaped (skipped any that
/// were busy mid-render).
#[tauri::command]
pub async fn engine_reap_pool_workers() -> Result<usize> {
    Ok(crate::pdf_engine::render_pool::reap_idle_workers())
}

/// Fire-and-forget prefetch: queue async render jobs for a list of
/// page indices at the given scale. Each job runs on the
/// `spawn_blocking` thread pool (sized by tokio's default, typically
/// 512 threads — but pdfium's thread-local handle init means
/// effective parallelism is bounded by CPU). Misses populate the
/// LRU cache; subsequent `engine_render_page_lru` calls hit
/// immediately.
///
/// Returns IMMEDIATELY after spawning — the actual renders complete
/// in the background. The caller is expected to subsequently call
/// `engine_render_page_lru` for the pages that come into view; if
/// the prefetch finished, that call hits the cache.
#[tauri::command]
pub async fn engine_prefetch_pages(path: String, page_indices: Vec<u16>, scale: f32) -> Result<()> {
    for page_index in page_indices {
        let path_clone = path.clone();
        tokio::task::spawn_blocking(move || {
            // Errors are swallowed here on purpose. Prefetch is
            // best-effort: a failure to render a future page must
            // never bubble back to the user (they may never scroll
            // to it). The next on-demand render attempt will
            // surface any real error.
            let _ = crate::pdf_engine::render_cache::get_or_render(&path_clone, page_index, scale);
        });
    }
    Ok(())
}

/// Render N pages concurrently and wait until they all finish.
///
/// Difference from `engine_prefetch_pages`: this AWAITS, so the
/// caller knows exactly when the batch is done. Used by the
/// pool perf bench to measure actual parallelism without the
/// bridge-poll overhead that a "fire prefetch, then poll cache"
/// loop suffers.
///
/// Returns the page indices in the order they completed (which
/// won't match input order under a parallel pool — handy for
/// validating that workers really are parallel).
#[tauri::command]
pub async fn engine_render_pages_concurrent(
    path: String,
    page_indices: Vec<u16>,
    scale: f32,
) -> Result<Vec<u16>> {
    use tokio::task::JoinSet;
    let mut set = JoinSet::new();
    for page_index in page_indices {
        let path_clone = path.clone();
        set.spawn_blocking(move || -> Result<u16> {
            crate::pdf_engine::render_cache::get_or_render(&path_clone, page_index, scale)?;
            Ok(page_index)
        });
    }
    let mut completed = Vec::with_capacity(set.len());
    while let Some(res) = set.join_next().await {
        let page =
            res.map_err(|e| AppError::Pdf(format!("render-concurrent task panicked: {e}")))??;
        completed.push(page);
    }
    Ok(completed)
}

/// Bake an EditModel into output PDF bytes via incremental update.
/// Zero-edit models take the fast path (sig-preserving empty
/// increment). Non-empty models now ship via S5.5 (mask + text
/// overlay + FlateDecode + coord conversion).
#[tauri::command]
pub async fn engine_bake(path: String, model: EditModel) -> Result<EngineSaveResult> {
    let original = tokio::fs::read(&path)
        .await
        .map_err(|e| AppError::Pdf(format!("read {path}: {e}")))?;
    let (result, degradations) =
        satchel_core::fallback::capture(|| bake_edit_model(&original, &model));
    let (bytes, summary) = result?;
    Ok(EngineSaveResult {
        bytes,
        summary,
        degradations,
    })
}

/// Bytes-based variant of [`engine_bake`]. The frontend holds
/// `pdfBytes` in memory (possibly already merged with earlier
/// incremental updates in the same session); routing through a
/// temp file would both add latency and open a divergence window.
/// Same motivation as `engine_render_page_with_skips_from_bytes`.
///
/// Returns the output bytes + summary. Errors surface to the JS
/// `invoke` call as a string; callers should catch and fall back to
/// their pd-lib bake path.
#[tauri::command]
pub async fn engine_bake_from_bytes(bytes: Vec<u8>, model: EditModel) -> Result<EngineSaveResult> {
    // capture() INSIDE spawn_blocking: the fallback sink is
    // thread-local, so it must be installed on the worker thread
    // that actually runs the engine — not the async IPC thread.
    let (result, degradations) = tokio::task::spawn_blocking(move || {
        satchel_core::fallback::capture(|| bake_edit_model(&bytes, &model))
    })
    .await
    .map_err(|e| AppError::Pdf(format!("engine-bake-from-bytes task panicked: {e}")))?;
    let (out, summary) = result?;
    Ok(EngineSaveResult {
        bytes: out,
        summary,
        degradations,
    })
}

/// Path-in/path-out variant of [`engine_bake`]. The engine reads the
/// source PDF directly from `input_path`, applies `model`, writes the
/// result to `output_path`, and returns only the WriteSummary as
/// JSON.
///
/// **Why this exists:** for heavy docs (>5 MB) the bytes-based
/// variants ship the full document through Tauri's default
/// `Vec<u8>` IPC, which JSON-marshals each byte as an ASCII integer.
/// On a 33 MB doc that's a 200 MB+ JSON string IN the request AND
/// a similar string OUT in the response — multi-second blocking
/// of the WebView in BOTH directions plus the V8 heap balloons to
/// ~1 GB of intermediate string data. We've watched the process
/// hit 2.1 GB and hang on a single save of brand-guidelines.pdf.
///
/// The frontend should write its in-memory pdfBytes to `input_path`
/// via `plugin-fs.writeFile` (binary fast path — Channel-based, no
/// JSON), call this command, then read `output_path` back via
/// `plugin-fs.readFile`. Total IPC overhead becomes a few KB of
/// JSON request + the WriteSummary response — kilobytes, not
/// hundreds of megabytes.
#[tauri::command]
pub async fn engine_bake_to_path(
    input_path: String,
    output_path: String,
    model: EditModel,
) -> Result<EnginePathSaveResult> {
    let (result, degradations) = tokio::task::spawn_blocking(move || {
        satchel_core::fallback::capture(|| -> Result<WriteSummary> {
            let bytes = std::fs::read(&input_path)
                .map_err(|e| AppError::Pdf(format!("read {input_path}: {e}")))?;
            let (out, summary) = bake_edit_model(&bytes, &model)?;
            std::fs::write(&output_path, &out)
                .map_err(|e| AppError::Pdf(format!("write {output_path}: {e}")))?;
            Ok(summary)
        })
    })
    .await
    .map_err(|e| AppError::Pdf(format!("engine-bake-to-path task panicked: {e}")))?;
    let summary = result?;
    Ok(EnginePathSaveResult {
        summary,
        degradations,
    })
}

/// Path-in/path-out variant of [`engine_rewrite_from_bytes`]. Same
/// motivation as [`engine_bake_to_path`] — for heavy docs the bytes-
/// based IPC path balloons V8 heap multi-GB; routing through disk
/// keeps the IPC payload to a small JSON request + the WriteSummary
/// response.
#[tauri::command]
pub async fn engine_rewrite_to_path(
    input_path: String,
    output_path: String,
    model: EditModel,
) -> Result<EnginePathSaveResult> {
    let (result, degradations) = tokio::task::spawn_blocking(move || {
        satchel_core::fallback::capture(|| -> Result<WriteSummary> {
            let bytes = std::fs::read(&input_path)
                .map_err(|e| AppError::Pdf(format!("read {input_path}: {e}")))?;
            let (out, summary) = rewrite_text_edits_in_place(&bytes, &model)?;
            std::fs::write(&output_path, &out)
                .map_err(|e| AppError::Pdf(format!("write {output_path}: {e}")))?;
            Ok(summary)
        })
    })
    .await
    .map_err(|e| AppError::Pdf(format!("engine-rewrite-to-path task panicked: {e}")))?;
    let summary = result?;
    Ok(EnginePathSaveResult {
        summary,
        degradations,
    })
}

/// True text editing: rewrite the page's existing content stream in
/// place, replacing `Tj`/`TJ` operands via the font's ToUnicode CMap
/// reverse-mapping. Unlike [`engine_bake_from_bytes`]'s overlay
/// approach, this produces a file where extracted text returns the
/// NEW content (copy-paste, text-mining, search all see "Receipt"
/// instead of "Invoice").
///
/// Fails when: the font has no ToUnicode CMap, the original text
/// can't be located as a single Tj/TJ run, or any character in the
/// replacement text lacks a reverse-mapping. Callers should catch
/// and fall through to the overlay bake path so the edit isn't
/// lost on unrewritable paragraphs.
#[tauri::command]
pub async fn engine_rewrite_from_bytes(
    bytes: Vec<u8>,
    model: EditModel,
) -> Result<EngineSaveResult> {
    let (result, degradations) = tokio::task::spawn_blocking(move || {
        satchel_core::fallback::capture(|| rewrite_text_edits_in_place(&bytes, &model))
    })
    .await
    .map_err(|e| AppError::Pdf(format!("engine-rewrite task panicked: {e}")))?;
    let (out, summary) = result?;
    Ok(EngineSaveResult {
        bytes: out,
        summary,
        degradations,
    })
}

/// Render a page with specific bbox regions stripped of text.
/// Replaces today's DOM-mask overlay for the paragraph-edit layer —
/// the edited paragraph's text objects literally don't render, so
/// the background under them (gradient, photo, border) comes through
/// with 100% fidelity.
#[tauri::command]
pub async fn engine_render_page_with_skips(
    path: String,
    page_index: u16,
    scale: f32,
    skip_bboxes: Vec<SkipBbox>,
) -> Result<Response> {
    let png = crate::pdf_engine::render_thread::submit(move || {
        render_page_to_png_with_skips(&path, page_index, scale, &skip_bboxes)
    })
    .await?;
    Ok(Response::new(png))
}

/// Enumerate every text object on a page with its bbox in PDF-point
/// space. Frontend's EditableParagraphLayer maps paragraph bboxes
/// against this list to compute the skip set for subsequent
/// selective-op renders.
#[tauri::command]
pub async fn engine_list_page_text_objects(
    path: String,
    page_index: u16,
) -> Result<Vec<PageTextObjectInfo>> {
    crate::pdf_engine::render_thread::submit(move || list_page_text_objects(&path, page_index))
        .await
}

/// Selective-op render keyed off in-memory PDF bytes instead of a
/// file path. The frontend holds `pdfBytes` (the current in-memory
/// document, including any uncommitted edits merged via the bake
/// path) and routes engine-strip calls through this command.
///
/// Motivation: `EditableParagraphLayer` discards the original file
/// path on load and works off the in-memory byte buffer. Going
/// through a temp file both adds latency (disk write per keystroke-
/// debounced render) and opens a divergence window where the engine
/// sees the pre-edit bytes. Passing bytes directly keeps the render
/// in lockstep with the edit state.
///
/// Payload size is the full document bytes per call. For typical
/// edit-stream documents (invoices, contracts, 100KB–2MB range) IPC
/// cost is negligible; larger docs may want frontend-side debouncing
/// (currently 300ms in the layer's engine-strip effect).
#[tauri::command]
pub async fn engine_render_page_with_skips_from_bytes(
    bytes: Vec<u8>,
    page_index: u16,
    scale: f32,
    skip_bboxes: Vec<SkipBbox>,
) -> Result<Response> {
    let png = crate::pdf_engine::render_thread::submit(move || {
        render_page_to_png_with_skips_from_bytes(bytes, page_index, scale, &skip_bboxes)
    })
    .await?;
    Ok(Response::new(png))
}

/// Extract raw font-program bytes for every embedded font used on
/// a page. Frontend registers via the `FontFace` API so paragraph-
/// edit overlays render in the PDF's original typeface. Pairs with
/// the S6 selective-op render for seamless edit.
#[tauri::command]
pub async fn engine_extract_page_fonts(
    path: String,
    page_index: u32,
) -> Result<Vec<ExtractedFont>> {
    let fonts = tokio::task::spawn_blocking(move || extract_fonts_for_page(&path, page_index))
        .await
        .map_err(|e| AppError::Pdf(format!("extract-page-fonts task panicked: {e}")))??;
    Ok(fonts)
}

/// Bytes-based variant of [`engine_extract_page_fonts`]. The
/// frontend holds pdfBytes directly and uses this to avoid the
/// round-trip through a temp file. Same rationale as
/// [`engine_render_page_with_skips_from_bytes`] — see S8.5 session.
#[tauri::command]
pub async fn engine_extract_page_fonts_from_bytes(
    bytes: Vec<u8>,
    page_index: u32,
) -> Result<Vec<ExtractedFont>> {
    let fonts = tokio::task::spawn_blocking(move || extract_fonts_from_bytes(&bytes, page_index))
        .await
        .map_err(|e| {
            AppError::Pdf(format!("extract-page-fonts-from-bytes task panicked: {e}"))
        })??;
    Ok(fonts)
}

/// Session 4: targeted save-time extraction — find the embedded font
/// program for `family` anywhere in the document and judge whether it
/// can be REUSED for new text (TrueType + unicode cmap + glyph
/// coverage of `codepoints`). The overlay bake's resolution chain
/// tries this FIRST, before system fonts: the document's own typeface
/// is the faithful choice. Returns a tagged status — `usable` /
/// `unusable` (embedded but not re-encodable: the caller records
/// font.doc_embed_unusable) / `not_found` (silent; chain proceeds).
#[tauri::command]
pub async fn pdf_extract_font_payload(
    bytes: Vec<u8>,
    family: String,
    codepoints: Vec<u32>,
) -> Result<crate::pdf_engine::DocFontExtraction> {
    let out = tokio::task::spawn_blocking(move || {
        crate::pdf_engine::extract_font_payload_from_bytes(&bytes, &family, &codepoints)
    })
    .await
    .map_err(|e| AppError::Pdf(format!("extract-font-payload task panicked: {e}")))??;
    Ok(out)
}

/// Path variant of [`pdf_extract_font_payload`] — heavy (>1 MiB)
/// documents must not marshal their whole byte buffer through the
/// JSON-array IPC just to look up one font program (the same
/// inflation the engine_*_to_path commands exist to avoid).
#[tauri::command]
pub async fn pdf_extract_font_payload_from_path(
    path: String,
    family: String,
    codepoints: Vec<u32>,
) -> Result<crate::pdf_engine::DocFontExtraction> {
    let out = tokio::task::spawn_blocking(move || {
        crate::pdf_engine::extract_font_payload_from_path(&path, &family, &codepoints)
    })
    .await
    .map_err(|e| AppError::Pdf(format!("extract-font-payload-path task panicked: {e}")))??;
    Ok(out)
}

#[cfg(test)]
mod wire_shape_tests {
    use super::*;
    use crate::pdf_engine::types::WriteSummary;
    use satchel_core::fallback::FallbackEvent;

    fn summary() -> WriteSummary {
        WriteSummary {
            total_bytes: 10,
            appended_bytes: 2,
            new_xref_offset: 8,
            previous_xref_offset: 4,
            new_objects_emitted: 1,
        }
    }

    fn event() -> FallbackEvent {
        FallbackEvent {
            area: "font.substituted".into(),
            detail: "requested='Calibri' used='Helvetica' paragraph=p1".into(),
        }
    }

    /// Pins the bytes-command wire shape the frontend reads
    /// (pdfEngineBake.ts): summary stays NESTED, degradations is an
    /// additive sibling array of {area, detail}.
    #[test]
    fn engine_save_result_wire_shape() {
        let v = serde_json::to_value(EngineSaveResult {
            bytes: vec![1, 2],
            summary: summary(),
            degradations: vec![event()],
        })
        .expect("serializes");
        assert_eq!(v["summary"]["total_bytes"], 10);
        assert_eq!(v["summary"]["appended_bytes"], 2);
        assert_eq!(v["degradations"][0]["area"], "font.substituted");
        assert!(v["degradations"][0]["detail"]
            .as_str()
            .unwrap()
            .contains("Calibri"));
    }

    /// Pins the path-command wire shape: WriteSummary fields are
    /// FLATTENED at the top level (existing frontend readers of
    /// total_bytes/appended_bytes/... keep working — the pre-Session-1
    /// shape WAS the bare WriteSummary), with degradations additive.
    #[test]
    fn engine_path_save_result_flattens_summary() {
        let v = serde_json::to_value(EnginePathSaveResult {
            summary: summary(),
            degradations: vec![event()],
        })
        .expect("serializes");
        assert_eq!(v["total_bytes"], 10, "summary must be flattened: {v}");
        assert_eq!(v["appended_bytes"], 2);
        assert_eq!(v["new_objects_emitted"], 1);
        assert!(v.get("summary").is_none(), "no nested summary key: {v}");
        assert_eq!(v["degradations"][0]["area"], "font.substituted");
    }

    /// Clean runs serialize an EMPTY degradations array (not null /
    /// absent) so the TS merge layer can rely on the field existing.
    #[test]
    fn clean_run_serializes_empty_degradations_array() {
        let v = serde_json::to_value(EnginePathSaveResult {
            summary: summary(),
            degradations: vec![],
        })
        .expect("serializes");
        assert!(v["degradations"].as_array().unwrap().is_empty());
    }
}
