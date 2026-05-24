import { Canvas, Rect, Textbox, Group, type TPointerEventInfo } from 'fabric'

const NOTE_COLORS = ['#f9e2af', '#a6e3a1', '#89b4fa', '#f38ba8', '#cba6f7']

export function applyStickyNoteTool(
  canvas: Canvas,
  noteColor: string,
  onSave: () => void
): void {
  canvas.isDrawingMode = false
  canvas.selection = false
  canvas.defaultCursor = 'crosshair'

  canvas.on('mouse:down', (e: TPointerEventInfo) => {
    if (e.target) return
    const pointer = canvas.getScenePoint(e.e)

    const bg = new Rect({
      width: 160,
      height: 100,
      fill: noteColor,
      rx: 4,
      ry: 4,
      // Fabric v6 typed `shadow` as a Shadow instance; the string form still
      // works at runtime (Fabric parses it). Cast for the TS compiler.
      shadow: '2px 2px 6px rgba(0,0,0,0.3)' as unknown as import('fabric').Shadow,
    })

    const text = new Textbox('Note...', {
      width: 150,
      left: 5,
      top: 5,
      fontSize: 12,
      fill: '#1e1e2e',
      fontFamily: 'sans-serif',
      editable: true
    })

    const group = new Group([bg, text], {
      left: pointer.x,
      top: pointer.y,
      selectable: true,
      subTargetCheck: true
    })

    ;(group as any).__isStickyNote = true

    canvas.add(group)
    canvas.setActiveObject(group)
    onSave()
  })
}

export { NOTE_COLORS }
