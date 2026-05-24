// Ribbon tab order persistence.
// Stored as a JSON array of canonical tab names in localStorage so the
// PDF toolbar (and any future per-user pro-toolbar preferences) can
// honor the user's drag-sort preference across sessions.

const KEY = 'open-satchel:ribbon-tab-order'

export const DEFAULT_PDF_RIBBON_ORDER = [
  'Home', 'Insert', 'Annotate', 'Review',
  'FillSign', 'Protect', 'Pages', 'Tools', 'Batch',
] as const

export type PdfRibbonTab = typeof DEFAULT_PDF_RIBBON_ORDER[number]
const KNOWN = new Set<string>(DEFAULT_PDF_RIBBON_ORDER)

export function loadRibbonOrder(): PdfRibbonTab[] {
  if (typeof localStorage === 'undefined') return [...DEFAULT_PDF_RIBBON_ORDER]
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return [...DEFAULT_PDF_RIBBON_ORDER]
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return [...DEFAULT_PDF_RIBBON_ORDER]
    // Reconcile: drop unknowns (likely removed in a later build),
    // append any newly-added tabs the user hasn't positioned yet.
    const valid = parsed.filter((t) => KNOWN.has(t)) as PdfRibbonTab[]
    const missing = DEFAULT_PDF_RIBBON_ORDER.filter((t) => !valid.includes(t))
    return [...valid, ...missing]
  } catch {
    return [...DEFAULT_PDF_RIBBON_ORDER]
  }
}

export function saveRibbonOrder(order: PdfRibbonTab[]): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(KEY, JSON.stringify(order))
  } catch {
    /* quota exceeded or disabled — silent */
  }
}

export function resetRibbonOrder(): PdfRibbonTab[] {
  if (typeof localStorage !== 'undefined') {
    try { localStorage.removeItem(KEY) } catch { /* ignore */ }
  }
  return [...DEFAULT_PDF_RIBBON_ORDER]
}

/** Move item at `from` to position `to` and return a new array. */
export function reorder<T>(arr: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= arr.length || to >= arr.length) return arr
  const out = arr.slice()
  const [moved] = out.splice(from, 1)
  out.splice(to, 0, moved)
  return out
}
