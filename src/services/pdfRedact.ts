// True redaction: removes PDF text objects inside each redaction rectangle
// before drawing the black appearance rectangle. Image-like overlaps keep the
// full-page raster fallback so pixels are not left recoverable behind a visual
// overlay. Decorative vector/path overlaps are allowed through the selective
// text path so a highlighted text line does not flatten the rest of the page.
//
// Session 3 (RELEASE-BLOCKING): every redaction save is VERIFIED before it
// is allowed to commit. The pipeline harvests the text under each region
// from the PRE-transform document ("needles"), transforms through a single
// exit, then proves permanence with witnesses the transform code does not
// own: a Rust raw/stream/string-object byte scan (lopdf), a pdfjs decoded
// re-extraction (doc-wide + region-empty), an annotation-rect sweep, and
// an image-pixel sweep (any image painted across a region must carry the
// redaction in its PIXELS — the raster path burns regions into the bitmap
// before embedding; a vector box over intact pixels is a failure).
// Failures get ONE remediation pass (rasterize failing pages + scrub
// metadata), are re-verified, and otherwise REFUSE the save by throwing.
// A mask-only output (black box drawn, bytes intact) is a FAILED redaction.

import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef, rgb } from 'pdf-lib'
import { PRESET_PATTERNS } from './pdfRedactPatterns'
import type { SaveDegradationCollector } from './saveDegradations'

export interface RedactionRect {
  page: number // 0-based
  x: number    // PDF points, bottom-left origin (INTRINSIC user space)
  y: number
  width: number
  height: number
  color?: [number, number, number] // default black
  /** Normalized [0,1] TOP-LEFT fraction of the VISIBLE (rendered, /Rotate
   *  applied) page — set for manual marks straight from the display coords,
   *  so it is EXACT for any rotation and independent of the intrinsic-rect
   *  mapping. Drives the GATE-2 pdfium fill witness; absent on machine rects
   *  (find-&-redact), where the witness derives the region from CropBox
   *  geometry (rotation 0). */
  viewRect?: { x: number; y: number; width: number; height: number }
}

/** One piece of text harvested from under a redaction region in the
 *  PRE-transform document. Verification layers consult the eligibility
 *  flags set by classification (see classifyHarvestedNeedles). */
export interface RedactionNeedle {
  /** Raw harvested text (trimmed) — what the Rust byte scan greps for. */
  text: string
  /** Whitespace-stripped, lowercased form for decoded-layer matching. */
  norm: string
  pageIndex: number
  /** Eligible for the document-wide decoded-extraction check. False when
   *  the same token also occurs OUTSIDE the redacted regions (removing
   *  those instances was never requested) or the token is too short to
   *  be a meaningful document-wide witness. */
  docWide: boolean
  /** Eligible for the Rust raw/stream/string-object scan. False for
   *  structural PDF vocabulary ("Pages", "Font", …) that legitimately
   *  appears in the file format itself. */
  rustLayer: boolean
}

export interface RedactionApplyResult {
  bytes: Uint8Array
  /** Harvested needles — callers MUST re-verify with these after any
   *  later byte transform (tagged-PDF restore, pre-encryption). */
  needles: RedactionNeedle[]
  /** The regions that were redacted, for re-verification. */
  rects: RedactionRect[]
}

export interface RedactionVerdict {
  failures: string[]
  failingPages: Set<number>
  /** Needle texts whose survival sites may be /Info or XMP metadata —
   *  remediation scrubs those before the re-verify. */
  metadataScrubCandidates: string[]
}

// ── DEV-only failure injection ───────────────────────────────────
// Proves the refusal path end-to-end: with the flag set, the transform
// draws ONLY the black boxes (mask-only — the classic fake redaction)
// and skips remediation, so verification MUST fail and the save MUST
// throw. Guarded so production builds can never take this branch.
let forceMaskOnly = false

export function __setRedactForceMaskOnly(value: boolean): void {
  if (!import.meta.env.DEV) {
    throw new Error('__setRedactForceMaskOnly is a DEV-only failure-injection hook')
  }
  forceMaskOnly = value
}

/** Cheap detection of a digital signature / document timestamp in the
 *  input. A signed PDF carries a signature dictionary with a /ByteRange
 *  (the signed span) AND a /Sig or /DocTimeStamp /Type. Requiring BOTH
 *  avoids matching an empty (unsigned) /FT /Sig form field. This is a
 *  WARN trigger only — not a cryptographic verification (that is
 *  pdfSign.ts). */
export function documentHasSignature(bytes: Uint8Array): boolean {
  const text = new TextDecoder('latin1').decode(bytes)
  return /\/ByteRange\s*\[/.test(text) && /\/(Sig|DocTimeStamp)\b/.test(text)
}

export async function applyRedactions(
  bytes: Uint8Array,
  rects: RedactionRect[],
  collector?: SaveDegradationCollector,
  opts?: { forceRaster?: boolean },
): Promise<RedactionApplyResult> {
  if (rects.length === 0) return { bytes, needles: [], rects: [] }

  // R9d (Session 9): redaction is a FULL regeneration — a single-revision
  // output (the startxref-marker invariant in verifyRedactionPermanence
  // REFUSES anything else), which NEUTRALIZES any superseded incremental-
  // update revision on UNSIGNED files (no prior-revision leak). On a
  // SIGNED file that same full rewrite INVALIDATES the signature: the
  // signed byte range no longer matches. We never resurrect or selectively
  // rewrite superseded revisions on a signed file (the classic redaction-
  // leak vector) — we regenerate and record the signature loss LOUDLY
  // rather than silently shipping a file the user believes is still signed.
  if (documentHasSignature(bytes)) {
    collector?.record({
      area: 'redact.signature_invalidated',
      detail:
        'this document is digitally signed; redaction rewrites the whole file to remove the ' +
        'content permanently, which invalidates the existing signature - the saved copy is no ' +
        'longer signed. Re-sign it after redacting if a signature is required.',
    })
  }

  // Phase 0 — harvest verification needles from the PRE-transform
  // document. If this throws (unparseable input) the save refuses:
  // a redaction we cannot later verify must not be certified.
  const harvest = await harvestRedactionNeedles(bytes, rects, collector)
  const needles = harvest.needles

  // No-op guard accounting (gauntlet R2 P0). A redaction is only
  // trustworthy if it actually REMOVED something under each region's
  // page. Three independent removal witnesses populate this set:
  //   (1) a needle harvested from the page's region(s) [pdfjs],
  //   (2) a text object stripped on the page [pdfium],
  //   (3) the page was rasterized (pixels burned).
  // A page that carries redaction rects but appears in NONE of these
  // removed nothing — the box landed on no content (empty space, or,
  // on a rotated / non-zero-origin page, in the wrong coordinate
  // frame). The region-scoped verifier layers then pass VACUOUSLY, so
  // we would otherwise certify `permanence_verified` for a box that
  // never touched the real target, leaving it fully extractable. We
  // refuse such a no-op instead (see the guard before Phase 2's record).
  const removalPages = new Set<number>()
  for (const n of needles) removalPages.add(n.pageIndex)

  // Pages that were RASTERIZED (a fill box burned into the pixels) — these
  // are the only pages the GATE-2 independent-frame positive control can
  // confirm (a text-strip page has no fill box to check).
  const rasterizedPages = new Set<number>()

  const maskOnly = forceMaskOnly
  // Legal Guarantee: rasterize EVERY marked page BY CONSTRUCTION, regardless
  // of whether the in-place text strip would have sufficed. There is then no
  // recoverable text/vector object left under any region at all — the page's
  // /Contents is replaced by a burned image (GATE 1/5). Mask-only fault
  // injection owns its own no-removal path and is never force-rasterized.
  const forceRaster = !!opts?.forceRaster && !maskOnly
  let workingBytes = bytes

  if (maskOnly) {
    workingBytes = await drawRedactionRects(bytes, rects, collector)
  } else if (forceRaster) {
    workingBytes = await rasterizeRedactionPages(bytes, rects, collector)
    const flattenedPages = [...new Set(rects.map((r) => r.page))].sort((a, b) => a - b)
    for (const r of rects) {
      removalPages.add(r.page)
      rasterizedPages.add(r.page)
    }
    collector?.record({
      area: 'redact.legal_guarantee_flatten',
      detail:
        `Legal Guarantee: redacted page(s) ${flattenedPages.map((p) => p + 1).join(', ')} ` +
        'were flattened to a secured image by construction - the original content stream was ' +
        'replaced and text/vectors under the marks are destroyed at the pixel level (those pages ' +
        'lose selectable text)',
    })
  } else {
    // Phase 1 — transform. Single exit: failures set flags and fall
    // through; nothing returns early past the verification phase.
    const rasterPages = await probeRasterFallbackPages(bytes, rects, collector)
    // cidredact (§9a): proactively route any redacted page bearing a Type3
    // glyph-procedure, an image-mask stencil, or a Form XObject carrying
    // either to the raster path. These constructs are invisible to BOTH the
    // pdfjs text harvest and the pdfium geometry witness, so a secret drawn
    // this way would otherwise reach a clean verdict while staying readable.
    // Rasterizing flattens the page (the proven-permanent path) and removes
    // the construct at the pixel level; the page loses selectable text. We
    // detect + route BEFORE the witnesses run rather than depending on a
    // witness that is structurally blind to the construct.
    const glyphProcPages = await probeGlyphProcedurePages(bytes, rects, collector)
    for (const [page, constructs] of glyphProcPages) {
      rasterPages.add(page)
      collector?.record({
        area: 'redact.glyph_procedure_rasterized',
        detail:
          `page ${page + 1}: a glyph-procedure construct (${constructs.join('; ')}) is present on a ` +
          'redacted page - a Type3/Form-XObject/image-mask glyph is invisible to the text and ' +
          'geometry redaction witnesses, so the page was rasterized (flattened to a secured image) ' +
          'to remove it permanently. The page loses selectable text.',
        pageIndex: page,
      })
    }
    // §9g (vecredact): raw vector PATH content (filled rects, strokes,
    // bezier curves — outlined text, a chart, a signature, a logo) painted
    // under a redaction mark is invisible to BOTH the text witnesses
    // (Layers 1-3 byte/decoded/region-empty, Layer 6 pdfium) AND the image-
    // pixel sweep (Layer 5). A secret drawn as vector graphics would be
    // COVERED by the box yet survive verbatim in the content stream and reach
    // a falsely-clean `permanence_verified` verdict (§9g, found by red-team
    // of §9a). Detect it GEOMETRICALLY on the ORIGINAL bytes (before the cover
    // box is drawn, so the box never self-trips) and route the page to the
    // proven raster/flatten path. Region-scoped (the path geometry must
    // overlap the rect, so a table border / rule elsewhere does not trip it)
    // and fail-closed (a detector failure rasterizes every redacted page).
    const vectorContentPages = await probeVectorContentPages(bytes, rects, collector)
    for (const page of vectorContentPages) rasterPages.add(page)
    for (const page of harvest.vacuousPages) {
      if (rasterPages.has(page)) continue
      rasterPages.add(page)
      // Vacuous-pass guard: pdfium sees text under a region on this
      // page, but the decoded layer harvested nothing there — the
      // doc-wide check would pass vacuously. Raster is the safe
      // direction (pixels burned, nothing extractable).
      collector?.record({
        area: 'redact.raster_fallback',
        detail:
          `page ${page + 1}: text overlaps a redaction region but the decoded text layer ` +
          'could not harvest it for verification; page rasterized',
        pageIndex: page,
      })
    }
    const tightProbeMissPages = await probeTightBoxesMissingTextPages(
      bytes,
      rects.filter((r) => r.height <= 16 && !rasterPages.has(r.page)),
      collector,
    )
    for (const page of tightProbeMissPages) rasterPages.add(page)
    const rasterRects = rects.filter((r) => rasterPages.has(r.page))
    const textOnlyRects = rects.filter((r) => !rasterPages.has(r.page))

    const stripMissRasterPages = new Set<number>()
    let transformFailed = false
    if (textOnlyRects.length > 0) {
      try {
        const stripOutcome = await stripTextInRedactionRects(workingBytes, textOnlyRects)
        workingBytes = stripOutcome.bytes
        for (const [page, count] of stripOutcome.removedByPage) {
          if (count > 0) removalPages.add(page)
        }
        const remainingTextPages = await probeTextOverlapPages(workingBytes, textOnlyRects, collector)
        for (const page of remainingTextPages) stripMissRasterPages.add(page)
        const cleanTextRects = textOnlyRects.filter((r) => !stripMissRasterPages.has(r.page))
        if (cleanTextRects.length > 0) {
          workingBytes = await drawRedactionRects(workingBytes, cleanTextRects, collector)
        }
      } catch (err) {
        console.warn('[pdfRedact] selective text redaction failed; falling back to raster redaction', err)
        // Raster is the SAFE direction (burns pixels — nothing left to
        // leak) but a fidelity degradation: redacted pages become images.
        collector?.record({
          area: 'redact.raster_fallback',
          detail: `selective text redaction failed (${err instanceof Error ? err.message : String(err)}); affected pages rasterized`,
        })
        transformFailed = true
      }
    }

    if (transformFailed) {
      workingBytes = await rasterizeRedactionPages(bytes, rects, collector)
      for (const r of rects) {
        removalPages.add(r.page)
        rasterizedPages.add(r.page)
      }
    } else {
      const finalRasterRects = [
        ...rasterRects,
        ...textOnlyRects.filter((r) => stripMissRasterPages.has(r.page)),
      ]
      if (finalRasterRects.length > 0) {
        workingBytes = await rasterizeRedactionPages(workingBytes, finalRasterRects, collector)
        for (const r of finalRasterRects) {
          removalPages.add(r.page)
          rasterizedPages.add(r.page)
        }
      }
    }
  }

  // No-op guard (gauntlet R2 P0). Any page that carries redaction rects
  // but witnessed ZERO removal (no needle, no strip, no raster) removed
  // nothing — the box(es) on it covered no detectable content. Refuse
  // rather than let the region-scoped verifier certify it clean
  // vacuously. force_mask_only is the DEV fault-injection that
  // deliberately removes nothing so the verifier must catch it, so it is
  // exempt (the verifier owns that path).
  if (!maskOnly) {
    const noOpPages = [...new Set(rects.map((r) => r.page))]
      .filter((p) => !removalPages.has(p))
      .sort((a, b) => a - b)
    if (noOpPages.length > 0) {
      throw new Error(
        'Redaction removed no content from the redacted region(s) on page(s) ' +
          `${noOpPages.map((p) => p + 1).join(', ')} - the box covered no detectable text or ` +
          'graphics. This commonly means the box is in the wrong place: the page may be rotated ' +
          '(/Rotate) or use a non-zero MediaBox/CropBox origin, so display-frame coordinates do ' +
          'not match the content. The save was refused rather than certified, because a redaction ' +
          'that removed nothing cannot be proven to have removed the intended content.',
      )
    }
  }

  // Phase 2 — verify with witnesses the transform does not own.
  let verdict = await verifyRedactionPermanence(workingBytes, needles, rects, collector, rasterizedPages)

  // Phase 3 — remediate ONCE (never in mask-only failure injection),
  // re-verify, then refuse if anything still survives.
  if (verdict.failures.length > 0 && !maskOnly) {
    let remediated = false
    if (verdict.failingPages.size > 0) {
      const failingRects = rects.filter((r) => verdict.failingPages.has(r.page))
      if (failingRects.length > 0) {
        workingBytes = await rasterizeRedactionPages(workingBytes, failingRects, collector)
        for (const r of failingRects) rasterizedPages.add(r.page)
        collector?.record({
          area: 'redact.raster_fallback',
          detail:
            'verification found surviving content under redacted region(s) on page(s) ' +
            `${[...verdict.failingPages].map((p) => p + 1).sort((a, b) => a - b).join(', ')}; pages rasterized`,
        })
        remediated = true
      }
    }
    if (verdict.metadataScrubCandidates.length > 0) {
      workingBytes = await scrubMetadataNeedles(workingBytes, verdict.metadataScrubCandidates, collector)
      remediated = true
    }
    if (remediated) {
      verdict = await verifyRedactionPermanence(workingBytes, needles, rects, collector, rasterizedPages)
    }
  }

  if (verdict.failures.length > 0) {
    throw new Error(
      'Redaction verification failed - redacted content would survive in the saved file, ' +
        'so the save was refused. ' + verdict.failures.join('; '),
    )
  }

  collector?.record({
    area: 'redact.permanence_verified',
    detail:
      `post-redaction permanence verified: ${needles.length} harvested needle(s); ` +
      'byte/object scan, decoded extraction, region-empty, and annotation checks clean',
  })
  return { bytes: workingBytes, needles, rects }
}

interface StripBbox {
  page_index: number
  x: number
  y: number
  width: number
  height: number
  coord_space: 'pdf'
}

interface RedactionOverlapProbe {
  page_index: number
  text: boolean
  non_text: boolean
  object_types: string[]
}

function probeNeedsRasterFallback(probe: RedactionOverlapProbe): boolean {
  if (!probe.non_text) return false

  const types = probe.object_types.map((kind) => kind.toLowerCase())
  const hasRasterishObject = types.some((kind) =>
    kind.includes('image') ||
    kind.includes('form') ||
    kind.includes('xobject') ||
    kind.includes('unknown') ||
    kind.includes('unsupported'),
  )
  if (hasRasterishObject) return true

  const hasOnlyDecorativeVectorOverlap = types.every((kind) =>
    kind.includes('text') ||
    kind.includes('path') ||
    kind.includes('shading'),
  )
  return !(probe.text && hasOnlyDecorativeVectorOverlap)
}

function rectsToStripBboxes(rects: RedactionRect[]): StripBbox[] {
  const padX = 4
  return rects.map((r) => {
    const padBottom = 4
    // Legacy exact-match redaction boxes can be tight to the baseline
    // rather than the full glyph bbox. Grow those upward enough for PDFium
    // to select the intended text object without forcing a page raster.
    const padTop = r.height <= 16 ? 14 : 4
    return {
      page_index: r.page,
      x: r.x - padX,
      y: r.y - padBottom,
      width: r.width + padX * 2,
      height: r.height + padBottom + padTop,
      coord_space: 'pdf',
    }
  })
}

async function probeRasterFallbackPages(
  bytes: Uint8Array,
  rects: RedactionRect[],
  collector?: SaveDegradationCollector,
): Promise<Set<number>> {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const probes = await invoke<RedactionOverlapProbe[]>('pdf_probe_redaction_overlaps', {
      bytes: Array.from(bytes),
      bboxes: rectsToStripBboxes(rects),
    })
    return new Set(
      probes
        .filter(probeNeedsRasterFallback)
        .map((probe) => probe.page_index),
    )
  } catch (err) {
    console.warn('[pdfRedact] redaction overlap probe failed; using raster fallback', err)
    collector?.record({
      area: 'redact.raster_fallback',
      detail: `redaction overlap probe failed (${err instanceof Error ? err.message : String(err)}); all redacted pages rasterized`,
    })
    return new Set(rects.map((r) => r.page))
  }
}

