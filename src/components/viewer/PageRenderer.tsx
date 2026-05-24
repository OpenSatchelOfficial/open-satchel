import { useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { useUIStore } from '../../stores/uiStore'
import FabricCanvas from '../editor/FabricCanvas'

interface Props {
  pdfDoc: PDFDocumentProxy
  pageIndex: number
  displayIndex: number
  rotation: number
}

export default function PageRenderer({ pdfDoc, pageIndex, displayIndex, rotation }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const zoom = useUIStore((s) => s.zoom)
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let cancelled = false

    const render = async () => {
      try {
        const page = await pdfDoc.getPage(pageIndex + 1)
        if (cancelled) {
          page.cleanup()
          return
        }

        const viewport = page.getViewport({ scale: zoom * window.devicePixelRatio, rotation })
        const displayViewport = page.getViewport({ scale: zoom, rotation })

        canvas.width = viewport.width
        canvas.height = viewport.height
        canvas.style.width = `${displayViewport.width}px`
        canvas.style.height = `${displayViewport.height}px`

        setDimensions({ width: displayViewport.width, height: displayViewport.height })

        const ctx = canvas.getContext('2d')!
        await page.render({ canvasContext: ctx, viewport }).promise
        page.cleanup()
      } catch (err) {
        if (!cancelled) console.error('Failed to render page:', err)
      }
    }

    render()

    return () => {
      cancelled = true
    }
  }, [pdfDoc, pageIndex, zoom, rotation])

  return (
    <div
      data-page-display-index={displayIndex}
      style={{
        position: 'relative',
        marginBottom: 12,
        boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
        background: '#fff'
      }}
    >
      <canvas
        ref={canvasRef}
        style={{ display: 'block', pointerEvents: 'none' }}
      />
      {dimensions && (
        <FabricCanvas
          pageIndex={pageIndex}
          width={dimensions.width}
          height={dimensions.height}
        />
      )}
    </div>
  )
}
