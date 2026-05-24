// On-canvas form designer. When active, drag to define a field rect,
// the type is chosen from a small picker dropdown exposed on the
// fabric group's custom property, and the list of "designed" fields is
// surfaced back to the caller via onSave(). When the user saves, the
// list can be passed to pdfForms.addFormFields() to burn into the PDF.

import { Canvas, Rect, Textbox, Group, type TPointerEventInfo } from 'fabric'

export type DesignerFieldKind = 'text' | 'checkbox' | 'radio' | 'dropdown' | 'signature'

export interface DesignerOptions {
  defaultKind?: DesignerFieldKind
  color?: string
  onSave?: () => void
}

export function applyFormDesignerTool(canvas: Canvas, opts: DesignerOptions = {}): void {
  const kind = opts.defaultKind ?? 'text'
  const color = opts.color ?? '#f9e2af'
  canvas.isDrawingMode = false
  canvas.selection = false
  canvas.defaultCursor = 'crosshair'

  let startX = 0, startY = 0
  let rect: Rect | null = null

  canvas.on('mouse:down', (e: TPointerEventInfo) => {
    if (e.target) return
    const p = canvas.getScenePoint(e.e)
    startX = p.x; startY = p.y
    rect = new Rect({
      left: startX, top: startY, width: 0, height: 0,
      fill: color, opacity: 0.35, stroke: color, strokeWidth: 1,
      strokeDashArray: [4, 4], selectable: false,
    })
    canvas.add(rect)
  })

  canvas.on('mouse:move', (e: TPointerEventInfo) => {
    if (!rect) return
    const p = canvas.getScenePoint(e.e)
    rect.set({
      width: Math.abs(p.x - startX),
      height: Math.abs(p.y - startY),
      left: Math.min(startX, p.x),
      top: Math.min(startY, p.y),
    })
    canvas.renderAll()
  })

  canvas.on('mouse:up', () => {
    if (!rect) return
    if ((rect.width ?? 0) < 10 || (rect.height ?? 0) < 5) {
      canvas.remove(rect); rect = null; canvas.renderAll(); return
    }
    const name = window.prompt('Field name', `field_${Math.random().toString(36).slice(2, 7)}`)
    if (!name) { canvas.remove(rect); rect = null; canvas.renderAll(); return }
    const label = new Textbox(`${kind}: ${name}`, {
      left: (rect.left ?? 0) + 4,
      top: (rect.top ?? 0) + 4,
      fontSize: 10, fill: '#1e1e2e', selectable: false, evented: false, width: (rect.width ?? 100) - 8,
    })
    const g = new Group([rect, label], { selectable: true })
    ;(g as unknown as { __formField?: { kind: DesignerFieldKind; name: string; rect: { x: number; y: number; width: number; height: number } } }).__formField = {
      kind,
      name,
      rect: { x: rect.left ?? 0, y: rect.top ?? 0, width: rect.width ?? 0, height: rect.height ?? 0 },
    }
    canvas.remove(rect)
    canvas.remove(label)
    canvas.add(g)
    canvas.renderAll()
    opts.onSave?.()
    rect = null
  })
}

/** Walk every fabric group on the canvas and return the designed form fields. */
export function collectDesignedFields(canvas: Canvas): Array<{
  kind: DesignerFieldKind; name: string; rect: { x: number; y: number; width: number; height: number }
}> {
  const out: Array<{ kind: DesignerFieldKind; name: string; rect: { x: number; y: number; width: number; height: number } }> = []
  for (const obj of canvas.getObjects()) {
    const f = (obj as unknown as { __formField?: { kind: DesignerFieldKind; name: string; rect: { x: number; y: number; width: number; height: number } } }).__formField
    if (f) out.push(f)
  }
  return out
}
