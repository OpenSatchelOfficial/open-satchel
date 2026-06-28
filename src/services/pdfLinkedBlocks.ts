// Linked paragraph blocks — InDesign-style chained text frames.
//
// Two or more paragraph bboxes "link" into a chain. When the user
// types more text than fits in the first frame, the overflow flows
// into the second, then the third, etc. If the chain runs out of
// space, the trailing words simply get dropped from the visible
// flow (they're preserved in `chain.text` so a later resize / new
// frame restores them).
//
// PARITY.md flags this as the Foxit-killer differentiator — Foxit
// + Acrobat both don't have it, but it's table stakes in InDesign /
// Affinity Publisher / QuarkXPress. Worth shipping even before the
// UX is polished because the engine seam is the gate.
//
// Architecture:
//   1. Pure flow algorithm (this file) takes the chain definition
//      + a text-measurement function + the full text payload, and
//      returns per-frame text segments.
//   2. expandChainToEdits() converts the flow result into a list
//      of ParagraphEdit entries the bake stage already understands
//      (one edit per frame, newText = the segment that landed there).
//   3. The bake stage just sees normal paragraph edits — no engine
//      changes needed. Reflow on resize / text change re-runs the
//      flow algorithm + emits fresh edits.
//
// The measurement function is injected so tests can use a simple
// monospace estimate; production callers route through the
// harfbuzz subsetter's `measure_text` IPC for true font metrics.

import type { ParagraphEdit } from './pdfParagraphEdits'

export interface LinkedFrame {
  /** Stable id from the source paragraph cluster. Used as the
   *  paragraphId for the per-frame ParagraphEdit emitted at save. */
  paragraphId: string
  /** Bbox in viewport (scale=1) coords, top-left origin. */
  bbox: { x: number; y: number; width: number; height: number }
  /** Page index this frame lives on. */
  pageIndex: number
  /** Style fields preserved per-frame so the bake emits with
   *  matching font/color. All optional — undefined → bake default. */
  fontSize?: number
  fontFamily?: string
  bold?: boolean
  italic?: boolean
  color?: string
  backgroundColor?: string
}

export interface LinkedChain {
  /** Stable id for this chain (uuid or counter). */
  id: string
  /** Frames in flow order. Text fills the first, overflow flows
   *  into the next, etc. */
  frames: LinkedFrame[]
  /** The full text payload for this chain. */
  text: string
}

/** Text-measurement signature. Production callers wrap the harfbuzz
 *  subsetter's measure-text IPC; tests pass a simple monospace
 *  estimate. Returns the rendered width in viewport units. */
export type MeasureTextWidth = (
  text: string,
  fontSize: number,
  fontFamily?: string,
) => number

export interface FrameSegment {
  paragraphId: string
  /** The text that fits in this frame after flow. May be empty if
   *  earlier frames consumed all of `chain.text`. */
  text: string
  /** True iff text was truncated at this frame because the chain
   *  ran out of subsequent frames. The trailing characters are
   *  available on `chain.text` for later restoration. */
  overflow: boolean
}

/** Flow result + the overflow that did NOT fit any frame. Session 6
 *  (epic deliverable 3): the trailing characters past the last frame
 *  used to vanish silently — `flowTextThroughChain` only set an
 *  `overflow` flag nobody read. This report surfaces the dropped text
 *  so the save path can record a `linked.overflow_dropped` degradation
 *  (fidelity) instead of losing characters quietly. */
export interface FlowReport {
  segments: FrameSegment[]
  /** Verbatim text that overflowed the last frame (whitespace
   *  preserved — the flow splits on `/(\s+)/` keeping separators, so
   *  joining the remainder reconstructs the original tail exactly).
   *  Empty string when everything fit. */
  droppedText: string
}

/** Flow text through a chain, splitting at word boundaries.
 *
 *  Returns one segment per frame in the chain. If the text fits in
 *  fewer frames than the chain has, trailing frames get empty
 *  segments. If it doesn't fit even in the last frame, the last
 *  segment carries `overflow: true` and the trailing words are
 *  silently dropped from the flow (they remain on `chain.text`).
 *
 *  Word-wrap algorithm: greedy word-by-word — pull words from the
 *  remaining text, accumulate into the current line until the
 *  measured width exceeds frame.bbox.width. New line starts.
 *  When we run out of vertical space (line count × line height >
 *  frame.bbox.height), the remaining text spills to the next frame.
 *
 *  Line height is derived as fontSize × 1.2 (browser-default
 *  leading). Customizable per-frame via fontSize.
 */
