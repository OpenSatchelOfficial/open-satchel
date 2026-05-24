// Comment enumeration + threading over Fabric annotations that the
// editor layer persists. Fabric stores each annotation as an object in
// `fabricJSON.objects[]` per-page with shape-specific fields (text,
// left, top, fill, ...). This service flattens them into a typed
// Comment list for the comment-list panel and summary-pdf generators.

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

function inferKind(obj: Record<string, unknown>): CommentKind {
  const kind = obj.__kind as string | undefined
  if (kind) return kind as CommentKind
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
      const body = (obj.text as string | undefined) ?? ''
      const author = (obj.__author as string | undefined) ?? 'You'
      const createdAt = (obj.__createdAt as number | undefined)
      const parentId = (obj.__parentId as string | undefined)
      const id = (obj.__id as string | undefined) ?? `${pageIndex}_${objectIndex}`
      const status = (obj.__status as Comment['status']) ?? 'open'
      const color = (obj.fill as string | undefined) ?? (obj.stroke as string | undefined)
      const x = (obj.left as number | undefined) ?? 0
      const y = (obj.top as number | undefined) ?? 0
      out.push({
        pageIndex, objectIndex, kind, author, body, createdAt, parentId, id,
        status, color, x, y, fabricType: obj.type as string | undefined,
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
