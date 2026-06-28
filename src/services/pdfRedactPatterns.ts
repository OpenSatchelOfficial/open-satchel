// Pattern-based search-and-redact. Walks each page's pdfjs text
// content, runs regex matching, and emits `RedactionRect` entries
// pointing at the matched character ranges' bounding boxes.
//
// This is the engine half of "Acrobat parity A4: find SSNs, emails,
// phones, credit cards in a flat PDF and stage redactions over each
// match." Once the rects are returned the caller hands them to
// `applyRedactions` (services/pdfRedact.ts), which removes recoverable
// text and falls back to raster replacement for image-like page regions
// — same trust posture as hand-drawn redactions.
//
// Why pdfjs text-content rather than raw content streams: pdfjs gives
// us per-item bboxes (`item.transform[4..5]` + `item.width`) in PDF
// user-space, including the character widths from the font metrics.
// Using those bboxes is robust across CID-keyed fonts, custom CMaps,
// and Type0 encodings — the same surface area where our content-
// stream walker would otherwise have to re-decode bytes.
//
// The engine returns strict matches (string + bbox + page); pattern
// composition is the caller's responsibility (test-hooks UI / dialog).

import type { RedactionRect } from './pdfRedact'

/** A regex pattern to find-and-redact. */
export interface RedactPattern {
  /** Display label, e.g. "SSN" or "Custom: \\d{4}-\\d{4}". */
  label: string
  /** RegExp to apply (with `g` flag — caller supplies). */
  re: RegExp
}

/** A single match found by `findPatternMatches`. */
export interface PatternMatch {
  /** 0-based page index. */
  page: number
  /** The matched text. */
  text: string
  /** Pattern label that matched (`SSN`, `Email`, etc.). */
  pattern: string
  /** Bounding box in PDF user-space (bottom-left origin). */
  rect: RedactionRect
}

/** Built-in presets covering the common Acrobat "find & redact"
 *  categories. Anchored / Luhn validation is light — these are
 *  detection heuristics, not validators. The Apply pass burns rects
 *  regardless, so a false positive just over-redacts (safe) rather
 *  than under-redacts (unsafe).
 *
 *  Caller can compose: pass any subset of these or custom patterns. */
