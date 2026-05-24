import { useEffect, useRef, useCallback } from 'react'
import { Canvas as FabricCanvasClass } from 'fabric'
import { useUIStore } from '../../stores/uiStore'
import { useDocumentStore } from '../../stores/documentStore'
import { applySelectTool } from './SelectTool'
import { applyTextTool } from './TextTool'
import { applyDrawTool } from './DrawTool'
import { applyImageTool } from './ImageTool'

interface Props {
  pageIndex: number
  width: number
  height: number
}

export default function FabricCanvas({ pageIndex, width, height }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fabricRef = useRef<FabricCanvasClass | null>(null)
  const tool = useUIStore((s) => s.tool)
  const drawingOptions = useUIStore((s) => s.drawingOptions)
  const textOptions = useUIStore((s) => s.textOptions)
  const updatePageFabricJSON = useDocumentStore((s) => s.updatePageFabricJSON)
  const fabricJSON = useDocumentStore((s) => {
    const page = s.pages.find((p) => p.pageIndex === pageIndex)
    return page?.fabricJSON ?? null
  })

  const saveState = useCallback(() => {
    const fc = fabricRef.current
    if (!fc) return
    const json = fc.toJSON() as Record<string, unknown>
    updatePageFabricJSON(pageIndex, json)
  }, [pageIndex, updatePageFabricJSON])

  // Initialize fabric canvas
  useEffect(() => {
    const el = canvasRef.current
    if (!el || fabricRef.current) return

    const fc = new FabricCanvasClass(el, {
      width,
      height,
      selection: true,
      preserveObjectStacking: true
    })

    // Restore saved state
    if (fabricJSON) {
      fc.loadFromJSON(fabricJSON).then(() => {
        fc.renderAll()
      })
    }

    fc.on('object:added', saveState)
    fc.on('object:modified', saveState)
    fc.on('object:removed', saveState)

    fabricRef.current = fc

    return () => {
      saveState()
      fc.dispose()
      fabricRef.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Update dimensions
  useEffect(() => {
    const fc = fabricRef.current
    if (!fc) return
    fc.setDimensions({ width, height })
  }, [width, height])

  // Apply tool
  useEffect(() => {
    const fc = fabricRef.current
    if (!fc) return

    // Reset drawing mode
    fc.isDrawingMode = false
    fc.selection = true
    fc.defaultCursor = 'default'

    // Remove previous click handlers
    fc.off('mouse:down')

    switch (tool) {
      case 'select':
        applySelectTool(fc)
        break
      case 'text':
        applyTextTool(fc, textOptions, saveState)
        break
      case 'draw':
        applyDrawTool(fc, drawingOptions)
        break
      case 'image':
        applyImageTool(fc, saveState)
        break
      case 'signature':
        // Signature tool uses same placement as image, handled separately
        fc.defaultCursor = 'crosshair'
        break
      default:
        applySelectTool(fc)
    }
  }, [tool, drawingOptions, textOptions, saveState])

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: `${width}px`,
        height: `${height}px`
      }}
    />
  )
}
