// Measure tool: click-drag on the canvas to measure distance between
// two points. Persists as a Fabric group (line + text) so the
// measurement stays with the document. Supports a scale factor
// (pt → user units — e.g. 72pt/in, or user-calibrated).

import { Canvas, Line, Textbox, Group, type TPointerEventInfo } from 'fabric'

export interface MeasureOpts {
  color?: string
  strokeWidth?: number
  unit?: 'pt' | 'in' | 'cm' | 'mm' | 'px'
  scale?: number // user-units per pt; e.g. 1/72 for inches
  precision?: number
}

const UNIT_FACTORS: Record<string, number> = {
  pt: 1,
  in: 1 / 72,
  cm: 2.54 / 72,
  mm: 25.4 / 72,
  px: 1,
}

export function applyMeasureTool(canvas: Canvas, opts: MeasureOpts = {}, onSave: () => void = () => {}): void {
  const color = opts.color ?? '#ff00ff'
  const strokeWidth = opts.strokeWidth ?? 2
  const unit = opts.unit ?? 'pt'
  const userScale = opts.scale ?? UNIT_FACTORS[unit] ?? 1
  const precision = opts.precision ?? 2

  canvas.isDrawingMode = false
  canvas.selection = false
  canvas.defaultCursor = 'crosshair'

  let startX = 0
  let startY = 0
  let line: Line | null = null

  canvas.on('mouse:down', (e: TPointerEventInfo) => {
    if (e.target) return
    const p = canvas.getScenePoint(e.e)
    startX = p.x
    startY = p.y
    line = new Line([startX, startY, startX, startY], {
      stroke: color,
      strokeWidth,
      selectable: false,
      evented: false,
    })
    canvas.add(line)
  })

  canvas.on('mouse:move', (e: TPointerEventInfo) => {
    if (!line) return
    const p = canvas.getScenePoint(e.e)
    line.set({ x2: p.x, y2: p.y })
    canvas.renderAll()
  })

  canvas.on('mouse:up', (e: TPointerEventInfo) => {
    if (!line) return
    const p = canvas.getScenePoint(e.e)
    const dx = p.x - startX
    const dy = p.y - startY
    const pxDist = Math.sqrt(dx * dx + dy * dy)
    const dist = pxDist * userScale
    if (dist < 1) {
      // Ignore tiny accidental clicks
      canvas.remove(line)
      canvas.renderAll()
      line = null
      return
    }
    const label = `${dist.toFixed(precision)} ${unit}`
    const midX = (startX + p.x) / 2
    const midY = (startY + p.y) / 2
    const text = new Textbox(label, {
      left: midX,
      top: midY - 14,
      fontSize: 12,
      fill: color,
      backgroundColor: 'rgba(255,255,255,0.8)',
      selectable: false,
      evented: false,
      width: 120,
    })
    const group = new Group([line, text], { selectable: true })
    ;(group as unknown as { __measureDistance: number }).__measureDistance = dist
    ;(group as unknown as { __measureUnit: string }).__measureUnit = unit
    canvas.remove(line)
    canvas.remove(text)
    canvas.add(group)
    canvas.renderAll()
    onSave()
    line = null
  })
}
