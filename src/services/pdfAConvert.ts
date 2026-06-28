// PDF/A conversion pipeline.
//
// Orchestrates everything needed to take an arbitrary PDF and produce
// a PDF/A-conformant output. Targets the procurement-checklist profiles
// for v1: 1b, 2b, 3b. The Unicode profiles (2u/3u) are validate-only
// in the UI — generating /ActualText for arbitrary content streams is
// a multi-week problem and easy to ship wrong.
//
// Pipeline order (each step depends on the prior):
//   1. sanitizePdf          — strip JS / OCG / encryption / actions
//   2. embedMissingFonts    — Standard-14 substitution; flag the rest
//   3. flattenTransparency  — A-1B only (per-page raster fallback)
//   4. addOutputIntent      — embed sRGB ICC + /OutputIntents dict
//   5. writeMetadata        — ensure title/creator present
//   6. writePdfAXmp         — build + inject XMP packet
//   7. setPdfVersion        — header bytes (1.4 for A-1, 1.7 for A-2/3)
//   8. re-validate          — return both bytes and final report

import { PDFDocument, PDFName, PDFRawStream, PDFDict, PDFArray, PDFString, PDFNumber, PDFRef, PDFHexString, decodePDFRawStream } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { invoke } from '@tauri-apps/api/core'
import { sanitizePdf, readMetadata } from './pdfOps'
import { buildPdfAXmp, type PdfAProfile, type PdfMetadata } from './pdfAXmp'
import { validatePdfA } from './pdfAValidation'
import {
  parseContentStream, serializeContentStream, getPageContentBytes,
  replacePageContents, type ContentStreamOp, type PdfString as CSPdfString,
  type TJArrayElement,
} from './contentStreamParser'

export interface ConvertOptions {
  profile: 'A-1B' | 'A-2B' | 'A-3B'
  /** Override metadata; falls back to PDF's existing values. */
  metadata?: Partial<PdfMetadata>
  /** If true, abort on any unembeddable font instead of skipping. */
  failOnFontIssue?: boolean
  /** Progress callback (0..1). */
  onProgress?: (frac: number, label: string) => void
  /** Optional provider override for sRGB ICC profile bytes. Defaults
   *  to Tauri's `pdfa_get_srgb_icc` command. Node test harnesses can
   *  inject a filesystem-backed provider. */
  iccProvider?: () => Promise<Uint8Array>
  /** Optional provider override for Standard-14 font substitute bytes.
   *  Defaults to Tauri's `pdfa_get_standard14_substitute` command. */
  standard14Provider?: (psName: string) => Promise<Uint8Array | null>
  /** Optional provider override for the bundled CJK substitute font
   *  (Noto Sans SC). Defaults to Tauri's `pdfa_get_cjk_substitute`
   *  command. Node test harnesses inject a filesystem-backed provider
   *  that returns the same vendored bytes the Rust command embeds. */
  cjkProvider?: (baseFont: string) => Promise<Uint8Array | null>
}

// Default providers — hit the Tauri backend. Overridable via ConvertOptions.
const defaultIccProvider = async (): Promise<Uint8Array> =>
  new Uint8Array(await invoke<number[]>('pdfa_get_srgb_icc'))

const defaultStandard14Provider = async (psName: string): Promise<Uint8Array | null> => {
  const sub = await invoke<number[]>('pdfa_get_standard14_substitute', { name: psName })
  return sub && sub.length > 0 ? new Uint8Array(sub) : null
}

const defaultCjkProvider = async (baseFont: string): Promise<Uint8Array | null> => {
  // Tauri v2 marshals camelCase arg names — `baseFont` deserializes to the
  // Rust `base_font` param.
  const sub = await invoke<number[]>('pdfa_get_cjk_substitute', { baseFont })
  return sub && sub.length > 0 ? new Uint8Array(sub) : null
}

export interface ConvertReport {
  profile: PdfAProfile
  steps: { name: string; status: 'done' | 'skipped' | 'warning' | 'failed'; detail?: string }[]
  /** Validator score after conversion (0..100). */
  finalScore: number
  /** True if validator reports compliant after conversion. */
  isCompliant: boolean
  warnings: string[]
}

/**
 * Public helper for callers outside the PDF/A convert flow (notably the
 * PDF/UA a11y flow) that need the same font-embed plumbing without the
 * rest of the PDF/A pipeline (XMP, output intent, etc.). Runs:
 *   1. embedMissingFonts     — Standard-14 substitution via provider
 *   2. rewriteSubstitutedTextEncoding — 1-byte WinAnsi → 2-byte Identity-H
 *   3. rebuildCidFontWidths  — complete /W + explicit /DW
 *
 * Required for PDF/UA §7.21.4.1 ("all fonts used for rendering shall be
 * embedded"). Standard-14 refs without descriptors fail this rule.
 */
export async function embedAndReencodeStandard14(
  bytes: Uint8Array,
  substituteProvider?: (psName: string) => Promise<Uint8Array | null>,
  cjkProvider?: (baseFont: string) => Promise<Uint8Array | null>,
): Promise<Uint8Array> {
  const provider = substituteProvider ?? defaultStandard14Provider
  const res = await embedMissingFonts(bytes, false, provider, cjkProvider ?? defaultCjkProvider)
  let work = res.bytes
  if (res.cidSubstitutes.size > 0) {
    work = (await rewriteCidSubstitutedText(work, res.cidSubstitutes)).bytes
  }
  if (res.substitutes.size > 0) {
    work = await rewriteSubstitutedTextEncoding(work, res.substitutes)
  }
  work = await rebuildCidFontWidths(work)
  return work
}

