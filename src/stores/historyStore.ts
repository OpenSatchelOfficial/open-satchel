import { create } from 'zustand'
import type { PdfPageState } from '../formats/pdf'
import type { ParagraphEdit } from '../services/pdfParagraphEdits'

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

// NOTE (2026-06-11, Night-2 decision #2): undo history is DOCUMENT
// history only. The ui:tool / ui:zoom / ui:ribbonOrder / ui:ribbonTab
// entry types that used to interleave UI state into Ctrl+Z were
// removed — tool switches, zoom steps, and ribbon drags are not
// undoable. pushUndo() additionally rejects any 'ui:'-prefixed type
// at runtime so stale callers can't reintroduce them silently.

type RawHistoryEntry =
  | FabricEntry
  | PagesEntry
  | PdfStateEntry
  | ParagraphEditsEntry

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
  dropTab: (tabId: string) => void
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
      // _livePreviewParagraphEdits (Session 6) is the live reflow-preview
      // channel — neighbor shift edits recomputed on every keystroke,
      // never persisted and never undoable.
      if (
        k === '_savePreviewParagraphEdits' ||
        k === '_savePreviewImageEdits' ||
        k === '_livePreviewParagraphEdits'
      )
        continue
      // Save-report fields describe SAVES, not document states: a
      // snapshot must never carry them, or undo would resurrect a
      // stale degradation report / post-save toast (Session-1 channel;
      // applyPdfSnapshot preserves the CURRENT values instead).
      if (k === '_lastSaveReport' || k === '_postSaveNotices' || k === '_postSaveWarning') continue
      // NOTE (reverted 2026-06-14): a prior change SHARED the live pdfBytes
      // reference into snapshots to save memory. That was UNSAFE — pdfBytes is
      // not in-place-mutated, but pdfjs's worker transfer DETACHES the
      // underlying ArrayBuffer of any array passed to getDocument WITHOUT a
      // .slice() (e.g. the auto-tag path, src/services/pdfAutoTag.ts). With a
      // shared reference, edit -> auto-tag -> undo would restore a neutered
      // (zero-length) buffer = blank/corrupt document. Deep-copying keeps each
      // snapshot's bytes independent of any later detach. The memory cost is
      // bounded by MAX_HISTORY_ESTIMATED_BYTES (128 MB) and the per-tab
      // dropTab-on-close reclaim; correctness wins over that marginal saving.
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
      // Document-history-only guard: UI-state slices must never ride
      // the document undo stack again (Night-2 decision #2). Type
      // system prevents it for TS callers; this catches JS/test-hook
      // stragglers at runtime.
      if (String((entry as { type?: string }).type ?? '').startsWith('ui:')) {
        console.warn(
          `historyStore: dropped ${(entry as { type?: string }).type} entry — UI state is not undoable (document history only)`,
        )
        return state
      }
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

  clear: () => set({ undoStack: [], redoStack: [] }),

  // Free a closed tab's undo/redo entries. Each pdf_state snapshot holds
  // the tab's pages/edits (and references its ~33 MB pdfBytes); no close
  // path purged them before, so a closed heavy doc's history stayed
  // resident in the GLOBAL stacks until count/byte-cap eviction by other
  // tabs' edits (gauntlet-installed I-2c history contributor). Entries
  // carry tabId on every variant, so this is a precise per-tab drop that
  // leaves other open tabs' history intact.
  dropTab: (tabId) =>
    set((state) => {
      // FabricEntry carries no tabId (canvas-only, no pdfBytes); keep those.
      // The pdfBytes-heavy variants (pdf_state/pages/paragraph_edits) all
      // carry tabId, so this precisely drops the closed tab's entries.
      const keep = (e: HistoryEntry): boolean => {
        const t = (e as { tabId?: string }).tabId
        return t === undefined || t !== tabId
      }
      return {
        undoStack: state.undoStack.filter(keep),
        redoStack: state.redoStack.filter(keep),
      }
    }),
}))
