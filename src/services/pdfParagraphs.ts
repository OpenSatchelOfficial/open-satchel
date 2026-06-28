// Cluster pdfjs text items into paragraph-level bounding boxes.
//
// v2 (column-aware). The previous version grouped items into lines by
// Y proximity only, which merged columns on the same baseline into a
// single paragraph (e.g. invoice layouts with "Name..." on the left and
// "Date:..." on the right ended up as one mashed-together block).
//
// Current algorithm:
//   1. Read text items + font-style map from pdfjs.
//   2. Group items into LINE SEGMENTS by Y-proximity; within a Y-line,
//      split on X-gaps > columnGapFactor × fontSize so two visually
//      separate columns become two separate segments.
//   3. Cluster segments into PARAGRAPHS by column alignment
//      (segment.x close to previous), vertical adjacency (line gap
//      near 1× fontSize), and font-size continuity.
//   4. Emit paragraph boxes with union bboxes, resolved font family
//      (from pdfjs styles map), and a best-guess color placeholder.
//
// The output is stable and sorted top-down, left-to-right. Paragraph
// ids are position-based so they're reproducible across clustering runs.

import type { PDFDocumentProxy } from 'pdfjs-dist'
import { PDFDocument } from 'pdf-lib'
import { parseContentStream, getPageContentBytes } from './contentStreamParser'
import type { StyledRun } from './pdfParagraphEdits'
import {
  classifyPdfParagraphLayouts,
  type PdfParagraphLayout,
} from './pdfLayoutIntelligence'

export interface TextItem {
  str: string
  transform: number[]
  width: number
  height: number
  fontName: string
  hasEOL: boolean
}

export interface ParagraphBox {
  id: string
  itemIndices: number[]
  lines: Line[]
  bbox: { x: number; y: number; width: number; height: number }
  originalText: string
  fontSize: number
  fontName: string
  /** Resolved CSS font family from pdfjs styles map (e.g. 'Helvetica',
   *  'Times New Roman'), not the internal pdfjs id. 'sans-serif' if
   *  unknown. */
  fontFamily: string
  /** True if pdfjs reported the style as italic. */
  italic: boolean
  /** Bold heuristic: fontName contains Bold/Black/Heavy. */
  bold: boolean
  /** Sampled text color from the rendered canvas, as hex. Defaults to
   *  black when sampling hasn't run; populated by sampleParagraphColors
   *  after the canvas is available. */
  color: string
  /** True when we detected a dark background behind this paragraph, so
   *  the editor can render edits in white-on-dark without the user
   *  having to set color manually. */
  onDarkBackground: boolean
  /** Sampled background color (hex). Used by save to paint an
   *  invisible-on-the-real-background mask over the original text
   *  before drawing the replacement. Avoids the white-rect-on-dark-
   *  header bug. */
  backgroundColor: string
  /** Styled runs inferred from saved PDF drawing commands. This is used
   *  for reopened rich-text edits whose underline/strike decorations were
   *  saved as PDF strokes rather than as text attributes. */
  runs?: StyledRun[]
  /** Session 5 (R5b): true when this paragraph's font is EMBEDDED in
   *  the document (pdfjs translated it with missingFile === false) but
   *  its real family is UNRECOVERABLE — pdfjs styles report only a
   *  generic fallback AND the commonObjs font object carries no usable
   *  name (CID/Type3/name-table-less subsets). The generic
   *  `fontFamily` stack on this paragraph is then a fallback-of-
   *  necessity, NOT a faithful Standard-14 alias: the save path's
   *  overlay resolution must record font.embed_resolution_failed +
   *  font.substituted instead of the silent "faithful/alias class"
   *  label. Absent/false when the family was recovered, the font is
   *  not embedded, or recovery could not run (operational misses stay
   *  conservative — no false fidelity records). */
  fontFamilyIsGenericFallback?: boolean
  /** Conservative layout role/safety classification used to decide
   *  whether opt-in auto-layout may move neighboring PDF text. */
  layout?: PdfParagraphLayout
}

export interface Line {
  y: number
  fontSize: number
  text: string
  itemIndices: number[]
  x: number
  width: number
}

export interface ClusteringOptions {
  /** Fraction of fontSize allowed as y-delta within the same line. */
  lineTolerance?: number
  /** Fraction of fontSize allowed as gap before we split paragraphs. */
  paragraphGapFactor?: number
  /** Multiple of fontSize that counts as a column break within one y-line.
   *  Defaults to 0.8 — tighter than earlier versions and aligned with pdf.js's
   *  own SPACE_IN_FLOW_MAX_FACTOR (0.6) and pdfminer's char_margin (~1.0 of
   *  fontSize). This splits "Date:  2026-01-24" into two paragraphs when the
   *  label and value sit in separate pdfjs items. */
  columnGapFactor?: number
  /** Max x-offset (in px) between line segments to consider them in the
   *  same column when forming paragraphs. */
  columnAlignmentTolerance?: number
  /** A whitespace-only pdfjs item whose width is ≥ this multiple of fontSize
   *  is treated as a COLUMN SEPARATOR regardless of x-gap (pdfjs reports the
   *  gap between columns as a single synthetic " " item with large width,
   *  which our naive item-to-item gap check would see as gap=0 because the
   *  items touch). Splitting on those makes invoice "Invoice | Date:" and
   *  "Date: | 2026-01-24" layouts produce separate edit boxes. */
  whitespaceItemSplitFactor?: number
  /** If the left segment of two items ends with ':' and the x-gap between
   *  them is ≥ this multiple of fontSize, force a split. Captures the
   *  "Label: Value" pattern industry-standard key/value detectors use. */
  labelColonGapFactor?: number
}

