// S2 — Explicit paragraph reflow.
//
// Acrobat-style text edits are fixed-position by default: deleting a
// paragraph blanks that text box and leaves the rest of the page alone.
// This service only closes the gap for edits that explicitly opt in with
// `flowBehavior: 'flow'`.
//
// This module synthesizes the missing entries. Given the full
// paragraph layout per page (from the editor's clusterer) and the
// user's edits, it returns an enriched edit map where every paragraph
// downstream of a flow edit carries a `positionDelta`. Deletions shift
// followers up by the freed height. Edits whose replacement box grows
// downward shift followers down by the added height. The engine then
// re-emits each shifted paragraph with the same text + a vertical
// translation; the original glyphs are masked at their unmoved
// location, so the visual effect is "blocks make room."
//
// **Single-page**: shift later paragraphs on the SAME page only.
// Handles the 90% case where a body paragraph mid-document is deleted.
//
// **Cross-page**: when the deletion frees enough room that one
// or more later same-page paragraphs would no longer fit on the page
// after the shift, those paragraphs shift up freely (the engine will
// draw them where instructed; bottom-of-page underflow is fine — pdfs
// don't enforce content stay-inside-mediabox). The first paragraph on
// the NEXT page is also shifted up by the leftover delta, with the
// expectation that whoever extends this can chain the shift through
// subsequent pages by walking edges. The engine doesn't need to know
// about cross-page semantics: a positionDelta with negative dy on the
// page-1 paragraph just shifts its draw position upward, which still
// renders within the page-1 mediabox so long as the paragraph's
// original bbox + delta lands inside.

import type { ParagraphEdit, TextAlign } from './pdfParagraphEdits'
import type { PdfLayoutRole } from './pdfLayoutIntelligence'

/** Lightweight subset of a paragraph cluster — only what reflow needs. */
export interface ReflowParagraph {
  paragraphId: string
  bbox: { x: number; y: number; width: number; height: number }
  originalText: string
  fontSize: number
  fontFamily?: string
  bold?: boolean
  italic?: boolean
  align?: TextAlign
  color?: string
  backgroundColor?: string
  layoutRole?: PdfLayoutRole
  layoutSafeForAutoReflow?: boolean
  layoutFlowId?: string
  layoutReasons?: string[]
}

/** What the editor passes us per page: ALL paragraphs in reading
 *  order (top-down, left-to-right within a column), NOT just the
 *  edited ones. */
export type ParagraphsByPage = Map<number, ReflowParagraph[]>

/** What the editor passes us per page: only the user's edits. */
export type EditsByPage = Map<number, ParagraphEdit[]>

export interface ReflowWarning {
  pageIndex: number
  paragraphId: string
  role?: PdfLayoutRole
  reason: string
  /** 'blocked' (default) = the edit was pinned to a fixed text box
   *  (unsafe layout / obstacle collision). 'cross_page' = a reflow shift
   *  pushed text below the page bottom and true multi-page flow is not
   *  implemented, so the save path records it as a fidelity degradation
   *  (layout.cross_page_overflow) rather than the info-level
   *  layout.auto_reflow_blocked. Session 6 D2. */
  kind?: 'blocked' | 'cross_page'
}

export interface ReflowResult {
  editsByPage: EditsByPage
  warnings: ReflowWarning[]
}

/**
 * Detect explicit flow edits (edits with `flowBehavior: 'flow'`):
 * deletions synthesize shift-up entries for paragraphs that should
 * fill the gap; downward-growing replacements synthesize shift-down
 * entries for paragraphs that should make room.
 *
 * Pure function — caller merges the result with their existing edits
 * before sending to bake.
 *
 * **Returns** an enriched copy of `editsByPage`. Existing edits are
 * preserved verbatim; new "shift" entries are appended for paragraphs
 * not already in `editsByPage`. If a paragraph is BOTH already edited
 * (e.g. user changed its color) AND should shift, the existing edit
 * gets a merged positionDelta and the second pass leaves the rest
 * intact.
 *
 * @param paragraphsByPage  All paragraphs per page (top-down sorted).
 * @param editsByPage       The user's existing edits.
 * @param opts.crossPageSpill  When true, leftover delta from the last
 *   shifted paragraph on a page also shifts the first paragraph of
 *   the next page. Default `true`.
 */
export interface ReflowOpts {
  crossPageSpill?: boolean
  /** Per-page usable height (scale=1 viewport coords, same space as the
   *  paragraph bboxes). When provided, a reflow shift that pushes a
   *  paragraph's bottom below the page emits a `kind:'cross_page'`
   *  warning — true multi-page text flow is not implemented, so the save
   *  path records the loss loudly instead of pretending. Session 6 D2. */
  pageHeights?: Map<number, number>
}

