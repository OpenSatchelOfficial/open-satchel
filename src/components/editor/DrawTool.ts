import { Canvas, PencilBrush } from 'fabric'
import type { DrawingOptions } from '../../types/pdf'

export function applyDrawTool(canvas: Canvas, options: DrawingOptions): void {
  canvas.isDrawingMode = true
  canvas.selection = false

  const brush = new PencilBrush(canvas)
  brush.color = options.color
  brush.width = options.width
  canvas.freeDrawingBrush = brush
}
