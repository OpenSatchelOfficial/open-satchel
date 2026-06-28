import { PDFDocument } from 'pdf-lib'
import type { RedactionRect } from './pdfRedact'

export type FabricObjectRecord = Record<string, unknown>

export interface ManualRedactionPageState {
  pageIndex: number
  deleted: boolean
  fabricJSON: Record<string, unknown> | null
  pageSize?: { width: number; height: number }
}

export interface ManualRedactionDocumentState {
  pages: ManualRedactionPageState[]
}

function finiteNumber(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function fabricObjectsOf(fabricJSON: unknown): FabricObjectRecord[] {
  if (!fabricJSON || typeof fabricJSON !== 'object') return []
  const objects = (fabricJSON as { objects?: unknown }).objects
  return Array.isArray(objects)
    ? objects.filter((obj): obj is FabricObjectRecord => !!obj && typeof obj === 'object')
    : []
}

function colorIsBlack(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const v = value.trim().toLowerCase()
  if (v === 'black' || v === '#000' || v === '#000000' || v === '#000000ff') return true
  const rgb = v.match(/^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*(\d+(?:\.\d+)?))?\s*\)$/)
  if (!rgb) return false
  const [, r, g, b, a] = rgb
  return Number(r) === 0 && Number(g) === 0 && Number(b) === 0 && (a === undefined || Number(a) > 0.99)
}

function strokeIsAbsent(obj: FabricObjectRecord): boolean {
  const stroke = typeof obj.stroke === 'string' ? obj.stroke.trim().toLowerCase() : obj.stroke
  const noStrokeColor = stroke === undefined || stroke === null || stroke === '' || stroke === 'transparent'
  return noStrokeColor && finiteNumber(obj.strokeWidth, 0) <= 0
}

function redactionTargetId(obj: FabricObjectRecord): string | null {
  return typeof obj.__redactionTargetId === 'string' && obj.__redactionTargetId.length > 0
    ? obj.__redactionTargetId
    : null
}

function isMarkedRedactionTarget(obj: FabricObjectRecord): boolean {
  return obj.__redactionMarked === true
}

/** Size of an unrotated, fully opaque, black, stroke-less rect with no
 *  other annotation role — the shape class redaction bars belong to.
 *  Returns null for anything else. */
function opaqueBlackRectSize(obj: FabricObjectRecord): { w: number; h: number } | null {
  if (typeof obj.__annotationType === 'string' && obj.__annotationType !== '') return null
  const type = String(obj.type ?? '').toLowerCase()
  if (type !== 'rect') return null
  if (!colorIsBlack(obj.fill)) return null
  if (!strokeIsAbsent(obj)) return null
  if (finiteNumber(obj.opacity, 1) < 0.99) return null
  if (Math.abs(finiteNumber(obj.angle, 0)) > 0.01) return null
  if (obj.__linkUrl || obj.__fieldName || obj.__isStickyNote || obj.__watermark) return null
  return {
    w: Math.abs(finiteNumber(obj.width, 0) * finiteNumber(obj.scaleX, 1)),
    h: Math.abs(finiteNumber(obj.height, 0) * finiteNumber(obj.scaleY, 1)),
  }
}

function isExplicitRedactionMarker(obj: FabricObjectRecord): boolean {
  if (obj.__annotationType === 'redact' || obj.__annotationType === 'redaction_mark') return true

  // Compatibility for in-session redaction bars serialized before
  // __annotationType was included in Fabric JSON. Keep this narrow so
  // ordinary black shape annotations do not get promoted to redactions.
  const size = opaqueBlackRectSize(obj)
  return !!size && size.w >= 5 && size.h >= 10 && size.h <= 32
}

/** Opaque black rects that look like redaction bars but fail ONLY the
 *  bar-height heuristic (taller than 32 px). They save as ordinary
 *  drawn shapes — content underneath SURVIVES in the file. Callers
 *  surface each one as a `redact.unclassified_opaque_rect` fidelity
 *  degradation so a user who hand-drew a "redaction" learns the bytes
 *  are still there. */
export function findUnclassifiedOpaqueRects(
  fabricJSON: Record<string, unknown> | null,
): FabricObjectRecord[] {
  return fabricObjectsOf(fabricJSON).filter((obj) => {
    if (isManualRedactionObject(obj)) return false
    const size = opaqueBlackRectSize(obj)
    return !!size && size.w >= 5 && size.h > 32
  })
}