export function computeReflowDeltas(
  paragraphsByPage: ParagraphsByPage,
  editsByPage: EditsByPage,
  opts: ReflowOpts = {},
): EditsByPage {
  return computeReflowDeltasWithReport(paragraphsByPage, editsByPage, opts).editsByPage
}

export function computeReflowDeltasWithReport(
  paragraphsByPage: ParagraphsByPage,
  editsByPage: EditsByPage,
  opts: ReflowOpts = {},
): ReflowResult {
  const crossPageSpill = opts.crossPageSpill ?? true
  const result: EditsByPage = new Map()
  const warnings: ReflowWarning[] = []
  for (const [pageIndex, edits] of editsByPage) {
    result.set(pageIndex, edits.map(cloneEdit))
  }
  for (const [pageIndex, paragraphs] of paragraphsByPage) {
    if (!result.has(pageIndex)) result.set(pageIndex, [])
  }

  const sortedPageIndices = [...paragraphsByPage.keys()].sort((a, b) => a - b)
  const flowIds = collectFlowIds(paragraphsByPage, result)
  const crossPageCarryByFlow = new Map<string, number>()

  for (const [pageIndex, edits] of result) {
    const paragraphs = paragraphsByPage.get(pageIndex) ?? []
    const paragraphsById = new Map(paragraphs.map((p) => [p.paragraphId, p]))
    for (const edit of edits) {
      if (edit.flowBehavior !== 'flow' || edit.originalText === '') continue
      const para = paragraphsById.get(edit.paragraphId)
      if (para && !reflowSafe(para, edit)) {
        // Defense in depth: the editor already pins unsafe-layout edits
        // to 'fixed' at blur time, but edits arriving here still marked
        // 'flow' (test drivers, stale persisted edits) get pinned now so
        // bake never treats them as movable.
        edit.flowBehavior = 'fixed'
        warnings.push({
          pageIndex,
          paragraphId: edit.paragraphId,
          role: edit.layoutRole ?? para.layoutRole,
          reason: layoutBlockReason(para, edit),
        })
      }
    }
  }

  for (const flowId of flowIds) {
    for (const pageIndex of sortedPageIndices) {
      const allParagraphs = paragraphsByPage.get(pageIndex) ?? []
      const edits = result.get(pageIndex) ?? []
      const editsByParaId = new Map<string, ParagraphEdit>()
      for (const e of edits) editsByParaId.set(e.paragraphId, e)

      const paragraphs = allParagraphs
        .filter((p) => reflowFlowId(p, editsByParaId.get(p.paragraphId)) === flowId)
      if (paragraphs.length === 0) continue

      // Everything on the page that is NOT part of this flow is a fixed
      // obstacle: unsafe layout regions (tables, forms, invoices,
      // headers...) and members of other flows (e.g. the neighboring
      // column). Reflow must never move text across or into them.
      const obstacles = allParagraphs.filter(
        (p) => reflowFlowId(p, editsByParaId.get(p.paragraphId)) !== flowId,
      )

      // Sort paragraphs top-down (smaller y = nearer top in viewport).
      const sorted = [...paragraphs].sort((a, b) => a.bbox.y - b.bbox.y)

      const carryIn = crossPageCarryByFlow.get(flowId) ?? 0
      crossPageCarryByFlow.set(flowId, 0)

      const plan = planFlowShifts(sorted, editsByParaId, carryIn)
      for (const w of plan.peerWarnings) {
        warnings.push({ pageIndex, ...w })
      }

      // Geometric safety gate: simulate every planned move (and the
      // edited paragraphs' own downward growth) and block the whole
      // flow on this page if any swept band crosses or enters an
      // x-overlapping obstacle. This is what keeps "safe" body flows
      // from sliding over fixed tables/forms interleaved with them.
      const collision = findFlowObstacleCollision(plan, obstacles)
      if (collision) {
        for (const edit of plan.flowEdits) {
          edit.flowBehavior = 'fixed'
          warnings.push({
            pageIndex,
            paragraphId: edit.paragraphId,
            role: edit.layoutRole,
            reason: `fixed layout in the reflow path (${collisionLabel(collision)})`,
          })
        }
        continue
      }

      // Cross-page honesty (Session 6 D2): true multi-page text flow is
      // NOT implemented. The upward deletion nudge (crossPageSpill) is
      // lossless and stays silent, but DOWNWARD growth/shift can push a
      // paragraph below the page bottom, where it is off-page in most
      // viewers. When page geometry is available and that happens, emit a
      // cross_page warning so the save path records it loudly instead of
      // pretending the content still flows onto the next page.
      const pageHeight = opts.pageHeights?.get(pageIndex)
      if (pageHeight !== undefined && pageHeight > 0) {
        const offenders: Array<{ id: string; bottom: number }> = []
        for (const shift of plan.shifts) {
          if (shift.dy <= 0) continue // upward shift never falls off the bottom
          const bottom = shift.para.bbox.y + shift.para.bbox.height + shift.dy
          if (bottom > pageHeight + CROSS_PAGE_TOLERANCE) {
            offenders.push({ id: shift.para.paragraphId, bottom })
          }
        }
        for (const band of plan.growthBands) {
          if (band.bottom > pageHeight + CROSS_PAGE_TOLERANCE) {
            offenders.push({ id: band.edit.paragraphId, bottom: band.bottom })
          }
        }
        if (offenders.length > 0) {
          const worst = offenders.reduce((a, b) => (b.bottom > a.bottom ? b : a))
          warnings.push({
            pageIndex,
            paragraphId: worst.id,
            reason:
              `edited text was pushed below the page bottom (y≈${Math.round(worst.bottom)} ` +
              `> page height ${Math.round(pageHeight)}); true multi-page text flow is not ` +
              'implemented, so the overflowing text is off-page in the saved file',
            kind: 'cross_page',
          })
        }
      }

      for (const shift of plan.shifts) {
        const existingEdit = editsByParaId.get(shift.para.paragraphId)
        if (existingEdit) {
          const prevDx = existingEdit.positionDelta?.dx ?? 0
          const prevDy = existingEdit.positionDelta?.dy ?? 0
          existingEdit.positionDelta = { dx: prevDx, dy: prevDy + shift.dy }
        } else {
          // Synthesize a shift-only edit. newText === originalText so
          // the engine re-draws the same text at the new location.
          // The mask still covers the original location.
          edits.push(synthesizeShiftEdit(shift.para, shift.dy))
        }
      }

      // Page-end: if leftover shift-up remains and we're allowed to
      // spill, remember it for the next page's first paragraph in the
      // same flow region.
      if (crossPageSpill && plan.carryOut > 0.001) {
        crossPageCarryByFlow.set(flowId, plan.carryOut)
      }
    }
  }

  return { editsByPage: result, warnings }
}

