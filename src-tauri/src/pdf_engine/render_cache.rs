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
//! page-renders) AND bounded by total bytes via `OS_RENDER_CACHE_BYTES`
//! (default 128 MB). The byte bound is load-bearing: a single PNG is NOT
//! ~100KB — at high zoom a US-letter page is 5–20 MB, so 100 entries by
//! count alone could pin hundreds of MB of working set. The byte ceiling
//! evicts LRU entries after each insert until the cached PNG bytes fit.
//!
//! Eviction: standard LRU by count, plus byte-ceiling eviction after each
//! insert. The crate handles recency ordering on `get`.
//!
//! Per-doc invalidation (`invalidate_path`) drops a document's entries —
//! called on SAVE (bytes changed → prior renders stale) AND on TAB CLOSE
//! (tabStore.closeTab → engine_invalidate_render_cache) so a closed doc's
//! renders are reclaimed immediately instead of lingering until other
//! docs' renders evict them by count (gauntlet-installed I-2c).
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
    // Explicit opt-out always wins.
    if std::env::var("OS_PDFIUM_USE_POOL").ok().as_deref() == Some("0") {
        return false;
    }
    // Otherwise the pool is on ONLY if its worker sidecar can be located.
    // A packaged 1.0 build ships pdfium.dll but not the worker
    // (docs/RELEASE.md §0), so without this guard render_cache would
    // attempt + fail a worker spawn — and eprintln — on every render and
    // every prefetched page before falling back. With it, a worker-less
    // build cleanly takes the in-process render path below. (Honors the
    // OS_PDFIUM_WORKER_EXE override, since worker_available → locate_worker_exe
    // checks it first; cheap path/exists check, no spawn.)
    crate::pdf_engine::render_pool::worker_available()
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

/// Total-bytes ceiling for cached PNGs (default 128 MB). Read once.
/// The entry-COUNT cap alone does not bound memory: a single high-zoom
/// US-letter PNG is 5–20 MB, so 100 entries could pin hundreds of MB.
fn byte_ceiling_from_env() -> usize {
    std::env::var("OS_RENDER_CACHE_BYTES")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|&n| n > 0)
        .unwrap_or(128 * 1024 * 1024)
}

static BYTE_CEILING: Lazy<usize> = Lazy::new(byte_ceiling_from_env);

static CACHE: Lazy<Mutex<LruCache<CacheKey, Vec<u8>>>> =
    Lazy::new(|| Mutex::new(LruCache::new(capacity_from_env())));

/// Evict least-recently-used entries until the total cached PNG bytes are
/// under the byte ceiling, keeping at least the just-inserted entry. Caller
/// holds the cache lock.
fn evict_to_byte_ceiling(guard: &mut LruCache<CacheKey, Vec<u8>>) {
    evict_to_ceiling(guard, *BYTE_CEILING)
}

/// Ceiling-parameterized core (testable without touching the env-read
/// global). Keeps at least one entry so an oversized active render isn't
/// dropped to satisfy a ceiling smaller than itself.
fn evict_to_ceiling(guard: &mut LruCache<CacheKey, Vec<u8>>, ceiling: usize) {
    let mut total: usize = guard.iter().map(|(_, v)| v.len()).sum();
    while total > ceiling && guard.len() > 1 {
        match guard.pop_lru() {
            Some((_, evicted)) => total -= evicted.len(),
            None => break,
        }
    }
}

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
        evict_to_byte_ceiling(&mut guard);
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

    #[test]
    fn byte_ceiling_evicts_lru_until_under_limit() {
        // Capacity high enough that the COUNT cap never triggers — we want
        // to exercise the BYTE bound alone.
        let mut c: LruCache<CacheKey, Vec<u8>> = LruCache::new(NonZeroUsize::new(100).unwrap());
        // Five 10-byte entries = 50 bytes; ceiling 25 bytes must evict the
        // three oldest, leaving the two most-recently-used (30 > 25 would
        // evict a third, so 2 remain at 20 bytes ≤ 25).
        for i in 0..5u16 {
            c.put(CacheKey::new("d.pdf", i, 1.0), vec![0u8; 10]);
        }
        evict_to_ceiling(&mut c, 25);
        let total: usize = c.iter().map(|(_, v)| v.len()).sum();
        assert!(total <= 25, "total {total} should be ≤ ceiling 25");
        // Most-recently-inserted (page 4) survives; oldest (page 0) evicted.
        assert!(c.contains(&CacheKey::new("d.pdf", 4, 1.0)), "MRU kept");
        assert!(!c.contains(&CacheKey::new("d.pdf", 0, 1.0)), "LRU evicted");
    }

    #[test]
    fn byte_ceiling_keeps_at_least_one_oversized_entry() {
        // A single entry larger than the ceiling must NOT be dropped (it is
        // the active render; len()>1 guard protects it).
        let mut c: LruCache<CacheKey, Vec<u8>> = LruCache::new(NonZeroUsize::new(100).unwrap());
        c.put(CacheKey::new("d.pdf", 0, 1.0), vec![0u8; 1000]);
        evict_to_ceiling(&mut c, 10);
        assert_eq!(c.len(), 1, "the only entry survives even when oversized");
    }
}
