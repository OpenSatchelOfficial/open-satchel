// Flatten Transparency — composite transparent objects onto opaque background.
// For print workflows that require all-opaque pages.
//
// Approach: render each page via pdfjs at high DPI → embed as a single
// page-size JPEG → replace the content stream. This is the "nuclear" option
// but guarantees correct output.

import { PDFDocument } from 'pdf-lib'
import { pdfToImages } from './pdfOps'

export interface FlattenOptions {
  dpi?: number       // render resolution (default 300)
  quality?: number   // JPEG quality 0-1 (default 0.92)
  pages?: number[]   // 0-based page indices to flatten (default all)
}

/**
 * Flatten all transparency by rendering pages as images and re-embedding.
 * Pages become non-editable image-only after this operation.
 */
export async function flattenTransparency(
  bytes: Uint8Array,
  opts?: FlattenOptions
): Promise<Uint8Array> {
  const dpi = opts?.dpi ?? 300
  const quality = opts?.quality ?? 0.92
  const scale = dpi / 72

  // Render all pages to PNG
  const pageImages = await pdfToImages(bytes, { scale })

  // Load the original PDF to get page dimensions
  const srcDoc = await PDFDocument.load(bytes)
  const pageCount = srcDoc.getPageCount()
  const targetPages = opts?.pages ?? Array.from({ length: pageCount }, (_, i) => i)

  // Create a new PDF with flattened pages
  const outDoc = await PDFDocument.create()

  for (let i = 0; i < pageCount; i++) {
    const srcPage = srcDoc.getPage(i)
    const { width, height } = srcPage.getSize()

    if (targetPages.includes(i) && i < pageImages.length) {
      // Flatten this page: convert PNG to JPEG, embed as full-page image
      const pngBlob = new Blob([pageImages[i]], { type: 'image/png' })
      const bitmap = await createImageBitmap(pngBlob)
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
      const ctx = canvas.getContext('2d')!

      // Draw white background (flattens transparency)
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(bitmap, 0, 0)
      bitmap.close()

      const jpegBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality })
      const jpegBytes = new Uint8Array(await jpegBlob.arrayBuffer())

      const img = await outDoc.embedJpg(jpegBytes)
      const page = outDoc.addPage([width, height])
      page.drawImage(img, { x: 0, y: 0, width, height })
    } else {
      // Copy page as-is (not flattened)
      const [copied] = await outDoc.copyPages(srcDoc, [i])
      outDoc.addPage(copied)
    }
  }

  return await outDoc.save()
}
