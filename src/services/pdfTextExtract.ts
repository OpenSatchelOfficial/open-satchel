// PDF Text Extraction + Block Grouping + Operator Mapping
//
// Bridges pdfjs text extraction (positions/fonts) with the content stream
// parser (operator-level access) to enable true text editing.

import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { ParsedContentStream, TextRun } from './contentStreamParser'
import { parseContentStream, getPageContentBytes } from './contentStreamParser'
import { PDFDocument } from 'pdf-lib'

// ── Types ──────────────────────────────────────────────────────────

export interface PdfTextItem {
  str: string
  x: number            // PDF coords (points from left)
  y: number            // PDF coords (points from bottom)
  canvasY: number      // canvas coords (points from top)
  width: number
  height: number
  fontName: string
  fontSize: number
}

export interface TextLine {
  items: PdfTextItem[]
  y: number            // PDF y (bottom-left origin)
  canvasY: number      // canvas y (top-left origin)
  x: number
  width: number
  height: number
  text: string
}

export interface MatchedTextBlock {
  lines: TextLine[]
  text: string
  bounds: { x: number; y: number; width: number; height: number }         // canvas coords
  pdfBounds: { x: number; y: number; width: number; height: number }     // PDF coords
  fontName: string
  fontSize: number
  lineHeight: number
  operatorIndices: number[]
  originalTextRuns: TextRun[]
}

// ── Font Name Mapping ──────────────────────────────────────────────

/** Map PDF internal font names to standard CSS/Fabric-friendly names */
export function mapPdfFontToStandard(pdfFontName: string): string {
  if (!pdfFontName) return 'Helvetica'

  // Strip subset prefix (e.g., "AAAAAB+ArialMT" → "ArialMT")
  let name = pdfFontName
  const plusIdx = name.indexOf('+')
  if (plusIdx >= 0) name = name.substring(plusIdx + 1)

  // Strip pdf-lib generated suffix (e.g., "Helvetica-7098480789" → "Helvetica")
  const dashDigitMatch = name.match(/^(.+?)-\d{5,}$/)
  if (dashDigitMatch) name = dashDigitMatch[1]

  const lower = name.toLowerCase().replace(/[^a-z]/g, '')

  if (lower.includes('arial') || lower.includes('helvetica')) return 'Helvetica'
  if (lower.includes('timesnewroman') || lower.includes('times')) return 'Times-Roman'
  if (lower.includes('couriernew') || lower.includes('courier')) return 'Courier'
  if (lower.includes('georgia')) return 'Georgia'
  if (lower.includes('verdana')) return 'Verdana'
  if (lower.includes('trebuchet')) return 'Trebuchet MS'
  if (lower.includes('impact')) return 'Impact'
  if (lower.includes('comicsans')) return 'Comic Sans MS'

  // If it looks like a real font name, keep it
  if (name.length > 2 && !name.match(/^[gf]_d\d/)) return name

  return 'Helvetica'
}

// ── Text Extraction ────────────────────────────────────────────────

/** Extract text items from a pdfjs page with positional data */
export async function extractTextItems(
  pdfjsDoc: PDFDocumentProxy,
  pageIndex: number
): Promise<{ items: PdfTextItem[]; pageWidth: number; pageHeight: number }> {
  const page = await pdfjsDoc.getPage(pageIndex + 1)
  const viewport = page.getViewport({ scale: 1 })
  const tc = await page.getTextContent()

  const items: PdfTextItem[] = []
  for (const item of tc.items as any[]) {
    if (!item.str || item.str.trim() === '') continue
    const tx = item.transform
    const fontSize = Math.sqrt(tx[0] * tx[0] + tx[1] * tx[1])
    items.push({
      str: item.str,
      x: tx[4],
      y: tx[5],
      canvasY: viewport.height - tx[5],
      width: item.width,
      height: item.height || fontSize,
      fontName: item.fontName || '',
      fontSize,
    })
  }

  page.cleanup()
  return { items, pageWidth: viewport.width, pageHeight: viewport.height }
}

// ── Grouping Algorithm ─────────────────────────────────────────────

/** Group text items into lines (items sharing the same Y baseline) */
function groupIntoLines(items: PdfTextItem[], yTolerance: number = 2.0): TextLine[] {
  if (items.length === 0) return []

  // Sort by canvasY (top to bottom), then x (left to right)
  const sorted = [...items].sort((a, b) => a.canvasY - b.canvasY || a.x - b.x)

  const lines: TextLine[] = []
  let currentItems: PdfTextItem[] = [sorted[0]]
  let currentY = sorted[0].canvasY

  for (let i = 1; i < sorted.length; i++) {
    const item = sorted[i]
    if (Math.abs(item.canvasY - currentY) <= yTolerance) {
      currentItems.push(item)
    } else {
      lines.push(buildLine(currentItems))
      currentItems = [item]
      currentY = item.canvasY
    }
  }
  lines.push(buildLine(currentItems))
  return lines
}

function buildLine(items: PdfTextItem[]): TextLine {
  // Sort by x within the line
  items.sort((a, b) => a.x - b.x)

  // Concatenate text with space heuristic
  let text = ''
  for (let i = 0; i < items.length; i++) {
    if (i > 0) {
      const gap = items[i].x - (items[i - 1].x + items[i - 1].width)
      if (gap > items[i - 1].fontSize * 0.3) text += ' '
    }
    text += items[i].str
  }

  const minX = Math.min(...items.map(it => it.x))
  const maxRight = Math.max(...items.map(it => it.x + it.width))
  const maxHeight = Math.max(...items.map(it => it.height))

  return {
    items,
    y: items[0].y,
    canvasY: items[0].canvasY,
    x: minX,
    width: maxRight - minX,
    height: maxHeight,
    text,
  }
}

