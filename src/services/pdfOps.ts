// Unified pdf-lib / pdfjs-dist operations. Pure functions over bytes so
// they are trivially testable and reusable between dialogs, IPC handlers,
// and batch automation. Nothing in here touches the DOM or stores.

import { PDFDocument, PDFName, PDFDict, PDFArray, PDFString, PDFNumber, PDFRawStream, PDFRef, rgb, degrees, StandardFonts } from 'pdf-lib'

// ---------- Metadata ----------

export interface PdfMetadata {
  title?: string
  author?: string
  subject?: string
  keywords?: string[]
  producer?: string
  creator?: string
  creationDate?: Date
  modificationDate?: Date
}

export async function readMetadata(bytes: Uint8Array): Promise<PdfMetadata> {
  // Read-only path — share the parsed doc across the Advanced
  // Tools sections that all read metadata-adjacent info on mount.
  // PDFDocument.load on a 33 MB doc takes 1-3 s; without sharing,
  // each section click pays this cost again.
  const { getReadOnlyPdfLibDoc } = await import('./pdfLibDocCache')
  const doc = await getReadOnlyPdfLibDoc(bytes)
  const kwStr = doc.getKeywords()
  return {
    title: doc.getTitle() || undefined,
    author: doc.getAuthor() || undefined,
    subject: doc.getSubject() || undefined,
    // pdf-lib joins with space on write, so split on any comma/semicolon/
    // whitespace run; callers that want the raw string can use kwStr.
    keywords: kwStr ? kwStr.split(/[,;]+\s*|\s+/).filter(Boolean) : undefined,
    producer: doc.getProducer() || undefined,
    creator: doc.getCreator() || undefined,
    creationDate: doc.getCreationDate() || undefined,
    modificationDate: doc.getModificationDate() || undefined,
  }
}

export async function writeMetadata(bytes: Uint8Array, meta: PdfMetadata): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes)
  if (meta.title !== undefined) doc.setTitle(meta.title)
  if (meta.author !== undefined) doc.setAuthor(meta.author)
  if (meta.subject !== undefined) doc.setSubject(meta.subject)
  // Accept string[] from UI; join with ", " so readMetadata round-trips
  // cleanly back to the same array split on commas.
  const joinedKeywords =
    meta.keywords === undefined
      ? undefined
      : Array.isArray(meta.keywords) ? meta.keywords.join(', ') : meta.keywords
  if (joinedKeywords !== undefined) {
    doc.setKeywords([joinedKeywords as unknown as string])
  }
  if (meta.creator !== undefined) doc.setCreator(meta.creator)
  if (meta.producer !== undefined) doc.setProducer(meta.producer)
  if (meta.creationDate !== undefined) doc.setCreationDate(meta.creationDate)
  if (meta.modificationDate !== undefined) doc.setModificationDate(meta.modificationDate)
  let out = await doc.save()
  // G6: pd-lib's set*() only updates /Info — the catalog's /Metadata
  // XMP stream stays stale. Sync standard fields into XMP so gov /
  // hospital preflight tools (which read XMP, not /Info) see the new
  // values. The syncXmpFromInfo helper uses a regex-based field
  // replacer; an earlier DOMParser version hung on real-world XMP.
  // Wrap in try/catch so any future XMP edge case doesn't bubble up
  // — the /Info update has already succeeded.
  try {
    const { syncXmpFromInfo } = await import('./pdfMisc')
    out = await syncXmpFromInfo(out, {
      title: meta.title,
      author: meta.author,
      subject: meta.subject,
      keywords: joinedKeywords,
      creator: meta.creator,
      producer: meta.producer,
      creationDate: meta.creationDate,
      modificationDate: meta.modificationDate,
    })
  } catch (e) {
    console.warn('[writeMetadata] XMP sync failed, /Info still updated:', e)
  }
  return out
}

export async function stripMetadata(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes)
  doc.setTitle('')
  doc.setAuthor('')
  doc.setSubject('')
  doc.setKeywords([])
  doc.setCreator('')
  doc.setProducer('')
  return await doc.save()
}

export interface SanitizeOptions {
  stripMetadata?: boolean
  stripXmp?: boolean
  stripJavaScript?: boolean
  stripAttachments?: boolean
  stripHiddenLayers?: boolean
  stripAnnotations?: boolean
  stripForms?: boolean
  stripOutlines?: boolean
  stripNamedDestinations?: boolean
}

