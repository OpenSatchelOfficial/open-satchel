// View-only page renderer that goes through pdfium native rendering.
//
// Used by PageRenderer when the document is heavy (>5 MB by default)
// AND the user is in view-only mode (no editing). For lighter docs
// or in edit mode, pdfjs is preferred since pdfium PNGs have no
// text-layer for interaction.
//
// Renders an `<img>` whose src is the cached blob URL produced by
// pdfiumRender.renderPageViaPdfium. On miss, the call goes
// IPC-bound to engine_render_page_from_bytes; on hit, the cached
// URL returns immediately. Width/height come from the rendered PNG.

import { useEffect, useState } from 'react'
import { renderPageViaPdfium } from '../../services/pdfiumRender'

interface Props {
  pdfBytes: Uint8Array
  pageIndex: number
  /** Render scale = zoom × DPR. Same convention as PageRenderer. */
  scale: number
  /** CSS width/height for the displayed image (= zoom × pdfPoints).
   *  Caller computes from page geometry; the cached PNG's intrinsic
   *  pixels are scaled to fit. */
  displayWidth: number
  displayHeight: number
  /** When set, render goes through the path-based engine command
   *  (no IPC byte transfer for the 33 MB doc — just a small PNG
   *  response). Strongly recommended; in-memory bytes-based render
   *  is the slow fallback. */
  filePath?: string
  /** Called when render fails so the parent can fall back to pdfjs. */
  onError?: (err: unknown) => void
}

export default function PdfiumPageView({
  pdfBytes,
  pageIndex,
  scale,
  displayWidth,
  displayHeight,
  filePath,
  onError,
}: Props) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setUrl(null)
    renderPageViaPdfium(pdfBytes, pageIndex, scale, filePath)
      .then((u) => {
        if (cancelled) return
        setUrl(u)
      })
      .catch((err) => {
        if (cancelled) return
        onError?.(err)
      })
    return () => { cancelled = true }
  }, [pdfBytes, pageIndex, scale, filePath, onError])

  if (!url) {
    // Skeleton placeholder so layout doesn't reflow when the PNG
    // resolves. Same dimensions as the eventual <img>.
    return (
      <div
        style={{
          width: displayWidth,
          height: displayHeight,
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
        }}
        data-testid="pdfium-page-view-loading"
      />
    )
  }

  return (
    <img
      src={url}
      alt=""
      data-testid="pdfium-page-view"
      data-page-index={pageIndex}
      draggable={false}
      style={{
        width: displayWidth,
        height: displayHeight,
        userSelect: 'none',
        display: 'block',
      }}
    />
  )
}
