// Initial View settings — how the PDF opens. Writes to catalog's
// /OpenAction, /PageLayout, /PageMode.
//
// Mirrors Acrobat's File > Properties > Initial View tab.

import { useEffect, useState } from 'react'
import { useFormatStore } from '../../stores/formatStore'
import { useTabStore } from '../../stores/tabStore'
import type { PdfFormatState } from './index'
import { readInitialView, writeInitialView, type InitialView, type PageLayout, type PageMode } from '../../services/pdfMisc'

interface Props { tabId: string; onClose: () => void }

const LAYOUTS: Array<{ value: PageLayout; label: string }> = [
  { value: 'Default', label: 'Default (reader preference)' },
  { value: 'SinglePage', label: 'Single page' },
  { value: 'OneColumn', label: 'Continuous column' },
  { value: 'TwoColumnLeft', label: 'Two columns (odd left)' },
  { value: 'TwoColumnRight', label: 'Two columns (odd right)' },
  { value: 'TwoPageLeft', label: 'Two page view (odd left)' },
  { value: 'TwoPageRight', label: 'Two page view (odd right)' },
]
const MODES: Array<{ value: PageMode; label: string }> = [
  { value: 'Default', label: 'Default (reader preference)' },
  { value: 'UseNone', label: 'Page only (hide sidebars)' },
  { value: 'UseOutlines', label: 'Show bookmarks panel' },
  { value: 'UseThumbs', label: 'Show thumbnails panel' },
  { value: 'FullScreen', label: 'Full screen' },
  { value: 'UseOC', label: 'Show layers panel' },
  { value: 'UseAttachments', label: 'Show attachments panel' },
]

export default function InitialViewDialog({ tabId, onClose }: Props) {
  const state = useFormatStore((s) => s.data[tabId] as PdfFormatState | undefined)
  const [view, setView] = useState<InitialView>({ openAtPage: 1, pageLayout: 'Default', pageMode: 'Default' })
  const [status, setStatus] = useState('')

  useEffect(() => {
    if (!state) return
    readInitialView(state.pdfBytes).then(setView)
  }, [state?.pdfBytes])

  const save = async () => {
    if (!state) return
    setStatus('Saving…')
    try {
      const out = await writeInitialView(state.pdfBytes, view)
      useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({ ...prev, pdfBytes: out }))
      useTabStore.getState().setTabDirty(tabId, true)
      setStatus('Saved.')
      setTimeout(onClose, 500)
    } catch (e) {
      setStatus(`Error: ${(e as Error).message}`)
    }
  }

  return (
    <div data-testid="initial-view-dialog" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
         onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ background: 'var(--bg-primary)', borderRadius: 8, padding: 20, minWidth: 440, border: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 14 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>Initial View</h3>
          <button onClick={onClose} style={{ fontSize: 18, background: 'transparent', border: 'none', color: 'var(--text-primary)', cursor: 'pointer' }}>✕</button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Row label="Open at page">
            <input data-testid="iv-open-page" type="number" min={1} max={state?.pages.length ?? 1}
              value={view.openAtPage}
              onChange={(e) => setView({ ...view, openAtPage: Number(e.target.value) })}
              style={{ ...inp, width: 80 }} />
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>of {state?.pages.length ?? 1}</span>
          </Row>
          <Row label="Page layout">
            <select data-testid="iv-layout" style={inp} value={view.pageLayout} onChange={(e) => setView({ ...view, pageLayout: e.target.value as PageLayout })}>
              {LAYOUTS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
            </select>
          </Row>
          <Row label="Page mode (panels)">
            <select data-testid="iv-mode" style={inp} value={view.pageMode} onChange={(e) => setView({ ...view, pageMode: e.target.value as PageMode })}>
              {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </Row>
        </div>

        {status && <div data-testid="iv-status" style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 10 }}>{status}</div>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button onClick={onClose} style={btnSec}>Cancel</button>
          <button data-testid="iv-save" onClick={save} style={btnPri}>Save</button>
        </div>
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={{ fontSize: 11, color: 'var(--text-secondary)', display: 'block', marginBottom: 3 }}>{label}</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>{children}</div>
    </div>
  )
}

const inp: React.CSSProperties = { padding: '6px 8px', fontSize: 12, background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text-primary)', flex: 1 }
const btnPri: React.CSSProperties = { padding: '6px 14px', background: 'var(--accent)', color: 'var(--bg-primary)', border: 'none', borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: 'pointer' }
const btnSec: React.CSSProperties = { padding: '6px 14px', background: 'var(--bg-surface)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 4, fontSize: 12, cursor: 'pointer' }
