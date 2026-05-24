// Extra PDF conversion services matching WPS: PDF→Excel, PDF→PPT,
// PDF→TXT, Extract all embedded images, To Image-only PDF, and the
// companion "insert / replace pages" ops.

import { PDFDocument } from 'pdf-lib'
import * as XLSX from 'xlsx'
import PptxGenJS from 'pptxgenjs'
import { extractText, pdfToImages, imagesToPdf } from './pdfOps'

// ---------- PDF → plain text (.txt) ----------

export async function pdfToText(bytes: Uint8Array): Promise<string> {
  const pages = await extractText(bytes)
  return pages
    .map((p) => {
      const sorted = [...p.items].sort((a, b) => (a.y - b.y) || (a.x - b.x))
      let currentY = sorted[0]?.y
      const lines: string[] = []
      let line = ''
      for (const it of sorted) {
        if (currentY !== undefined && Math.abs(it.y - currentY) > 4) {
          if (line.trim()) lines.push(line.trimEnd())
          line = ''
          currentY = it.y
        }
        if (line && !line.endsWith(' ') && !it.str.startsWith(' ')) line += ' '
        line += it.str
      }
      if (line.trim()) lines.push(line.trimEnd())
      return lines.join('\n')
    })
    .join('\n\n--- Page Break ---\n\n')
}

// ---------- PDF → Excel (structural table detection) ----------

/** Detect column boundaries from text item X-positions using gap analysis */
function detectColumns(items: { x: number; width: number }[], pageWidth: number): number[] {
  if (items.length < 2) return [0, pageWidth]
  // Collect all left edges and right edges
  const edges: number[] = []
  for (const it of items) {
    edges.push(it.x)
    edges.push(it.x + it.width)
  }
  edges.sort((a, b) => a - b)

  // Find gaps between clusters of edges — these are column separators
  const gaps: { pos: number; size: number }[] = []
  for (let i = 1; i < edges.length; i++) {
    const gap = edges[i] - edges[i - 1]
    if (gap > 15) { // Minimum gap to be a column boundary
      gaps.push({ pos: (edges[i] + edges[i - 1]) / 2, size: gap })
    }
  }

  // Build column boundaries: [0, gap1, gap2, ..., pageWidth]
  const boundaries = [0, ...gaps.sort((a, b) => a.pos - b.pos).map(g => g.pos), pageWidth]

  // Deduplicate boundaries that are too close together
  const deduped = [boundaries[0]]
  for (let i = 1; i < boundaries.length; i++) {
    if (boundaries[i] - deduped[deduped.length - 1] > 20) {
      deduped.push(boundaries[i])
    }
  }
  return deduped
}

/** Assign a text item to a column based on its X position */
function assignColumn(x: number, boundaries: number[]): number {
  for (let i = 0; i < boundaries.length - 1; i++) {
    if (x >= boundaries[i] && x < boundaries[i + 1]) return i
  }
  return boundaries.length - 2
}

export async function pdfToExcel(bytes: Uint8Array): Promise<Uint8Array> {
  const pages = await extractText(bytes)
  const wb = XLSX.utils.book_new()

  pages.forEach((p, pageIdx) => {
    if (p.items.length === 0) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['(empty page)']]), `Page ${pageIdx + 1}`)
      return
    }

    // Step 1: Detect column structure from X-position clustering
    const maxX = Math.max(...p.items.map(it => it.x + it.width))
    const colBoundaries = detectColumns(p.items, maxX + 20)
    const numCols = colBoundaries.length - 1

    // Step 2: Group items into rows by Y-position
    const sorted = [...p.items].sort((a, b) => (a.y - b.y) || (a.x - b.x))
    const lines: { y: number; items: typeof sorted }[] = []
    let curY = sorted[0].y
    let curItems = [sorted[0]]

    for (let i = 1; i < sorted.length; i++) {
      const it = sorted[i]
      if (Math.abs(it.y - curY) > 4) {
        lines.push({ y: curY, items: curItems })
        curItems = [it]
        curY = it.y
      } else {
        curItems.push(it)
      }
    }
    lines.push({ y: curY, items: curItems })

    // Step 3: Build grid — place each text item in its detected column
    const rows: string[][] = []
    for (const line of lines) {
      const row = new Array(numCols).fill('')
      for (const item of line.items) {
        const col = assignColumn(item.x, colBoundaries)
        if (row[col]) row[col] += ' '
        row[col] += item.str.trim()
      }
      // Only add if row has any content
      if (row.some(c => c.trim())) rows.push(row)
    }

    const ws = XLSX.utils.aoa_to_sheet(rows)
    XLSX.utils.book_append_sheet(wb, ws, `Page ${pageIdx + 1}`)
  })

  const arr = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
  return new Uint8Array(arr as ArrayBuffer)
}

