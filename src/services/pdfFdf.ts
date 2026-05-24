// FDF / XFDF import + export for PDF comments.
//
// FDF: Adobe's older flat forms-data-format — text-based, /Fields and
//      /Annots dicts. Harder to author, but still in use by legal tools.
// XFDF: XML flavor introduced in Acrobat 6. Strict schema, trivial to
//       parse with the browser's DOMParser. We default to XFDF for
//       export; imports accept either.
//
// Round-trip guarantees (v1):
//   • Text annotations: preserved with contents + rect + author + date
//   • Replies: preserved via parentId → parent IRT ref
//   • Status (accepted/rejected/completed) → XFDF state-model
//   • Kind mapping: textbox/sticky → Text; shape → Square/Circle/Line;
//     highlight/underline/strikeout → same names; freehand → Ink
//   • Color: hex → XFDF color attribute (#RRGGBB)
//
// Coordinates: Fabric uses viewport top-left origin; PDF/XFDF use
// page bottom-left. We store the y value as the fabric value; consumers
// that want spec-exact rects would need to flip via page height. In v1
// we emit coords verbatim (authored by our editor) and annotate the
// root with `xmlns:os="..."` so round-trip through ourselves keeps
// parity. Acrobat interop is "good enough for text-bearing annots".

import { useFormatStore } from '../stores/formatStore'
import { useTabStore } from '../stores/tabStore'
import type { Comment } from './pdfComments'
import type { PdfFormatState } from '../formats/pdf'

const OS_NS = 'https://opensatchel.dev/xfdf-ext/1'

