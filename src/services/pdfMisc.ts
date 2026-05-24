// Grab-bag of PDF structural operations:
//
//   • XMP custom metadata — read/write arbitrary Dublin-Core extensions
//   • OCG (Optional Content Groups) — enumerate + toggle visibility +
//     flatten (merge the default-state into content)
//   • Space-usage audit — sum byte sizes by subtype/filter
//   • Initial View — Open at page, zoom, page layout, page mode
//
// Kept in one file because each op is a small self-contained helper
// and the type/dict wrangling is shared.

import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, PDFNumber, PDFString, PDFHexString, PDFRef, PDFStream } from 'pdf-lib'

// ───────────────────────── XMP CUSTOM METADATA ─────────────────────────

export interface XmpCustomProp {
  namespace: string    // full URI, e.g. "http://purl.org/dc/elements/1.1/"
  prefix: string       // short tag prefix, e.g. "dc"
  name: string         // local name, e.g. "rights"
  value: string
}

/** Pull custom XMP properties out of the catalog's /Metadata stream.
 *  Only returns user-extensible namespaces — core PDF / standard Dublin
 *  Core fields that pdf-lib already handles via doc.getTitle() etc are
 *  excluded so the editor doesn't duplicate them. */
export async function readXmpCustomProps(bytes: Uint8Array): Promise<XmpCustomProp[]> {
  const doc = await PDFDocument.load(bytes)
  const catalog = doc.catalog
  const metaRef = catalog.get(PDFName.of('Metadata'))
  if (!metaRef) return []
  const stream = doc.context.lookup(metaRef)
  if (!(stream instanceof PDFStream)) return []
  const payload = stream instanceof PDFRawStream
    ? new TextDecoder().decode(stream.getContents())
    : ''
  if (!payload) return []
  return parseXmpRdf(payload)
}

function parseXmpRdf(xml: string): XmpCustomProp[] {
  const out: XmpCustomProp[] = []
  try {
    const doc = new DOMParser().parseFromString(xml, 'application/xml')
    const rdfDesc = doc.getElementsByTagNameNS('http://www.w3.org/1999/02/22-rdf-syntax-ns#', 'Description')
    for (let i = 0; i < rdfDesc.length; i++) {
      const desc = rdfDesc[i]
      for (const attr of Array.from(desc.attributes)) {
        if (!attr.namespaceURI || attr.namespaceURI === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#') continue
        if (attr.namespaceURI === 'http://www.w3.org/2000/xmlns/') continue
        // Skip pdf-lib-handled fields (title/author/subject/keywords etc)
        // on the standard Dublin Core + PDF / XAP namespaces.
        if (isStandardField(attr.namespaceURI, attr.localName)) continue
        out.push({
          namespace: attr.namespaceURI,
          prefix: attr.prefix || '',
          name: attr.localName,
          value: attr.value,
        })
      }
      for (const child of Array.from(desc.children)) {
        const ns = child.namespaceURI ?? ''
        if (isStandardField(ns, child.localName)) continue
        const valueEl = child.getElementsByTagNameNS('http://www.w3.org/1999/02/22-rdf-syntax-ns#', 'li')[0]
        out.push({
          namespace: ns,
          prefix: child.prefix || '',
          name: child.localName,
          value: valueEl ? valueEl.textContent ?? '' : child.textContent ?? '',
        })
      }
    }
  } catch {
    return []
  }
  return out
}

function isStandardField(ns: string, name: string): boolean {
  const DC = 'http://purl.org/dc/elements/1.1/'
  const PDF = 'http://ns.adobe.com/pdf/1.3/'
  const XMP = 'http://ns.adobe.com/xap/1.0/'
  if (ns === DC && ['title', 'creator', 'subject', 'description'].includes(name)) return true
  if (ns === PDF && ['Producer', 'Keywords'].includes(name)) return true
  if (ns === XMP && ['CreatorTool', 'CreateDate', 'ModifyDate', 'MetadataDate'].includes(name)) return true
  return false
}

// Standard XMP fields that mirror /Info entries. Updating /Info via
// pd-lib's setTitle/setAuthor/etc. doesn't touch /Metadata, so the
// XMP packet drifts out of sync (G6 in the ledger). Gov / hospital
// preflight tools read XMP, not /Info — must keep them in agreement.
//
// Mapping per Adobe XMP for PDF:
//   /Info Title       → dc:title (rdf:Alt with x-default)
//   /Info Author      → dc:creator (rdf:Seq)
//   /Info Subject     → dc:description (rdf:Alt with x-default)
//   /Info Keywords    → pdf:Keywords (literal) AND dc:subject (rdf:Bag)
//   /Info Creator     → xmp:CreatorTool
//   /Info Producer    → pdf:Producer
//   /Info CreationDate→ xmp:CreateDate (ISO 8601)
//   /Info ModDate     → xmp:ModifyDate + xmp:MetadataDate

export interface XmpInfoSync {
  title?: string
  author?: string
  subject?: string
  keywords?: string  // joined-with-comma form, like /Info Keywords
  creator?: string
  producer?: string
  creationDate?: Date
  modificationDate?: Date
}

export async function syncXmpFromInfo(bytes: Uint8Array, meta: XmpInfoSync): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes)
  const catalog = doc.catalog
  const metaRef = catalog.get(PDFName.of('Metadata'))
  let existingXml = ''
  if (metaRef) {
    const stream = doc.context.lookup(metaRef)
    if (stream instanceof PDFRawStream) {
      existingXml = new TextDecoder().decode(stream.getContents())
    }
  }
  const nextXml = rebuildXmpWithStandard(existingXml, meta)
  const metaStream = doc.context.stream(nextXml, {
    Type: PDFName.of('Metadata'),
    Subtype: PDFName.of('XML'),
  })
  catalog.set(PDFName.of('Metadata'), doc.context.register(metaStream))
  return await doc.save()
}

