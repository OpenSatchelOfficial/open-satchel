import { useMemo, useState } from 'react'
import { useFormatStore } from '../../stores/formatStore'
import { useUIStore } from '../../stores/uiStore'
import { useTabStore } from '../../stores/tabStore'
import type { PdfFormatState } from './index'
import { listComments, groupIntoThreads, generateCommentsSummaryPdf, exportCommentsAsCsv, exportCommentsAsRtf, exportCommentsAsJson, type Comment } from '../../services/pdfComments'
import { exportCommentsAsXfdf, downloadXfdf, importXfdfComments } from '../../services/pdfFdf'

interface Props {
  tabId: string
}

type SortKey = 'page' | 'author' | 'status'

/** Right-rail comments panel — enumerates every annotation with
 *  author + body + jump-to-page button. Mirrors Acrobat's comment
 *  list. Sort + filter + "Summarize to PDF" action. */
export default function CommentsPanel({ tabId }: Props) {
  const state = useFormatStore((s) => s.data[tabId] as PdfFormatState | undefined)
  const setCurrentPage = useUIStore((s) => s.setCurrentPage)
  const [sort, setSort] = useState<SortKey>('page')
  const [authorFilter, setAuthorFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | NonNullable<Comment['status']>>('all')
  const [status, setStatus] = useState('')
  const [replyingTo, setReplyingTo] = useState<string | null>(null)
  const [replyText, setReplyText] = useState('')

  const all = useMemo(() => state ? listComments(state) : [], [state])
  const filtered = useMemo(() => {
    let list = all
    if (authorFilter) list = list.filter((c) => c.author.toLowerCase().includes(authorFilter.toLowerCase()))
    if (statusFilter !== 'all') list = list.filter((c) => (c.status ?? 'open') === statusFilter)
    const cmp = (a: Comment, b: Comment): number => {
      if (sort === 'page') return a.pageIndex - b.pageIndex || (a.createdAt ?? 0) - (b.createdAt ?? 0)
      if (sort === 'author') return a.author.localeCompare(b.author)
      if (sort === 'status') return (a.status ?? 'open').localeCompare(b.status ?? 'open')
      return 0
    }
    return [...list].sort(cmp)
  }, [all, sort, authorFilter, statusFilter])

  const threads = useMemo(() => groupIntoThreads(filtered), [filtered])

  if (!state) return null

  const jumpTo = (c: Comment) => {
    const visible = state.pages.filter((p) => !p.deleted)
    const idx = visible.findIndex((_, i) => i === c.pageIndex)
    // c.pageIndex is already the visible-index since listComments iterates visible pages only
    if (c.pageIndex < visible.length) {
      setCurrentPage(c.pageIndex)
      const el = document.querySelector(`[data-page-display-index="${c.pageIndex}"]`) as HTMLElement | null
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
    void idx
  }

  const exportSummary = async () => {
    setStatus('Building summary…')
    try {
      const pdf = await generateCommentsSummaryPdf(filtered, `Comments from tab ${tabId}`)
      const name = `comments-${Date.now()}.pdf`
      ;(globalThis as unknown as { __lastSavedName?: string }).__lastSavedName = name
      const ok = await window.api.file.saveAs(pdf)
      setStatus(ok ? `Saved ${name}.` : 'Save cancelled.')
    } catch (e) {
      setStatus(e instanceof Error ? `Error: ${e.message}` : 'Failed')
    }
  }

  const exportCsv = () => {
    setStatus('Exporting CSV…')
    try {
      const csv = exportCommentsAsCsv(filtered)
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `comments-${Date.now()}.csv`
      a.click()
      URL.revokeObjectURL(url)
      setStatus('CSV download triggered.')
    } catch (e) {
      setStatus(e instanceof Error ? `Error: ${e.message}` : 'Failed')
    }
  }

  const exportJson = () => {
    setStatus('Exporting JSON…')
    try {
      const json = exportCommentsAsJson(filtered)
      const blob = new Blob([json], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `comments-${Date.now()}.json`
      a.click()
      URL.revokeObjectURL(url)
      setStatus('JSON download triggered.')
    } catch (e) {
      setStatus(e instanceof Error ? `Error: ${e.message}` : 'Failed')
    }
  }

  const exportRtf = () => {
    setStatus('Exporting RTF…')
    try {
      const rtf = exportCommentsAsRtf(filtered, `tab-${tabId}`)
      const blob = new Blob([rtf], { type: 'application/rtf' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `comments-${Date.now()}.rtf`
      a.click()
      URL.revokeObjectURL(url)
      setStatus('RTF download triggered.')
    } catch (e) {
      setStatus(e instanceof Error ? `Error: ${e.message}` : 'Failed')
    }
  }

  const exportXfdf = async () => {
    setStatus('Exporting XFDF…')
    try {
      const xfdf = exportCommentsAsXfdf(filtered, `tab-${tabId}`)
      downloadXfdf(xfdf, `comments-${Date.now()}.xfdf`)
      setStatus('XFDF download triggered.')
    } catch (e) {
      setStatus(e instanceof Error ? `Error: ${e.message}` : 'Failed')
    }
  }

  const importXfdf = async () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.xfdf,.fdf,application/vnd.adobe.xfdf,application/vnd.fdf,text/xml'
    input.onchange = async () => {
      const f = input.files?.[0]
      if (!f) return
      setStatus(`Importing ${f.name}…`)
      try {
        const text = new TextDecoder().decode(new Uint8Array(await f.arrayBuffer()))
        const added = await importXfdfComments(tabId, text)
        setStatus(`Imported ${added} comment(s).`)
      } catch (e) {
        setStatus(e instanceof Error ? `Import failed: ${e.message}` : 'Import failed')
      }
    }
    input.click()
  }

  /** Update a comment's __status on the underlying Fabric object. */
  const setCommentStatus = (c: Comment, nextStatus: NonNullable<Comment['status']>) => {
    useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => {
      const pages = prev.pages.map((p) => {
        if (p.pageIndex !== c.pageIndex && !((prev.pages.filter((pp) => !pp.deleted)[c.pageIndex]?.pageIndex === p.pageIndex))) return p
        const fj = p.fabricJSON as { objects?: Array<Record<string, unknown>> } | null
        if (!fj?.objects) return p
        const nextObjs = fj.objects.map((obj, idx) => {
          if (idx !== c.objectIndex) return obj
          return { ...obj, __status: nextStatus }
        })
        return { ...p, fabricJSON: { ...fj, objects: nextObjs } }
      })
      return { ...prev, pages }
    })
    useTabStore.getState().setTabDirty(tabId, true)
  }

  /** Commit a reply as a new text-bearing fabric object on the same page,
   *  linked via __parentId to the thread root. */
  const commitReply = (root: Comment) => {
    if (!replyText.trim()) { setReplyingTo(null); setReplyText(''); return }
    const replyObj = {
      type: 'textbox',
      text: replyText,
      left: (root.x ?? 20) + 20,
      top: (root.y ?? 20) + 20,
      fontSize: 12,
      fill: root.color ?? '#89b4fa',
      width: 200,
      editable: false,
      selectable: true,
      __author: 'You',
      __createdAt: Date.now(),
      __id: `reply_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      __parentId: root.id,
      __kind: 'textbox_note',
      __isComment: true,
    }
    useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => {
      const visible = prev.pages.filter((p) => !p.deleted)
      const actualPage = visible[root.pageIndex]
      if (!actualPage) return prev
      const pages = prev.pages.map((p) => {
        if (p.pageIndex !== actualPage.pageIndex) return p
        const fj = (p.fabricJSON as { version?: string; objects?: Array<Record<string, unknown>> } | null) ?? { version: '6.4.0', objects: [] }
        return { ...p, fabricJSON: { ...fj, objects: [...(fj.objects ?? []), replyObj] } }
      })
      return { ...prev, pages }
    })
    useTabStore.getState().setTabDirty(tabId, true)
    setReplyingTo(null)
    setReplyText('')
  }

  const authors = [...new Set(all.map((c) => c.author))]

  return (
    <div data-testid="comments-panel" style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      background: 'var(--bg-primary)', borderLeft: '1px solid var(--border)',
      minWidth: 260, padding: 6, gap: 4,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
          Comments ({filtered.length}{all.length !== filtered.length ? ` of ${all.length}` : ''})
        </span>
      </div>

      <div style={{ display: 'flex', gap: 4, fontSize: 10 }}>
        <select data-testid="cmt-sort" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}
          style={selStyle}>
          <option value="page">Page</option>
          <option value="author">Author</option>
          <option value="status">Status</option>
        </select>
        <select data-testid="cmt-status-filter" value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
          style={selStyle}>
          <option value="all">All</option>
          <option value="open">Open</option>
          <option value="accepted">Accepted</option>
          <option value="rejected">Rejected</option>
          <option value="completed">Completed</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </div>

      {authors.length > 1 && (
        <input data-testid="cmt-author-filter" placeholder="Filter by author…"
          value={authorFilter} onChange={(e) => setAuthorFilter(e.target.value)}
          style={{
            padding: '4px 6px', fontSize: 10,
            background: 'var(--bg-surface)', border: '1px solid var(--border)',
            color: 'var(--text-primary)', borderRadius: 3,
          }} />
      )}

      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 3 }}>
        {threads.length === 0 ? (
          <div style={{ padding: 20, fontSize: 10, color: 'var(--text-muted)', textAlign: 'center' }}>
            No comments{all.length > 0 ? ' match the filters' : ''}.
          </div>
        ) : (
          threads.map((t, i) => (
            <div key={t.root.id} data-testid={`cmt-thread-${i}`}
              style={{
                padding: 6, borderRadius: 3,
                background: 'var(--bg-surface)', border: '1px solid var(--border)',
              }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 }}>
                <button data-testid={`cmt-jump-${i}`} onClick={() => jumpTo(t.root)}
                  style={{
                    padding: '2px 5px', fontSize: 9, borderRadius: 2,
                    background: 'var(--bg-primary)', color: 'var(--text-primary)',
                    border: '1px solid var(--border)', cursor: 'pointer',
                  }}
                  title="Jump to comment">p{t.root.pageIndex + 1}</button>
                <span style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                  {t.root.kind}
                </span>
                <span style={{ flex: 1, fontSize: 10, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t.root.author}
                </span>
                <select
                  data-testid={`cmt-status-${i}`}
                  value={t.root.status ?? 'open'}
                  onChange={(e) => setCommentStatus(t.root, e.target.value as NonNullable<Comment['status']>)}
                  title="Comment status"
                  style={{
                    fontSize: 8, padding: '1px 2px', borderRadius: 2,
                    background: t.root.status === 'accepted' ? 'rgba(80,200,120,0.25)'
                      : t.root.status === 'rejected' ? 'rgba(240,80,100,0.25)'
                      : t.root.status === 'completed' ? 'rgba(80,160,220,0.25)'
                      : t.root.status === 'cancelled' ? 'rgba(200,200,200,0.25)'
                      : 'var(--bg-surface)',
                    color: 'var(--text-primary)', textTransform: 'uppercase',
                    border: '1px solid var(--border)',
                  }}
                >
                  <option value="open">Open</option>
                  <option value="accepted">Accepted</option>
                  <option value="rejected">Rejected</option>
                  <option value="completed">Completed</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </div>
              {t.root.body && (
                <div style={{
                  fontSize: 10, color: 'var(--text-primary)',
                  maxHeight: 60, overflow: 'hidden', textOverflow: 'ellipsis',
                  whiteSpace: 'pre-wrap',
                }}>{t.root.body}</div>
              )}
              {t.replies.length > 0 && (
                <div style={{ marginTop: 4, paddingLeft: 10, borderLeft: '2px solid var(--border)' }}>
                  {t.replies.map((r, ri) => (
                    <div key={r.id} data-testid={`cmt-reply-${i}-${ri}`}
                      style={{ fontSize: 9, color: 'var(--text-secondary)', marginBottom: 2 }}>
                      <strong style={{ color: 'var(--text-primary)' }}>{r.author}:</strong> {r.body}
                    </div>
                  ))}
                </div>
              )}
              {replyingTo === t.root.id ? (
                <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <textarea
                    data-testid={`cmt-reply-input-${i}`}
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    placeholder="Reply…"
                    autoFocus
                    style={{ width: '100%', minHeight: 42, fontSize: 10, padding: '3px 5px', fontFamily: 'inherit', background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 2 }}
                  />
                  <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                    <button onClick={() => { setReplyingTo(null); setReplyText('') }}
                      style={{ padding: '2px 6px', fontSize: 9 }}>Cancel</button>
                    <button onClick={() => commitReply(t.root)}
                      disabled={!replyText.trim()}
                      data-testid={`cmt-reply-commit-${i}`}
                      style={{ padding: '2px 8px', fontSize: 9, background: 'var(--accent)', color: 'var(--bg-primary)', border: 'none', borderRadius: 2, cursor: replyText.trim() ? 'pointer' : 'not-allowed', fontWeight: 600 }}>
                      Post
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  data-testid={`cmt-reply-btn-${i}`}
                  onClick={() => { setReplyingTo(t.root.id); setReplyText('') }}
                  style={{ marginTop: 3, padding: '2px 6px', fontSize: 9, background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-secondary)', borderRadius: 2, cursor: 'pointer', alignSelf: 'flex-start' }}>
                  Reply
                </button>
              )}
            </div>
          ))
        )}
      </div>

      {status && (
        <div data-testid="cmt-status" style={{
          fontSize: 9, padding: '3px 5px', background: 'var(--bg-surface)',
          borderRadius: 2, color: 'var(--text-secondary)',
        }}>{status}</div>
      )}

      <div style={{ display: 'flex', gap: 4 }}>
        <button data-testid="cmt-summarize" onClick={exportSummary}
          disabled={filtered.length === 0}
          style={{
            flex: 2, padding: '6px 10px', fontSize: 10, borderRadius: 3,
            background: filtered.length ? 'var(--accent)' : 'var(--bg-surface)',
            color: filtered.length ? 'var(--bg-primary)' : 'var(--text-muted)',
            border: 'none',
            cursor: filtered.length ? 'pointer' : 'not-allowed',
            fontWeight: 600, opacity: filtered.length ? 1 : 0.5,
          }}>
          Summarize → PDF
        </button>
        <button data-testid="cmt-csv-export" onClick={exportCsv}
          disabled={filtered.length === 0}
          title="Export comments as CSV (Excel / spreadsheet)"
          style={{ flex: 1, padding: '6px 4px', fontSize: 9, background: 'var(--bg-surface)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 3, cursor: filtered.length ? 'pointer' : 'not-allowed' }}>
          CSV
        </button>
        <button data-testid="cmt-rtf-export" onClick={exportRtf}
          disabled={filtered.length === 0}
          title="Export comments as RTF (Word / LibreOffice)"
          style={{ flex: 1, padding: '6px 4px', fontSize: 9, background: 'var(--bg-surface)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 3, cursor: filtered.length ? 'pointer' : 'not-allowed' }}>
          RTF
        </button>
        <button data-testid="cmt-json-export" onClick={exportJson}
          disabled={filtered.length === 0}
          title="Export comments as JSON (scripted import / analytics)"
          style={{ flex: 1, padding: '6px 4px', fontSize: 9, background: 'var(--bg-surface)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 3, cursor: filtered.length ? 'pointer' : 'not-allowed' }}>
          JSON
        </button>
      </div>
      <div style={{ display: 'flex', gap: 4 }}>
        <button data-testid="cmt-xfdf-export" onClick={exportXfdf}
          disabled={filtered.length === 0}
          title="Export comments as XFDF (for Acrobat)"
          style={{ flex: 1, padding: '6px 4px', fontSize: 9, background: 'var(--bg-surface)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 3, cursor: filtered.length ? 'pointer' : 'not-allowed' }}>
          Export XFDF
        </button>
        <button data-testid="cmt-xfdf-import" onClick={importXfdf}
          title="Import comments from XFDF/FDF"
          style={{ flex: 1, padding: '6px 4px', fontSize: 9, background: 'var(--bg-surface)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 3, cursor: 'pointer' }}>
          Import XFDF
        </button>
      </div>
    </div>
  )
}

const selStyle: React.CSSProperties = {
  flex: 1, padding: '3px 4px', fontSize: 10,
  background: 'var(--bg-surface)', border: '1px solid var(--border)',
  color: 'var(--text-primary)', borderRadius: 3,
}
