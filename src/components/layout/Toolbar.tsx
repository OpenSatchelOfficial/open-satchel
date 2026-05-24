import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { useTabStore } from '../../stores/tabStore'
import { useUIStore } from '../../stores/uiStore'
import { useHistoryStore } from '../../stores/historyStore'
import { openFile, saveActiveTab } from '../../lib/actions'
import { undo as doUndo, redo as doRedo } from '../../lib/undo-redo'
import { I } from '../icons'
import Logo from '../Logo'
import PreferencesFlyout from './PreferencesFlyout'
import Tooltip from '../Tooltip'
import { getEffectiveBinding, formatBinding, type ShortcutId } from '../../lib/shortcuts'
import OnboardingTour, { resetTourCompletion } from '../OnboardingTour'
import AboutDialog from '../AboutDialog'
import { t } from '../../lib/i18n'
import { useLocale } from '../../hooks/useLocale'

/** Top-level chrome — slim 36px-tall band with brand, file ops, the
 *  doc breadcrumb in the centre, and right-aligned find/sidebar/prefs.
 *  The breadcrumb shows the active tab's path + filename + dirty pip;
 *  on the empty state the centre stays blank. */
export default function Toolbar({ extraRight }: { extraRight?: ReactNode } = {}) {
  const tabs = useTabStore((s) => s.tabs)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const active = tabs.find((t) => t.id === activeTabId)

  const sidebarOpen = useUIStore((s) => s.sidebarOpen)
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  const openFind = useUIStore((s) => s.openFind)

  const [prefsOpen, setPrefsOpen] = useState(false)
  const [tourOpen, setTourOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  // Subscribe to locale changes so t() lookups in this render pick
  // up the new strings the moment the user switches language.
  useLocale()

  // Reactive undo/redo button enable state. Reads stack lengths from
  // historyStore via a Zustand subscription so the buttons enable
  // and disable in real time as the user makes / unwinds edits.
  const [canUndo, setCanUndo] = useState(useHistoryStore.getState().undoStack.length > 0)
  const [canRedo, setCanRedo] = useState(useHistoryStore.getState().redoStack.length > 0)
  useEffect(() => {
    const update = () => {
      const s = useHistoryStore.getState()
      setCanUndo(s.undoStack.length > 0)
      setCanRedo(s.redoStack.length > 0)
    }
    update()
    return useHistoryStore.subscribe(update)
  }, [])

  return (
    <div
      style={{
        gridColumn: '1 / -1',
        height: 'var(--toolbar-h)',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '0 10px',
        background: 'var(--bg-chrome)',
        borderBottom: '1px solid var(--line)',
        position: 'relative',
        zIndex: 5,
      }}
    >
      {/* Brand */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span style={{ color: 'var(--accent)', display: 'inline-flex' }}>
          <Logo size={16} />
        </span>
        <span
          className="os-serif"
          style={{ fontSize: 14, fontWeight: 500, letterSpacing: -0.2 }}
        >
          Open Satchel
        </span>
      </div>

      <div className="os-divider" style={{ height: 16, marginInline: 4 }} />

      <ToolbarBtn
        icon={<I.Open />}
        label={t('toolbar.open')}
        kbd={formatBinding(getEffectiveBinding('file.open'))}
        description="Open a PDF from disk."
        onClick={() => void openFile()}
      />
      <ToolbarBtn
        icon={<I.Save />}
        label={t('toolbar.save')}
        kbd={formatBinding(getEffectiveBinding('file.save'))}
        description="Save the active tab to its current path."
        disabled={!activeTabId}
        onClick={() => void saveActiveTab()}
      />

      {/* Physical undo / redo buttons. Sit immediately right of Save
       *  so they're easy to reach one-handed. Disabled state mirrors
       *  the historyStore so users see at a glance whether there's
       *  anything to undo. The keyboard equivalents (Ctrl+Z /
       *  Ctrl+Shift+Z) still work — these are the visible affordance.
       */}
      <ToolbarBtn
        icon={<I.Undo />}
        label="Undo"
        kbd={formatBinding(getEffectiveBinding('edit.undo'))}
        description="Revert the last action."
        disabled={!canUndo}
        subtle
        testId="toolbar-undo"
        onClick={() => { doUndo() }}
      />
      <ToolbarBtn
        icon={<I.Redo />}
        label="Redo"
        kbd={formatBinding(getEffectiveBinding('edit.redo'))}
        description="Re-apply the last undone action."
        disabled={!canRedo}
        subtle
        testId="toolbar-redo"
        onClick={() => { doRedo() }}
      />

      <div className="os-divider" style={{ height: 16, marginInline: 4 }} />

      {/* Centre: file breadcrumb */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          justifyContent: 'center',
          minWidth: 0,
        }}
      >
        {active && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '4px 10px',
              borderRadius: 6,
              background: 'var(--bg-sunken)',
              maxWidth: '60%',
              minWidth: 0,
            }}
          >
            <span style={{ color: 'var(--accent)', flexShrink: 0, display: 'inline-flex' }}>
              <I.FilePdf size={13} />
            </span>
            {active.filePath && (
              <span
                className="os-mono"
                style={{
                  fontSize: 10.5,
                  color: 'var(--ink-3)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  minWidth: 0,
                  flexShrink: 1,
                }}
                title={active.filePath}
              >
                {trimDir(active.filePath)}
              </span>
            )}
            <span
              style={{
                fontSize: 12,
                color: 'var(--ink)',
                fontWeight: 500,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                minWidth: 0,
              }}
            >
              {active.fileName}
            </span>
            {active.isDirty && (
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 999,
                  background: 'var(--accent)',
                  flexShrink: 0,
                }}
                title="Unsaved changes"
              />
            )}
          </div>
        )}
      </div>

      {extraRight}

      <ToolbarBtn
        icon={<I.Search />}
        label={t('toolbar.find')}
        kbd={formatBinding(getEffectiveBinding('find.open'))}
        description="Search the document. Use Ctrl+H to also replace."
        subtle
        disabled={!activeTabId}
        onClick={openFind}
      />
      <ToolbarBtn
        icon={<I.Sidebar />}
        label={t('toolbar.sidebar')}
        kbd={formatBinding(getEffectiveBinding('sidebar.toggle'))}
        description="Show / hide the page sidebar."
        active={sidebarOpen}
        onClick={toggleSidebar}
        subtle
      />
      <div style={{ position: 'relative' }} onContextMenu={(e) => {
        // Right-click on the ? button → About dialog. Left-click is
        // still the tour. Keeps the chrome compact (one icon, two
        // affordances) the same way Acrobat overloads its question
        // mark.
        e.preventDefault()
        setAboutOpen(true)
      }}>
        <ToolbarBtn
          icon={<I.HelpCircle />}
          label={t('toolbar.help')}
          description="Click: replay the welcome tour. Right-click: About + procurement docs."
          onClick={() => {
            resetTourCompletion()
            setTourOpen(true)
          }}
          subtle
        />
      </div>
      <div style={{ position: 'relative' }}>
        <ToolbarBtn
          icon={<I.Sliders />}
          label={t('toolbar.preferences')}
          description="Customize theme, accent, density, and keyboard shortcuts."
          active={prefsOpen}
          onClick={() => setPrefsOpen((o) => !o)}
          subtle
        />
        {prefsOpen && <PreferencesFlyout onClose={() => setPrefsOpen(false)} />}
      </div>
      {tourOpen && <OnboardingTour onClose={() => setTourOpen(false)} />}
      {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} />}
    </div>
  )
}

