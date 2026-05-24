import { useEffect } from 'react'
import { useUIStore } from '../../stores/uiStore'
import { useTabStore } from '../../stores/tabStore'
import { getHandler } from '../../formats/registry'
import Toolbar from './Toolbar'
import TabBar from './TabBar'
import StatusBar from './StatusBar'
import ContentRouter from './ContentRouter'
import ToolRail from './ToolRail'
import CommandLauncher from './CommandLauncher'
import AnnotationGutter from './AnnotationGutter'
import SaveNoticeToast from './SaveNoticeToast'

/** Top-level shell.
 *
 *  Two layout modes (Preferences → PDF layout):
 *    • ribbon — the format's `ToolbarExtras` (PdfToolbar) renders as a
 *      chip-tab ribbon between the tab bar and the page. Default.
 *    • rail   — a slim 10-tool rail in column 1 spans the full main
 *      row, replacing the ribbon. Long-tail dialogs go through ⌘K.
 *
 *  The annotation gutter (Preferences → Annotation gutter) adds a
 *  third column to the right of the page — empty shell for now,
 *  comments wiring lands later. */
export default function AppShell() {
  const sidebarOpen = useUIStore((s) => s.sidebarOpen)
  const layout = useUIStore((s) => s.layout)
  const showAnnotationGutter = useUIStore((s) => s.showAnnotationGutter)
  const commandPaletteOpen = useUIStore((s) => s.commandPaletteOpen)
  const setCommandPaletteOpen = useUIStore((s) => s.setCommandPaletteOpen)

  const activeTabId = useTabStore((s) => s.activeTabId)
  const tabs = useTabStore((s) => s.tabs)
  const activeTab = tabs.find((t) => t.id === activeTabId)
  const handler = activeTab ? getHandler(activeTab.format) : undefined
  const SidebarComponent = handler?.Sidebar
  const RibbonComponent = handler?.ToolbarExtras

  const isRail = layout === 'rail' && Boolean(activeTab)
  const hasSidebar = Boolean(sidebarOpen && activeTab && SidebarComponent)
  // Ribbon only renders in ribbon mode, against an active format that
  // ships a ToolbarExtras component.
  const hasRibbon = !isRail && Boolean(activeTab && RibbonComponent)
  const hasGutter = Boolean(showAnnotationGutter && activeTab)

  // Build column template:
  //   [rail?] [sidebar?] main [gutter?]
  const cols: string[] = []
  if (isRail) cols.push('var(--rail-w)')
  if (hasSidebar) cols.push('var(--sidebar-w)')
  cols.push('1fr')
  if (hasGutter) cols.push('var(--gutter-w)')

  // Build row template:
  //   toolbar / tabbar / [ribbon?] / main / status
  const rows = hasRibbon
    ? `var(--toolbar-h) var(--tabbar-h) minmax(var(--ribbon-h), auto) 1fr var(--statusbar-h)`
    : `var(--toolbar-h) var(--tabbar-h) 1fr var(--statusbar-h)`

  // Row index of the main content area
  const mainRowStart = hasRibbon ? 4 : 3
  const statusRowStart = hasRibbon ? 5 : 4

  // ── Esc closes the launcher ────────────────────────────────────────
  useEffect(() => {
    if (!commandPaletteOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCommandPaletteOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [commandPaletteOpen, setCommandPaletteOpen])

  return (
    <>
      <div
        style={{
          display: 'grid',
          gridTemplateRows: rows,
          gridTemplateColumns: cols.join(' '),
          height: '100vh',
          width: '100vw',
          overflow: 'hidden',
          background: 'var(--bg-app)',
          color: 'var(--ink)',
        }}
      >
        <Toolbar />
        <TabBar />

        {hasRibbon && RibbonComponent && activeTabId && (
          <div
            style={{
              gridColumn: '1 / -1',
              gridRow: 3,
              borderBottom: '1px solid var(--line)',
              background: 'var(--bg-chrome)',
              minWidth: 0,
            }}
          >
            <RibbonComponent tabId={activeTabId} />
          </div>
        )}

        {/* Tool rail — column 1 of the main row, full height of main */}
        {isRail && (
          <div
            style={{
              gridRow: mainRowStart,
              gridColumn: 1,
              minHeight: 0,
              minWidth: 0,
            }}
          >
            <ToolRail onOpenLauncher={() => setCommandPaletteOpen(true)} />
          </div>
        )}

        {/* Format-specific sidebar */}
        {hasSidebar && SidebarComponent && activeTabId && (
          <aside
            style={{
              gridRow: mainRowStart,
              gridColumn: isRail ? 2 : 1,
              background: 'var(--bg-sunken)',
              borderRight: '1px solid var(--line)',
              overflow: 'auto',
              minHeight: 0,
              minWidth: 0,
            }}
          >
            <SidebarComponent tabId={activeTabId} />
          </aside>
        )}

        {/* Main content */}
        <main
          style={{
            gridRow: mainRowStart,
            gridColumn: mainColumn(isRail, hasSidebar, hasGutter),
            overflow: 'hidden',
            background: 'var(--bg-app)',
            position: 'relative',
            minWidth: 0,
            minHeight: 0,
          }}
        >
          <ContentRouter />
        </main>

        {/* Annotation gutter */}
        {hasGutter && (
          <div
            style={{
              gridRow: mainRowStart,
              gridColumn: -1,
              minHeight: 0,
              minWidth: 0,
            }}
          >
            <AnnotationGutter />
          </div>
        )}

        {/* Row N: status bar */}
        <div style={{ gridRow: statusRowStart, gridColumn: '1 / -1' }}>
          <StatusBar />
        </div>
      </div>

      <CommandLauncher
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
      />
      <SaveNoticeToast />
    </>
  )
}

/** Compute the grid-column of the main content area based on which
 *  optional columns are present. The grid is always laid out as
 *  [rail?] [sidebar?] main [gutter?], so main's column index =
 *  1 + Number(isRail) + Number(hasSidebar). The end edge is "−2" when
 *  a gutter is present (so it stops short of the gutter column),
 *  otherwise "−1". */
function mainColumn(isRail: boolean, hasSidebar: boolean, hasGutter: boolean): string {
  const startCol = 1 + (isRail ? 1 : 0) + (hasSidebar ? 1 : 0)
  const endCol = hasGutter ? -2 : -1
  return `${startCol} / ${endCol}`
}
