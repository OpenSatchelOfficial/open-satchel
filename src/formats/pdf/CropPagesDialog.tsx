import { useEffect, useRef, useState } from 'react'
import { useFormatStore } from '../../stores/formatStore'
import { useTabStore } from '../../stores/tabStore'
import type { PdfFormatState } from './index'
import { cropPages } from '../../services/pdfOps'
import { PDFDocument } from 'pdf-lib'

interface Props {
  tabId: string
  onClose: () => void
}

/** Crop pages by drawing a rect on a preview of page 1 and applying to
 *  a range. Wraps pdfOps.cropPages. */
export default function CropPagesDialog({ tabId, onClose }: Props) {
  const state = useFormatStore((s) => s.data[tabId] as PdfFormatState | undefined)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [pageSize, setPageSize] = useState<{ width: number; height: number } | null>(null)
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number }>({ x: 40, y: 40, w: 500, h: 700 })
  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(null)
  const [rangeFrom, setRangeFrom] = useState(1)
  const [rangeTo, setRangeTo] = useState<number | ''>('')
  const [status, setStatus] = useState('')
  const [running, setRunning] = useState(false)

  const DISPLAY_W = 400

  useEffect(() => {
    if (!state) return
    ;(async () => {
      const doc = await PDFDocument.load(state.pdfBytes)
      const page = doc.getPage(0)
      const size = page.getSize()
      setPageSize({ width: size.width, height: size.height })
      setRect({ x: 40, y: 40, w: size.width - 80, h: size.height - 80 })
      const pdfjsLib = await import('pdfjs-dist')
      const pdfjsDoc = await pdfjsLib.getDocument({ data: state.pdfBytes.slice() }).promise
      const pdfjsPage = await pdfjsDoc.getPage(1)
      const scale = DISPLAY_W / size.width
      const viewport = pdfjsPage.getViewport({ scale })
      const canvas = canvasRef.current
      if (!canvas) return
      canvas.width = viewport.width
      canvas.height = viewport.height
      const ctx = canvas.getContext('2d')!
      await pdfjsPage.render({ canvasContext: ctx, viewport }).promise
      pdfjsPage.cleanup()
      pdfjsDoc.destroy()
    })()
  }, [state?.pdfBytes])

  if (!state) return null

  const totalPages = state.pages.filter((p) => !p.deleted).length
  const scale = pageSize ? DISPLAY_W / pageSize.width : 1

  const cssFromPdf = (pdfX: number, pdfY: number, pdfW: number, pdfH: number) => ({
    left: pdfX * scale,
    // PDF y-up → CSS y-down. Rect's PDF y is bottom-left.
    top: pageSize ? (pageSize.height - pdfY - pdfH) * scale : 0,
    width: pdfW * scale,
    height: pdfH * scale,
  })

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pageSize) return
    const target = e.currentTarget
    const r = target.getBoundingClientRect()
    const cx = e.clientX - r.left, cy = e.clientY - r.top
    const pdfX = cx / scale
    const pdfY = pageSize.height - cy / scale
    setDrawStart({ x: pdfX, y: pdfY })
    setRect({ x: pdfX, y: pdfY, w: 0, h: 0 })
    target.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drawStart || !pageSize) return
    const target = e.currentTarget
    const r = target.getBoundingClientRect()
    const cx = e.clientX - r.left, cy = e.clientY - r.top
    const pdfX = cx / scale
    const pdfY = pageSize.height - cy / scale
    const left = Math.min(drawStart.x, pdfX)
    const bottom = Math.min(drawStart.y, pdfY)
    const width = Math.abs(pdfX - drawStart.x)
    const height = Math.abs(pdfY - drawStart.y)
    setRect({ x: left, y: bottom, w: width, h: height })
  }
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    setDrawStart(null)
    e.currentTarget.releasePointerCapture(e.pointerId)
  }

  const apply = async () => {
    setRunning(true)
    setStatus('Cropping…')
    try {
      const to = rangeTo === '' ? totalPages : Math.min(Number(rangeTo), totalPages)
      const pageIndices = Array.from({ length: Math.max(0, to - rangeFrom + 1) }, (_, i) => rangeFrom - 1 + i)
      const bytes = await cropPages(state.pdfBytes, { x: rect.x, y: rect.y, width: rect.w, height: rect.h }, pageIndices)
      useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({ ...prev, pdfBytes: bytes }))
      useTabStore.getState().setTabDirty(tabId, true)
      setStatus(`Cropped ${pageIndices.length} page${pageIndices.length === 1 ? '' : 's'} to ${Math.round(rect.w)}×${Math.round(rect.h)} pt.`)
      setTimeout(onClose, 500)
    } catch (e) {
      setStatus(e instanceof Error ? `Error: ${e.message}` : 'Failed')
    } finally {
      setRunning(false)
    }
  }

  const css = pageSize ? cssFromPdf(rect.x, rect.y, rect.w, rect.h) : { left: 0, top: 0, width: 0, height: 0 }

  return (
    <div
      data-testid="crop-pages-dialog"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: 'var(--bg-primary)', borderRadius: 8, padding: 20,
        border: '1px solid var(--border)', maxWidth: 560,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>Crop Pages</h3>
          <button onClick={onClose} style={{ background:'transparent', border:'none', color:'var(--text-primary)', cursor:'pointer', fontSize:18 }}>✕</button>
        </div>

        <p style={{ margin: '0 0 10px 0', fontSize: 11, color: 'var(--text-secondary)' }}>
          Drag on the preview of page 1 to select the crop area. The same rectangle applies to every page in range.
        </p>

        <div
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          data-testid="crop-preview"
          style={{
            position: 'relative', width: DISPLAY_W,
            border: '1px solid var(--border)',
            margin: '0 auto', background: '#fff',
            cursor: 'crosshair', userSelect: 'none', touchAction: 'none',
          }}>
          <canvas ref={canvasRef} style={{ display: 'block', width: '100%' }} />
          <div style={{
            position: 'absolute',
            left: css.left, top: css.top, width: css.width, height: css.height,
            border: '2px solid var(--accent)',
            background: 'rgba(99,179,237,0.12)',
            pointerEvents: 'none',
          }} />
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <div style={{ flex: 1 }}>
            <Label>From page</Label>
            <input data-testid="crop-from" type="number" min={1} max={totalPages} value={rangeFrom} onChange={(e) => setRangeFrom(Number(e.target.value))} style={inp} />
          </div>
          <div style={{ flex: 1 }}>
            <Label>To page (blank = end)</Label>
            <input data-testid="crop-to" type="number" min={rangeFrom} max={totalPages} value={rangeTo} placeholder={String(totalPages)}
              onChange={(e) => setRangeTo(e.target.value === '' ? '' : Number(e.target.value))} style={inp} />
          </div>
          <div style={{ flex: 2, fontSize: 10, color: 'var(--text-muted)', alignSelf: 'flex-end' }}>
            {Math.round(rect.w)} × {Math.round(rect.h)} pt · starting at ({Math.round(rect.x)}, {Math.round(rect.y)})
          </div>
        </div>

        {status && (
          <div data-testid="crop-status" style={{
            marginTop: 8, padding: 6, background: 'var(--bg-surface)', borderRadius: 3, fontSize: 11,
          }}>{status}</div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button onClick={onClose} style={btnSecondary}>Cancel</button>
          <button data-testid="crop-apply" onClick={apply} disabled={running || rect.w <= 0 || rect.h <= 0} style={btnPrimary}>
            {running ? 'Cropping…' : 'Apply crop'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Label({ children }: { children: React.ReactNode }) {
  return <label style={{ fontSize: 11, color: 'var(--text-secondary)', display: 'block', marginBottom: 3 }}>{children}</label>
}

const inp: React.CSSProperties = {
  width: '100%', padding: '5px 8px', fontSize: 12,
  background: 'var(--bg-surface)', border: '1px solid var(--border)',
  borderRadius: 3, color: 'var(--text-primary)', boxSizing: 'border-box',
}
const btnPrimary: React.CSSProperties = {
  padding: '6px 16px', background: 'var(--accent)', color: 'var(--bg-primary)',
  border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 600,
}
const btnSecondary: React.CSSProperties = {
  padding: '6px 16px', background: 'var(--bg-surface)', color: 'var(--text-primary)',
  border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer', fontSize: 12,
}
