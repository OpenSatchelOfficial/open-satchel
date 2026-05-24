// Link annotation editor services. Walks every page's /Annots array
// looking for /Subtype /Link entries, surfacing their URL or page
// destination so the UI can list, edit, and delete them.
//
// Covers three PDF link flavors:
//   - URI action: { /S /URI, /URI "https://..." }  → external link
//   - GoTo action: { /S /GoTo, /D [ pageRef /XYZ x y z ] }  → same-doc jump
//   - GoToR action: { /S /GoToR, /F "..." }  → external file (rare)

import { PDFDocument, PDFName, PDFArray, PDFDict, PDFString, PDFHexString, PDFRef, PDFNumber } from 'pdf-lib'

export interface LinkAnnotation {
  pageIndex: number
  annotRef: string          // indirect object key for round-trip edit/delete
  rect: [number, number, number, number]  // x1, y1, x2, y2 PDF user-space
  kind: 'uri' | 'goto' | 'gotor' | 'unknown'
  /** For `uri`: the URL. For `goto`: formatted "Page N". For `gotor`:
   *  the target file path. Used as the edit-in-place label. */
  target: string
  /** For `goto` only: the resolved destination page (0-based). */
  destPage?: number
}

function derefDict(doc: PDFDocument, val: unknown): PDFDict | undefined {
  const v = val instanceof PDFRef ? doc.context.lookup(val) : val
  return v instanceof PDFDict ? v : undefined
}

export async function listLinks(bytes: Uint8Array): Promise<LinkAnnotation[]> {
  const doc = await PDFDocument.load(bytes)
  const out: LinkAnnotation[] = []
  for (let i = 0; i < doc.getPageCount(); i++) {
    const page = doc.getPage(i)
    const annotsArr = page.node.get(PDFName.of('Annots'))
    if (!(annotsArr instanceof PDFArray)) continue
    for (let j = 0; j < annotsArr.size(); j++) {
      const annotVal = annotsArr.get(j)
      const annotDict = derefDict(doc, annotVal)
      if (!annotDict) continue
      const subtype = annotDict.get(PDFName.of('Subtype'))
      if (!subtype || subtype.toString() !== '/Link') continue

      const rect: [number, number, number, number] = [0, 0, 0, 0]
      const rectArr = annotDict.get(PDFName.of('Rect'))
      if (rectArr instanceof PDFArray) {
        for (let k = 0; k < 4; k++) {
          const n = rectArr.get(k)
          rect[k] = n instanceof PDFNumber ? n.asNumber() : 0
        }
      }

      const actionDict = derefDict(doc, annotDict.get(PDFName.of('A')))
      const destVal = annotDict.get(PDFName.of('Dest'))

      let kind: LinkAnnotation['kind'] = 'unknown'
      let target = ''
      let destPage: number | undefined

      if (actionDict) {
        const s = actionDict.get(PDFName.of('S'))?.toString()
        if (s === '/URI') {
          const uri = actionDict.get(PDFName.of('URI'))
          if (uri instanceof PDFString) target = uri.asString()
          else if (uri instanceof PDFHexString) target = uri.decodeText()
          kind = 'uri'
        } else if (s === '/GoTo') {
          const d = actionDict.get(PDFName.of('D'))
          if (d instanceof PDFArray && d.get(0) instanceof PDFRef) {
            destPage = doc.getPages().findIndex((p) => p.ref === (d.get(0) as PDFRef))
            kind = 'goto'
            target = destPage >= 0 ? `Page ${destPage + 1}` : '(unresolved)'
          }
        } else if (s === '/GoToR') {
          const f = actionDict.get(PDFName.of('F'))
          if (f instanceof PDFString) target = f.asString()
          else if (f instanceof PDFHexString) target = f.decodeText()
          kind = 'gotor'
        }
      } else if (destVal instanceof PDFArray) {
        // Inline /Dest (rare but legal).
        if (destVal.get(0) instanceof PDFRef) {
          destPage = doc.getPages().findIndex((p) => p.ref === (destVal.get(0) as PDFRef))
          kind = 'goto'
          target = destPage >= 0 ? `Page ${destPage + 1}` : '(unresolved)'
        }
      }

      const annotRef = annotVal instanceof PDFRef ? annotVal.toString() : `inline-${i}-${j}`
      out.push({ pageIndex: i, annotRef, rect, kind, target, destPage })
    }
  }
  return out
}

