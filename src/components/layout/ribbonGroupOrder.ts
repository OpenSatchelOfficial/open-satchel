// Per-tool ribbon customization registry. Companion to toolbarOrder.ts
// (which handles tab-level reorder). This module persists per-group
// tool order so the user can drag tools within a group OR move tools
// between groups (same-tab only — cross-tab moves stay locked because
// the underlying tool/state coupling lives in PdfToolbar's render).
//
// The ribbon's JSX is currently hardcoded by group; integration will
// require routing each render through `getOrderedToolIds(groupId)`
// once + applying the order. That refactor is multi-day; this commit
// ships the persistence layer with strict tests so the integration
// has a clean seam.
//
// Storage shape: localStorage 'open-satchel:ribbon-tool-order' →
//   { [groupId]: string[] /* tool ids */ }
//
// Reconciliation (same idea as toolbarOrder.ts):
//   - On load, drop tool ids that aren't in the canonical default
//     for that group (likely removed in a later build).
//   - Append any newly-added tool ids the user hasn't positioned yet.
//   - If the persisted record is missing for a group, fall back to
//     the canonical default — no override surface.

const KEY = 'open-satchel:ribbon-tool-order'

/** Group id → canonical tool ids in default render order. Bake the
 *  current PdfToolbar groups in here as we migrate. Adding new
 *  groups is non-breaking; the persistence layer just starts
 *  tracking them on first reorder.
 *
 *  Ids match the values passed to ui.setTool in PdfToolbar.tsx
 *  exactly so a reorder operation produces a one-to-one mapping
 *  with no translation layer. */
export const DEFAULT_RIBBON_TOOL_ORDER: Record<string, string[]> = {
  // Highlight group from PdfToolbar.tsx (Annotate tab).
  highlight: ['highlight', 'highlight_area', 'underline', 'strikethrough'],
  // Shape tools (Annotate tab → Shapes group). PdfToolbar uses
  // shape_rect / shape_circle / shape_line / shape_arrow.
  shapes: ['shape_rect', 'shape_circle', 'shape_line', 'shape_arrow'],
  // Insert tab → Content group (Image + Sticky Note).
  insert_content: ['image', 'sticky_note'],
  // Fill & Sign Marks group (Text Comment / ✗ / ✓ / ◯).
  marks: ['textbox_note', 'fill_cross', 'fill_check', 'fill_circle'],
}

type Order = Record<string, string[]>

function readRaw(): Order {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const out: Order = {}
    for (const k of Object.keys(parsed)) {
      const arr = (parsed as Record<string, unknown>)[k]
      if (Array.isArray(arr) && arr.every((s) => typeof s === 'string')) {
        out[k] = arr
      }
    }
    return out
  } catch {
    return {}
  }
}

function writeRaw(order: Order): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(KEY, JSON.stringify(order))
  } catch {
    /* quota / private mode */
  }
}

/** Resolve the effective tool order for a group, applying the user's
 *  reorder + reconciling against the canonical default. Returns the
 *  default verbatim if no override is set. */
export function getOrderedToolIds(groupId: string): string[] {
  const defaults = DEFAULT_RIBBON_TOOL_ORDER[groupId]
  if (!defaults) return []
  const all = readRaw()
  const persisted = all[groupId]
  if (!persisted) return [...defaults]
  const known = new Set(defaults)
  // Drop any persisted ids that aren't in the canonical default
  // (likely removed across versions). De-dupe in case storage was
  // corrupted.
  const seen = new Set<string>()
  const valid: string[] = []
  for (const id of persisted) {
    if (known.has(id) && !seen.has(id)) {
      valid.push(id)
      seen.add(id)
    }
  }
  // Append any newly-added defaults the user hasn't positioned yet.
  for (const id of defaults) {
    if (!seen.has(id)) {
      valid.push(id)
      seen.add(id)
    }
  }
  return valid
}

/** Persist a new order for a group. The new order MUST be a permutation
 *  of the canonical defaults — extra ids are dropped, missing ids
 *  appended in canonical position. */
export function setOrderedToolIds(groupId: string, ids: string[]): void {
  const all = readRaw()
  const defaults = DEFAULT_RIBBON_TOOL_ORDER[groupId] ?? []
  const known = new Set(defaults)
  const seen = new Set<string>()
  const filtered: string[] = []
  for (const id of ids) {
    if (known.has(id) && !seen.has(id)) {
      filtered.push(id)
      seen.add(id)
    }
  }
  for (const id of defaults) {
    if (!seen.has(id)) {
      filtered.push(id)
      seen.add(id)
    }
  }
  all[groupId] = filtered
  writeRaw(all)
}

/** Reset a single group to canonical default — removes its entry
 *  from the persisted map. */
export function resetToolOrder(groupId: string): void {
  const all = readRaw()
  delete all[groupId]
  writeRaw(all)
}

/** Reset every group's tool order. */
export function resetAllToolOrders(): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* unavailable */
  }
}

/** Move tool at `from` to position `to` within a group's effective
 *  order, then persist. Convenience for drag-drop UIs. */
export function moveToolWithinGroup(groupId: string, from: number, to: number): string[] {
  const cur = getOrderedToolIds(groupId)
  if (from < 0 || from >= cur.length || to < 0 || to >= cur.length || from === to) {
    return cur
  }
  const next = cur.slice()
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  setOrderedToolIds(groupId, next)
  return next
}

/** True if the group has been customized (i.e., differs from the
 *  canonical default). UIs use this to show a "Reset to default"
 *  affordance. */
export function isGroupCustomized(groupId: string): boolean {
  const cur = getOrderedToolIds(groupId)
  const def = DEFAULT_RIBBON_TOOL_ORDER[groupId]
  if (!def) return false
  if (cur.length !== def.length) return true
  for (let i = 0; i < cur.length; i++) {
    if (cur[i] !== def[i]) return true
  }
  return false
}
