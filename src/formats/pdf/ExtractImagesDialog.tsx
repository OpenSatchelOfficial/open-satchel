import { useEffect, useState } from 'react'
import { useFormatStore } from '../../stores/formatStore'
import type { PdfFormatState } from './index'
import { extractEmbeddedImages, type ExtractedEmbeddedImage } from '../../services/pdfImageOps'

interface Props {
  tabId: string
  onClose: () => void
}

/** Extract embedded image XObjects to disk. Lists all images across
 *  all pages with thumbnails + metadata; user picks individual images
 *  or extracts all at once. Round-trips JPEG streams byte-identical;
 *  other compressions fall back to raw stream bytes. */
export default function ExtractImagesDialog({ tabId, onClose }: Props) {
  const state = useFormatStore((s) => s.data[tabId] as PdfFormatState | undefined)
  const [images, setImages] = useState<ExtractedEmbeddedImage[]>([])
  const [thumbnails, setThumbnails] = useState<Map<number, string>>(new Map())
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState('')

  useEffect(() => {
    if (!state) return
    setLoading(true)
    extractEmbeddedImages(state.pdfBytes).then(async (imgs) => {
      setImages(imgs)
      // Build thumbnails for JPEGs via Blob URL; non-JPEG images are
      // tagged with the filter name instead.
      const thumbs = new Map<number, string>()
      for (let i = 0; i < imgs.length; i++) {
        const img = imgs[i]
        if (img.extension === 'jpg') {
          const url = URL.createObjectURL(new Blob([img.bytes], { type: 'image/jpeg' }))
          thumbs.set(i, url)
        }
      }
      setThumbnails(thumbs)
      setLoading(false)
    })
  }, [state?.pdfBytes])

  if (!state) return null

  const saveOne = async (img: ExtractedEmbeddedImage, idx: number) => {
    const name = `page${img.pageIndex + 1}-${img.xObjectName}.${img.extension}`
    ;(globalThis as unknown as { __lastSavedName?: string }).__lastSavedName = name
    const ok = await window.api.file.saveAs(img.bytes)
    if (ok) setStatus(`Saved ${name}.`)
    void idx
  }

  const saveAll = async () => {
    setStatus(`Extracting ${images.length} image${images.length === 1 ? '' : 's'}…`)
    let saved = 0
    for (const img of images) {
      const name = `page${img.pageIndex + 1}-${img.xObjectName}.${img.extension}`
      ;(globalThis as unknown as { __lastSavedName?: string }).__lastSavedName = name
      const ok = await window.api.file.saveAs(img.bytes)
      if (ok) saved++
    }
    setStatus(`Saved ${saved} of ${images.length} files.`)
  }

  const saveAllToFolder = async () => {
    const isTauri = typeof (globalThis as unknown as { __isTauri?: boolean }).__isTauri === 'boolean'
      ? (globalThis as unknown as { __isTauri?: boolean }).__isTauri
      : typeof (globalThis as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined'
    if (!isTauri) {
      setStatus('Extract to folder requires the Tauri desktop build. Use "Save as…" per image in browser mode.')
      return
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dialog = await import('@tauri-apps/plugin-dialog') as any
      const picked = await dialog.open({ directory: true, multiple: false, title: 'Pick destination folder' })
      if (!picked) return
      const destPath = typeof picked === 'string' ? picked : (picked as { path: string }).path
      const sep = destPath.includes('\\') ? '\\' : '/'
      setStatus(`Saving ${images.length} image${images.length === 1 ? '' : 's'} to ${destPath}…`)
      let saved = 0
      for (const img of images) {
        const name = `page${img.pageIndex + 1}-${img.xObjectName}.${img.extension}`
        const full = `${destPath}${sep}${name}`
        try {
          await window.api.file.save(img.bytes, full)
          saved++
        } catch (e) {
          console.warn('Failed to save', full, e)
        }
      }
      setStatus(`Saved ${saved} of ${images.length} file(s) to ${destPath}.`)
    } catch (e) {
      setStatus(`Error: ${(e as Error).message}`)
    }
  }

  return (
    <div
      data-testid="extract-images-dialog"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: 'var(--bg-primary)', borderRadius: 8, padding: 20,
        border: '1px solid var(--border)', width: '72vw', maxWidth: 860,
        maxHeight: '80vh', display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>Extract Embedded Images</h3>
          <button onClick={onClose} style={{ background:'transparent', border:'none', color:'var(--text-primary)', cursor:'pointer', fontSize:18 }}>✕</button>
        </div>

        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 10 }}>
          {loading ? 'Scanning pages…' :
            images.length === 0 ? 'No embedded images found.' :
            `Found ${images.length} image${images.length === 1 ? '' : 's'} across ${new Set(images.map(i => i.pageIndex)).size} page${new Set(images.map(i => i.pageIndex)).size === 1 ? '' : 's'}.`}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 4 }}>
          {images.length > 0 && (
            <div
              data-testid="extract-images-grid"
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
                gap: 10,
              }}>
              {images.map((img, i) => (
                <div key={i} data-testid={`img-${i}`}
                  style={{
                    border: '1px solid var(--border)', borderRadius: 4,
                    background: 'var(--bg-surface)',
                    padding: 6, display: 'flex', flexDirection: 'column', gap: 4,
                  }}>
                  <div style={{
                    width: '100%', height: 100,
                    background: '#1a1a1a', borderRadius: 3,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    overflow: 'hidden',
                  }}>
                    {thumbnails.get(i) ? (
                      <img src={thumbnails.get(i)!}
                        alt={img.xObjectName}
                        style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
                    ) : (
                      <span style={{ fontSize: 10, color: 'var(--text-muted)', textAlign: 'center', padding: 4 }}>
                        {img.filter}<br />({img.extension})
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-primary)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {img.xObjectName}
                  </div>
                  <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>
                    Page {img.pageIndex + 1} · {img.width}×{img.height} · {formatSize(img.bytes.byteLength)}
                  </div>
                  <button
                    data-testid={`extract-${i}`}
                    onClick={() => saveOne(img, i)}
                    style={{
                      padding: '3px 6px', fontSize: 10, borderRadius: 3,
                      background: 'var(--accent)', color: 'var(--bg-primary)',
                      border: 'none', cursor: 'pointer', fontWeight: 600,
                    }}>
                    Save as…
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {status && (
          <div data-testid="extract-status" style={{
            marginTop: 10, padding: 6, background: 'var(--bg-surface)', borderRadius: 3,
            fontSize: 11, color: 'var(--text-primary)',
          }}>{status}</div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button onClick={onClose} style={{
            padding: '6px 16px', background: 'var(--bg-surface)', color: 'var(--text-primary)',
            border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer', fontSize: 12,
          }}>Close</button>
          <button
            data-testid="extract-all-folder"
            onClick={saveAllToFolder}
            disabled={images.length === 0}
            style={{
              padding: '6px 14px', background: 'var(--bg-surface)', color: 'var(--text-primary)',
              border: '1px solid var(--border)', borderRadius: 4, cursor: images.length ? 'pointer' : 'not-allowed',
              fontSize: 12,
            }}
            title="Save all images into one folder (Tauri only)">
            Save all to folder…
          </button>
          <button
            data-testid="extract-all"
            onClick={saveAll}
            disabled={images.length === 0}
            style={{
              padding: '6px 16px', background: images.length ? 'var(--accent)' : 'var(--bg-surface)',
              color: images.length ? 'var(--bg-primary)' : 'var(--text-muted)',
              border: 'none', borderRadius: 4, cursor: images.length ? 'pointer' : 'not-allowed',
              fontSize: 12, fontWeight: 600,
            }}>
            Extract all ({images.length})
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
