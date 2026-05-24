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
import type { ParagraphEdit } from './pdfParagraphEdits'
import { resolveSystemFont } from './pdfFontResolution'

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
): Promise<Uint8Array | null> {
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
    await invoke<void>('pdf_strip_text_in_bboxes_to_path', {
      input_path: inPath,
      output_path: outPath,
      bboxes,
    })
    const bytes = await readFile(outPath)
    return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
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
): Promise<{ bytes: Uint8Array; summary: any } | null> {
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
    const summary = await invoke<{
      total_bytes: number
      appended_bytes: number
      new_xref_offset: number
      previous_xref_offset: number
      new_objects_emitted: number
    }>(cmd, { inputPath: inPath, outputPath: outPath, model })
    const bytes = await readFile(outPath)
    return {
      bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
      summary,
    }
  } catch (err) {
    console.warn(`[engine-bake] path-routed ${cmd} failed:`, err)
    return null
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
  /** When the true rewrite couldn't apply, this is the engine's reason
   *  (e.g. "font has no ToUnicode CMap", "multi-run paragraph"). */
  rewriteFailureReason?: string
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
): Promise<EngineBakeOutcome | null> {
  if (paragraphEditsByPage.size === 0) return null

  // G2: pre-resolve embedded fonts BEFORE building the model. For
  // each unique non-Standard-14 (family, bold, italic) tuple in the
  // edits, look up a system font via resolveSystemFont then subset
  // it via font_subset (Typst-rust subsetter). Successful resolutions
  // get a customFontId that the bake stage uses to route through the
  // /FontFile2 path; failed resolutions fall through to Standard 14.
  const embeddedFonts: Record<string, EngineEmbeddedFont> = {}
  // Mutate edits in-place to set customFontId. We deep-clone the
  // input map so the caller's references stay clean.
  const edits_cloned: Map<number, ParagraphEdit[]> = new Map(
    Array.from(paragraphEditsByPage, ([k, v]) => [k, v.map((e) => ({ ...e }))]),
  )
  await populateEmbeddedFonts(edits_cloned, embeddedFonts)

  const pages: Record<string, { paragraphs: ParagraphEdit[] }> = {}
  for (const [pageIndex, edits] of edits_cloned) {
    if (edits.length === 0) continue
    pages[String(pageIndex)] = { paragraphs: edits }
  }
  if (Object.keys(pages).length === 0) return null

  // Overlay-stage model: pass through as-is (the overlay path renders
  // multi-line text correctly via per-line drawText emit, see
  // pdf_engine/bake.rs).
  const model: EngineEditModel = {
    sourceHash: '',
    pages,
    version: 1,
    embeddedFonts: Object.keys(embeddedFonts).length > 0 ? embeddedFonts : undefined,
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

  // If any edit is style-only (fontSize / color / fontFamily / bold /
  // italic / align changed vs original), skip stage 1 entirely — the
  // rewrite path only touches Tj operands and would silently drop the
  // style change. Go straight to overlay, which re-emits Tf + rg for
  // each edit and thus honors style changes correctly.
  let forceOverlay = false
  for (const pageIndex of paragraphEditsByPage.keys()) {
    const edits = paragraphEditsByPage.get(pageIndex) ?? []
    if (edits.some((e) => e.styleChanged === true)) {
      forceOverlay = true
      break
    }
  }

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
    rewriteFailureReason = 'style-change edit present — routed to overlay'
  } else try {
    let outBytes: Uint8Array
    let rawSummary: any
    if (isHeavy) {
      const routed = await bakeViaPathRoute('engine_rewrite_to_path', pdfBytes, rewriteModel)
      if (!routed) throw new Error('path-routed rewrite returned null')
      outBytes = routed.bytes
      rawSummary = routed.summary
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
      }>('engine_rewrite_from_bytes', {
        bytes: Array.from(pdfBytes),
        model: rewriteModel,
      })
      outBytes = raw.bytes instanceof Uint8Array ? raw.bytes : new Uint8Array(raw.bytes)
      rawSummary = raw.summary
    }
    console.log(
      `[engine-rewrite] true text edit: ${rawSummary.appended_bytes} bytes appended,`,
      `${rawSummary.new_objects_emitted} object(s) superseded`,
    )
    return {
      path: 'rewrite',
      bytes: outBytes,
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

  // Stage 2: overlay bake fallback. Pre-strip the original text in
  // each edit's bbox via pdf_strip_text_in_bboxes (G9 — destructive
  // overlay backstop). This makes the overlay paint go onto already-
  // clean bytes, so forensic tools / strings(1) / Acrobat extract
  // can't recover the original text from beneath the whiteout. Even
  // when the rewrite stage couldn't find a Tj match (multi-run
  // paragraphs, encoding edge cases, full-line deletes), pdfium's
  // bbox-based text-object removal gets it.
  let prepBytes: Uint8Array = pdfBytes
  try {
    const stripBboxes: Array<{
      page_index: number
      x: number; y: number; width: number; height: number
      coord_space: 'css'
    }> = []
    for (const [pageIndex, edits] of paragraphEditsByPage) {
      for (const e of edits) {
        if (!e.bbox) continue
        // Frontend bbox is CSS top-left; engine flips per-page using
        // page height. Pad slightly so partial-overlap edges still get
        // stripped (Tj bounds can extend a couple px past the visible
        // glyph quad).
        const pad = 2
        stripBboxes.push({
          page_index: pageIndex,
          x: (e.bbox.x ?? 0) - pad,
          y: (e.bbox.y ?? 0) - pad,
          width: (e.bbox.width ?? 0) + pad * 2,
          height: (e.bbox.height ?? 0) + pad * 2,
          coord_space: 'css',
        })
      }
    }
    if (stripBboxes.length > 0) {
      if (isHeavy) {
        // Path-route the strip pre-pass to avoid the 33 MB
        // Array.from + JSON-array marshal in BOTH directions.
        const stripped = await stripViaPathRoute(pdfBytes, stripBboxes)
        if (stripped) {
          prepBytes = stripped
          console.log(
            `[engine-bake] G9 destructive backstop (path-routed): stripped ${stripBboxes.length} text bbox(es) before overlay`,
          )
        } else {
          // Path route failed; fall through to overlay without strip.
          // Visual output is still correct, original text is recoverable.
          console.warn('[engine-bake] G9 path-routed strip failed; overlay will leak original text')
        }
      } else {
        const stripped = await invoke<number[]>('pdf_strip_text_in_bboxes', {
          bytes: Array.from(pdfBytes),
          bboxes: stripBboxes,
        })
        prepBytes = stripped instanceof Uint8Array ? stripped : new Uint8Array(stripped)
        console.log(
          `[engine-bake] G9 destructive backstop: stripped ${stripBboxes.length} text bbox(es) before overlay`,
        )
      }
    }
  } catch (stripErr) {
    console.warn('[engine-bake] G9 strip pre-pass failed, overlay will leak original:', stripErr)
    // Continue with original bytes — overlay still paints visually
    // correct output, just leaves the original text recoverable.
  }

  try {
    let outBytes: Uint8Array
    let rawSummary: any
    const isHeavyPrep = prepBytes.byteLength > HEAVY_BYTES_THRESHOLD
    if (isHeavyPrep) {
      const routed = await bakeViaPathRoute('engine_bake_to_path', prepBytes, model)
      if (!routed) throw new Error('path-routed bake returned null')
      outBytes = routed.bytes
      rawSummary = routed.summary
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
      }>('engine_bake_from_bytes', {
        bytes: Array.from(prepBytes),
        model,
      })
      outBytes = raw.bytes instanceof Uint8Array ? raw.bytes : new Uint8Array(raw.bytes)
      rawSummary = raw.summary
    }
    return {
      path: 'overlay',
      rewriteFailureReason,
      bytes: outBytes,
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
 *  what counts as "needs embedding". */
function isStandard14Family(family: string | undefined): boolean {
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

/** Build a deterministic font_id from (family, bold, italic). Used
 *  as the key in `EngineEditModel.embeddedFonts` and as the value
 *  written into each ParagraphEdit's `customFontId`. */
function buildFontId(family: string, bold: boolean, italic: boolean): string {
  const base = family.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const tag = bold && italic ? 'bolditalic' : bold ? 'bold' : italic ? 'italic' : 'regular'
  return `${base}-${tag}`
}

/** Walk every edit, collect the unique non-Standard-14 (family, bold,
 *  italic) tuples, resolve each to a TTF via `resolveSystemFont`,
 *  subset it via the `font_subset` Tauri command using the codepoints
 *  that family actually uses, and pack the bytes into `embeddedFonts`.
 *  Each edit using a successfully-resolved font gets its
 *  `customFontId` field set so the bake stage routes it through the
 *  embedded path.
 *
 *  Failures (no system font matches, font_subset errors, Tauri not
 *  available in dev preview) are non-fatal: the edit's customFontId
 *  stays unset and the bake falls through to Standard 14 (visible
 *  substitution, but the document still saves).
 */
async function populateEmbeddedFonts(
  editsByPage: Map<number, ParagraphEdit[]>,
  embeddedFonts: Record<string, EngineEmbeddedFont>,
): Promise<void> {
  // First pass: collect unique tuples + the codepoints each one
  // needs, plus a list of (page, index) pointers so we can write
  // customFontId back after resolving.
  interface TupleEntry {
    family: string
    bold: boolean
    italic: boolean
    codepoints: Set<number>
    edits: { pageIdx: number; editIdx: number }[]
  }
  const tuples = new Map<string, TupleEntry>()

  for (const [pageIdx, edits] of editsByPage) {
    edits.forEach((edit, editIdx) => {
      const family = edit.fontFamily ?? ''
      if (isStandard14Family(family)) return
      const bold = !!edit.bold
      const italic = !!edit.italic
      const id = buildFontId(family, bold, italic)
      let entry = tuples.get(id)
      if (!entry) {
        entry = { family, bold, italic, codepoints: new Set(), edits: [] }
        tuples.set(id, entry)
      }
      entry.edits.push({ pageIdx, editIdx })
      for (const ch of edit.newText) {
        entry.codepoints.add(ch.codePointAt(0)!)
      }
    })
  }

  if (tuples.size === 0) return

  // Second pass: resolve + subset + pack.
  for (const [id, entry] of tuples) {
    let resolved: { id: string; family: string; style: string; bytes: Uint8Array } | null = null
    try {
      resolved = await resolveSystemFont(entry.family, entry.bold, entry.italic)
    } catch (e) {
      console.warn(`[engine-bake/G2] resolveSystemFont failed for ${id}:`, e)
    }
    if (!resolved) {
      // No system font match — leave customFontId unset; bake falls
      // through to Standard 14 substitution.
      continue
    }
    let subsetBytes: Uint8Array = resolved.bytes
    try {
      const codepointsArr = Array.from(entry.codepoints)
      const subset = await invoke<number[]>('font_subset', {
        bytes: Array.from(resolved.bytes),
        codepoints: codepointsArr,
      })
      subsetBytes = new Uint8Array(subset)
    } catch (e) {
      // Subsetter failure → embed the FULL font. Larger output but
      // still correct.
      console.warn(`[engine-bake/G2] font_subset failed for ${id}, embedding full font:`, e)
    }
    embeddedFonts[id] = {
      bytes: Array.from(subsetBytes),
      postscriptName: resolved.id || resolved.family,
      bold: entry.bold,
      italic: entry.italic,
    }
    // Wire customFontId back into each affected edit.
    for (const { pageIdx, editIdx } of entry.edits) {
      const arr = editsByPage.get(pageIdx)
      if (arr && arr[editIdx]) {
        arr[editIdx] = { ...arr[editIdx], customFontId: id }
      }
    }
  }
}
