import { Canvas, Rect, type TPointerEventInfo } from 'fabric'

export type HighlightMode = 'highlight' | 'underline' | 'strikethrough' | 'redact' | 'redaction_mark'

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
    ;(canvas as any).__dragCreateActive = true
    const pointer = canvas.getScenePoint(e.e)
    startX = pointer.x
    startY = pointer.y

    const height = mode === 'highlight' || mode === 'redact' || mode === 'redaction_mark' ? 20 : 3
    const isRedactionMark = mode === 'redaction_mark'

    rect = new Rect({
      left: startX,
      top: mode === 'underline' ? startY + 16 : mode === 'strikethrough' ? startY + 8 : startY,
      width: 0,
      height,
      fill: mode === 'redact' ? '#000000' : isRedactionMark ? 'rgba(0,0,0,0.05)' : color,
      stroke: isRedactionMark ? '#000000' : undefined,
      strokeWidth: isRedactionMark ? 3 : 0,
      opacity: mode === 'highlight' ? 0.35 : mode === 'redact' || isRedactionMark ? 1 : 0.8,
      selectable: true,
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
    ;(canvas as any).__dragCreateActive = false
    if (rect && rect.width! < 5) {
      canvas.remove(rect)
      rect = null
      return
    }
    rect = null
    onSave()
  })
}
