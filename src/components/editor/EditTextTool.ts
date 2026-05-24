// Edit Text Tool — Places editable Fabric Textboxes over extracted PDF body text
//
// When the user activates this tool, pdfjs extracts text with positions and
// the content stream parser maps them to operators. Each text block becomes
// an editable Fabric Textbox with metadata linking it back to the content
// stream for true operator-level replacement on save.

import { Textbox } from 'fabric'
import type { Canvas } from 'fabric'
import type { MatchedTextBlock } from '../../services/pdfTextExtract'
import { mapPdfFontToStandard } from '../../services/pdfTextExtract'

export interface EditTextOptions {
  blocks: MatchedTextBlock[]
  canvasWidth: number
  canvasHeight: number
  pageWidth: number      // PDF page width in points
  pageHeight: number     // PDF page height in points
  onSave: () => void
}

/** Apply the edit text tool: place editable textboxes over extracted text blocks */
export function applyEditTextTool(canvas: Canvas, opts: EditTextOptions): void {
  canvas.isDrawingMode = false
  canvas.selection = true
  canvas.defaultCursor = 'text'

  const scaleX = opts.canvasWidth / opts.pageWidth
  const scaleY = opts.canvasHeight / opts.pageHeight

  for (const block of opts.blocks) {
    // Convert PDF coords to canvas coords for placement
    // block.pdfBounds is in PDF coordinate space (bottom-left origin)
    const canvasX = block.pdfBounds.x * scaleX
    const canvasY = (opts.pageHeight - block.pdfBounds.y - block.pdfBounds.height) * scaleY
    const canvasW = block.pdfBounds.width * scaleX
    const fontSize = block.fontSize * scaleY
    const fontFamily = mapPdfFontToStandard(block.fontName)

    const textbox = new Textbox(block.text, {
      left: canvasX,
      top: canvasY,
      width: Math.max(canvasW * 1.15, 60),  // 15% wider to prevent false wrapping
      fontSize,
      fontFamily,
      fill: '#000000',
      lineHeight: block.lineHeight,
      editable: true,
      selectable: true,
      backgroundColor: '#ffffff',  // white bg to cover original text
      stroke: '#89b4fa',
      strokeWidth: 0.5,
      strokeDashArray: [4, 2],
      padding: 4,
      splitByGrapheme: false,
    })

    // Store metadata for save-path integration
    ;(textbox as any).__editTextBlock = true
    ;(textbox as any).__originalText = block.text
    ;(textbox as any).__operatorIndices = block.operatorIndices
    ;(textbox as any).__originalTextRuns = block.originalTextRuns
    ;(textbox as any).__pdfBounds = block.pdfBounds
    ;(textbox as any).__blockFontName = block.fontName
    ;(textbox as any).__blockFontSize = block.fontSize

    // Auto-save when text changes
    textbox.on('changed', () => {
      opts.onSave()
    })
    textbox.on('editing:exited', () => {
      opts.onSave()
    })

    canvas.add(textbox)
  }

  canvas.renderAll()
}

/** Remove all edit-text textboxes from the canvas */
export function removeEditTextBoxes(canvas: Canvas): void {
  const toRemove = canvas.getObjects().filter((obj: any) => obj.__editTextBlock === true)
  for (const obj of toRemove) {
    canvas.remove(obj)
  }
  canvas.renderAll()
}

/** Check if the canvas already has edit-text textboxes */
export function hasEditTextBoxes(canvas: Canvas): boolean {
  return canvas.getObjects().some((obj: any) => obj.__editTextBlock === true)
}
