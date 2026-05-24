// PDF → Word (.docx) export. Uses pdfjs-dist to extract positioned text
// runs per page, then rebuilds a .docx with paragraphs + page breaks
// preserved. Fonts/formatting are best-effort: the goal is "something
// editable in Word" not "pixel-perfect reconstruction". Competitors
// (including Acrobat) also approximate on this.

import { Document, Packer, Paragraph, TextRun, PageBreak } from 'docx'
import { extractText } from './pdfOps'

export interface PdfToWordOpts {
  lineGapThreshold?: number // pt; items further apart than this start a new paragraph (default 4)
}

/** Group positioned text runs into readable paragraphs by clustering on y. */
function groupIntoLines(items: { str: string; x: number; y: number; fontName?: string }[], gap: number): string[] {
  if (items.length === 0) return []
  // Sort top→bottom, left→right
  const sorted = [...items].sort((a, b) => (a.y - b.y) || (a.x - b.x))
  const lines: string[] = []
  let currentY = sorted[0].y
  let currentLine = ''
  for (const it of sorted) {
    if (Math.abs(it.y - currentY) > gap) {
      if (currentLine.trim()) lines.push(currentLine.trimEnd())
      currentLine = ''
      currentY = it.y
    }
    // Separate runs with a space if the previous run didn't end in one
    if (currentLine && !currentLine.endsWith(' ') && !it.str.startsWith(' ')) currentLine += ' '
    currentLine += it.str
  }
  if (currentLine.trim()) lines.push(currentLine.trimEnd())
  return lines
}

export async function pdfToWord(bytes: Uint8Array, opts: PdfToWordOpts = {}): Promise<Uint8Array> {
  const gap = opts.lineGapThreshold ?? 4
  const pages = await extractText(bytes)

  const children: Paragraph[] = []
  pages.forEach((page, pageIdx) => {
    const lines = groupIntoLines(page.items, gap)
    if (lines.length === 0) {
      children.push(new Paragraph({ children: [new TextRun({ text: '' })] }))
    } else {
      for (const line of lines) {
        children.push(new Paragraph({ children: [new TextRun({ text: line })] }))
      }
    }
    if (pageIdx < pages.length - 1) {
      children.push(new Paragraph({ children: [new PageBreak()] }))
    }
  })

  const doc = new Document({
    creator: 'Open Satchel',
    title: 'Converted from PDF',
    sections: [{ children }],
  })
  // docx Packer.toBuffer is Node-only; use toBlob in the browser.
  const blob = await Packer.toBlob(doc)
  return new Uint8Array(await blob.arrayBuffer())
}
