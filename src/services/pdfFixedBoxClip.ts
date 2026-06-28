import type { ParagraphEdit } from './pdfParagraphEdits'
import type { SaveDegradationCollector } from './saveDegradations'

/** Whitespace-stripped length — the clip re-wraps text (inserting/removing
 *  soft newlines), so raw length diffs are noisy. Comparing the visible
 *  character count is the faithful "did content get dropped" signal. */
function visibleLen(s: string): number {
  return s.replace(/\s+/g, '').length
}

interface ClipOptions {
  text: string
  width: number
  height: number
  fontSize: number
  fontFamily?: string
  bold?: boolean
  italic?: boolean
  lineHeight?: number
}

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function estimateTextWidth(text: string, fontSize: number): number {
  let units = 0
  for (const ch of text) {
    if (ch === ' ') units += 0.28
    else if (/[ilI.,'|]/.test(ch)) units += 0.24
    else if (/[mwMW@#%&]/.test(ch)) units += 0.86
    else if (/[A-Z0-9]/.test(ch)) units += 0.62
    else units += 0.52
  }
  return units * fontSize
}

function browserTextWidth(text: string, opts: ClipOptions): number | null {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const style = opts.italic ? 'italic ' : ''
  const weight = opts.bold ? '700 ' : '400 '
  const family = opts.fontFamily?.trim() || 'Helvetica, Arial, sans-serif'
  ctx.font = `${style}${weight}${Math.max(1, opts.fontSize)}px ${family}`
  return ctx.measureText(text).width
}

function textWidth(text: string, opts: ClipOptions): number {
  return browserTextWidth(text, opts) ?? estimateTextWidth(text, opts.fontSize)
}

function maxVisibleLines(opts: ClipOptions): number {
  const lineHeight = Math.max(1, opts.fontSize * (opts.lineHeight ?? 1.2))
  const tolerance = Math.max(1, opts.fontSize * 0.15)
  return Math.max(1, Math.floor((opts.height + tolerance) / lineHeight))
}

function pushIfRoom(lines: string[], line: string, limit: number): boolean {
  if (lines.length >= limit) return false
  lines.push(line.replace(/\s+$/g, ''))
  return lines.length < limit
}

function splitTokenToFit(token: string, opts: ClipOptions, lines: string[], limit: number): string {
  let chunk = ''
  for (const ch of token) {
    const candidate = chunk + ch
    if (candidate && textWidth(candidate, opts) <= opts.width + 0.5) {
      chunk = candidate
      continue
    }
    if (chunk && !pushIfRoom(lines, chunk, limit)) return ''
    chunk = textWidth(ch, opts) <= opts.width + 0.5 ? ch : ''
  }
  return chunk
}

export function clipTextToFixedBox(opts: ClipOptions): string {
  const normalized = normalizeText(opts.text)
  if (!normalized || opts.width <= 0 || opts.height <= 0 || opts.fontSize <= 0) {
    return normalized
  }

  const limit = maxVisibleLines(opts)
  const lines: string[] = []
  for (const rawLine of normalized.split('\n')) {
    if (lines.length >= limit) break
    let line = ''
    const tokens = rawLine.match(/\S+|\s+/g) ?? ['']
    for (const token of tokens) {
      if (lines.length >= limit) break
      const candidate = line + token
      if (textWidth(candidate, opts) <= opts.width + 0.5) {
        line = candidate
        continue
      }
      if (line.trim().length > 0) {
        if (!pushIfRoom(lines, line, limit)) {
          line = ''
          break
        }
        line = ''
      }
      if (token.trim().length === 0) continue
      if (textWidth(token, opts) <= opts.width + 0.5) {
        line = token
      } else {
        line = splitTokenToFit(token, opts, lines, limit)
      }
    }
    if (lines.length >= limit) break
    if (!pushIfRoom(lines, line, limit)) break
  }
  return lines.join('\n')
}

function clipEdit(
  edit: ParagraphEdit,
  pageIndex: number,
  collector?: SaveDegradationCollector,
): ParagraphEdit {
  if (!edit.clipToBbox || !edit.newText) return { ...edit }
  // A hard newline is explicit user content, not soft overflow. Do not
  // silently rewrite "A\nB" to just the visible first line during save.
  if (normalizeText(edit.newText).includes('\n')) return { ...edit }
  const clipped = clipTextToFixedBox({
    text: edit.newText,
    width: edit.bbox.width,
    height: edit.bbox.height,
    fontSize: edit.fontSize,
    fontFamily: edit.fontFamily,
    bold: edit.bold,
    italic: edit.italic,
    lineHeight: edit.lineHeight,
  })
  // Gauntlet finding (Game F): when the edited text OVERFLOWS the fixed box
  // (clipToBbox is set from elementHasOverflow at commit time, with
  // auto-layout OFF), the overflow is clipped away here. That used to be
  // SILENT — a user who typed more text than the box holds got the extra
  // text dropped from the saved file with no signal, violating the core
  // "report every degradation" rule. Record it: the clip is still applied
  // (fixed-box layout is preserved by design when auto-layout is off), but
  // the content loss is now LOUD. Turning auto-layout on reflows instead of
  // clipping (clipToBbox is dropped upstream in that mode).
  const droppedChars = visibleLen(edit.newText) - visibleLen(clipped)
  if (droppedChars > 0) {
    collector?.record({
      area: 'text.clipped_to_fixed_box',
      detail:
        `edited text overflowed its fixed paragraph box and ${droppedChars} character(s) ` +
        `were clipped from the saved file (kept '${clipped.slice(0, 40)}…'). Turn on ` +
        `"Auto layout text edits" to reflow instead of clipping, or enlarge the box.`,
      severity: 'fidelity',
      pageIndex,
      paragraphId: edit.paragraphId,
    })
  }
  return { ...edit, newText: clipped }
}

export function clipParagraphEditsForFixedBoxes(
  editsByPage: Map<number, ParagraphEdit[]>,
  collector?: SaveDegradationCollector,
): Map<number, ParagraphEdit[]> {
  return new Map(
    Array.from(editsByPage, ([pageIndex, edits]) => [
      pageIndex,
      edits.map((edit) => clipEdit(edit, pageIndex, collector)),
    ]),
  )
}

export function hasFixedBoxClipEdits(editsByPage: Map<number, ParagraphEdit[]>): boolean {
  for (const edits of editsByPage.values()) {
    if (edits.some((edit) => edit.clipToBbox === true)) return true
  }
  return false
}
