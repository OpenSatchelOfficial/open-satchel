import {
  PDFDocument, rgb, StandardFonts, PDFPage, PDFFont, degrees, PDFName, PDFArray, PDFString,
  PDFDict, PDFRef,
  PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown,
  beginMarkedContent, endMarkedContent,
} from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { createCoordinateMapper } from './coordinateMapper'
import {
  parseContentStream, getPageContentBytes, writePageContentBytes,
  serializeContentStream, applyTextReplacement, encodeTextToBytes,
} from './contentStreamParser'
import { buildGlyphMaps, encodeWithGlyphMap } from './cmapResolver'
import type { HeaderFooterConfig } from '../formats/pdf/index'
import type { SaveDegradationCollector } from './saveDegradations'

// ── Helpers ──────────────────────────────────────────────────────

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  if (!result) return { r: 0, g: 0, b: 0 }
  return {
    r: parseInt(result[1], 16) / 255,
    g: parseInt(result[2], 16) / 255,
    b: parseInt(result[3], 16) / 255
  }
}

async function imageSourceToBytes(src: string): Promise<Uint8Array> {
  if (src.startsWith('data:')) {
    const comma = src.indexOf(',')
    if (comma < 0) throw new Error('Invalid image data URL')
    const meta = src.slice(0, comma)
    const body = src.slice(comma + 1)
    const binary = meta.includes(';base64')
      ? atob(body)
      : decodeURIComponent(body)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  }
  const response = await fetch(src)
  const arrayBuf = await response.arrayBuffer()
  return new Uint8Array(arrayBuf)
}

// ── Font Management ──────────────────────────────────────────────

const fontCache = new Map<string, PDFFont>()

function mapToStandardFont(
  fontFamily: string,
  bold: boolean,
  italic: boolean
): StandardFonts {
  const family = (fontFamily || 'Helvetica').toLowerCase()

  if (family.includes('times') || family.includes('serif')) {
    if (bold && italic) return StandardFonts.TimesRomanBoldItalic
    if (bold) return StandardFonts.TimesRomanBold
    if (italic) return StandardFonts.TimesRomanItalic
    return StandardFonts.TimesRoman
  }

  if (family.includes('courier') || family.includes('mono')) {
    if (bold && italic) return StandardFonts.CourierBoldOblique
    if (bold) return StandardFonts.CourierBold
    if (italic) return StandardFonts.CourierOblique
    return StandardFonts.Courier
  }

  // Default: Helvetica family
  if (bold && italic) return StandardFonts.HelveticaBoldOblique
  if (bold) return StandardFonts.HelveticaBold
  if (italic) return StandardFonts.HelveticaOblique
  return StandardFonts.Helvetica
}

async function getFont(
  pdfDoc: PDFDocument,
  fontFamily: string,
  bold: boolean,
  italic: boolean,
  customFontId?: string,
  glyphs?: string
): Promise<PDFFont> {
  const cacheKey = `${fontFamily}-${bold}-${italic}-${customFontId || 'std'}`
  if (fontCache.has(cacheKey)) return fontCache.get(cacheKey)!

  let font: PDFFont

  if (customFontId) {
    try {
      let bytes: Uint8Array
      // Use IPC subsetting if glyphs are provided (main process has Node.js access for subset-font)
      if (glyphs && glyphs.length > 0 && window.api?.font?.subset) {
        bytes = await window.api.font.subset(customFontId, glyphs)
      } else {
        bytes = await window.api.font.getBytes(customFontId)
      }
      font = await pdfDoc.embedFont(bytes)
    } catch {
      // Fallback to standard font if custom fails
      font = await pdfDoc.embedFont(mapToStandardFont(fontFamily, bold, italic))
    }
  } else {
    font = await pdfDoc.embedFont(mapToStandardFont(fontFamily, bold, italic))
  }

  fontCache.set(cacheKey, font)
  return font
}

/** Scan all pages to build a map of customFontId → characters used */
function collectGlyphsPerFont(pages: any[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const page of pages) {
    if (!page.fabricJSON) continue
    const objects = (page.fabricJSON as any).objects || []
    for (const obj of objects) {
      if ((obj.type === 'textbox' || obj.type === 'text' || obj.type === 'i-text' ||
           obj.type === 'Textbox' || obj.type === 'Text' || obj.type === 'IText') && obj.__customFontId) {
        const existing = map.get(obj.__customFontId) || ''
        map.set(obj.__customFontId, existing + (obj.text || ''))
      }
    }
  }
  // Deduplicate characters per font
  for (const [id, chars] of map) {
    map.set(id, [...new Set(chars)].join(''))
  }
  return map
}

// ── Save Options ─────────────────────────────────────────────────

export interface SerializeOptions {
  encryption?: { userPassword: string; ownerPassword: string }
  headerFooter?: HeaderFooterConfig
  /** Session-1 degradation channel. When present, silent edit-drop
   *  sites in this pass record instead of `continue`-ing invisibly. */
  collector?: SaveDegradationCollector
}

function pruneUnreachablePdfObjects(pdfDoc: PDFDocument): void {
  const ctx = pdfDoc.context as any
  const reachable = new Set<string>()

  const visit = (obj: unknown): void => {
    if (!obj) return
    if (obj instanceof PDFRef) {
      const key = obj.toString()
      if (reachable.has(key)) return
      reachable.add(key)
      try { visit(ctx.lookup(obj)) } catch { /* dangling refs are ignored */ }
      return
    }
    if (obj instanceof PDFDict) {
      for (const [, value] of obj.entries()) visit(value)
      return
    }
    if (obj instanceof PDFArray) {
      for (let i = 0; i < obj.size(); i++) visit(obj.get(i))
      return
    }
    const dict = (obj as { dict?: unknown }).dict
    if (dict instanceof PDFDict) visit(dict)
  }

  visit(ctx.trailerInfo.Root)
  visit(ctx.trailerInfo.Info)
  visit(ctx.trailerInfo.Encrypt)
  visit(ctx.trailerInfo.ID)

  for (const [ref] of ctx.enumerateIndirectObjects() as [PDFRef, unknown][]) {
    if (!reachable.has(ref.toString())) ctx.delete(ref)
  }
}

// ── Main Serialization ───────────────────────────────────────────