/** Update an existing link annotation's URL (for uri kind) or destination
 *  page (for goto kind). Identified by pageIndex + annotRef. */
export async function updateLink(
  bytes: Uint8Array,
  pageIndex: number,
  annotRef: string,
  patch: { url?: string; destPage?: number },
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes)
  const page = doc.getPage(pageIndex)
  const annotsArr = page.node.get(PDFName.of('Annots'))
  if (!(annotsArr instanceof PDFArray)) return bytes

  for (let j = 0; j < annotsArr.size(); j++) {
    const v = annotsArr.get(j)
    if (!(v instanceof PDFRef)) continue
    if (v.toString() !== annotRef) continue
    const dict = doc.context.lookup(v)
    if (!(dict instanceof PDFDict)) continue

    if (patch.url !== undefined) {
      // Force URI action, replacing any existing /A or /Dest.
      dict.delete(PDFName.of('Dest'))
      const action = PDFDict.withContext(doc.context)
      action.set(PDFName.of('Type'), PDFName.of('Action'))
      action.set(PDFName.of('S'), PDFName.of('URI'))
      action.set(PDFName.of('URI'), PDFString.of(patch.url))
      dict.set(PDFName.of('A'), action)
    }
    if (patch.destPage !== undefined) {
      const targetPage = doc.getPages()[patch.destPage]
      if (!targetPage) continue
      dict.delete(PDFName.of('A'))
      const destArr = PDFArray.withContext(doc.context)
      destArr.push(targetPage.ref)
      destArr.push(PDFName.of('XYZ'))
      destArr.push(PDFNumber.of(0))
      destArr.push(PDFNumber.of(targetPage.getHeight()))
      destArr.push(PDFNumber.of(0))
      dict.set(PDFName.of('Dest'), destArr)
    }
  }
  return await doc.save()
}

/** Delete a link annotation by pageIndex + annotRef. */
export async function deleteLink(
  bytes: Uint8Array,
  pageIndex: number,
  annotRef: string,
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes)
  const page = doc.getPage(pageIndex)
  const annotsArr = page.node.get(PDFName.of('Annots'))
  if (!(annotsArr instanceof PDFArray)) return bytes

  const keep: Array<Parameters<PDFArray['push']>[0]> = []
  for (let j = 0; j < annotsArr.size(); j++) {
    const v = annotsArr.get(j)
    if (v instanceof PDFRef && v.toString() === annotRef) continue
    keep.push(v as Parameters<PDFArray['push']>[0])
  }
  const next = PDFArray.withContext(doc.context)
  for (const v of keep) next.push(v)
  page.node.set(PDFName.of('Annots'), next)
  return await doc.save()
}

// ── Named destinations ─────────────────────────────────────────────

export interface NamedDestination {
  name: string
  pageIndex: number
  /** XYZ top-left y in PDF user-space (rarely used by editors). */
  top?: number
}

/** Walks /Catalog/Names/Dests and /Catalog/Dests (two legal locations
 *  for named dests in the spec) and emits a flat list. */
