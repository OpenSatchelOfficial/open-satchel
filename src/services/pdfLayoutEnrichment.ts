// Session 5 (R5a/R5b) — save-seam layout enrichment + alignment honesty.
//
// THE GAP THIS CLOSES (Session-3/4 review, R5a): the clusterer's
// DETECTED alignment never entered the edit model, so a width-changing
// text edit on a center/right/justify paragraph kept the original Td
// anchor and visually broke alignment while the SaveReport stayed
// strict-clean — proven by the external render oracle
// (.test-mcp/test-alignment-fidelity-live.mjs, Δcenter≈180px on a
// zero-degradation save). The core epic rule: that must either be
// FIXED in the pixels or RECORDED as a degradation — never silent.
//
// Mechanism, in order:
//   1. ENRICH — every text-relevant paragraph edit carries the
//      clusterer's layout metadata (role, detected align, the R5b
//      generic-fallback font flag). Gesture-time attachment (editor
//      commit, find/replace) is the cheap primary source; this seam
//      re-clusters the edited pages as the FALLBACK for edits that
//      arrived without metadata (MCP store patches, stale persisted
//      edits). An edit that ends up with NO metadata records
//      layout.enrichment_unavailable — the unknown is visible, never
//      silent (gate-1 P0: the silent-miss channel must not reappear
//      one layer deeper).
//   2. DECIDE per edit (pure, unit-testable):
//      - route:   plain single-line text edit on a detected
//                 center/right paragraph whose overlay redraw is
//                 FAITHFUL (Std-14 alias family, not a generic-
//                 fallback stack, WinAnsi-coverable replacement) →
//                 carry align into the edit + requiresOverlay. The
//                 engine overlay re-lays the line inside the original
//                 ink bbox (G1, A5-proven), preserving the anchor.
//                 Never trades glyph fidelity for alignment fidelity
//                 (gate-1 P0): anything non-faithful records instead.
//      - carry:   the edit is ALREADY overlay-bound (style/run edit) —
//                 attach align so the redraw preserves it for free.
//      - unpreserved: every other width-changing case (multi-line,
//                 justify, custom/unrecoverable fonts, non-WinAnsi
//                 text) records layout.alignment_unpreserved at
//                 FIDELITY severity so a strict gate SEES the loss.
//   3. FLAG ambiguous-region edits (epic deliverable 3): an edit
//      landing on a layout-role 'ambiguous' paragraph records
//      layout.ambiguous_region_edit (info) — frozen AND flagged.

import type { ParagraphBox } from './pdfParagraphs'
import type { ParagraphEdit, TextAlign } from './pdfParagraphEdits'
import { editCarriesRunStyling } from './pdfParagraphEdits'
import { primaryFamily } from './pdfFontResolution'
import { isStandard14Family, winAnsiUncoveredCodepoints } from './pdfEngineBake'
import { isOcrParagraphId } from './pdfOcrToParagraphs'
import type { RecordInput } from './saveDegradations'

/** Minimal collector surface so unit drivers can pass a plain stub. */
export interface DegradationSink {
  record(input: RecordInput): void
}

/** Docs >16 MiB skip the save-time cluster fallback: clustering the
 *  page set at save time on the webview thread is the exact hazard
 *  class Session 4 measured on the 33 MB doc. Gesture-time metadata
 *  makes this path rare; when it fires, the miss is RECORDED. */
const ENRICHMENT_CLUSTER_BYTE_CAP = 16 * 1024 * 1024

/** Copy layout metadata from a source paragraph onto an edit, filling
 *  only fields the edit doesn't already carry. BOTH new fields are
 *  tri-state (gate-2 P1): the paragraph's own undefined ("detector
 *  had no evidence" / "recovery probe could not complete") survives —
 *  it is never collapsed into 'left' or false here. */
