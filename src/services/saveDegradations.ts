// Structured save-degradation channel (Hardening Session 1).
//
// Every silent fallback in the save pipeline becomes a recorded
// SaveDegradation instead of (at best) one mutable warning string.
// The collector is APPEND-ONLY and deduplicating: when two fallbacks
// fire in one save, both surface — the old single-slot
// `paragraphSaveWarning` pattern dropped everything after the first.
//
// One collector instance is constructed PER SAVE INVOCATION and
// threaded explicitly through the pipeline (no module singleton —
// concurrent saves on different tabs must not interleave, and HMR
// must not reset a save in flight).
//
// Severity contract (the strict-gate currency for Sessions 2-9):
//   - 'security'  → leaked/recoverable content the user asked to
//                   remove. Always shown. Always fails strict.
//   - 'fidelity'  → output differs from the user's intent (overlay
//                   instead of rewrite, substituted font, dropped
//                   edit, wrong geometry). Shown. Fails strict.
//   - 'info'      → designed degradation or cosmetic default that
//                   matches longstanding intended behavior (alias
//                   font mapping, run-styled overlay path). Counted
//                   in the toast, full text in the report. Strict
//                   tests still see it via the report + bake paths.

export type DegradationSeverity = 'info' | 'fidelity' | 'security'

export interface SaveDegradation {
  /** Stable machine-readable site id, dotted lowercase —
   *  e.g. `engine.rewrite_to_overlay`, `strip.skipped_text_recoverable`. */
  area: string
  /** Technical context: which paragraph, which font, engine reason. */
  detail: string
  severity: DegradationSeverity
  pageIndex?: number
  paragraphId?: string
}

/** Which bake path a paragraph edit took at save time. NOTE: a save
 *  that THROWS (DocMDP refusal, data-loss guard, encryption failure)
 *  writes no report at all — the previous report stays in place and
 *  drivers detect it via the unchanged saveSeq. There is deliberately
 *  no 'failed' path value: per-edit failure attribution inside a
 *  refused save is Session-3+ work. */
export type BakePathKind = 'rewrite' | 'overlay' | 'legacy_pdflib'

export interface ParagraphPathEntry {
  paragraphId: string
  pageIndex: number
  path: BakePathKind
  /** HONEST granularity marker. The engine cascade decides per
   *  BATCH (one rewrite attempt for all plain edits, all-or-nothing
   *  — see splitParagraphEditsByBakePath + bakeParagraphEditsViaEngine),
   *  so a per-edit entry derived from a batch outcome says so here.
   *  'page' = the legacy pd-lib path, which applies per page. */
  granularity: 'batch' | 'page'
  /** Engine's reason when a rewrite batch fell to overlay/legacy. */
  failureReason?: string
}

/** Real write-evidence numbers from one engine bake/rewrite batch
 *  (Session 2, additive). Mirrors the engine's WriteSummary so strict
 *  drivers can assert on actual write activity — appended bytes, new
 *  objects — instead of trusting the path label alone. One entry per
 *  successful engine batch in the save (rewrite batch and styled
 *  overlay batch bake separately). */
export interface EngineWriteSummaryEntry {
  /** Which engine stage produced this batch's bytes. */
  path: 'rewrite' | 'overlay'
  /** Which IPC route carried the bake: 'path' = the heavy
   *  engine_*_to_path commands (>1 MiB docs), 'bytes' = in-memory.
   *  Drivers proving the heavy route assert this instead of inferring
   *  it from a size precondition alone. */
  route: 'path' | 'bytes'
  totalBytes: number
  appendedBytes: number
  newXrefOffset: number
  previousXrefOffset: number
  newObjectsEmitted: number
}

/** Persistent per-save report stored in PdfFormatState._lastSaveReport.
 *  Rewritten on EVERY committed save, including the no-edit fast path,
 *  so MCP drivers never read a stale previous save as current. */
export interface SaveReport {
  /** Monotonic per-tab sequence; drivers compare across saves to
   *  detect staleness (a save that short-circuits before the handler
   *  — e.g. clean-tab isDirty guard — leaves saveSeq unchanged). */
  saveSeq: number
  timestamp: number
  /** True when the no-edit fast path returned the bytes verbatim. */
  fastPath: boolean
  degradations: SaveDegradation[]
  paragraphPaths: ParagraphPathEntry[]
  /** Present only when at least one engine batch baked this save.
   *  Absent on the fast path and on pure legacy/pd-lib saves. */
  engineSummaries?: EngineWriteSummaryEntry[]
}