function pruneUnreachablePdfObjects(doc: PDFDocument): void {
  const ctx = doc.context as any
  const reachable = new Set<string>()

  const visit = (obj: unknown): void => {
    if (!obj) return
    if (obj instanceof PDFRef) {
      const key = obj.toString()
      if (reachable.has(key)) return
      reachable.add(key)
      try { visit(ctx.lookup(obj)) } catch { /* tolerate dangling refs */ }
      return
    }
    if (obj instanceof PDFDict) {
      for (const [, value] of obj.entries()) visit(value)
      return
    }
    if (obj instanceof PDFArray) {
      for (let i = 0; i < obj.size(); i++) visit(obj.get(i))
      return
    }
    const dict = (obj as { dict?: unknown }).dict
    if (dict instanceof PDFDict) visit(dict)
  }

  visit(ctx.trailerInfo.Root)
  visit(ctx.trailerInfo.Info)
  visit(ctx.trailerInfo.Encrypt)
  visit(ctx.trailerInfo.ID)

  for (const [ref] of ctx.enumerateIndirectObjects() as [PDFRef, unknown][]) {
    if (!reachable.has(ref.toString())) ctx.delete(ref)
  }
}

/** Deep sanitize — remove hidden info from PDF catalog for privacy/compliance */
export async function sanitizePdf(bytes: Uint8Array, opts: SanitizeOptions = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes)
  const catalog = doc.catalog

  // Strip basic metadata
  if (opts.stripMetadata !== false) {
    doc.setTitle(''); doc.setAuthor(''); doc.setSubject('')
    doc.setKeywords([]); doc.setCreator(''); doc.setProducer('')
  }

  // Strip XMP metadata stream
  if (opts.stripXmp !== false) {
    try { catalog.delete(PDFName.of('Metadata')) } catch { /* may not exist */ }
  }

  // Strip JavaScript and actions
  if (opts.stripJavaScript !== false) {
    try { catalog.delete(PDFName.of('OpenAction')) } catch {}
    try { catalog.delete(PDFName.of('AA')) } catch {}
    // Walk pages to remove per-page actions
    for (let i = 0; i < doc.getPageCount(); i++) {
      try { doc.getPage(i).node.delete(PDFName.of('AA')) } catch {}
    }
    // Remove /Names/JavaScript tree
    try {
      const names = catalog.lookup(PDFName.of('Names')) as PDFDict | undefined
      if (names) names.delete(PDFName.of('JavaScript'))
    } catch {}
  }

  // Strip embedded file attachments
  if (opts.stripAttachments !== false) {
    try {
      const names = catalog.lookup(PDFName.of('Names')) as PDFDict | undefined
      if (names) names.delete(PDFName.of('EmbeddedFiles'))
    } catch {}
  }

  // Strip optional content (hidden layers)
  if (opts.stripHiddenLayers !== false) {
    try { catalog.delete(PDFName.of('OCProperties')) } catch {}
  }

  // Strip bookmark/outlines and named destinations that can carry private labels
  // or stale links into removed content.
  if (opts.stripOutlines !== false) {
    try { catalog.delete(PDFName.of('Outlines')) } catch {}
  }
  if (opts.stripNamedDestinations !== false) {
    try { catalog.delete(PDFName.of('Dests')) } catch {}
    try {
      const names = catalog.lookup(PDFName.of('Names')) as PDFDict | undefined
      if (names) names.delete(PDFName.of('Dests'))
    } catch {}
  }

  // Strip annotations from all pages
  if (opts.stripAnnotations) {
    for (let i = 0; i < doc.getPageCount(); i++) {
      try { doc.getPage(i).node.delete(PDFName.of('Annots')) } catch {}
    }
  }

  // Strip interactive forms (AcroForm + XFA)
  if (opts.stripForms) {
    try { catalog.delete(PDFName.of('AcroForm')) } catch {}
  }

  pruneUnreachablePdfObjects(doc)
  return await doc.save()
}

// ---------- Split ----------

export interface SplitRange {
  start: number // 1-based inclusive
  end: number   // 1-based inclusive
  name?: string
}

