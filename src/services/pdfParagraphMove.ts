// A2 — Cross-page paragraph drag-reorder.
//
// Users drag a paragraph from one page onto another. We capture the
// move as a `ParagraphMove` and at save time expand it into two
// ParagraphEdit entries:
//   - Source-page edit: bbox = sourceBbox, originalText = the moved
//     text, newText = "" → engine paints a mask over the original
//     glyphs. This is a fixed delete; moves do not opt into automatic
//     gap-closing reflow.
//   - Destination-page edit: bbox = toBbox, originalText = (empty —
//     no Tj at this position), newText = moved text → engine's
//     true-rewrite path can't find a Tj to surgically replace, so it
//     falls back to overlay bake which paints mask + draws text.
//     That's the right behavior: a paragraph appearing at a new
//     location IS a freshly-drawn block.
//
// Path 1 from the parity prompt: copy + delete. Bigger output (one
// new overlay stream per destination page) but spec-compliant and
// doesn't require cross-page indirection in the content stream.
// Path 2 (cross-page indirection via shared stream) is smaller but
// less standard and offers no user-visible advantage; deferred.

import type { ParagraphEdit, StyledRun } from './pdfParagraphEdits'

export interface ParagraphMove {
  /** Stable id from the source paragraph cluster, used to mask the
   *  source text at save time. */
  paragraphId: string
  /** 0-based page index the paragraph originated on. */
  fromPage: number
  /** 0-based page index the paragraph is being moved to. May equal
   *  fromPage for an in-page reposition (the engine handles that
   *  path via positionDelta on the standard ParagraphEdit). For
   *  cross-page moves fromPage !== toPage. */
  toPage: number
  /** Bbox of the paragraph at its ORIGINAL location, in viewport
   *  (scale=1) coords. Used to mask the source glyphs. */
  fromBbox: { x: number; y: number; width: number; height: number }
  /** Bbox where the paragraph should land on toPage, in viewport
   *  (scale=1) coords. */
  toBbox: { x: number; y: number; width: number; height: number }
  /** The original text content. Captured at drag-start so the move
   *  is independent of any subsequent re-cluster of the source page. */
  text: string
  /** Original style fields, preserved on the destination edit so the
   *  bake path emits with the same font/color/etc. */
  fontSize: number
  fontFamily?: string
  bold?: boolean
  italic?: boolean
  color?: string
  backgroundColor?: string
  runs?: StyledRun[]
}

/** Expand a list of ParagraphMove into two ParagraphEdit entries
 *  per move (source mask + destination draw), keyed by page index.
 *
 *  Pure function — no PDF I/O. The bake stage consumes the result
 *  the same way it consumes any other ParagraphEdit map.
 *
 *  In-page moves (fromPage === toPage) are short-circuited into a
 *  single positionDelta-bearing edit so we don't double-mask.
 */
export function expandMovesToEdits(
  moves: ParagraphMove[],
): Map<number, ParagraphEdit[]> {
  const out = new Map<number, ParagraphEdit[]>()
  const push = (page: number, edit: ParagraphEdit) => {
    const arr = out.get(page) ?? []
    arr.push(edit)
    out.set(page, arr)
  }
  for (const m of moves) {
    if (m.fromPage === m.toPage) {
      // Same-page reposition: one edit with positionDelta. Mask
      // stays at fromBbox (original glyph location); text draws at
      // toBbox.
      const dx = m.toBbox.x - m.fromBbox.x
      const dy = m.toBbox.y - m.fromBbox.y
      push(m.fromPage, {
        paragraphId: m.paragraphId,
        bbox: { ...m.fromBbox },
        originalText: m.text,
        newText: m.text,
        fontSize: m.fontSize,
        color: m.color,
        backgroundColor: m.backgroundColor,
        fontFamily: m.fontFamily,
        bold: m.bold,
        italic: m.italic,
        ...(m.runs ? { runs: m.runs, requiresOverlay: true, styleChanged: true } : {}),
        positionDelta: { dx, dy },
      })
      continue
    }
    // Cross-page: emit (a) source mask, (b) destination draw.
    push(m.fromPage, {
      paragraphId: m.paragraphId,
      bbox: { ...m.fromBbox },
      originalText: m.text,
      newText: '', // mask only, no text drawn
      fontSize: m.fontSize,
      color: m.color,
      backgroundColor: m.backgroundColor,
      fontFamily: m.fontFamily,
      bold: m.bold,
      italic: m.italic,
    })
    // Suffix the dest paragraphId so it's distinct from the source
    // (which still exists in the cluster on the source page until
    // the next re-cluster sees the masked-out content). Avoids
    // accidental same-id collisions when pdfReflow looks up edits.
    push(m.toPage, {
      paragraphId: `${m.paragraphId}__moved`,
      bbox: { ...m.toBbox },
      originalText: '', // nothing here originally → engine overlay-bakes
      newText: m.text,
      fontSize: m.fontSize,
      color: m.color,
      backgroundColor: m.backgroundColor,
      fontFamily: m.fontFamily,
      bold: m.bold,
      italic: m.italic,
      ...(m.runs ? { runs: m.runs, requiresOverlay: true, styleChanged: true } : {}),
    })
  }
  return out
}

/** Merge expanded move edits with any existing per-page edits so the
 *  bake pipeline gets a single union map. Existing edits on a
 *  paragraph the move references win (user's last action takes
 *  priority); other existing edits are kept verbatim.
 */
export function mergeMoveEditsWithExisting(
  existing: Map<number, ParagraphEdit[]>,
  moveEdits: Map<number, ParagraphEdit[]>,
): Map<number, ParagraphEdit[]> {
  const out = new Map<number, ParagraphEdit[]>()
  for (const [page, edits] of existing) out.set(page, edits.map((e) => ({ ...e })))
  for (const [page, edits] of moveEdits) {
    const cur = out.get(page) ?? []
    const existingIds = new Set(cur.map((e) => e.paragraphId))
    const additions = edits.filter((e) => !existingIds.has(e.paragraphId))
    out.set(page, [...cur, ...additions])
  }
  return out
}
