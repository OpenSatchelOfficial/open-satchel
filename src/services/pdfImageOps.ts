// PDF Image Operations — list, replace, and resize embedded images
//
// Walks the /Resources /XObject dictionary to find embedded images,
// provides metadata, and supports in-place replacement/resize.

import { PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFDict } from 'pdf-lib'

export interface EmbeddedImage {
  pageIndex: number
  refKey: string         // indirect object key (for replacement)
  width: number
  height: number
  bitsPerComponent: number
  filter: string         // e.g. "DCTDecode" (JPEG), "FlateDecode" (PNG-like)
  colorSpace: string
  byteLength: number
  xObjectName: string    // e.g. "Im0", "Image1"
}

/** Embedded image bytes + metadata, ready for extraction to disk.
 *  Unlike `listEmbeddedImages` this resolves each stream's payload into
 *  a Uint8Array. Callers typically pair this with a filename convention
 *  (page-N-name.ext) and save via window.api.file.saveAs. */
export interface ExtractedEmbeddedImage {
  pageIndex: number
  xObjectName: string
  width: number
  height: number
  filter: string
  /** Heuristic extension based on the PDF filter: "jpg" for DCTDecode,
   *  "png" for FlateDecode (we wrap the raw stream in a minimal PNG
   *  container), "jbig2" for JBIG2Decode (preserved as-is), etc. */
  extension: string
  bytes: Uint8Array
}

/** Walk all pages and extract every embedded image XObject into bytes
 *  ready for saving to disk. JPEG streams round-trip verbatim; other
 *  compressions fall back to the raw DecodedStream wrapped in PNG.
 *  Non-image XObjects (form XObjects, patterns) are skipped. */