/** Rust-side event shape (satchel_core::fallback::FallbackEvent). */
export interface EngineFallbackEvent {
  area: string
  detail: string
}

// ── Severity mapping ─────────────────────────────────────────────

/** Families the frontend DELIBERATELY maps onto Standard-14 metrics
 *  (see isStandard14Family in pdfEngineBake.ts). A bake-time
 *  substitution of one of these is designed aliasing → info, not a
 *  fidelity warning on every Calibri document. */
const ALIAS_FAMILY_FRAGMENTS = [
  'helvetica', 'arial', 'sans-serif', 'calibri', 'system-ui', '-apple-system',
  'times', 'serif', 'roman', 'georgia', 'cambria',
  'courier', 'mono', 'consolas', 'menlo', 'inconsolata', 'fixed',
]

function isAliasFamily(family: string): boolean {
  const s = family.toLowerCase()
  if (!s) return true
  return ALIAS_FAMILY_FRAGMENTS.some((f) => s.includes(f))
}

const SECURITY_AREAS = new Set([
  'strip.skipped_text_recoverable',
  'text.whiteout_unavailable',
  // Attachments are container formats the redaction permanence scan
  // cannot inspect — redacted content may survive inside them.
  'redact.attachments_present',
  // Session-3 (verifier gate-2 P1): deletion ≠ redaction is by design,
  // but the consequence is a SECURITY property of the saved file — the
  // "deleted" text is recoverable from the prior revision's bytes by
  // anyone with a text editor. Strict lifecycle runs that delete text
  // must explicitly allow this area; the toast tells the user to use
  // Redact for permanent removal.
  'delete.recoverable_prior_revision',
  // Gate-2 P2: a hand-drawn opaque rect that did NOT route through the
  // redaction pipeline is the classic mask-only failure — the covered
  // content ships in the file looking redacted. Security, not a
  // cosmetic footnote.
  'redact.unclassified_opaque_rect',
  // R9c (Session 9): an image / stencil that OVERLAPS a redaction region
  // but cannot be pixel-verified (undecodable DCT/JPX/CCITT, or an image
  // mask) — exactly where image-borne secrets hide and the byte scanner
  // is blind. Geometry-true (fires only on region overlap, never doc-
  // wide), so it BLOCKS rather than footnoting. The accompanying failure
  // refuses the save; this record makes the block a visible security
  // event. (The doc-wide redact.scan_streams_undecodable INFO record
  // below stays — it covers streams NOT correlated to a region.)
  'redact.image_undecodable_under_region',
  // R9a/R9b (Session 9): the independent (pdfium) text witness — the only
  // verdict layer that does NOT decode through pdfjs — could not run, so a
  // CID/subset-font region (text survives as glyph indices pdfjs cannot
  // read) cannot be certified clean by any engine. Inconclusive == refuse,
  // never a silent pass; the accompanying failure blocks the save.
  'redact.cid_scan_inconclusive',
  // R9d (Session 9): the document was digitally signed, and redaction's
  // full regeneration (the single-revision neutralization that prevents a
  // prior-revision leak) invalidates that signature. Security severity so
  // the user is never silently handed a file they believe is still signed;
  // a signed-doc redaction lifecycle must allow this area explicitly.
  'redact.signature_invalidated',
  // R6 (gauntlet): a plain edit (not redaction) on an approval-signed PDF
  // invalidates the existing signature — the signed byte range no longer
  // matches. SECURITY so the user is never silently handed a file that "looks
  // signed" but verifies as modified. A signed-doc edit lifecycle must allow
  // this area explicitly; the redaction path's own redact.signature_invalidated
  // covers the redaction case (this is excluded there to avoid double-record).
  'signature.invalidated_by_edit',
])
// NOT in any set (defaults to fidelity): redact.raster_fallback and
// redact.raster_dropped_doc_structure — the raster path is the SAFE
// direction for permanence (pixels burned, nothing left to leak) but a
// real fidelity loss: pages become images; form fields/bookmarks/name
// trees are dropped by the rebuild.
// Also deliberately unregistered → fidelity (Session 6, the auto-layout
// frontier): linked.overflow_dropped (text past a linked chain's last
// frame is not in the saved file) and layout.cross_page_overflow (edited
// text grew below the page bottom and true multi-page flow is not
// implemented). Both are real, loud, strict-failing losses by design.
// Also deliberately unregistered → fidelity (Session 7, OCR editing):
// ocr.style_forced — edited OCR text is redrawn in a forced font/weight/
// color (Helvetica, regular, black) because OCR cannot know the scanned
// glyphs' real typeface. That is a genuine VISUAL divergence from the
// source, so it stays loud (fidelity). It is NEVER a strict true-edit
// pass — paragraphPaths records the OCR edit as path:'overlay', which
// already fails the expectTrueEdit gate; the matching designed-behavior
// record is ocr.overlay_only (info, below). An OCR-edit lifecycle runs
// in the harness's overlayAcceptable mode with BOTH areas declared.
// Also deliberately unregistered → fidelity (Session 8, tagged PDF):
// tag.structure_flattened — the snapshot-and-restore re-tag rebuilds a
// tagged PDF's structure as /P-per-page + /Figure, so heading levels
// (H1/H2/H3), list structure (/L /LI /Lbl /LBody), table structure
// (/Table /TR /TH /TD), and /Link tags collapse to generic paragraphs.
// That is a real accessibility-FIDELITY loss (it used to be SILENT), so
// it stays loud and strict-failing. A tagged-PDF edit-save is therefore
// run in the harness's overlayAcceptable mode with this area declared —
// true H/L/Table preservation is engine-level work (the bake keeps no
// structure↔run map), tracked in KNOWN-LIMITATIONS §8. Sibling tag
// areas (tag.snapshot_failed / tag.restore_failed /
// tag.restore_skipped_redaction) likewise fall through to fidelity.

