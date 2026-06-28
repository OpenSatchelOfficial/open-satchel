import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useUIStore } from '../../stores/uiStore'
import { openFile, saveActiveTab, saveActiveTabAs } from '../../lib/actions'
import { I } from '../icons'
import type { Tool } from '../../types/pdf'

/** Spotlight-style command launcher.
 *
 *  Bound to Ctrl+K via registerGlobalShortcuts (or the toolbar trigger).
 *  Two command shapes:
 *    • "tool"   → set the active tool then close
 *    • "action" → invoke a known action (Open / Save / Find / Print / …)
 *      or surface a "coming soon" status when the action's dialog isn't
 *      wired yet. The launcher is the single discoverable seam for the
 *      long tail; missing wiring shows up here, not as a silent miss. */
interface Cmd {
  group: string
  label: string
  /** Fuzzy search hits boost matches against `label`, `group`, and the
   *  optional `keywords` blob. Used so "wmrk" → "Watermark", "ocr" →
   *  "OCR — recognize text". */
  keywords?: string
  kbd?: string
  kind: 'tool' | 'action'
  toolId?: Tool
  /** Action invoker. Returns a string to surface as a status (e.g.
   *  "Coming soon — wired in M4"); void = silent close. */
  action?: () => void | Promise<void> | string
}

