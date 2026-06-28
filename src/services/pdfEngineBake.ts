// Frontend bridge to the Rust engine's bake path.
//
// The PDF handler's save flow accumulates paragraph edits per page in
// each `PdfPageState`. This helper converts that per-page edit map into
// the backend's `EditModel` shape and invokes `engine_bake_from_bytes`
// over Tauri IPC.
//
// When the engine is available and the bake succeeds, the returned
// bytes are a signature-safe incremental update: the original document
// prefix is preserved byte-for-byte, and the edits ride on top as an
// appended overlay stream + superseded page dict (see the engine's
// S5.5 series in `src-tauri/src/pdf_engine/bake.rs`).
//
// When anything goes wrong (Tauri not available in dev preview, engine
// returns an error, EditModel has shapes the engine's S5.5 path can't
// handle yet), this returns `null` so the caller can fall through to
// the existing pd-lib bake path without losing the edit.

import { invoke } from '@tauri-apps/api/core'
import {
  expandParagraphEditMaskForDecorations,
  type ParagraphEdit,
} from './pdfParagraphEdits'
import { primaryFamily, resolveSystemFont } from './pdfFontResolution'
import { isOcrParagraphId } from './pdfOcrToParagraphs'
import { substitutionDetail } from './saveDegradations'
import type {
  EngineFallbackEvent,
  SaveDegradationCollector,
} from './saveDegradations'

/** Path-routed bake/rewrite. Writes `prepBytes` to a tmp input
 *  file via plugin-fs (binary fast path), invokes the path-in/
 *  path-out engine command, then reads the output back via
 *  plugin-fs and deletes the tmp files.
 *
 *  Why: the bytes-based engine commands ship pdfBytes through
 *  Tauri's default Vec<u8> IPC, which Array.from(u8)+JSON.stringify
 *  inflates to ~6 ASCII bytes per source byte — a 33 MB doc becomes
 *  a ~200 MB JSON string IN, and similar OUT. V8 chokes; the
 *  WebView blocks for seconds and the parent process can balloon
 *  past 2 GB. The path route caps IPC at a few KB of JSON
 *  metadata regardless of doc size.
 *
 *  Returns null when the dev preview lacks Tauri or any of the
 *  fs/invoke calls throw; callers can then fall back to the
 *  legacy in-memory path. */
/** Path-routed variant of pdf_strip_text_in_bboxes. Same motivation
 *  as bakeViaPathRoute. */
async function stripViaPathRoute(
  pdfBytes: Uint8Array,
  bboxes: Array<{
    page_index: number
    x: number; y: number; width: number; height: number
    coord_space: 'css' | 'pdf'
  }>,
): Promise<{ bytes: Uint8Array; removedPerBbox: number[] } | null> {
  let inPath: string | null = null
  let outPath: string | null = null
  try {
    const { tempDir, join } = await import('@tauri-apps/api/path')
    const { writeFile, readFile } = await import('@tauri-apps/plugin-fs')
    const dir = await tempDir()
    const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    inPath = await join(dir, `os-strip-${stamp}.in.pdf`)
    outPath = await join(dir, `os-strip-${stamp}.out.pdf`)
    await writeFile(inPath, pdfBytes)
    // StripPathOutcome: {removed_per_bbox, removed_by_page,
    // removed_total} — per-REGION counts let the caller detect the
    // silent NO-OP strip (zero objects removed for a region whose
    // edit expected removal = original text still recoverable), even
    // when a SIBLING region on the same page stripped fine.
    const outcome = await invoke<{
      removed_per_bbox?: number[]
      removed_by_page?: Record<string, number>
      removed_total?: number
    }>('pdf_strip_text_in_bboxes_to_path', {
      input_path: inPath,
      output_path: outPath,
      bboxes,
    })
    const bytes = await readFile(outPath)
    return {
      bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
      removedPerBbox: Array.isArray(outcome?.removed_per_bbox) ? outcome.removed_per_bbox : [],
    }
  } catch (err) {
    console.warn('[engine-bake] path-routed strip failed:', err)
    return null
  } finally {
    try {
      const { remove } = await import('@tauri-apps/plugin-fs')
      if (inPath) await remove(inPath).catch(() => undefined)
      if (outPath) await remove(outPath).catch(() => undefined)
    } catch { /* swallow */ }
  }
}

async function bakeViaPathRoute(
  cmd: 'engine_bake_to_path' | 'engine_rewrite_to_path',
  prepBytes: Uint8Array,
  model: EngineEditModel,
): Promise<{ bytes: Uint8Array; summary: any; degradations: EngineFallbackEvent[] } | null> {
  let inPath: string | null = null
  let outPath: string | null = null
  try {
    const { tempDir, join } = await import('@tauri-apps/api/path')
    const { writeFile, readFile } = await import('@tauri-apps/plugin-fs')
    const dir = await tempDir()
    const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    inPath = await join(dir, `os-bake-${stamp}.in.pdf`)
    outPath = await join(dir, `os-bake-${stamp}.out.pdf`)
    await writeFile(inPath, prepBytes)
    // EnginePathSaveResult: WriteSummary fields FLATTENED at the top
    // level (pre-Session-1 wire compat) + additive `degradations`.
    const summary = await invoke<{
      total_bytes: number
      appended_bytes: number
      new_xref_offset: number
      previous_xref_offset: number
      new_objects_emitted: number
      degradations?: EngineFallbackEvent[]
    }>(cmd, { inputPath: inPath, outputPath: outPath, model })
    // Loud shape validation. A serde/IPC drift here must NOT decay
    // into `undefined` telemetry — and because this throw is caught
    // by our own try below (→ null → caller falls back), the
    // distinctive message surfaces as the recorded fallback reason
    // instead of vanishing.
    if (!summary || typeof summary.total_bytes !== 'number') {
      throw new Error(
        `[engine-bake] ${cmd} returned unexpected shape (keys: ${
          summary ? Object.keys(summary).join(',') : String(summary)
        }) - expected flattened WriteSummary`,
      )
    }
    const bytes = await readFile(outPath)
    return {
      bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
      summary,
      degradations: Array.isArray(summary.degradations) ? summary.degradations : [],
    }
  } catch (err) {
    // RETHROW with the real reason (verifier finding): swallowing to
    // null here meant heavy-doc saves reported the generic
    // 'path-routed rewrite returned null' as rewriteFailureReason and
    // every paragraphPaths failureReason, while light docs kept the
    // engine's actual message. Callers catch and route to fallback
    // exactly as before — only the recorded reason improves.
    console.warn(`[engine-bake] path-routed ${cmd} failed:`, err)
    throw err instanceof Error ? err : new Error(String(err))
  } finally {
    // Best-effort cleanup. plugin-fs.remove no-ops if the file
    // already doesn't exist; other errors are non-fatal — the OS
    // tempdir is rotated by the system anyway.
    try {
      const { remove } = await import('@tauri-apps/plugin-fs')
      if (inPath) await remove(inPath).catch(() => undefined)
      if (outPath) await remove(outPath).catch(() => undefined)
    } catch { /* swallow */ }
  }
}

/** G2: embedded TrueType font payload that rides inside an
 *  `EngineEditModel.embeddedFonts` map. Frontend pre-resolves each
 *  unique non-Standard-14 (family, bold, italic) tuple via
 *  `pdfFontResolution.resolveSystemFont` then `font_subset` Tauri
 *  command before packing the bytes here. */
