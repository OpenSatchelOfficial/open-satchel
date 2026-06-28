// Comment enumeration + threading over Fabric annotations that the
// editor layer persists. Fabric stores each annotation as an object in
// `fabricJSON.objects[]` per-page with shape-specific fields (text,
// left, top, fill, ...). Native PDF text annotations are imported into
// the same marker-object model so the comment-list panel has one source
// of truth.

import type { PdfFormatState, PdfPageState } from '../formats/pdf'

export type CommentKind =
  | 'textbox_note'  // TextBox annotation (free text)
  | 'sticky_note'   // Sticky note
  | 'highlight'
  | 'underline'
  | 'strikethrough'
  | 'shape'
  | 'stamp'
  | 'freehand'
  | 'other'

export interface Comment {
  pageIndex: number       // 0-based (visible-index)
  objectIndex: number     // index in page's fabricJSON.objects array
  kind: CommentKind
  /** Author text — populated when the Fabric object has a `__author`
   *  field (added by the annotation tools). Defaults to "You". */
  author: string
  /** Free-text body. Empty for pure-markup annotations like highlight. */
  body: string
  /** Creation timestamp (ms). When not recorded on the object we use
   *  the page-load time as a deterministic fallback. */
  createdAt?: number
  /** Thread membership. When set, this comment is a reply to the
   *  comment with id = parentId. */
  parentId?: string
  id: string
  /** Status set by reviewers. Mirrors Acrobat's comment workflow. */
  status?: 'open' | 'accepted' | 'rejected' | 'completed' | 'cancelled'
  /** Color shown for the comment chip in the list. Falls back to
   *  yellow for sticky notes, blue for text boxes, etc. */
  color?: string
  /** Position in PDF user-space for the jump-to anchor. */
  x?: number
  y?: number
  /** Object type as Fabric reports it, for debugging / future use. */
  fabricType?: string
}

export interface NativeStickyNoteSnapshot {
  id: string
  hadName: boolean
  rectPdf?: [number, number, number, number]
  contents?: string
  author?: string
}

export interface NativeStickyNoteImport {
  pageIndex: number
  object: Record<string, unknown>
  snapshot: NativeStickyNoteSnapshot
}

interface StoredCommentReply {
  id: string
  body: string
  author: string
  createdAt?: number
  status?: Comment['status']
}

const STICKY_NOTE_WIDTH = 184
const STICKY_NOTE_HEIGHT = 96
const STICKY_NOTE_SERIALIZED_WIDTH = STICKY_NOTE_WIDTH + 1
const STICKY_NOTE_SERIALIZED_HEIGHT = STICKY_NOTE_HEIGHT + 1
const STICKY_NOTE_PADDING_X = 10
const STICKY_NOTE_PADDING_TOP = 12
const STICKY_PREVIEW_MAX_LINES = 5
const STICKY_PREVIEW_MAX_CHARS = 27

function stickyPreviewText(contents: string): string {
  const trimmed = contents.trim()
  if (!trimmed) return 'Add a note...'
  const sourceLines = trimmed.split(/\r?\n/)
  const out: string[] = []
  let clipped = false

  const pushWrapped = (sourceLine: string) => {
    const words = sourceLine.trim().split(/\s+/).filter(Boolean)
    if (!words.length) {
      out.push('')
      return
    }

    let line = ''
    for (const word of words) {
      if (out.length >= STICKY_PREVIEW_MAX_LINES) { clipped = true; return }
      if (word.length > STICKY_PREVIEW_MAX_CHARS) {
        if (line) {
          out.push(line)
          line = ''
          if (out.length >= STICKY_PREVIEW_MAX_LINES) { clipped = true; return }
        }
        out.push(word.slice(0, STICKY_PREVIEW_MAX_CHARS))
        clipped = true
        continue
      }
      const next = line ? `${line} ${word}` : word
      if (next.length <= STICKY_PREVIEW_MAX_CHARS) {
        line = next
      } else {
        out.push(line)
        line = word
      }
    }
    if (line) out.push(line)
  }

  for (const sourceLine of sourceLines) {
    if (out.length >= STICKY_PREVIEW_MAX_LINES) { clipped = true; break }
    pushWrapped(sourceLine)
  }

  if (out.length > STICKY_PREVIEW_MAX_LINES) {
    out.length = STICKY_PREVIEW_MAX_LINES
    clipped = true
  }

  if (clipped && out.length > 0) {
    const lastIdx = out.length - 1
    const last = out[lastIdx].replace(/\s+$/g, '')
    const maxBody = Math.max(0, STICKY_PREVIEW_MAX_CHARS - 3)
    out[lastIdx] = `${last.slice(0, maxBody).replace(/\s+$/g, '')}...`
  }

  return out.join('\n')
}

