// Layers / object panel. Lists every Fabric object on the active page
// with lock / visibility toggles, z-order controls, and click-to-select.

import { useState, useEffect } from 'react'
import type { Canvas, FabricObject } from 'fabric'

interface Props {
  fabricCanvas: Canvas | null
  onChange?: () => void
}

export default function LayersPanel({ fabricCanvas, onChange }: Props) {
  const [version, setVersion] = useState(0)
  const bump = () => setVersion((v) => v + 1)

  // Re-render whenever canvas objects change
  useEffect(() => {
    if (!fabricCanvas) return
    const events = ['object:added', 'object:removed', 'object:modified', 'selection:created', 'selection:cleared', 'selection:updated']
    for (const e of events) fabricCanvas.on(e as never, bump)
    return () => {
      for (const e of events) fabricCanvas.off(e as never, bump as never)
    }
  }, [fabricCanvas])

  if (!fabricCanvas) return null
  const objects = fabricCanvas.getObjects()
  const active = fabricCanvas.getActiveObject()

  const handleSelect = (obj: FabricObject) => {
    fabricCanvas.setActiveObject(obj)
    fabricCanvas.renderAll()
    bump()
  }

  const toggleLock = (obj: FabricObject) => {
    const locked = !obj.lockMovementX
    obj.set({ lockMovementX: locked, lockMovementY: locked, lockScalingX: locked, lockScalingY: locked, lockRotation: locked, selectable: !locked })
    fabricCanvas.renderAll(); bump(); onChange?.()
  }

  const toggleVisibility = (obj: FabricObject) => {
    obj.visible = !obj.visible
    fabricCanvas.renderAll(); bump(); onChange?.()
  }

  const deleteObj = (obj: FabricObject) => {
    fabricCanvas.remove(obj); bump(); onChange?.()
  }

  const moveUp = (obj: FabricObject) => { fabricCanvas.bringObjectForward(obj); bump(); onChange?.() }
  const moveDown = (obj: FabricObject) => { fabricCanvas.sendObjectBackwards(obj); bump(); onChange?.() }
  const moveTop = (obj: FabricObject) => { fabricCanvas.bringObjectToFront(obj); bump(); onChange?.() }
  const moveBottom = (obj: FabricObject) => { fabricCanvas.sendObjectToBack(obj); bump(); onChange?.() }

  const label = (o: FabricObject) => {
    const t = o.type || 'obj'
    if (t.toLowerCase() === 'textbox') return `Text: "${((o as unknown as { text?: string }).text ?? '').slice(0, 20)}"`
    if (t.toLowerCase() === 'image') return 'Image'
    if (t.toLowerCase() === 'path') return 'Drawing'
    if (t.toLowerCase() === 'group') return 'Group'
    return t
  }

  return (
    <div data-testid="layers-panel" style={{
      padding: 8, background: 'var(--bg-surface)', border: '1px solid var(--border)',
      borderRadius: 4, fontSize: 11, color: 'var(--text-primary)', width: '100%'
    }}>
      <div style={{ marginBottom: 6, fontWeight: 600, color: 'var(--text-secondary)' }}>Layers ({objects.length}) <span data-testid="layers-version" style={{ display: 'none' }}>{version}</span></div>
      {objects.length === 0 && <div style={{ color: 'var(--text-muted)' }}>No objects on this page.</div>}
      {[...objects].reverse().map((obj, i) => {
        const actualIdx = objects.length - 1 - i
        const isActive = obj === active
        return (
          <div key={actualIdx} data-testid={`layer-${actualIdx}`} style={{
            display: 'flex', alignItems: 'center', gap: 4, padding: '3px 4px',
            background: isActive ? 'var(--accent)' : 'transparent',
            color: isActive ? 'var(--bg-primary)' : 'var(--text-primary)',
            borderRadius: 2, cursor: 'pointer'
          }} onClick={() => handleSelect(obj)}>
            <button onClick={(e) => { e.stopPropagation(); toggleVisibility(obj) }} title="Toggle visibility" style={{ background:'transparent', border:'none', cursor:'pointer', padding:0, color:'inherit' }}>{obj.visible !== false ? '👁' : '—'}</button>
            <button onClick={(e) => { e.stopPropagation(); toggleLock(obj) }} title="Toggle lock" style={{ background:'transparent', border:'none', cursor:'pointer', padding:0, color:'inherit' }}>{obj.lockMovementX ? '🔒' : '🔓'}</button>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label(obj)}</span>
            <button onClick={(e) => { e.stopPropagation(); moveTop(obj) }} title="To front" style={{ background:'transparent', border:'none', cursor:'pointer', padding:0, color:'inherit' }}>⇈</button>
            <button onClick={(e) => { e.stopPropagation(); moveUp(obj) }} title="Up" style={{ background:'transparent', border:'none', cursor:'pointer', padding:0, color:'inherit' }}>↑</button>
            <button onClick={(e) => { e.stopPropagation(); moveDown(obj) }} title="Down" style={{ background:'transparent', border:'none', cursor:'pointer', padding:0, color:'inherit' }}>↓</button>
            <button onClick={(e) => { e.stopPropagation(); moveBottom(obj) }} title="To back" style={{ background:'transparent', border:'none', cursor:'pointer', padding:0, color:'inherit' }}>⇊</button>
            <button onClick={(e) => { e.stopPropagation(); deleteObj(obj) }} title="Delete" style={{ background:'transparent', border:'none', cursor:'pointer', padding:0, color:'var(--danger)' }}>✕</button>
          </div>
        )
      })}
    </div>
  )
}
