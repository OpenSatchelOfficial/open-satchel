// Auto-detect form fields on a flat PDF.
//
// Runs pdfFormsDetect.detectFieldsOnFlatPdf per page, surfaces a
// preview per detection with accept/reject toggles, and on Apply
// creates real AcroForm fields via addFormFields.

import { useEffect, useState } from 'react'
import { useFormatStore } from '../../stores/formatStore'
import { useTabStore } from '../../stores/tabStore'
import type { PdfFormatState } from './index'
import { detectFieldsOnFlatPdf, type DetectedField } from '../../services/pdfFormsDetect'
import { addFormFields } from '../../services/pdfForms'

interface Props { tabId: string; onClose: () => void }

export default function AutoDetectFieldsDialog({ tabId, onClose }: Props) {
  const state = useFormatStore((s) => s.data[tabId] as PdfFormatState | undefined)
  const [scope, setScope] = useState<'current' | 'all'>('current')
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState('')
  const [detected, setDetected] = useState<Array<DetectedField & { accepted: boolean }>>([])
  const [progress, setProgress] = useState(0)

  useEffect(() => { setDetected([]) }, [tabId])

  const run = async () => {
    if (!state) return
    setRunning(true)
    setStatus('Scanning…')
    setProgress(0)
    setDetected([])
    try {
      const visible = state.pages.filter((p) => !p.deleted)
      // Current visible page via uiStore is a UX nicety; fall back to 0
      // if nothing's selected.
      const currentVisibleIdx = Math.min(visible.length - 1, Math.max(0, 0))
      const pagesToScan = scope === 'current' ? [visible[currentVisibleIdx].pageIndex] : visible.map((p) => p.pageIndex)
      const all: Array<DetectedField & { accepted: boolean }> = []
      for (let i = 0; i < pagesToScan.length; i++) {
        setStatus(`Scanning page ${i + 1} of ${pagesToScan.length}…`)
        const found = await detectFieldsOnFlatPdf(state.pdfBytes, pagesToScan[i])
        for (const f of found) all.push({ ...f, accepted: f.confidence > 0.4 })
        setProgress(Math.round(((i + 1) / pagesToScan.length) * 100))
      }
      setDetected(all)
      const uText = all.filter((d) => d.detectedAs === 'underline').length
      const uCheck = all.filter((d) => d.detectedAs === 'checkbox').length
      setStatus(`Found ${uText} text field${uText === 1 ? '' : 's'} + ${uCheck} checkbox${uCheck === 1 ? '' : 'es'}.`)
    } catch (e) {
      setStatus(`Error: ${(e as Error).message}`)
    } finally {
      setRunning(false)
    }
  }

  const apply = async () => {
    if (!state) return
    const accepted = detected.filter((d) => d.accepted)
    if (accepted.length === 0) { setStatus('No fields to add.'); return }
    setRunning(true)
    setStatus('Adding fields…')
    try {
      let textN = 1, checkN = 1
      const specs = accepted.map((d) => ({
        ...d.spec,
        name: d.detectedAs === 'underline' ? `text_${textN++}` : `check_${checkN++}`,
      }))
      const out = await addFormFields(state.pdfBytes, specs)
      useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({ ...prev, pdfBytes: out }))
      useTabStore.getState().setTabDirty(tabId, true)
      setStatus(`Added ${specs.length} field${specs.length === 1 ? '' : 's'}.`)
      setTimeout(onClose, 600)
    } catch (e) {
      setStatus(`Error: ${(e as Error).message}`)
    } finally {
      setRunning(false)
    }
  }

  const toggle = (idx: number) => {
    setDetected(detected.map((d, i) => i === idx ? { ...d, accepted: !d.accepted } : d))
  }
  const acceptAll = (v: boolean) => {
    setDetected(detected.map((d) => ({ ...d, accepted: v })))
  }

  return (
    <div data-testid="auto-detect-dialog" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
         onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ background: 'var(--bg-primary)', borderRadius: 8, padding: 20, minWidth: 560, maxWidth: 760, maxHeight: '85vh', display: 'flex', flexDirection: 'column', border: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>Auto-detect Form Fields</h3>
          <button data-testid="ad-close" onClick={onClose} style={{ fontSize: 18, background: 'transparent', border: 'none', color: 'var(--text-primary)', cursor: 'pointer' }}>✕</button>
        </div>

        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>
          Scans rasterized pages for underlines (→ text fields) and small empty squares (→ checkboxes).
          Review detections before committing — auto-detect is heuristic, not semantic.
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="radio" checked={scope === 'current'} onChange={() => setScope('current')} disabled={running} />
            Current page
          </label>
          <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="radio" checked={scope === 'all'} onChange={() => setScope('all')} disabled={running} />
            All pages
          </label>
          <button data-testid="ad-scan" onClick={run} disabled={running}
            style={{ padding: '5px 12px', fontSize: 12, background: 'var(--accent)', color: 'var(--bg-primary)', border: 'none', borderRadius: 4, fontWeight: 600, cursor: running ? 'wait' : 'pointer', marginLeft: 'auto' }}>
            {running ? `${progress}%…` : 'Scan'}
          </button>
        </div>

        {detected.length > 0 && (
          <>
            <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
              <button onClick={() => acceptAll(true)} style={{ padding: '2px 8px', fontSize: 10 }}>Accept all</button>
              <button onClick={() => acceptAll(false)} style={{ padding: '2px 8px', fontSize: 10 }}>Reject all</button>
              <span style={{ alignSelf: 'center', fontSize: 10, color: 'var(--text-muted)' }}>
                {detected.filter((d) => d.accepted).length} of {detected.length} will be added
              </span>
            </div>
            <div style={{ flex: 1, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 4, padding: 4 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-surface)' }}>
                    <th style={th}></th>
                    <th style={th}>Type</th>
                    <th style={th}>Page</th>
                    <th style={{ ...th, textAlign: 'right' }}>Pos (pt)</th>
                    <th style={{ ...th, textAlign: 'right' }}>Size (pt)</th>
                    <th style={{ ...th, textAlign: 'right' }}>Conf.</th>
                  </tr>
                </thead>
                <tbody>
                  {detected.map((d, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid var(--bg-surface)', opacity: d.accepted ? 1 : 0.4 }}>
                      <td style={td}><input type="checkbox" checked={d.accepted} onChange={() => toggle(i)} /></td>
                      <td style={td}>{d.detectedAs}</td>
                      <td style={td}>{d.spec.page + 1}</td>
                      <td style={{ ...td, textAlign: 'right' }}>{Math.round(d.spec.rect.x)}, {Math.round(d.spec.rect.y)}</td>
                      <td style={{ ...td, textAlign: 'right' }}>{Math.round(d.spec.rect.width)} × {Math.round(d.spec.rect.height)}</td>
                      <td style={{ ...td, textAlign: 'right', color: d.confidence > 0.7 ? 'var(--success)' : d.confidence > 0.4 ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                        {Math.round(d.confidence * 100)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {status && <div data-testid="ad-status" style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>{status}</div>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button data-testid="ad-cancel" onClick={onClose} disabled={running} style={{ padding: '6px 14px', fontSize: 12 }}>Cancel</button>
          <button data-testid="ad-apply" onClick={apply} disabled={running || detected.filter((d) => d.accepted).length === 0}
            style={{ padding: '6px 14px', fontSize: 12, background: 'var(--accent)', color: 'var(--bg-primary)', border: 'none', borderRadius: 4, fontWeight: 600, cursor: running ? 'wait' : 'pointer' }}>
            Apply ({detected.filter((d) => d.accepted).length})
          </button>
        </div>
      </div>
    </div>
  )
}

const th: React.CSSProperties = { padding: '6px 8px', textAlign: 'left', fontWeight: 600, color: 'var(--text-secondary)', fontSize: 10, textTransform: 'uppercase' }
const td: React.CSSProperties = { padding: '4px 8px', color: 'var(--text-primary)' }