export interface EngineEmbeddedFont {
  /** Subsetted TrueType bytes (Vec<u8> → number[] over Tauri JSON IPC). */
  bytes: number[]
  /** PostScript-style font name. Writer auto-prefixes with AAAAAA+
   *  if no subset prefix is detected. */
  postscriptName: string
  bold?: boolean
  italic?: boolean
}

/** Backend `EditModel` shape, as deserialized by serde. Keys match
 *  the `#[serde(rename=...)]` attributes in `src-tauri/src/live/model.rs`. */
interface EngineEditModel {
  sourceHash: string
  /** HashMap<u32, PageEdits>. JSON keys are the page-index strings
   *  (serde accepts either numbers or strings for numeric-keyed maps). */
  pages: Record<string, { paragraphs: ParagraphEdit[] }>
  version: number
  /** G2: pool of embedded font payloads keyed by `custom_font_id`.
   *  Each ParagraphEdit with a matching `customFontId` field gets
   *  routed through the embedded-TTF bake path (Type0 + CIDFontType2
   *  + Identity-H). Empty / missing → Standard-14-only bake. */
  embeddedFonts?: Record<string, EngineEmbeddedFont>
}

export interface EngineBakeSummary {
  totalBytes: number
  appendedBytes: number
  newXrefOffset: number
  previousXrefOffset: number
  newObjectsEmitted: number
}

export interface EngineBakeResult {
  bytes: Uint8Array
  summary: EngineBakeSummary
}

/** Which bake path produced the resulting bytes. Callers can surface this
 *  to the user: `rewrite` is the true Acrobat-style edit; `overlay` is an
 *  appended mask+paint and leaves the original text extractable. */
export type BakePath = 'rewrite' | 'overlay'

export interface EngineBakeOutcome extends EngineBakeResult {
  path: BakePath
  /** Which IPC route carried the bake — 'path' for the heavy
   *  engine_*_to_path commands, 'bytes' for in-memory. Surfaced in
   *  the SaveReport so drivers can assert the routing instead of
   *  inferring it from the fixture size alone. */
  route: 'path' | 'bytes'
  /** When the true rewrite couldn't apply, this is the engine's reason
   *  (e.g. "font has no ToUnicode CMap", "multi-run paragraph"). */
  rewriteFailureReason?: string
  /** Session-1 channel: fallback events the Rust engine recorded while
   *  producing these bytes (font substitution, geometry defaults, …).
   *  Already merged into `options.collector` when one was supplied —
   *  exposed here for callers that inspect the outcome directly. */
  degradations: EngineFallbackEvent[]
}

/**
 * Try to bake `paragraphEditsByPage` onto `pdfBytes` via the Rust
 * engine. Resolves to `{ bytes, summary, path, rewriteFailureReason? }`
 * on success, or `null` when the engine is unavailable (Tauri not
 * running) or both the rewrite AND the overlay fallback fail — in
 * which case the caller can fall through to pd-lib.
 *
 * **Two-stage cascade inside:**
 *
 *   1. **True text rewrite** (`engine_rewrite_from_bytes`) — modifies
 *      the page's existing content stream in place, replacing `Tj`/`TJ`
 *      operands via the font's ToUnicode CMap reverse-mapping. Sets
 *      `path: 'rewrite'`. Real edited text — copy-paste, search, and
 *      extraction all see the new content.
 *
 *   2. **Overlay bake** (`engine_bake_from_bytes`) — fallback when
 *      rewrite fails. Draws the new text in an appended content
 *      stream with a mask rect hiding the original. Sets
 *      `path: 'overlay'` AND `rewriteFailureReason`. Works for
 *      anything, but leaves the original text extractable.
 *
 * The caller MUST check `path` — shipping overlay-baked output without
 * telling the user is a data-integrity hazard (reopening extracts the
 * old text).
 */
