import { useEffect, useState, type CSSProperties } from 'react'
import {
  listShortcuts,
  setOverride,
  clearAllOverrides,
  formatBinding,
  findActionByBinding,
  type KeyBinding,
  type ShortcutEntry,
  type ShortcutId,
} from '../../lib/shortcuts'

interface Props {
  onClose: () => void
}

/** Custom keyboard shortcuts panel. Click any binding to enter rebind
 *  mode — the next non-modifier keypress becomes the new binding.
 *  Escape cancels rebind. Conflicts (the new binding is already used
 *  by another action) show an inline warning; the user can confirm
 *  to overwrite. Per-row "↺" resets to default; "Reset all" clears
 *  every customization. */
export default function ShortcutsPanel({ onClose }: Props) {
  const [entries, setEntries] = useState<ShortcutEntry[]>(() => listShortcuts())
  const [rebinding, setRebinding] = useState<ShortcutId | null>(null)
  // Tracks the live keypress when a user is in rebind mode, so the
  // chip shows "Press a key…" until they press something. Cleared
  // when rebind mode exits.
  const [conflict, setConflict] = useState<{ id: ShortcutId; collidesWith: ShortcutId; binding: KeyBinding } | null>(null)

  // Refresh the snapshot from localStorage. Called after any mutation.
  const refresh = () => setEntries(listShortcuts())

  useEffect(() => {
    if (!rebinding) return
    const handler = (e: KeyboardEvent) => {
      // Cancel on Escape.
      if (e.key === 'Escape') {
        e.preventDefault()
        setRebinding(null)
        setConflict(null)
        return
      }
      // Modifier-only events (Ctrl held alone) — wait for the actual key.
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return
      e.preventDefault()
      e.stopPropagation()

      const binding: KeyBinding = {
        ctrl: e.ctrlKey || e.metaKey,
        shift: e.shiftKey,
        alt: e.altKey,
        key: e.key,
      }
      const collidesWith = findActionByBinding(binding, rebinding)
      if (collidesWith) {
        setConflict({ id: rebinding, collidesWith, binding })
        // Don't apply yet — surface conflict to user.
        return
      }
      setOverride(rebinding, binding)
      setRebinding(null)
      setConflict(null)
      refresh()
    }
    // Capture-phase so we beat the global registerGlobalShortcuts
    // listener in shortcuts.ts (it would otherwise fire the action
    // we're trying to rebind).
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [rebinding])

  const acceptConflict = () => {
    if (!conflict) return
    // Clear the colliding action's binding (so the user has to rebind
    // it manually), then apply the new binding.
    setOverride(conflict.collidesWith, { ctrl: false, shift: false, alt: false, key: '' })
    setOverride(conflict.id, conflict.binding)
    setRebinding(null)
    setConflict(null)
    refresh()
  }

  const cancelConflict = () => {
    setRebinding(null)
    setConflict(null)
  }

  return (
    <>
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(0,0,0,0.4)' }}
      />
      <div
        data-testid="shortcuts-panel"
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 520,
          maxHeight: '80vh',
          background: 'var(--bg-surface)',
          border: '1px solid var(--line-strong)',
          borderRadius: 12,
          boxShadow: 'var(--shadow-lg)',
          zIndex: 61,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '14px 18px',
            borderBottom: '1px solid var(--line)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'var(--bg-chrome)',
          }}
        >
          <div className="os-serif" style={{ fontSize: 17, fontWeight: 500, letterSpacing: -0.3 }}>
            Keyboard shortcuts
          </div>
          <button
            data-testid="shortcuts-close"
            onClick={onClose}
            style={{
              width: 26,
              height: 26,
              padding: 0,
              background: 'transparent',
              border: 'none',
              fontSize: 18,
              color: 'var(--ink-3)',
              cursor: 'pointer',
              borderRadius: 4,
            }}
            title="Close"
          >
            ×
          </button>
        </div>

        {/* Conflict banner (only shown during a conflict) */}
        {conflict && (
          <div
            data-testid="shortcuts-conflict"
            style={{
              padding: '10px 14px',
              background: 'var(--accent-tint)',
              borderBottom: '1px solid var(--accent)',
              fontSize: 12,
              color: 'var(--ink)',
            }}
          >
            <div style={{ marginBottom: 6 }}>
              <strong>{formatBinding(conflict.binding)}</strong> is already
              bound to{' '}
              <strong>{entries.find((e) => e.id === conflict.collidesWith)?.label}</strong>.
              Use it for <strong>{entries.find((e) => e.id === conflict.id)?.label}</strong> instead?
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                data-testid="shortcuts-conflict-overwrite"
                onClick={acceptConflict}
                style={{
                  padding: '4px 10px',
                  fontSize: 11,
                  borderRadius: 4,
                  background: 'var(--accent)',
                  color: 'var(--bg-primary)',
                  border: 'none',
                  cursor: 'pointer',
                  fontWeight: 600,
                }}
              >
                Use here, clear there
              </button>
              <button
                data-testid="shortcuts-conflict-cancel"
                onClick={cancelConflict}
                style={{
                  padding: '4px 10px',
                  fontSize: 11,
                  borderRadius: 4,
                  background: 'var(--bg-surface)',
                  color: 'var(--ink-2)',
                  border: '1px solid var(--line)',
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Shortcut list */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '6px 0' }}>
          {entries.map((e) => {
            const isRebinding = rebinding === e.id
            return (
              <div
                key={e.id}
                data-testid={`shortcuts-row-${e.id}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '8px 18px',
                  borderBottom: '1px solid var(--line)',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--ink)' }}>
                    {e.label}
                  </div>
                  <div style={{ fontSize: 10.5, color: 'var(--ink-3)' }}>
                    {e.description}
                  </div>
                </div>
                <button
                  data-testid={`shortcuts-bind-${e.id}`}
                  onClick={() => {
                    setRebinding(e.id)
                    setConflict(null)
                  }}
                  style={{
                    minWidth: 110,
                    padding: '4px 10px',
                    fontSize: 11,
                    fontFamily: '"JetBrains Mono", monospace',
                    background: isRebinding ? 'var(--accent)' : 'var(--bg-sunken)',
                    color: isRebinding ? 'var(--bg-primary)' : e.isCustomized ? 'var(--accent)' : 'var(--ink-2)',
                    border: `1px solid ${isRebinding ? 'var(--accent)' : 'var(--line)'}`,
                    borderRadius: 4,
                    cursor: 'pointer',
                    textAlign: 'center',
                    fontWeight: e.isCustomized ? 600 : 400,
                  }}
                  title={e.isCustomized ? 'Click to rebind (customized)' : 'Click to rebind'}
                >
                  {isRebinding
                    ? 'Press a key…'
                    : e.effectiveBinding.key === ''
                    ? '— unbound'
                    : formatBinding(e.effectiveBinding)}
                </button>
                <button
                  data-testid={`shortcuts-reset-${e.id}`}
                  onClick={() => {
                    setOverride(e.id, null)
                    refresh()
                  }}
                  disabled={!e.isCustomized}
                  title="Reset to default"
                  style={{
                    width: 26,
                    height: 26,
                    padding: 0,
                    fontSize: 14,
                    background: 'transparent',
                    border: 'none',
                    color: e.isCustomized ? 'var(--ink-2)' : 'var(--ink-4)',
                    cursor: e.isCustomized ? 'pointer' : 'not-allowed',
                    opacity: e.isCustomized ? 1 : 0.3,
                    borderRadius: 4,
                  }}
                >
                  ↺
                </button>
              </div>
            )
          })}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '10px 18px',
            borderTop: '1px solid var(--line)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'var(--bg-chrome)',
          }}
        >
          <div className="os-mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: 0.4 }}>
            {entries.filter((e) => e.isCustomized).length}/{entries.length} customized
          </div>
          <button
            data-testid="shortcuts-reset-all"
            onClick={() => {
              clearAllOverrides()
              refresh()
            }}
            disabled={!entries.some((e) => e.isCustomized)}
            style={{
              padding: '5px 12px',
              fontSize: 11,
              borderRadius: 4,
              background: 'var(--bg-surface)',
              color: 'var(--ink-2)',
              border: '1px solid var(--line)',
              cursor: entries.some((e) => e.isCustomized) ? 'pointer' : 'not-allowed',
              opacity: entries.some((e) => e.isCustomized) ? 1 : 0.5,
            }}
          >
            Reset all to defaults
          </button>
        </div>
      </div>
    </>
  )
}

// Re-export so the module is single-path-importable.
export type { ShortcutId, KeyBinding, ShortcutEntry } from '../../lib/shortcuts'
export const _styles: { panel: CSSProperties } = {
  panel: { display: 'block' },
}
