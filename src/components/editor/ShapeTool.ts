import { Canvas, Rect, Ellipse, Line, type TPointerEventInfo } from 'fabric'

export type ShapeType = 'rectangle' | 'circle' | 'line' | 'arrow'

const baseLineRender = (Line.prototype as unknown as {
  _render(this: Line, ctx: CanvasRenderingContext2D): void
})._render

export function decorateArrowLine(line: Line): Line {
  const target = line as Line & {
    __isArrow?: boolean
    __openSatchelArrowDecorated?: boolean
    stroke?: unknown
    strokeWidth?: number
    calcLinePoints: () => { x1: number; y1: number; x2: number; y2: number }
    _render: (ctx: CanvasRenderingContext2D) => void
  }
  target.__isArrow = true
  if (target.__openSatchelArrowDecorated) return line
  target.__openSatchelArrowDecorated = true
  target._render = function renderOpenSatchelArrow(ctx: CanvasRenderingContext2D) {
    baseLineRender.call(this, ctx)
    if (!this.__isArrow) return

    const p = this.calcLinePoints()
    const dx = p.x2 - p.x1
    const dy = p.y2 - p.y1
    const lineLen = Math.hypot(dx, dy)
    if (lineLen < 2) return

    const angle = Math.atan2(dy, dx)
    const headLen = Math.min(Math.max((this.strokeWidth || 1) * 4.5, 10), lineLen * 0.45)
    const wing = Math.PI / 6

    ctx.save()
    ctx.beginPath()
    ctx.moveTo(p.x2, p.y2)
    ctx.lineTo(p.x2 - headLen * Math.cos(angle - wing), p.y2 - headLen * Math.sin(angle - wing))
    ctx.moveTo(p.x2, p.y2)
    ctx.lineTo(p.x2 - headLen * Math.cos(angle + wing), p.y2 - headLen * Math.sin(angle + wing))
    ctx.lineWidth = this.strokeWidth || 1
    if (typeof this.stroke === 'string') ctx.strokeStyle = this.stroke
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.stroke()
    ctx.restore()
  }
  return line
}

export function decorateArrowLines(canvas: Canvas): void {
  canvas.getObjects().forEach((obj) => {
    if ((obj as any).__isArrow && String(obj.type).toLowerCase() === 'line') {
      decorateArrowLine(obj as Line)
    }
  })
}

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
    ;(canvas as any).__dragCreateActive = true
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
        if (shapeType === 'arrow') decorateArrowLine(shape)
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
    ;(canvas as any).__dragCreateActive = false
    if (shape) {
      const tooSmall =
        shapeType === 'rectangle' ? (shape.width || 0) < 5 || (shape.height || 0) < 5 :
          shapeType === 'circle' ? (shape.rx || 0) < 3 || (shape.ry || 0) < 3 :
            Math.hypot((shape.x2 || 0) - (shape.x1 || 0), (shape.y2 || 0) - (shape.y1 || 0)) < 5
      if (tooSmall) canvas.remove(shape)
    }
    shape = null
    onSave()
  })
}