export async function bakeParagraphEditsViaEngine(
  pdfBytes: Uint8Array,
  paragraphEditsByPage: Map<number, ParagraphEdit[]>,
  options: {
    forceOverlay?: boolean
    /** Session-1 degradation channel. When supplied, this bake
     *  records its own fallbacks (G9 strip skip, font-resolution
     *  outcomes) and merges engine-side events into it. */
    collector?: SaveDegradationCollector
    /** §3: opt-in to embed the installed file for office-suite family
     *  names (Arial/Calibri/Cambria/…) on an EXACT system-font match
     *  instead of substituting Standard-14 metrics. Default false. */
    embedInstalledFonts?: boolean
  } = {},
): Promise<EngineBakeOutcome | null> {
  if (paragraphEditsByPage.size === 0) return null
  const collector = options.collector

  // Mutate edits in-place (customFontId at the overlay stage). We
  // deep-clone the input map so the caller's references stay clean.
  const edits_cloned: Map<number, ParagraphEdit[]> = new Map(
    Array.from(paragraphEditsByPage, ([k, v]) => [
      k,
      v.map((e) => expandParagraphEditMaskForDecorations({ ...e })),
    ]),
  )

  const pages: Record<string, { paragraphs: ParagraphEdit[] }> = {}
  for (const [pageIndex, edits] of edits_cloned) {
    if (edits.length === 0) continue
    pages[String(pageIndex)] = { paragraphs: edits }
  }
  if (Object.keys(pages).length === 0) return null

  // Rewrite-stage model: NO embedded fonts. Session-4 restructure
  // (adversarial-preflight P0-2): font resolution used to run at
  // model-build time, BEFORE the rewrite attempt — so a custom-font
  // doc whose family can't be re-resolved carried fidelity-severity
  // resolution records even when the rewrite then succeeded and kept
  // the document's own fonts untouched. All font work now happens at
  // the OVERLAY stage, after the rewrite has actually failed (or was
  // skipped by forceOverlay): a successful rewrite does zero font
  // resolution and records zero font.* events. The rewrite path
  // never reads EditModel.embeddedFonts (text_rewrite.rs re-encodes
  // through the document's own ToUnicode CMaps), so omitting them
  // here is behavior-neutral for stage 1.
  const model: EngineEditModel = {
    sourceHash: '',
    pages,
    version: 1,
  }

  // Rewrite-stage model: pass `new_text` through verbatim, including
  // embedded `\n`. The engine's true-rewrite path now handles four
  // newline cases (G8 closed):
  //   1. original no \n, new no \n → vanilla single-Tj rewrite.
  //   2. original has \n, new has \n (same line count) → multi-run
  //      fan: each line replaces its own Tj.
  //   3. original has \n, new has different line count → multi-run
  //      collapse / extend with empty Tj sweep.
  //   4. original no \n, new has \n → splice path: the matched Tj's
  //      operand becomes the first line; (Td 0 -leading) (Tj line)
  //      pairs are inserted after for each subsequent line.
  // Standard fonts can't encode U+000A, so we never pack `\n` into a
  // Tj operand — the engine splits on `\n` before calling encode_text.
  // Pre-G8, this stage flattened `\n` to a space so the destructive
  // rewrite path didn't error and force overlay-fallback (which would
  // have left the original text recoverable). With G8 closed, the
  // newline is preserved end-to-end.
  const rewriteModel: EngineEditModel = model

  const forceOverlay = options.forceOverlay === true

  // Heavy-doc threshold for routing through the path-based engine
  // commands (zero IPC byte transfer in either direction). The
  // bytes-based path is fine for sub-MB docs where Array.from +
  // JSON.stringify costs are noise; for anything larger it pays
  // big — and on a 33 MB doc it literally hangs the process.
  const HEAVY_BYTES_THRESHOLD = 1 * 1024 * 1024
  const isHeavy = pdfBytes.byteLength > HEAVY_BYTES_THRESHOLD

  // Stage 1: true text rewrite (skipped when a style edit is present).
  let rewriteFailureReason: string | undefined
  if (forceOverlay) {
    rewriteFailureReason = 'style/layout edit requires overlay'
  } else try {
    let outBytes: Uint8Array
    let rawSummary: any
    let engineEvents: EngineFallbackEvent[] = []
    if (isHeavy) {
      const routed = await bakeViaPathRoute('engine_rewrite_to_path', pdfBytes, rewriteModel)
      if (!routed) throw new Error('path-routed rewrite returned null')
      outBytes = routed.bytes
      rawSummary = routed.summary
      engineEvents = routed.degradations
    } else {
      const raw = await invoke<{
        bytes: number[] | Uint8Array
        summary: {
          total_bytes: number
          appended_bytes: number
          new_xref_offset: number
          previous_xref_offset: number
          new_objects_emitted: number
        }
        degradations?: EngineFallbackEvent[]
      }>('engine_rewrite_from_bytes', {
        bytes: Array.from(pdfBytes),
        model: rewriteModel,
      })
      outBytes = raw.bytes instanceof Uint8Array ? raw.bytes : new Uint8Array(raw.bytes)
      rawSummary = raw.summary
      engineEvents = Array.isArray(raw.degradations) ? raw.degradations : []
    }
    collector?.recordEngineEvents(engineEvents)
    console.log(
      `[engine-rewrite] true text edit: ${rawSummary.appended_bytes} bytes appended,`,
      `${rawSummary.new_objects_emitted} object(s) superseded`,
    )
    return {
      path: 'rewrite',
      route: isHeavy ? 'path' : 'bytes',
      bytes: outBytes,
      degradations: engineEvents,
      summary: {
        totalBytes: rawSummary.total_bytes,
        appendedBytes: rawSummary.appended_bytes,
        newXrefOffset: rawSummary.new_xref_offset,
        previousXrefOffset: rawSummary.previous_xref_offset,
        newObjectsEmitted: rawSummary.new_objects_emitted,
      },
    }
  } catch (rewriteErr) {
    rewriteFailureReason =
      rewriteErr instanceof Error ? rewriteErr.message : String(rewriteErr)
    console.warn(
      '[engine-rewrite] true edit not applicable, falling back to overlay bake:',
      rewriteFailureReason,
    )
  }

  // Stage 2 begins: the overlay WILL materialize (or fall to pd-lib).
  // Resolve fonts now — and only now (Session-4 restructure; see the
  // model comment above). The resolution chain per custom family:
  // document-embedded font extraction → system font → loud
  // substitution; Standard-14 routes get the WinAnsi coverage check +
  // unicode escalation. Throws UnencodableReplacementError (a
  // deliberate save REFUSAL with the offending characters named) when
  // replacement text contains characters NO available font can draw —
  // the alternative was a silent character drop or a three-layer
  // crash with pdf-lib's message.
  const embeddedFonts: Record<string, EngineEmbeddedFont> = {}
  const fontResolution = await resolveOverlayFonts(
    pdfBytes,
    edits_cloned,
    embeddedFonts,
    collector,
    isHeavy,
    options.embedInstalledFonts ?? false,
  )
  const overlayModel: EngineEditModel = {
    ...model,
    embeddedFonts: Object.keys(embeddedFonts).length > 0 ? embeddedFonts : undefined,
  }

  // Pre-strip the original text in
  // each edit's bbox via pdf_strip_text_in_bboxes (G9 — destructive
  // overlay backstop). This makes the overlay paint go onto already-
  // clean bytes, so forensic tools / strings(1) / Acrobat extract
  // can't recover the original text from beneath the whiteout. Even
  // when the rewrite stage couldn't find a Tj match (multi-run
  // paragraphs, encoding edge cases, full-line deletes), pdfium's
  // bbox-based text-object removal gets it.
  let prepBytes: Uint8Array = pdfBytes
  // True when at least one bbox genuinely expects text removal (a real
  // text edit overlaying extractable glyphs). False for an all-OCR batch
  // (no extractable text on an image-only page). Gates the
  // strip-INFRASTRUCTURE-failure leak records below so an all-OCR batch
  // hitting a strip failure doesn't raise a FALSE security signal
  // (Session 7, verifier gate-3 P2). Declared outside the try so the
  // catch can read it.
  let anyTextStripExpected = false
  try {
    const stripBboxes: Array<{
      page_index: number
      x: number; y: number; width: number; height: number
      coord_space: 'css'
    }> = []
    // Per-REGION expectation tracking (verifier gate-3 finding: per-
    // page totals masked a region that stripped nothing when a sibling
    // region on the same page stripped fine). stripBboxMeta is aligned
    // 1:1 with stripBboxes; an entry expects removal when its edit has
    // real original text being overlaid.
    const stripBboxMeta: Array<{
      pageIndex: number
      paragraphId: string
      expectsRemoval: boolean
    }> = []
    for (const [pageIndex, edits] of paragraphEditsByPage) {
      for (const e of edits) {
        if (e.skipSourceMask) continue
        const maskBbox = e.maskBbox ?? e.bbox
        if (!maskBbox) continue
        stripBboxMeta.push({
          pageIndex,
          paragraphId: e.paragraphId,
          // OCR edits (Session 7) do NOT expect strip removal: an
          // image-only page has no extractable TEXT under the overlay —
          // the "original text" is OCR-recognized from raster pixels, so
          // the strip removing ZERO is the correct, expected outcome, not
          // a text-extraction leak. The overlay-over-unchanged-image
          // recoverability is honestly recorded by ocr.overlay_only;
          // flagging strip.skipped_text_recoverable (security) here would
          // be a FALSE leak signal. Real text edits keep the check.
          expectsRemoval:
            !isOcrParagraphId(e.paragraphId) && (e.originalText ?? '').trim() !== '',
        })
        // Frontend bbox is CSS top-left; engine flips per-page using
        // page height. Pad slightly so partial-overlap edges still get
        // stripped (Tj bounds can extend a couple px past the visible
        // glyph quad).
        const pad = 2
        stripBboxes.push({
          page_index: pageIndex,
          x: (maskBbox.x ?? 0) - pad,
          y: (maskBbox.y ?? 0) - pad,
          width: (maskBbox.width ?? 0) + pad * 2,
          height: (maskBbox.height ?? 0) + pad * 2,
          coord_space: 'css',
        })
      }
    }
    anyTextStripExpected = stripBboxMeta.some((m) => m.expectsRemoval)
    const recordSilentNoOpStrips = (removedPerBbox: number[]) => {
      stripBboxMeta.forEach((meta, i) => {
        if (!meta.expectsRemoval) return
        const removed = removedPerBbox[i] ?? 0
        if (removed === 0) {
          collector?.record({
            area: 'strip.skipped_text_recoverable',
            detail:
              `destructive strip removed ZERO text objects for paragraph ${meta.paragraphId} ` +
              `on page ${meta.pageIndex}; its original text remains recoverable under the overlay`,
            pageIndex: meta.pageIndex,
            paragraphId: meta.paragraphId,
          })
        }
      })
    }
    if (stripBboxes.length > 0) {
      if (isHeavy) {
        // Path-route the strip pre-pass to avoid the 33 MB
        // Array.from + JSON-array marshal in BOTH directions.
        const stripped = await stripViaPathRoute(pdfBytes, stripBboxes)
        if (stripped) {
          prepBytes = stripped.bytes
          recordSilentNoOpStrips(stripped.removedPerBbox)
          console.log(
            `[engine-bake] G9 destructive backstop (path-routed): stripped ${stripBboxes.length} text bbox(es) before overlay`,
          )
        } else {
          // Path route failed; fall through to overlay without strip.
          // Visual output is still correct, original text is recoverable.
          console.warn('[engine-bake] G9 path-routed strip failed; overlay will leak original text')
          // Only a real text edit can leak extractable text — an all-OCR
          // batch has none, so skip the false security signal there.
          if (anyTextStripExpected) {
            collector?.record({
              area: 'strip.skipped_text_recoverable',
              detail:
                `path-routed destructive strip failed for ${stripBboxes.length} region(s); ` +
                'the overlay masks the original text visually but the bytes remain extractable',
            })
          }
        }
      } else {
        // StripTextOutcome: {bytes, removed_per_bbox, removed_by_page,
        // removed_total}.
        const outcome = await invoke<{
          bytes: number[] | Uint8Array
          removed_per_bbox?: number[]
          removed_by_page?: Record<string, number>
          removed_total?: number
        }>('pdf_strip_text_in_bboxes', {
          bytes: Array.from(pdfBytes),
          bboxes: stripBboxes,
        })
        const strippedBytes = outcome.bytes
        prepBytes = strippedBytes instanceof Uint8Array ? strippedBytes : new Uint8Array(strippedBytes)
        recordSilentNoOpStrips(
          Array.isArray(outcome.removed_per_bbox) ? outcome.removed_per_bbox : [],
        )
        console.log(
          `[engine-bake] G9 destructive backstop: stripped ${outcome.removed_total ?? '?'} text object(s) across ${stripBboxes.length} bbox(es) before overlay`,
        )
      }
    }
  } catch (stripErr) {
    console.warn('[engine-bake] G9 strip pre-pass failed, overlay will leak original:', stripErr)
    // Continue with original bytes — overlay still paints visually
    // correct output, just leaves the original text recoverable.
    // Only record the leak when a real text edit was actually expected to
    // strip (an all-OCR batch has no extractable text — no false signal).
    if (anyTextStripExpected) {
      collector?.record({
        area: 'strip.skipped_text_recoverable',
        detail:
          'destructive strip pre-pass failed; the overlay masks the original text visually ' +
          `but the bytes remain extractable: ${stripErr instanceof Error ? stripErr.message : String(stripErr)}`,
      })
    }
  }

  try {
    let outBytes: Uint8Array
    let rawSummary: any
    let engineEvents: EngineFallbackEvent[] = []
    const isHeavyPrep = prepBytes.byteLength > HEAVY_BYTES_THRESHOLD
    if (isHeavyPrep) {
      const routed = await bakeViaPathRoute('engine_bake_to_path', prepBytes, overlayModel)
      if (!routed) throw new Error('path-routed bake returned null')
      outBytes = routed.bytes
      rawSummary = routed.summary
      engineEvents = routed.degradations
    } else {
      const raw = await invoke<{
        bytes: number[] | Uint8Array
        summary: {
          total_bytes: number
          appended_bytes: number
          new_xref_offset: number
          previous_xref_offset: number
          new_objects_emitted: number
        }
        degradations?: EngineFallbackEvent[]
      }>('engine_bake_from_bytes', {
        bytes: Array.from(prepBytes),
        model: overlayModel,
      })
      outBytes = raw.bytes instanceof Uint8Array ? raw.bytes : new Uint8Array(raw.bytes)
      rawSummary = raw.summary
      engineEvents = Array.isArray(raw.degradations) ? raw.degradations : []
    }
    collector?.recordEngineEvents(engineEvents)
    // The overlay MATERIALIZED — flush the success-gated records the
    // resolution chain prepared (font.substituted for engine-blind
    // stack-collapsed families, font.unicode_escalated, and the D3
    // per-paragraph overlay-limitations enumeration). Had the bake
    // thrown, pd-lib would have run its own resolution + records and
    // these would have been false positives.
    for (const rec of fontResolution.pendingOnSuccess) {
      collector?.record(rec)
    }
    return {
      path: 'overlay',
      route: isHeavyPrep ? 'path' : 'bytes',
      rewriteFailureReason,
      bytes: outBytes,
      degradations: engineEvents,
      summary: {
        totalBytes: rawSummary.total_bytes,
        appendedBytes: rawSummary.appended_bytes,
        newXrefOffset: rawSummary.new_xref_offset,
        previousXrefOffset: rawSummary.previous_xref_offset,
        newObjectsEmitted: rawSummary.new_objects_emitted,
      },
    }
  } catch (bakeErr) {
    console.warn('[engine-bake] overlay also failed, falling back to pd-lib:', bakeErr)
    return null
  }
}