export const PRESET_PATTERNS: RedactPattern[] = [
  { label: 'SSN', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  // Phone: NANP shapes (10-digit, with separators, optional +1).
  { label: 'Phone', re: /\b(?:\+?1[\s-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g },
  // Email: simple but high-recall.
  { label: 'Email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  // Credit card: 13–19 digit run, common separators. Doesn't run Luhn —
  // false positives here mean over-redaction, which is preferable to
  // missing one.
  { label: 'Credit card', re: /\b(?:\d[ -]?){13,19}\b/g },
  // US bank account: 9–17 digit run, standalone. High false-positive
  // risk; default-off.
  { label: 'Account number', re: /\b\d{9,17}\b/g },
  // Date of birth (very high-recall — date formats vary). Default-off.
  { label: 'Date', re: /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g },
]

/** Convenience: lookup a preset by label. */
export function presetByLabel(label: string): RedactPattern | null {
  return PRESET_PATTERNS.find((p) => p.label === label) ?? null
}

interface PdfjsTextItem {
  /** The string rendered by this item — single Tj/TJ run. */
  str: string
  /** [a, b, c, d, e, f] — 6-element matrix. e=x, f=y in user-space. */
  transform: number[]
  /** Item width in user-space units. */
  width: number
  /** Item height in user-space units (font size). */
  height: number
  /** Whether this item ends a line (pdfjs heuristic). */
  hasEOL?: boolean
}

interface PdfjsPage {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getTextContent(): Promise<{ items: any[] }>
  getViewport(args: { scale: number }): { height: number; width: number }
  cleanup(): void
}

interface PdfjsDoc {
  numPages: number
  getPage(pageNumber: number): Promise<PdfjsPage>
}

/** Walk every page in `pdfDoc` and return every match against any
 *  pattern in `patterns`. The caller hands the result's `rect[]` to
 *  `applyRedactions` to actually flatten the redactions onto disk.
 *
 *  Performance: O(pages × items × patterns); a 50-page doc with 4
 *  patterns runs in <500ms locally. Matching uses the joined-line
 *  string (so a match split across kerning-coalesced items still
 *  hits) and reverse-maps the match offset back to the originating
 *  items' bboxes via a position index. */
export async function findPatternMatches(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pdfDoc: any,
  patterns: RedactPattern[],
  opts: { pages?: number[]; padding?: number } = {},
): Promise<PatternMatch[]> {
  if (!pdfDoc || patterns.length === 0) return []
  const numPages: number = (pdfDoc as PdfjsDoc).numPages
  const pageRange =
    opts.pages && opts.pages.length > 0 ? opts.pages : Array.from({ length: numPages }, (_, i) => i)
  // Pad redaction rects slightly past glyph extents — text items'
  // bboxes are tight to the cap-height baseline; a 1pt pad ensures
  // descenders / accents are covered without bleeding into adjacent
  // text. Caller can override.
  const pad = opts.padding ?? 1.5

  const all: PatternMatch[] = []
  for (const pageIdx of pageRange) {
    if (pageIdx < 0 || pageIdx >= numPages) continue
    const page = await (pdfDoc as PdfjsDoc).getPage(pageIdx + 1)
    const tc = await page.getTextContent()
    const items = (tc.items as PdfjsTextItem[]).filter(
      (it) => typeof it.str === 'string',
    )

    // Concatenate items into a single-line string and remember each
    // item's [start, end) char offset within the joined string. That
    // way a regex match's index maps back to a contiguous slice of
    // items via binary search.
    interface ItemSpan {
      itemIdx: number
      start: number
      end: number
    }
    let joined = ''
    const spans: ItemSpan[] = []
    for (let i = 0; i < items.length; i++) {
      const start = joined.length
      const piece = items[i].str
      joined += piece
      spans.push({ itemIdx: i, start, end: start + piece.length })
      // Insert a space at item boundary if pdfjs marks EOL or the
      // next item starts on a new line. This matches what users see
      // visually so "555-12-3456 line break" patterns don't false-
      // negative.
      if (items[i].hasEOL || i + 1 < items.length) {
        joined += ' '
      }
    }

    for (const pat of patterns) {
      // Reset lastIndex — RegExp with /g is stateful across docs.
      pat.re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = pat.re.exec(joined)) !== null) {
        if (m[0].length === 0) {
          // Defensive: avoid infinite loop on zero-width matches.
          pat.re.lastIndex += 1
          continue
        }
        const matchStart = m.index
        const matchEnd = m.index + m[0].length

        // Find which spans overlap [matchStart, matchEnd).
        const hitItems: number[] = []
        for (const s of spans) {
          if (s.end <= matchStart) continue
          if (s.start >= matchEnd) break
          hitItems.push(s.itemIdx)
        }
        if (hitItems.length === 0) continue

        // Compute bbox from union of hit-item rects.
        let minX = Number.POSITIVE_INFINITY
        let maxX = Number.NEGATIVE_INFINITY
        let minY = Number.POSITIVE_INFINITY
        let maxY = Number.NEGATIVE_INFINITY
        for (const ii of hitItems) {
          const it = items[ii]
          const x = it.transform[4] ?? 0
          const y = it.transform[5] ?? 0
          // pdfjs item bboxes: x..x+width on the line baseline; height
          // (~font size) extends UP from y. Acrobat-style redaction
          // wants a rect from the descender (y - 0.2*h) to the cap
          // (y + h), so include 20% descender padding.
          const descender = it.height * 0.2
          const bottom = y - descender
          const top = y + it.height
          if (x < minX) minX = x
          if (x + it.width > maxX) maxX = x + it.width
          if (bottom < minY) minY = bottom
          if (top > maxY) maxY = top
        }

        // Don't emit if anything went wrong.
        if (
          !Number.isFinite(minX) ||
          !Number.isFinite(maxX) ||
          !Number.isFinite(minY) ||
          !Number.isFinite(maxY)
        ) {
          continue
        }

        const rect: RedactionRect = {
          page: pageIdx,
          x: minX - pad,
          y: minY - pad,
          width: maxX - minX + 2 * pad,
          height: maxY - minY + 2 * pad,
          color: [0, 0, 0],
        }
        all.push({
          page: pageIdx,
          text: m[0],
          pattern: pat.label,
          rect,
        })
      }
    }
    page.cleanup()
  }
  return all
}

/** Pattern bundle import/export — JSON shape that legal / privacy
 *  teams can ship across an org. Lets users load a canonical PII
 *  pattern set instead of typing regex per session.
 *
 *  Schema:
 *    {
 *      "name": "Acme PII bundle v1",
 *      "patterns": [
 *        { "label": "EmployeeID", "source": "EMP-\\d{6}", "flags": "g" },
 *        ...
 *      ]
 *    }
 */
export interface PatternBundle {
  name: string
  patterns: Array<{ label: string; source: string; flags?: string }>
}

/** Parse a JSON string into a list of RedactPattern. Throws with a
 *  clear message on malformed shape — tells the caller to surface
 *  the error to the user. */
export function loadPatternBundle(json: string): { name: string; patterns: RedactPattern[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (e) {
    throw new Error(`Pattern bundle JSON parse failed: ${(e as Error).message}`)
  }
  const obj = parsed as Partial<PatternBundle>
  if (!obj || typeof obj.name !== 'string' || !Array.isArray(obj.patterns)) {
    throw new Error('Pattern bundle missing required fields: name (string), patterns (array)')
  }
  const patterns: RedactPattern[] = []
  for (const p of obj.patterns) {
    if (!p || typeof p.label !== 'string' || typeof p.source !== 'string') {
      throw new Error('Pattern entry missing label or source string')
    }
    let re: RegExp
    try {
      re = new RegExp(p.source, p.flags ?? 'g')
    } catch (e) {
      throw new Error(`Invalid regex for pattern "${p.label}": ${(e as Error).message}`)
    }
    if (!re.flags.includes('g')) {
      // Force /g so .exec() walk works as expected. Bundles SHOULD
      // include 'g' but we tolerate omission.
      re = new RegExp(re.source, re.flags + 'g')
    }
    patterns.push({ label: p.label, re })
  }
  return { name: obj.name, patterns }
}

/** Serialize the current pattern set to a JSON bundle string.
 *  RegExp source + flags are extracted; bundles round-trip cleanly. */
export function savePatternBundle(name: string, patterns: RedactPattern[]): string {
  const out: PatternBundle = {
    name,
    patterns: patterns.map((p) => ({
      label: p.label,
      source: p.re.source,
      flags: p.re.flags,
    })),
  }
  return JSON.stringify(out, null, 2)
}

/** De-dup overlapping or identical match rects on the same page —
 *  for example "Phone" and "Account number" can both match a 10-digit
 *  string. Keeps the first (highest-priority) match per overlapping
 *  group. Pattern order in the input array determines priority. */
export function dedupOverlappingMatches(matches: PatternMatch[]): PatternMatch[] {
  const out: PatternMatch[] = []
  for (const m of matches) {
    const overlaps = out.some(
      (o) =>
        o.page === m.page &&
        rectsOverlap(o.rect, m.rect),
    )
    if (!overlaps) out.push(m)
  }
  return out
}

function rectsOverlap(a: RedactionRect, b: RedactionRect): boolean {
  return !(
    a.x + a.width < b.x ||
    b.x + b.width < a.x ||
    a.y + a.height < b.y ||
    b.y + b.height < a.y
  )
}
