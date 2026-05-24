import { useState } from 'react'
import { useFormatStore } from '../../stores/formatStore'
import { useTabStore } from '../../stores/tabStore'
import type { PdfFormatState } from './index'
import { addPageNumbers } from '../../services/pdfConvert'

interface Props {
  tabId: string
  onClose: () => void
}

type Position = 'header-left' | 'header-center' | 'header-right' | 'footer-left' | 'footer-center' | 'footer-right'
type Style = 'decimal' | 'roman-lower' | 'roman-upper' | 'letter-lower' | 'letter-upper'

/** Quick page-numbering dialog. Wraps pdfConvert.addPageNumbers. */
export default function PageNumbersDialog({ tabId, onClose }: Props) {
  const state = useFormatStore((s) => s.data[tabId] as PdfFormatState | undefined)
  const [prefix, setPrefix] = useState('Page ')
  const [suffix, setSuffix] = useState(' of {total}')
  const [start, setStart] = useState(1)
  const [style, setStyle] = useState<Style>('decimal')
  const [position, setPosition] = useState<Position>('footer-center')
  const [fontSize, setFontSize] = useState(10)
  const [color, setColor] = useState('#000000')
  const [rangeFrom, setRangeFrom] = useState(1)
  const [rangeTo, setRangeTo] = useState<number | ''>('')
  const [status, setStatus] = useState('')
  const [running, setRunning] = useState(false)

  if (!state) return null

  const totalPages = state.pages.filter((p) => !p.deleted).length

  const styleToRange = (s: Style): 'D' | 'r' | 'R' | 'a' | 'A' => {
    switch (s) {
      case 'decimal': return 'D'
      case 'roman-lower': return 'r'
      case 'roman-upper': return 'R'
      case 'letter-lower': return 'a'
      case 'letter-upper': return 'A'
    }
  }

  const formatNumber = (n: number, s: Style): string => {
    if (s === 'decimal') return String(n)
    if (s === 'roman-lower') return toRoman(n).toLowerCase()
    if (s === 'roman-upper') return toRoman(n)
    if (s === 'letter-lower') return toLetter(n).toLowerCase()
    return toLetter(n)
  }

  const preview = `${prefix}${formatNumber(start, style)}${suffix.replace('{total}', String(totalPages))}`

  const run = async () => {
    setRunning(true)
    setStatus('Applying…')
    try {
      const to = rangeTo === '' ? totalPages : Math.min(Number(rangeTo), totalPages)
      const pageIndices = Array.from({ length: Math.max(0, to - rangeFrom + 1) }, (_, i) => rangeFrom - 1 + i)
      const [vertPos, horizPos] = position.split('-') as [string, 'left' | 'center' | 'right']
      const bytes = await addPageNumbers(state.pdfBytes, {
        prefix, suffix, start,
        style: styleToRange(style),
        position: vertPos === 'header' ? 'top' : 'bottom',
        alignment: horizPos,
        fontSize, color: hexToRgb(color),
        pageIndices,
      })
      useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({ ...prev, pdfBytes: bytes }))
      useTabStore.getState().setTabDirty(tabId, true)
      setStatus(`Applied page numbers to ${pageIndices.length} page${pageIndices.length === 1 ? '' : 's'}.`)
      // Auto-close after a beat so the user sees the status flash and
      // headless tests can wait on dialog closure as the apply signal.
      setTimeout(onClose, 500)
    } catch (e) {
      setStatus(e instanceof Error ? `Error: ${e.message}` : 'Failed')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div
      data-testid="page-numbers-dialog"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: 'var(--bg-primary)', borderRadius: 8, padding: 20,
        border: '1px solid var(--border)', width: 500,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>Page Numbers</h3>
          <button onClick={onClose} style={xBtn}>✕</button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <Label>Prefix</Label>
              <input data-testid="pagenum-prefix" style={inp} value={prefix} onChange={(e) => setPrefix(e.target.value)} />
            </div>
            <div style={{ flex: 1 }}>
              <Label>Suffix (use {'{total}'})</Label>
              <input data-testid="pagenum-suffix" style={inp} value={suffix} onChange={(e) => setSuffix(e.target.value)} />
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <Label>Style</Label>
              <select data-testid="pagenum-style" style={inp} value={style} onChange={(e) => setStyle(e.target.value as Style)}>
                <option value="decimal">1, 2, 3, 4</option>
                <option value="roman-upper">I, II, III, IV</option>
                <option value="roman-lower">i, ii, iii, iv</option>
                <option value="letter-upper">A, B, C, D</option>
                <option value="letter-lower">a, b, c, d</option>
              </select>
            </div>
            <div style={{ width: 80 }}>
              <Label>Start at</Label>
              <input data-testid="pagenum-start" type="number" min={1} style={inp} value={start} onChange={(e) => setStart(Number(e.target.value))} />
            </div>
            <div style={{ width: 60 }}>
              <Label>Size</Label>
              <input type="number" min={6} max={36} style={inp} value={fontSize} onChange={(e) => setFontSize(Number(e.target.value))} />
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
                  data-testid={`pagenum-pos-${p}`}
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

          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <div style={{ flex: 1 }}>
              <Label>From page</Label>
              <input data-testid="pagenum-from" type="number" min={1} max={totalPages} style={inp}
                value={rangeFrom} onChange={(e) => setRangeFrom(Number(e.target.value))} />
            </div>
            <div style={{ flex: 1 }}>
              <Label>To page (blank = end)</Label>
              <input data-testid="pagenum-to" type="number" min={rangeFrom} max={totalPages} style={inp}
                value={rangeTo} placeholder={String(totalPages)}
                onChange={(e) => setRangeTo(e.target.value === '' ? '' : Number(e.target.value))} />
            </div>
          </div>

          <div style={{
            padding: 8, background: 'var(--bg-surface)', borderRadius: 4,
            fontSize: 11, color: 'var(--text-secondary)',
          }}>
            Preview: <strong data-testid="pagenum-preview" style={{ color: 'var(--text-primary)' }}>{preview}</strong>
          </div>
        </div>

        {status && (
          <div data-testid="pagenum-status" style={{
            marginTop: 10, padding: 6, background: 'var(--bg-surface)', borderRadius: 3,
            fontSize: 11, color: 'var(--text-primary)',
          }}>{status}</div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button onClick={onClose} style={btnSecondary}>Cancel</button>
          <button data-testid="pagenum-apply" onClick={run} disabled={running} style={btnPrimary}>
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

function toRoman(n: number): string {
  const m = [['M', 1000], ['CM', 900], ['D', 500], ['CD', 400], ['C', 100], ['XC', 90], ['L', 50], ['XL', 40], ['X', 10], ['IX', 9], ['V', 5], ['IV', 4], ['I', 1]] as const
  let out = ''
  for (const [s, v] of m) { while (n >= v) { out += s; n -= v } }
  return out
}

function toLetter(n: number): string {
  let out = ''
  while (n > 0) {
    const r = (n - 1) % 26
    out = String.fromCharCode(65 + r) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
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