// ── G2: embedded-font pre-resolution ─────────────────────────────

/** Standard 14 family detector — anything that looks Helvetica /
 *  Times / Courier shaped does NOT need an embedded payload (the
 *  Rust bake will use its in-memory AFM tables). Mirrors
 *  `resolve_family` in `bake.rs` so frontend and backend agree on
 *  what counts as "needs embedding". Exported for the Session-5
 *  alignment-routing faithfulness guard (pdfLayoutEnrichment.ts). */
export function isStandard14Family(family: string | undefined): boolean {
  const s = (family ?? '').toLowerCase()
  if (!s) return true // missing → Helvetica fallback, no embed needed
  if (
    s.includes('helvetica') || s.includes('arial') || s.includes('sans-serif') ||
    s.includes('calibri') || s.includes('system-ui') || s.includes('-apple-system')
  ) return true
  if (s.includes('times') || s.includes('serif') || s.includes('roman') ||
      s.includes('georgia') || s.includes('cambria')) return true
  if (s.includes('courier') || s.includes('mono') || s.includes('consolas') ||
      s.includes('menlo') || s.includes('inconsolata') || s.includes('fixed')) return true
  return false
}

/** §3: office-suite family names that look Standard-14-shaped to
 *  `isStandard14Family` (so the engine bake would substitute AFM metrics)
 *  but DO have a real installed font file worth embedding for exact
 *  fidelity. This is a strict SUBSET decision layered ON TOP of
 *  `isStandard14Family` — it is NOT a replacement, and it must stay
 *  DISJOINT from the genuine Standard-14 trio (Helvetica/Times/Courier),
 *  which legitimately use AFM metrics and must never embed-route. Only
 *  consulted when the user opts in (`embedInstalledFonts`); the routing
 *  then requires an EXACT system-font match (see resolveOverlayFonts).
 *
 *  Kept separate from `isStandard14Family` deliberately: that predicate
 *  has a second consumer (the Session-5 alignment-routing faithfulness
 *  guard in pdfLayoutEnrichment.ts) — narrowing it in place would flip
 *  which center/right edits route through the align-aware overlay. */