const INFO_AREAS = new Set([
  // Optional metadata wipe (the checkbox beside the redaction tools): a SUCCESS
  // record, not a degradation — the user opted into it. A FAILED wipe
  // (metadata.wipe_failed) is deliberately NOT listed here, so it falls through
  // to the loud fidelity default below (identifying metadata may remain).
  'metadata.wiped',
  // The post-redaction metadata scrub (the second modal after the destructive
  // redaction strong-save offered "scrub identifying metadata? highly
  // recommended"). A SUCCESS record — the user accepted the offer. Mirrors
  // metadata.wiped; the FAILED form falls through to metadata.wipe_failed.
  'metadata.scrubbed_after_redaction',
  'engine.run_styled_overlay',
  'engine.new_textbox_overlay',
  'font.subset_failed_full_embed',
  // Session-3 redaction channel: designed behaviors of the verified
  // redaction pipeline, not leaks. Leaks REFUSE the save (throw) —
  // these record what the verifier did and which checks were demoted.
  'redact.short_needle',
  'redact.token_outside_region',
  'redact.structural_token_needle',
  'redact.annotations_removed',
  'redact.metadata_scrubbed',
  'redact.permanence_verified',
  // GATE-2 independent-frame positive control: a SUCCESS record — pdfium
  // (a different engine + frame than the burn) confirmed the rasterized
  // region is the fill color at the true content location. A FAILED witness
  // REFUSES the save (throws), so only the pass is recorded here.
  'redact.fill_witness_verified',
  // Legal Guarantee deliberately flattens every redacted page to a secured
  // image. The page losing selectable text is the EXPLICIT, walkthrough-
  // confirmed consequence of the user enabling LG — designed behavior, not a
  // surprise loss (mirrors ocr.overlay_only). The dedicated LG success toast
  // already communicates the outcome; this stays in the report at info.
  'redact.legal_guarantee_flatten',
  'redact.field_value_shared',
  // Gate-2 P3: non-Flate streams (DCT/JPX/CCITT image payloads) cannot
  // be decompressed by the byte scanner; the demotion is recorded, and
  // the image-pixel + decoded layers own that content.
  'redact.scan_streams_undecodable',
  // NOT geometry.media_box_default: the Session-1 A4 visual check
  // proved a defaulted page height makes overlay redraws land in a
  // mispositioned clip — edited text visually VANISHES. That is
  // fidelity, not a cosmetic footnote (the underlying indirect-ref
  // lookup bug is fixed, so this now fires only on genuinely
  // missing/unreadable MediaBox).
  'color.parse_failed_default',
  'layout.justify_no_spaces',
  'layout.auto_reflow_blocked',
  // Session 5 — alignment honesty (R5a). The routing/carry records
  // narrate the chain DOING the right thing (alignment preserved via
  // the align-aware overlay); the loss case is the deliberately
  // UNREGISTERED layout.alignment_unpreserved, which falls through to
  // the fidelity default below so strict gates fail on it.
  'layout.detected_alignment_routed',
  // Edits landing in ambiguous regions are frozen AND flagged (epic
  // deliverable 3) — the freeze is designed behavior, hence info.
  'layout.ambiguous_region_edit',
  // §5b: a width-changing edit on a lone display line that looks visually
  // centered but the detector had no confident claim. INFO (not fidelity):
  // it is bounded by detector recall, not a hard contract — the alignment
  // MIGHT have been centered. Surfacing it turns the previously-SILENT
  // weak-evidence case (KNOWN-LIMITATIONS §5b) into a recorded one,
  // role-gated to the lone-centered-display-line class to avoid nagging.
  'layout.alignment_weak_evidence',
  // The enrichment fallback could not resolve layout metadata for an
  // edit — alignment/font-recovery state is UNKNOWN, made visible.
  'layout.enrichment_unavailable',
  // Session 4 — the overlay-stage resolution chain. These are the
  // chain's HONEST narration, not losses by themselves: the loss, if
  // any, lands as font.substituted / font.embed_resolution_failed
  // (fidelity) or as a refused save (UnencodableReplacementError).
  // The D3 enumeration is info for the same reason — the fidelity
  // event for the path itself is engine.rewrite_to_overlay.
  'font.doc_embed_unusable',
  'font.system_match_fuzzy',
  'font.unicode_escalated',
  'overlay.properties_approximated',
  // Session 7 (OCR editing): the OCR edit path is overlay BY NATURE — an
  // image-only page has no extractable source text to rewrite in place,
  // so a drawn overlay is the only honest representation, not a fallback
  // from a real rewrite attempt. Designed behavior → info, mirroring the
  // engine.run_styled_overlay precedent. The accompanying VISUAL loss
  // (forced font/weight/color) is the SEPARATE ocr.style_forced record,
  // which stays fidelity (unregistered, above). Both surface; neither is
  // a strict true-edit pass (the bake path is recorded as 'overlay').
  'ocr.overlay_only',
  // Session tagpreserve: the tagged-PDF structure-preservation SUCCESS
  // records. These are the honest counterpart to tag.structure_flattened
  // (fidelity) — they fire when an edit-save KEEPS accessibility structure
  // instead of collapsing it to /P, so the win is visible in the report
  // rather than the report only ever narrating losses.
  //   • tag.structure_preserved_fully — the original /StructTreeRoot was
  //     kept intact (no tagged-page content was rewritten; the existing
  //     tree survives the save round-trip verbatim, or every original
  //     semantic role was reproduced 1:1). Census after == census before.
  //   • tag.structure_preserved_types — a content edit rewrote part of the
  //     document, but the original semantic hierarchy (H/L/Table/Figure/
  //     Link/Form types + nesting) was re-asserted on the saved bytes; the
  //     detail carries the preserved-vs-flattened role breakdown. Honest:
  //     preserved roles are content-less structure markers (the per-element
  //     MCID↔run association of rewritten content is NOT rebuilt — see
  //     KNOWN-LIMITATIONS §8a), but the types + nesting are real and pass
  //     veraPDF UA-1.
  //   • tag.structure_preservation_failed — the type-preserving rebuild
  //     threw; the save fell back to today's flat /P rebuild rather than
  //     aborting. Recorded so the degradation (a flatten happened despite
  //     a preserve attempt) is never silent. The accompanying
  //     tag.structure_flattened (fidelity) still fires from the census diff.
  'tag.structure_preserved_fully',
  'tag.structure_preserved_types',
  'tag.structure_preservation_failed',
])

