// Compare two PDFs: text-level diff (LCS) and pixel-level diff (canvas).

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { extractText, pdfToImages } from './pdfOps'

export type DiffOp = 'equal' | 'insert' | 'delete'

export interface DiffSegment {
  op: DiffOp
  text: string
}

export interface PageDiff {
  page: number
  left: string
  right: string
  segments: DiffSegment[]
  similarity: number // 0..1
}

/** Classic LCS-based line diff, good enough for page text comparison. */
function diffLines(a: string[], b: string[]): DiffSegment[] {
  const n = a.length, m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }
  const out: DiffSegment[] = []
  let i = n, j = m
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { out.unshift({ op: 'equal', text: a[i - 1] }); i--; j-- }
    else if (dp[i - 1][j] >= dp[i][j - 1]) { out.unshift({ op: 'delete', text: a[i - 1] }); i-- }
    else { out.unshift({ op: 'insert', text: b[j - 1] }); j-- }
  }
  while (i > 0) { out.unshift({ op: 'delete', text: a[--i] }) }
  while (j > 0) { out.unshift({ op: 'insert', text: b[--j] }) }
  return out
}

export interface ComparePdfsResult {
  pages: PageDiff[]
  summary: { totalLines: number; inserted: number; deleted: number; unchanged: number; similarity: number }
}

export async function comparePdfs(leftBytes: Uint8Array, rightBytes: Uint8Array): Promise<ComparePdfsResult> {
  const [left, right] = await Promise.all([extractText(leftBytes), extractText(rightBytes)])
  const maxPages = Math.max(left.length, right.length)
  const pages: PageDiff[] = []
  let ins = 0, del = 0, eq = 0
  for (let i = 0; i < maxPages; i++) {
    const leftLines = (left[i]?.items ?? []).map((it) => it.str).filter((s) => s.trim())
    const rightLines = (right[i]?.items ?? []).map((it) => it.str).filter((s) => s.trim())
    const segs = diffLines(leftLines, rightLines)
    let pageIns = 0, pageDel = 0, pageEq = 0
    for (const s of segs) {
      if (s.op === 'insert') pageIns++
      else if (s.op === 'delete') pageDel++
      else pageEq++
    }
    ins += pageIns; del += pageDel; eq += pageEq
    const totalOnPage = pageIns + pageDel + pageEq
    pages.push({
      page: i,
      left: leftLines.join('\n'),
      right: rightLines.join('\n'),
      segments: segs,
      similarity: totalOnPage === 0 ? 1 : pageEq / totalOnPage,
    })
  }
  const total = ins + del + eq
  return {
    pages,
    summary: { totalLines: total, inserted: ins, deleted: del, unchanged: eq, similarity: total === 0 ? 1 : eq / total },
  }
}

// ── Word-level diff ────────────────────────────────────────────────

/** Character-granular diff within changed lines. Takes two strings and
 *  emits segments with word boundaries preserved. Useful for the
 *  compare report so users see "Q4 → Q1" instead of "whole line
 *  rewritten". */
export function diffWords(a: string, b: string): DiffSegment[] {
  const aw = a.split(/(\s+)/)
  const bw = b.split(/(\s+)/)
  const n = aw.length, m = bw.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = aw[i - 1] === bw[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }
  const out: DiffSegment[] = []
  let i = n, j = m
  while (i > 0 && j > 0) {
    if (aw[i - 1] === bw[j - 1]) { out.unshift({ op: 'equal', text: aw[i - 1] }); i--; j-- }
    else if (dp[i - 1][j] >= dp[i][j - 1]) { out.unshift({ op: 'delete', text: aw[i - 1] }); i-- }
    else { out.unshift({ op: 'insert', text: bw[j - 1] }); j-- }
  }
  while (i > 0) { out.unshift({ op: 'delete', text: aw[--i] }) }
  while (j > 0) { out.unshift({ op: 'insert', text: bw[--j] }) }
  return out
}

// ── Compare report PDF ─────────────────────────────────────────────

