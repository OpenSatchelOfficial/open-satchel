import { create } from 'zustand'
import {
  clonePdfHistorySnapshot,
  isReplaying,
  useHistoryStore,
  type PdfHistorySnapshot,
} from './historyStore'

// Per-tab format-specific state. Each format handler owns the shape of its
// own slice; we keep it untyped here to avoid a giant union. Handlers use
// `getFormatState<MyState>(tabId)` to get back a typed view.
//
// This matches the Electron-era pattern so porting handlers is mechanical.

interface FormatStoreState {
  data: Record<string, unknown>
  setFormatState: <T = unknown>(tabId: string, state: T) => void
  getFormatState: <T>(tabId: string) => T | undefined
  updateFormatState: <T>(tabId: string, updater: (prev: T) => T) => void
  clearFormatState: (tabId: string) => void
}

function isPdfHistoryState(value: unknown): value is PdfHistorySnapshot {
  if (!value || typeof value !== 'object') return false
  const v = value as { pdfBytes?: unknown; pages?: unknown; pageCount?: unknown }
  return v.pdfBytes instanceof Uint8Array && Array.isArray(v.pages) && typeof v.pageCount === 'number'
}

// ── I-2b: generation-swap worker-doc release ─────────────────────────
// When a committing save or an undo/redo swaps state.pdfBytes, the
// displaced generation's pdfjs WORKER document is orphaned — clearFormatState
// (the R15 close-fix) only releases on tab close, NOT on the bytes-replace
// paths (updateFormatState/setFormatState). Each orphan is ~one 33 MB parse
// resident in the worker until process exit (gauntlet-installed I-2b).
// Free it at the replace choke points — guarded (never destroy a ref a live
// tab still renders) and deferred (new render commits first).
function pdfBytesOf(state: unknown): Uint8Array | null {
  return state &&
    typeof state === 'object' &&
    (state as { pdfBytes?: unknown }).pdfBytes instanceof Uint8Array
    ? (state as { pdfBytes: Uint8Array }).pdfBytes
    : null
}

function bytesStillReferenced(
  data: Record<string, unknown>,
  bytes: Uint8Array,
): boolean {
  for (const entry of Object.values(data)) {
    if (
      entry &&
      typeof entry === 'object' &&
      (entry as { pdfBytes?: unknown }).pdfBytes === bytes
    ) {
      return true
    }
  }
  return false
}

function scheduleGenerationRelease(
  displaced: Uint8Array | null,
  replacement: Uint8Array | null,
): void {
  if (!displaced || displaced === replacement) return
  // Dynamic import keeps pdfDocCache store-agnostic and avoids a static
  // import cycle — the exact pattern clearFormatState already uses.
  void (async () => {
    try {
      const { releasePdfDocIfUnreferenced } = await import(
        '../components/viewer/pdfDocCache'
      )
      releasePdfDocIfUnreferenced(displaced, (b) =>
        bytesStillReferenced(useFormatStore.getState().data, b),
      )
    } catch {
      /* best-effort */
    }
  })()
}

function stripBytesForCompare(value: PdfHistorySnapshot): Record<string, unknown> {
  const cloned = clonePdfHistorySnapshot(value) as Record<string, unknown>
  delete cloned.pdfBytes
  return cloned
}

function pdfStateChanged(
  before: PdfHistorySnapshot,
  next: PdfHistorySnapshot,
  previousPdfBytes: Uint8Array,
): boolean {
  if (previousPdfBytes !== next.pdfBytes) return true
  return JSON.stringify(stripBytesForCompare(before)) !== JSON.stringify(stripBytesForCompare(next))
}

function stripPageRuntimeSlot(value: PdfHistorySnapshot, slot: string): Record<string, unknown> {
  const cloned = stripBytesForCompare(value)
  const pages = Array.isArray(cloned.pages) ? cloned.pages : []
  cloned.pages = pages.map((page) => {
    if (!page || typeof page !== 'object') return page
    const { [slot]: _slot, ...rest } = page as unknown as Record<string, unknown>
    void _slot
    return rest
  })
  return cloned
}

function pageSlotMap(state: PdfHistorySnapshot, slot: string, idField: string): Map<string, string> {
  const out = new Map<string, string>()
  state.pages.forEach((page, pageIndex) => {
    const items = (page as unknown as Record<string, unknown>)[slot]
    if (!Array.isArray(items)) return
    items.forEach((item, itemIndex) => {
      const id = item && typeof item === 'object'
        ? (item as Record<string, unknown>)[idField]
        : null
      out.set(`${pageIndex}:${String(id ?? itemIndex)}`, JSON.stringify(item))
    })
  })
  return out
}

function changedKeys(before: Map<string, string>, after: Map<string, string>): string[] {
  const keys = new Set([...before.keys(), ...after.keys()])
  return [...keys].filter((key) => before.get(key) !== after.get(key))
}