export async function splitPdf(bytes: Uint8Array, ranges: SplitRange[]): Promise<Uint8Array[]> {
  const source = await PDFDocument.load(bytes)
  const total = source.getPageCount()
  const out: Uint8Array[] = []
  for (const r of ranges) {
    const s = Math.max(1, r.start)
    const e = Math.min(total, r.end)
    if (e < s) continue
    const indices = Array.from({ length: e - s + 1 }, (_, i) => s - 1 + i)
    const dest = await PDFDocument.create()
    const copied = await dest.copyPages(source, indices)
    for (const p of copied) dest.addPage(p)
    out.push(await dest.save())
  }
  return out
}

/** Split into N-page chunks. */
export async function splitEveryN(bytes: Uint8Array, n: number): Promise<Uint8Array[]> {
  const doc = await PDFDocument.load(bytes)
  const total = doc.getPageCount()
  const ranges: SplitRange[] = []
  for (let i = 1; i <= total; i += n) {
    ranges.push({ start: i, end: Math.min(i + n - 1, total) })
  }
  return splitPdf(bytes, ranges)
}

// ---------- Page labels (i, ii, iii, 1, 2, 3) ----------

export type PageLabelStyle = 'D' | 'R' | 'r' | 'A' | 'a' // Decimal, Roman UC/LC, Letter UC/LC

export interface PageLabelRange {
  from: number // 0-based page index where this numbering starts
  style: PageLabelStyle
  prefix?: string
  start?: number // starting number for this range (default 1)
}

export async function setPageLabels(bytes: Uint8Array, ranges: PageLabelRange[]): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes)
  const context = doc.context
  const nums = PDFArray.withContext(context)
  for (const r of ranges) {
    const dict = PDFDict.withContext(context)
    dict.set(PDFName.of('S'), PDFName.of(r.style))
    if (r.prefix) dict.set(PDFName.of('P'), PDFString.of(r.prefix))
    if (r.start !== undefined) dict.set(PDFName.of('St'), PDFNumber.of(r.start))
    nums.push(PDFNumber.of(r.from))
    nums.push(dict)
  }
  const labels = PDFDict.withContext(context)
  labels.set(PDFName.of('Nums'), nums)
  doc.catalog.set(PDFName.of('PageLabels'), labels)
  return await doc.save()
}

// ---------- Bates numbering (legal counter burned onto each page footer) ----------

export interface BatesOptions {
  prefix?: string        // e.g. "ACME-"
  suffix?: string
  start?: number         // default 1
  digits?: number        // zero-pad, default 6
  position?: 'footer-right' | 'footer-center' | 'footer-left' | 'header-right' | 'header-center' | 'header-left'
  fontSize?: number      // default 10
  color?: [number, number, number] // rgb 0..1; default black
  margin?: number        // pt from edge, default 20
  skipOdd?: boolean      // skip odd pages
  skipEven?: boolean     // skip even pages
  skipPages?: number[]   // specific 0-based page indices to skip
  ranges?: { from: number; to: number; start?: number }[] // restart numbering at range boundaries
}

export async function applyBatesNumbering(bytes: Uint8Array, opts: BatesOptions = {}): Promise<Uint8Array> {
  const { prefix = '', suffix = '', start = 1, digits = 6, position = 'footer-right', fontSize = 10, color = [0, 0, 0], margin = 20 } = opts
  const skipSet = new Set(opts.skipPages || [])
  const doc = await PDFDocument.load(bytes)
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const pages = doc.getPages()

  // Build a counter map: for each page, what number should it get?
  let counter = start
  pages.forEach((page, i) => {
    // Check skip conditions
    if (opts.skipOdd && i % 2 === 0) return    // 0-indexed: even index = odd page
    if (opts.skipEven && i % 2 === 1) return
    if (skipSet.has(i)) return

    // Check if we need to restart counter at a range boundary
    if (opts.ranges) {
      const range = opts.ranges.find(r => r.from === i)
      if (range) counter = range.start ?? start
    }

    const { width, height } = page.getSize()
    const n = String(counter).padStart(digits, '0')
    const text = `${prefix}${n}${suffix}`
    const textW = font.widthOfTextAtSize(text, fontSize)
    const textH = font.heightAtSize(fontSize)
    let x = margin, y = margin
    if (position.startsWith('header')) y = height - margin - textH
    if (position.endsWith('right')) x = width - margin - textW
    else if (position.endsWith('center')) x = (width - textW) / 2
    page.drawText(text, { x, y, size: fontSize, font, color: rgb(color[0], color[1], color[2]) })
    counter++
  })
  return await doc.save()
}

// ---------- Attachments (embed arbitrary files in the PDF) ----------

