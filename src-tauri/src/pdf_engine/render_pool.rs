//! Multi-process pdfium render pool.
//!
//! Why a pool of subprocesses (and not threads):
//!
//! pdfium-render's `thread_safe` Cargo feature wraps every native call
//! in a global mutex. The underlying C++ library keeps significant
//! per-document mutable state and is not safe to enter from multiple
//! threads concurrently. So spawning 8 tokio tasks each calling
//! `render_page_to_png` does the same work as one task calling it 8
//! times in a loop — the mutex serializes them.
//!
//! The fix is to run pdfium in N separate OS processes. Each process
//! has its own copy of the library and its own (process-local) mutex,
//! so 8 of them produce real 8× parallelism on an 8-core box.
//!
//! Architecture:
//!
//!   • One `[[bin]] pdfium_worker` target (see
//!     `src-tauri/src/bin/pdfium_worker.rs`) reads framed JSON
//!     requests on stdin and writes PNG (or error) bytes on stdout.
//!   • `PdfiumPool` holds N `Mutex<WorkerSlot>`. Each slot lazily
//!     spawns + adopts a child the first time it's needed.
//!   • `PdfiumPool::render` does try-lock-round-robin to find a free
//!     worker; if all are busy, blocks on the next-in-line.
//!   • Worker death (panic, OOM, killed) on a request: the pool
//!     drops the dead Child, the next call to that slot respawns.
//!
//! All of this is synchronous on the caller's side so it slots into
//! the existing `tokio::task::spawn_blocking` pattern in
//! `commands::engine`. No async-IO-with-subprocesses gymnastics.

use crate::error::AppError;
use crate::Result;
use once_cell::sync::Lazy;
use serde::Serialize;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Debug, Serialize)]
struct RenderRequest {
    path: String,
    page_index: u16,
    scale: f32,
}

struct WorkerSlot {
    child: Option<Child>,
}

pub struct PdfiumPool {
    workers: Vec<Mutex<WorkerSlot>>,
    /// Round-robin index used when every slot is contended.
    next: AtomicUsize,
    /// Path to the worker exe; resolved once at construction.
    worker_exe: PathBuf,
}

impl PdfiumPool {
    /// Construct a pool with `n_workers` slots. Workers are not
    /// spawned until first use — pool construction is a few hundred
    /// nanoseconds.
    pub fn new(n_workers: usize) -> Result<Self> {
        if n_workers == 0 {
            return Err(AppError::InvalidArgument("pool size must be > 0".into()));
        }
        let worker_exe = locate_worker_exe()?;
        let mut workers = Vec::with_capacity(n_workers);
        for _ in 0..n_workers {
            workers.push(Mutex::new(WorkerSlot { child: None }));
        }
        Ok(Self {
            workers,
            next: AtomicUsize::new(0),
            worker_exe,
        })
    }

    /// Override the worker binary path. Used by tests so they can
    /// point at a `pdfium_worker_mock` fixture instead of needing
    /// pdfium.dll loaded.
    #[cfg(test)]
    pub fn new_with_exe(n_workers: usize, exe: PathBuf) -> Result<Self> {
        if n_workers == 0 {
            return Err(AppError::InvalidArgument("pool size must be > 0".into()));
        }
        let mut workers = Vec::with_capacity(n_workers);
        for _ in 0..n_workers {
            workers.push(Mutex::new(WorkerSlot { child: None }));
        }
        Ok(Self {
            workers,
            next: AtomicUsize::new(0),
            worker_exe: exe,
        })
    }

    /// Render a page via one of the workers. Synchronous; intended
    /// to be called inside `tokio::task::spawn_blocking` so multiple
    /// concurrent jobs can each grab a different worker slot.
    pub fn render(&self, path: &str, page_index: u16, scale: f32) -> Result<Vec<u8>> {
        // First pass: prefer a free slot, so concurrent jobs spread
        // across workers instead of all queueing on slot[0].
        for slot in &self.workers {
            if let Ok(mut guard) = slot.try_lock() {
                return self.render_with_slot(&mut guard, path, page_index, scale);
            }
        }
        // Every slot busy — round-robin pick and wait for it.
        let idx = self.next.fetch_add(1, Ordering::Relaxed) % self.workers.len();
        let mut guard = self.workers[idx]
            .lock()
            .map_err(|_| AppError::Pdf("pdfium pool slot poisoned".into()))?;
        self.render_with_slot(&mut guard, path, page_index, scale)
    }

