// Manage custom stamps — import PNG/JPEG, view library, remove.
// Stamps persist in localStorage so they survive across sessions.
// The imported stamps render on any page via a drop tool that places
// them as Fabric image objects.

import { useEffect, useState } from 'react'
import { loadCustomStamps, importCustomStampFromFile, removeCustomStamp, type CustomStamp } from '../../components/editor/StampTool'

interface Props {
  onClose: () => void
  onSelect?: (stamp: CustomStamp) => void
}

export default function CustomStampsDialog({ onClose, onSelect }: Props) {
  const [stamps, setStamps] = useState<CustomStamp[]>([])
  const [status, setStatus] = useState('')

  useEffect(() => { setStamps(loadCustomStamps()) }, [])

  const importFile = async () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/png,image/jpeg'
    input.multiple = true
    input.onchange = async () => {
      if (!input.files) return
      let ok = 0
      for (const f of Array.from(input.files)) {
        try { await importCustomStampFromFile(f); ok++ } catch (e) { setStatus(String((e as Error).message)) }
      }
      setStamps(loadCustomStamps())
      if (ok > 0) setStatus(`Imported ${ok} stamp${ok === 1 ? '' : 's'}.`)
    }
    input.click()
  }

  const remove = (id: string) => {
    removeCustomStamp(id)
    setStamps(loadCustomStamps())
  }

  return (
    <div data-testid="custom-stamps-dialog" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
         onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ background: 'var(--bg-primary)', borderRadius: 8, padding: 18, minWidth: 460, maxWidth: 600, border: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>Custom Stamps</h3>
          <button data-testid="cs-close" onClick={onClose} style={{ fontSize: 18, background: 'transparent', border: 'none', color: 'var(--text-primary)', cursor: 'pointer' }}>✕</button>
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          <button data-testid="cs-import" onClick={importFile}
            style={{ padding: '6px 12px', background: 'var(--accent)', color: 'var(--bg-primary)', border: 'none', borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
            + Import PNG/JPEG
          </button>
          {status && <span data-testid="cs-status" style={{ alignSelf: 'center', fontSize: 10, color: 'var(--text-muted)' }}>{status}</span>}
        </div>

        {stamps.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: 18, textAlign: 'center', border: '1px dashed var(--border)', borderRadius: 4 }}>
            No custom stamps yet. Import a PNG/JPEG to build your library.
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 8, maxHeight: 360, overflowY: 'auto' }}>
            {stamps.map((s) => (
              <div key={s.id} style={{ border: '1px solid var(--border)', borderRadius: 4, padding: 6, background: 'var(--bg-surface)', display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ width: '100%', height: 70, background: '#fff', borderRadius: 3, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                  <img src={s.dataUrl} alt={s.label} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.label}>
                  {s.label}
                </div>
                <div style={{ display: 'flex', gap: 3 }}>
                  {onSelect && (
                    <button onClick={() => { onSelect(s); onClose() }}
                      style={{ flex: 1, padding: '2px 4px', fontSize: 9, background: 'var(--accent)', color: 'var(--bg-primary)', border: 'none', borderRadius: 2, cursor: 'pointer', fontWeight: 600 }}>
                      Use
                    </button>
                  )}
                  <button onClick={() => remove(s.id)}
                    title="Remove stamp"
                    style={{ padding: '2px 6px', fontSize: 9, background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 2, cursor: 'pointer' }}>
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 10 }}>
          Stamps persist in localStorage. Use "Save custom stamps to file" in Batch if you need to back them up.
        </div>
      </div>
    </div>
  )
}
