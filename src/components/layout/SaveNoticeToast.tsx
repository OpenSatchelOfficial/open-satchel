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

  return (
    <div
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
        alignItems: 'center',
        gap: 10,
        fontSize: 12,
        color: 'var(--ink)',
        maxWidth: 520,
      }}
    >
      <span style={{ flex: 1 }}>{notice.message}</span>
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
