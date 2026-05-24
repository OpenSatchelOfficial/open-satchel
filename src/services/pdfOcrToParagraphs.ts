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
    // Per-line text join + line break between.
    const text = c.lines
      .map((l) => l.words.map((w) => w.text).join(' '))
      .join('\n')
    out.push({
      id: `ocr_${pageIndex}_${i}`,
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
    return {
      id: op.id,
      itemIndices: [],
      lines: [
        {
          y: vpBbox.y + vpBbox.height,
          fontSize: vpFontSize,
          text: op.text,
          itemIndices: [],
          x: vpBbox.x,
          width: vpBbox.width,
        },
      ],
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
