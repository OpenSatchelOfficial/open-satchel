// Fill & Sign quick-stamps: Cross (X), Check (✓), Circle (◯), Line (—),
// Dot (•), Date (MM/DD/YYYY), Initials, Timestamp. Each is a
// click-to-place tool that drops a small fabric object at the cursor.

import { Canvas, Line, Circle, Textbox, Group, type TPointerEventInfo } from 'fabric'

function onClickPlace(canvas: Canvas, onSave: () => void, factory: (x: number, y: number) => unknown | Promise<unknown>) {
  canvas.isDrawingMode = false
  canvas.selection = false
  canvas.defaultCursor = 'crosshair'
  canvas.on('mouse:down', async (e: TPointerEventInfo) => {
    if (e.target) return
    const p = canvas.getScenePoint(e.e)
    const obj = await factory(p.x, p.y)
    if (obj) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      canvas.add(obj as any)
      canvas.renderAll()
      onSave()
    }
  })
}

export function applyFillCrossTool(canvas: Canvas, color: string, onSave: () => void): void {
  onClickPlace(canvas, onSave, (x, y) => {
    const size = 12
    const l1 = new Line([x - size, y - size, x + size, y + size], { stroke: color, strokeWidth: 2, selectable: true })
    const l2 = new Line([x - size, y + size, x + size, y - size], { stroke: color, strokeWidth: 2, selectable: true })
    return new Group([l1, l2], { selectable: true })
  })
}

export function applyFillCheckTool(canvas: Canvas, color: string, onSave: () => void): void {
  onClickPlace(canvas, onSave, (x, y) => {
    return new Textbox('✓', {
      left: x - 8, top: y - 10, fontSize: 20,
      fill: color, fontWeight: 'bold', selectable: true, width: 20,
    })
  })
}

export function applyFillCircleTool(canvas: Canvas, color: string, onSave: () => void): void {
  onClickPlace(canvas, onSave, (x, y) => {
    return new Circle({
      left: x - 10, top: y - 10, radius: 10,
      fill: 'transparent', stroke: color, strokeWidth: 2, selectable: true,
    })
  })
}

export function applyFillLineTool(canvas: Canvas, color: string, onSave: () => void): void {
  // Click-drag variant — user wants a short straight stroke.
  canvas.isDrawingMode = false
  canvas.selection = false
  canvas.defaultCursor = 'crosshair'
  let startX = 0, startY = 0, line: Line | null = null
  canvas.on('mouse:down', (e: TPointerEventInfo) => {
    if (e.target) return
    const p = canvas.getScenePoint(e.e)
    startX = p.x; startY = p.y
    line = new Line([startX, startY, startX, startY], { stroke: color, strokeWidth: 2, strokeLineCap: 'round', selectable: true })
    canvas.add(line)
  })
  canvas.on('mouse:move', (e: TPointerEventInfo) => {
    if (!line) return
    const p = canvas.getScenePoint(e.e)
    line.set({ x2: p.x, y2: p.y })
    canvas.renderAll()
  })
  canvas.on('mouse:up', () => {
    if (line) onSave()
    line = null
  })
}

export function applyFillDotTool(canvas: Canvas, color: string, onSave: () => void): void {
  onClickPlace(canvas, onSave, (x, y) => {
    return new Circle({
      left: x - 3, top: y - 3, radius: 3,
      fill: color, stroke: color, strokeWidth: 0, selectable: true,
    })
  })
}

export function applyFillDateTool(canvas: Canvas, color: string, onSave: () => void): void {
  onClickPlace(canvas, onSave, (x, y) => {
    const now = new Date()
    const mm = String(now.getMonth() + 1).padStart(2, '0')
    const dd = String(now.getDate()).padStart(2, '0')
    const yyyy = now.getFullYear()
    return new Textbox(`${mm}/${dd}/${yyyy}`, {
      left: x, top: y - 8, fontSize: 12,
      fill: color, width: 100, selectable: true, editable: true,
    })
  })
}

export function applyFillInitialsTool(canvas: Canvas, color: string, initials: string, onSave: () => void): void {
  const text = initials?.trim() || 'AB'
  onClickPlace(canvas, onSave, (x, y) => {
    return new Textbox(text, {
      left: x, top: y - 10, fontSize: 18,
      fill: color, fontFamily: 'Segoe Script, Comic Sans MS, cursive',
      fontStyle: 'italic', selectable: true, editable: true, width: 80,
    })
  })
}

export function applyFillTimestampTool(canvas: Canvas, color: string, onSave: () => void): void {
  onClickPlace(canvas, onSave, (x, y) => {
    const now = new Date()
    const iso = now.toISOString().slice(0, 19).replace('T', ' ')
    return new Textbox(iso + ' UTC', {
      left: x, top: y - 7, fontSize: 10,
      fill: color, width: 150, selectable: true,
    })
  })
}