export function isManualRedactionObject(obj: FabricObjectRecord): boolean {
  return isExplicitRedactionMarker(obj) || isMarkedRedactionTarget(obj)
}

export function countManualRedactions(state: ManualRedactionDocumentState | null | undefined): number {
  if (!state) return 0
  return state.pages.reduce((sum, page) => {
    const objects = fabricObjectsOf(page.fabricJSON)
    const markerTargetIds = new Set<string>()
    let count = 0
    for (const obj of objects) {
      if (!isExplicitRedactionMarker(obj)) continue
      count += 1
      const targetId = redactionTargetId(obj)
      if (targetId) markerTargetIds.add(targetId)
    }
    for (const obj of objects) {
      if (!isMarkedRedactionTarget(obj)) continue
      const targetId = redactionTargetId(obj)
      if (!targetId || !markerTargetIds.has(targetId)) count += 1
    }
    return sum + count
  }, 0)
}

export function stateHasManualRedactions(state: ManualRedactionDocumentState | null | undefined): boolean {
  return countManualRedactions(state) > 0
}

export function stripManualRedactionObjects(
  fabricJSON: Record<string, unknown> | null,
): { fabricJSON: Record<string, unknown> | null; removed: FabricObjectRecord[] } {
  const objects = fabricObjectsOf(fabricJSON)
  if (objects.length === 0) return { fabricJSON, removed: [] }

  const kept: FabricObjectRecord[] = []
  const removed: FabricObjectRecord[] = []
  for (const obj of objects) {
    if (isManualRedactionObject(obj)) removed.push(obj)
    else kept.push(obj)
  }
  if (removed.length === 0) return { fabricJSON, removed }

  return {
    fabricJSON: {
      ...(fabricJSON ?? {}),
      objects: kept,
    },
    removed,
  }
}

/**
 * Maps a display-frame rect (CropBox-display points, TOP-LEFT origin, in the
 * VISIBLE/rotated frame the Fabric overlay lives in) to the page's INTRINSIC
 * user-space rect (bottom-left origin, CropBox-absolute). Inverts the page
 * /Rotate + CropBox offset by construction — it is the exact inverse of the
 * pdfjs PageViewport transform at scale 1 (verified in the geometry test).
 * For rotation 0 it reduces to add-origin + Y-flip. Pure + unit-testable.
 */
export function displayRectToUserRect(
  disp: { x: number; y: number; width: number; height: number },
  crop: { x: number; y: number; width: number; height: number },
  rotation: number,
): { x: number; y: number; width: number; height: number } {
  const r = ((rotation % 360) + 360) % 360
  const { x: cx, y: cy, width: cw, height: ch } = crop
  const corner = (vx: number, vy: number): [number, number] => {
    switch (r) {
      case 90:
        return [cx + vy, cy + vx]
      case 180:
        return [cx + cw - vx, cy + vy]
      case 270:
        return [cx + cw - vy, cy + ch - vx]
      default:
        return [cx + vx, cy + ch - vy]
    }
  }
  const pts = [
    corner(disp.x, disp.y),
    corner(disp.x + disp.width, disp.y),
    corner(disp.x, disp.y + disp.height),
    corner(disp.x + disp.width, disp.y + disp.height),
  ]
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const x0 = Math.min(...xs)
  const y0 = Math.min(...ys)
  return { x: x0, y: y0, width: Math.max(...xs) - x0, height: Math.max(...ys) - y0 }
}

/**
 * Inverse of {@link displayRectToUserRect}: maps an INTRINSIC user-space rect
 * (bottom-left origin, CropBox-absolute) to the display-frame rect (top-left
 * origin, in the VISIBLE/rotated frame the Fabric overlay lives in) at scale
 * 1. Used by the test-hook mark placement so a synthetic mark over a known
 * user-space target lands where a real draw gesture would on a rotated /
 * offset-CropBox page (so the rotated end-to-end redaction path is testable).
 * Round-trips with displayRectToUserRect to the pixel (verified in the
 * geometry test). Pure + unit-testable.
 */