function stickyPreviewHeight(preview: string): number {
  return Math.max(13, preview.split(/\r?\n/).length * 13.4)
}

function stickyAccentColor(noteColor: string): string {
  switch (noteColor.toLowerCase()) {
    case '#a6e3a1': return '#55a95a'
    case '#89b4fa': return '#3b73d9'
    case '#f38ba8': return '#c34865'
    case '#cba6f7': return '#8b5ed7'
    default: return '#d29b00'
  }
}

function inferKind(obj: Record<string, unknown>): CommentKind {
  const kind = obj.__kind as string | undefined
  if (kind) return kind as CommentKind
  if (obj.__isStickyNote) return 'sticky_note'
  const type = (obj.type as string | undefined)?.toLowerCase()
  const text = (obj.text as string | undefined) ?? ''
  if (type === 'textbox') {
    if (text.startsWith('💬') || obj.__isStickyNote) return 'sticky_note'
    return 'textbox_note'
  }
  if (type === 'path' || type === 'polyline') return 'freehand'
  if (type === 'rect' || type === 'circle' || type === 'ellipse' ||
      type === 'line' || type === 'triangle' || type === 'polygon') return 'shape'
  if (type === 'group') return 'stamp'
  if (type === 'image') return 'other'
  return 'other'
}

function extractBody(obj: Record<string, unknown>): string {
  if (typeof obj.__contents === 'string') return obj.__contents
  if (typeof obj.text === 'string') return obj.text
  const children = Array.isArray(obj.objects) ? obj.objects : []
  for (const child of children) {
    if (child && typeof child === 'object' && typeof (child as Record<string, unknown>).text === 'string') {
      return String((child as Record<string, unknown>).text)
    }
  }
  return ''
}

function decodePdfText(value: unknown): string {
  if (!value) return ''
  const maybe = value as { decodeText?: () => string; asString?: () => string; value?: () => string }
  try {
    if (typeof maybe.decodeText === 'function') return maybe.decodeText()
    if (typeof maybe.asString === 'function') return maybe.asString()
    if (typeof maybe.value === 'function') return maybe.value()
  } catch {
    return ''
  }
  return String(value).replace(/^\((.*)\)$/s, '$1')
}

