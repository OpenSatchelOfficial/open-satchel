import { useEffect, useState } from 'react'
import { useFormatStore } from '../../stores/formatStore'
import { useTabStore } from '../../stores/tabStore'
import { useUIStore } from '../../stores/uiStore'
import type { PdfFormatState } from './index'
import { readBookmarks, writeFlatBookmarks, type Bookmark } from '../../services/pdfBookmarks'

interface Props {
  tabId: string
}

/** Bookmarks / outline panel. Reads the PDF's /Outlines tree on open,
 *  lets the user add/rename/delete entries with direct navigation, and
 *  writes a flat list back to the PDF. Nested outlines render read-only
 *  for now (one level of indentation shown). */
export default function BookmarksPanel({ tabId }: Props) {
  const state = useFormatStore((s) => s.data[tabId] as PdfFormatState | undefined)
  const setCurrentPage = useUIStore((s) => s.setCurrentPage)
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [loading, setLoading] = useState(true)
  const [dirty, setDirty] = useState(false)
  const [status, setStatus] = useState('')

  useEffect(() => {
    if (!state) return
    setLoading(true)
    readBookmarks(state.pdfBytes).then((bms) => {
      setBookmarks(flatten(bms))
      setLoading(false)
      setDirty(false)
    }).catch(() => { setBookmarks([]); setLoading(false) })
  }, [state?.pdfBytes])

  if (!state) return null

  const totalPages = state.pages.length

  const jumpTo = (page: number) => {
    // Use visible-index mapping since pages can be marked deleted.
    const visible = state.pages.filter((p) => !p.deleted)
    const targetDisplayIndex = visible.findIndex((p) => p.pageIndex === page)
    if (targetDisplayIndex >= 0) {
      setCurrentPage(targetDisplayIndex)
      const el = document.querySelector(`[data-page-display-index="${targetDisplayIndex}"]`) as HTMLElement | null
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }

  const update = (i: number, patch: Partial<Bookmark>) => {
    setBookmarks((prev) => prev.map((b, idx) => idx === i ? { ...b, ...patch } : b))
    setDirty(true)
  }
  const remove = (i: number) => {
    setBookmarks((prev) => prev.filter((_, idx) => idx !== i))
    setDirty(true)
  }
  const add = (atCurrent = false) => {
    const defaultPage = atCurrent ? useUIStore.getState().currentPage : 0
    const visible = state.pages.filter((p) => !p.deleted)
    const pageIdx = visible[defaultPage]?.pageIndex ?? 0
    setBookmarks((prev) => [...prev, { title: 'New bookmark', page: pageIdx }])
    setDirty(true)
  }
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= bookmarks.length) return
    setBookmarks((prev) => {
      const next = [...prev]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
    setDirty(true)
  }
  const save = async () => {
    setStatus('Saving…')
    try {
      const bytes = await writeFlatBookmarks(state.pdfBytes, bookmarks)
      useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({ ...prev, pdfBytes: bytes }))
      useTabStore.getState().setTabDirty(tabId, true)
      setDirty(false)
      setStatus(`Saved ${bookmarks.length} bookmark${bookmarks.length === 1 ? '' : 's'}.`)
      setTimeout(() => setStatus(''), 2000)
    } catch (e) {
      setStatus(e instanceof Error ? `Error: ${e.message}` : 'Failed')
    }
  }

  return (
    <div
      data-testid="bookmarks-panel"
      style={{
        display: 'flex', flexDirection: 'column', height: '100%',
        padding: 6, gap: 4,
      }}>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <button
          data-testid="bm-add"
          onClick={() => add(false)}
          title="Add bookmark at page 1"
          style={panelBtn}>
          + Add
        </button>
        <button
          data-testid="bm-add-current"
          onClick={() => add(true)}
          title="Add bookmark at currently-viewed page"
          style={panelBtn}>
          + Current
        </button>
        <div style={{ flex: 1 }} />
        <button
          data-testid="bm-save"
          onClick={save}
          disabled={!dirty}
          style={{
            ...panelBtnPrimary,
            opacity: dirty ? 1 : 0.4,
            cursor: dirty ? 'pointer' : 'not-allowed',
          }}>
          Save
        </button>
      </div>

      {status && (
        <div data-testid="bm-status" style={{
          fontSize: 10, padding: '4px 6px', borderRadius: 3,
          background: 'var(--bg-surface)', color: 'var(--text-secondary)',
        }}>{status}</div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', padding: 2 }}>
        {loading ? (
          <div style={{ padding: 12, fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>
            Loading bookmarks…
          </div>
        ) : bookmarks.length === 0 ? (
          <div style={{ padding: 12, fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>
            No bookmarks yet. Click “+ Add” or “+ Current” to create one.
          </div>
        ) : (
          bookmarks.map((bm, i) => (
            <div key={i} data-testid={`bm-row-${i}`}
              style={{
                display: 'flex', alignItems: 'center', gap: 3,
                padding: '3px 2px', borderRadius: 3,
                borderBottom: '1px solid var(--border)',
              }}>
              <button
                data-testid={`bm-jump-${i}`}
                onClick={() => jumpTo(bm.page)}
                title="Go to page"
                style={{
                  ...panelBtnSmall,
                  minWidth: 30, padding: '2px 4px',
                  fontFamily: 'Courier, monospace',
                }}>
                {bm.page + 1}
              </button>
              <input
                data-testid={`bm-title-${i}`}
                value={bm.title}
                onChange={(e) => update(i, { title: e.target.value })}
                style={{
                  flex: 1, minWidth: 0, padding: '3px 5px', fontSize: 11,
                  background: 'transparent', border: '1px solid transparent',
                  color: 'var(--text-primary)', borderRadius: 2,
                }}
                onFocus={(e) => { e.target.style.border = '1px solid var(--border)' }}
                onBlur={(e) => { e.target.style.border = '1px solid transparent' }}
              />
              <input
                data-testid={`bm-page-${i}`}
                type="number" min={1} max={totalPages}
                value={bm.page + 1}
                onChange={(e) => update(i, { page: Math.max(0, Math.min(totalPages - 1, Number(e.target.value) - 1)) })}
                style={{
                  width: 40, padding: '2px 4px', fontSize: 10,
                  background: 'var(--bg-surface)', border: '1px solid var(--border)',
                  color: 'var(--text-primary)', borderRadius: 2,
                }}
              />
              <button onClick={() => move(i, -1)} disabled={i === 0}
                style={{ ...panelBtnSmall, opacity: i === 0 ? 0.3 : 1 }}
                title="Move up">▲</button>
              <button onClick={() => move(i, 1)} disabled={i === bookmarks.length - 1}
                style={{ ...panelBtnSmall, opacity: i === bookmarks.length - 1 ? 0.3 : 1 }}
                title="Move down">▼</button>
              <button
                data-testid={`bm-del-${i}`}
                onClick={() => remove(i)}
                style={{ ...panelBtnSmall, color: 'var(--danger)' }}
                title="Delete">✕</button>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function flatten(bms: Bookmark[]): Bookmark[] {
  const out: Bookmark[] = []
  const walk = (list: Bookmark[]) => {
    for (const b of list) {
      out.push({ title: b.title, page: b.page })
      if (b.children) walk(b.children)
    }
  }
  walk(bms)
  return out
}

const panelBtn: React.CSSProperties = {
  padding: '3px 8px', fontSize: 10, borderRadius: 3,
  background: 'var(--bg-surface)', color: 'var(--text-primary)',
  border: '1px solid var(--border)', cursor: 'pointer',
}
const panelBtnPrimary: React.CSSProperties = {
  padding: '3px 10px', fontSize: 10, borderRadius: 3,
  background: 'var(--accent)', color: 'var(--bg-primary)',
  border: 'none', cursor: 'pointer', fontWeight: 600,
}
const panelBtnSmall: React.CSSProperties = {
  width: 20, height: 20, padding: 0, fontSize: 10,
  background: 'transparent', border: 'none',
  color: 'var(--text-primary)', cursor: 'pointer', borderRadius: 2,
}