const DEFAULT_OPTS: Required<ClusteringOptions> = {
  lineTolerance: 0.4,
  paragraphGapFactor: 1.8,
  columnGapFactor: 0.8,
  columnAlignmentTolerance: 8,
  whitespaceItemSplitFactor: 0.8,
  labelColonGapFactor: 0.3,
}

// pdfjs's `textContent.styles` is keyed by the same id as item.fontName.
interface PdfjsStyle {
  fontFamily?: string
  ascent?: number
  descent?: number
  vertical?: boolean
}

function itemGeometry(item: TextItem, pageHeight: number) {
  const [a, , , d, e, f] = item.transform
  const fontSize = Math.abs(d) || Math.abs(a)
  const yTop = pageHeight - f - fontSize
  const xLeft = e
  return {
    x: xLeft,
    y: yTop,
    width: Math.max(item.width, 1),
    height: fontSize * 1.2,
    fontSize,
    baselineY: pageHeight - f,
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function mostCommon<T>(values: T[]): T {
  const counts = new Map<T, number>()
  let best: T = values[0]
  let bestCount = 0
  for (const v of values) {
    const c = (counts.get(v) ?? 0) + 1
    counts.set(v, c)
    if (c > bestCount) {
      best = v
      bestCount = c
    }
  }
  return best
}

// pdfjs font family strings are often bare names ('Helvetica') — pick a
// sensible fallback stack so browser rendering is close to canvas.
function normalizeFontFamily(family: string | undefined): string {
  if (!family) return `-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif`
  // Serif-ish keywords → serif stack; monospace → monospace; else sans.
  const f = family.toLowerCase()
  if (/times|serif|garamond|georgia|book|cambria|palatino/.test(f)) {
    return `'${family}', 'Times New Roman', Times, serif`
  }
  if (/courier|mono|console|consolas|menlo|cascadia/.test(f)) {
    return `'${family}', 'Cascadia Code', Consolas, monospace`
  }
  return `'${family}', -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif`
}

// ── Real-family recovery (Session 4, D1a) ─────────────────────────────
//
// pdfjs's `getTextContent().styles[*].fontFamily` exposes embedded
// fonts only as the generic fallbackName ('sans-serif' | 'serif' |
// 'monospace'), so the real family of a designed document never used
// to reach the edit model — every custom-font paragraph clustered as
// 'sans-serif' and the save path silently substituted Standard-14
// without even knowing what it was substituting. These helpers recover
// the real name from the translated font object in `page.commonObjs`
// (populated by getOperatorList(); getTextContent() never commits
// fonts — verified against pdfRedact.ts's getOperatorList precedent).

/** True for pdfjs's generic fallback family names (and missing ones). */
export function isGenericPdfjsFamily(family: string | undefined): boolean {
  if (!family) return true
  const f = family.trim().toLowerCase()
  return f === 'sans-serif' || f === 'serif' || f === 'monospace'
}

/** Strip the 6-uppercase-letter subset tag: 'ABCDEF+Verdanq' → 'Verdanq'. */
export function stripSubsetPrefix(name: string): string {
  return name.replace(/^[A-Z]{6}\+/, '')
}

/** Recover a usable family name from a pdfjs commonObjs font object.
 *  Probes `name` (BaseFont-derived) then `psName`, defensively — the
 *  exact field set varies by font type. Returns null when nothing
 *  better than a generic fallback or a pdfjs internal id is present. */
export function recoverFamilyFromFontObject(fontObj: unknown): string | null {
  if (!fontObj || typeof fontObj !== 'object') return null
  const o = fontObj as { name?: unknown; psName?: unknown }
  for (const candidate of [o.name, o.psName]) {
    if (typeof candidate !== 'string') continue
    const stripped = stripSubsetPrefix(candidate.trim())
    if (!stripped || isGenericPdfjsFamily(stripped)) continue
    // pdfjs internal ids ('g_d0_f1') are not family names.
    if (/^g_d\d+_f\d+$/i.test(stripped)) continue
    return stripped
  }
  return null
}

/** Per-page recovery result: recovered real families by pdfjs font
 *  id, plus the ids whose font program IS embedded but whose name is
 *  unrecoverable (Session 5, R5b — these must fail LOUD at save). */
interface FamilyRecovery {
  families: Map<string, string>
  unrecoverable: Set<string>
  /** Font ids whose recovery probe COMPLETED with a definite answer:
   *  recovered, unrecoverable-but-embedded, or positively NOT embedded
   *  (missingFile === true). Generic-styled fonts NOT in this set are
   *  OPERATIONAL misses (object absent, probe threw, missingFile
   *  indeterminate) — the paragraph's flag stays undefined so the save
   *  seam re-checks and records the unknown instead of treating the
   *  miss as "positively faithful" (gate-2 P1: the tri-state must not
   *  collapse at the source). */
  checked: Set<string>
}

/** Per-page recovery cache. Whole-document loops (find/replace body,
 *  auto-tag, save-time reflow) call clusterParagraphs once per page —
 *  sometimes repeatedly — and pdfjs returns the same PDFPageProxy for
 *  a given page, so a WeakMap keyed on the proxy makes recovery a
 *  once-per-page-per-session cost (and usually free even then: see
 *  recoverRealFamilies' commonObjs-first probe). */
const familyRecoveryCache = new WeakMap<object, FamilyRecovery>()

/** Recover real families for every font whose getTextContent style is
 *  only the generic pdfjs fallbackName. commonObjs is probed first —
 *  fonts land there during normal rendering, so the expensive forced
 *  getOperatorList() pass runs only when some generic font is still
 *  untranslated (headless drivers, cluster-before-first-render). */
async function recoverRealFamilies(
  page: {
    getOperatorList: () => Promise<unknown>
    commonObjs: { has: (n: string) => boolean; get: (n: string) => unknown }
  },
  items: TextItem[],
  styles: Record<string, PdfjsStyle>,
): Promise<FamilyRecovery> {
  const cached = familyRecoveryCache.get(page)
  if (cached) return cached

  const recovered = new Map<string, string>()
  // Session 5 (R5b): a generic-styled font whose translated object IS
  // present with an EMBEDDED program (missingFile === false strictly —
  // undefined stays conservative) but yields no recoverable name is a
  // genuine unrecoverable embedded font, not an operational miss. The
  // save path records the substitution loudly for these.
  const unrecoverable = new Set<string>()
  const genericFontNames = new Set<string>()
  for (const it of items) {
    if (!it.fontName) continue
    if (isGenericPdfjsFamily(styles[it.fontName]?.fontFamily)) {
      genericFontNames.add(it.fontName)
    }
  }

  const checked = new Set<string>()
  const harvest = () => {
    for (const fontName of genericFontNames) {
      if (recovered.has(fontName)) continue
      try {
        if (!page.commonObjs.has(fontName)) continue
        const fontObj = page.commonObjs.get(fontName)
        const family = recoverFamilyFromFontObject(fontObj)
        if (family) {
          recovered.set(fontName, family)
          unrecoverable.delete(fontName)
          checked.add(fontName)
        } else if (fontObj && typeof fontObj === 'object') {
          const missingFile = (fontObj as { missingFile?: unknown }).missingFile
          if (missingFile === false) {
            unrecoverable.add(fontName)
            checked.add(fontName)
          } else if (missingFile === true) {
            // Positively NOT embedded — the generic style is pdfjs's
            // substitution of a missing font, not a recovery failure.
            checked.add(fontName)
          }
          // missingFile indeterminate → stays unchecked (operational).
        }
      } catch {
        /* unresolved object — stays unchecked (operational miss) */
      }
    }
  }

  if (genericFontNames.size > 0) {
    harvest()
    const allWarm = [...genericFontNames].every((n) => {
      try {
        return page.commonObjs.has(n)
      } catch {
        return false
      }
    })
    if (!allWarm) {
      try {
        await page.getOperatorList()
        harvest()
      } catch {
        /* operator list unavailable — keep the generic fallback */
      }
    }
  }

  const result: FamilyRecovery = { families: recovered, unrecoverable, checked }
  familyRecoveryCache.set(page, result)
  return result
}

function isBoldName(fontName: string): boolean {
  return /bold|black|heavy|semibold/i.test(fontName)
}

function isItalicName(fontName: string): boolean {
  return /italic|oblique/i.test(fontName)
}

/**
 * Sample the rendered canvas to infer each paragraph's text color.
 *
 * pdfjs's text items don't carry color information (it lives in the
 * graphics-state colorspace ops of the content stream, which pdfjs
 * doesn't expose on TextContent). So to preserve things like "Invoice"
 * white-on-dark in the header, we sample the raster and derive the
 * text color from background luminance:
 *   - Dark background → text is probably white.
 *   - Light background → text is probably black.
 *
 * This heuristic covers ~99% of real documents. A proper solution
 * would parse the content stream for the sg/rg/k ops preceding each
 * Tj — deferred until someone hits a mid-luminance edge case.
 *
 * `canvas` is the rendered PDF canvas. `pageWidth` is the bbox
 * coordinate space (scale=1 viewport). We derive the bitmap-to-bbox
 * ratio from canvas.width / pageWidth.
 */
/**
 * Read each paragraph's TEXT color from the PDF's own content stream
 * (the authoritative source — whatever color the author explicitly
 * set via `rg` / `g` / `k` / `scn` before the text-showing op). No
 * heuristics, no luminance thresholds, no canvas sampling.
 *
 * Returns a Map keyed by paragraph id. Paragraphs with no matching
 * text run in the content stream are absent from the map — callers
 * should fall back to a sensible default (we default to black
 * elsewhere; the PDF spec's default fill is also black).
 *
 * Matching strategy: each content-stream text run has an (x, y) in
 * PDF user space; each paragraph bbox is in viewport-top-left coords
 * (scale 1). We convert the bbox to user space once per paragraph
 * and pick the first text run that falls inside it. Fast enough for
 * typical invoices (10-200 runs × 10-50 paragraphs) and doesn't need
 * the index alignment that per-span blanking requires.
 */
export async function getParagraphTextColorsFromStream(
  pdfBytes: Uint8Array,
  pageIndex: number,
  paragraphs: ParagraphBox[],
  pageHeight: number,
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  try {
    const doc = await PDFDocument.load(pdfBytes)
    const streamData = getPageContentBytes(doc, pageIndex)
    if (!streamData) return out
    const parsed = parseContentStream(streamData.bytes)
    const toHex = (v: number) =>
      Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0')

    for (const p of paragraphs) {
      const xMin = p.bbox.x - 2
      const xMax = p.bbox.x + p.bbox.width + 2
      const yMinPdf = pageHeight - (p.bbox.y + p.bbox.height) - 2
      const yMaxPdf = pageHeight - p.bbox.y + 2
      // Pick the first run whose position is inside the bbox. Runs
      // within a paragraph almost always share color; if they don't,
      // the user can change it manually via the upcoming color
      // picker.
      const run = parsed.textRuns.find(
        (r) => r.x >= xMin && r.x <= xMax && r.y >= yMinPdf && r.y <= yMaxPdf,
      )
      if (!run) continue
      const c = run.fillColor
      out.set(p.id, `#${toHex(c.r)}${toHex(c.g)}${toHex(c.b)}`)
    }
  } catch {
    // Content stream unavailable / corrupt / compressed in an
    // unsupported way → return empty map; callers default to black.
  }
  return out
}

interface HorizontalStroke {
  x0: number
  x1: number
  y: number
}

function numericArg(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function sameRunDecor(a: StyledRun, b: StyledRun): boolean {
  return (
    Boolean(a.underline) === Boolean(b.underline) &&
    Boolean(a.strikethrough) === Boolean(b.strikethrough)
  )
}

function collectHorizontalStrokes(bytes: Uint8Array): HorizontalStroke[] {
  const parsed = parseContentStream(bytes)
  const strokes: HorizontalStroke[] = []
  let move: { x: number; y: number } | null = null
  let line: { x0: number; y0: number; x1: number; y1: number } | null = null

  for (const op of parsed.operators) {
    if (op.operator === 'm') {
      const x = numericArg(op.args[0])
      const y = numericArg(op.args[1])
      move = x === null || y === null ? null : { x, y }
      line = null
      continue
    }
    if (op.operator === 'l' && move) {
      const x = numericArg(op.args[0])
      const y = numericArg(op.args[1])
      line = x === null || y === null ? null : {
        x0: move.x,
        y0: move.y,
        x1: x,
        y1: y,
      }
      continue
    }
    if (op.operator === 'S' || op.operator === 's') {
      if (line && Math.abs(line.y0 - line.y1) <= 0.75) {
        const x0 = Math.min(line.x0, line.x1)
        const x1 = Math.max(line.x0, line.x1)
        if (x1 - x0 >= 2) strokes.push({ x0, x1, y: (line.y0 + line.y1) / 2 })
      }
      line = null
    }
  }

  return strokes
}

function strokeOverlapsRange(stroke: HorizontalStroke, x0: number, x1: number): boolean {
  const width = Math.max(0, x1 - x0)
  const strokeWidth = Math.max(0, stroke.x1 - stroke.x0)
  if (width <= 0 || strokeWidth <= 0) return false
  const overlap = Math.max(0, Math.min(stroke.x1, x1) - Math.max(stroke.x0, x0))
  return overlap >= Math.min(width, strokeWidth) * 0.45 && overlap >= Math.min(2, width * 0.25)
}

function hasDecorationStroke(
  strokes: HorizontalStroke[],
  x0: number,
  x1: number,
  expectedY: number,
  fontSize: number,
): boolean {
  const yTol = Math.max(1.25, fontSize * 0.18)
  return strokes.some((stroke) =>
    Math.abs(stroke.y - expectedY) <= yTol &&
    strokeOverlapsRange(stroke, x0, x1),
  )
}

function appendStyledRun(runs: StyledRun[], next: StyledRun): void {
  if (!next.text) return
  const last = runs[runs.length - 1]
  if (last && sameRunDecor(last, next)) {
    last.text += next.text
    return
  }
  runs.push(next)
}

function inferRunsForParagraph(
  paragraph: ParagraphBox,
  items: TextItem[],
  pageHeight: number,
  strokes: HorizontalStroke[],
): StyledRun[] | null {
  const runs: StyledRun[] = []
  let decorated = false

  paragraph.lines.forEach((line, lineIndex) => {
    for (const idx of line.itemIndices) {
      const item = items[idx]
      if (!item?.str) continue
      const geom = itemGeometry(item, pageHeight)
      const baselinePdfY = item.transform[5]
      const underlineY = baselinePdfY - geom.fontSize * 0.12
      const strikeY = baselinePdfY + geom.fontSize * 0.32
      const pieces = item.str.split(/(\s+)/).filter((piece) => piece.length > 0)
      const totalChars = Math.max(1, item.str.length)
      let cursorX = geom.x

      for (const piece of pieces) {
        const pieceWidth = geom.width * (piece.length / totalChars)
        const x0 = cursorX
        const x1 = cursorX + pieceWidth
        cursorX = x1
        const underline = hasDecorationStroke(strokes, x0, x1, underlineY, geom.fontSize)
        const strikethrough = hasDecorationStroke(strokes, x0, x1, strikeY, geom.fontSize)
        decorated = decorated || underline || strikethrough
        appendStyledRun(runs, {
          text: piece,
          ...(underline ? { underline: true } : {}),
          ...(strikethrough ? { strikethrough: true } : {}),
        })
      }
    }
    if (lineIndex < paragraph.lines.length - 1) appendStyledRun(runs, { text: '\n' })
  })

  return decorated ? runs : null
}

/**
 * Reconstruct underline/strikethrough run metadata from saved PDF strokes.
 *
 * Our rich-text save path persists underline/strike as real vector lines,
 * because PDF text has no native per-run decoration attribute. On reopen,
 * pdfjs only exposes the text items; without this pass, dragging that text
 * later moves the glyphs but leaves the old decoration strokes behind. We
 * map horizontal strokes back onto the text items whose baselines they sit
 * under/through so subsequent paragraph edits can redraw the same runs.
 */
export async function getParagraphStyledRunsFromStream(
  pdfBytes: Uint8Array,
  pageIndex: number,
  paragraphs: ParagraphBox[],
  pageHeight: number,
  items: TextItem[],
): Promise<Map<string, StyledRun[]>> {
  const out = new Map<string, StyledRun[]>()
  try {
    const doc = await PDFDocument.load(pdfBytes)
    const streamData = getPageContentBytes(doc, pageIndex)
    if (!streamData) return out
    const strokes = collectHorizontalStrokes(streamData.bytes)
    if (strokes.length === 0) return out
    for (const paragraph of paragraphs) {
      const runs = inferRunsForParagraph(paragraph, items, pageHeight, strokes)
      if (runs) out.set(paragraph.id, runs)
    }
  } catch {
    // Unsupported/corrupt streams simply behave like normal plain text.
  }
  return out
}

/**
 * Derive each paragraph's BACKGROUND color from the rendered canvas.
 * Kept from the earlier implementation because the content stream
 * doesn't give us an obvious "what's behind this text" — that's
 * rasterized from fills/images/ops that happen before the text ops.
 * The bg color is only used as the "invisible mask" we paint over
 * the original location at save time, so approximate sampling from
 * the pixel data above the paragraph is sufficient.
 */
export function sampleParagraphBackgrounds(
  canvas: HTMLCanvasElement,
  paragraphs: ParagraphBox[],
  pageWidth: number,
): ParagraphBox[] {
  const ctx = canvas.getContext('2d')
  if (!ctx || pageWidth <= 0 || canvas.width <= 0) return paragraphs
  const scale = canvas.width / pageWidth
  return paragraphs.map((p) => {
    try {
      // Median of bbox interior pixels — glyphs are the minority, so
      // the median channel values land on the background color.
      const bx = Math.max(0, Math.round(p.bbox.x * scale) + 1)
      const by = Math.max(0, Math.round(p.bbox.y * scale) + 1)
      const bw = Math.min(canvas.width - bx, Math.max(2, Math.round(p.bbox.width * scale) - 2))
      const bh = Math.min(canvas.height - by, Math.max(2, Math.round(p.bbox.height * scale) - 2))
      if (bw <= 0 || bh <= 0) return p
      const data = ctx.getImageData(bx, by, bw, bh).data
      const rs: number[] = []
      const gs: number[] = []
      const bs: number[] = []
      for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3] / 255
        if (a < 0.1) continue
        rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2])
      }
      if (rs.length === 0) return p
      const median = (arr: number[]): number => {
        arr.sort((a, b) => a - b)
        const mid = arr.length >> 1
        return arr.length % 2 === 0 ? (arr[mid - 1] + arr[mid]) / 2 : arr[mid]
      }
      const bgR = median(rs), bgG = median(gs), bgB = median(bs)
      const toHex = (v: number) => Math.round(v).toString(16).padStart(2, '0')
      return {
        ...p,
        backgroundColor: `#${toHex(bgR)}${toHex(bgG)}${toHex(bgB)}`,
      }
    } catch {
      return p
    }
  })
}