function parsePdfDate(raw: string): number | undefined {
  if (!raw) return undefined
  const iso = raw.match(/^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/)
  if (!iso) {
    const parsed = Date.parse(raw)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  const [, y, mo = '01', d = '01', h = '00', mi = '00', s = '00'] = iso
  const parsed = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
  return Number.isFinite(parsed) ? parsed : undefined
}

function numberFromPdfObject(value: unknown): number | null {
  if (value == null) return null
  const maybe = value as { asNumber?: () => number; numberValue?: number }
  if (typeof maybe.asNumber === 'function') {
    const n = maybe.asNumber()
    return Number.isFinite(n) ? n : null
  }
  if (typeof maybe.numberValue === 'number') return maybe.numberValue
  const n = Number(String(value))
  return Number.isFinite(n) ? n : null
}

function colorArrayToHex(values: number[]): string {
  if (values.length < 3) return '#f9e2af'
  const toByte = (n: number) => Math.max(0, Math.min(255, Math.round(n * 255)))
  return `#${[values[0], values[1], values[2]]
    .map((n) => toByte(n).toString(16).padStart(2, '0'))
    .join('')}`
}

function makeImportedStickyMarker(args: {
  id: string
  left: number
  top: number
  body: string
  author: string
  createdAt?: number
  color: string
  snapshot: NativeStickyNoteSnapshot
  replies?: StoredCommentReply[]
}): Record<string, unknown> {
  const hasBody = args.body.trim().length > 0
  const preview = stickyPreviewText(args.body)
  return {
    type: 'Group',
    version: '6.9.1',
    originX: 'left',
    originY: 'top',
    left: args.left,
    top: args.top,
    width: STICKY_NOTE_SERIALIZED_WIDTH,
    height: STICKY_NOTE_SERIALIZED_HEIGHT,
    fill: 'rgb(0,0,0)',
    stroke: null,
    strokeWidth: 0,
    selectable: true,
    evented: true,
    hasControls: false,
    lockScalingX: true,
    lockScalingY: true,
    __isStickyNote: true,
    __nativeStickyMarker: true,
    __nativeStickyImported: true,
    __isComment: true,
    __kind: 'sticky_note',
    __id: args.id,
    __author: args.author,
    __createdAt: args.createdAt,
    __contents: args.body,
    __color: args.color,
    __nativeStickySnapshot: args.snapshot,
    ...(args.replies?.length ? { __replies: args.replies } : {}),
    objects: [
      {
        type: 'Rect',
        version: '6.9.1',
        originX: 'left',
        originY: 'top',
        left: -STICKY_NOTE_SERIALIZED_WIDTH / 2,
        top: -STICKY_NOTE_SERIALIZED_HEIGHT / 2,
        width: STICKY_NOTE_WIDTH,
        height: STICKY_NOTE_HEIGHT,
        fill: args.color,
        stroke: '#8a6d00',
        strokeWidth: 1,
        rx: 4,
        ry: 4,
        selectable: false,
        evented: false,
      },
      {
        type: 'Rect',
        version: '6.9.1',
        originX: 'left',
        originY: 'top',
        left: -STICKY_NOTE_SERIALIZED_WIDTH / 2,
        top: -STICKY_NOTE_SERIALIZED_HEIGHT / 2,
        width: STICKY_NOTE_WIDTH,
        height: 6,
        fill: stickyAccentColor(args.color),
        opacity: 0.85,
        selectable: false,
        evented: false,
      },
      {
        type: 'Text',
        version: '6.9.1',
        originX: 'left',
        originY: 'top',
        left: -STICKY_NOTE_SERIALIZED_WIDTH / 2 + STICKY_NOTE_PADDING_X,
        top: -STICKY_NOTE_SERIALIZED_HEIGHT / 2 + STICKY_NOTE_PADDING_TOP,
        height: stickyPreviewHeight(preview),
        fontSize: 11,
        fontWeight: 'normal',
        fontFamily: 'Arial',
        fontStyle: hasBody ? 'normal' : 'italic',
        lineHeight: 1.18,
        text: preview,
        fill: hasBody ? '#2f2500' : '#7a641d',
        selectable: false,
        evented: false,
      },
    ],
  }
}

export async function extractNativeStickyNoteImports(bytes: Uint8Array): Promise<NativeStickyNoteImport[]> {
  const { PDFDocument, PDFArray, PDFDict, PDFName } = await import('pdf-lib')
  const out: NativeStickyNoteImport[] = []
  let doc
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })
  } catch (err) {
    console.warn('[pdfComments] native sticky-note import skipped:', err)
    return out
  }

  for (let pageIndex = 0; pageIndex < doc.getPageCount(); pageIndex++) {
    const page = doc.getPage(pageIndex)
    const annots = page.node.lookup(PDFName.of('Annots'), PDFArray)
    if (!annots) continue
    const pageHeight = page.getHeight()

    const textAnnots: Array<{
      refKey: string
      replyToRefKey: string
      rect: [number, number, number, number]
      body: string
      author: string
      modified: string
      nm: string
      id: string
      color: string
    }> = []

    for (let i = 0; i < annots.size(); i++) {
      const refKey = String(annots.get(i) ?? '')
      const annot = annots.lookup(i, PDFDict)
      if (!annot) continue
      const subtype = annot.get(PDFName.of('Subtype'))?.toString()
      if (subtype !== '/Text') continue

      const rectArray = annot.lookup(PDFName.of('Rect'), PDFArray)
      if (!rectArray || rectArray.size() < 4) continue
      const rect = [0, 1, 2, 3].map((idx) => numberFromPdfObject(rectArray.lookup(idx)))
      if (rect.some((n) => n == null)) continue
      const [x1, y1, x2, y2] = rect as [number, number, number, number]

      const body = decodePdfText(annot.get(PDFName.of('Contents')))
      const author = decodePdfText(annot.get(PDFName.of('T'))) || 'Unknown'
      const modified = decodePdfText(annot.get(PDFName.of('M')))
      const nm = decodePdfText(annot.get(PDFName.of('NM')))
      const replyToRefKey = String(annot.get(PDFName.of('IRT')) ?? '')
      const id = nm || `sticky_native_${pageIndex}_${i}_${Math.round(x1)}_${Math.round(y1)}`

      const colorArray = annot.lookup(PDFName.of('C'), PDFArray)
      const colorValues: number[] = []
      if (colorArray) {
        for (let ci = 0; ci < colorArray.size(); ci++) {
          const n = numberFromPdfObject(colorArray.lookup(ci))
          if (n != null) colorValues.push(n)
        }
      }
      const color = colorArrayToHex(colorValues)
      textAnnots.push({
        refKey,
        replyToRefKey,
        rect: [x1, y1, x2, y2],
        body,
        author,
        modified,
        nm,
        id,
        color,
      })
    }

    const repliesByParentRef = new Map<string, StoredCommentReply[]>()
    textAnnots.forEach((entry, idx) => {
      if (!entry.replyToRefKey) return
      const replies = repliesByParentRef.get(entry.replyToRefKey) ?? []
      replies.push({
        id: entry.nm || `${entry.replyToRefKey}_reply_${idx}`,
        body: entry.body,
        author: entry.author,
        createdAt: parsePdfDate(entry.modified),
        status: 'open',
      })
      repliesByParentRef.set(entry.replyToRefKey, replies)
    })

    for (const entry of textAnnots) {
      if (entry.replyToRefKey) continue
      const snapshot: NativeStickyNoteSnapshot = {
        id: entry.id,
        hadName: !!entry.nm,
        rectPdf: entry.rect,
        contents: entry.body,
        author: entry.author,
      }
      const [x1, , , y2] = entry.rect

      out.push({
        pageIndex,
        snapshot,
        object: makeImportedStickyMarker({
          id: entry.id,
          left: x1,
          top: pageHeight - y2,
          body: entry.body,
          author: entry.author,
          createdAt: parsePdfDate(entry.modified),
          color: entry.color,
          snapshot,
          replies: repliesByParentRef.get(entry.refKey) ?? [],
        }),
      })
    }
  }
  return out
}

