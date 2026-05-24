// Engine-strip render hook — calls `engine_render_page_with_skips_from_bytes`
// with the current in-memory PDF bytes + a set of paragraph bboxes to
// strip, and returns a blob URL for the resulting PNG.
//
// Used by EditableParagraphLayer to replace today's DOM-mask approach.
// Instead of covering edited paragraphs with styled divs (which breaks
// against gradient, photo, or bordered backgrounds), the engine renders
// the page WITHOUT those text objects in the first place — the
// background comes through with 100% fidelity.
//
// Usage: pass `enabled: false` or an empty `skipBboxes` to suppress
// calls. The hook debounces rapid changes (300ms default) so typing
// into a paragraph doesn't fire one IPC per keystroke.

import { invoke } from '@tauri-apps/api/core'
import { useEffect, useRef, useState } from 'react'

export interface SkipBbox {
  /** PDF-user-space (bottom-left origin) x in points. */
  x: number
  /** PDF-user-space y in points. */
  y: number
  /** Width in points. */
  width: number
  /** Height in points. */
  height: number
}

export interface EngineStripInput {
  /** Raw PDF bytes — the current in-memory document. */
  pdfBytes: Uint8Array | undefined
  /** 0-based page index. */
  pageIndex: number
  /** Render scale (1.5 matches what the pdfjs canvas uses at 100%
   *  zoom by default in this app). */
  scale: number
  /** Regions to strip, in PDF-point space. Empty means "no strip —
   *  skip the IPC entirely and return null". */
  skipBboxes: SkipBbox[]
  /** Master switch. When false, no IPC fires and pngUrl stays null.
   *  Independent of `skipBboxes.length` so callers can short-circuit
   *  on e.g. `!active` without emptying the bbox list. */
  enabled?: boolean
  /** Milliseconds of quiet time before the IPC fires. Default 300. */
  debounceMs?: number
  /** When the doc is on disk AND the in-memory bytes match disk,
   *  pass `filePath` + `isDirty=false` to take the path-based fast
   *  path: NO bytes cross IPC (only the PNG response). On a 33 MB
   *  doc this is the difference between 30 ms (path) and 1.5 s
   *  (Array.from(33MB) → JSON-array → V8 parse → Vec<u8>). When the
   *  in-memory bytes diverge from disk (any uncommitted edit), pass
   *  `isDirty=true` and the bytes-based path will be used.
   *
   *  Both unset → bytes path (legacy behavior). */
  filePath?: string | null
  isDirty?: boolean
}

export interface EngineStripOutput {
  /** blob: URL for the rendered PNG; null when no render is active.
   *  Callers can set this as an `<img src>` or draw it onto a canvas. */
  pngUrl: string | null
  /** True while an IPC call is in flight. UI can show a subtle
   *  shimmer during this window. */
  loading: boolean
  /** Last error from the IPC, if any. null once a subsequent call
   *  succeeds. */
  error: string | null
}

export function useEngineStrippedRender({
  pdfBytes,
  pageIndex,
  scale,
  skipBboxes,
  enabled = true,
  debounceMs = 300,
  filePath,
  isDirty,
}: EngineStripInput): EngineStripOutput {
  const [pngUrl, setPngUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Track the previous blob URL so we can revoke it when it's
  // replaced. Revoking prevents a small memory leak per edit.
  const prevUrlRef = useRef<string | null>(null)

  // Serialize the skip-bboxes so the effect's deps are stable. JSON
  // stringify is cheap for the sizes involved (a handful of rects).
  const skipKey = JSON.stringify(skipBboxes)

  useEffect(() => {
    const hasWork =
      enabled && pdfBytes && pdfBytes.byteLength > 0 && skipBboxes.length > 0
    if (!hasWork) {
      // Clear any stale render; revoke its URL.
      setPngUrl((url) => {
        if (url) URL.revokeObjectURL(url)
        return null
      })
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)

    const timer = setTimeout(() => {
      // Path-based fast path: when the doc is on disk AND no
      // uncommitted edits have diverged the in-memory bytes from
      // disk, ship the path string instead of 33 MB worth of JSON-
      // array-marshalled u8s. Pdfium reloads from the file path
      // (cheap — its own LRU cache + linearization-aware open) and
      // the only thing crossing IPC is the PNG body (which already
      // ships as raw octet-stream after the engine.rs Response
      // migration). This is the difference between ~30 ms and
      // ~1.5 s per render call on brand-guidelines.pdf.
      const useFilePath = !!filePath && !isDirty
      const invokePromise = useFilePath
        ? invoke<ArrayBuffer | number[] | Uint8Array>(
            'engine_render_page_with_skips',
            {
              path: filePath,
              pageIndex,
              scale,
              skipBboxes,
            },
          )
        : invoke<ArrayBuffer | number[] | Uint8Array>(
            'engine_render_page_with_skips_from_bytes',
            {
              bytes: Array.from(pdfBytes as Uint8Array),
              pageIndex,
              scale,
              skipBboxes,
            },
          )
      invokePromise
        .then((png) => {
          if (cancelled) return
          const bytes =
            png instanceof Uint8Array ? png
              : png instanceof ArrayBuffer ? new Uint8Array(png)
              : new Uint8Array(png as number[])
          const blob = new Blob([bytes], { type: 'image/png' })
          const url = URL.createObjectURL(blob)
          // Revoke the previous URL AFTER assigning the new one to
          // avoid a frame where `src` points at a revoked blob.
          const stale = prevUrlRef.current
          prevUrlRef.current = url
          setPngUrl(url)
          setError(null)
          if (stale) URL.revokeObjectURL(stale)
        })
        .catch((e: unknown) => {
          if (cancelled) return
          const msg = e instanceof Error ? e.message : String(e)
          console.warn('[engine-strip] failed:', msg)
          setError(msg)
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }, debounceMs)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfBytes, pageIndex, scale, skipKey, enabled, debounceMs, filePath, isDirty])

  // On unmount, revoke any leftover URL so the browser can GC the
  // backing blob.
  useEffect(() => {
    return () => {
      if (prevUrlRef.current) URL.revokeObjectURL(prevUrlRef.current)
      prevUrlRef.current = null
    }
  }, [])

  return { pngUrl, loading, error }
}

/**
 * Convert a frontend paragraph bbox (top-left origin, PDF-point scale
 * per the pdfParagraphs.ts convention) to an engine `SkipBbox`
 * (bottom-left origin, PDF-point scale).
 *
 * The engine's `SkipBbox` matches PDF's native user-space: origin at
 * bottom-left, y increases upward. Frontend bboxes from
 * `clusterParagraphs` come with top-left origin because they're
 * derived from pdfjs's `TextContentItem` transforms after a Y-flip.
 */
export function skipBboxFromParagraphBbox(
  paragraphBbox: { x: number; y: number; width: number; height: number },
  pageHeight: number,
): SkipBbox {
  return {
    x: paragraphBbox.x,
    y: pageHeight - (paragraphBbox.y + paragraphBbox.height),
    width: paragraphBbox.width,
    height: paragraphBbox.height,
  }
}