/** Group lines into paragraph blocks */
function groupLinesIntoBlocks(lines: TextLine[], pageWidth: number): MatchedTextBlock[] {
  if (lines.length === 0) return []

  const blocks: MatchedTextBlock[] = []
  let currentLines: TextLine[] = [lines[0]]

  for (let i = 1; i < lines.length; i++) {
    const prev = currentLines[currentLines.length - 1]
    const curr = lines[i]

    const lineGap = curr.canvasY - prev.canvasY - prev.height
    const fontSizeChange = Math.abs(
      (curr.items[0]?.fontSize || 12) - (prev.items[0]?.fontSize || 12)
    )
    const leftEdgeShift = Math.abs(curr.x - prev.x)

    let shouldSplit = false
    if (lineGap > prev.height * 1.5) shouldSplit = true         // Large vertical gap
    if (fontSizeChange > 2) shouldSplit = true                    // Heading/body boundary
    if (leftEdgeShift > pageWidth * 0.3) shouldSplit = true      // Column jump

    if (shouldSplit) {
      blocks.push(buildBlock(currentLines))
      currentLines = [curr]
    } else {
      currentLines.push(curr)
    }
  }
  blocks.push(buildBlock(currentLines))
  return blocks
}

function buildBlock(lines: TextLine[]): MatchedTextBlock {
  const text = lines.map(l => l.text).join('\n')

  // Canvas-coord bounds (top-left origin)
  const minX = Math.min(...lines.map(l => l.x))
  const minCanvasY = Math.min(...lines.map(l => l.canvasY))
  const maxRight = Math.max(...lines.map(l => l.x + l.width))
  const maxCanvasBottom = Math.max(...lines.map(l => l.canvasY + l.height))

  // PDF-coord bounds (bottom-left origin)
  const maxPdfY = Math.max(...lines.map(l => l.y))
  const minPdfY = Math.min(...lines.map(l => l.y)) - lines[lines.length - 1].height

  // Dominant font
  const fontCounts = new Map<string, number>()
  const sizeCounts = new Map<number, number>()
  for (const line of lines) {
    for (const item of line.items) {
      fontCounts.set(item.fontName, (fontCounts.get(item.fontName) || 0) + item.str.length)
      const roundedSize = Math.round(item.fontSize)
      sizeCounts.set(roundedSize, (sizeCounts.get(roundedSize) || 0) + item.str.length)
    }
  }
  const fontName = [...fontCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || ''
  const fontSize = [...sizeCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 12

  // Line height ratio
  let lineHeight = 1.2
  if (lines.length > 1) {
    const gaps = []
    for (let i = 1; i < lines.length; i++) {
      gaps.push(lines[i].canvasY - lines[i - 1].canvasY)
    }
    const avgGap = gaps.reduce((s, g) => s + g, 0) / gaps.length
    lineHeight = Math.max(1.0, Math.min(2.5, avgGap / fontSize))
  }

  return {
    lines,
    text,
    bounds: {
      x: minX,
      y: minCanvasY,
      width: maxRight - minX,
      height: maxCanvasBottom - minCanvasY,
    },
    pdfBounds: {
      x: minX,
      y: minPdfY,
      width: maxRight - minX,
      height: maxPdfY - minPdfY + fontSize,
    },
    fontName,
    fontSize,
    lineHeight,
    operatorIndices: [],
    originalTextRuns: [],
  }
}

// ── Operator Matching ──────────────────────────────────────────────

/** Match pdfjs text items to content stream TextRuns by position proximity */
function matchBlocksToOperators(
  blocks: MatchedTextBlock[],
  textRuns: TextRun[],
  pageHeight: number,
  posTolerance: number = 5.0
): void {
  for (const block of blocks) {
    const matchedOps = new Set<number>()
    const matchedRuns: TextRun[] = []

    for (const line of block.lines) {
      for (const item of line.items) {
        // Find the closest TextRun by position
        let bestRun: TextRun | null = null
        let bestDist = Infinity

        for (const run of textRuns) {
          // TextRun positions are in PDF coords (bottom-left origin)
          const dx = Math.abs(run.x - item.x)
          const dy = Math.abs(run.y - item.y)
          const dist = dx + dy

          if (dist < bestDist && dist < posTolerance * item.fontSize) {
            bestDist = dist
            bestRun = run
          }
        }

        if (bestRun) {
          matchedOps.add(bestRun.opIndex)
          if (!matchedRuns.includes(bestRun)) matchedRuns.push(bestRun)
        }
      }
    }

    block.operatorIndices = [...matchedOps]
    block.originalTextRuns = matchedRuns
  }
}

// ── Main Entry Point ───────────────────────────────────────────────

/** Extract text blocks from a PDF page with content stream operator mapping */
export async function extractMatchedTextBlocks(
  pdfjsDoc: PDFDocumentProxy,
  pdfLibDoc: PDFDocument,
  pageIndex: number
): Promise<{ blocks: MatchedTextBlock[]; parsed: ParsedContentStream | null }> {
  // Step 1: Extract text items via pdfjs
  const { items, pageWidth, pageHeight } = await extractTextItems(pdfjsDoc, pageIndex)
  if (items.length === 0) return { blocks: [], parsed: null }

  // Step 2: Group into lines then blocks
  const lines = groupIntoLines(items)
  const blocks = groupLinesIntoBlocks(lines, pageWidth)

  // Step 3: Parse content stream
  const streamData = getPageContentBytes(pdfLibDoc, pageIndex)
  let parsed: ParsedContentStream | null = null

  if (streamData) {
    parsed = parseContentStream(streamData.bytes)
    // Step 4: Match blocks to content stream operators
    matchBlocksToOperators(blocks, parsed.textRuns, pageHeight)
  }

  return { blocks, parsed }
}
