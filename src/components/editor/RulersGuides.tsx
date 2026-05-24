// Rulers, guides, grid, snap. Overlays on top of the PDF viewer.
// Purely visual — guides are not serialized into the PDF. Snap-to-
// grid affects object placement via Fabric's `object:moving` event
// and is also applied to guide drag positions when enabled.

import { useEffect, useRef, useState } from 'react'
import type { Canvas } from 'fabric'

export interface Guide {
  axis: 'h' | 'v'
  pos: number
}

export interface RulersGuidesProps {
  fabricCanvas: Canvas | null
  width: number
  height: number
  showRulers: boolean
  showGrid: boolean
  gridSize?: number   // pt
  snapToGrid?: boolean
  guides?: ReadonlyArray<Guide>
  onAddGuide?: (axis: 'h' | 'v', pos: number) => void
  onMoveGuide?: (idx: number, pos: number) => void
  onRemoveGuide?: (idx: number) => void
}

export function RulersGuides({
  fabricCanvas,
  width,
  height,
  showRulers,
  showGrid,
  gridSize = 50,
  snapToGrid = false,
  guides = [],
  onAddGuide,
  onMoveGuide,
  onRemoveGuide,
}: RulersGuidesProps) {
  const gridRef = useRef<HTMLCanvasElement>(null)
  const rulerHRef = useRef<HTMLCanvasElement>(null)
  const rulerVRef = useRef<HTMLCanvasElement>(null)
  const [dragIdx, setDragIdx] = useState<number | null>(null)

  // Draw grid
  useEffect(() => {
    const c = gridRef.current
    if (!c || !showGrid) return
    c.width = width
    c.height = height
    const ctx = c.getContext('2d')!
    ctx.clearRect(0, 0, width, height)
    ctx.strokeStyle = 'rgba(137,180,250,0.15)'
    ctx.lineWidth = 1
    for (let x = gridSize; x < width; x += gridSize) {
      ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, height); ctx.stroke()
    }
    for (let y = gridSize; y < height; y += gridSize) {
      ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(width, y + 0.5); ctx.stroke()
    }
  }, [showGrid, gridSize, width, height])

  // Draw rulers
  useEffect(() => {
    if (!showRulers) return
    const drawH = () => {
      const c = rulerHRef.current
      if (!c) return
      c.width = width
      c.height = 20
      const ctx = c.getContext('2d')!
      ctx.fillStyle = '#313244'
      ctx.fillRect(0, 0, width, 20)
      ctx.strokeStyle = '#a6adc8'
      ctx.fillStyle = '#cdd6f4'
      ctx.font = '9px sans-serif'
      for (let x = 0; x < width; x += 10) {
        const len = x % 50 === 0 ? 10 : x % 25 === 0 ? 7 : 4
        ctx.beginPath(); ctx.moveTo(x + 0.5, 20); ctx.lineTo(x + 0.5, 20 - len); ctx.stroke()
        if (x % 50 === 0 && x > 0) ctx.fillText(String(x), x + 2, 10)
      }
    }
    const drawV = () => {
      const c = rulerVRef.current
      if (!c) return
      c.width = 20
      c.height = height
      const ctx = c.getContext('2d')!
      ctx.fillStyle = '#313244'
      ctx.fillRect(0, 0, 20, height)
      ctx.strokeStyle = '#a6adc8'
      ctx.fillStyle = '#cdd6f4'
      ctx.font = '9px sans-serif'
      for (let y = 0; y < height; y += 10) {
        const len = y % 50 === 0 ? 10 : y % 25 === 0 ? 7 : 4
        ctx.beginPath(); ctx.moveTo(20, y + 0.5); ctx.lineTo(20 - len, y + 0.5); ctx.stroke()
        if (y % 50 === 0 && y > 0) { ctx.save(); ctx.translate(10, y + 12); ctx.rotate(-Math.PI / 2); ctx.fillText(String(y), 0, 4); ctx.restore() }
      }
    }
    drawH(); drawV()
  }, [showRulers, width, height])

  // Snap to grid on object move (fabric scope)
  useEffect(() => {
    if (!fabricCanvas || !snapToGrid) return
    const handler = (e: { target?: { left?: number; top?: number; set?: (opts: object) => void } }) => {
      if (!e.target || typeof e.target.set !== 'function') return
      const lx = Math.round((e.target.left ?? 0) / gridSize) * gridSize
      const ly = Math.round((e.target.top ?? 0) / gridSize) * gridSize
      e.target.set({ left: lx, top: ly })
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(fabricCanvas as any).on('object:moving', handler)
    return () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(fabricCanvas as any).off('object:moving', handler)
    }
  }, [fabricCanvas, snapToGrid, gridSize])

  const handleRulerClick = (axis: 'h' | 'v') => (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!onAddGuide) return
    const rect = e.currentTarget.getBoundingClientRect()
    const raw = axis === 'h' ? e.clientX - rect.left : e.clientY - rect.top
    const pos = snapToGrid ? Math.round(raw / gridSize) * gridSize : raw
    onAddGuide(axis, pos)
  }

  // Pointer-driven guide drag. `pointer:capture` locks the event
  // stream to the guide handle so dragging off the page edge still
  // delivers moves until pointerup. Position is clamped to [0, extent)
  // so guides can't vanish off-screen.
  const onGuidePointerDown = (idx: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (!onMoveGuide) return
    e.preventDefault()
    e.stopPropagation()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    setDragIdx(idx)
  }
  const onGuidePointerMove = (idx: number, axis: 'h' | 'v') => (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragIdx !== idx || !onMoveGuide) return
    const el = e.currentTarget
    // offsetParent is the page container (position: relative). We want
    // coordinates in its local space, not window coordinates, because
    // the page may be scrolled or offset within a larger viewport.
    const parent = el.offsetParent as HTMLElement | null
    if (!parent) return
    const rect = parent.getBoundingClientRect()
    const raw = axis === 'h' ? e.clientY - rect.top : e.clientX - rect.left
    const extent = axis === 'h' ? height : width
    const clamped = Math.max(0, Math.min(extent - 1, raw))
    const snapped = snapToGrid ? Math.round(clamped / gridSize) * gridSize : clamped
    onMoveGuide(idx, snapped)
  }
  const onGuidePointerUp = (idx: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragIdx !== idx) return
    const el = e.currentTarget
    try { el.releasePointerCapture(e.pointerId) } catch { /* pointer may already be released */ }
    setDragIdx(null)
  }
  const onGuideDoubleClick = (idx: number) => () => {
    if (!onRemoveGuide) return
    onRemoveGuide(idx)
  }

  return (
    <>
      {showGrid && (
        <canvas
          ref={gridRef}
          style={{ position: 'absolute', top: 0, left: 0, width, height, pointerEvents: 'none', zIndex: 2 }}
        />
      )}
      {showRulers && (
        <>
          <canvas
            ref={rulerHRef}
            onClick={handleRulerClick('v')}
            style={{ position: 'absolute', top: -20, left: 0, width, height: 20, zIndex: 3, cursor: 'crosshair' }}
            title="Click to add vertical guide"
          />
          <canvas
            ref={rulerVRef}
            onClick={handleRulerClick('h')}
            style={{ position: 'absolute', top: 0, left: -20, width: 20, height, zIndex: 3, cursor: 'crosshair' }}
            title="Click to add horizontal guide"
          />
        </>
      )}
      {guides.map((g, i) => {
        const isDragging = dragIdx === i
        const base = {
          position: 'absolute' as const,
          background: isDragging ? 'rgba(243, 139, 168, 0.95)' : 'rgba(243, 139, 168, 0.6)',
          zIndex: 4,
          cursor: g.axis === 'v' ? 'ew-resize' : 'ns-resize',
          // A 9px wide grab band centered on the 1px guide line. The
          // visible line stays 1px via an inner ::before pseudo-style
          // emulated with a child <span>, but for simplicity we widen
          // the whole div and use a solid color with alpha — users
          // see a slightly thicker bar, which is fine.
        }
        const style = g.axis === 'v'
          ? { ...base, top: 0, left: g.pos - 4, width: 9, height }
          : { ...base, left: 0, top: g.pos - 4, height: 9, width }
        return (
          <div
            key={`${g.axis}-${i}`}
            style={style}
            title={`${g.axis === 'v' ? 'Vertical' : 'Horizontal'} guide @ ${Math.round(g.pos)}px — drag to move, double-click to delete`}
            onPointerDown={onGuidePointerDown(i)}
            onPointerMove={onGuidePointerMove(i, g.axis)}
            onPointerUp={onGuidePointerUp(i)}
            onPointerCancel={onGuidePointerUp(i)}
            onDoubleClick={onGuideDoubleClick(i)}
          />
        )
      })}
    </>
  )
}
