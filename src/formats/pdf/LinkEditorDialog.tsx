import { useEffect, useState } from 'react'
import { useFormatStore } from '../../stores/formatStore'
import { useTabStore } from '../../stores/tabStore'
import { useUIStore } from '../../stores/uiStore'
import type { PdfFormatState } from './index'
import { listLinks, updateLink, deleteLink, type LinkAnnotation } from '../../services/pdfLinks'

interface Props {
  tabId: string
  onClose: () => void
}

/** Edit existing link annotations — URLs, GoTo destinations, deletion.
 *  Drag-to-create is still handled by the Fabric `link` tool; this
 *  dialog is for touching what's already in the PDF. */
export default function LinkEditorDialog({ tabId, onClose }: Props) {
  const state = useFormatStore((s) => s.data[tabId] as PdfFormatState | undefined)
  const setCurrentPage = useUIStore((s) => s.setCurrentPage)
  const [links, setLinks] = useState<LinkAnnotation[]>([])
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState('')
  const [edits, setEdits] = useState<Map<string, string>>(new Map())

  const reload = async () => {
    if (!state) return
    setLoading(true)
    try {
      const list = await listLinks(state.pdfBytes)
      setLinks(list)
      setEdits(new Map())
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void reload() }, [state?.pdfBytes])

  if (!state) return null

  const key = (l: LinkAnnotation) => `${l.pageIndex}:${l.annotRef}`

  const setEdit = (l: LinkAnnotation, value: string) => {
    setEdits((prev) => {
      const next = new Map(prev)
      next.set(key(l), value)
      return next
    })
  }

  const saveEdit = async (l: LinkAnnotation) => {
    const value = edits.get(key(l))
    if (value === undefined || value === l.target) return
    setStatus(`Saving link on page ${l.pageIndex + 1}…`)
    try {
      let bytes: Uint8Array
      if (l.kind === 'goto') {
        const pageNum = parseInt(value.replace(/\D/g, ''), 10)
        if (!pageNum || pageNum < 1 || pageNum > state.pages.length) {
          setStatus('Invalid page number.'); return
        }
        bytes = await updateLink(state.pdfBytes, l.pageIndex, l.annotRef, { destPage: pageNum - 1 })
      } else {
        bytes = await updateLink(state.pdfBytes, l.pageIndex, l.annotRef, { url: value })
      }
      useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({ ...prev, pdfBytes: bytes }))
      useTabStore.getState().setTabDirty(tabId, true)
      setStatus('Saved.')
      await reload()
    } catch (e) {
      setStatus(e instanceof Error ? `Error: ${e.message}` : 'Failed')
    }
  }

  const removeLink = async (l: LinkAnnotation) => {
    setStatus(`Deleting link on page ${l.pageIndex + 1}…`)
    try {
      const bytes = await deleteLink(state.pdfBytes, l.pageIndex, l.annotRef)
      useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({ ...prev, pdfBytes: bytes }))
      useTabStore.getState().setTabDirty(tabId, true)
      setStatus('Deleted.')
      await reload()
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
      data-testid="link-editor-dialog"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: 'var(--bg-primary)', borderRadius: 8, padding: 20,
        border: '1px solid var(--border)', width: 620, maxHeight: '80vh',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>Links</h3>
          <button onClick={onClose} style={{ background:'transparent', border:'none', color:'var(--text-primary)', cursor:'pointer', fontSize:18 }}>✕</button>
        </div>

        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 10 }}>
          {loading ? 'Scanning…' :
           links.length === 0 ? 'No link annotations found.' :
           `${links.length} link${links.length === 1 ? '' : 's'} across ${new Set(links.map(l => l.pageIndex)).size} page${new Set(links.map(l => l.pageIndex)).size === 1 ? '' : 's'}.`}
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {links.map((l, i) => (
            <div key={key(l)} data-testid={`link-row-${i}`}
              style={{
                display: 'grid', gridTemplateColumns: '56px 64px 1fr 90px',
                gap: 6, alignItems: 'center', padding: 8,
                background: 'var(--bg-surface)', border: '1px solid var(--border)',
                borderRadius: 4, marginBottom: 4,
              }}>
              <button
                data-testid={`link-jump-${i}`}
                onClick={() => jumpTo(l.pageIndex)}
                style={{
                  padding: '3px 6px', fontSize: 10, borderRadius: 3,
                  background: 'var(--bg-primary)', color: 'var(--text-primary)',
                  border: '1px solid var(--border)', cursor: 'pointer',
                }}
                title="Jump to page">Page {l.pageIndex + 1}</button>
              <span style={{
                fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase',
                textAlign: 'center', padding: '2px 4px', borderRadius: 2,
                background: 'var(--bg-primary)',
              }}>{l.kind}</span>
              <input
                data-testid={`link-target-${i}`}
                value={edits.get(key(l)) ?? l.target}
                onChange={(e) => setEdit(l, e.target.value)}
                onBlur={() => saveEdit(l)}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur() }}
                style={{
                  padding: '4px 6px', fontSize: 11,
                  background: 'var(--bg-primary)', border: '1px solid var(--border)',
                  color: 'var(--text-primary)', borderRadius: 3,
                  width: '100%', boxSizing: 'border-box',
                  fontFamily: l.kind === 'uri' ? 'monospace' : undefined,
                }}
                placeholder={l.kind === 'goto' ? 'Page number' : 'URL'}
              />
              <button
                data-testid={`link-delete-${i}`}
                onClick={() => removeLink(l)}
                style={{
                  padding: '4px 10px', fontSize: 10,
                  background: 'var(--danger)', color: '#fff',
                  border: 'none', borderRadius: 3, cursor: 'pointer',
                }}>Delete</button>
            </div>
          ))}
        </div>

        {status && (
          <div data-testid="link-status" style={{
            marginTop: 8, padding: 6, background: 'var(--bg-surface)', borderRadius: 3,
            fontSize: 11, color: 'var(--text-primary)',
          }}>{status}</div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button onClick={onClose} style={{
            padding: '6px 16px', background: 'var(--bg-surface)', color: 'var(--text-primary)',
            border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer', fontSize: 12,
          }}>Close</button>
        </div>
      </div>
    </div>
  )
}
