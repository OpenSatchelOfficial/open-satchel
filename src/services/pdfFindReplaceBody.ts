// Find / replace across BODY-text paragraphs.
//
// Complements pdfTextOps.replaceAcrossPages, which only touches Fabric
// overlay objects (Add Text, watermarks, sticky notes). This service
// clusters real PDF body text via pdfParagraphs.clusterParagraphs and
// emits ParagraphEdit entries that route through the engine bake +
// true-rewrite path — so the saved PDF carries the substituted text
// in the actual content stream and original formatting is preserved
// (the rewrite path keeps the original Tj operators' font + size).
//
// Two functions:
//   - findInBodyText(pdfDoc, pattern, opts)  → BodyMatch[]
//   - buildBodyReplaceEdits(pdfDoc, pattern, replacement, opts)
//       → Map<pageIndex, ParagraphEdit[]>
//
// Both clusterer-call once per page on demand (no state pollution in
// EditableParagraphLayer). The tradeoff: each invocation re-runs
// clustering for every page in the doc — fine for find/replace
// since the user explicitly triggers it.

import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { ParagraphEdit } from './pdfParagraphEdits'
import { clusterParagraphs, type ParagraphBox } from './pdfParagraphs'

export interface BodyFindOpts {
  caseSensitive?: boolean
  wholeWord?: boolean
  regex?: boolean
}

export interface BodyMatch {
  pageIndex: number
  paragraphId: string
  /** Raw paragraph text the match landed in. */
  paragraphText: string
  /** UTF-16 offset where the match starts within paragraphText. */
  start: number
  /** UTF-16 offset just past the end of the match. */
  end: number
  /** Matched substring. */
  match: string
}

/** Build a global RegExp from the search needle + flags. Identical
 *  semantics to pdfTextOps.buildPattern so the dialog can compose
 *  body + fabric counts without divergence. */
export function buildBodyPattern(needle: string, opts: BodyFindOpts): RegExp {
  let source = needle
  if (!opts.regex) source = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (opts.wholeWord) source = `\\b(?:${source})\\b`
  const flags = 'g' + (opts.caseSensitive ? '' : 'i')
  return new RegExp(source, flags)
}

/** Pure: scan a list of paragraphs (per page) and emit matches. Kept
 *  decoupled from pdfjs so unit tests can inject synthesized
 *  paragraphs and assert match positions. */
export function findInParagraphList(
  paragraphs: ParagraphBox[],
  pageIndex: number,
  pattern: RegExp,
): BodyMatch[] {
  const out: BodyMatch[] = []
  for (const p of paragraphs) {
    pattern.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = pattern.exec(p.originalText)) !== null) {
      out.push({
        pageIndex,
        paragraphId: p.id,
        paragraphText: p.originalText,
        start: m.index,
        end: m.index + m[0].length,
        match: m[0],
      })
      // Defend against zero-width regex (e.g. /^/g) — bump lastIndex
      // so we don't loop forever.
      if (m[0].length === 0) pattern.lastIndex += 1
    }
  }
  return out
}

/** Walk every page in the document, cluster paragraphs, scan for
 *  matches. Returns an in-order match list across pages.
 *
 *  Pages with zero text (image-only / scanned) yield zero matches.
 *  Use the EditableParagraphLayer's "Run OCR + edit" overlay first to
 *  surface text on those pages before find/replace will see them. */
export async function findInBodyText(
  pdfDoc: PDFDocumentProxy,
  needle: string,
  opts: BodyFindOpts = {},
): Promise<BodyMatch[]> {
  if (!needle) return []
  const pattern = buildBodyPattern(needle, opts)
  const out: BodyMatch[] = []
  const pageCount = pdfDoc.numPages
  for (let i = 0; i < pageCount; i++) {
    const { paragraphs } = await clusterParagraphs(pdfDoc, i)
    out.push(...findInParagraphList(paragraphs, i, pattern))
  }
  return out
}

/** Pure: from a paragraph list + matches, build the ParagraphEdit
 *  entries that route through the engine bake. Each edit replaces ALL
 *  matches inside a paragraph in one pass (so Replace All on a
 *  paragraph with N matches creates ONE edit, not N).
 *
 *  Style fields (color, fontFamily, bold, italic) are copied from
 *  the source paragraph so the engine's rewrite path picks the right
 *  font; backgroundColor is also preserved for the mask if the
 *  engine path falls through to overlay bake. */
export function buildBodyReplaceEditsFromParagraphs(
  paragraphs: ParagraphBox[],
  pattern: RegExp,
  replacement: string,
): ParagraphEdit[] {
  const out: ParagraphEdit[] = []
  for (const p of paragraphs) {
    pattern.lastIndex = 0
    if (!pattern.test(p.originalText)) continue
    pattern.lastIndex = 0
    const newText = p.originalText.replace(pattern, replacement)
    if (newText === p.originalText) continue
    out.push({
      paragraphId: p.id,
      bbox: { ...p.bbox },
      originalText: p.originalText,
      newText,
      fontSize: p.fontSize,
      color: p.color,
      backgroundColor: p.backgroundColor,
      fontFamily: p.fontFamily,
      bold: p.bold,
      italic: p.italic,
    })
  }
  return out
}

/** Walk every page, cluster, build replace edits per page. Returns
 *  Map<pageIndex, ParagraphEdit[]> — caller merges with the page's
 *  existing _paragraphEdits and triggers a save. */
export async function buildBodyReplaceEdits(
  pdfDoc: PDFDocumentProxy,
  needle: string,
  replacement: string,
  opts: BodyFindOpts = {},
): Promise<Map<number, ParagraphEdit[]>> {
  const out = new Map<number, ParagraphEdit[]>()
  if (!needle) return out
  const pattern = buildBodyPattern(needle, opts)
  const pageCount = pdfDoc.numPages
  for (let i = 0; i < pageCount; i++) {
    const { paragraphs } = await clusterParagraphs(pdfDoc, i)
    // Re-build pattern per page since /g state carries lastIndex
    // across uses — using a fresh RegExp avoids cross-page bleed.
    const perPagePattern = buildBodyPattern(needle, opts)
    const edits = buildBodyReplaceEditsFromParagraphs(
      paragraphs,
      perPagePattern,
      replacement,
    )
    if (edits.length > 0) out.set(i, edits)
  }
  return out
}

/** Count the total number of regex matches across an edit map. The
 *  bake pipeline doesn't return a per-paragraph match count, so we
 *  re-derive it from (originalText, newText) — caller-friendly for
 *  the dialog status line ("Replaced N occurrences"). */
export function countReplacementsInEdits(
  edits: Map<number, ParagraphEdit[]>,
  needle: string,
  opts: BodyFindOpts = {},
): number {
  if (!needle || edits.size === 0) return 0
  const pattern = buildBodyPattern(needle, opts)
  let total = 0
  for (const pageEdits of edits.values()) {
    for (const e of pageEdits) {
      pattern.lastIndex = 0
      const m = e.originalText.match(pattern)
      if (m) total += m.length
    }
  }
  return total
}
