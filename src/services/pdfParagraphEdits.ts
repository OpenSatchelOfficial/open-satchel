// Apply paragraph-level text edits to PDF bytes on save.
//
// Architecture: EditableParagraphLayer (UI) stores edits of the form
//   { paragraphId, bbox, originalText, newText, fontSize, fontName }
// per page, in `_paragraphEdits` on PdfPageState. This service consumes
// those edits and produces new PDF bytes.
//
// Strategy (matches Acrobat's block-level repaint):
//   1. Draw a white rectangle covering the paragraph bbox — obliterates
//      the original glyphs in the saved PDF, regardless of font encoding.
//   2. Draw the new text inside the rect using a system-available
//      fallback font (Helvetica by default; user-configurable in M2+).
//      We manually wrap lines to fit the original bbox width, preserving
//      the original layout as closely as a fallback font allows.
//
// Trade-offs:
//   - Simpler than in-place content-stream rewriting and not dependent on
//     the original font being present.
//   - Substituted text won't match original font metrics exactly (same
//     complaint Acrobat users have with its fallback to Minion Pro).
//   - For paragraphs where the original font is available (M2 font
//     import), we skip the whiteout and use the real embedded font.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import {
  parseContentStream,
  applyTextReplacement,
  getPageContentLayout,
  patchPageContentStreams,
  encodeTextToBytes,
} from './contentStreamParser'
import { resolveSystemFont } from './pdfFontResolution'

export type TextAlign = 'left' | 'center' | 'right' | 'justify'

export interface ParagraphEdit {
  paragraphId: string
  /** Paragraph bbox in pdfjs viewport coords (top-left origin, scale=1). */
  bbox: { x: number; y: number; width: number; height: number }
  originalText: string
  newText: string
  /** Font size from the original paragraph (PDF user-space units). */
  fontSize: number
  /** Text color hex (sampled from canvas — white on dark bg, black on light). */
  color?: string
  /** Background color hex (sampled from canvas — used for the "whiteout"
   *  rect which is actually whatever-color-the-background-is to blend in). */
  backgroundColor?: string
  /** Resolved CSS font family from the original paragraph's pdfjs
   *  styles map (e.g. "'Helvetica', -apple-system, ..."). Used by the
   *  save pipeline to look up a matching installed system font for
   *  re-embedding; null/missing → Helvetica Standard fallback. */
  fontFamily?: string
  /** True when the original paragraph was bold/heading; save picks a
   *  bold variant of the fallback font to preserve visual weight. */
  bold?: boolean
  /** True when the original paragraph was italic. */
  italic?: boolean
  /** Alignment within the paragraph bbox. Default 'left'. 'justify' spreads
   *  intra-word space to fill the line width (last line left-aligned). */
  align?: TextAlign
  /** Line spacing multiplier (browser-style). 1.0 = baseline-touching,
   *  1.2 = default body-text leading, 1.5 / 2.0 = wide. The bake path
   *  multiplies fontSize × lineHeight to derive the TL (text-leading)
   *  emit between baked lines. Undefined → engine default 1.2. */
  lineHeight?: number
  /** pdfjs TextLayer indices of every item that belongs to this paragraph. */
  itemIndices?: number[]
  /** Original text for each item — same length as itemIndices. */
  itemOriginalTexts?: string[]
  /** User-dragged displacement from the original bbox, in viewport
   *  (scale=1) coordinates. Only the draw position moves; blanking and
   *  masking still happen at the original bbox so ghost text is removed
   *  from the spot it started, and the new text appears wherever the user
   *  dropped it. dy is positive-down (viewport convention); save converts
   *  to PDF user-space. */
  positionDelta?: { dx: number; dy: number }
  /** True when the user changed any style field (fontSize, color,
   *  fontFamily, bold, italic, align) vs the paragraph's original
   *  pdfjs-detected values. Forces the save pipeline to overlay bake
   *  instead of text rewrite — the rewrite path only modifies Tj
   *  operands, it doesn't re-emit Tf / rg / Tm, so style changes would
   *  be silently dropped without this flag. */
  styleChanged?: boolean
  /** G2: opaque key into [`EngineEditModel.embeddedFonts`]. Set when
   *  the paragraph uses a non-Standard-14 family AND the resolver
   *  found a system font for it. The bake stage looks up the matching
   *  payload + embeds the font as /FontFile2 + emits text as 2-byte
   *  CIDs under Identity-H. Missing → bake falls through to Standard 14
   *  (visible substitution, but the document still saves cleanly). */
  customFontId?: string
}