export function userRectToDisplayRect(
  user: { x: number; y: number; width: number; height: number },
  crop: { x: number; y: number; width: number; height: number },
  rotation: number,
): { x: number; y: number; width: number; height: number } {
  const r = ((rotation % 360) + 360) % 360
  const { x: cx, y: cy, width: cw, height: ch } = crop
  const toVis = (ux: number, uy: number): [number, number] => {
    switch (r) {
      case 90:
        return [uy - cy, ux - cx]
      case 180:
        return [cx + cw - ux, uy - cy]
      case 270:
        return [cy + ch - uy, cx + cw - ux]
      default:
        return [ux - cx, cy + ch - uy]
    }
  }
  const pts = [
    toVis(user.x, user.y),
    toVis(user.x + user.width, user.y),
    toVis(user.x, user.y + user.height),
    toVis(user.x + user.width, user.y + user.height),
  ]
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const x0 = Math.min(...xs)
  const y0 = Math.min(...ys)
  return { x: x0, y: y0, width: Math.max(...xs) - x0, height: Math.max(...ys) - y0 }
}

/**
 * Maps one Fabric redaction object to a PDF-space rect, or THROWS with a
 * reason. Redaction geometry must never degrade silently: a mark the user
 * drew that cannot be mapped to a real page region means the bytes under
 * it would survive the save — that is a failed redaction, not a skippable
 * object (Session-3 P0).
 */
function fabricRedactionObjectToRect(
  obj: FabricObjectRecord,
  page: number,
  pdfW: number,
  pdfH: number,
  zoom: number,
  /** Display-box (CropBox/MediaBox) lower-left origin in user space. The
   *  rendered content's top-left is display (0,0); content operators are in
   *  absolute user space offset by this origin, and the strip works there —
   *  so the rect must add it (Gauntlet R24). Defaults to 0 for standard
   *  origin-(0,0) pages. */
  originX = 0,
  originY = 0,
  /** Page /Rotate (0/90/180/270). The Fabric overlay sits on the rendered,
   *  rotation-applied page, so the display mark must be un-rotated into
   *  intrinsic user space (gauntlet RB-2). Defaults to 0. */
  rotation = 0,
): RedactionRect {
  const z = zoom > 0 ? zoom : 1
  const angle = Math.abs(finiteNumber(obj.angle, 0)) % 360
  if (angle > 0.01 && angle < 359.99) {
    throw new Error(
      `redaction mark is rotated (${finiteNumber(obj.angle, 0)}°) - rotated marks cannot be ` +
        'mapped to an axis-aligned redaction region; redraw the mark without rotation',
    )
  }
  const left = finiteNumber(obj.left, 0)
  const top = finiteNumber(obj.top, 0)
  const rawW = finiteNumber(obj.width, 0) * finiteNumber(obj.scaleX, 1)
  const rawH = finiteNumber(obj.height, 0) * finiteNumber(obj.scaleY, 1)
  const minX = Math.min(left, left + rawW)
  const minY = Math.min(top, top + rawH)
  const width = Math.abs(rawW)
  const height = Math.abs(rawH)
  if (width <= 0 || height <= 0) {
    throw new Error(
      `redaction mark has a degenerate size (${width.toFixed(2)}×${height.toFixed(2)} px) - ` +
        'delete the mark and redraw it over the content to remove',
    )
  }

  // Display-frame rect in CropBox-display points (top-left origin, VISIBLE
  // frame); visW/visH swap on 90/270 because the rendered page is rotated.
  const r = ((rotation % 360) + 360) % 360
  const dispX = minX / z
  const dispY = minY / z
  const dispW = width / z
  const dispH = height / z
  const visW = r === 90 || r === 270 ? pdfH : pdfW
  const visH = r === 90 || r === 270 ? pdfW : pdfH

  // Map display → INTRINSIC user space, inverting rotation + CropBox offset
  // so the rect lands in the same frame the content operators, the strip,
  // and the burn use (gauntlet RB-1 / RB-2 / R24). Unrotated reduces to the
  // prior add-origin + Y-flip.
  const u = displayRectToUserRect(
    { x: dispX, y: dispY, width: dispW, height: dispH },
    { x: originX, y: originY, width: pdfW, height: pdfH },
    r,
  )
  const x0 = clamp(u.x, originX, originX + pdfW)
  const y0 = clamp(u.y, originY, originY + pdfH)
  const x1 = clamp(u.x + u.width, originX, originX + pdfW)
  const y1 = clamp(u.y + u.height, originY, originY + pdfH)
  const redactionW = x1 - x0
  const redactionH = y1 - y0
  if (redactionW <= 0.25 || redactionH <= 0.25) {
    throw new Error(
      `redaction mark maps outside the page bounds (page is ${pdfW.toFixed(0)}×${pdfH.toFixed(0)} pt, ` +
        `mark at css ${minX.toFixed(0)},${minY.toFixed(0)} ${width.toFixed(0)}×${height.toFixed(0)} @zoom ${z}) - ` +
        'delete the mark and redraw it over the content to remove',
    )
  }
  // EXACT display fraction (top-left, fraction of the VISIBLE page) for the
  // GATE-2 pdfium fill witness — derived straight from the display mark, so
  // it is independent of the intrinsic-rect mapping above.
  const viewRect =
    visW > 0 && visH > 0
      ? { x: dispX / visW, y: dispY / visH, width: dispW / visW, height: dispH / visH }
      : undefined
  return {
    page,
    x: x0,
    y: y0,
    width: redactionW,
    height: redactionH,
    ...(viewRect ? { viewRect } : {}),
  }
}

