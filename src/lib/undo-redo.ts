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
import type { PdfFormatState } from '../formats/pdf'
import type { ParagraphEdit } from '../services/pdfParagraphEdits'

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
  const restored = clonePdfHistorySnapshot(snapshot)
  // Save-report fields track SAVES, not document states. Snapshots
  // exclude them (historyStore cloneValue), so carry the CURRENT
  // values across — undo must neither wipe the live save report nor
  // resurrect a stale one (Session-1 degradation channel).
  const current = useFormatStore.getState().getFormatState<Record<string, unknown>>(tabId)
  if (current) {
    for (const k of ['_lastSaveReport', '_postSaveNotices', '_postSaveWarning']) {
      if (current[k] !== undefined) (restored as Record<string, unknown>)[k] = current[k]
    }
  }
  useFormatStore.getState().setFormatState(tabId, restored)
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
  }
}

// Night-2 decision #2 (2026-06-11): undo is DOCUMENT history only.
// The uiStore subscription that pushed ui:tool / ui:zoom entries and
// the ui:* replay cases were removed at this seam — tool switches,
// zoom steps, and ribbon drags are no longer undoable. historyStore
// rejects 'ui:'-prefixed entries at runtime as the backstop.
