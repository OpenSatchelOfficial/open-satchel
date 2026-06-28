// EditableImageLayer — select and drag embedded images on a PDF page.
//
// Parses the page's content stream on mount, surfaces each `/ImN Do`
// call as a draggable bounding box, and commits per-image translation
// deltas to `_imageEdits` on the page state. The save pipeline consumes
// those deltas via applyImageEditsToBytes to rewrite the cm matrix
// preceding each Do — surgical byte patch, same invariant as the
// paragraph save.
//
// Interaction model:
//   - Mounted always (like EditableParagraphLayer), `active` prop gates
//     pointer-events.
//   - Click a box → selected state; drag → ghost preview; release →
//     commit delta to `_imageEdits`.
//   - Drag delta is in PDF user-space (bottom-left origin, positive dy
//     is UP). The UI layer computes the delta from pointer deltas in
//     viewport coords and the current scale.
//
// v1 scope: translate only. Resize handles + rotation come later.

import { useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { useFormatStore } from '../../stores/formatStore'
import { useTabStore } from '../../stores/tabStore'
import { withReplay } from '../../stores/historyStore'
import * as pdfjsLib from 'pdfjs-dist'
import {
  getPageContentLayout,
  parseContentStream,
} from '../../services/contentStreamParser'
import {
  rectFromCtm,
  suppressImageDrawsForPreview,
  type ImageDrawRect,
  type ImageEdit,
} from '../../services/pdfImageEdits'
import {
  fabricJsonHasRedactionMarkForTarget,
  redactionMarkTargetId,
  stageElementRedactionMark,
  type CssRedactionMarkRect,
} from '../../services/pdfRedactionMarks'
import type { PdfFormatState } from './index'
import { PDFDocument, PDFName, PDFRawStream, PDFDict } from 'pdf-lib'

interface Props {
  tabId: string
  pageIndex: number
  pdfDoc: PDFDocumentProxy
  width: number
  height: number
  active?: boolean
  markRedactionMode?: boolean
  /** True after the sibling pdfjs canvas has painted the current
   *  pdfDoc. Used to keep post-save image previews visible until the
   *  saved pixels have actually replaced the old canvas. */
  renderReady?: boolean
}

function readImageEdits(tabId: string, pageIndex: number): ImageEdit[] {
  const state = useFormatStore.getState().data[tabId] as PdfFormatState | undefined
  if (!state) return []
  const page = state.pages.find((p) => p.pageIndex === pageIndex) as
    | (PdfFormatState['pages'][number] & { _imageEdits?: ImageEdit[] })
    | undefined
  return page?._imageEdits ?? []
}

function writeImageEdits(tabId: string, pageIndex: number, edits: ImageEdit[]) {
  useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({
    ...prev,
    pages: prev.pages.map((p) =>
      p.pageIndex === pageIndex
        ? ({ ...p, _imageEdits: edits.length > 0 ? edits : undefined } as PdfFormatState['pages'][number])
        : p,
    ),
  }))
  if (edits.length > 0) useTabStore.getState().setTabDirty(tabId, true)
}

interface ImageBox extends ImageDrawRect {
  /** Unique id: xObjectName + draw-sequence index so multiple draws of
   *  the same image get distinct boxes in the UI (even if v1 edit
   *  application collapses them). */
  id: string
}

