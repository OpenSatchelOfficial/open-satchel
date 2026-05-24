import { useEffect } from 'react'
import { useUIStore } from '../stores/uiStore'
import { useTabStore } from '../stores/tabStore'
import { openFile, saveFile, saveFileAs, closeActiveTab } from '../App'
import { undo as doUndo, redo as doRedo } from '../lib/undo-redo'

export function useKeyboardShortcuts() {
  const setTool = useUIStore((s) => s.setTool)
  const zoomIn = useUIStore((s) => s.zoomIn)
  const zoomOut = useUIStore((s) => s.zoomOut)
  const resetZoom = useUIStore((s) => s.resetZoom)
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  const toggleCommandPalette = useUIStore((s) => s.toggleCommandPalette)
  const openFind = useUIStore((s) => s.openFind)
  const openReplace = useUIStore((s) => s.openReplace)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey
      const shift = e.shiftKey
      const target = e.target as HTMLElement

      // Don't intercept when typing in inputs (unless it's a global shortcut)
      const isTyping = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable

      // Global shortcuts (work even in inputs)
      if (ctrl && !shift && e.key === 'f') { e.preventDefault(); openFind(); return }
      if (ctrl && !shift && e.key === 'h') { e.preventDefault(); openReplace(); return }
      if (ctrl && !shift && e.key === 'k') { e.preventDefault(); toggleCommandPalette(); return }
      if (ctrl && !shift && e.key === 'p') { e.preventDefault(); toggleCommandPalette(); return }
      if (ctrl && !shift && e.key === 'o') { e.preventDefault(); openFile(); return }
      if (ctrl && shift && e.key === 'S') { e.preventDefault(); saveFileAs(); return }
      if (ctrl && !shift && e.key === 's') { e.preventDefault(); saveFile(); return }
      if (ctrl && e.key === 'w') { e.preventDefault(); closeActiveTab(); return }

      if (ctrl && !shift && e.key === 'z') {
        e.preventDefault()
        doUndo()
        return
      }
      if (ctrl && (e.key === 'y' || (shift && e.key === 'Z'))) {
        e.preventDefault()
        doRedo()
        return
      }

      // Tab cycling
      if (ctrl && e.key === 'Tab') {
        e.preventDefault()
        const { tabs, activeTabId, setActiveTab } = useTabStore.getState()
        if (tabs.length <= 1) return
        const idx = tabs.findIndex((t) => t.id === activeTabId)
        const next = shift
          ? (idx - 1 + tabs.length) % tabs.length
          : (idx + 1) % tabs.length
        setActiveTab(tabs[next].id)
        return
      }

      // Ctrl+1-9 to switch tabs
      if (ctrl && e.key >= '1' && e.key <= '9') {
        e.preventDefault()
        const { tabs, setActiveTab } = useTabStore.getState()
        const idx = parseInt(e.key) - 1
        if (idx < tabs.length) setActiveTab(tabs[idx].id)
        return
      }

      // Don't intercept tool shortcuts when typing
      if (isTyping) return

      // Zoom
      if (ctrl && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomIn(); return }
      if (ctrl && e.key === '-') { e.preventDefault(); zoomOut(); return }
      if (ctrl && e.key === '0') { e.preventDefault(); resetZoom(); return }
      if (ctrl && e.key === 'b') { e.preventDefault(); toggleSidebar(); return }

      // Tool shortcuts (no modifier, not while typing)
      if (!ctrl && !shift) {
        switch (e.key) {
          case 'v': case 'V': setTool('select'); return
          case 't': case 'T': setTool('text'); return
          case 'd': case 'D': setTool('draw'); return
          case 'i': case 'I': setTool('image'); return
          case 'Escape': setTool('select'); return
        }
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [setTool, zoomIn, zoomOut, resetZoom, toggleSidebar, toggleCommandPalette, openFind, openReplace])
}
