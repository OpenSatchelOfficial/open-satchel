import { useState, useMemo } from 'react'
import { PAGE_SIZES, getPageSizeName } from '../../constants/pageSizes'
import { useFormatStore } from '../../stores/formatStore'
import { useTabStore } from '../../stores/tabStore'
import { useUIStore } from '../../stores/uiStore'
import type { PdfFormatState } from './index'

type Unit = 'pt' | 'mm' | 'in'

function toPoints(value: number, unit: Unit): number {
  switch (unit) {
    case 'mm': return value * (72 / 25.4)
    case 'in': return value * 72
    case 'pt': return value
  }
}

function fromPoints(pts: number, unit: Unit): number {
  switch (unit) {
    case 'mm': return pts / (72 / 25.4)
    case 'in': return pts / 72
    case 'pt': return pts
  }
}

function roundTo(n: number, decimals: number): number {
  const f = Math.pow(10, decimals)
  return Math.round(n * f) / f
}

interface Props {
  tabId: string
  onClose: () => void
}

export default function PageSizeDialog({ tabId, onClose }: Props) {
  const state = useFormatStore.getState().getFormatState<PdfFormatState>(tabId)
  const currentPage = useUIStore((s) => s.currentPage)

  // Get current page dimensions for defaults
  const currentPageState = state?.pages[currentPage]
  const defaultW = currentPageState?.pageSize?.width ?? 595
  const defaultH = currentPageState?.pageSize?.height ?? 842

  const detectedSize = getPageSizeName(defaultW, defaultH)

  const [selectedSize, setSelectedSize] = useState<string>(detectedSize ?? 'Custom')
  const [widthPt, setWidthPt] = useState(defaultW)
  const [heightPt, setHeightPt] = useState(defaultH)
  const [unit, setUnit] = useState<Unit>('mm')
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>(
    defaultW <= defaultH ? 'portrait' : 'landscape'
  )
  const [applyTo, setApplyTo] = useState<'current' | 'all'>('current')

  const sizeNames = [...Object.keys(PAGE_SIZES), 'Custom']

  const handleSizeChange = (name: string) => {
    setSelectedSize(name)
    if (name !== 'Custom') {
      const size = PAGE_SIZES[name]
      if (orientation === 'landscape') {
        setWidthPt(Math.max(size.width, size.height))
        setHeightPt(Math.min(size.width, size.height))
      } else {
        setWidthPt(Math.min(size.width, size.height))
        setHeightPt(Math.max(size.width, size.height))
      }
    }
  }

  const handleOrientationToggle = (o: 'portrait' | 'landscape') => {
    setOrientation(o)
    if (o === 'landscape' && widthPt < heightPt) {
      setWidthPt(heightPt)
      setHeightPt(widthPt)
    } else if (o === 'portrait' && widthPt > heightPt) {
      setWidthPt(heightPt)
      setHeightPt(widthPt)
    }
  }

  const displayW = roundTo(fromPoints(widthPt, unit), 2)
  const displayH = roundTo(fromPoints(heightPt, unit), 2)

  const handleWidthChange = (val: number) => {
    const pts = Math.round(toPoints(val, unit))
    setWidthPt(pts)
    setSelectedSize('Custom')
  }

  const handleHeightChange = (val: number) => {
    const pts = Math.round(toPoints(val, unit))
    setHeightPt(pts)
    setSelectedSize('Custom')
  }

  // Preview aspect ratio
  const previewMaxW = 120
  const previewMaxH = 150
  const aspect = widthPt / heightPt
  let previewW: number, previewH: number
  if (aspect > previewMaxW / previewMaxH) {
    previewW = previewMaxW
    previewH = previewMaxW / aspect
  } else {
    previewH = previewMaxH
    previewW = previewMaxH * aspect
  }

  const handleApply = () => {
    if (!state) return

    useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({
      ...prev,
      pages: prev.pages.map((p, i) => {
        if (applyTo === 'current' && i !== currentPage) return p
        return {
          ...p,
          pageSize: { width: widthPt, height: heightPt }
        }
      })
    }))

    useTabStore.getState().setTabDirty(tabId, true)
    onClose()
  }

  const inputStyle: React.CSSProperties = {
    width: 70,
    fontSize: 11,
    padding: '3px 6px',
    background: 'var(--bg-surface)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border)',
    borderRadius: 3,
    outline: 'none'
  }

  const labelStyle: React.CSSProperties = {
    fontSize: 11,
    color: 'var(--text-secondary)',
    marginBottom: 4
  }

  const btnStyle: React.CSSProperties = {
    padding: '2px 6px',
    fontSize: 11,
    borderRadius: 3,
    background: 'var(--bg-surface)',
    color: 'var(--text-secondary)',
    border: 'none',
    cursor: 'pointer'
  }

  const activeBtnStyle: React.CSSProperties = {
    ...btnStyle,
    background: 'var(--accent)',
    color: '#1e1e2e'
  }

  return (
    <div data-testid="page-size-dialog" style={{
      position: 'fixed',
      inset: 0,
      background: 'rgba(0,0,0,0.5)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 2000
    }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: 'var(--bg-primary)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 20,
        minWidth: 380,
        maxWidth: 460,
        boxShadow: '0 8px 24px rgba(0,0,0,0.5)'
      }}>
        <h3 style={{ margin: '0 0 16px', fontSize: 14, color: 'var(--text-primary)' }}>
          Page Size
        </h3>

        <div style={{ display: 'flex', gap: 20 }}>
          {/* Left: controls */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* Size preset */}
            <div>
              <div style={labelStyle}>Size</div>
              <select
                data-testid="ps-preset"
                value={selectedSize}
                onChange={(e) => handleSizeChange(e.target.value)}
                style={{
                  ...inputStyle,
                  width: '100%'
                }}
              >
                {sizeNames.map((name) => (
                  <option key={name} value={name}>
                    {name === 'Custom' ? 'Custom' : `${name} - ${PAGE_SIZES[name].label}`}
                  </option>
                ))}
              </select>
            </div>

            {/* Orientation */}
            <div>
              <div style={labelStyle}>Orientation</div>
              <div style={{ display: 'flex', gap: 4 }}>
                <button
                  data-testid="ps-portrait"
                  style={orientation === 'portrait' ? activeBtnStyle : btnStyle}
                  onClick={() => handleOrientationToggle('portrait')}
                >Portrait</button>
                <button
                  data-testid="ps-landscape"
                  style={orientation === 'landscape' ? activeBtnStyle : btnStyle}
                  onClick={() => handleOrientationToggle('landscape')}
                >Landscape</button>
              </div>
            </div>

            {/* Width / Height */}
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
              <div>
                <div style={labelStyle}>Width</div>
                <input
                  data-testid="ps-width"
                  type="number"
                  value={displayW}
                  onChange={(e) => handleWidthChange(Number(e.target.value))}
                  style={inputStyle}
                  step={unit === 'pt' ? 1 : 0.1}
                  min={1}
                />
              </div>
              <div>
                <div style={labelStyle}>Height</div>
                <input
                  data-testid="ps-height"
                  type="number"
                  value={displayH}
                  onChange={(e) => handleHeightChange(Number(e.target.value))}
                  style={inputStyle}
                  step={unit === 'pt' ? 1 : 0.1}
                  min={1}
                />
              </div>
              <div>
                <select
                  data-testid="ps-unit"
                  value={unit}
                  onChange={(e) => setUnit(e.target.value as Unit)}
                  style={{ ...inputStyle, width: 50 }}
                >
                  <option value="mm">mm</option>
                  <option value="in">in</option>
                  <option value="pt">pt</option>
                </select>
              </div>
            </div>

            {/* Apply to */}
            <div>
              <div style={labelStyle}>Apply to</div>
              <div style={{ display: 'flex', gap: 4 }}>
                <button
                  data-testid="ps-apply-current"
                  style={applyTo === 'current' ? activeBtnStyle : btnStyle}
                  onClick={() => setApplyTo('current')}
                >Current page</button>
                <button
                  data-testid="ps-apply-all"
                  style={applyTo === 'all' ? activeBtnStyle : btnStyle}
                  onClick={() => setApplyTo('all')}
                >All pages</button>
              </div>
            </div>
          </div>

          {/* Right: preview */}
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            minWidth: 140
          }}>
            <div style={labelStyle}>Preview</div>
            <div style={{
              width: previewW,
              height: previewH,
              border: '2px solid var(--accent)',
              borderRadius: 2,
              background: 'var(--bg-surface)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}>
              <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>
                {Math.round(widthPt)} x {Math.round(heightPt)} pt
              </span>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={btnStyle}>Cancel</button>
          <button data-testid="ps-apply" onClick={handleApply} style={activeBtnStyle}>Apply</button>
        </div>
      </div>
    </div>
  )
}
