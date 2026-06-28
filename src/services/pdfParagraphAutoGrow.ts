import type { ParagraphBox } from './pdfParagraphs'
import type { ParagraphEdit } from './pdfParagraphEdits'

const DEFAULT_LINE_HEIGHT = 1.2
const MIN_TEXT_BOX_WIDTH = 12

type PageBounds =
  | { w?: number; h?: number; width?: number; height?: number }
  | null
  | undefined

let measureCanvas: HTMLCanvasElement | null = null

function canonicalFontFamily(raw: string | undefined): string {
  const s = (raw || '').toLowerCase()
  if (s.includes('times') || s.includes('serif')) return 'Times-Roman'
  if (s.includes('courier') || s.includes('mono')) return 'Courier'
  return 'Helvetica'
}

function cssFamily(raw: string | undefined): string {
  const family = canonicalFontFamily(raw)
  if (family === 'Times-Roman') return `"Times New Roman", Times, serif`
  if (family === 'Courier') return `"Courier New", Courier, monospace`
  return `Helvetica, Arial, sans-serif`
}

function fallbackWidth(text: string, fontSize: number, fontFamily: string | undefined): number {
  const family = canonicalFontFamily(fontFamily)
  const factor = family === 'Courier' ? 0.62 : family === 'Times-Roman' ? 0.52 : 0.54
  return text.length * fontSize * factor
}

function makeTextMeasurer(
  fontSize: number,
  fontFamily: string | undefined,
  bold: boolean | undefined,
  italic: boolean | undefined,
): (text: string) => number {
  if (typeof document === 'undefined') {
    return (text) => fallbackWidth(text, fontSize, fontFamily)
  }
  measureCanvas ??= document.createElement('canvas')
  const ctx = measureCanvas.getContext('2d')
  if (!ctx) return (text) => fallbackWidth(text, fontSize, fontFamily)
  ctx.font = `${italic ? 'italic' : 'normal'} ${bold ? 700 : 400} ${fontSize}px ${cssFamily(fontFamily)}`
  return (text) => ctx.measureText(text).width
}

function wrappedLineCount(text: string, maxWidth: number, measure: (text: string) => number): number {
  const hardLines = (text || ' ').replace(/\r/g, '').split('\n')
  let count = 0
  for (const hardLine of hardLines) {
    if (hardLine.length === 0) {
      count += 1
      continue
    }
    const tokens = hardLine.split(/(\s+)/).filter((token) => token.length > 0)
    let line = ''
    for (const token of tokens) {
      const candidate = line + token
      if (line.trim().length > 0 && measure(candidate.trimEnd()) > maxWidth) {
        count += 1
        line = token.trimStart()
      } else {
        line = candidate
      }
    }
    count += 1
  }
  return Math.max(1, count)
}

function runAwareMetrics(
  edit: ParagraphEdit,
  para: ParagraphBox,
): { widestWord: number; widestHardLine: number; maxFontSize: number } | null {
  const runs = edit.runs
  if (!runs || runs.length === 0) return null
  let widestWord = 0
  const hardLineWidths = [0]
  let maxFontSize = Math.max(1, edit.fontSize ?? para.fontSize ?? 12)

  for (const run of runs) {
    const fontSize = Math.max(1, run.fontSize ?? edit.fontSize ?? para.fontSize ?? 12)
    maxFontSize = Math.max(maxFontSize, fontSize)
    const measure = makeTextMeasurer(
      fontSize,
      edit.fontFamily ?? para.fontFamily,
      run.bold ?? edit.bold ?? para.bold,
      run.italic ?? edit.italic ?? para.italic,
    )
    const parts = run.text.replace(/\r/g, '').split('\n')
    parts.forEach((part, index) => {
      if (index > 0) hardLineWidths.push(0)
      hardLineWidths[hardLineWidths.length - 1] += measure(part)
      for (const word of part.match(/\S+/g) ?? []) {
        widestWord = Math.max(widestWord, measure(word))
      }
    })
  }

  return {
    widestWord,
    widestHardLine: hardLineWidths.reduce((max, width) => Math.max(max, width), 0),
    maxFontSize,
  }
}

function pageLimit(pageSize: PageBounds, axis: 'width' | 'height'): number {
  if (!pageSize) return Number.POSITIVE_INFINITY
  if (axis === 'width') return pageSize.w ?? pageSize.width ?? Number.POSITIVE_INFINITY
  return pageSize.h ?? pageSize.height ?? Number.POSITIVE_INFINITY
}

export function paragraphStylePatchNeedsAutoGrow(patch: Partial<ParagraphEdit>): boolean {
  return (
    patch.bbox === undefined &&
    (
      patch.fontSize !== undefined ||
      patch.fontFamily !== undefined ||
      patch.bold !== undefined ||
      patch.italic !== undefined ||
      patch.lineHeight !== undefined
    )
  )
}

export function growParagraphBboxForStyledText(
  para: ParagraphBox,
  edit: ParagraphEdit,
  pageSize?: PageBounds,
): ParagraphBox['bbox'] {
  const base = edit.bbox ?? para.bbox
  const text = edit.newText ?? para.originalText ?? ''
  const richMetrics = runAwareMetrics(edit, para)
  const fontSize = richMetrics?.maxFontSize ?? Math.max(1, edit.fontSize ?? para.fontSize ?? 12)
  const lineHeight = Math.max(0.5, edit.lineHeight ?? DEFAULT_LINE_HEIGHT)
  const padding = Math.max(2, fontSize * 0.12)
  const measure = makeTextMeasurer(
    fontSize,
    edit.fontFamily ?? para.fontFamily,
    edit.bold ?? para.bold,
    edit.italic ?? para.italic,
  )
  const hardLines = (text || ' ').replace(/\r/g, '').split('\n')
  const words = text.match(/\S+/g) ?? []
  const widestWord = richMetrics?.widestWord ?? words.reduce((max, word) => Math.max(max, measure(word)), 0)
  const widestHardLine = richMetrics?.widestHardLine ?? hardLines.reduce((max, line) => Math.max(max, measure(line)), 0)
  // Browser canvas metrics are close enough for the live editor, but rich-run
  // save draws with pdf-lib's Standard-14 metrics. Give styled runs a modest
  // buffer so a line that barely fits on screen does not wrap after save.
  const richMetricSlack = richMetrics ? Math.max(fontSize * 0.75, widestHardLine * 0.08) : 0
  const maxPageWidth = Math.max(base.width, pageLimit(pageSize, 'width') - base.x)
  const grownWidth = Math.max(
    base.width,
    widestWord + padding * 2 + richMetricSlack,
    widestHardLine + padding * 2 + richMetricSlack,
    MIN_TEXT_BOX_WIDTH,
  )
  const width = Math.min(maxPageWidth, grownWidth)
  const wrapWidth = Math.max(1, width - padding * 2)
  const lineCount = wrappedLineCount(text, wrapWidth, measure)
  const neededHeight = lineCount * fontSize * lineHeight + padding * 2
  const maxPageHeight = Math.max(base.height, pageLimit(pageSize, 'height') - base.y)
  const height = Math.min(maxPageHeight, Math.max(base.height, neededHeight))

  if (Math.abs(width - base.width) < 0.01 && Math.abs(height - base.height) < 0.01) {
    return base
  }
  return { ...base, width, height }
}
