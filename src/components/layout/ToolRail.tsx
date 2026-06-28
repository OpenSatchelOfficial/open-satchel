import type { CSSProperties, ReactNode } from 'react'
import { useUIStore } from '../../stores/uiStore'
import { I } from '../icons'
import type { Tool } from '../../types/pdf'

interface RailToolDef {
  id: Tool
  icon: ReactNode
  label: string
  kbd?: string
}

/** Slim 10-tool rail. Maps to `Tool` IDs already wired into the PDF
 *  format. Long-tail actions (Merge, OCR, Watermark, Bates, Wizard,
 *  Compare…) live in the ⌘K command launcher — see CommandLauncher.tsx.
 *
 *  This rail is what the redesign called the "rail variant honestly
 *  applied" — keep direct-manipulation tools you USE here, push
 *  one-shot dialogs into the launcher. */
const TOOLS: RailToolDef[] = [
  { id: 'select',    icon: <I.Cursor />,     label: 'Select',     kbd: 'V' },
  { id: 'edit_text', icon: <I.Type />,       label: 'Edit text',  kbd: 'T' },
  { id: 'highlight', icon: <I.Highlight />,  label: 'Highlight',  kbd: 'M' },
  { id: 'sticky_note', icon: <I.Comment />,  label: 'Comment',    kbd: 'C' },
  { id: 'draw',      icon: <I.Pen />,        label: 'Freehand',   kbd: 'P' },
  { id: 'shape_rect', icon: <I.Shape />,     label: 'Shape',      kbd: 'U' },
  { id: 'stamp',     icon: <I.Stamp />,      label: 'Stamp',      kbd: 'S' },
  { id: 'signature', icon: <I.Sign />,       label: 'Fill & Sign', kbd: 'F' },
  { id: 'mark_redaction', icon: <I.Redact />, label: 'Mark redaction' },
  { id: 'redact',    icon: <I.Redact />,     label: 'Redact' },
  { id: 'image',     icon: <I.Insert />,     label: 'Image' },
]

interface ToolRailProps {
  onOpenLauncher: () => void
}

/** Vertical rail. Sits in column 1 of the AppShell grid in `layout: 'rail'`
 *  mode, spanning the full main row. Active tool gets the accent tint;
 *  hover gets bg-hover. The launcher button at the bottom is dashed +
 *  has a kbd hint so it reads as "different kind of thing". */
export default function ToolRail({ onOpenLauncher }: ToolRailProps) {
  const tool = useUIStore((s) => s.tool)
  const setTool = useUIStore((s) => s.setTool)

  return (
    <aside
      style={{
        width: '100%',
        height: '100%',
        background: 'var(--bg-chrome)',
        borderRight: '1px solid var(--line)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '8px 0',
        gap: 4,
      }}
    >
      {TOOLS.map((t) => {
        const active = tool === t.id
        const baseStyle: CSSProperties = {
          width: 36,
          height: 32,
          display: 'grid',
          placeItems: 'center',
          border: '1px solid',
          borderColor: active ? 'var(--accent)' : 'transparent',
          background: active ? 'var(--accent-tint)' : 'transparent',
          color: active ? 'var(--accent)' : 'var(--ink-2)',
          borderRadius: 6,
          position: 'relative',
          flexShrink: 0,
          cursor: 'pointer',
        }
        return (
          <button
            key={t.id}
            onClick={() => setTool(t.id)}
            title={`${t.label}${t.kbd ? ` (${t.kbd})` : ''}`}
            style={baseStyle}
            onMouseEnter={(e) => {
              if (!active) e.currentTarget.style.background = 'var(--bg-hover)'
            }}
            onMouseLeave={(e) => {
              if (!active) e.currentTarget.style.background = 'transparent'
            }}
          >
            {t.icon}
            {t.kbd && (
              <span
                className="os-mono"
                style={{
                  position: 'absolute',
                  bottom: -1,
                  right: 2,
                  fontSize: 8,
                  color: 'var(--ink-4)',
                }}
              >
                {t.kbd}
              </span>
            )}
          </button>
        )
      })}

      <div
        style={{
          width: 24,
          height: 1,
          background: 'var(--line)',
          margin: '4px 0',
          flexShrink: 0,
        }}
      />

      {/* Launcher trigger — dashed border so it doesn't look like another
          tool. ⌘K hint is part of the affordance. */}
      <button
        onClick={onOpenLauncher}
        title="More tools - Action Wizard, Merge, OCR, Compare, Watermark…  (Ctrl+K)"
        style={{
          width: 36,
          height: 36,
          marginTop: 2,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 1,
          border: '1px dashed var(--line-strong)',
          background: 'var(--bg-surface)',
          color: 'var(--ink-2)',
          borderRadius: 6,
          cursor: 'pointer',
          flexShrink: 0,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'var(--bg-hover)'
          e.currentTarget.style.borderColor = 'var(--accent)'
          e.currentTarget.style.color = 'var(--accent)'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'var(--bg-surface)'
          e.currentTarget.style.borderColor = 'var(--line-strong)'
          e.currentTarget.style.color = 'var(--ink-2)'
        }}
      >
        <I.More size={14} />
        <span className="os-mono" style={{ fontSize: 7.5, letterSpacing: 0.4 }}>
          ⌘K
        </span>
      </button>

      <div style={{ flex: 1, minHeight: 8 }} />
    </aside>
  )
}
