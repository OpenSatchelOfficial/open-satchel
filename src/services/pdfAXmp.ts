// PDF/A XMP metadata packet builder.
//
// PDF/A REQUIRES an XMP metadata stream in the PDF catalog with
// profile-specific identifiers (pdfaid:part + pdfaid:conformance).
// veraPDF and Acrobat Preflight both key on these.
//
// Hand-rolled — XMP for PDF/A is a fixed template with five required
// namespaces (dc, pdf, xmp, xmpMM, pdfaid). Libraries are heavyweight
// (lxml-style baggage); ~150 LOC + inspectable beats a dep here.

export type PdfAProfile = 'A-1B' | 'A-2B' | 'A-2U' | 'A-3B' | 'A-3U'

export interface PdfMetadata {
  title?: string
  author?: string
  subject?: string
  /** Matches pdfOps.PdfMetadata — kept as a list for semantic accuracy.
   *  Joined with ", " for the XMP <pdf:Keywords> field. */
  keywords?: string[]
  creator?: string
  producer?: string
  creationDate?: Date
  modDate?: Date
}

interface ProfileSpec { part: 1 | 2 | 3; conformance: 'B' | 'U'; revision: string }

const PROFILES: Record<PdfAProfile, ProfileSpec> = {
  'A-1B': { part: 1, conformance: 'B', revision: '2005' },
  'A-2B': { part: 2, conformance: 'B', revision: '2011' },
  'A-2U': { part: 2, conformance: 'U', revision: '2011' },
  'A-3B': { part: 3, conformance: 'B', revision: '2012' },
  'A-3U': { part: 3, conformance: 'U', revision: '2012' },
}

// XML escape for text content (NOT for attribute values).
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// PDF/A requires ISO 8601 dates with timezone offset.
function iso8601(d: Date): string {
  const pad = (n: number, w = 2) => n.toString().padStart(w, '0')
  const tzMin = -d.getTimezoneOffset()
  const tzSign = tzMin >= 0 ? '+' : '-'
  const tzAbs = Math.abs(tzMin)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${tzSign}${pad(Math.floor(tzAbs / 60))}:${pad(tzAbs % 60)}`
  )
}

/**
 * Build a complete XMP packet for embedding in a PDF/A document's
 * /Metadata stream. Includes the required xpacket wrapper.
 */
export function buildPdfAXmp(meta: PdfMetadata, profile: PdfAProfile): string {
  const spec = PROFILES[profile]
  const now = new Date()
  const created = meta.creationDate ?? now
  const modified = meta.modDate ?? now
  const title = meta.title ?? ''
  const author = meta.author ?? ''
  const subject = meta.subject ?? ''
  const keywords = (meta.keywords && meta.keywords.length > 0) ? meta.keywords.join(', ') : ''
  const creator = meta.creator ?? 'Open Satchel'
  const producer = meta.producer ?? 'Open Satchel PDF/A Converter'

  // The xpacket wrapper is part of the XMP spec (ISO 16684-1) and PDF/A
  // explicitly requires it. The leading "begin" attr value MUST be the
  // U+FEFF BOM, but PDF spec also allows the empty string form many tools
  // emit. We use BOM for maximum tool compatibility.
  const bom = '\uFEFF'

  return [
    `<?xpacket begin="${bom}" id="W5M0MpCehiHzreSzNTczkc9d"?>`,
    `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Open Satchel ${spec.revision}">`,
    `  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">`,
    `    <rdf:Description rdf:about=""`,
    `        xmlns:dc="http://purl.org/dc/elements/1.1/"`,
    `        xmlns:pdf="http://ns.adobe.com/pdf/1.3/"`,
    `        xmlns:xmp="http://ns.adobe.com/xap/1.0/"`,
    `        xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/"`,
    `        xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">`,
    `      <dc:format>application/pdf</dc:format>`,
    title ? `      <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${esc(title)}</rdf:li></rdf:Alt></dc:title>` : '',
    author ? `      <dc:creator><rdf:Seq><rdf:li>${esc(author)}</rdf:li></rdf:Seq></dc:creator>` : '',
    subject ? `      <dc:description><rdf:Alt><rdf:li xml:lang="x-default">${esc(subject)}</rdf:li></rdf:Alt></dc:description>` : '',
    keywords ? `      <pdf:Keywords>${esc(keywords)}</pdf:Keywords>` : '',
    `      <pdf:Producer>${esc(producer)}</pdf:Producer>`,
    `      <xmp:CreatorTool>${esc(creator)}</xmp:CreatorTool>`,
    `      <xmp:CreateDate>${iso8601(created)}</xmp:CreateDate>`,
    `      <xmp:ModifyDate>${iso8601(modified)}</xmp:ModifyDate>`,
    `      <xmp:MetadataDate>${iso8601(now)}</xmp:MetadataDate>`,
    `      <xmpMM:DocumentID>uuid:${crypto.randomUUID()}</xmpMM:DocumentID>`,
    `      <xmpMM:InstanceID>uuid:${crypto.randomUUID()}</xmpMM:InstanceID>`,
    // pdfaid is THE marker veraPDF + Acrobat Preflight key on first.
    `      <pdfaid:part>${spec.part}</pdfaid:part>`,
    `      <pdfaid:conformance>${spec.conformance}</pdfaid:conformance>`,
    `    </rdf:Description>`,
    `  </rdf:RDF>`,
    `</x:xmpmeta>`,
    // The trailing xpacket end="w" means "writable" — leaves room for
    // post-hoc edits without rewriting the whole packet. Most tools
    // emit this. PDF/A doesn't care which form ("r" or "w").
    `<?xpacket end="w"?>`,
  ].filter(Boolean).join('\n')
}