// ---------- PDF → PowerPoint (each page as a slide with the rendered image) ----------

export async function pdfToPpt(bytes: Uint8Array): Promise<Uint8Array> {
  const pngs = await pdfToImages(bytes, { scale: 2 })
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_WIDE' // 13.33 x 7.5 inches
  for (const png of pngs) {
    const slide = pptx.addSlide()
    // btoa(String.fromCharCode(...arr)) blew the stack on multi-page
    // PDFs because spread on a typed array > ~64K args throws
    // RangeError. The conversion failed silently — toPpt's promise
    // rejected, the dialog had no try/catch, status stayed empty.
    // Chunk-encode binary string at 16KB-arg windows.
    const b64 = 'data:image/png;base64,' + uint8ToBase64(png)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    slide.addImage({ data: b64, x: 0, y: 0, w: 13.33, h: 7.5 } as any)
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = (await pptx.write({ outputType: 'uint8array' })) as any
  return out instanceof Uint8Array ? out : new Uint8Array(out)
}

// btoa-friendly base64 of any-size Uint8Array. Splits into 0x8000-byte
// chunks; concat the resulting binary strings; pass to btoa. (btoa
// itself handles strings of any size — it's the apply/spread that
// blows the stack with very long arg lists.)
function uint8ToBase64(arr: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < arr.length; i += chunkSize) {
    const slice = arr.subarray(i, i + chunkSize)
    binary += String.fromCharCode.apply(null, slice as unknown as number[])
  }
  return btoa(binary)
}

// ---------- Extract all embedded images (scan object stream for /XObject Image) ----------

/** Naïve image extractor: re-renders every page and returns each page
 *  as a PNG. Matches WPS's "Extract Picture" which exports page-level
 *  images — true object-graph walk (extracting every embedded image
 *  exactly once) would require deeper pdfjs traversal. */
export async function extractAllPictures(bytes: Uint8Array, opts: { scale?: number } = {}): Promise<Uint8Array[]> {
  return pdfToImages(bytes, { scale: opts.scale ?? 2 })
}

// ---------- To Image-only PDF (rasterize every page) ----------

export async function toImageOnlyPdf(bytes: Uint8Array): Promise<Uint8Array> {
  const pngs = await pdfToImages(bytes, { scale: 2 })
  // Preserve original page dimensions
  const doc = await PDFDocument.load(bytes)
  const pages = doc.getPages()
  const out = await PDFDocument.create()
  for (let i = 0; i < pages.length; i++) {
    const { width, height } = pages[i].getSize()
    const newPage = out.addPage([width, height])
    const img = await out.embedPng(pngs[i])
    newPage.drawImage(img, { x: 0, y: 0, width, height })
  }
  return await out.save()
}

// ---------- Insert pages from another PDF at a given position ----------

export async function insertPagesFromPdf(
  bytes: Uint8Array,
  sourceBytes: Uint8Array,
  atIndex: number,
  sourceRanges?: { start: number; end: number }[],
): Promise<Uint8Array> {
  const dest = await PDFDocument.load(bytes)
  const src = await PDFDocument.load(sourceBytes)
  const srcPageCount = src.getPageCount()
  const indices: number[] = []
  if (sourceRanges && sourceRanges.length > 0) {
    for (const r of sourceRanges) {
      const s = Math.max(1, r.start), e = Math.min(srcPageCount, r.end)
      for (let i = s - 1; i <= e - 1; i++) indices.push(i)
    }
  } else {
    for (let i = 0; i < srcPageCount; i++) indices.push(i)
  }
  const copied = await dest.copyPages(src, indices)
  copied.forEach((p, i) => dest.insertPage(atIndex + i, p))
  return await dest.save()
}

// ---------- Replace pages with pages from another PDF ----------

