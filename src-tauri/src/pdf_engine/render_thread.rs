//! Dedicated pdfium render thread — IPC isolation.
//!
//! pdfium's C library corrupts Tauri's IPC thread pool when called
//! from `tokio::task::spawn_blocking`: after any render,
//! `@tauri-apps/plugin-fs` operations (`readFile`, `writeFile`)
//! hang indefinitely. The handler loop stays responsive for non-IPC
//! operations, but file access never returns.
//!
//! This module spawns a single long-lived OS thread that owns ALL
//! in-process pdfium calls. Callers submit work via a channel and
//! await the result via `tokio::sync::oneshot`. pdfium never touches
//! any thread managed by Tauri or tokio.
//!
//! The multi-process render pool (`render_pool.rs`) remains the
//! primary path for cached file-based renders (LRU cache, prefetch,
//! concurrent batch). This thread handles everything else:
//! selective-op renders, bytes-based renders, page counts,
//! text-object enumeration, and verify strip-text operations.

use crate::error::AppError;
use crate::Result;
use once_cell::sync::OnceCell;
use std::sync::mpsc;

type Work = Box<dyn FnOnce() + Send>;

static SENDER: OnceCell<mpsc::Sender<Work>> = OnceCell::new();

fn get_sender() -> Result<&'static mpsc::Sender<Work>> {
    SENDER.get_or_try_init(|| {
        let (tx, rx) = mpsc::channel::<Work>();
        std::thread::Builder::new()
            .name("pdfium-render".into())
            .spawn(move || {
                while let Ok(work) = rx.recv() {
                    work();
                }
            })
            .map_err(|e| AppError::Pdf(format!("spawn pdfium render thread: {e}")))?;
        Ok(tx)
    })
}

/// Submit work to the dedicated pdfium thread and await the result.
///
/// The closure runs on a single long-lived OS thread that never
/// touches Tauri's async runtime. pdfium's thread-local
/// (`with_pdfium`) initializes once on this thread and is reused
/// for every subsequent call.
pub async fn submit<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let boxed: Work = Box::new(move || {
        let _ = tx.send(work());
    });
    get_sender()?
        .send(boxed)
        .map_err(|_| AppError::Pdf("pdfium render thread dead".into()))?;
    rx.await
        .map_err(|_| AppError::Pdf("pdfium render thread dropped reply".into()))?
}

/// Synchronous variant of [`submit`] for callers already inside
/// `spawn_blocking`. Blocks the calling thread until the dedicated
/// pdfium thread completes the work.
///
/// Used by `render_cache::get_or_render`'s pool-failure fallback:
/// the cache is called from `spawn_blocking`, so we can't `.await`.
/// Blocking a `spawn_blocking` thread is fine — that's what it's for.
pub fn submit_blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    let (tx, rx) = std::sync::mpsc::channel();
    let boxed: Work = Box::new(move || {
        let _ = tx.send(work());
    });
    get_sender()?
        .send(boxed)
        .map_err(|_| AppError::Pdf("pdfium render thread dead".into()))?;
    rx.recv()
        .map_err(|_| AppError::Pdf("pdfium render thread dropped reply".into()))?
}