interface PlannedShift {
  para: ReflowParagraph
  dy: number
}

interface FlowPlan {
  shifts: PlannedShift[]
  /** Flow-opted edits (safe, non-empty original) driving this flow. */
  flowEdits: ParagraphEdit[]
  /** New page area occupied by an edit's own downward growth:
   *  from the original bottom to the edited bottom. */
  growthBands: Array<{ edit: ParagraphEdit; top: number; bottom: number; x: number; width: number }>
  carryOut: number
  peerWarnings: Array<Omit<ReflowWarning, 'pageIndex'>>
}

/** Pure planning walk: computes every shift the flow wants without
 *  mutating any edit, so the caller can collision-check first. */
function planFlowShifts(
  sorted: ReflowParagraph[],
  editsByParaId: Map<string, ParagraphEdit>,
  carryIn: number,
): FlowPlan {
  const plan: FlowPlan = {
    shifts: [],
    flowEdits: [],
    growthBands: [],
    carryOut: 0,
    peerWarnings: [],
  }
  let cumulativeShift = carryIn

  for (let i = 0; i < sorted.length; i++) {
    const para = sorted[i]
    const existingEdit = editsByParaId.get(para.paragraphId)
    const wantsFlow =
      existingEdit !== undefined &&
      existingEdit.flowBehavior === 'flow' &&
      existingEdit.originalText !== ''
    if (wantsFlow) plan.flowEdits.push(existingEdit)

    // Detection: fixed/undefined deletes blank in place. Only an
    // explicit flow delete is allowed to move later paragraphs.
    const isFlowDeletion = wantsFlow && existingEdit.newText === ''

    if (isFlowDeletion) {
      if (hasSameRowPeer(para, sorted)) {
        plan.peerWarnings.push({
          paragraphId: para.paragraphId,
          role: existingEdit?.layoutRole ?? para.layoutRole,
          reason: 'same-baseline peer detected; treating as fixed layout',
        })
        continue
      }
      // Compute freed height: prefer the gap to the next paragraph
      // in this flow region, fall back to bbox.height + leading when
      // there is no next paragraph in the region.
      const next = sorted[i + 1]
      const freed = next
        ? next.bbox.y - para.bbox.y
        : para.bbox.height + para.fontSize * 0.2
      cumulativeShift += freed
      continue
    }

    // Apply any accumulated shift to this paragraph before this
    // paragraph's own growth contributes to following paragraphs.
    // Viewport y is positive-down. cumulativeShift positive means
    // "move up", so the applied dy is negative; cumulativeShift
    // negative means "move down", so the applied dy is positive.
    if (Math.abs(cumulativeShift) > 0.001) {
      plan.shifts.push({ para, dy: -cumulativeShift })
    }

    const growth = flowGrowthBelowOriginal(para, existingEdit)
    if (growth > 0.001) {
      if (hasSameRowPeer(para, sorted)) {
        plan.peerWarnings.push({
          paragraphId: para.paragraphId,
          role: existingEdit?.layoutRole ?? para.layoutRole,
          reason: 'same-baseline peer detected; treating as fixed layout',
        })
      } else {
        plan.growthBands.push({
          edit: existingEdit!,
          top: para.bbox.y + para.bbox.height,
          bottom: existingEdit!.bbox.y + existingEdit!.bbox.height,
          x: existingEdit!.bbox.x,
          width: existingEdit!.bbox.width,
        })
        cumulativeShift -= growth
      }
    }
  }

  plan.carryOut = cumulativeShift
  return plan
}