export function flowTextThroughChain(
  chain: LinkedChain,
  measure: MeasureTextWidth,
): FrameSegment[] {
  return flowTextThroughChainWithReport(chain, measure).segments
}

/** Same flow algorithm as {@link flowTextThroughChain}, but also
 *  returns the overflow text that did not fit any frame so the caller
 *  can record a degradation instead of dropping characters silently
 *  (Session 6, epic deliverable 3). */
export function flowTextThroughChainWithReport(
  chain: LinkedChain,
  measure: MeasureTextWidth,
): FlowReport {
  const remaining: string[] = chain.text.split(/(\s+)/) // keep whitespace
  const segments: FrameSegment[] = []
  let cursor = 0

  for (let i = 0; i < chain.frames.length; i++) {
    const frame = chain.frames[i]
    const fontSize = frame.fontSize ?? 12
    const lineHeight = fontSize * 1.2
    const maxLines = Math.max(1, Math.floor(frame.bbox.height / lineHeight))
    const maxWidth = frame.bbox.width

    const lines: string[] = []
    let currentLine = ''

    while (cursor < remaining.length && lines.length < maxLines) {
      const next = remaining[cursor]
      const candidate = currentLine + next
      // Newlines force a line break unconditionally.
      if (next.includes('\n')) {
        // Push everything before the newline to the current line.
        const parts = next.split('\n')
        currentLine += parts[0]
        lines.push(currentLine.trimEnd())
        for (let p = 1; p < parts.length - 1; p++) {
          if (lines.length >= maxLines) break
          lines.push(parts[p])
        }
        currentLine = parts[parts.length - 1]
        cursor++
        continue
      }
      const width = measure(candidate, fontSize, frame.fontFamily)
      if (width <= maxWidth || currentLine.length === 0) {
        currentLine = candidate
        cursor++
      } else {
        lines.push(currentLine.trimEnd())
        currentLine = ''
      }
    }
    if (currentLine.length > 0 && lines.length < maxLines) {
      lines.push(currentLine.trimEnd())
      currentLine = ''
    } else if (currentLine.length > 0) {
      // Remaining content at end of frame goes back into remaining
      // for the next frame's flow.
      remaining.splice(cursor, 0, currentLine)
      currentLine = ''
    }

    segments.push({
      paragraphId: frame.paragraphId,
      text: lines.join('\n'),
      overflow: false,
    })
  }

  // If the loop exited with text left over and we used the last
  // frame, mark its segment as overflow AND surface the dropped tail.
  // Whitespace is preserved by the split, so joining the remainder
  // reconstructs the original overflow text verbatim.
  let droppedText = ''
  if (cursor < remaining.length && segments.length > 0) {
    const last = segments[segments.length - 1]
    last.overflow = true
    droppedText = remaining.slice(cursor).join('')
  }

  return { segments, droppedText }
}

/** Convert a flowed chain into ParagraphEdit entries the bake
 *  stage consumes. Each frame becomes one edit per page, with the
 *  flowed segment as `newText`.
 *
 *  Skipping: a frame whose flowed text equals an empty string
 *  becomes a deletion edit (newText='') so the bake masks the
 *  original glyphs at that bbox — keeps the frame visually clean
 *  rather than leaving stale text behind from before the flow.
 */
export function expandChainToEdits(
  chain: LinkedChain,
  segments: FrameSegment[],
  originalTextByParagraphId: Map<string, string>,
): Map<number, ParagraphEdit[]> {
  const out = new Map<number, ParagraphEdit[]>()
  for (let i = 0; i < chain.frames.length; i++) {
    const frame = chain.frames[i]
    const seg = segments[i]
    if (!seg) continue
    const original = originalTextByParagraphId.get(frame.paragraphId) ?? ''
    const edit: ParagraphEdit = {
      paragraphId: frame.paragraphId,
      bbox: { ...frame.bbox },
      originalText: original,
      newText: seg.text,
      fontSize: frame.fontSize ?? 12,
      color: frame.color,
      backgroundColor: frame.backgroundColor,
      fontFamily: frame.fontFamily,
      bold: frame.bold,
      italic: frame.italic,
    }
    const arr = out.get(frame.pageIndex) ?? []
    arr.push(edit)
    out.set(frame.pageIndex, arr)
  }
  return out
}

/** Built-in monospace measurement — width = char count × fontSize ×
 *  factor. Tests use this; production substitutes the harfbuzz
 *  subsetter via window.api.font.measureText(...). */
export function monospaceMeasure(
  text: string,
  fontSize: number,
  _fontFamily?: string,
): number {
  // Helvetica's average width is ~0.5em; monospace estimate is
  // close enough for test fixtures.
  return text.length * fontSize * 0.5
}
