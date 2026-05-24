// Central undo/redo dispatcher.
//
// historyStore holds typed entries from multiple subsystems (Fabric
// overlays, page-level mods, paragraph-text edits, UI state changes
// like tool/zoom/ribbon-tab order). This module pops the top of the
// stack, inspects `type`, and applies the inverse via the appropriate
// store. Keeping the dispatch here means shortcut handlers and UI
// buttons share one path.

import {
  clonePdfHistorySnapshot,
  useHistoryStore,
  withReplay,
  type HistoryEntry,
  type PdfHistorySnapshot,
} from '../stores/historyStore'
import { useFormatStore } from '../stores/formatStore'
import { useTabStore } from '../stores/tabStore'
import { useUIStore } from '../stores/uiStore'
import type { PdfFormatState } from '../formats/pdf'
import type { ParagraphEdit } from '../services/pdfParagraphEdits'
import type { Tool } from '../types/pdf'
import type { PdfRibbonTab } from '../components/layout/toolbarOrder'

/** Apply a history entry's "direction" to the page state. For undo we
 *  want `entry.before`; for redo we want `entry.after`. Callers pick. */
function applyParagraphEdits(
  tabId: string,
  pageIndex: number,
  edits: ParagraphEdit[] | undefined,
): void {
  useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({
    ...prev,
    pages: prev.pages.map((p) =>
      p.pageIndex === pageIndex
        ? ({ ...p, _paragraphEdits: edits && edits.length > 0 ? edits : undefined } as any)
        : p,
    ),
  }))
  // Dirty flag: true iff the target direction leaves ANY edits on ANY
  // page, else rely on caller's judgement. Conservative: mark dirty
  // whenever we mutate edits so the autosave knows to flush.
  useTabStore.getState().setTabDirty(tabId, true)
}

export function undo(): boolean {
  const entry = useHistoryStore.getState().undo()
  if (!entry) return false
  withReplay(() => applyEntry(entry, 'before'))
  return true
}

export function redo(): boolean {
  const entry = useHistoryStore.getState().redo()
  if (!entry) return false
  withReplay(() => applyEntry(entry, 'after'))
  return true
}

function applyPdfSnapshot(tabId: string, snapshot: PdfHistorySnapshot): void {
  useFormatStore.getState().setFormatState(tabId, clonePdfHistorySnapshot(snapshot))
  useTabStore.getState().setTabDirty(tabId, true)
}

function applyEntry(entry: HistoryEntry, dir: 'before' | 'after'): void {
  switch (entry.type) {
    case 'pdf_state':
      applyPdfSnapshot(entry.tabId, dir === 'before' ? entry.before : entry.after)
      return
    case 'paragraph_edits':
      applyParagraphEdits(
        entry.tabId,
        entry.pageIndex,
        dir === 'before' ? entry.before : entry.after,
      )
      return
    case 'pages':
      useFormatStore.getState().updateFormatState<PdfFormatState>(entry.tabId, (prev) => ({
        ...prev,
        pages: dir === 'before'
          ? ((entry as any).before ?? (entry as any).pages ?? prev.pages)
          : ((entry as any).after ?? prev.pages),
      }))
      useTabStore.getState().setTabDirty(entry.tabId, true)
      return
    case 'fabric':
      // Fabric entries are per-page JSON snapshots. FabricCanvas should
      // pick this up via its own subscription; if not, consumers can
      // listen on historyStore changes directly.
      return
    case 'ui:tool':
      withReplay(() => {
        useUIStore.getState().setTool((dir === 'before' ? entry.before : entry.after) as Tool)
      })
      return
    case 'ui:zoom':
      withReplay(() => {
        useUIStore.setState({ zoom: dir === 'before' ? entry.before : entry.after })
      })
      return
    case 'ui:ribbonOrder': {
      const setter = (window as Window & {
        __pdfRibbonSetTabs?: (t: PdfRibbonTab[]) => void
      }).__pdfRibbonSetTabs
      if (!setter) return
      withReplay(() => {
        setter((dir === 'before' ? entry.before : entry.after) as PdfRibbonTab[])
      })
      return
    }
    case 'ui:ribbonTab':
      // The ribbon tab is local component state in PdfToolbar; we don't
      // currently surface a setter for it. Skip silently rather than
      // throw — the entry just becomes a no-op replay.
      return
  }
}

// ───────────────────────────────────────────────────────────────────
// UI subscription — pushes `ui:tool` / `ui:zoom` history entries when
// useUIStore values change. Called once at app startup.
// Returns the unsubscribe function for symmetric cleanup.
// ───────────────────────────────────────────────────────────────────

import { isReplaying } from '../stores/historyStore'

let _uiSubscribed = false
export function subscribeUiHistory(): () => void {
  if (_uiSubscribed) return () => { /* already subscribed */ }
  _uiSubscribed = true
  let lastTool = useUIStore.getState().tool
  let lastZoom = useUIStore.getState().zoom
  const unsub = useUIStore.subscribe((state) => {
    if (isReplaying()) {
      lastTool = state.tool
      lastZoom = state.zoom
      return
    }
    if (state.tool !== lastTool) {
      useHistoryStore.getState().pushUndo({ type: 'ui:tool', before: lastTool, after: state.tool })
      lastTool = state.tool
    }
    if (state.zoom !== lastZoom) {
      useHistoryStore.getState().pushUndo({
        type: 'ui:zoom',
        before: lastZoom,
        after: state.zoom,
        label: 'Zoom change',
        coalesceKey: 'ui:zoom',
      })
      lastZoom = state.zoom
    }
  })
  return () => {
    _uiSubscribed = false
    unsub()
  }
}