interface GlyphProcedureProbe {
  page_index: number
  type3: boolean
  image_mask: boolean
  form_glyph: boolean
  constructs: string[]
}

/** cidredact (§9a): detect, on each redacted page, a glyph drawn as a Type3
 *  glyph-procedure, an image-mask stencil, or a Form XObject bearing either —
 *  the constructs that evade BOTH redaction text witnesses (pdfjs harvests no
 *  Unicode; pdfium may classify the glyph as non-text) so a secret could reach
 *  a clean verdict while remaining visually readable. Returns the flagged
 *  pages → the constructs found, so the caller routes them to the proven
 *  raster/flatten path BEFORE the (blind) witnesses run. The Rust detector is
 *  pure lopdf — it cannot be defeated by the same pdfium gap as the witness.
 *  A detector failure FAILS CLOSED: every redacted page is routed to raster
 *  (the safe direction) rather than risk certifying a blind-witness clean. */
async function probeGlyphProcedurePages(
  bytes: Uint8Array,
  rects: RedactionRect[],
  collector?: SaveDegradationCollector,
): Promise<Map<number, string[]>> {
  const pages = [...new Set(rects.map((r) => r.page))]
  if (pages.length === 0) return new Map()
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const probes = await invoke<GlyphProcedureProbe[]>('pdf_probe_glyph_procedures', {
      bytes: Array.from(bytes),
      pages,
    })
    const flagged = new Map<number, string[]>()
    for (const p of probes) {
      if (p.type3 || p.image_mask || p.form_glyph) {
        flagged.set(p.page_index, p.constructs.length ? p.constructs : ['glyph-procedure construct'])
      }
    }
    return flagged
  } catch (err) {
    console.warn('[pdfRedact] glyph-procedure detector failed; rasterizing all redacted pages', err)
    collector?.record({
      area: 'redact.glyph_procedure_rasterized',
      detail:
        `glyph-procedure detector unavailable (${err instanceof Error ? err.message : String(err)}); ` +
        'every redacted page was rasterized as a precaution - a Type3/Form-XObject/image-mask glyph ' +
        'could otherwise survive a clean verdict',
    })
    return new Map(pages.map((p) => [p, ['detector unavailable - fail-closed raster']]))
  }
}

/** §9g (vecredact): on the ORIGINAL bytes (BEFORE the cover box is drawn, so
 *  the box never self-trips), find every redacted page where PAINTED vector-
 *  path content overlaps a redaction region, route it to the proven raster/
 *  flatten path, and RECORD the fidelity degradation. This is the only way to
 *  destroy vector content the text + image witnesses cannot see (§9g).
 *  Region-scoped via the geometric walk (operatorListHitsVectorRegions).
 *  Returns the flagged page set (the caller adds them to rasterPages).
 *  Fail-closed: a parse/IPC failure rasterizes every redacted page (the safe
 *  direction) and records that fact. */
async function probeVectorContentPages(
  bytes: Uint8Array,
  rects: RedactionRect[],
  collector?: SaveDegradationCollector,
): Promise<Set<number>> {
  const pages = [...new Set(rects.map((r) => r.page))]
  if (pages.length === 0) return new Set()
  const regionsByPage = regionsByPageOf(rects)
  const recordRasterized = (pageIndex: number, why: string): void => {
    collector?.record({
      area: 'redact.vector_content_rasterized',
      detail:
        `page ${pageIndex + 1}: ${why} - vector graphics (outlined text, a chart, a signature, a ` +
        'logo) are invisible to the text and image redaction witnesses, so the page was rasterized ' +
        '(flattened to a secured image) to remove the content permanently. The page loses selectable text.',
      severity: 'fidelity',
      pageIndex,
    })
  }
  try {
    const pdfjsLib = await import('pdfjs-dist')
    const OPS = pdfjsLib.OPS as unknown as VectorOpCodes
    const doc = await pdfjsLib.getDocument({
      data: bytes.slice(),
      isOffscreenCanvasSupported: false,
    }).promise
    const flagged = new Set<number>()
    try {
      for (const [pageIndex, regions] of regionsByPage) {
        if (pageIndex >= doc.numPages) continue
        const page = await doc.getPage(pageIndex + 1)
        try {
          const view = page.view as number[] // [x0, y0, x1, y1] in PDF units
          const pageWidth = Math.abs(view[2] - view[0]) || 1
          const pageHeight = Math.abs(view[3] - view[1]) || 1
          const opList = await page.getOperatorList()
          if (
            operatorListHitsVectorRegions(
              opList.fnArray,
              opList.argsArray,
              OPS,
              regions,
              pageWidth,
              pageHeight,
            )
          ) {
            flagged.add(pageIndex)
            recordRasterized(
              pageIndex,
              'raw vector-path content (filled regions, strokes, or curves) overlaps a redacted region',
            )
          }
        } finally {
          page.cleanup()
        }
      }
    } finally {
      try { await doc.destroy() } catch { /* best-effort cleanup */ }
    }
    return flagged
  } catch (err) {
    console.warn('[pdfRedact] vector-content detector failed; rasterizing all redacted pages', err)
    const why = `the vector-content detector failed (${err instanceof Error ? err.message : String(err)}) so the page was rasterized as a precaution (fail-closed)`
    for (const p of pages) {
      collector?.record({
        area: 'redact.vector_content_rasterized',
        detail:
          `page ${p + 1}: ${why} - raw vector graphics under a mark could otherwise survive a clean ` +
          'verdict, so the page was flattened to a secured image (it loses selectable text).',
        severity: 'fidelity',
        pageIndex: p,
      })
    }
    return new Set(pages)
  }
}

