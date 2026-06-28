import { Canvas, Rect, type FabricObject, type TPointerEventInfo } from 'fabric'

const MARK_FILL = 'rgba(0,0,0,0.05)'
const MARK_STROKE = '#000000'
const MARK_STROKE_WIDTH = 3

type RedactionFabricObject = FabricObject & {
  __annotationType?: string
  __redactionMarked?: boolean
  __redactionOverlay?: boolean
  __redactionTargetId?: string
  __id?: string
  isEditing?: boolean
  exitEditing?: () => void
}

function makeTargetId(obj: RedactionFabricObject): string {
  if (typeof obj.__redactionTargetId === 'string' && obj.__redactionTargetId.length > 0) {
    return obj.__redactionTargetId
  }
  if (typeof obj.__id === 'string' && obj.__id.length > 0) {
    obj.__redactionTargetId = obj.__id
    return obj.__id
  }
  const id = `redaction-target-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  obj.__redactionTargetId = id
  return id
}

function isRedactionRegionObject(obj: RedactionFabricObject): boolean {
  return obj.__annotationType === 'redact' || obj.__annotationType === 'redaction_mark'
}

function objectBounds(obj: RedactionFabricObject): { left: number; top: number; width: number; height: number } {
  obj.setCoords()
  const bounds = obj.getBoundingRect()
  return {
    left: Number(bounds.left) || 0,
    top: Number(bounds.top) || 0,
    width: Math.max(1, Number(bounds.width) || 0),
    height: Math.max(1, Number(bounds.height) || 0),
  }
}

function makeRedactionMarker(
  bounds: { left: number; top: number; width: number; height: number },
  targetId?: string,
): Rect {
  const marker = new Rect({
    left: bounds.left,
    top: bounds.top,
    width: bounds.width,
    height: bounds.height,
    fill: MARK_FILL,
    stroke: MARK_STROKE,
    strokeWidth: MARK_STROKE_WIDTH,
    strokeUniform: true,
    opacity: 1,
    selectable: targetId ? false : true,
    evented: targetId ? false : true,
    hasControls: !targetId,
    hasBorders: !targetId,
    rx: 0,
    ry: 0,
  })
  ;(marker as RedactionFabricObject).__annotationType = 'redaction_mark'
  if (targetId) {
    ;(marker as RedactionFabricObject).__redactionOverlay = true
    ;(marker as RedactionFabricObject).__redactionTargetId = targetId
  }
  return marker
}

function findMarkerForTarget(canvas: Canvas, targetId: string): RedactionFabricObject | null {
  return (canvas.getObjects() as RedactionFabricObject[]).find((obj) =>
    obj.__redactionOverlay === true &&
    obj.__redactionTargetId === targetId &&
    obj.__annotationType === 'redaction_mark',
  ) ?? null
}

function findTargetForMarker(canvas: Canvas, marker: RedactionFabricObject): RedactionFabricObject | null {
  const id = marker.__redactionTargetId
  if (!id) return null
  return (canvas.getObjects() as RedactionFabricObject[]).find((obj) =>
    obj !== marker &&
    obj.__redactionMarked === true &&
    obj.__redactionTargetId === id,
  ) ?? null
}

function syncMarkerToTarget(canvas: Canvas, marker: RedactionFabricObject, target: RedactionFabricObject): void {
  const bounds = objectBounds(target)
  const padding = MARK_STROKE_WIDTH
  marker.set({
    left: bounds.left - padding,
    top: bounds.top - padding,
    width: bounds.width + padding * 2,
    height: bounds.height + padding * 2,
    angle: 0,
    scaleX: 1,
    scaleY: 1,
  })
  marker.setCoords()
  const objects = canvas.getObjects()
  const markerIndex = objects.indexOf(marker)
  const targetIndex = objects.indexOf(target)
  if (markerIndex > targetIndex && targetIndex >= 0) {
    const c = canvas as Canvas & { moveObjectTo?: (obj: FabricObject, index: number) => void }
    if (typeof c.moveObjectTo === 'function') {
      c.moveObjectTo(marker, targetIndex)
    } else {
      while (canvas.getObjects().indexOf(marker) > targetIndex) {
        canvas.sendObjectBackwards(marker)
      }
    }
  }
}

export function syncRedactionMarkerOverlays(canvas: Canvas): void {
  const markers = (canvas.getObjects() as RedactionFabricObject[])
    .filter((obj) => obj.__redactionOverlay === true && obj.__annotationType === 'redaction_mark')
  for (const marker of markers) {
    const target = findTargetForMarker(canvas, marker)
    if (target) syncMarkerToTarget(canvas, marker, target)
  }
}

function markTargetForRedaction(canvas: Canvas, target: RedactionFabricObject, onSave: () => void): void {
  if (isRedactionRegionObject(target)) return

  if (target.isEditing && typeof target.exitEditing === 'function') {
    target.exitEditing()
  }

  const targetId = makeTargetId(target)
  target.__redactionMarked = true
  target.set({
    borderColor: MARK_STROKE,
    cornerColor: MARK_STROKE,
    cornerStrokeColor: MARK_STROKE,
    borderScaleFactor: MARK_STROKE_WIDTH,
    transparentCorners: false,
  } as Partial<RedactionFabricObject>)
  target.setCoords()

  let marker = findMarkerForTarget(canvas, targetId)
  if (!marker) {
    marker = makeRedactionMarker(objectBounds(target), targetId) as RedactionFabricObject
    canvas.add(marker)
  }
  syncMarkerToTarget(canvas, marker, target)
  canvas.setActiveObject(target)
  canvas.renderAll()
  onSave()
}

export function applyRedactionMarkTool(canvas: Canvas, onSave: () => void): void {
  canvas.isDrawingMode = false
  canvas.selection = false
  canvas.skipTargetFind = false
  canvas.defaultCursor = 'pointer'

  let startX = 0
  let startY = 0
  let rect: Rect | null = null

  canvas.on('mouse:down', (e: TPointerEventInfo) => {
    if (e.target) {
      markTargetForRedaction(canvas, e.target as RedactionFabricObject, onSave)
      return
    }

    ;(canvas as unknown as { __dragCreateActive?: boolean }).__dragCreateActive = true
    const pointer = canvas.getScenePoint(e.e)
    startX = pointer.x
    startY = pointer.y
    rect = makeRedactionMarker({ left: startX, top: startY, width: 0, height: 20 })
    canvas.add(rect)
  })

  canvas.on('mouse:move', (e: TPointerEventInfo) => {
    if (!rect) return
    const pointer = canvas.getScenePoint(e.e)
    rect.set({
      width: Math.abs(pointer.x - startX),
      height: Math.abs(pointer.y - startY),
      left: Math.min(startX, pointer.x),
      top: Math.min(startY, pointer.y),
    })
    canvas.renderAll()
  })

  canvas.on('mouse:up', () => {
    ;(canvas as unknown as { __dragCreateActive?: boolean }).__dragCreateActive = false
    if (rect && (rect.width ?? 0) < 5) {
      canvas.remove(rect)
      rect = null
      return
    }
    rect = null
    onSave()
  })
}
