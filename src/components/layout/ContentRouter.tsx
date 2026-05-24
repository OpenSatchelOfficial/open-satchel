import { useTabStore } from '../../stores/tabStore'
import { getHandler } from '../../formats/registry'
import EmptyState from './EmptyState'

export default function ContentRouter() {
  const activeTabId = useTabStore((s) => s.activeTabId)
  const tabs = useTabStore((s) => s.tabs)

  if (!activeTabId) return <EmptyState />
  const tab = tabs.find((t) => t.id === activeTabId)
  if (!tab) return <EmptyState />

  const handler = getHandler(tab.format)
  if (!handler) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          color: 'var(--text-muted)',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        <div style={{ fontSize: 28 }}>🚫</div>
        <div style={{ fontSize: 12 }}>Unsupported format: {tab.format}</div>
      </div>
    )
  }

  const Viewer = handler.Viewer
  return <Viewer tabId={activeTabId} />
}
