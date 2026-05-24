import { useEffect, useRef, useState, type ReactNode, type CSSProperties } from 'react'

interface Props {
  /** What the tooltip describes — title, body, and an optional
   *  shortcut hint formatted as e.g. 'Ctrl+S'. */
  title: string
  description?: string
  shortcut?: string
  /** The trigger element. Tooltip wraps it via a span so the wrapper
   *  inherits the trigger's outer flow. */
  children: ReactNode
  /** Hover delay in ms before the tooltip appears. Default 500. */
  delay?: number
  /** Auto-position above (default) or below the trigger. */
  side?: 'top' | 'bottom'
  /** Disable on touch devices to avoid stuck tooltips after taps. */
  disableOnTouch?: boolean
}

/** Rich tooltip with title + optional description + optional kbd
 *  hint. Hovers ≥`delay` ms before showing. Auto-positions via
 *  client-rect math; if the tooltip would overflow the viewport
 *  it flips side. Used selectively on ribbon buttons where the
 *  native title= attribute can't carry rich content (multi-line,
 *  shortcut chip, etc.). For buttons with simple labels, native
 *  title= is still preferred — it's free + accessible. */
export default function Tooltip({
  title,
  description,
  shortcut,
  children,
  delay = 500,
  side = 'top',
  disableOnTouch = true,
}: Props) {
  const [visible, setVisible] = useState(false)
  const [coords, setCoords] = useState<{ x: number; y: number; effectiveSide: 'top' | 'bottom' } | null>(null)
  const wrapRef = useRef<HTMLSpanElement>(null)
  const timerRef = useRef<number | null>(null)

  const cancel = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  const showSoon = () => {
    cancel()
    timerRef.current = window.setTimeout(() => {
      const el = wrapRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const tooltipMargin = 6
      let effectiveSide: 'top' | 'bottom' = side
      // If preferred side would clip, flip.
      if (side === 'top' && r.top < 60) effectiveSide = 'bottom'
      if (side === 'bottom' && r.bottom + 60 > window.innerHeight) effectiveSide = 'top'
      const y = effectiveSide === 'top' ? r.top - tooltipMargin : r.bottom + tooltipMargin
      const x = r.left + r.width / 2
      setCoords({ x, y, effectiveSide })
      setVisible(true)
    }, delay)
  }

  const hide = () => {
    cancel()
    setVisible(false)
  }

  useEffect(() => {
    return () => cancel()
  }, [])

  const handleTouch = () => {
    if (disableOnTouch) return
    showSoon()
  }

  return (
    <>
      <span
        ref={wrapRef}
        onMouseEnter={showSoon}
        onMouseLeave={hide}
        onFocus={showSoon}
        onBlur={hide}
        onTouchStart={handleTouch}
        style={{ display: 'inline-flex' }}
      >
        {children}
      </span>
      {visible && coords && (
        <div
          role="tooltip"
          data-testid="tooltip"
          style={{
            ...tooltipStyle,
            position: 'fixed',
            left: coords.x,
            top: coords.y,
            transform:
              coords.effectiveSide === 'top'
                ? 'translate(-50%, -100%)'
                : 'translate(-50%, 0)',
          }}
        >
          <div style={titleStyle}>{title}</div>
          {description && <div style={descStyle}>{description}</div>}
          {shortcut && (
            <div style={kbdRowStyle}>
              {shortcut.split('+').map((part, i, arr) => (
                <span key={i} style={{ display: 'inline-flex', alignItems: 'center' }}>
                  <kbd style={kbdStyle}>{part}</kbd>
                  {i < arr.length - 1 && <span style={kbdSepStyle}>+</span>}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  )
}

const tooltipStyle: CSSProperties = {
  zIndex: 1000,
  background: 'var(--ink)',
  color: 'var(--bg-surface)',
  padding: '8px 12px',
  borderRadius: 6,
  fontSize: 11.5,
  lineHeight: 1.35,
  maxWidth: 260,
  pointerEvents: 'none',
  boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
  whiteSpace: 'normal',
}

const titleStyle: CSSProperties = {
  fontWeight: 600,
  marginBottom: 2,
}

const descStyle: CSSProperties = {
  opacity: 0.85,
  fontSize: 10.5,
}

const kbdRowStyle: CSSProperties = {
  marginTop: 6,
  display: 'flex',
  gap: 1,
  flexWrap: 'wrap',
}

const kbdStyle: CSSProperties = {
  fontFamily: '"JetBrains Mono", monospace',
  fontSize: 9.5,
  padding: '2px 6px',
  background: 'rgba(255,255,255,0.12)',
  borderRadius: 3,
  border: '1px solid rgba(255,255,255,0.2)',
  color: 'inherit',
}

const kbdSepStyle: CSSProperties = {
  fontSize: 10,
  opacity: 0.6,
  margin: '0 2px',
}