interface ImagePreview {
  /** Raster slice copied from the pdfjs page canvas at the image's
   *  original location. Used only for live preview; save still rewrites
   *  the PDF content stream surgically. */
  url: string
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

import CropImageDialog from './CropImageDialog'

export default function EditableImageLayer({
  tabId,
  pageIndex,
  pdfDoc,
  width,
  height,
  active = true,
  markRedactionMode = false,
  renderReady = true,
}: Props) {
  const [boxes, setBoxes] = useState<ImageBox[]>([])
  const [basePageSize, setBasePageSize] = useState<{ w: number; h: number } | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [dragOffset, setDragOffset] = useState<{ dx: number; dy: number } | null>(null)
  const [imagePreviews, setImagePreviews] = useState<Record<string, ImagePreview>>({})
  const [suppressedPreview, setSuppressedPreview] = useState<{ id: string; url: string } | null>(null)
  const [cropTarget, setCropTarget] = useState<string | null>(null)
  const layerRef = useRef<HTMLDivElement>(null)
  const dragStartRef = useRef<{ x: number; y: number } | null>(null)
  const suppressedUrlRef = useRef<string | null>(null)
  const pageFabricJSON = useFormatStore((s): Record<string, unknown> | null => {
    const state = s.data[tabId] as PdfFormatState | undefined
    const page = state?.pages.find((p) => p.pageIndex === pageIndex)
    return page?.fabricJSON ?? null
  })

  // Parse image draws once per (pdfDoc, pageIndex).
  //
  // Heavy work (pd-lib full-doc parse + content-stream walk) is
  // gated behind requestIdleCallback so it doesn't block first-paint.
  // The user can't interact with image bboxes until they switch to
  // edit_image mode anyway — by then this cluster has long since
  // settled.
  useEffect(() => {
    let cancelled = false
    let idleHandle: number | null = null
    const runParse = async () => {
      try {
        const state = useFormatStore.getState().data[tabId] as PdfFormatState | undefined
        if (!state) return
        const pdfLibDoc = await PDFDocument.load(state.pdfBytes)
        if (cancelled) return
        const layout = getPageContentLayout(pdfLibDoc, pageIndex)
        if (!layout) return
        const parsed = parseContentStream(layout.bytes)

        // Resolve which XObjects are actually images — skip Form XObjects
        // (annotations, page-group overlays, etc). Ask the page's
        // Resources/XObject dict for each name's Subtype.
        const page = pdfLibDoc.getPage(pageIndex)
        const resources = pdfLibDoc.context.lookup(page.node.get(PDFName.of('Resources')))
        const xobjects = resources instanceof PDFDict
          ? pdfLibDoc.context.lookup(resources.get(PDFName.of('XObject')))
          : undefined
        // Subtype detection — accept BOTH /Image (raster) and /Form
        // (vector group). Form XObjects wrap arbitrary content streams
        // (logos, headers, repeated layouts) and respond to the same
        // cm-matrix rewrite path that image moves use, so they edit
        // identically from the user's perspective: click → drag /
        // resize / rotate / flip / crop.
        type XObjKind = 'image' | 'form' | null
        const xObjectKind = (name: string): XObjKind => {
          if (!(xobjects instanceof PDFDict)) return null
          const ref = xobjects.get(PDFName.of(name))
          if (!ref) return null
          const obj = pdfLibDoc.context.lookup(ref)
          if (!(obj instanceof PDFRawStream)) return null
          const subtype = obj.dict.get(PDFName.of('Subtype'))
          if (!subtype) return null
          const subtypeStr = subtype.toString()
          if (subtypeStr === '/Image') return 'image'
          if (subtypeStr === '/Form') return 'form'
          return null
        }

        const pageSize = page.getSize()
        const result: ImageBox[] = []
        parsed.imageDraws.forEach((draw, i) => {
          const kind = xObjectKind(draw.xObjectName)
          if (!kind) return
          const rect = rectFromCtm(draw)
          // Skip tiny/invalid rects (likely stamps or pattern fills).
          if (rect.width < 4 || rect.height < 4) return
          result.push({ ...rect, id: `${draw.xObjectName}_${i}_${kind}` })
        })

        if (cancelled) return
        setBoxes(result)
        setBasePageSize({ w: pageSize.width, h: pageSize.height })
      } catch (err) {
        console.warn('[EditableImageLayer] parse failed:', err)
      }
    }
    idleHandle = window.setTimeout(() => { void runParse() }, 150)
    return () => {
      cancelled = true
      if (idleHandle !== null) window.clearTimeout(idleHandle)
    }
  }, [pdfDoc, pageIndex, tabId])

  // Cross-layer: clear active when clicking outside
  useEffect(() => {
    if (!active) return
    const onOutside = (e: Event) => {
      const el = layerRef.current
      if (!el) return
      const target = e.target as Node | null
      if (target && el.contains(target)) return
      setActiveId(null)
    }
    document.addEventListener('pointerdown', onOutside, true)
    return () => document.removeEventListener('pointerdown', onOutside, true)
  }, [active])

  const scale = basePageSize ? width / basePageSize.w : 1
  const pageH = basePageSize?.h ?? 0
  const pdfBytes = useFormatStore((s): Uint8Array | undefined => {
    const state = s.data[tabId] as PdfFormatState | undefined
    return state?.pdfBytes
  })

  // Build live image previews by copying each original image rect from
  // the rendered pdfjs canvas. That lets dragging move the actual pixels
  // the user sees instead of a colored placeholder rectangle.
  useEffect(() => {
    if (!basePageSize || boxes.length === 0) {
      setImagePreviews({})
      return
    }
    let cancelled = false

    const run = async () => {
      const start = Date.now()
      const MAX_WAIT = 2500
      let canvas: HTMLCanvasElement | null = null
      while (Date.now() - start < MAX_WAIT) {
        if (cancelled) return
        const layer = layerRef.current
        canvas = layer?.parentElement?.querySelector('canvas[data-ready="1"]') as HTMLCanvasElement | null
        if (canvas && canvas.width > 0 && canvas.height > 0) break
        await new Promise((r) => setTimeout(r, 50))
      }
      if (cancelled || !canvas || canvas.width <= 0 || canvas.height <= 0) return

      const layer = layerRef.current
      if (!layer) return
      const layerRect = layer.getBoundingClientRect()
      const canvasRect = canvas.getBoundingClientRect()
      if (canvasRect.width <= 0 || canvasRect.height <= 0) return

      const pxPerCssX = canvas.width / canvasRect.width
      const pxPerCssY = canvas.height / canvasRect.height
      const next: Record<string, ImagePreview> = {}

      for (const box of boxes) {
        const cssX = box.x * scale
        const cssY = (pageH - box.y - box.height) * scale
        const cssW = box.width * scale
        const cssH = box.height * scale

        const sx = clamp((layerRect.left + cssX - canvasRect.left) * pxPerCssX, 0, canvas.width)
        const sy = clamp((layerRect.top + cssY - canvasRect.top) * pxPerCssY, 0, canvas.height)
        const sw = clamp(cssW * pxPerCssX, 1, canvas.width - sx)
        const sh = clamp(cssH * pxPerCssY, 1, canvas.height - sy)
        if (sw <= 1 || sh <= 1) continue

        const tmp = document.createElement('canvas')
        tmp.width = Math.max(1, Math.round(sw))
        tmp.height = Math.max(1, Math.round(sh))
        const ctx = tmp.getContext('2d')
        if (!ctx) continue
        ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, tmp.width, tmp.height)
        next[box.id] = { url: tmp.toDataURL('image/png') }
      }

      if (!cancelled) setImagePreviews(next)
    }

    void run()
    return () => { cancelled = true }
  }, [boxes, basePageSize, scale, pageH])

