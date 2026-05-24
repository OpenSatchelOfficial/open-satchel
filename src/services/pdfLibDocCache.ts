// Shared pdf-lib PDFDocument cache (read-only).
//
// Why: PdfAdvancedDialog has 20+ sections, several of which fire a
// `PDFDocument.load(bytes)` from a `useEffect` every time the user
// clicks a tab in the dialog (Metadata, Signatures, Bookmarks,
// PDF/A, etc). On a 33 MB doc each load is 1-3 s — clicking
// between sections feels frozen.
//
// This cache memoises the parse keyed by Uint8Array identity, the
// same pattern as ./pdfDocCache for pdfjs. Multiple read-only
// callers share one PDFDocument instance per `pdfBytes`.
//
// IMPORTANT: callers MUST NOT mutate the returned doc. Anything
// that calls `.save()` or `.set*()` should re-parse fresh bytes
// (the original `PDFDocument.load(bytes)` path) — the cached doc
// is shared and mutations would race across sections.
//
// Eviction: WeakMap keyed by the bytes Uint8Array reference, so a
// tab close (which drops the format-store entry holding the bytes)
// lets the cache entry GC naturally.

import { PDFDocument } from 'pdf-lib'

const cache = new WeakMap<Uint8Array, Promise<PDFDocument>>()

/** Get a shared, read-only PDFDocument for these bytes. Caller
 *  must NOT mutate the returned doc — pass fresh bytes through
 *  `PDFDocument.load(bytes.slice())` for any write path.
 *
 *  Uses pd-lib's DEFAULT load options so the cached doc behaves
 *  byte-identically to the un-cached `PDFDocument.load(bytes)`
 *  call sites it replaces. Earlier this cache used permissive
 *  options (throwOnInvalidObject: false) and that broke
 *  `validatePdfA → auditFonts`: a Resources entry was looked up
 *  as a PDFDict but the permissive load returned something else.
 *  Don't repeat that. */
export function getReadOnlyPdfLibDoc(bytes: Uint8Array): Promise<PDFDocument> {
  const hit = cache.get(bytes)
  if (hit) return hit
  const promise = PDFDocument.load(bytes)
  cache.set(bytes, promise)
  promise.catch(() => {
    if (cache.get(bytes) === promise) cache.delete(bytes)
  })
  return promise
}