    /// Pool size. Stable for the lifetime of the pool.
    pub fn len(&self) -> usize {
        self.workers.len()
    }

    fn render_with_slot(
        &self,
        slot: &mut WorkerSlot,
        path: &str,
        page_index: u16,
        scale: f32,
    ) -> Result<Vec<u8>> {
        // Lazy spawn / respawn after death.
        if slot.child.is_none() {
            slot.child = Some(spawn_worker(&self.worker_exe)?);
        }
        let child = slot.child.as_mut().expect("just spawned");

        let req = RenderRequest {
            path: path.to_string(),
            page_index,
            scale,
        };
        let body = serde_json::to_vec(&req)
            .map_err(|e| AppError::Pdf(format!("serialize render request: {e}")))?;

        // Write the request frame; on I/O error assume the worker
        // died, drop it, propagate. Next call to this slot will
        // respawn. Returning the error rather than respawning
        // immediately means a poison-PDF (one that crashes pdfium)
        // surfaces to the caller as an error instead of looping.
        let stdin = child
            .stdin
            .as_mut()
            .ok_or_else(|| AppError::Pdf("worker stdin missing".into()))?;
        if let Err(e) = (|| -> std::io::Result<()> {
            stdin.write_all(&(body.len() as u32).to_be_bytes())?;
            stdin.write_all(&body)?;
            stdin.flush()?;
            Ok(())
        })() {
            slot.child = None;
            return Err(AppError::Pdf(format!("worker write: {e}")));
        }

        let stdout = child
            .stdout
            .as_mut()
            .ok_or_else(|| AppError::Pdf("worker stdout missing".into()))?;
        let mut status = [0u8; 1];
        let mut len_buf = [0u8; 4];
        let response: std::io::Result<Vec<u8>> = (|| {
            stdout.read_exact(&mut status)?;
            stdout.read_exact(&mut len_buf)?;
            let len = u32::from_be_bytes(len_buf) as usize;
            // 64 MB sanity cap — a US-letter PNG at 4× is ~20 MB.
            // Anything larger is a corrupted frame.
            if len > 67_108_864 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("response body too large: {len}"),
                ));
            }
            let mut body = vec![0u8; len];
            stdout.read_exact(&mut body)?;
            Ok(body)
        })();
        let body = match response {
            Ok(b) => b,
            Err(e) => {
                // Worker stdout pipe broke — assume it crashed. Drop
                // it so the next request respawns.
                slot.child = None;
                return Err(AppError::Pdf(format!("worker read: {e}")));
            }
        };
        if status[0] == 0 {
            Ok(body)
        } else {
            let msg = String::from_utf8_lossy(&body).to_string();
            Err(AppError::Pdf(format!("worker error: {msg}")))
        }
    }
}

impl Drop for PdfiumPool {
    fn drop(&mut self) {
        for slot in &self.workers {
            if let Ok(mut g) = slot.lock() {
                if let Some(mut child) = g.child.take() {
                    // Closing stdin lets the worker exit cleanly.
                    drop(child.stdin.take());
                    let _ = child.wait();
                }
            }
        }
    }
}

fn spawn_worker(exe: &PathBuf) -> Result<Child> {
    let mut cmd = Command::new(exe);
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    // Inherit stderr so worker panics surface in the parent's log.
    cmd.stderr(Stdio::inherit());
    cmd.spawn()
        .map_err(|e| AppError::Pdf(format!("spawn pdfium_worker {}: {e}", exe.display())))
}