export interface ApplyParagraphOptions {
  /** Fallback system font for substitution when the original isn't available. */
  fallbackFont?: keyof typeof StandardFonts
  /**
   * Optional pdfjs document for the content-stream rewrite + whiteout
   * fallback path. When provided, we ask applyTextEditsToBytes to blank
   * the original content-stream ops before we draw the replacement, so
   * pdfjs can't extract ghost text on subsequent edits.
   */
  pdfjsDoc?: PDFDocumentProxy | null
}

function hexToRgb01(hex: string | undefined): { r: number; g: number; b: number } {
  if (!hex || !hex.startsWith('#') || (hex.length !== 7 && hex.length !== 4)) {
    return { r: 0, g: 0, b: 0 }
  }
  let h = hex.slice(1)
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  return {
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255,
  }
}

/** Break text into lines that fit within maxWidth when rendered in `font` at `size`. */
function wrapLines(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  // Preserve explicit newlines; wrap each paragraph-line separately.
  const paragraphs = text.split('\n')
  const out: string[] = []
  for (const para of paragraphs) {
    if (para.length === 0) {
      out.push('')
      continue
    }
    const words = para.split(/(\s+)/) // keep whitespace groups for round-trip spacing
    let current = ''
    for (const w of words) {
      const candidate = current + w
      const width = font.widthOfTextAtSize(candidate, size)
      if (width <= maxWidth || current.length === 0) {
        current = candidate
      } else {
        out.push(current.trimEnd())
        current = w.trimStart()
      }
    }
    if (current.length > 0) out.push(current)
  }
  return out
}