export async function listNamedDestinations(bytes: Uint8Array): Promise<NamedDestination[]> {
  const doc = await PDFDocument.load(bytes)
  const out: NamedDestination[] = []
  const pages = doc.getPages()

  const pushFromDest = (name: string, destVal: unknown) => {
    const dest = destVal instanceof PDFRef ? doc.context.lookup(destVal) : destVal
    const arr = dest instanceof PDFArray ? dest : (dest instanceof PDFDict ? (dest.get(PDFName.of('D')) as PDFArray | undefined) : undefined)
    if (!(arr instanceof PDFArray)) return
    const pageRef = arr.get(0)
    if (!(pageRef instanceof PDFRef)) return
    const idx = pages.findIndex((p) => p.ref === pageRef)
    if (idx < 0) return
    out.push({ name, pageIndex: idx })
  }

  // Old-style: /Catalog /Dests dict (name → dest)
  const oldDests = doc.catalog.get(PDFName.of('Dests'))
  const oldDestsDict = oldDests instanceof PDFRef ? doc.context.lookup(oldDests) : oldDests
  if (oldDestsDict instanceof PDFDict) {
    for (const [key, value] of oldDestsDict.entries()) {
      pushFromDest(key.toString().replace(/^\//, ''), value)
    }
  }

  // New-style: /Catalog /Names /Dests name tree
  const names = doc.catalog.get(PDFName.of('Names'))
  const namesDict = names instanceof PDFRef ? doc.context.lookup(names) : names
  if (namesDict instanceof PDFDict) {
    const destsNode = namesDict.get(PDFName.of('Dests'))
    const destsDict = destsNode instanceof PDFRef ? doc.context.lookup(destsNode) : destsNode
    if (destsDict instanceof PDFDict) {
      const walk = (node: PDFDict) => {
        const namesArr = node.get(PDFName.of('Names'))
        const realNamesArr = namesArr instanceof PDFRef ? doc.context.lookup(namesArr) : namesArr
        if (realNamesArr instanceof PDFArray) {
          for (let i = 0; i + 1 < realNamesArr.size(); i += 2) {
            const key = realNamesArr.get(i)
            let n = ''
            if (key instanceof PDFString) n = key.asString()
            else if (key instanceof PDFHexString) n = key.decodeText()
            pushFromDest(n, realNamesArr.get(i + 1))
          }
        }
        const kids = node.get(PDFName.of('Kids'))
        const realKids = kids instanceof PDFRef ? doc.context.lookup(kids) : kids
        if (realKids instanceof PDFArray) {
          for (let i = 0; i < realKids.size(); i++) {
            const k = realKids.get(i)
            const kd = k instanceof PDFRef ? doc.context.lookup(k) : k
            if (kd instanceof PDFDict) walk(kd)
          }
        }
      }
      walk(destsDict)
    }
  }
  return out
}

/** Replace all named destinations with the provided list. Writes to
 *  the modern /Catalog /Names /Dests name tree (the form veraPDF and
 *  Acrobat 2020+ prefer) AND mirrors to the legacy /Catalog /Dests
 *  dict so older readers and PDF/A-1b validators still resolve them. */
export async function writeNamedDestinations(
  bytes: Uint8Array,
  dests: NamedDestination[],
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes)
  const pages = doc.getPages()

  // Build the legacy /Catalog/Dests dict (name → dest array).
  const legacyDict = PDFDict.withContext(doc.context)
  // Build the modern /Names/Dests Names array — flat [name, dest, name, dest, ...].
  const namesArr = PDFArray.withContext(doc.context)

  for (const d of dests) {
    const page = pages[d.pageIndex]
    if (!page) continue
    const destArr = PDFArray.withContext(doc.context)
    destArr.push(page.ref)
    destArr.push(PDFName.of('XYZ'))
    destArr.push(PDFNumber.of(0))
    destArr.push(PDFNumber.of(d.top ?? page.getHeight()))
    destArr.push(PDFNumber.of(0))

    legacyDict.set(PDFName.of(d.name), destArr)

    namesArr.push(PDFString.of(d.name))
    namesArr.push(destArr)
  }

  if (dests.length === 0) {
    // Empty list: clear both locations.
    doc.catalog.delete(PDFName.of('Dests'))
    const namesNode = doc.catalog.get(PDFName.of('Names'))
    const namesDict = namesNode instanceof PDFRef ? doc.context.lookup(namesNode) : namesNode
    if (namesDict instanceof PDFDict) namesDict.delete(PDFName.of('Dests'))
  } else {
    doc.catalog.set(PDFName.of('Dests'), legacyDict)

    // Ensure /Catalog/Names exists, then set its /Dests subtree leaf.
    const namesNode = doc.catalog.get(PDFName.of('Names'))
    const existing = namesNode instanceof PDFRef ? doc.context.lookup(namesNode) : namesNode
    let namesDict: PDFDict
    if (existing instanceof PDFDict) {
      namesDict = existing
    } else {
      namesDict = PDFDict.withContext(doc.context)
      doc.catalog.set(PDFName.of('Names'), namesDict)
    }
    const destsLeaf = PDFDict.withContext(doc.context)
    destsLeaf.set(PDFName.of('Names'), namesArr)
    namesDict.set(PDFName.of('Dests'), destsLeaf)
  }

  return await doc.save()
}
