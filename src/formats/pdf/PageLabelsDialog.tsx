import { useState } from 'react'
import { useFormatStore } from '../../stores/formatStore'
import { useTabStore } from '../../stores/tabStore'
import type { PdfFormatState } from './index'
import { setPageLabels, type PageLabelRange, type PageLabelStyle } from '../../services/pdfOps'

interface Props {
  tabId: string
  onClose: () => void
}

interface UiRange {
  from: number      // 1-based display
  style: PageLabelStyle
  prefix: string
  start: number
}

/** Page labels editor — write the PDF's /PageLabels dict so front
 *  matter gets roman numerals, body gets decimals, etc. Mirrors
 *  Acrobat's Organize > More > Page Labels. */
export default function PageLabelsDialog({ tabId, onClose }: Props) {
  const state = useFormatStore((s) => s.data[tabId] as PdfFormatState | undefined)
  const [ranges, setRanges] = useState<UiRange[]>([
    { from: 1, style: 'r', prefix: '', start: 1 },
  ])
  const [status, setStatus] = useState('')

  if (!state) return null
  const totalPages = state.pages.filter((p) => !p.deleted).length

  const update = (i: number, patch: Partial<UiRange>) => {
    setRanges((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  }
  const add = () => {
    const lastFrom = ranges[ranges.length - 1]?.from ?? 0
    setRanges([...ranges, { from: Math.min(totalPages, lastFrom + 1), style: 'D', prefix: '', start: 1 }])
  }
  const remove = (i: number) => {
    setRanges(ranges.filter((_, idx) => idx !== i))
  }
  const save = async () => {
    try {
      const sorted = [...ranges].sort((a, b) => a.from - b.from)
      const serviceRanges: PageLabelRange[] = sorted.map((r) => ({
        from: Math.max(0, r.from - 1),
        style: r.style,
        prefix: r.prefix || undefined,
        start: r.start,
      }))
      const bytes = await setPageLabels(state.pdfBytes, serviceRanges)
      useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({ ...prev, pdfBytes: bytes }))
      useTabStore.getState().setTabDirty(tabId, true)
      setStatus(`Wrote ${sorted.length} label range${sorted.length === 1 ? '' : 's'}.`)
      setTimeout(onClose, 500)
    } catch (e) {
      setStatus(e instanceof Error ? `Error: ${e.message}` : 'Failed')
    }
  }

  const preview = (r: UiRange, n: number): string => {
    if (r.style === 'D') return `${r.prefix}${n}`
    if (r.style === 'R' || r.style === 'r') {
      const roman = toRoman(n)
      return `${r.prefix}${r.style === 'r' ? roman.toLowerCase() : roman}`
    }
    const letters = toLetter(n)
    return `${r.prefix}${r.style === 'a' ? letters.toLowerCase() : letters}`
  }

  return (
    <div
      data-testid="page-labels-dialog"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: 'var(--bg-primary)', borderRadius: 8, padding: 20,
        border: '1px solid var(--border)', width: 560,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>Page Labels</h3>
          <button onClick={onClose} style={{ background:'transparent', border:'none', color:'var(--text-primary)', cursor:'pointer', fontSize:18 }}>✕</button>
        </div>

        <p style={{ margin: '0 0 12px 0', fontSize: 11, color: 'var(--text-secondary)' }}>
          Each range defines how pages starting at <em>From</em> are labeled. Example:
          <br />• Front matter: pages 1-5 → i, ii, iii, iv, v (style=roman lower)
          <br />• Body: pages 6-end → 1, 2, 3… (style=decimal, Start at=1)
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {ranges.map((r, i) => (
            <div key={i} data-testid={`range-${i}`}
              style={{
                display: 'grid',
                gridTemplateColumns: '60px 120px 1fr 60px 120px 30px',
                gap: 6, alignItems: 'center', padding: 6,
                border: '1px solid var(--border)', borderRadius: 4,
                background: 'var(--bg-surface)',
              }}>
              <input data-testid={`range-from-${i}`} type="number" min={1} max={totalPages}
                value={r.from} onChange={(e) => update(i, { from: Number(e.target.value) })}
                style={inp} title="First page (1-based)" />
              <select data-testid={`range-style-${i}`} value={r.style}
                onChange={(e) => update(i, { style: e.target.value as PageLabelStyle })}
                style={inp}>
                <option value="D">1, 2, 3 (decimal)</option>
                <option value="R">I, II, III (roman UC)</option>
                <option value="r">i, ii, iii (roman lc)</option>
                <option value="A">A, B, C (letter UC)</option>
                <option value="a">a, b, c (letter lc)</option>
              </select>
              <input data-testid={`range-prefix-${i}`} type="text"
                value={r.prefix} placeholder="Prefix (optional)"
                onChange={(e) => update(i, { prefix: e.target.value })}
                style={inp} />
              <input data-testid={`range-start-${i}`} type="number" min={1}
                value={r.start} onChange={(e) => update(i, { start: Number(e.target.value) })}
                style={inp} title="Number to start at" />
              <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                {preview(r, r.start)}…
              </div>
              <button onClick={() => remove(i)} disabled={ranges.length === 1}
                style={{ background:'transparent', border:'none', color:'var(--danger)', cursor:ranges.length > 1 ? 'pointer':'not-allowed', padding:0, fontSize:14, opacity:ranges.length > 1 ? 1 : 0.3 }}>✕</button>
            </div>
          ))}
        </div>

        {status && (
          <div data-testid="labels-status" style={{
            marginTop: 10, padding: 6, background: 'var(--bg-surface)', borderRadius: 3,
            fontSize: 11, color: 'var(--text-primary)',
          }}>{status}</div>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 14 }}>
          <button data-testid="labels-add-range" onClick={add}
            style={{ padding:'6px 12px', background:'var(--bg-surface)', color:'var(--text-primary)', border:'1px solid var(--border)', borderRadius:4, cursor:'pointer', fontSize:11 }}>
            + Add range
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onClose} style={{
              padding:'6px 16px', background:'var(--bg-surface)', color:'var(--text-primary)',
              border:'1px solid var(--border)', borderRadius:4, cursor:'pointer', fontSize:12,
            }}>Cancel</button>
            <button data-testid="labels-apply" onClick={save} style={{
              padding:'6px 16px', background:'var(--accent)', color:'var(--bg-primary)',
              border:'none', borderRadius:4, cursor:'pointer', fontSize:12, fontWeight:600,
            }}>Apply labels</button>
          </div>
        </div>
      </div>
    </div>
  )
}

function toRoman(n: number): string {
  const m = [['M', 1000], ['CM', 900], ['D', 500], ['CD', 400], ['C', 100], ['XC', 90], ['L', 50], ['XL', 40], ['X', 10], ['IX', 9], ['V', 5], ['IV', 4], ['I', 1]] as const
  let out = '', k = n
  for (const [s, v] of m) { while (k >= v) { out += s; k -= v } }
  return out
}
function toLetter(n: number): string {
  let out = '', k = n
  while (k > 0) { const r = (k - 1) % 26; out = String.fromCharCode(65 + r) + out; k = Math.floor((k - 1) / 26) }
  return out
}

const inp: React.CSSProperties = {
  padding: '5px 8px', fontSize: 11,
  background: 'var(--bg-primary)', border: '1px solid var(--border)',
  borderRadius: 3, color: 'var(--text-primary)', boxSizing: 'border-box',
  width: '100%',
}
