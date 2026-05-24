import { useEffect, useState } from 'react'
import { useFormatStore } from '../../stores/formatStore'
import { useTabStore } from '../../stores/tabStore'
import { useUIStore } from '../../stores/uiStore'
import type { PdfFormatState } from './index'
import { listNamedDestinations, writeNamedDestinations, type NamedDestination } from '../../services/pdfLinks'

interface Props {
  tabId: string
  onClose: () => void
}

/** Edit named destinations — stable page anchors that bookmarks and
 *  cross-document links can target by name instead of by absolute
 *  page number. Useful when adding/removing pages shouldn't break
 *  external references. */
export default function NamedDestinationsDialog({ tabId, onClose }: Props) {
  const state = useFormatStore((s) => s.data[tabId] as PdfFormatState | undefined)
  const setCurrentPage = useUIStore((s) => s.setCurrentPage)
  const [dests, setDests] = useState<NamedDestination[]>([])
  const [loading, setLoading] = useState(true)
  const [dirty, setDirty] = useState(false)
  const [status, setStatus] = useState('')

  useEffect(() => {
    if (!state) return
    setLoading(true)
    listNamedDestinations(state.pdfBytes).then((list) => {
      setDests(list)
      setLoading(false)
      setDirty(false)
    })
  }, [state?.pdfBytes])

  if (!state) return null

  const totalPages = state.pages.filter((p) => !p.deleted).length

  const update = (i: number, patch: Partial<NamedDestination>) => {
    setDests((prev) => prev.map((d, idx) => (idx === i ? { ...d, ...patch } : d)))
    setDirty(true)
  }
  const remove = (i: number) => {
    setDests((prev) => prev.filter((_, idx) => idx !== i))
    setDirty(true)
  }
  const add = () => {
    const curPage = useUIStore.getState().currentPage
    const visible = state.pages.filter((p) => !p.deleted)
    const pageIdx = visible[curPage]?.pageIndex ?? 0
    setDests((prev) => [...prev, { name: `dest_${prev.length + 1}`, pageIndex: pageIdx }])
    setDirty(true)
  }

  const save = async () => {
    setStatus('Saving…')
    try {
      const bytes = await writeNamedDestinations(state.pdfBytes, dests)
      useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({ ...prev, pdfBytes: bytes }))
      useTabStore.getState().setTabDirty(tabId, true)
      setDirty(false)
      setStatus(`Saved ${dests.length} destination${dests.length === 1 ? '' : 's'}.`)
      setTimeout(onClose, 500)
    } catch (e) {
      setStatus(e instanceof Error ? `Error: ${e.message}` : 'Failed')
    }
  }

  const jumpTo = (pageIndex: number) => {
    const visible = state.pages.filter((p) => !p.deleted)
    const idx = visible.findIndex((p) => p.pageIndex === pageIndex)
    if (idx >= 0) {
      setCurrentPage(idx)
      const el = document.querySelector(`[data-page-display-index="${idx}"]`) as HTMLElement | null
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }

  return (
    <div
      data-testid="named-destinations-dialog"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: 'var(--bg-primary)', borderRadius: 8, padding: 20,
        border: '1px solid var(--border)', width: 520, maxHeight: '80vh',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>Named Destinations</h3>
          <button onClick={onClose} style={{ background:'transparent', border:'none', color:'var(--text-primary)', cursor:'pointer', fontSize:18 }}>✕</button>
        </div>

        <p style={{ margin: '0 0 10px 0', fontSize: 11, color: 'var(--text-secondary)' }}>
          Named destinations are stable anchors. Use them as bookmark targets or cross-document link targets so renumbering pages doesn't break references.
        </p>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {loading ? (
            <div style={{ padding: 12, fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>Loading…</div>
          ) : dests.length === 0 ? (
            <div style={{ padding: 12, fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>
              No named destinations yet. Click "+ Add" to create one pointing at the current page.
            </div>
          ) : (
            dests.map((d, i) => (
              <div key={i} data-testid={`dest-row-${i}`}
                style={{
                  display: 'grid', gridTemplateColumns: '1fr 80px 60px 30px',
                  gap: 6, alignItems: 'center', padding: 6,
                  background: 'var(--bg-surface)', border: '1px solid var(--border)',
                  borderRadius: 4, marginBottom: 3,
                }}>
                <input
                  data-testid={`dest-name-${i}`}
                  value={d.name}
                  onChange={(e) => update(i, { name: e.target.value })}
                  style={{
                    padding: '4px 6px', fontSize: 11,
                    background: 'var(--bg-primary)', border: '1px solid var(--border)',
                    color: 'var(--text-primary)', borderRadius: 3,
                    fontFamily: 'monospace',
                  }}
                />
                <input
                  data-testid={`dest-page-${i}`}
                  type="number" min={1} max={totalPages}
                  value={d.pageIndex + 1}
                  onChange={(e) => update(i, { pageIndex: Math.max(0, Math.min(totalPages - 1, Number(e.target.value) - 1)) })}
                  style={{
                    padding: '4px 6px', fontSize: 11, textAlign: 'center',
                    background: 'var(--bg-primary)', border: '1px solid var(--border)',
                    color: 'var(--text-primary)', borderRadius: 3,
                  }}
                />
                <button
                  data-testid={`dest-jump-${i}`}
                  onClick={() => jumpTo(d.pageIndex)}
                  style={{
                    padding: '4px 8px', fontSize: 10, borderRadius: 3,
                    background: 'var(--bg-primary)', color: 'var(--text-primary)',
                    border: '1px solid var(--border)', cursor: 'pointer',
                  }}>Go</button>
                <button
                  data-testid={`dest-del-${i}`}
                  onClick={() => remove(i)}
                  style={{ background:'transparent', border:'none', color:'var(--danger)', cursor:'pointer', padding:0, fontSize:14 }}>✕</button>
              </div>
            ))
          )}
        </div>

        {status && (
          <div data-testid="dest-status" style={{
            marginTop: 8, padding: 6, background: 'var(--bg-surface)', borderRadius: 3,
            fontSize: 11, color: 'var(--text-primary)',
          }}>{status}</div>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10 }}>
          <button data-testid="dest-add" onClick={add}
            style={{ padding:'6px 12px', background:'var(--bg-surface)', color:'var(--text-primary)', border:'1px solid var(--border)', borderRadius:4, cursor:'pointer', fontSize:11 }}>
            + Add (points at current page)
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onClose} style={{
              padding:'6px 16px', background:'var(--bg-surface)', color:'var(--text-primary)',
              border:'1px solid var(--border)', borderRadius:4, cursor:'pointer', fontSize:12,
            }}>Cancel</button>
            <button data-testid="dest-save" onClick={save} disabled={!dirty} style={{
              padding:'6px 16px', background:dirty ? 'var(--accent)' : 'var(--bg-surface)',
              color:dirty ? 'var(--bg-primary)' : 'var(--text-muted)',
              border:'none', borderRadius:4,
              cursor:dirty ? 'pointer' : 'not-allowed', fontSize:12, fontWeight:600,
              opacity:dirty ? 1 : 0.5,
            }}>Save</button>
          </div>
        </div>
      </div>
    </div>
  )
}
