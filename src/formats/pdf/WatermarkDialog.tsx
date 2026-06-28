import { useState } from 'react'

interface Props {
  onClose: () => void
  onApply: (text: string, options: WatermarkOptions) => void
  onUnbake?: (text: string) => void
}

export interface WatermarkOptions {
  fontSize: number
  color: string
  opacity: number
  angle: number
  position: 'center' | 'diagonal'
  applyTo: 'all' | 'odd' | 'even'
}

export default function WatermarkDialog({ onClose, onApply, onUnbake }: Props) {
  const [text, setText] = useState('CONFIDENTIAL')
  const [fontSize, setFontSize] = useState(48)
  const [color, setColor] = useState('#888888')
  const [opacity, setOpacity] = useState(0.3)
  const [angle, setAngle] = useState(-45)
  const [applyTo, setApplyTo] = useState<'all' | 'odd' | 'even'>('all')

  return (
    <div data-testid="watermark-dialog" style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
    }}>
      <div style={{
        background: 'var(--bg-primary)', borderRadius: 8, padding: 24,
        border: '1px solid var(--border)', minWidth: 380
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>Add Watermark</h3>
          <button onClick={onClose} style={{ fontSize: 18 }}>✕</button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label style={{ fontSize: 11, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>Text</label>
            <input data-testid="wm-text" value={text} onChange={(e) => setText(e.target.value)}
              style={{ width: '100%', padding: '6px 8px' }} />
          </div>

          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 11, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>Font Size</label>
              <input data-testid="wm-fontsize" type="number" value={fontSize} onChange={(e) => setFontSize(Number(e.target.value))}
                min={12} max={120} style={{ width: '100%', padding: '6px 8px' }} />
            </div>
            <div>
              <label style={{ fontSize: 11, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>Color</label>
              <input data-testid="wm-color" type="color" value={color} onChange={(e) => setColor(e.target.value)}
                style={{ width: 40, height: 32, border: 'none', cursor: 'pointer' }} />
            </div>
          </div>

          <div>
            <label style={{ fontSize: 11, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>
              Opacity: {Math.round(opacity * 100)}%
            </label>
            <input data-testid="wm-opacity" type="range" min={5} max={100} value={Math.round(opacity * 100)}
              onChange={(e) => setOpacity(Number(e.target.value) / 100)}
              style={{ width: '100%', accentColor: 'var(--accent)' }} />
          </div>

          <div>
            <label style={{ fontSize: 11, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>
              Angle: {angle}°
            </label>
            <input data-testid="wm-angle" type="range" min={-90} max={90} value={angle}
              onChange={(e) => setAngle(Number(e.target.value))}
              style={{ width: '100%', accentColor: 'var(--accent)' }} />
          </div>

          <div>
            <label style={{ fontSize: 11, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>Apply to</label>
            <select data-testid="wm-applyto" value={applyTo} onChange={(e) => setApplyTo(e.target.value as 'all' | 'odd' | 'even')}
              style={{ width: '100%', padding: '6px 8px' }}>
              <option value="all">All pages</option>
              <option value="odd">Odd pages (1, 3, 5…)</option>
              <option value="even">Even pages (2, 4, 6…)</option>
            </select>
          </div>

          {/* Preview */}
          <div style={{
            height: 80, background: '#fff', borderRadius: 4, display: 'flex',
            alignItems: 'center', justifyContent: 'center', overflow: 'hidden'
          }}>
            <span style={{
              fontSize: Math.min(fontSize * 0.4, 28), color, opacity,
              fontWeight: 'bold', fontFamily: 'Impact, sans-serif',
              transform: `rotate(${angle}deg)`, userSelect: 'none'
            }}>
              {text}
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 16 }}>
          {onUnbake && (
            <button
              data-testid="wm-unbake"
              onClick={() => onUnbake(text)}
              disabled={!text.trim()}
              style={{
                padding: '8px 12px',
                background: 'var(--bg-surface)',
                color: text.trim() ? 'var(--danger)' : 'var(--text-muted)',
                border: `1px solid ${text.trim() ? 'var(--danger)' : 'var(--border)'}`,
                borderRadius: 4,
                fontSize: 12,
                cursor: text.trim() ? 'pointer' : 'not-allowed',
              }}
              title="Strip BT...ET text blocks containing this text from every page (G5: un-bake watermark text from already-baked content streams). Best-effort - works for Helvetica/standard-14 watermarks like Open Satchel's pd-lib drawText path emits."
            >
              Remove this text from PDF
            </button>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onClose} style={{ padding: '8px 16px', background: 'var(--bg-surface)', borderRadius: 4 }}>
              Cancel
            </button>
            <button
              data-testid="wm-apply"
              onClick={() => onApply(text, { fontSize, color, opacity, angle, position: 'center', applyTo })}
              style={{ padding: '8px 16px', background: 'var(--accent)', color: 'var(--bg-primary)', borderRadius: 4, fontWeight: 600 }}
            >
              Apply
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