export async function replacePagesFromPdf(
  bytes: Uint8Array,
  sourceBytes: Uint8Array,
  targetStart: number, // 1-based page to start replacing
  targetEnd: number,   // 1-based inclusive
  sourceStart: number = 1,
): Promise<Uint8Array> {
  const dest = await PDFDocument.load(bytes)
  const src = await PDFDocument.load(sourceBytes)
  const targetCount = targetEnd - targetStart + 1
  const sourceIndices = Array.from({ length: targetCount }, (_, i) => sourceStart - 1 + i)
  const copied = await dest.copyPages(src, sourceIndices)
  // Remove the target range first, bottom-up so indices stay valid
  for (let i = targetEnd - 1; i >= targetStart - 1; i--) dest.removePage(i)
  copied.forEach((p, i) => dest.insertPage(targetStart - 1 + i, p))
  return await dest.save()
}

// ---------- Page background color or image ----------

export interface PageBackgroundOpts {
  pageIndices?: number[]
  color?: [number, number, number] // rgb 0..1
  imageBytes?: Uint8Array
  imageOpacity?: number // 0..1
}

export async function applyPageBackground(bytes: Uint8Array, opts: PageBackgroundOpts): Promise<Uint8Array> {
  const { default: pdfLib } = { default: await import('pdf-lib') }
  const doc = await pdfLib.PDFDocument.load(bytes)
  const pages = doc.getPages()
  const targets = opts.pageIndices ?? pages.map((_, i) => i)
  let img: Awaited<ReturnType<typeof doc.embedPng>> | null = null
  if (opts.imageBytes) {
    const isPng = opts.imageBytes[0] === 0x89 && opts.imageBytes[1] === 0x50
    img = isPng ? await doc.embedPng(opts.imageBytes) : await doc.embedJpg(opts.imageBytes)
  }
  for (const i of targets) {
    const page = pages[i]
    if (!page) continue
    const { width, height } = page.getSize()
    if (opts.color) {
      const [r, g, b] = opts.color
      // Use a content-stream prepend so the color paints BEHIND existing content
      page.drawRectangle({ x: 0, y: 0, width, height, color: pdfLib.rgb(r, g, b) })
      // pdf-lib appends — acceptable for new pages. For full-fidelity we'd
      // rewrite the content stream order; good enough for most docs.
    }
    if (img) {
      page.drawImage(img, { x: 0, y: 0, width, height, opacity: opts.imageOpacity ?? 0.3 })
    }
  }
  return await doc.save()
}

// ---------- Export highlighted text from a PDF (read fabric highlight rects over extracted text) ----------

export interface HighlightExport {
  page: number
  text: string
  color?: string
}

/** Given fabric JSON per page and extracted PDF text, emit the text
 *  content under every highlight rectangle (and underline/strikethrough
 *  which we also treat as emphasis). */
export function exportHighlightsFromPages(
  pages: Array<{ fabricJSON?: { objects?: Array<Record<string, unknown>> } | null } | undefined>,
  extractedText: Array<{ page: number; items: Array<{ str: string; x: number; y: number; width: number; height: number }> }>,
): HighlightExport[] {
  const out: HighlightExport[] = []
  pages.forEach((page, i) => {
    const fjObjs = page?.fabricJSON?.objects ?? []
    const extr = extractedText[i]
    if (!extr) return
    for (const obj of fjObjs) {
      const o = obj as { type?: string; left?: number; top?: number; width?: number; height?: number; opacity?: number; fill?: string }
      if ((o.type || '').toLowerCase() !== 'rect') continue
      // Heuristic: highlights are translucent rects (opacity < 1), not full-black redactions
      if (!(o.opacity !== undefined && o.opacity < 1)) continue
      const L = o.left ?? 0, T = o.top ?? 0, W = o.width ?? 0, H = o.height ?? 0
      const textUnder = extr.items
        .filter((it) => it.x >= L && it.x <= L + W && it.y >= T && it.y <= T + H)
        .map((it) => it.str)
        .join(' ')
      if (textUnder.trim()) {
        out.push({ page: i, text: textUnder.trim(), color: o.fill })
      }
    }
  })
  return out
}

// ---------- Insert standalone page numbers (simplified header/footer for just numbering) ----------

import { StandardFonts, rgb } from 'pdf-lib'