function describeParagraphChange(
  tabId: string,
  before: PdfHistorySnapshot,
  after: PdfHistorySnapshot,
): { label: string; coalesceKey?: string } | null {
  if (JSON.stringify(stripPageRuntimeSlot(before, '_paragraphEdits')) !== JSON.stringify(stripPageRuntimeSlot(after, '_paragraphEdits'))) {
    return null
  }
  const beforeMap = pageSlotMap(before, '_paragraphEdits', 'paragraphId')
  const afterMap = pageSlotMap(after, '_paragraphEdits', 'paragraphId')
  const keys = changedKeys(beforeMap, afterMap)
  if (keys.length !== 1) return { label: 'Paragraph edit' }

  const beforeEdit = beforeMap.get(keys[0]) ? JSON.parse(beforeMap.get(keys[0])!) : {}
  const afterEdit = afterMap.get(keys[0]) ? JSON.parse(afterMap.get(keys[0])!) : {}
  const changed = new Set(changedKeys(
    new Map(Object.entries(beforeEdit).map(([k, v]) => [k, JSON.stringify(v)])),
    new Map(Object.entries(afterEdit).map(([k, v]) => [k, JSON.stringify(v)])),
  ))
  const kind = changed.has('newText')
    ? 'text'
    : changed.has('positionDelta')
      ? 'move'
      : ['fontSize', 'color', 'bold', 'italic', 'fontFamily', 'align', 'lineHeight']
          .some((field) => changed.has(field))
        ? 'style'
        : 'edit'
  const label =
    kind === 'text' ? 'Paragraph text edit'
      : kind === 'move' ? 'Paragraph move'
        : kind === 'style' ? 'Paragraph style edit'
          : 'Paragraph edit'
  return { label, coalesceKey: `pdf:${tabId}:paragraph:${kind}:${keys[0]}` }
}

function describeImageChange(
  tabId: string,
  before: PdfHistorySnapshot,
  after: PdfHistorySnapshot,
): { label: string; coalesceKey?: string } | null {
  if (JSON.stringify(stripPageRuntimeSlot(before, '_imageEdits')) !== JSON.stringify(stripPageRuntimeSlot(after, '_imageEdits'))) {
    return null
  }
  const beforeMap = pageSlotMap(before, '_imageEdits', 'xObjectName')
  const afterMap = pageSlotMap(after, '_imageEdits', 'xObjectName')
  const keys = changedKeys(beforeMap, afterMap)
  if (keys.length !== 1) return { label: 'Image edit' }
  return { label: 'Image edit', coalesceKey: `pdf:${tabId}:image:${keys[0]}` }
}

function describePdfStateChange(
  tabId: string,
  before: PdfHistorySnapshot,
  after: PdfHistorySnapshot,
): { label: string; coalesceKey?: string } {
  const paragraph = describeParagraphChange(tabId, before, after)
  if (paragraph) return paragraph
  const image = describeImageChange(tabId, before, after)
  if (image) return image
  if (before.pageCount !== after.pageCount || before.pages.length !== after.pages.length) {
    return { label: 'PDF page change' }
  }
  return { label: 'PDF edit' }
}

export const useFormatStore = create<FormatStoreState>((set, get) => ({
  data: {},

  setFormatState: (tabId, state) =>
    set((s) => {
      // I-2b: free the displaced generation's orphaned worker doc (undo/redo
      // routes through here with a fresh-ref snapshot).
      scheduleGenerationRelease(pdfBytesOf(s.data[tabId]), pdfBytesOf(state))
      return { data: { ...s.data, [tabId]: state } }
    }),

  getFormatState: <T,>(tabId: string): T | undefined =>
    get().data[tabId] as T | undefined,

  updateFormatState: <T,>(tabId: string, updater: (prev: T) => T) =>
    set((s) => {
      const prev = s.data[tabId] as T | undefined
      if (prev === undefined) return s
      const prevSnapshot =
        !isReplaying() && isPdfHistoryState(prev)
          ? prev
          : null
      const before = prevSnapshot ? clonePdfHistorySnapshot(prevSnapshot) : null
      const next = updater(prev)
      if (
        prevSnapshot &&
        before &&
        isPdfHistoryState(next) &&
        pdfStateChanged(before, next, prevSnapshot.pdfBytes)
      ) {
        useHistoryStore.getState().pushUndo({
          type: 'pdf_state',
          tabId,
          before,
          after: clonePdfHistorySnapshot(next),
          ...describePdfStateChange(tabId, before, next),
        })
      }
      // I-2b: a committing save swaps pdfBytes here — free the displaced
      // generation's orphaned worker doc.
      scheduleGenerationRelease(pdfBytesOf(prev), pdfBytesOf(next))
      return { data: { ...s.data, [tabId]: next } }
    }),

  clearFormatState: (tabId) =>
    set((s) => {
      // Release the pdfjs WORKER document for this tab's CURRENT pdfBytes before
      // dropping the format entry — calling PDFDocumentProxy.destroy() (the only
      // thing that frees the worker's parsed copy; JS GC of the cache promise
      // does NOT). clearFormatState is the single choke point EVERY close path
      // funnels through (TabBar X + middle-click → TabBar.tsx; Ctrl+W →
      // closeActiveTab in actions.ts; and tabStore.closeTab's own cleanup), so
      // the release fires regardless of caller order. The earlier
      // tabStore.closeTab-only release was DEFEATED on real UI gestures because
      // those callers clearFormatState() synchronously BEFORE closeTab, leaving
      // closeTab's async getFormatState() === undefined → release never ran (the
      // ~190MB/cycle WebView2 renderer leak stayed UNFIXED on the gestures users
      // actually use; gauntlet-installed completeness-critic, 2026-06-14).
      // Fire-and-forget so this setter stays synchronous.
      const dropped = s.data[tabId] as { pdfBytes?: unknown } | undefined
      const bytes = dropped && dropped.pdfBytes instanceof Uint8Array ? dropped.pdfBytes : null
      if (bytes) {
        void (async () => {
          try {
            const { releasePdfDoc } = await import('../components/viewer/pdfDocCache')
            await releasePdfDoc(bytes)
          } catch { /* best-effort */ }
        })()
      }
      const { [tabId]: _dropped, ...rest } = s.data
      return { data: rest }
    }),
}))