/** Parse pdfaid:part + pdfaid:conformance from an XMP string. Returns
 *  null if not a PDF/A XMP packet. Used by validator.
 *
 *  G6: real-world XMP comes in multiple shapes. Photoshop, Acrobat, and
 *  the xmp-toolkit emit any of:
 *
 *    1. Element form (Open Satchel's own buildPdfAXmp default):
 *         <pdfaid:part>1</pdfaid:part>
 *         <pdfaid:conformance>B</pdfaid:conformance>
 *
 *    2. Attribute form on rdf:Description (common from xmp-toolkit
 *       and Acrobat 9+):
 *         <rdf:Description rdf:about=""
 *             xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"
 *             pdfaid:part="1" pdfaid:conformance="B">
 *
 *    3. Mixed across multiple rdf:Description blocks (Photoshop's
 *       per-namespace block style — one Description holds dc:*,
 *       another holds pdfaid:*).
 *
 *    4. Non-default prefix — XML lets the writer rebind the
 *       pdfaid namespace to ANY prefix (`xmlns:foo="...id/"` then
 *       `<foo:part>`). Rare but legal.
 *
 *  Strategy: detect the prefix bound to the pdfaid namespace URI,
 *  then match BOTH element and attribute forms with that prefix. Falls
 *  back to "pdfaid" when no explicit binding is found (the canonical
 *  prefix every reference XMP example uses).
 *
 *  Why regex not DOMParser: DOMParser hung on a real-world XMP body
 *  during the 2026-04-25 session — see pdfMisc.ts `regexReplaceXmpFields`
 *  for the broader avoid-DOMParser context. Regex stays linear-time
 *  and is easy to audit. */
