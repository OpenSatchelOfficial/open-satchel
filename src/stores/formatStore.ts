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

function stripBytesForCompare(value: PdfHistorySnapshot): Record<string, unknown> {
  const cloned = clonePdfHistorySnapshot(value) as Record<string, unknown>
  delete cloned.pdfBytes
  return cloned
}

function pdfStateChanged(prev: PdfHistorySnapshot, next: PdfHistorySnapshot): boolean {
  if (prev.pdfBytes !== next.pdfBytes) return true
  return JSON.stringify(stripBytesForCompare(prev)) !== JSON.stringify(stripBytesForCompare(next))
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
    set((s) => ({ data: { ...s.data, [tabId]: state } })),

  getFormatState: <T,>(tabId: string): T | undefined =>
    get().data[tabId] as T | undefined,

  updateFormatState: <T,>(tabId: string, updater: (prev: T) => T) =>
    set((s) => {
      const prev = s.data[tabId] as T | undefined
      if (prev === undefined) return s
      const before =
        !isReplaying() && isPdfHistoryState(prev)
          ? clonePdfHistorySnapshot(prev)
          : null
      const next = updater(prev)
      if (
        before &&
        isPdfHistoryState(next) &&
        pdfStateChanged(before, next)
      ) {
        useHistoryStore.getState().pushUndo({
          type: 'pdf_state',
          tabId,
          before,
          after: clonePdfHistorySnapshot(next),
          ...describePdfStateChange(tabId, before, next),
        })
      }
      return { data: { ...s.data, [tabId]: next } }
    }),

  clearFormatState: (tabId) =>
    set((s) => {
      const { [tabId]: _dropped, ...rest } = s.data
      return { data: rest }
    }),
}))
