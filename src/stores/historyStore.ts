import { create } from 'zustand'
import type { PdfPageState } from '../formats/pdf'
import type { ParagraphEdit } from '../services/pdfParagraphEdits'
import type { Tool } from '../types/pdf'

interface HistoryEntryMeta {
  label?: string
  coalesceKey?: string
  createdAt?: number
  estimatedBytes?: number
}

interface FabricEntry {
  type: 'fabric'
  pageIndex: number
  fabricJSON: Record<string, unknown>
}

interface PagesEntry {
  type: 'pages'
  tabId: string
  before: PdfPageState[]
  after: PdfPageState[]
  /** Legacy one-way snapshot. Kept so older callers/tests fail soft
   *  while the codebase migrates to before/after entries. */
  pages?: PdfPageState[]
}

export interface PdfHistorySnapshot {
  [key: string]: unknown
  pdfBytes: Uint8Array
  pageCount: number
  pages: PdfPageState[]
}

interface PdfStateEntry {
  type: 'pdf_state'
  tabId: string
  before: PdfHistorySnapshot
  after: PdfHistorySnapshot
}

/** Paragraph-level text edit history entry. Stores BEFORE and AFTER
 *  snapshots of a page's _paragraphEdits so we can bidirectionally
 *  replay either state. The layer pushes one entry per commit (blur),
 *  not per keystroke — matches tldraw's mark-on-commit pattern. */
interface ParagraphEditsEntry {
  type: 'paragraph_edits'
  tabId: string
  pageIndex: number
  before: ParagraphEdit[] | undefined
  after: ParagraphEdit[] | undefined
}

/** UI-state history entries — tool selection, ribbon tab order,
 *  ribbon active tab, zoom. Lightweight before/after snapshots so
 *  Ctrl+Z works for "I clicked the wrong tool" / "I dragged the
 *  ribbon and want it back" without a separate undo per state slice. */
interface UiToolEntry {
  type: 'ui:tool'
  before: Tool
  after: Tool
}

interface UiRibbonOrderEntry {
  type: 'ui:ribbonOrder'
  before: string[]
  after: string[]
}

interface UiRibbonTabEntry {
  type: 'ui:ribbonTab'
  before: string
  after: string
}

interface UiZoomEntry {
  type: 'ui:zoom'
  before: number
  after: number
}

type RawHistoryEntry =
  | FabricEntry
  | PagesEntry
  | PdfStateEntry
  | ParagraphEditsEntry
  | UiToolEntry
  | UiRibbonOrderEntry
  | UiRibbonTabEntry
  | UiZoomEntry

export type HistoryEntry = RawHistoryEntry & HistoryEntryMeta

/** When the keyboard shortcut handler replays a UI entry, it sets
 *  this flag so the wrapped setter (e.g. setTool) doesn't push a
 *  fresh history entry that would clobber the redo stack. Module-
 *  level so callers don't need to thread it through props. */
let _replaying = false
export function isReplaying(): boolean { return _replaying }
export function withReplay<T>(fn: () => T): T {
  _replaying = true
  try { return fn() }
  finally { _replaying = false }
}

interface HistoryState {
  undoStack: HistoryEntry[]
  redoStack: HistoryEntry[]
  pushUndo: (entry: HistoryEntry) => void
  undo: () => HistoryEntry | null
  redo: () => HistoryEntry | null
  clear: () => void
}

const MAX_HISTORY = 100
const MAX_HISTORY_ESTIMATED_BYTES = 128 * 1024 * 1024
const COALESCE_WINDOW_MS = 1_000

function cloneValue<T>(value: T): T {
  if (value instanceof Uint8Array) return new Uint8Array(value) as T
  if (Array.isArray(value)) return value.map((v) => cloneValue(v)) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Runtime-only paint handoff state should never become an undo
      // target; it is derived from pending edits and cleared after render.
      if (k === '_savePreviewParagraphEdits' || k === '_savePreviewImageEdits') continue
      out[k] = cloneValue(v)
    }
    return out as T
  }
  return value
}

export function clonePdfHistorySnapshot<T extends PdfHistorySnapshot>(state: T): T {
  return cloneValue(state)
}

