import { useEffect, useRef } from 'react'
import './DialogBase.css'

interface DialogBaseProps {
  open: boolean
  onClose: () => void
  title: string
  subtitle?: string
  icon?: React.ReactNode
  /** Dialog width in px. Default 460. Larger dialogs (e.g. FormDesigner)
   *  can pass 720 or similar. */
  width?: number
  /** Optional footer. When omitted, callers can render their own
   *  actions inline in `children`. */
  footer?: React.ReactNode
  /** Small metadata text at the bottom-left of the footer (e.g.
   *  "AES-256 · open-source crypto"). */
  footerMeta?: React.ReactNode
  'data-testid'?: string
  children: React.ReactNode
}

/** Shared dialog chrome for every modal in the app.
 *
 * Replaces the ad-hoc fixed-inset-overlay pattern that every dialog
 * was inlining. One consistent look:
 *   - Soft pop-in animation (~250ms)
 *   - Header: icon glyph + title + subtitle + close X
 *   - Body: caller-provided content
 *   - Footer (optional): meta on the left, actions on the right
 *   - Scrim: 55% opacity + 8px backdrop blur
 *
 * Closes on:
 *   - Scrim click (outside the panel)
 *   - Esc key
 *   - Caller-invoked `onClose()`
 */
export default function DialogBase({
  open,
  onClose,
  title,
  subtitle,
  icon,
  width = 460,
  footer,
  footerMeta,
  'data-testid': testId,
  children,
}: DialogBaseProps) {
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="os-dialog-scrim"
      data-testid={testId}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        className="os-dialog-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="os-dialog-title"
        style={{ width }}
      >
        <div className="os-dialog-head">
          {icon && <div className="os-dialog-icon-wrap">{icon}</div>}
          <div className="os-dialog-titles">
            <h3 id="os-dialog-title">{title}</h3>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button
            className="os-dialog-close"
            type="button"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="os-dialog-body">{children}</div>
        {(footer || footerMeta) && (
          <div className="os-dialog-footer">
            <span className="os-dialog-footer-meta">{footerMeta}</span>
            <div className="os-dialog-footer-acts">{footer}</div>
          </div>
        )}
      </div>
    </div>
  )
}