interface ToolbarBtnProps {
  icon: ReactNode
  label: string
  kbd?: string
  /** Optional rich-tooltip description. When set, renders the
   *  in-app Tooltip component instead of the native title= so the
   *  user sees title + description + kbd chip. */
  description?: string
  active?: boolean
  disabled?: boolean
  onClick?: () => void
  /** Icon-only mode (no label text). Used for the right-side chrome. */
  subtle?: boolean
  /** Optional stable selector for tests + accessibility. */
  testId?: string
}

export function ToolbarBtn({
  icon,
  label,
  kbd,
  description,
  active,
  disabled,
  onClick,
  subtle,
  testId,
}: ToolbarBtnProps) {
  const [hover, setHover] = useState(false)
  const style: CSSProperties = {
    height: 26,
    padding: '0 8px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    border: '1px solid transparent',
    borderColor: active
      ? 'var(--line-strong)'
      : hover && !disabled
        ? 'var(--line)'
        : 'transparent',
    background: active
      ? 'var(--bg-active)'
      : hover && !disabled
        ? 'var(--bg-hover)'
        : 'transparent',
    color: disabled ? 'var(--ink-4)' : 'var(--ink-2)',
    borderRadius: 6,
    fontSize: 12,
    opacity: disabled ? 0.6 : 1,
    cursor: disabled ? 'default' : 'pointer',
  }
  const button = (
    <button
      onClick={onClick}
      disabled={disabled}
      // Native title= as fallback so screen readers + non-Tooltip
      // builds still work. Tooltip wraps for the rich variant.
      title={description ? undefined : kbd ? `${label} (${kbd})` : label}
      aria-label={label}
      data-testid={testId}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={style}
    >
      <span style={{ display: 'inline-flex' }}>{icon}</span>
      {!subtle && <span>{label}</span>}
    </button>
  )
  if (description) {
    return (
      <Tooltip title={label} description={description} shortcut={kbd}>
        {button}
      </Tooltip>
    )
  }
  return button
}

// Re-export for callers that compose Toolbar buttons against a
// dynamic shortcut id without re-importing the formatter.
export function shortcutLabel(id: ShortcutId): string {
  return formatBinding(getEffectiveBinding(id))
}

/** Shorten a long path to "…/parent/" — keeps the breadcrumb readable
 *  when the user opens a file 12 directories deep. */
function trimDir(filePath: string): string {
  const sep = filePath.includes('\\') ? '\\' : '/'
  const parts = filePath.split(sep)
  if (parts.length <= 1) return ''
  const parent = parts.slice(-2, -1)[0] || sep
  return parts.length > 3 ? `…${sep}${parent}${sep}` : `${parts.slice(0, -1).join(sep)}${sep}`
}