export function attachLayoutMetadataToEdit(edit: ParagraphEdit, para: ParagraphBox): void {
  if (para.layout) {
    if (edit.layoutRole === undefined) edit.layoutRole = para.layout.role
    if (edit.layoutSafeForAutoReflow === undefined) {
      edit.layoutSafeForAutoReflow = para.layout.safeForAutoReflow
    }
    if (edit.layoutFlowId === undefined && para.layout.flowId !== undefined) {
      edit.layoutFlowId = para.layout.flowId
    }
    if (edit.layoutReasons === undefined && para.layout.reasons) {
      edit.layoutReasons = [...para.layout.reasons]
    }
    if (edit.layoutDetectedAlign === undefined && para.layout.align !== undefined) {
      edit.layoutDetectedAlign = para.layout.align as TextAlign
    }
    if (
      edit.layoutWeakCenterEvidence === undefined &&
      para.layout.weakCenterEvidence !== undefined
    ) {
      edit.layoutWeakCenterEvidence = para.layout.weakCenterEvidence
    }
  }
  if (
    edit.fontFamilyIsGenericFallback === undefined &&
    para.fontFamilyIsGenericFallback !== undefined
  ) {
    edit.fontFamilyIsGenericFallback = para.fontFamilyIsGenericFallback
  }
}

export type AlignmentAction =
  | { kind: 'none' }
  | { kind: 'route'; align: TextAlign }
  | { kind: 'carry'; align: TextAlign }
  | { kind: 'unpreserved'; align: TextAlign; reason: string }

/** Pure decision for one edit — see the module header for the table. */
export function decideAlignmentHandling(edit: ParagraphEdit): AlignmentAction {
  const detected = edit.layoutDetectedAlign
  if (!detected || detected === 'left') return { kind: 'none' }
  // The user's explicit alignment always wins (the A5-proven path).
  if (edit.align !== undefined) return { kind: 'none' }
  if (edit.isNewTextBox || edit.skipSourceMask) return { kind: 'none' }
  const newText = edit.newText ?? ''
  // Deletes mask without drawing — nothing to anchor.
  if (newText.trim() === '') return { kind: 'none' }

  const overlayBound = edit.requiresOverlay === true || editCarriesRunStyling(edit)
  const textChanged = newText !== edit.originalText
  if (!textChanged) {
    // Style-only edits redraw the whole paragraph: carry the detected
    // alignment so the redraw preserves what the page already shows.
    return overlayBound ? { kind: 'carry', align: detected } : { kind: 'none' }
  }
  if (overlayBound) return { kind: 'carry', align: detected }

  const singleLine =
    !(edit.originalText ?? '').includes('\n') && !newText.includes('\n')
  // Routing demands POSITIVELY-known-faithful font state (=== false):
  // an unknown recovery state (undefined) must not pass the guard —
  // routing it could redraw an unrecoverable font in Helvetica under a
  // faithful label (gate-2 P1).
  const faithfulFont =
    edit.fontFamilyIsGenericFallback === false &&
    isStandard14Family(primaryFamily(edit.fontFamily ?? ''))
  if (
    (detected === 'center' || detected === 'right') &&
    singleLine &&
    faithfulFont &&
    winAnsiUncoveredCodepoints(newText).length === 0
  ) {
    return { kind: 'route', align: detected }
  }
  const reason =
    detected === 'justify'
      ? 'justified fill cannot be re-laid faithfully by a plain text edit'
      : !singleLine
        ? 'multi-line paragraph'
        : edit.fontFamilyIsGenericFallback === true
          ? 'the unrecoverable embedded font would substitute in the overlay redraw'
          : edit.fontFamilyIsGenericFallback === undefined
            ? 'font-recovery state is unknown for this edit'
            : !isStandard14Family(primaryFamily(edit.fontFamily ?? ''))
              ? 'the custom font would lose fidelity in the overlay redraw'
              : 'replacement text exceeds WinAnsi coverage'
  return { kind: 'unpreserved', align: detected, reason }
}

