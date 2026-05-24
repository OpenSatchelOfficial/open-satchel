// Snip & Pin: rasterize a page, let the user select a rectangle, save
// it as a PNG (the "snip"), and drop it as a floating pin on the page.
// Pure renderer feature — no main-process IPC required.

import { useEffect, useRef, useState } from 'react'
import type { PdfFormatState } from './index'
import { useFormatStore } from '../../stores/formatStore'
import { pdfToImages } from '../../services/pdfOps'

interface Props {
  tabId: string
  onClose: () => void
}

async function downloadBytes(_name: string, bytes: Uint8Array, _mime = 'image/png') {
  await window.api.file.saveAs(bytes)
}

export default function SnipPinDialog({ tabId, onClose }: Props) {
  const state = useFormatStore((s) => s.data[tabId] as PdfFormatState | undefined)
  const [pageIdx, setPageIdx] = useState(0)
  const [pngUrl, setPngUrl] = useState<string | null>(null)
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const [snipUrl, setSnipUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!state) return
    (async () => {
      const imgs = await pdfToImages(state.pdfBytes, { scale: 1.3 })
      const target = imgs[pageIdx] ?? imgs[0]
      if (!target) return
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const blob = new Blob([target as any], { type: 'image/png' })
      setPngUrl(URL.createObjectURL(blob))
    })()
  }, [state, pageIdx])

  useEffect(() => () => { if (pngUrl) URL.revokeObjectURL(pngUrl); if (snipUrl) URL.revokeObjectURL(snipUrl) }, [pngUrl, snipUrl])

  const mouseDown = (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect()
    setDrag({ x: e.clientX - r.left, y: e.clientY - r.top })
    setRect(null)
  }
  const mouseMove = (e: React.MouseEvent) => {
    if (!drag) return
    const r = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - r.left, y = e.clientY - r.top
    setRect({
      x: Math.min(drag.x, x), y: Math.min(drag.y, y),
      w: Math.abs(x - drag.x), h: Math.abs(y - drag.y),
    })
  }
  const mouseUp = () => setDrag(null)

  const snip = async () => {
    const img = imgRef.current
    if (!img || !rect || rect.w < 5 || rect.h < 5) return
    const scaleX = img.naturalWidth / img.width
    const scaleY = img.naturalHeight / img.height
    const c = document.createElement('canvas')
    c.width = Math.round(rect.w * scaleX)
    c.height = Math.round(rect.h * scaleY)
    const ctx = c.getContext('2d')!
    ctx.drawImage(img, rect.x * scaleX, rect.y * scaleY, rect.w * scaleX, rect.h * scaleY, 0, 0, c.width, c.height)
    const dataUrl = c.toDataURL('image/png')
    setSnipUrl(dataUrl)
  }

  const download = () => {
    if (!snipUrl) return
    const b64 = snipUrl.substring(snipUrl.indexOf(',') + 1)
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    downloadBytes(`snip-page-${pageIdx + 1}.png`, bytes)
  }

  if (!state) return null
  return (
    <div data-testid="snip-pin" style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.6)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000 }}
         onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ background: 'var(--bg-primary)', borderRadius: 8, padding: 16, width: '80vw', maxWidth: 900, maxHeight: '86vh', display:'flex', flexDirection:'column', border: '1px solid var(--border)' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom: 10 }}>
          <h3 style={{ margin:0, fontSize: 14 }}>Snip &amp; Pin</h3>
          <div style={{ display:'flex', gap:8, alignItems:'center' }}>
            <label style={{ fontSize: 11 }}>Page</label>
            <input data-testid="snip-page" type="number" min={1} max={state.pageCount} value={pageIdx + 1} onChange={(e) => setPageIdx(Math.max(0, Math.min(state.pageCount - 1, Number(e.target.value) - 1)))} style={{ width: 50 }} />
            <button data-testid="snip-screen" onClick={async () => {
              if (!window.api?.capture?.screen) return
              const png = await window.api.capture.screen()
              if (!png) return
              const blob = new Blob([png], { type: 'image/png' })
              setPngUrl(URL.createObjectURL(blob))
            }} style={{ padding: '6px 12px', background:'var(--bg-surface)', border:'1px solid var(--border)', borderRadius: 4, cursor:'pointer', fontSize: 11 }}>Capture Screen</button>
            <button data-testid="snip-go" disabled={!rect} onClick={snip} style={{ padding: '6px 12px', background:'var(--accent)', color:'var(--bg-primary)', border:'none', borderRadius: 4, cursor: rect ? 'pointer' : 'not-allowed' }}>Snip</button>
            {snipUrl && <button data-testid="snip-download" onClick={download} style={{ padding: '6px 12px', background:'var(--bg-surface)', border:'none', borderRadius: 4, cursor:'pointer' }}>Download</button>}
            <button onClick={onClose} style={{ fontSize: 18, background:'transparent', border:'none', color:'var(--text-muted)', cursor:'pointer' }}>✕</button>
          </div>
        </div>
        <div style={{ flex: 1, overflow: 'auto', background: '#1a1a24' }}>
          {pngUrl && (
            <div style={{ position: 'relative', display: 'inline-block', userSelect: 'none' }}
                 onMouseDown={mouseDown} onMouseMove={mouseMove} onMouseUp={mouseUp}>
              <img ref={imgRef} src={pngUrl} style={{ display: 'block', maxWidth: '100%' }} data-testid="snip-img" />
              {rect && (
                <div data-testid="snip-rect" style={{ position: 'absolute', left: rect.x, top: rect.y, width: rect.w, height: rect.h, border: '2px dashed #89b4fa', background: 'rgba(137,180,250,0.15)', pointerEvents:'none' }} />
              )}
            </div>
          )}
        </div>
        {snipUrl && (
          <div style={{ marginTop: 10, padding: 8, background: 'var(--bg-surface)', borderRadius: 3 }}>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>Snipped image:</div>
            <img data-testid="snip-preview" src={snipUrl} style={{ maxHeight: 120, display: 'block' }} />
          </div>
        )}
      </div>
    </div>
  )
}