export interface PdfAttachment {
  name: string          // filename shown in viewers
  bytes: Uint8Array
  mimeType?: string
  description?: string
}

export async function addAttachments(bytes: Uint8Array, files: PdfAttachment[]): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes)
  for (const f of files) {
    await doc.attach(f.bytes, f.name, {
      mimeType: f.mimeType,
      description: f.description,
    })
  }
  return await doc.save()
}

// ---------- Hyperlinks (add URI link annotation to a rect) ----------

export interface HyperlinkSpec {
  page: number     // 0-based index
  rect: [number, number, number, number] // x1, y1, x2, y2 in PDF points (origin bottom-left)
  url: string
}

export async function addHyperlinks(bytes: Uint8Array, links: HyperlinkSpec[]): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes)
  const ctx = doc.context
  const pages = doc.getPages()
  for (const link of links) {
    const page = pages[link.page]
    if (!page) continue
    const linkDict = PDFDict.withContext(ctx)
    linkDict.set(PDFName.of('Type'), PDFName.of('Annot'))
    linkDict.set(PDFName.of('Subtype'), PDFName.of('Link'))
    linkDict.set(PDFName.of('Rect'), PDFArray.withContext(ctx))
    const rect = linkDict.get(PDFName.of('Rect')) as PDFArray
    for (const v of link.rect) rect.push(PDFNumber.of(v))
    linkDict.set(PDFName.of('Border'), PDFArray.withContext(ctx))
    const border = linkDict.get(PDFName.of('Border')) as PDFArray
    for (const v of [0, 0, 0]) border.push(PDFNumber.of(v))
    const action = PDFDict.withContext(ctx)
    action.set(PDFName.of('Type'), PDFName.of('Action'))
    action.set(PDFName.of('S'), PDFName.of('URI'))
    action.set(PDFName.of('URI'), PDFString.of(link.url))
    linkDict.set(PDFName.of('A'), action)
    const annotRef = ctx.register(linkDict)
    let annots = page.node.get(PDFName.of('Annots')) as PDFArray | undefined
    if (!annots) {
      annots = PDFArray.withContext(ctx)
      page.node.set(PDFName.of('Annots'), annots)
    }
    annots.push(annotRef)
  }
  return await doc.save()
}

// ---------- Crop pages ----------

export interface CropRect {
  x: number
  y: number
  width: number
  height: number
}

export async function cropPages(bytes: Uint8Array, rect: CropRect, pageIndices?: number[]): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes)
  const pages = doc.getPages()
  const targets = pageIndices ?? pages.map((_, i) => i)
  for (const i of targets) {
    const page = pages[i]
    if (!page) continue
    // Crop = visible region [x, y, x+width, y+height]. Set both
    // MediaBox and CropBox so verifiers / downstream renderers /
    // print pipeline all agree on the visible page bounds. The
    // previous implementation only set CropBox, which left MediaBox
    // at the original [0,0,W,H] and the saved bytes still reported
    // the un-cropped page size.
    page.setMediaBox(rect.x, rect.y, rect.width, rect.height)
    page.setCropBox(rect.x, rect.y, rect.width, rect.height)
  }
  return await doc.save()
}

// ---------- Rotate (bulk) ----------

export async function rotatePages(bytes: Uint8Array, angle: 90 | 180 | 270, pageIndices?: number[]): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes)
  const pages = doc.getPages()
  const targets = pageIndices ?? pages.map((_, i) => i)
  for (const i of targets) {
    const p = pages[i]
    if (!p) continue
    const current = p.getRotation().angle
    p.setRotation(degrees((current + angle) % 360))
  }
  return await doc.save()
}

// ---------- Compress / Optimize ----------