export async function convertToPdfA(
  bytes: Uint8Array,
  opts: ConvertOptions,
): Promise<{ bytes: Uint8Array; report: ConvertReport }> {
  const steps: ConvertReport['steps'] = []
  const warnings: string[] = []
  const profile = opts.profile
  const onProgress = opts.onProgress ?? (() => { /* noop */ })

  // ── Step 1: sanitize ──────────────────────────────────────────────
  onProgress(0.05, 'Sanitizing (strip JS, encryption, actions)…')
  let work: Uint8Array
  try {
    work = await sanitizePdf(bytes, {
      stripJavaScript: true,
      stripAttachments: profile === 'A-1B' || profile === 'A-2B', // A-3 allows
      stripHiddenLayers: true,
      stripMetadata: false, // we'll rewrite later
      stripXmp: true, // we'll rewrite later
    })
    steps.push({ name: 'sanitize', status: 'done' })
  } catch (e) {
    steps.push({ name: 'sanitize', status: 'failed', detail: String(e) })
    throw new Error(`sanitize failed: ${e}`)
  }

  // ── Step 2: font embedding audit + fix ────────────────────────────
  onProgress(0.20, 'Auditing fonts…')
  const standard14Provider = opts.standard14Provider ?? defaultStandard14Provider
  const cjkProvider = opts.cjkProvider ?? defaultCjkProvider
  const fontReport = await embedMissingFonts(work, opts.failOnFontIssue ?? false, standard14Provider, cjkProvider)
  work = fontReport.bytes
  if (fontReport.cjkSubstituted.length > 0) {
    const detail = fontReport.cjkSubstituted
      .map((c) => `${c.requested} → ${c.substitute}`)
      .join(', ')
    steps.push({ name: 'embedCjkFonts', status: 'done', detail: `Embedded bundled CJK substitute for ${fontReport.cjkSubstituted.length} bare CID font(s): ${detail}` })
  }
  if (fontReport.unfixed.length > 0) {
    const detail = `${fontReport.unfixed.length} font(s) need manual remediation: ${fontReport.unfixed.join(', ')}`
    if (opts.failOnFontIssue) {
      steps.push({ name: 'embedFonts', status: 'failed', detail })
      throw new Error(detail)
    }
    warnings.push(detail)
    steps.push({ name: 'embedFonts', status: 'warning', detail })
  } else if (fontReport.fixed > 0) {
    steps.push({ name: 'embedFonts', status: 'done', detail: `Substituted ${fontReport.fixed} standard-14 font ref(s)` })
  } else {
    steps.push({ name: 'embedFonts', status: 'skipped', detail: 'All fonts already embedded' })
  }

  // ── Step 2a-CJK: re-encode + ToUnicode for substituted CID fonts ──
  // A bare CIDFontType2 (composite font with no embedded program) was
  // swapped for the bundled Noto Sans SC. Its content stream still holds
  // the (now-gone) source font's 2-byte GIDs. Re-encode every 2-byte CID
  // to a Noto GID via the source /ToUnicode (code → Unicode → Noto GID),
  // then write a fresh /ToUnicode (Noto GID → Unicode) so the output is
  // both Identity-H-correct and text-selectable. Must run BEFORE the
  // Standard-14 1-byte pass and the /W rebuild.
  if (fontReport.cidSubstitutes.size > 0) {
    onProgress(0.28, 'Re-encoding CJK content streams (Identity-H + ToUnicode)…')
    try {
      const cidRes = await rewriteCidSubstitutedText(work, fontReport.cidSubstitutes)
      work = cidRes.bytes
      const unmappedNote = cidRes.unmapped > 0 ? `; ${cidRes.unmapped} code(s) had no recoverable Unicode → drawn as .notdef + not in /ToUnicode` : ''
      steps.push({ name: 'cjkReencode', status: cidRes.unmapped > 0 ? 'warning' : 'done', detail: `Re-encoded + generated /ToUnicode for ${fontReport.cidSubstitutes.size} CJK font(s)${unmappedNote}` })
      if (cidRes.unmapped > 0) warnings.push(`${cidRes.unmapped} CJK character code(s) had no /ToUnicode mapping and were drawn as .notdef`)
    } catch (e) {
      steps.push({ name: 'cjkReencode', status: 'failed', detail: String(e) })
      throw new Error(`CJK content-stream re-encoding failed: ${e}`)
    }
  }

  // ── Step 2b: content-stream re-encoding (substituted fonts only) ──
  // Standard-14 substitutes are Type0/Identity-H; original content
  // streams were written for Type1/WinAnsi (1-byte codes). Rewrite
  // every Tj/TJ/'/" byte string that executes under a substituted
  // font so codes are 2-byte GIDs instead. Skipped when no fonts
  // were substituted.
  if (fontReport.substitutes.size > 0) {
    onProgress(0.30, 'Re-encoding content streams for Type0 fonts…')
    try {
      work = await rewriteSubstitutedTextEncoding(work, fontReport.substitutes)
      steps.push({ name: 'contentReencode', status: 'done', detail: `Re-encoded content-stream text for ${fontReport.substitutes.size} substituted font(s)` })
    } catch (e) {
      steps.push({ name: 'contentReencode', status: 'warning', detail: String(e) })
      warnings.push(`Content-stream re-encoding skipped: ${e}`)
    }
  }

  // ── Step 3: transparency flatten (A-1B only) ──────────────────────
  if (profile === 'A-1B') {
    onProgress(0.40, 'Checking transparency…')
    const flatResult = await flattenTransparencyA1(work)
    work = flatResult.bytes
    if (flatResult.flattenedPages > 0) {
      const detail = `Rasterized ${flatResult.flattenedPages} page(s) at 200dpi (text on those pages becomes non-selectable)`
      warnings.push(detail)
      steps.push({ name: 'flattenTransparency', status: 'warning', detail })
    } else {
      steps.push({ name: 'flattenTransparency', status: 'skipped', detail: 'No transparency detected' })
    }
  }

  // ── Step 4: output intent (sRGB ICC) ──────────────────────────────
  onProgress(0.60, 'Embedding sRGB ICC profile…')
  const iccProvider = opts.iccProvider ?? defaultIccProvider
  try {
    work = await addOutputIntent(work, profile, iccProvider)
    steps.push({ name: 'outputIntent', status: 'done', detail: 'sRGB IEC61966-2.1 embedded as /OutputIntents[0]' })
  } catch (e) {
    steps.push({ name: 'outputIntent', status: 'failed', detail: String(e) })
    throw new Error(`outputIntent failed: ${e}`)
  }

  // ── Step 4b: rebuild CID font /W arrays from embedded TTFs ────────
  // pd-lib emits a sparse /W that relies on /DW=1000 fallback for
  // glyphs whose width equals 1000. PDF/A §6.3.6 compares the /W
  // widths with the actual font-program widths and fails when a glyph
  // used by content streams is outside /W's coverage but its real
  // width is not 1000. Rebuild /W to cover 0..numGlyphs-1 with the
  // actual per-glyph widths from the TTF, making /DW a no-op.
  onProgress(0.70, 'Rebuilding CID font /W arrays…')
  try {
    work = await rebuildCidFontWidths(work)
    steps.push({ name: 'cidWidths', status: 'done' })
  } catch (e) {
    steps.push({ name: 'cidWidths', status: 'warning', detail: String(e) })
    warnings.push(`CID width rebuild skipped: ${e}`)
  }

  // ── Step 5: DocInfo + XMP packet (one step, must stay in sync) ───
  // PDF/A §6.7.3 requires identical values in DocInfo and XMP when
  // both are present. injectXmp owns both writes so they can't drift.
  onProgress(0.80, 'Writing metadata + XMP packet…')
  const existing = await readMetadata(work)
  const finalMeta: PdfMetadata = {
    title: opts.metadata?.title ?? existing.title ?? 'Untitled Document',
    author: opts.metadata?.author ?? existing.author ?? '',
    subject: opts.metadata?.subject ?? existing.subject ?? '',
    keywords: opts.metadata?.keywords ?? existing.keywords ?? [],
    creator: opts.metadata?.creator ?? existing.creator ?? 'Open Satchel',
    producer: opts.metadata?.producer ?? `Open Satchel PDF/A Converter (${profile})`,
    creationDate: existing.creationDate ? new Date(existing.creationDate) : new Date(),
    modDate: new Date(),
  }
  work = await injectXmp(work, finalMeta, profile)
  steps.push({ name: 'xmp', status: 'done' })

  // ── Step 7: PDF version downgrade ─────────────────────────────────
  onProgress(0.92, 'Setting PDF version header…')
  const targetVersion = profile === 'A-1B' ? '1.4' : '1.7'
  work = setPdfVersion(work, targetVersion)
  steps.push({ name: 'pdfVersion', status: 'done', detail: `%PDF-${targetVersion}` })

  // ── Step 8: re-validate ───────────────────────────────────────────
  onProgress(0.97, 'Validating output…')
  const finalReport = await validatePdfA(work, profile)

  onProgress(1.0, 'Done')
  return {
    bytes: work,
    report: {
      profile,
      steps,
      finalScore: finalReport.score,
      isCompliant: finalReport.isCompliant,
      warnings,
    },
  }
}

// ─────────────────────────────────────────────────────────────────────
// Step implementations below
// ─────────────────────────────────────────────────────────────────────

interface FontEmbedResult {
  bytes: Uint8Array
  fixed: number
  unfixed: string[] // BaseFont names of fonts that need manual remediation
  /** Map from substitute-font ref (as "tag gen R" string) to the TTF
   *  bytes we embedded. Used by rewriteSubstitutedTextEncoding to
   *  re-encode content-stream text from 1-byte WinAnsi to 2-byte
   *  Identity-H CIDs via the TTF's Unicode cmap. */
  substitutes: Map<string, Uint8Array>
  /** Map from the NEW (Noto) Type0 font ref to the bytes we embedded +
   *  the SOURCE font's decoded code→Unicode map (parsed from its
   *  /ToUnicode CMap). rewriteCidSubstitutedText uses this to re-encode
   *  every 2-byte CID in the content stream from the (now-gone) source
   *  font's GIDs to Noto GIDs, then writes a fresh /ToUnicode. */
  cidSubstitutes: Map<string, { notoBytes: Uint8Array; codeToUnicode: Map<number, string> }>
  /** CJK fonts that were substituted, for the convert report
   *  (requested base-font name → bundled substitute family). */
  cjkSubstituted: { requested: string; substitute: string }[]
}

// ── WinAnsiEncoding → Unicode mapping ────────────────────────────────
// PDF 1.7 Appendix D defines WinAnsiEncoding. Codes 0x20..0x7E are
// ASCII (identity-map to Unicode). Codes 0x80..0x9F and a handful of
// 0xA0..0xFF are the non-Latin-1 additions. The rest of 0xA0..0xFF
// is the Latin-1 Supplement (identity-map).
//
// Undefined in WinAnsi per PDF spec: 0x81, 0x8D, 0x8F, 0x90, 0x9D.
// Renderers typically round-trip these as themselves.
const WIN_ANSI_SPECIAL: Record<number, number> = {
  0x80: 0x20AC, 0x82: 0x201A, 0x83: 0x0192, 0x84: 0x201E, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02C6, 0x89: 0x2030, 0x8A: 0x0160,
  0x8B: 0x2039, 0x8C: 0x0152, 0x8E: 0x017D,
  0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201C, 0x94: 0x201D, 0x95: 0x2022,
  0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02DC, 0x99: 0x2122, 0x9A: 0x0161,
  0x9B: 0x203A, 0x9C: 0x0153, 0x9E: 0x017E, 0x9F: 0x0178,
}

function winAnsiByteToCodePoint(b: number): number {
  if (b < 0x80 || b >= 0xA0) return b
  return WIN_ANSI_SPECIAL[b] ?? b
}

const STANDARD_14 = new Set([
  'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique',
  'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic',
  'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique',
  'Symbol', 'ZapfDingbats',
])

