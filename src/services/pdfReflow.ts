// S2 — Cross-page paragraph reflow.
//
// When a paragraph is deleted (a ParagraphEdit with empty `newText`),
// the paragraphs visually below it should slide up to fill the gap —
// otherwise the saved PDF has an empty hole where the deleted block
// was. The engine handles per-paragraph mask + text emission cleanly,
// but it can only act on what's in the EditModel: paragraphs the user
// hasn't touched aren't there.
//
// This module synthesizes the missing entries. Given the full
// paragraph layout per page (from the editor's clusterer) and the
// user's edits, it returns an enriched edit map where every paragraph
// downstream of a deletion carries a `positionDelta` shifting it up
// by the freed height. The engine then re-emits each shifted
// paragraph with the same text + a vertical translation; the original
// glyphs are masked at their unmoved location, so the visual effect
// is "block slides up."
//
// **Single-page**: shift later paragraphs on the SAME page only.
// Handles the 90% case where a body paragraph mid-document is deleted.
//
// **Cross-page**: when the deletion frees enough room that one
// or more later same-page paragraphs would no longer fit on the page
// after the shift, those paragraphs shift up freely (the engine will
// draw them where instructed; bottom-of-page underflow is fine — pdfs
// don't enforce content stay-inside-mediabox). The first paragraph on
// the NEXT page is also shifted up by the leftover delta, with the
// expectation that whoever extends this can chain the shift through
// subsequent pages by walking edges. The engine doesn't need to know
// about cross-page semantics: a positionDelta with negative dy on the
// page-1 paragraph just shifts its draw position upward, which still
// renders within the page-1 mediabox so long as the paragraph's
// original bbox + delta lands inside.

import type { ParagraphEdit, TextAlign } from './pdfParagraphEdits'

/** Lightweight subset of a paragraph cluster — only what reflow needs. */
export interface ReflowParagraph {
  paragraphId: string
  bbox: { x: number; y: number; width: number; height: number }
  originalText: string
  fontSize: number
  fontFamily?: string
  bold?: boolean
  italic?: boolean
  align?: TextAlign
  color?: string
  backgroundColor?: string
}

/** What the editor passes us per page: ALL paragraphs in reading
 *  order (top-down, left-to-right within a column), NOT just the
 *  edited ones. */
export type ParagraphsByPage = Map<number, ReflowParagraph[]>

/** What the editor passes us per page: only the user's edits. */
export type EditsByPage = Map<number, ParagraphEdit[]>

/**
 * Detect deleted paragraphs (edits with `newText` empty AND
 * `originalText` non-empty) and synthesize shift-up entries for the
 * paragraphs that should fill the gap.
 *
 * Pure function — caller merges the result with their existing edits
 * before sending to bake.
 *
 * **Returns** an enriched copy of `editsByPage`. Existing edits are
 * preserved verbatim; new "shift" entries are appended for paragraphs
 * not already in `editsByPage`. If a paragraph is BOTH already edited
 * (e.g. user changed its color) AND should shift, the existing edit
 * gets a merged positionDelta and the second pass leaves the rest
 * intact.
 *
 * @param paragraphsByPage  All paragraphs per page (top-down sorted).
 * @param editsByPage       The user's existing edits.
 * @param opts.crossPageSpill  When true, leftover delta from the last
 *   shifted paragraph on a page also shifts the first paragraph of
 *   the next page. Default `true`.
 */
