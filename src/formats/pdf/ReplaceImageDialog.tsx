import { useEffect, useState } from 'react'
import { useFormatStore } from '../../stores/formatStore'
import { useTabStore } from '../../stores/tabStore'
import type { PdfFormatState } from './index'
import { listEmbeddedImages, replaceEmbeddedImage, type EmbeddedImage } from '../../services/pdfImageOps'

interface Props {
  tabId: string
  onClose: () => void
}

/** Replace an existing embedded image XObject with new JPEG bytes.
 *  Preserves pd-lib refs so the image's drawing CTM still works and
 *  all references to the XObject update in place. */
export default function ReplaceImageDialog({ tabId, onClose }: Props) {
  const state = useFormatStore((s) => s.data[tabId] as PdfFormatState | undefined)
  const [images, setImages] = useState<EmbeddedImage[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<EmbeddedImage | null>(null)
  const [status, setStatus] = useState('')
  const [running, setRunning] = useState(false)

  useEffect(() => {
    if (!state) return
    setLoading(true)
    listEmbeddedImages(state.pdfBytes).then((list) => {
      setImages(list)
      setLoading(false)
      if (list.length === 1) setSelected(list[0])
    })
  }, [state?.pdfBytes])

  if (!state) return null

  const pickReplacement = () => {
    if (!selected) return
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/jpeg,image/png'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      setRunning(true)
      setStatus(`Reading ${file.name}…`)
      try {
        const raw = new Uint8Array(await file.arrayBuffer())
        // Decode to get actual dimensions
        const bitmap = await createImageBitmap(new Blob([raw]))
        let jpegBytes = raw
        // Convert PNG to JPEG at source resolution; replaceEmbeddedImage
        // hard-assumes JPEG for the stream's /Filter rewrite.
        if (!(raw[0] === 0xFF && raw[1] === 0xD8)) {
          setStatus('Converting PNG → JPEG…')
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
          const ctx = canvas.getContext('2d')!
          ctx.drawImage(bitmap, 0, 0)
          const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 })
          jpegBytes = new Uint8Array(await blob.arrayBuffer())
        }
        setStatus('Rewriting XObject stream…')
        const newBytes = await replaceEmbeddedImage(
          state.pdfBytes,
          selected.pageIndex,
          selected.xObjectName,
          jpegBytes,
          bitmap.width,
          bitmap.height,
        )
        bitmap.close()
        useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({ ...prev, pdfBytes: newBytes }))
        useTabStore.getState().setTabDirty(tabId, true)
        setStatus(`Replaced ${selected.xObjectName} with ${file.name} (${bitmap.width}×${bitmap.height}).`)
        // Refresh the list — dimensions changed.
        const refreshed = await listEmbeddedImages(newBytes)
        setImages(refreshed)
        setSelected(refreshed.find((i) => i.xObjectName === selected.xObjectName && i.pageIndex === selected.pageIndex) ?? null)
        // Auto-close so callers don't have to manually dismiss after
        // a successful replace. 500ms gives the user a beat to read
        // the status message.
        setTimeout(onClose, 500)
      } catch (e) {
        setStatus(e instanceof Error ? `Error: ${e.message}` : 'Failed')
      } finally {
        setRunning(false)
      }
    }
    input.click()
  }

  return (
    <div
      data-testid="replace-image-dialog"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: 'var(--bg-primary)', borderRadius: 8, padding: 20,
        border: '1px solid var(--border)', width: 500, maxHeight: '80vh',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>Replace Image</h3>
          <button onClick={onClose} style={{ background:'transparent', border:'none', color:'var(--text-primary)', cursor:'pointer', fontSize:18 }}>✕</button>
        </div>

        <p style={{ margin: '0 0 10px 0', fontSize: 11, color: 'var(--text-secondary)' }}>
          Pick an embedded image from the document, then select a replacement file. The image XObject's stream is rewritten in place — position + scale from the content stream's cm are preserved.
        </p>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {loading ? (
            <div style={{ padding: 16, fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>Scanning…</div>
          ) : images.length === 0 ? (
            <div style={{ padding: 16, fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>
              No embedded images in this document.
            </div>
          ) : (
            images.map((img, i) => {
              const isSel = selected?.xObjectName === img.xObjectName && selected.pageIndex === img.pageIndex
              return (
                <div key={i} data-testid={`img-opt-${i}`}
                  onClick={() => setSelected(img)}
                  style={{
                    padding: 8, borderRadius: 4, cursor: 'pointer',
                    background: isSel ? 'rgba(99,179,237,0.08)' : 'var(--bg-surface)',
                    border: isSel ? '1px solid var(--accent)' : '1px solid var(--border)',
                    marginBottom: 3, display: 'flex', alignItems: 'center', gap: 8,
                  }}>
                  <input type="radio" checked={isSel} onChange={() => setSelected(img)} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-primary)' }}>
                      {img.xObjectName}
                    </div>
                    <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>
                      Page {img.pageIndex + 1} · {img.width}×{img.height} · {img.filter} · {formatSize(img.byteLength)}
                    </div>
                  </div>
                </div>
              )
            })
          )}
        </div>

        {status && (
          <div data-testid="replace-status" style={{
            marginTop: 10, padding: 6, background: 'var(--bg-surface)', borderRadius: 3,
            fontSize: 11, color: 'var(--text-primary)',
          }}>{status}</div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button onClick={onClose} style={{
            padding: '6px 16px', background: 'var(--bg-surface)', color: 'var(--text-primary)',
            border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer', fontSize: 12,
          }}>Cancel</button>
          <button data-testid="replace-pick" onClick={pickReplacement} disabled={!selected || running} style={{
            padding: '6px 16px',
            background: (!selected || running) ? 'var(--bg-surface)' : 'var(--accent)',
            color: (!selected || running) ? 'var(--text-muted)' : 'var(--bg-primary)',
            border: 'none', borderRadius: 4,
            cursor: (!selected || running) ? 'not-allowed' : 'pointer',
            fontSize: 12, fontWeight: 600,
          }}>
            {running ? 'Replacing…' : 'Pick replacement…'}
          </button>
        </div>
      </div>
    </div>
  )
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}