async function probeTightBoxesMissingTextPages(
  bytes: Uint8Array,
  rects: RedactionRect[],
  collector?: SaveDegradationCollector,
): Promise<Set<number>> {
  const pages = new Set<number>()
  for (const rect of rects) {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const probes = await invoke<RedactionOverlapProbe[]>('pdf_probe_redaction_overlaps', {
        bytes: Array.from(bytes),
        bboxes: rectsToStripBboxes([rect]),
      })
      if (!probes.some((probe) => probe.text)) pages.add(rect.page)
    } catch (err) {
      console.warn('[pdfRedact] tight redaction probe failed; using raster fallback', err)
      collector?.record({
        area: 'redact.raster_fallback',
        detail: `tight redaction probe failed on page ${rect.page} (${err instanceof Error ? err.message : String(err)}); page rasterized`,
        pageIndex: rect.page,
      })
      pages.add(rect.page)
    }
  }
  return pages
}

async function probeTextOverlapPages(
  bytes: Uint8Array,
  rects: RedactionRect[],
  collector?: SaveDegradationCollector,
): Promise<Set<number>> {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const probes = await invoke<RedactionOverlapProbe[]>('pdf_probe_redaction_overlaps', {
      bytes: Array.from(bytes),
      bboxes: rectsToStripBboxes(rects),
    })
    return new Set(
      probes
        .filter((probe) => probe.text)
        .map((probe) => probe.page_index),
    )
  } catch (err) {
    console.warn('[pdfRedact] post-strip text probe failed; using raster fallback', err)
    collector?.record({
      area: 'redact.raster_fallback',
      detail: `post-strip text probe failed (${err instanceof Error ? err.message : String(err)}); affected pages rasterized`,
    })
    return new Set(rects.map((r) => r.page))
  }
}

async function stripTextInRedactionRects(
  bytes: Uint8Array,
  rects: RedactionRect[],
): Promise<{ bytes: Uint8Array; removedByPage: Map<number, number> }> {
  if (rects.length === 0) return { bytes, removedByPage: new Map() }
  // pdf_strip_text_in_bboxes returns StripTextOutcome {bytes,
  // removed_by_page, removed_total} since Session 1. The redaction
  // pipeline self-checks survival via probeTextOverlapPages right
  // after this call; removed_by_page additionally feeds the no-op
  // guard (a region that stripped zero text on its page is one of the
  // three removal witnesses — see the guard in applyRedactions).
  const { invoke } = await import('@tauri-apps/api/core')
  const outcome = await invoke<{
    bytes: number[] | Uint8Array
    removed_by_page?: Array<[number, number]> | Record<string, number>
    removed_total?: number
  }>('pdf_strip_text_in_bboxes', {
    bytes: Array.from(bytes),
    bboxes: rectsToStripBboxes(rects),
  })
  const out = outcome.bytes
  const removedByPage = new Map<number, number>()
  const rbp = outcome.removed_by_page
  if (Array.isArray(rbp)) {
    for (const entry of rbp) {
      if (Array.isArray(entry) && entry.length === 2) removedByPage.set(Number(entry[0]), Number(entry[1]))
    }
  } else if (rbp && typeof rbp === 'object') {
    for (const [k, v] of Object.entries(rbp)) removedByPage.set(Number(k), Number(v))
  }
  return {
    bytes: out instanceof Uint8Array ? out : new Uint8Array(out),
    removedByPage,
  }
}

async function drawRedactionRects(
  bytes: Uint8Array,
  rects: RedactionRect[],
  collector?: SaveDegradationCollector,
): Promise<Uint8Array> {
  if (rects.length === 0) return bytes
  const pdfDoc = await PDFDocument.load(bytes)
  const pages = pdfDoc.getPages()

  // Annotations under a redaction region carry their own content
  // (comment text, link targets, form values) — a black box drawn
  // over them hides, not removes, that content.
  removeAnnotationsInRegions(pdfDoc, regionsByPageOf(rects), collector)

  // Embedded page thumbnails are pre-rendered images of the page from
  // BEFORE the redaction.
  for (const pageIndex of new Set(rects.map((r) => r.page))) {
    pages[pageIndex]?.node.delete(PDFName.of('Thumb'))
  }

  for (const r of rects) {
    const page = pages[r.page]
    if (!page) continue
    const [cr, cg, cb] = r.color ?? [0, 0, 0]
    page.drawRectangle({
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      color: rgb(cr, cg, cb),
    })
  }
  pruneUnreachablePdfObjects(pdfDoc)
  return await pdfDoc.save()
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

/** Re-renders pages that need image-like redaction as raster images, then
 *  overlays opaque rectangles and replaces the original page content with
 *  that image. Text-only redactions avoid this path so the rest of the page
 *  remains editable after save.
 */
async function rasterizeRedactionPages(
  bytes: Uint8Array,
  rects: RedactionRect[],
  collector?: SaveDegradationCollector,
): Promise<Uint8Array> {
  if (rects.length === 0) return bytes

  const redactedPages = new Set(rects.map((r) => r.page))

  // Render redacted pages via pdfjs. getViewport() bakes the page's
  // intrinsic /Rotate and uses page.view (the CropBox) as the rendered
  // region, so the bitmap is the page exactly as the editor displays it.
  // The burn maps each rect through viewport.transform — the SAME transform
  // pdfjs used to render — so a black box lands on the rendered pixels for
  // ANY rotation, CropBox offset or MediaBox origin (gauntlet RB-1 / RB-3).
  const pdfjsLib = await import('pdfjs-dist')
  const pdfjsDoc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise
  const RASTER_SCALE = 2

  const source = await PDFDocument.load(bytes)
  const sourcePages = source.getPages()
  // Build a new doc: for redacted pages, swap content with image + burn
  // black boxes. For others, copy through unchanged.
  const dest = await PDFDocument.create()

  // Gate-2 P2: rebuilding into a fresh document drops document-LEVEL
  // structures that copyPages does not carry — form fields (AcroForm),
  // the name trees (incl. embedded-file attachments), bookmarks and
  // layer config. For redaction permanence that loss is conservative
  // (dropped content cannot leak), but it must never be SILENT.
  const droppedStructures: string[] = []
  for (const [key, label] of [
    ['AcroForm', 'form fields (AcroForm)'],
    ['Names', 'name trees (incl. embedded-file attachments)'],
    ['Outlines', 'bookmarks (Outlines)'],
    ['OCProperties', 'layer configuration (OCProperties)'],
  ] as const) {
    if (source.catalog.has(PDFName.of(key))) droppedStructures.push(label)
  }
  if (droppedStructures.length > 0) {
    collector?.record({
      area: 'redact.raster_dropped_doc_structure',
      detail:
        'raster redaction rebuilds the document and drops document-level ' +
        `structures: ${droppedStructures.join('; ')}`,
    })
  }

  // Copy metadata
  dest.setTitle(source.getTitle() || '')
  dest.setAuthor(source.getAuthor() || '')
  dest.setSubject(source.getSubject() || '')

  // G3 / G5 (legal-guarantee): each redacted page is REBUILT into this fresh
  // document — its original content stream, /Resources (incl. any Form-XObject
  // or image shared with another page), and page-level /Metadata / /PieceInfo /
  // /Thumb are simply never carried over, so removal does not depend on
  // zero-ref orphan pruning (a shared XObject the unmarked pages still use is
  // copied for THEM, never for the redacted page). pd-lib's save() writes a
  // single complete revision — and the verifier's startxref-marker invariant
  // REFUSES any multi-revision output — so there is no superseded-revision leak.
  // G4: a rebuilt page is a flat image and loses its interactive objects (link
  // annotations, form-field widgets, tags). Conservative for permanence, but
  // RECORD it per page rather than dropping silently.
  let droppedLinks = 0
  let droppedWidgets = 0
  let droppedOtherAnnots = 0
  const interactivityPages = new Set<number>()

  try {
    for (let i = 0; i < sourcePages.length; i++) {
      if (!redactedPages.has(i)) {
        const [copied] = await dest.copyPages(source, [i])
        dest.addPage(copied)
        continue
      }
      const pageRects = rects.filter((rr) => rr.page === i)
      const sourcePage = sourcePages[i]
      // G4: tally the interactivity this page will lose to the flatten.
      try {
        const annots = sourcePage.node.lookup(PDFName.of('Annots'))
        if (annots instanceof PDFArray && annots.size() > 0) {
          interactivityPages.add(i)
          for (let a = 0; a < annots.size(); a++) {
            const dict = source.context.lookupMaybe(annots.get(a), PDFDict)
            const subtype = dict?.get(PDFName.of('Subtype'))
            const tag = subtype ? subtype.toString() : ''
            if (tag === '/Link') droppedLinks++
            else if (tag === '/Widget') droppedWidgets++
            else droppedOtherAnnots++
          }
        }
      } catch {
        // A page whose /Annots can't be read still rasterizes safely; the
        // interactivity tally is best-effort reporting, never a save blocker.
      }
      const mediaBox = sourcePage.getMediaBox()
      let cropBox = mediaBox
      try {
        const cb = sourcePage.getCropBox()
        if (cb && cb.width > 0 && cb.height > 0) cropBox = cb
      } catch {
        cropBox = mediaBox
      }
      const pageRotation = sourcePage.getRotation()
      const pjsPage = await pdfjsDoc.getPage(i + 1)
      // Render the page in its INTRINSIC (unrotated) content orientation:
      // the output page keeps the original MediaBox/CropBox/Rotate, so the
      // saved page displays identically AND its coordinate frame matches the
      // input — the verifier layers (and the GATE-2 pdfium witness) can reuse
      // the same user-space rects against the output with no re-mapping.
      const viewport = pjsPage.getViewport({ scale: RASTER_SCALE, rotation: 0 })
      const transform = viewport.transform as unknown as Matrix
      let burnedPng: Uint8Array
      try {
        const canvas = document.createElement('canvas')
        canvas.width = viewport.width
        canvas.height = viewport.height
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('2d canvas context unavailable for redaction render')
        await pjsPage.render({ canvasContext: ctx, viewport }).promise
        const dataUrl = canvas.toDataURL('image/png')
        const b64 = dataUrl.substring(dataUrl.indexOf(',') + 1)
        const bin = atob(b64)
        const png = new Uint8Array(bin.length)
        for (let j = 0; j < bin.length; j++) png[j] = bin.charCodeAt(j)
        // BURN the redaction into the PIXELS before embedding. A vector
        // rectangle drawn over the image hides but does not remove the
        // content — the secret pixels would ship inside the image XObject,
        // recoverable with any image extractor (gate-2 P0). Burn the same
        // padded geometry the text strip uses so partial glyphs (ascenders
        // above a tight box) cannot survive at the pixel level either.
        const burns = pageRects.map((r) => ({
          bbox: rectsToStripBboxes([r])[0],
          color: r.color ?? ([0, 0, 0] as [number, number, number]),
        }))
        burnedPng = await burnRegionsIntoPng(png, burns, transform)
      } finally {
        pjsPage.cleanup()
      }
      const img = await dest.embedPng(burnedPng)
      // Preserve the source page's geometry so the output frame == input
      // frame: the intrinsic-orientation bitmap fills the CropBox region, and
      // the page keeps its MediaBox/CropBox/Rotate (the viewer rotates the
      // flattened image for display exactly as it rotated the original).
      const page = dest.addPage([mediaBox.width, mediaBox.height])
      page.setMediaBox(mediaBox.x, mediaBox.y, mediaBox.width, mediaBox.height)
      page.setCropBox(cropBox.x, cropBox.y, cropBox.width, cropBox.height)
      page.setRotation(pageRotation)
      page.drawImage(img, {
        x: cropBox.x,
        y: cropBox.y,
        width: cropBox.width,
        height: cropBox.height,
      })
      // Crisp vector rectangle on top for appearance — the rect is in the
      // page's user space, which the output now shares with the input.
      for (const r of pageRects) {
        const [cr, cg, cb] = r.color ?? [0, 0, 0]
        page.drawRectangle({ x: r.x, y: r.y, width: r.width, height: r.height, color: rgb(cr, cg, cb) })
      }
    }
  } finally {
    pdfjsDoc.destroy()
  }

  // G4: surface the per-page interactivity the flatten dropped (never silent).
  if (interactivityPages.size > 0) {
    const parts: string[] = []
    if (droppedLinks > 0) parts.push(`${droppedLinks} link annotation(s)`)
    if (droppedWidgets > 0) parts.push(`${droppedWidgets} form-field widget(s)`)
    if (droppedOtherAnnots > 0) parts.push(`${droppedOtherAnnots} other annotation(s)`)
    collector?.record({
      area: 'redact.raster_dropped_page_interactivity',
      detail:
        `rasterized redacted page(s) ${[...interactivityPages]
          .map((p) => p + 1)
          .sort((a, b) => a - b)
          .join(', ')} were flattened to a secured image and lost interactivity: ` +
        `${parts.join(', ')} (links/fields/tags do not survive a flatten)`,
    })
  }

  return await dest.save()
}

interface PngBurn {
  bbox: { x: number; y: number; width: number; height: number } // PDF user space
  color: [number, number, number] // 0..1 components
}

/** Fills the given user-space regions with opaque color IN THE PIXELS of a
 *  rendered page PNG. Each rect is mapped to bitmap pixels through
 *  `transform` — the pdfjs viewport transform that rendered the page — so
 *  the fill lands on the correct pixels for ANY rotation / CropBox offset
 *  (gauntlet RB-1 / RB-3); the old `bitmap.width/pageWidth` + static
 *  bottom-left flip put the box 90° off on rotated pages and mis-scaled it
 *  when CropBox ≠ MediaBox. Throws on any decode/draw failure — the caller
 *  is the redaction raster path, where an unburned image must never be
 *  embedded silently. */
async function burnRegionsIntoPng(
  png: Uint8Array,
  burns: PngBurn[],
  transform: Matrix,
): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(new Blob([png as BlobPart], { type: 'image/png' }))
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2d canvas context unavailable for redaction pixel burn')
    ctx.drawImage(bitmap, 0, 0)
    for (const b of burns) {
      const [r, g, bl] = b.color
      ctx.fillStyle = `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(bl * 255)})`
      // Map the user-space rect through the viewport transform to bitmap
      // pixels (top-left origin), then over-paint by 1px on every side so
      // edge resampling cannot blend secrets back.
      const px = userRectToPixelRect(b.bbox, transform)
      ctx.fillRect(px.x - 1, px.y - 1, px.width + 2, px.height + 2)
    }
    const dataUrl = canvas.toDataURL('image/png')
    const b64 = dataUrl.substring(dataUrl.indexOf(',') + 1)
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let j = 0; j < bin.length; j++) out[j] = bin.charCodeAt(j)
    return out
  } finally {
    bitmap.close()
  }
}

