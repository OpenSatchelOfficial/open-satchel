import { useState } from 'react'
import { useFormatStore } from '../../stores/formatStore'
import type { PdfFormatState } from './index'
import { generateCompareReport } from '../../services/pdfCompare'

interface Props {
  tabId: string
  onClose: () => void
}

/** Pick a second PDF and generate a one-shot compare report. */
export default function CompareReportDialog({ tabId, onClose }: Props) {
  const state = useFormatStore((s) => s.data[tabId] as PdfFormatState | undefined)
  const [status, setStatus] = useState('')
  const [running, setRunning] = useState(false)

  if (!state) return null

  const pickAndGenerate = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'application/pdf'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      setRunning(true)
      setStatus(`Comparing against ${file.name}…`)
      try {
        const otherBytes = new Uint8Array(await file.arrayBuffer())
        const report = await generateCompareReport(state.pdfBytes, otherBytes, 'This PDF', file.name)
        const name = `compare-report-${Date.now()}.pdf`
        ;(globalThis as unknown as { __lastSavedName?: string }).__lastSavedName = name
        const ok = await window.api.file.saveAs(report)
        setStatus(ok ? `Saved ${name} (${(report.byteLength / 1024).toFixed(1)} KB).` : 'Save cancelled.')
      } catch (e) {
        setStatus(e instanceof Error ? `Error: ${e.message}` : 'Failed')
      } finally {
        setRunning(false)
      }
    }
    input.click()
  }

  return (
    <div
      data-testid="compare-report-dialog"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: 'var(--bg-primary)', borderRadius: 8, padding: 20,
        border: '1px solid var(--border)', minWidth: 440,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>Compare &amp; Generate Report</h3>
          <button onClick={onClose} style={{ background:'transparent', border:'none', color:'var(--text-primary)', cursor:'pointer', fontSize:18 }}>✕</button>
        </div>
        <p style={{ margin: '0 0 12px 0', fontSize: 11, color: 'var(--text-secondary)' }}>
          Compares this PDF against a second PDF and produces a new PDF report showing:
          <br />• Summary totals (inserted, deleted, similarity)
          <br />• Per-page similarity bar chart
          <br />• Line-by-line diff with inserts (green) and deletes (red)
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose} style={{
            padding: '6px 16px', background: 'var(--bg-surface)', color: 'var(--text-primary)',
            border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer', fontSize: 12,
          }}>Cancel</button>
          <button
            data-testid="compare-report-pick"
            onClick={pickAndGenerate}
            disabled={running}
            style={{
              padding: '6px 16px', background: 'var(--accent)', color: 'var(--bg-primary)',
              border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 600,
              opacity: running ? 0.6 : 1,
            }}>
            {running ? 'Generating…' : 'Pick second PDF…'}
          </button>
        </div>
        {status && (
          <div data-testid="compare-report-status" style={{
            marginTop: 10, padding: 6, background: 'var(--bg-surface)', borderRadius: 3, fontSize: 11, color: 'var(--text-primary)',
          }}>{status}</div>
        )}
      </div>
    </div>
  )
}
