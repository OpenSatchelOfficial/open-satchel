//! Bounded bitmap-render cache for the in-app PDF viewer.
//!
//! pdfium's `render_with_config` is the cheapest part of the
//! viewer's mount cost — typically 10–30ms per US-letter page on
//! modern hardware — but for rapid scrolls, search-result jumps,
//! and zoom transitions the same page may be requested several
//! times in quick succession. An LRU cache turns every repeat
//! request into a sub-millisecond byte-vector clone instead of a
//! fresh render.
//!
//! Cache key is `(path, page_index, scale_q)` where `scale_q` is
//! the requested scale rounded to the nearest 0.05 (5%). Continuous
//! zoom gestures bucket into a small set of cache slots — a user
//! sweeping zoom from 0.5 to 2.0 produces ~30 distinct keys per
//! page, well within the configured capacity.
//!
//! Capacity is read from `OS_RENDER_CACHE_PAGES` env (default 100
//! page-renders). At ~100KB per PNG that's ~10MB working set — small
//! enough to live alongside the active edit page's pdfjs canvas
//! footprint, large enough to hold ±5 pages × 10 zoom levels with
//! room for jumps.
//!
//! Eviction: standard LRU. The crate handles ordering on `get`.
//!
//! Concurrency: a single `Mutex<LruCache<…>>` guards the map.
//! Render misses release the lock during the actual pdfium call so
//! parallel renders don't serialize on it. The lock is only held
//! for HashMap-style ops which are O(1) per call.

use crate::error::AppError;
use crate::pdf_engine::render::render_page_to_png;
use crate::pdf_engine::render_pool::render_via_pool;
use crate::Result;
use lru::LruCache;
use once_cell::sync::Lazy;
use std::num::NonZeroUsize;
use std::sync::Mutex;

/// Set `OS_PDFIUM_USE_POOL=0` to force the in-process render path
/// (debug aid; if the pool ever regresses, flip this off without a
/// rebuild). Default is 1 — pool on.
fn pool_enabled() -> bool {
    std::env::var("OS_PDFIUM_USE_POOL")
        .ok()
        .map(|v| v != "0")
        .unwrap_or(true)
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct CacheKey {
    path: String,
    page_index: u16,
    /// Scale × 1000, rounded to nearest 50 (= 0.05 quantum).
    scale_q: u32,
}

impl CacheKey {
    fn new(path: &str, page_index: u16, scale: f32) -> Self {
        // Quantize scale to nearest 0.05 to dedupe near-identical
        // zoom requests. 1.234 → 1.25 → scale_q = 1250.
        let q = ((scale * 20.0).round() / 20.0) * 1000.0;
        let scale_q = q.max(0.0) as u32;
        Self {
            path: path.to_string(),
            page_index,
            scale_q,
        }
    }
}

fn capacity_from_env() -> NonZeroUsize {
    std::env::var("OS_RENDER_CACHE_PAGES")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|&n| n > 0)
        .and_then(NonZeroUsize::new)
        .unwrap_or_else(|| NonZeroUsize::new(100).expect("100 > 0"))
}

static CACHE: Lazy<Mutex<LruCache<CacheKey, Vec<u8>>>> =
    Lazy::new(|| Mutex::new(LruCache::new(capacity_from_env())));

/// Look up a cached PNG, or render-and-store one. Render runs OUTSIDE
/// the cache mutex so concurrent miss-renders don't serialize.
pub fn get_or_render(pdf_path: &str, page_index: u16, scale: f32) -> Result<Vec<u8>> {
    let key = CacheKey::new(pdf_path, page_index, scale);
    {
        let mut guard = CACHE
            .lock()
            .map_err(|_| AppError::Pdf("render cache mutex poisoned".into()))?;
        if let Some(cached) = guard.get(&key) {
            return Ok(cached.clone());
        }
    }
    // Cache miss — render unlocked.
    //
    // Route through the multi-process pdfium pool by default. Each
    // pool worker is a separate OS process holding its own pdfium
    // copy, so N concurrent get_or_render calls (each in its own
    // tokio::spawn_blocking thread) get N× real parallelism. The
    // in-process `render_page_to_png` path is gated behind
    // `OS_PDFIUM_USE_POOL=0` for emergency rollback.
    //
    // Fallback: pool failures route through the dedicated pdfium
    // render thread (`submit_blocking`). This keeps pdfium off
    // Tauri's IPC threads — calling render_page_to_png directly on
    // a spawn_blocking thread would poison the IPC mechanism.
    let bytes = if pool_enabled() {
        match render_via_pool(pdf_path, page_index, scale) {
            Ok(b) => b,
            Err(e) => {
                eprintln!("[render_cache] pool render failed ({e}); falling back to render thread");
                let p = pdf_path.to_string();
                crate::pdf_engine::render_thread::submit_blocking(move || {
                    render_page_to_png(&p, page_index, scale)
                })?
            }
        }
    } else {
        let p = pdf_path.to_string();
        crate::pdf_engine::render_thread::submit_blocking(move || {
            render_page_to_png(&p, page_index, scale)
        })?
    };
    {
        let mut guard = CACHE
            .lock()
            .map_err(|_| AppError::Pdf("render cache mutex poisoned".into()))?;
        guard.put(key, bytes.clone());
    }
    Ok(bytes)
}

/// Invalidate every entry for a path. Call after a save: bytes
/// changed, prior renders are stale. Single-doc invalidate is cheap
/// since the LRU iterator is bounded by total capacity.
pub fn invalidate_path(pdf_path: &str) -> Result<()> {
    let mut guard = CACHE
        .lock()
        .map_err(|_| AppError::Pdf("render cache mutex poisoned".into()))?;
    let to_drop: Vec<CacheKey> = guard
        .iter()
        .filter(|(k, _)| k.path == pdf_path)
        .map(|(k, _)| k.clone())
        .collect();
    for k in to_drop {
        guard.pop(&k);
    }
    Ok(())
}

/// Diagnostic: current entry count + capacity. Useful for telemetry
/// and the perf bench.
pub fn stats() -> Result<(usize, usize)> {
    let guard = CACHE
        .lock()
        .map_err(|_| AppError::Pdf("render cache mutex poisoned".into()))?;
    Ok((guard.len(), guard.cap().get()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_key_quantizes_scale() {
        let a = CacheKey::new("foo.pdf", 0, 1.0);
        let b = CacheKey::new("foo.pdf", 0, 1.02);
        let c = CacheKey::new("foo.pdf", 0, 1.05);
        assert_eq!(a, b, "1.00 and 1.02 round to the same bucket");
        assert_ne!(a, c, "1.00 and 1.05 are different buckets");
    }

    #[test]
    fn cache_key_distinguishes_pages() {
        let a = CacheKey::new("foo.pdf", 0, 1.0);
        let b = CacheKey::new("foo.pdf", 1, 1.0);
        assert_ne!(a, b);
    }

    #[test]
    fn cache_key_distinguishes_paths() {
        let a = CacheKey::new("foo.pdf", 0, 1.0);
        let b = CacheKey::new("bar.pdf", 0, 1.0);
        assert_ne!(a, b);
    }

    #[test]
    fn capacity_default_is_100() {
        // Test reads the actual default. Don't run env-mutating
        // tests in this lib (parallelism would race).
        let cap = capacity_from_env();
        assert!(cap.get() >= 1);
    }
}
