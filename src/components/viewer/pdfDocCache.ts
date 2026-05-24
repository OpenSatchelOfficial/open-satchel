// Per-bytes pdfjs document cache.
//
// Why: PdfViewer (active-page render), PdfSidebar (thumbnails),
// and PageRendererLight (off-screen pages) each need a
// PDFDocumentProxy for the same `pdfBytes`. Without coordination
// each component calls `pdfjsLib.getDocument({ data: bytes })`
// independently — for an N-page doc the sidebar alone runs N
// parallel parses (one per <PageThumbnail>) plus the viewer's
// parse. Each parse decompresses content streams and copies the
// bytes into a worker. On a 33 MB PDF that's enough to OOM the
// WebView V8 heap (verified on brand-guidelines.pdf).
//
// This module memoises the parse keyed by Uint8Array identity:
// the same bytes reference always returns the same document
// promise. Callers must NOT call .destroy() on the returned doc
// — the cache owns its lifetime. Callers should only call
// `releasePdfDoc(bytes)` when they're confident no other consumer
// is using it (typically: tab close, or pdfBytes replaced).
//
// Tab close → format-store entry replaced → next call to
// `getPdfDoc` for new bytes → previous entry naturally evicted
// when nothing references the old bytes (we use a WeakMap).

import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'

// Set up the worker source once. PdfViewer's usePdfDocument
// already does this; do it here too to be defensive against load
// order between the consumers.
if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.mjs',
    import.meta.url,
  ).toString()
}

// WeakMap so that when the format-store releases its reference
// to a `pdfBytes` Uint8Array (e.g., on tab close or after a save
// produces new bytes), the entry is GC'd along with it. No
// manual eviction needed for the common case.
const cache = new WeakMap<Uint8Array, Promise<PDFDocumentProxy>>()

export function getPdfDoc(pdfBytes: Uint8Array): Promise<PDFDocumentProxy> {
  const hit = cache.get(pdfBytes)
  if (hit) return hit
  // pdfjs.getDocument's data path detaches the underlying
  // ArrayBuffer (worker transfer). We `.slice()` to keep the
  // original bytes intact — the format-store still references
  // them and other code paths read the originals (signatures,
  // tagged-PDF preserve, etc).
  const promise = pdfjsLib.getDocument({
    data: pdfBytes.slice(),
    disableAutoFetch: true,
    disableStream: false,
  }).promise
  cache.set(pdfBytes, promise)
  // If the parse fails, drop the entry so a retry can happen.
  promise.catch(() => {
    if (cache.get(pdfBytes) === promise) cache.delete(pdfBytes)
  })
  return promise
}

/// Release the cached document for these bytes. Call on tab
/// close. Skips work if the bytes weren't cached (common for
/// browser-mode tests).
export async function releasePdfDoc(pdfBytes: Uint8Array): Promise<void> {
  const entry = cache.get(pdfBytes)
  if (!entry) return
  cache.delete(pdfBytes)
  try {
    const doc = await entry
    doc.destroy()
  } catch {
    /* parse failed — nothing to destroy */
  }
}
