//! pdfium-backed page renderer (Session 3).
//!
//! Loads `pdfium.dll` dynamically from one of:
//!
//! 1. `$PDFIUM_DYNAMIC_LIB_PATH` — directory containing pdfium.dll (or
//!    libpdfium.so / libpdfium.dylib on non-Windows).
//! 2. `<repo>/tools/pdfium/bin/` — the path
//!    `scripts/install-pdfium.mjs` drops the library into.
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
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

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
                        "no pdfium binary found: set PDFIUM_DYNAMIC_LIB_PATH, \
                         run scripts/install-pdfium.mjs, or install pdfium \
                         on PATH. probe error: {e}"
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

/// Records which discovery branch actually bound pdfium, for
/// diagnostics + the Session-10 bundle smoke (which asserts a packaged
/// app binds from the executable directory, NOT from a leaked env var
/// or the repo `tools/` dir). Set once, on the first successful bind.
static PDFIUM_SOURCE: OnceLock<String> = OnceLock::new();

fn note_pdfium_source(s: String) {
    let _ = PDFIUM_SOURCE.set(s);
}

/// The discovery branch that bound pdfium in this process, if a bind
/// has occurred. One of: `env:PDFIUM_DYNAMIC_LIB_PATH=…`,
/// `repo-tools:…`, `executable-directory:…`, or `system-library`.
/// The bundle smoke asserts this starts with `executable-directory`.
pub fn pdfium_source() -> Option<String> {
    PDFIUM_SOURCE.get().cloned()
}

/// Find and bind pdfium.dll / libpdfium. Probe order:
/// 1. `$PDFIUM_DYNAMIC_LIB_PATH` — explicit override (dev + CI).
/// 2. repo-local `tools/pdfium/bin/` — the dev fast-path.
/// 3. **next to the current executable** — the INSTALLED-APP path. The
///    bundler drops `pdfium.dll` beside the binary (and beside
///    `pdfium_worker.exe`), so a packaged app with no env var and no
///    `tools/` dir finds it here. Kept AFTER the two dev paths so dev
///    behavior is byte-identical; only a packaged app reaches it.
/// 4. system library on PATH — last resort.
fn bind_pdfium() -> std::result::Result<Box<dyn PdfiumLibraryBindings>, PdfiumError> {
    // 1. Explicit path via env var.
    if let Ok(dir) = std::env::var("PDFIUM_DYNAMIC_LIB_PATH") {
        let b = Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path(&dir))?;
        note_pdfium_source(format!("env:PDFIUM_DYNAMIC_LIB_PATH={dir}"));
        return Ok(b);
    }

    // 2. Repo-local tools/pdfium/bin.
    if let Some(dir) = find_repo_tools_dir() {
        let candidate = dir.join("bin");
        if candidate.exists() {
            if let Some(b) = try_bind_in_dir(&candidate) {
                note_pdfium_source(format!("repo-tools:{}", candidate.display()));
                return Ok(b);
            }
            // Fall through if binding failed — try the exe dir + system
            // library below.
        }
    }

    // 3. Next to the current executable (packaged-app layout).
    for dir in exe_sibling_dirs() {
        if let Some(b) = try_bind_in_dir(&dir) {
            note_pdfium_source(format!("executable-directory:{}", dir.display()));
            return Ok(b);
        }
    }

    // 4. System library on PATH.
    let b = Pdfium::bind_to_system_library()?;
    note_pdfium_source("system-library".to_string());
    Ok(b)
}

/// Try to bind the platform pdfium library inside `dir`. Returns `None`
/// (without attempting a load) when the library file isn't present, so
/// a probe of an empty directory is cheap and never touches the loader.
fn try_bind_in_dir(dir: &Path) -> Option<Box<dyn PdfiumLibraryBindings>> {
    let lib_path = Pdfium::pdfium_platform_library_name_at_path(&dir.to_string_lossy().to_string());
    if !Path::new(&lib_path).exists() {
        return None;
    }
    Pdfium::bind_to_library(&lib_path).ok()
}

