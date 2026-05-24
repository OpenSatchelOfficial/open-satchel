// OCG (Optional Content Groups) layers panel.
//
// Lists every OCG in the open PDF with its name + default visibility
// and a toggle switch. Toggling writes to the catalog's
// /OCProperties/D/ON and /OFF arrays and saves. Acrobat / Foxit respect
// the new defaults on next open.

import { useEffect, useState } from 'react'
import { useFormatStore } from '../../stores/formatStore'
import { useTabStore } from '../../stores/tabStore'
import type { PdfFormatState } from './index'
import { listOcgs, setOcgVisibility, type OcgInfo } from '../../services/pdfMisc'

interface Props { tabId: string; onClose: () => void }

export default function OcgLayersDialog({ tabId, onClose }: Props) {
  const state = useFormatStore((s) => s.data[tabId] as PdfFormatState | undefined)
  const [ocgs, setOcgs] = useState<OcgInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState('')

  useEffect(() => {
    if (!state) return
    listOcgs(state.pdfBytes).then((list) => {
      setOcgs(list)
      setLoading(false)
    }).catch((e) => { setStatus((e as Error).message); setLoading(false) })
  }, [state?.pdfBytes])

  const toggle = async (id: string, visible: boolean) => {
    if (!state) return
    setStatus(`Toggling…`)
    try {
      const out = await setOcgVisibility(state.pdfBytes, id, visible)
      useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({ ...prev, pdfBytes: out }))
      useTabStore.getState().setTabDirty(tabId, true)
      const refreshed = await listOcgs(out)
      setOcgs(refreshed)
      setStatus('Saved.')
    } catch (e) {
      setStatus(`Error: ${(e as Error).message}`)
    }
  }

  return (
    <div data-testid="ocg-layers-dialog" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
         onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ background: 'var(--bg-primary)', borderRadius: 8, padding: 20, minWidth: 460, maxWidth: 620, border: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>Layers (OCG)</h3>
          <button data-testid="ocg-close" onClick={onClose} style={{ fontSize: 18, background: 'transparent', border: 'none', color: 'var(--text-primary)', cursor: 'pointer' }}>✕</button>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>
          Toggle layer visibility. Changes write to the PDF catalog's default ON/OFF arrays and save immediately.
        </div>
        {loading ? (
          <div data-testid="ocg-scanning" style={{ padding: 20, fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>Scanning…</div>
        ) : ocgs.length === 0 ? (
          <div data-testid="ocg-empty" style={{ padding: 20, fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', border: '1px dashed var(--border)', borderRadius: 4 }}>
            No layers found in this PDF.
          </div>
        ) : (
          <div data-testid="ocg-list" style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 360, overflowY: 'auto' }}>
            {ocgs.map((g) => (
              <div
                key={g.id}
                data-testid={`ocg-row-${g.id}`}
                data-ocg-name={g.name}
                data-ocg-visible={g.visible ? '1' : '0'}
                data-ocg-locked={g.locked ? '1' : '0'}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 6, background: 'var(--bg-surface)', borderRadius: 3, opacity: g.locked ? 0.6 : 1 }}
              >
                <input
                  type="checkbox"
                  data-testid={`ocg-toggle-${g.id}`}
                  checked={g.visible}
                  disabled={g.locked}
                  onChange={(e) => toggle(g.id, e.target.checked)}
                />
                <span style={{ flex: 1, fontSize: 12, color: 'var(--text-primary)' }}>{g.name}</span>
                <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>{g.intent}</span>
                {g.locked && <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>🔒 locked</span>}
              </div>
            ))}
          </div>
        )}
        {status && <div data-testid="ocg-status" style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 10 }}>{status}</div>}
      </div>
    </div>
  )
}