export function familyNeedsEmbedding(family: string | undefined): boolean {
  const s = (family ?? '').toLowerCase().trim()
  if (!s) return false
  // The genuine Standard-14 trio + generic CSS keywords are AFM-metric
  // families — never embed-route them.
  if (s.includes('helvetica') || s.includes('times') || s.includes('courier')) return false
  if (s === 'sans-serif' || s === 'serif' || s === 'monospace' ||
      s.includes('system-ui') || s.includes('-apple-system')) return false
  // The office-suite faces that `isStandard14Family` ALSO catches (so
  // they currently take AFM metrics) AND have a real installed file.
  // Restricted to exactly this set so the opt-in's effect is confined to
  // the §3-problem names: families NOT caught by isStandard14Family
  // (Verdana, Tahoma, Segoe, …) already route to the custom-primary
  // embed chain and must keep their existing fuzzy-match behavior.
  // INVARIANT: familyNeedsEmbedding(f) ⊆ isStandard14Family(f).
  const OFFICE_SUITE_EMBEDDABLE = ['arial', 'calibri', 'cambria', 'georgia']
  return OFFICE_SUITE_EMBEDDABLE.some((f) => s.includes(f))
}

/** Build a deterministic font_id from (family, bold, italic). Used
 *  as the key in `EngineEditModel.embeddedFonts` and as the value
 *  written into each ParagraphEdit's `customFontId`. */
function buildFontId(family: string, bold: boolean, italic: boolean): string {
  const base = family.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const tag = bold && italic ? 'bolditalic' : bold ? 'bold' : italic ? 'italic' : 'regular'
  return `${base}-${tag}`
}

// ── Session 4: WinAnsi coverage mirror + unicode escalation ───────

/** The 27 Windows-1252 specials encode_winansi (bake.rs) maps into
 *  0x80–0x9F. PINNED to the Rust table — the same list appears in
 *  bake.rs's winansi tests; drift here changes which texts escalate
 *  (over-escalation embeds a font unnecessarily; under-escalation
 *  falls into the engine's encodability refusal — never silent). */
const WINANSI_SPECIAL_CODEPOINTS = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6,
  0x2030, 0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c,
  0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
  0x0153, 0x017e, 0x0178,
])

/** Mirrors encode_winansi's coverage (bake.rs): ASCII 0x20–0x7E,
 *  Latin-1 0xA0–0xFF, the cp1252 specials. \n and \r never reach the
 *  encoder (line splits). */
export function winAnsiCoversCodepoint(cp: number): boolean {
  if (cp === 0x0a || cp === 0x0d) return true
  if (cp >= 0x20 && cp <= 0x7e) return true
  if (cp >= 0xa0 && cp <= 0xff) return true
  return WINANSI_SPECIAL_CODEPOINTS.has(cp)
}

/** Unique codepoints in `text` the WinAnsi (Standard-14) route would
 *  DROP — non-empty means the route needs escalation or refusal. */
export function winAnsiUncoveredCodepoints(text: string): number[] {
  const missing = new Set<number>()
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (!winAnsiCoversCodepoint(cp)) missing.add(cp)
  }
  return Array.from(missing)
}

/** EXACT mirror of bake.rs family_is_faithful_standard14 — true when
 *  the engine's own substitution emitter is BLIND to this family
 *  string (it reads the stack as faithful Std-14 and stays silent),
 *  so the TS side must record the substitution instead. One fact,
 *  one owner (verifier gate-2 P1-1: the previous gate used the wider
 *  isStandard14Family fragment list, whose extra tokens — consolas,
 *  mono, arial… — diverged from the Rust predicate; a monospace
 *  stack without a courier token made BOTH sides record). Pinned
 *  cross-language by test-winansi-mirror.mjs +
 *  substitution_recorded_for_unknown_family in bake.rs. */
export function engineBlindToSubstitution(familyStack: string): boolean {
  const s = familyStack.toLowerCase()
  return (
    s.trim() === '' ||
    s.includes('helvetica') ||
    s.includes('times') ||
    s.includes('courier')
  )
}

/** Unicode-capable system family for a Standard-14-class request.
 *  Mirrors bake.rs resolve_family's bucketing; these three ship with
 *  every Windows install and carry wide BMP coverage. */
export function escalationFamilyFor(family: string): string {
  const s = family.toLowerCase()
  if (s.includes('times') || s.includes('serif') || s.includes('roman') ||
      s.includes('georgia') || s.includes('cambria')) return 'Times New Roman'
  if (s.includes('courier') || s.includes('mono') || s.includes('consolas') ||
      s.includes('menlo') || s.includes('inconsolata') || s.includes('fixed')) return 'Courier New'
  return 'Arial'
}

/** Deliberate save refusal: replacement text contains characters NO
 *  available font can draw. The alternatives were a silent character
 *  drop (the pre-Session-1 behavior) or a three-layer crash ending in
 *  pdf-lib's WinAnsi error. Thrown OUT of the save — refused saves
 *  write no report (Session-3 contract), so the message itself names
 *  the characters and paragraphs. */
export class UnencodableReplacementError extends Error {
  constructor(codepoints: number[], paragraphIds: string[]) {
    const chars = codepoints
      .slice(0, 8)
      .map((cp) => {
        const printable = (() => {
          try { return String.fromCodePoint(cp) } catch { return '?' }
        })()
        return `U+${cp.toString(16).toUpperCase().padStart(4, '0')} (${printable})`
      })
      .join(', ')
    super(
      `save refused: replacement text contains characters no available font can draw: ${chars}` +
        (codepoints.length > 8 ? ` (+${codepoints.length - 8} more)` : '') +
        ` in paragraph(s) ${paragraphIds.join(', ')}. ` +
        'Remove the characters or install a font that covers them.',
    )
    this.name = 'UnencodableReplacementError'
  }
}

// ── Session 4: overlay-stage font resolution chain ────────────────

interface PendingRecord {
  area: string
  detail: string
  severity?: 'info' | 'fidelity' | 'security'
  pageIndex?: number
  paragraphId?: string
}

interface OverlayFontResolution {
  /** Records that are true ONLY if the engine overlay materializes
   *  (font.substituted for engine-blind families, escalation infos,
   *  the D3 per-paragraph enumeration). Flushed by the caller on the
   *  overlay success return — a bake failure falls to pd-lib, which
   *  runs its OWN resolution + records. */
  pendingOnSuccess: PendingRecord[]
}

/** Tagged result of pdf_extract_font_payload (serde enum). */
type DocFontExtractionResult =
  | { status: 'usable'; bytes: number[]; ps_name: string; missing_codepoints: number[] }
  | { status: 'unusable'; ps_name: string; reason: string }
  | { status: 'not_found' }

/** Extraction with heavy-doc path routing: >1 MiB documents go
 *  through a temp file + the _from_path command instead of marshaling
 *  the whole byte buffer through JSON-array IPC. */
