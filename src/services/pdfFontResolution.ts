// Font resolution for PDF paragraph edits.
//
// When the user edits a paragraph, we want the re-drawn text to match
// the original font so the save output looks visually continuous. The
// original paragraph's font name is known (from pdfjs's styles map);
// this service takes that name + style flags and returns the actual
// font-file bytes from the user's system so pd-lib can embed them on
// save. Falls back silently when no match exists — save then uses the
// pd-lib Standard (Helvetica/Times/Courier) placeholder.
//
// Strategy — first slice of M2 font auto-import:
//   1. Cache the system font list once per session (listSystem is
//      walkdir + ttf-parser over the OS Fonts directory; ~100ms on a
//      typical machine, not worth re-querying per edit).
//   2. Match by family name first (normalized: lowercase, strip
//      spaces/hyphens), falling back to fuzzy substring when the
//      family names don't line up exactly (e.g. pdf says "HelveticaNeue"
//      and the system registers "Helvetica Neue").
//   3. Within a matching family, pick the style that best aligns with
//      the paragraph's bold/italic flags.
//   4. Cache loaded bytes per font id so saving a multi-edit page
//      doesn't re-read the same 1-MB .ttf from disk multiple times.
//
// Future slices will add:
//   - Extract fonts embedded IN the PDF (covers fonts the user doesn't
//     have installed), via a new Rust command that pulls /FontFile2
//     streams out of the PDF's Font dicts.
//   - Google Fonts auto-download for free-licensed families the system
//     lacks.
//   - fsType respect (TrueType OS/2 embedding flags) so we don't
//     re-embed fonts the vendor marked no-embedding.
//
// In browser mode, window.api.font.listSystem
// returns [] per the shim — resolveSystemFont always returns null and
// callers fall back cleanly. Tauri mode is where this has effect.

interface FontEntry {
  id: string
  name: string
  family: string
  style: string
}

export interface ResolvedFont {
  id: string
  family: string
  style: string
  bytes: Uint8Array
}

let systemListCache: Promise<FontEntry[]> | null = null
const bytesCache = new Map<string, Uint8Array>()

/** Reset caches — used by tests; production code only calls this once
 *  implicitly via first lookup. */
export function _resetFontResolutionCaches(): void {
  systemListCache = null
  bytesCache.clear()
}

async function getSystemFonts(): Promise<FontEntry[]> {
  if (!systemListCache) {
    systemListCache = window.api.font.listSystem().catch(() => [])
  }
  return systemListCache
}

/** Normalize family/style for matching: lowercase, strip whitespace and
 *  hyphens. This lets "Helvetica Neue", "HelveticaNeue", and
 *  "helvetica-neue" all resolve to the same key. */
function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '').replace(/[-_]/g, '')
}

/** Is this style string bold? */
function styleIsBold(style: string): boolean {
  const n = norm(style)
  return /bold|black|heavy|semibold|demibold/.test(n)
}

/** Is this style string italic/oblique? */
function styleIsItalic(style: string): boolean {
  const n = norm(style)
  return /italic|oblique/.test(n)
}

/** Score how well `entry.style` matches the requested bold/italic flags.
 *  Higher is better; we use this to pick between e.g. "Regular", "Light",
 *  "Bold" when the paragraph wants bold. */
function styleScore(entryStyle: string, wantBold: boolean, wantItalic: boolean): number {
  const eBold = styleIsBold(entryStyle)
  const eItalic = styleIsItalic(entryStyle)
  let score = 0
  score += eBold === wantBold ? 2 : 0
  score += eItalic === wantItalic ? 2 : 0
  // Penalty for being further from "Regular" when nothing is requested —
  // picks plain over Light/Thin/Condensed.
  if (!wantBold && !wantItalic) {
    const n = norm(entryStyle)
    if (n === 'regular' || n === 'book' || n === 'roman' || n === '') score += 1
    if (/(light|thin|condensed|narrow|extra|ultra|black)/.test(n) && !eBold) score -= 1
  }
  return score
}

/** Extract the first family name from a font-family CSS-style string.
 *  pdfjs fontFamily looks like `'Helvetica', -apple-system, ...`. */
function primaryFamily(family: string): string {
  if (!family) return ''
  const first = family.split(',')[0]?.trim() ?? ''
  return first.replace(/^['"]/, '').replace(/['"]$/, '')
}

async function loadBytes(f: FontEntry): Promise<ResolvedFont | null> {
  let bytes = bytesCache.get(f.id)
  if (!bytes) {
    try {
      bytes = await window.api.font.getBytes(f.id)
    } catch {
      return null
    }
    if (!bytes || bytes.byteLength === 0) return null
    bytesCache.set(f.id, bytes)
  }
  return { id: f.id, family: f.family, style: f.style, bytes }
}

/**
 * Resolve a PDF paragraph's font description to an installed system font
 * file. Returns null when no reasonable match exists — caller should
 * fall back to a pd-lib Standard font.
 */
export async function resolveSystemFont(
  family: string,
  bold: boolean,
  italic: boolean,
): Promise<ResolvedFont | null> {
  const primary = primaryFamily(family)
  if (!primary) return null

  const fonts = await getSystemFonts()
  if (fonts.length === 0) return null

  const target = norm(primary)

  // Collect every system font whose family matches the target name.
  // Exact family match first, then fuzzy substring in either direction
  // (covers "HelveticaNeue" vs "Helvetica Neue", "TimesNewRoman" vs
  // "Times New Roman", etc.).
  let matches: FontEntry[] = fonts.filter((f) => norm(f.family) === target)
  if (matches.length === 0) {
    matches = fonts.filter((f) => {
      const fn = norm(f.family)
      return fn.includes(target) || target.includes(fn)
    })
  }
  if (matches.length === 0) return null

  // Within the matches, pick the best style.
  let best: FontEntry | null = null
  let bestScore = -Infinity
  for (const m of matches) {
    const score = styleScore(m.style, bold, italic)
    if (score > bestScore) {
      bestScore = score
      best = m
    }
  }
  if (!best) return null

  return loadBytes(best)
}
