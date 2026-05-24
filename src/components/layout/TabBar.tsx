import { useTabStore } from '../../stores/tabStore'
import { useFormatStore } from '../../stores/formatStore'
import { getHandler } from '../../formats/registry'
import type { DocumentFormat } from '../../types/tabs'
import { I, type IconName } from '../icons'

/** Map a document format → redesign-v2 monoline icon name. The fallback
 *  is FilePdf since that's the only handler currently registered. */
const ICON_BY_FORMAT: Partial<Record<DocumentFormat, IconName>> = {
  pdf: 'FilePdf',
  markdown: 'FileMd',
  docx: 'FileDoc',
  xlsx: 'FileXls',
  pptx: 'FilePpt',
  image: 'FileImg',
  svg: 'FileImg',
  code: 'FileCode',
  json: 'FileJson',
  csv: 'FileCsv',
  html: 'FileHtml',
}

/** Tab bar — chip-style tabs with a top-edge accent on the active one,
 *  monospace dirty pip, and middle-click to close. Empty state still
 *  reserves the row so the grid stays stable. */
export default function TabBar() {
  const tabs = useTabStore((s) => s.tabs)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const setActiveTab = useTabStore((s) => s.setActiveTab)
  const closeTab = useTabStore((s) => s.closeTab)

  const handleClose = (tabId: string, format: string) => {
    const handler = getHandler(format as DocumentFormat)
    handler?.cleanup?.(tabId)
    useFormatStore.getState().clearFormatState(tabId)
    closeTab(tabId)
  }

  return (
    <div
      style={{
        gridColumn: '1 / -1',
        height: 'var(--tabbar-h)',
        display: 'flex',
        alignItems: 'stretch',
        background: 'var(--bg-app)',
        borderBottom: '1px solid var(--line)',
        paddingLeft: 4,
        paddingRight: 8,
        gap: 0,
        overflow: 'hidden',
      }}
    >
      {tabs.map((tab) => {
        const active = tab.id === activeTabId
        const iconName = ICON_BY_FORMAT[tab.format] ?? 'FilePdf'
        const Icon = I[iconName] as React.ComponentType<{ size?: number }>
        return (
          <div
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault()
                handleClose(tab.id, tab.format)
              }
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '0 10px',
              minWidth: 0,
              maxWidth: 220,
              cursor: 'pointer',
              position: 'relative',
              background: active ? 'var(--bg-surface)' : 'transparent',
              borderTop: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
              borderLeft: '1px solid transparent',
              borderRight: '1px solid var(--line)',
              borderBottom: active ? '1px solid var(--bg-surface)' : 'none',
              marginBottom: active ? -1 : 0,
              fontSize: 12,
            }}
          >
            <span
              style={{
                color: active ? 'var(--accent)' : 'var(--ink-3)',
                flexShrink: 0,
                display: 'inline-flex',
              }}
            >
              <Icon size={14} />
            </span>
            <span
              style={{
                color: active ? 'var(--ink)' : 'var(--ink-2)',
                fontWeight: active ? 500 : 400,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {tab.fileName}
              {tab.isDirty && (
                <span style={{ color: 'var(--accent)', marginLeft: 4 }}>•</span>
              )}
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation()
                handleClose(tab.id, tab.format)
              }}
              aria-label={`Close ${tab.fileName}`}
              title="Close tab"
              style={{
                width: 16,
                height: 16,
                marginLeft: 4,
                display: 'grid',
                placeItems: 'center',
                border: 'none',
                background: 'transparent',
                color: 'var(--ink-3)',
                borderRadius: 3,
                opacity: active ? 1 : 0.55,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--bg-hover)'
                e.currentTarget.style.color = 'var(--bad)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent'
                e.currentTarget.style.color = 'var(--ink-3)'
              }}
            >
              <I.Close size={10} />
            </button>
          </div>
        )
      })}
      <div style={{ flex: 1 }} />
    </div>
  )
}