export function listComments(state: PdfFormatState): Comment[] {
  const out: Comment[] = []
  state.pages.forEach((page: PdfPageState, pageIndex: number) => {
    if (page.deleted) return
    const fj = page.fabricJSON as { objects?: Array<Record<string, unknown>> } | null
    const objs = fj?.objects ?? []
    objs.forEach((obj, objectIndex) => {
      const kind = inferKind(obj)
      // Skip things that aren't really user-intelligible comments.
      if (kind === 'other' && !obj.__isComment) return
      const body = extractBody(obj)
      const author = (obj.__author as string | undefined) ?? 'You'
      const createdAt = (obj.__createdAt as number | undefined)
      const parentId = (obj.__parentId as string | undefined)
      const id = (obj.__id as string | undefined) ?? `${pageIndex}_${objectIndex}`
      const status = (obj.__status as Comment['status']) ?? 'open'
      const color = (obj.__color as string | undefined) ??
        (obj.fill as string | undefined) ??
        (obj.stroke as string | undefined)
      const x = (obj.left as number | undefined) ?? 0
      const y = (obj.top as number | undefined) ?? 0
      out.push({
        pageIndex, objectIndex, kind, author, body, createdAt, parentId, id,
        status, color, x, y, fabricType: obj.type as string | undefined,
      })
      const replies = Array.isArray(obj.__replies) ? obj.__replies as StoredCommentReply[] : []
      replies.forEach((reply, replyIndex) => {
        out.push({
          pageIndex,
          objectIndex,
          kind: 'textbox_note',
          author: reply.author || 'You',
          body: reply.body || '',
          createdAt: reply.createdAt,
          parentId: id,
          id: reply.id || `${id}_reply_${replyIndex}`,
          status: reply.status ?? 'open',
          color,
          x,
          y,
          fabricType: 'comment_reply',
        })
      })
    })
  })
  return out
}

/** Group comments into threads keyed by root id. Replies become
 *  children of their parent. Returns ordered list of thread roots
 *  with nested `replies` arrays. */
export interface CommentThread {
  root: Comment
  replies: Comment[]
}