function buildCommands(setTool: (t: Tool) => void): Cmd[] {
  const commands: Cmd[] = [
    // ── Tools (rail) ────────────────────────────────────────────────
    { group: 'Tools', label: 'Select',         kind: 'tool', toolId: 'select', kbd: 'V' },
    { group: 'Tools', label: 'Edit text',      kind: 'tool', toolId: 'edit_text', kbd: 'T' },
    { group: 'Tools', label: 'Edit image',     kind: 'tool', toolId: 'edit_image' },
    { group: 'Tools', label: 'Highlight',      kind: 'tool', toolId: 'highlight', kbd: 'M' },
    { group: 'Tools', label: 'Underline',      kind: 'tool', toolId: 'underline' },
    { group: 'Tools', label: 'Strikethrough',  kind: 'tool', toolId: 'strikethrough' },
    { group: 'Tools', label: 'Comment / Sticky',kind: 'tool', toolId: 'sticky_note', kbd: 'C' },
    { group: 'Tools', label: 'Freehand draw',  kind: 'tool', toolId: 'draw', kbd: 'P' },
    { group: 'Tools', label: 'Rectangle',      kind: 'tool', toolId: 'shape_rect' },
    { group: 'Tools', label: 'Ellipse',        kind: 'tool', toolId: 'shape_circle' },
    { group: 'Tools', label: 'Line',           kind: 'tool', toolId: 'shape_line' },
    { group: 'Tools', label: 'Arrow',          kind: 'tool', toolId: 'shape_arrow' },
    { group: 'Tools', label: 'Stamp',          kind: 'tool', toolId: 'stamp' },
    { group: 'Tools', label: 'Redact',         kind: 'tool', toolId: 'redact' },
    { group: 'Tools', label: 'Measure',        kind: 'tool', toolId: 'measure' },
    { group: 'Tools', label: 'Fill & Sign',    kind: 'tool', toolId: 'signature', kbd: 'F' },
    { group: 'Tools', label: 'Insert text',    kind: 'tool', toolId: 'text' },
    { group: 'Tools', label: 'Image',          kind: 'tool', toolId: 'image' },
    { group: 'Tools', label: 'Wipe off',       kind: 'tool', toolId: 'wipe_off' },
    { group: 'Tools', label: 'Insert text marker', kind: 'tool', toolId: 'insert_text_marker' },
    { group: 'Tools', label: 'Replace text marker', kind: 'tool', toolId: 'replace_text_marker' },

    // ── File ────────────────────────────────────────────────────────
    { group: 'File',  label: 'Open file…',     kind: 'action', kbd: 'Ctrl+O', action: () => { void openFile() } },
    { group: 'File',  label: 'Save',           kind: 'action', kbd: 'Ctrl+S', action: () => { void saveActiveTab() } },
    { group: 'File',  label: 'Save as…',       kind: 'action', kbd: 'Ctrl+Shift+S', action: () => { void saveActiveTabAs() } },

    // ── Document ────────────────────────────────────────────────────
    { group: 'Document', label: 'Find…',           kind: 'action', kbd: 'Ctrl+F', action: () => useUIStore.getState().openFind() },
    { group: 'Document', label: 'Find & Replace…', kind: 'action', kbd: 'Ctrl+H', action: () => useUIStore.getState().openReplace() },
    { group: 'Document', label: 'Toggle read mode', kind: 'action', kbd: 'R',     action: () => useUIStore.getState().toggleReadMode() },

    // ── View ────────────────────────────────────────────────────────
    { group: 'View',  label: 'Toggle sidebar',     kind: 'action', kbd: 'Ctrl+B', action: () => useUIStore.getState().toggleSidebar() },
    { group: 'View',  label: 'Toggle theme',       kind: 'action',                action: () => useUIStore.getState().toggleTheme() },
    { group: 'View',  label: 'Toggle annotation gutter', kind: 'action',          action: () => useUIStore.getState().toggleAnnotationGutter() },
    { group: 'View',  label: 'Toggle rulers',      kind: 'action',                action: () => useUIStore.getState().toggleRulers() },
    { group: 'View',  label: 'Toggle grid',        kind: 'action',                action: () => useUIStore.getState().toggleGrid() },
    { group: 'View',  label: 'Toggle snap to grid',kind: 'action',                action: () => useUIStore.getState().toggleSnapToGrid() },

    // ── Pages / Tools / Batch / Protect (long-tail dialogs) ─────────
    // These open the existing format-specific dialogs once wiring lands.
    // Until then they show a friendly "coming soon" so the launcher
    // surface is always honest about what's bound.
    { group: 'Pages',  label: 'Page Manager',      kind: 'action', action: () => 'Page Manager - open via the Pages ribbon' },
    { group: 'Pages',  label: 'Merge PDFs',        kind: 'action', action: () => 'Merge - open via the Pages ribbon' },
    { group: 'Pages',  label: 'Split PDF',         kind: 'action', action: () => 'Split - open via the Pages ribbon' },
    { group: 'Pages',  label: 'Page numbers',      kind: 'action', action: () => 'Page Numbers - open via the Pages ribbon' },
    { group: 'Pages',  label: 'Bates numbering',   kind: 'action', action: () => 'Bates - open via the Pages ribbon' },
    { group: 'Pages',  label: 'Crop pages',        kind: 'action', action: () => 'Crop - open via the Pages ribbon' },
    { group: 'Pages',  label: 'Page size',         kind: 'action', action: () => 'Page Size - open via the Pages ribbon' },
    { group: 'Pages',  label: 'Page labels',       kind: 'action', action: () => 'Page Labels - open via the Pages ribbon' },

    { group: 'Tools',  label: 'Properties / Metadata', kind: 'action', action: () => 'Metadata - open via the Tools ribbon' },
    { group: 'Tools',  label: 'Initial view…',     kind: 'action', action: () => 'Initial View - open via the Tools ribbon' },
    { group: 'Tools',  label: 'Audit size',        kind: 'action', action: () => 'Audit Size - open via the Tools ribbon' },
    { group: 'Tools',  label: 'Layers (OCG)',      kind: 'action', action: () => 'Layers - open via the Tools ribbon' },
    { group: 'Tools',  label: 'OCR - recognize text', kind: 'action', keywords: 'ocr recognize text', action: () => 'OCR - open via the Tools ribbon' },
    { group: 'Tools',  label: 'Extract text',      kind: 'action', action: () => 'Extract Text - open via the Tools ribbon' },
    { group: 'Tools',  label: 'Extract images',    kind: 'action', action: () => 'Extract Images - open via the Tools ribbon' },
    { group: 'Tools',  label: 'Replace image',     kind: 'action', action: () => 'Replace Image - open via the Tools ribbon' },
    { group: 'Tools',  label: 'Form Designer',     kind: 'action', action: () => 'Form Designer - open via the Tools ribbon' },
    { group: 'Tools',  label: 'Auto-detect fields',kind: 'action', action: () => 'Auto-detect - open via the Tools ribbon' },

    { group: 'Protect',label: 'Add watermark',     kind: 'action', keywords: 'watermark wmrk', action: () => 'Watermark - open via the Protect ribbon' },
    { group: 'Protect',label: 'Password protect',  kind: 'action', action: () => 'Password - open via the Protect ribbon' },
    { group: 'Protect',label: 'Sign & certify',    kind: 'action', action: () => 'Sign & Certify - open via the Fill & Sign ribbon' },
    { group: 'Protect',label: 'Verify signatures', kind: 'action', action: () => 'Verify - open via the Protect ribbon' },

    { group: 'Batch',  label: 'PDF → Word',        kind: 'action', action: () => 'PDF → Word - open via the Batch ribbon' },
    { group: 'Batch',  label: 'PDF → PowerPoint',  kind: 'action', action: () => 'PDF → PPT - open via the Batch ribbon' },
    { group: 'Batch',  label: 'PDF → Excel',       kind: 'action', action: () => 'PDF → Excel - open via the Batch ribbon' },
    { group: 'Batch',  label: 'Action Wizard',     kind: 'action', action: () => 'Action Wizard - open via the Batch ribbon' },
    { group: 'Batch',  label: 'Watched folders',   kind: 'action', action: () => 'Watched Folders - open via the Batch ribbon' },

    { group: 'Settings', label: 'Open preferences…', kind: 'action', kbd: 'Ctrl+,', action: () => 'Click the gear icon in the toolbar' },
  ]
  // Reference setTool so the closure stays bound (the actual dispatch
  // happens in `fire` via the toolId; this prevents lint warnings about
  // an unused param without changing the public API).
  void setTool
  return commands
}

