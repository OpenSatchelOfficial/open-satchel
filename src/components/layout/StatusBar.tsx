import { useEffect, useState, type CSSProperties } from 'react'
import { useTabStore } from '../../stores/tabStore'
import { useUIStore } from '../../stores/uiStore'
import { useFormatStore } from '../../stores/formatStore'
import { appApi } from '../../lib/ipc'
import { FORMAT_NAMES } from '../../types/tabs'
import { I } from '../icons'
import type { PdfFormatState } from '../../formats/pdf'
import { countManualRedactions } from '../../services/pdfManualRedactions'

/** Status bar — monospace metadata band sitting along the bottom edge.
 *
 *  Left  → local-process pip + format + page tally
 *  Right → save status + zoom controls + runtime tag + version
 *
 *  The redesign keeps everything uppercased + tracking-out so the row
 *  reads as machine-spoken metadata rather than a friendly UI strip. */
export default function StatusBar() {
  const tabs = useTabStore((s) => s.tabs)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const active = tabs.find((t) => t.id === activeTabId)

  const zoom = useUIStore((s) => s.zoom)
  const zoomIn = useUIStore((s) => s.zoomIn)
  const zoomOut = useUIStore((s) => s.zoomOut)
  const currentPage = useUIStore((s) => s.currentPage)
  const autoSaveStatus = useUIStore((s) => s.autoSaveStatus)
  const autoSaveEnabled = useUIStore((s) => s.autoSaveEnabled)
  const legalGuarantee = useUIStore((s) => s.legalGuaranteeRedaction)

  // Pull page count from the active format state — only PDF handler
  // populates this today, but the lookup is generic so other handlers
  // can mirror the shape.
  const pageCount = useFormatStore((s) => {
    if (!active || active.format !== 'pdf') return 0
    const fmt = s.data[active.id] as PdfFormatState | undefined
    return fmt?.pageCount ?? 0
  })
  const pendingRedactionCount = useFormatStore((s) => {
    if (!active || active.format !== 'pdf') return 0
    return countManualRedactions(s.data[active.id] as PdfFormatState | undefined)
  })

  const [version, setVersion] = useState<string | null>(null)
  useEffect(() => {
    appApi.version().then(setVersion).catch(() => setVersion(null))
  }, [])

  return (
    <div
      style={{
        gridColumn: '1 / -1',
        height: 'var(--statusbar-h)',
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '0 10px',
        background: 'var(--bg-chrome)',
        borderTop: '1px solid var(--line)',
        fontSize: 'var(--fs-meta)',
        color: 'var(--ink-3)',
        fontFamily: '"JetBrains Mono", monospace',
        letterSpacing: 0.4,
        textTransform: 'uppercase',
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: 999,
            background: 'var(--good)',
          }}
        />
        local
      </span>
      <span>{active ? FORMAT_NAMES[active.format] : 'No file open'}</span>
      {pageCount > 0 && (
        <span>
          pg {String(currentPage + 1).padStart(2, '0')} / {pageCount}
        </span>
      )}
      {pendingRedactionCount > 0 && (
        <span style={{ color: 'var(--warn)' }}>
          {pendingRedactionCount} redaction mark{pendingRedactionCount === 1 ? '' : 's'} · autosave off
        </span>
      )}
      {legalGuarantee && (
        <span
          data-testid="statusbar-legal-guarantee"
          title="Legal Guarantee redaction is ON — redacted pages flatten to secured images on save; autosave is locked off."
          style={{ color: 'var(--accent)', fontWeight: 600 }}
        >
          🔒 Legal Guarantee · autosave locked off
        </span>
      )}

      {active?.isDirty ? (
        autoSaveEnabled && autoSaveStatus === 'idle' ? (
          <span style={{ color: 'var(--accent)' }}>● unsaved · autosave pending</span>
        ) : autoSaveStatus === 'saving' ? (
          <span style={{ color: 'var(--warn)' }}>saving…</span>
        ) : (
          <span style={{ color: 'var(--accent)' }}>● unsaved</span>
        )
      ) : autoSaveStatus === 'saved' ? (
        <span style={{ color: 'var(--good)' }}>saved</span>
      ) : null}

      <div style={{ flex: 1 }} />

      {active && (
        <>
          <button onClick={zoomOut} style={statusBtn} title="Zoom out">
            <I.ZoomOut size={11} />
          </button>
          <span style={{ minWidth: 36, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
          <button onClick={zoomIn} style={statusBtn} title="Zoom in">
            <I.ZoomIn size={11} />
          </button>
        </>
      )}
      <span>tauri 2 · rust</span>
      {version && <span>v{version}</span>}
    </div>
  )
}

const statusBtn: CSSProperties = {
  width: 18,
  height: 18,
  display: 'grid',
  placeItems: 'center',
  border: 'none',
  background: 'transparent',
  color: 'var(--ink-3)',
  borderRadius: 3,
  cursor: 'pointer',
}
