// Pre-removal report for the Sanitize Document wizard. Scans a PDF
// for hidden info (metadata, scripts, attachments, etc.) and returns
// a structured report so the UI can show "we'll remove these N
// items" before the user commits.
//
// Sister service to `pdfOps.sanitizePdf` which actually performs the
// removal. Same option-name vocabulary so a UI can wire (report →
// toggle → apply) without renaming.

import { PDFDocument, PDFDict, PDFName, PDFArray, PDFRef, PDFRawStream, PDFHexString, PDFString, PDFNumber, decodePDFRawStream } from 'pdf-lib'

export interface SanitizeReport {
  /** /Info dict — counts each non-empty document-info field. */
  metadata: {
    /** True if any of title/author/subject/keywords/creator/producer is non-empty. */
    present: boolean
    title?: string
    author?: string
    subject?: string
    keywords?: string[]
    creator?: string
    producer?: string
  }
  /** /Metadata XMP packet. */
  xmp: { present: boolean; bytes: number }
  /** Document-level JS plus per-page additional actions. */
  javascript: {
    /** Count of all JS-bearing structures: openAction + AA + page-AAs + named-JS-tree. */
    count: number
    hasOpenAction: boolean
    hasAdditionalActions: boolean
    pageActionPages: number[]
    namedJsActions: number
  }
  /** /Names/EmbeddedFiles dictionary. */
  attachments: {
    count: number
    names: string[]
    items: {
      name: string
      fileName?: string
      unicodeFileName?: string
      description?: string
      subtype?: string
      size?: number
      checksum?: string
      crc?: string
      decodedBytes?: number
      payloadPreview?: string
    }[]
  }
  /** /OCProperties — optional content groups (layers). */
  layers: { count: number }
  /** Per-page /Annots — sticky notes, highlights, links, etc. */
  annotations: { totalCount: number; perPage: { pageIndex: number; count: number }[] }
  /** /AcroForm — interactive form fields. */
  forms: {
    fieldCount: number
    hasXfa: boolean
    hasDefaultResources: boolean
    hasCalculationOrder: boolean
    quadding?: number
  }
  /** /Outlines — bookmarks. */
  outlines: { count: number; titles: string[]; hasActions: boolean }
  /** /Dests and /Names/Dests named destinations. */
  namedDestinations: { count: number; names: string[] }
}