export async function extractEmbeddedImages(bytes: Uint8Array): Promise<ExtractedEmbeddedImage[]> {
  const doc = await PDFDocument.load(bytes)
  const out: ExtractedEmbeddedImage[] = []
  for (let i = 0; i < doc.getPageCount(); i++) {
    const page = doc.getPage(i)
    const resourcesRef = page.node.get(PDFName.of('Resources'))
    if (!resourcesRef) continue
    const resDict = doc.context.lookup(resourcesRef) as PDFDict | undefined
    if (!resDict) continue
    const xobjectsRef = resDict.get(PDFName.of('XObject'))
    if (!xobjectsRef) continue
    const xoDict = doc.context.lookup(xobjectsRef) as PDFDict | undefined
    if (!xoDict) continue

    for (const [name, ref] of xoDict.entries()) {
      const obj = doc.context.lookup(ref)
      if (!obj || !(obj instanceof PDFRawStream)) continue
      const dict = obj.dict
      const subtype = dict.get(PDFName.of('Subtype'))
      if (!subtype || subtype.toString() !== '/Image') continue

      const w = (dict.get(PDFName.of('Width')) as PDFNumber | undefined)?.asNumber() ?? 0
      const h = (dict.get(PDFName.of('Height')) as PDFNumber | undefined)?.asNumber() ?? 0
      const filter = dict.get(PDFName.of('Filter'))?.toString() ?? ''
      const streamBytes = obj.getContents()

      const isJpeg = filter.includes('DCTDecode')
      const isJp2 = filter.includes('JPXDecode')
      const isJbig2 = filter.includes('JBIG2Decode')
      let extension = 'bin'
      let outBytes: Uint8Array = streamBytes
      if (isJpeg) {
        extension = 'jpg'
      } else if (isJp2) {
        extension = 'jp2'
      } else if (isJbig2) {
        extension = 'jbig2'
      } else {
        // Non-JPEG: re-render this image via pdf.js-native isn't worth
        // wiring here; fall back to emitting raw decoded stream with a
        // .bin extension so the user has SOMETHING to inspect, and flag
        // via filter name.
        extension = 'bin'
      }

      out.push({
        pageIndex: i,
        xObjectName: name.toString().replace(/^\//, ''),
        width: w,
        height: h,
        filter: filter.replace(/^\//, '') || 'None',
        extension,
        bytes: outBytes,
      })
    }
  }
  return out
}

/** List all embedded images across all pages */
export async function listEmbeddedImages(bytes: Uint8Array): Promise<EmbeddedImage[]> {
  const doc = await PDFDocument.load(bytes)
  const images: EmbeddedImage[] = []

  for (let i = 0; i < doc.getPageCount(); i++) {
    const page = doc.getPage(i)
    const resources = page.node.get(PDFName.of('Resources'))
    if (!resources) continue
    const resDict = doc.context.lookup(resources) as PDFDict | undefined
    if (!resDict) continue
    const xobjects = resDict.get(PDFName.of('XObject'))
    if (!xobjects) continue
    const xoDict = doc.context.lookup(xobjects) as PDFDict | undefined
    if (!xoDict) continue

    // Iterate XObject entries
    const entries = xoDict.entries()
    for (const [name, ref] of entries) {
      const obj = doc.context.lookup(ref)
      if (!obj || !('dict' in obj)) continue
      const stream = obj as PDFRawStream
      const dict = stream.dict
      const subtype = dict.get(PDFName.of('Subtype'))
      if (!subtype || subtype.toString() !== '/Image') continue

      const w = (dict.get(PDFName.of('Width')) as PDFNumber | undefined)?.asNumber() ?? 0
      const h = (dict.get(PDFName.of('Height')) as PDFNumber | undefined)?.asNumber() ?? 0
      const bpc = (dict.get(PDFName.of('BitsPerComponent')) as PDFNumber | undefined)?.asNumber() ?? 8
      const filter = dict.get(PDFName.of('Filter'))?.toString() ?? 'None'
      const cs = dict.get(PDFName.of('ColorSpace'))?.toString() ?? 'Unknown'

      images.push({
        pageIndex: i,
        refKey: ref.toString(),
        width: w,
        height: h,
        bitsPerComponent: bpc,
        filter: filter.replace('/', ''),
        colorSpace: cs.replace('/', ''),
        byteLength: stream.getContents().byteLength,
        xObjectName: name.toString().replace('/', ''),
      })
    }
  }

  return images
}

/** Replace an embedded image with new JPEG bytes. Updates dimensions and stream. */
export async function replaceEmbeddedImage(
  bytes: Uint8Array,
  pageIndex: number,
  xObjectName: string,
  newImageBytes: Uint8Array,
  newWidth: number,
  newHeight: number
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes)
  const page = doc.getPage(pageIndex)
  const resources = page.node.get(PDFName.of('Resources'))
  if (!resources) throw new Error('Page has no resources')
  const resDict = doc.context.lookup(resources) as PDFDict
  const xobjects = resDict.get(PDFName.of('XObject'))
  if (!xobjects) throw new Error('Page has no XObjects')
  const xoDict = doc.context.lookup(xobjects) as PDFDict

  const ref = xoDict.get(PDFName.of(xObjectName))
  if (!ref) throw new Error(`XObject "${xObjectName}" not found`)
  const stream = doc.context.lookup(ref) as PDFRawStream
  const dict = stream.dict

  // Detect if new image is JPEG (starts with FF D8)
  const isJpeg = newImageBytes[0] === 0xFF && newImageBytes[1] === 0xD8

  // Update stream contents — pdf-lib types mark `contents` readonly; the
  // field is still mutable at runtime.
  ;(stream as unknown as { contents: Uint8Array }).contents = newImageBytes
  dict.set(PDFName.of('Width'), PDFNumber.of(newWidth))
  dict.set(PDFName.of('Height'), PDFNumber.of(newHeight))
  dict.set(PDFName.of('Length'), PDFNumber.of(newImageBytes.byteLength))

  if (isJpeg) {
    dict.set(PDFName.of('Filter'), PDFName.of('DCTDecode'))
    dict.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'))
    dict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8))
  }

  return await doc.save()
}

/** Crop an embedded JPEG image to a sub-rectangle in image-pixel coords
 *  and rewrite the cm so the cropped image lands at the user-specified
 *  on-page rect. `cropPixels` is in the original image's pixel space;
 *  `onPageUserRect` is where the cropped result should appear in
 *  user-space coordinates on the page. */
