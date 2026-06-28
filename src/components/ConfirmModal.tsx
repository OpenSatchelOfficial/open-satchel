import { useEffect } from 'react'
import { useUIStore } from '../stores/uiStore'

/** Blocking in-app confirmation modal. Replaces window.confirm, which the
 *  packaged WebView2 build silently suppresses — so destructive-action
 *  warnings (e.g. the redaction "no undo" prompt) would otherwise never reach
 *  the user. Driven by uiStore.confirmDialog (set by requestConfirm); the
 *  buttons resolve the awaiting promise via resolveConfirm(true|false).
 *  Mounted once at the App root. */
export default function ConfirmModal() {
  const dialog = useUIStore((s) => s.confirmDialog)
  const resolveConfirm = useUIStore((s) => s.resolveConfirm)

  useEffect(() => {
    if (!dialog) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        resolveConfirm(false)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        resolveConfirm(true)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [dialog, resolveConfirm])

  if (!dialog) return null
  const danger = dialog.tone === 'danger'

  return (
    <div
      data-testid="confirm-modal"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.7)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 2000,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) resolveConfirm(false)
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        style={{
          width: 460,
          maxWidth: '90vw',
          background: 'var(--bg-primary)',
          border: '1px solid var(--border)',
          borderTop: `3px solid ${danger ? 'var(--bad)' : 'var(--warn)'}`,
          borderRadius: 8,
          padding: 22,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          boxShadow: 'var(--shadow-lg)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 18 }}>{danger ? '⚠️' : '❓'}</span>
          <h3 style={{ margin: 0, fontSize: 15, color: 'var(--text-primary)' }}>{dialog.title}</h3>
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.6, whiteSpace: 'pre-line' }}>
          {dialog.message}
        </div>
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 4 }}>
          <button
            data-testid="confirm-modal-cancel"
            onClick={() => resolveConfirm(false)}
            style={{
              padding: '6px 14px',
              fontSize: 12,
              borderRadius: 4,
              background: 'var(--bg-surface)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border)',
              cursor: 'pointer',
            }}
          >
            {dialog.cancelLabel}
          </button>
          <button
            data-testid="confirm-modal-confirm"
            onClick={() => resolveConfirm(true)}
            autoFocus
            style={{
              padding: '6px 14px',
              fontSize: 12,
              fontWeight: 600,
              borderRadius: 4,
              background: danger ? 'var(--bad)' : 'var(--accent)',
              color: 'var(--bg-primary)',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            {dialog.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
