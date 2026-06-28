import { Canvas, Group, Rect, Text, type TPointerEventInfo } from 'fabric'

const NOTE_COLORS = ['#f9e2af', '#a6e3a1', '#89b4fa', '#f38ba8', '#cba6f7']
const NOTE_WIDTH = 184
const NOTE_HEIGHT = 96
const NOTE_PADDING_X = 10
const NOTE_PADDING_TOP = 12
const NOTE_PREVIEW_MAX_LINES = 5
const NOTE_PREVIEW_MAX_CHARS = 27
const EMPTY_PREVIEW = 'Add a note...'

export function stickyNotePreviewText(contents: string): string {
  const trimmed = contents.trim()
  if (!trimmed) return EMPTY_PREVIEW
  const sourceLines = trimmed.split(/\r?\n/)
  const out: string[] = []
  let clipped = false

  const pushWrapped = (sourceLine: string) => {
    const words = sourceLine.trim().split(/\s+/).filter(Boolean)
    if (!words.length) {
      out.push('')
      return
    }

    let line = ''
    for (const word of words) {
      if (out.length >= NOTE_PREVIEW_MAX_LINES) { clipped = true; return }
      if (word.length > NOTE_PREVIEW_MAX_CHARS) {
        if (line) {
          out.push(line)
          line = ''
          if (out.length >= NOTE_PREVIEW_MAX_LINES) { clipped = true; return }
        }
        out.push(word.slice(0, NOTE_PREVIEW_MAX_CHARS))
        clipped = true
        continue
      }
      const next = line ? `${line} ${word}` : word
      if (next.length <= NOTE_PREVIEW_MAX_CHARS) {
        line = next
      } else {
        out.push(line)
        line = word
      }
    }
    if (line) out.push(line)
  }

  for (const sourceLine of sourceLines) {
    if (out.length >= NOTE_PREVIEW_MAX_LINES) { clipped = true; break }
    pushWrapped(sourceLine)
  }

  if (out.length > NOTE_PREVIEW_MAX_LINES) {
    out.length = NOTE_PREVIEW_MAX_LINES
    clipped = true
  }

  if (clipped && out.length > 0) {
    const lastIdx = out.length - 1
    const last = out[lastIdx].replace(/\s+$/g, '')
    const maxBody = Math.max(0, NOTE_PREVIEW_MAX_CHARS - 3)
    out[lastIdx] = `${last.slice(0, maxBody).replace(/\s+$/g, '')}...`
  }

  return out.join('\n')
}

function stickyNotePreviewHeight(contents: string): number {
  return Math.max(13, stickyNotePreviewText(contents).split(/\r?\n/).length * 13.4)
}

export function makeStickyNoteText(contents = ''): Text {
  const hasBody = contents.trim().length > 0
  return new Text(stickyNotePreviewText(contents), {
    left: NOTE_PADDING_X,
    top: NOTE_PADDING_TOP,
    fontSize: 11,
    lineHeight: 1.18,
    fill: hasBody ? '#2f2500' : '#7a641d',
    fontFamily: 'Arial',
    fontStyle: hasBody ? 'normal' : 'italic',
    selectable: false,
    evented: false,
    height: stickyNotePreviewHeight(contents),
  })
}

export function makeStickyNoteTextbox(contents = ''): Text {
  return makeStickyNoteText(contents)
}

function noteAccentColor(noteColor: string): string {
  switch (noteColor.toLowerCase()) {
    case '#a6e3a1': return '#55a95a'
    case '#89b4fa': return '#3b73d9'
    case '#f38ba8': return '#c34865'
    case '#cba6f7': return '#8b5ed7'
    default: return '#d29b00'
  }
}

function makeCommentId(): string {
  return `sticky_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

export function makeStickyNoteGroup(
  left: number,
  top: number,
  noteColor: string,
  contents = '',
): Group {
  const background = new Rect({
    left: 0,
    top: 0,
    width: NOTE_WIDTH,
    height: NOTE_HEIGHT,
    fill: noteColor,
    stroke: '#8a6d00',
    strokeWidth: 1,
    rx: 4,
    ry: 4,
    selectable: false,
    evented: false,
  })
  const accent = new Rect({
    left: 0,
    top: 0,
    width: NOTE_WIDTH,
    height: 6,
    fill: noteAccentColor(noteColor),
    opacity: 0.85,
    selectable: false,
    evented: false,
  })
  const text = makeStickyNoteText(contents)
  return new Group([background, accent, text], {
    left,
    top,
    selectable: true,
    hasControls: false,
    lockScalingX: true,
    lockScalingY: true,
    hoverCursor: 'pointer',
  })
}

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

    const marker = makeStickyNoteGroup(pointer.x, pointer.y, noteColor)

    ;(marker as any).__isStickyNote = true
    ;(marker as any).__nativeStickyMarker = true
    ;(marker as any).__isComment = true
    ;(marker as any).__kind = 'sticky_note'
    ;(marker as any).__author = 'You'
    ;(marker as any).__createdAt = Date.now()
    ;(marker as any).__id = makeCommentId()
    ;(marker as any).__contents = ''
    ;(marker as any).__color = noteColor

    canvas.add(marker)
    canvas.setActiveObject(marker)
    canvas.renderAll()
    onSave()
  })
}

export { NOTE_COLORS }