export function parsePdfAIdentity(xmp: string): { part: number; conformance: string } | null {
  const PDFAID_NS = 'http://www.aiim.org/pdfa/ns/id/'
  // Find every prefix that's bound to the pdfaid namespace anywhere
  // in the packet — XML lets the writer redefine prefixes per element,
  // and well-formed Photoshop XMP often binds it twice. We try each
  // discovered prefix in turn so a `<foo:part>1</foo:part>` body
  // matches as long as `xmlns:foo="...id/"` exists somewhere.
  const prefixes = new Set<string>(['pdfaid'])
  const nsRe = /xmlns:([\w-]+)\s*=\s*["']http:\/\/www\.aiim\.org\/pdfa\/ns\/id\/["']/g
  for (let m = nsRe.exec(xmp); m !== null; m = nsRe.exec(xmp)) {
    prefixes.add(m[1])
  }

  let part: number | null = null
  let conformance: string | null = null

  for (const prefix of prefixes) {
    const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (part === null) {
      // Element form, with tolerant whitespace + optional attribute soup.
      const elM = xmp.match(new RegExp(`<${esc}:part\\b[^>]*>\\s*(\\d+)\\s*<\\/${esc}:part\\s*>`))
      // Attribute form on any element (typically rdf:Description).
      const attrM = xmp.match(new RegExp(`\\b${esc}:part\\s*=\\s*["'](\\d+)["']`))
      const v = elM?.[1] ?? attrM?.[1]
      if (v) part = parseInt(v, 10)
    }
    if (conformance === null) {
      const elM = xmp.match(new RegExp(`<${esc}:conformance\\b[^>]*>\\s*([A-Za-z])\\s*<\\/${esc}:conformance\\s*>`))
      const attrM = xmp.match(new RegExp(`\\b${esc}:conformance\\s*=\\s*["']([A-Za-z])["']`))
      const v = elM?.[1] ?? attrM?.[1]
      if (v) conformance = v.toUpperCase()
    }
    if (part !== null && conformance !== null) break
  }

  if (part === null || conformance === null) {
    void PDFAID_NS // exported semantic anchor; kept for grep-ability.
    return null
  }
  return { part, conformance }
}

export interface BasicXmpOptions {
  /** If true, include the pdfuaid:part=1 marker — required by
   *  PDF/UA-1 §5. pdfStructTree enables this when writing its Metadata
   *  stream since the whole point of that stream is PDF/UA conformance. */
  pdfUa1?: boolean
}

/**
 * Build a minimal XMP packet suitable for any PDF (PDF/UA, ordinary
 * tagged PDF). Same dc + pdf + xmp + xmpMM namespaces as buildPdfAXmp
 * but omits the pdfaid marker. Used by pdfStructTree when a Catalog
 * /Metadata entry is required but the doc isn't claimed as PDF/A.
 */
export function buildBasicXmp(meta: PdfMetadata, opts: BasicXmpOptions = {}): string {
  const now = new Date()
  const created = meta.creationDate ?? now
  const modified = meta.modDate ?? now
  const title = meta.title ?? ''
  const author = meta.author ?? ''
  const subject = meta.subject ?? ''
  const keywords = (meta.keywords && meta.keywords.length > 0) ? meta.keywords.join(', ') : ''
  const creator = meta.creator ?? 'Open Satchel'
  const producer = meta.producer ?? 'Open Satchel'
  const bom = '\uFEFF'
  return [
    `<?xpacket begin="${bom}" id="W5M0MpCehiHzreSzNTczkc9d"?>`,
    `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Open Satchel">`,
    `  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">`,
    `    <rdf:Description rdf:about=""`,
    `        xmlns:dc="http://purl.org/dc/elements/1.1/"`,
    `        xmlns:pdf="http://ns.adobe.com/pdf/1.3/"`,
    `        xmlns:xmp="http://ns.adobe.com/xap/1.0/"`,
    `        xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/"` +
      (opts.pdfUa1 ? '' : '>'),
    opts.pdfUa1 ? `        xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/">` : '',
    `      <dc:format>application/pdf</dc:format>`,
    title ? `      <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${esc(title)}</rdf:li></rdf:Alt></dc:title>` : '',
    author ? `      <dc:creator><rdf:Seq><rdf:li>${esc(author)}</rdf:li></rdf:Seq></dc:creator>` : '',
    subject ? `      <dc:description><rdf:Alt><rdf:li xml:lang="x-default">${esc(subject)}</rdf:li></rdf:Alt></dc:description>` : '',
    keywords ? `      <pdf:Keywords>${esc(keywords)}</pdf:Keywords>` : '',
    `      <pdf:Producer>${esc(producer)}</pdf:Producer>`,
    `      <xmp:CreatorTool>${esc(creator)}</xmp:CreatorTool>`,
    `      <xmp:CreateDate>${iso8601(created)}</xmp:CreateDate>`,
    `      <xmp:ModifyDate>${iso8601(modified)}</xmp:ModifyDate>`,
    `      <xmp:MetadataDate>${iso8601(now)}</xmp:MetadataDate>`,
    `      <xmpMM:DocumentID>uuid:${crypto.randomUUID()}</xmpMM:DocumentID>`,
    `      <xmpMM:InstanceID>uuid:${crypto.randomUUID()}</xmpMM:InstanceID>`,
    opts.pdfUa1 ? `      <pdfuaid:part>1</pdfuaid:part>` : '',
    `    </rdf:Description>`,
    `  </rdf:RDF>`,
    `</x:xmpmeta>`,
    `<?xpacket end="w"?>`,
  ].filter(Boolean).join('\n')
}