export async function clusterParagraphs(
  pdfDoc: PDFDocumentProxy,
  pageIndex: number,
  options: ClusteringOptions = {},
): Promise<{ paragraphs: ParagraphBox[]; pageWidth: number; pageHeight: number; items: TextItem[] }> {
  const opts = { ...DEFAULT_OPTS, ...options }
  const page = await pdfDoc.getPage(pageIndex + 1)
  const viewport = page.getViewport({ scale: 1 })
  const pageWidth = viewport.width
  const pageHeight = viewport.height
  const textContent = await page.getTextContent()
  const items = textContent.items as unknown as TextItem[]
  const styles = (textContent.styles ?? {}) as Record<string, PdfjsStyle>

  // Session 4 (D1a): recover real font families for fonts whose style
  // entry is only the generic pdfjs fallback. Fonts land in commonObjs
  // only during rendering / operator-list generation. In the app the
  // page is usually already rendered, so the translated font objects
  // are warm — probe commonObjs FIRST and force a getOperatorList()
  // pass only when some generic font is still missing (headless
  // drivers, cluster-before-first-render). Results cache per page
  // proxy: whole-document loops (find/replace, auto-tag, save-time
  // reflow) call clusterParagraphs repeatedly and must not re-pay the
  // operator-list cost. Best-effort: any failure keeps today's
  // generic behavior.
  const recovery = await recoverRealFamilies(page, items, styles)
  const recoveredFamilies = recovery.families
  page.cleanup()

  type ItemPlus = {
    orig: number
    item: TextItem
    geom: ReturnType<typeof itemGeometry>
    hardBreakBefore: boolean
  }
  const enriched: ItemPlus[] = []
  let pendingHardBreak = false
  items.forEach((it, i) => {
    if (!it.str || !it.str.length) {
      if (it.hasEOL) pendingHardBreak = true
      return
    }
    enriched.push({
      orig: i,
      item: it,
      geom: itemGeometry(it, pageHeight),
      hardBreakBefore: pendingHardBreak,
    })
    pendingHardBreak = false
  })

  // Sort by y (top-down) with ties broken by x (left-right).
  enriched.sort((a, b) => {
    const yDiff = a.geom.y - b.geom.y
    if (Math.abs(yDiff) > Math.min(a.geom.fontSize, b.geom.fontSize) * opts.lineTolerance) {
      return yDiff
    }
    return a.geom.x - b.geom.x
  })

  // Line segments: group by Y, then split on large X gaps.
  // A "segment" is a contiguous run of items that share a baseline AND
  // aren't separated by a wide horizontal gap. Two columns on the same
  // physical line become two segments, not one.
  type Segment = {
    yTop: number
    baselineY: number
    fontSize: number
    items: ItemPlus[]
    xLeft: number
    xRight: number
    hardBreakBefore: boolean
  }
  const segments: Segment[] = []
  let currentYLine: ItemPlus[] = []
  let currentBaseline: number | null = null
  let currentFontSize = 0

  const flushYLine = () => {
    if (currentYLine.length === 0) return
    currentYLine.sort((a, b) => a.geom.x - b.geom.x)

    // Two-pass: first collect split-before indices + items to drop, then
    // build segments. Keeps the control flow simple and guarantees
    // buildSegment never receives an empty array.
    const splitBefore = new Set<number>() // index i where a new segment begins
    const dropItems = new Set<number>()   // indices to omit from every segment

    const isWideWs = (it: ItemPlus): boolean =>
      /^\s+$/.test(it.item.str) &&
      it.geom.width >= it.geom.fontSize * opts.whitespaceItemSplitFactor

    // Any leading wide-whitespace item on a line is a layout gap, not
    // editable content — drop and start the first real segment after it.
    if (currentYLine.length > 0 && isWideWs(currentYLine[0])) {
      dropItems.add(0)
      splitBefore.add(1)
    }

    for (let i = 1; i < currentYLine.length; i++) {
      const prev = currentYLine[i - 1]
      const cur = currentYLine[i]
      const gap = cur.geom.x - (prev.geom.x + prev.geom.width)
      const fs = Math.max(prev.geom.fontSize, cur.geom.fontSize)

      // Signal 1 — visible x-gap between non-whitespace atoms.
      const gapSplit = gap > fs * opts.columnGapFactor

      // Signal 2 — pdfjs often emits a single synthetic " " item with
      // large width to encode an inter-column gap. The atoms around it
      // touch with gap=0, so we detect the whitespace item directly and
      // split BOTH sides of it.
      const curWide = isWideWs(cur)
      const prevWide = isWideWs(prev)

      // Signal 3 — label:value. "Date:" + any nontrivial gap + value.
      const prevStr = prev.item.str.trimEnd()
      const colonSplit =
        prevStr.endsWith(':') && gap >= fs * opts.labelColonGapFactor

      // Signal 4 — overprinted/overlapped text objects. If two
      // rendered text items on the same baseline overlap horizontally,
      // treating them as one line fuses independent Acrobat-style text
      // boxes. Small negative gaps can come from font metrics/kerning,
      // so only split on meaningful overlap.
      const overlapSplit =
        !curWide &&
        !prevWide &&
        gap < -fs * 0.25

      if (curWide) {
        splitBefore.add(i + 1)
        dropItems.add(i)
      } else if (prevWide) {
        splitBefore.add(i)
      } else if (cur.hardBreakBefore || gapSplit || colonSplit || overlapSplit) {
        splitBefore.add(i)
      }
    }

    // Walk the line emitting segments bounded by split points, filtering
    // out dropped items. Skip any resulting segment that's all whitespace.
    const emitSegment = (from: number, to: number) => {
      const items: ItemPlus[] = []
      for (let k = from; k < to; k++) {
        if (!dropItems.has(k)) items.push(currentYLine[k])
      }
      if (items.length === 0) return
      const hasNonWs = items.some((it) => !/^\s*$/.test(it.item.str))
      if (!hasNonWs) return
      segments.push(buildSegment(items))
    }

    let segStart = 0
    for (let i = 1; i <= currentYLine.length; i++) {
      if (i === currentYLine.length || splitBefore.has(i)) {
        emitSegment(segStart, i)
        segStart = i
      }
    }

    currentYLine = []
    currentBaseline = null
    currentFontSize = 0
  }

  const buildSegment = (its: ItemPlus[]): Segment => {
    const xLeft = its[0].geom.x
    const last = its[its.length - 1]
    const xRight = last.geom.x + last.geom.width
    const yTop = Math.min(...its.map((i) => i.geom.y))
    const baseline = median(its.map((i) => i.geom.baselineY))
    const fontSize = median(its.map((i) => i.geom.fontSize))
    return {
      yTop,
      baselineY: baseline,
      fontSize,
      items: its,
      xLeft,
      xRight,
      hardBreakBefore: its[0]?.hardBreakBefore === true,
    }
  }

  for (const it of enriched) {
    const tol = it.geom.fontSize * opts.lineTolerance
    if (currentBaseline !== null && Math.abs(it.geom.baselineY - currentBaseline) <= tol) {
      currentYLine.push(it)
      currentFontSize = Math.max(currentFontSize, it.geom.fontSize)
    } else {
      flushYLine()
      currentYLine = [it]
      currentBaseline = it.geom.baselineY
      currentFontSize = it.geom.fontSize
    }
  }
  flushYLine()

  // Sort segments top-down, left-to-right for deterministic cluster output.
  segments.sort((a, b) => {
    const yDiff = a.yTop - b.yTop
    if (Math.abs(yDiff) > Math.min(a.fontSize, b.fontSize) * opts.lineTolerance) return yDiff
    return a.xLeft - b.xLeft
  })

  // Cluster segments into paragraphs.
  // Rules to stay in the same paragraph:
  //   - column alignment: |this.xLeft - prev.xLeft| <= columnAlignmentTolerance
  //   - vertical adjacency: gap between baselines ≈ 1× fontSize, up to
  //     paragraphGapFactor× before we split
  //   - font-size continuity: ratio not > 1.5 (bigger → heading break)
  const paragraphs: ParagraphBox[] = []
  let currentPara: Segment[] = []
  const paragraphIdCounts = new Map<string, number>()
  const flushPara = () => {
    if (currentPara.length === 0) return
    const itemIndices: number[] = []
    const allLines: Line[] = []
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity
    const fontSizes: number[] = []
    const fontNames: string[] = []
    const texts: string[] = []
    for (const seg of currentPara) {
      const lineText = seg.items.map((i) => i.item.str).join('')
      const lineItemIdx = seg.items.map((i) => i.orig)
      allLines.push({
        y: seg.yTop,
        fontSize: seg.fontSize,
        text: lineText,
        itemIndices: lineItemIdx,
        x: seg.xLeft,
        width: seg.xRight - seg.xLeft,
      })
      texts.push(lineText)
      for (const it of seg.items) {
        itemIndices.push(it.orig)
        fontSizes.push(it.geom.fontSize)
        fontNames.push(it.item.fontName)
        minX = Math.min(minX, it.geom.x)
        minY = Math.min(minY, it.geom.y)
        // Only extend the paragraph's right edge for items that actually
        // render glyphs. pdfjs reports layout-gap whitespace as items
        // with large widths (e.g. between "Invoice" and "Date:" in the
        // invoice header we saw a single " " with width=239 filling the
        // inter-column space). Including that in maxX makes our save-time
        // mask rect cover the next column too — visible bug where
        // editing "Invoice" wipes out the "Date:" label. Skip those.
        const isWhitespaceOnly = !it.item.str || /^\s*$/.test(it.item.str)
        if (!isWhitespaceOnly) {
          maxX = Math.max(maxX, it.geom.x + it.geom.width)
        }
        maxY = Math.max(maxY, it.geom.y + it.geom.height)
      }
    }
    // If every item was whitespace (rare), fall back to the segment's
    // geometric right edge so the bbox still has non-zero width.
    if (maxX === -Infinity) {
      for (const seg of currentPara) {
        maxX = Math.max(maxX, seg.xRight)
      }
    }
    const fontName = mostCommon(fontNames)
    const style = styles[fontName] ?? {}
    const medFontSize = median(fontSizes)
    // Bold detection: pdfjs's internal fontName ('g_d0_f1' etc.) almost
    // never contains 'bold', so the isBoldName(fontName) check rarely
    // fires on real PDFs. Fall back to three signals:
    //   1. Resolved fontFamily from the styles map (e.g. 'Helvetica-Bold')
    //   2. fontName containing 'bold'/'black'/'heavy' (covers some PDFs)
    //   3. Large font size as a weak heading heuristic — titles/headers
    //      are almost always bold in designed documents.
    // Session 4 (D1a): a recovered real family ('ABCDEF+Verdanq' →
    // 'Verdanq') supersedes the generic pdfjs fallback for both the
    // emitted fontFamily and the bold/italic name heuristics (real
    // names carry '-Bold'/'-Italic' suffixes the fallback never had).
    const recoveredFamily = recoveredFamilies.get(fontName)
    const resolvedFamily = recoveredFamily ?? style.fontFamily ?? ''
    // Session 5 (R5b), TRI-STATE (gate-2 P1): true = embedded program
    // with an unrecoverable name (the save path substitutes LOUDLY);
    // false = positively known faithful (real style family, recovered
    // name, or positively-not-embedded); undefined = the recovery
    // probe could not complete — the save seam re-checks and records
    // the unknown.
    const genericStyled = isGenericPdfjsFamily(style.fontFamily)
    const genericFallback: boolean | undefined = !genericStyled
      ? false
      : recoveredFamily !== undefined
        ? false
        : recovery.unrecoverable.has(fontName)
          ? true
          : recovery.checked.has(fontName)
            ? false
            : undefined
    const bold =
      isBoldName(fontName) ||
      isBoldName(resolvedFamily) ||
      medFontSize >= 20
    const baseId = `p_${pageIndex}_${Math.round(minX)}_${Math.round(minY)}`
    const collisionCount = paragraphIdCounts.get(baseId) ?? 0
    paragraphIdCounts.set(baseId, collisionCount + 1)
    const firstItemIndex = itemIndices.length > 0 ? Math.min(...itemIndices) : paragraphs.length
    const paragraphId = collisionCount === 0 ? baseId : `${baseId}_i${firstItemIndex}`
    paragraphs.push({
      id: paragraphId,
      itemIndices,
      lines: allLines,
      bbox: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
      originalText: texts.join('\n'),
      fontSize: medFontSize,
      fontName,
      fontFamily: normalizeFontFamily(recoveredFamily ?? style.fontFamily),
      bold,
      italic: isItalicName(fontName) || isItalicName(resolvedFamily),
      color: '#000000',
      onDarkBackground: false,
      backgroundColor: '#ffffff',
      ...(genericFallback !== undefined ? { fontFamilyIsGenericFallback: genericFallback } : {}),
    })
    currentPara = []
  }

  let prev: Segment | null = null
  for (const seg of segments) {
    if (!prev) {
      currentPara = [seg]
      prev = seg
      continue
    }
    const colAligned = Math.abs(seg.xLeft - prev.xLeft) <= opts.columnAlignmentTolerance
    const expectedGap = (prev.fontSize + seg.fontSize) / 2
    // gap between baselines — prev is higher-up on screen (smaller y),
    // seg below it. Expected line-to-line gap ≈ fontSize × 1.0–1.4.
    const baselineGap = seg.baselineY - prev.baselineY
    // baselineY is pageHeight - PDF-Y so increases top-to-bottom.
    const gapOk = baselineGap > 0 && baselineGap <= expectedGap * opts.paragraphGapFactor
    const fontSizeRatio =
      Math.max(prev.fontSize, seg.fontSize) /
      Math.max(Math.min(prev.fontSize, seg.fontSize), 1)
    const sizeCompat = fontSizeRatio <= 1.5
    if (!seg.hardBreakBefore && colAligned && gapOk && sizeCompat) {
      currentPara.push(seg)
    } else {
      flushPara()
      currentPara = [seg]
    }
    prev = seg
  }
  flushPara()

  const classified = classifyPdfParagraphLayouts(paragraphs, {
    pageIndex,
    pageWidth,
    pageHeight,
    rotation: viewport.rotation ?? 0,
  })

  return { paragraphs: classified, pageWidth, pageHeight, items }
}