  // Runtime-only source suppression for the active moved image. The
  // resulting PNG is clipped to the dirty source rect at render time, so
  // there is no full-page DOM preview that can bleed across pages.
  useEffect(() => {
    if (!pdfBytes || !basePageSize || !activeId) {
      setSuppressedPreview((prev) => {
        if (prev?.url) URL.revokeObjectURL(prev.url)
        suppressedUrlRef.current = null
        return null
      })
      return
    }
    const box = boxes.find((b) => b.id === activeId)
    if (!box) return
    let cancelled = false

    const run = async () => {
      try {
        const previewBytes = await suppressImageDrawsForPreview(pdfBytes, pageIndex, [box.xObjectName])
        if (cancelled) return
        const doc = await pdfjsLib.getDocument({ data: previewBytes.slice() }).promise
        try {
          const page = await doc.getPage(pageIndex + 1)
          const viewport = page.getViewport({ scale })
          const canvas = document.createElement('canvas')
          canvas.width = Math.max(1, Math.floor(viewport.width))
          canvas.height = Math.max(1, Math.floor(viewport.height))
          const ctx = canvas.getContext('2d')
          if (!ctx) return
          await page.render({ canvasContext: ctx, viewport }).promise
          if (cancelled) return
          const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
          if (!blob || cancelled) return
          const url = URL.createObjectURL(blob)
          const stale = suppressedUrlRef.current
          suppressedUrlRef.current = url
          setSuppressedPreview({ id: box.id, url })
          if (stale) URL.revokeObjectURL(stale)
          page.cleanup()
        } finally {
          await doc.destroy()
        }
      } catch (err) {
        if (!cancelled) console.warn('[EditableImageLayer] suppress preview failed:', err)
      }
    }

    void run()
    return () => { cancelled = true }
  }, [pdfBytes, basePageSize, activeId, boxes, pageIndex, scale])

