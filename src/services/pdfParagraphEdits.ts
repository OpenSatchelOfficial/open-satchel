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
import { primaryFamily, resolveSystemFont } from './pdfFontResolution'
import type { PdfLayoutRole } from './pdfLayoutIntelligence'
import { substitutionDetail } from './saveDegradations'
import type { SaveDegradationCollector } from './saveDegradations'

export type TextAlign = 'left' | 'center' | 'right' | 'justify'

/** One run of character-level-uniform text inside a paragraph. Used for
 *  Acrobat-style per-selection formatting: a box can hold several runs
 *  with different bold/italic/underline/strike/color/size, and only the
 *  selected run(s) change when the user clicks Bold etc. Any omitted
 *  field falls back to the paragraph default (the flat fields on
 *  ParagraphEdit). Font family / alignment / line-spacing are NOT
 *  per-run — they stay paragraph-level. */
export interface StyledRun {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strikethrough?: boolean
  /** Text color hex; falls back to the edit's `color`. */
  color?: string
  /** Font size in pt; falls back to the edit's `fontSize`. */
  fontSize?: number
}

export interface ParagraphEdit {
  paragraphId: string
  /** Paragraph bbox in pdfjs viewport coords (top-left origin, scale=1). */
  bbox: { x: number; y: number; width: number; height: number }
  /** Optional bbox used only for removing/masking the original glyphs.
   *  Style auto-grow and user resizing can make `bbox` larger so the
   *  replacement text has room to draw, but the source whiteout must stay
   *  on the original glyph bounds or it can erase neighboring paragraphs. */
  maskBbox?: { x: number; y: number; width: number; height: number }
  /** Runtime marker for Add Text boxes created by the paragraph editor.
   *  These start with no source PDF glyphs, so save draws only the new
   *  text and never treats the box as an original paragraph to erase. */
  isNewTextBox?: boolean
  /** True when this edit should draw replacement text without masking
   *  source content. Used by Add Text boxes, which are overlays rather
   *  than edits of an existing PDF text run. */
  skipSourceMask?: boolean
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
  /** Draw an underline decoration under each emitted replacement line. */
  underline?: boolean
  /** Draw a strikethrough decoration through each emitted replacement line. */
  strikethrough?: boolean
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
  /** Paragraph delete/reflow policy. Undefined/default is `fixed`,
   *  matching Acrobat-style text-box edits: blank or redraw this
   *  paragraph in place without moving neighboring page content.
   *  `flow` is reserved for explicit "delete and close gap" body-text
   *  commands; `linked` is for chain layout that manages its own flow. */
  flowBehavior?: 'fixed' | 'flow' | 'linked'
  /** Layout intelligence snapshot from the paragraph clusterer. Save-time
   *  reflow treats `layoutSafeForAutoReflow === false` as a hard stop. */
  layoutRole?: PdfLayoutRole
  layoutSafeForAutoReflow?: boolean
  layoutFlowId?: string
  layoutReasons?: string[]
  /** Session 5 (R5a): the clusterer's DETECTED alignment for the source
   *  paragraph. 'left' means positively classified left; undefined means
   *  the edit never saw layout metadata (the save seam then enriches it
   *  or records layout.enrichment_unavailable). Distinct from `align`,
   *  which is the alignment the DRAW uses (user-chosen, or attached by
   *  the save seam when it routes/preserves detected alignment). */
  layoutDetectedAlign?: TextAlign
  /** §5b: mirrors PdfParagraphLayout.weakCenterEvidence — the source
   *  paragraph is a lone display line that LOOKS visually centered but
   *  the detector had no confident claim (layoutDetectedAlign undefined).
   *  A width-changing edit on such a paragraph (in a display-line role)
   *  records layout.alignment_weak_evidence instead of shipping a broken
   *  center silently. undefined = no weak hint (the common case). */
  layoutWeakCenterEvidence?: boolean
  /** Session 5 (R5b): mirrors ParagraphBox.fontFamilyIsGenericFallback —
   *  the source paragraph's font is embedded but its family name is
   *  unrecoverable, so `fontFamily` is a generic fallback stack, NOT a
   *  faithful Standard-14 alias. The overlay font resolution records
   *  the substitution loudly for these. false = positively known
   *  recovered/unembedded; undefined = unknown (enrichment fills it). */
  fontFamilyIsGenericFallback?: boolean
  /** User-visible post-save note when auto-layout was requested but
   *  blocked for a complex/ambiguous layout region. */
  layoutWarning?: string
  /** True when the live editor detected hidden overflow in the fixed
   *  paragraph box. Save clips the replacement text to the visible
   *  box so reopening does not recluster a huge off-box paragraph. */
  clipToBbox?: boolean
  /** True when the user changed any style field (fontSize, color,
   *  fontFamily, bold, italic, align) vs the paragraph's original
   *  pdfjs-detected values. Rewrite-safe style changes such as font
   *  size and fill color are handled by the true text rewrite path;
   *  layout/font-resource changes may still require overlay bake. */
  styleChanged?: boolean
  /** True when a style/layout edit needs a fresh draw path because it
   *  cannot be expressed by rewriting the existing text run in place. */
  requiresOverlay?: boolean
  /** G2: opaque key into [`EngineEditModel.embeddedFonts`]. Set when
   *  the paragraph uses a non-Standard-14 family AND the resolver
   *  found a system font for it. The bake stage looks up the matching
   *  payload + embeds the font as /FontFile2 + emits text as 2-byte
   *  CIDs under Identity-H. Missing → bake falls through to Standard 14
   *  (visible substitution, but the document still saves cleanly). */
  customFontId?: string
  /** Rich-text character runs. When present and *mixed*, this is the
   *  source of truth for the paragraph's content + per-run character
   *  styling, and `newText` mirrors `runs.map(r => r.text).join('')`.
   *  A mixed-run paragraph always saves via the overlay path (the true
   *  in-place rewrite can't express more than one style per run). When
   *  absent or uniform, the flat fields above drive rendering exactly as
   *  before. */
  runs?: StyledRun[]
}

