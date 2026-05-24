import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { useUIStore } from '../../stores/uiStore'
import { I } from '../icons'
import type { AccentName, DensityName, LayoutMode, ThemeName } from '../../types/pdf'
import ShortcutsPanel from './ShortcutsPanel'
import { getLocale, setLocale, SUPPORTED_LOCALES, type Locale } from '../../lib/i18n'
import { isFullscreen, setFullscreen } from '../../lib/fullscreen'

const ACCENT_SWATCHES: { id: AccentName; label: string; hex: string }[] = [
  { id: 'amber',  label: 'Burnt amber', hex: 'oklch(66% 0.155 52)' },
  { id: 'forest', label: 'Forest',      hex: 'oklch(52% 0.13 155)' },
  { id: 'iris',   label: 'Iris',        hex: 'oklch(56% 0.16 290)' },
  { id: 'ink',    label: 'Ink',         hex: 'oklch(28% 0.02 260)' },
]

/** In-app Preferences flyout — anchored under the gear button on the
 *  toolbar. Closes on Escape or click-outside. Writes directly to
 *  uiStore so changes persist for the session and show up in any
 *  other UI surface that reads the same state. */
export default function PreferencesFlyout({ onClose }: { onClose: () => void }) {
  const theme = useUIStore((s) => s.theme)
  const setTheme = useUIStore((s) => s.setTheme)
  const accent = useUIStore((s) => s.accent)
  const setAccent = useUIStore((s) => s.setAccent)
  const density = useUIStore((s) => s.density)
  const setDensity = useUIStore((s) => s.setDensity)
  const layout = useUIStore((s) => s.layout)
  const setLayout = useUIStore((s) => s.setLayout)
  const showAnnotationGutter = useUIStore((s) => s.showAnnotationGutter)
  const setShowAnnotationGutter = useUIStore((s) => s.setShowAnnotationGutter)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [locale, setLocaleState] = useState<Locale>(() => getLocale())
  // Fullscreen lives on the OS window (Tauri owns it), so we read it
  // on mount + sync to the segmented control. Polling once on mount is
  // enough since the user changes it from THIS panel; if they hit
  // Alt+Enter while the panel is open, the visual will lag by 1 click
  // — acceptable trade vs adding a window-event listener.
  const [windowMode, setWindowMode] = useState<'window' | 'fullscreen'>('window')
  useEffect(() => {
    void isFullscreen().then((fs) => setWindowMode(fs ? 'fullscreen' : 'window'))
  }, [])
  const changeWindowMode = (mode: 'window' | 'fullscreen') => {
    setWindowMode(mode)
    void setFullscreen(mode === 'fullscreen')
  }
  const changeLocale = (loc: Locale) => {
    setLocale(loc)
    setLocaleState(loc)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <>
      {/* Click-out scrim */}
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, zIndex: 40 }}
      />
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute',
          top: 'calc(100% + 8px)',
          right: 0,
          width: 320,
          background: 'var(--bg-surface)',
          border: '1px solid var(--line-strong)',
          borderRadius: 10,
          boxShadow: 'var(--shadow-lg)',
          zIndex: 50,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '12px 14px 10px',
            borderBottom: '1px solid var(--line)',
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            background: 'var(--bg-chrome)',
          }}
        >
          <div
            className="os-serif"
            style={{ fontSize: 16, fontWeight: 500, letterSpacing: -0.3 }}
          >
            Preferences
          </div>
          <div
            className="os-mono"
            style={{
              fontSize: 9.5,
              color: 'var(--ink-3)',
              letterSpacing: 0.6,
              textTransform: 'uppercase',
            }}
          >
            Ctrl+,
          </div>
        </div>

        <PrefSection label="Appearance">
          <PrefRow label="Mode">
            <SegGroup<ThemeName>
              value={theme}
              onChange={setTheme}
              options={[
                { value: 'light', icon: <I.Sun size={13} />, label: 'Light' },
                { value: 'dark',  icon: <I.Moon size={13} />, label: 'Dark' },
              ]}
            />
          </PrefRow>

          <PrefRow label="Accent" stack>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {ACCENT_SWATCHES.map((s) => {
                const active = accent === s.id
                return (
                  <button
                    key={s.id}
                    onClick={() => setAccent(s.id)}
                    title={s.label}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      height: 26,
                      padding: '0 9px 0 6px',
                      border: `1px solid ${active ? 'var(--line-strong)' : 'var(--line)'}`,
                      borderRadius: 999,
                      background: active ? 'var(--bg-active)' : 'var(--bg-surface)',
                      cursor: 'pointer',
                      fontSize: 11,
                      color: 'var(--ink-2)',
                    }}
                  >
                    <span
                      style={{
                        width: 14,
                        height: 14,
                        borderRadius: 999,
                        background: s.hex,
                        boxShadow: 'inset 0 0 0 1px rgba(0,0,0,.18)',
                      }}
                    />
                    <span>{s.label}</span>
                  </button>
                )
              })}
            </div>
          </PrefRow>
        </PrefSection>

        <PrefSection label="Layout">
          <PrefRow
            label="PDF layout"
            hint="Ribbon = chip tabs · Tool rail = slim 10-tool rail + ⌘K launcher"
            stack
          >
            <SegGroup<LayoutMode>
              value={layout}
              onChange={setLayout}
              options={[
                { value: 'ribbon', label: 'Ribbon' },
                { value: 'rail',   label: 'Tool rail' },
              ]}
            />
          </PrefRow>

          <PrefRow label="Density">
            <SegGroup<DensityName>
              value={density}
              onChange={setDensity}
              options={[
                { value: 'compact',  label: 'Compact' },
                { value: 'balanced', label: 'Balanced' },
                { value: 'roomy',    label: 'Roomy' },
              ]}
            />
          </PrefRow>

          <PrefRow label="Annotation gutter" hint="Stable column for comments &amp; replies">
            <Switch value={showAnnotationGutter} onChange={setShowAnnotationGutter} />
          </PrefRow>

          <PrefRow label="Window mode" hint="Alt+Enter toggles">
            <SegGroup<'window' | 'fullscreen'>
              value={windowMode}
              onChange={changeWindowMode}
              options={[
                { value: 'window',     icon: <I.Window size={13} />,     label: 'Window' },
                { value: 'fullscreen', icon: <I.Fullscreen size={13} />, label: 'Full' },
              ]}
            />
          </PrefRow>
        </PrefSection>

        <PrefSection label="Language">
          <PrefRow label="UI language" hint="Reload to apply everywhere">
            <select
              data-testid="prefs-locale"
              value={locale}
              onChange={(e) => changeLocale(e.target.value as Locale)}
              style={{
                padding: '4px 8px',
                fontSize: 11,
                borderRadius: 4,
                background: 'var(--bg-surface)',
                color: 'var(--ink-2)',
                border: '1px solid var(--line)',
                cursor: 'pointer',
              }}
            >
              {SUPPORTED_LOCALES.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
          </PrefRow>
        </PrefSection>

        <PrefSection label="Shortcuts">
          <PrefRow label="Keyboard shortcuts" hint="Customize global key bindings">
            <button
              data-testid="prefs-open-shortcuts"
              onClick={() => setShortcutsOpen(true)}
              style={{
                padding: '5px 12px',
                fontSize: 11,
                borderRadius: 4,
                background: 'var(--bg-surface)',
                color: 'var(--ink-2)',
                border: '1px solid var(--line)',
                cursor: 'pointer',
              }}
            >
              Customize…
            </button>
          </PrefRow>
        </PrefSection>

        <div
          style={{
            padding: '9px 14px',
            borderTop: '1px solid var(--line)',
            background: 'var(--bg-sunken)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: 11,
            color: 'var(--ink-3)',
          }}
        >
          <span>Synced across all open documents</span>
          <span className="os-mono" style={{ fontSize: 10, letterSpacing: 0.4 }}>
            v0.1.0
          </span>
        </div>
      </div>
      {shortcutsOpen && <ShortcutsPanel onClose={() => setShortcutsOpen(false)} />}
    </>
  )
}

function PrefSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ padding: '10px 14px 12px', borderBottom: '1px solid var(--line)' }}>
      <div
        className="os-mono"
        style={{
          fontSize: 9.5,
          letterSpacing: 0.7,
          textTransform: 'uppercase',
          color: 'var(--ink-3)',
          marginBottom: 8,
        }}
      >
        {label}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>{children}</div>
    </div>
  )
}

function PrefRow({
  label,
  hint,
  stack,
  children,
}: {
  label: string
  hint?: string
  stack?: boolean
  children: ReactNode
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: stack ? 'column' : 'row',
        alignItems: stack ? 'stretch' : 'center',
        justifyContent: 'space-between',
        gap: stack ? 7 : 12,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, color: 'var(--ink)', lineHeight: 1.2 }}>{label}</div>
        {hint && (
          <div
            style={{
              fontSize: 10.5,
              color: 'var(--ink-3)',
              marginTop: 2,
              lineHeight: 1.3,
            }}
            dangerouslySetInnerHTML={{ __html: hint }}
          />
        )}
      </div>
      <div style={{ flexShrink: 0 }}>{children}</div>
    </div>
  )
}

interface SegOption<T> {
  value: T
  label: string
  icon?: ReactNode
}

function SegGroup<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (v: T) => void
  options: SegOption<T>[]
}) {
  return (
    <div
      style={{
        display: 'inline-flex',
        border: '1px solid var(--line)',
        borderRadius: 7,
        background: 'var(--bg-sunken)',
        padding: 2,
        gap: 2,
      }}
    >
      {options.map((o) => {
        const active = value === o.value
        const style: CSSProperties = {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          height: 22,
          padding: '0 9px',
          border: 'none',
          borderRadius: 5,
          background: active ? 'var(--bg-surface)' : 'transparent',
          boxShadow: active
            ? '0 1px 2px rgba(0,0,0,.06), 0 0 0 1px var(--line)'
            : 'none',
          color: active ? 'var(--ink)' : 'var(--ink-2)',
          fontSize: 11,
          cursor: 'pointer',
        }
        return (
          <button key={String(o.value)} onClick={() => onChange(o.value)} style={style}>
            {o.icon && <span style={{ display: 'inline-flex' }}>{o.icon}</span>}
            <span>{o.label}</span>
          </button>
        )
      })}
    </div>
  )
}

function Switch({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!value)}
      role="switch"
      aria-checked={value}
      style={{
        width: 32,
        height: 18,
        borderRadius: 999,
        border: '1px solid var(--line)',
        background: value ? 'var(--accent)' : 'var(--bg-sunken)',
        position: 'relative',
        cursor: 'pointer',
        padding: 0,
        transition: 'background 120ms ease',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 1,
          left: value ? 15 : 1,
          width: 14,
          height: 14,
          borderRadius: 999,
          background: 'var(--bg-surface)',
          boxShadow: '0 1px 2px rgba(0,0,0,.2)',
          transition: 'left 120ms ease',
        }}
      />
    </button>
  )
}