function pdfText(obj: unknown): string | undefined {
  if (obj instanceof PDFHexString) return obj.decodeText()
  if (obj instanceof PDFString) return obj.asString()
  if (obj instanceof PDFName) return obj.toString().replace(/^\//, '')
  return undefined
}

function pdfNumber(obj: unknown): number | undefined {
  return obj instanceof PDFNumber ? obj.asNumber() : undefined
}

function lookupDict(ctx: any, value: unknown): PDFDict | undefined {
  const obj = value instanceof PDFRef ? ctx.lookup(value) : value
  return obj instanceof PDFDict ? obj : undefined
}

function lookupRawStream(ctx: any, value: unknown): PDFRawStream | undefined {
  const obj = value instanceof PDFRef ? ctx.lookup(value) : value
  return obj instanceof PDFRawStream ? obj : undefined
}

export async function generateSanitizeReport(bytes: Uint8Array): Promise<SanitizeReport> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })
  const ctx = doc.context
  const catalog = doc.catalog

  // ── Metadata (DocInfo) ───────────────────────────────────────────
  const title = doc.getTitle() ?? ''
  const author = doc.getAuthor() ?? ''
  const subject = doc.getSubject() ?? ''
  const keywordsRaw = doc.getKeywords() ?? ''
  // pd-lib joins setKeywords([...]) with a space; Acrobat / others
  // join with a comma. Split on either + dedupe so the report shows
  // a normalized list regardless of how the doc was authored.
  const keywords = (typeof keywordsRaw === 'string' ? keywordsRaw : '')
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  const creator = doc.getCreator() ?? ''
  const producer = doc.getProducer() ?? ''
  const metadataPresent = !!(title || author || subject || keywords.length || creator || producer)

  // ── XMP /Metadata ─────────────────────────────────────────────────
  let xmpBytes = 0
  try {
    const ref = catalog.get(PDFName.of('Metadata'))
    const obj = ref instanceof PDFRef ? ctx.lookup(ref) : ref
    if (obj instanceof PDFRawStream) xmpBytes = obj.contents.length
  } catch {
    /* missing → 0 */
  }

  // ── JavaScript / AA / page actions ───────────────────────────────
  let hasOpenAction = false
  let hasAdditionalActions = false
  try {
    if (catalog.get(PDFName.of('OpenAction'))) hasOpenAction = true
  } catch {}
  try {
    if (catalog.get(PDFName.of('AA'))) hasAdditionalActions = true
  } catch {}
  const pageActionPages: number[] = []
  for (let i = 0; i < doc.getPageCount(); i++) {
    try {
      const page = doc.getPage(i)
      if (page.node.get(PDFName.of('AA'))) pageActionPages.push(i)
    } catch {
      /* skip page */
    }
  }
  let namedJsActions = 0
  try {
    const names = catalog.lookup(PDFName.of('Names'))
    if (names instanceof PDFDict) {
      const js = names.lookup(PDFName.of('JavaScript'))
      if (js instanceof PDFDict) {
        const namesArr = js.lookup(PDFName.of('Names'))
        if (namesArr instanceof PDFArray) {
          // Pairs of [name, action-ref] → divide by 2 for entry count.
          namedJsActions = Math.floor(namesArr.size() / 2)
        }
      }
    }
  } catch {
    /* tolerate */
  }
  const javascriptCount =
    (hasOpenAction ? 1 : 0) +
    (hasAdditionalActions ? 1 : 0) +
    pageActionPages.length +
    namedJsActions

  // ── Embedded file attachments ─────────────────────────────────────
  const attachmentNames: string[] = []
  const attachmentItems: SanitizeReport['attachments']['items'] = []
  try {
    const names = catalog.lookup(PDFName.of('Names'))
    if (names instanceof PDFDict) {
      const ef = names.lookup(PDFName.of('EmbeddedFiles'))
      if (ef instanceof PDFDict) {
        const namesArr = ef.lookup(PDFName.of('Names'))
        if (namesArr instanceof PDFArray) {
          for (let i = 0; i < namesArr.size(); i += 2) {
            const nameObj = namesArr.lookup(i)
            // String-or-hex string serialization differs; handle both.
            if (nameObj instanceof PDFHexString) {
              attachmentNames.push(nameObj.decodeText())
            } else if (nameObj instanceof PDFString) {
              attachmentNames.push(nameObj.asString())
            } else {
              attachmentNames.push('(unnamed)')
            }
            const spec = lookupDict(ctx, namesArr.get(i + 1))
            const efDict = spec ? lookupDict(ctx, spec.get(PDFName.of('EF'))) : undefined
            const stream = efDict ? lookupRawStream(ctx, efDict.get(PDFName.of('F'))) : undefined
            const params = spec ? lookupDict(ctx, spec.get(PDFName.of('Params'))) ?? (stream ? lookupDict(ctx, stream.dict.get(PDFName.of('Params'))) : undefined) : undefined
            let decoded: Uint8Array | undefined
            try {
              decoded = stream ? decodePDFRawStream(stream).decode() : undefined
            } catch {
              decoded = stream?.contents
            }
            attachmentItems.push({
              name: attachmentNames[attachmentNames.length - 1],
              ...(spec ? { fileName: pdfText(spec.get(PDFName.of('F'))) } : {}),
              ...(spec ? { unicodeFileName: pdfText(spec.get(PDFName.of('UF'))) } : {}),
              ...(spec ? { description: pdfText(spec.get(PDFName.of('Desc'))) } : {}),
              ...(spec ? { subtype: pdfText(spec.get(PDFName.of('Subtype'))) } : {}),
              ...(params ? { size: pdfNumber(params.get(PDFName.of('Size'))) } : {}),
              ...(params ? { checksum: pdfText(params.get(PDFName.of('CheckSum'))) } : {}),
              ...(params ? { crc: pdfText(params.get(PDFName.of('CRC'))) } : {}),
              ...(decoded ? { decodedBytes: decoded.length, payloadPreview: new TextDecoder().decode(decoded).slice(0, 120) } : {}),
            })
          }
        }
      }
    }
  } catch {
    /* tolerate */
  }

  // ── OCG layers ────────────────────────────────────────────────────
  let layerCount = 0
  try {
    const ocp = catalog.lookup(PDFName.of('OCProperties'))
    if (ocp instanceof PDFDict) {
      const ocgs = ocp.lookup(PDFName.of('OCGs'))
      if (ocgs instanceof PDFArray) layerCount = ocgs.size()
    }
  } catch {
    /* none */
  }

  // ── Annotations ───────────────────────────────────────────────────
  const annotPerPage: { pageIndex: number; count: number }[] = []
  let totalAnnots = 0
  for (let i = 0; i < doc.getPageCount(); i++) {
    try {
      const page = doc.getPage(i)
      const annots = page.node.lookup(PDFName.of('Annots'))
      let count = 0
      if (annots instanceof PDFArray) count = annots.size()
      if (count > 0) {
        annotPerPage.push({ pageIndex: i, count })
        totalAnnots += count
      }
    } catch {
      /* page parse fail — skip */
    }
  }

  // ── Forms ─────────────────────────────────────────────────────────
  let fieldCount = 0
  let hasXfa = false
  let hasDefaultResources = false
  let hasCalculationOrder = false
  let quadding: number | undefined
  try {
    const acro = catalog.lookup(PDFName.of('AcroForm'))
    if (acro instanceof PDFDict) {
      const fields = acro.lookup(PDFName.of('Fields'))
      if (fields instanceof PDFArray) {
        // Walk top-level fields; recurse into kids if present.
        const stack: PDFArray[] = [fields]
        while (stack.length) {
          const arr = stack.pop()!
          for (let i = 0; i < arr.size(); i++) {
            const f = arr.lookup(i)
            if (!(f instanceof PDFDict)) continue
            const kids = f.lookup(PDFName.of('Kids'))
            if (kids instanceof PDFArray) {
              stack.push(kids)
            } else {
              fieldCount += 1
            }
          }
        }
      }
      if (acro.get(PDFName.of('XFA'))) hasXfa = true
      if (acro.get(PDFName.of('DR'))) hasDefaultResources = true
      if (acro.get(PDFName.of('CO'))) hasCalculationOrder = true
      quadding = pdfNumber(acro.get(PDFName.of('Q')))
    }
  } catch {
    /* tolerate */
  }

  // ── Outlines (bookmarks) ──────────────────────────────────────────
  let outlineCount = 0
  const outlineTitles: string[] = []
  let outlineHasActions = false
  try {
    const outlines = catalog.lookup(PDFName.of('Outlines'))
    if (outlines instanceof PDFDict) {
      const cnt = outlines.get(PDFName.of('Count'))
      if (cnt instanceof PDFNumber) {
        outlineCount = Math.abs(cnt.asNumber())
      }
      let current = outlines.get(PDFName.of('First'))
      const seen = new Set<string>()
      while (current instanceof PDFRef && !seen.has(current.toString())) {
        seen.add(current.toString())
        const node = ctx.lookup(current)
        if (!(node instanceof PDFDict)) break
        const title = pdfText(node.get(PDFName.of('Title')))
        if (title) outlineTitles.push(title)
        if (node.get(PDFName.of('A'))) outlineHasActions = true
        const child = node.get(PDFName.of('First'))
        if (child instanceof PDFRef && !seen.has(child.toString())) {
          const childNode = ctx.lookup(child)
          if (childNode instanceof PDFDict) {
            const childTitle = pdfText(childNode.get(PDFName.of('Title')))
            if (childTitle) outlineTitles.push(childTitle)
            if (childNode.get(PDFName.of('A'))) outlineHasActions = true
          }
        }
        current = node.get(PDFName.of('Next'))
      }
    }
  } catch {
    /* none */
  }

  // ── Named destinations ────────────────────────────────────────────
  const namedDestinationNames: string[] = []
  try {
    const names = catalog.lookup(PDFName.of('Names'))
    if (names instanceof PDFDict) {
      const dests = names.lookup(PDFName.of('Dests'))
      if (dests instanceof PDFDict) {
        const namesArr = dests.lookup(PDFName.of('Names'))
        if (namesArr instanceof PDFArray) {
          for (let i = 0; i < namesArr.size(); i += 2) {
            namedDestinationNames.push(pdfText(namesArr.get(i)) ?? '(unnamed)')
          }
        }
      }
    }
    const destsDict = catalog.lookup(PDFName.of('Dests'))
    if (destsDict instanceof PDFDict) {
      for (const key of destsDict.keys()) namedDestinationNames.push(pdfText(key) ?? key.toString())
    }
  } catch {
    /* none */
  }

  return {
    metadata: {
      present: metadataPresent,
      ...(title ? { title } : {}),
      ...(author ? { author } : {}),
      ...(subject ? { subject } : {}),
      ...(keywords.length ? { keywords } : {}),
      ...(creator ? { creator } : {}),
      ...(producer ? { producer } : {}),
    },
    xmp: { present: xmpBytes > 0, bytes: xmpBytes },
    javascript: {
      count: javascriptCount,
      hasOpenAction,
      hasAdditionalActions,
      pageActionPages,
      namedJsActions,
    },
    attachments: { count: attachmentNames.length, names: attachmentNames, items: attachmentItems },
    layers: { count: layerCount },
    annotations: { totalCount: totalAnnots, perPage: annotPerPage },
    forms: {
      fieldCount,
      hasXfa,
      hasDefaultResources,
      hasCalculationOrder,
      ...(quadding !== undefined ? { quadding } : {}),
    },
    outlines: { count: outlineCount, titles: outlineTitles, hasActions: outlineHasActions },
    namedDestinations: { count: namedDestinationNames.length, names: namedDestinationNames },
  }
}

/** Total count of "things that would be removed" in a one-line summary
 *  for buttons / status text. Excludes outlines (we don't strip those
 *  by default). */
export function sanitizeReportTotalRemovable(r: SanitizeReport): number {
  return (
    (r.metadata.present ? 1 : 0) +
    (r.xmp.present ? 1 : 0) +
    r.javascript.count +
    r.attachments.count +
    r.layers.count +
    r.annotations.totalCount +
    r.forms.fieldCount +
    r.outlines.count +
    r.namedDestinations.count
  )
}