/** Concatenated text of a run list — kept in sync with `edit.newText`. */
export function concatRuns(runs: StyledRun[]): string {
  return runs.map((r) => r.text).join('')
}

/** Resolve a run's effective style against the paragraph defaults, as a
 *  comparison key. Two runs with the same key render identically. */
function runStyleKey(run: StyledRun, edit: ParagraphEdit): string {
  return [
    run.bold ?? edit.bold ?? false,
    run.italic ?? edit.italic ?? false,
    run.underline ?? edit.underline ?? false,
    run.strikethrough ?? edit.strikethrough ?? false,
    (run.color ?? edit.color ?? '').toLowerCase(),
    run.fontSize ?? edit.fontSize ?? 0,
  ].join('|')
}

/** True when the edit carries 2+ runs that don't all share one effective
 *  style — i.e. genuine per-selection formatting. */
export function paragraphHasMixedRuns(edit: ParagraphEdit): boolean {
  const runs = edit.runs
  if (!runs || runs.length <= 1) return false
  const first = runStyleKey(runs[0], edit)
  return runs.some((r) => runStyleKey(r, edit) !== first)
}

/** True when the edit carries any explicit per-run character styling. Used
 *  to (a) treat the change as meaningful (it lives in `runs`, not the flat
 *  fields) and (b) force the overlay save path — the in-place rewrite can't
 *  express more than one style per run, and even uniform run styling lands
 *  on overlay exactly like whole-box bold/italic already does. */
export function editCarriesRunStyling(edit: ParagraphEdit): boolean {
  return (
    !!edit.runs &&
    edit.runs.some(
      (r) =>
        r.bold !== undefined ||
        r.italic !== undefined ||
        r.underline !== undefined ||
        r.strikethrough !== undefined ||
        r.color !== undefined ||
        r.fontSize !== undefined,
    )
  )
}

export function paragraphStyleHasDecoration(
  style: Pick<ParagraphEdit, 'underline' | 'strikethrough' | 'runs'>,
): boolean {
  return Boolean(
    style.underline ||
    style.strikethrough ||
    style.runs?.some((run) => run.underline || run.strikethrough),
  )
}