/** §5b: pure decision for whether one edit should record
 *  `layout.alignment_weak_evidence` (info). Fires for a width-changing
 *  edit on a lone display line that the classifier hinted is visually
 *  centered (weakCenterEvidence) but whose alignment it could not
 *  confidently detect (layoutDetectedAlign undefined). Role-gated to the
 *  genuine display-line class: the geometric hint also fires on
 *  multi_column lines straddling page center (the known false-positive
 *  class) and on frozen roles (table_cell/header/footer/form) that never
 *  reflow — both excluded here so the record stays on the ~0.4%-of-body
 *  lone-centered-heading class (corpus-measured), not ordinary documents. */
export function shouldRecordWeakCenterEvidence(edit: ParagraphEdit): boolean {
  return (
    edit.layoutWeakCenterEvidence === true &&
    edit.layoutDetectedAlign === undefined &&
    edit.align === undefined &&
    (edit.layoutRole === 'single_column_body' || edit.layoutRole === 'list_item') &&
    !edit.isNewTextBox &&
    !edit.skipSourceMask &&
    (edit.newText ?? '') !== (edit.originalText ?? '') &&
    (edit.newText ?? '').trim() !== ''
  )
}

export interface EnrichOptions {
  editsByPage: Map<number, ParagraphEdit[]>
  /** Cluster one page of the CURRENT document, or null when the
   *  pdfjs doc is unavailable / clustering failed. */
  clusterPage: (pageIndex: number) => Promise<ParagraphBox[] | null>
  collector: DegradationSink
  docByteLength: number
}

/** Returns an enriched CLONE of `editsByPage` (caller-owned edit
 *  objects are never mutated — the inputs are the live
 *  `_paragraphEdits` arrays on page state). */
