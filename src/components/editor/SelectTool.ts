import type { Canvas } from 'fabric'

export function applySelectTool(canvas: Canvas): void {
  canvas.isDrawingMode = false
  canvas.selection = true
  canvas.defaultCursor = 'default'
  canvas.forEachObject((obj) => {
    obj.selectable = true
    obj.evented = true
  })
}
