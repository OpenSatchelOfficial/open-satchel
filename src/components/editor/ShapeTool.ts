import { Canvas, Rect, Ellipse, Line, type TPointerEventInfo } from 'fabric'

export type ShapeType = 'rectangle' | 'circle' | 'line' | 'arrow'

export function applyShapeTool(
  canvas: Canvas,
  shapeType: ShapeType,
  color: string,
  strokeWidth: number,
  onSave: () => void
): void {
  canvas.isDrawingMode = false
  canvas.selection = false
  canvas.defaultCursor = 'crosshair'

  let startX = 0
  let startY = 0
  let shape: any = null

  canvas.on('mouse:down', (e: TPointerEventInfo) => {
    if (e.target) return
    const pointer = canvas.getScenePoint(e.e)
    startX = pointer.x
    startY = pointer.y

    switch (shapeType) {
      case 'rectangle':
        shape = new Rect({
          left: startX, top: startY, width: 0, height: 0,
          fill: 'transparent', stroke: color, strokeWidth, selectable: true
        })
        break
      case 'circle':
        shape = new Ellipse({
          left: startX, top: startY, rx: 0, ry: 0,
          fill: 'transparent', stroke: color, strokeWidth, selectable: true
        })
        break
      case 'line':
      case 'arrow':
        shape = new Line([startX, startY, startX, startY], {
          stroke: color, strokeWidth, selectable: true,
          strokeLineCap: 'round'
        })
        ;(shape as any).__isArrow = shapeType === 'arrow'
        break
    }

    if (shape) canvas.add(shape)
  })

  canvas.on('mouse:move', (e: TPointerEventInfo) => {
    if (!shape) return
    const pointer = canvas.getScenePoint(e.e)

    switch (shapeType) {
      case 'rectangle':
        shape.set({
          width: Math.abs(pointer.x - startX),
          height: Math.abs(pointer.y - startY),
          left: Math.min(startX, pointer.x),
          top: Math.min(startY, pointer.y)
        })
        break
      case 'circle':
        shape.set({
          rx: Math.abs(pointer.x - startX) / 2,
          ry: Math.abs(pointer.y - startY) / 2,
          left: Math.min(startX, pointer.x),
          top: Math.min(startY, pointer.y)
        })
        break
      case 'line':
      case 'arrow':
        shape.set({ x2: pointer.x, y2: pointer.y })
        break
    }

    canvas.renderAll()
  })

  canvas.on('mouse:up', () => {
    shape = null
    onSave()
  })
}