export async function enrichAndRouteParagraphEdits(
  opts: EnrichOptions,
): Promise<Map<number, ParagraphEdit[]>> {
  const { clusterPage, collector, docByteLength } = opts
  const out = new Map<number, ParagraphEdit[]>()
  for (const [pageIndex, edits] of opts.editsByPage) {
    out.set(pageIndex, edits.map((e) => ({ ...e })))
  }

  // 1. Enrichment fallback for edits that arrived without metadata.
  for (const [pageIndex, edits] of out) {
    // layoutRole is the "metadata was attached" marker (the classifier
    // always assigns a role, so a gesture-attached edit always has
    // one). layoutDetectedAlign === undefined does NOT mean
    // un-attached — it can be the detector's honest unknown. The font
    // flag's undefined always warrants a re-check (operational miss).
    const needing = edits.filter(
      (e) =>
        !e.isNewTextBox &&
        !e.skipSourceMask &&
        // OCR edits (Session 7) carry OCR-derived geometry, never body-
        // flow layout. The body clusterer used as the enrichment
        // fallback emits `p_*` ids, so an `ocr_*` edit would never match
        // and would falsely record layout.enrichment_unavailable. OCR
        // boxes have no detected alignment/role to preserve — their
        // honest degradations are ocr.overlay_only / ocr.style_forced,
        // recorded at the bake seam — so skip enrichment for them.
        !isOcrParagraphId(e.paragraphId) &&
        (e.layoutRole === undefined ||
          e.fontFamilyIsGenericFallback === undefined),
    )
    if (needing.length === 0) continue
    const ids = needing.map((e) => e.paragraphId).join(', ')
    if (docByteLength > ENRICHMENT_CLUSTER_BYTE_CAP) {
      collector.record({
        area: 'layout.enrichment_unavailable',
        detail:
          `layout metadata missing for paragraph(s) ${ids} on page ${pageIndex} and the ` +
          `document is too large (${docByteLength} bytes) for the save-time cluster ` +
          'fallback; detected alignment and font-recovery state are UNKNOWN for these edits',
        pageIndex,
      })
      continue
    }
    const paras = await clusterPage(pageIndex)
    const byId = new Map((paras ?? []).map((p) => [p.id, p]))
    for (const edit of needing) {
      const para = byId.get(edit.paragraphId)
      if (para) {
        attachLayoutMetadataToEdit(edit, para)
        // The recluster ran but the font-recovery probe still could
        // not complete (operational miss) — the unknown is RECORDED,
        // never treated as positively faithful (gate-2 P1). Detector-
        // unknown ALIGNMENT after a completed analysis is the
        // documented conservative residual (weak-evidence geometry)
        // and stays silent by design — see KNOWN-LIMITATIONS.
        if (edit.fontFamilyIsGenericFallback === undefined) {
          collector.record({
            area: 'layout.enrichment_unavailable',
            detail:
              `paragraph ${edit.paragraphId} on page ${pageIndex}: the font-recovery ` +
              'probe could not complete (font object unavailable); whether its font is a ' +
              'faithful alias or an unrecoverable embedded font is UNKNOWN for this save',
            pageIndex,
            paragraphId: edit.paragraphId,
          })
        }
      } else {
        collector.record({
          area: 'layout.enrichment_unavailable',
          detail:
            `layout metadata missing for paragraph ${edit.paragraphId} on page ${pageIndex}` +
            (paras
              ? ' (paragraph not found in the save-time cluster pass - moved/synthesized edit?)'
              : ' (page analysis unavailable)') +
            '; detected alignment and font-recovery state are UNKNOWN for this edit',
          pageIndex,
          paragraphId: edit.paragraphId,
        })
      }
    }
  }

  // 2 + 3. Alignment handling + ambiguous-region flag.
  for (const [pageIndex, edits] of out) {
    for (const edit of edits) {
      const action = decideAlignmentHandling(edit)
      if (action.kind === 'route') {
        edit.align = action.align
        edit.requiresOverlay = true
        collector.record({
          area: 'layout.detected_alignment_routed',
          detail:
            `paragraph ${edit.paragraphId}: detected align='${action.align}' - text edit ` +
            'routed to the align-aware overlay so the alignment is preserved',
          pageIndex,
          paragraphId: edit.paragraphId,
        })
      } else if (action.kind === 'carry') {
        edit.align = action.align
        collector.record({
          area: 'layout.detected_alignment_routed',
          detail:
            `paragraph ${edit.paragraphId}: detected align='${action.align}' carried into ` +
            'the overlay redraw so the alignment is preserved',
          pageIndex,
          paragraphId: edit.paragraphId,
        })
      } else if (action.kind === 'unpreserved') {
        collector.record({
          area: 'layout.alignment_unpreserved',
          detail:
            `paragraph ${edit.paragraphId}: detected align='${action.align}' is NOT preserved ` +
            `by this save (${action.reason}); the redrawn text stays left-anchored`,
          pageIndex,
          paragraphId: edit.paragraphId,
        })
      } else if (shouldRecordWeakCenterEvidence(edit)) {
        // §5b: a width-changing edit on a lone display line that LOOKS
        // visually centered but whose alignment the detector could not
        // confidently read (tri-state undefined) — surface the loss
        // instead of shipping a broken center SILENTLY. (action.kind is
        // 'none' here precisely because layoutDetectedAlign is undefined.)
        collector.record({
          area: 'layout.alignment_weak_evidence',
          detail:
            `paragraph ${edit.paragraphId}: the original line appears visually centered but its ` +
            'alignment could not be confidently detected (weak geometric evidence); the edited ' +
            'text is redrawn left-anchored, so a centered appearance is not preserved',
          pageIndex,
          paragraphId: edit.paragraphId,
        })
      }

      const meaningful =
        (edit.newText ?? '') !== (edit.originalText ?? '') ||
        edit.styleChanged === true ||
        (edit.positionDelta !== undefined &&
          (Math.abs(edit.positionDelta.dx) >= 0.01 ||
            Math.abs(edit.positionDelta.dy) >= 0.01))
      if (edit.layoutRole === 'ambiguous' && meaningful && !edit.isNewTextBox) {
        collector.record({
          area: 'layout.ambiguous_region_edit',
          detail:
            `paragraph ${edit.paragraphId} sits in an ambiguous layout region; the edit was ` +
            'saved as a fixed text box (auto layout never moves ambiguous regions)',
          pageIndex,
          paragraphId: edit.paragraphId,
        })
      }
    }
  }

  return out
}