fn locate_worker_exe() -> Result<PathBuf> {
    // The worker is built as a peer bin target in the same
    // target/{debug,release} directory as the main exe. In dev
    // (cargo run / `npm run tauri dev`) and release alike, that's
    // the parent of `current_exe()`.
    //
    // Allow override via env var — useful for tests that want to
    // point at a fixture binary.
    if let Ok(p) = std::env::var("OS_PDFIUM_WORKER_EXE") {
        let p = PathBuf::from(p);
        if !p.exists() {
            return Err(AppError::Pdf(format!(
                "OS_PDFIUM_WORKER_EXE points at non-existent {}",
                p.display()
            )));
        }
        return Ok(p);
    }

    let current =
        std::env::current_exe().map_err(|e| AppError::Pdf(format!("current_exe: {e}")))?;
    let dir = current
        .parent()
        .ok_or_else(|| AppError::Pdf("current_exe has no parent".into()))?;
    let candidate = if cfg!(windows) {
        dir.join("pdfium_worker.exe")
    } else {
        dir.join("pdfium_worker")
    };
    if !candidate.exists() {
        return Err(AppError::Pdf(format!(
            "pdfium_worker not found at {} — was the bin target built?",
            candidate.display()
        )));
    }
    Ok(candidate)
}

fn default_pool_size() -> usize {
    // Each pool worker is its own pdfium_worker.exe — pdfium.dll
    // (~15MB resident) plus the most-recently-rendered doc kept in
    // the worker's own per-process cache. On a 33MB doc that's
    // ~50MB per worker. The previous clamp of [2, 8] meant 8
    // workers × 50MB = 400MB of resident pool memory on big-doc
    // sessions, plus the IPC pipe buffers. Cut the upper clamp to
    // 4 — pdfium itself serializes per-process so going past 4 buys
    // little parallelism beyond the typical ±1 active-page window
    // anyway, and the memory savings let the editor breathe on
    // landscape docs the size of a brand-guidelines.pdf.
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .clamp(2, 4)
}

/// Process-global pool. Lazy because pool construction needs to
/// resolve the worker exe path which we don't want to do at static
/// init time (env vars, current_exe etc. may not be ready).
///
/// Stored as `Arc<PdfiumPool>` inside a `Mutex<Option<...>>` so the
/// init mutex is released as soon as we've cloned the Arc out.
/// Holding the init mutex during the actual render would serialize
/// every render call through this lock — defeating the entire
/// purpose of the pool. The pool's internal per-worker
/// `Mutex<WorkerSlot>` is what serializes one-render-per-worker;
/// nothing above that should hold a global lock.
///
/// `Mutex<Option<...>>` rather than `OnceCell` so a failed init can
/// be retried — useful in dev where the worker bin might not be
/// built yet on first call.
static POOL: Lazy<Mutex<Option<Arc<PdfiumPool>>>> = Lazy::new(|| Mutex::new(None));

/// Acquire a clone of the global pool's `Arc`, initializing the pool
/// on first call. The init mutex is released BEFORE we return — the
/// caller now holds an `Arc<PdfiumPool>` that doesn't touch any
/// global lock for subsequent renders.
fn pool_handle() -> Result<Arc<PdfiumPool>> {
    let mut guard = POOL
        .lock()
        .map_err(|_| AppError::Pdf("pool init mutex poisoned".into()))?;
    if let Some(p) = guard.as_ref() {
        return Ok(Arc::clone(p));
    }
    let n = std::env::var("OS_PDFIUM_POOL_WORKERS")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|&n| n > 0)
        .unwrap_or_else(default_pool_size);
    let arc = Arc::new(PdfiumPool::new(n)?);
    *guard = Some(Arc::clone(&arc));
    Ok(arc)
}

/// Render a page via the global pool. Synchronous — call from
/// `spawn_blocking`. Returns PNG bytes.
pub fn render_via_pool(path: &str, page_index: u16, scale: f32) -> Result<Vec<u8>> {
    let pool = pool_handle()?;
    pool.render(path, page_index, scale)
}

/// Diagnostic: configured pool size. Returns 0 if not yet initialised.
pub fn pool_size() -> usize {
    POOL.lock()
        .ok()
        .and_then(|g| g.as_ref().map(|p| p.len()))
        .unwrap_or(0)
}