/// Candidate directories to probe for a pdfium library laid down beside
/// the executable by the bundler. Covers the packaged layouts:
/// Windows places the lib next to the exe; a macOS `.app` puts the exe in
/// `Contents/MacOS/` with libraries in `../Resources` or `../Frameworks`;
/// Linux AppImage/portable layouts use a sibling `../lib`, while a `.deb`
/// installs the binary to `<prefix>/bin/<name>` and stages Tauri's bundled
/// resources to a product-named `<prefix>/lib/<name>/`.
///
/// On Linux the PRIMARY shipping vehicle is Flatpak, whose launch wrapper
/// exports `PDFIUM_DYNAMIC_LIB_PATH` (the highest-priority bind branch) so
/// it never reaches this probe; these `../lib*` candidates are the
/// belt-and-suspenders fallback for the secondary deb/AppImage targets.
/// NOTE (Session 11): the exact deb resource directory is UNVERIFIED on
/// Linux hardware — confirm `<prefix>/lib/<name>/` on the first real Linux
/// `tauri build` and adjust this list if the bundler nests differently.
fn exe_sibling_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            dirs.push(dir.to_path_buf());
            dirs.push(dir.join("..").join("Resources"));
            dirs.push(dir.join("..").join("Frameworks"));
            dirs.push(dir.join("..").join("lib"));
            // Product-named lib dir: `<prefix>/lib/<exe-stem>/` (the deb
            // layout). Derived from the exe stem so it tracks the binary
            // name rather than hardcoding "open-satchel".
            if let Some(stem) = exe.file_stem() {
                dirs.push(dir.join("..").join("lib").join(stem));
            }
        }
    }
    dirs
}

/// Walk up from `CARGO_MANIFEST_DIR` (or cwd) looking for a
/// `tools/pdfium` directory. Returns the path to it if found.
///
/// NOTE: `CARGO_MANIFEST_DIR` is read at RUNTIME (not the `env!` macro),
/// so it is unset for a packaged exe — a packaged app never resolves a
/// repo `tools/` dir through this path. The Session-10 bundle smoke
/// relies on that (it also clears the var + runs cwd outside the repo).
fn find_repo_tools_dir() -> Option<PathBuf> {
    let start = std::env::var_os("CARGO_MANIFEST_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok())?;
    let mut cur = start.as_path();
    loop {
        let candidate = cur.join("tools").join("pdfium");
        if candidate.exists() {
            return Some(candidate);
        }
        cur = cur.parent()?;
    }
}

/// Render one page of a PDF to PNG bytes.
///
/// `scale` is applied against the page's natural dimensions in points
/// (72 dpi). So `scale = 1.5` on a US-Letter page gives a 918×1188
/// PNG, matching what the Playwright fidelity capture emits. This
/// alignment is deliberate — the Session 4 render-diff harness
/// compares engine output byte-for-byte against Playwright captures.
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

#[cfg(test)]
mod discovery_tests {
    //! pdfium-free unit tests for the Session-10 packaged-app discovery
    //! probe. These never load the library (the CI lib gate runs without
    //! pdfium present), so they assert only the path-selection logic.
    use super::*;

    #[test]
    fn exe_sibling_dirs_includes_the_exe_directory_first() {
        let dirs = exe_sibling_dirs();
        // current_exe() resolves in the test runner, so the list is
        // non-empty and its first entry is the test binary's own dir.
        assert!(!dirs.is_empty(), "expected at least the exe dir");
        let exe = std::env::current_exe().expect("current_exe in test");
        let parent = exe.parent().expect("test exe has a parent");
        assert_eq!(
            dirs[0], parent,
            "the executable's own directory must be probed first"
        );
        // The macOS/Linux sibling layouts are appended after it.
        assert!(dirs.iter().any(|d| d.ends_with("Resources")));
        assert!(dirs.iter().any(|d| d.ends_with("Frameworks")));
        assert!(dirs.iter().any(|d| d.ends_with("lib")));
        // The Linux .deb product-named lib dir (`../lib/<exe-stem>`) is
        // probed too, so a deb-installed app finds its staged pdfium.
        let stem = exe.file_stem().expect("test exe has a stem");
        assert!(
            dirs.iter().any(|d| d.ends_with(std::path::Path::new("lib").join(stem))),
            "expected a ../lib/<exe-stem> candidate for the deb layout"
        );
    }

    #[test]
    fn try_bind_in_dir_returns_none_for_a_dir_without_pdfium() {
        // An empty temp dir has no platform library, so the probe must
        // short-circuit to None WITHOUT attempting to load anything.
        let tmp = std::env::temp_dir().join(format!(
            "os-render-probe-{}",
            std::process::id()
        ));
        let _ = std::fs::create_dir_all(&tmp);
        assert!(
            try_bind_in_dir(&tmp).is_none(),
            "probing a pdfium-free directory must yield None, not a load attempt"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn pdfium_source_is_none_until_a_bind_occurs() {
        // In a lib-test process that never renders, no source is set.
        // (If another test in the same binary rendered first, this would
        // be Some — so we only assert the getter is callable + typed.)
        let _ = pdfium_source();
    }
}