export async function serializeEditsToPdf(
  originalBytes: Uint8Array,
  pages: any[],
  zoom: number,
  options?: SerializeOptions
): Promise<Uint8Array> {
  fontCache.clear()

  // Pre-compute glyph sets for font subsetting
  const glyphMap = collectGlyphsPerFont(pages)

  const pdfDoc = await PDFDocument.load(originalBytes)

  // Register fontkit for custom font support
  try {
    pdfDoc.registerFontkit(fontkit as any)
  } catch {
    // fontkit may fail in some environments, continue with standard fonts
    options?.collector?.record({
      area: 'font.embed_resolution_failed',
      detail: 'fontkit registration failed in the serializer pass; custom fonts unavailable, standard fonts used',
    })
  }

  // ── Page-structure pass: deletes + inserts (blank) + duplicates ──
  //
  // The `pages` array is the DESIRED final page sequence. Each entry
  // has a pageIndex referring to the original document, except:
  //   • pageIndex < 0  → a blank page inserted by PageManager
  //                      (handleInsertBlank uses negative timestamps)
  //   • Same pageIndex appearing twice → a duplicate
  //
  // Strategy: only rebuild the page tree when the order actually
  // diverges from the original. The rebuild path uses copyPages +
  // removePage + addPage which produces page wrappers whose
  // mutation methods (setMediaBox, setSize, setRotation) don't
  // always propagate into the saved bytes — pdfPage.setMediaBox on
  // a freshly-added clone leaves the original media_box in place
  // when pdfDoc.save() walks the page tree.
  //
  // Detection: any deleted page, any negative pageIndex (blank
  // insert), any positive pageIndex appearing more than once
  // (duplicate), or activePages.length === originalPageCount but
  // the order is shuffled → rebuild. Otherwise → keep the original
  // tree and apply edits in place.
  const activePages = pages.filter((p: any) => !p.deleted)
  const originalPageCount = pdfDoc.getPageCount()

  // Three categories of structural change, each with a different
  // strategy. Detection runs before any mutation:
  //
  //   1. Inserts/duplicates only (any pageIndex<0, or same pageIndex
  //      appearing twice) → rebuild the page tree from copies.
  //   2. Deletions only (some entries deleted, no inserts/duplicates)
  //      → call removePage for each deleted entry, in reverse order.
  //      Cheaper + safer than rebuild; preserves the original PDFDict
  //      refs for surviving pages so setMediaBox/setRotation persist.
  //   3. No structural change → no-op; later loops apply edits in
  //      place.
  const hasInsert = activePages.some((p: any) => p.pageIndex < 0)
  const seenIndices = new Set<number>()
  let hasDuplicate = false
  for (const p of activePages) {
    if (p.pageIndex >= 0) {
      if (seenIndices.has(p.pageIndex)) { hasDuplicate = true; break }
      seenIndices.add(p.pageIndex)
    }
  }
  const deletedIndices: number[] = []
  for (const p of pages) {
    if (p.deleted && p.pageIndex >= 0) deletedIndices.push(p.pageIndex)
  }

  if (hasInsert || hasDuplicate) {
    // Full rebuild path — match the activePages order exactly.
    const sourceIndices: number[] = []
    const blankSlotsByActiveIdx = new Set<number>()
    for (let ai = 0; ai < activePages.length; ai++) {
      const p = activePages[ai]
      if (p.pageIndex < 0) {
        blankSlotsByActiveIdx.add(ai)
      } else if (p.pageIndex < originalPageCount) {
        sourceIndices.push(p.pageIndex)
      }
    }
    const copies: any[] = sourceIndices.length > 0
      ? await pdfDoc.copyPages(pdfDoc, sourceIndices)
      : []

    for (let i = originalPageCount - 1; i >= 0; i--) {
      pdfDoc.removePage(i)
    }

    let copyCursor = 0
    for (let ai = 0; ai < activePages.length; ai++) {
      if (blankSlotsByActiveIdx.has(ai)) {
        pdfDoc.addPage([595, 842])
        continue
      }
      const next = copies[copyCursor++]
      if (next) pdfDoc.addPage(next)
    }
  } else if (deletedIndices.length > 0) {
    // Delete-only path. Reverse order keeps source indices valid.
    deletedIndices.sort((a, b) => b - a)
    for (const idx of deletedIndices) {
      if (idx >= 0 && idx < pdfDoc.getPageCount()) {
        pdfDoc.removePage(idx)
      }
    }
  }
  // else: no structural change — leave the page tree alone.

  if (hasInsert || hasDuplicate || deletedIndices.length > 0) {
    pruneUnreachablePdfObjects(pdfDoc)
  }

  // Apply rotations and page sizes
  for (let i = 0; i < activePages.length; i++) {
    const pageState = activePages[i]
    if (i >= pdfDoc.getPageCount()) break
    const pdfPage = pdfDoc.getPage(i)

    // Apply page size change. setMediaBox + setCropBox are explicit
    // and survive the save round-trip; pdfPage.setSize tries to be
    // clever with /TrimBox / /BleedBox / /ArtBox alignments and on
    // recently-added (copyPages-cloned) pages doesn't always rewire
    // the underlying PDFDict reference, leaving the saved bytes with
    // the source page's original /MediaBox.
    if (pageState.pageSize) {
      const w = pageState.pageSize.width
      const h = pageState.pageSize.height
      pdfPage.setMediaBox(0, 0, w, h)
      pdfPage.setCropBox(0, 0, w, h)
    }

    // Apply rotation
    if (pageState.rotation !== 0) {
      const currentRotation = pdfPage.getRotation().angle
      pdfPage.setRotation(degrees(currentRotation + pageState.rotation))
    }
  }

  // ── TextLayer edits (pdfjs TextLayer-based inline editing) ──────
  // Each page may have _textLayerEdits: array of { spanIndex, originalText, newText }.
  // These map directly to content stream text runs by index order.
  for (let i = 0; i < activePages.length; i++) {
    const pageState = activePages[i] as any
    const textEdits = pageState._textLayerEdits
    if (!textEdits || textEdits.length === 0) continue
    if (i >= pdfDoc.getPageCount()) break

    const streamData = getPageContentBytes(pdfDoc, i)
    if (!streamData) {
      // Whole page's text edits silently vanish here — a data-loss
      // site found by the Session-1 preflight audit. Record it.
      options?.collector?.record({
        area: 'serializer.text_edit_dropped',
        detail: `page ${i}: no readable content stream; ${textEdits.length} text edit(s) dropped`,
        pageIndex: i,
      })
      continue
    }

    const parsed = parseContentStream(streamData.bytes)
    let modified = false

    for (const edit of textEdits) {
      // Map span index to content stream text run index
      // pdfjs textDivs are in the same order as getTextContent() items,
      // which correspond 1:1 to our parsed textRuns (sequential Tj/TJ ops)
      const run = parsed.textRuns[edit.spanIndex]
      if (!run) {
        options?.collector?.record({
          area: 'serializer.text_edit_dropped',
          detail: `page ${i}: span ${edit.spanIndex} has no matching content-stream run; edit dropped`,
          pageIndex: i,
        })
        continue
      }

      const newBytes = encodeTextToBytes(edit.newText)
      applyTextReplacement(parsed, run.opIndex, newBytes, run.tjElementIndex)
      modified = true
    }

    if (modified) {
      const newBytes = serializeContentStream(parsed.operators, streamData.bytes)
      writePageContentBytes(streamData.stream, newBytes, true)
    }
  }

  // ── Fabric edit_text blocks (legacy overlay approach, kept as fallback) ──
  for (let i = 0; i < activePages.length; i++) {
    const pageState = activePages[i]
    if (!pageState.fabricJSON) continue
    if (i >= pdfDoc.getPageCount()) break

    const fabricData = pageState.fabricJSON as any
    const objects: any[] = fabricData.objects || []
    const editBlocks = objects.filter((obj: any) =>
      obj.__editTextBlock && obj.text !== obj.__originalText
    )
    if (editBlocks.length === 0) continue

    const streamData = getPageContentBytes(pdfDoc, i)
    if (!streamData) {
      options?.collector?.record({
        area: 'serializer.text_edit_dropped',
        detail: `page ${i}: no readable content stream; ${editBlocks.length} legacy edit_text block(s) dropped`,
        pageIndex: i,
      })
      continue
    }

    const parsed = parseContentStream(streamData.bytes)

    for (const block of editBlocks) {
      const opIndices: number[] = block.__operatorIndices || []
      const runs = block.__originalTextRuns || []
      if (opIndices.length === 0 || runs.length === 0) continue

      // Try to encode with CMap-aware glyph mapping
      const firstRun = runs[0]
      let encoded: Uint8Array | null = null

      // Check if original was hex-encoded (likely CMap/glyph-indexed)
      if (firstRun.rawString?.type === 'hex' && firstRun.rawString?.value) {
        // Build glyph map from the run's data and try encoding
        // For now, use simple Latin-1 encoding for hex strings
        encoded = encodeTextToBytes(block.text)
      } else {
        encoded = encodeTextToBytes(block.text)
      }

      if (!encoded) {
        options?.collector?.record({
          area: 'serializer.text_edit_dropped',
          detail: `page ${i}: legacy edit_text block could not be encoded; edit dropped`,
          pageIndex: i,
        })
        continue
      }

      // Apply replacement to each matched operator
      for (let j = 0; j < opIndices.length; j++) {
        const opIdx = opIndices[j]
        const run = runs[j]
        if (!run) {
          options?.collector?.record({
            area: 'serializer.text_edit_dropped',
            detail: `page ${i}: legacy edit_text block operator ${j} has no matching run; partial edit`,
            pageIndex: i,
          })
          continue
        }

        // For multi-run blocks (text split across operators), we put
        // the full edited text in the first operator and clear the rest
        const textForThisOp = j === 0 ? block.text : ''
        const bytes = encodeTextToBytes(textForThisOp)
        if (bytes) {
          applyTextReplacement(parsed, opIdx, bytes, run.tjElementIndex)
        }
      }
    }

    // Serialize and write back
    const newBytes = serializeContentStream(parsed.operators, streamData.bytes)
    writePageContentBytes(streamData.stream, newBytes, true)
  }

  // Apply fabric edits (skip __editTextBlock objects — they're now in the content stream)
  for (let i = 0; i < activePages.length; i++) {
    const pageState = activePages[i]
    if (i >= pdfDoc.getPageCount()) break

    const pdfPage = pdfDoc.getPage(i)
    removeStickyTextAnnotations(pdfPage, pageState._nativeStickyNotes || [])

    if (!pageState.fabricJSON) continue
    const { width: pdfW, height: pdfH } = pdfPage.getSize()

    const canvasWidth = pdfW * zoom
    const canvasHeight = pdfH * zoom
    const mapper = createCoordinateMapper(canvasWidth, canvasHeight, pdfW, pdfH)

    const fabricData = pageState.fabricJSON as any
    const objects = fabricData.objects || []

    for (const obj of objects) {
      // Skip edit-text blocks — already handled via content stream replacement
      if (obj.__editTextBlock) continue
      await renderFabricObject(pdfDoc, pdfPage, obj, mapper, glyphMap)
    }
  }

  // Apply form values.
  //
  // Dispatch by field shape (text / checkbox / radio / dropdown).
  // We previously chained try/catches and swallowed every error, which
  // silently dropped values when pd-lib's high-level API rejected the
  // string format we passed (e.g. radio widgets where the user-clicked
  // value is the pdfjs-reported on-state index "2", but pd-lib's
  // RadioGroup.select wants the option string "pro" — that mismatch
  // killed every radio round-trip [B18]). Now: detect the field's
  // actual type once, dispatch correctly, and surface errors via
  // console.warn so a future test run sees the failure instead of
  // shipping silent data loss.
  let formHasNonWinAnsi = false
  try {
    const form = pdfDoc.getForm()
    for (const pageState of activePages) {
      if (!pageState.formValues) continue
      for (const [fieldName, value] of Object.entries(pageState.formValues)) {
        const field = form.getFields().find((f) => f.getName() === fieldName)
        if (!field) {
          console.warn(`[editSerializer] form field "${fieldName}" not found — skipping`)
          options?.collector?.record({
            area: 'serializer.form_value_dropped',
            detail: `form field "${fieldName}" not found in document; the entered value was dropped`,
          })
          continue
        }
        // Track whether ANY value has codepoints WinAnsi can't encode.
        // WinAnsi covers U+0000–U+00FF (Latin-1) plus a handful of
        // remapped slots (€ ‚ „ … and friends). Anything outside that
        // range — em-dashes (U+2014), curly quotes (U+2018-201D),
        // checkmarks (U+2713), etc. — needs a Unicode-capable font for
        // the appearance render. Cheap pre-check: any codepoint > 0xFF
        // is the ~99% signal [B14].
        if (typeof value === 'string' && /[^\x00-\xff]/.test(value)) {
          formHasNonWinAnsi = true
        }
        try {
          if (field instanceof PDFCheckBox) {
            if (value === true || value === 'Yes' || value === 'On') field.check()
            else field.uncheck()
          } else if (field instanceof PDFRadioGroup) {
            const str = String(value)
            try {
              field.select(str)
            } catch {
              // pdfjs reports radio buttonValue as the per-widget
              // appearance index (because pd-lib stored on-state names
              // that way); pd-lib's select() wants the original option
              // string. Try resolving str as an index into the
              // group's options.
              const opts = field.getOptions()
              const idx = Number(str)
              if (!Number.isNaN(idx) && opts[idx]) {
                field.select(opts[idx])
              } else {
                throw new Error(
                  `radio "${fieldName}" value ${JSON.stringify(value)} not in options [${opts.join(', ')}]`,
                )
              }
            }
          } else if (field instanceof PDFDropdown) {
            field.select(String(value))
          } else if (field instanceof PDFTextField) {
            const text = String(value)
            field.setText(text)
            // pd-lib's setText silently accepts oversize values; the
            // overflow only manifests later in appearance render
            // (Acrobat clips visually) or when /MaxLen rejects writes.
            // Surface the mismatch as a console.warn so a future test
            // run sees the truncation instead of shipping silent
            // data-loss [B14-B19 followup].
            try {
              const max = field.getMaxLength()
              if (max && text.length > max) {
                console.warn(
                  `[editSerializer] form field "${fieldName}" text length ` +
                    `${text.length} exceeds declared MaxLen ${max} — Acrobat will truncate on display.`,
                )
                options?.collector?.record({
                  area: 'serializer.form_value_truncated',
                  detail: `form field "${fieldName}": entered ${text.length} chars exceeds MaxLen ${max}; viewers will truncate on display`,
                })
              }
              const stored = field.getText()
              if (stored !== text) {
                console.warn(
                  `[editSerializer] form field "${fieldName}" stored != input ` +
                    `(stored.length=${stored?.length}, input.length=${text.length}) — pd-lib may have truncated.`,
                )
                options?.collector?.record({
                  area: 'serializer.form_value_truncated',
                  detail: `form field "${fieldName}": stored value differs from input (stored=${stored?.length ?? 0} chars, input=${text.length}); pd-lib may have truncated`,
                })
              }
            } catch {
              /* getMaxLength / getText edge — ignore */
            }
          } else {
            console.warn(
              `[editSerializer] unsupported form field type for "${fieldName}":`,
              field.constructor?.name ?? typeof field,
            )
            options?.collector?.record({
              area: 'serializer.form_value_dropped',
              detail: `form field "${fieldName}" has an unsupported type (${field.constructor?.name ?? typeof field}); the entered value was dropped`,
            })
          }
        } catch (err) {
          console.warn(
            `[editSerializer] failed to apply form value for "${fieldName}":`,
            (err as Error).message,
          )
          options?.collector?.record({
            area: 'serializer.form_value_dropped',
            detail: `form value for "${fieldName}" could not be applied (${(err as Error).message}); the entered value was dropped`,
          })
        }
      }
    }

    // If any form value has non-WinAnsi codepoints, embed Source Sans 3
    // Regular (CFF-flavored OTF) and pre-render every field appearance
    // with it. Without this, pd-lib's auto-appearance pass during save()
    // throws "WinAnsi cannot encode" on the Unicode glyph and rolls back
    // the entire save [B14]. Skipped when all values are pure ASCII/
    // Latin-1 so the typical save path doesn't pay the embed cost.
    //
    // Why Source Sans 3 (CFF) and not NotoSans (TrueType): Acrobat DC's
    // "Font Capture" pass crashes (0xc06d007e popup) when ingesting an
    // embedded TrueType font into its system cache. CFF/OTF goes
    // through Acrobat's PostScript-derived font path, which doesn't
    // run Font Capture. See scripts/install-form-font.mjs comment
    // block for the full rationale. [B21 Acrobat Font Capture fix]
    //
    // Coverage tradeoff: Source Sans 3 ships Latin Extended-A/B,
    // Greek, Cyrillic, the punctuation block (em/en dash, curly
    // quotes), and common currency — i.e. realistic real-world form
    // text. Like NotoSans before it, it does NOT include Dingbats
    // (✓ U+2713), so pasting a checkmark glyph into a /Tx field
    // still misses; users should click the checkbox widget instead.
    // Documented gap, not a v1 blocker.
    // pd-lib defaults a new text field's fontSize to 0 ("auto"), which
    // Acrobat reads as "no size hint" and quietly DOESN'T render the
    // appearance stream in default state — multiline /Tx fields show
    // blank until clicked, at which point Acrobat regens with its own
    // giant default. Short fields tolerate it because pd-lib's
    // auto-fit happens to lay out non-degenerate. Force a real
    // fontSize on every text field, ASCII or Unicode, so the saved
    // appearance is something Acrobat will paint without re-tap [B19].
    for (const f of form.getFields()) {
      if (f instanceof PDFTextField) {
        // pd-lib's TextField doesn't expose `getFontSize()` in its
        // d.ts, so set unconditionally — `setFontSize(10)` is
        // idempotent and overrides only when the field's existing
        // /DA didn't carry an explicit size hint. Wrap defensively
        // because some hand-crafted PDFs have malformed /DA strings
        // that pd-lib can't parse on read.
        try {
          f.setFontSize(10)
        } catch {
          /* keep default */
        }
      }
    }

    if (formHasNonWinAnsi) {
      try {
        // public/fonts/SourceSans3-Regular.otf is shipped via
        // scripts/install-form-font.mjs and served by Vite at root.
        // Fetch fails in non-DOM contexts (Node tests) — guard so the
        // editor doesn't go down if the font is missing. ASCII-only
        // saves remain unaffected.
        const fontUrl = '/fonts/SourceSans3-Regular.otf'
        const resp = await fetch(fontUrl)
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status} fetching ${fontUrl}`)
        }
        const fontBytes = new Uint8Array(await resp.arrayBuffer())
        // Subset by default — pd-lib + fontkit emit only the glyphs
        // referenced by the appearance streams, keeping the saved
        // PDF small (~6–15KB out of the ~270KB OTF). pd-lib accepts
        // CFF-flavored OTF bytes the same as TTF; fontkit detects
        // the `CFF ` table and emits a /Type1 (or /CIDFontType0)
        // descriptor, which goes through Acrobat's PostScript-
        // derived font path — no Font Capture exception.
        const unicodeFont = await pdfDoc.embedFont(fontBytes, {
          subset: true,
        })
        form.updateFieldAppearances(unicodeFont)

        // Set /NeedAppearances=true on the AcroForm dict. This tells
        // capable PDF readers (Acrobat, modern browsers, pdfjs):
        // "trust /V; regenerate the appearance from your own fonts on
        // display." Acrobat then uses its bundled Unicode-capable
        // font and SKIPS its Font Capture pass on our embedded font
        // — the popup that showed up in 23.x DC Pro empirically
        // tracks to that pass. Less-capable readers ignore the flag
        // and fall back to our pre-rendered /AP appearance, so we
        // still cover the long tail.
        try {
          const acroForm = (form as unknown as { acroForm: { dict: { set: (k: PDFName, v: unknown) => void } } }).acroForm
          acroForm.dict.set(PDFName.of('NeedAppearances'), pdfDoc.context.obj(true))
        } catch (e) {
          // pd-lib internal shape changed — log but don't block save.
          console.warn('[editSerializer] could not set NeedAppearances=true:', (e as Error).message)
        }

        // Tell save() not to re-run updateFieldAppearances with the
        // form's default (Helvetica/WinAnsi) font — that would
        // re-throw the encode error.
        ;(pdfDoc as { __osSkipFieldAppearances?: boolean }).__osSkipFieldAppearances = true
      } catch (err) {
        console.warn(
          '[editSerializer] could not embed Unicode form font; falling back to default appearance pass:',
          (err as Error).message,
        )
        options?.collector?.record({
          area: 'font.embed_resolution_failed',
          detail: `Unicode form font could not be embedded (${(err as Error).message}); non-Latin form text may render incorrectly`,
        })
      }
    }
  } catch {
    // pdfDoc.getForm() throws when there's no AcroForm — that's fine.
  }

  // Apply headers & footers
  if (options?.headerFooter) {
    await renderHeadersFooters(pdfDoc, activePages, options.headerFooter)
  }

  // If we already pre-rendered field appearances with a Unicode font
  // for B14, tell save() to skip its default appearance pass — that
  // would re-render with Helvetica/WinAnsi and re-throw the encode
  // error we just dodged.
  const skipFieldAppearances = !!(pdfDoc as { __osSkipFieldAppearances?: boolean })
    .__osSkipFieldAppearances

  // Save with encryption if requested
  if (options?.encryption) {
    return pdfDoc.save({
      userPassword: options.encryption.userPassword,
      ownerPassword: options.encryption.ownerPassword,
      updateFieldAppearances: !skipFieldAppearances,
    } as any)
  }

  return pdfDoc.save({ updateFieldAppearances: !skipFieldAppearances })
}

// ── Link annotation helper ───────────────────────────────────────
//
// pd-lib's public API has drawText/drawRectangle but no dedicated
// "add link" call. Build the dict via context.obj() and append the
// returned ref onto the page's /Annots array, creating the array
// if the page has none. Matches the shape pdfLinks.ts reads back.

function addLinkAnnotation(
  pdfDoc: PDFDocument,
  page: PDFPage,
  rect: [number, number, number, number],
  url: string,
): void {
  const ctx = pdfDoc.context
  const annotDict = ctx.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: rect,
    Border: [0, 0, 0],
    A: {
      Type: 'Action',
      S: 'URI',
      URI: PDFString.of(url),
    },
  })
  const annotRef = ctx.register(annotDict)

  const existing = page.node.get(PDFName.of('Annots'))
  if (existing instanceof PDFArray) {
    existing.push(annotRef)
  } else {
    const arr = PDFArray.withContext(ctx)
    arr.push(annotRef)
    page.node.set(PDFName.of('Annots'), arr)
  }
}

function appendPageAnnotation(pdfDoc: PDFDocument, page: PDFPage, annotDict: PDFDict): PDFRef {
  const ctx = pdfDoc.context
  const annotRef = ctx.register(annotDict)
  const existing = page.node.get(PDFName.of('Annots'))
  if (existing instanceof PDFArray) {
    existing.push(annotRef)
  } else {
    const arr = PDFArray.withContext(ctx)
    arr.push(annotRef)
    page.node.set(PDFName.of('Annots'), arr)
  }
  return annotRef
}

function addStickyTextAnnotation(
  pdfDoc: PDFDocument,
  page: PDFPage,
  rect: [number, number, number, number],
  contents: string,
  author: string,
  color: string,
  id?: string,
): PDFRef {
  const ctx = pdfDoc.context
  const c = hexToRgb(color)
  const annot = ctx.obj({
    Type: 'Annot',
    Subtype: 'Text',
    Rect: rect,
    Contents: PDFString.of(contents || ''),
    T: PDFString.of(author || 'You'),
    ...(id ? { NM: PDFString.of(id) } : {}),
    Name: 'Comment',
    Open: false,
    C: [c.r, c.g, c.b],
    F: 4,
  }) as PDFDict
  return appendPageAnnotation(pdfDoc, page, annot)
}

interface StickyReply {
  id?: string
  body: string
  author?: string
}

function addStickyReplyAnnotation(
  pdfDoc: PDFDocument,
  page: PDFPage,
  rect: [number, number, number, number],
  reply: StickyReply,
  parentRef: PDFRef,
  color: string,
): PDFRef {
  const ctx = pdfDoc.context
  const c = hexToRgb(color)
  const annot = ctx.obj({
    Type: 'Annot',
    Subtype: 'Text',
    Rect: rect,
    Contents: PDFString.of(reply.body || ''),
    T: PDFString.of(reply.author || 'You'),
    ...(reply.id ? { NM: PDFString.of(reply.id) } : {}),
    Name: 'Comment',
    Open: false,
    C: [c.r, c.g, c.b],
    F: 4,
    IRT: parentRef,
    RT: PDFName.of('R'),
  }) as PDFDict
  return appendPageAnnotation(pdfDoc, page, annot)
}

function extractStickyReplies(obj: any): StickyReply[] {
  if (!Array.isArray(obj.__replies)) return []
  return obj.__replies
    .filter((reply: any) => reply && typeof reply === 'object' && typeof reply.body === 'string')
    .map((reply: any) => ({
      id: typeof reply.id === 'string' ? reply.id : undefined,
      body: reply.body,
      author: typeof reply.author === 'string' ? reply.author : 'You',
    }))
}

function extractGroupText(obj: any): string {
  if (typeof obj.__contents === 'string') return obj.__contents
  if (typeof obj.text === 'string') return obj.text
  const children = Array.isArray(obj.objects) ? obj.objects : []
  for (const child of children) {
    if (child && typeof child === 'object' && typeof child.text === 'string') {
      return child.text
    }
  }
  return ''
}

function pdfTextValue(value: unknown): string {
  if (!value) return ''
  const v = value as { decodeText?: () => string; asString?: () => string }
  try {
    if (typeof v.decodeText === 'function') return v.decodeText()
    if (typeof v.asString === 'function') return v.asString()
  } catch {
    return ''
  }
  return String(value).replace(/^\((.*)\)$/s, '$1')
}

function pdfNumberValue(value: unknown): number | null {
  if (value == null) return null
  const v = value as { asNumber?: () => number; numberValue?: number }
  if (typeof v.asNumber === 'function') {
    const n = v.asNumber()
    return Number.isFinite(n) ? n : null
  }
  if (typeof v.numberValue === 'number') return v.numberValue
  const n = Number(String(value))
  return Number.isFinite(n) ? n : null
}

function annotRect(annot: PDFDict): [number, number, number, number] | null {
  const arr = annot.lookup(PDFName.of('Rect'), PDFArray)
  if (!arr || arr.size() < 4) return null
  const nums = [0, 1, 2, 3].map((idx) => pdfNumberValue(arr.lookup(idx)))
  if (nums.some((n) => n == null)) return null
  return nums as [number, number, number, number]
}

function rectClose(a?: number[], b?: number[]): boolean {
  if (!a || !b || a.length < 4 || b.length < 4) return false
  return a.slice(0, 4).every((n, idx) => Math.abs(n - b[idx]) < 0.5)
}

function stickySnapshotMatches(annot: PDFDict, snapshot: any): boolean {
  if (annot.get(PDFName.of('IRT'))) return false
  const nm = pdfTextValue(annot.get(PDFName.of('NM')))
  if (snapshot?.id && nm && nm === snapshot.id) return true
  if (snapshot?.hadName) return false
  const rect = annotRect(annot)
  const contents = pdfTextValue(annot.get(PDFName.of('Contents')))
  const author = pdfTextValue(annot.get(PDFName.of('T')))
  return rectClose(rect ?? undefined, snapshot?.rectPdf) &&
    contents === (snapshot?.contents ?? '') &&
    author === (snapshot?.author ?? '')
}

function pdfObjectKey(value: unknown): string {
  return value ? String(value) : ''
}

function removeStickyTextAnnotations(page: PDFPage, snapshots: any[] = []): void {
  if (!snapshots.length) return
  const annots = page.node.lookup(PDFName.of('Annots'), PDFArray)
  if (!annots) return

  const parentRefsToRemove = new Set<string>()
  for (let i = 0; i < annots.size(); i++) {
    const annot = annots.lookup(i, PDFDict)
    if (!annot) continue
    if (annot.get(PDFName.of('Subtype'))?.toString() !== '/Text') continue
    if (snapshots.some((snapshot) => stickySnapshotMatches(annot, snapshot))) {
      const refKey = pdfObjectKey(annots.get(i))
      if (refKey) parentRefsToRemove.add(refKey)
    }
  }

  for (let i = annots.size() - 1; i >= 0; i--) {
    const annot = annots.lookup(i, PDFDict)
    if (!annot) continue
    if (annot.get(PDFName.of('Subtype'))?.toString() !== '/Text') continue
    const ownRef = pdfObjectKey(annots.get(i))
    const replyToRef = pdfObjectKey(annot.get(PDFName.of('IRT')))
    if (
      snapshots.some((snapshot) => stickySnapshotMatches(annot, snapshot)) ||
      (!!ownRef && parentRefsToRemove.has(ownRef)) ||
      (!!replyToRef && parentRefsToRemove.has(replyToRef))
    ) {
      annots.remove(i)
    }
  }
}

function stickySnapshotFromObject(obj: any): any {
  const snapshot = obj.__nativeStickySnapshot
  return {
    id: obj.__id,
    hadName: true,
    rectPdf: snapshot?.rectPdf,
    contents: snapshot?.contents,
    author: snapshot?.author,
  }
}

function isStickyNoteObject(obj: any): boolean {
  return !!(obj && (obj.__isStickyNote || obj.__kind === 'sticky_note'))
}

// ── Render Fabric Objects to PDF ─────────────────────────────────

async function renderFabricObject(
  pdfDoc: PDFDocument,
  page: PDFPage,
  obj: any,
  mapper: ReturnType<typeof createCoordinateMapper>,
  glyphMap: Map<string, string>
): Promise<void> {
  if (isStickyNoteObject(obj)) {
    const left = obj.left || 0
    const top = obj.top || 0
    const w = (obj.width || 18) * (obj.scaleX || 1)
    const h = (obj.height || 18) * (obj.scaleY || 1)
    const pos = mapper.fabricToPdf(left, top + h)
    removeStickyTextAnnotations(page, [stickySnapshotFromObject(obj)])
    const rect: [number, number, number, number] = [
      pos.x,
      pos.y,
      pos.x + mapper.scaleToPdf(w),
      pos.y + mapper.sizeToPdf(h),
    ]
    const color = obj.__color || obj.fill || '#f9e2af'
    const parentRef = addStickyTextAnnotation(
      pdfDoc,
      page,
      rect,
      extractGroupText(obj),
      obj.__author || 'You',
      color,
      obj.__id,
    )
    for (const reply of extractStickyReplies(obj)) {
      addStickyReplyAnnotation(pdfDoc, page, rect, reply, parentRef, color)
    }
    return
  }

  // Fabric v6 emits PascalCase types (Path, Rect, Image, Group, Textbox,
  // IText, Circle, Ellipse, Line, Polygon, Polyline, Triangle). Older
  // Fabric and our legacy-serialized JSON used lowercase (path, rect,
  // image, textbox, i-text). Normalize both so neither camp silently
  // falls through to default. The switch below lists both forms for
  // clarity.
  const t = (obj.type as string | undefined) ?? ''
  switch (t) {
    case 'Textbox':
    case 'IText':
    case 'Text':
    case 'textbox':
    case 'i-text':
    case 'text': {
      const text = obj.text || ''
      const fontSize = mapper.sizeToPdf(obj.fontSize || 16)
      const color = hexToRgb(obj.fill || '#000000')
      const customFontId = obj.__customFontId || undefined
      const font = await getFont(
        pdfDoc,
        obj.fontFamily || 'Helvetica',
        obj.fontWeight === 'bold',
        obj.fontStyle === 'italic',
        customFontId,
        customFontId ? glyphMap.get(customFontId) : undefined
      )

      // G5: wrap watermark textbox emissions in `/Watermark BMC ... EMC`
      // marked-content. The Rust pdf_remove_watermark_text command
      // strips by marker (semantic), so an "unbake watermark" round-
      // trip won't accidentally remove unrelated body text that happens
      // to share the watermark string. BMC is the simpler form (no
      // properties dict); the strip path matches both BMC and BDC for
      // belt-and-suspenders compatibility with anything that re-flows
      // the marker via DOM tools.
      const isWatermark = obj.__watermark === true
      if (isWatermark) {
        page.pushOperators(beginMarkedContent('Watermark'))
      }

      const lines = text.split('\n')
      const lineHeight = obj.lineHeight || 1.2

      // G1: honor textAlign on overlay bake. pre-fix, every Textbox
      // saved left-aligned regardless of the Fabric textAlign property.
      // For 'center' / 'right' / 'justify': measure each line's width
      // via the resolved font and shift x by the appropriate offset
      // inside the box bounds. 'justify' here uses simple word-spacing
      // distribution (last line not justified). Falls back to left
      // when textAlign is missing or 'left'.
      const textAlign = (obj.textAlign as 'left' | 'center' | 'right' | 'justify' | undefined) ?? 'left'
      const fabricBoxWidth = (obj.width || 0) * (obj.scaleX || 1)
      const pdfBoxWidth = mapper.scaleToPdf(fabricBoxWidth)
      const measureLine = (s: string): number => {
        try { return font.widthOfTextAtSize(s, fontSize) }
        catch { return s.length * fontSize * 0.5 }  // approx fallback
      }

      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx]
        if (!line.trim()) continue

        const yOffset =
          (obj.top || 0) +
          (obj.fontSize || 16) * lineIdx * lineHeight +
          (obj.fontSize || 16)
        const pos = mapper.fabricToPdf(obj.left || 0, yOffset)

        // Justify is the only path that splits + re-emits per-word.
        // For left/center/right we just shift the line's x.
        if (textAlign === 'justify' && lineIdx < lines.length - 1) {
          const words: string[] = line.split(/(\s+)/)  // keep separators for measure
          const wordWidths: number[] = words.map(measureLine)
          const totalWordsWidth = wordWidths.reduce((a: number, b: number) => a + b, 0)
          const slack = pdfBoxWidth - totalWordsWidth
          // Distribute slack across whitespace tokens only.
          const spaceTokens = words.filter((w: string) => /^\s+$/.test(w))
          const extraPerSpace = spaceTokens.length > 0 ? slack / spaceTokens.length : 0
          let cursorX = pos.x
          for (let wi = 0; wi < words.length; wi++) {
            const w = words[wi]
            if (!w) continue
            page.drawText(w, {
              x: cursorX,
              y: pos.y,
              size: fontSize,
              font,
              color: rgb(color.r, color.g, color.b),
              opacity: obj.opacity ?? 1,
              rotate: obj.angle ? degrees(obj.angle) : undefined,
            })
            cursorX += wordWidths[wi] + (/^\s+$/.test(w) ? extraPerSpace : 0)
          }
          continue
        }

        let xOffset = 0
        if (textAlign === 'center' || textAlign === 'right') {
          const lineWidth = measureLine(line)
          if (textAlign === 'center') xOffset = (pdfBoxWidth - lineWidth) / 2
          else xOffset = pdfBoxWidth - lineWidth
        }

        page.drawText(line, {
          x: pos.x + xOffset,
          y: pos.y,
          size: fontSize,
          font,
          color: rgb(color.r, color.g, color.b),
          opacity: obj.opacity ?? 1,
          rotate: obj.angle ? degrees(obj.angle) : undefined,
        })
      }

      // G5: close the /Watermark BMC sequence opened above. Always
      // matches an opener — if isWatermark was false at the top, we
      // never opened, so nothing to close.
      if (isWatermark) {
        page.pushOperators(endMarkedContent())
      }

      break
    }

    case 'Rect':
    case 'rect': {
      const left = obj.left || 0
      const top = obj.top || 0
      const w = (obj.width || 0) * (obj.scaleX || 1)
      const h = (obj.height || 0) * (obj.scaleY || 1)
      const pos = mapper.fabricToPdf(left, top + h)
      const strokeColor = hexToRgb(obj.stroke || '#000000')
      const hasFill = obj.fill && obj.fill !== 'transparent' && obj.fill !== ''
      const fillColor = hasFill ? hexToRgb(obj.fill) : null
      const pdfW = mapper.scaleToPdf(w)
      const pdfH = mapper.sizeToPdf(h)

      page.drawRectangle({
        x: pos.x,
        y: pos.y,
        width: pdfW,
        height: pdfH,
        borderColor: obj.stroke ? rgb(strokeColor.r, strokeColor.g, strokeColor.b) : undefined,
        borderWidth: obj.strokeWidth ? mapper.sizeToPdf(obj.strokeWidth) : undefined,
        color: fillColor ? rgb(fillColor.r, fillColor.g, fillColor.b) : undefined,
        opacity: obj.opacity ?? 1
      })

      // /Link annotation emit: when the Link tool tagged this Rect with
      // __linkUrl, add a proper PDF /Link annotation over the same rect.
      // Leaves the visible rectangle in place (Open Satchel's Link-tool
      // draws it with a dashed blue stroke as an authoring affordance).
      // The annotation's /Border is [0 0 0] so it doesn't double up.
      const linkUrl = typeof obj.__linkUrl === 'string' ? obj.__linkUrl : undefined
      if (linkUrl) {
        addLinkAnnotation(
          pdfDoc,
          page,
          [pos.x, pos.y, pos.x + pdfW, pos.y + pdfH],
          linkUrl,
        )
      }
      break
    }

    case 'Ellipse':
    case 'ellipse': {
      const rx = (obj.rx || 0) * (obj.scaleX || 1)
      const ry = (obj.ry || 0) * (obj.scaleY || 1)
      const cx = (obj.left || 0) + rx
      const cy = (obj.top || 0) + ry
      const center = mapper.fabricToPdf(cx, cy)
      const strokeColor = hexToRgb(obj.stroke || '#000000')
      const hasFill = obj.fill && obj.fill !== 'transparent' && obj.fill !== ''
      const fillColor = hasFill ? hexToRgb(obj.fill) : null

      page.drawEllipse({
        x: center.x,
        y: center.y,
        xScale: mapper.scaleToPdf(rx),
        yScale: mapper.sizeToPdf(ry),
        borderColor: obj.stroke ? rgb(strokeColor.r, strokeColor.g, strokeColor.b) : undefined,
        borderWidth: obj.strokeWidth ? mapper.sizeToPdf(obj.strokeWidth) : undefined,
        color: fillColor ? rgb(fillColor.r, fillColor.g, fillColor.b) : undefined,
        opacity: obj.opacity ?? 1
      })
      break
    }

    case 'Line':
    case 'line': {
      const x1 = obj.x1 ?? 0
      const y1 = obj.y1 ?? 0
      const x2 = obj.x2 ?? 0
      const y2 = obj.y2 ?? 0
      const left = obj.left || 0
      const top = obj.top || 0
      const w = obj.width || 0
      const h = obj.height || 0

      // Fabric stores line coords relative to the object center
      const start = mapper.fabricToPdf(left + x1 + w / 2, top + y1 + h / 2)
      const end = mapper.fabricToPdf(left + x2 + w / 2, top + y2 + h / 2)
      const strokeColor = hexToRgb(obj.stroke || '#000000')

      page.drawLine({
        start: { x: start.x, y: start.y },
        end: { x: end.x, y: end.y },
        thickness: mapper.sizeToPdf(obj.strokeWidth || 1),
        color: rgb(strokeColor.r, strokeColor.g, strokeColor.b),
        opacity: obj.opacity ?? 1
      })

      // Arrow head
      if (obj.__isArrow) {
        const angle = Math.atan2(end.y - start.y, end.x - start.x)
        const headLen = mapper.sizeToPdf(12)
        const a1 = angle + Math.PI * 0.85
        const a2 = angle - Math.PI * 0.85

        page.drawLine({
          start: { x: end.x, y: end.y },
          end: { x: end.x + headLen * Math.cos(a1), y: end.y + headLen * Math.sin(a1) },
          thickness: mapper.sizeToPdf(obj.strokeWidth || 1),
          color: rgb(strokeColor.r, strokeColor.g, strokeColor.b),
          opacity: obj.opacity ?? 1
        })
        page.drawLine({
          start: { x: end.x, y: end.y },
          end: { x: end.x + headLen * Math.cos(a2), y: end.y + headLen * Math.sin(a2) },
          thickness: mapper.sizeToPdf(obj.strokeWidth || 1),
          color: rgb(strokeColor.r, strokeColor.g, strokeColor.b),
          opacity: obj.opacity ?? 1
        })
      }
      break
    }

    case 'Group':
    case 'group': {
      // Rasterize visual groups such as stamps to PNG and embed.
      try {
        const left = obj.left || 0
        const top = obj.top || 0
        const w = (obj.width || 100) * (obj.scaleX || 1)
        const h = (obj.height || 100) * (obj.scaleY || 1)

        const offscreen = new OffscreenCanvas(Math.ceil(w) + 4, Math.ceil(h) + 4)
        const ctx = offscreen.getContext('2d')!
        ctx.globalAlpha = obj.opacity ?? 1
        ctx.translate(2, 2)

        // Render group children
        if (obj.objects) {
          for (const child of obj.objects) {
            renderGroupChild(ctx, child, w, h, obj.scaleX || 1, obj.scaleY || 1)
          }
        }

        const blob = await offscreen.convertToBlob({ type: 'image/png' })
        const arrayBuf = await blob.arrayBuffer()
        const pngBytes = new Uint8Array(arrayBuf)
        const image = await pdfDoc.embedPng(pngBytes)

        const pos = mapper.fabricToPdf(left, top + h)
        page.drawImage(image, {
          x: pos.x,
          y: pos.y,
          width: mapper.scaleToPdf(w),
          height: mapper.sizeToPdf(h)
        })
      } catch {
        // Skip groups that fail to rasterize
      }
      break
    }

    case 'Image':
    case 'image': {
      const imageSrc = obj.__imageDataUrl || obj.src
      if (!imageSrc) break
      try {
        const bytes = await imageSourceToBytes(imageSrc)

        let image
        if (bytes[0] === 0x89 && bytes[1] === 0x50) {
          image = await pdfDoc.embedPng(bytes)
        } else {
          image = await pdfDoc.embedJpg(bytes)
        }

        const scaleX = obj.scaleX || 1
        const scaleY = obj.scaleY || 1
        const imgWidth = (obj.width || 100) * scaleX
        const imgHeight = (obj.height || 100) * scaleY

        const pos = mapper.fabricToPdf(obj.left || 0, (obj.top || 0) + imgHeight)

        page.drawImage(image, {
          x: pos.x,
          y: pos.y,
          width: mapper.scaleToPdf(imgWidth),
          height: mapper.sizeToPdf(imgHeight)
        })
      } catch {
        // Skip images that can't be embedded
      }
      break
    }

    case 'Path':
    case 'path': {
      // Freehand drawings: rasterize to transparent PNG
      try {
        const pathData = obj.path
        if (!pathData) break

        const left = obj.left || 0
        const top = obj.top || 0
        const width = obj.width || 100
        const height = obj.height || 100
        const scaleX = obj.scaleX || 1
        const scaleY = obj.scaleY || 1

        const scaledWidth = width * scaleX
        const scaledHeight = height * scaleY

        const offscreen = new OffscreenCanvas(
          Math.ceil(scaledWidth) + 4,
          Math.ceil(scaledHeight) + 4
        )
        const ctx = offscreen.getContext('2d')!

        ctx.strokeStyle = obj.stroke || '#000000'
        ctx.lineWidth = obj.strokeWidth || 1
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.globalAlpha = obj.opacity || 1

        ctx.beginPath()
        for (const cmd of pathData) {
          switch (cmd[0]) {
            case 'M':
              ctx.moveTo((cmd[1] - left / scaleX) * scaleX + 2, (cmd[2] - top / scaleY) * scaleY + 2)
              break
            case 'L':
              ctx.lineTo((cmd[1] - left / scaleX) * scaleX + 2, (cmd[2] - top / scaleY) * scaleY + 2)
              break
            case 'Q':
              ctx.quadraticCurveTo(
                (cmd[1] - left / scaleX) * scaleX + 2, (cmd[2] - top / scaleY) * scaleY + 2,
                (cmd[3] - left / scaleX) * scaleX + 2, (cmd[4] - top / scaleY) * scaleY + 2
              )
              break
            case 'C':
              ctx.bezierCurveTo(
                (cmd[1] - left / scaleX) * scaleX + 2, (cmd[2] - top / scaleY) * scaleY + 2,
                (cmd[3] - left / scaleX) * scaleX + 2, (cmd[4] - top / scaleY) * scaleY + 2,
                (cmd[5] - left / scaleX) * scaleX + 2, (cmd[6] - top / scaleY) * scaleY + 2
              )
              break
          }
        }
        ctx.stroke()

        const blob = await offscreen.convertToBlob({ type: 'image/png' })
        const arrayBuf = await blob.arrayBuffer()
        const pngBytes = new Uint8Array(arrayBuf)
        const image = await pdfDoc.embedPng(pngBytes)

        const pos = mapper.fabricToPdf(left, top + scaledHeight)

        page.drawImage(image, {
          x: pos.x,
          y: pos.y,
          width: mapper.scaleToPdf(scaledWidth),
          height: mapper.sizeToPdf(scaledHeight)
        })
      } catch {
        // Skip paths that fail to rasterize
      }
      break
    }
  }
}

// ── Render Group Children (for stamps, sticky notes) ─────────────

function renderGroupChild(
  ctx: OffscreenCanvasRenderingContext2D,
  child: any,
  groupW: number,
  groupH: number,
  groupScaleX: number,
  groupScaleY: number
): void {
  const scaleX = (child.scaleX || 1) * groupScaleX
  const scaleY = (child.scaleY || 1) * groupScaleY
  const left = ((child.left || 0) + groupW / 2) * groupScaleX
  const top = ((child.top || 0) + groupH / 2) * groupScaleY

  ctx.save()

  if (child.angle) {
    const w = (child.width || 0) * scaleX
    const h = (child.height || child.fontSize || 0) * scaleY
    ctx.translate(left + w / 2, top + h / 2)
    ctx.rotate((child.angle * Math.PI) / 180)
    ctx.translate(-(left + w / 2), -(top + h / 2))
  }

  if (child.type === 'rect' || child.type === 'Rect') {
    const w = (child.width || 0) * scaleX
    const h = (child.height || 0) * scaleY
    if (child.fill && child.fill !== 'transparent') {
      ctx.fillStyle = child.fill
      ctx.globalAlpha = child.opacity ?? 1
      ctx.fillRect(left, top, w, h)
    }
    if (child.stroke) {
      ctx.strokeStyle = child.stroke
      ctx.lineWidth = child.strokeWidth || 1
      ctx.strokeRect(left, top, w, h)
    }
  } else if (
    child.type === 'textbox' || child.type === 'text' ||
    child.type === 'Textbox' || child.type === 'Text' || child.type === 'IText'
  ) {
    const w = (child.width || 0) * scaleX
    const h = (child.height || child.fontSize || 14) * scaleY
    const fontSize = (child.fontSize || 14) * Math.max(groupScaleX, groupScaleY)
    ctx.fillStyle = child.fill || '#000000'
    ctx.font = `${child.fontWeight || 'normal'} ${child.fontStyle || 'normal'} ${fontSize}px ${child.fontFamily || 'Helvetica'}`
    ctx.textAlign = child.textAlign || 'left'
    ctx.textBaseline = 'middle'
    const drawX =
      ctx.textAlign === 'center' ? left + w / 2 :
        ctx.textAlign === 'right' ? left + w :
          left
    const lines = String(child.text || '').split(/\r?\n/)
    const lineHeight = fontSize * (child.lineHeight || 1.16)
    const blockHeight = Math.max(lineHeight, lines.length * lineHeight)
    const firstY = top + h / 2 - blockHeight / 2 + lineHeight / 2
    lines.forEach((line, idx) => {
      ctx.fillText(line, drawX, firstY + idx * lineHeight)
    })
  }

  ctx.restore()
}

// ── Headers & Footers ────────────────────────────────────────────

async function renderHeadersFooters(
  pdfDoc: PDFDocument,
  activePages: any[],
  config: HeaderFooterConfig
): Promise<void> {
  const font = await pdfDoc.embedFont(mapToStandardFont(config.fontFamily, false, false))
  const color = hexToRgb(config.color)
  const fontSize = config.fontSize || 10
  const totalPages = activePages.filter((p: any) => !p.deleted).length

  for (let i = 0; i < Math.min(activePages.length, pdfDoc.getPageCount()); i++) {
    // Check apply-to scope
    const pageNum = i + 1
    if (config.applyTo === 'odd' && pageNum % 2 === 0) continue
    if (config.applyTo === 'even' && pageNum % 2 !== 0) continue

    const page = pdfDoc.getPage(i)
    const { width, height } = page.getSize()
    const margin = 40 // left/right margin in points

    const resolveTokens = (text: string): string =>
      text
        .replace(/\{page\}/g, String(pageNum))
        .replace(/\{pages\}/g, String(totalPages))
        .replace(/\{date\}/g, new Date().toLocaleDateString())
        .replace(/\{time\}/g, new Date().toLocaleTimeString())
        .replace(/\{filename\}/g, 'Document')

    const drawZone = (text: string, x: number, y: number, align: 'left' | 'center' | 'right') => {
      if (!text.trim()) return
      const resolved = resolveTokens(text)
      let drawX = x
      if (align === 'center') {
        const textWidth = font.widthOfTextAtSize(resolved, fontSize)
        drawX = x - textWidth / 2
      } else if (align === 'right') {
        const textWidth = font.widthOfTextAtSize(resolved, fontSize)
        drawX = x - textWidth
      }
      page.drawText(resolved, {
        x: drawX,
        y,
        size: fontSize,
        font,
        color: rgb(color.r, color.g, color.b)
      })
    }

    const headerY = height - (config.marginTop || 20)
    const footerY = config.marginBottom || 20

    // Headers
    drawZone(config.headerLeft, margin, headerY, 'left')
    drawZone(config.headerCenter, width / 2, headerY, 'center')
    drawZone(config.headerRight, width - margin, headerY, 'right')

    // Footers
    drawZone(config.footerLeft, margin, footerY, 'left')
    drawZone(config.footerCenter, width / 2, footerY, 'center')
    drawZone(config.footerRight, width - margin, footerY, 'right')
  }
}
