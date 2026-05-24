import { Canvas, Textbox, type TPointerEventInfo } from 'fabric'
import type { TextOptions } from '../../types/pdf'

export function applyTextTool(
  canvas: Canvas,
  options: TextOptions,
  onSave: () => void
): void {
  canvas.isDrawingMode = false
  canvas.selection = false
  canvas.defaultCursor = 'text'

  // Deselect existing objects so clicks go through
  canvas.discardActiveObject()

  canvas.on('mouse:down', (e: TPointerEventInfo) => {
    // If clicking on an existing textbox, let fabric handle selection
    if (e.target && e.target instanceof Textbox) return

    const pointer = canvas.getScenePoint(e.e)

    const textbox = new Textbox('Type here...', {
      left: pointer.x,
      top: pointer.y,
      fontSize: options.fontSize,
      fill: options.color,
      fontFamily: options.fontFamily,
      fontWeight: options.bold ? 'bold' : 'normal',
      fontStyle: options.italic ? 'italic' : 'normal',
      underline: options.underline ?? false,
      linethrough: options.strikethrough ?? false,
      textAlign: options.textAlign ?? 'left',
      lineHeight: options.lineHeight ?? 1.2,
      charSpacing: options.charSpacing ?? 0,
      width: 200,
      editable: true,
      selectable: true
    })

    // Store custom font ID as a custom property on the textbox
    if (options.customFontId) {
      ;(textbox as any).__customFontId = options.customFontId
    }

    canvas.add(textbox)
    canvas.setActiveObject(textbox)
    textbox.enterEditing()
    textbox.selectAll()
    onSave()
  })
}
