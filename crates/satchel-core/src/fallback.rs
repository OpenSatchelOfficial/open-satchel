//! Fallback observability — "a pass that needed a fallback is not a
//! perfect pass."
//!
//! Production code paths sometimes degrade gracefully: a missing
//! glyph bound gets estimated, a non-canonical BER envelope gets
//! normalized before parsing, an undecodable XMP stream falls back
//! to raw bytes. In production that graceful degradation is correct
//! behavior; in TESTS it silently converts "the primary path broke"
//! into a green checkmark.
//!
//! This module makes fallbacks first-class events:
//!
//! - library code calls [`record`] at every fallback site (no-op
//!   unless a capture scope is active, so production pays one
//!   thread-local read);
//! - tests and tools wrap work in [`capture`] and either assert the
//!   event list is empty (strict: fallback == failure) or assert a
//!   SPECIFIC fallback fired (when the fallback itself is under
//!   test);
//! - `satchel --strict` (CLI) exits non-zero when any fallback fired
//!   and lists them, so harnesses can treat fallback usage as
//!   failure without parsing logs.
//!
//! Scoping is per-thread. Code that fans work out to other threads
//! must capture on those threads — fine for the current single-
//! threaded core (discipline rule 4 works in our favor here).

use std::cell::RefCell;

/// One recorded fallback occurrence.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct FallbackEvent {
    /// Stable machine-readable site id, dotted lowercase —
    /// e.g. `"pdfium.font_size.bounds_height"`, `"cms.ber_normalized"`.
    pub area: String,
    /// Human-readable context (which char, which stream, sizes…).
    pub detail: String,
}

thread_local! {
    static SINK: RefCell<Option<Vec<FallbackEvent>>> = const { RefCell::new(None) };
}

/// Record a fallback occurrence at a degraded code path.
///
/// No-op when no [`capture`] scope is active on this thread, so
/// production callers pay only a thread-local read.
pub fn record(area: &'static str, detail: impl Into<String>) {
    SINK.with(|sink| {
        if let Some(events) = sink.borrow_mut().as_mut() {
            events.push(FallbackEvent {
                area: area.to_string(),
                detail: detail.into(),
            });
        }
    });
}

/// Run `f` with fallback capture active on this thread; returns the
/// result together with every fallback recorded during the run.
///
/// Nested captures stack: the inner scope takes the events recorded
/// while it is active; the outer scope resumes afterwards and ALSO
/// receives a copy of the inner events (a fallback inside a nested
/// scope is still a fallback of the outer operation).
///
/// Unwind-safe: if `f` panics, the previous sink is restored before
/// the panic propagates (the in-flight events are discarded — the
/// panic itself is the signal). Without this, a panic inside a
/// pooled worker thread (tokio `spawn_blocking` catches panics and
/// reuses the thread) would leave a zombie sink installed forever,
/// silently swallowing every later capture on that thread.
pub fn capture<R>(f: impl FnOnce() -> R) -> (R, Vec<FallbackEvent>) {
    struct RestoreGuard {
        /// `Some(previous)` while armed; taken on the normal path so
        /// Drop only restores during an unwind.
        previous: Option<Option<Vec<FallbackEvent>>>,
    }
    impl Drop for RestoreGuard {
        fn drop(&mut self) {
            if let Some(previous) = self.previous.take() {
                SINK.with(|sink| *sink.borrow_mut() = previous);
            }
        }
    }

    let previous = SINK.with(|sink| sink.borrow_mut().replace(Vec::new()));
    let mut guard = RestoreGuard {
        previous: Some(previous),
    };
    let result = f();
    let previous = guard
        .previous
        .take()
        .expect("guard still armed on the normal path");
    let events = SINK.with(|sink| {
        let inner = sink.borrow_mut().take().unwrap_or_default();
        *sink.borrow_mut() = previous;
        inner
    });
    // Propagate to the enclosing scope, if any.
    SINK.with(|sink| {
        if let Some(outer) = sink.borrow_mut().as_mut() {
            outer.extend(events.iter().cloned());
        }
    });
    (result, events)
}

/// Test helper: run `f` and PANIC if any fallback fired — the
/// strict "fallback usage is failure" mode.
///
/// Use in golden tests where the primary path must carry the whole
/// fixture. When a fallback is itself under test, use [`capture`]
/// and assert on the event list instead.
pub fn assert_no_fallbacks<R>(context: &str, f: impl FnOnce() -> R) -> R {
    let (result, events) = capture(f);
    assert!(
        events.is_empty(),
        "{context}: expected a fallback-free run, but {} fallback(s) fired:\n{}",
        events.len(),
        events
            .iter()
            .map(|e| format!("  - [{}] {}", e.area, e.detail))
            .collect::<Vec<_>>()
            .join("\n")
    );
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_outside_capture_is_noop() {
        record("test.noop", "nothing listening");
        let ((), events) = capture(|| {});
        assert!(events.is_empty());
    }

    #[test]
    fn capture_collects_events_in_order() {
        let ((), events) = capture(|| {
            record("test.a", "first");
            record("test.b", "second");
        });
        assert_eq!(
            events.iter().map(|e| e.area.as_str()).collect::<Vec<_>>(),
            vec!["test.a", "test.b"]
        );
        assert_eq!(events[0].detail, "first");
    }

    #[test]
    fn nested_capture_takes_inner_and_propagates_to_outer() {
        let ((), outer) = capture(|| {
            record("test.outer", "before");
            let ((), inner) = capture(|| record("test.inner", "x"));
            assert_eq!(inner.len(), 1);
            assert_eq!(inner[0].area, "test.inner");
        });
        let areas: Vec<&str> = outer.iter().map(|e| e.area.as_str()).collect();
        assert_eq!(areas, vec!["test.outer", "test.inner"]);
    }

    #[test]
    #[should_panic(expected = "fallback-free run")]
    fn assert_no_fallbacks_panics_on_fallback() {
        assert_no_fallbacks("strict test", || record("test.boom", "degraded"));
    }

    #[test]
    fn assert_no_fallbacks_passes_clean_runs() {
        let v = assert_no_fallbacks("clean", || 42);
        assert_eq!(v, 42);
    }

    #[test]
    fn capture_restores_sink_after_panic() {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            capture(|| {
                record("test.pre_panic", "recorded then boom");
                panic!("boom");
            })
        }));
        assert!(result.is_err());
        // The unwind must have uninstalled the sink: a record outside
        // any capture is a no-op, and a fresh capture starts empty
        // (no zombie events from the panicked scope).
        record("test.after_panic", "must be a no-op");
        let ((), events) = capture(|| record("test.fresh", "y"));
        assert_eq!(
            events.iter().map(|e| e.area.as_str()).collect::<Vec<_>>(),
            vec!["test.fresh"]
        );
    }

    #[test]
    fn nested_capture_panic_restores_outer_scope() {
        let ((), outer) = capture(|| {
            record("test.outer_before", "a");
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                capture(|| {
                    record("test.inner", "x");
                    panic!("inner boom");
                })
            }));
            // Outer scope must still be live and collecting; the
            // panicked inner scope's events are discarded.
            record("test.outer_after", "b");
        });
        let areas: Vec<&str> = outer.iter().map(|e| e.area.as_str()).collect();
        assert_eq!(areas, vec!["test.outer_before", "test.outer_after"]);
    }
}