/** Subsequence-aware filter — matches if all query chars appear in
 *  order somewhere in the haystack. Good enough for "wmrk" → "Watermark". */
function fuzzyMatch(haystack: string, query: string): boolean {
  if (!query) return true
  const t = haystack.toLowerCase()
  const q = query.toLowerCase()
  if (t.includes(q)) return true
  let i = 0
  for (const ch of t) {
    if (ch === q[i]) i++
    if (i >= q.length) return true
  }
  return false
}

interface CommandLauncherProps {
  open: boolean
  onClose: () => void
}

export default function CommandLauncher({ open, onClose }: CommandLauncherProps) {
  const setTool = useUIStore((s) => s.setTool)
  const setSaveNotice = useUIStore((s) => s.setSaveNotice)

  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const [recents, setRecents] = useState<string[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  const commands = buildCommands(setTool)

  useEffect(() => {
    if (open) {
      setQuery('')
      setCursor(0)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [open])

  if (!open) return null

  const matches = (c: Cmd) =>
    fuzzyMatch(c.label, query) ||
    fuzzyMatch(c.group, query) ||
    (c.keywords ? fuzzyMatch(c.keywords, query) : false)

  const filtered = commands.filter(matches)
  const groups = filtered.reduce<Record<string, Cmd[]>>((acc, c) => {
    ;(acc[c.group] = acc[c.group] || []).push(c)
    return acc
  }, {})
  const groupNames = Object.keys(groups)

  const recentsBlock = !query
    ? recents
        .map((label) => commands.find((c) => c.label === label))
        .filter((c): c is Cmd => Boolean(c))
    : []
  const flat = [...recentsBlock, ...filtered]
  const safeCursor = Math.min(cursor, Math.max(0, flat.length - 1))

  const fire = (cmd: Cmd | undefined) => {
    if (!cmd) return
    setRecents((r) => [cmd.label, ...r.filter((x) => x !== cmd.label)].slice(0, 5))
    if (cmd.kind === 'tool' && cmd.toolId) {
      setTool(cmd.toolId)
    } else if (cmd.kind === 'action' && cmd.action) {
      const result = cmd.action()
      if (typeof result === 'string') {
        setSaveNotice({
          message: result,
          tone: 'info',
          expiresAt: Date.now() + 4000,
        })
      }
    }
    onClose()
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => Math.min(flat.length - 1, c + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(0, c - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      fire(flat[safeCursor])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  let runningIdx = recentsBlock.length

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'color-mix(in oklch, var(--ink) 32%, transparent)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
        paddingTop: '8%',
        zIndex: 100,
        backdropFilter: 'blur(2px)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKey}
        style={{
          width: 560,
          maxHeight: '70%',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg-surface)',
          border: '1px solid var(--line-strong)',
          borderRadius: 12,
          boxShadow:
            '0 18px 50px -12px color-mix(in oklch, var(--ink) 50%, transparent)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '12px 14px',
            borderBottom: '1px solid var(--line)',
          }}
        >
          <span style={{ color: 'var(--ink-3)', display: 'inline-flex' }}>
            <I.Search size={16} />
          </span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setCursor(0)
            }}
            placeholder="Search every action - try ‘ocr’, ‘watermark’, ‘bates’"
            style={{
              flex: 1,
              border: 'none',
              outline: 'none',
              background: 'transparent',
              fontSize: 14,
              color: 'var(--ink)',
              fontFamily: 'inherit',
            }}
          />
          <span
            className="os-mono"
            style={{
              fontSize: 10,
              color: 'var(--ink-3)',
              border: '1px solid var(--line)',
              borderRadius: 4,
              padding: '1px 5px',
            }}
          >
            esc
          </span>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '6px 0' }}>
          {recentsBlock.length > 0 && (
            <div>
              <div
                className="os-mono"
                style={{
                  fontSize: 9.5,
                  color: 'var(--ink-3)',
                  textTransform: 'uppercase',
                  letterSpacing: 0.7,
                  padding: '8px 14px 4px',
                }}
              >
                Recent
              </div>
              {recentsBlock.map((cmd, i) => (
                <LauncherRow
                  key={`r${i}`}
                  cmd={cmd}
                  active={safeCursor === i}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => fire(cmd)}
                />
              ))}
            </div>
          )}
          {groupNames.map((gn) => {
            const startIdx = runningIdx
            const rows = groups[gn].map((cmd, j) => {
              const idx = startIdx + j
              return (
                <LauncherRow
                  key={`${gn}-${j}`}
                  cmd={cmd}
                  active={safeCursor === idx}
                  onMouseEnter={() => setCursor(idx)}
                  onClick={() => fire(cmd)}
                />
              )
            })
            runningIdx += groups[gn].length
            return (
              <div key={gn}>
                <div
                  className="os-mono"
                  style={{
                    fontSize: 9.5,
                    color: 'var(--ink-3)',
                    textTransform: 'uppercase',
                    letterSpacing: 0.7,
                    padding: '8px 14px 4px',
                  }}
                >
                  {gn}
                </div>
                {rows}
              </div>
            )
          })}
          {flat.length === 0 && (
            <div
              style={{
                padding: '24px 14px',
                textAlign: 'center',
                color: 'var(--ink-3)',
                fontSize: 12,
              }}
            >
              No commands match{' '}
              <span className="os-mono">"{query}"</span>
            </div>
          )}
        </div>

        <div
          style={{
            height: 28,
            padding: '0 12px',
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            background: 'var(--bg-chrome)',
            borderTop: '1px solid var(--line)',
            fontSize: 10.5,
            color: 'var(--ink-3)',
          }}
        >
          <span>
            <kbd className="os-mono" style={kbdStyle}>↑↓</kbd> navigate
          </span>
          <span>
            <kbd className="os-mono" style={kbdStyle}>↵</kbd> run
          </span>
          <span>
            <kbd className="os-mono" style={kbdStyle}>esc</kbd> close
          </span>
          <div style={{ flex: 1 }} />
          <span className="os-mono" style={{ letterSpacing: 0.5 }}>
            {flat.length} commands
          </span>
        </div>
      </div>
    </div>
  )
}