interface ObstacleCollision {
  obstacle: ReflowParagraph
  movedParagraphId: string
}

const OBSTACLE_X_OVERLAP_RATIO = 0.25
const OBSTACLE_Y_TOLERANCE = 2
// Slack before a downward shift counts as "off the page bottom" — a
// couple of units of rounding/descent overhang is not a real loss.
const CROSS_PAGE_TOLERANCE = 2

function xOverlaps(
  a: { x: number; width: number },
  b: { x: number; width: number },
): boolean {
  const overlap = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const minWidth = Math.max(1, Math.min(a.width, b.width))
  return overlap / minWidth >= OBSTACLE_X_OVERLAP_RATIO
}

function bandIntrudes(
  top: number,
  bottom: number,
  obstacle: ReflowParagraph,
): boolean {
  const oTop = obstacle.bbox.y
  const oBottom = obstacle.bbox.y + obstacle.bbox.height
  return Math.min(bottom, oBottom) - Math.max(top, oTop) > OBSTACLE_Y_TOLERANCE
}

/** A planned move is unsafe when the swept band of any shifted
 *  paragraph — the union of its old and new vertical extents — or the
 *  freshly occupied growth band of an edited paragraph crosses an
 *  x-overlapping obstacle. Sweeping the travel path (not just the
 *  destination) also rejects "jumps over" fixed content, which would
 *  reorder text relative to fixed neighbors even without overlap. */
function findFlowObstacleCollision(
  plan: FlowPlan,
  obstacles: ReflowParagraph[],
): ObstacleCollision | null {
  if (obstacles.length === 0) return null
  for (const shift of plan.shifts) {
    const { bbox } = shift.para
    const sweptTop = Math.min(bbox.y, bbox.y + shift.dy)
    const sweptBottom = Math.max(bbox.y + bbox.height, bbox.y + bbox.height + shift.dy)
    for (const obstacle of obstacles) {
      if (!xOverlaps(bbox, obstacle.bbox)) continue
      if (bandIntrudes(sweptTop, sweptBottom, obstacle)) {
        return { obstacle, movedParagraphId: shift.para.paragraphId }
      }
    }
  }
  for (const band of plan.growthBands) {
    if (band.bottom - band.top <= OBSTACLE_Y_TOLERANCE) continue
    for (const obstacle of obstacles) {
      if (!xOverlaps(band, obstacle.bbox)) continue
      if (bandIntrudes(band.top, band.bottom, obstacle)) {
        return { obstacle, movedParagraphId: band.edit.paragraphId }
      }
    }
  }
  return null
}

function collisionLabel(collision: ObstacleCollision): string {
  const role = collision.obstacle.layoutRole?.replace(/_/g, ' ')
  if (role) return `would collide with ${role}`
  // Synthetic obstacles (redaction zones) carry no layout role — name
  // them through their first reason instead.
  const reason = collision.obstacle.layoutReasons?.[0]
  return reason ? `would collide with ${reason}` : 'would collide with fixed text'
}

/** UI-side preview of the save-time geometric gate: would this single
 *  flow edit be blocked by a fixed obstacle on its page? Lets the
 *  editor fall back to a fixed text box at blur time so the live
 *  preview matches what save will actually do. */
