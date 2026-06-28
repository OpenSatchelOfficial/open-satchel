// Crop dialog for embedded JPEG images.
//
// Shows the original image with a draggable crop rectangle overlay.
// User drags handles to set the source region; on Apply we call
// cropEmbeddedImage which re-encodes the JPEG at the cropped size and
// rewrites the on-page cm so the result lands at the same on-page
// position (or an adjusted rect if the crop changed proportion).

import { useEffect, useRef, useState } from 'react'
import { useFormatStore } from '../../stores/formatStore'
import { useTabStore } from '../../stores/tabStore'
import type { PdfFormatState } from './index'
import { cropEmbeddedImage, listEmbeddedImages } from '../../services/pdfImageOps'
import { listImageDrawsOnPage } from '../../services/pdfImageEdits'

interface Props {
  tabId: string
  pageIndex: number
  xObjectName: string
  onClose: () => void
}

interface Rect { x: number; y: number; w: number; h: number }

export default function CropImageDialog({ tabId, pageIndex, xObjectName, onClose }: Props) {
  const [imgUrl, setImgUrl] = useState<string | null>(null)
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null)
  const [crop, setCrop] = useState<Rect | null>(null)
  const [onPageRect, setOnPageRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const imgRef = useRef<HTMLImageElement>(null)
  const dragRef = useRef<{ sx: number; sy: number; mode: 'create' | 'move' | 'tl' | 'tr' | 'bl' | 'br'; start?: Rect } | null>(null)

  useEffect(() => {
    let cancel = false
    ;(async () => {
      try {
        const state = useFormatStore.getState().data[tabId] as PdfFormatState | undefined
        if (!state) return
        const images = await listEmbeddedImages(state.pdfBytes)
        const rects = await listImageDrawsOnPage(state.pdfBytes, pageIndex)
        const img = images.find((i) => i.pageIndex === pageIndex && i.xObjectName === xObjectName)
        const rect = rects.find((r) => r.xObjectName === xObjectName)
        if (!img || !rect) { setStatus('Image not found'); return }
        // Extract bytes for preview — reuse listEmbeddedImages for metadata
        // but pull extractEmbeddedImages for the actual bytes.
        const { extractEmbeddedImages } = await import('../../services/pdfImageOps')
        const extracted = await extractEmbeddedImages(state.pdfBytes)
        const ex = extracted.find((e) => e.pageIndex === pageIndex && e.xObjectName === xObjectName)
        if (!ex) { setStatus('Could not extract image bytes'); return }
        if (ex.extension !== 'jpg') { setStatus(`Crop supports JPEG only (got: ${ex.filter}).`); return }
        if (cancel) return
        const url = URL.createObjectURL(new Blob([ex.bytes], { type: 'image/jpeg' }))
        setImgUrl(url)
        setImgSize({ w: img.width, h: img.height })
        setCrop({ x: img.width * 0.1, y: img.height * 0.1, w: img.width * 0.8, h: img.height * 0.8 })
        setOnPageRect({ x: rect.x, y: rect.y, w: rect.width, h: rect.height })
      } catch (e) {
        setStatus((e as Error).message)
      }
    })()
    return () => { cancel = true; if (imgUrl) URL.revokeObjectURL(imgUrl) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, pageIndex, xObjectName])

  const displayW = 600
  const displayH = imgSize ? (displayW / imgSize.w) * imgSize.h : 400
  const scale = imgSize ? displayW / imgSize.w : 1

  const toDisplay = (r: Rect) => ({ left: r.x * scale, top: r.y * scale, width: r.w * scale, height: r.h * scale })
  const fromPx = (px: number) => px / scale

  const handleDown = (mode: 'create' | 'move' | 'tl' | 'tr' | 'bl' | 'br') => (e: React.PointerEvent) => {
    e.stopPropagation()
    e.preventDefault()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const rect = imgRef.current?.getBoundingClientRect()
    const sx = rect ? e.clientX - rect.left : 0
    const sy = rect ? e.clientY - rect.top : 0
    dragRef.current = { sx, sy, mode, start: crop ? { ...crop } : undefined }
    if (mode === 'create') {
      setCrop({ x: fromPx(sx), y: fromPx(sy), w: 1, h: 1 })
    }
  }
  const handleMove = (e: React.PointerEvent) => {
    if (!dragRef.current || !crop) return
    const rect = imgRef.current?.getBoundingClientRect()
    if (!rect) return
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const { sx, sy, mode, start } = dragRef.current
    const dxPx = x - sx
    const dyPx = y - sy
    const dxSrc = fromPx(dxPx)
    const dySrc = fromPx(dyPx)
    const max = imgSize ?? { w: 1, h: 1 }
    let next: Rect = { ...crop }
    if (mode === 'create' && start === undefined) {
      const x1 = fromPx(sx), y1 = fromPx(sy), x2 = fromPx(x), y2 = fromPx(y)
      next = {
        x: Math.max(0, Math.min(x1, x2)),
        y: Math.max(0, Math.min(y1, y2)),
        w: Math.min(max.w, Math.abs(x2 - x1)),
        h: Math.min(max.h, Math.abs(y2 - y1)),
      }
    } else if (start) {
      if (mode === 'move') {
        next.x = Math.max(0, Math.min(max.w - start.w, start.x + dxSrc))
        next.y = Math.max(0, Math.min(max.h - start.h, start.y + dySrc))
      } else if (mode === 'tl') {
        next.x = Math.max(0, Math.min(start.x + start.w - 1, start.x + dxSrc))
        next.y = Math.max(0, Math.min(start.y + start.h - 1, start.y + dySrc))
        next.w = start.x + start.w - next.x
        next.h = start.y + start.h - next.y
      } else if (mode === 'tr') {
        next.y = Math.max(0, Math.min(start.y + start.h - 1, start.y + dySrc))
        next.w = Math.max(1, Math.min(max.w - start.x, start.w + dxSrc))
        next.h = start.y + start.h - next.y
      } else if (mode === 'bl') {
        next.x = Math.max(0, Math.min(start.x + start.w - 1, start.x + dxSrc))
        next.w = start.x + start.w - next.x
        next.h = Math.max(1, Math.min(max.h - start.y, start.h + dySrc))
      } else if (mode === 'br') {
        next.w = Math.max(1, Math.min(max.w - start.x, start.w + dxSrc))
        next.h = Math.max(1, Math.min(max.h - start.y, start.h + dySrc))
      }
    }
    setCrop(next)
  }
  const handleUp = () => { dragRef.current = null }

  const apply = async () => {
    if (!crop || !imgSize || !onPageRect) return
    setBusy(true)
    setStatus('Cropping…')
    try {
      const state = useFormatStore.getState().data[tabId] as PdfFormatState | undefined
      if (!state) throw new Error('No PDF state')
      // Scale the on-page rect in proportion to the crop's fraction of the image
      const ratioW = crop.w / imgSize.w
      const ratioH = crop.h / imgSize.h
      const shiftX = (crop.x / imgSize.w) * onPageRect.w
      // PDF y grows up; image pixel y grows down. The on-page top of the
      // image bbox is at y = onPageRect.y + onPageRect.h. If we crop from
      // pixel-y=crop.y (distance from image's PIXEL top), the on-page
      // origin of the cropped result shifts DOWN by crop.y/h * on-page
      // height.
      const shiftY = ((imgSize.h - crop.y - crop.h) / imgSize.h) * onPageRect.h
      const newOnPage = {
        x: onPageRect.x + shiftX,
        y: onPageRect.y + shiftY,
        w: onPageRect.w * ratioW,
        h: onPageRect.h * ratioH,
      }
      const newBytes = await cropEmbeddedImage(
        state.pdfBytes,
        pageIndex,
        xObjectName,
        { sx: crop.x, sy: crop.y, sw: crop.w, sh: crop.h },
        newOnPage,
      )
      useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({
        ...prev, pdfBytes: newBytes,
      }))
      useTabStore.getState().setTabDirty(tabId, true)
      setStatus('Cropped.')
      setTimeout(onClose, 400)
    } catch (e) {
      setStatus(`Error: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
         onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ background: 'var(--bg-primary)', borderRadius: 8, padding: 20, border: '1px solid var(--border)', maxWidth: 720 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>Crop image - {xObjectName}</h3>
          <button onClick={onClose} style={{ fontSize: 18, background: 'transparent', border: 'none', color: 'var(--text-primary)', cursor: 'pointer' }}>✕</button>
        </div>
        {imgUrl && imgSize && crop ? (
          <>
            <div style={{ position: 'relative', width: displayW, height: displayH, background: '#000' }}>
              <img
                ref={imgRef}
                src={imgUrl}
                alt="source"
                draggable={false}
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', userSelect: 'none' }}
                onPointerDown={handleDown('create')}
                onPointerMove={handleMove}
                onPointerUp={handleUp}
                onPointerCancel={handleUp}
              />
              <div
                style={{
                  position: 'absolute',
                  ...toDisplay(crop),
                  border: '2px solid #f9e2af',
                  cursor: 'move',
                  boxShadow: '0 0 0 9999px rgba(0,0,0,0.4)',
                }}
                onPointerDown={handleDown('move')}
                onPointerMove={handleMove}
                onPointerUp={handleUp}
              >
                {(['tl', 'tr', 'bl', 'br'] as const).map((m) => (
                  <div key={m}
                    onPointerDown={handleDown(m)}
                    onPointerMove={handleMove}
                    onPointerUp={handleUp}
                    style={{
                      position: 'absolute',
                      width: 12, height: 12, background: '#f9e2af',
                      cursor: m === 'tl' || m === 'br' ? 'nwse-resize' : 'nesw-resize',
                      left: m.includes('l') ? -6 : undefined,
                      right: m.includes('r') ? -6 : undefined,
                      top: m.includes('t') ? -6 : undefined,
                      bottom: m.includes('b') ? -6 : undefined,
                    }}
                  />
                ))}
              </div>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
              Crop: {Math.round(crop.x)}, {Math.round(crop.y)} - {Math.round(crop.w)}×{Math.round(crop.h)}px
              <span style={{ marginLeft: 10 }}>Source: {imgSize.w}×{imgSize.h}px</span>
            </div>
          </>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: 40, textAlign: 'center' }}>
            {status || 'Loading…'}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          {status && !busy && <span style={{ fontSize: 11, color: 'var(--text-muted)', alignSelf: 'center', marginRight: 'auto' }}>{status}</span>}
          <button onClick={onClose} disabled={busy} style={{ padding: '6px 14px', fontSize: 12 }}>Cancel</button>
          <button onClick={apply} disabled={busy || !crop}
            style={{ padding: '6px 14px', fontSize: 12, background: 'var(--accent)', color: 'var(--bg-primary)', border: 'none', borderRadius: 4, fontWeight: 600, cursor: busy ? 'wait' : 'pointer' }}>
            {busy ? 'Applying…' : 'Apply crop'}
          </button>
        </div>
      </div>
    </div>
  )
}
