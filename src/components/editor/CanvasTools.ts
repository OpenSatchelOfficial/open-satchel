// Grab-bag of on-canvas fabric tools we add as part of WPS-parity:
// - applyWipeOffTool: click to delete objects (eraser)
// - applyHighlightAreaTool: drag to create a translucent rect highlight
// - applyTextBoxAnnotationTool: click to place a bordered textbox
// - applyLinkAnnotationTool: drag to draw a clickable link rect (URL prompt)
// - applyAudioAnnotationTool / applyVideoAnnotationTool: click to attach media icon
// - applyInsertTextMarkerTool / applyReplaceTextMarkerTool: caret-style markers

import { Canvas, Rect, Textbox, Group, type TPointerEventInfo } from 'fabric'

// ---------- Wipe Off (eraser) ----------

export function applyWipeOffTool(canvas: Canvas, onSave: () => void): void {
  canvas.isDrawingMode = false
  canvas.selection = false
  canvas.defaultCursor = 'not-allowed'
  canvas.on('mouse:down', (e: TPointerEventInfo) => {
    if (e.target) {
      canvas.remove(e.target)
      canvas.renderAll()
      onSave()
    }
  })
}

// ---------- Highlight Area (rect, not text-based) ----------

export function applyHighlightAreaTool(canvas: Canvas, color: string, onSave: () => void): void {
  canvas.isDrawingMode = false
  canvas.selection = false
  canvas.defaultCursor = 'crosshair'
  let startX = 0, startY = 0, shape: Rect | null = null
  canvas.on('mouse:down', (e: TPointerEventInfo) => {
    if (e.target) return
    ;(canvas as any).__dragCreateActive = true
    const p = canvas.getScenePoint(e.e)
    startX = p.x; startY = p.y
    shape = new Rect({ left: startX, top: startY, width: 0, height: 0, fill: color, opacity: 0.35, stroke: color, strokeWidth: 0.5, selectable: true })
    canvas.add(shape)
  })
  canvas.on('mouse:move', (e: TPointerEventInfo) => {
    if (!shape) return
    const p = canvas.getScenePoint(e.e)
    shape.set({
      width: Math.abs(p.x - startX),
      height: Math.abs(p.y - startY),
      left: Math.min(startX, p.x),
      top: Math.min(startY, p.y),
    })
    canvas.renderAll()
  })
  canvas.on('mouse:up', () => {
    ;(canvas as any).__dragCreateActive = false
    if (shape && (shape.width ?? 0) > 3) onSave()
    shape = null
  })
}

// ---------- Text Box annotation (bordered) ----------

export function applyTextBoxAnnotationTool(canvas: Canvas, onSave: () => void): void {
  canvas.isDrawingMode = false
  canvas.selection = false
  canvas.defaultCursor = 'text'
  canvas.on('mouse:down', (e: TPointerEventInfo) => {
    if (e.target) return
    const p = canvas.getScenePoint(e.e)
    const tb = new Textbox('Type here', {
      left: p.x, top: p.y, fontSize: 12, fill: '#1e1e2e',
      backgroundColor: '#fffdd0', width: 200,
      padding: 6, editable: true, selectable: true,
    })
    // Add a subtle border via strokeWidth on the underlying rect via set
    ;(tb as unknown as { stroke?: string; strokeWidth?: number }).stroke = '#89b4fa'
    ;(tb as unknown as { stroke?: string; strokeWidth?: number }).strokeWidth = 1
    canvas.add(tb)
    canvas.setActiveObject(tb)
    tb.enterEditing()
    tb.selectAll()
    onSave()
  })
}

// ---------- Link annotation (drag to define rect, prompt for URL, save as group with __url) ----------

export function applyLinkAnnotationTool(canvas: Canvas, onSave: () => void): void {
  canvas.isDrawingMode = false
  canvas.selection = false
  canvas.defaultCursor = 'crosshair'
  let startX = 0, startY = 0, rect: Rect | null = null
  canvas.on('mouse:down', (e: TPointerEventInfo) => {
    if (e.target) return
    const p = canvas.getScenePoint(e.e)
    startX = p.x; startY = p.y
    // selectable: false during drag — otherwise Fabric's mousemove
    // handler routes to "drag-move the object" once the rect has any
    // size, and our mouse:move updates stop firing after ~3 events.
    // Flip back to selectable:true at mouse:up so the user can click
    // it afterward.
    rect = new Rect({ left: startX, top: startY, width: 0, height: 0, fill: 'transparent', stroke: '#89b4fa', strokeWidth: 1, strokeDashArray: [4, 3], selectable: false, evented: false })
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
    if (!rect || (rect.width ?? 0) < 3) { if (rect) canvas.remove(rect); rect = null; return }
    // Test-driven URL injection: the ribbon test driver calls
    // prompt_set_next({value: url}) before mouse:up to hijack
    // window.prompt. User-driven drags still show the native prompt.
    const url = window.prompt('Link URL', 'https://') || ''
    if (!url) { canvas.remove(rect); rect = null; canvas.renderAll(); return }
    ;(rect as unknown as { __linkUrl?: string }).__linkUrl = url
    // Re-enable selection + event handling now that the drag is done.
    rect.set({ selectable: true, evented: true })
    canvas.renderAll()
    onSave()
    rect = null
  })
}