export function expandParagraphBboxForDecorationMask(
  bbox: ParagraphEdit['bbox'],
  fontSize: number,
  pageSize?: { w?: number; h?: number } | null,
): ParagraphEdit['bbox'] {
  const padX = Math.max(4, fontSize * 0.35)
  const padY = Math.max(7, fontSize * 0.55)
  const x0 = Math.max(0, bbox.x - padX)
  const y0 = Math.max(0, bbox.y - padY)
  const maxX = pageSize?.w && pageSize.w > 0 ? pageSize.w : Number.POSITIVE_INFINITY
  const maxY = pageSize?.h && pageSize.h > 0 ? pageSize.h : Number.POSITIVE_INFINITY
  const x1 = Math.min(maxX, bbox.x + bbox.width + padX)
  const y1 = Math.min(maxY, bbox.y + bbox.height + padY)
  return {
    x: x0,
    y: y0,
    width: Math.max(0, x1 - x0),
    height: Math.max(0, y1 - y0),
  }
}

export function expandParagraphEditMaskForDecorations(
  edit: ParagraphEdit,
  pageSize?: { w?: number; h?: number } | null,
  sourceBbox?: ParagraphEdit['bbox'],
): ParagraphEdit {
  if (edit.skipSourceMask || !paragraphStyleHasDecoration(edit)) return edit
  return {
    ...edit,
    maskBbox: expandParagraphBboxForDecorationMask(
      sourceBbox ?? edit.maskBbox ?? edit.bbox,
      edit.fontSize,
      pageSize,
    ),
  }
}

/** Normalize an edit after its `runs` change: re-derive `newText` from the
 *  runs and, when the runs carry styling, force the overlay save path.
 *  Returns a new edit object (does not mutate the input). No-op when there
 *  are no runs. */