export function computeReflowDeltas(
  paragraphsByPage: ParagraphsByPage,
  editsByPage: EditsByPage,
  opts: { crossPageSpill?: boolean } = {},
): EditsByPage {
  const crossPageSpill = opts.crossPageSpill ?? true
  const result: EditsByPage = new Map()
  for (const [pageIndex, edits] of editsByPage) {
    result.set(pageIndex, edits.map(cloneEdit))
  }
  for (const [pageIndex, paragraphs] of paragraphsByPage) {
    if (!result.has(pageIndex)) result.set(pageIndex, [])
  }

  // Carry from cross-page: when the last reflow on page N still has
  // a non-zero shift unaccounted for (because deletions exceeded the
  // sum of subsequent paragraphs' available space), apply that shift
  // to the first paragraph of page N+1.
  let crossPageCarry = 0

  // Iterate pages in ascending order so cross-page carry flows
  // forward correctly.
  const sortedPageIndices = [...paragraphsByPage.keys()].sort((a, b) => a - b)

  for (const pageIndex of sortedPageIndices) {
    const paragraphs = paragraphsByPage.get(pageIndex) ?? []
    const edits = result.get(pageIndex) ?? []

    // Sort paragraphs top-down (smaller y = nearer top in viewport).
    const sorted = [...paragraphs].sort((a, b) => a.bbox.y - b.bbox.y)

    // Index for fast lookup: paragraphId → ParagraphEdit, on this page.
    const editsByParaId = new Map<string, ParagraphEdit>()
    for (const e of edits) editsByParaId.set(e.paragraphId, e)

    // Compute cumulative shift as we walk top→bottom. Each deleted
    // paragraph adds its (height + leading) to the running shift; each
    // surviving later paragraph receives the current cumulative shift.
    let cumulativeShift = crossPageCarry
    crossPageCarry = 0

    for (let i = 0; i < sorted.length; i++) {
      const para = sorted[i]
      const existingEdit = editsByParaId.get(para.paragraphId)

      // Detection: deletion = existing edit with empty new_text +
      // non-empty original_text. (Edits with non-empty new_text don't
      // free space — they replace text in-place.)
      const isDeletion =
        existingEdit !== undefined &&
        existingEdit.newText === '' &&
        existingEdit.originalText !== ''

      if (isDeletion) {
        // Compute freed height: prefer the gap to the next paragraph
        // (that's the actual visual space that disappears), fall back
        // to bbox.height + leading when there's no next paragraph.
        const next = sorted[i + 1]
        const freed = next
          ? next.bbox.y - para.bbox.y
          : para.bbox.height + para.fontSize * 0.2
        cumulativeShift += freed
        continue
      }

      // No shift accumulated → paragraph stays put, no synthesis needed.
      if (cumulativeShift <= 0.001) continue

      // Apply shift. Viewport y is positive-down; "shift up" means
      // the new viewport y is smaller. The pdfParagraphEdits
      // positionDelta convention is: dy is positive-down in viewport
      // space, so a shift-up is a NEGATIVE dy.
      const shiftDy = -cumulativeShift

      if (existingEdit) {
        // Merge into existing edit.
        const prevDx = existingEdit.positionDelta?.dx ?? 0
        const prevDy = existingEdit.positionDelta?.dy ?? 0
        existingEdit.positionDelta = { dx: prevDx, dy: prevDy + shiftDy }
      } else {
        // Synthesize a shift-only edit. newText === originalText so
        // the engine re-draws the same text at the new location.
        // The mask still covers the original location.
        edits.push(synthesizeShiftEdit(para, shiftDy))
      }
    }

    // Page-end: if cumulativeShift > 0 and we're allowed to spill,
    // remember it for the next page's first paragraph.
    if (crossPageSpill && cumulativeShift > 0.001) {
      crossPageCarry = cumulativeShift
    }
  }

  return result
}

function cloneEdit(e: ParagraphEdit): ParagraphEdit {
  return {
    ...e,
    bbox: { ...e.bbox },
    positionDelta: e.positionDelta ? { ...e.positionDelta } : undefined,
  }
}

function synthesizeShiftEdit(
  para: ReflowParagraph,
  shiftDy: number,
): ParagraphEdit {
  return {
    paragraphId: para.paragraphId,
    bbox: { ...para.bbox },
    originalText: para.originalText,
    newText: para.originalText,
    fontSize: para.fontSize,
    fontFamily: para.fontFamily,
    bold: para.bold,
    italic: para.italic,
    align: para.align,
    color: para.color,
    backgroundColor: para.backgroundColor,
    positionDelta: { dx: 0, dy: shiftDy },
  }
}