// Regex-based XMP field replacer. Avoids DOMParser entirely (which
// hung on a real-world XMP body during the 2026-04-25 session). For
// each field we want to set, strip any pre-existing tag with the
// same local name (any namespace prefix), then inject a fresh element
// inside the first <rdf:Description ...>. This is structural-not-
// semantic: we don't validate XML namespaces, just substring-match
// tag boundaries. Good enough for /Info → XMP sync (the canonical
// fields are well-defined); not good enough for arbitrary
// custom-property edits.
function regexReplaceXmpFields(existing: string, fields: Array<{ tag: string; xml: string }>): string {
  let out = existing
  // Remove existing instances of each tag (ns-agnostic).
  for (const { tag } of fields) {
    // Match <prefix:tag ...>...</prefix:tag> OR <prefix:tag ... /> (self-closing).
    const localName = tag.includes(':') ? tag.split(':')[1] : tag
    const pairRe = new RegExp(`<[a-zA-Z][\\w-]*:${escapeRegex(localName)}\\b[^>]*>[\\s\\S]*?<\\/[a-zA-Z][\\w-]*:${escapeRegex(localName)}>`, 'g')
    const selfRe = new RegExp(`<[a-zA-Z][\\w-]*:${escapeRegex(localName)}\\b[^>]*\\/>`, 'g')
    out = out.replace(pairRe, '').replace(selfRe, '')
  }
  // Find first <rdf:Description ...> and inject new fields before its
  // closing </rdf:Description>. If no Description tag, append before
  // </rdf:RDF>; if no RDF either, this is a no-op.
  const descClose = /<\/(?:[a-zA-Z][\w-]*:)?Description>/i
  const rdfClose = /<\/(?:[a-zA-Z][\w-]*:)?RDF>/i
  const inject = fields.map((f) => f.xml).join('\n      ')
  if (descClose.test(out)) {
    out = out.replace(descClose, (m) => '\n      ' + inject + '\n    ' + m)
  } else if (rdfClose.test(out)) {
    out = out.replace(rdfClose, (m) => '\n  ' + inject + '\n  ' + m)
  }
  // Ensure required namespace declarations on rdf:Description (best-
  // effort — if we already added them they stay; otherwise inject).
  const NS = [
    ['xmlns:dc', 'http://purl.org/dc/elements/1.1/'],
    ['xmlns:pdf', 'http://ns.adobe.com/pdf/1.3/'],
    ['xmlns:xmp', 'http://ns.adobe.com/xap/1.0/'],
  ]
  out = out.replace(/<([a-zA-Z][\w-]*:)?Description\b([^>]*)>/, (_m, prefix = '', attrs = '') => {
    let extras = ''
    for (const [name, uri] of NS) {
      if (!attrs.includes(name + '=')) extras += ` ${name}="${uri}"`
    }
    return `<${prefix}Description${attrs}${extras}>`
  })
  return out
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function rebuildXmpWithStandard(existing: string, meta: XmpInfoSync): string {
  const e = (s: string) => s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
  const isoDate = (d?: Date): string | null => {
    if (!d) return null
    try {
      const dt = new Date(d)
      if (isNaN(dt.getTime())) return null
      return dt.toISOString().replace(/\.\d{3}Z$/, 'Z')
    } catch {
      return null
    }
  }
  const created = isoDate(meta.creationDate)
  const modified = isoDate(meta.modificationDate)
  const xmpModified = modified ?? isoDate(new Date()) ?? null

  const dcBlock = []
  if (meta.title !== undefined) {
    dcBlock.push(`<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${e(meta.title)}</rdf:li></rdf:Alt></dc:title>`)
  }
  if (meta.author !== undefined) {
    dcBlock.push(`<dc:creator><rdf:Seq><rdf:li>${e(meta.author)}</rdf:li></rdf:Seq></dc:creator>`)
  }
  if (meta.subject !== undefined) {
    dcBlock.push(`<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${e(meta.subject)}</rdf:li></rdf:Alt></dc:description>`)
  }
  if (meta.keywords !== undefined) {
    // Keywords appear in two places: pdf:Keywords (literal CSV) AND
    // dc:subject (rdf:Bag of individual terms split on comma/space).
    const items = meta.keywords.split(/[,;]\s*/).filter(Boolean)
    dcBlock.push(`<dc:subject><rdf:Bag>${items.map((k) => `<rdf:li>${e(k)}</rdf:li>`).join('')}</rdf:Bag></dc:subject>`)
  }

  const pdfBlock = []
  if (meta.keywords !== undefined) pdfBlock.push(`<pdf:Keywords>${e(meta.keywords)}</pdf:Keywords>`)
  if (meta.producer !== undefined) pdfBlock.push(`<pdf:Producer>${e(meta.producer)}</pdf:Producer>`)

  const xmpBlock = []
  if (meta.creator !== undefined) xmpBlock.push(`<xmp:CreatorTool>${e(meta.creator)}</xmp:CreatorTool>`)
  if (created) xmpBlock.push(`<xmp:CreateDate>${created}</xmp:CreateDate>`)
  if (modified) xmpBlock.push(`<xmp:ModifyDate>${modified}</xmp:ModifyDate>`)
  if (xmpModified) xmpBlock.push(`<xmp:MetadataDate>${xmpModified}</xmp:MetadataDate>`)

  // If there's existing XMP, preserve any non-standard properties by
  // running them through readXmpCustomProps logic (they'll be left
  // alone). Build a fresh standard block and splice.
  if (!existing.trim()) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:dc="http://purl.org/dc/elements/1.1/"
      xmlns:pdf="http://ns.adobe.com/pdf/1.3/"
      xmlns:xmp="http://ns.adobe.com/xap/1.0/">
      ${dcBlock.join('\n      ')}
      ${pdfBlock.join('\n      ')}
      ${xmpBlock.join('\n      ')}
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`
  }
  // Existing XMP: regex-replace approach (DOMParser hung on real-world
  // XMP during the 2026-04-25 session). Build the per-field {tag, xml}
  // list and let regexReplaceXmpFields do the splicing.
  const fields: Array<{ tag: string; xml: string }> = []
  if (meta.title !== undefined)        fields.push({ tag: 'dc:title', xml: dcBlock.find((s) => s.includes('<dc:title')) ?? '' })
  if (meta.author !== undefined)       fields.push({ tag: 'dc:creator', xml: dcBlock.find((s) => s.includes('<dc:creator')) ?? '' })
  if (meta.subject !== undefined)      fields.push({ tag: 'dc:description', xml: dcBlock.find((s) => s.includes('<dc:description')) ?? '' })
  if (meta.keywords !== undefined) {
    fields.push({ tag: 'dc:subject', xml: dcBlock.find((s) => s.includes('<dc:subject')) ?? '' })
    fields.push({ tag: 'pdf:Keywords', xml: pdfBlock.find((s) => s.includes('<pdf:Keywords')) ?? '' })
  }
  if (meta.producer !== undefined)     fields.push({ tag: 'pdf:Producer', xml: pdfBlock.find((s) => s.includes('<pdf:Producer')) ?? '' })
  if (meta.creator !== undefined)      fields.push({ tag: 'xmp:CreatorTool', xml: xmpBlock.find((s) => s.includes('<xmp:CreatorTool')) ?? '' })
  if (created)                         fields.push({ tag: 'xmp:CreateDate', xml: xmpBlock.find((s) => s.includes('<xmp:CreateDate')) ?? '' })
  if (modified)                        fields.push({ tag: 'xmp:ModifyDate', xml: xmpBlock.find((s) => s.includes('<xmp:ModifyDate')) ?? '' })
  if (xmpModified)                     fields.push({ tag: 'xmp:MetadataDate', xml: xmpBlock.find((s) => s.includes('<xmp:MetadataDate')) ?? '' })
  return regexReplaceXmpFields(existing, fields.filter((f) => f.xml))
}

export async function writeXmpCustomProps(bytes: Uint8Array, props: XmpCustomProp[]): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes)
  const catalog = doc.catalog
  // Preserve existing XMP + append our custom tags. If no /Metadata stream
  // exists we mint one.
  const metaRef = catalog.get(PDFName.of('Metadata'))
  let existingXml = ''
  if (metaRef) {
    const stream = doc.context.lookup(metaRef)
    if (stream instanceof PDFRawStream) {
      existingXml = new TextDecoder().decode(stream.getContents())
    }
  }
  const nextXml = rebuildXmpWithCustom(existingXml, props)
  const metaStream = doc.context.stream(nextXml, {
    Type: PDFName.of('Metadata'),
    Subtype: PDFName.of('XML'),
  })
  catalog.set(PDFName.of('Metadata'), doc.context.register(metaStream))
  return await doc.save()
}

function rebuildXmpWithCustom(existing: string, props: XmpCustomProp[]): string {
  // If no existing XMP, build a minimal skeleton and add our namespaces.
  if (!existing.trim()) {
    const nsDecls = groupByNs(props).map(([ns, prefix]) => `xmlns:${prefix}="${ns}"`).join(' ')
    const body = props.map(propToXml).join('\n    ')
    return `<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" ${nsDecls}>
    ${body}
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`
  }
  // Else splice new elements into the first rdf:Description. Strip any
  // existing custom props (by full-qualified name) first so re-saves
  // don't duplicate.
  try {
    const parsed = new DOMParser().parseFromString(existing, 'application/xml')
    const rdfDesc = parsed.getElementsByTagNameNS('http://www.w3.org/1999/02/22-rdf-syntax-ns#', 'Description')[0]
    if (!rdfDesc) return existing
    // Remove any user-custom children (anything not in our standard namespaces)
    const toRemove: Element[] = []
    for (const child of Array.from(rdfDesc.children)) {
      if (!isStandardField(child.namespaceURI ?? '', child.localName)) toRemove.push(child)
    }
    toRemove.forEach((el) => rdfDesc.removeChild(el))
    // Ensure xmlns:<prefix> is declared for each namespace we're adding
    for (const [ns, prefix] of groupByNs(props)) {
      if (!rdfDesc.getAttributeNS('http://www.w3.org/2000/xmlns/', prefix)) {
        rdfDesc.setAttributeNS('http://www.w3.org/2000/xmlns/', `xmlns:${prefix}`, ns)
      }
    }
    for (const p of props) {
      const el = parsed.createElementNS(p.namespace, `${p.prefix || nsPrefixFromUri(p.namespace)}:${p.name}`)
      el.textContent = p.value
      rdfDesc.appendChild(el)
    }
    return new XMLSerializer().serializeToString(parsed)
  } catch {
    return existing
  }
}

function groupByNs(props: XmpCustomProp[]): Array<[string, string]> {
  const seen = new Map<string, string>()
  for (const p of props) {
    if (!seen.has(p.namespace)) seen.set(p.namespace, p.prefix || nsPrefixFromUri(p.namespace))
  }
  return [...seen.entries()]
}

function nsPrefixFromUri(ns: string): string {
  // Last path segment or 'cx' fallback. Good-enough for uniqueness per
  // document; users can override by passing an explicit prefix.
  const m = ns.match(/([a-zA-Z][\w]*)\/?$/)
  return m ? m[1] : 'cx'
}

function propToXml(p: XmpCustomProp): string {
  const tag = `${p.prefix || nsPrefixFromUri(p.namespace)}:${p.name}`
  return `<${tag}>${xmlEscape(p.value)}</${tag}>`
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// ───────────────────────── OCG (Optional Content) ─────────────────────

export interface OcgInfo {
  id: string          // ref string like "42 0 R"
  name: string
  intent: string
  visible: boolean    // default-state from /OCProperties/D/ON|OFF
  locked: boolean     // in /OCProperties/D/Locked
}

export async function listOcgs(bytes: Uint8Array): Promise<OcgInfo[]> {
  const doc = await PDFDocument.load(bytes)
  const catalog = doc.catalog
  const ocProps = doc.context.lookup(catalog.get(PDFName.of('OCProperties')))
  if (!(ocProps instanceof PDFDict)) return []
  const ocgsArr = doc.context.lookup(ocProps.get(PDFName.of('OCGs')))
  const defaults = doc.context.lookup(ocProps.get(PDFName.of('D')))
  if (!(ocgsArr instanceof PDFArray)) return []
  const onArr = defaults instanceof PDFDict
    ? (doc.context.lookup(defaults.get(PDFName.of('ON'))) as PDFArray | undefined)
    : undefined
  const offArr = defaults instanceof PDFDict
    ? (doc.context.lookup(defaults.get(PDFName.of('OFF'))) as PDFArray | undefined)
    : undefined
  const lockedArr = defaults instanceof PDFDict
    ? (doc.context.lookup(defaults.get(PDFName.of('Locked'))) as PDFArray | undefined)
    : undefined

  const onSet = new Set<string>()
  const offSet = new Set<string>()
  const lockedSet = new Set<string>()
  onArr?.asArray().forEach((r) => onSet.add(r.toString()))
  offArr?.asArray().forEach((r) => offSet.add(r.toString()))
  lockedArr?.asArray().forEach((r) => lockedSet.add(r.toString()))

  const out: OcgInfo[] = []
  for (const entry of ocgsArr.asArray()) {
    const id = entry.toString()
    const dict = doc.context.lookup(entry)
    if (!(dict instanceof PDFDict)) continue
    const nameObj = dict.get(PDFName.of('Name'))
    const intentObj = dict.get(PDFName.of('Intent'))
    out.push({
      id,
      name: nameObj instanceof PDFString || nameObj instanceof PDFHexString
        ? nameObj.decodeText()
        : nameObj?.toString().replace(/^\(|\)$/g, '') ?? 'Unnamed',
      intent: intentObj?.toString() ?? 'View',
      visible: offSet.has(id) ? false : true,
      locked: lockedSet.has(id),
    })
  }
  return out
}

export async function setOcgVisibility(bytes: Uint8Array, id: string, visible: boolean): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes)
  const catalog = doc.catalog
  const ocProps = doc.context.lookup(catalog.get(PDFName.of('OCProperties')))
  if (!(ocProps instanceof PDFDict)) return bytes
  let defaults = doc.context.lookup(ocProps.get(PDFName.of('D')))
  if (!(defaults instanceof PDFDict)) {
    defaults = doc.context.obj({})
    ocProps.set(PDFName.of('D'), defaults as PDFDict)
  }
  const dd = defaults as PDFDict
  const ensureArr = (key: string): PDFArray => {
    let a = doc.context.lookup(dd.get(PDFName.of(key)))
    if (!(a instanceof PDFArray)) {
      a = doc.context.obj([])
      dd.set(PDFName.of(key), a as PDFArray)
    }
    return a as PDFArray
  }
  const onArr = ensureArr('ON')
  const offArr = ensureArr('OFF')
  const targetRef = refFromId(id, doc)
  if (!targetRef) return bytes
  // Remove targetRef from both arrays, then add it to the right one.
  pruneRef(onArr, id)
  pruneRef(offArr, id)
  ;(visible ? onArr : offArr).push(targetRef)
  return await doc.save()
}

function refFromId(id: string, doc: PDFDocument): PDFRef | undefined {
  const match = id.match(/^(\d+)\s+(\d+)\s+R$/)
  if (!match) return undefined
  // pdf-lib uses its own ref registry but PDFRef.of(objectNumber, generationNumber) works
  return PDFRef.of(Number(match[1]), Number(match[2]))
  void doc
}

function pruneRef(arr: PDFArray, id: string): void {
  const entries = arr.asArray().slice()
  arr.asArray().length = 0
  for (const e of entries) {
    if (e.toString() !== id) arr.push(e)
  }
}

// ───────────────────────── SPACE-USAGE AUDIT ───────────────────────────

export interface SpaceBucket {
  label: string         // "Image", "Font", "ContentStream", "Annot", "Other"
  filter: string        // "DCTDecode" | "FlateDecode" | ...
  count: number
  totalBytes: number
}

export interface SpaceAudit {
  buckets: SpaceBucket[]
  totalIndirectBytes: number
  totalBytes: number
}

export async function auditSpaceUsage(bytes: Uint8Array): Promise<SpaceAudit> {
  const doc = await PDFDocument.load(bytes)
  const map = new Map<string, SpaceBucket>()
  let totalIndirect = 0
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    let label = 'Other'
    let filter = 'None'
    if (obj instanceof PDFRawStream) {
      const dict = obj.dict
      const subtype = dict.get(PDFName.of('Subtype'))?.toString() ?? ''
      const type = dict.get(PDFName.of('Type'))?.toString() ?? ''
      filter = dict.get(PDFName.of('Filter'))?.toString().replace(/^\//, '') ?? 'None'
      if (subtype === '/Image') label = 'Image'
      else if (type === '/Font' || subtype === '/Font') label = 'Font'
      else if (type === '/Metadata' || subtype === '/Metadata') label = 'Metadata'
      else if (subtype === '/Form') label = 'XObject.Form'
      else if (type === '/XObject' || subtype === '/XObject') label = 'XObject'
      else if (dict.get(PDFName.of('Contents'))) label = 'ContentStream'
      else label = 'Stream'
      const contents = obj.getContents()
      totalIndirect += contents.byteLength
      const key = `${label}|${filter}`
      const bucket = map.get(key) ?? { label, filter, count: 0, totalBytes: 0 }
      bucket.count++
      bucket.totalBytes += contents.byteLength
      map.set(key, bucket)
    }
  }
  const buckets = [...map.values()].sort((a, b) => b.totalBytes - a.totalBytes)
  return {
    buckets,
    totalIndirectBytes: totalIndirect,
    totalBytes: bytes.byteLength,
  }
}

// ───────────────────────── INITIAL VIEW ──────────────────────────────

export type PageLayout = 'Default' | 'SinglePage' | 'OneColumn' | 'TwoColumnLeft' | 'TwoColumnRight' | 'TwoPageLeft' | 'TwoPageRight'
export type PageMode = 'Default' | 'UseNone' | 'UseOutlines' | 'UseThumbs' | 'FullScreen' | 'UseOC' | 'UseAttachments'

export interface InitialView {
  openAtPage: number    // 1-based; 1 = default
  pageLayout: PageLayout
  pageMode: PageMode
}

export async function readInitialView(bytes: Uint8Array): Promise<InitialView> {
  const doc = await PDFDocument.load(bytes)
  const catalog = doc.catalog
  const layout = catalog.get(PDFName.of('PageLayout'))?.toString().replace(/^\//, '') ?? 'Default'
  const mode = catalog.get(PDFName.of('PageMode'))?.toString().replace(/^\//, '') ?? 'Default'
  let page = 1
  const openAct = doc.context.lookup(catalog.get(PDFName.of('OpenAction')))
  if (openAct instanceof PDFArray) {
    // [<page ref> /Fit …]
    const ref = openAct.asArray()[0]
    for (let i = 0; i < doc.getPageCount(); i++) {
      if (doc.getPages()[i].ref.toString() === ref?.toString()) { page = i + 1; break }
    }
  }
  return {
    openAtPage: page,
    pageLayout: (layout as PageLayout) || 'Default',
    pageMode: (mode as PageMode) || 'Default',
  }
}

export async function writeInitialView(bytes: Uint8Array, view: InitialView): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes)
  const catalog = doc.catalog
  if (view.pageLayout && view.pageLayout !== 'Default') {
    catalog.set(PDFName.of('PageLayout'), PDFName.of(view.pageLayout))
  } else {
    try { catalog.delete(PDFName.of('PageLayout')) } catch { /* ignore */ }
  }
  if (view.pageMode && view.pageMode !== 'Default') {
    catalog.set(PDFName.of('PageMode'), PDFName.of(view.pageMode))
  } else {
    try { catalog.delete(PDFName.of('PageMode')) } catch { /* ignore */ }
  }
  const page = Math.max(1, Math.min(doc.getPageCount(), view.openAtPage)) - 1
  if (page > 0) {
    const targetPage = doc.getPages()[page]
    const ref = targetPage.ref
    // /XYZ left top zoom — left=0, top=page height (top-left corner),
    // zoom=null means "preserve the current zoom level". This is what
    // Acrobat writes when the user picks "open at page N" without
    // specifying a fit mode, and it survives most viewers cleanly.
    // null values are encoded as the PDF /null name, but pdf-lib's
    // PDFNumber works fine with concrete numbers — using 0 for zoom
    // means "use default" in practice across all major readers.
    const arr = doc.context.obj([
      ref,
      PDFName.of('XYZ'),
      0,
      targetPage.getHeight(),
      0,
    ])
    catalog.set(PDFName.of('OpenAction'), arr)
  } else {
    try { catalog.delete(PDFName.of('OpenAction')) } catch { /* ignore */ }
  }
  return await doc.save()
}

// Keep unused imports silenced (PDFNumber + PDFString + pdf-lib export).
void PDFNumber; void PDFString
