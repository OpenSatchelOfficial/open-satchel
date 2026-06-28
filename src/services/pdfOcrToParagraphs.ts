// Convert OCR word-level output into editable ParagraphBox-shaped
// entries so the paragraph editor can target OCR'd text the same way
// it targets pdfjs-extracted body text. The bridge between
// services/pdfOcr.ts and components/formats/pdf/EditableParagraphLayer.
//
// The clusterer is intentionally simple: bucket words by Y coordinate
// (line band), join consecutive lines whose Y-bands fall within a
// gap-threshold into paragraphs. No font-stack inference (OCR doesn't
// know the source font); paragraphs default to Helvetica + 12pt and
// the bake stage handles font fallback as if they were imported.

import type { OcrPageData } from './pdfOcr'

/** Prefix every OCR-synthesized paragraph id carries. Body-text
 *  paragraph ids (clusterParagraphs) are `p_*`, so this prefix is a
 *  collision-free origin marker. The save seam reads it to record the
 *  OCR-specific degradations (ocr.overlay_only / ocr.style_forced) and
 *  to skip body-clusterer layout enrichment (OCR boxes carry their own
 *  OCR-derived geometry, not body-flow metadata). */
export const OCR_PARAGRAPH_ID_PREFIX = 'ocr_'

/** True when a paragraph id was synthesized by the OCR pipeline. The
 *  one source of truth for OCR origin at the save seam — used instead
 *  of threading a new flag through every edit-rebuild path (a flag a
 *  rebuild could drop; the id is always present on a ParagraphEdit). */
export function isOcrParagraphId(id: string | undefined | null): boolean {
  return typeof id === 'string' && id.startsWith(OCR_PARAGRAPH_ID_PREFIX)
}

/** One recognized line within an OCR paragraph, in OCR pixel coords
 *  (top-left origin, matching the rasterized canvas). */
export interface OcrLine {
  text: string
  x: number
  y: number
  width: number
  height: number
  /** Median word height on this line — a per-line font-size estimate. */
  fontSize: number
}

export interface OcrParagraph {
  /** Stable id derived from page + cluster index. */
  id: string
  /** 0-based page index. */
  pageIndex: number
  /** The clustered text. Words on the same line joined with ' '. */
  text: string
  /** Bbox in viewport (scale=1) coordinates, top-left origin. Same
   *  convention as ParagraphBox so the editor can consume directly. */
  bbox: { x: number; y: number; width: number; height: number }
  /** Words inside this paragraph — useful for sub-cluster reanalysis
   *  (e.g. word-level diff or per-word bbox redaction). */
  words: Array<{ text: string; x: number; y: number; w: number; h: number }>
  /** Estimated font size — derived from the median word height.
   *  Default 12 if the cluster is empty / degenerate. */
  fontSize: number
  /** Per-line geometry (Session 7). Lets the editor/overlay redraw each
   *  recognized line at its real y/x/width instead of collapsing the
   *  whole paragraph into one synthetic line. Top-to-bottom order. */
  lines: OcrLine[]
}

export interface OcrToParagraphsOptions {
  /** Maximum vertical gap between lines (in OCR units, typically pixels)
   *  that still counts as part of the same paragraph. Default 1.4× the
   *  line height of the previous line — matches typographic paragraph
   *  spacing. */
  paragraphGapMultiplier?: number
  /** Minimum word count to emit a paragraph. Filters out OCR noise
   *  (single-pixel artifacts that resolve to empty / one-letter
   *  words). Default 1 (keep everything). */
  minWordsPerParagraph?: number
}

/** Cluster OCR words on a single page into paragraph-shaped entries.
 *  Words come from `OcrPageData.words` with Tesseract-style bboxes
 *  (top-left origin, in pixel coords matching the rasterized canvas). */