async function extractDocFontPayload(
  pdfBytes: Uint8Array,
  family: string,
  codepoints: number[],
  isHeavy: boolean,
): Promise<DocFontExtractionResult | null> {
  try {
    if (!isHeavy) {
      return await invoke<DocFontExtractionResult>('pdf_extract_font_payload', {
        bytes: Array.from(pdfBytes),
        family,
        codepoints,
      })
    }
    let inPath: string | null = null
    try {
      const { tempDir, join } = await import('@tauri-apps/api/path')
      const { writeFile } = await import('@tauri-apps/plugin-fs')
      const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      inPath = await join(await tempDir(), `os-fontx-${stamp}.pdf`)
      await writeFile(inPath, pdfBytes)
      return await invoke<DocFontExtractionResult>('pdf_extract_font_payload_from_path', {
        path: inPath,
        family,
        codepoints,
      })
    } finally {
      try {
        const { remove } = await import('@tauri-apps/plugin-fs')
        if (inPath) await remove(inPath).catch(() => undefined)
      } catch { /* swallow */ }
    }
  } catch (e) {
    // Tauri unavailable (dev preview) or command error — the chain
    // proceeds to system-font resolution; pd-lib remains the floor.
    console.warn(`[engine-bake] doc-font extraction unavailable for '${family}':`, e)
    return null
  }
}

/** Subset `bytes` to `codepoints` and pack into the model's embedded
 *  pool under `id`. Subsetter failure embeds the full font (recorded
 *  info — larger file, same fidelity). */
async function subsetAndPack(
  embeddedFonts: Record<string, EngineEmbeddedFont>,
  id: string,
  fontBytes: Uint8Array | number[],
  codepoints: number[],
  postscriptName: string,
  bold: boolean,
  italic: boolean,
  collector?: SaveDegradationCollector,
): Promise<void> {
  const fullBytes = Array.isArray(fontBytes) ? fontBytes : Array.from(fontBytes)
  let packed: number[] = fullBytes
  try {
    const subset = await invoke<number[]>('font_subset', {
      bytes: fullBytes,
      codepoints,
    })
    // Session-4 discovery (pinned by subset_loses_cmap_documented_
    // limitation in commands/font.rs): the Typst subsetter DROPS the
    // cmap table — Typst maps text→glyphs itself, but OUR engine
    // encodes through the payload's own cmap (encode_cids), so a
    // cmap-less subset makes every glyph unmappable and the
    // encodability guard refuses the bake (the save then silently
    // degraded to pd-lib — the pre-Session-4 G2 path could never
    // actually bake). Verify the subset still maps the codepoints;
    // when it doesn't, embed the FULL font: larger file, full
    // fidelity, recorded.
    const lost = await invoke<number[]>('font_coverage', {
      bytes: subset,
      codepoints,
    })
    if (lost.length === 0) {
      packed = subset
    } else {
      collector?.record({
        area: 'font.subset_failed_full_embed',
        detail:
          `subset output for '${id}' lost cmap mappings for ${lost.length} codepoint(s) ` +
          '(Typst subsetter drops cmap); embedding the full font (larger file, same fidelity)',
      })
    }
  } catch (e) {
    console.warn(`[engine-bake/G2] font_subset failed for ${id}, embedding full font:`, e)
    collector?.record({
      area: 'font.subset_failed_full_embed',
      detail: `font_subset failed for '${id}'; embedding the full font (larger file, same fidelity)`,
    })
  }
  embeddedFonts[id] = {
    bytes: packed,
    postscriptName,
    bold,
    italic,
  }
}

/** The Session-4 resolution chain — runs at the OVERLAY stage only
 *  (after the true rewrite failed or was forceOverlay-skipped; a
 *  successful rewrite keeps the document's own fonts and does none of
 *  this work). Per unique (family, bold, italic) tuple with drawn
 *  text:
 *
 *  CUSTOM primary family:
 *    1. document-embedded font extraction (the FAITHFUL choice — the
 *       doc usually carries the real typeface) with glyph coverage;
 *    2. system-font resolution (+ coverage; fuzzy matches recorded);
 *    3. loud failure — font.embed_resolution_failed (fidelity) +
 *       font.substituted (TS for engine-blind stacks, engine for bare
 *       families — mutual exclusivity preserved), then the
 *       Standard-14 landing gets the WinAnsi check below.
 *
 *  STANDARD-14 primary family:
 *    WinAnsi-coverable text → unchanged Std-14 route (silent).
 *    Non-WinAnsi characters → escalate to an embedded unicode-capable
 *    system face (Arial / Times New Roman / Courier New), coverage-
 *    checked BEFORE embedding; truly uncoverable characters throw
 *    UnencodableReplacementError — the save is REFUSED with the
 *    characters named, never a silent drop.
 *
 *  Every edit also gets a pending D3 enumeration record naming the
 *  font treatment + the properties the overlay approximates. */
