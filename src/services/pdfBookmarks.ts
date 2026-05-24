// Bookmarks / outline support. Reads /Outlines from PDF catalog, and
// writes a flat list of (title → page) bookmarks back. Nested outlines
// are supported on read but flattened on write (simpler UX; can nest
// later if users want it).

import { PDFDocument, PDFDict, PDFName, PDFArray, PDFString, PDFHexString, PDFNumber, PDFRef } from 'pdf-lib'

/** True iff every code unit is ASCII (≤ U+007F). PDFDocEncoding handles
 *  ASCII byte-identically; anything outside needs the UTF-16 BE / BOM
 *  hex-string path to round-trip cleanly. Em-dash (U+2014), curly
 *  quotes, accented Latin, currency, and CJK all fail this check. */
function isAsciiOnly(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0x7f) return false
  }
  return true
}

/** Emit a PDFString-or-PDFHexString that round-trips `s` losslessly.
 *  Plain `PDFString.of(s)` uses PDFDocEncoding (single-byte), which
 *  truncates U+2014 (em-dash) to 0x14 — corrupting any non-ASCII
 *  title on save. PDFHexString.fromText encodes as UTF-16 BE with the
 *  BOM that PDF readers expect. */
function pdfTextString(s: string): PDFString | PDFHexString {
  return isAsciiOnly(s) ? PDFString.of(s) : PDFHexString.fromText(s)
}

export interface Bookmark {
  title: string
  page: number // 0-based index
  children?: Bookmark[]
}

function readOutlineNode(node: PDFDict | undefined, doc: PDFDocument): Bookmark | null {
  if (!node) return null
  const titleObj = node.get(PDFName.of('Title'))
  let title = ''
  if (titleObj instanceof PDFHexString) title = titleObj.decodeText()
  else if (titleObj instanceof PDFString) title = titleObj.asString()
  // Dest can be direct or via /A (GoTo action)
  let page = 0
  const dest = node.get(PDFName.of('Dest'))
  const action = node.get(PDFName.of('A'))
  let destArr: PDFArray | undefined
  if (dest instanceof PDFArray) destArr = dest
  else if (action instanceof PDFDict) {
    const d = action.get(PDFName.of('D'))
    if (d instanceof PDFArray) destArr = d
  }
  if (destArr) {
    const pageRef = destArr.get(0)
    if (pageRef instanceof PDFRef) {
      const allPages = doc.getPages()
      const idx = allPages.findIndex((p) => p.ref === pageRef)
      if (idx >= 0) page = idx
    }
  }
  // Walk children via /First + /Next
  const children: Bookmark[] = []
  let childRef = node.get(PDFName.of('First'))
  while (childRef instanceof PDFRef) {
    const childNode = doc.context.lookup(childRef) as PDFDict
    const child = readOutlineNode(childNode, doc)
    if (child) children.push(child)
    const nextRef = childNode.get(PDFName.of('Next'))
    childRef = nextRef instanceof PDFRef ? nextRef : undefined
  }
  return { title, page, children: children.length ? children : undefined }
}

export async function readBookmarks(bytes: Uint8Array): Promise<Bookmark[]> {
  // Read-only path — share the parsed doc with other Advanced Tools
  // sections so opening Bookmarks doesn't re-parse a 33 MB doc.
  const { getReadOnlyPdfLibDoc } = await import('./pdfLibDocCache')
  const doc = await getReadOnlyPdfLibDoc(bytes)
  // catalog.get returns the raw value, which may be a PDFRef — deref via ctx.lookup.
  let outlines: unknown = doc.catalog.get(PDFName.of('Outlines'))
  if (outlines instanceof PDFRef) outlines = doc.context.lookup(outlines)
  if (!(outlines instanceof PDFDict)) return []
  const top: Bookmark[] = []
  let childRef: unknown = outlines.get(PDFName.of('First'))
  while (childRef instanceof PDFRef) {
    const childNode = doc.context.lookup(childRef) as PDFDict
    const child = readOutlineNode(childNode, doc)
    if (child) top.push(child)
    const nextRef = childNode.get(PDFName.of('Next'))
    childRef = nextRef instanceof PDFRef ? nextRef : undefined
  }
  return top
}

/** Replace all bookmarks with a flat list. Each entry points to a page. */
export async function writeFlatBookmarks(bytes: Uint8Array, bookmarks: Bookmark[]): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes)
  const ctx = doc.context
  const pages = doc.getPages()
  if (bookmarks.length === 0) {
    doc.catalog.delete(PDFName.of('Outlines'))
    return await doc.save()
  }
  // Build child nodes first, then link First/Last/Next/Prev
  const childRefs: PDFRef[] = []
  bookmarks.forEach((bm) => {
    const pageIdx = Math.max(0, Math.min(pages.length - 1, bm.page))
    const dict = PDFDict.withContext(ctx)
    dict.set(PDFName.of('Title'), pdfTextString(bm.title))
    const destArr = PDFArray.withContext(ctx)
    destArr.push(pages[pageIdx].ref)
    destArr.push(PDFName.of('XYZ'))
    destArr.push(PDFNumber.of(0))
    destArr.push(PDFNumber.of(pages[pageIdx].getHeight()))
    destArr.push(PDFNumber.of(0))
    dict.set(PDFName.of('Dest'), destArr)
    childRefs.push(ctx.register(dict))
  })
  const outlines = PDFDict.withContext(ctx)
  outlines.set(PDFName.of('Type'), PDFName.of('Outlines'))
  outlines.set(PDFName.of('Count'), PDFNumber.of(childRefs.length))
  outlines.set(PDFName.of('First'), childRefs[0])
  outlines.set(PDFName.of('Last'), childRefs[childRefs.length - 1])
  const outlinesRef = ctx.register(outlines)
  childRefs.forEach((ref, i) => {
    const dict = ctx.lookup(ref) as PDFDict
    dict.set(PDFName.of('Parent'), outlinesRef)
    if (i > 0) dict.set(PDFName.of('Prev'), childRefs[i - 1])
    if (i < childRefs.length - 1) dict.set(PDFName.of('Next'), childRefs[i + 1])
  })
  doc.catalog.set(PDFName.of('Outlines'), outlinesRef)
  return await doc.save()
}