/** Generate a single-PDF compare report with summary + per-page diff.
 *  Page 1: totals + similarity % + per-page bar chart. Remaining pages:
 *  one per content page with inserted/deleted lines colored red/green.
 *  Users get a shareable artifact they can save anywhere without loading
 *  the viewer. */
export async function generateCompareReport(
  leftBytes: Uint8Array,
  rightBytes: Uint8Array,
  leftName = 'Original',
  rightName = 'Revised',
): Promise<Uint8Array> {
  const result = await comparePdfs(leftBytes, rightBytes)
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold)
  const fontMono = await doc.embedFont(StandardFonts.Courier)

  const margin = 40
  const pageW = 612, pageH = 792

  // ---- Summary page ----
  const summary = doc.addPage([pageW, pageH])
  summary.drawText('Compare Report', { x: margin, y: pageH - margin - 14, size: 20, font: fontBold, color: rgb(0.1, 0.1, 0.1) })
  summary.drawText(`${leftName} vs ${rightName}`, { x: margin, y: pageH - margin - 36, size: 11, font, color: rgb(0.35, 0.35, 0.35) })
  summary.drawText(`Generated ${new Date().toLocaleString()}`, { x: margin, y: pageH - margin - 54, size: 9, font, color: rgb(0.5, 0.5, 0.5) })

  const s = result.summary
  const similarity = Math.round(s.similarity * 100)
  const rows = [
    [`Pages compared`, String(result.pages.length)],
    [`Lines inserted`, `+${s.inserted}`],
    [`Lines deleted`, `-${s.deleted}`],
    [`Lines unchanged`, String(s.unchanged)],
    [`Overall similarity`, `${similarity}%`],
  ]
  let y = pageH - margin - 100
  for (const [k, v] of rows) {
    summary.drawText(k, { x: margin, y, size: 11, font })
    summary.drawText(v, { x: margin + 200, y, size: 11, font: fontBold })
    y -= 18
  }

  // Mini per-page bar chart
  const chartTop = y - 30
  summary.drawText('Per-page similarity', { x: margin, y: chartTop, size: 11, font: fontBold })
  const barsAreaY = chartTop - 130
  const barsH = 110
  const barsW = pageW - margin * 2
  const barW = Math.min(20, barsW / Math.max(1, result.pages.length))
  summary.drawRectangle({ x: margin, y: barsAreaY, width: barsW, height: barsH, borderColor: rgb(0.85, 0.85, 0.85), borderWidth: 0.5, color: rgb(0.98, 0.98, 0.98) })
  result.pages.forEach((pg, i) => {
    const h = pg.similarity * barsH
    const color = pg.similarity > 0.9 ? rgb(0.3, 0.75, 0.5)
      : pg.similarity > 0.5 ? rgb(0.95, 0.75, 0.2)
      : rgb(0.9, 0.35, 0.35)
    summary.drawRectangle({ x: margin + i * barW + 2, y: barsAreaY, width: barW - 4, height: h, color })
    if (result.pages.length < 30) {
      summary.drawText(String(i + 1), { x: margin + i * barW + 4, y: barsAreaY - 10, size: 6, font, color: rgb(0.4, 0.4, 0.4) })
    }
  })

  // ---- Per-page detail pages ----
  for (const pg of result.pages) {
    const page = doc.addPage([pageW, pageH])
    page.drawText(`Page ${pg.page + 1}`, { x: margin, y: pageH - margin - 14, size: 16, font: fontBold })
    page.drawText(`Similarity: ${Math.round(pg.similarity * 100)}%`, { x: pageW - margin - 120, y: pageH - margin - 14, size: 11, font, color: rgb(0.4, 0.4, 0.4) })

    let cy = pageH - margin - 40
    for (const seg of pg.segments) {
      if (cy < margin + 16) {
        // New detail page when we run out of room
        const cont = doc.addPage([pageW, pageH])
        cy = pageH - margin - 16
        cont.drawText(`Page ${pg.page + 1} (continued)`, { x: margin, y: pageH - margin - 14, size: 12, font: fontBold, color: rgb(0.35, 0.35, 0.35) })
        cy = pageH - margin - 40
        // Rebind drawing target: switch the "page" reference locally
        drawLine(cont, seg, margin, cy, fontMono, pageW)
        cy -= 14
        continue
      }
      drawLine(page, seg, margin, cy, fontMono, pageW)
      cy -= 14
    }
  }

  return await doc.save()
}

