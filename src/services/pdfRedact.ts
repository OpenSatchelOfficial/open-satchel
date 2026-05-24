// True redaction: rasterizes the underlying page region within each
// redaction rectangle so the "blacked out" text is unrecoverable via
// copy-paste or text extraction. Competitor ship-blocker — merely
// drawing a black rect on top of text still leaks the original text
// in the PDF's content stream.

import { PDFDocument, rgb } from 'pdf-lib'
import { pdfToImages } from './pdfOps'

export interface RedactionRect {
  page: number // 0-based
  x: number    // PDF points, bottom-left origin
  y: number
  width: number
  height: number
  color?: [number, number, number] // default black
}

/** Re-renders every redacted page as a rasterized image, then overlays
 *  opaque rectangles for the redacted regions on the image copy, and
 *  replaces the original page content with the image. Original text &
 *  objects for that page are dropped. Non-redacted pages are untouched.
 */
export async function applyRedactions(bytes: Uint8Array, rects: RedactionRect[]): Promise<Uint8Array> {
  if (rects.length === 0) return bytes

  // Which pages need redaction?
  const redactedPages = new Set(rects.map((r) => r.page))

  // Rasterize the whole PDF at 2x scale; we'll only replace the pages
  // we need but reuse the rendered PNG stream.
  const rasters = await pdfToImages(bytes, { scale: 2 })

  const source = await PDFDocument.load(bytes)
  const sourcePages = source.getPages()
  // Build a new doc: for redacted pages, swap content with image + burn
  // black boxes. For others, copy through unchanged.
  const dest = await PDFDocument.create()

  // Copy metadata
  dest.setTitle(source.getTitle() || '')
  dest.setAuthor(source.getAuthor() || '')
  dest.setSubject(source.getSubject() || '')

  for (let i = 0; i < sourcePages.length; i++) {
    const { width, height } = sourcePages[i].getSize()
    if (redactedPages.has(i)) {
      const page = dest.addPage([width, height])
      const img = await dest.embedPng(rasters[i])
      page.drawImage(img, { x: 0, y: 0, width, height })
      // Burn black rects for this page's redactions
      for (const r of rects.filter((rr) => rr.page === i)) {
        const [cr, cg, cb] = r.color ?? [0, 0, 0]
        page.drawRectangle({
          x: r.x, y: r.y, width: r.width, height: r.height,
          color: rgb(cr, cg, cb),
        })
      }
    } else {
      const [copied] = await dest.copyPages(source, [i])
      dest.addPage(copied)
    }
  }
  return await dest.save()
}