export interface RedactionObstacleRect {
  pageIndex: number
  x: number
  y: number
  width: number
  height: number
}

/** Session 5: redaction mark rects in CLUSTER space (scale-1 CSS,
 *  top-left origin) for use as fixed REFLOW obstacles — auto layout
 *  must never sweep text through a region the user marked for
 *  destruction. Read-only and non-throwing (unlike
 *  fabricRedactionObjectToRect): an unmappable mark is SKIPPED here
 *  because the redaction APPLY stage still refuses it later; obstacle
 *  injection must never fail a save by itself. */
export function collectRedactionObstacleRects(
  pages: ManualRedactionPageState[],
  zoom: number,
): RedactionObstacleRect[] {
  const z = zoom > 0 ? zoom : 1
  const out: RedactionObstacleRect[] = []
  for (const page of pages) {
    if (page.deleted) continue
    for (const obj of fabricObjectsOf(page.fabricJSON)) {
      if (!isManualRedactionObject(obj)) continue
      const angle = Math.abs(finiteNumber(obj.angle, 0)) % 360
      if (angle > 0.01 && angle < 359.99) continue
      const left = finiteNumber(obj.left, 0)
      const top = finiteNumber(obj.top, 0)
      const rawW = finiteNumber(obj.width, 0) * finiteNumber(obj.scaleX, 1)
      const rawH = finiteNumber(obj.height, 0) * finiteNumber(obj.scaleY, 1)
      const width = Math.abs(rawW) / z
      const height = Math.abs(rawH) / z
      if (width <= 0.25 || height <= 0.25) continue
      out.push({
        pageIndex: page.pageIndex,
        x: Math.min(left, left + rawW) / z,
        y: Math.min(top, top + rawH) / z,
        width,
        height,
      })
    }
  }
  return out
}

