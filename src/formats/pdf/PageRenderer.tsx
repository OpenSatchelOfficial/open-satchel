import { useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { useUIStore } from '../../stores/uiStore'
import { useFormatStore } from '../../stores/formatStore'
import { useTabStore } from '../../stores/tabStore'
import type { PdfFormatState } from './index'
import FabricCanvas from './FabricCanvas'
import FormFieldRenderer from './FormFieldRenderer'
import EditableTextLayer from './EditableTextLayer'
import EditableParagraphLayer from './EditableParagraphLayer'
import EditableImageLayer from './EditableImageLayer'
import { RulersGuides, type Guide } from '../../components/editor/RulersGuides'
import PdfiumPageView from '../../components/viewer/PdfiumPageView'
import { shouldUsePdfiumRender } from '../../services/pdfiumRender'

// Stable reference so a missing key doesn't synthesize a new empty
// array on each render — would loop `useSyncExternalStore` infinitely.
const EMPTY_GUIDES: ReadonlyArray<Guide> = Object.freeze([])

interface Props {
  tabId: string
  pdfDoc: PDFDocumentProxy
  pageIndex: number
  displayIndex: number
  rotation: number
  /** Reports the rendered (zoom-applied) dimensions back to the
   *  parent so PdfViewer can size virtualization placeholders to
   *  match. Called once per render. */
  onDimensions?: (height: number, width: number) => void
}

export default function PageRenderer({
  tabId,
  pdfDoc,
  pageIndex,
  displayIndex,
  rotation,
  onDimensions,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const zoom = useUIStore((s) => s.zoom)
  const tool = useUIStore((s) => s.tool)
  const readMode = useUIStore((s) => s.readMode)
  const showRulers = useUIStore((s) => s.showRulers)
  const showGrid = useUIStore((s) => s.showGrid)
  const snapToGrid = useUIStore((s) => s.snapToGrid)
  const gridSize = useUIStore((s) => s.gridSize)
  const guides = useUIStore((s) => s.guides[`${tabId}:${pageIndex}`]) ?? EMPTY_GUIDES
  const addGuide = useUIStore((s) => s.addGuide)
  const moveGuide = useUIStore((s) => s.moveGuide)
  const removeGuide = useUIStore((s) => s.removeGuide)
  const pdfBytes = useFormatStore((s) => (s.data[tabId] as PdfFormatState | undefined)?.pdfBytes)
  // File path enables the path-based pdfium render command (no
  // IPC byte transfer for the source bytes). Without it,
  // PdfiumPageView's render falls back to engine_render_page_from_bytes
  // which JSON-array-marshals the full 33 MB per call — multi-second
  // freeze on click-thumbnail page swaps.
  const filePath = useTabStore((s) => s.tabs.find((t) => t.id === tabId)?.filePath)
  const isDirty = useTabStore((s) => s.tabs.find((t) => t.id === tabId)?.isDirty ?? false)
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null)

  // Pdfium native view path: heavy doc + view-only mode = swap pdfjs
  // canvas for a pdfium-rendered PNG. Editor stays on pdfjs because
  // pdfium PNGs have no text layer for selection / paragraph edits.
  // useNativeRender: any active edit-related tool (edit_text /
  // edit_image / form fields) keeps pdfjs since those layers depend
  // on pdfjs-extracted geometry. Tool 'select' and Hand-mode count
  // as view-only.
  const VIEW_ONLY_TOOLS = ['select']
  const isViewOnly = readMode || VIEW_ONLY_TOOLS.includes(tool)
  const useNativeRender =
    !!pdfBytes && shouldUsePdfiumRender(pdfBytes) && isViewOnly
  const [nativeFailed, setNativeFailed] = useState(false)
  const [renderReady, setRenderReady] = useState(false)
  const renderReadyDocRef = useRef<PDFDocumentProxy | null>(null)
  const renderReadyBytesRef = useRef<Uint8Array | null>(null)
  // pdfBytes isn't a direct dep of the render effect — we want the
  // effect to re-run when pdfDoc changes (which happens when pdfBytes
  // changes) but not separately. Touch it to silence the linter.
  void pdfBytes

  // Render loop with offscreen-canvas double-buffering. The visible
  // canvas keeps showing the previous render (pre-save) while pdfjs
  // rasterizes the new page into a detached canvas; when the async
  // render resolves, we blit the result onto the visible canvas in a
  // single frame. This eliminates the "fade to white" flash users saw
  // on Ctrl+S, because the visible canvas is never cleared.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let cancelled = false

    // Clear the readiness flag at the start of each render so sibling
    // components (EditableParagraphLayer in particular) don't sample
    // the PREVIOUS paint thinking it's current.
    canvas.dataset.ready = ''
    renderReadyDocRef.current = null
    renderReadyBytesRef.current = null
    setRenderReady(false)

    const render = async () => {
      try {
        const page = await pdfDoc.getPage(pageIndex + 1)
        if (cancelled) { page.cleanup(); return }

        const intrinsicRotation = (page as any).rotate || 0
        const effectiveRotation = (intrinsicRotation + rotation) % 360

        const displayViewport = page.getViewport({
          scale: zoom,
          rotation: effectiveRotation,
        })

        // Performance fast-path: when pdfium native render is going to
        // overlay this page, skip the pdfjs canvas rasterize entirely.
        // Just publish dimensions so layout settles, set the ready
        // flag (no canvas content but downstream consumers gate on
        // dataset.ready), and bail.
        //
        // E3 perf: also skip the canvas backing-buffer allocation. The
        // canvas is invisible under the pdfium <img> (opacity: 0) and
        // we never paint to it on this branch — allocating
        // width × height × 4 bytes of GPU memory is pure waste.
        // 612 × 792 × dpr² × 4 ≈ 7.7MB/page; in-window window=±1 means
        // ~23MB saved on the 32MB brand-guidelines.pdf gate. When the
        // user tears back to interactive mode (edit_text / select),
        // useNativeRender flips false, this effect re-runs and the
        // full render path (below) reallocates at the right size.
        if (useNativeRender && !nativeFailed) {
          canvas.width = 0
          canvas.height = 0
          canvas.style.width = `${displayViewport.width}px`
          canvas.style.height = `${displayViewport.height}px`
          canvas.dataset.ready = '1'
          renderReadyDocRef.current = pdfDoc
          renderReadyBytesRef.current = pdfBytes ?? null
          setRenderReady(true)
          setDimensions({ width: displayViewport.width, height: displayViewport.height })
          onDimensions?.(displayViewport.height, displayViewport.width)
          page.cleanup()
          return
        }

        const viewport = page.getViewport({
          scale: zoom * window.devicePixelRatio,
          rotation: effectiveRotation,
        })

        // Render into an off-DOM canvas so the visible canvas doesn't
        // blank during the async pdfjs paint.
        const offscreen = document.createElement('canvas')
        offscreen.width = Math.floor(viewport.width)
        offscreen.height = Math.floor(viewport.height)
        const offCtx = offscreen.getContext('2d')!
        await page.render({ canvasContext: offCtx, viewport }).promise
        if (cancelled) { page.cleanup(); return }

        canvas.width = offscreen.width
        canvas.height = offscreen.height
        canvas.style.width = `${displayViewport.width}px`
        canvas.style.height = `${displayViewport.height}px`
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(offscreen, 0, 0)

        // Signal paint completion so EditableParagraphLayer can sample
        // bg colors without racing against an unpainted canvas. Without
        // this the sample ran while the canvas was still blank-white,
        // which made every paragraph default to "light background" and
        // the save masks were drawn white (erasing dark headers).
        canvas.dataset.ready = '1'
        renderReadyDocRef.current = pdfDoc
        renderReadyBytesRef.current = pdfBytes ?? null
        setRenderReady(true)

        setDimensions({ width: displayViewport.width, height: displayViewport.height })
        onDimensions?.(displayViewport.height, displayViewport.width)
        page.cleanup()
      } catch (err) {
        if (!cancelled) console.error('Failed to render page:', err)
      }
    }

    render()
    return () => {
      cancelled = true
    }
  }, [pdfDoc, pageIndex, zoom, rotation, useNativeRender, nativeFailed])

  const renderReadyForCurrentDoc =
    renderReady &&
    renderReadyDocRef.current === pdfDoc &&
    renderReadyBytesRef.current === (pdfBytes ?? null)

  return (
    <div
      data-page-display-index={displayIndex}
      style={{
        position: 'relative',
        marginBottom: 12,
        boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
        background: '#fff',
        // Use width/height from the rendered viewport so the container
        // always matches exactly the page content — no clipping, no excess space.
        width: dimensions ? `${dimensions.width}px` : 'auto',
        height: dimensions ? `${dimensions.height}px` : 'auto',
        flexShrink: 0,
        overflow: 'hidden',
        contain: 'layout paint',
        isolation: 'isolate',
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          display: 'block',
          pointerEvents: 'none',
          position: 'absolute',
          top: 0,
          left: 0,
          // Hide pdfjs canvas when the pdfium native render is in
          // play — the <img> below covers the same area at the same
          // dimensions. We keep the canvas mounted so tearing back
          // to interactive mode doesn't require a re-render.
          opacity: useNativeRender && !nativeFailed ? 0 : 1,
          // No opacity transition — offscreen double-buffering above
          // means the visible canvas is never in an intermediate state.
        }}
      />
      {dimensions && pdfBytes && useNativeRender && !nativeFailed && (
        <div style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: dimensions.width,
          height: dimensions.height,
          pointerEvents: 'none',
        }}>
          <PdfiumPageView
            pdfBytes={pdfBytes}
            pageIndex={pageIndex}
            scale={zoom * window.devicePixelRatio}
            displayWidth={dimensions.width}
            displayHeight={dimensions.height}
            // Only use the path-based render when bytes match disk
            // (clean tab). Once user makes any edit, in-memory
            // bytes diverge — fall back to byte-based render to
            // pick up the staged changes.
            filePath={!isDirty && filePath ? filePath : undefined}
            onError={(err) => {
              console.warn('[PageRenderer] pdfium render failed, falling back to pdfjs:', err)
              setNativeFailed(true)
            }}
          />
        </div>
      )}
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
      {/* Modeless-editing architecture.
          Both interactive layers stay mounted regardless of the
          current tool. FabricCanvas is ALWAYS interactive now — even
          in Edit Text mode. Phase C: the FabricCanvas internally
          flips `fc.selection = false` in edit_text to kill marquee
          drag-select on empty area, but individual Fabric objects
          remain clickable. Combined with paragraph boxes sitting
          above Fabric (zIndex 5 vs 1) with their own pointer-events:
          auto regions, the natural z-order gives us the priority
          table automatically:
             Edit Text: paragraph box (top-z) > Fabric object > empty
             Select:    Fabric object > paragraph box > empty
                        (select mode: paragraph outlines hidden,
                         so `active=false` → paragraph layer is fully
                         pointer-events-none). */}
      {dimensions && (
        <FabricCanvas
          tabId={tabId}
          pageIndex={pageIndex}
          width={dimensions.width}
          height={dimensions.height}
          pdfDoc={pdfDoc}
          interactive={!readMode}
        />
      )}
      {dimensions && (
        <EditableParagraphLayer
          tabId={tabId}
          pageIndex={pageIndex}
          pdfDoc={pdfDoc}
          width={dimensions.width}
          height={dimensions.height}
          active={!readMode && tool === 'edit_text'}
          renderReady={renderReadyForCurrentDoc}
        />
      )}
      {/* Image editing layer — content-stream XObject moves. Active
          under the dedicated `edit_image` primary tool (not `image`,
          which is the drop-to-add-new tool). Parallel to edit_text:
          its own primary mode with its own layer-wins priority. */}
      {dimensions && (
        <EditableImageLayer
          tabId={tabId}
          pageIndex={pageIndex}
          pdfDoc={pdfDoc}
          width={dimensions.width}
          height={dimensions.height}
          active={!readMode && tool === 'edit_image'}
          renderReady={renderReadyForCurrentDoc}
        />
      )}
      {/* Kept importable but not mounted by default — paragraph-level is
          the primary edit UI. Span-level remains as a manual-opt fallback
          for users who need TJ-element precision. */}
      {false && <EditableTextLayer tabId={tabId} pageIndex={pageIndex} pdfDoc={pdfDoc} width={0} height={0} />}
      {dimensions && (showRulers || showGrid || guides.length > 0) && (
        <RulersGuides
          fabricCanvas={null}
          width={dimensions.width}
          height={dimensions.height}
          showRulers={showRulers}
          showGrid={showGrid}
          gridSize={gridSize}
          snapToGrid={snapToGrid}
          guides={guides}
          onAddGuide={(axis, pos) => addGuide(tabId, pageIndex, axis, pos)}
          onMoveGuide={(idx, pos) => moveGuide(tabId, pageIndex, idx, pos)}
          onRemoveGuide={(idx) => removeGuide(tabId, pageIndex, idx)}
        />
      )}
    </div>
  )
}