/// Tear down the global pool. Used by the Tauri shutdown hook so
/// child processes don't outlive the parent on a forced quit.
pub fn shutdown_pool() {
    if let Ok(mut g) = POOL.lock() {
        *g = None;
    }
}

/// Reap every idle worker child. Unlike [`shutdown_pool`] this
/// keeps the pool struct alive (next render call will lazily
/// respawn) — it just frees the OS-level child processes that are
/// not actively rendering.
///
/// Use this from a tab-close path: after the user closes the heavy
/// 33 MB doc we don't need 4 pdfium_worker.exe processes each
/// pinning ~50 MB of resident memory until app quit. They'll
/// respawn within microseconds when the next render fires.
///
/// Workers currently mid-render are skipped (try_lock fails); they
/// get reaped on a subsequent call once they're done.
pub fn reap_idle_workers() -> usize {
    let pool = match POOL.lock() {
        Ok(g) => match g.as_ref() {
            Some(p) => Arc::clone(p),
            None => return 0,
        },
        Err(_) => return 0,
    };
    let mut reaped = 0usize;
    for slot in &pool.workers {
        if let Ok(mut guard) = slot.try_lock() {
            if let Some(mut child) = guard.child.take() {
                drop(child.stdin.take());
                let _ = child.wait();
                reaped += 1;
            }
        }
    }
    reaped
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_pool_size_clamps() {
        let n = default_pool_size();
        assert!(n >= 2 && n <= 8, "default {n} out of [2, 8]");
    }

    #[test]
    fn rejects_zero_workers() {
        let r = PdfiumPool::new_with_exe(0, PathBuf::from("nonexistent"));
        assert!(r.is_err());
    }

    #[test]
    fn render_request_serialisation_is_stable() {
        // The wire protocol the worker depends on. If this changes
        // and the worker isn't updated, the worker will
        // misinterpret requests in subtle ways. Lock it down.
        let req = RenderRequest {
            path: "/tmp/foo.pdf".to_string(),
            page_index: 3,
            scale: 1.5,
        };
        let s = serde_json::to_string(&req).unwrap();
        assert!(s.contains("\"path\":\"/tmp/foo.pdf\""));
        assert!(s.contains("\"page_index\":3"));
        assert!(s.contains("\"scale\":1.5"));
    }

    /// Process-wide mutex serializes env-var manipulation across the
    /// override tests. Cargo's test runner is multi-threaded; without
    /// this serialization, two tests that mutate the same env var
    /// race in non-deterministic ways (one removes the var while
    /// another's read in flight).
    fn env_test_lock() -> std::sync::MutexGuard<'static, ()> {
        use std::sync::Mutex;
        static LOCK: Mutex<()> = Mutex::new(());
        LOCK.lock().unwrap_or_else(|p| p.into_inner())
    }

    #[test]
    fn locate_worker_respects_env_override() {
        let _g = env_test_lock();
        // Point at an existing path (this very test binary).
        let me = std::env::current_exe().unwrap();
        std::env::set_var("OS_PDFIUM_WORKER_EXE", &me);
        let r = locate_worker_exe();
        std::env::remove_var("OS_PDFIUM_WORKER_EXE");
        assert!(r.is_ok());
        assert_eq!(r.unwrap(), me);
    }

    #[test]
    fn locate_worker_rejects_missing_override() {
        let _g = env_test_lock();
        std::env::set_var("OS_PDFIUM_WORKER_EXE", "/this/path/will/not/exist/zzz.exe");
        let r = locate_worker_exe();
        std::env::remove_var("OS_PDFIUM_WORKER_EXE");
        assert!(r.is_err());
    }

    #[test]
    fn pool_size_zero_before_init() {
        // ensure_pool hasn't been called, pool_size reports 0.
        // This test must run before any other test triggers init.
        // We can't actually guarantee that with cargo's parallel
        // test runner — but pool_size() should never panic in any
        // case. Smoke-test that property.
        let n = pool_size();
        assert!(n == 0 || n >= 2);
    }
}