const kbdStyle: CSSProperties = {
  fontSize: 9.5,
  color: 'var(--ink-2)',
  border: '1px solid var(--line)',
  borderRadius: 3,
  padding: '0 4px',
  background: 'var(--bg-surface)',
}

function LauncherRow({
  cmd,
  active,
  onMouseEnter,
  onClick,
}: {
  cmd: Cmd
  active: boolean
  onMouseEnter: () => void
  onClick: () => void
}) {
  return (
    <button
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      style={{
        width: '100%',
        padding: '6px 14px',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        border: 'none',
        background: active ? 'var(--accent-tint)' : 'transparent',
        color: active ? 'var(--accent)' : 'var(--ink)',
        cursor: 'pointer',
        textAlign: 'left',
        borderLeft: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
      }}
    >
      <span
        style={{
          width: 18,
          height: 18,
          display: 'grid',
          placeItems: 'center',
          color: active ? 'var(--accent)' : 'var(--ink-3)',
        }}
      >
        {cmd.kind === 'tool' ? <I.Cursor size={13} /> : <I.Sliders size={13} />}
      </span>
      <span style={{ fontSize: 12.5, flex: 1 }}>{cmd.label}</span>
      <span
        className="os-mono"
        style={{
          fontSize: 10,
          color: active ? 'var(--accent)' : 'var(--ink-4)',
        }}
      >
        {cmd.group}
      </span>
      {cmd.kbd && (
        <span className="os-mono" style={{ ...kbdStyle, marginLeft: 4 }}>
          {cmd.kbd}
        </span>
      )}
    </button>
  )
}
