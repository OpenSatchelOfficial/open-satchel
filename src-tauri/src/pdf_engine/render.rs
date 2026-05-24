//! pdfium-backed page renderer.
//!
//! Loads the platform pdfium shared library dynamically from one of:
//!
//! 1. `$PDFIUM_DYNAMIC_LIB_PATH` — directory containing pdfium.dll
//!    (or libpdfium.so / libpdfium.dylib on non-Windows). The Tauri
//!    shell sets this at startup to point at the bundled resource
//!    dir, so end users get a working binary out of the box;
//!    developers can override to point at a custom build.
//! 2. `<repo>/src-tauri/resources/pdfium/` — where
//!    `scripts/install-pdfium.mjs` drops the library at install time.
//!    Used as a dev fallback when Rust is invoked directly via
//!    `cargo run` (no Tauri shell to set the env var).
//! 3. System PATH — last resort; behaves like the default
//!    [`Pdfium::bind_to_system_library`].
//!
//! The loaded [`Pdfium`] is wrapped in a `OnceLock` so repeated
//! renders share the same handle. pdfium is thread-safe when the
//! `thread_safe` feature is enabled (it is — see Cargo.toml).
//!
//! S3 scope: `render_page_to_png(path, page_index, scale) -> Vec<u8>`
//! and the Tauri command that wraps it. S6 extends this with
//! `skip_object_ids` for selective-op render.

use crate::error::AppError;
use crate::Result;
use pdfium_render::prelude::*;
use std::cell::RefCell;
use std::path::PathBuf;

// `Pdfium` owns a `Box<dyn PdfiumLibraryBindings>` which is neither
// Send nor Sync (the bindings trait doesn't require it). That rules
// out `static` storage — we'd need Sync. Instead we use
// `thread_local!`: each thread that enters the render path gets its
// own Pdfium, created lazily. The underlying pdfium.dll only loads
// once at the OS level; pdfium-render's thread-local wrapper handles
// per-thread state. Since Tauri commands + spawn_blocking tasks run
// on a worker-pool with a small, stable number of threads, the
// binding overhead is paid at most a handful of times.
thread_local! {
    static PDFIUM: RefCell<Option<Pdfium>> = const { RefCell::new(None) };
}

/// Run `f` with a reference to this thread's Pdfium instance,
/// initializing it if needed. Returns the closure's return value or
/// an `AppError::Pdf` if binding the library fails.
/// Public wrapper around the thread-local Pdfium dance for callers
/// outside this module (G9 destructive-overlay backstop in
/// commands::verify uses it). Same lazy-init + binding logic; just
/// exposed.
pub fn with_pdfium_pub<R>(f: impl FnOnce(&Pdfium) -> Result<R>) -> Result<R> {
    with_pdfium(f)
}

fn with_pdfium<R>(f: impl FnOnce(&Pdfium) -> Result<R>) -> Result<R> {
    PDFIUM.with(|cell| {
        // First, initialize if needed.
        {
            let borrow = cell.borrow();
            if borrow.is_none() {
                drop(borrow);
                let bindings = bind_pdfium().map_err(|e| {
                    AppError::Pdf(format!(
                        "no pdfium binary found: run \
                         `node scripts/install-pdfium.mjs`, set \
                         PDFIUM_DYNAMIC_LIB_PATH to the directory \
                         containing pdfium, or install pdfium on the \
                         system library path. probe error: {e}"
                    ))
                })?;
                *cell.borrow_mut() = Some(Pdfium::new(bindings));
            }
        }
        let borrow = cell.borrow();
        let pdfium = borrow
            .as_ref()
            .expect("pdfium just initialized must be Some");
        f(pdfium)
    })
}

/// Find and bind the pdfium shared library. Checks env var, then the
/// repo-local src-tauri/resources/pdfium dir, then falls back to the
/// platform system library.
fn bind_pdfium() -> std::result::Result<Box<dyn PdfiumLibraryBindings>, PdfiumError> {
    // 1. Explicit path via env var (set by Tauri shell at startup in
    //    production; can be overridden by developers).
    if let Ok(dir) = std::env::var("PDFIUM_DYNAMIC_LIB_PATH") {
        return Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path(&dir));
    }

    // 2. Repo-local src-tauri/resources/pdfium (dev fallback when
    //    cargo is invoked directly, without the Tauri shell).
    if let Some(dir) = find_repo_pdfium_dir() {
        let path_str = dir.to_string_lossy().to_string();
        if let Ok(b) =
            Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path(&path_str))
        {
            return Ok(b);
        }
        // Fall through if binding failed — try system library below
        // as a last resort.
    }

    // 3. System library on PATH
    Pdfium::bind_to_system_library()
}

