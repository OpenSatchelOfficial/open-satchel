import { create } from 'zustand'
import { v4 as uuid } from 'uuid'
import type { TabDescriptor, DocumentFormat } from '../types/tabs'

interface TabActions {
  openTab: (filePath: string | null, fileName: string, format: DocumentFormat) => string
  closeTab: (id: string) => void
  setActiveTab: (id: string) => void
  // Secondary pane: null = single-pane mode.
  // Used by M7 split-view work; harmless in M1 because UI ignores it.
  setSecondaryTab: (id: string | null) => void
  setTabDirty: (id: string, dirty: boolean) => void
  setTabFilePath: (id: string, path: string, name: string) => void
  reorderTabs: (fromIndex: number, toIndex: number) => void
}

interface TabState {
  tabs: TabDescriptor[]
  activeTabId: string | null
  secondaryTabId: string | null
}

export const useTabStore = create<TabState & TabActions>((set, get) => ({
  tabs: [],
  activeTabId: null,
  secondaryTabId: null,

  openTab: (filePath, fileName, format) => {
    // Activate existing tab if the same file is already open — matches
    // Electron-era behavior users expect.
    if (filePath) {
      const existing = get().tabs.find((t) => t.filePath === filePath)
      if (existing) {
        set({ activeTabId: existing.id })
        return existing.id
      }
    }

    const id = uuid()
    const tab: TabDescriptor = { id, filePath, fileName, format, isDirty: false }
    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabId: id,
    }))
    return id
  },

  closeTab: (id) => {
    set((state) => {
      const tabs = state.tabs.filter((t) => t.id !== id)
      let activeTabId = state.activeTabId
      let secondaryTabId = state.secondaryTabId
      if (activeTabId === id) {
        const closedIndex = state.tabs.findIndex((t) => t.id === id)
        activeTabId = tabs.length > 0 ? tabs[Math.min(closedIndex, tabs.length - 1)].id : null
      }
      if (secondaryTabId === id) secondaryTabId = null
      return { tabs, activeTabId, secondaryTabId }
    })
    // Drop the JS-side blob cache + reap idle pdfium worker
    // children + clear the format-store slice for this tab. After
    // closing a heavy doc the OS may not GC the worker processes
    // for many seconds; reaping reclaims ~50 MB per worker
    // immediately. Format-store cleanup drops the per-tab pdfBytes
    // (33 MB on brand-guidelines.pdf), accumulated incremental-save
    // bytes, fabric JSON state, and pdfjs doc refs — without it,
    // closing a tab leaves the doc heap-resident until the V8 GC
    // decides to collect (which can be never on a long-lived
    // WebView). All best-effort. Run async so close stays sync.
    void (async () => {
      try {
        const { useFormatStore } = await import('./formatStore')
        useFormatStore.getState().clearFormatState(id)
      } catch { /* swallow */ }
      try {
        const { clearPdfiumRenderCache } = await import('../services/pdfiumRender')
        clearPdfiumRenderCache()
      } catch { /* swallow */ }
      try {
        const { invalidateLightRenderCache } = await import(
          '../formats/pdf/pageRendererLightCache'
        )
        invalidateLightRenderCache()
      } catch { /* swallow */ }
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('engine_reap_pool_workers')
      } catch { /* swallow */ }
    })()
  },

  setActiveTab: (id) => set({ activeTabId: id }),
  setSecondaryTab: (id) => set({ secondaryTabId: id }),

  setTabDirty: (id, dirty) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === id ? { ...t, isDirty: dirty } : t)),
    })),

  setTabFilePath: (id, path, name) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === id ? { ...t, filePath: path, fileName: name } : t)),
    })),

  reorderTabs: (fromIndex, toIndex) =>
    set((state) => {
      const tabs = [...state.tabs]
      const [moved] = tabs.splice(fromIndex, 1)
      tabs.splice(toIndex, 0, moved)
      return { tabs }
    }),
}))
