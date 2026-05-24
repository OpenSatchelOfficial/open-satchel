// Drag-reorderable tool tile container for the ribbon.
//
// Wraps a set of tool tiles in HTML5 DnD so the user can rearrange
// them within the same group. Right-click on any tile (contextmenu)
// resets the group to its canonical default. Visual feedback during
// drag: dragged tile fades, drop-target highlights with a thin
// outline that matches the accent color.
//
// Persistence + reconciliation lives in ribbonGroupOrder.ts; this
// component is purely presentation + interaction. Pass an `items`
// map keyed by tool id with a `render` callback per tool — the
// component picks the order via getOrderedToolIds(groupId) and
// invokes the callbacks in that order.

import { useEffect, useState, type ReactNode } from 'react'
import {
  getOrderedToolIds,
  moveToolWithinGroup,
  resetToolOrder,
  isGroupCustomized,
} from './ribbonGroupOrder'

interface Props {
  /** Group key registered in DEFAULT_RIBBON_TOOL_ORDER. Tool ids
   *  not in the canonical default are silently dropped (the user
   *  can't reorder unknown tools). */
  groupId: string
  /** Tile renderers keyed by tool id. Tiles not in this map are
   *  skipped — useful when a group's complete set of tools isn't
   *  always all rendered (feature flags, format-conditional). */
  items: Record<string, () => ReactNode>
  /** Callback fired after every successful reorder. The reorder
   *  is already persisted to localStorage; pass this to trigger
   *  a parent state update if you need fresh order on subsequent
   *  renders without remount. */
  onReorder?: () => void
}

export default function OrderedToolGroup({ groupId, items, onReorder }: Props) {
  // Re-read order on mount + after reorder. Storing in component
  // state lets us re-render on drop without forcing parents to
  // pass a key= bust.
  const [order, setOrder] = useState<string[]>(() => getOrderedToolIds(groupId))
  useEffect(() => {
    setOrder(getOrderedToolIds(groupId))
  }, [groupId])

  const [draggingIndex, setDraggingIndex] = useState<number | null>(null)
  const [dropTarget, setDropTarget] = useState<number | null>(null)

  const handleDrop = (toIndex: number) => {
    if (draggingIndex === null || draggingIndex === toIndex) {
      setDraggingIndex(null)
      setDropTarget(null)
      return
    }
    const next = moveToolWithinGroup(groupId, draggingIndex, toIndex)
    setOrder(next)
    setDraggingIndex(null)
    setDropTarget(null)
    onReorder?.()
  }

  const handleContextMenu = (e: React.MouseEvent) => {
    // Right-click → reset this group to canonical default. Skip
    // confirm dialog because the action is non-destructive (no data
    // loss) and undoable by re-dragging.
    e.preventDefault()
    if (!isGroupCustomized(groupId)) return
    resetToolOrder(groupId)
    setOrder(getOrderedToolIds(groupId))
    onReorder?.()
  }

  return (
    <div
      data-testid={`ordered-tool-group-${groupId}`}
      data-group-id={groupId}
      onContextMenu={handleContextMenu}
      style={{
        display: 'contents', // children participate in parent flex/grid
      }}
    >
      {order.map((toolId, idx) => {
        const render = items[toolId]
        if (!render) return null
        const isDragging = draggingIndex === idx
        const isDropTarget = dropTarget === idx && draggingIndex !== idx
        return (
          <div
            key={toolId}
            draggable
            data-tool-id={toolId}
            data-tool-index={idx}
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/plain', toolId)
              setDraggingIndex(idx)
            }}
            onDragEnter={(e) => {
              e.preventDefault()
              if (draggingIndex !== null && draggingIndex !== idx) {
                setDropTarget(idx)
              }
            }}
            onDragOver={(e) => {
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
            }}
            onDragLeave={() => {
              setDropTarget((cur) => (cur === idx ? null : cur))
            }}
            onDrop={(e) => {
              e.preventDefault()
              handleDrop(idx)
            }}
            onDragEnd={() => {
              setDraggingIndex(null)
              setDropTarget(null)
            }}
            style={{
              opacity: isDragging ? 0.4 : 1,
              outline: isDropTarget ? '2px solid var(--accent)' : 'none',
              outlineOffset: -1,
              borderRadius: 3,
              cursor: 'grab',
              transition: 'opacity 80ms',
            }}
          >
            {render()}
          </div>
        )
      })}
    </div>
  )
}
