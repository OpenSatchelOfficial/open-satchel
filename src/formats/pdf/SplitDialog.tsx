import { useState } from 'react'
import { useFormatStore } from '../../stores/formatStore'
import type { PdfFormatState } from './index'
import { splitPdf, splitEveryN, type SplitRange } from '../../services/pdfOps'
import { resolveOutputBytes } from '../../services/pdfPrint'

interface Props {
  tabId: string
  onClose: () => void
}

type Mode = 'every-n' | 'ranges' | 'per-page'

/** Direct split dialog — pick a mode, pick a target, one-click export.
 *  Replaces the Advanced Tools → Organize → split flow for the common
 *  case. Mirrors Acrobat's "Split Document" organizer action. */
export default function SplitDialog({ tabId, onClose }: Props) {
  const state = useFormatStore((s) => s.data[tabId] as PdfFormatState | undefined)
  const [mode, setMode] = useState<Mode>('every-n')
  const [n, setN] = useState(2)
  const [rangesText, setRangesText] = useState('1-5, 6-10')
  const [status, setStatus] = useState('')
  const [running, setRunning] = useState(false)

  if (!state) return null

  const totalPages = state.pages.filter((p) => !p.deleted).length

  const parseRanges = (text: string): SplitRange[] => {
    const parts = text.split(',').map((s) => s.trim()).filter(Boolean)
    const out: SplitRange[] = []
    for (const part of parts) {
      const m = part.match(/^(\d+)\s*-\s*(\d+)$/)
      if (m) {
        out.push({ start: Number(m[1]), end: Number(m[2]) })
      } else if (/^\d+$/.test(part)) {
        const n = Number(part)
        out.push({ start: n, end: n })
      }
    }
    return out
  }

  const run = async () => {
    setRunning(true)
    setStatus('Splitting…')
    try {
      // GATE 3: bake pending manual redactions before exporting split chunks —
      // each chunk is a downloaded file that must not carry the secret.
      const srcBytes = await resolveOutputBytes(tabId)
      let chunks: Uint8Array[] = []
      if (mode === 'every-n') {
        chunks = await splitEveryN(srcBytes, Math.max(1, n))
      } else if (mode === 'ranges') {
        const ranges = parseRanges(rangesText)
        if (ranges.length === 0) { setStatus('Invalid ranges. Use "1-5, 6-10".'); setRunning(false); return }
        chunks = await splitPdf(srcBytes, ranges)
      } else {
        chunks = await splitEveryN(srcBytes, 1)
      }

      const baseName = 'split'
      let saved = 0
      for (let i = 0; i < chunks.length; i++) {
        const name = `${baseName}-${String(i + 1).padStart(2, '0')}.pdf`
        // Set browser-shim's expected filename; Tauri build ignores.
        ;(globalThis as unknown as { __lastSavedName?: string }).__lastSavedName = name
        const ok = await window.api.file.saveAs(chunks[i])
        if (ok) saved++
      }
      setStatus(`Saved ${saved} of ${chunks.length} files.`)
      if (saved > 0) setTimeout(onClose, 500)
    } catch (e) {
      setStatus(e instanceof Error ? `Error: ${e.message}` : 'Split failed.')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div
      data-testid="split-dialog"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: 'var(--bg-primary)', borderRadius: 8, padding: 20,
        border: '1px solid var(--border)', width: 460,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>Split PDF</h3>
          <button onClick={onClose} style={xBtnStyle}>✕</button>
        </div>

        <p style={{ margin: '0 0 12px 0', fontSize: 12, color: 'var(--text-secondary)' }}>
          Current document: <strong>{totalPages} pages</strong>. Each split chunk saves as a separate file.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <ModeRow testId="split-mode-every-n" mode="every-n" current={mode} setMode={setMode} label="Every N pages">
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
              <input
                data-testid="split-n"
                type="number" min={1} max={totalPages} value={n}
                onChange={(e) => setN(Number(e.target.value))}
                disabled={mode !== 'every-n'}
                style={{ ...inp, width: 70 }}
              />
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                pages per file ({Math.ceil(totalPages / Math.max(1, n))} files)
              </span>
            </div>
          </ModeRow>
          <ModeRow testId="split-mode-ranges" mode="ranges" current={mode} setMode={setMode} label="Custom ranges">
            <input
              data-testid="split-ranges"
              type="text" value={rangesText}
              onChange={(e) => setRangesText(e.target.value)}
              disabled={mode !== 'ranges'}
              placeholder="e.g. 1-5, 6-10, 11"
              style={{ ...inp, marginTop: 4 }}
            />
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
              Each range becomes one output file.
            </span>
          </ModeRow>
          <ModeRow testId="split-mode-per-page" mode="per-page" current={mode} setMode={setMode} label="One file per page">
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              Extract every page as its own PDF ({totalPages} files).
            </span>
          </ModeRow>
        </div>

        {status && (
          <div data-testid="split-status" style={{
            marginTop: 12, padding: 8, background: 'var(--bg-surface)',
            borderRadius: 4, fontSize: 11, color: 'var(--text-primary)',
          }}>{status}</div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={btnSecondary}>Cancel</button>
          <button data-testid="split-run" onClick={run} disabled={running} style={btnPrimary}>
            {running ? 'Splitting…' : 'Split'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ModeRow({ mode, current, setMode, label, children, testId }: {
  mode: Mode; current: Mode; setMode: (m: Mode) => void; label: string;
  children?: React.ReactNode; testId?: string
}) {
  const selected = mode === current
  return (
    <div
      data-testid={testId}
      onClick={() => setMode(mode)}
      style={{
        padding: 10, borderRadius: 4, cursor: 'pointer',
        border: selected ? '1px solid var(--accent)' : '1px solid var(--border)',
        background: selected ? 'var(--bg-surface)' : 'transparent',
      }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
        <input type="radio" checked={selected} onChange={() => setMode(mode)} style={{ margin: 0 }} />
        <strong>{label}</strong>
      </label>
      <div style={{ marginLeft: 22 }}>{children}</div>
    </div>
  )
}

const inp: React.CSSProperties = {
  padding: '5px 8px', fontSize: 12,
  background: 'var(--bg-surface)', border: '1px solid var(--border)',
  borderRadius: 3, color: 'var(--text-primary)', boxSizing: 'border-box',
}
const btnPrimary: React.CSSProperties = {
  padding: '6px 16px', background: 'var(--accent)', color: 'var(--bg-primary)',
  border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 600,
}
const btnSecondary: React.CSSProperties = {
  padding: '6px 16px', background: 'var(--bg-surface)', color: 'var(--text-primary)',
  border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer', fontSize: 12,
}
const xBtnStyle: React.CSSProperties = {
  background: 'transparent', border: 'none', color: 'var(--text-primary)',
  cursor: 'pointer', fontSize: 18,
}