export function syncRunsToEdit(edit: ParagraphEdit): ParagraphEdit {
  if (!edit.runs || edit.runs.length === 0) return edit
  const next: ParagraphEdit = { ...edit, newText: concatRuns(edit.runs) }
  if (editCarriesRunStyling(next)) {
    next.requiresOverlay = true
    next.styleChanged = true
  }
  return next
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
  /**
   * Skip system-font resolution/embedding and draw every paragraph in the
   * Standard-14 fallback family instead. Used as a crash-safe retry: pd-lib's
   * fontkit can throw "Cannot read properties of undefined (reading 'tables')"
   * at save time on certain system fonts; the caller retries with this set so
   * the save still succeeds (Standard-14 substitution) rather than aborting.
   */
  forceStandardFonts?: boolean
  /** Session-1 degradation channel: pd-lib-path font fallbacks record
   *  here instead of degrading silently. (The Rust engine records its
   *  own bake-time substitutions — this covers the LEGACY path, which
   *  only runs when the engine didn't.) */
  collector?: SaveDegradationCollector
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

function drawTextDecorations(
  pdfPage: PDFPage,
  edit: ParagraphEdit,
  lineX: number,
  baselineY: number,
  lineWidth: number,
  size: number,
  color: { r: number; g: number; b: number },
) {
  const clippedWidth = Math.max(0, Math.min(lineWidth, edit.bbox.width))
  if (clippedWidth <= 0) return
  const thickness = Math.max(0.5, size / 16)
  const stroke = rgb(color.r, color.g, color.b)
  if (edit.underline) {
    const y = baselineY - size * 0.12
    pdfPage.drawLine({
      start: { x: lineX, y },
      end: { x: lineX + clippedWidth, y },
      thickness,
      color: stroke,
    })
  }
  if (edit.strikethrough) {
    const y = baselineY + size * 0.32
    pdfPage.drawLine({
      start: { x: lineX, y },
      end: { x: lineX + clippedWidth, y },
      thickness,
      color: stroke,
    })
  }
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
        if (edit.skipSourceMask) continue
        const maskBbox = paragraphStyleHasDecoration(edit)
          ? expandParagraphBboxForDecorationMask(edit.maskBbox ?? edit.bbox, edit.fontSize)
          : edit.maskBbox ?? edit.bbox
        // Convert viewport-top-left bbox → PDF user-space Y range.
        const padY = Math.max(3, edit.fontSize * 0.25)
        const padX = Math.max(2, edit.fontSize * 0.15)
        const xMin = maskBbox.x - padX
        const xMax = maskBbox.x + maskBbox.width + padX
        const yMinPdf = pageH - (maskBbox.y + maskBbox.height) - padY
        const yMaxPdf = pageH - maskBbox.y + padY
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
  if (!options.forceStandardFonts) {
    for (const e of edits) {
      const fam = e.fontFamily
      if (!fam) continue
      try {
        const r = await resolveSystemFont(fam, !!e.bold, !!e.italic)
        if (!r) continue
        textPerFontId.set(r.id, (textPerFontId.get(r.id) ?? '') + e.newText)
      } catch { /* resolve failure handled later in pickFontFor */ }
    }
  }

  const pickFontFor = async (
    edit: ParagraphEdit,
    boldOverride?: boolean,
    italicOverride?: boolean,
  ): Promise<PDFFont> => {
    // Resolve the original paragraph's font family against the user's
    // installed fonts. The paragraph stores its fontFamily as a CSS
    // stack ("'Helvetica', -apple-system, ..."); pdfFontResolution
    // picks off the primary name and matches by family + style.
    // bold/italic may be overridden per run for mixed-style paragraphs.
    const bold = boldOverride ?? !!edit.bold
    const italic = italicOverride ?? !!edit.italic
    // Crash-safe retry path: never touch system fonts / fontkit.
    // (The CALLER records font.standard14_retry — intent is known.)
    if (options.forceStandardFonts) return pickStandard(bold, italic)
    const family = edit.fontFamily
    // Missing family = the designed default, not a substitution.
    if (!family) return pickStandard(bold, italic)
    // Session 5 (R5b): the source font is embedded but its family is
    // unrecoverable — the generic stack carries no real information,
    // so resolving it would at best fuzzy-match noise. Substitute
    // standard fonts LOUDLY (the engine-path twin of this check lives
    // in resolveOverlayFonts; same sentinel, classifier files it
    // fidelity).
    if (edit.fontFamilyIsGenericFallback === true) {
      options.collector?.record({
        area: 'font.embed_resolution_failed',
        detail:
          `the document embeds the font drawn by paragraph ${edit.paragraphId} but its ` +
          'family name is unrecoverable (CID/Type3/name-table-less subset); the pd-lib ' +
          'redraw substitutes a standard font',
        paragraphId: edit.paragraphId,
      })
      options.collector?.record({
        area: 'font.substituted',
        detail: substitutionDetail(
          'unrecoverable embedded font',
          'standard-14',
          `path=pdlib paragraph=${edit.paragraphId}`,
        ),
        paragraphId: edit.paragraphId,
      })
      return pickStandard(bold, italic)
    }
    try {
      const resolved = await resolveSystemFont(family, bold, italic)
      if (!resolved) {
        // Record the PRIMARY family, not the full CSS stack: the stack
        // begins with its own quote ('X', Helvetica, …) which made the
        // severity classifier's requested='…' capture come up empty →
        // every real custom-font loss was misfiled as designed-alias
        // info. (Session 2 fix; classifier in saveDegradations.ts.)
        options.collector?.record({
          area: 'font.substituted',
          detail: substitutionDetail(primaryFamily(family), 'standard-14', 'path=pdlib (no system font match)'),
          paragraphId: edit.paragraphId,
        })
        return pickStandard(bold, italic)
      }
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
          options.collector?.record({
            area: 'font.subset_failed_full_embed',
            detail: `font_subset failed for '${resolved.id}' (pd-lib path); embedding the full font`,
          })
        }
      }

      const embedded = await doc.embedFont(bytesForEmbed, { subset: false })
      systemFontCache.set(resolved.id, embedded)
      return embedded
    } catch (err) {
      // Any failure (font file corrupt, fontkit doesn't like it) →
      // Standard fallback. Better to render SOMETHING legible than
      // to crash the save.
      options.collector?.record({
        area: 'font.substituted',
        detail: substitutionDetail(
          primaryFamily(family),
          'standard-14',
          `path=pdlib (embed failed: ${err instanceof Error ? err.message : String(err)})`,
        ),
        paragraphId: edit.paragraphId,
      })
      return pickStandard(bold, italic)
    }
  }

  for (const edit of edits) {
    const maskBbox = paragraphStyleHasDecoration(edit)
      ? expandParagraphBboxForDecorationMask(edit.maskBbox ?? edit.bbox, edit.fontSize)
      : edit.maskBbox ?? edit.bbox
    // Convert viewport top-left origin → pdf user-space bottom-left origin.
    const maskPdfY = pageHeight - maskBbox.y - maskBbox.height
    const { x: maskX, width: maskWidth, height: maskHeight } = maskBbox
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
    if (!edit.skipSourceMask) {
      const padY = Math.max(3, edit.fontSize * 0.25)
      const padX = Math.max(2, edit.fontSize * 0.15)
      const widthBuffer = Math.min(edit.fontSize * 0.3, 6)
      pdfPage.drawRectangle({
        x: maskX - padX,
        y: maskPdfY - padY,
        width: maskWidth + padX * 2 + widthBuffer,
        height: maskHeight + padY * 2,
        color: rgb(bg.r, bg.g, bg.b),
        opacity: 1,
      })
    }

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
      const align: TextAlign = edit.align ?? 'left'
      const lineHeightMult = (edit.lineHeight && edit.lineHeight > 0) ? edit.lineHeight : 1.2

      if (editCarriesRunStyling(edit) && edit.runs && edit.runs.length > 0) {
        // ── Rich-text per-run layout (Acrobat-style per-selection) ────
        // Each segment carries its own bold/italic variant, size, color,
        // and decoration. Font FAMILY stays the box family; only the
        // variant + size + color vary per run.
        // Use the pre-embedded Standard-14 variants (Helvetica/Times/Courier
        // family per fallbackName) rather than embedding a system font per
        // run. Embedding system fonts here can trip fontkit's "tables
        // undefined" bug at doc.save() on real PDFs — and the overlay path
        // already substitutes the font, so Standard-14 variants are the safe,
        // crash-free choice. Bold/italic/size/color still vary per run.
        //
        // Session 4 (verifier gate-1 P1-2): that hardcode silently
        // substituted custom families with no record — a run-styled
        // save on a designed-font doc certified "the per-run gap is
        // recorded" while shipping an invisible substitution in the
        // same save. Record it like every other Standard-14 landing.
        {
          const fam = edit.fontFamily
          const primary = fam ? primaryFamily(fam) : ''
          if (primary && !/helvetica|times|courier|^$/i.test(primary)) {
            options.collector?.record({
              area: 'font.substituted',
              detail: substitutionDetail(
                primary,
                'standard-14',
                'path=pdlib (run-styled overlay draws Standard-14 variants per run)',
              ),
              paragraphId: edit.paragraphId,
            })
          }
        }
        const fontForRun = (b: boolean, i: boolean): PDFFont => pickStandard(b, i)
        interface Seg {
          text: string
          font: PDFFont
          size: number
          color: { r: number; g: number; b: number }
          underline: boolean
          strikethrough: boolean
          width: number
          isSpace: boolean
        }
        // Tokenize runs into words + whitespace, tracking hard newlines.
        const tokens: { text: string; run: StyledRun; newline: boolean }[] = []
        for (const run of edit.runs) {
          run.text.split('\n').forEach((part, pi) => {
            if (pi > 0) tokens.push({ text: '', run, newline: true })
            for (const piece of part.split(/(\s+)/)) {
              if (piece.length > 0) tokens.push({ text: piece, run, newline: false })
            }
          })
        }
        // Resolve each token to a measured segment (or a line break).
        const entries: ({ seg: Seg } | { newline: true })[] = []
        for (const t of tokens) {
          if (t.newline) { entries.push({ newline: true }); continue }
          const b = t.run.bold ?? !!edit.bold
          const i = t.run.italic ?? !!edit.italic
          const f = await fontForRun(b, i)
          const sz = Math.max(6, Math.min(t.run.fontSize ?? edit.fontSize, 72))
          entries.push({
            seg: {
              text: t.text,
              font: f,
              size: sz,
              color: hexToRgb01(t.run.color ?? edit.color),
              underline: t.run.underline ?? !!edit.underline,
              strikethrough: t.run.strikethrough ?? !!edit.strikethrough,
              width: f.widthOfTextAtSize(t.text, sz),
              isSpace: /^\s+$/.test(t.text),
            },
          })
        }
        // Greedy wrap into lines, breaking on hard newlines or width.
        const lines: Seg[][] = []
        let cur: Seg[] = []
        let curW = 0
        const flush = () => { lines.push(cur); cur = []; curW = 0 }
        for (const entry of entries) {
          if ('newline' in entry) { flush(); continue }
          const seg = entry.seg
          if (!seg.isSpace && cur.length > 0 && curW + seg.width > width) {
            while (cur.length > 0 && cur[cur.length - 1].isSpace) { curW -= cur[cur.length - 1].width; cur.pop() }
            flush()
          }
          if (seg.isSpace && cur.length === 0) continue
          cur.push(seg)
          curW += seg.width
        }
        if (cur.length > 0 || lines.length === 0) flush()
        // Draw each line; baseline advances by the line's tallest run.
        let baselineY = drawPdfY + height
        for (const lineSegs of lines) {
          const lineW = lineSegs.reduce((a, s) => a + s.width, 0)
          const maxSize = lineSegs.reduce((m, s) => Math.max(m, s.size), 6)
          baselineY -= maxSize
          let cx =
            align === 'right' ? drawX + (width - lineW)
            : align === 'center' ? drawX + (width - lineW) / 2
            : drawX
          for (const s of lineSegs) {
            if (s.text.trim().length > 0) {
              pdfPage.drawText(s.text, {
                x: cx, y: baselineY, size: s.size, font: s.font,
                color: rgb(s.color.r, s.color.g, s.color.b),
              })
              if (s.underline || s.strikethrough) {
                const thickness = Math.max(0.5, s.size / 16)
                const stroke = rgb(s.color.r, s.color.g, s.color.b)
                if (s.underline) {
                  const y = baselineY - s.size * 0.12
                  pdfPage.drawLine({ start: { x: cx, y }, end: { x: cx + s.width, y }, thickness, color: stroke })
                }
                if (s.strikethrough) {
                  const y = baselineY + s.size * 0.32
                  pdfPage.drawLine({ start: { x: cx, y }, end: { x: cx + s.width, y }, thickness, color: stroke })
                }
              }
            }
            cx += s.width
          }
          baselineY -= maxSize * (lineHeightMult - 1)
        }
      } else {
        // ── Single-font path (uniform paragraph — unchanged) ──────────
        const color = hexToRgb01(edit.color)
        const size = Math.max(6, Math.min(edit.fontSize, 72))
        const lineHeight = size * lineHeightMult
        const font = await pickFontFor(edit)
        const lines = wrapLines(edit.newText, font, size, width)

        // We do NOT clip at the original bbox bottom. Acrobat and WPS both
        // let a paragraph's content grow downward when the replacement is
        // longer than the original (the box visually expands to fit).
        let baselineY = drawPdfY + height - size
        for (let li = 0; li < lines.length; li++) {
          const line = lines[li]
          if (align === 'justify' && li < lines.length - 1 && line.includes(' ')) {
            // Widen inter-word spaces to fill the full width.
            const words = line.split(' ')
            const wordsWidth = words.reduce((acc, w) => acc + font.widthOfTextAtSize(w, size), 0)
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
            drawTextDecorations(pdfPage, edit, drawX, baselineY, width, size, color)
          } else {
            const lineWidth = font.widthOfTextAtSize(line, size)
            const lineX =
              align === 'right' ? drawX + (width - lineWidth)
              : align === 'center' ? drawX + (width - lineWidth) / 2
              : drawX // left (and justify last line)
            pdfPage.drawText(line, {
              x: lineX, y: baselineY, size, font,
              color: rgb(color.r, color.g, color.b),
            })
            drawTextDecorations(pdfPage, edit, lineX, baselineY, lineWidth, size, color)
          }
          baselineY -= lineHeight
        }
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