async function resolveOverlayFonts(
  pdfBytes: Uint8Array,
  editsByPage: Map<number, ParagraphEdit[]>,
  embeddedFonts: Record<string, EngineEmbeddedFont>,
  collector: SaveDegradationCollector | undefined,
  isHeavy: boolean,
  embedInstalledFonts: boolean,
): Promise<OverlayFontResolution> {
  interface EditRef {
    pageIdx: number
    editIdx: number
    paragraphId: string
    newText: string
    /** This edit's OWN family stack — the engine-blindness decision
     *  is per-edit (verifier gate-2 P1-2: edits sharing a primary can
     *  arrive bare from a UI gesture AND stacked from cluster
     *  recovery; deciding on the first-seen stack made recording
     *  order-dependent). */
    family: string
    /** Session 5 (R5b): this edit's source font is EMBEDDED but its
     *  family is unrecoverable — the generic stack is a fallback of
     *  necessity, so the Standard-14 landing is a real substitution,
     *  never the silent "faithful/alias class" label. Per-edit:
     *  tuples key on (primary,bold,italic), and a generic primary can
     *  collect flagged and unflagged edits in one tuple. */
    genericFallback: boolean
  }
  interface TupleEntry {
    family: string
    primary: string
    bold: boolean
    italic: boolean
    codepoints: Set<number>
    edits: EditRef[]
  }
  const tuples = new Map<string, TupleEntry>()
  const pendingOnSuccess: PendingRecord[] = []
  /** paragraphId → font-treatment label for the D3 enumeration. */
  const treatments = new Map<string, { label: string; ref: EditRef; pageIdx: number }>()

  for (const [pageIdx, edits] of editsByPage) {
    edits.forEach((edit, editIdx) => {
      if (!edit.newText) return // delete-only: mask, no text draw
      const family = edit.fontFamily ?? ''
      const primary = primaryFamily(family)
      const ref: EditRef = {
        pageIdx, editIdx, paragraphId: edit.paragraphId, newText: edit.newText, family,
        genericFallback: edit.fontFamilyIsGenericFallback === true,
      }
      const id = buildFontId(primary || family || 'default', !!edit.bold, !!edit.italic)
      let entry = tuples.get(id)
      if (!entry) {
        entry = {
          family,
          primary,
          bold: !!edit.bold,
          italic: !!edit.italic,
          codepoints: new Set(),
          edits: [],
        }
        tuples.set(id, entry)
      }
      entry.edits.push(ref)
      for (const ch of edit.newText) entry.codepoints.add(ch.codePointAt(0)!)
    })
  }

  const setCustomFontId = (entry: TupleEntry, id: string) => {
    for (const { pageIdx, editIdx } of entry.edits) {
      const arr = editsByPage.get(pageIdx)
      if (arr && arr[editIdx]) arr[editIdx] = { ...arr[editIdx], customFontId: id }
    }
  }
  const setTreatment = (entry: TupleEntry, label: string) => {
    for (const ref of entry.edits) {
      treatments.set(ref.paragraphId, { label, ref, pageIdx: ref.pageIdx })
    }
  }

  /** Escalation: embed a unicode-capable system face or REFUSE.
   *  `substitutedParagraphIds` limits the per-edit substitution record
   *  to the refs the substitution fact is true FOR (Session 5: a
   *  generic-primary tuple can mix unrecoverable-font edits with
   *  ordinary alias-class edits; only the former substituted).
   *  Omitted → all edits (the custom-primary path, where the whole
   *  tuple shares the unresolved family). */
  const escalateOrRefuse = async (
    id: string,
    entry: TupleEntry,
    uncovered: number[],
    substitutedFromPrimary: string | null,
    substitutedParagraphIds?: Set<string>,
  ): Promise<void> => {
    const escFamily = escalationFamilyFor(
      substitutedFromPrimary ? 'helvetica' : entry.primary || 'helvetica',
    )
    const allCps = Array.from(entry.codepoints)
    let resolved: Awaited<ReturnType<typeof resolveSystemFont>> = null
    try {
      resolved = await resolveSystemFont(escFamily, entry.bold, entry.italic)
    } catch { /* fall through to refusal */ }
    if (resolved) {
      let missing: number[]
      try {
        missing = await invoke<number[]>('font_coverage', {
          bytes: Array.from(resolved.bytes),
          codepoints: allCps,
        })
      } catch {
        // Coverage UNKNOWABLE → refuse (gate-2 P2-3): proceeding here
        // meant the engine's encodability guard threw, the bake fell
        // to pd-lib, and pdf-lib's WinAnsi crash replaced the named
        // refusal — the exact failure mode the deliberate refusal
        // exists to prevent. Preservation cannot be guaranteed, so
        // the save is refused with the characters named.
        throw new UnencodableReplacementError(
          uncovered,
          entry.edits.map((e) => e.paragraphId),
        )
      }
      if (missing.length === 0) {
        await subsetAndPack(
          embeddedFonts, id, resolved.bytes, allCps,
          resolved.id || resolved.family, entry.bold, entry.italic, collector,
        )
        setCustomFontId(entry, id)
        for (const ref of entry.edits) {
          // Per-edit honesty (gate-2 P3): the tuple unions codepoints
          // across edits — only edits whose OWN text carries
          // non-WinAnsi characters get the escalation record.
          const ownUncovered = winAnsiUncoveredCodepoints(ref.newText)
          if (ownUncovered.length > 0) {
            const charList = ownUncovered
              .slice(0, 8)
              .map((cp) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`)
              .join(' ')
            pendingOnSuccess.push({
              area: 'font.unicode_escalated',
              detail:
                `replacement text contains characters outside WinAnsi (${charList}); ` +
                `drawn with embedded '${resolved.family}' to preserve them`,
              pageIndex: ref.pageIdx,
              paragraphId: ref.paragraphId,
            })
          }
          if (
            substitutedFromPrimary &&
            (substitutedParagraphIds === undefined ||
              substitutedParagraphIds.has(ref.paragraphId))
          ) {
            pendingOnSuccess.push({
              area: 'font.substituted',
              detail: substitutionDetail(
                substitutedFromPrimary,
                `${resolved.family} (unicode escalation)`,
                `paragraph=${ref.paragraphId}`,
              ),
              pageIndex: ref.pageIdx,
              paragraphId: ref.paragraphId,
            })
          }
        }
        setTreatment(entry, `unicode escalation → embedded '${resolved.family}'`)
        return
      }
      // The escalated face itself lacks glyphs → refuse with the
      // REAL missing set (what Arial can't draw, not what WinAnsi
      // couldn't).
      throw new UnencodableReplacementError(
        missing,
        entry.edits.map((e) => e.paragraphId),
      )
    }
    throw new UnencodableReplacementError(
      uncovered,
      entry.edits.map((e) => e.paragraphId),
    )
  }

  for (const [id, entry] of tuples) {
    const allCps = Array.from(entry.codepoints)
    const allText = entry.edits.map((e) => e.newText).join('\n')

    // §3: when the user opts in, an office-suite name (Arial/Calibri/…)
    // that would otherwise take Standard-14 metrics is routed to the
    // custom-primary chain below to EMBED its installed file instead.
    // Excludes genericFallback edits (their real font is unrecoverable —
    // Standard-14 substitution is the honest landing, §5c) and the
    // genuine Standard-14 trio (familyNeedsEmbedding returns false).
    const officeSuiteEmbed =
      embedInstalledFonts &&
      familyNeedsEmbedding(entry.primary) &&
      !entry.edits.some((r) => r.genericFallback)

    // ── Standard-14-class primary: WinAnsi check + escalation ──
    if (isStandard14Family(entry.primary) && !officeSuiteEmbed) {
      // Session 5 (R5b): edits whose generic stack exists only because
      // the document's embedded font has an unrecoverable name are NOT
      // the faithful/alias class — that was the silent Standard-14
      // collapse the Session-3/4 review flagged. Per-edit: the same
      // generic primary can carry flagged and unflagged edits.
      const flagged = entry.edits.filter((r) => r.genericFallback)
      // The unrecoverable-doc-font fact records regardless of where
      // the draw lands (std-14 metrics or a unicode-escalated face).
      for (const ref of flagged) {
        collector?.record({
          area: 'font.embed_resolution_failed',
          detail:
            `the document embeds the font drawn by paragraph ${ref.paragraphId} but its ` +
            'family name is unrecoverable (CID/Type3/name-table-less subset); the overlay ' +
            'redraw cannot reuse it',
          pageIndex: ref.pageIdx,
          paragraphId: ref.paragraphId,
        })
      }
      const uncovered = winAnsiUncoveredCodepoints(allText)
      if (uncovered.length === 0) {
        for (const ref of flagged) {
          // One owner per substitution fact (Session-2/4 invariant):
          // TS records only stacks the engine reads as faithful
          // Std-14 and stays silent on; families the engine CAN see
          // (e.g. a bare 'monospace' stack) reach bake.rs's own
          // emitter.
          if (engineBlindToSubstitution(ref.family)) {
            pendingOnSuccess.push({
              area: 'font.substituted',
              detail: substitutionDetail(
                'unrecoverable embedded font',
                'standard-14 metrics',
                `paragraph=${ref.paragraphId}`,
              ),
              pageIndex: ref.pageIdx,
              paragraphId: ref.paragraphId,
            })
          }
          treatments.set(ref.paragraphId, {
            label: 'substituted standard-14 (document font unrecoverable)',
            ref,
            pageIdx: ref.pageIdx,
          })
        }
        for (const ref of entry.edits) {
          if (ref.genericFallback) continue
          treatments.set(ref.paragraphId, {
            label: 'standard-14 (faithful/alias class)',
            ref,
            pageIdx: ref.pageIdx,
          })
        }
        continue
      }
      // Escalation owns the substitution record + treatment for the
      // refs it draws; pass the flagged set so the unrecoverable-font
      // fact is never dropped on this branch (gate-1 P1).
      await escalateOrRefuse(
        id,
        entry,
        uncovered,
        flagged.length > 0 ? 'unrecoverable embedded font' : null,
        new Set(flagged.map((r) => r.paragraphId)),
      )
      continue
    }

    // ── Custom primary: doc extraction → system font → loud sub ──
    let resolvedVia: string | null = null

    const docResult = await extractDocFontPayload(pdfBytes, entry.primary, allCps, isHeavy)
    if (docResult?.status === 'usable' && docResult.missing_codepoints.length === 0) {
      await subsetAndPack(
        embeddedFonts, id, docResult.bytes, allCps,
        docResult.ps_name || entry.primary, entry.bold, entry.italic, collector,
      )
      setCustomFontId(entry, id)
      // Honesty (gate-2 P3): extraction matches by FAMILY only — a
      // bold/italic request re-embeds the family's found program and
      // synthesizes the style at the descriptor level.
      setTreatment(
        entry,
        `document font re-embedded ('${entry.primary}')` +
          (entry.bold || entry.italic
            ? ' (requested bold/italic approximated by the embedded program)'
            : ''),
      )
      resolvedVia = 'doc'
      continue
    }
    if (docResult?.status === 'usable') {
      // Embedded and parseable but missing glyphs for THIS text.
      const miss = docResult.missing_codepoints
        .slice(0, 8)
        .map((cp) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`)
        .join(' ')
      collector?.record({
        area: 'font.doc_embed_unusable',
        detail:
          `document embeds '${docResult.ps_name}' but it lacks glyphs for the replacement ` +
          `text (${miss}); trying system fonts`,
      })
    } else if (docResult?.status === 'unusable') {
      collector?.record({
        area: 'font.doc_embed_unusable',
        detail: `document embeds '${docResult.ps_name}' but it cannot be reused: ${docResult.reason}`,
      })
    }
    // not_found / null → silent; the family simply isn't in the doc.

    if (!resolvedVia) {
      let resolved: Awaited<ReturnType<typeof resolveSystemFont>> = null
      try {
        resolved = await resolveSystemFont(entry.family, entry.bold, entry.italic)
      } catch (e) {
        console.warn(`[engine-bake/G2] resolveSystemFont failed for ${id}:`, e)
      }
      if (resolved) {
        let missing: number[] | null = null
        try {
          missing = await invoke<number[]>('font_coverage', {
            bytes: Array.from(resolved.bytes),
            codepoints: allCps,
          })
        } catch {
          // Coverage unknowable → treat as a failed step (gate-2
          // P2-3 sibling): embedding an unverified face risks the
          // engine guard refusing the bake and the save degrading
          // through pd-lib with a worse outcome than the loud
          // Standard-14 substitution below.
          missing = null
        }
        if (missing !== null && missing.length === 0) {
          if (officeSuiteEmbed && resolved.matchKind === 'fuzzy') {
            // §3: office-suite embedding is gated to an EXACT installed
            // match — a fuzzy/bidirectional-containment match risks
            // borrowing the WRONG face (e.g. a different family that
            // merely contains 'calibri'). Decline to embed; the loud
            // Standard-14 substitution below owns the honest fallback.
            collector?.record({
              area: 'font.system_match_fuzzy',
              detail:
                `office-suite family '${entry.primary}' only fuzzy-matched system font ` +
                `'${resolved.family}'; not embedded (exact match required for office-suite), ` +
                'Standard-14 metrics used',
            })
          } else {
            if (resolved.matchKind === 'fuzzy') {
              collector?.record({
                area: 'font.system_match_fuzzy',
                detail:
                  `system font '${resolved.family}' matched requested family '${entry.primary}' ` +
                  'by fuzzy name containment, not exact equality',
              })
            }
            await subsetAndPack(
              embeddedFonts, id, resolved.bytes, allCps,
              resolved.id || resolved.family, entry.bold, entry.italic, collector,
            )
            setCustomFontId(entry, id)
            setTreatment(entry, `system font embedded ('${resolved.family}')`)
            resolvedVia = 'system'
          }
        }
      }
    }

    if (!resolvedVia) {
      // Loud failure: the chain exhausted both faithful options.
      collector?.record({
        area: 'font.embed_resolution_failed',
        detail:
          `no usable font for family='${entry.primary}' bold=${entry.bold} italic=${entry.italic} ` +
          '(document embed not reusable or absent; no system font match)',
      })
      // Substitution record: TS owns it ONLY when the engine is blind
      // to it (the edit's stack reads as faithful Std-14 to bake.rs's
      // family_is_faithful_standard14, so its emitter stays silent).
      // Families the engine CAN see reach its emitter — recording
      // here too would double-report one fact (Session-2 mutual-
      // exclusivity design). PER-EDIT decision on each edit's own
      // stack (gate-2 P1-1/P1-2: predicate now an exact Rust mirror;
      // order-independent).
      for (const ref of entry.edits) {
        if (!engineBlindToSubstitution(ref.family)) continue
        pendingOnSuccess.push({
          area: 'font.substituted',
          detail: substitutionDetail(
            entry.primary,
            'standard-14 metrics',
            '(family stack collapsed to a standard-14 alias; document/system resolution failed)',
          ),
          pageIndex: ref.pageIdx,
          paragraphId: ref.paragraphId,
        })
      }
      setTreatment(entry, `substituted standard-14 (requested '${entry.primary}')`)
      // The Standard-14 landing still has to encode the text:
      const uncovered = winAnsiUncoveredCodepoints(allText)
      if (uncovered.length > 0) {
        await escalateOrRefuse(id, entry, uncovered, entry.primary)
      }
    }
  }

  // ── D3: per-paragraph overlay-limitations enumeration ──────────
  // The detail names exactly what the overlay approximates relative
  // to the original run (write_edit_block in bake.rs): font
  // treatment, recomputed baseline/leading, unpreserved spacing and
  // horizontal scaling, re-laid alignment, bbox clipping. Info
  // severity — the fidelity event for the path itself is
  // engine.rewrite_to_overlay; this record is the enumeration the
  // epic's deliverable 3 requires a strict test to SEE.
  for (const [pageIdx, edits] of editsByPage) {
    for (const edit of edits) {
      if (!edit.newText || edit.isNewTextBox) continue
      const t = treatments.get(edit.paragraphId)
      const lineHeight = edit.lineHeight && edit.lineHeight > 0 ? edit.lineHeight : 1.2
      pendingOnSuccess.push({
        area: 'overlay.properties_approximated',
        detail:
          `paragraph ${edit.paragraphId}: font=${t?.label ?? 'standard-14 (faithful/alias class)'}; ` +
          `baseline+leading recomputed (0.85em cap heuristic, x${lineHeight} leading); ` +
          'char/word spacing + horizontal scaling not preserved; ' +
          `alignment='${edit.align ?? 'left'}' re-laid from box geometry; draw clipped to bbox`,
        pageIndex: pageIdx,
        paragraphId: edit.paragraphId,
      })
    }
  }

  return { pendingOnSuccess }
}