export function flowEditBlockedByObstacle(
  paragraphs: ReflowParagraph[],
  edit: ParagraphEdit,
  pageIndex = 0,
): ReflowWarning | null {
  const probe = cloneEdit(edit)
  probe.flowBehavior = 'flow'
  const { warnings } = computeReflowDeltasWithReport(
    new Map([[pageIndex, paragraphs]]),
    new Map([[pageIndex, [probe]]]),
    { crossPageSpill: false },
  )
  return warnings.find(
    (w) => w.paragraphId === edit.paragraphId && /reflow path|same-baseline/.test(w.reason),
  ) ?? null
}

function collectFlowIds(
  paragraphsByPage: ParagraphsByPage,
  editsByPage: EditsByPage,
): string[] {
  const out = new Set<string>()
  for (const [pageIndex, paragraphs] of paragraphsByPage) {
    const edits = editsByPage.get(pageIndex) ?? []
    const editsByParaId = new Map(edits.map((e) => [e.paragraphId, e]))
    for (const para of paragraphs) {
      const edit = editsByParaId.get(para.paragraphId)
      const id = reflowFlowId(para, edit)
      if (id) out.add(id)
    }
  }
  return [...out].sort()
}

function reflowFlowId(
  para: ReflowParagraph,
  edit: ParagraphEdit | undefined,
): string | null {
  if (!reflowSafe(para, edit)) return null
  return edit?.layoutFlowId ?? para.layoutFlowId ?? 'legacy-body'
}

function reflowSafe(
  para: ReflowParagraph,
  edit: ParagraphEdit | undefined,
): boolean {
  if (edit?.layoutSafeForAutoReflow === false) return false
  if (para.layoutSafeForAutoReflow === false) return false
  return true
}

function layoutBlockReason(
  para: ReflowParagraph,
  edit: ParagraphEdit | undefined,
): string {
  const role = edit?.layoutRole ?? para.layoutRole
  const reason = edit?.layoutReasons?.[0] ?? para.layoutReasons?.[0]
  const roleText = role ? role.replace(/_/g, ' ') : 'complex layout'
  return reason ? `${roleText}: ${reason}` : `${roleText} is not safe for auto layout`
}

// Form/table rows are fixed-position structures, not flowing prose.
// Deleting a value from "Last Name:  ANDERSON" should blank only that value.
function hasSameRowPeer(para: ReflowParagraph, paragraphs: ReflowParagraph[]): boolean {
  const paraCenterY = para.bbox.y + para.bbox.height / 2
  for (const other of paragraphs) {
    if (other.paragraphId === para.paragraphId) continue
    const otherCenterY = other.bbox.y + other.bbox.height / 2
    const yTolerance = Math.max(3, Math.min(para.fontSize, other.fontSize) * 0.45)
    if (Math.abs(otherCenterY - paraCenterY) > yTolerance) continue

    const overlap =
      Math.min(para.bbox.x + para.bbox.width, other.bbox.x + other.bbox.width) -
      Math.max(para.bbox.x, other.bbox.x)
    const minWidth = Math.max(1, Math.min(para.bbox.width, other.bbox.width))
    if (overlap / minWidth < 0.25) return true
  }
  return false
}

function cloneEdit(e: ParagraphEdit): ParagraphEdit {
  return {
    ...e,
    bbox: { ...e.bbox },
    maskBbox: e.maskBbox ? { ...e.maskBbox } : undefined,
    positionDelta: e.positionDelta ? { ...e.positionDelta } : undefined,
    layoutReasons: e.layoutReasons ? [...e.layoutReasons] : undefined,
  }
}

function flowGrowthBelowOriginal(
  para: ReflowParagraph,
  edit: ParagraphEdit | undefined,
): number {
  if (!edit || edit.flowBehavior !== 'flow') return 0
  if (edit.newText === '' || edit.originalText === '') return 0
  const originalBottom = para.bbox.y + para.bbox.height
  const editedBottom = edit.bbox.y + edit.bbox.height
  return Math.max(0, editedBottom - originalBottom)
}

function synthesizeShiftEdit(
  para: ReflowParagraph,
  shiftDy: number,
): ParagraphEdit {
  return {
    paragraphId: para.paragraphId,
    bbox: { ...para.bbox },
    originalText: para.originalText,
    newText: para.originalText,
    fontSize: para.fontSize,
    fontFamily: para.fontFamily,
    bold: para.bold,
    italic: para.italic,
    align: para.align,
    color: para.color,
    backgroundColor: para.backgroundColor,
    layoutRole: para.layoutRole,
    layoutSafeForAutoReflow: para.layoutSafeForAutoReflow,
    layoutFlowId: para.layoutFlowId,
    layoutReasons: para.layoutReasons,
    positionDelta: { dx: 0, dy: shiftDy },
    flowBehavior: 'flow',
  }
}