export async function compressPdf(
  bytes: Uint8Array,
  opts?: { imageQuality?: number; maxDimension?: number }
): Promise<Uint8Array> {
  const quality = opts?.imageQuality ?? 0.65
  const maxDim = opts?.maxDimension ?? 1500

  const doc = await PDFDocument.load(bytes)

  // Walk all indirect objects and downsample JPEG images
  const context = doc.context
  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue
    const dict = obj.dict
    const subtype = dict.get(PDFName.of('Subtype'))
    if (!subtype || subtype.toString() !== '/Image') continue
    const filter = dict.get(PDFName.of('Filter'))
    if (!filter || filter.toString() !== '/DCTDecode') continue

    // This is a JPEG image — extract dimensions
    const imgW = (dict.get(PDFName.of('Width')) as PDFNumber | undefined)?.asNumber() ?? 0
    const imgH = (dict.get(PDFName.of('Height')) as PDFNumber | undefined)?.asNumber() ?? 0
    if (imgW <= maxDim && imgH <= maxDim) continue // Already small enough

    try {
      // Decode the JPEG
      const jpegBytes = obj.contents
      const blob = new Blob([jpegBytes], { type: 'image/jpeg' })
      const bitmap = await createImageBitmap(blob)

      // Calculate scaled dimensions (preserving aspect ratio)
      const scale = Math.min(maxDim / bitmap.width, maxDim / bitmap.height, 1)
      const newW = Math.round(bitmap.width * scale)
      const newH = Math.round(bitmap.height * scale)

      // Re-encode at reduced size and quality
      const canvas = new OffscreenCanvas(newW, newH)
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(bitmap, 0, 0, newW, newH)
      bitmap.close()

      const outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality })
      const outBytes = new Uint8Array(await outBlob.arrayBuffer())

      // Replace stream contents — see editSerializer for the same cast.
      ;(obj as unknown as { contents: Uint8Array }).contents = outBytes
      dict.set(PDFName.of('Width'), PDFNumber.of(newW))
      dict.set(PDFName.of('Height'), PDFNumber.of(newH))
      dict.set(PDFName.of('Length'), PDFNumber.of(outBytes.length))
    } catch {
      // Skip images that fail to decode — non-critical
    }
  }

  return await doc.save({
    useObjectStreams: true,
    updateFieldAppearances: false,
  })
}

// ---------- PDF → Images (PNG per page, rendered via pdfjs) ----------

export async function pdfToImages(bytes: Uint8Array, opts: { scale?: number } = {}): Promise<Uint8Array[]> {
  const scale = opts.scale ?? 2
  const pdfjsLib = await import('pdfjs-dist')
  const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise
  const images: Uint8Array[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = viewport.width
    canvas.height = viewport.height
    const ctx = canvas.getContext('2d')!
    await page.render({ canvasContext: ctx, viewport }).promise
    const dataUrl = canvas.toDataURL('image/png')
    const b64 = dataUrl.substring(dataUrl.indexOf(',') + 1)
    const bin = atob(b64)
    const arr = new Uint8Array(bin.length)
    for (let j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j)
    images.push(arr)
    page.cleanup()
  }
  doc.destroy()
  return images
}

// ---------- Images → PDF ----------

export interface ImageToPdfOpts {
  pageSize?: { width: number; height: number } // pt; default letter 612x792
  fit?: 'contain' | 'cover' | 'stretch'
  margin?: number
}

export async function imagesToPdf(images: Uint8Array[], opts: ImageToPdfOpts = {}): Promise<Uint8Array> {
  const { pageSize = { width: 612, height: 792 }, fit = 'contain', margin = 20 } = opts
  const doc = await PDFDocument.create()
  for (const imgBytes of images) {
    // Detect PNG vs JPG by magic bytes
    const isPng = imgBytes[0] === 0x89 && imgBytes[1] === 0x50 && imgBytes[2] === 0x4e && imgBytes[3] === 0x47
    const img = isPng ? await doc.embedPng(imgBytes) : await doc.embedJpg(imgBytes)
    const page = doc.addPage([pageSize.width, pageSize.height])
    const availableW = pageSize.width - margin * 2
    const availableH = pageSize.height - margin * 2
    let drawW: number, drawH: number
    if (fit === 'stretch') {
      drawW = availableW; drawH = availableH
    } else {
      const ratio = img.width / img.height
      const avail = availableW / availableH
      if ((fit === 'contain' && ratio > avail) || (fit === 'cover' && ratio < avail)) {
        drawW = availableW
        drawH = availableW / ratio
      } else {
        drawH = availableH
        drawW = availableH * ratio
      }
    }
    const x = (pageSize.width - drawW) / 2
    const y = (pageSize.height - drawH) / 2
    page.drawImage(img, { x, y, width: drawW, height: drawH })
  }
  return await doc.save()
}

// ---------- Extract all text (used by PDF → Word, Find & Replace, Compare) ----------

export interface ExtractedText {
  page: number
  items: { str: string; x: number; y: number; width: number; height: number; fontName?: string }[]
}