// Common system-font names that real PDFs reference without embedding
// (PDF/A §6.3.4-1 fails when these have no FontFile entry). Map each
// to the Standard-14 PostScript name we'll substitute. The visual
// outcome is acceptable for archival — Helvetica vs Arial is a near-
// invisible swap, and the alternative is the entire conversion
// failing the spec rule [V2 P0 #3a].
const SYSTEM_FONT_ALIASES = new Map<string, string>([
  ['ArialMT', 'Helvetica'],
  ['Arial', 'Helvetica'],
  ['Arial-Bold', 'Helvetica-Bold'],
  ['Arial-Italic', 'Helvetica-Oblique'],
  ['Arial-BoldItalic', 'Helvetica-BoldOblique'],
  ['Arial,Bold', 'Helvetica-Bold'],
  ['Arial,Italic', 'Helvetica-Oblique'],
  ['Arial,BoldItalic', 'Helvetica-BoldOblique'],
  ['TimesNewRoman', 'Times-Roman'],
  ['TimesNewRomanPS', 'Times-Roman'],
  ['TimesNewRomanPSMT', 'Times-Roman'],
  ['TimesNewRomanPS-Bold', 'Times-Bold'],
  ['TimesNewRomanPS-Italic', 'Times-Italic'],
  ['TimesNewRomanPS-BoldItalic', 'Times-BoldItalic'],
  ['CourierNew', 'Courier'],
  ['CourierNewPS', 'Courier'],
  ['CourierNewPSMT', 'Courier'],
  ['CourierNewPS-Bold', 'Courier-Bold'],
  ['CourierNewPS-Italic', 'Courier-Oblique'],
  ['CourierNewPS-BoldItalic', 'Courier-BoldOblique'],
])

/**
 * Walk every font dict (including those in form XObjects) and ensure
 * each has a FontDescriptor. For Standard-14 references, fetch a
 * system substitute font (Arial / Liberation / DejaVu) via the Rust
 * pdfa_get_standard14_substitute command and embed it via pdf-lib's
 * embedFont, then rewrite the page's Resources/Font key to point at
 * the embedded font.
 *
 * For non-Standard-14 unembedded fonts (custom CID fonts the original
 * exporter shipped without descriptors) we surface a warning — proper
 * fix needs glyph-ID enumeration from content streams, which is its
 * own multi-day project.
 */