export async function collectManualRedactionsForSave<T extends ManualRedactionPageState>(
  workingBytes: Uint8Array,
  pages: T[],
  zoom: number,
): Promise<{ pages: T[]; rects: RedactionRect[] }> {
  const removedByPageIndex: FabricObjectRecord[][] = []
  let hasRemoved = false
  const strippedPages = pages.map((page, idx) => {
    const stripped = stripManualRedactionObjects(page.fabricJSON)
    removedByPageIndex[idx] = stripped.removed
    if (stripped.removed.length === 0) return page
    hasRemoved = true
    return { ...page, fabricJSON: stripped.fabricJSON } as T
  })

  if (!hasRemoved) return { pages, rects: [] }

  const sourceDoc = await PDFDocument.load(workingBytes)
  const rects: RedactionRect[] = []
  let outputPageIndex = 0
  for (let pageIdx = 0; pageIdx < strippedPages.length; pageIdx++) {
    const page = strippedPages[pageIdx]
    const removed = removedByPageIndex[pageIdx] ?? []
    if (page.deleted) continue

    if (removed.length > 0) {
      // P0 (Session 3): redaction geometry must come from the REAL page.
      // The old code fell back to an A4 constant (595×842) when neither the
      // page state nor the document had a usable size — every rect computed
      // against the wrong height lands on the wrong content. Refuse instead.
      if (page.pageIndex < 0 || page.pageIndex >= sourceDoc.getPageCount()) {
        throw new Error(
          `Redaction failed: page ${pageIdx + 1} maps to source page index ${page.pageIndex}, ` +
            `which does not exist in the document (${sourceDoc.getPageCount()} page(s)).`,
        )
      }
      const sourcePage = sourceDoc.getPage(page.pageIndex)
      // Page /Rotate is now inverted into intrinsic user space by
      // fabricRedactionObjectToRect → displayRectToUserRect (gauntlet RB-2),
      // so a rotated page no longer refuses; the mark lands on the correct
      // content and the GATE-2 pdfium fill witness confirms it independently.
      const rotation = ((sourcePage.getRotation().angle % 360) + 360) % 360
      let pdfW = finiteNumber(page.pageSize?.width, 0)
      let pdfH = finiteNumber(page.pageSize?.height, 0)
      if (pdfW <= 0 || pdfH <= 0) {
        const size = sourcePage.getSize()
        pdfW = size.width
        pdfH = size.height
      }
      if (pdfW <= 0 || pdfH <= 0) {
        throw new Error(
          `Redaction failed: could not determine the size of page ${pageIdx + 1}, so redaction ` +
            'marks cannot be mapped to PDF coordinates.',
        )
      }

      // Gauntlet R24 (P0 fix): the viewer renders the CropBox region (pdfjs
      // `getViewport` uses `page.view` = CropBox), so the display frame's
      // top-left maps to the CropBox lower-left in user space and its DIMS are
      // the CropBox dims — but the page's content operators (and the strip)
      // are in ABSOLUTE user space. A redaction rect mapped in origin-(0,0)
      // MediaBox space therefore lands `(origin)` away and, when the displaced
      // box covers OTHER content, removes the wrong thing while the
      // region-scoped permanence verifier certifies the misplaced rect clean —
      // a silent leak. Map in the CropBox frame: use the CropBox origin AND
      // dims so both an offset MediaBox (R24) and an inset CropBox (R26) land
      // correctly. For a standard page (no CropBox → defaults to MediaBox,
      // origin 0) this reduces to the prior behavior.
      let originX = 0
      let originY = 0
      try {
        const cb = sourcePage.getCropBox()
        if (cb && finiteNumber(cb.width, 0) > 0 && finiteNumber(cb.height, 0) > 0) {
          originX = finiteNumber(cb.x, 0)
          originY = finiteNumber(cb.y, 0)
          // The display frame the fabric marks live in is the CropBox, so its
          // dims drive the Y-flip — not the MediaBox dims from getSize().
          pdfW = finiteNumber(cb.width, pdfW)
          pdfH = finiteNumber(cb.height, pdfH)
        } else {
          const mb = sourcePage.getMediaBox()
          originX = finiteNumber(mb.x, 0)
          originY = finiteNumber(mb.y, 0)
          // Use the INTRINSIC MediaBox dims (not the viewer's pageSize, which
          // may report the rotated/visible size) so displayRectToUserRect's
          // un-rotation works against the true content frame.
          pdfW = finiteNumber(mb.width, pdfW)
          pdfH = finiteNumber(mb.height, pdfH)
        }
      } catch {
        originX = 0
        originY = 0
      }

      const markerTargetIds = new Set<string>()
      const regionObjects = removed.filter((obj) => {
        if (!isExplicitRedactionMarker(obj)) return false
        const targetId = redactionTargetId(obj)
        if (targetId) markerTargetIds.add(targetId)
        return true
      })
      for (const obj of removed) {
        if (!isMarkedRedactionTarget(obj)) continue
        const targetId = redactionTargetId(obj)
        if (targetId && markerTargetIds.has(targetId)) continue
        regionObjects.push(obj)
      }

      // P0 (Session 3): 1:1 mark→rect accounting. Every redaction object
      // the user drew MUST yield a region; a mark that silently drops here
      // is content the user believes is redacted but whose bytes survive.
      for (const obj of regionObjects) {
        try {
          rects.push(fabricRedactionObjectToRect(obj, outputPageIndex, pdfW, pdfH, zoom, originX, originY, rotation))
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err)
          throw new Error(`Redaction failed on page ${pageIdx + 1}: ${reason}`)
        }
      }
    }

    outputPageIndex += 1
  }

  if (rects.length === 0) {
    throw new Error('Redaction boxes were present, but none mapped to a valid PDF page region.')
  }

  return { pages: strippedPages, rects }
}
