import { useEffect, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { getPdfDoc } from './pdfDocCache'

// usePdfDocument now reads from the per-bytes pdfjs document cache
// (see ./pdfDocCache.ts). Multiple consumers — the active-page
// PdfViewer, the sidebar's PageThumbnail, PageRendererLight — all
// share one PDFDocumentProxy per pdfBytes Uint8Array. Without that,
// brand-guidelines.pdf (33 MB, 15 pages) ran 16 parallel
// pdfjs.getDocument parses and OOM'd the WebView V8 heap.
//
// Critically: this hook does NOT call doc.destroy() on cleanup.
// The cache owns the doc's lifetime; tab close releases via
// releasePdfDoc. Calling .destroy() here would yank the doc out
// from under the sidebar's still-rendering thumbnails.
export function usePdfDocument(pdfBytes: Uint8Array | null): PDFDocumentProxy | null {
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null)

  useEffect(() => {
    if (!pdfBytes) {
      setPdfDoc(null)
      return
    }

    let cancelled = false
    getPdfDoc(pdfBytes)
      .then((doc) => {
        if (!cancelled) setPdfDoc(doc)
      })
      .catch((err) => {
        console.error('Failed to load PDF:', err)
      })

    return () => {
      cancelled = true
    }
  }, [pdfBytes])

  return pdfDoc
}