// ── Needle harvest + classification ──────────────────────────────

export function normalizeRedactionText(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase()
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    count += 1
    idx = haystack.indexOf(needle, idx + 1)
  }
  return count
}

function truncateForDetail(text: string, max = 40): string {
  const t = text.trim()
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`
}

/** PDF structural / font-program vocabulary that legitimately appears in
 *  the raw bytes of almost every document. A user redacting the literal
 *  word "Pages" must not have the save refused because every page tree
 *  node contains /Pages. These tokens skip the RUST byte-scan layer only —
 *  the decoded-extraction and region-empty layers still verify them. */
const STRUCTURAL_TOKEN_LEXICON = new Set([
  'page', 'pages', 'type', 'font', 'fonts', 'catalog', 'count', 'kids',
  'contents', 'length', 'filter', 'width', 'height', 'title', 'author',
  'subject', 'creator', 'producer', 'info', 'root', 'size', 'name',
  'names', 'first', 'last', 'next', 'prev', 'parent', 'resources',
  'mediabox', 'cropbox', 'rotate', 'annots', 'annot', 'rect', 'border',
  'encoding', 'unicode', 'identity', 'metadata', 'outlines', 'lang',
  'language', 'version', 'date', 'data', 'text', 'image', 'form',
  'group', 'pattern', 'shading', 'matrix', 'state', 'view', 'print',
  'none', 'true', 'false', 'null',
  // file-structure keywords present in EVERY valid PDF (gate-3 P2):
  // without these, redacting the everyday words "stream"/"trailer"
  // permanently refuses the save — the byte layer always finds the
  // mandatory keyword, and remediation cannot remove it.
  'stream', 'endstream', 'trailer', 'xref', 'startxref', 'obj', 'endobj',
  // font-table strings embedded in font programs
  'regular', 'bold', 'italic', 'oblique', 'light', 'medium', 'black',
  'roman', 'copyright', 'trademark', 'helvetica', 'arial', 'times',
  'courier', 'symbol', 'georgia', 'calibri', 'cambria', 'verdana',
])

/** Pure classification pass (unit-testable without pdfjs/tauri).
 *  Mutates the eligibility flags on each needle and records the
 *  designed-demotion info degradations. */
export function classifyHarvestedNeedles(
  needles: RedactionNeedle[],
  fullNorm: string,
  harvestedCounts: Map<string, number>,
  collector?: SaveDegradationCollector,
): void {
  for (const needle of needles) {
    if (needle.norm.length < 4) {
      needle.docWide = false
      needle.rustLayer = false
      collector?.record({
        area: 'redact.short_needle',
        detail:
          `redacted text '${truncateForDetail(needle.text)}' is too short for document-wide ` +
          'verification; region-level verification still applies',
        pageIndex: needle.pageIndex,
      })
      continue
    }
    if (STRUCTURAL_TOKEN_LEXICON.has(needle.norm)) {
      needle.rustLayer = false
      collector?.record({
        area: 'redact.structural_token_needle',
        detail:
          `redacted text '${truncateForDetail(needle.text)}' matches PDF structural vocabulary; ` +
          'byte-level scan skipped for it - decoded and region verification still apply',
        pageIndex: needle.pageIndex,
      })
    }
    const docCount = countOccurrences(fullNorm, needle.norm)
    const harvested = harvestedCounts.get(needle.norm) ?? 0
    if (docCount > harvested) {
      needle.docWide = false
      needle.rustLayer = false
      collector?.record({
        area: 'redact.token_outside_region',
        detail:
          `redacted text '${truncateForDetail(needle.text)}' also occurs outside the redacted ` +
          `region(s) (${docCount} total vs ${harvested} under regions); document-wide ` +
          'verification skipped for it - region verification still applies',
        pageIndex: needle.pageIndex,
      })
    }
  }
}

interface PdfSpaceTextItem {
  str: string
  x: number
  y: number
  width: number
  height: number
}

interface DocTextSnapshot {
  /** Per-page normalized text joined with NUL separators (norms never
   *  contain NUL, so needles cannot falsely match across pages). */
  fullNorm: string
  pageNorms: Map<number, string>
  pageItems: Map<number, PdfSpaceTextItem[]>
}

/** Decoded-layer snapshot via pdfjs. Items carry PDF bottom-left-origin
 *  coordinates (transform[4]/[5] = glyph origin in user space). */
async function snapshotDocText(bytes: Uint8Array): Promise<DocTextSnapshot> {
  const pdfjsLib = await import('pdfjs-dist')
  const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise
  try {
    const pageItems = new Map<number, PdfSpaceTextItem[]>()
    const pageNorms = new Map<number, string>()
    let fullNorm = ''
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p)
      const content = await page.getTextContent()
      const items: PdfSpaceTextItem[] = []
      let pageText = ''
      for (const raw of content.items as Array<Record<string, unknown>>) {
        const str = typeof raw.str === 'string' ? raw.str : ''
        if (!str) continue
        const tx = Array.isArray(raw.transform) ? (raw.transform as number[]) : null
        items.push({
          str,
          x: tx ? Number(tx[4]) || 0 : 0,
          y: tx ? Number(tx[5]) || 0 : 0,
          width: typeof raw.width === 'number' ? raw.width : 0,
          height: typeof raw.height === 'number' ? raw.height : 0,
        })
        pageText += str
      }
      pageItems.set(p - 1, items)
      const norm = normalizeRedactionText(pageText)
      pageNorms.set(p - 1, norm)
      fullNorm += norm + '\u0000'
    }
    return { fullNorm, pageNorms, pageItems }
  } finally {
    try { await doc.destroy() } catch { /* best-effort cleanup */ }
  }
}

interface Region {
  x: number
  y: number
  width: number
  height: number
}

/** Verification uses the SAME padded geometry the strip uses, so
 *  anything pdfium was asked to remove is checked for survival. */
function regionsByPageOf(rects: RedactionRect[]): Map<number, Region[]> {
  const map = new Map<number, Region[]>()
  for (const b of rectsToStripBboxes(rects)) {
    const list = map.get(b.page_index) ?? []
    list.push({ x: b.x, y: b.y, width: b.width, height: b.height })
    map.set(b.page_index, list)
  }
  return map
}

function itemIntersectsRegion(item: PdfSpaceTextItem, region: Region): boolean {
  // transform[5] is the BASELINE y: ascenders extend up by ~height,
  // descenders below by ~0.2×height.
  const h = Math.max(item.height, 1)
  const itemY0 = item.y - 0.2 * h
  const itemY1 = item.y + Math.max(item.height, 0.5)
  const itemX0 = item.x
  const itemX1 = item.x + Math.max(item.width, 0.5)
  return (
    itemX0 < region.x + region.width &&
    itemX1 > region.x &&
    itemY0 < region.y + region.height &&
    itemY1 > region.y
  )
}

function rectOverlapsRegion(rect: Region, region: Region): boolean {
  return (
    rect.x < region.x + region.width &&
    rect.x + rect.width > region.x &&
    rect.y < region.y + region.height &&
    rect.y + rect.height > region.y
  )
}

async function harvestRedactionNeedles(
  bytes: Uint8Array,
  rects: RedactionRect[],
  collector?: SaveDegradationCollector,
): Promise<{ needles: RedactionNeedle[]; vacuousPages: Set<number> }> {
  const regionsByPage = regionsByPageOf(rects)
  const snapshot = await snapshotDocText(bytes)

  const needles: RedactionNeedle[] = []
  const seen = new Set<string>()
  const harvestedCounts = new Map<string, number>()
  const pagesWithHarvest = new Set<number>()

  for (const [pageIndex, regions] of regionsByPage) {
    const items = snapshot.pageItems.get(pageIndex) ?? []
    for (const item of items) {
      if (!regions.some((rg) => itemIntersectsRegion(item, rg))) continue
      const norm = normalizeRedactionText(item.str)
      if (!norm) continue
      pagesWithHarvest.add(pageIndex)
      harvestedCounts.set(norm, (harvestedCounts.get(norm) ?? 0) + 1)
      const key = `${pageIndex}\u0000${norm}`
      if (seen.has(key)) continue
      seen.add(key)
      needles.push({ text: item.str.trim(), norm, pageIndex, docWide: true, rustLayer: true })
    }
  }

  classifyHarvestedNeedles(needles, snapshot.fullNorm, harvestedCounts, collector)

  // Vacuous-pass guard input: pages where pdfium sees text under a
  // region but the decoded layer harvested nothing. (A probe failure
  // returns ALL pages → every region page without harvest rasterizes
  // — the conservative direction.)
  const textOverlapPages = await probeTextOverlapPages(bytes, rects, collector)
  const vacuousPages = new Set<number>()
  for (const page of textOverlapPages) {
    if (regionsByPage.has(page) && !pagesWithHarvest.has(page)) vacuousPages.add(page)
  }

  return { needles, vacuousPages }
}

// ── Permanence verification ──────────────────────────────────────

interface PermanenceGrepHit {
  kind: string
  variant: string
  object_id?: number | null
}

interface PermanenceNeedleResult {
  needle: string
  raw_hits: PermanenceGrepHit[]
  stream_hits: PermanenceGrepHit[]
  string_object_hits: PermanenceGrepHit[]
  leaked: boolean
}

export interface PermanenceCheckResult {
  needles: PermanenceNeedleResult[]
  startxref_markers: number
  parse_ok: boolean
  total_streams_scanned: number
  total_streams_decompressed: number
  embedded_files: number
  leaked: boolean
}

function formatHitSites(n: PermanenceNeedleResult): string {
  const sites = [
    ...n.raw_hits.map((h) => `raw:${h.variant}`),
    ...n.stream_hits.map((h) => `stream:${h.variant}${h.object_id != null ? `#${h.object_id}` : ''}`),
    ...n.string_object_hits.map((h) => `${h.kind}:${h.variant}${h.object_id != null ? `#${h.object_id}` : ''}`),
  ]
  return sites.slice(0, 6).join(', ') + (sites.length > 6 ? ', …' : '')
}

/** Multi-layer post-transform survival check. Every layer that cannot
 *  run counts as a FAILURE — a redaction that cannot be verified must
 *  not be certified. */
export async function verifyRedactionPermanence(
  outBytes: Uint8Array,
  needles: RedactionNeedle[],
  rects: RedactionRect[],
  collector?: SaveDegradationCollector,
  /** Pages the redaction RASTERIZED (a fill box was burned into the pixels).
   *  Enables the GATE-2 independent-frame positive control (Layer 5b): only
   *  rasterized pages carry a fill box to confirm. */
  rasterizedPages?: Set<number>,
): Promise<RedactionVerdict> {
  const failures: string[] = []
  const failingPages = new Set<number>()
  const metadataScrubCandidates: string[] = []
  const regionsByPage = regionsByPageOf(rects)

  // Layer 1 — Rust raw/stream/string-object scan + revision invariant.
  // lopdf parses what the byte grep cannot see (octal/hex escaped
  // strings, name escapes); startxref count proves no dead pre-redaction
  // revision rides along in the file.
  const rustNeedles = [...new Set(
    needles.filter((n) => n.rustLayer && n.text.length >= 4).map((n) => n.text),
  )]
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const result = await invoke<PermanenceCheckResult>('pdf_redaction_permanence_check', {
      bytes: Array.from(outBytes),
      needles: rustNeedles,
    })
    if (result.startxref_markers !== 1) {
      failures.push(
        `output has ${result.startxref_markers} startxref markers - a prior document ` +
          'revision (carrying pre-redaction bytes) may survive in the file',
      )
    }
    if (!result.parse_ok) {
      failures.push('output could not be parsed for object-level verification')
    }
    for (const n of result.needles) {
      if (!n.leaked) continue
      failures.push(
        `redacted text '${truncateForDetail(n.needle)}' survives at byte/object level (${formatHitSites(n)})`,
      )
      metadataScrubCandidates.push(n.needle)
    }
    // Gate-2 P3: lopdf can only decompress Flate streams — DCT/JPX/CCITT
    // (typical image payloads) are scanned compressed-byte-only, where a
    // needle match is essentially impossible. Record the demotion instead
    // of letting the byte layer claim full coverage; image content is
    // owned by the pixel layer (5), and decoded text by layers 2-3.
    const undecodable = result.total_streams_scanned - result.total_streams_decompressed
    if (undecodable > 0) {
      collector?.record({
        area: 'redact.scan_streams_undecodable',
        detail:
          `${undecodable} of ${result.total_streams_scanned} stream object(s) could not be ` +
          'decompressed (non-Flate filters) - the byte-level scan is inconclusive for them; ' +
          'decoded-text and image-pixel layers still verified the regions',
      })
    }
    if (result.embedded_files > 0) {
      // Attachments are CONTAINER formats (zip/docx/…) no byte scan can
      // inspect — surface their presence as security severity instead of
      // pretending they were scanned.
      collector?.record({
        area: 'redact.attachments_present',
        detail:
          `${result.embedded_files} embedded file(s) present - attachments cannot be ` +
          'scanned for redacted content; remove attachments before redacting, or verify them manually',
      })
    }
  } catch (err) {
    failures.push(
      `byte-level permanence verification unavailable (${err instanceof Error ? err.message : String(err)}) ` +
        '- refusing to certify the redaction',
    )
  }

  // Layers 2+3 — decoded re-extraction of the OUTPUT.
  let outSnapshot: DocTextSnapshot | null = null
  try {
    outSnapshot = await snapshotDocText(outBytes)
  } catch (err) {
    failures.push(
      `decoded-text verification unavailable (${err instanceof Error ? err.message : String(err)}) ` +
        '- refusing to certify the redaction',
    )
  }
  if (outSnapshot) {
    // Layer 2 — document-wide: needles that existed ONLY inside the
    // regions must be gone from the whole document.
    for (const needle of needles) {
      if (!needle.docWide) continue
      if (!outSnapshot.fullNorm.includes(needle.norm)) continue
      const pages: number[] = []
      for (const [pageIndex, norm] of outSnapshot.pageNorms) {
        if (norm.includes(needle.norm)) {
          pages.push(pageIndex)
          failingPages.add(pageIndex)
        }
      }
      failures.push(
        `redacted text '${truncateForDetail(needle.text)}' is still extractable from the ` +
          `saved document (page(s) ${pages.map((p) => p + 1).join(', ') || 'unknown'})`,
      )
    }
    // Layer 3 — region-empty: NO text item may remain under any region,
    // independent of which needles were harvested.
    for (const [pageIndex, regions] of regionsByPage) {
      const items = outSnapshot.pageItems.get(pageIndex) ?? []
      for (const item of items) {
        if (!normalizeRedactionText(item.str)) continue
        if (regions.some((rg) => itemIntersectsRegion(item, rg))) {
          failingPages.add(pageIndex)
          failures.push(
            `text '${truncateForDetail(item.str)}' still occupies a redacted region on page ${pageIndex + 1}`,
          )
          break // one witness per page is enough to fail/remediate it
        }
      }
    }
    // R9b — arbitrary-pattern sweep over the OUTPUT, region-scoped and
    // REGARDLESS of harvest. Layer 3 fails on ANY surviving region text;
    // this names the sensitive CLASS (SSN/email/…) that survived, using
    // the same pattern set as the find-&-redact tool — so a sensitive
    // value that slipped the harvest still trips a security witness with a
    // specific reason. Region-scoped, so it never false-positives on
    // legitimately un-redacted content elsewhere in the document.
    for (const [pageIndex, regions] of regionsByPage) {
      const items = outSnapshot.pageItems.get(pageIndex) ?? []
      for (const item of items) {
        const text = item.str ?? ''
        if (!text.trim()) continue
        if (!regions.some((rg) => itemIntersectsRegion(item, rg))) continue
        for (const pat of PRESET_PATTERNS) {
          // Fresh RegExp per test — PRESET_PATTERNS carry the /g flag and
          // a shared lastIndex would make .test() stateful across items.
          const re = new RegExp(pat.re.source, pat.re.flags.replace('g', ''))
          if (re.test(text)) {
            failingPages.add(pageIndex)
            failures.push(
              `a ${pat.label}-shaped value survives in a redacted region on page ${pageIndex + 1}`,
            )
            break
          }
        }
      }
    }
  }

  // Layer 4 — annotation sweep: nothing in /Annots may overlap a region.
  try {
    const pdfDoc = await PDFDocument.load(outBytes)
    const pages = pdfDoc.getPages()
    for (const [pageIndex, regions] of regionsByPage) {
      const page = pages[pageIndex]
      if (!page) continue
      const annotsVal = page.node.lookup(PDFName.of('Annots'))
      if (!(annotsVal instanceof PDFArray)) continue
      for (let i = 0; i < annotsVal.size(); i++) {
        const dict = lookupAnnotDict(pdfDoc.context, annotsVal.get(i))
        if (!dict) {
          failingPages.add(pageIndex)
          failures.push(`an unreadable annotation survives on redacted page ${pageIndex + 1}`)
          continue
        }
        const rect = readAnnotRect(dict)
        if (!rect) {
          failingPages.add(pageIndex)
          failures.push(`an annotation without readable geometry survives on redacted page ${pageIndex + 1}`)
          continue
        }
        if (regions.some((rg) => rectOverlapsRegion(rect, rg))) {
          failingPages.add(pageIndex)
          failures.push(`an annotation still overlaps a redacted region on page ${pageIndex + 1}`)
        }
      }
    }
  } catch (err) {
    failures.push(
      `annotation verification unavailable (${err instanceof Error ? err.message : String(err)}) ` +
        '- refusing to certify the redaction',
    )
  }

  // Layer 5 — image-pixel sweep: any image painted across a redaction
  // region must carry the redaction IN ITS PIXELS. A vector box drawn
  // over an image XObject hides but does not remove the content — the
  // page renders black while the embedded image still contains the
  // secret (extractable with pdfimages/mutool). This is the witness
  // that catches a mask-only raster fallback.
  try {
    await sweepImagePixelsInRegions(outBytes, rects, regionsByPage, failures, failingPages, collector, rasterizedPages)
  } catch (err) {
    failures.push(
      `image-pixel verification unavailable (${err instanceof Error ? err.message : String(err)}) ` +
        '- refusing to certify the redaction',
    )
  }

  // Layer 6 — INDEPENDENT-ENGINE (pdfium) region witness. Layers 1-3 all
  // decode through pdfjs — the SAME engine that harvested the needles — so
  // a region pdfjs cannot decode (subsetted CID fonts store glyph INDICES,
  // not the Unicode needle; exotic CMaps; Type3) is invisible to every
  // pdfjs layer AND was never harvested as a needle. One shared blind spot
  // hides the leak from all of them (SESSION-3-4-REVIEW R9a/R9b). pdfium
  // decodes via a DIFFERENT path and reports text-object GEOMETRY — it does
  // not need to recover Unicode to know a glyph occupies the region, so it
  // is font-AGNOSTIC. If pdfium still finds a text object under a redacted
  // region in the OUTPUT, refuse. If the witness cannot RUN at all, a
  // CID/exotic-font region cannot be certified clean by ANY engine — that
  // is inconclusive, recorded at SECURITY and FAILED (never a silent pass).
  //
  // TODO(1.1 — pdfium STRATEGY): this witness, like strip_text_impl, is
  // pdfium-backed. The 1.1 pure-Rust redaction work replaces both with an
  // own text-geometry extractor; the verifier stays implementation-
  // agnostic — only the engine behind this layer changes.
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const probes = await invoke<RedactionOverlapProbe[]>('pdf_probe_redaction_overlaps', {
      bytes: Array.from(outBytes),
      bboxes: rectsToStripBboxes(rects),
    })
    for (const probe of probes) {
      if (probe.text && regionsByPage.has(probe.page_index)) {
        failingPages.add(probe.page_index)
        failures.push(
          `a second PDF engine (pdfium) still finds text under a redacted region on page ` +
            `${probe.page_index + 1} - a pdfjs-blind CID/exotic-font glyph may have survived`,
        )
      }
    }
  } catch (err) {
    // The ONLY independent (non-pdfjs) witness could not run. We cannot
    // rule out a CID/exotic-font survivor the pdfjs layers are blind to —
    // block at security severity rather than certify on a shared blind spot.
    failures.push(
      `independent-engine (pdfium) region witness unavailable (${err instanceof Error ? err.message : String(err)}) ` +
        '- a CID/exotic-font region cannot be certified clean; refusing to certify the redaction',
    )
    collector?.record({
      area: 'redact.cid_scan_inconclusive',
      detail:
        'the independent (pdfium) text witness could not run, so a CID/subset-font region ' +
        `could not be confirmed empty (${err instanceof Error ? err.message : String(err)})`,
    })
  }

  // Layer 5b — INDEPENDENT-FRAME positive control (GATE 2). Layers 1–5
  // above all decode/locate through pdfjs — the SAME engine + getViewport
  // math the raster burn uses — so a burn displaced by a frame bug can
  // remove *something*, satisfy the no-op guard, and let those layers
  // certify the (wrongly-inspected) region clean while the secret survives
  // at the TRUE location (gauntlet RB-4 / RB-6). This witness renders the
  // OUTPUT with pdfium (a different engine AND frame) and asserts the marked
  // region is (near-)uniformly the fill color, with the region derived from
  // CropBox geometry — NOT the burn's frame. A verifier that reuses the
  // burn's frame cannot detect a frame bug in that code; this one can.
  if (rasterizedPages && rasterizedPages.size > 0) {
    try {
      const pdfDoc = await PDFDocument.load(outBytes)
      const pages = pdfDoc.getPages()
      type Reg = { region: { x: number; y: number; width: number; height: number }; page: number }
      const byColor = new Map<string, { fill: [number, number, number]; regs: Reg[] }>()
      let skippedRotated = 0
      for (const r of rects) {
        if (!rasterizedPages.has(r.page)) continue
        const page = pages[r.page]
        if (!page) continue
        let region: { x: number; y: number; width: number; height: number }
        if (r.viewRect) {
          // Manual marks carry an EXACT display fraction — works for any
          // rotation, and is derived independently of the intrinsic-rect
          // mapping the burn used (so a mapping bug shows up as non-fill).
          region = r.viewRect
        } else {
          const rot = ((page.getRotation().angle % 360) + 360) % 360
          if (rot !== 0) {
            // A machine rect (find-&-redact) on a rotated page: no display
            // fraction, and the unrotated CropBox normalization does not
            // apply. The pdfjs-frame layers still gate this page.
            skippedRotated++
            continue
          }
          let cb: { x: number; y: number; width: number; height: number }
          try {
            const c = page.getCropBox()
            cb = c && c.width > 0 && c.height > 0 ? c : page.getMediaBox()
          } catch {
            cb = page.getMediaBox()
          }
          region = userRectToNormalizedView({ x: r.x, y: r.y, width: r.width, height: r.height }, cb)
        }
        const color = (r.color ?? [0, 0, 0]) as [number, number, number]
        const key = color.join(',')
        if (!byColor.has(key)) byColor.set(key, { fill: color, regs: [] })
        byColor.get(key)!.regs.push({ region, page: r.page })
      }
      if (skippedRotated > 0) {
        collector?.record({
          area: 'redact.fill_witness_skipped_rotated',
          detail:
            `${skippedRotated} rasterized region(s) on rotated page(s) were not checked by the ` +
            'independent pdfium fill witness (rotated display-frame mapping not yet wired); the ' +
            'pdfjs-frame layers still gate those pages',
        })
      }
      const { invoke } = await import('@tauri-apps/api/core')
      let ranAny = false
      for (const { fill, regs } of byColor.values()) {
        if (regs.length === 0) continue
        const probes = await invoke<
          Array<{ page_index: number; fill_fraction: number; sampled: number; bad_pixel: number[] | null }>
        >('pdf_probe_region_fill', {
          bytes: Array.from(outBytes),
          regions: regs.map((g) => ({
            page_index: g.page,
            x: g.region.x,
            y: g.region.y,
            width: g.region.width,
            height: g.region.height,
          })),
          fill: [Math.round(fill[0] * 255), Math.round(fill[1] * 255), Math.round(fill[2] * 255)],
        })
        ranAny = true
        probes.forEach((pr, i) => {
          const g = regs[i]
          if (!g || pr.sampled === 0) return // region off the rendered page; other layers cover
          if (pr.fill_fraction < 0.95) {
            failingPages.add(g.page)
            failures.push(
              `an independent engine (pdfium) renders the redacted region on page ${g.page + 1} as only ` +
                `${Math.round(pr.fill_fraction * 100)}% the redaction fill color` +
                (pr.bad_pixel ? ` (e.g. rgb(${pr.bad_pixel.join(',')}))` : '') +
                ' - the raster burn was displaced or did not apply; content may survive at the true location',
            )
          }
        })
      }
      if (ranAny) {
        collector?.record({
          area: 'redact.fill_witness_verified',
          detail:
            'independent-engine (pdfium) positive control confirmed the rasterized redaction ' +
            'region(s) are the fill color at the true content location',
        })
      }
    } catch (err) {
      failures.push(
        `independent-engine (pdfium) fill witness unavailable (${err instanceof Error ? err.message : String(err)}) ` +
          '- a rasterized redaction region cannot be confirmed opaque; refusing to certify the redaction',
      )
    }
  }

  return { failures, failingPages, metadataScrubCandidates }
}

// ── Layer 5: image-pixel sweep ───────────────────────────────────

/** pdfjs decoded image payload (page.objs / inline-image op arg). */
export interface DecodedImageLike {
  width: number
  height: number
  data: Uint8Array | Uint8ClampedArray
}

type Matrix = [number, number, number, number, number, number]

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

/** PDF `cm` concatenation: newCTM = m × ctm. */
export function multiplyMatrix(m: Matrix | number[], ctm: Matrix): Matrix {
  return [
    m[0] * ctm[0] + m[1] * ctm[2],
    m[0] * ctm[1] + m[1] * ctm[3],
    m[2] * ctm[0] + m[3] * ctm[2],
    m[2] * ctm[1] + m[3] * ctm[3],
    m[4] * ctm[0] + m[5] * ctm[2] + ctm[4],
    m[4] * ctm[1] + m[5] * ctm[3] + ctm[5],
  ]
}

function applyMatrix(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

/** Maps a PDF user-space rect to bitmap pixel coordinates (top-left origin)
 *  through a pdfjs viewport transform (the `viewport.transform` matrix that
 *  rendered the page). Pure + unit-testable: the redaction raster burn
 *  relies on it landing the fill on the rendered pixels for ANY rotation /
 *  CropBox offset (gauntlet RB-1 / RB-3). All four corners are transformed
 *  and the axis-aligned bounding box is taken, so a 90/270 rotation (which
 *  swaps width/height) is handled by construction rather than by a manual
 *  swap. */
export function userRectToPixelRect(
  rect: { x: number; y: number; width: number; height: number },
  transform: Matrix,
): { x: number; y: number; width: number; height: number } {
  const corners = [
    applyMatrix(transform, rect.x, rect.y),
    applyMatrix(transform, rect.x + rect.width, rect.y),
    applyMatrix(transform, rect.x, rect.y + rect.height),
    applyMatrix(transform, rect.x + rect.width, rect.y + rect.height),
  ]
  const xs = corners.map((c) => c[0])
  const ys = corners.map((c) => c[1])
  const x0 = Math.min(...xs)
  const y0 = Math.min(...ys)
  return { x: x0, y: y0, width: Math.max(...xs) - x0, height: Math.max(...ys) - y0 }
}

/** Normalized TOP-LEFT view fraction [0,1] of a user-space rect within a
 *  CropBox, for a page with NO /Rotate (intrinsic orientation == display).
 *  Computed from CropBox geometry alone — independent of the pdfjs viewport
 *  matrix the burn uses — so it can drive the GATE-2 pdfium fill probe as a
 *  witness the burn does NOT own. Rotated pages need the display-frame mark
 *  instead (wired separately); this is the unrotated common case. */
export function userRectToNormalizedView(
  rect: { x: number; y: number; width: number; height: number },
  cropBox: { x: number; y: number; width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const cw = cropBox.width || 1
  const ch = cropBox.height || 1
  return {
    x: (rect.x - cropBox.x) / cw,
    y: (cropBox.y + cropBox.height - (rect.y + rect.height)) / ch,
    width: rect.width / cw,
    height: rect.height / ch,
  }
}

/** Page-space bbox of the image unit square under the CTM. */
export function unitSquareBBox(ctm: Matrix): Region {
  const pts = [applyMatrix(ctm, 0, 0), applyMatrix(ctm, 1, 0), applyMatrix(ctm, 0, 1), applyMatrix(ctm, 1, 1)]
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const x0 = Math.min(...xs)
  const y0 = Math.min(...ys)
  return { x: x0, y: y0, width: Math.max(...xs) - x0, height: Math.max(...ys) - y0 }
}

/** Pure pixel witness (unit-testable): checks that every pixel of the
 *  image that falls inside any of the given page-space regions is
 *  within tolerance of one of the redaction fill colors. Returns
 *  human-readable failure strings; an empty array is a pass. Formats
 *  it cannot decode are FAILURES, not skips. */
export function imageRegionPixelFailures(
  img: DecodedImageLike,
  ctm: Matrix,
  regions: Region[],
  fillColors: Array<[number, number, number]>, // 0..255 components
  tolerance = 12,
): string[] {
  const { width: w, height: h, data } = img
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return ['image has invalid dimensions - pixels cannot be verified']
  }
  const det = ctm[0] * ctm[3] - ctm[1] * ctm[2]
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) {
    return ['image transform is not invertible - pixels cannot be verified']
  }
  const inv: Matrix = [
    ctm[3] / det,
    -ctm[1] / det,
    -ctm[2] / det,
    ctm[0] / det,
    (ctm[2] * ctm[5] - ctm[3] * ctm[4]) / det,
    (ctm[1] * ctm[4] - ctm[0] * ctm[5]) / det,
  ]

  // Pixel reader per pdfjs ImageKind (1bpp grayscale rows are padded
  // to byte boundaries; 24bpp RGB; 32bpp RGBA).
  let getPixel: ((px: number, py: number) => [number, number, number]) | null = null
  if (data.length === w * h * 3) {
    getPixel = (px, py) => {
      const i = (py * w + px) * 3
      return [data[i], data[i + 1], data[i + 2]]
    }
  } else if (data.length === w * h * 4) {
    getPixel = (px, py) => {
      const i = (py * w + px) * 4
      return [data[i], data[i + 1], data[i + 2]]
    }
  } else if (data.length === Math.ceil(w / 8) * h) {
    const rowBytes = Math.ceil(w / 8)
    getPixel = (px, py) => {
      const bit = (data[py * rowBytes + (px >> 3)] >> (7 - (px & 7))) & 1
      const v = bit ? 255 : 0
      return [v, v, v]
    }
  }
  if (!getPixel) {
    return [`image pixel format not decodable (${w}×${h}, ${data.length} bytes) - pixels cannot be verified`]
  }

  const failures: string[] = []
  for (const region of regions) {
    // Map the region's corners through the inverse CTM into image unit
    // space, then into pixel coordinates (image row 0 is the TOP edge,
    // i.e. v near 1).
    const corners = [
      applyMatrix(inv, region.x, region.y),
      applyMatrix(inv, region.x + region.width, region.y),
      applyMatrix(inv, region.x, region.y + region.height),
      applyMatrix(inv, region.x + region.width, region.y + region.height),
    ]
    const us = corners.map((c) => c[0])
    const vs = corners.map((c) => c[1])
    const pxMin = Math.max(0, Math.floor(Math.min(...us) * w) + 2)
    const pxMax = Math.min(w - 1, Math.ceil(Math.max(...us) * w) - 3)
    const pyMin = Math.max(0, Math.floor((1 - Math.max(...vs)) * h) + 2)
    const pyMax = Math.min(h - 1, Math.ceil((1 - Math.min(...vs)) * h) - 3)
    if (pxMin > pxMax || pyMin > pyMax) continue // region misses the image's pixels

    let bad: [number, number, [number, number, number]] | null = null
    scan: for (let py = pyMin; py <= pyMax; py++) {
      for (let px = pxMin; px <= pxMax; px++) {
        const [r, g, b] = getPixel(px, py)
        const matches = fillColors.some(
          ([fr, fg, fb]) =>
            Math.abs(r - fr) <= tolerance && Math.abs(g - fg) <= tolerance && Math.abs(b - fb) <= tolerance,
        )
        if (!matches) {
          bad = [px, py, [r, g, b]]
          break scan
        }
      }
    }
    if (bad) {
      failures.push(
        `image pixels under a redacted region are NOT the redaction fill ` +
          `(pixel ${bad[0]},${bad[1]} is rgb(${bad[2].join(',')})) - content survives inside the image`,
      )
    }
  }
  return failures
}

// ── §9g (vecredact): raw vector-path content under a redaction region ──
//
// The text witnesses (Layers 1-3 byte/decoded/region-empty, Layer 6 pdfium)
// and the image-pixel sweep (Layer 5) are ALL blind to raw vector PATH
// content — filled rectangles, strokes, bezier curves: outlined text, a
// chart, a signature, a logo. A secret drawn that way is COVERED by the
// black mark yet survives verbatim in the content stream, so the pipeline
// would falsely certify it permanent (§9g, found by red-team of §9a). These
// pure helpers walk a page's operator list with CTM tracking and answer one
// question: does any PAINTED path's real geometry overlap a redaction
// region? The caller routes a hit page to the proven raster/flatten path
// BEFORE the (blind) witnesses run. Region-scoped so a table border / rule
// elsewhere on the page does not trip it; pure + exported so the logic is
// unit-testable against synthetic AND real (fixture) operator lists.

/** The subset of pdfjs `OPS` codes the vector walk consults. Passed in so
 *  the walk is decoupled from the pdfjs import and unit-testable with a
 *  synthetic map. */
export interface VectorOpCodes {
  save: number
  restore: number
  transform: number
  constructPath: number
  moveTo: number
  lineTo: number
  curveTo: number
  curveTo2: number
  curveTo3: number
  rectangle: number
  closePath: number
  stroke: number
  closeStroke: number
  fill: number
  eoFill: number
  fillStroke: number
  eoFillStroke: number
  closeFillStroke: number
  closeEOFillStroke: number
  endPath: number
  paintFormXObjectBegin: number
  paintFormXObjectEnd: number
}

interface VectorSubpath {
  /** Points in LOCAL (pre-CTM) user space. For curves ALL control points
   *  are included — the curve stays within their convex hull, so the bbox
   *  is an over-approximation (the SAFE direction for a leak guard). */
  pts: Array<[number, number]>
  /** A standalone `re` rectangle (a closed, fillable quad). */
  isRect: boolean
  /** Subpath was explicitly closed (`h`, or a `re`) → its closing edge
   *  paints under a stroke. */
  closed: boolean
}

/** Decode one `constructPath` operator. pdfjs merges consecutive path-
 *  construction ops into a single op whose args are
 *  `[opsArray, flatCoords, minMax]`; this returns the subpaths in local
 *  user space. Sub-op operand arities are the PDF-spec / pdfjs `getOPMap`
 *  values (m,l = 2; c = 6; v,y = 4; re = 4; h = 0). Exported for unit tests. */
export function decodeConstructPathSubpaths(
  ops: ReadonlyArray<number>,
  coords: ArrayLike<number>,
  c: VectorOpCodes,
): VectorSubpath[] {
  const subpaths: VectorSubpath[] = []
  let cur: VectorSubpath | null = null
  let i = 0
  const ensure = (): VectorSubpath => {
    if (!cur) {
      cur = { pts: [], isRect: false, closed: false }
      subpaths.push(cur)
    }
    return cur
  }
  for (const op of ops) {
    if (op === c.moveTo) {
      const x = coords[i++]
      const y = coords[i++]
      cur = { pts: [[x, y]], isRect: false, closed: false }
      subpaths.push(cur)
    } else if (op === c.lineTo) {
      const x = coords[i++]
      const y = coords[i++]
      ensure().pts.push([x, y])
    } else if (op === c.curveTo) {
      const s = ensure()
      for (let k = 0; k < 3; k++) {
        const x = coords[i++]
        const y = coords[i++]
        s.pts.push([x, y])
      }
    } else if (op === c.curveTo2 || op === c.curveTo3) {
      const s = ensure()
      for (let k = 0; k < 2; k++) {
        const x = coords[i++]
        const y = coords[i++]
        s.pts.push([x, y])
      }
    } else if (op === c.rectangle) {
      const x = coords[i++]
      const y = coords[i++]
      const w = coords[i++]
      const h = coords[i++]
      subpaths.push({
        pts: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]],
        isRect: true,
        closed: true,
      })
      cur = null
    } else if (op === c.closePath) {
      if (cur) cur.closed = true
    }
  }
  return subpaths
}

/** Does the segment p0→p1 intersect the axis-aligned rect? Liang–Barsky
 *  clip; an endpoint inside the rect and an edge crossing both count, and a
 *  degenerate zero-length segment (a dot) inside the rect counts. Pure +
 *  exported for unit tests. */
export function segmentIntersectsRect(
  x0: number, y0: number, x1: number, y1: number,
  rx: number, ry: number, rw: number, rh: number,
): boolean {
  const xmin = rx
  const xmax = rx + rw
  const ymin = ry
  const ymax = ry + rh
  const dx = x1 - x0
  const dy = y1 - y0
  let t0 = 0
  let t1 = 1
  const slabs: Array<[number, number]> = [
    [-dx, x0 - xmin],
    [dx, xmax - x0],
    [-dy, y0 - ymin],
    [dy, ymax - y0],
  ]
  for (const [p, q] of slabs) {
    if (p === 0) {
      if (q < 0) return false // parallel to this slab and outside it
      continue
    }
    const r = q / p
    if (p < 0) {
      if (r > t1) return false
      if (r > t0) t0 = r
    } else {
      if (r < t0) return false
      if (r < t1) t1 = r
    }
  }
  return t0 <= t1
}

function pointsBBox(pts: Array<[number, number]>): Region {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of pts) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/** Does a painted path (its subpaths, in LOCAL space) overlap a region after
 *  the CTM? `isFill` selects the test: a filled interior ≈ the subpath bbox;
 *  a stroke paints only the edges, so segment-crossing is used (a large
 *  hollow stroked frame whose edges miss the region does not trip). A near-
 *  full-page subpath is page furniture (background / border) and is skipped
 *  — it carries no localized secret and rasterizing for it is pure fidelity
 *  loss with no security gain (a uniform full-page block encodes nothing
 *  extractable, while real outlined text / charts span far less). */
function vectorPaintHitsRegions(
  subpaths: VectorSubpath[],
  ctm: Matrix,
  regions: Region[],
  pageWidth: number,
  pageHeight: number,
  isFill: boolean,
): boolean {
  for (const sp of subpaths) {
    if (sp.pts.length === 0) continue
    const tpts = sp.pts.map(([x, y]) => applyMatrix(ctm, x, y)) as Array<[number, number]>
    const bb = pointsBBox(tpts)
    if (!Number.isFinite(bb.x) || !Number.isFinite(bb.y)) continue
    if (bb.width >= 0.92 * pageWidth && bb.height >= 0.92 * pageHeight) continue
    if (isFill) {
      if (regions.some((rg) => rectOverlapsRegion(bb, rg))) return true
      continue
    }
    // Stroke: only the path edges paint. Test each drawn segment (and the
    // closing edge of a closed subpath) against each region.
    const n = tpts.length
    if (n === 1) {
      for (const rg of regions) {
        if (segmentIntersectsRect(tpts[0][0], tpts[0][1], tpts[0][0], tpts[0][1], rg.x, rg.y, rg.width, rg.height)) {
          return true
        }
      }
      continue
    }
    for (let k = 0; k + 1 < n; k++) {
      for (const rg of regions) {
        if (segmentIntersectsRect(tpts[k][0], tpts[k][1], tpts[k + 1][0], tpts[k + 1][1], rg.x, rg.y, rg.width, rg.height)) {
          return true
        }
      }
    }
    if ((sp.closed || sp.isRect) && n >= 2) {
      for (const rg of regions) {
        if (segmentIntersectsRect(tpts[n - 1][0], tpts[n - 1][1], tpts[0][0], tpts[0][1], rg.x, rg.y, rg.width, rg.height)) {
          return true
        }
      }
    }
  }
  return false
}

/** Walk a page operator list (pdfjs `fnArray`/`argsArray`) with CTM tracking
 *  — save/restore/transform plus Form-XObject begin/end (pdfjs inlines forms,
 *  applying the form matrix) — and answer: does any PAINTED path overlap a
 *  redaction region? Stops at the first hit. Pure + exported for unit tests. */
export function operatorListHitsVectorRegions(
  fnArray: ArrayLike<number>,
  argsArray: ArrayLike<unknown>,
  ops: VectorOpCodes,
  regions: Region[],
  pageWidth: number,
  pageHeight: number,
): boolean {
  const FILL_OPS = new Set<number>([
    ops.fill, ops.eoFill, ops.fillStroke, ops.eoFillStroke, ops.closeFillStroke, ops.closeEOFillStroke,
  ])
  const STROKE_OPS = new Set<number>([ops.stroke, ops.closeStroke])
  let ctm: Matrix = IDENTITY
  const stack: Matrix[] = []
  let subpaths: VectorSubpath[] = []
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i]
    const args = argsArray[i] as ReadonlyArray<unknown> | undefined
    if (fn === ops.save) {
      stack.push(ctm)
    } else if (fn === ops.restore) {
      ctm = stack.pop() ?? IDENTITY
    } else if (fn === ops.transform) {
      ctm = multiplyMatrix(args as number[], ctm)
    } else if (fn === ops.paintFormXObjectBegin) {
      // pdfjs: save() then transform(matrix). Mirror so form-embedded paths
      // are tracked in page space (the image sweep does NOT do this — §9g is
      // stricter, matching the fail-closed intent).
      stack.push(ctm)
      const m = args?.[0] as number[] | null | undefined
      if (m && m.length === 6) ctm = multiplyMatrix(m, ctm)
    } else if (fn === ops.paintFormXObjectEnd) {
      ctm = stack.pop() ?? IDENTITY
    } else if (fn === ops.constructPath) {
      const pathOps = (args?.[0] ?? []) as number[]
      const coords = (args?.[1] ?? []) as number[]
      for (const sp of decodeConstructPathSubpaths(pathOps, coords, ops)) subpaths.push(sp)
    } else if (FILL_OPS.has(fn)) {
      if (vectorPaintHitsRegions(subpaths, ctm, regions, pageWidth, pageHeight, true)) return true
      subpaths = []
    } else if (STROKE_OPS.has(fn)) {
      if (vectorPaintHitsRegions(subpaths, ctm, regions, pageWidth, pageHeight, false)) return true
      subpaths = []
    } else if (fn === ops.endPath) {
      subpaths = []
    }
  }
  return false
}

/** Newer pdfjs may deliver decoded images as `{ bitmap: ImageBitmap }`
 *  instead of typed-array data — rasterize through a canvas so the
 *  pixel witness still sees real pixels. */
function decodedImageData(img: unknown): DecodedImageLike | null {
  const bmp = (img as { bitmap?: ImageBitmap })?.bitmap
  if (!bmp || typeof document === 'undefined') return null
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bmp.width
    canvas.height = bmp.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(bmp, 0, 0)
    const id = ctx.getImageData(0, 0, bmp.width, bmp.height)
    return { width: bmp.width, height: bmp.height, data: id.data }
  } catch {
    return null
  }
}

/** Walks each redacted page's operator list with CTM tracking and runs
 *  the pixel witness on every image painted across a region. Image
 *  masks and undecodable images intersecting a region are failures. */
async function sweepImagePixelsInRegions(
  outBytes: Uint8Array,
  rects: RedactionRect[],
  regionsByPage: Map<number, Region[]>,
  failures: string[],
  failingPages: Set<number>,
  collector?: SaveDegradationCollector,
  rasterizedPages?: Set<number>,
): Promise<void> {
  const pdfjsLib = await import('pdfjs-dist')
  const OPS = pdfjsLib.OPS
  // isOffscreenCanvasSupported:false asks pdfjs for typed-array pixel
  // data instead of ImageBitmap objects; decodedImageData() below also
  // handles the bitmap form for pdfjs versions that ignore the option.
  const doc = await pdfjsLib.getDocument({
    data: outBytes.slice(),
    isOffscreenCanvasSupported: false,
  }).promise
  try {
    for (const [pageIndex, regions] of regionsByPage) {
      if (pageIndex >= doc.numPages) continue
      // A page WE rasterized has its entire content replaced by a single
      // full-page burned image — there is no "vector box over a surviving
      // secret image" to catch here (the threat this layer exists for), and
      // the burn's correctness is verified INDEPENDENTLY by Layer 5b (the
      // pdfium fill witness, a different engine + frame). Worse, the full-page
      // flattened image often fails pdfjs's post-getOperatorList page.objs.get
      // decode and would FALSELY refuse an otherwise-perfect redaction. Skip
      // it — Layer 5b owns rasterized pages. (force_mask_only pages are NOT in
      // rasterizedPages, so the mask-only fault injection is still caught.)
      if (rasterizedPages?.has(pageIndex)) continue
      const fillColors = rects
        .filter((r) => r.page === pageIndex)
        .map((r): [number, number, number] => {
          const [cr, cg, cb] = r.color ?? [0, 0, 0]
          return [Math.round(cr * 255), Math.round(cg * 255), Math.round(cb * 255)]
        })
      const page = await doc.getPage(pageIndex + 1)
      const opList = await page.getOperatorList()
      let ctm: Matrix = IDENTITY
      const stack: Matrix[] = []
      for (let i = 0; i < opList.fnArray.length; i++) {
        const fn = opList.fnArray[i]
        const args = opList.argsArray[i]
        if (fn === OPS.save) {
          stack.push(ctm)
        } else if (fn === OPS.restore) {
          ctm = stack.pop() ?? IDENTITY
        } else if (fn === OPS.transform) {
          ctm = multiplyMatrix(args as number[], ctm)
        } else if (
          fn === OPS.paintImageXObject ||
          fn === OPS.paintInlineImageXObject ||
          fn === OPS.paintImageMaskXObject
        ) {
          const bbox = unitSquareBBox(ctm)
          const hitRegions = regions.filter((rg) => rectOverlapsRegion(bbox, rg))
          if (hitRegions.length === 0) continue
          if (fn === OPS.paintImageMaskXObject) {
            failingPages.add(pageIndex)
            failures.push(
              `an image mask is painted across a redacted region on page ${pageIndex + 1} ` +
                '- stencil content cannot be certified as redacted',
            )
            // R9c: this is the unscanned-stream-overlaps-a-region case
            // promoted to a SECURITY block (geometry-true — it only fires
            // for an image/stencil that actually intersects a redaction
            // region, so it cannot false-positive on images elsewhere).
            collector?.record({
              area: 'redact.image_undecodable_under_region',
              detail:
                `page ${pageIndex + 1}: an image mask overlaps a redacted region and its ` +
                'stencil pixels cannot be certified clean - the redaction was refused',
              pageIndex,
            })
            continue
          }
          let img: DecodedImageLike | null = null
          if (fn === OPS.paintInlineImageXObject) {
            img = (args?.[0] ?? null) as DecodedImageLike | null
          } else {
            try {
              img = page.objs.get(args[0]) as DecodedImageLike | null
            } catch {
              img = null
            }
          }
          if (img && !(img as { data?: unknown }).data) {
            img = decodedImageData(img) ?? img
          }
          if (!img || !img.data) {
            failingPages.add(pageIndex)
            failures.push(
              `an image painted across a redacted region on page ${pageIndex + 1} could not be ` +
                'decoded for pixel verification',
            )
            // R9c: an image stream (often DCT/JPX/CCITT — exactly where
            // image-borne secrets hide and the byte scanner is blind) that
            // OVERLAPS a redaction region but cannot be pixel-verified is a
            // SECURITY block, not a footnote. Geometry-true: it fires only
            // for an image intersecting a region, never doc-wide.
            collector?.record({
              area: 'redact.image_undecodable_under_region',
              detail:
                `page ${pageIndex + 1}: an image overlapping a redacted region could not be ` +
                'decoded for pixel verification - the redaction was refused',
              pageIndex,
            })
            continue
          }
          const errs = imageRegionPixelFailures(img, ctm, hitRegions, fillColors)
          if (errs.length > 0) {
            failingPages.add(pageIndex)
            for (const e of errs) failures.push(`page ${pageIndex + 1}: ${e}`)
          }
        }
      }
      page.cleanup()
    }
  } finally {
    try { await doc.destroy() } catch { /* best-effort cleanup */ }
  }
}

/** Remediation: delete /Info keys whose decoded value contains a leaked
 *  needle, and drop the XMP /Metadata stream wholesale (it is regenerable
 *  and cannot be safely rewritten as serialized XML). */
async function scrubMetadataNeedles(
  bytes: Uint8Array,
  needleTexts: string[],
  collector?: SaveDegradationCollector,
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(bytes)
  const ctx = pdfDoc.context as any
  const norms = needleTexts.map((t) => normalizeRedactionText(t)).filter(Boolean)
  const removed: string[] = []

  let info: unknown = ctx.trailerInfo.Info
  if (info instanceof PDFRef) {
    try { info = ctx.lookup(info) } catch { info = null }
  }
  if (info instanceof PDFDict) {
    for (const [key, value] of [...info.entries()]) {
      let text = ''
      try {
        const v = value as { decodeText?: () => string; asString?: () => string }
        text = v.decodeText?.() ?? v.asString?.() ?? ''
      } catch { text = '' }
      const valueNorm = normalizeRedactionText(String(text))
      if (valueNorm && norms.some((n) => valueNorm.includes(n))) {
        info.delete(key)
        removed.push(`/Info ${key.toString()}`)
      }
    }
  }
  if (pdfDoc.catalog.has(PDFName.of('Metadata'))) {
    pdfDoc.catalog.delete(PDFName.of('Metadata'))
    removed.push('XMP /Metadata stream')
  }

  collector?.record({
    area: 'redact.metadata_scrubbed',
    detail: `document metadata scrubbed during redaction: ${removed.join(', ') || 'no matching keys found'}`,
  })
  pruneUnreachablePdfObjects(pdfDoc)
  return await pdfDoc.save()
}

// ── Annotation removal under redaction regions ───────────────────

function lookupAnnotDict(ctx: unknown, value: unknown): PDFDict | null {
  if (value instanceof PDFRef) {
    try {
      const got = (ctx as { lookup(ref: PDFRef): unknown }).lookup(value)
      return got instanceof PDFDict ? got : null
    } catch {
      return null
    }
  }
  return value instanceof PDFDict ? value : null
}

function readAnnotRect(annot: PDFDict): Region | null {
  let rectVal: unknown
  try { rectVal = annot.lookup(PDFName.of('Rect')) } catch { return null }
  if (!(rectVal instanceof PDFArray) || rectVal.size() < 4) return null
  const nums: number[] = []
  for (let i = 0; i < 4; i++) {
    let v: unknown
    try { v = rectVal.lookup(i) } catch { return null }
    if (!(v instanceof PDFNumber)) return null
    const n = v.asNumber()
    if (!Number.isFinite(n)) return null
    nums.push(n)
  }
  const x0 = Math.min(nums[0], nums[2])
  const y0 = Math.min(nums[1], nums[3])
  return { x: x0, y: y0, width: Math.max(nums[0], nums[2]) - x0, height: Math.max(nums[1], nums[3]) - y0 }
}

/** Removes every annotation overlapping a redaction region (plus their
 *  popups and /IRT reply chains), clearing form-field values when the
 *  removed widget was the field's only presentation. Unreadable
 *  annotations on redacted pages are removed conservatively — geometry
 *  that cannot be checked cannot be allowed to stay. */
function removeAnnotationsInRegions(
  pdfDoc: PDFDocument,
  regionsByPage: Map<number, Region[]>,
  collector?: SaveDegradationCollector,
): void {
  const ctx = pdfDoc.context
  const pages = pdfDoc.getPages()
  let totalRemoved = 0

  for (const [pageIndex, regions] of regionsByPage) {
    const page = pages[pageIndex]
    if (!page) continue
    const annotsVal = page.node.lookup(PDFName.of('Annots'))
    if (!(annotsVal instanceof PDFArray)) continue

    interface Entry { raw: unknown; dict: PDFDict | null; refKey: string | null; remove: boolean }
    const entries: Entry[] = []
    for (let i = 0; i < annotsVal.size(); i++) {
      const raw = annotsVal.get(i)
      entries.push({
        raw,
        dict: lookupAnnotDict(ctx, raw),
        refKey: raw instanceof PDFRef ? raw.toString() : null,
        remove: false,
      })
    }

    for (const e of entries) {
      if (!e.dict) { e.remove = true; continue }
      const rect = readAnnotRect(e.dict)
      if (!rect) { e.remove = true; continue }
      if (regions.some((rg) => rectOverlapsRegion(rect, rg))) e.remove = true
    }

    // Fixpoint: popups whose /Parent is removed and replies whose /IRT
    // target is removed go too (their content quotes the removed one).
    let changed = true
    while (changed) {
      changed = false
      const removedKeys = new Set(
        entries.filter((e) => e.remove && e.refKey).map((e) => e.refKey as string),
      )
      for (const e of entries) {
        if (e.remove || !e.dict) continue
        for (const linkKey of ['Parent', 'IRT', 'Popup']) {
          const target = e.dict.get(PDFName.of(linkKey))
          if (target instanceof PDFRef && removedKeys.has(target.toString())) {
            e.remove = true
            changed = true
            break
          }
        }
      }
    }

    const removedEntries = entries.filter((e) => e.remove)
    if (removedEntries.length === 0) continue
    const removedKeys = new Set(
      removedEntries.filter((e) => e.refKey).map((e) => e.refKey as string),
    )

    for (const e of removedEntries) {
      if (!e.dict) continue
      if (e.dict.get(PDFName.of('Subtype')) !== PDFName.of('Widget')) continue
      // A form widget under a redaction region renders the field VALUE —
      // clear it unless other widgets elsewhere present the same field.
      const parentDict = lookupAnnotDict(ctx, e.dict.get(PDFName.of('Parent')))
      const fieldDict = parentDict ?? e.dict
      let kids: unknown
      try { kids = fieldDict.lookup(PDFName.of('Kids')) } catch { kids = undefined }
      let sharedSurvivor = false
      if (kids instanceof PDFArray) {
        for (let i = 0; i < kids.size(); i++) {
          const kid = kids.get(i)
          const kidKey = kid instanceof PDFRef ? kid.toString() : null
          // An unidentifiable kid might be a surviving widget — do not
          // destroy a possibly-shared value.
          if (!kidKey || !removedKeys.has(kidKey)) { sharedSurvivor = true; break }
        }
      }
      if (sharedSurvivor) {
        collector?.record({
          area: 'redact.field_value_shared',
          detail:
            'a form widget under a redaction region was removed, but the field value was ' +
            'kept because other widgets elsewhere present the same field',
          pageIndex,
        })
      } else {
        for (const k of ['V', 'DV', 'RV', 'AP']) {
          e.dict.delete(PDFName.of(k))
          fieldDict.delete(PDFName.of(k))
        }
      }
      // Detach the removed widget from the surviving field tree so its
      // appearance stream is no longer reachable (prune collects it).
      if (kids instanceof PDFArray && e.refKey) {
        for (let i = kids.size() - 1; i >= 0; i--) {
          const kid = kids.get(i)
          if (kid instanceof PDFRef && kid.toString() === e.refKey) kids.remove(i)
        }
      }
    }

    for (let i = annotsVal.size() - 1; i >= 0; i--) {
      if (entries[i]?.remove) annotsVal.remove(i)
    }
    if (annotsVal.size() === 0) page.node.delete(PDFName.of('Annots'))
    totalRemoved += removedEntries.length
  }

  if (totalRemoved > 0) {
    collector?.record({
      area: 'redact.annotations_removed',
      detail:
        `${totalRemoved} annotation(s) overlapping redacted regions were removed ` +
        '(comments, links, popups, and form widgets cannot keep content under a redaction)',
    })
  }
}