/** Canonical detail format for `font.substituted` — the severity
 *  classifier below PARSES this format, so every TS emitter must
 *  build its detail through this helper (the Rust emitter in
 *  bake.rs pins the same shape with a unit test). `requested` must
 *  be the PRIMARY family (never a CSS stack — a stack's own leading
 *  quote makes the regex capture come up empty). */
export function substitutionDetail(requested: string, used: string, suffix = ''): string {
  return `requested='${requested}' used='${used}'${suffix ? ` ${suffix}` : ''}`
}

/** Default severity for an area. `font.substituted` is special-cased:
 *  designed alias families are info; anything else (a real custom
 *  font the user lost) is fidelity. Unknown areas default to
 *  fidelity — conservative: an unmapped degradation should be loud
 *  until someone classifies it. */
export function severityForArea(area: string, detail = ''): DegradationSeverity {
  if (SECURITY_AREAS.has(area)) return 'security'
  if (INFO_AREAS.has(area)) return 'info'
  if (area === 'font.substituted') {
    const m = /requested='([^']*)'/.exec(detail)
    const requested = m?.[1] ?? ''
    // Conservative on malformed details (Session-4 hardening): a
    // missing or EMPTY capture means the emitter drifted from the
    // canonical format (classically: a quoted CSS stack put its own
    // quote after requested=' and the capture came up empty, filing
    // every real custom-font loss as designed-alias info). An
    // unclassifiable substitution is LOUD, never silently info.
    if (!m || requested === '') return 'fidelity'
    return isAliasFamily(requested) ? 'info' : 'fidelity'
  }
  return 'fidelity'
}