function estimateValueBytes(value: unknown, seen = new WeakSet<object>()): number {
  if (value == null) return 0
  if (value instanceof Uint8Array) return value.byteLength
  switch (typeof value) {
    case 'boolean': return 4
    case 'number': return 8
    case 'string': return value.length * 2
    case 'object': {
      if (seen.has(value)) return 0
      seen.add(value)
      if (Array.isArray(value)) {
        return value.reduce((sum, item) => sum + estimateValueBytes(item, seen), 0)
      }
      return Object.entries(value as Record<string, unknown>).reduce(
        (sum, [key, item]) => sum + key.length * 2 + estimateValueBytes(item, seen),
        0,
      )
    }
    default:
      return 0
  }
}

export function estimateHistoryEntryBytes(entry: HistoryEntry): number {
  return estimateValueBytes(entry)
}

function defaultLabel(entry: HistoryEntry): string {
  switch (entry.type) {
    case 'pdf_state': return 'PDF edit'
    case 'paragraph_edits': return 'Paragraph edit'
    case 'pages': return 'Page edit'
    case 'fabric': return 'Annotation edit'
    case 'ui:tool': return 'Tool change'
    case 'ui:zoom': return 'Zoom change'
    case 'ui:ribbonOrder': return 'Ribbon order change'
    case 'ui:ribbonTab': return 'Ribbon tab change'
  }
}

function withMetadata(entry: HistoryEntry): HistoryEntry {
  const createdAt = entry.createdAt ?? Date.now()
  const labeled = {
    ...entry,
    label: entry.label ?? defaultLabel(entry),
    createdAt,
  }
  return {
    ...labeled,
    estimatedBytes: entry.estimatedBytes ?? estimateHistoryEntryBytes(labeled),
  }
}

function canCoalesce(prev: HistoryEntry | undefined, next: HistoryEntry): boolean {
  if (!prev?.coalesceKey || !next.coalesceKey) return false
  if (prev.type !== next.type || prev.coalesceKey !== next.coalesceKey) return false
  return (next.createdAt ?? 0) - (prev.createdAt ?? 0) <= COALESCE_WINDOW_MS
}

function mergeCoalescedEntry(prev: HistoryEntry, next: HistoryEntry): HistoryEntry {
  let merged: HistoryEntry
  switch (next.type) {
    case 'pdf_state':
      merged = { ...next, before: (prev as Extract<HistoryEntry, { type: 'pdf_state' }>).before }
      break
    case 'paragraph_edits':
      merged = { ...next, before: (prev as Extract<HistoryEntry, { type: 'paragraph_edits' }>).before }
      break
    case 'pages':
      merged = { ...next, before: (prev as Extract<HistoryEntry, { type: 'pages' }>).before }
      break
    case 'ui:zoom':
      merged = { ...next, before: (prev as Extract<HistoryEntry, { type: 'ui:zoom' }>).before }
      break
    default:
      merged = next
  }
  return withMetadata({
    ...merged,
    createdAt: prev.createdAt,
    estimatedBytes: undefined,
  })
}

function trimUndoStack(stack: HistoryEntry[]): HistoryEntry[] {
  let trimmed = stack.slice(-MAX_HISTORY)
  let estimatedBytes = trimmed.reduce((sum, entry) => sum + (entry.estimatedBytes ?? 0), 0)
  while (trimmed.length > 1 && estimatedBytes > MAX_HISTORY_ESTIMATED_BYTES) {
    const [dropped, ...rest] = trimmed
    estimatedBytes -= dropped.estimatedBytes ?? 0
    trimmed = rest
  }
  return trimmed
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  undoStack: [],
  redoStack: [],

  pushUndo: (entry) =>
    set((state) => {
      const next = withMetadata(entry)
      const prev = state.undoStack[state.undoStack.length - 1]
      if (canCoalesce(prev, next)) {
        return {
          undoStack: trimUndoStack([
            ...state.undoStack.slice(0, -1),
            mergeCoalescedEntry(prev, next),
          ]),
          redoStack: [],
        }
      }
      return {
        undoStack: trimUndoStack([...state.undoStack, next]),
        redoStack: [] // Clear redo on new action
      }
    }),

  undo: () => {
    const state = get()
    if (state.undoStack.length === 0) return null
    const entry = state.undoStack[state.undoStack.length - 1]
    set({
      undoStack: state.undoStack.slice(0, -1),
      redoStack: [...state.redoStack, entry]
    })
    return entry
  },

  redo: () => {
    const state = get()
    if (state.redoStack.length === 0) return null
    const entry = state.redoStack[state.redoStack.length - 1]
    set({
      redoStack: state.redoStack.slice(0, -1),
      undoStack: [...state.undoStack, entry]
    })
    return entry
  },

  clear: () => set({ undoStack: [], redoStack: [] })
}))