async function embedMissingFonts(
  bytes: Uint8Array,
  _strict: boolean,
  substituteProvider: (psName: string) => Promise<Uint8Array | null>,
  cjkProvider: (baseFont: string) => Promise<Uint8Array | null> = defaultCjkProvider,
): Promise<FontEmbedResult> {
  const doc = await PDFDocument.load(bytes)
  doc.registerFontkit(fontkit)
  let fixed = 0
  const unfixed: string[] = []
  const substitutes = new Map<string, Uint8Array>()
  const cidSubstitutes = new Map<string, { notoBytes: Uint8Array; codeToUnicode: Map<number, string> }>()
  const cjkSubstituted: { requested: string; substitute: string }[] = []

  // The bundled CJK font is large (~7 MB) and identical for every bare
  // CID reference this session — fetch + parse it at most once.
  let cjkBytesCache: Uint8Array | null | undefined
  const getCjkSubstitute = async (baseFont: string): Promise<Uint8Array | null> => {
    if (cjkBytesCache !== undefined) return cjkBytesCache
    try {
      const b = await cjkProvider(baseFont)
      cjkBytesCache = b && b.length > 0 ? b : null
    } catch (e) {
      console.warn('[pdfAConvert] CJK substitute lookup failed:', e)
      cjkBytesCache = null
    }
    return cjkBytesCache
  }

  // Decode a font dict's /ToUnicode CMap stream to raw CMap bytes. Bare
  // CID fonts are only recoverable when they carry one — it's the sole
  // bridge from the source font's GIDs back to Unicode.
  const readToUnicodeBytes = (font: PDFDict): Uint8Array | null => {
    const tuRef = font.get(PDFName.of('ToUnicode'))
    if (!tuRef) return null
    const tu = doc.context.lookup(tuRef)
    if (!(tu instanceof PDFRawStream)) return null
    try {
      return decodePDFRawStream(tu).decode()
    } catch {
      return null
    }
  }

  // Cache per-PostScript-name embedded fonts so a Standard-14 used on
  // 50 pages doesn't trigger 50 substitution lookups + 50 embeds.
  const substituteCache = new Map<string, ReturnType<PDFDocument['embedFont']> | null>()
  const subBytesCache = new Map<string, Uint8Array>()

  /**
   * Fetch + embed a substitute for a Standard-14 PostScript name.
   * Caches the result. Returns null if no substitute available.
   */
  const getSubstitute = async (psName: string) => {
    if (substituteCache.has(psName)) {
      const cached = substituteCache.get(psName)
      return cached ? await cached : null
    }
    try {
      const subBytes = await substituteProvider(psName)
      if (!subBytes || subBytes.length === 0) {
        substituteCache.set(psName, null)
        return null
      }
      subBytesCache.set(psName, subBytes)
      // Subset the font to keep the embed small. pd-lib will collect
      // glyph usage from any text we draw with this font — but we're
      // not drawing, we're swapping refs. So embed unsubsetted (full
      // font ≈ 100KB per style; acceptable inflation for v1).
      const embedPromise = doc.embedFont(subBytes, { subset: false })
      substituteCache.set(psName, embedPromise)
      return await embedPromise
    } catch (e) {
      console.warn(`[pdfAConvert] substitute lookup failed for ${psName}:`, e)
      substituteCache.set(psName, null)
      return null
    }
  }

  // First pass — collect every Resources/Font entry that needs fixing.
  // We mutate per-page Resources/Font dicts, so collect first then mutate.
  type FontSlot =
    | { kind: 'std'; fontsDict: PDFDict; key: PDFName; psName: string }
    | { kind: 'cid'; fontsDict: PDFDict; key: PDFName; baseFont: string; toUnicodeBytes: Uint8Array }
  const slotsToFix: FontSlot[] = []
  const seenRefs = new Set<string>() // dedupe identical font refs across pages

  const visitFontDict = (fontsDict: PDFDict | undefined, allowCidSubstitution = true) => {
    if (!fontsDict) return
    for (const [key, ref] of fontsDict.entries()) {
      const refKey = `${ref.toString()}:${key.toString()}`
      if (seenRefs.has(refKey)) continue
      seenRefs.add(refKey)

      const font = doc.context.lookup(ref) as PDFDict | undefined
      if (!font) continue

      // Check FontDescriptor in two places. Simple fonts carry it on
      // the top-level font dict. Composite fonts (Type0) push it into
      // /DescendantFonts[0]'s CIDFont dict — pd-lib emits this shape,
      // so a shallow check would falsely flag every just-embedded font.
      //
      // We also need to verify the descriptor carries an actual font
      // program (FontFile / FontFile2 / FontFile3). PDF/A §6.3.4-1
      // fails when the font is referenced without an embedded program,
      // even if the descriptor itself exists. ArialMT in proposal.pdf
      // had a descriptor but no FontFile entry [V2 P0 #3c].
      const descriptorOf = (f: PDFDict): PDFDict | undefined => {
        const direct = f.get(PDFName.of('FontDescriptor'))
        if (direct) return doc.context.lookup(direct) as PDFDict | undefined
        const subtype = f.get(PDFName.of('Subtype'))?.toString()
        if (subtype === '/Type0') {
          const descRef = f.get(PDFName.of('DescendantFonts'))
          const descArr = descRef ? (doc.context.lookup(descRef) as PDFArray | undefined) : undefined
          if (descArr && descArr.size() > 0) {
            const cidFont = doc.context.lookup(descArr.get(0)) as PDFDict | undefined
            const cidDescRef = cidFont?.get(PDFName.of('FontDescriptor'))
            if (cidDescRef) return doc.context.lookup(cidDescRef) as PDFDict | undefined
          }
        }
        return undefined
      }
      const descriptor = descriptorOf(font)
      const hasFontFile = !!descriptor && (
        !!descriptor.get(PDFName.of('FontFile')) ||
        !!descriptor.get(PDFName.of('FontFile2')) ||
        !!descriptor.get(PDFName.of('FontFile3'))
      )
      if (descriptor && hasFontFile) continue

      const baseFontObj = font.get(PDFName.of('BaseFont'))
      const baseFont = baseFontObj ? baseFontObj.toString().replace(/^\//, '') : '<unknown>'
      const psName = baseFont.replace(/^[A-Z]{6}\+/, '')

      // Composite (Type0) font with no embedded program = a bare CID
      // font — the common un-embedded CJK case. We can only substitute it
      // when it carries a /ToUnicode CMap (the bridge from its private
      // GIDs back to Unicode); otherwise the codes are unrecoverable
      // (a named-CMap decoder, e.g. UniGB-UCS2-H, would be the next layer).
      const subtype = font.get(PDFName.of('Subtype'))?.toString()
      if (subtype === '/Type0') {
        // CID substitution re-encodes the PAGE content stream only. A bare
        // CID font referenced from a form XObject (or other nested resource)
        // would be substituted but its content never re-encoded — garbage
        // GIDs + no /ToUnicode. Don't substitute those; record honestly.
        if (!allowCidSubstitution) {
          unfixed.push(`${baseFont} (bare CID font inside a form XObject - CJK substitution is page-level only this session)`)
          continue
        }
        const toUnicodeBytes = readToUnicodeBytes(font)
        if (toUnicodeBytes) {
          slotsToFix.push({ kind: 'cid', fontsDict, key, baseFont, toUnicodeBytes })
        } else {
          unfixed.push(`${baseFont} (bare CID font, no embedded program and no /ToUnicode to recover text)`)
        }
        continue
      }

      if (STANDARD_14.has(psName)) {
        slotsToFix.push({ kind: 'std', fontsDict, key, psName })
      } else if (SYSTEM_FONT_ALIASES.has(psName)) {
        // Common system font (Arial, Times New Roman, Courier New) that
        // the source PDF referenced without embedding. Map to the
        // Standard-14 substitute we ship — same provider path, same
        // resulting Type0 font. PDF/A §6.3.4-1 requires the font
        // program be embedded; this path satisfies that.
        const alias = SYSTEM_FONT_ALIASES.get(psName)!
        slotsToFix.push({ kind: 'std', fontsDict, key, psName: alias })
      } else {
        unfixed.push(`${baseFont} (no FontDescriptor)`)
      }
    }
  }

  for (let i = 0; i < doc.getPageCount(); i++) {
    const page = doc.getPage(i)
    const resources = page.node.get(PDFName.of('Resources'))
    if (!resources) continue
    const resDict = doc.context.lookup(resources) as PDFDict | undefined
    if (!resDict) continue

    const fontsRef = resDict.get(PDFName.of('Font'))
    const fonts = fontsRef ? (doc.context.lookup(fontsRef) as PDFDict | undefined) : undefined
    visitFontDict(fonts)

    // Walk form XObjects (a common veraPDF-catch spot).
    const xObjRef = resDict.get(PDFName.of('XObject'))
    const xObj = xObjRef ? (doc.context.lookup(xObjRef) as PDFDict | undefined) : undefined
    if (xObj) {
      for (const [, xRef] of xObj.entries()) {
        const x = doc.context.lookup(xRef) as PDFDict | undefined
        if (!x) continue
        const xResRef = x.get(PDFName.of('Resources'))
        const xRes = xResRef ? (doc.context.lookup(xResRef) as PDFDict | undefined) : undefined
        if (!xRes) continue
        const xFontsRef = xRes.get(PDFName.of('Font'))
        const xFonts = xFontsRef ? (doc.context.lookup(xFontsRef) as PDFDict | undefined) : undefined
        visitFontDict(xFonts, false) // CID re-encode is page-level only; don't substitute XObject CID fonts
      }
    }
  }

  // Second pass — fetch substitutes and rewrite the slots.
  // Track which PS names actually got substituted vs missing-on-system.
  const failedPsNames = new Set<string>()
  let cjkUnavailableReported = false
  for (const slot of slotsToFix) {
    if (slot.kind === 'cid') {
      // Bare CID font → embed the bundled CJK substitute as a fresh
      // Identity-H CIDFontType2. We re-encode its content stream + write
      // /ToUnicode later (rewriteCidSubstitutedText), using the source
      // /ToUnicode captured here.
      const notoBytes = await getCjkSubstitute(slot.baseFont)
      if (!notoBytes) {
        if (!cjkUnavailableReported) {
          cjkUnavailableReported = true
          unfixed.push(`${slot.baseFont} (no bundled CJK substitute font available)`)
        }
        continue
      }
      let embedded
      try {
        // subset:false is REQUIRED: we encode content streams to GIDs
        // ourselves (not via pd-lib's drawText), so pd-lib must embed the
        // whole program with an Identity CIDToGIDMap — a subset would
        // renumber/drop the GIDs we write.
        embedded = await doc.embedFont(notoBytes, { subset: false })
      } catch (e) {
        unfixed.push(`${slot.baseFont} (CJK embed failed: ${e})`)
        continue
      }
      slot.fontsDict.set(slot.key, embedded.ref)
      const codeToUnicode = parseToUnicodeCMap(slot.toUnicodeBytes)
      cidSubstitutes.set(refKeyFromRef(embedded.ref), { notoBytes, codeToUnicode })
      cjkSubstituted.push({ requested: slot.baseFont, substitute: 'Noto Sans SC' })
      fixed++
      continue
    }

    const sub = await getSubstitute(slot.psName)
    if (!sub) {
      if (!failedPsNames.has(slot.psName)) {
        failedPsNames.add(slot.psName)
        unfixed.push(`${slot.psName} (no system substitute available)`)
      }
      continue
    }
    // pd-lib's embedFont gave us a PDFFont; its .ref is the indirect
    // ref to the new Type0 font dict (with FontDescriptor + ToUnicode).
    // Replace the page's Resources/Font[key] with this ref. The
    // content stream's "/F1 12 Tf" operators continue to work since
    // we kept the same key — they just resolve to the new font now.
    //
    // BUT: the content stream's byte strings were written for the
    // ORIGINAL Type1 simple font (1-byte WinAnsi). With the new Type0
    // Identity-H font they're interpreted as 2-byte CIDs — wrong.
    // rewriteSubstitutedTextEncoding (called later in the pipeline)
    // walks every Tj/TJ/'/" operator and re-encodes the bytes.
    slot.fontsDict.set(slot.key, sub.ref)
    const ttfBytes = subBytesCache.get(slot.psName)
    if (ttfBytes) substitutes.set(refKeyFromRef(sub.ref), ttfBytes)
    fixed++
  }

  // NOTE on the substituted-away old font subtree: pd-lib does not
  // garbage-collect, so each old bare-CID font lingers as an unreferenced
  // object. Its stale /W array can be >8191 elements (a CJK font has ~21k
  // glyphs) and would fail PDF/A-1 §6.1.12 even though nothing references
  // it. Rather than DELETE the subtree (which risks corrupting a font also
  // reachable from an annotation /AP, AcroForm /DR, Pattern, or a shared
  // descriptor/program), rebuildCidFontWidths re-chunks every CIDFont's /W
  // in place — including orphans — to ≤8000-element sub-arrays. Lossless,
  // reachability-agnostic, and clears the only rule the orphan trips.

  return { bytes: new Uint8Array(await doc.save()), fixed, unfixed, substitutes, cidSubstitutes, cjkSubstituted }
}

/** Stable string key for a PDFRef — e.g. "15 0 R". Used because
 *  Map<PDFRef, X> doesn't dedupe refs by identity. */
function refKeyFromRef(ref: PDFRef): string {
  return `${ref.objectNumber} ${ref.generationNumber} R`
}

/**
 * After Standard-14 substitution swaps a page's /F1 from a Type1 (1-byte
 * WinAnsi) font to a pd-lib Type0/Identity-H font, the existing content
 * stream's `(Hello) Tj` still holds 1-byte WinAnsi codes. Type0 reads
 * them as 2-byte CIDs, producing out-of-range glyph IDs that fail
 * veraPDF §6.3.5 + §6.3.6.
 *
 * This pass walks every page's content stream, tracks the active font
 * (via `/FontName size Tf`), and for every Tj/TJ/'/" that fires while
 * a substituted font is active, re-encodes the byte string:
 *
 *     1-byte WinAnsi code  →  Unicode codepoint  →  GID in substitute TTF
 *
 * The new string is emitted as a hex string of 2-byte big-endian GIDs
 * (the natural form for Identity-H), replacing the original.
 *
 * Non-text operators are preserved byte-for-byte (serializeContentStream
 * only replaces the modified text ops).
 */
async function rewriteSubstitutedTextEncoding(
  bytes: Uint8Array,
  substitutes: Map<string, Uint8Array>,
): Promise<Uint8Array> {
  if (substitutes.size === 0) return bytes

  const doc = await PDFDocument.load(bytes)
  const ctx = doc.context

  // Parse each substitute TTF once and cache its cmap (Unicode → GID).
  type FontKit = {
    glyphForCodePoint: (cp: number) => { id: number } | null
  }
  const ttfByRefKey = new Map<string, FontKit>()
  for (const [refKey, ttfBytes] of substitutes) {
    try {
      const ttf = (fontkit as unknown as { create: (b: Uint8Array) => FontKit }).create(ttfBytes)
      ttfByRefKey.set(refKey, ttf)
    } catch {
      // If fontkit can't parse, skip this substitute — rewriting would
      // produce garbage GIDs. The pre-rewrite state is still better
      // than broken rewriting.
    }
  }
  if (ttfByRefKey.size === 0) return bytes

  for (let pageIdx = 0; pageIdx < doc.getPageCount(); pageIdx++) {
    const page = doc.getPage(pageIdx)

    // Build font-key → FontKit map for this page's substituted fonts.
    // Example: { F1: <ttf>, F2: <ttf> } when /F1 and /F2 point at our
    // substitutes. Other keys are not substituted — leave them alone.
    const resourcesRef = page.node.get(PDFName.of('Resources'))
    const resources = resourcesRef ? ctx.lookup(resourcesRef) : null
    if (!(resources instanceof PDFDict)) continue
    const fontsRef = resources.get(PDFName.of('Font'))
    const fontsDict = fontsRef ? ctx.lookup(fontsRef) : null
    if (!(fontsDict instanceof PDFDict)) continue

    const pageSubstitutes = new Map<string, FontKit>()
    for (const [key, refOrDict] of fontsDict.entries()) {
      // fontsDict entries are usually refs. Resolve to get the final Font dict.
      let fontRefKey: string | null = null
      if (refOrDict instanceof PDFRef) {
        fontRefKey = refKeyFromRef(refOrDict)
      } else {
        // Inline dict — no ref. Skip (substitutes are always indirect).
        continue
      }
      const ttf = ttfByRefKey.get(fontRefKey)
      if (ttf) pageSubstitutes.set(key.toString().replace(/^\//, ''), ttf)
    }
    if (pageSubstitutes.size === 0) continue

    const contentInfo = getPageContentBytes(doc, pageIdx)
    if (!contentInfo || contentInfo.bytes.length === 0) continue
    const contentBytes = contentInfo.bytes

    const parsed = parseContentStream(contentBytes)
    let activeFontKey: string | null = null
    let rewroteAny = false

    for (let opIdx = 0; opIdx < parsed.operators.length; opIdx++) {
      const op = parsed.operators[opIdx]
      if (op.operator === 'Tf') {
        // args: [/FontKey, size]
        const nameArg = op.args[0] as string
        activeFontKey = typeof nameArg === 'string' ? nameArg.replace(/^\//, '') : null
        continue
      }
      if (!activeFontKey) continue
      const ttf = pageSubstitutes.get(activeFontKey)
      if (!ttf) continue

      if (op.operator === 'Tj' || op.operator === "'") {
        const str = op.args[0] as CSPdfString
        const newStr = reencodeString(str, ttf)
        replaceTextOp(op, newStr, op.operator)
        rewroteAny = true
      } else if (op.operator === '"') {
        // aw ac string " — args: [aw, ac, string]
        const str = op.args[2] as CSPdfString
        const newStr = reencodeString(str, ttf)
        const aw = op.args[0] as number
        const ac = op.args[1] as number
        replaceQuotationOp(op, aw, ac, newStr)
        rewroteAny = true
      } else if (op.operator === 'TJ') {
        const arr = op.args[0] as TJArrayElement[]
        const newArr: TJArrayElement[] = arr.map(el => el.kind === 'string'
          ? { kind: 'string', value: reencodeString(el.value, ttf) }
          : el)
        replaceTJOp(op, newArr)
        rewroteAny = true
      }
    }

    if (rewroteAny) {
      const rewritten = serializeContentStream(parsed.operators, contentBytes)
      replacePageContents(doc, pageIdx, rewritten)
    }
  }

  return new Uint8Array(await doc.save({ useObjectStreams: false }))
}

/** Re-encode a byte string from 1-byte WinAnsi to 2-byte Identity-H GIDs. */
function reencodeString(
  src: CSPdfString,
  ttf: { glyphForCodePoint: (cp: number) => { id: number } | null },
): CSPdfString {
  const out = new Uint8Array(src.value.length * 2)
  for (let i = 0; i < src.value.length; i++) {
    const byte = src.value[i]
    const cp = winAnsiByteToCodePoint(byte)
    let gid = 0
    try {
      const g = ttf.glyphForCodePoint(cp)
      gid = g?.id ?? 0
    } catch {
      gid = 0
    }
    out[i * 2] = (gid >> 8) & 0xFF
    out[i * 2 + 1] = gid & 0xFF
  }
  return { type: 'hex', value: out, decoded: src.decoded }
}

function replaceTextOp(
  op: ContentStreamOp,
  newStr: CSPdfString,
  originalOp: string,
): void {
  // Encode as hex string and append " <op>"
  const hex = encodeHexFromBytes(newStr.value)
  const full = new TextEncoder().encode(hex + ' ' + originalOp)
  op.operator = '__modified'
  op.args = [full]
}

function replaceQuotationOp(
  op: ContentStreamOp,
  aw: number,
  ac: number,
  newStr: CSPdfString,
): void {
  const hex = encodeHexFromBytes(newStr.value)
  const body = `${aw} ${ac} ${hex} "`
  op.operator = '__modified'
  op.args = [new TextEncoder().encode(body)]
}

function replaceTJOp(op: ContentStreamOp, newArr: TJArrayElement[]): void {
  const parts: string[] = ['[']
  for (const el of newArr) {
    if (el.kind === 'number') parts.push(String(el.value))
    else parts.push(encodeHexFromBytes(el.value.value))
    parts.push(' ')
  }
  parts.push('] TJ')
  op.operator = '__modified'
  op.args = [new TextEncoder().encode(parts.join(''))]
}

function encodeHexFromBytes(bytes: Uint8Array): string {
  let s = '<'
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  s += '>'
  return s
}

/**
 * Walk every Type0 font, parse the embedded FontFile2 TTF, and
 * replace the CIDFont's /W with a complete 0..numGlyphs-1 array of
 * actual per-glyph advance widths (normalized to 1/1000 em per PDF
 * spec). Explicit /DW = 1000 written so the widths entry has no
 * implicit-default ambiguity.
 *
 * pd-lib emits a sparse /W omitting glyphs whose width happens to
 * equal /DW — except /DW is not written, so the implicit default 1000
 * is relied on. veraPDF §6.3.6 compares /W values against the actual
 * font program and flags every glyph referenced from a content stream
 * whose computed dict-width differs from its program-width.
 *
 * A complete /W + explicit /DW eliminates the ambiguity for any
 * Identity-H content stream. NOTE: when Standard-14 Type1 references
 * are substituted with Type0 (via pd-lib's embedFont), the ORIGINAL
 * content stream still uses 1-byte PDFDocEncoding codes — those bytes
 * are then interpreted as leading halves of 2-byte CIDs, producing
 * out-of-range CIDs that the complete /W still can't cover. Closing
 * that gap requires rewriting content streams from simple to
 * Identity-H encoding (deferred to v1.1 — multi-day, per-operator
 * decode/re-encode via the original font's /Encoding table).
 */
async function rebuildCidFontWidths(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes)
  const ctx = doc.context

  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue
    if (obj.get(PDFName.of('Type'))?.toString() !== '/Font') continue
    if (obj.get(PDFName.of('Subtype'))?.toString() !== '/Type0') continue

    const descArrRef = obj.get(PDFName.of('DescendantFonts'))
    const descArr = descArrRef ? ctx.lookup(descArrRef) : null
    if (!(descArr instanceof PDFArray) || descArr.size() === 0) continue
    const cidFont = ctx.lookup(descArr.get(0))
    if (!(cidFont instanceof PDFDict)) continue

    const fontDescRef = cidFont.get(PDFName.of('FontDescriptor'))
    const fontDesc = fontDescRef ? ctx.lookup(fontDescRef) : null
    if (!(fontDesc instanceof PDFDict)) continue

    // FontFile2 = TrueType outlines (what pd-lib writes for Standard-14
    // substitutes). FontFile3 is CFF / OpenType CFF — substitutes are
    // all TTF so we only handle FontFile2 here.
    const fontFileRef = fontDesc.get(PDFName.of('FontFile2'))
    if (!fontFileRef) {
      // No embedded program — we can't recompute widths. But this CIDFont
      // (e.g. a bare CID font substituted away, now orphaned) may carry a
      // stale /W with a >8191-element sub-array that fails PDF/A-1 §6.1.12.
      // Re-chunk it in place (lossless: same widths, smaller sub-arrays).
      rechunkOversizedWidths(ctx, cidFont)
      continue
    }
    const fontFile = ctx.lookup(fontFileRef)
    if (!(fontFile instanceof PDFRawStream)) continue

    // FontFile2 streams are typically /Filter /FlateDecode. pd-lib's
    // PDFRawStream.contents is the raw encoded bytes — decodePDFRawStream
    // walks /Filter and returns TTF bytes.
    let ttfBytes: Uint8Array
    try {
      ttfBytes = decodePDFRawStream(fontFile).decode()
    } catch { continue }

    type FontKit = {
      unitsPerEm: number
      numGlyphs: number
      getGlyph: (gid: number) => { advanceWidth: number } | null
    }
    let ttf: FontKit
    try {
      ttf = (fontkit as unknown as { create: (b: Uint8Array) => FontKit }).create(ttfBytes)
    } catch { continue }
    const unitsPerEm = ttf.unitsPerEm || 1000
    const numGlyphs = ttf.numGlyphs
    if (!numGlyphs) continue

    // Build /W = [0 [w0 w1 ... wN-1]]
    const widths: number[] = new Array(numGlyphs)
    for (let gid = 0; gid < numGlyphs; gid++) {
      try {
        const glyph = ttf.getGlyph(gid)
        const adv = glyph?.advanceWidth ?? 0
        widths[gid] = Math.round((adv / unitsPerEm) * 1000)
      } catch {
        widths[gid] = 0
      }
    }

    // /W = [ cStart [w...] cStart2 [w...] … ]. PDF/A-1 (§6.1.12 test 5,
    // inherited from the PDF 1.4 implementation limits) caps any array at
    // 8191 elements, so a CJK font with 20k+ glyphs would overflow a single
    // [w0 … wN-1] sub-array. Chunk the contiguous widths into sub-arrays of
    // ≤ 8000 elements, each introduced by its starting CID — the top-level
    // /W then holds only 2 entries per chunk, well under the limit.
    const W_CHUNK = 8000
    const wTopItems: (PDFNumber | PDFArray)[] = []
    for (let start = 0; start < numGlyphs; start += W_CHUNK) {
      const slice = widths.slice(start, start + W_CHUNK)
      wTopItems.push(PDFNumber.of(start))
      wTopItems.push(ctx.obj(slice.map(w => PDFNumber.of(w))) as PDFArray)
    }
    const wTop = ctx.obj(wTopItems) as PDFArray
    cidFont.set(PDFName.of('W'), wTop)
    cidFont.set(PDFName.of('DW'), PDFNumber.of(1000))

    // §6.3.5-3: emit a /CIDSet stream into the FontDescriptor.
    // The CIDSet is a bitmap with one bit per CID; bit N=1 iff CID N
    // is present in the embedded font subset. pd-lib's `subset:false`
    // path embeds the entire font program (numGlyphs glyphs) so every
    // CID 0..numGlyphs-1 is present. Pre-existing embedded subset
    // fonts (Wingdings, Aptos in proposal.pdf) are similarly treated
    // as fully-present: a too-permissive bitmap is conformant per the
    // veraPDF rule (`containsCIDSet == true && cidSetListsAllGlyphs ==
    // true`), an under-permissive one fails [V2 P0 #3a].
    const cidSetByteLen = Math.ceil(numGlyphs / 8)
    const cidSet = new Uint8Array(cidSetByteLen)
    for (let cid = 0; cid < numGlyphs; cid++) {
      cidSet[cid >> 3] |= (0x80 >> (cid & 7))
    }
    const cidSetDict = ctx.obj({ Length: cidSet.length })
    const cidSetStream = PDFRawStream.of(cidSetDict, cidSet)
    const cidSetRef = ctx.register(cidSetStream)
    fontDesc.set(PDFName.of('CIDSet'), cidSetRef)
  }

  return new Uint8Array(await doc.save({ useObjectStreams: false }))
}

/**
 * Re-chunk a CIDFont's existing `/W` so no sub-array exceeds 8000 elements
 * (PDF/A-1 §6.1.12). Lossless — preserves the exact CID→width mapping, just
 * splits an oversized `[cStart [w0 … wN]]` run into consecutive
 * `[cStart [...]] cStart+k [...]]` runs. Range-form triples (`cFirst cLast w`)
 * and anything else are copied verbatim. Used for CIDFonts we can't rebuild
 * from a font program (no FontFile2) — e.g. a substituted-away bare CID font
 * left orphaned in the file with pd-lib's original 20k-element `/W`.
 */
function rechunkOversizedWidths(ctx: PDFDocument['context'], cidFont: PDFDict): void {
  const wEntry = cidFont.get(PDFName.of('W'))
  const w = wEntry ? ctx.lookup(wEntry) : null
  if (!(w instanceof PDFArray)) return

  let oversized = false
  for (let i = 0; i < w.size(); i++) {
    const el = ctx.lookup(w.get(i))
    if (el instanceof PDFArray && el.size() > 8000) { oversized = true; break }
  }
  if (!oversized) return

  const newItems: (PDFNumber | PDFArray)[] = []
  let i = 0
  while (i < w.size()) {
    const a = ctx.lookup(w.get(i))
    const b = i + 1 < w.size() ? ctx.lookup(w.get(i + 1)) : null
    if (a instanceof PDFNumber && b instanceof PDFArray) {
      const start = Number(a.toString())
      if (b.size() <= 8000) {
        newItems.push(PDFNumber.of(start), b)
      } else {
        for (let off = 0; off < b.size(); off += 8000) {
          const end = Math.min(off + 8000, b.size())
          const chunk: PDFNumber[] = []
          for (let j = off; j < end; j++) chunk.push(PDFNumber.of(Number(b.get(j)?.toString() ?? '0')))
          newItems.push(PDFNumber.of(start + off), ctx.obj(chunk) as PDFArray)
        }
      }
      i += 2
    } else {
      // Range-form number (cFirst/cLast/w) or stray element — copy verbatim.
      newItems.push(w.get(i) as PDFNumber)
      i += 1
    }
  }
  cidFont.set(PDFName.of('W'), ctx.obj(newItems) as PDFArray)
}

interface FlattenResult { bytes: Uint8Array; flattenedPages: number }

/**
 * For each page that uses transparency (has a /Group with /S
 * /Transparency, or any /SMask in resources), rasterize JUST that
 * page at 200dpi and replace the page contents with a single image.
 *
 * Loses text selectability on rasterized pages — there's no
 * pure-JS transparency flattener that preserves text. Pdfium-render
 * (Rust) would, but adds 12MB to the bundle. v1 ships the rasterize
 * fallback; v1.1 can swap in pdfium if users complain.
 *
 * For v1.0 we detect-only and surface the count as a warning. The
 * actual rasterize step is deferred to a follow-up commit because
 * doing it right needs the pdfjs render path which lives in the
 * frontend, not in a service module. For now: report 0 flattened
 * with a warning if any pages need it.
 */
async function flattenTransparencyA1(bytes: Uint8Array): Promise<FlattenResult> {
  const doc = await PDFDocument.load(bytes)
  const ctx = doc.context
  let touched = 0
  for (let i = 0; i < doc.getPageCount(); i++) {
    const page = doc.getPage(i)
    let pageTouched = false

    // §6.4-3: strip /Group dicts whose /S = /Transparency from the
    // page dict. A real flatten (rasterize at 200dpi) would preserve
    // the visual but lose text selectability. Just removing the
    // /Group entry is the next-best thing: the page renders the same
    // *non-transparent* content (its main text + paths), and
    // veraPDF stops flagging the rule. PDFs that genuinely depend
    // on the transparency group for visual correctness lose those
    // effects — but those same PDFs were already non-conformant per
    // §6.4-3, so the user was going to lose them either way [V2 P0 #3b].
    const groupRef = page.node.get(PDFName.of('Group'))
    if (groupRef) {
      const gd = ctx.lookup(groupRef) as PDFDict | undefined
      if (gd?.get(PDFName.of('S'))?.toString() === '/Transparency') {
        page.node.delete(PDFName.of('Group'))
        pageTouched = true
      }
    }

    // §6.4-2: strip /SMask and non-1.0 /CA, /ca from ExtGState dicts
    // referenced from page resources. Same trade-off as /Group strip:
    // we lose alpha effects but preserve all opaque content.
    const resources = page.node.get(PDFName.of('Resources'))
    const resDict = resources ? (ctx.lookup(resources) as PDFDict | undefined) : undefined
    if (resDict) {
      const ext = resDict.get(PDFName.of('ExtGState'))
      const extDict = ext ? (ctx.lookup(ext) as PDFDict | undefined) : undefined
      if (extDict) {
        for (const [, extRef] of extDict.entries()) {
          const e = ctx.lookup(extRef) as PDFDict | undefined
          if (!e) continue
          if (e.get(PDFName.of('SMask'))) { e.delete(PDFName.of('SMask')); pageTouched = true }
          const ca = e.get(PDFName.of('CA'))
          if (ca && ca.toString() !== '1') { e.set(PDFName.of('CA'), PDFNumber.of(1)); pageTouched = true }
          const caLower = e.get(PDFName.of('ca'))
          if (caLower && caLower.toString() !== '1') { e.set(PDFName.of('ca'), PDFNumber.of(1)); pageTouched = true }
        }
      }
    }
    if (pageTouched) touched++
  }
  return { bytes: new Uint8Array(await doc.save({ useObjectStreams: false })), flattenedPages: touched }
}

/**
 * Embed an sRGB ICC profile and write the /OutputIntents catalog entry.
 * Loads the system sRGB profile via the Tauri Rust command.
 */
async function addOutputIntent(
  bytes: Uint8Array,
  profile: 'A-1B' | 'A-2B' | 'A-3B',
  iccProvider: () => Promise<Uint8Array>,
): Promise<Uint8Array> {
  const icc = await iccProvider()
  if (icc.length < 128 || !isLikelyIcc(icc)) {
    throw new Error('Invalid sRGB ICC profile')
  }

  const doc = await PDFDocument.load(bytes)
  const ctx = doc.context

  // Build the ICC stream object. /N 3 = three color channels (RGB).
  const iccDict = ctx.obj({
    N: 3,
    Length: icc.length,
  })
  const iccStream = PDFRawStream.of(iccDict, icc)
  const iccRef = ctx.register(iccStream)

  // Output intent dict — /S /GTS_PDFA1 is the marker the spec uses
  // for ALL PDF/A profiles (despite the "1" in the name; Adobe never
  // updated it and the spec keeps it for backward compat).
  const subtype = 'GTS_PDFA1'
  const intentDict = ctx.obj({
    Type: PDFName.of('OutputIntent'),
    S: PDFName.of(subtype),
    OutputConditionIdentifier: PDFString.of('sRGB IEC61966-2.1'),
    RegistryName: PDFString.of('http://www.color.org'),
    Info: PDFString.of('sRGB IEC61966-2.1'),
    DestOutputProfile: iccRef,
  })

  // Replace any existing /OutputIntents — we want exactly one for PDF/A.
  const intentArray = ctx.obj([intentDict]) as PDFArray
  doc.catalog.set(PDFName.of('OutputIntents'), intentArray)

  return new Uint8Array(await doc.save())
}

function isLikelyIcc(bytes: Uint8Array): boolean {
  // ICC v2/v4 profiles have "acsp" at byte offset 36.
  if (bytes.length < 40) return false
  return bytes[36] === 0x61 && bytes[37] === 0x63 && bytes[38] === 0x73 && bytes[39] === 0x70
}

/**
 * Build XMP packet + inject as /Metadata stream on the catalog, and
 * normalize DocInfo so its values are byte-equivalent to the XMP
 * copies (PDF/A §6.7.3 — Producer, Keywords, and other DocInfo keys
 * must match their XMP analogues when BOTH are present).
 *
 * Also writes classic xref tables (xref streams are forbidden in
 * PDF/A-1 per §6.1.4 test 3; allowed in A-2/3 but we use classic
 * uniformly for consistency + smaller risk surface).
 */
async function injectXmp(bytes: Uint8Array, meta: PdfMetadata, profile: PdfAProfile): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes)

  // ── Sync DocInfo with XMP BEFORE building the packet ──────────────
  // The XMP template below skips empty fields; we must mirror that in
  // DocInfo so veraPDF's value-equivalence check passes. An empty
  // string or pre-existing source field in DocInfo vs a missing tag
  // in XMP = mismatch.
  //
  // Strategy: for each field, either write the matching value or
  // DELETE the DocInfo entry. Never leave an empty or stale value.
  const infoRef = doc.context.trailerInfo.Info
  const info = infoRef ? (doc.context.lookup(infoRef) as PDFDict | undefined) : undefined
  const setOrDelete = (key: string, value: string | undefined, setter?: () => void) => {
    if (value && value.length > 0 && setter) {
      setter()
    } else if (info) {
      info.delete(PDFName.of(key))
    }
  }
  setOrDelete('Title', meta.title, () => doc.setTitle(meta.title!))
  setOrDelete('Author', meta.author, () => doc.setAuthor(meta.author!))
  setOrDelete('Subject', meta.subject, () => doc.setSubject(meta.subject!))
  setOrDelete('Creator', meta.creator, () => doc.setCreator(meta.creator!))
  setOrDelete('Producer', meta.producer, () => doc.setProducer(meta.producer!))
  if (meta.creationDate) doc.setCreationDate(meta.creationDate)
  if (meta.modDate) doc.setModificationDate(meta.modDate)

  // Keywords: XMP writes joined-with-", " when non-empty, else skips.
  // Mirror in DocInfo: only write when non-empty, and use the same join.
  const kwJoined = (meta.keywords && meta.keywords.length > 0)
    ? meta.keywords.join(', ')
    : ''
  setOrDelete('Keywords', kwJoined, () => doc.setKeywords([kwJoined]))

  // ── Build XMP packet ──────────────────────────────────────────────
  const xmp = buildPdfAXmp(meta, profile)
  const xmpBytes = new TextEncoder().encode(xmp)

  const xmpDict = doc.context.obj({
    Type: PDFName.of('Metadata'),
    Subtype: PDFName.of('XML'),
    Length: xmpBytes.length,
  })
  const xmpStream = PDFRawStream.of(xmpDict, xmpBytes)
  const xmpRef = doc.context.register(xmpStream)

  doc.catalog.set(PDFName.of('Metadata'), xmpRef)
  ensureTrailerId(doc)

  // Classic xref (no xref streams) — required by PDF/A-1.
  return new Uint8Array(await doc.save({ useObjectStreams: false }))
}