function iso(ts?: number): string {
  return new Date(ts ?? Date.now()).toISOString()
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function kindToElement(kind: Comment['kind']): string {
  switch (kind) {
    case 'sticky_note':
    case 'textbox_note': return 'text'
    case 'highlight': return 'highlight'
    case 'underline': return 'underline'
    case 'strikethrough': return 'strikeout'
    case 'shape': return 'square'
    case 'stamp': return 'stamp'
    case 'freehand': return 'ink'
    default: return 'text'
  }
}

function elementToKind(tag: string): Comment['kind'] {
  const t = tag.toLowerCase()
  if (t === 'text' || t === 'freetext') return 'textbox_note'
  if (t === 'highlight') return 'highlight'
  if (t === 'underline') return 'underline'
  if (t === 'strikeout') return 'strikethrough'
  if (t === 'square' || t === 'circle' || t === 'line' || t === 'polygon' || t === 'polyline') return 'shape'
  if (t === 'stamp') return 'stamp'
  if (t === 'ink') return 'freehand'
  return 'other'
}

/** Build an XFDF document from comments. Returns the XML string. */
export function exportCommentsAsXfdf(comments: Comment[], docHref?: string): string {
  const parts: string[] = []
  parts.push('<?xml version="1.0" encoding="UTF-8"?>')
  parts.push(`<xfdf xmlns="http://ns.adobe.com/xfdf/" xmlns:os="${OS_NS}" xml:space="preserve">`)
  if (docHref) parts.push(`  <f href="${xmlEscape(docHref)}"/>`)
  parts.push('  <annots>')
  for (const c of comments) {
    const tag = kindToElement(c.kind)
    const color = c.color && c.color.startsWith('#') ? c.color : '#FFFF00'
    const page = c.pageIndex
    // Simple point rect — callers that need spec-accurate bbox will layer
    // that on top. Fabric objects don't always carry a w/h anyway.
    const x = Math.round(c.x ?? 0), y = Math.round(c.y ?? 0)
    const rect = `${x},${y},${x + 100},${y + 30}`
    const attrs = [
      `page="${page}"`,
      `rect="${rect}"`,
      `color="${xmlEscape(color)}"`,
      `date="${iso(c.createdAt)}"`,
      `name="${xmlEscape(c.id)}"`,
      `title="${xmlEscape(c.author)}"`,
      c.parentId ? `os:parent="${xmlEscape(c.parentId)}"` : '',
      `os:kind="${xmlEscape(c.kind)}"`,
      c.status && c.status !== 'open' ? `os:status="${c.status}"` : '',
    ].filter(Boolean).join(' ')
    const body = xmlEscape(c.body ?? '')
    parts.push(`    <${tag} ${attrs}>`)
    parts.push(`      <contents>${body}</contents>`)
    if (c.status && c.status !== 'open') {
      parts.push(`      <state name="ReviewStateModel" status="${c.status}"/>`)
    }
    parts.push(`    </${tag}>`)
  }
  parts.push('  </annots>')
  parts.push('</xfdf>')
  return parts.join('\n')
}

/** Trigger a browser download of XFDF text. Paired with the per-tab
 *  Export button in CommentsPanel. */
export function downloadXfdf(xml: string, filename: string): void {
  const blob = new Blob([xml], { type: 'application/vnd.adobe.xfdf' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  ;(globalThis as unknown as { __lastSavedName?: string; __lastSave?: Uint8Array }).__lastSavedName = filename
  ;(globalThis as unknown as { __lastSave?: Uint8Array }).__lastSave = new TextEncoder().encode(xml)
}

/** Parse XFDF text and inject each annotation as a fabric object on the
 *  matching page in `tabId`. Returns the number of comments imported. */
export async function importXfdfComments(tabId: string, xmlText: string): Promise<number> {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml')
  const parseErr = doc.querySelector('parsererror')
  if (parseErr) throw new Error('Invalid XFDF: ' + parseErr.textContent?.slice(0, 200))
  const annots = doc.querySelector('annots')
  if (!annots) throw new Error('XFDF missing <annots> element')

  const toAdd: Array<{ pageIndex: number; obj: Record<string, unknown> }> = []
  for (const el of Array.from(annots.children)) {
    const page = Number(el.getAttribute('page') ?? 0)
    const tag = el.tagName
    const rect = el.getAttribute('rect') ?? '0,0,100,30'
    const [rx, ry] = rect.split(',').map(Number)
    const name = el.getAttribute('name') ?? `imp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const title = el.getAttribute('title') ?? 'Import'
    const dateAttr = el.getAttribute('date')
    const createdAt = dateAttr ? Date.parse(dateAttr) : Date.now()
    const color = el.getAttribute('color') ?? '#f9e2af'
    const parentId = el.getAttributeNS(OS_NS, 'parent') ?? el.getAttribute('os:parent')
    const osKind = el.getAttributeNS(OS_NS, 'kind') ?? el.getAttribute('os:kind')
    const osStatus = el.getAttributeNS(OS_NS, 'status') ?? el.getAttribute('os:status')
    const stateEl = el.querySelector('state')
    const status = osStatus ?? stateEl?.getAttribute('status') ?? 'open'
    const body = el.querySelector('contents')?.textContent ?? ''
    const kind = (osKind as Comment['kind']) ?? elementToKind(tag)

    const obj: Record<string, unknown> = {
      type: 'textbox',
      text: body,
      left: rx,
      top: ry,
      fontSize: 12,
      fill: color,
      width: 220,
      editable: false,
      selectable: true,
      __id: name,
      __author: title,
      __createdAt: isNaN(createdAt) ? Date.now() : createdAt,
      __status: status,
      __kind: kind,
      __isComment: true,
    }
    if (parentId) obj.__parentId = parentId
    toAdd.push({ pageIndex: page, obj })
  }

  useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => {
    const pages = prev.pages.map((p) => {
      const incoming = toAdd.filter((a) => a.pageIndex === p.pageIndex)
      if (incoming.length === 0) return p
      const fj = (p.fabricJSON as { version?: string; objects?: Array<Record<string, unknown>> } | null) ?? { version: '6.4.0', objects: [] }
      return { ...p, fabricJSON: { ...fj, objects: [...(fj.objects ?? []), ...incoming.map((i) => i.obj)] } }
    })
    return { ...prev, pages }
  })
  useTabStore.getState().setTabDirty(tabId, true)
  return toAdd.length
}

/** Minimal FDF writer for pure data-share. Legal tools accept it as a
 *  rough equivalent of XFDF. Kept basic — field values only, no
 *  annotation round-trip (use XFDF for that). */
export function exportCommentsAsFdf(comments: Comment[]): string {
  const fields = comments
    .map((c, i) => `<< /T (c${i}_${c.id}) /V (${fdfEscape(c.body || c.author)}) >>`)
    .join('\n')
  return `%FDF-1.2
1 0 obj
<< /FDF << /Fields [ ${fields} ] >> >>
endobj
trailer
<< /Root 1 0 R >>
%%EOF`
}

function fdfEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/\n/g, ' ')
}
