import type { ParagraphBox } from './pdfParagraphs'

export type PdfLayoutRole =
  | 'single_column_body'
  | 'multi_column'
  | 'header'
  | 'footer'
  | 'list_item'
  | 'table_cell'
  | 'invoice_pair'
  | 'form_field'
  | 'signature_area'
  | 'repeated_furniture'
  | 'ambiguous'

/** Detected alignment is TRI-STATE by contract (gate-2 P1): 'left' is
 *  emitted only on POSITIVE evidence (flush to the measure's left /
 *  shared left edges); absent means UNKNOWN (no measure, weak
 *  evidence, indented geometry) — never silently rebranded as left.
 *  Consumers must treat absent as "alignment preservation unknowable",
 *  not as a left claim. */
export type PdfDetectedAlign = 'left' | 'center' | 'right' | 'justify'

export interface PdfParagraphLayout {
  role: PdfLayoutRole
  safeForAutoReflow: boolean
  confidence: number
  reasons: string[]
  flowId?: string
  columnIndex?: number
  rowIndex?: number
  repeatedFurniture?: boolean
  /** Detected paragraph alignment (Session 5, R5a). Present ONLY when
   *  the geometry confidently reads non-left; absent means left or
   *  unknown. Detection is conservative by design — a false 'center'
   *  on a left paragraph would re-anchor its edits, while a miss just
   *  keeps today's behavior (left anchor + the alignment_unpreserved
   *  record at the save seam). Mirrored in the Rust port
   *  (crates/satchel-core/src/cluster/layout.rs) — parity policy
   *  applies. */
  align?: PdfDetectedAlign
  /** §5b (weak-evidence alignment): set ONLY when `align` is undefined
   *  AND the geometry gives a LOOSE positive hint that a lone display
   *  line is visually centered (real indent both sides, midpoint near the
   *  measure center, but outside `inferParagraphAlign`'s tight center
   *  tolerance). It exists so a width-changing edit on such a paragraph
   *  can RECORD `layout.alignment_weak_evidence` (info) instead of
   *  shipping a broken center SILENTLY. Deliberately TS-only — it is a
   *  save-degradation hint, NOT a clustering/routing output, so no Rust
   *  parity mirror is required (the golden cluster test compares roles +
   *  geometry, never this). Gated tight to the lone-centered-display-line
   *  class to avoid nagging ordinary left body text. */
  weakCenterEvidence?: boolean
}

export interface LayoutPageContext {
  pageIndex: number
  pageWidth: number
  pageHeight: number
  /** Page /Rotate (degrees, multiples of 90). Non-zero rotation makes
   *  the clusterer's bbox math unreliable, so auto layout is gated. */
  rotation?: number
}

type ClassifiableParagraph = Pick<
  ParagraphBox,
  'id' | 'bbox' | 'lines' | 'originalText' | 'fontSize'
> & { layout?: PdfParagraphLayout }

interface Assignment {
  role: PdfLayoutRole
  safeForAutoReflow: boolean
  confidence: number
  reasons: string[]
  priority: number
  flowId?: string
  columnIndex?: number
  rowIndex?: number
  repeatedFurniture?: boolean
}

interface RowGroup<T extends ClassifiableParagraph> {
  index: number
  centerY: number
  paragraphs: T[]
}

const ROLE_LABEL: Record<PdfLayoutRole, string> = {
  single_column_body: 'single-column body text',
  multi_column: 'multi-column text',
  header: 'header',
  footer: 'footer',
  list_item: 'list item',
  table_cell: 'table cell',
  invoice_pair: 'invoice label/value pair',
  form_field: 'form-like field',
  signature_area: 'signature/certification area',
  repeated_furniture: 'repeated page furniture',
  ambiguous: 'ambiguous layout',
}

const ROLE_PRIORITY: Record<PdfLayoutRole, number> = {
  single_column_body: 10,
  list_item: 35,
  multi_column: 40,
  ambiguous: 55,
  form_field: 70,
  invoice_pair: 81,
  table_cell: 78,
  repeated_furniture: 82,
  footer: 85,
  header: 85,
  signature_area: 95,
}