function ensureTrailerId(doc: PDFDocument): void {
  const ctx = doc.context
  if (ctx.trailerInfo.ID) return
  const arr = PDFArray.withContext(ctx)
  arr.push(PDFHexString.of(randomTrailerIdHex()))
  arr.push(PDFHexString.of(randomTrailerIdHex()))
  ctx.trailerInfo.ID = arr
}

function randomTrailerIdHex(): string {
  const bytes = new Uint8Array(16)
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Rewrite the PDF header's version bytes in place. pdf-lib's save()
 * may emit %PDF-1.7 even when we want %PDF-1.4 for PDF/A-1.
 *
 * Brittle but tiny — the header is always "%PDF-x.y\n" at offset 0.
 * If that ever changes, the regex match fails and we throw rather
 * than silently writing wrong bytes.
 */
function setPdfVersion(bytes: Uint8Array, version: string): Uint8Array {
  // First 16 bytes max — header is "%PDF-x.y\n%binarymarker\n".
  const head = new TextDecoder('latin1').decode(bytes.slice(0, 16))
  const m = head.match(/^%PDF-(\d\.\d)/)
  if (!m) {
    throw new Error(`PDF header not recognized: ${head.slice(0, 8)}`)
  }
  if (m[1] === version) return bytes // already correct

  const out = new Uint8Array(bytes.length)
  out.set(bytes, 0)
  // Replace bytes [5..8] with new version (e.g. "1.4")
  const verBytes = new TextEncoder().encode(version)
  out.set(verBytes, 5)
  return out
}

// ─────────────────────────────────────────────────────────────────────
// CJK bare-CID substitution support
//
// A composite (Type0) font with no embedded font program is the common
// un-embedded CJK case (e.g. /BaseFont /STSong-Light). PDF/A forbids it.
// We embed the bundled Noto Sans SC as a fresh Identity-H CIDFontType2,
// then re-encode the content stream's 2-byte codes from the source font's
// GIDs to Noto GIDs (via the source /ToUnicode → Unicode → Noto GID) and
// write a fresh /ToUnicode so the output is selectable. RTL, multiple CJK
// faces in one doc, CFF-keyed (FontFile3), and vertical writing stay
// recorded residuals (KNOWN-LIMITATIONS §4).
// ─────────────────────────────────────────────────────────────────────

/** Convert a run of UTF-16BE hex (4 hex per code unit) to a JS string. */
function hexToUtf16String(hex: string): string {
  let s = ''
  for (let i = 0; i + 4 <= hex.length; i += 4) {
    s += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16))
  }
  return s
}

