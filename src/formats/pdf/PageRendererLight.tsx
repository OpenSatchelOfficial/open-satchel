// Lightweight page renderer for non-active pages.
//
// Renders to a `<canvas>` via the SAME pdfDoc the active full
// PageRenderer uses, in a pdfjs Web Worker. That's the same path
// the sidebar thumbnail strip uses (PdfSidebar.tsx) and it
// "just works" — pdfjs runs each render in its own worker thread
// with NO global mutex, so 35 page renders truly run in parallel.
//
// We previously routed light pages through pdfium via the Rust
// `engine_render_page_lru` command. Pdfium is faster per-page in
// isolation but its `thread_safe` Rust wrapper serializes every
// call through one global mutex (the underlying C++ library isn't
// thread-safe). Net wall-clock for 35 cold renders was worse, and
// 35 simultaneous IPCs + Tokio spawn_blocking + per-thread pdfium
// handle init ended up crashing the app under contention.
//
// pdfjs avoids all of that. Same pdfjs document already loaded
// for the active PageRenderer; we just call .getPage(N) and
// .render() on a per-component basis. pdfjs handles work
// scheduling, decompression streaming, and Web Worker dispatch.
//
// What this component owns:
//   - Cheap geometry probe (page.getViewport) for scroll height
//   - Background pdfjs render → canvas
//   - FormFieldRenderer overlay so non-active form fields stay live
//
// What this component does NOT own:
//   - FabricCanvas / EditableParagraphLayer / EditableImageLayer /
//     RulersGuides — those mount only on the active page.
//   - The full edit-text contentEditable layer.
//
// Cost comparison on a US-letter page:
//   PageRenderer (full) ≈ pdfjs canvas + 4 overlay layers ≈ 30MB heap
//   PageRendererLight   ≈ pdfjs canvas only             ≈ 1MB heap

import { useEffect, useRef, useState } from 'react'
import { useUIStore } from '../../stores/uiStore'
import FormFieldRenderer from './FormFieldRenderer'

interface Props {
  tabId: string
  pageIndex: number
  displayIndex: number
  rotation: number
  /** Reports the rendered (zoom-applied) dimensions back to the
   *  parent so PdfViewer can size virtualization placeholders to
   *  match. Called once per render. */
  onDimensions?: (height: number, width: number) => void
  /** pdfjs doc proxy used for both geometry and bitmap render. */
  pdfDoc: import('pdfjs-dist').PDFDocumentProxy
  /** True when this page is within ±N of the active page. Renders
   *  at full DPR so the user never sees a blurry-to-sharp flash
   *  when scrolling. */
  nearActive?: boolean
}

