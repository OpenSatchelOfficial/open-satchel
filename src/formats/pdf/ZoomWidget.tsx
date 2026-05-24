import { useEffect, useRef, useState } from 'react'
import { useUIStore } from '../../stores/uiStore'

const PRESETS = [
  { label: 'Fit Width', value: 'fit-width' as const },
  { label: 'Fit Page', value: 'fit-page' as const },
  { label: '50%', value: 0.5 },
  { label: '75%', value: 0.75 },
  { label: '100%', value: 1.0 },
  { label: '125%', value: 1.25 },
  { label: '150%', value: 1.5 },
  { label: '200%', value: 2.0 },
  { label: '300%', value: 3.0 },
  { label: '400%', value: 4.0 },
]

/** Floating zoom widget at bottom-right of the PDF viewer.
 *  Mirrors Acrobat's zoom control: − / pct / +, with a dropdown for
 *  presets including fit-width and fit-page. Fit modes measure the
 *  container and compute scale once; user can still scroll & +/− from
 *  there.
 */
export default function ZoomWidget({ containerRef }: { containerRef: React.RefObject<HTMLElement | null> }) {
  const zoom = useUIStore((s) => s.zoom)
  const setZoom = useUIStore((s) => s.setZoom)
  const zoomIn = useUIStore((s) => s.zoomIn)
  const zoomOut = useUIStore((s) => s.zoomOut)
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (btnRef.current && !btnRef.current.parentElement?.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const applyPreset = (v: typeof PRESETS[number]['value']) => {
    setOpen(false)
    if (v === 'fit-width') {
      const container = containerRef.current
      if (!container) return
      const page = container.querySelector('[data-page-display-index]') as HTMLElement | null
      if (!page) return
      const pageBaseWidth = page.getBoundingClientRect().width / zoom
      const available = container.clientWidth - 40
      setZoom(Math.max(0.25, Math.min(4.0, available / pageBaseWidth)))
    } else if (v === 'fit-page') {
      const container = containerRef.current
      if (!container) return
      const page = container.querySelector('[data-page-display-index]') as HTMLElement | null
      if (!page) return
      const rect = page.getBoundingClientRect()
      const pageBaseWidth = rect.width / zoom
      const pageBaseHeight = rect.height / zoom
      const availW = container.clientWidth - 40
      const availH = container.clientHeight - 40
      const scale = Math.min(availW / pageBaseWidth, availH / pageBaseHeight)
      setZoom(Math.max(0.25, Math.min(4.0, scale)))
    } else {
      setZoom(v)
    }
  }

  return (
    <div style={{
      position: 'absolute', bottom: 14, right: 14, zIndex: 50,
      display: 'flex', alignItems: 'center', gap: 2,
      background: 'var(--bg-primary)', border: '1px solid var(--border)',
      borderRadius: 20, padding: '2px 4px', boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
      fontSize: 12,
    }}>
      <ZBtn label="−" onClick={zoomOut} title="Zoom out" />
      <button
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        style={{
          minWidth: 56, padding: '4px 8px', background: 'transparent',
          border: 'none', color: 'var(--text-primary)', cursor: 'pointer',
          fontSize: 12, fontVariantNumeric: 'tabular-nums',
        }}
        title="Set zoom"
      >
        {Math.round(zoom * 100)}%
      </button>
      <ZBtn label="+" onClick={zoomIn} title="Zoom in" />
      {open && (
        <div style={{
          position: 'absolute', bottom: '100%', right: 0, marginBottom: 6,
          background: 'var(--bg-primary)', border: '1px solid var(--border)',
          borderRadius: 6, boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
          minWidth: 120, padding: 4, display: 'flex', flexDirection: 'column', gap: 1,
        }}>
          {PRESETS.map((p) => (
            <button key={p.label} onClick={() => applyPreset(p.value)} style={{
              textAlign: 'left', padding: '4px 10px', fontSize: 11,
              background: 'transparent', border: 'none',
              color: 'var(--text-primary)', cursor: 'pointer', borderRadius: 3,
            }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function ZBtn({ label, onClick, title }: { label: string; onClick: () => void; title: string }) {
  return (
    <button onClick={onClick} title={title} style={{
      width: 24, height: 24, padding: 0, background: 'transparent',
      border: 'none', color: 'var(--text-primary)', cursor: 'pointer',
      fontSize: 14, fontWeight: 600, borderRadius: 12,
    }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
    >
      {label}
    </button>
  )
}