const LIST_RE = /^\s*(?:[•\u2022*_-]|\d{1,3}[.)]|[A-Za-z][.)]|[ivxlcdm]{1,8}[.)])\s+\S/i
const PAGE_NUMBER_RE = /^\s*(?:page\s*)?\d+(?:\s+of\s+\d+)?\s*$/i
const MONEY_RE = /(?:[$£€]\s*)?\(?\d{1,3}(?:,\d{3})*(?:\.\d{2})?\)?/
const DATE_RE = /\b(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}-\d{2}-\d{2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+\d{4})\b/i
const INVOICE_RE = /\b(?:invoice|subtotal|total|balance|amount|qty|quantity|unit price|rate|due|bill to|ship to|tax|terms|payment|po\s*#?)\b/i
const FORM_LABEL_RE = /\b(?:name|address|phone|email|date of birth|dob|ssn|account|policy|applicant|employer|employee|taxpayer|claim|id\s*#?|signature|initials)\b/i
const FORM_MARK_RE = /(?:_{3,}|-{4,}|□|☐|\[\s*\]|\(\s*\))/
const SIGNATURE_RE = /\b(?:signature|signed by|sign here|authorized signer|certification|certify|docmdp|approval signature|initials)\b/i

function cleanText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Short, isolated text reads as page furniture; multi-line prose that
 *  merely starts inside the header/footer band (tight margins, page-top
 *  continuation paragraphs) does not. */
function isFurnitureLike(p: ClassifiableParagraph, txt: string): boolean {
  return PAGE_NUMBER_RE.test(txt) || (p.lines.length <= 2 && txt.length <= 90)
}

/** A blank-field marker only signals a form when it dominates the text
 *  or the text is label-sized. Long prose with an inline blank
 *  ("...for her novel ____?") or dash runs stays body text — the
 *  geometric obstacle guard still protects any grid below it. */
function hasFormMark(txt: string): boolean {
  const marks = txt.match(new RegExp(FORM_MARK_RE.source, 'g'))
  if (!marks) return false
  if (txt.length <= 80) return true
  const markChars = marks.reduce((sum, m) => sum + m.length, 0)
  return markChars >= txt.length * 0.2
}

function textOf(p: ClassifiableParagraph): string {
  return cleanText(p.originalText || p.lines.map((line) => line.text).join(' '))
}

function centerY(p: ClassifiableParagraph): number {
  return p.bbox.y + p.bbox.height / 2
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function addReason(reasons: string[], reason: string): string[] {
  return reasons.includes(reason) ? reasons : [...reasons, reason]
}

function assign<T extends ClassifiableParagraph>(
  assignments: Map<string, Assignment>,
  p: T,
  role: PdfLayoutRole,
  safeForAutoReflow: boolean,
  confidence: number,
  reason: string,
  patch: Partial<Assignment> = {},
): void {
  const existing = assignments.get(p.id)
  const priority = ROLE_PRIORITY[role]
  if (!existing || priority > existing.priority) {
    assignments.set(p.id, {
      role,
      safeForAutoReflow,
      confidence,
      reasons: [reason],
      priority,
      ...patch,
    })
    return
  }
  existing.reasons = addReason(existing.reasons, reason)
  existing.confidence = Math.max(existing.confidence, confidence)
  if (!safeForAutoReflow) existing.safeForAutoReflow = false
  if (patch.flowId !== undefined) existing.flowId = patch.flowId
  if (patch.columnIndex !== undefined) existing.columnIndex = patch.columnIndex
  if (patch.rowIndex !== undefined) existing.rowIndex = patch.rowIndex
  if (patch.repeatedFurniture !== undefined) existing.repeatedFurniture = patch.repeatedFurniture
}

function rowGroups<T extends ClassifiableParagraph>(paragraphs: T[]): RowGroup<T>[] {
  const sorted = [...paragraphs].sort((a, b) => centerY(a) - centerY(b) || a.bbox.x - b.bbox.x)
  const rows: RowGroup<T>[] = []
  for (const p of sorted) {
    const tol = Math.max(4, p.fontSize * 0.55)
    const row = rows.find((r) => Math.abs(r.centerY - centerY(p)) <= tol)
    if (row) {
      row.paragraphs.push(p)
      row.centerY = median(row.paragraphs.map(centerY))
    } else {
      rows.push({ index: rows.length, centerY: centerY(p), paragraphs: [p] })
    }
  }
  for (const row of rows) row.paragraphs.sort((a, b) => a.bbox.x - b.bbox.x)
  return rows
}

function isShortStructuredCell(p: ClassifiableParagraph): boolean {
  const txt = textOf(p)
  return txt.length <= 48 && p.lines.length <= 2 && p.bbox.height <= Math.max(28, p.fontSize * 2.5)
}

/** Prose discriminator for column-vs-table work (Session 5): wrapped
 *  multi-line text or a sentence-length single line reads as editorial
 *  prose, never as a table cell. The length floor matters — a 2-line
 *  wrapped label/value cell ("Bill To:\nACME Corp") must NOT count as
 *  prose or label stacks qualify column bands. */
function isProseLike(p: ClassifiableParagraph): boolean {
  const txt = textOf(p)
  if (txt.length < 50) return false
  return p.lines.length >= 2 || txt.split(/\s+/).length >= 8
}

/** Band-level prose evidence (Session 5). A single member passing
 *  isProseLike is enough — but the pdfjs clusterer often segments
 *  article columns into per-LINE paragraphs (~25-30 chars each), none
 *  of which qualifies alone, and the differential caught the flagship
 *  two-column fixture freezing on exactly that shape. A vertically
 *  DENSE run of several members with real aggregate text is column
 *  prose; staggered label/value stacks stay sparse (big y-gaps, thin
 *  text) and remain frozen. */
function bandHasProseEvidence<T extends ClassifiableParagraph>(members: T[]): boolean {
  if (members.some(isProseLike)) return true
  if (members.length < 4) return false
  const totalChars = members.reduce((s, p) => s + textOf(p).length, 0)
  if (totalChars < 120) return false
  const sorted = [...members].sort((a, b) => a.bbox.y - b.bbox.y)
  const gaps: number[] = []
  for (let i = 1; i < sorted.length; i++) {
    gaps.push(sorted[i].bbox.y - (sorted[i - 1].bbox.y + sorted[i - 1].bbox.height))
  }
  const fontSizes = members.map((p) => p.fontSize)
  return median(gaps) <= median(fontSizes) * 1.9
}

/** Tight money/value token for the TABLE detector (Session 5). The
 *  shared MONEY_RE matches any 1-3 digit substring (a bare year inside
 *  prose qualifies), which froze short two-column prose rows as table
 *  cells whenever they mentioned a number. Table evidence needs a
 *  value-shaped token: currency-prefixed, thousands-grouped, or
 *  2-decimal. MONEY_RE itself is untouched — the invoice-page rules
 *  deliberately stay loose (freezing invoices is the safe direction). */
const STRICT_VALUE_RE = /[$£€]\s*\d|\b\d{1,3}(?:,\d{3})+(?:\.\d{2})?\b|\b\d+\.\d{2}\b/

function rowHasStructuredSignal<T extends ClassifiableParagraph>(row: RowGroup<T>): boolean {
  return row.paragraphs.some((p) => {
    const txt = textOf(p)
    return STRICT_VALUE_RE.test(txt) ||
      /\b(?:qty|amount|total|price|item|sku|hours|rate|date|invoice)\b/i.test(txt) ||
      /^\d+(?:\.\d+)?%?$/.test(txt)
  })
}

function isLikelyLabel(text: string): boolean {
  const t = cleanText(text)
  return t.length > 0 &&
    t.length <= 42 &&
    /[A-Za-z]/.test(t) &&
    (/:$/.test(t) || FORM_LABEL_RE.test(t) || INVOICE_RE.test(t))
}

function isLikelyValue(text: string): boolean {
  const t = cleanText(text)
  return MONEY_RE.test(t) || DATE_RE.test(t) || /^[A-Z]{1,6}[- ]?\d{2,}/.test(t) || /^\d+(?:\.\d+)?%?$/.test(t)
}

function rowLooksLikeLabelValue<T extends ClassifiableParagraph>(row: RowGroup<T>): boolean {
  if (row.paragraphs.length !== 2) return false
  const [left, right] = row.paragraphs
  const gap = right.bbox.x - (left.bbox.x + left.bbox.width)
  const textLeft = textOf(left)
  const textRight = textOf(right)
  return gap >= Math.max(8, left.fontSize * 0.7) && isLikelyLabel(textLeft) && isLikelyValue(textRight)
}

function pageLooksLikeInvoice<T extends ClassifiableParagraph>(paragraphs: T[]): boolean {
  const allText = paragraphs.map(textOf).join(' ')
  const invoiceSignals = paragraphs.filter((p) => INVOICE_RE.test(textOf(p))).length
  const moneySignals = paragraphs.filter((p) => MONEY_RE.test(textOf(p))).length
  return /\binvoice\b/i.test(allText) && (invoiceSignals >= 2 || moneySignals >= 2)
}

function detectRecurringGridColumns<T extends ClassifiableParagraph>(rows: RowGroup<T>[]): number[] {
  const buckets: Array<{ x: number; rows: Set<number> }> = []
  for (const row of rows) {
    if (row.paragraphs.length < 2) continue
    for (const p of row.paragraphs) {
      const existing = buckets.find((b) => Math.abs(b.x - p.bbox.x) <= 14)
      if (existing) {
        existing.x = (existing.x * existing.rows.size + p.bbox.x) / (existing.rows.size + 1)
        existing.rows.add(row.index)
      } else {
        buckets.push({ x: p.bbox.x, rows: new Set([row.index]) })
      }
    }
  }
  return buckets
    .filter((b) => b.rows.size >= 2)
    .map((b) => b.x)
    .sort((a, b) => a - b)
}

function overlapsRecurringColumn(p: ClassifiableParagraph, columns: number[]): boolean {
  return columns.some((x) => Math.abs(x - p.bbox.x) <= 16)
}

function detectColumnBands<T extends ClassifiableParagraph>(
  paragraphs: T[],
  pageWidth: number,
): Array<{ index: number; x: number; paragraphs: T[] }> {
  const candidates = paragraphs
    .filter((p) => p.bbox.width < pageWidth * 0.68)
    .sort((a, b) => a.bbox.x - b.bbox.x)
  const bands: Array<{ x: number; paragraphs: T[] }> = []
  for (const p of candidates) {
    const tol = Math.max(20, pageWidth * 0.045)
    const band = bands.find((b) => Math.abs(b.x - p.bbox.x) <= tol)
    if (band) {
      band.paragraphs.push(p)
      band.x = median(band.paragraphs.map((q) => q.bbox.x))
    } else {
      bands.push({ x: p.bbox.x, paragraphs: [p] })
    }
  }
  const useful = bands
    .filter((b) => b.paragraphs.length >= 2)
    .sort((a, b) => a.x - b.x)
  if (useful.length < 2) return []
  if (useful[useful.length - 1].x - useful[0].x < pageWidth * 0.22) return []

  const hasVerticalOverlap = useful.some((a, i) => useful.some((b, j) => {
    if (i >= j) return false
    const aTop = Math.min(...a.paragraphs.map((p) => p.bbox.y))
    const aBottom = Math.max(...a.paragraphs.map((p) => p.bbox.y + p.bbox.height))
    const bTop = Math.min(...b.paragraphs.map((p) => p.bbox.y))
    const bBottom = Math.max(...b.paragraphs.map((p) => p.bbox.y + p.bbox.height))
    return Math.min(aBottom, bBottom) - Math.max(aTop, bTop) > 40
  }))
  if (!hasVerticalOverlap) return []

  return useful.map((b, index) => ({ ...b, index }))
}

// ── Detected alignment (Session 5, R5a) ─────────────────────────────
//
// Width-changing edits keep the original Td anchor (left edge), so a
// center/right/justify paragraph whose text changes visually breaks
// alignment while the save report stays clean — proven by the external
// render oracle (.test-mcp/test-alignment-fidelity-live.mjs). The save
// seam consumes this detection to either route the edit to the
// align-aware overlay or record layout.alignment_unpreserved.
//
// Conservative contract: emit non-left ONLY on strong geometric
// evidence; the right-edge evidence must be corroborated OUTSIDE the
// paragraph itself (a second paragraph sharing the page's max right
// edge, or symmetric page margins) so a paragraph can never justify
// itself against its own bounding box — the degenerate case where any
// longest-first-line left paragraph would read as justified.

const ALIGN_EDGE_TOL = 2
const ALIGN_FLUSH_TOL = 1.5

interface AlignMeasure {
  left: number
  right: number
  /** Right edges of all paragraphs (for external corroboration). */
  rightEdges: Array<{ id: string; right: number }>
  /** True when the page's margins look symmetric (maxRight ≈ pageWidth − modalLeft). */
  symmetric: boolean
}

function deriveAlignMeasure<T extends ClassifiableParagraph>(
  paragraphs: T[],
  pageWidth: number,
): AlignMeasure | null {
  if (paragraphs.length < 2) return null
  const lefts = paragraphs.map((p) => p.bbox.x).sort((a, b) => a - b)
  // Modal left edge within tolerance, requiring ≥2 paragraphs; else min.
  let modalLeft = lefts[0]
  let bestCount = 1
  for (let i = 0; i < lefts.length; i++) {
    let count = 1
    let sum = lefts[i]
    for (let j = i + 1; j < lefts.length && lefts[j] - lefts[i] <= ALIGN_EDGE_TOL; j++) {
      count++
      sum += lefts[j]
    }
    if (count > bestCount) {
      bestCount = count
      modalLeft = sum / count
    }
  }
  const rightEdges = paragraphs.map((p) => ({ id: p.id, right: p.bbox.x + p.bbox.width }))
  const maxRight = Math.max(...rightEdges.map((r) => r.right))
  const measure = maxRight - modalLeft
  if (!(measure > pageWidth * 0.3)) return null
  return {
    left: modalLeft,
    right: maxRight,
    rightEdges,
    symmetric: Math.abs(maxRight - (pageWidth - modalLeft)) <= 3,
  }
}

/** True when the page's max-right evidence holds beyond paragraph `id`
 *  itself: another paragraph shares the edge, or the margins are
 *  symmetric. */
function rightEdgeCorroborated(measure: AlignMeasure, id: string): boolean {
  if (measure.symmetric) return true
  return rightEdgeSharedByOther(measure, id)
}

/** Strong corroboration: another PARAGRAPH ends at the measure's right
 *  edge. Margin symmetry deliberately does NOT count here — justify
 *  detection with a single evidence line needs a real second flush
 *  edge, or any left paragraph whose longest line coincidentally hits
 *  the symmetric margin would read as justified. */
function rightEdgeSharedByOther(measure: AlignMeasure, id: string): boolean {
  return measure.rightEdges.some(
    (r) => r.id !== id && Math.abs(r.right - measure.right) <= ALIGN_EDGE_TOL,
  )
}

function inferParagraphAlign<T extends ClassifiableParagraph>(
  p: T,
  measure: AlignMeasure,
): PdfDetectedAlign | undefined {
  const lines = p.lines.filter((l) => l.width > 0)
  if (lines.length === 0) return undefined
  const varMin = Math.max(10, p.fontSize)

  if (lines.length >= 2) {
    const ls = lines.map((l) => l.x)
    const rs = lines.map((l) => l.x + l.width)
    const cs = lines.map((l) => l.x + l.width / 2)
    const lVar = Math.max(...ls) - Math.min(...ls)
    const rVar = Math.max(...rs) - Math.min(...rs)
    const cVar = Math.max(...cs) - Math.min(...cs)

    if (lVar <= ALIGN_FLUSH_TOL) {
      // Shared left edge: left prose or justified. Justify needs every
      // NON-LAST line flush to the page measure's right edge, with the
      // edge corroborated outside this paragraph when only one non-last
      // line exists.
      if (Math.abs(Math.min(...ls) - measure.left) <= ALIGN_EDGE_TOL) {
        const nonLast = rs.slice(0, -1)
        const allFlush =
          nonLast.length >= 1 &&
          nonLast.every((r) => Math.abs(r - measure.right) <= ALIGN_FLUSH_TOL)
        if (allFlush) {
          if (nonLast.length >= 2 || rightEdgeSharedByOther(measure, p.id)) {
            return 'justify'
          }
          // Flush both edges but uncorroborated: genuinely ambiguous
          // between left and justified — UNKNOWN, never a left claim.
          return undefined
        }
      }
      // Shared left edges with ragged right: POSITIVE left evidence.
      return 'left'
    }
    if (rVar <= ALIGN_FLUSH_TOL && lVar >= varMin) return 'right'
    if (cVar <= 3 && lVar >= varMin && rVar >= varMin) return 'center'
    return undefined
  }

  // Single line: measure-based, with the left-flush precedence rule —
  // a line anchored at the measure's left is left text no matter where
  // it ends (a full-measure line is indistinguishable from justified).
  const line = lines[0]
  const L = line.x
  const R = line.x + line.width
  if (Math.abs(L - measure.left) <= ALIGN_EDGE_TOL) return 'left'
  const measureWidth = measure.right - measure.left
  const leftSlack = L - measure.left
  const rightSlack = measure.right - R
  const minSlack = Math.max(12, measureWidth * 0.04)
  if (
    Math.abs(R - measure.right) <= ALIGN_EDGE_TOL &&
    leftSlack >= minSlack &&
    rightEdgeCorroborated(measure, p.id)
  ) {
    return 'right'
  }
  const center = (L + R) / 2
  const measureCenter = (measure.left + measure.right) / 2
  if (
    Math.abs(center - measureCenter) <= Math.max(2, measureWidth * 0.01) &&
    leftSlack >= minSlack &&
    rightSlack >= minSlack &&
    Math.abs(leftSlack - rightSlack) <= Math.max(3, measureWidth * 0.02)
  ) {
    return 'center'
  }
  return undefined
}

/** §5b: a LOOSE positive hint that a lone display line is visually
 *  centered, used ONLY when `inferParagraphAlign` returned undefined (no
 *  confident claim). Tight gate to the true-positive class — a single
 *  line with a real indent on BOTH sides whose midpoint sits near the
 *  measure center — so it fires on centered headings/certificate lines,
 *  not on ordinary left body text (which is left-flush → excluded) or
 *  indented blocks (midpoint far from center → excluded). The center
 *  band (6% of measure width) is deliberately LOOSER than
 *  `inferParagraphAlign`'s 1% strict test, which is exactly why it
 *  catches the lines that fall to undefined there. */
function hasWeakCenterEvidence<T extends ClassifiableParagraph>(
  p: T,
  measure: AlignMeasure,
): boolean {
  const lines = p.lines.filter((l) => l.width > 0)
  if (lines.length !== 1) return false // lone display line only (§5a owns multi-line)
  const measureWidth = measure.right - measure.left
  if (measureWidth <= 0) return false
  const line = lines[0]
  const L = line.x
  const R = line.x + line.width
  const leftSlack = L - measure.left
  const rightSlack = measure.right - R
  const minSlack = Math.max(12, measureWidth * 0.04)
  // Real indent on BOTH sides: a left- or right-flush line is positively
  // classified (or left-claimed) by inferParagraphAlign, never weak.
  if (leftSlack < minSlack || rightSlack < minSlack) return false
  const center = (L + R) / 2
  const measureCenter = (measure.left + measure.right) / 2
  return Math.abs(center - measureCenter) <= measureWidth * 0.06
}

function layoutFromAssignment(a: Assignment): PdfParagraphLayout {
  const {
    priority: _priority,
    ...layout
  } = a
  void _priority
  return {
    ...layout,
    reasons: [...layout.reasons],
  }
}

export function describePdfLayoutRole(role: PdfLayoutRole | undefined): string {
  return role ? ROLE_LABEL[role] : 'unclassified layout'
}

export function isPdfLayoutAutoReflowSafe(layout: PdfParagraphLayout | undefined): boolean {
  return layout?.safeForAutoReflow !== false
}

export function blockedAutoReflowMessage(layout: PdfParagraphLayout | undefined): string {
  const label = describePdfLayoutRole(layout?.role)
  const reason = layout?.reasons?.[0]
  return `Auto layout was skipped for ${label}; this edit was saved as a fixed text box.${reason ? ` (${reason})` : ''}`
}

export function obstacleBlockedAutoReflowMessage(reason?: string): string {
  return (
    'Auto layout was skipped because fixed content sits in the reflow path; ' +
    `this edit was saved as a fixed text box.${reason ? ` (${reason})` : ''}`
  )
}

export function classifyPdfParagraphLayouts<T extends ClassifiableParagraph>(
  paragraphs: T[],
  ctx: LayoutPageContext,
): T[] {
  if (paragraphs.length === 0) return paragraphs

  // Rotated pages (/Rotate 90/180/270 — scanned docs, landscape covers):
  // itemGeometry() maps text coordinates without applying the rotation,
  // so every bbox on such a page is positionally wrong (negative y,
  // swapped axes). Classifying on top of bad geometry could mark text
  // "safe" and let reflow shift it along the wrong axis. Gate the whole
  // page as unsafe until rotation-aware editing lands.
  if (((ctx.rotation ?? 0) % 360 + 360) % 360 !== 0) {
    return paragraphs.map((p) => ({
      ...p,
      layout: {
        role: 'ambiguous' as const,
        safeForAutoReflow: false,
        confidence: 0.9,
        reasons: ['rotated page; auto layout is not supported on rotated pages yet'],
      },
    }))
  }

  const assignments = new Map<string, Assignment>()
  const rows = rowGroups(paragraphs)
  const headerBand = Math.max(44, Math.min(72, ctx.pageHeight * 0.085))
  const footerBand = Math.max(44, Math.min(72, ctx.pageHeight * 0.085))
  const isInvoicePage = pageLooksLikeInvoice(paragraphs)

  for (const row of rows) {
    for (const p of row.paragraphs) {
      const txt = textOf(p)
      const top = p.bbox.y
      const bottom = p.bbox.y + p.bbox.height

      if (SIGNATURE_RE.test(txt)) {
        assign(assignments, p, 'signature_area', false, 0.96, 'signature or certification wording', {
          rowIndex: row.index,
        })
      }

      if (top <= headerBand && isFurnitureLike(p, txt)) {
        const role: PdfLayoutRole = PAGE_NUMBER_RE.test(txt) ? 'repeated_furniture' : 'header'
        assign(assignments, p, role, false, 0.86, 'inside page header band', {
          rowIndex: row.index,
          repeatedFurniture: true,
        })
      } else if (bottom >= ctx.pageHeight - footerBand && isFurnitureLike(p, txt)) {
        const role: PdfLayoutRole = PAGE_NUMBER_RE.test(txt) ? 'repeated_furniture' : 'footer'
        assign(assignments, p, role, false, 0.86, 'inside page footer band', {
          rowIndex: row.index,
          repeatedFurniture: true,
        })
      }

      if (LIST_RE.test(txt)) {
        assign(assignments, p, 'list_item', true, 0.82, 'list marker detected', {
          flowId: 'body',
          rowIndex: row.index,
        })
      }

      if (hasFormMark(txt) || (FORM_LABEL_RE.test(txt) && /:?\s*$/.test(txt) && txt.length <= 50)) {
        assign(assignments, p, 'form_field', false, 0.78, 'form-like label or blank field marker', {
          rowIndex: row.index,
        })
      }
    }

    if (row.paragraphs.length >= 2 && row.paragraphs.some((p) => hasFormMark(textOf(p)))) {
      for (const p of row.paragraphs) {
        assign(assignments, p, 'form_field', false, 0.82, 'shares a row with a blank form marker', {
          rowIndex: row.index,
        })
      }
    }

    if (isInvoicePage && (
      rowLooksLikeLabelValue(row) ||
      row.paragraphs.some((p) => INVOICE_RE.test(textOf(p))) ||
      (row.paragraphs.length >= 2 && row.paragraphs.some((p) => MONEY_RE.test(textOf(p))))
    )) {
      for (const p of row.paragraphs) {
        assign(assignments, p, 'invoice_pair', false, 0.88, 'invoice label/value or amount row', {
          rowIndex: row.index,
        })
      }
    }
  }

  const recurringColumns = detectRecurringGridColumns(rows)
  const structuredRows = rows.filter((row) => {
    if (row.paragraphs.length >= 3) {
      // Prose-vs-cell discrimination (Session 5): a wide row is a table
      // row only when most members read as short structured cells.
      // Genuine multi-column prose sharing a baseline must not freeze
      // as a table — but it does not get a free pass to safety either
      // (see the demotion pass below).
      const shortCells = row.paragraphs.filter(isShortStructuredCell).length
      return shortCells >= Math.ceil(row.paragraphs.length / 2)
    }
    if (row.paragraphs.length < 2) return false
    const structuredCells = row.paragraphs.filter(isShortStructuredCell).length
    const recurringCells = row.paragraphs.filter((p) => overlapsRecurringColumn(p, recurringColumns)).length
    return recurringColumns.length >= 2 &&
      structuredCells === row.paragraphs.length &&
      recurringCells >= 2 &&
      rowHasStructuredSignal(row)
  })

  if (structuredRows.length >= 2 || structuredRows.some((row) => row.paragraphs.length >= 3)) {
    for (const row of structuredRows) {
      for (const p of row.paragraphs) {
        assign(assignments, p, 'table_cell', false, 0.88, 'aligned row/cell grid detected', {
          rowIndex: row.index,
        })
      }
    }
  }

  // Demotion floor (Session 5, preflight P0): a ≥3-member row that did
  // NOT qualify as a table row must never fall through to the safe
  // body default. Non-prose members are pinned ambiguous+frozen HERE —
  // authoritatively, so a list marker or a later column band cannot
  // re-claim them as safe (ambiguous priority 55 outranks list_item 35
  // and multi_column 40, and an unsafe assignment also removes them
  // from the band candidate set). Prose members stay unassigned so a
  // genuine multi-column page can still claim them below.
  for (const row of rows) {
    if (row.paragraphs.length < 3) continue
    if (structuredRows.includes(row)) continue
    for (const p of row.paragraphs) {
      if (isProseLike(p)) continue
      assign(assignments, p, 'ambiguous', false, 0.66, 'short cell in a wide row without table evidence', {
        rowIndex: row.index,
      })
    }
  }

  const safeColumnCandidates = paragraphs.filter((p) => {
    const a = assignments.get(p.id)
    return !a || a.safeForAutoReflow
  })
  const columnBands = detectColumnBands(safeColumnCandidates, ctx.pageWidth)
  if (columnBands.length >= 2) {
    for (const band of columnBands) {
      // A band earns SAFE multi_column only with prose evidence
      // (Session 5): stacks of short label/value cells align by x
      // exactly like article columns do, but reflowing them is a
      // structured-data hazard — they freeze as ambiguous instead.
      // List items keep their own (safe) role either way; a column
      // of bullets is a designed safe shape.
      const bandHasProse = bandHasProseEvidence(band.paragraphs)
      for (const p of band.paragraphs) {
        const existing = assignments.get(p.id)
        const flowId = `column:${ctx.pageIndex}:${band.index}`
        if (existing?.role === 'list_item') {
          existing.flowId = flowId
          existing.columnIndex = band.index
          existing.reasons = addReason(existing.reasons, 'inside multi-column region')
        } else if (!bandHasProse) {
          assign(assignments, p, 'ambiguous', false, 0.62, 'column-like stack of short cells without prose evidence', {
            columnIndex: band.index,
          })
        } else {
          assign(assignments, p, 'multi_column', true, 0.82, 'inside multi-column region', {
            flowId,
            columnIndex: band.index,
          })
        }
      }
    }
  }

  for (const row of rows) {
    // Session 5: widened from exactly-2 to ≥2 — any same-baseline
    // multi-member row whose members no detector positively claimed
    // stays frozen instead of defaulting to the safe body flow.
    if (row.paragraphs.length < 2) continue
    for (const p of row.paragraphs) {
      if (assignments.has(p.id)) continue
      assign(assignments, p, 'ambiguous', false, 0.62, 'same-baseline peer without a safe flow structure', {
        rowIndex: row.index,
      })
    }
  }

  // Detected alignment (Session 5, R5a) — pure geometry, orthogonal to
  // roles. Computed once per page from the paragraph set, attached to
  // every paragraph's layout when confidently non-left.
  const alignMeasure = deriveAlignMeasure(paragraphs, ctx.pageWidth)

  return paragraphs.map((p) => {
    const existing = assignments.get(p.id)
    const layout: PdfParagraphLayout = existing
      ? layoutFromAssignment(existing)
      : {
          role: 'single_column_body' as const,
          safeForAutoReflow: true,
          confidence: 0.74,
          reasons: ['default body-flow region'],
          flowId: 'body',
        }
    if (alignMeasure) {
      const align = inferParagraphAlign(p, alignMeasure)
      if (align) layout.align = align
      // §5b: no confident claim, but a loose hint the lone line is
      // visually centered — surface it so a width-changing edit records
      // the weak-evidence loss instead of shipping a broken center.
      else if (hasWeakCenterEvidence(p, alignMeasure)) layout.weakCenterEvidence = true
    }
    return { ...p, layout }
  })
}
