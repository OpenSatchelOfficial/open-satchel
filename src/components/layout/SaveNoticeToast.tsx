import { useEffect } from 'react'
import { useUIStore } from '../../stores/uiStore'
import { I } from '../icons'

const TONE_COLOR: Record<string, string> = {
  info: 'var(--accent)',
  success: 'var(--good)',
  warn: 'var(--warn)',
  error: 'var(--bad)',
}

/** Floating toast for save / command-launcher status messages.
 *
 *  Reads `saveNotice` from uiStore (set by `setSaveNotice`). Auto-clears
 *  when expiresAt elapses; manual close-X provided too. The toast sits
 *  at bottom-centre above all chrome — z-index 200, above the launcher
 *  modal so a tool-launch confirmation can flash on top. */
export default function SaveNoticeToast() {
  const notice = useUIStore((s) => s.saveNotice)
  const setSaveNotice = useUIStore((s) => s.setSaveNotice)

  useEffect(() => {
    if (!notice) return
    const remaining = notice.expiresAt - Date.now()
    if (remaining <= 0) {
      setSaveNotice(null)
      return
    }
    const t = setTimeout(() => setSaveNotice(null), remaining)
    return () => clearTimeout(t)
  }, [notice, setSaveNotice])

  if (!notice) return null

  const toneColor = TONE_COLOR[notice.tone] ?? TONE_COLOR.info
  const items = notice.items && notice.items.length > 0 ? notice.items : null

  // Session-1 channel: when structured items are present, render ALL
  // of them stacked — the old single-string toast could only ever
  // show the first of two simultaneous degradations. Security items
  // get the --bad accent + a SECURITY prefix so they can't be read
  // past; info items ride as full lines only when explicitly
  // toast-visible, the rest arrive pre-collapsed via hiddenInfoCount.
  const SEVERITY_COLOR: Record<string, string> = {
    security: 'var(--bad)',
    fidelity: 'var(--warn)',
    info: 'var(--accent)',
  }

  return (
    <div
      data-testid="save-notice-toast"
      style={{
        position: 'fixed',
        bottom: 36,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 200,
        padding: '8px 12px 8px 14px',
        background: 'var(--bg-surface)',
        border: '1px solid var(--line-strong)',
        borderLeft: `3px solid ${toneColor}`,
        borderRadius: 8,
        boxShadow: 'var(--shadow-lg)',
        display: 'flex',
        alignItems: items ? 'flex-start' : 'center',
        gap: 10,
        fontSize: 12,
        color: 'var(--ink)',
        maxWidth: 520,
      }}
    >
      {items ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {items.map((item, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
              <span
                aria-hidden
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: item.severity === 'security' ? 2 : '50%',
                  background: SEVERITY_COLOR[item.severity] ?? 'var(--accent)',
                  flexShrink: 0,
                  alignSelf: 'center',
                }}
              />
              <span style={{ fontWeight: item.severity === 'security' ? 700 : 400 }}>
                {item.severity === 'security' && (
                  <span style={{ color: 'var(--bad)', marginRight: 4 }}>SECURITY:</span>
                )}
                {item.message}
              </span>
            </div>
          ))}
          {(notice.hiddenInfoCount ?? 0) > 0 && (
            <div style={{ color: 'var(--ink-3)', fontSize: 11 }}>
              +{notice.hiddenInfoCount} info notice{notice.hiddenInfoCount === 1 ? '' : 's'} in the save report
            </div>
          )}
        </div>
      ) : (
        <span style={{ flex: 1 }}>{notice.message}</span>
      )}
      {notice.action && (
        <button
          data-testid="save-notice-action"
          onClick={() => {
            notice.action?.run()
            setSaveNotice(null)
          }}
          style={{
            padding: '5px 10px',
            fontSize: 11,
            fontWeight: 600,
            borderRadius: 5,
            border: '1px solid var(--line-strong)',
            background: 'var(--accent)',
            color: 'var(--bg-primary)',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            alignSelf: 'center',
          }}
        >
          {notice.action.label}
        </button>
      )}
      <button
        onClick={() => setSaveNotice(null)}
        title="Dismiss"
        style={{
          width: 20,
          height: 20,
          display: 'grid',
          placeItems: 'center',
          border: 'none',
          background: 'transparent',
          color: 'var(--ink-3)',
          borderRadius: 3,
          cursor: 'pointer',
        }}
      >
        <I.Close size={11} />
      </button>
    </div>
  )
}