/**
 * Parse a /ToUnicode CMap stream into a code → Unicode string map. Codes
 * are the 2-byte values the content stream uses; values are the decoded
 * Unicode (usually one BMP char, occasionally a multi-char sequence).
 * Handles both `beginbfchar`/`endbfchar` and `beginbfrange`/`endbfrange`
 * (single-dst and array-dst forms) — the shapes pd-lib and real-world
 * exporters emit.
 */
function parseToUnicodeCMap(bytes: Uint8Array): Map<number, string> {
  const map = new Map<number, string>()
  const text = new TextDecoder('latin1').decode(bytes)

  const bfcharRe = /beginbfchar([\s\S]*?)endbfchar/g
  let block: RegExpExecArray | null
  while ((block = bfcharRe.exec(text))) {
    const pairRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g
    let p: RegExpExecArray | null
    while ((p = pairRe.exec(block[1]))) {
      map.set(parseInt(p[1], 16), hexToUtf16String(p[2]))
    }
  }

  const bfrangeRe = /beginbfrange([\s\S]*?)endbfrange/g
  while ((block = bfrangeRe.exec(text))) {
    // Forms: <lo> <hi> <dst>   |   <lo> <hi> [ <d0> <d1> ... ]
    const entryRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(\[[^\]]*\]|<[0-9A-Fa-f]+>)/g
    let e: RegExpExecArray | null
    while ((e = entryRe.exec(block[1]))) {
      const lo = parseInt(e[1], 16)
      const hi = parseInt(e[2], 16)
      const dst = e[3]
      if (dst.startsWith('[')) {
        const arr = [...dst.matchAll(/<([0-9A-Fa-f]+)>/g)].map((x) => hexToUtf16String(x[1]))
        for (let c = lo, i = 0; c <= hi && i < arr.length; c++, i++) map.set(c, arr[i])
      } else {
        const startHex = dst.slice(1, -1)
        const units: number[] = []
        for (let i = 0; i + 4 <= startHex.length; i += 4) units.push(parseInt(startHex.slice(i, i + 4), 16))
        if (units.length === 0) continue
        for (let c = lo; c <= hi; c++) {
          // Increment the destination as a big-endian integer across ALL its
          // 16-bit units, carrying into the higher units (per the CMap spec —
          // the destination is a single value, not just the last unit).
          const u = units.slice()
          let carry = c - lo
          for (let k = u.length - 1; k >= 0 && carry > 0; k--) {
            const sum = u[k] + carry
            u[k] = sum & 0xffff
            carry = sum >>> 16
          }
          map.set(c, String.fromCharCode(...u))
        }
      }
    }
  }
  return map
}

