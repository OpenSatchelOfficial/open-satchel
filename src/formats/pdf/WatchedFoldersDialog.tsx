// Hot-folder watcher UI. Lists currently-watched folders, lets the
// user add a new one (folder + optional .action.json), or remove
// existing watches. Tauri-only — browser mode shows a "requires Tauri"
// banner because OS file-watchers aren't reachable from the sandbox.

import { useEffect, useState } from 'react'
import { useHotFolderWatch, type HotFolderEntry } from '../../services/hotFolder'

interface Props { onClose: () => void }

export default function WatchedFoldersDialog({ onClose }: Props) {
  const [watches, setWatches] = useState<HotFolderEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const { addWatch, removeWatch, refresh } = useHotFolderWatch()

  const isTauri = typeof (globalThis as unknown as { __isTauri?: boolean }).__isTauri === 'boolean'
    ? (globalThis as unknown as { __isTauri?: boolean }).__isTauri
    : typeof (globalThis as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined'

  useEffect(() => {
    refresh().then(setWatches).catch(() => void 0)
  }, [refresh])

  const handleAdd = async () => {
    setBusy(true)
    setStatus('')
    try {
      const added = await addWatch()
      if (added) {
        setWatches(await refresh())
        setStatus(`Watching ${added.path}`)
      } else {
        setStatus('Cancelled.')
      }
    } catch (e) {
      setStatus(`Error: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const handleRemove = async (id: string) => {
    setBusy(true)
    try {
      await removeWatch(id)
      setWatches(await refresh())
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-testid="watched-folders-dialog" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
         onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ background: 'var(--bg-primary)', borderRadius: 8, padding: 20, minWidth: 520, maxWidth: 680, border: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 14 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>Watched Folders (Hot-Folder Automation)</h3>
          <button data-testid="wf-close" onClick={onClose} style={{ fontSize: 18, background: 'transparent', border: 'none', color: 'var(--text-primary)', cursor: 'pointer' }}>✕</button>
        </div>

        {!isTauri && (
          <div style={{ fontSize: 12, padding: 10, background: 'var(--bg-surface)', borderLeft: '3px solid #f9e2af', marginBottom: 12 }}>
            Hot-folder watch requires the Tauri desktop build — browsers don't expose OS file-system watchers. Run <code>npm run tauri:dev</code>.
          </div>
        )}

        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
          When a new PDF lands in a watched folder, the selected .action.json workflow runs automatically. Output is saved next to the source file.
        </div>

        {watches.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: 16, textAlign: 'center', border: '1px dashed var(--border)', borderRadius: 4, marginBottom: 10 }}>
            No folders being watched.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
            {watches.map((w) => (
              <div key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 8, background: 'var(--bg-surface)', borderRadius: 4 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={w.path}>
                    📁 {w.path}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={w.actionJsonPath ?? 'No action assigned'}>
                    Action: {w.actionJsonPath ? w.actionJsonPath.split(/[/\\]/).pop() : '(none — will prompt per file)'}
                  </div>
                </div>
                <button data-testid={`wf-stop-${w.id}`} onClick={() => handleRemove(w.id)} disabled={busy}
                  style={{ padding: '4px 10px', fontSize: 11, cursor: busy ? 'wait' : 'pointer' }}>
                  Stop
                </button>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          <button data-testid="wf-add" onClick={handleAdd} disabled={busy || !isTauri}
            style={{ padding: '6px 12px', background: isTauri ? 'var(--accent)' : 'var(--bg-surface)', color: isTauri ? 'var(--bg-primary)' : 'var(--text-muted)', border: 'none', borderRadius: 4, cursor: isTauri ? 'pointer' : 'not-allowed', fontSize: 12 }}>
            + Add Folder…
          </button>
          <div data-testid="wf-status" style={{ flex: 1, fontSize: 11, color: 'var(--text-muted)', alignSelf: 'center' }}>{status}</div>
        </div>
      </div>
    </div>
  )
}