export default function PageRendererLight({
  tabId,
  pageIndex,
  displayIndex,
  rotation,
  onDimensions,
  pdfDoc,
  nearActive = false,
}: Props) {
  const zoom = useUIStore((s) => s.zoom)
  const tool = useUIStore((s) => s.tool)
  const setCurrentPage = useUIStore((s) => s.setCurrentPage)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null)
  // onDimensions is a fresh function on every PdfViewer render —
  // capturing it as a dep would re-run the dimensions effect on
  // every parent re-render too. Read via ref instead.
  const onDimensionsRef = useRef(onDimensions)
  onDimensionsRef.current = onDimensions

  // Single combined effect: probe geometry → render to canvas via
  // pdfjs. Both run on the same `page` proxy so we don't pay
  // pdfjs.getPage cost twice. Cancellation guard skips the canvas
  // paint if the component unmounts mid-render.
  //
  // Tiered render scale: pages within ±N of the active page render
  // at full zoom × DPR so scroll-to transitions are invisible.
  // Distant pages render at 0.75× to save GPU memory.
  useEffect(() => {
    let cancelled = false
    const PREVIEW_SCALE = 0.75
    const renderScale = nearActive
      ? zoom * window.devicePixelRatio
      : Math.min(zoom, PREVIEW_SCALE)
    let activePage: import('pdfjs-dist').PDFPageProxy | null = null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let renderTask: any = null

    const run = async () => {
      try {
        const page = await pdfDoc.getPage(pageIndex + 1)
        activePage = page
        if (cancelled) return
        // Combine intrinsic page rotation (e.g., scanned pages) with
        // user-applied rotation. pdfjs OVERRIDES rotation when given,
        // it doesn't add — so we precompute the sum here.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const intrinsic = ((page as any).rotate as number) || 0
        const effectiveRotation = (intrinsic + rotation) % 360

        // Display viewport (CSS pixels) at full zoom — drives the
        // wrapper size + FormFieldRenderer geometry.
        const displayVp = page.getViewport({ scale: zoom, rotation: effectiveRotation })
        const dim = { width: displayVp.width, height: displayVp.height }
        setDimensions(dim)
        onDimensionsRef.current?.(dim.height, dim.width)

        // Render viewport at preview scale → cheaper bitmap.
        const renderVp = page.getViewport({ scale: renderScale, rotation: effectiveRotation })
        const canvas = canvasRef.current
        if (!canvas) return
        canvas.width = Math.max(1, Math.floor(renderVp.width))
        canvas.height = Math.max(1, Math.floor(renderVp.height))
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        renderTask = page.render({ canvasContext: ctx as any, viewport: renderVp })
        await renderTask.promise
        if (cancelled) return
      } catch (err) {
        // Cancellation throws RenderingCancelledException — silently
        // swallow that one (it's the expected outcome of unmount-
        // during-render). Genuine errors get logged.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const name = (err as any)?.name
        if (!cancelled && name !== 'RenderingCancelledException') {
          console.warn('[PageRendererLight] pdfjs render failed:', err)
        }
      } finally {
        // ALWAYS cleanup the page proxy, regardless of success /
        // cancellation / error. Skipping cleanup leaks pdfjs's
        // operator-list cache + font references for the page —
        // ~3-10 MB per page on a designed PDF. With a 5-page
        // virtualization window churning across 15 pages, that's
        // 50+ MB leaking on every scroll.
        if (activePage) {
          try { activePage.cleanup() } catch { /* swallow */ }
          activePage = null
        }
        // Drop canvas backing store too — for landscape pages at
        // retina that's a 10-30 MB GPU buffer per Light page.
        // The wrapper stays mounted so the viewer's scroll-height
        // calc doesn't jitter; only the bitmap is freed.
        if (cancelled) {
          const canvas = canvasRef.current
          if (canvas) {
            canvas.width = 0
            canvas.height = 0
          }
        }
      }
    }
    run()
    return () => {
      cancelled = true
      // Cancel the in-flight pdfjs render so the worker thread isn't
      // chewing on a page whose component is gone. Without this the
      // RenderTask runs to completion AFTER unmount and pdfjs holds
      // page proxy + canvas refs for the duration. On a 15-page
      // landscape doc with rapid scroll, we counted 10+ orphaned
      // RenderTasks accumulating per minute of page-flipping.
      if (renderTask) {
        try { renderTask.cancel() } catch { /* swallow */ }
      }
    }
  }, [pdfDoc, pageIndex, zoom, rotation, nearActive])

  // Tools that need a FabricCanvas on the clicked page (Add Text,
  // Highlight, etc). When the user fires one of these on a Light
  // page the click should make the page active so the next click
  // hits the freshly mounted full PageRenderer's Fabric.
  const ANNOTATION_TOOLS = new Set([
    'text', 'image', 'sticky_note', 'highlight', 'highlight_area',
    'underline', 'strikethrough', 'mark_redaction', 'redact', 'shape_rect', 'shape_circle',
    'shape_line', 'shape_arrow', 'stamp', 'wipe_off', 'textbox_note',
    'link', 'draw', 'signature',
  ])
  const onWrapperClick = () => {
    if (ANNOTATION_TOOLS.has(tool)) {
      setCurrentPage(displayIndex)
    }
  }

  return (
    <div
      data-page-display-index={displayIndex}
      data-page-light="1"
      onClick={onWrapperClick}
      style={{
        position: 'relative',
        width: dimensions?.width ?? 612 * zoom,
        height: dimensions?.height ?? 792 * zoom,
        marginBottom: 12,
        background: '#fff',
        flexShrink: 0,
        boxShadow: '0 1px 3px rgba(0,0,0,0.12)',
        cursor: ANNOTATION_TOOLS.has(tool) ? 'pointer' : 'default',
      }}
    >
      {/* Canvas always mounted so the render effect has a target.
          width/height attributes set by the effect; CSS scales it
          to fill the wrapper. */}
      <canvas
        ref={canvasRef}
        style={{
          width: '100%',
          height: '100%',
          display: 'block',
          userSelect: 'none',
        }}
      />
      {dimensions && (
        <FormFieldRenderer
          tabId={tabId}
          pageIndex={pageIndex}
          pdfDoc={pdfDoc}
          zoom={zoom}
          pageWidth={dimensions.width}
          pageHeight={dimensions.height}
        />
      )}
    </div>
  )
}
