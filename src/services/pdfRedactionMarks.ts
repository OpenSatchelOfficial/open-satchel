import { useFormatStore } from '../stores/formatStore'
import { useTabStore } from '../stores/tabStore'
import { useUIStore } from '../stores/uiStore'
import type { PdfFormatState } from '../formats/pdf'

const MARK_FILL = 'rgba(0,0,0,0.05)'
const MARK_STROKE = '#000000'
const MARK_STROKE_WIDTH = 3
const FABRIC_VERSION = '6.9.1'

export interface CssRedactionMarkRect {
  left: number
  top: number
  width: number
  height: number
}

export function redactionMarkTargetId(kind: 'paragraph' | 'image', pageIndex: number, id: string): string {
  return `redaction:${kind}:${pageIndex}:${id}`
}

function finiteNumber(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function paddedRect(
  rect: CssRedactionMarkRect,
  pad: number,
  pageWidth?: number,
  pageHeight?: number,
): CssRedactionMarkRect {
  const maxW = pageWidth && pageWidth > 0 ? pageWidth : Number.POSITIVE_INFINITY
  const maxH = pageHeight && pageHeight > 0 ? pageHeight : Number.POSITIVE_INFINITY
  const left = clamp(finiteNumber(rect.left) - pad, 0, maxW)
  const top = clamp(finiteNumber(rect.top) - pad, 0, maxH)
  const right = clamp(finiteNumber(rect.left + rect.width) + pad, 0, maxW)
  const bottom = clamp(finiteNumber(rect.top + rect.height) + pad, 0, maxH)
  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  }
}

function makeRedactionMarkObject(rect: CssRedactionMarkRect, targetId: string): Record<string, unknown> {
  return {
    rx: 0,
    ry: 0,
    __annotationType: 'redaction_mark',
    __redactionTargetId: targetId,
    __redactionOverlay: true,
    type: 'Rect',
    version: FABRIC_VERSION,
    originX: 'left',
    originY: 'top',
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    fill: MARK_FILL,
    stroke: MARK_STROKE,
    strokeWidth: MARK_STROKE_WIDTH,
    strokeDashArray: null,
    strokeLineCap: 'butt',
    strokeDashOffset: 0,
    strokeLineJoin: 'miter',
    strokeUniform: true,
    strokeMiterLimit: 4,
    scaleX: 1,
    scaleY: 1,
    angle: 0,
    flipX: false,
    flipY: false,
    opacity: 1,
    shadow: null,
    visible: true,
    backgroundColor: '',
    fillRule: 'nonzero',
    paintFirst: 'fill',
    globalCompositeOperation: 'source-over',
    skewX: 0,
    skewY: 0,
    selectable: false,
    evented: false,
    hasControls: false,
    hasBorders: false,
  }
}

function isMarkerForTarget(obj: unknown, targetId: string): boolean {
  if (!obj || typeof obj !== 'object') return false
  const rec = obj as Record<string, unknown>
  return rec.__annotationType === 'redaction_mark' &&
    rec.__redactionTargetId === targetId
}

export function fabricJsonHasRedactionMarkForTarget(fabricJSON: unknown, targetId: string): boolean {
  if (!fabricJSON || typeof fabricJSON !== 'object') return false
  const objects = (fabricJSON as { objects?: unknown }).objects
  return Array.isArray(objects) && objects.some((obj) => isMarkerForTarget(obj, targetId))
}

function disableAutosaveForPendingRedaction(): void {
  const ui = useUIStore.getState()
  if (!ui.autoSaveEnabled) return
  ui.setAutoSaveEnabled(false)
  ui.setSaveNotice({
    tone: 'warn',
    message: 'Autosave turned off while redactions are marked. Use Save when you are ready to permanently apply them.',
    expiresAt: Date.now() + 10000,
  })
}

export function stageElementRedactionMark(args: {
  tabId: string
  pageIndex: number
  rect: CssRedactionMarkRect
  targetId: string
  pageWidth?: number
  pageHeight?: number
  padding?: number
}): void {
  const rect = paddedRect(args.rect, args.padding ?? MARK_STROKE_WIDTH, args.pageWidth, args.pageHeight)
  const mark = makeRedactionMarkObject(rect, args.targetId)

  useFormatStore.getState().updateFormatState<PdfFormatState>(args.tabId, (prev) => ({
    ...prev,
    pages: prev.pages.map((page) => {
      if (page.pageIndex !== args.pageIndex) return page
      const existing = (page.fabricJSON as { version?: string; objects?: unknown[]; background?: unknown } | null) ?? {
        version: FABRIC_VERSION,
        objects: [],
        background: '',
      }
      const objects = Array.isArray(existing.objects) ? existing.objects : []
      return {
        ...page,
        fabricJSON: {
          ...existing,
          version: existing.version ?? FABRIC_VERSION,
          objects: [
            ...objects.filter((obj) => !isMarkerForTarget(obj, args.targetId)),
            mark,
          ],
        },
      }
    }),
  }))
  useTabStore.getState().setTabDirty(args.tabId, true)
  disableAutosaveForPendingRedaction()
}