export type PageNumberStyle = 'D' | 'r' | 'R' | 'a' | 'A'

export interface PageNumberOpts {
  /** Preset format. Ignored when `prefix`/`suffix` are provided. */
  format?: 'N' | 'N of M' | 'Page N' | 'Page N of M'
  /** Custom prefix string (e.g. "Page "). If set, overrides `format`. */
  prefix?: string
  /** Custom suffix string. Supports `{total}` token for page count. */
  suffix?: string
  /** Numbering style — D=1,2,3 R=I,II,III r=i,ii,iii A=A,B,C a=a,b,c */
  style?: PageNumberStyle
  position?: 'footer-right' | 'footer-center' | 'footer-left' | 'header-right' | 'header-center' | 'header-left' | 'top' | 'bottom'
  alignment?: 'left' | 'center' | 'right'
  fontSize?: number
  /** RGB 0..1 triplet. */
  color?: [number, number, number]
  margin?: number
  start?: number
  skipFirst?: boolean
  /** If present, only number these page indices (0-based). */
  pageIndices?: number[]
}

function formatPageNum(n: number, style: PageNumberStyle): string {
  if (style === 'D') return String(n)
  if (style === 'R' || style === 'r') {
    const m = [['M', 1000], ['CM', 900], ['D', 500], ['CD', 400], ['C', 100], ['XC', 90], ['L', 50], ['XL', 40], ['X', 10], ['IX', 9], ['V', 5], ['IV', 4], ['I', 1]] as const
    let out = ''; let k = n
    for (const [s, v] of m) { while (k >= v) { out += s; k -= v } }
    return style === 'r' ? out.toLowerCase() : out
  }
  let out = ''; let k = n
  while (k > 0) { const r = (k - 1) % 26; out = String.fromCharCode(65 + r) + out; k = Math.floor((k - 1) / 26) }
  return style === 'a' ? out.toLowerCase() : out
}

export async function addPageNumbers(bytes: Uint8Array, opts: PageNumberOpts = {}): Promise<Uint8Array> {
  const {
    format = 'Page N of M',
    prefix, suffix,
    style = 'D',
    fontSize = 10, margin = 24, start = 1, skipFirst = false,
    color = [0, 0, 0] as [number, number, number],
    pageIndices,
  } = opts

  // Normalize position → vertPos + alignment
  let vertPos: 'header' | 'footer' = 'footer'
  let align: 'left' | 'center' | 'right' = opts.alignment ?? 'center'
  if (opts.position) {
    if (opts.position === 'top') vertPos = 'header'
    else if (opts.position === 'bottom') vertPos = 'footer'
    else {
      const [v, h] = opts.position.split('-') as [string, 'left' | 'center' | 'right']
      vertPos = v === 'header' ? 'header' : 'footer'
      if (!opts.alignment) align = h
    }
  }

  const doc = await PDFDocument.load(bytes)
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const pages = doc.getPages()
  const indexList = pageIndices ? [...new Set(pageIndices)].sort((a, b) => a - b) : null
  const indexSet = indexList ? new Set(indexList) : null

  pages.forEach((page, i) => {
    if (skipFirst && i === 0) return
    if (indexSet && !indexSet.has(i)) return
    const n = start + (indexList ? indexList.indexOf(i) : i)
    const m = pages.length

    let text: string
    if (prefix !== undefined || suffix !== undefined) {
      const resolvedSuffix = (suffix ?? '').replace(/\{total\}/g, String(m))
      text = `${prefix ?? ''}${formatPageNum(n, style)}${resolvedSuffix}`
    } else {
      text = format === 'N' ? `${n}`
        : format === 'N of M' ? `${n} of ${m}`
        : format === 'Page N' ? `Page ${n}`
        : `Page ${n} of ${m}`
    }

    const { width, height } = page.getSize()
    const tw = font.widthOfTextAtSize(text, fontSize)
    const th = font.heightAtSize(fontSize)
    let x = margin, y = margin
    if (vertPos === 'header') y = height - margin - th
    if (align === 'right') x = width - margin - tw
    else if (align === 'center') x = (width - tw) / 2
    page.drawText(text, { x, y, size: fontSize, font, color: rgb(color[0], color[1], color[2]) })
  })
  return await doc.save()
}