/// Walk up from `CARGO_MANIFEST_DIR` (or cwd) looking for the
/// `src-tauri/resources/pdfium` directory. Returns the path if found.
fn find_repo_pdfium_dir() -> Option<PathBuf> {
    let start = std::env::var_os("CARGO_MANIFEST_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok())?;
    let mut cur = start.as_path();
    loop {
        let candidate = cur.join("src-tauri").join("resources").join("pdfium");
        if candidate.exists() {
            return Some(candidate);
        }
        // Also handle the case where we're already inside src-tauri/.
        let inner = cur.join("resources").join("pdfium");
        if inner.exists() {
            return Some(inner);
        }
        cur = cur.parent()?;
    }
}

/// Render one page of a PDF to PNG bytes.
///
/// `scale` is applied against the page's natural dimensions in points
/// (72 dpi). So `scale = 1.5` on a US-Letter page gives a 918×1188
/// PNG, matching the browser reference-renderer output. This
/// alignment is deliberate so engine output can be compared
/// byte-for-byte against reference captures.
pub fn render_page_to_png(pdf_path: &str, page_index: u16, scale: f32) -> Result<Vec<u8>> {
    if scale <= 0.0 || !scale.is_finite() {
        return Err(AppError::InvalidArgument(format!(
            "render scale must be positive and finite (got {scale})"
        )));
    }

    with_pdfium(|pdfium| {
        let document = pdfium
            .load_pdf_from_file(pdf_path, None)
            .map_err(|e| AppError::Pdf(format!("load {pdf_path}: {e}")))?;

        let pages = document.pages();
        let page = pages
            .get(page_index)
            .map_err(|e| AppError::Pdf(format!("page {page_index}: {e}")))?;

        let width_pts = page.width().value;
        let height_pts = page.height().value;
        let width_px = (width_pts * scale).round() as i32;
        let height_px = (height_pts * scale).round() as i32;

        let render_config = PdfRenderConfig::new()
            .set_target_width(width_px)
            .set_target_height(height_px)
            .render_form_data(true);

        let bitmap = page
            .render_with_config(&render_config)
            .map_err(|e| AppError::Pdf(format!("render page {page_index}: {e}")))?;

        // `as_image` returns a DynamicImage. Encode to PNG via the
        // image crate.
        let dyn_image = bitmap.as_image();
        let mut png_bytes: Vec<u8> = Vec::new();
        {
            use image::ImageFormat;
            use std::io::Cursor;
            dyn_image
                .write_to(&mut Cursor::new(&mut png_bytes), ImageFormat::Png)
                .map_err(|e| AppError::Pdf(format!("encode PNG: {e}")))?;
        }

        Ok(png_bytes)
    })
}

/// Count pages in a PDF without rendering anything. Useful as a
/// cheap liveness check for the pdfium binding + for the frontend's
/// page-picker UI.
pub fn page_count(pdf_path: &str) -> Result<u16> {
    with_pdfium(|pdfium| {
        let document = pdfium
            .load_pdf_from_file(pdf_path, None)
            .map_err(|e| AppError::Pdf(format!("load {pdf_path}: {e}")))?;
        Ok(document.pages().len())
    })
}

/// One bbox in PDF point space (pre-scaling). `(x, y)` is the
/// top-left corner in PDF coordinates (origin at bottom-left of the
/// page). Used by the selective-op render path to indicate regions
/// whose text objects should be omitted from the render.
#[derive(Debug, Clone, Copy, serde::Deserialize)]
pub struct SkipBbox {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

/// Render a page with specific regions EXCLUDED. For each bbox in
/// `skip_bboxes`, any page text object whose bounding box overlaps
/// is removed before the render runs. This is the engine's
/// replacement for today's DOM-mask approach in
/// `EditableParagraphLayer` — the text literally doesn't render, so
/// the background underneath (gradient, photo, border) comes
/// through with 100% fidelity.
///
/// `scale` semantics match [`render_page_to_png`] — 1.5× on US-Letter
/// gives a 918×1188 PNG for apples-to-apples diff against the
/// mask-based render.
///
/// Returns PNG bytes. Errors if pdfium refuses the object-mutation
/// on this document (rare — only flagged PDFs with content-stream
/// protections).
///
/// **S6.5:** three issues had to be threaded to make this work on
/// native pdfium 7357 + pdfium-render 0.8.37:
///
/// 1. Load via `load_pdf_from_byte_vec` rather than `load_pdf_from_file`
///    so pdfium owns a contiguous memory buffer (the custom
///    file-accessor callback from reader-backed loads has been
///    unstable for mutation in past versions).
/// 2. Set content-regeneration strategy to `Manual`. We don't need the
///    content stream rewritten — render walks the live object list
///    directly — and skipping `FPDFPage_GenerateContent` shaves the
///    per-mutation overhead.
/// 3. `std::mem::forget` each `PdfPageObject` returned by
///    `remove_object_at_index`. pdfium's `FPDFPage_RemoveObject`
///    destroys the underlying object before returning, but
///    pdfium-render's `Drop` impl then calls `FPDFPageObj_Destroy`
///    on the wrapper — a classic double-free that manifests as
///    `STATUS_ILLEGAL_INSTRUCTION` on Windows. See the inline comment
///    on the mem::forget call for the full trace.
///
/// Empty-skip callers still go through the fast `load_pdf_from_file`
/// path — identical bytes guaranteed against `render_page_to_png`.
pub fn render_page_to_png_with_skips(
    pdf_path: &str,
    page_index: u16,
    scale: f32,
    skip_bboxes: &[SkipBbox],
) -> Result<Vec<u8>> {
    // Fast path: with no skips, round-trip through the plain renderer
    // so empty-skip output is byte-identical (see the
    // `selective_op_empty_skips_matches_full_render` test). This also
    // keeps the zero-edit hot path off the byte-vec allocation below.
    if skip_bboxes.is_empty() {
        return render_page_to_png(pdf_path, page_index, scale);
    }
    let bytes =
        std::fs::read(pdf_path).map_err(|e| AppError::Pdf(format!("read {pdf_path}: {e}")))?;
    render_page_to_png_with_skips_from_bytes(bytes, page_index, scale, skip_bboxes)
}

/// Same as [`render_page_to_png_with_skips`] but takes the PDF bytes
/// directly. Used by the IPC command the frontend calls from
/// `EditableParagraphLayer` — the frontend holds the in-memory bytes
/// (with any staged edits already merged), so routing through a temp
/// file would both add latency and miss uncommitted state.
pub fn render_page_to_png_with_skips_from_bytes(
    bytes: Vec<u8>,
    page_index: u16,
    scale: f32,
    skip_bboxes: &[SkipBbox],
) -> Result<Vec<u8>> {
    if scale <= 0.0 || !scale.is_finite() {
        return Err(AppError::InvalidArgument(format!(
            "render scale must be positive and finite (got {scale})"
        )));
    }

    with_pdfium(move |pdfium| {
        let document = pdfium
            .load_pdf_from_byte_vec(bytes, None)
            .map_err(|e| AppError::Pdf(format!("load pdf (byte-vec): {e}")))?;

        let pages = document.pages();
        let mut page = pages
            .get(page_index)
            .map_err(|e| AppError::Pdf(format!("page {page_index}: {e}")))?;

        // Opt out of auto-regenerate-after-mutate. Render reads the
        // in-memory object list, not the content stream, so stripped
        // text is invisible in output without needing a regen pass.
        page.set_content_regeneration_strategy(PdfPageContentRegenerationStrategy::Manual);

        let _removed = remove_text_objects_in_regions(&mut page, skip_bboxes)?;

        let width_pts = page.width().value;
        let height_pts = page.height().value;
        let width_px = (width_pts * scale).round() as i32;
        let height_px = (height_pts * scale).round() as i32;

        let render_config = PdfRenderConfig::new()
            .set_target_width(width_px)
            .set_target_height(height_px)
            .render_form_data(true);

        let bitmap = page
            .render_with_config(&render_config)
            .map_err(|e| AppError::Pdf(format!("render page {page_index}: {e}")))?;

        let dyn_image = bitmap.as_image();
        let mut png_bytes: Vec<u8> = Vec::new();
        {
            use image::ImageFormat;
            use std::io::Cursor;
            dyn_image
                .write_to(&mut Cursor::new(&mut png_bytes), ImageFormat::Png)
                .map_err(|e| AppError::Pdf(format!("encode PNG: {e}")))?;
        }

        Ok(png_bytes)
    })
}

/// Walk `page`'s text objects, remove those overlapping any
/// `skip_bbox`, return the count of objects removed. Non-text
/// objects (paths, images, form XObjects) are left untouched —
/// we never want to strip background graphics.
///
/// Caller is responsible for loading the document via
/// `load_pdf_from_byte_vec` and setting the page's content
/// regeneration strategy to Manual — otherwise pdfium's auto-regen
/// hook crashes with STATUS_ILLEGAL_INSTRUCTION on file-backed docs.
fn remove_text_objects_in_regions(page: &mut PdfPage, skip_bboxes: &[SkipBbox]) -> Result<usize> {
    if skip_bboxes.is_empty() {
        return Ok(0);
    }

    // First pass (immutable borrow): collect the indices of text
    // objects whose bounds overlap any skip bbox.
    let mut to_remove: Vec<PdfPageObjectIndex> = Vec::new();
    {
        let objects = page.objects();
        for idx in 0..objects.len() {
            let Ok(obj) = objects.get(idx) else { continue };
            if obj.object_type() != PdfPageObjectType::Text {
                continue;
            }
            let Ok(bounds) = obj.bounds() else { continue };
            if bounds_overlaps_any(&bounds, skip_bboxes) {
                to_remove.push(idx);
            }
        }
    }

    if to_remove.is_empty() {
        return Ok(0);
    }

    // Second pass (mutable borrow): remove from highest index down so
    // earlier removals don't shift indices we still need. Failed
    // removals (stale index, etc.) are skipped rather than aborting —
    // partial strip is still better than no strip.
    let mut removed = 0usize;
    {
        let objects_mut = page.objects_mut();
        for idx in to_remove.iter().rev().copied() {
            if let Ok(removed_obj) = objects_mut.remove_object_at_index(idx) {
                // pdfium-render's Drop impl on an unowned PdfPageObject
                // calls FPDFPageObj_Destroy. But pdfium's
                // FPDFPage_RemoveObject has already destroyed the
                // underlying object — letting Drop run is a double-free
                // that crashes with STATUS_ILLEGAL_INSTRUCTION on
                // Windows. Forget the wrapper to skip Drop; the struct
                // itself is a handful of bytes on the stack and the
                // underlying C memory is already freed.
                std::mem::forget(removed_obj);
                removed += 1;
            }
        }
    }

    Ok(removed)
}

fn bounds_overlaps_any(bounds: &PdfQuadPoints, bboxes: &[SkipBbox]) -> bool {
    let obj_left = bounds.left().value;
    let obj_right = bounds.right().value;
    let obj_bottom = bounds.bottom().value;
    let obj_top = bounds.top().value;

    for b in bboxes {
        let bx0 = b.x;
        let bx1 = b.x + b.width;
        let by0 = b.y;
        let by1 = b.y + b.height;
        // Axis-aligned overlap check.
        let overlaps_x = obj_right >= bx0 && obj_left <= bx1;
        let overlaps_y = obj_top >= by0 && obj_bottom <= by1;
        if overlaps_x && overlaps_y {
            return true;
        }
    }
    false
}

/// Discovery pass: list every text object on a page with its bounds
/// in PDF-point space. EditableParagraphLayer can map its paragraph
/// bboxes against this list to compute skip sets at cluster time.
#[derive(Debug, Clone, serde::Serialize)]
pub struct PageTextObjectInfo {
    pub index: u32,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub text_preview: String,
}

pub fn list_page_text_objects(pdf_path: &str, page_index: u16) -> Result<Vec<PageTextObjectInfo>> {
    with_pdfium(|pdfium| {
        let document = pdfium
            .load_pdf_from_file(pdf_path, None)
            .map_err(|e| AppError::Pdf(format!("load {pdf_path}: {e}")))?;
        let pages = document.pages();
        let page = pages
            .get(page_index)
            .map_err(|e| AppError::Pdf(format!("page {page_index}: {e}")))?;

        let objects = page.objects();
        let mut out = Vec::new();
        for idx in 0..objects.len() {
            let Ok(obj) = objects.get(idx) else { continue };
            if obj.object_type() != PdfPageObjectType::Text {
                continue;
            }
            let Ok(bounds) = obj.bounds() else { continue };
            // Note: we don't populate `text_preview` — calling
            // `as_text_object().text()` on documents loaded via
            // `load_pdf_from_file` has triggered STATUS_ILLEGAL_INSTRUCTION
            // in native pdfium. Frontend doesn't need the preview for
            // bbox→paragraph matching; leaving it empty is safe.
            out.push(PageTextObjectInfo {
                index: idx as u32,
                x: bounds.left().value,
                y: bounds.bottom().value,
                width: bounds.right().value - bounds.left().value,
                height: bounds.top().value - bounds.bottom().value,
                text_preview: String::new(),
            });
        }
        Ok(out)
    })
}
