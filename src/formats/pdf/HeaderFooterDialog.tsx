import { useState, useRef } from 'react'
import { useFormatStore } from '../../stores/formatStore'
import { useTabStore } from '../../stores/tabStore'
import type { PdfFormatState, HeaderFooterConfig } from './index'

interface Props {
  tabId: string
  onClose: () => void
}

const TOKENS = ['{page}', '{pages}', '{date}', '{time}', '{filename}'] as const

const FONTS = ['Helvetica', 'Times', 'Courier'] as const

const defaultConfig: HeaderFooterConfig = {
  headerLeft: '', headerCenter: '', headerRight: '',
  footerLeft: '', footerCenter: 'Page {page} of {pages}', footerRight: '',
  fontFamily: 'Helvetica', fontSize: 10, color: '#000000',
  applyTo: 'all', marginTop: 20, marginBottom: 20
}

export default function HeaderFooterDialog({ tabId, onClose }: Props) {
  const existing = useFormatStore.getState().getFormatState<PdfFormatState>(tabId)?.headerFooter
  const [config, setConfig] = useState<HeaderFooterConfig>(existing ?? defaultConfig)
  const lastFocusedRef = useRef<HTMLInputElement | null>(null)

  const labelStyle: React.CSSProperties = {
    fontSize: 11, color: 'var(--text-secondary)', display: 'block', marginBottom: 4
  }
  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '5px 6px', fontSize: 11,
    background: 'var(--bg-surface)', border: '1px solid var(--border)',
    borderRadius: 3, color: 'var(--text-primary)', boxSizing: 'border-box'
  }
  const radioLabelStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 6, fontSize: 12,
    color: 'var(--text-primary)', cursor: 'pointer'
  }

  const update = (partial: Partial<HeaderFooterConfig>) => {
    setConfig(prev => ({ ...prev, ...partial }))
  }

  const insertToken = (token: string) => {
    const input = lastFocusedRef.current
    if (!input) return
    const start = input.selectionStart ?? input.value.length
    const end = input.selectionEnd ?? input.value.length
    const newVal = input.value.slice(0, start) + token + input.value.slice(end)
    const fieldName = input.dataset.field as keyof HeaderFooterConfig
    if (fieldName) {
      update({ [fieldName]: newVal } as any)
      // Restore cursor position after React re-render
      setTimeout(() => {
        input.focus()
        const pos = start + token.length
        input.setSelectionRange(pos, pos)
      }, 0)
    }
  }

  const handleApply = () => {
    useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, prev => ({
      ...prev, headerFooter: config
    }))
    useTabStore.getState().setTabDirty(tabId, true)
    onClose()
  }

  const resolveToken = (text: string): string => {
    return text
      .replace(/\{page\}/g, '1')
      .replace(/\{pages\}/g, '5')
      .replace(/\{date\}/g, new Date().toLocaleDateString())
      .replace(/\{time\}/g, new Date().toLocaleTimeString())
      .replace(/\{filename\}/g, 'document.pdf')
  }

  type ZoneKey = 'headerLeft' | 'headerCenter' | 'headerRight' | 'footerLeft' | 'footerCenter' | 'footerRight'

  // Stable testid mapping for the zone keys. The headerLeft → hf-header-left
  // form is the contract the comprehensive-test-runner manifest references.
  const zoneTestids: Record<ZoneKey, string> = {
    headerLeft: 'hf-header-left',
    headerCenter: 'hf-header-center',
    headerRight: 'hf-header-right',
    footerLeft: 'hf-footer-left',
    footerCenter: 'hf-footer-center',
    footerRight: 'hf-footer-right',
  }

  const zoneInput = (field: ZoneKey, placeholder: string) => (
    <input
      data-testid={zoneTestids[field]}
      data-field={field}
      value={config[field]}
      onChange={(e) => update({ [field]: e.target.value } as any)}
      onFocus={(e) => { lastFocusedRef.current = e.target as HTMLInputElement }}
      placeholder={placeholder}
      style={inputStyle}
    />
  )

  return (
    <div data-testid="header-footer-dialog" style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
    }}>
      <div style={{
        background: 'var(--bg-primary)', borderRadius: 8, padding: 24,
        border: '1px solid var(--border)', minWidth: 520, maxWidth: 580
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>Headers &amp; Footers</h3>
          <button data-testid="hf-close" onClick={onClose} style={{ fontSize: 18, background: 'transparent', border: 'none', color: 'var(--text-primary)', cursor: 'pointer' }}>
            &#x2715;
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Zone grid */}
          <div>
            <label style={labelStyle}>Header</label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
              {zoneInput('headerLeft', 'Left')}
              {zoneInput('headerCenter', 'Center')}
              {zoneInput('headerRight', 'Right')}
            </div>
          </div>

          <div>
            <label style={labelStyle}>Footer</label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
              {zoneInput('footerLeft', 'Left')}
              {zoneInput('footerCenter', 'Center')}
              {zoneInput('footerRight', 'Right')}
            </div>
          </div>

          {/* Token buttons */}
          <div>
            <label style={labelStyle}>Insert Token (click to insert at cursor)</label>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {TOKENS.map((t) => (
                <button key={t} onClick={() => insertToken(t)}
                  style={{
                    padding: '3px 8px', fontSize: 10, borderRadius: 3,
                    background: 'var(--bg-surface)', border: '1px solid var(--border)',
                    color: 'var(--text-primary)', cursor: 'pointer', fontFamily: 'monospace'
                  }}>
                  {t}
                </button>
              ))}
            </div>
          </div>

          {/* Font options row */}
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>Font Family</label>
              <select value={config.fontFamily} onChange={(e) => update({ fontFamily: e.target.value })}
                style={{ width: '100%', padding: '5px 6px', fontSize: 12 }}>
                {FONTS.map((f) => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
            </div>
            <div style={{ width: 70 }}>
              <label style={labelStyle}>Size (pt)</label>
              <input type="number" min={6} max={24} value={config.fontSize}
                onChange={(e) => update({ fontSize: Number(e.target.value) })}
                style={{ ...inputStyle, width: '100%' }} />
            </div>
            <div style={{ width: 40 }}>
              <label style={labelStyle}>Color</label>
              <input type="color" value={config.color}
                onChange={(e) => update({ color: e.target.value })}
                style={{ width: 36, height: 28, border: 'none', cursor: 'pointer', padding: 0 }} />
            </div>
          </div>

          {/* Apply to */}
          <div>
            <label style={labelStyle}>Apply to</label>
            <div style={{ display: 'flex', gap: 16 }}>
              <label style={radioLabelStyle}>
                <input data-testid="hf-apply-to-all" type="radio" name="hf-apply" checked={config.applyTo === 'all'}
                  onChange={() => update({ applyTo: 'all' })} />
                All pages
              </label>
              <label style={radioLabelStyle}>
                <input data-testid="hf-apply-to-odd" type="radio" name="hf-apply" checked={config.applyTo === 'odd'}
                  onChange={() => update({ applyTo: 'odd' })} />
                Odd pages only
              </label>
              <label style={radioLabelStyle}>
                <input data-testid="hf-apply-to-even" type="radio" name="hf-apply" checked={config.applyTo === 'even'}
                  onChange={() => update({ applyTo: 'even' })} />
                Even pages only
              </label>
            </div>
          </div>

          {/* Margins */}
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>Margin from top edge (pt)</label>
              <input type="number" min={5} max={100} value={config.marginTop}
                onChange={(e) => update({ marginTop: Number(e.target.value) })}
                style={{ ...inputStyle, width: '100%' }} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>Margin from bottom edge (pt)</label>
              <input type="number" min={5} max={100} value={config.marginBottom}
                onChange={(e) => update({ marginBottom: Number(e.target.value) })}
                style={{ ...inputStyle, width: '100%' }} />
            </div>
          </div>

          {/* Preview */}
          <div>
            <label style={labelStyle}>Preview</label>
            <div style={{
              background: '#ffffff', borderRadius: 4, border: '1px solid var(--border)',
              padding: 8, height: 120, display: 'flex', flexDirection: 'column',
              justifyContent: 'space-between', position: 'relative'
            }}>
              {/* Header preview row */}
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
                fontFamily: config.fontFamily === 'Courier' ? 'Courier, monospace'
                  : config.fontFamily === 'Times' ? '"Times New Roman", Times, serif'
                  : 'Helvetica, Arial, sans-serif',
                fontSize: Math.min(config.fontSize * 0.8, 11), color: config.color
              }}>
                <span>{resolveToken(config.headerLeft)}</span>
                <span>{resolveToken(config.headerCenter)}</span>
                <span>{resolveToken(config.headerRight)}</span>
              </div>

              {/* Page body placeholder */}
              <div style={{
                flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center'
              }}>
                <div style={{
                  width: '60%', display: 'flex', flexDirection: 'column', gap: 3
                }}>
                  {[1, 2, 3, 4].map(i => (
                    <div key={i} style={{
                      height: 3, background: '#e0e0e0', borderRadius: 1,
                      width: i === 4 ? '40%' : '100%'
                    }} />
                  ))}
                </div>
              </div>

              {/* Footer preview row */}
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
                fontFamily: config.fontFamily === 'Courier' ? 'Courier, monospace'
                  : config.fontFamily === 'Times' ? '"Times New Roman", Times, serif'
                  : 'Helvetica, Arial, sans-serif',
                fontSize: Math.min(config.fontSize * 0.8, 11), color: config.color
              }}>
                <span>{resolveToken(config.footerLeft)}</span>
                <span>{resolveToken(config.footerCenter)}</span>
                <span>{resolveToken(config.footerRight)}</span>
              </div>
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button data-testid="hf-cancel" onClick={onClose}
            style={{ padding: '8px 16px', background: 'var(--bg-surface)', borderRadius: 4, border: 'none', color: 'var(--text-primary)', cursor: 'pointer' }}>
            Cancel
          </button>
          <button data-testid="hf-apply" onClick={handleApply}
            style={{
              padding: '8px 16px', background: 'var(--accent)',
              color: 'var(--bg-primary)', borderRadius: 4, fontWeight: 600, border: 'none', cursor: 'pointer'
            }}>
            Apply
          </button>
        </div>
      </div>
    </div>
  )
}