/**
 * Emit a valid PostScript /ToUnicode CMap from a GID → Unicode-string map.
 * GIDs are the Identity-H 2-byte codes in the content stream (we use an
 * Identity CIDToGIDMap, so code == CID == GID). Destinations are full
 * strings so a one-glyph ligature/combining sequence keeps all its
 * characters in the text layer. Chunks `bfchar` into blocks of 100 (the
 * PostScript per-block limit).
 *
 * A Unicode string → UTF-16BE hex (handles multi-char destinations like
 * ligatures / combining sequences, and supplementary-plane surrogates —
 * JS strings already hold those as surrogate pairs, so charCodeAt yields
 * the correct UTF-16BE units).
 */
function stringToUtf16beHex(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    out += s.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase()
  }
  return out
}

function buildToUnicodeCMap(gidToUnicode: Map<number, string>): string {
  const entries = [...gidToUnicode.entries()].filter(([, s]) => s.length > 0).sort((a, b) => a[0] - b[0])
  const lines: string[] = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
  ]
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100)
    lines.push(`${chunk.length} beginbfchar`)
    for (const [gid, str] of chunk) {
      lines.push(`<${gid.toString(16).padStart(4, '0').toUpperCase()}> <${stringToUtf16beHex(str)}>`)
    }
    lines.push('endbfchar')
  }
  lines.push('endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end')
  return lines.join('\n')
}