// ---------- Audio / Video annotation (media icon + url) ----------

function makeMediaAnnotation(canvas: Canvas, kind: 'audio' | 'video', onSave: () => void) {
  canvas.isDrawingMode = false
  canvas.selection = false
  canvas.defaultCursor = 'crosshair'
  canvas.on('mouse:down', (e: TPointerEventInfo) => {
    if (e.target) return
    const p = canvas.getScenePoint(e.e)
    const url = window.prompt(`${kind === 'audio' ? 'Audio' : 'Video'} URL or file path`, '')
    if (!url) return
    const icon = kind === 'audio' ? '🔊' : '▶'
    const box = new Rect({ left: p.x, top: p.y, width: 40, height: 40, fill: '#313244', stroke: '#89b4fa', strokeWidth: 1, rx: 4, ry: 4 })
    const label = new Textbox(icon, { left: p.x + 10, top: p.y + 8, fontSize: 18, fill: '#cdd6f4', width: 30, selectable: false })
    const group = new Group([box, label], { selectable: true })
    ;(group as unknown as { __mediaUrl?: string; __mediaKind?: string }).__mediaUrl = url
    ;(group as unknown as { __mediaKind?: string }).__mediaKind = kind
    canvas.add(group)
    onSave()
  })
}

export function applyAudioAnnotationTool(canvas: Canvas, onSave: () => void): void {
  makeMediaAnnotation(canvas, 'audio', onSave)
}

export function applyVideoAnnotationTool(canvas: Canvas, onSave: () => void): void {
  makeMediaAnnotation(canvas, 'video', onSave)
}

// ---------- Insert text marker (caret) ----------

export function applyInsertTextMarkerTool(canvas: Canvas, onSave: () => void): void {
  canvas.isDrawingMode = false
  canvas.selection = false
  canvas.defaultCursor = 'text'
  canvas.on('mouse:down', (e: TPointerEventInfo) => {
    if (e.target) return
    const p = canvas.getScenePoint(e.e)
    const text = window.prompt('Text to insert', '')
    if (text === null) return
    const caret = new Textbox('^', { left: p.x, top: p.y - 6, fontSize: 14, fill: '#f38ba8', fontWeight: 'bold', selectable: false, width: 12 })
    const annotation = new Textbox(text || '(no text)', { left: p.x + 10, top: p.y - 20, fontSize: 10, fill: '#1e1e2e', backgroundColor: '#fffdd0', width: 140, padding: 4, selectable: false })
    const g = new Group([caret, annotation], { selectable: true })
    ;(g as unknown as { __insertText?: string }).__insertText = text
    canvas.add(g)
    onSave()
  })
}

// ---------- Replace text marker (strike + suggestion) ----------

export function applyReplaceTextMarkerTool(canvas: Canvas, onSave: () => void): void {
  canvas.isDrawingMode = false
  canvas.selection = false
  canvas.defaultCursor = 'crosshair'
  let startX = 0, startY = 0, strike: Rect | null = null
  canvas.on('mouse:down', (e: TPointerEventInfo) => {
    if (e.target) return
    const p = canvas.getScenePoint(e.e)
    startX = p.x; startY = p.y
    strike = new Rect({ left: startX, top: startY, width: 0, height: 3, fill: '#f38ba8', opacity: 0.9, selectable: false })
    canvas.add(strike)
  })
  canvas.on('mouse:move', (e: TPointerEventInfo) => {
    if (!strike) return
    const p = canvas.getScenePoint(e.e)
    strike.set({ width: Math.abs(p.x - startX) })
  })
  canvas.on('mouse:up', () => {
    if (!strike) return
    const replacement = window.prompt('Replacement text', '')
    if (replacement === null) { canvas.remove(strike); strike = null; return }
    const note = new Textbox(replacement || '(remove)', { left: strike.left ?? 0, top: (strike.top ?? 0) + 8, fontSize: 10, fill: '#1e1e2e', backgroundColor: '#fffdd0', width: strike.width ?? 100, padding: 3, selectable: false })
    const g = new Group([strike, note], { selectable: true })
    ;(g as unknown as { __replaceText?: string }).__replaceText = replacement
    canvas.remove(strike)
    canvas.remove(note)
    canvas.add(g)
    canvas.renderAll()
    onSave()
    strike = null
  })
}
