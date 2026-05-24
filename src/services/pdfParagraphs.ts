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
  page.cleanup()

  type ItemPlus = {
    orig: number
    item: TextItem
    geom: ReturnType<typeof itemGeometry>
  }
  const enriched: ItemPlus[] = []
  items.forEach((it, i) => {
    if (!it.str || !it.str.length) return
    enriched.push({ orig: i, item: it, geom: itemGeometry(it, pageHeight) })
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

      if (curWide) {
        splitBefore.add(i + 1)
        dropItems.add(i)
      } else if (prevWide) {
        splitBefore.add(i)
      } else if (gapSplit || colonSplit) {
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
    return { yTop, baselineY: baseline, fontSize, items: its, xLeft, xRight }
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
    const resolvedFamily = style.fontFamily ?? ''
    const bold =
      isBoldName(fontName) ||
      isBoldName(resolvedFamily) ||
      medFontSize >= 20
    paragraphs.push({
      id: `p_${pageIndex}_${Math.round(minX)}_${Math.round(minY)}`,
      itemIndices,
      lines: allLines,
      bbox: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
      originalText: texts.join('\n'),
      fontSize: medFontSize,
      fontName,
      fontFamily: normalizeFontFamily(style.fontFamily),
      bold,
      italic: isItalicName(fontName) || isItalicName(resolvedFamily),
      color: '#000000',
      onDarkBackground: false,
      backgroundColor: '#ffffff',
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
    if (colAligned && gapOk && sizeCompat) {
      currentPara.push(seg)
    } else {
      flushPara()
      currentPara = [seg]
    }
    prev = seg
  }
  flushPara()

  return { paragraphs, pageWidth, pageHeight, items }
}