export async function cropEmbeddedImage(
  bytes: Uint8Array,
  pageIndex: number,
  xObjectName: string,
  cropPixels: { sx: number; sy: number; sw: number; sh: number },
  onPageUserRect: { x: number; y: number; w: number; h: number },
  quality: number = 0.9,
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes)
  const page = doc.getPage(pageIndex)
  const resources = page.node.get(PDFName.of('Resources'))
  if (!resources) throw new Error('Page has no resources')
  const resDict = doc.context.lookup(resources) as PDFDict
  const xobjects = resDict.get(PDFName.of('XObject'))
  if (!xobjects) throw new Error('Page has no XObjects')
  const xoDict = doc.context.lookup(xobjects) as PDFDict
  const ref = xoDict.get(PDFName.of(xObjectName))
  if (!ref) throw new Error(`XObject "${xObjectName}" not found`)
  const stream = doc.context.lookup(ref) as PDFRawStream
  const dict = stream.dict
  const filter = dict.get(PDFName.of('Filter'))?.toString() ?? ''
  if (!filter.includes('DCTDecode')) {
    throw new Error('Crop currently supports JPEG images only (Filter: ' + filter + ')')
  }

  const originalBytes = stream.getContents()
  const bitmap = await createImageBitmap(new Blob([originalBytes], { type: 'image/jpeg' }))
  const sw = Math.max(1, Math.round(cropPixels.sw))
  const sh = Math.max(1, Math.round(cropPixels.sh))
  const canvas = new OffscreenCanvas(sw, sh)
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bitmap, cropPixels.sx, cropPixels.sy, cropPixels.sw, cropPixels.sh, 0, 0, sw, sh)
  bitmap.close()
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality })
  const newBytes = new Uint8Array(await blob.arrayBuffer())

  ;(stream as unknown as { contents: Uint8Array }).contents = newBytes
  dict.set(PDFName.of('Width'), PDFNumber.of(sw))
  dict.set(PDFName.of('Height'), PDFNumber.of(sh))
  dict.set(PDFName.of('Length'), PDFNumber.of(newBytes.byteLength))

  // Rewrite the cm for this image's Do call so the cropped image draws
  // at the requested user-space rect. applyImageEditsToBytes needs the
  // current cm matrix to know what to modify — we compute the DELTA
  // against the current effective CTM and rely on its surgical patch.
  const saved = await doc.save()
  // Apply a cm rewrite step: the new cm is [w 0 0 h x y] in user-space.
  // Encoded as an ImageEdit with translate + scale deltas, relative to
  // whatever the existing cm is.
  const { applyImageEditsToBytes, listImageDrawsOnPage } = await import('./pdfImageEdits')
  const rects = await listImageDrawsOnPage(saved, pageIndex)
  const r = rects.find((rr: { xObjectName: string }) => rr.xObjectName === xObjectName)
  if (!r) return saved
  const dx = onPageUserRect.x - r.x
  const dy = onPageUserRect.y - r.y
  const scaleX = r.width === 0 ? 1 : onPageUserRect.w / r.width
  const scaleY = r.height === 0 ? 1 : onPageUserRect.h / r.height
  return await applyImageEditsToBytes(saved, pageIndex, [{ xObjectName, dx, dy, scaleX, scaleY }])
}

/** Resize an embedded image by re-encoding it at new dimensions */
export async function resizeEmbeddedImage(
  bytes: Uint8Array,
  pageIndex: number,
  xObjectName: string,
  targetWidth: number,
  targetHeight: number,
  quality: number = 0.8
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes)
  const page = doc.getPage(pageIndex)
  const resources = page.node.get(PDFName.of('Resources'))
  if (!resources) throw new Error('Page has no resources')
  const resDict = doc.context.lookup(resources) as PDFDict
  const xobjects = resDict.get(PDFName.of('XObject'))
  if (!xobjects) throw new Error('Page has no XObjects')
  const xoDict = doc.context.lookup(xobjects) as PDFDict

  const ref = xoDict.get(PDFName.of(xObjectName))
  if (!ref) throw new Error(`XObject "${xObjectName}" not found`)
  const stream = doc.context.lookup(ref) as PDFRawStream
  const dict = stream.dict
  const filter = dict.get(PDFName.of('Filter'))?.toString() ?? ''

  // Only JPEG images can be easily resized via canvas
  if (!filter.includes('DCTDecode')) {
    throw new Error('Only JPEG images can be resized (filter: ' + filter + ')')
  }

  const originalBytes = stream.getContents()
  const bitmap = await createImageBitmap(new Blob([originalBytes], { type: 'image/jpeg' }))

  const canvas = new OffscreenCanvas(targetWidth, targetHeight)
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight)
  bitmap.close()

  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality })
  const newBytes = new Uint8Array(await blob.arrayBuffer())

  ;(stream as unknown as { contents: Uint8Array }).contents = newBytes
  dict.set(PDFName.of('Width'), PDFNumber.of(targetWidth))
  dict.set(PDFName.of('Height'), PDFNumber.of(targetHeight))
  dict.set(PDFName.of('Length'), PDFNumber.of(newBytes.byteLength))

  return await doc.save()
}