export async function applyParagraphEditsToBytes(
  pdfBytes: Uint8Array,
  pageIndex: number,
  edits: ParagraphEdit[],
  options: ApplyParagraphOptions = {},
): Promise<Uint8Array> {
  if (edits.length === 0) return pdfBytes

  // Phase 1: blank the original text by POSITION, SURGICALLY.
  //
  // We parse the content stream, find each text run whose (x, y) falls
  // inside a paragraph's bbox, and replace JUST that Tj / TJ operator's
  // bytes with an empty string. The rest of the stream — filled
  // rectangles, ExtGState references, other text runs, every byte — is
  // preserved verbatim. The Contents array structure is kept intact
  // too: each affected sub-stream is rewritten in place, the array of
  // sub-stream refs is untouched.
  //
  // History of this code path:
  //   1. First attempt — index-based blanking via pdfjs spanIndex →
  //      parser textRun index. Unreliable because pdfjs emits synthetic
  //      whitespace items the parser doesn't see; the indices diverge
  //      and we'd blank the wrong run.
  //   2. Position-based blanking + replacePageContents. Fixed the
  //      indexing problem AND the stacked-ghost "Statement Receipt"
  //      bug (pd-lib appends new sub-streams to Contents on each save;
  //      writePageContentBytes only wrote to the first, letting later
  //      entries survive blanking). But the flatten-into-single-stream
  //      approach broke rendering of filled rectangles that sat under
  //      edited text (FINDINGS.md #2 — editing "Segment" on the navy
  //      table-header row caused the navy bar to render as a tiny
  //      fragment). The exact mechanism is ambiguous — byte-identical
  //      content in both master and edited — but the restructure is
  //      the only variable.
  //   3. (this version) Surgical byte-patch via patchPageContentStreams.
  //      Changes only the bytes that belong to the blanked operators.
  //      Preserves every other op verbatim AND the Contents array
  //      layout, so pd-lib's subsequent append-on-draw doesn't
  //      interact with a restructured page. This matches how Acrobat
  //      and WPS structure edits: incremental updates on top of an
  //      otherwise byte-for-byte original.
  let workingBytes = pdfBytes
  {
    const prebBlankDoc = await PDFDocument.load(workingBytes)
    const prebBlankPage = prebBlankDoc.getPage(pageIndex)
    const { height: pageH } = prebBlankPage.getSize()
    const layout = getPageContentLayout(prebBlankDoc, pageIndex)
    if (layout) {
      const parsed = parseContentStream(layout.bytes)
      for (const edit of edits) {
        // Convert viewport-top-left bbox → PDF user-space Y range.
        const padY = Math.max(3, edit.fontSize * 0.25)
        const padX = Math.max(2, edit.fontSize * 0.15)
        const xMin = edit.bbox.x - padX
        const xMax = edit.bbox.x + edit.bbox.width + padX
        const yMinPdf = pageH - (edit.bbox.y + edit.bbox.height) - padY
        const yMaxPdf = pageH - edit.bbox.y + padY
        for (const run of parsed.textRuns) {
          if (run.x >= xMin && run.x <= xMax && run.y >= yMinPdf && run.y <= yMaxPdf) {
            applyTextReplacement(parsed, run.opIndex, encodeTextToBytes(''), run.tjElementIndex)
          }
        }
      }
      // Collect all ops that were tagged __modified and express them as
      // byte-range patches on the concatenated content view.
      const patches: Array<{ start: number; end: number; replacement: Uint8Array }> = []
      for (const op of parsed.operators) {
        if (op.operator === '__modified') {
          patches.push({
            start: op.byteOffset,
            end: op.byteOffset + op.byteLength,
            replacement: op.args[0] as Uint8Array,
          })
        }
      }
      if (patches.length > 0) {
        patchPageContentStreams(layout, patches)
        workingBytes = new Uint8Array(await prebBlankDoc.save())
      }
    }
  }

  const doc = await PDFDocument.load(workingBytes)
  // pd-lib needs fontkit to embed non-Standard (TrueType/OpenType) fonts.
  // Registering is cheap and safe to call unconditionally; if fontkit
  // itself fails to init (rare; happens on very old bundlers) we catch
  // and the resolveSystemFont path returns null → Standard fallback.
  try {
    doc.registerFontkit(fontkit as unknown as Parameters<typeof doc.registerFontkit>[0])
  } catch {
    /* noop — fallback path handles missing fontkit */
  }
  const pdfPage = doc.getPage(pageIndex)
  const { height: pageHeight } = pdfPage.getSize()

  const fallbackName = options.fallbackFont ?? 'Helvetica'
  // Pre-embed all four Standard-font style variants as a GUARANTEED
  // fallback. Only the variants actually referenced get serialized
  // (pdf-lib lazy-writes). System-font resolution below may supersede
  // these per-edit when a matching family is installed.
  const fontStandardPlain = await doc.embedFont(StandardFonts[fallbackName])
  const fontStandardBold = await doc.embedFont(
    fallbackName === 'Helvetica' ? StandardFonts.HelveticaBold
      : fallbackName === 'TimesRoman' ? StandardFonts.TimesRomanBold
      : StandardFonts.CourierBold,
  )
  const fontStandardItalic = await doc.embedFont(
    fallbackName === 'Helvetica' ? StandardFonts.HelveticaOblique
      : fallbackName === 'TimesRoman' ? StandardFonts.TimesRomanItalic
      : StandardFonts.CourierOblique,
  )
  const fontStandardBoldItalic = await doc.embedFont(
    fallbackName === 'Helvetica' ? StandardFonts.HelveticaBoldOblique
      : fallbackName === 'TimesRoman' ? StandardFonts.TimesRomanBoldItalic
      : StandardFonts.CourierBoldOblique,
  )
  const pickStandard = (bold: boolean, italic: boolean): PDFFont => {
    if (bold && italic) return fontStandardBoldItalic
    if (bold) return fontStandardBold
    if (italic) return fontStandardItalic
    return fontStandardPlain
  }

  // Per-save cache of embedded system fonts, keyed by resolver id. A
  // page with many paragraphs that share a family only embeds bytes
  // once, and pd-lib's embedFont is ~20 KB of work per call so this
  // matters for multi-hundred-paragraph pages.
  const systemFontCache = new Map<string, PDFFont>()

  // Pre-pass: union the new text across edits that will resolve to the
  // same font id, so we can subset that font ONCE against the full set
  // of codepoints its edits need. Without this, caching a first-edit
  // subset would drop glyphs needed by later edits using the same font.
  const textPerFontId = new Map<string, string>()
  for (const e of edits) {
    const fam = e.fontFamily
    if (!fam) continue
    try {
      const r = await resolveSystemFont(fam, !!e.bold, !!e.italic)
      if (!r) continue
      textPerFontId.set(r.id, (textPerFontId.get(r.id) ?? '') + e.newText)
    } catch { /* resolve failure handled later in pickFontFor */ }
  }

  const pickFontFor = async (edit: ParagraphEdit): Promise<PDFFont> => {
    // Resolve the original paragraph's font family against the user's
    // installed fonts. The paragraph stores its fontFamily as a CSS
    // stack ("'Helvetica', -apple-system, ..."); pdfFontResolution
    // picks off the primary name and matches by family + style.
    const family = edit.fontFamily
    if (!family) return pickStandard(!!edit.bold, !!edit.italic)
    try {
      const resolved = await resolveSystemFont(family, !!edit.bold, !!edit.italic)
      if (!resolved) return pickStandard(!!edit.bold, !!edit.italic)
      const cached = systemFontCache.get(resolved.id)
      if (cached) return cached

      // CRITICAL: pre-subset via Rust harfbuzz_rs-equivalent (Typst's
      // pure-Rust subsetter) before handing bytes to pd-lib. pd-lib's
      // own `subset:true` path drops glyphs from CJK cmaps and mangles
      // GSUB/GPOS for Arabic — ROADMAP M3.5 documents the failure
      // mode. Pre-subsetting produces a small font with only the
      // glyphs this save actually uses; we then embed with subset:false
      // so pd-lib treats the already-subsetted bytes as a complete
      // font. Net: a CJK single-char edit drops from ~11 MB embed to
      // typically <100 KB.
      let bytesForEmbed = resolved.bytes
      const unionText = textPerFontId.get(resolved.id) ?? edit.newText
      if (unionText && window.api?.font?.subsetBytes) {
        try {
          const shrunk = await window.api.font.subsetBytes(resolved.bytes, unionText)
          // Guard against the subsetter returning something nonsensical
          // (empty or larger than the original) — fall back to the
          // full bytes in that case so we never ship a broken font.
          if (shrunk && shrunk.byteLength > 0 && shrunk.byteLength < resolved.bytes.byteLength) {
            bytesForEmbed = shrunk
          }
        } catch {
          // Subsetter can't handle every TTF/OTF; full embed as fallback.
        }
      }

      const embedded = await doc.embedFont(bytesForEmbed, { subset: false })
      systemFontCache.set(resolved.id, embedded)
      return embedded
    } catch {
      // Any failure (font file corrupt, fontkit doesn't like it) →
      // Standard fallback. Better to render SOMETHING legible than
      // to crash the save.
      return pickStandard(!!edit.bold, !!edit.italic)
    }
  }

  for (const edit of edits) {
    // Convert viewport top-left origin → pdf user-space bottom-left origin.
    const origPdfY = pageHeight - edit.bbox.y - edit.bbox.height
    const { x: origX, width, height } = edit.bbox

    // Draw a MASK rectangle over the paragraph in the detected
    // BACKGROUND color. On the dark invoice header this draws a dark
    // rect (invisible against the black bar); on white body paragraphs
    // it draws a white rect (invisible against the page).
    //
    // This sidesteps the content-stream blanking's index-mismatch bug
    // (pdfjs emits synthetic space items that the parser doesn't see,
    // so spanIndex → textRun index mapping is unreliable in practice
    // — blanking the wrong run leaves the original "Invoice" text
    // alive in the content stream and you get "InvoiceINV 2026" after
    // save). By painting the exact bg color over the bbox, we fully
    // mask the original glyphs regardless of how the content stream
    // is structured, without any visible rect.
    //
    // The mask ALWAYS paints at the ORIGINAL bbox — that's where the
    // glyphs still live after content-stream blanking does its best
    // effort. If the paragraph was user-dragged, the text is drawn at
    // the new position further down; no second mask is needed because
    // we want the underlying page to show through there.
    const bg = hexToRgb01(edit.backgroundColor ?? '#ffffff')
    // Pad generously — pdfjs's item.width is the advance width and
    // doesn't cover all glyph bearings. 25% of fontSize vertically +
    // 25% of width horizontally covers metric differences and any
    // overhangs.
    // Keep padding modest on the right so the mask doesn't bleed into
    // neighbouring paragraphs (e.g. "Invoice" title and "Date:" column
    // sit very close horizontally). Clustering already trims trailing
    // whitespace from the bbox's right edge, so the bbox itself is
    // accurate; these are just antialiasing + metric-mismatch buffers.
    const padY = Math.max(3, edit.fontSize * 0.25)
    const padX = Math.max(2, edit.fontSize * 0.15)
    const widthBuffer = Math.min(edit.fontSize * 0.3, 6)
    pdfPage.drawRectangle({
      x: origX - padX,
      y: origPdfY - padY,
      width: width + padX * 2 + widthBuffer,
      height: height + padY * 2,
      color: rgb(bg.r, bg.g, bg.b),
      opacity: 1,
    })

    // Apply the user-dragged offset for text drawing only. dx is the
    // horizontal delta in viewport units (same as bbox.x); dy is
    // positive-down in viewport space, but PDF y is positive-up, so we
    // subtract when converting.
    const dx = edit.positionDelta?.dx ?? 0
    const dy = edit.positionDelta?.dy ?? 0
    const drawX = origX + dx
    const drawPdfY = origPdfY - dy

    // 2. Draw new text at the (possibly dragged) position.
    if (edit.newText.trim()) {
      const color = hexToRgb01(edit.color)
      const size = Math.max(6, Math.min(edit.fontSize, 72))
      const lineHeight = size * 1.2
      const font = await pickFontFor(edit)
      const lines = wrapLines(edit.newText, font, size, width)
      const align: TextAlign = edit.align ?? 'left'

      // Compute per-line x offset for the chosen alignment. For justify
      // we widen intra-word spaces on all lines except the last (Word-
      // style). pdf-lib doesn't expose a native align prop across all
      // versions, so we do the geometry ourselves using widthOfTextAtSize.
      //
      // We do NOT clip at the original bbox bottom. Acrobat and WPS both
      // let a paragraph's content grow downward when the replacement is
      // longer than the original (the box visually expands to fit).
      // Earlier revisions broke out of the draw loop the moment
      // baselineY dropped below drawPdfY, which silently dropped any
      // wrapped lines past the first — e.g. "Q4 2026 EARNINGS REPORT"
      // became "Q1 2027 EARNINGS" because the 2nd line "REPORT" lived
      // below the original ~31pt title bbox. That was test fail #1 in
      // scripts/FINDINGS.md.
      let baselineY = drawPdfY + height - size
      for (let li = 0; li < lines.length; li++) {
        const line = lines[li]

        if (align === 'justify' && li < lines.length - 1 && line.includes(' ')) {
          // Widen inter-word spaces to fill the full width.
          const words = line.split(' ')
          const wordsWidth = words.reduce(
            (acc, w) => acc + font.widthOfTextAtSize(w, size),
            0,
          )
          const gaps = words.length - 1
          const spaceW = (width - wordsWidth) / gaps
          let cx = drawX
          for (let w = 0; w < words.length; w++) {
            pdfPage.drawText(words[w], {
              x: cx, y: baselineY, size, font,
              color: rgb(color.r, color.g, color.b),
            })
            cx += font.widthOfTextAtSize(words[w], size) + (w < gaps ? spaceW : 0)
          }
        } else {
          const lineWidth = font.widthOfTextAtSize(line, size)
          const lineX =
            align === 'right' ? drawX + (width - lineWidth)
            : align === 'center' ? drawX + (width - lineWidth) / 2
            : drawX // left (and justify last line)
          pdfPage.drawText(line, {
            x: lineX,
            y: baselineY,
            size,
            font,
            color: rgb(color.r, color.g, color.b),
          })
        }
        baselineY -= lineHeight
      }
    }
  }

  const out = await doc.save()
  return new Uint8Array(out)
}

/** Convenience: apply paragraph edits across all pages in one pass. */
export async function applyAllParagraphEdits(
  pdfBytes: Uint8Array,
  editsByPage: Map<number, ParagraphEdit[]>,
  options: ApplyParagraphOptions = {},
): Promise<Uint8Array> {
  let working = pdfBytes
  for (const [pageIndex, edits] of editsByPage) {
    if (edits.length === 0) continue
    working = await applyParagraphEditsToBytes(working, pageIndex, edits, options)
  }
  return working
}

// (intentionally unused import to keep PDFPage in scope for future helpers
// that operate on a loaded page directly)
void (null as unknown as PDFPage)