export function groupIntoThreads(comments: Comment[]): CommentThread[] {
  const byId = new Map<string, Comment>()
  for (const c of comments) byId.set(c.id, c)
  const threads = new Map<string, CommentThread>()
  for (const c of comments) {
    if (c.parentId && byId.has(c.parentId)) continue // reply, handled below
    threads.set(c.id, { root: c, replies: [] })
  }
  for (const c of comments) {
    if (!c.parentId) continue
    // Walk up to root
    let curId = c.parentId
    let hops = 0
    while (hops < 100) {
      const parent = byId.get(curId)
      if (!parent) break
      if (!parent.parentId || !byId.has(parent.parentId)) {
        const t = threads.get(curId)
        if (t) t.replies.push(c)
        break
      }
      curId = parent.parentId
      hops++
    }
  }
  return [...threads.values()].sort((a, b) => {
    if (a.root.pageIndex !== b.root.pageIndex) return a.root.pageIndex - b.root.pageIndex
    return (a.root.createdAt ?? 0) - (b.root.createdAt ?? 0)
  })
}

/** Summary of comments for the right-rail panel badge. */
export function summarizeComments(comments: Comment[]): {
  total: number
  byPage: Map<number, number>
  byAuthor: Map<string, number>
  byStatus: Record<NonNullable<Comment['status']>, number>
} {
  const byPage = new Map<number, number>()
  const byAuthor = new Map<string, number>()
  const byStatus: Record<NonNullable<Comment['status']>, number> = {
    open: 0, accepted: 0, rejected: 0, completed: 0, cancelled: 0,
  }
  for (const c of comments) {
    byPage.set(c.pageIndex, (byPage.get(c.pageIndex) ?? 0) + 1)
    byAuthor.set(c.author, (byAuthor.get(c.author) ?? 0) + 1)
    byStatus[c.status ?? 'open']++
  }
  return { total: comments.length, byPage, byAuthor, byStatus }
}

// ── Comment summary PDF ────────────────────────────────────────────

/** Generate a standalone PDF listing every comment with its page
 *  reference, author, kind, status, and body. Matches Acrobat's
 *  "Print comments summary" output. */
export async function generateCommentsSummaryPdf(
  comments: Comment[],
  docTitle = 'Document',
): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold)

  const pageW = 612, pageH = 792
  const margin = 50
  const lineHeight = 14

  let page = doc.addPage([pageW, pageH])
  let y = pageH - margin

  const ensureRoom = (rows = 1) => {
    if (y - rows * lineHeight < margin + 20) {
      page = doc.addPage([pageW, pageH])
      y = pageH - margin
    }
  }

  page.drawText('Comments Summary', { x: margin, y, size: 18, font: fontBold })
  y -= 24
  page.drawText(docTitle, { x: margin, y, size: 11, font, color: rgb(0.35, 0.35, 0.35) })
  y -= 16
  page.drawText(`Generated ${new Date().toLocaleString()} · ${comments.length} comment${comments.length === 1 ? '' : 's'}`, {
    x: margin, y, size: 9, font, color: rgb(0.5, 0.5, 0.5),
  })
  y -= 24

  const sorted = [...comments].sort((a, b) =>
    a.pageIndex - b.pageIndex || (a.createdAt ?? 0) - (b.createdAt ?? 0),
  )
  let curPage = -1
  for (const c of sorted) {
    if (c.pageIndex !== curPage) {
      curPage = c.pageIndex
      ensureRoom(2)
      page.drawText(`Page ${curPage + 1}`, { x: margin, y, size: 13, font: fontBold, color: rgb(0.2, 0.2, 0.2) })
      y -= 18
    }
    ensureRoom(3)
    const header = `${c.author} · ${c.kind}${c.status && c.status !== 'open' ? ` · ${c.status}` : ''}`
    page.drawText(header, { x: margin, y, size: 9, font: fontBold, color: rgb(0.3, 0.3, 0.6) })
    y -= 12
    const body = c.body || `(${c.kind} with no text)`
    // Wrap at ~80 chars
    const MAX = 85
    const lines: string[] = []
    for (const ln of body.split(/\r?\n/)) {
      if (ln.length <= MAX) lines.push(ln)
      else {
        for (let i = 0; i < ln.length; i += MAX) lines.push(ln.slice(i, i + MAX))
      }
    }
    for (const ln of lines) {
      ensureRoom(1)
      page.drawText(ln, { x: margin + 12, y, size: 10, font, color: rgb(0.15, 0.15, 0.15) })
      y -= lineHeight
    }
    y -= 6
  }

  return await doc.save()
}

/** CSV export of the comment list. Columns: Page, Author, Kind,
 *  Status, Created (ISO), Body. Body is double-quote escaped per
 *  RFC 4180 — embedded quotes become "" and embedded newlines stay
 *  inside the quoted field. Excel + LibreOffice + Numbers all
 *  parse this dialect natively.
 *
 *  Acrobat parity: matches the "Comments → Summarize Comments →
 *  CSV" path that legal review workflows use to file comments
 *  alongside the document. */