/** Info-severity areas whose FULL text still belongs in the toast —
 *  established, actionable user guidance (today's UX shows it). Other
 *  info items appear in the toast only as a collapsed count line; the
 *  full text lives in the report. */
export const TOAST_VISIBLE_INFO_AREAS = new Set([
  'layout.auto_reflow_blocked',
  // The post-redaction metadata scrub success rides in the toast in full so
  // the user gets explicit confirmation that identifying metadata was removed
  // alongside the redaction (it is the second thing they just confirmed).
  'metadata.scrubbed_after_redaction',
])

const SEVERITY_ORDER: Record<DegradationSeverity, number> = {
  security: 0,
  fidelity: 1,
  info: 2,
}

// ── Collector ────────────────────────────────────────────────────

export interface RecordInput {
  area: string
  detail: string
  /** Override the table mapping (rarely needed). */
  severity?: DegradationSeverity
  pageIndex?: number
  paragraphId?: string
}

export class SaveDegradationCollector {
  private items: SaveDegradation[] = []
  private seen = new Set<string>()

  /** Append one degradation. Deduplicates exact repeats
   *  (area+detail+paragraphId+pageIndex) so per-edit loops can record
   *  unconditionally without inflating the report. */
  record(input: RecordInput): void {
    const severity = input.severity ?? severityForArea(input.area, input.detail)
    // JSON key, not string concatenation: `detail` is free-form (it
    // embeds error messages), so a delimiter-joined key was injectable
    // — {detail:'a|1'} collided with {detail:'a', paragraphId:'1'}.
    // Severity participates so an explicit override is never dropped
    // as a duplicate of a differently-classified record.
    const key = JSON.stringify([input.area, input.detail, input.paragraphId, input.pageIndex, severity])
    if (this.seen.has(key)) return
    this.seen.add(key)
    this.items.push({
      area: input.area,
      detail: input.detail,
      severity,
      ...(input.pageIndex !== undefined ? { pageIndex: input.pageIndex } : {}),
      ...(input.paragraphId ? { paragraphId: input.paragraphId } : {}),
    })
  }

  /** Merge events captured on the Rust side (engine bake/rewrite
   *  command responses) into this save's list. Severity is assigned
   *  by the same table — Rust events carry only area+detail. */
  recordEngineEvents(
    events: EngineFallbackEvent[] | undefined | null,
    ctx: { pageIndex?: number } = {},
  ): void {
    if (!events) return
    for (const ev of events) {
      if (!ev || typeof ev.area !== 'string') continue
      this.record({ area: ev.area, detail: ev.detail ?? '', pageIndex: ctx.pageIndex })
    }
  }