type PdfPage = ReturnType<PDFDocument['addPage']>
type PdfFont = import('pdf-lib').PDFFont

function drawLine(page: PdfPage, seg: DiffSegment, margin: number, y: number, font: PdfFont, pageW: number) {
  const maxWidth = pageW - margin * 2
  const prefix = seg.op === 'insert' ? '+ ' : seg.op === 'delete' ? '- ' : '  '
  const color = seg.op === 'insert' ? rgb(0.15, 0.55, 0.3)
    : seg.op === 'delete' ? rgb(0.75, 0.25, 0.25)
    : rgb(0.3, 0.3, 0.3)
  // Background tint on changed lines
  if (seg.op !== 'equal') {
    page.drawRectangle({
      x: margin - 2, y: y - 2, width: maxWidth + 4, height: 12,
      color: seg.op === 'insert' ? rgb(0.9, 0.97, 0.92) : rgb(0.98, 0.9, 0.9),
    })
  }
  const truncated = (prefix + seg.text).slice(0, 105)
  page.drawText(truncated, { x: margin, y, size: 9, font, color })
}

// ── Pixel-level diff ───────────────────────────────────────────────

export interface PixelDiffResult {
  diffImage: Uint8Array
  changedPixels: number
  changePercent: number
  width: number
  height: number
}

/** Pixel-diff two PDF pages. Renders both, compares, produces red overlay of changes. */
export async function pixelDiffPages(
  leftBytes: Uint8Array,
  rightBytes: Uint8Array,
  pageIndex: number,
  opts?: { scale?: number; threshold?: number }
): Promise<PixelDiffResult | null> {
  const scale = opts?.scale ?? 1.5
  const threshold = opts?.threshold ?? 30

  const [leftImgs, rightImgs] = await Promise.all([
    pdfToImages(leftBytes, { scale }),
    pdfToImages(rightBytes, { scale }),
  ])
  if (pageIndex >= leftImgs.length || pageIndex >= rightImgs.length) return null

  const [leftBm, rightBm] = await Promise.all([
    createImageBitmap(new Blob([leftImgs[pageIndex]], { type: 'image/png' })),
    createImageBitmap(new Blob([rightImgs[pageIndex]], { type: 'image/png' })),
  ])

  const w = Math.max(leftBm.width, rightBm.width)
  const h = Math.max(leftBm.height, rightBm.height)

  const lc = new OffscreenCanvas(w, h), lx = lc.getContext('2d')!
  lx.drawImage(leftBm, 0, 0)
  const ld = lx.getImageData(0, 0, w, h)

  const rc = new OffscreenCanvas(w, h), rx = rc.getContext('2d')!
  rx.drawImage(rightBm, 0, 0)
  const rd = rx.getImageData(0, 0, w, h)
  leftBm.close(); rightBm.close()

  const dc = new OffscreenCanvas(w, h), dx = dc.getContext('2d')!
  const dd = dx.createImageData(w, h)
  const d = dd.data, lp = ld.data, rp = rd.data
  let changed = 0

  for (let i = 0; i < lp.length; i += 4) {
    const dist = Math.abs(lp[i] - rp[i]) + Math.abs(lp[i+1] - rp[i+1]) + Math.abs(lp[i+2] - rp[i+2])
    if (dist > threshold) {
      d[i] = 255; d[i+1] = 60; d[i+2] = 60; d[i+3] = 180
      changed++
    }
  }

  dx.putImageData(dd, 0, 0)
  const blob = await dc.convertToBlob({ type: 'image/png' })
  return {
    diffImage: new Uint8Array(await blob.arrayBuffer()),
    changedPixels: changed,
    changePercent: Math.round((changed / (w * h)) * 10000) / 100,
    width: w, height: h,
  }
}