export function exportCommentsAsCsv(comments: Comment[]): string {
  const rows: string[] = []
  rows.push(['Page', 'Author', 'Kind', 'Status', 'Created', 'Body'].join(','))
  const sorted = [...comments].sort(
    (a, b) => a.pageIndex - b.pageIndex || (a.createdAt ?? 0) - (b.createdAt ?? 0),
  )
  for (const c of sorted) {
    const created = c.createdAt ? new Date(c.createdAt).toISOString() : ''
    rows.push(
      [
        String(c.pageIndex + 1),
        csvEscape(c.author),
        csvEscape(c.kind),
        csvEscape(c.status ?? 'open'),
        csvEscape(created),
        csvEscape(c.body),
      ].join(','),
    )
  }
  return rows.join('\r\n')
}

function csvEscape(s: string): string {
  if (s == null) return ''
  // Quote if the cell contains a comma, quote, CR, or LF.
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

/** RTF export of the comment list. Word, LibreOffice, and Pages all
 *  open RTF natively, and a CSV-like table can be embedded as plain
 *  paragraphs (one per comment) with bold author + page header.
 *  Lighter than DOCX (no XML packaging dance) and richer than CSV. */
export function exportCommentsAsRtf(comments: Comment[], docTitle = 'Document'): string {
  const sorted = [...comments].sort(
    (a, b) => a.pageIndex - b.pageIndex || (a.createdAt ?? 0) - (b.createdAt ?? 0),
  )
  const parts: string[] = []
  // Header
  parts.push('{\\rtf1\\ansi\\ansicpg1252\\deff0')
  parts.push('{\\fonttbl{\\f0 Calibri;}}')
  parts.push('{\\info{\\title ' + rtfEscape(`Comments Summary — ${docTitle}`) + '}}')
  parts.push('\\fs28\\b ' + rtfEscape('Comments Summary') + '\\b0\\fs24\\par')
  parts.push('\\fs20 ' + rtfEscape(docTitle) + '\\par')
  parts.push(
    '\\fs18 ' +
      rtfEscape(
        `Generated ${new Date().toLocaleString()} — ${sorted.length} comment${sorted.length === 1 ? '' : 's'}`,
      ) +
      '\\par\\par',
  )

  let curPage = -1
  for (const c of sorted) {
    if (c.pageIndex !== curPage) {
      curPage = c.pageIndex
      parts.push('\\fs24\\b ' + rtfEscape(`Page ${curPage + 1}`) + '\\b0\\fs20\\par')
    }
    const status = c.status && c.status !== 'open' ? ` · ${c.status}` : ''
    parts.push(
      '\\fs18\\b ' +
        rtfEscape(`${c.author} · ${c.kind}${status}`) +
        '\\b0\\par ' +
        rtfEscape(c.body || `(${c.kind} with no text)`) +
        '\\par\\par',
    )
  }

  parts.push('}')
  return parts.join('\n')
}

/** JSON export of the comment list. Pure structured-data dump —
 *  Comment shape preserved verbatim minus the internal objectIndex
 *  (an implementation detail that's not stable across saves).
 *  Use when piping comments into another tool's import (Acrobat
 *  XFDF for Acrobat-target; this for everything else). */
export function exportCommentsAsJson(comments: Comment[]): string {
  const sorted = [...comments].sort(
    (a, b) => a.pageIndex - b.pageIndex || (a.createdAt ?? 0) - (b.createdAt ?? 0),
  )
  // Strip objectIndex from the wire shape — it's a transient pointer
  // into the fabric layer that doesn't survive save/reload.
  const clean = sorted.map(({ objectIndex: _ignored, ...rest }) => rest)
  return JSON.stringify(
    {
      generated: new Date().toISOString(),
      count: clean.length,
      comments: clean,
    },
    null,
    2,
  )
}

function rtfEscape(s: string): string {
  if (s == null) return ''
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    // Non-ASCII → \uN ? hex escape (RTF 1.x Unicode escape).
    // Use a substitution char (?) so older readers degrade gracefully.
    .replace(/[-￿]/g, (ch) => `\\u${ch.charCodeAt(0)}?`)
    // Actual newlines → \par paragraph breaks; CR ignored.
    .replace(/\r/g, '')
    .replace(/\n/g, '\\par ')
}