  useEffect(() => {
    return () => {
      if (suppressedUrlRef.current) URL.revokeObjectURL(suppressedUrlRef.current)
    }
  }, [])

  // Subscribe to edits so the layer re-renders when deltas change.
  const pageEdits = useFormatStore((s): ImageEdit[] | undefined => {
    const state = s.data[tabId] as PdfFormatState | undefined
    const page = state?.pages.find((p) => p.pageIndex === pageIndex) as
      | (PdfFormatState['pages'][number] & { _imageEdits?: ImageEdit[] })
      | undefined
    return page?._imageEdits
  })
  const pageSavePreviewEdits = useFormatStore((s): ImageEdit[] | undefined => {
    const state = s.data[tabId] as PdfFormatState | undefined
    const page = state?.pages.find((p) => p.pageIndex === pageIndex) as
      | (PdfFormatState['pages'][number] & { _savePreviewImageEdits?: ImageEdit[] })
      | undefined
    return page?._savePreviewImageEdits
  })
  useEffect(() => {
    if (!renderReady || !pageSavePreviewEdits || pageSavePreviewEdits.length === 0) return
    withReplay(() => {
      useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({
        ...prev,
        pages: prev.pages.map((p) => {
          if (p.pageIndex !== pageIndex) return p
          const { _savePreviewImageEdits, ...rest } = p as any
          void _savePreviewImageEdits
          return rest
        }),
      }))
    })
  }, [renderReady, pageSavePreviewEdits, tabId, pageIndex])

  const handlePointerDown = (e: React.PointerEvent, box: ImageBox) => {
    if (!active) return
    e.preventDefault()
    e.stopPropagation()
    setActiveId(box.id)
    dragStartRef.current = { x: e.clientX, y: e.clientY }
    setDragOffset({ dx: 0, dy: 0 })
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragStartRef.current) return
    const dx = e.clientX - dragStartRef.current.x
    const dy = e.clientY - dragStartRef.current.y
    setDragOffset({ dx, dy })
  }

  const handlePointerUp = (e: React.PointerEvent, box: ImageBox) => {
    const start = dragStartRef.current
    if (!start) return
    const dx = e.clientX - start.x
    const dy = e.clientY - start.y
    dragStartRef.current = null
    setDragOffset(null)
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* noop */
    }
    // Threshold — treat sub-threshold movement as a click, not a drag.
    if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return
    // Convert viewport delta → PDF user-space delta. Viewport y is
    // top-down; PDF y is bottom-up. Scale applies to both axes.
    const pdfDx = dx / scale
    const pdfDy = -dy / scale
    const current = readImageEdits(tabId, pageIndex)
    // Combine with any existing delta for the same xObject name.
    const existingIdx = current.findIndex((e) => e.xObjectName === box.xObjectName)
    const merged: ImageEdit = existingIdx >= 0
      ? {
          ...current[existingIdx],
          dx: current[existingIdx].dx + pdfDx,
          dy: current[existingIdx].dy + pdfDy,
        }
      : { xObjectName: box.xObjectName, dx: pdfDx, dy: pdfDy }
    const next = existingIdx >= 0
      ? current.map((e, i) => i === existingIdx ? merged : e)
      : [...current, merged]
    writeImageEdits(tabId, pageIndex, next)
  }

  const applyToolbar = (box: ImageBox, op: 'rot-cw' | 'rot-ccw' | 'flip-h' | 'flip-v') => {
    const current = readImageEdits(tabId, pageIndex)
    const idx = current.findIndex((e) => e.xObjectName === box.xObjectName)
    const existing: ImageEdit = idx >= 0 ? current[idx] : { xObjectName: box.xObjectName, dx: 0, dy: 0 }
    const next: ImageEdit = { ...existing }
    if (op === 'rot-cw') next.rotateDegrees = ((existing.rotateDegrees ?? 0) - 90) % 360
    if (op === 'rot-ccw') next.rotateDegrees = ((existing.rotateDegrees ?? 0) + 90) % 360
    if (op === 'flip-h') next.flipH = !existing.flipH
    if (op === 'flip-v') next.flipV = !existing.flipV
    const merged = idx >= 0 ? current.map((e, i) => i === idx ? next : e) : [...current, next]
    writeImageEdits(tabId, pageIndex, merged)
  }

  const markImageForRedaction = (box: ImageBox, rect: CssRedactionMarkRect) => {
    stageElementRedactionMark({
      tabId,
      pageIndex,
      targetId: redactionMarkTargetId('image', pageIndex, box.id),
      rect,
      pageWidth: width,
      pageHeight: height,
    })
    setActiveId(box.id)
  }

  if (!basePageSize || boxes.length === 0) return null

  return (
    <div
      ref={layerRef}
      data-testid={`editable-image-layer-${pageIndex}`}
      style={{
        position: 'absolute', inset: 0,
        pointerEvents: active && !markRedactionMode ? 'auto' : 'none',
        zIndex: 4,
      }}
    >
      {boxes.map((box) => {
        // Look up any committed delta for this xObject name; apply it to
        // the rendered bounding box position. This is how undo/redo +
        // drag-then-release movements visually persist.
        const edits =
          pageEdits && pageEdits.length > 0
            ? pageEdits
            : pageSavePreviewEdits ?? []
        const edit = edits.find((e) => e.xObjectName === box.xObjectName)
        const committedDx = edit?.dx ?? 0
        const committedDy = edit?.dy ?? 0

        // Live-drag offset for the box being dragged.
        const liveDx = activeId === box.id && dragOffset ? dragOffset.dx : 0
        const liveDy = activeId === box.id && dragOffset ? dragOffset.dy : 0

        // PDF bottom-left origin → viewport top-left. Also offset by
        // committed edit (in PDF user-space, translate to CSS). Live
        // drag already in CSS px.
        const cssX = (box.x + committedDx) * scale + liveDx
        // PDF y grows up; CSS y grows down. box.y + committedDy is the
        // PDF bottom-left y AFTER the edit. Top-edge in CSS = pageH -
        // (bottom + height).
        const cssY = (pageH - (box.y + committedDy) - box.height) * scale + liveDy
        const cssW = box.width * scale
        const cssH = box.height * scale
        const redactionTargetId = redactionMarkTargetId('image', pageIndex, box.id)
        const isRedactionMarked = fabricJsonHasRedactionMarkForTarget(pageFabricJSON, redactionTargetId)
        const hasMoved =
          Math.abs(committedDx) > 0.01 ||
          Math.abs(committedDy) > 0.01 ||
          Math.abs(liveDx) > 0.01 ||
          Math.abs(liveDy) > 0.01
        const preview = imagePreviews[box.id]
        const showBoxPreview = hasMoved && preview
        const showSourcePatch = hasMoved && suppressedPreview?.id === box.id

        return (
          <div key={box.id} style={{ position: 'absolute', left: 0, top: 0, width: 0, height: 0 }}>
            {showSourcePatch && (
              <div
                data-testid={`image-source-composite-${box.id}`}
                style={{
                  position: 'absolute',
                  left: box.x * scale,
                  top: (pageH - box.y - box.height) * scale,
                  width: cssW,
                  height: cssH,
                  overflow: 'hidden',
                  pointerEvents: 'none',
                  zIndex: 5,
                  contain: 'layout paint',
                }}
              >
                <img
                  src={suppressedPreview.url}
                  alt=""
                  draggable={false}
                  style={{
                    position: 'absolute',
                    left: -box.x * scale,
                    top: -(pageH - box.y - box.height) * scale,
                    width,
                    height,
                    userSelect: 'none',
                  }}
                />
              </div>
            )}
            {showBoxPreview && (
              <img
                data-testid={`image-live-preview-${box.id}`}
                src={preview.url}
                alt=""
                draggable={false}
                style={{
                  position: 'absolute',
                  left: cssX,
                  top: cssY,
                  width: cssW,
                  height: cssH,
                  pointerEvents: 'none',
                  userSelect: 'none',
                  zIndex: 6,
                }}
              />
            )}
            <div
              data-testid={`image-box-${box.id}`}
              data-xobject={box.xObjectName}
              onPointerDown={(e) => {
                if (markRedactionMode) {
                  e.preventDefault()
                  e.stopPropagation()
                  markImageForRedaction(box, {
                    left: cssX,
                    top: cssY,
                    width: cssW,
                    height: cssH,
                  })
                  return
                }
                handlePointerDown(e, box)
              }}
              onPointerMove={markRedactionMode ? undefined : handlePointerMove}
              onPointerUp={markRedactionMode ? undefined : (e) => handlePointerUp(e, box)}
              onPointerCancel={() => {
                dragStartRef.current = null
                setDragOffset(null)
              }}
              style={{
                position: 'absolute',
                left: cssX, top: cssY, width: cssW, height: cssH,
                zIndex: 7,
                pointerEvents: active ? 'auto' : 'none',
                border: isRedactionMarked
                  ? '3px solid #000000'
                  : activeId === box.id
                  ? '2px solid var(--accent)'
                  : '1px dashed rgba(99, 179, 237, 0.5)',
                background: 'transparent',
                boxShadow: isRedactionMarked ? '0 0 0 2px rgba(0, 0, 0, 0.20)' : undefined,
                cursor: markRedactionMode ? 'pointer' : activeId === box.id ? 'grabbing' : 'grab',
                boxSizing: 'border-box',
                touchAction: 'none',
              }}
              title={`Image: ${box.xObjectName}${box.rotated ? ' (rotated)' : ''}${!box.cmPresent ? ' - no cm, drag disabled' : ''}`}
            />
            {activeId === box.id && !markRedactionMode && (
              <div
                data-testid={`image-toolbar-${box.id}`}
                onPointerDown={(e) => e.stopPropagation()}
                style={{
                  position: 'absolute',
                  left: cssX,
                  top: cssY - 32,
                  display: 'flex', gap: 4,
                  padding: '3px 4px',
                  background: 'var(--bg-primary, #1e1e2e)',
                  border: '1px solid var(--border, #45475a)',
                  borderRadius: 4,
                  boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
                  zIndex: 5,
                  fontSize: 11,
                  whiteSpace: 'nowrap',
                }}
              >
                <button onClick={() => applyToolbar(box, 'rot-ccw')} title="Rotate 90° counter-clockwise"
                  style={tbBtn}>↺ 90°</button>
                <button onClick={() => applyToolbar(box, 'rot-cw')} title="Rotate 90° clockwise"
                  style={tbBtn}>↻ 90°</button>
                <button onClick={() => applyToolbar(box, 'flip-h')} title="Flip horizontal"
                  style={tbBtn}>↔ Flip H</button>
                <button onClick={() => applyToolbar(box, 'flip-v')} title="Flip vertical"
                  style={tbBtn}>↕ Flip V</button>
                <button onClick={() => setCropTarget(box.xObjectName)} title="Crop image"
                  style={tbBtn}>✂ Crop</button>
              </div>
            )}
          </div>
        )
      })}
      {cropTarget && (
        <CropImageDialog
          tabId={tabId}
          pageIndex={pageIndex}
          xObjectName={cropTarget}
          onClose={() => setCropTarget(null)}
        />
      )}
    </div>
  )
}

const tbBtn: React.CSSProperties = {
  padding: '2px 6px', fontSize: 11, cursor: 'pointer',
  background: 'var(--bg-surface, #313244)', color: 'var(--text-primary, #cdd6f4)',
  border: '1px solid var(--border, #45475a)', borderRadius: 3,
}