export function clusterOcrPageToParagraphs(
  page: OcrPageData,
  pageIndex: number,
  opts: OcrToParagraphsOptions = {},
): OcrParagraph[] {
  const minWords = opts.minWordsPerParagraph ?? 1
  if (!page.words || page.words.length === 0) return []

  // Step 1: bucket words by Y to form lines. Word y is the top edge;
  // we use y + h/2 as the line anchor so words with mismatched
  // heights (e.g. tall caps vs lowercase) still cluster correctly.
  const sorted = [...page.words].sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2))

  type Line = {
    yMid: number
    yMin: number
    yMax: number
    words: typeof sorted
  }
  const lines: Line[] = []
  // Y bucket tolerance: half the median word height. Robust against
  // outlier large/small words.
  const heights = sorted.map((w) => w.h).sort((a, b) => a - b)
  const medH = heights[Math.floor(heights.length / 2)] || 12
  const yTol = Math.max(3, medH * 0.55)

  for (const w of sorted) {
    const wMid = w.y + w.h / 2
    let placed = false
    for (const line of lines) {
      if (Math.abs(line.yMid - wMid) <= yTol) {
        line.words.push(w)
        line.yMin = Math.min(line.yMin, w.y)
        line.yMax = Math.max(line.yMax, w.y + w.h)
        line.yMid = (line.yMin + line.yMax) / 2
        placed = true
        break
      }
    }
    if (!placed) {
      lines.push({ yMid: wMid, yMin: w.y, yMax: w.y + w.h, words: [w] })
    }
  }
  // Sort lines top-to-bottom and words inside each line left-to-right.
  lines.sort((a, b) => a.yMid - b.yMid)
  for (const line of lines) {
    line.words.sort((a, b) => a.x - b.x)
  }

  // Step 2: cluster consecutive lines into paragraphs based on the gap.
  const gapMult = opts.paragraphGapMultiplier ?? 1.4
  type ParaCluster = { lines: Line[] }
  const clusters: ParaCluster[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (clusters.length === 0) {
      clusters.push({ lines: [line] })
      continue
    }
    const prevCluster = clusters[clusters.length - 1]
    const prevLine = prevCluster.lines[prevCluster.lines.length - 1]
    const lineH = prevLine.yMax - prevLine.yMin
    const gap = line.yMin - prevLine.yMax
    if (gap > lineH * gapMult) {
      clusters.push({ lines: [line] })
    } else {
      prevCluster.lines.push(line)
    }
  }

  // Step 3: emit ParagraphBox-shaped entries.
  const out: OcrParagraph[] = []
  for (let i = 0; i < clusters.length; i++) {
    const c = clusters[i]
    const flatWords = c.lines.flatMap((l) => l.words)
    if (flatWords.length < minWords) continue
    const xMin = Math.min(...flatWords.map((w) => w.x))
    const xMax = Math.max(...flatWords.map((w) => w.x + w.w))
    const yMin = Math.min(...flatWords.map((w) => w.y))
    const yMax = Math.max(...flatWords.map((w) => w.y + w.h))
    // Per-line geometry (Session 7) — one OcrLine per recognized line,
    // with a per-line median word-height font-size estimate.
    const paraLines: OcrLine[] = c.lines.map((l) => {
      const lx = Math.min(...l.words.map((w) => w.x))
      const lxMax = Math.max(...l.words.map((w) => w.x + w.w))
      const ly = Math.min(...l.words.map((w) => w.y))
      const lyMax = Math.max(...l.words.map((w) => w.y + w.h))
      const lh = l.words.map((w) => w.h).sort((a, b) => a - b)
      const lineMedH = lh[Math.floor(lh.length / 2)] || medH
      return {
        text: l.words.map((w) => w.text).join(' '),
        x: lx,
        y: ly,
        width: lxMax - lx,
        height: lyMax - ly,
        fontSize: lineMedH,
      }
    })
    // Per-line text join + line break between.
    const text = paraLines.map((l) => l.text).join('\n')
    out.push({
      id: `${OCR_PARAGRAPH_ID_PREFIX}${pageIndex}_${i}`,
      pageIndex,
      text,
      bbox: {
        x: xMin,
        y: yMin,
        width: xMax - xMin,
        height: yMax - yMin,
      },
      words: flatWords,
      fontSize: medH,
      lines: paraLines,
    })
  }
  return out
}

/** Cluster a multi-page OCR result into paragraph entries across
 *  every page. Returns a flat list with the page index baked in. */
export function clusterOcrResultToParagraphs(
  pages: OcrPageData[],
  opts: OcrToParagraphsOptions = {},
): OcrParagraph[] {
  const out: OcrParagraph[] = []
  for (const page of pages) {
    out.push(...clusterOcrPageToParagraphs(page, page.pageNum - 1, opts))
  }
  return out
}

/**
 * Convert OCR-derived paragraphs into ParagraphBox shape for the
 * EditableParagraphLayer. The bbox conversion divides by the OCR
 * scale so the result lands in viewport (scale=1) coords, matching
 * what `clusterParagraphs` returns for body text.
 *
 * `itemIndices` is empty: OCR has no pdfjs TextLayer counterpart,
 * so the surgical content-stream rewrite path can't act on these
 * paragraphs. The bake pipeline falls back to overlay (mask + draw),
 * which is the only sensible approach for image-only pages anyway —
 * there's no extractable text to surgically modify.
 */
export function ocrParagraphsToBoxes(
  ocrParagraphs: OcrParagraph[],
  ocrScale: number,
): Array<{
  id: string
  itemIndices: number[]
  lines: Array<{ y: number; fontSize: number; text: string; itemIndices: number[]; x: number; width: number }>
  bbox: { x: number; y: number; width: number; height: number }
  originalText: string
  fontSize: number
  fontName: string
  fontFamily: string
  italic: boolean
  bold: boolean
  color: string
  onDarkBackground: boolean
  backgroundColor: string
}> {
  return ocrParagraphs.map((op) => {
    const vpBbox = {
      x: op.bbox.x / ocrScale,
      y: op.bbox.y / ocrScale,
      width: op.bbox.width / ocrScale,
      height: op.bbox.height / ocrScale,
    }
    const vpFontSize = op.fontSize / ocrScale
    // One editor line per recognized OCR line (Session 7). `y` is the
    // baseline ≈ the line's bottom edge, matching the ParagraphBox line
    // convention. Falls back to a single full-paragraph line if the
    // per-line geometry is somehow empty (degenerate OCR cluster).
    const boxLines = (op.lines && op.lines.length > 0
      ? op.lines.map((ln) => ({
          y: (ln.y + ln.height) / ocrScale,
          fontSize: ln.fontSize / ocrScale,
          text: ln.text,
          itemIndices: [] as number[],
          x: ln.x / ocrScale,
          width: ln.width / ocrScale,
        }))
      : [
          {
            y: vpBbox.y + vpBbox.height,
            fontSize: vpFontSize,
            text: op.text,
            itemIndices: [] as number[],
            x: vpBbox.x,
            width: vpBbox.width,
          },
        ])
    return {
      id: op.id,
      itemIndices: [],
      lines: boxLines,
      bbox: vpBbox,
      originalText: op.text,
      fontSize: vpFontSize,
      fontName: 'Helvetica',
      fontFamily: 'Helvetica',
      italic: false,
      bold: false,
      color: '#000000',
      onDarkBackground: false,
      backgroundColor: '#ffffff',
    }
  })
}
