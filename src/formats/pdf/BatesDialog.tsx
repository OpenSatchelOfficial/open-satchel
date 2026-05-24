import { useState } from 'react'
import { useFormatStore } from '../../stores/formatStore'
import { useTabStore } from '../../stores/tabStore'
import type { PdfFormatState } from './index'
import { applyBatesNumbering } from '../../services/pdfOps'

interface Props {
  tabId: string
  onClose: () => void
}

type Position = 'footer-right' | 'footer-center' | 'footer-left' | 'header-right' | 'header-center' | 'header-left'

/** Bates numbering dialog. Legal-industry page numbering with prefix,
 *  suffix, digit width, and custom start. Each page gets a unique label
 *  burned onto the content stream. */
export default function BatesDialog({ tabId, onClose }: Props) {
  const state = useFormatStore((s) => s.data[tabId] as PdfFormatState | undefined)
  const [prefix, setPrefix] = useState('ACME-')
  const [suffix, setSuffix] = useState('')
  const [start, setStart] = useState(1)
  const [digits, setDigits] = useState(6)
  const [position, setPosition] = useState<Position>('footer-right')
  const [fontSize, setFontSize] = useState(10)
  const [color, setColor] = useState('#000000')
  const [skipOdd, setSkipOdd] = useState(false)
  const [skipEven, setSkipEven] = useState(false)
  const [status, setStatus] = useState('')
  const [running, setRunning] = useState(false)

  if (!state) return null
  const totalPages = state.pages.filter((p) => !p.deleted).length

  const sampleNum = String(start).padStart(digits, '0')
  const preview = `${prefix}${sampleNum}${suffix}`

  const run = async () => {
    setRunning(true)
    setStatus('Applying Bates numbering…')
    try {
      const bytes = await applyBatesNumbering(state.pdfBytes, {
        prefix, suffix, start, digits, position, fontSize,
        color: hexToRgb(color), skipOdd, skipEven,
      })
      useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({ ...prev, pdfBytes: bytes }))
      useTabStore.getState().setTabDirty(tabId, true)
      setStatus(`Bates numbers applied to ${totalPages} pages.`)
      setTimeout(onClose, 500)
    } catch (e) {
      setStatus(e instanceof Error ? `Error: ${e.message}` : 'Failed')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div
      data-testid="bates-dialog"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: 'var(--bg-primary)', borderRadius: 8, padding: 20,
        border: '1px solid var(--border)', width: 480,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>Bates Numbering</h3>
          <button onClick={onClose} style={xBtn}>✕</button>
        </div>

        <p style={{ margin: '0 0 12px 0', fontSize: 11, color: 'var(--text-secondary)' }}>
          Bates numbers are permanent sequential page identifiers used in legal discovery.
          They burn into the page content stream.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <Label>Prefix</Label>
              <input data-testid="bates-prefix" style={inp} value={prefix} onChange={(e) => setPrefix(e.target.value)} />
            </div>
            <div style={{ flex: 1 }}>
              <Label>Suffix</Label>
              <input data-testid="bates-suffix" style={inp} value={suffix} onChange={(e) => setSuffix(e.target.value)} />
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <Label>Start at</Label>
              <input data-testid="bates-start" type="number" min={0} style={inp} value={start} onChange={(e) => setStart(Number(e.target.value))} />
            </div>
            <div style={{ flex: 1 }}>
              <Label>Digits (zero-pad)</Label>
              <input data-testid="bates-digits" type="number" min={1} max={12} style={inp} value={digits} onChange={(e) => setDigits(Number(e.target.value))} />
            </div>
            <div style={{ width: 60 }}>
              <Label>Size</Label>
              <input type="number" min={6} max={24} style={inp} value={fontSize} onChange={(e) => setFontSize(Number(e.target.value))} />
            </div>
            <div style={{ width: 50 }}>
              <Label>Color</Label>
              <input type="color" value={color} onChange={(e) => setColor(e.target.value)}
                style={{ width: '100%', height: 28, border: 'none', cursor: 'pointer', padding: 0 }} />
            </div>
          </div>

          <div>
            <Label>Position</Label>
            <div style={{
              display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4,
              padding: 6, border: '1px solid var(--border)', borderRadius: 4,
            }}>
              {(['header-left', 'header-center', 'header-right', 'footer-left', 'footer-center', 'footer-right'] as Position[]).map((p) => (
                <button
                  key={p}
                  data-testid={`bates-pos-${p}`}
                  onClick={() => setPosition(p)}
                  style={{
                    padding: 8, fontSize: 10, borderRadius: 3,
                    background: position === p ? 'var(--accent)' : 'var(--bg-surface)',
                    color: position === p ? 'var(--bg-primary)' : 'var(--text-primary)',
                    border: 'none', cursor: 'pointer', textTransform: 'capitalize',
                  }}>{p.replace('-', ' ')}</button>
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 14, fontSize: 11, color: 'var(--text-secondary)' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
              <input type="checkbox" data-testid="bates-skip-odd" checked={skipOdd} onChange={(e) => setSkipOdd(e.target.checked)} />
              Skip odd pages
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
              <input type="checkbox" data-testid="bates-skip-even" checked={skipEven} onChange={(e) => setSkipEven(e.target.checked)} />
              Skip even pages
            </label>
          </div>

          <div style={{
            padding: 8, background: 'var(--bg-surface)', borderRadius: 4,
            fontSize: 12, color: 'var(--text-secondary)',
          }}>
            Preview: <strong data-testid="bates-preview" style={{
              color: 'var(--text-primary)', fontFamily: 'Courier, monospace', fontSize: 13,
            }}>{preview}</strong>
          </div>
        </div>

        {status && (
          <div data-testid="bates-status" style={{
            marginTop: 10, padding: 6, background: 'var(--bg-surface)', borderRadius: 3,
            fontSize: 11, color: 'var(--text-primary)',
          }}>{status}</div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button onClick={onClose} style={btnSecondary}>Cancel</button>
          <button data-testid="bates-apply" onClick={run} disabled={running} style={btnPrimary}>
            {running ? 'Applying…' : 'Apply'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Label({ children }: { children: React.ReactNode }) {
  return <label style={{ fontSize: 11, color: 'var(--text-secondary)', display: 'block', marginBottom: 3 }}>{children}</label>
}

function hexToRgb(hex: string): [number, number, number] {
  const m = hex.replace('#', '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  if (!m) return [0, 0, 0]
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255]
}

const inp: React.CSSProperties = {
  width: '100%', padding: '5px 8px', fontSize: 12,
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
const xBtn: React.CSSProperties = {
  background: 'transparent', border: 'none', color: 'var(--text-primary)',
  cursor: 'pointer', fontSize: 18,
}