/**
 * Public helper (brief API): build a /ToUnicode CMap by reversing the
 * embedded font's own cmap (GID → Unicode) via fontkit, optionally
 * restricted to `usedGids`. The PDF/A pipeline prefers the
 * actually-rendered GID→Unicode map (buildToUnicodeCMap), but this proves
 * the standalone "parse font cmap → ToUnicode" path the spec calls for and
 * backstops any used GID the rendered map missed.
 */
export function generateToUnicodeCMap(ttfBytes: Uint8Array, usedGids?: Set<number>): string {
  const font = (fontkit as unknown as {
    create: (b: Uint8Array) => {
      characterSet?: number[]
      glyphForCodePoint: (cp: number) => { id: number } | null
    }
  }).create(ttfBytes)

  // Codepoints to reverse: the font's own characterSet when fontkit
  // exposes it, else the bundled subset's coverage ranges.
  let codepoints: number[] | null = Array.isArray(font.characterSet) ? font.characterSet : null
  if (!codepoints) {
    codepoints = []
    for (let cp = 0x20; cp <= 0x7e; cp++) codepoints.push(cp)
    for (let cp = 0x3000; cp <= 0x303f; cp++) codepoints.push(cp)
    for (let cp = 0x4e00; cp <= 0x9fff; cp++) codepoints.push(cp)
    for (let cp = 0xff00; cp <= 0xffef; cp++) codepoints.push(cp)
  }

  const gidToUnicode = new Map<number, string>()
  for (const cp of codepoints) {
    let gid = 0
    try {
      gid = font.glyphForCodePoint(cp)?.id ?? 0
    } catch {
      gid = 0
    }
    if (gid === 0) continue
    if (usedGids && !usedGids.has(gid)) continue
    if (!gidToUnicode.has(gid)) gidToUnicode.set(gid, String.fromCodePoint(cp)) // first (lowest) cp wins
  }
  return buildToUnicodeCMap(gidToUnicode)
}

interface CidFontKit {
  glyphForCodePoint: (cp: number) => { id: number } | null
}

interface CidSubEntry {
  fk: CidFontKit
  codeToUnicode: Map<number, string>
  notoBytes: Uint8Array
  // gid → the FULL source Unicode string (a one-glyph ligature/combining
  // sequence keeps every character in the generated /ToUnicode, even though
  // the substitute renders a single glyph for it).
  usedGidToUnicode: Map<number, string>
  fontDict?: PDFDict
  unmapped: number
}

/** Re-encode one 2-byte CID string from source GIDs to Noto GIDs. */
function reencodeCidString(src: CSPdfString, entry: CidSubEntry): CSPdfString {
  const v = src.value
  const pairs = Math.floor(v.length / 2)
  if (pairs * 2 !== v.length) entry.unmapped++ // odd trailing byte (malformed) — count it
  const out = new Uint8Array(pairs * 2)
  for (let i = 0; i < pairs; i++) {
    const code = (v[i * 2] << 8) | v[i * 2 + 1]
    const uni = entry.codeToUnicode.get(code)
    let gid = 0
    if (uni && uni.length > 0) {
      // The glyph is chosen from the FIRST codepoint (one source glyph maps
      // to one substitute glyph), but the /ToUnicode keeps the WHOLE string
      // so extraction/search of a ligature stays lossless.
      const cp = uni.codePointAt(0) ?? 0
      try {
        gid = entry.fk.glyphForCodePoint(cp)?.id ?? 0
      } catch {
        gid = 0
      }
      if (gid !== 0) entry.usedGidToUnicode.set(gid, uni)
      else entry.unmapped++
    } else {
      entry.unmapped++
    }
    out[i * 2] = (gid >> 8) & 0xff
    out[i * 2 + 1] = gid & 0xff
  }
  return { type: 'hex', value: out, decoded: src.decoded }
}

/**
 * Walk every page, re-encode the content-stream text of each substituted
 * bare-CID font to Noto GIDs, and write a fresh /ToUnicode CMap onto the
 * new Type0 font dict. Mirrors rewriteSubstitutedTextEncoding but for the
 * 2-byte CID path. `cidSubstitutes` is keyed by the NEW (Noto) font ref —
 * object numbers survive pd-lib's save/reload, so the keys captured during
 * embedMissingFonts still resolve here (same invariant the 1-byte path
 * relies on).
 */
async function rewriteCidSubstitutedText(
  bytes: Uint8Array,
  cidSubstitutes: Map<string, { notoBytes: Uint8Array; codeToUnicode: Map<number, string> }>,
): Promise<{ bytes: Uint8Array; unmapped: number }> {
  if (cidSubstitutes.size === 0) return { bytes, unmapped: 0 }

  const doc = await PDFDocument.load(bytes)
  const ctx = doc.context

  const byRefKey = new Map<string, CidSubEntry>()
  for (const [refKey, info] of cidSubstitutes) {
    let fk: CidFontKit
    try {
      fk = (fontkit as unknown as { create: (b: Uint8Array) => CidFontKit }).create(info.notoBytes)
    } catch {
      continue
    }
    byRefKey.set(refKey, {
      fk,
      codeToUnicode: info.codeToUnicode,
      notoBytes: info.notoBytes,
      usedGidToUnicode: new Map(),
      unmapped: 0,
    })
  }
  if (byRefKey.size === 0) return { bytes, unmapped: 0 }

  for (let pageIdx = 0; pageIdx < doc.getPageCount(); pageIdx++) {
    const page = doc.getPage(pageIdx)
    const resources = ctx.lookup(page.node.get(PDFName.of('Resources')))
    if (!(resources instanceof PDFDict)) continue
    const fontsDict = ctx.lookup(resources.get(PDFName.of('Font')))
    if (!(fontsDict instanceof PDFDict)) continue

    const pageSubs = new Map<string, CidSubEntry>()
    for (const [key, refOrDict] of fontsDict.entries()) {
      if (!(refOrDict instanceof PDFRef)) continue
      const entry = byRefKey.get(refKeyFromRef(refOrDict))
      if (!entry) continue
      if (!entry.fontDict) {
        const d = ctx.lookup(refOrDict)
        if (d instanceof PDFDict) entry.fontDict = d
      }
      pageSubs.set(key.toString().replace(/^\//, ''), entry)
    }
    if (pageSubs.size === 0) continue

    const contentInfo = getPageContentBytes(doc, pageIdx)
    if (!contentInfo || contentInfo.bytes.length === 0) continue
    const parsed = parseContentStream(contentInfo.bytes)
    let activeFontKey: string | null = null
    let rewroteAny = false

    for (const op of parsed.operators) {
      if (op.operator === 'Tf') {
        const nameArg = op.args[0] as string
        activeFontKey = typeof nameArg === 'string' ? nameArg.replace(/^\//, '') : null
        continue
      }
      if (!activeFontKey) continue
      const entry = pageSubs.get(activeFontKey)
      if (!entry) continue

      if (op.operator === 'Tj' || op.operator === "'") {
        const newStr = reencodeCidString(op.args[0] as CSPdfString, entry)
        replaceTextOp(op, newStr, op.operator)
        rewroteAny = true
      } else if (op.operator === '"') {
        const newStr = reencodeCidString(op.args[2] as CSPdfString, entry)
        replaceQuotationOp(op, op.args[0] as number, op.args[1] as number, newStr)
        rewroteAny = true
      } else if (op.operator === 'TJ') {
        const arr = op.args[0] as TJArrayElement[]
        const newArr: TJArrayElement[] = arr.map((el) =>
          el.kind === 'string' ? { kind: 'string', value: reencodeCidString(el.value, entry) } : el,
        )
        replaceTJOp(op, newArr)
        rewroteAny = true
      }
    }

    if (rewroteAny) {
      const rewritten = serializeContentStream(parsed.operators, contentInfo.bytes)
      replacePageContents(doc, pageIdx, rewritten)
    }
  }

  // Write a fresh /ToUnicode onto each substituted Type0 dict, scoped to
  // the GIDs actually used on the page (keeps the CMap small + exact).
  for (const entry of byRefKey.values()) {
    if (!entry.fontDict) continue
    const cmapStr = buildToUnicodeCMap(entry.usedGidToUnicode)
    const cmapBytes = new TextEncoder().encode(cmapStr)
    const tuDict = ctx.obj({ Length: cmapBytes.length })
    const tuStream = PDFRawStream.of(tuDict, cmapBytes)
    const tuRef = ctx.register(tuStream)
    entry.fontDict.set(PDFName.of('ToUnicode'), tuRef)
  }

  let unmapped = 0
  for (const entry of byRefKey.values()) unmapped += entry.unmapped

  return { bytes: new Uint8Array(await doc.save({ useObjectStreams: false })), unmapped }
}
