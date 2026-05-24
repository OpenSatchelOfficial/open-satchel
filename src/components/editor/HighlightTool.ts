import { Canvas, Rect, type TPointerEventInfo } from 'fabric'

export type HighlightMode = 'highlight' | 'underline' | 'strikethrough' | 'redact'

export function applyHighlightTool(
  canvas: Canvas,
  mode: HighlightMode,
  color: string,
  onSave: () => void
): void {
  canvas.isDrawingMode = false
  canvas.selection = false
  canvas.defaultCursor = 'text'

  let startX = 0
  let startY = 0
  let rect: Rect | null = null

  canvas.on('mouse:down', (e: TPointerEventInfo) => {
    if (e.target) return // Don't create on existing objects
    const pointer = canvas.getScenePoint(e.e)
    startX = pointer.x
    startY = pointer.y

    const height = mode === 'highlight' ? 20 : mode === 'redact' ? 20 : 3

    rect = new Rect({
      left: startX,
      top: mode === 'underline' ? startY + 16 : mode === 'strikethrough' ? startY + 8 : startY,
      width: 0,
      height,
      fill: mode === 'redact' ? '#000000' : color,
      opacity: mode === 'highlight' ? 0.35 : mode === 'redact' ? 1 : 0.8,
      selectable: true,
      strokeWidth: 0,
      rx: mode === 'highlight' ? 2 : 0,
      ry: mode === 'highlight' ? 2 : 0
    })

    // Mark the type so serializer knows what it is
    ;(rect as any).__annotationType = mode

    canvas.add(rect)
  })

  canvas.on('mouse:move', (e: TPointerEventInfo) => {
    if (!rect) return
    const pointer = canvas.getScenePoint(e.e)
    const width = pointer.x - startX
    if (width > 0) {
      rect.set({ width })
      canvas.renderAll()
    }
  })

  canvas.on('mouse:up', () => {
    if (rect && rect.width! < 5) {
      canvas.remove(rect)
    }
    rect = null
    onSave()
  })
}