export async function extractText(bytes: Uint8Array): Promise<ExtractedText[]> {
  const pdfjsLib = await import('pdfjs-dist')
  const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise
  const out: ExtractedText[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const tc = await page.getTextContent()
    const viewport = page.getViewport({ scale: 1 })
    const items = tc.items.map((item: any) => {
      const tx = item.transform
      return {
        str: item.str,
        x: tx[4],
        y: viewport.height - tx[5],
        width: item.width,
        height: item.height,
        fontName: item.fontName,
      }
    })
    out.push({ page: i - 1, items })
    page.cleanup()
  }
  doc.destroy()
  return out
}

// ---------- Flatten annotations (burn form fields + fabric into page content) ----------

/** Strips interactive annotations and AcroForm, leaving only visible content.
 *  Used for "print final" / "prevent edits" workflows. */
export async function flattenForm(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes)
  const form = doc.getForm()
  form.flatten()
  return await doc.save()
}

// ---------- Custom thumbnail ----------
//
// Two concepts are combined here because users ask for "set a thumbnail"
// expecting EITHER to happen:
//   (a) Embed a /Thumb image stream on each PDF page so Acrobat-class
//       viewers show it in their thumbnail pane. This is the PDF-native
//       way and doesn't change the document content.
//   (b) Optionally prepend a "cover page" with the image filling it,
//       which is what most consumer tools do when they say "change
//       thumbnail" — the first page IS the thumbnail.

export interface ThumbnailOptions {
  /** Image to use. PNG or JPG bytes. */
  imageBytes: Uint8Array
  /** Where to apply /Thumb — 'first' (default), 'all', or specific indices. */
  pagesForEmbed?: 'first' | 'all' | number[]
  /** If true, prepend a cover page with the image filling it. */
  prependCoverPage?: boolean
  /** Cover page size when prepending (pt). Defaults to letter. */
  coverSize?: { width: number; height: number }
}

export async function setPdfThumbnail(bytes: Uint8Array, opts: ThumbnailOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes)
  const isPng = opts.imageBytes[0] === 0x89 && opts.imageBytes[1] === 0x50 && opts.imageBytes[2] === 0x4e && opts.imageBytes[3] === 0x47
  const img = isPng ? await doc.embedPng(opts.imageBytes) : await doc.embedJpg(opts.imageBytes)

  if (opts.prependCoverPage) {
    const size = opts.coverSize ?? { width: 612, height: 792 }
    // Cover is the fit-inside rectangle, centered with margin
    const margin = 20
    const availW = size.width - margin * 2
    const availH = size.height - margin * 2
    const ratio = img.width / img.height
    const availRatio = availW / availH
    let drawW: number, drawH: number
    if (ratio > availRatio) { drawW = availW; drawH = availW / ratio }
    else { drawH = availH; drawW = availH * ratio }
    const x = (size.width - drawW) / 2
    const y = (size.height - drawH) / 2
    // Insert a new page at index 0
    const cover = doc.insertPage(0, [size.width, size.height])
    cover.drawImage(img, { x, y, width: drawW, height: drawH })
  }

  // Embed /Thumb on the requested pages.
  const pages = doc.getPages()
  const pageIndices: number[] = opts.pagesForEmbed === 'all'
    ? pages.map((_, i) => i)
    : Array.isArray(opts.pagesForEmbed)
      ? opts.pagesForEmbed
      : [0]
  for (const idx of pageIndices) {
    const page = pages[idx]
    if (!page) continue
    // The /Thumb entry on a page dictionary accepts an image XObject
    // reference. pdf-lib's embedded images carry their own ref via .ref.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const imgRef = (img as unknown as { ref: unknown }).ref
    if (imgRef) {
      page.node.set(PDFName.of('Thumb'), imgRef as Parameters<typeof page.node.set>[1])
    }
  }
  return await doc.save()
}

/** Convenience: use a rendered page of the PDF itself as the thumbnail
 *  for every page. Matches what users mean by "use page 2 as my cover". */
export async function setPdfThumbnailFromPage(bytes: Uint8Array, pageIndex: number, prependCover = false): Promise<Uint8Array> {
  const images = await pdfToImages(bytes, { scale: 1.5 })
  const source = images[pageIndex] ?? images[0]
  if (!source) return bytes
  return setPdfThumbnail(bytes, { imageBytes: source, pagesForEmbed: 'all', prependCoverPage: prependCover })
}