  /** Snapshot, sorted security → fidelity → info (stable within a
   *  severity class, in recording order). */
  list(): SaveDegradation[] {
    return [...this.items].sort(
      (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
    )
  }

  hasAny(): boolean {
    return this.items.length > 0
  }

  highestSeverity(): DegradationSeverity | null {
    if (this.items.length === 0) return null
    return this.list()[0].severity
  }

  count(severity?: DegradationSeverity): number {
    if (!severity) return this.items.length
    return this.items.filter((d) => d.severity === severity).length
  }
}

// ── User-facing text ─────────────────────────────────────────────

/** Human-readable one-liner for a degradation. Areas with
 *  established notice copy keep it (the toast text users already
 *  know); everything else gets a readable generic form. */
export function humanizeDegradation(d: SaveDegradation): string {
  switch (d.area) {
    case 'engine.rewrite_to_overlay':
      if (/(style-change edit present|style\/layout edit requires overlay)/i.test(d.detail)) {
        return (
          'Paragraph style/layout saved with fixed-box overlay because font-resource, ' +
          'alignment, or spacing changes cannot be represented as a pure in-stream ' +
          'text rewrite. The page should match the edit preview, but search/copy ' +
          'may differ for clipped overflow text.'
        )
      }
      return (
        'Saved with paragraph overlay fallback instead of a true in-stream text rewrite. ' +
        'The page should look correct, but search/copy behavior may differ on this PDF.' +
        (d.detail ? ` Reason: ${d.detail}` : '')
      )
    case 'engine.legacy_pdflib':
      return (
        'Saved via the legacy paragraph overlay path (Rust engine unavailable or failed). ' +
        (d.detail ? ` Reason: ${d.detail}` : '')
      )
    case 'engine.run_styled_overlay':
      return 'Per-selection styled text was rendered via the rich-text overlay path.'
    case 'engine.new_textbox_overlay':
      return 'New text boxes were drawn as overlay content (no original text to rewrite).'
    case 'strip.skipped_text_recoverable':
      return (
        'SECURITY: the original text under an edited region could not be removed — ' +
        'it remains recoverable in the saved file. ' + d.detail
      )
    case 'text.whiteout_unavailable':
      return (
        'SECURITY: replacement masking was unavailable for some text edits — ' +
        'original text may remain visible or recoverable. ' + d.detail
      )
    case 'font.substituted':
      return `Edited text was re-rendered with a substituted font (${d.detail}).`
    case 'font.embed_resolution_failed':
      return `A custom font could not be resolved for embedding; a standard font was used (${d.detail}).`
    case 'font.embed_payload_missing':
      return `An embedded font payload was missing at bake time; a standard font was used (${d.detail}).`
    case 'font.standard14_retry':
      return (
        'Some edited text was re-rendered with a standard font (Helvetica/Times/Courier) ' +
        'because the original font could not be embedded.'
      )
    case 'font.subset_failed_full_embed':
      return `Font subsetting failed; the full font was embedded instead (${d.detail}).`
    case 'font.doc_embed_unusable':
      return `The document's own embedded font could not be reused for the edited text (${d.detail}).`
    case 'font.system_match_fuzzy':
      return `A system font was matched by approximate name rather than exact family (${d.detail}).`
    case 'font.unicode_escalated':
      return `Some characters are outside the standard PDF text encoding; an embedded system font was used to preserve them (${d.detail}).`
    case 'overlay.properties_approximated':
      return `Overlay re-draw approximates some original text properties (${d.detail}).`
    case 'ocr.overlay_only':
      return (
        'OCR-recognized text was saved as a drawn overlay, not a true in-stream rewrite — ' +
        'an image-only page has no extractable source text to modify in place. The edited ' +
        'text is searchable and copyable, but it is an overlay by nature: the original ' +
        `scanned page image is unchanged beneath it (${d.detail}).`
      )
    case 'ocr.style_forced':
      return (
        'Edited OCR text was redrawn in a forced font, weight, and color (the scanned ' +
        "glyphs' real typeface is unknown to OCR), so its appearance is approximated " +
        `rather than matched to the original scan (${d.detail}).`
      )
    case 'tag.snapshot_failed':
      return 'Tagged-PDF structure could not be snapshotted before save; the saved file may lose accessibility tags.'
    case 'tag.restore_failed':
      return 'Tagged-PDF structure could not be restored after save; the saved file may lose accessibility tags.'
    case 'tag.structure_flattened':
      return (
        'Accessibility structure was simplified during save: headings, lists, tables, and ' +
        'links were rebuilt as plain tagged paragraphs (/P). The document stays tagged and ' +
        'readable, but heading levels, list/table semantics, and link tags are not preserved ' +
        `through an edit-save (${d.detail}).`
      )
    case 'tag.structure_preserved_fully':
      return (
        'Accessibility structure was preserved on save: the document\'s original tagged ' +
        'structure tree (headings, lists, tables, figures, links) was kept intact ' +
        `(${d.detail}).`
      )
    case 'tag.structure_preserved_types':
      return (
        'Accessibility structure types were preserved on save: heading levels and list/' +
        'table/figure/link semantics were re-asserted on the edited document. Rewritten ' +
        `text is tagged as plain paragraphs (${d.detail}).`
      )
    case 'tag.structure_preservation_failed':
      return (
        'Tagged-PDF structure could not be type-preserved during save and fell back to a ' +
        `flat paragraph rebuild; heading/list/table/link types were simplified (${d.detail}).`
      )
    case 'reflow.skipped':
      return (
        'Auto layout reflow was skipped for this save because page analysis failed. ' +
        'Deleted text leaves blank space instead of closing the gap.'
      )
    case 'layout.auto_reflow_blocked':
      return d.detail
    case 'layout.detected_alignment_routed':
      return `Detected paragraph alignment was preserved via the overlay redraw (${d.detail}).`
    case 'layout.alignment_unpreserved':
      return (
        'Edited text was redrawn left-anchored although the original paragraph is ' +
        `center/right/justify aligned — the visual alignment is NOT preserved (${d.detail}).`
      )
    case 'layout.alignment_weak_evidence':
      return (
        'The original line looks visually centered, but its alignment could not be ' +
        'confidently detected, so the edited text was redrawn left-anchored — a centered ' +
        `appearance may not be preserved (${d.detail}).`
      )
    case 'linked.overflow_dropped':
      return (
        'Some text overflowed the last frame of a linked text chain and is NOT shown ' +
        `in the saved file. Add a frame or enlarge the last one to restore it (${d.detail}).`
      )
    case 'layout.cross_page_overflow':
      return (
        'Edited text grew past the bottom of the page. True multi-page text flow is not ' +
        `supported, so the overflowing text is off-page in the saved file (${d.detail}).`
      )
    case 'layout.ambiguous_region_edit':
      return `An edit landed in an ambiguous layout region and was saved as a fixed text box (${d.detail}).`
    case 'layout.enrichment_unavailable':
      return `Layout metadata could not be resolved for an edit; alignment preservation is unknown for it (${d.detail}).`
    case 'text.span_whiteout':
      return `A text edit was applied as a whiteout overlay (original encoding could not be rewritten in place) (${d.detail}).`
    case 'text.whiteout_failed':
      return `SAVE INCOMPLETE for some text edits: the whiteout fallback failed (${d.detail}).`
    case 'text.edit_dropped':
      return `A text edit could not be applied and was dropped from the saved file (${d.detail}).`
    case 'text.clipped_to_fixed_box':
      return (
        'Edited text overflowed its fixed paragraph box and the overflow was clipped from ' +
        'the saved file. Turn on "Auto layout text edits" to reflow the text instead of ' +
        `clipping it, or make the box larger (${d.detail}).`
      )
    case 'serializer.text_edit_dropped':
      return `A text edit could not be serialized and was dropped from the saved file (${d.detail}).`
    case 'geometry.page_height_unavailable':
      return `Page geometry could not be read; edit coordinates may be misplaced (${d.detail}).`
    case 'redact.raster_fallback':
      return `Redacted pages were rasterized (pixels burned — nothing recoverable, but the pages become images) (${d.detail}).`
    case 'redact.glyph_procedure_rasterized':
      return `A redacted page used a glyph drawn as a Type3 procedure, a Form XObject, or an image mask — invisible to the text/geometry redaction checks — so the page was flattened to a secured image to remove it permanently (the page loses selectable text) (${d.detail}).`
    case 'redact.raster_dropped_doc_structure':
      return `Raster redaction rebuilt the document and dropped document-level structures (${d.detail}).`
    case 'redact.scan_streams_undecodable':
      return `Some compressed streams could not be opened by the byte-level scan; decoded-text and image-pixel verification still covered the redacted regions (${d.detail}).`
    case 'redact.image_undecodable_under_region':
      return `SECURITY: an image overlapping a redacted region could not be verified at the pixel level, so the redaction was refused — the image may still contain the content. ${d.detail}`
    case 'redact.cid_scan_inconclusive':
      return `SECURITY: the independent text-verification engine could not run, so a region using subset/CID fonts could not be confirmed clean — the redaction was refused rather than certified on an unverifiable region. ${d.detail}`
    case 'redact.signature_invalidated':
      return `SECURITY: this document was digitally signed; redacting it rewrites the whole file to remove the content permanently, which invalidates the signature — the saved copy is no longer signed. ${d.detail}`
    case 'signature.invalidated_by_edit':
      return `SECURITY: this document was digitally signed; your edit changes the signed content, so the saved file is no longer validly signed (a PDF viewer will flag it as modified). Re-sign it after editing if a signature is required. ${d.detail}`
    case 'redact.attachments_present':
      return `SECURITY: this document has file attachments that redaction cannot scan — redacted content may exist inside them. ${d.detail}`
    case 'redact.permanence_verified':
      return 'Redaction verified: byte-level, decoded-text, region, and annotation checks confirmed the redacted content is gone.'
    case 'redact.annotations_removed':
      return `Annotations overlapping redacted regions were removed along with the content (${d.detail}).`
    case 'redact.metadata_scrubbed':
      return `Document metadata containing redacted text was removed (${d.detail}).`
    case 'redact.field_value_shared':
      return `A redacted form widget was removed, but its field value is shared with widgets elsewhere and was kept (${d.detail}).`
    case 'redact.short_needle':
      return `Some redacted text was too short for document-wide verification; the redacted region itself was still verified empty (${d.detail}).`
    case 'redact.token_outside_region':
      return `Some redacted text also appears outside the redacted area, so only the marked region was verified (${d.detail}).`
    case 'redact.structural_token_needle':
      return `Some redacted text matches PDF-internal vocabulary; the byte-level scan was skipped for it while decoded and region checks still ran (${d.detail}).`
    case 'redact.unclassified_opaque_rect':
      return `An opaque black box was saved as a visual shape, NOT a redaction — content underneath remains in the file. Use the redaction tool to remove it permanently (${d.detail}).`
    case 'delete.recoverable_prior_revision':
      return `Deleted text is gone from the visible document, but the file's prior revision still contains it (incremental save). Use Redact for permanent removal (${d.detail}).`
    case 'tag.restore_skipped_redaction':
      return `Tagged-PDF structure was NOT restored after redaction because it still contained redacted text; the save kept the redacted (untagged) version (${d.detail}).`
    case 'serializer.form_value_dropped':
      return `A form value could not be written and was dropped from the saved file (${d.detail}).`
    case 'serializer.form_value_truncated':
      return `A form value may display truncated in other viewers (${d.detail}).`
    case 'encoding.char_dropped':
      return `Some characters could not be encoded in the output font and were dropped (${d.detail}).`
    case 'metadata.wiped':
      return `Document metadata was wiped on save: the /Info dictionary (title, author, creator, producer, dates) and the XMP metadata packet were removed (${d.detail}).`
    case 'metadata.scrubbed_after_redaction':
      return `Metadata scrubbed: along with the redaction, the document's identifying metadata — title, author, creator, producer, creation/modification dates, and the XMP packet — was removed from the saved file (${d.detail}).`
    case 'metadata.wipe_failed':
      return `Metadata wipe was requested but FAILED — identifying metadata may remain in the saved file (${d.detail}).`
    case 'redact.raster_dropped_page_interactivity':
      return `Redacted page(s) were flattened to a secured image, which removes their interactive objects — links, form fields, and accessibility tags do not survive a flatten (${d.detail}).`
    case 'redact.legal_guarantee_flatten':
      return `Legal Guarantee: redacted page(s) were permanently flattened to a secured image — the content under the marks is destroyed at the pixel level and those pages no longer have selectable text (${d.detail}).`
    case 'redact.fill_witness_verified':
      return 'Redaction confirmed by an independent engine: pdfium rendered the saved file and the redacted region(s) are solid fill at the true content location.'
    case 'redact.fill_witness_skipped_rotated':
      return `A rotated rasterized region could not be fill-checked by the independent pdfium witness; the other verification layers still gated it (${d.detail}).`
    default:
      return `${d.area}: ${d.detail}`
  }
}
