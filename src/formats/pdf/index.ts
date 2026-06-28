import type { FormatHandler } from '../types'
import PdfViewer from './PdfViewer'
import PdfSidebar from './PdfSidebar'
import PdfToolbar from './PdfToolbar'
import { useFormatStore } from '../../stores/formatStore'
import { useHistoryStore, withReplay } from '../../stores/historyStore'
import { serializeEditsToPdf } from '../../services/editSerializer'
import { applyTextEditsToBytes, type TextLayerEdit } from '../../services/pdfTextEdits'
import {
  applyParagraphEditsToBytes,
  concatRuns,
  editCarriesRunStyling,
  paragraphHasMixedRuns,
  type ParagraphEdit,
} from '../../services/pdfParagraphEdits'
import { applyImageEditsToBytes, type ImageEdit } from '../../services/pdfImageEdits'
import {
  applyRedactions,
  verifyRedactionPermanence,
  type RedactionNeedle,
} from '../../services/pdfRedact'
import {
  collectManualRedactionsForSave,
  collectRedactionObstacleRects,
  findUnclassifiedOpaqueRects,
  stateHasManualRedactions,
  stripManualRedactionObjects,
} from '../../services/pdfManualRedactions'
import { bakeParagraphEditsViaEngine } from '../../services/pdfEngineBake'
import { enrichAndRouteParagraphEdits } from '../../services/pdfLayoutEnrichment'
import { isOcrParagraphId } from '../../services/pdfOcrToParagraphs'
import { clipParagraphEditsForFixedBoxes } from '../../services/pdfFixedBoxClip'
import {
  computeReflowDeltasWithReport,
  type ReflowParagraph,
  type ReflowWarning,
} from '../../services/pdfReflow'
import { clusterParagraphs } from '../../services/pdfParagraphs'
import {
  expandMovesToEdits,
  mergeMoveEditsWithExisting,
  type ParagraphMove,
} from '../../services/pdfParagraphMove'
import {
  flowTextThroughChainWithReport,
  expandChainToEdits,
  monospaceMeasure,
  type LinkedChain,
} from '../../services/pdfLinkedBlocks'
import {
  extractTagSnapshot,
  restoreTagsAfterSave,
  extractRoleCensus,
  computeFlattenedRoles,
  describeFlattenedRoles,
  summarizeStructureOutcome,
  type TagSnapshot,
} from '../../services/pdfStructPreserve'
import {
  extractNativeStickyNoteImports,
  type NativeStickyNoteSnapshot,
} from '../../services/pdfComments'
import { encryptPdf, type PermissionFlags } from '../../services/pdfCrypto'
import { verifySignatures } from '../../services/pdfSign'
import {
  SaveDegradationCollector,
  TOAST_VISIBLE_INFO_AREAS,
  type EngineWriteSummaryEntry,
  type ParagraphPathEntry,
  type SaveDegradation,
  type SaveReport,
} from '../../services/saveDegradations'
import { useUIStore } from '../../stores/uiStore'
import * as pdfjsLib from 'pdfjs-dist'

/** Cheap uncompressed-token scan for the no-edit fast path. Returns true
 *  when `token` (ASCII) appears in `bytes`. A tagged PDF whose
 *  /StructTreeRoot lives inside an object stream won't match — then we
 *  simply don't ANNOUNCE the preservation (the verbatim bytes still keep
 *  it). Bounded linear scan; only runs on an explicit clean save. */
function bytesContainAscii(bytes: Uint8Array, token: string): boolean {
  const n = token.length
  if (n === 0 || bytes.length < n) return false
  const first = token.charCodeAt(0)
  const limit = bytes.length - n
  outer: for (let i = 0; i <= limit; i++) {
    if (bytes[i] !== first) continue
    for (let j = 1; j < n; j++) {
      if (bytes[i + j] !== token.charCodeAt(j)) continue outer
    }
    return true
  }
  return false
}

export interface PdfPageState {
  pageIndex: number
  rotation: 0 | 90 | 180 | 270
  deleted: boolean
  fabricJSON: Record<string, unknown> | null
  formValues: Record<string, string | boolean> | null
  pageSize?: { width: number; height: number }
  /** Runtime-only save handoff: visual paragraph edits held after
   *  save has flushed real edits, until the new pdfjs canvas paints. */
  _savePreviewParagraphEdits?: ParagraphEdit[]
  /** Runtime-only save handoff for image moves, same purpose as above. */
  _savePreviewImageEdits?: ImageEdit[]
  /** Native PDF /Text annotations imported as editable comment markers. */
  _nativeStickyNotes?: NativeStickyNoteSnapshot[]
}

export interface PdfFormatState {
  pdfBytes: Uint8Array
  pageCount: number
  pages: PdfPageState[]
  /** True when in-memory bytes already crossed a destructive/security
   *  boundary, such as burned redactions. Cleared after the next save
   *  while also clearing undo history so pre-redaction bytes cannot be
   *  resurrected via Ctrl+Z after commit. */
  _historyBarrierOnSave?: boolean
  encryption?: {
    userPassword: string
    ownerPassword: string
    /** AES-256 = the modern default; others retained for Adobe Reader
     *  back-compat with old clients. */
    algorithm?: 'RC4_40' | 'RC4_128' | 'AES_128' | 'AES_256'
    permissions?: PermissionFlags
  }
  /** The tab was opened from an encrypted source after the user supplied
   *  its password. Saves preserve password protection via `encryption`
   *  instead of silently writing a decrypted file over the original. */
  _openedEncryptedSource?: boolean
  headerFooter?: HeaderFooterConfig
  /** B4: DocMDP enforce-on-load. When the loaded PDF carries a certified
   *  signature with a /DocMDP transform, this is the /P level the signer
   *  declared:
   *    1 — No changes allowed (any modification breaks the signature).
   *    2 — Form fill-in + signing only.
   *    3 — Form fill-in + signing + comments only.
   *  Save guards consult this to refuse destructive saves. Plain
   *  approval signatures (no /DocMDP) leave this undefined.
   *
   *  Detected once at load via verifySignatures(); no reactive update
   *  on edit — the signature itself certifies the static byte range,
   *  so the level can't change without the document changing. */
  docMdpLevel?: 1 | 2 | 3
  /** Set when docMdpLevel was triggered, so the UI can warn users
   *  before they make edits the signature won't survive. */
  certifiedSigner?: string
  /** R6 (gauntlet): true when the loaded PDF carries ANY digital signature
   *  (approval or certified). An APPROVAL signature does not lock editing the
   *  way a /DocMDP certified one does, but a content edit still invalidates it
   *  (the signed byte range no longer matches). The save records
   *  signature.invalidated_by_edit so that loss is loud rather than silently
   *  shipping a file that "looks signed" but verifies as tampered. */
  hasSignature?: boolean
  /** B6: in-session calc expressions per field name. Populated by
   *  the Form Designer when the user supplies a `calcExpression`
   *  alongside the field; read by FormFieldRenderer's onChange to
   *  recompute dependent fields. Whitelisted-expression engine —
   *  see pdfFormsCalc.ts for the grammar.
   *
   *  Survives only the current session; persistence to PDF
   *  (writing into /AA /K or a custom XMP entry) is a follow-up.
   *  In-memory wire-up is what users actually need to test the
   *  calc engine end-to-end during a fill session. */
  fieldCalcExpressions?: Record<string, string>
  /** D2: in-session field validations per field name. Form Designer
   *  populates this when the user attaches a `FormFieldValidation`
   *  to a field spec. Renderer surfaces invalid state via aria-invalid +
   *  red border + tooltip from `message`. Save guards refuse output
   *  if any field violates its validation.
   *
   *  Round-trip persistence (writing the rule into /AA /V keystroke
   *  or a custom XMP key) is a follow-up. */
  fieldValidations?: Record<string, import('../../services/pdfForms').FormFieldValidation>
  /** Session-1: one-shot structured save notices (toast-visible subset of
   *  the degradation list). actions.ts displays + clears after disk write.
   *  Replaces the old single-string `_postSaveWarning` slot, which could
   *  only ever surface ONE degradation per save. */
  _postSaveNotices?: SaveDegradation[]
  /** Session-1: persistent per-save report — the MCP/test source of truth.
   *  REWRITTEN on every committed save (incl. the no-edit fast path) with a
   *  monotonic saveSeq so drivers can detect staleness. Never cleared by
   *  the display path. Print (forPrint) runs write nothing here. */
  _lastSaveReport?: SaveReport
  /** Session-3: degradations recorded by surfaces that bake bytes into
   *  state OUTSIDE a save invocation (SearchAndRedactDialog applies
   *  redactions immediately and stores the result in pdfBytes). The
   *  eventual save — which may well take the no-edit FAST PATH because
   *  the bytes are already baked — seeds its collector from this field
   *  so the records land in that save's report, then clears it on
   *  commit. Print (forPrint) never clears: the records still belong
   *  to the next real save. */
  _pendingSaveDegradations?: SaveDegradation[]
  /** One-shot: the just-completed committing save flattened redacted page(s)
   *  under Legal Guarantee. lib/actions surfaces the post-save toast and
   *  clears it on the next state write. */
  _postSaveLegalGuaranteeApplied?: boolean
  /** One-shot: the user accepted the post-redaction "scrub identifying
   *  metadata? (highly recommended)" offer (the SECOND modal that pops after
   *  the destructive redaction strong-save confirm — see
   *  lib/actions.confirmPendingRedactionSave). When set, the metadata-wipe slot
   *  at the END of save() runs stripMetadata even if the persistent
   *  wipeMetadataOnSave checkbox is off, so the scrub rides the SAME save pass
   *  as the redaction (no second open/save). Set just before save() via
   *  withReplay so it never enters the undo history; STRIPPED on the committing
   *  state write-back so the next ordinary save does not silently re-wipe. */
  _wipeMetadataAfterRedaction?: boolean
}

function saveRequiresHistoryBarrier(state: PdfFormatState): boolean {
  const hasDeletedPage = state.pages.some((p) => p.deleted)
  const hasSecurityRewrite = state._historyBarrierOnSave === true
  const hasManualRedaction = stateHasManualRedactions(state)
  const hasEncryptionCommit = !!(
    state.encryption &&
    (state.encryption.userPassword || state.encryption.ownerPassword)
  )
  return hasDeletedPage || hasSecurityRewrite || hasManualRedaction || hasEncryptionCommit
}

function clearSaveBarrierFlag(tabId: string): void {
  withReplay(() => {
    useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => {
      const { _historyBarrierOnSave, ...rest } = prev
      void _historyBarrierOnSave
      return rest
    })
  })
}

// overlayFallbackNotice moved to saveDegradations.ts (humanizeDegradation,
// area engine.rewrite_to_overlay) — the established copy is preserved there.

function layoutAutoReflowNotice(
  editWarnings: string[],
  reportWarnings: ReflowWarning[] = [],
): string | null {
  const roles = new Set<string>()
  for (const warning of reportWarnings) {
    if (warning.role) roles.add(warning.role.replace(/_/g, ' '))
  }
  for (const warning of editWarnings) {
    const match = warning.match(/for ([^;(.]+)/i)
    if (match?.[1]) roles.add(match[1].trim())
  }
  const count = editWarnings.length + reportWarnings.length
  if (count === 0) return null
  const roleText = roles.size > 0 ? ` (${[...roles].slice(0, 4).join(', ')})` : ''
  return (
    `Auto layout was skipped for ${count} paragraph edit${count === 1 ? '' : 's'}${roleText}. ` +
    'The edits were saved as fixed text boxes so columns, tables, invoices, forms, headers, footers, and signature areas stay in place.'
  )
}

function collectLayoutEditWarnings(editsByPage: Map<number, ParagraphEdit[]>): string[] {
  const warnings: string[] = []
  for (const edits of editsByPage.values()) {
    for (const edit of edits) {
      if (edit.layoutWarning) warnings.push(edit.layoutWarning)
    }
  }
  return warnings
}

export interface HeaderFooterConfig {
  headerLeft: string; headerCenter: string; headerRight: string
  footerLeft: string; footerCenter: string; footerRight: string
  fontFamily: string; fontSize: number; color: string
  applyTo: 'all' | 'odd' | 'even'
  marginTop: number; marginBottom: number
}

function mapHasParagraphEdits(editsByPage: Map<number, ParagraphEdit[]>): boolean {
  for (const edits of editsByPage.values()) {
    if (edits.length > 0) return true
  }
  return false
}

function paragraphOverlayNeedsNotice(editsByPage: Map<number, ParagraphEdit[]>): boolean {
  for (const edits of editsByPage.values()) {
    if (edits.some((edit) => (edit as ParagraphEdit & { isNewTextBox?: boolean }).isNewTextBox !== true)) {
      return true
    }
  }
  return false
}

function collectStickyNoteSnapshots(page: PdfPageState): NativeStickyNoteSnapshot[] {
  const objects = (page.fabricJSON as { objects?: Array<Record<string, unknown>> } | null)?.objects ?? []
  const out: NativeStickyNoteSnapshot[] = []
  for (const obj of objects) {
    if (!(obj.__isStickyNote || obj.__kind === 'sticky_note')) continue
    const id = typeof obj.__id === 'string' ? obj.__id : ''
    if (!id) continue
    out.push({
      id,
      hadName: true,
      contents: typeof obj.__contents === 'string' ? obj.__contents : undefined,
      author: typeof obj.__author === 'string' ? obj.__author : undefined,
    })
  }
  return out
}

function splitParagraphEditsByBakePath(
  editsByPage: Map<number, ParagraphEdit[]>,
): {
  rewriteEdits: Map<number, ParagraphEdit[]>
  overlayEdits: Map<number, ParagraphEdit[]>
} {
  const rewriteEdits = new Map<number, ParagraphEdit[]>()
  const overlayEdits = new Map<number, ParagraphEdit[]>()
  for (const [pageIndex, edits] of editsByPage) {
    const rewrite: ParagraphEdit[] = []
    const overlay: ParagraphEdit[] = []
    for (const rawEdit of edits) {
      const edit = collapseUniformRunStyledEdit(rawEdit)
      // Per-selection styled paragraphs (runs) can't be expressed by the
      // in-place rewrite — route them to overlay even if the flag wasn't
      // set upstream.
      if ((edit as ParagraphEdit & { requiresOverlay?: boolean }).requiresOverlay === true || editCarriesRunStyling(edit)) overlay.push(edit)
      else rewrite.push(edit)
    }
    if (rewrite.length > 0) rewriteEdits.set(pageIndex, rewrite)
    if (overlay.length > 0) overlayEdits.set(pageIndex, overlay)
  }
  return { rewriteEdits, overlayEdits }
}

function collapseUniformRunStyledEdit(edit: ParagraphEdit): ParagraphEdit {
  const runs = edit.runs
  if (!runs || runs.length === 0 || paragraphHasMixedRuns(edit)) return edit
  const first = runs[0]
  const next: ParagraphEdit = {
    ...edit,
    newText: concatRuns(runs),
    bold: first.bold ?? edit.bold,
    italic: first.italic ?? edit.italic,
    underline: first.underline ?? edit.underline,
    strikethrough: first.strikethrough ?? edit.strikethrough,
    color: first.color ?? edit.color,
    fontSize: first.fontSize ?? edit.fontSize,
    requiresOverlay: true,
    styleChanged: true,
  }
  delete next.runs
  return next
}

/** Record the OCR-edit degradations (Session 7) for one overlay-baked
 *  OCR paragraph. An OCR edit is overlay BY NATURE — an image-only page
 *  has no extractable source text to rewrite in place — so the honest
 *  channel records ocr.overlay_only (info, designed) plus ocr.style_forced
 *  (fidelity, a real visual loss: the scanned glyphs' font/weight/color
 *  are unknown to OCR and are approximated). Both surface; neither is a
 *  strict true-edit pass (paragraphPaths records the bake as 'overlay').
 *  Called from every path that bakes an OCR edit (engine overlay + the
 *  legacy pd-lib fallback) so the recording can never be silently
 *  skipped. The collector dedupes, so a double-call is harmless. */
function recordOcrEditDegradations(
  collector: SaveDegradationCollector,
  edit: ParagraphEdit,
  pageIndex: number,
  engineReason?: string,
): void {
  collector.record({
    area: 'ocr.overlay_only',
    detail:
      `paragraph ${edit.paragraphId} on page ${pageIndex + 1}: OCR-recognized text saved as a ` +
      'drawn overlay (no extractable source text to rewrite in place)' +
      (engineReason ? ` - engine: ${engineReason}` : ''),
    pageIndex,
    paragraphId: edit.paragraphId,
  })
  const family = (edit.fontFamily ?? 'Helvetica').replace(/['"]/g, '').split(',')[0].trim() || 'Helvetica'
  const weight = edit.bold ? 'bold' : 'regular'
  const slant = edit.italic ? 'italic' : 'upright'
  const color = edit.color ?? '#000000'
  collector.record({
    area: 'ocr.style_forced',
    detail:
      `paragraph ${edit.paragraphId} on page ${pageIndex + 1}: drawn in ${family} ${weight} ` +
      `${slant} ${color} - the scanned glyphs' real font, weight, and color are approximated`,
    pageIndex,
    paragraphId: edit.paragraphId,
  })
}

export const pdfHandler: FormatHandler = {
  format: 'pdf',
  extensions: ['pdf'],
  displayName: 'PDF Document',
  icon: '📄',
  Viewer: PdfViewer,
  Sidebar: PdfSidebar,
  ToolbarExtras: PdfToolbar,

  load: async (tabId, bytes, _filePath) => {
    // Page count is read from the Rust side (pdfium full-load is
    // way cheaper than pdfjs because no content-stream
    // decompression). pdfHandler.load returns FAST so the user
    // sees a populated tab + sidebar immediately; the async
    // pdfjs parse for actual page rendering runs in the
    // background via the shared pdfDocCache (consumers:
    // usePdfDocument for the active page, PageThumbnail for
    // sidebar thumbs, PageRendererLight for off-screen).
    //
    // Browser-mode + non-Tauri tests fall through to pdfjs.
    let pageCount: number | undefined
    const isTauri = typeof (globalThis as unknown as { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__ !== 'undefined'
    if (isTauri && _filePath) {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const lin = await invoke<
          { page_count: number; file_length: number; end_first_page: number; first_page_object: number } | null
        >('engine_probe_linearization', { path: _filePath })
        if (lin && lin.page_count > 0) {
          pageCount = lin.page_count
        } else {
          pageCount = await invoke<number>('engine_page_count', { path: _filePath })
        }
      } catch (err) {
        console.warn('[pdfHandler.load] page-count via Rust failed; falling back to pdfjs:', err)
      }
    }
    // The Rust engine (pdfium/lopdf) may return 0 pages on a hybrid-xref
    // doc that pdfjs is lenient enough to recover. Try pdfjs before
    // refusing on a 0-page Rust result, so a document pdfjs CAN open is
    // never wrongly gated. pdfjs THROWS on the os-signed pathology (and
    // genuinely-broken files), which the gate below turns into the loud
    // refusal — never a silent empty tab.
    if (pageCount == null || pageCount === 0) {
      try {
        const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise
        pageCount = doc.numPages
        doc.destroy()
      } catch {
        // pdfjs also rejects — fall through to the gated refusal with
        // pageCount 0 (or its prior value if pdfium had returned 0).
        if (pageCount == null) pageCount = 0
      }
    }

    // Session 9 (open-reliability): a document that resolves to ZERO
    // pages cannot be displayed or edited — opening an empty tab is the
    // silent-0-page failure the 1.0 bar explicitly forbids ("opens
    // reliably… never a silent 0-page"). Fail LOUDLY with a gated reason
    // instead. When the Rust engine is available, probe whether the page
    // tree is merely UNREACHABLE (the os-signed-L2-FP2 hybrid-xref
    // pathology: the catalog references /Pages but those objects are
    // trapped in an undecodable ObjStm) versus genuinely empty, so the
    // message is specific. We NEVER attempt lenient full-scan recovery
    // here — that would resurrect superseded incremental-update revisions
    // on signed files (the redaction-leak vector Session 3 closed). The
    // refusal is the deliberate conservative choice.
    if (pageCount === 0) {
      let reason =
        'This PDF has no pages that can be displayed - it may be empty or damaged.'
      if (isTauri && _filePath) {
        try {
          const { invoke } = await import('@tauri-apps/api/core')
          const health = await invoke<{ page_tree_unreachable: boolean; parse_ok: boolean }>(
            'pdf_open_health',
            { path: _filePath },
          )
          if (health.page_tree_unreachable) {
            reason =
              'This PDF appears damaged or uses an unsupported structure: its page tree could ' +
              'not be read (the catalog references pages, but those objects are unreachable). ' +
              'Open Satchel will not try to recover it automatically - recovering a signed or ' +
              'revised file this way can expose content that was meant to be removed.'
          } else if (!health.parse_ok) {
            reason =
              'This PDF could not be parsed and cannot be safely opened - the file is likely corrupt.'
          }
        } catch {
          // Health probe unavailable (browser mode, IPC error) — keep the
          // generic reason. Still loud, still gated.
        }
      }
      throw new Error(reason)
    }

    const pages: PdfPageState[] = Array.from({ length: pageCount }, (_, i) => ({
      pageIndex: i,
      rotation: 0,
      deleted: false,
      fabricJSON: null,
      formValues: null
    }))

    try {
      const stickyImports = await extractNativeStickyNoteImports(bytes)
      if (stickyImports.length > 0) {
        for (const page of pages) {
          const incoming = stickyImports.filter((entry) => entry.pageIndex === page.pageIndex)
          if (incoming.length === 0) continue
          page.fabricJSON = {
            version: '6.4.0',
            objects: incoming.map((entry) => entry.object),
          }
          page._nativeStickyNotes = incoming.map((entry) => entry.snapshot)
        }
      }
    } catch (err) {
      console.warn('[pdfHandler.load] native sticky-note import skipped:', err)
    }

    // B4: DocMDP enforce-on-load. Run a one-shot signature check; if
    // any signature is /DocMDP-certified, capture the /P level and the
    // signer's subject so the save guard + UI banner can react. Failures
    // (malformed signature, parse errors) leave docMdpLevel undefined —
    // the document opens unrestricted, matching pre-B4 behavior.
    let docMdpLevel: 1 | 2 | 3 | undefined
    let certifiedSigner: string | undefined
    let hasSignature = false
    try {
      const sigs = await verifySignatures(bytes)
      hasSignature = sigs.length > 0
      const certified = sigs.find((s) => s.certified && s.certifyLevel)
      if (certified) {
        docMdpLevel = certified.certifyLevel
        certifiedSigner = certified.subject
      }
    } catch (err) {
      console.warn('[pdfHandler.load] DocMDP detection skipped:', err)
    }

    const state: PdfFormatState = {
      pdfBytes: bytes,
      pageCount,
      pages,
      docMdpLevel,
      certifiedSigner,
      hasSignature,
    }
    useFormatStore.getState().setFormatState(tabId, state)
  },

  save: async (tabId, opts) => {
    const tSaveStart = performance.now()
    // Print routes through this same pipeline to get WYSIWYG bytes, but it
    // hands them to an ephemeral iframe — never to disk. `commit` gates every
    // persistence side effect (at-rest encryption, state mutation, undo-history
    // clear, DocMDP refusal) so a Print can't silently commit a redaction
    // barrier, password-protect the printout, or wipe the undo stack.
    const commit = !opts?.forPrint
    const state = useFormatStore.getState().getFormatState<PdfFormatState>(tabId)
    if (!state) throw new Error('No PDF state for tab')
    // Self-clearing one-shot: the post-redaction metadata-scrub flag is read off
    // the `state` SNAPSHOT below (so the scrub still runs for THIS save), but we
    // strip it from the STORE up front so a save that THROWS after the metadata
    // slot — data-loss guard, permanence re-verify, encryption — can never leave
    // it set to silently re-wipe a later ordinary save. The committing write-back
    // also strips it (a harmless no-op once cleared here). Guarded on presence so
    // ordinary saves never pay a store write.
    if (commit && state._wipeMetadataAfterRedaction) {
      withReplay(() => useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => {
        const { _wipeMetadataAfterRedaction, ...rest } = prev as PdfFormatState
        void _wipeMetadataAfterRedaction
        return rest
      }))
    }
    const zoom = useUIStore.getState().zoom
    // Session-1 degradation channel: one append-only collector per
    // save invocation (replaces the single paragraphSaveWarning slot,
    // which dropped every fallback after the first). paragraphPaths
    // records which bake path each edit took, at honest granularity.
    const degradations = new SaveDegradationCollector()
    // Session-3 (verifier gate-2 P1): seed with degradations recorded by
    // out-of-save surfaces. SearchAndRedactDialog bakes redacted bytes
    // into state at Apply time, so the save that follows takes the
    // no-edit fast path — without this seed those records would never
    // reach any report. record() preserves the stashed severities.
    for (const d of state._pendingSaveDegradations ?? []) degradations.record(d)
    const paragraphPaths: ParagraphPathEntry[] = []
    // Session 2: real write evidence per engine batch — strict drivers
    // assert appendedBytes/newObjectsEmitted instead of trusting the
    // path label alone.
    const engineSummaries: EngineWriteSummaryEntry[] = []
    const saveSeq = (state._lastSaveReport?.saveSeq ?? 0) + 1

    // Fast-path: if nothing has actually been edited, return state.pdfBytes
    // verbatim. serializeEditsToPdf does a pdf-lib load+save round-trip that
    // mangles the xref table on PDFs that were originally ObjStm-compressed
    // (pdf-lib 1.17.1 bug — it emits xref entries pointing at offsets
    // inside other objects). For unsigned PDFs that's "only" an opaque
    // re-serialization; for SIGNED PDFs it also invalidates the signature
    // because the bytes inside the sig's ByteRange change.
    //
    // Edits that require the full pipeline:
    //   • _paragraphEdits / _textLayerEdits / _imageEdits  (per-page)
    //   • non-null fabricJSON                              (Fabric annots)
    //   • rotation ≠ 0 or deleted === true                 (page mods)
    //   • state.headerFooter set                           (header/footer)
    //   • state.encryption set                             (password / perm)
    //
    // When none of those are present, the pipeline would just re-serialize
    // the same document — losing the ObjStm compression, breaking xref
    // integrity, and invalidating any signature in the bytes. Skip it.
    const hasAnyEdit = state.pages.some((p) => {
      const paraEdits = (p as { _paragraphEdits?: unknown[] })._paragraphEdits
      const textEdits = (p as { _textLayerEdits?: unknown[] })._textLayerEdits
      const imgEdits = (p as { _imageEdits?: unknown[] })._imageEdits
      const paraMoves = (p as { _paragraphMoves?: unknown[] })._paragraphMoves
      // fabricJSON is populated with {version, objects: []} whenever the
      // Fabric canvas mounts, so a non-null value alone doesn't mean there
      // are annotations. Peek inside `objects` for real content.
      const fabricObjs = (p.fabricJSON as { objects?: unknown[] } | null)?.objects
      const hasFabric = Array.isArray(fabricObjs) && fabricObjs.length > 0
      const hasManagedNativeSticky = Array.isArray(p._nativeStickyNotes) && p._nativeStickyNotes.length > 0
      // Form fills land in pages[i].formValues per FormFieldRenderer.
      // editSerializer applies these via pdf-lib's getForm()/setText/check()
      // — but only if needsSerializerPass picks up this flag too. Without
      // counting formValues here, hasAnyEdit returns false on a pure
      // form-fill save and we short-circuit to state.pdfBytes verbatim,
      // dropping every value the user just typed [B13].
      const hasFormValues = !!(p.formValues && Object.keys(p.formValues).length > 0)
      // PageSizeDialog writes pageSize: {width, height} into the page
      // state. Without this gate, the fast-path returns the original
      // bytes verbatim and the new media_box never lands on disk.
      const hasPageSize = !!(p as { pageSize?: { width: number; height: number } }).pageSize
      return (
        (paraEdits && paraEdits.length > 0) ||
        (textEdits && textEdits.length > 0) ||
        (imgEdits && imgEdits.length > 0) ||
        (paraMoves && paraMoves.length > 0) ||
        hasFabric ||
        hasManagedNativeSticky ||
        hasFormValues ||
        hasPageSize ||
        p.rotation !== 0 ||
        p.deleted
      )
    })
    const linkedChainsForEditCheck = (state as PdfFormatState & { _linkedChains?: unknown[] })._linkedChains
    const hasDocLevelEdit = !!state.headerFooter
      || !!(state.encryption && (state.encryption.userPassword || state.encryption.ownerPassword))
      || !!(linkedChainsForEditCheck && linkedChainsForEditCheck.length > 0)
    // Page-count delta from PageManager (insert blank, duplicate). The
    // per-page hasAnyEdit misses both: handleInsertBlank pushes a page
    // with pageIndex < 0 (rotation 0, deleted false, no edit objects),
    // and handleDuplicate appends a clone with no edit flags either.
    // Without this gate, the fast-path returns state.pdfBytes verbatim
    // and the inserted/duplicated pages silently disappear at save time.
    const hasPageStructureChange = state.pages.length !== state.pageCount
      || state.pages.some((p) => p.pageIndex < 0)
    const clearHistoryAfterSave = saveRequiresHistoryBarrier(state)
    if (!hasAnyEdit && !hasDocLevelEdit && !hasPageStructureChange) {
      const tFastPath = performance.now()
      if (tFastPath - tSaveStart > 50) {
        // Fast-path itself shouldn't be slow (just a few `pages.some()`
        // calls). If we ever see this fire it means the state has
        // ballooned — log so the regression surfaces.
        console.log(`[pdfHandler.save] fast-path took ${(tFastPath - tSaveStart).toFixed(0)}ms`)
      }
      if (commit && state._historyBarrierOnSave) clearSaveBarrierFlag(tabId)
      if (commit && clearHistoryAfterSave) useHistoryStore.getState().clear()
      if (commit) {
        // The report is rewritten on EVERY committed save — including
        // this fast path — so an MCP driver never reads a previous
        // save's degradations as if they belonged to this one. The
        // one-shot notices are STRIPPED here too (verifier finding):
        // a prior save whose toast never displayed (Save-As canceled,
        // disk write failed) must not re-toast its stale notices
        // against this clean report.
        // Session-3: the fast-path report carries the SEEDED degradations
        // (dialog-baked redactions land here — see _pendingSaveDegradations),
        // which are also cleared now that they're committed to a report.
        //
        // Session tagpreserve: a clean save returns the bytes verbatim, so a
        // tagged document keeps its original /StructTreeRoot perfectly. Make
        // that preservation explicit in the report instead of silent (a
        // no-edit save on a tagged PDF must never look like it might have
        // dropped structure). Cheap uncompressed-token scan — see
        // bytesContainAscii for the object-stream caveat.
        if (bytesContainAscii(state.pdfBytes, 'StructTreeRoot')) {
          degradations.record({
            area: 'tag.structure_preserved_fully',
            detail: 'no-edit save returned the original bytes verbatim; the tagged structure tree is unchanged',
          })
        }
        const fastDegradations = degradations.list()
        const fastNotices = fastDegradations.filter(
          (d) => d.severity !== 'info' || TOAST_VISIBLE_INFO_AREAS.has(d.area),
        )
        withReplay(() => useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => {
          const { _postSaveNotices, _pendingSaveDegradations, ...rest } = prev as PdfFormatState
          void _postSaveNotices
          void _pendingSaveDegradations
          return {
            ...rest,
            ...(fastNotices.length > 0 ? { _postSaveNotices: fastNotices } : {}),
            _lastSaveReport: {
              saveSeq,
              timestamp: Date.now(),
              fastPath: true,
              degradations: fastDegradations,
              paragraphPaths: [],
            },
          }
        }))
      }
      // No edits of any kind reach here — and pending manual redaction marks
      // are Fabric objects, so `hasFabric` would have routed them to the full
      // path above. The live, in-memory bytes therefore carry no un-applied
      // redaction (nothing to "burn in") and are always decrypted, so they are
      // safe to return verbatim. (Output paths that DO see pending marks must
      // go through resolveOutputBytes — see services/pdfPrint.ts.)
      return state.pdfBytes
    }

    // B4: DocMDP enforce-on-load. The signer attached a transform that
    // declares which kinds of changes leave their signature intact.
    // We refuse to save edits that would break the signature instead
    // of silently shipping bytes a verifier will flag as tampered.
    //
    // /P 1 — No changes allowed. Anything beyond a no-op save is
    //         destructive; refuse outright.
    // /P 2 — Form fill-in + signing only. Any non-form edit refused.
    // /P 3 — Form fill-in + signing + comments. Reject paragraph /
    //         page / text-layer edits, but allow Fabric annotations
    //         (treated as comments) and form fills.
    //
    // Skipped for print: a printout never writes to disk, so it can't
    // invalidate the on-disk certified signature. Printing the current
    // (edited) view is legitimate even when saving those edits wouldn't be.
    if (commit && state.docMdpLevel) {
      const hasParaOrTextEdit = state.pages.some((p) => {
        const para = (p as { _paragraphEdits?: unknown[] })._paragraphEdits
        const text = (p as { _textLayerEdits?: unknown[] })._textLayerEdits
        const img  = (p as { _imageEdits?: unknown[] })._imageEdits
        const moves = (p as { _paragraphMoves?: unknown[] })._paragraphMoves
        return (para && para.length > 0)
            || (text && text.length > 0)
            || (img && img.length > 0)
            || (moves && moves.length > 0)
      })
      const hasPageMod = state.pages.some((p) => p.rotation !== 0 || p.deleted)
      const hasFabric = state.pages.some((p) => {
        const objs = (p.fabricJSON as { objects?: unknown[] } | null)?.objects
        return Array.isArray(objs) && objs.length > 0
      })
      const hasManualRedaction = stateHasManualRedactions(state)
      const hasHeaderFooter = !!state.headerFooter
      const hasFormFill = state.pages.some(
        (p) => p.formValues && Object.keys(p.formValues).length > 0,
      )

      const breach: string[] = []
      if (state.docMdpLevel === 1) {
        if (hasFabric || hasFormFill || hasParaOrTextEdit || hasPageMod || hasHeaderFooter || hasManualRedaction) {
          breach.push('any change forbidden under DocMDP /P=1 (No Changes Allowed)')
        }
      } else if (state.docMdpLevel === 2) {
        if (hasParaOrTextEdit) breach.push('paragraph / text edits')
        if (hasPageMod) breach.push('page rotation or deletion')
        if (hasHeaderFooter) breach.push('header/footer changes')
        // GATE 5 / G1: a redaction is a content edit (and under Legal Guarantee
        // a per-page FLATTEN) — refuse it explicitly rather than rely on the
        // incidental fact that pending marks are Fabric objects caught by
        // hasFabric. Decoupling mark storage from Fabric must not silently
        // reopen this leak: the flatten check is named.
        if (hasManualRedaction) breach.push('redactions (page flatten)')
        if (hasFabric) breach.push('annotations / drawings')
      } else if (state.docMdpLevel === 3) {
        if (hasParaOrTextEdit) breach.push('paragraph / text edits')
        if (hasPageMod) breach.push('page rotation or deletion')
        if (hasHeaderFooter) breach.push('header/footer changes')
        if (hasManualRedaction) breach.push('redactions')
        // Fabric annotations are treated as comments under /P=3 — allowed.
      }
      if (breach.length > 0) {
        const signer = state.certifiedSigner ? ` (signed by ${state.certifiedSigner})` : ''
        throw new Error(
          `This document carries a DocMDP /P=${state.docMdpLevel} certified signature${signer}. ` +
          `Saving would invalidate it. Refused: ${breach.join(', ')}. ` +
          `To proceed anyway, remove the signature first via the Sign panel.`,
        )
      }
    }

    // R6 (gauntlet): an APPROVAL signature (non-DocMDP) does NOT lock editing
    // the way a certified one does, but a content edit still INVALIDATES it —
    // the signed byte range no longer matches, so the saved file verifies as
    // modified. The redaction path records redact.signature_invalidated; a
    // plain edit used to be SILENT and shipped the now-broken /Sig dict (the
    // file "looks signed" but is cryptographically invalid). Record it so the
    // loss is loud (the core "report every degradation" rule). NOT a refusal
    // (approval sigs permit editing). Manual redactions are excluded — the
    // redaction pipeline records its own redact.signature_invalidated.
    if (commit && state.hasSignature && !state.docMdpLevel && !stateHasManualRedactions(state)) {
      const hasContentEdit = state.pages.some((p) => {
        const para = (p as { _paragraphEdits?: unknown[] })._paragraphEdits
        const text = (p as { _textLayerEdits?: unknown[] })._textLayerEdits
        const img = (p as { _imageEdits?: unknown[] })._imageEdits
        const moves = (p as { _paragraphMoves?: unknown[] })._paragraphMoves
        const fabric = (p.fabricJSON as { objects?: unknown[] } | null)?.objects
        return (!!para && para.length > 0) || (!!text && text.length > 0)
          || (!!img && img.length > 0) || (!!moves && moves.length > 0)
          || (Array.isArray(fabric) && fabric.length > 0)
          || p.rotation !== 0 || p.deleted
          || (!!p.formValues && Object.keys(p.formValues).length > 0)
      }) || !!state.headerFooter
      if (hasContentEdit) {
        degradations.record({
          area: 'signature.invalidated_by_edit',
          detail:
            'this document carried a digital signature; the edit changes the signed byte ' +
            'range, so the saved file verifies as modified/invalid in PDF viewers. Re-sign ' +
            'it after editing if a signature is required.',
          severity: 'security',
        })
      }
    }

    // A3 — Snapshot tagged-PDF metadata BEFORE the save pipeline
    // possibly invalidates /StructTreeRoot. Captured fields: doc
    // /Lang, /Title, all /Figure /Alt entries. Restored after save
    // by re-running installStructTree if the original was tagged,
    // so the saved bytes still pass veraPDF UA-1.
    let tagSnapshot: TagSnapshot | null = null
    try {
      tagSnapshot = await extractTagSnapshot(state.pdfBytes)
    } catch (err) {
      // Snapshotting is best-effort. If parsing fails (encrypted
      // doc, exotic structure), skip — saved doc just loses tags.
      console.warn('[pdfHandler.save] tag snapshot failed:', err)
      degradations.record({
        area: 'tag.snapshot_failed',
        detail: `tag snapshot failed; saved file may lose accessibility tags: ${err instanceof Error ? err.message : String(err)}`,
      })
    }

    // First pass: flush text-layer edits that EditableTextLayer accumulated
    // per-page. These need to land in pdfBytes BEFORE editSerializer runs,
    // because editSerializer handles Fabric annotations + page mods but
    // doesn't know about content-stream text edits.
    let workingBytes = state.pdfBytes
    const pdfjsDocForWhiteout = await (async () => {
      try {
        const doc = await pdfjsLib.getDocument({ data: workingBytes.slice() }).promise
        return doc
      } catch {
        return null
      }
    })()

    // Track which pages had paragraph edits so we can skip span-level
    // edits there (the whiteout already covered that region, and
    // serializeEditsToPdf's legacy internal path would otherwise
    // double-apply).
    const pagesWithParaEdits = new Set<number>()
    let usedEngineParagraphBake = false
    let usedLegacyParagraphFallback = false
    // Session 5 (gate-2 P2): the post-save preview must render the
    // ENRICHED edits (routed/carried alignment included) — previewing
    // the raw page edits would paint left-anchored text while the
    // saved bytes are centered.
    let enrichedEditsForPreview: Map<number, ParagraphEdit[]> | null = null

    try {
      // 1a0. Image-move edits (content-stream cm-matrix rewrite).
      // Run FIRST so subsequent paragraph whiteouts compute against
      // whatever bytes we emit here. Image translation doesn't
      // affect text byte offsets, but running it first matches the
      // "smallest-scope-first" ordering we use everywhere else.
      for (const page of state.pages) {
        const imgEdits = (page as any)._imageEdits as ImageEdit[] | undefined
        if (!imgEdits || imgEdits.length === 0) continue
        workingBytes = await applyImageEditsToBytes(
          workingBytes,
          page.pageIndex,
          imgEdits,
        )
      }

      // 1a. Paragraph-level edits (Acrobat-style).
      //
      // Primary path: Rust engine bake. Produces a signature-safe
      // incremental update (original bytes preserved byte-for-byte,
      // edits appended as overlay stream + superseded page dict with
      // FlateDecode compression). Handles the corpus cleanly.
      //
      // Fallback: pd-lib path via applyParagraphEditsToBytes. This
      // is what pre-engine saves used; it has known bugs
      // (fontkit `tables undefined` on some PDFs, xref corruption on
      // ObjStm-compressed sources, whole-doc re-serialize invalidates
      // signatures). We keep it as a last resort so saves never lose
      // the user's edits — better a bloated file than a blocking error.
      const paraEditsByPage = new Map<number, ParagraphEdit[]>()
      for (const page of state.pages) {
        const paraEdits = (page as any)._paragraphEdits as ParagraphEdit[] | undefined
        if (paraEdits && paraEdits.length > 0) {
          paraEditsByPage.set(page.pageIndex, paraEdits)
        }
      }

      // A2 — Cross-page paragraph drag-reorder.
      //
      // Read any captured moves (per-source-page _paragraphMoves
      // arrays) and expand each into a (source mask + dest draw)
      // edit pair. Then merge with the existing _paragraphEdits.
      // User edits on a paragraph WIN over the synthesized move
      // edit for that paragraphId — the merge step preserves them.
      //
      // The synthesized source-page mask edit has newText === ""
      // which means the S2 reflow pass below will see it as a
      // deletion and shift later same-page paragraphs up. That's
      // the right behavior — moving a paragraph away frees space
      // just like deleting it.
      const allMoves: ParagraphMove[] = []
      for (const page of state.pages) {
        const moves = (page as any)._paragraphMoves as ParagraphMove[] | undefined
        if (moves && moves.length > 0) allMoves.push(...moves)
      }
      if (allMoves.length > 0) {
        const moveEdits = expandMovesToEdits(allMoves)
        const merged = mergeMoveEditsWithExisting(paraEditsByPage, moveEdits)
        paraEditsByPage.clear()
        for (const [page, edits] of merged) paraEditsByPage.set(page, edits)
      }

      // Linked blocks — for any chain stored at the document level,
      // run the flow algorithm with the monospace measure (the engine
      // bake will substitute the active font; monospace is close
      // enough for line-break decisions for v1) and expand to per-
      // frame ParagraphEdits. Each frame's edit goes into the same
      // paragraphEdits map the bake stage consumes.
      const linkedChains = (state as PdfFormatState & { _linkedChains?: LinkedChain[] })
        ._linkedChains ?? []
      if (linkedChains.length > 0) {
        const originalTextById = new Map<string, string>()
        for (const ch of linkedChains) {
          for (const f of ch.frames) {
            originalTextById.set(f.paragraphId, '')
          }
        }
        for (const ch of linkedChains) {
          const { segments: segs, droppedText } = flowTextThroughChainWithReport(
            ch,
            monospaceMeasure,
          )
          const chainEdits = expandChainToEdits(ch, segs, originalTextById)
          for (const [page, edits] of chainEdits) {
            const cur = paraEditsByPage.get(page) ?? []
            const existingIds = new Set(cur.map((e) => e.paragraphId))
            const additions = edits.filter((e) => !existingIds.has(e.paragraphId))
            paraEditsByPage.set(page, [...cur, ...additions])
          }
          // Session 6 (epic deliverable 3): text that overflows the last
          // frame of a linked chain used to be dropped silently — the flow
          // set an `overflow` flag nobody read. Record it loudly so no
          // characters vanish without a trace. Fidelity by default
          // (unregistered in saveDegradations.ts → loud, fails strict).
          const droppedCount = droppedText.trim().length
          if (droppedCount > 0) {
            const snippet = droppedText.trim().slice(0, 40)
            degradations.record({
              area: 'linked.overflow_dropped',
              detail:
                `linked chain ${ch.id}: ${droppedCount} character(s) overflowed the ` +
                `last of ${ch.frames.length} frame(s) and are not shown in the saved ` +
                `file (starts: "${snippet}${droppedText.trim().length > 40 ? '…' : ''}"); ` +
                'add a frame or enlarge the last one to restore them',
            })
          }
        }
      }

      // Session 5 (R5a/R5b) — layout enrichment + alignment honesty.
      // Runs BEFORE reflow so attached roles/safety feed reflowSafe,
      // and BEFORE the bake split so routed edits land in the overlay
      // batch. Every text-relevant edit either carries layout metadata
      // (gesture-time, or the cluster fallback here) or records
      // layout.enrichment_unavailable; width-changing edits on
      // detected non-left paragraphs are routed to the align-aware
      // overlay when the redraw is faithful, and record
      // layout.alignment_unpreserved (fidelity) otherwise. Edits in
      // ambiguous regions are flagged. See pdfLayoutEnrichment.ts.
      if (paraEditsByPage.size > 0) {
        const enriched = await enrichAndRouteParagraphEdits({
          editsByPage: paraEditsByPage,
          clusterPage: async (idx) => {
            if (!pdfjsDocForWhiteout) return null
            try {
              return (await clusterParagraphs(pdfjsDocForWhiteout, idx)).paragraphs
            } catch {
              return null
            }
          },
          collector: degradations,
          docByteLength: workingBytes.byteLength,
        })
        paraEditsByPage.clear()
        for (const [page, edits] of enriched) paraEditsByPage.set(page, edits)
        enrichedEditsForPreview = enriched
      }

      // S2 — explicit paragraph reflow.
      //
      // Acrobat-style default: deleting paragraph text blanks that
      // fixed text box in place and growing a paragraph can overlap
      // later content. Only explicit flow edits opt into re-clustering
      // affected pages and synthesizing shift entries for followers.
      //
      // Skipped entirely when no flow edit is present, so normal text
      // deletes, replacements, and style edits stay fixed.
      const hasFlowLayout = [...paraEditsByPage.values()].some((edits) =>
        edits.some((e) => e.flowBehavior === 'flow' && e.originalText !== ''),
      )
      const preblockedLayoutWarnings = collectLayoutEditWarnings(paraEditsByPage)
      if (preblockedLayoutWarnings.length > 0) {
        const msg = layoutAutoReflowNotice(preblockedLayoutWarnings)
        if (msg) degradations.record({ area: 'layout.auto_reflow_blocked', detail: msg })
      }
      let editsForBake = paraEditsByPage
      if (hasFlowLayout) {
        try {
          const paragraphsByPage = new Map<number, ReflowParagraph[]>()
          // Per-page usable height (scale=1 viewport coords) so reflow can
          // tell when a downward shift pushes text off the page bottom —
          // the honest cross-page-overflow signal (Session 6 D2).
          const pageHeights = new Map<number, number>()
          // Cluster every page that has at least one edit AND the
          // page IMMEDIATELY after each — that's where cross-page
          // spillover lands. We don't need to cluster pages above an
          // edit because shifts only flow downward.
          const pagesToCluster = new Set<number>()
          for (const idx of paraEditsByPage.keys()) {
            pagesToCluster.add(idx)
            if (idx + 1 < state.pageCount) pagesToCluster.add(idx + 1)
          }
          if (pdfjsDocForWhiteout) {
            for (const idx of [...pagesToCluster].sort((a, b) => a - b)) {
              const { paragraphs, pageHeight } = await clusterParagraphs(
                pdfjsDocForWhiteout,
                idx,
              )
              pageHeights.set(idx, pageHeight)
              paragraphsByPage.set(
                idx,
                paragraphs.map((p) => ({
                  paragraphId: p.id,
                  bbox: { ...p.bbox },
                  originalText: p.originalText,
                  fontSize: p.fontSize,
                  fontFamily: p.fontFamily,
                  bold: p.bold,
                  italic: p.italic,
                  color: p.color,
                  backgroundColor: p.backgroundColor,
                  layoutRole: p.layout?.role,
                  layoutSafeForAutoReflow: p.layout?.safeForAutoReflow,
                  layoutFlowId: p.layout?.flowId,
                  layoutReasons: p.layout?.reasons,
                })),
              )
            }
            // Session 5: redaction mark zones are FIXED obstacles —
            // reflow must never sweep text through (or over) a region
            // the user marked for destruction. Injected as synthetic
            // unsafe paragraphs; reflowFlowId() makes anything with
            // layoutSafeForAutoReflow:false an obstacle for every flow.
            for (const r of collectRedactionObstacleRects(state.pages, zoom)) {
              const list = paragraphsByPage.get(r.pageIndex)
              if (!list) continue
              list.push({
                paragraphId: `__redaction_zone_${r.pageIndex}_${Math.round(r.x)}_${Math.round(r.y)}`,
                bbox: { x: r.x, y: r.y, width: r.width, height: r.height },
                originalText: '',
                fontSize: 12,
                layoutSafeForAutoReflow: false,
                layoutReasons: ['a marked redaction zone'],
              })
            }
            const reflow = computeReflowDeltasWithReport(
              paragraphsByPage,
              paraEditsByPage,
              { pageHeights },
            )
            editsForBake = reflow.editsByPage
            // Split by kind: blocked edits are the info-level "saved as
            // fixed boxes" notice; cross_page warnings are a real fidelity
            // loss (text pushed off-page, no multi-page flow) and must NOT
            // route through layoutAutoReflowNotice — its copy says "auto
            // layout was skipped / saved as fixed boxes", which is the
            // opposite of what happened (the text DID flow, off the page).
            const blockedWarnings = reflow.warnings.filter((w) => w.kind !== 'cross_page')
            const crossPageWarnings = reflow.warnings.filter((w) => w.kind === 'cross_page')
            if (blockedWarnings.length > 0) {
              const msg = layoutAutoReflowNotice([], blockedWarnings)
              if (msg) degradations.record({ area: 'layout.auto_reflow_blocked', detail: msg })
            }
            for (const w of crossPageWarnings) {
              degradations.record({
                area: 'layout.cross_page_overflow',
                detail: w.reason,
                pageIndex: w.pageIndex,
                paragraphId: w.paragraphId,
              })
            }
          } else {
            // pdfjs failed to open the document at the top of the save
            // — flow edits silently lose their reflow without this
            // record (preflight-audit find: the `if` had no else).
            degradations.record({
              area: 'reflow.skipped',
              detail: 'page analysis unavailable (pdfjs document failed to open); flow edits saved as fixed boxes',
            })
          }
        } catch (err) {
          // Reflow is best-effort. If clustering fails (heavy PDF,
          // unusual structure, OOM), fall back to the unenriched
          // edits — user gets the old "delete leaves a hole" behavior
          // for this save instead of a failed save. Never silent.
          console.warn('[pdfHandler.save] S2 reflow skipped:', err)
          degradations.record({
            area: 'reflow.skipped',
            detail: `page analysis failed: ${err instanceof Error ? err.message : String(err)}`,
          })
        }
      }

      const editsForSave = clipParagraphEditsForFixedBoxes(editsForBake, degradations)
      const { rewriteEdits, overlayEdits } = splitParagraphEditsByBakePath(editsForSave)

      const applyParagraphFallback = async (
        batch: Map<number, ParagraphEdit[]>,
        reason: string,
        opts: {
          /** engine.run_styled_overlay = the DESIGNED rich-text path
           *  (info, no toast — matches today's UX); default is the
           *  engine-unavailable legacy fallback (fidelity, toast). */
          area?: 'engine.legacy_pdflib' | 'engine.run_styled_overlay'
          /** Pure new-text-box batches degrade to info: overlay is the
           *  only representation a NEW box has. Still recorded. */
          severityOverride?: 'info'
        } = {},
      ) => {
        // Engine unavailable or errored — use pd-lib path. ALWAYS
        // recorded (the old code suppressed the notice for run-styled
        // edits and new text boxes with zero signal anywhere).
        usedLegacyParagraphFallback = true
        const area = opts.area ?? 'engine.legacy_pdflib'
        degradations.record({
          area,
          detail: reason,
          ...(opts.severityOverride ? { severity: opts.severityOverride } : {}),
        })

        // Session 3: destructive strip pre-pass — G9 parity with the
        // engine overlay path (pdfEngineBake.ts). The pd-lib overlay
        // MASKS the original text visually; without stripping first the
        // bytes survive under the whiteout and stay extractable. Per-
        // REGION accounting: a region that expected removal but stripped
        // nothing records the security area (strict-failing), exactly
        // like the engine path's recordSilentNoOpStrips.
        try {
          const stripBboxes: Array<{
            page_index: number
            x: number; y: number; width: number; height: number
            coord_space: 'css'
          }> = []
          const stripBboxMeta: Array<{
            pageIndex: number
            paragraphId: string
            expectsRemoval: boolean
          }> = []
          for (const [pageIndex, paraEdits] of batch) {
            for (const e of paraEdits) {
              if (e.skipSourceMask) continue
              const maskBbox = e.maskBbox ?? e.bbox
              if (!maskBbox) continue
              stripBboxMeta.push({
                pageIndex,
                paragraphId: e.paragraphId,
                expectsRemoval: (e.originalText ?? '').trim() !== '',
              })
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
          if (stripBboxes.length > 0) {
            const { invoke } = await import('@tauri-apps/api/core')
            const outcome = await invoke<{
              bytes: number[] | Uint8Array
              removed_per_bbox?: number[]
            }>('pdf_strip_text_in_bboxes', {
              bytes: Array.from(workingBytes),
              bboxes: stripBboxes,
            })
            workingBytes =
              outcome.bytes instanceof Uint8Array ? outcome.bytes : new Uint8Array(outcome.bytes)
            const removedPerBbox = Array.isArray(outcome.removed_per_bbox)
              ? outcome.removed_per_bbox
              : []
            stripBboxMeta.forEach((meta, i) => {
              if (!meta.expectsRemoval) return
              if ((removedPerBbox[i] ?? 0) === 0) {
                degradations.record({
                  area: 'strip.skipped_text_recoverable',
                  detail:
                    `legacy-path destructive strip removed ZERO text objects for paragraph ` +
                    `${meta.paragraphId} on page ${meta.pageIndex}; its original text remains ` +
                    'recoverable under the overlay',
                  pageIndex: meta.pageIndex,
                  paragraphId: meta.paragraphId,
                })
              }
            })
            console.log(
              `[pdfHandler.save] legacy-path destructive strip: ${stripBboxes.length} bbox(es) stripped before pd-lib overlay`,
            )
          }
        } catch (stripErr) {
          console.warn(
            '[pdfHandler.save] legacy-path strip pre-pass failed; overlay will leak original text:',
            stripErr,
          )
          degradations.record({
            area: 'strip.skipped_text_recoverable',
            detail:
              'legacy-path destructive strip pre-pass failed; the overlay masks the original ' +
              `text visually but the bytes remain extractable: ${stripErr instanceof Error ? stripErr.message : String(stripErr)}`,
          })
        }

        const fallback = (useUIStore.getState() as any).fallbackFontFamily as string | undefined
        for (const [pageIndex, paraEdits] of batch) {
          const baseOpts = {
            fallbackFont: (fallback as any) || 'Helvetica',
            // Pass the pdfjs doc we opened above so applyParagraphEditsToBytes
            // can blank CMap-encoded runs via whiteout fallback inside
            // applyTextEditsToBytes. Without this, CMap fonts would leave
            // ghost text in the content stream.
            pdfjsDoc: pdfjsDocForWhiteout,
            collector: degradations,
          }
          try {
            workingBytes = await applyParagraphEditsToBytes(workingBytes, pageIndex, paraEdits, baseOpts)
          } catch (err) {
            // pd-lib's fontkit can throw "Cannot read properties of undefined
            // (reading 'tables')" embedding/serializing certain system fonts.
            // Retry with Standard-14 substitution so the save succeeds rather
            // than aborting and stranding the user's edits.
            console.warn(
              '[pdfHandler.save] paragraph overlay font embed failed; retrying with Standard-14 fonts:',
              err,
            )
            workingBytes = await applyParagraphEditsToBytes(workingBytes, pageIndex, paraEdits, {
              ...baseOpts,
              forceStandardFonts: true,
            })
            degradations.record({
              area: 'font.standard14_retry',
              detail: `font embed crashed on page ${pageIndex}; retried with Standard-14 fonts: ${err instanceof Error ? err.message : String(err)}`,
              pageIndex,
            })
          }
          pagesWithParaEdits.add(pageIndex)
          for (const e of paraEdits) {
            paragraphPaths.push({
              paragraphId: e.paragraphId,
              pageIndex,
              path: 'legacy_pdflib',
              granularity: 'page',
              failureReason: reason,
            })
            // Session 7 — OCR edits reaching the legacy pd-lib overlay
            // are still overlay-by-nature; record their honest
            // degradations here too so the channel is never silent on
            // this path either.
            if (isOcrParagraphId(e.paragraphId)) {
              recordOcrEditDegradations(degradations, e, pageIndex, reason)
            }
          }
        }
      }

      const bakeParagraphBatch = async (
        batch: Map<number, ParagraphEdit[]>,
        fallbackReason: string,
      ) => {
        if (!mapHasParagraphEdits(batch)) return
        // True when at least one edit is NOT a new text box. Pure
        // new-text-box batches record at info severity — overlay is
        // the only representation a new box has (nothing to rewrite)
        // — but they still RECORD; the old code's notice suppression
        // left zero signal anywhere.
        const editsExistingText = paragraphOverlayNeedsNotice(batch)
        const engineBaked = await bakeParagraphEditsViaEngine(workingBytes, batch, {
          forceOverlay: fallbackReason.includes('styled paragraph edits'),
          collector: degradations,
          // §3: embed installed office-suite fonts (Arial/Calibri/…) on
          // an exact match when the user has opted in (default off).
          embedInstalledFonts: useUIStore.getState().embedInstalledFonts,
        })
        if (engineBaked) {
          usedEngineParagraphBake = true
          workingBytes = engineBaked.bytes
          for (const pageIndex of batch.keys()) {
            pagesWithParaEdits.add(pageIndex)
          }
          if (engineBaked.path === 'overlay') {
            // OCR edits are overlay BY NATURE and record ocr.* per-edit
            // below — NOT the misleading "rewrite fell back" area. Only
            // the NON-OCR edits in this batch get the engine.* record;
            // an all-OCR batch suppresses it entirely (Session 7). A
            // page is normally either all-body or all-OCR, so the mixed
            // case is defensive.
            const nonOcr = [...batch.values()].flat().filter((e) => !isOcrParagraphId(e.paragraphId))
            if (nonOcr.length > 0) {
              const nonOcrExistingText = nonOcr.some(
                (e) => (e as ParagraphEdit & { isNewTextBox?: boolean }).isNewTextBox !== true,
              )
              degradations.record({
                area: nonOcrExistingText ? 'engine.rewrite_to_overlay' : 'engine.new_textbox_overlay',
                detail:
                  engineBaked.rewriteFailureReason ??
                  (nonOcrExistingText
                    ? 'engine overlay used instead of in-stream rewrite'
                    : 'new text boxes drawn as overlay content'),
              })
            }
          }
          for (const [pageIndex, edits] of batch) {
            for (const e of edits) {
              paragraphPaths.push({
                paragraphId: e.paragraphId,
                pageIndex,
                path: engineBaked.path,
                granularity: 'batch',
                ...(engineBaked.rewriteFailureReason
                  ? { failureReason: engineBaked.rewriteFailureReason }
                  : {}),
              })
              // Session 7 — OCR edits are overlay by nature; record their
              // honest degradations (ocr.overlay_only + ocr.style_forced)
              // wherever the engine bakes them.
              if (isOcrParagraphId(e.paragraphId)) {
                recordOcrEditDegradations(degradations, e, pageIndex, engineBaked.rewriteFailureReason)
              }
              // Session 3, deletion ≠ redaction: BOTH engine paths save
              // as incremental updates — text deleted from the current
              // revision still exists in the dead prior revision's bytes
              // inside the same file. Designed behavior, recorded so the
              // channel never implies a delete was a redaction.
              if ((e.originalText ?? '').trim() && !(e.newText ?? '').trim()) {
                degradations.record({
                  area: 'delete.recoverable_prior_revision',
                  detail:
                    `paragraph ${e.paragraphId} on page ${pageIndex + 1}: deleted text was ` +
                    'removed from the current revision, but the incremental save keeps the ' +
                    'prior revision in the file - use Redact to remove it permanently',
                  pageIndex,
                  paragraphId: e.paragraphId,
                })
              }
            }
          }
          console.log(
            `[pdfHandler.save] engine ${engineBaked.path}: +${engineBaked.summary.appendedBytes} bytes,`,
            `${engineBaked.summary.newObjectsEmitted} new objects`,
          )
          engineSummaries.push({
            path: engineBaked.path,
            route: engineBaked.route,
            totalBytes: engineBaked.summary.totalBytes,
            appendedBytes: engineBaked.summary.appendedBytes,
            newXrefOffset: engineBaked.summary.newXrefOffset,
            previousXrefOffset: engineBaked.summary.previousXrefOffset,
            newObjectsEmitted: engineBaked.summary.newObjectsEmitted,
          })
        } else {
          await applyParagraphFallback(batch, fallbackReason, {
            severityOverride: editsExistingText ? undefined : 'info',
          })
        }
      }

      // Mixed-run (per-selection styled) paragraphs render via the run-aware
      // pd-lib overlay (applyParagraphEditsToBytes), which honours `runs`.
      // The Rust engine bake doesn't yet emit per-run Tf / fill color, so
      // routing these through the engine would flatten the styling. Keep
      // them on the TS path; engine per-run emission is a future optimization.
      const runStyledEdits = new Map<number, ParagraphEdit[]>()
      const plainOverlayEdits = new Map<number, ParagraphEdit[]>()
      for (const [pageIndex, paraEdits] of overlayEdits) {
        const styled = paraEdits.filter((e) => editCarriesRunStyling(e))
        const plain = paraEdits.filter((e) => !editCarriesRunStyling(e))
        if (styled.length > 0) runStyledEdits.set(pageIndex, styled)
        if (plain.length > 0) plainOverlayEdits.set(pageIndex, plain)
      }

      await bakeParagraphBatch(
        rewriteEdits,
        'Rust true text rewrite and engine overlay were unavailable; used the legacy paragraph overlay path.',
      )
      await bakeParagraphBatch(
        plainOverlayEdits,
        'Rust engine overlay was unavailable for styled paragraph edits; used the legacy paragraph overlay path.',
      )
      if (mapHasParagraphEdits(runStyledEdits)) {
        await applyParagraphFallback(
          runStyledEdits,
          'per-selection styled text rendered via the rich-text overlay path',
          { area: 'engine.run_styled_overlay' },
        )
      }

      // 1b. Span-level text edits (legacy fallback path). Skip pages
      // where paragraph edits already ran — those cover the same region.
      for (const page of state.pages) {
        if (pagesWithParaEdits.has(page.pageIndex)) continue
        const edits = (page as any)._textLayerEdits as TextLayerEdit[] | undefined
        if (!edits || edits.length === 0) continue
        workingBytes = await applyTextEditsToBytes(
          workingBytes,
          page.pageIndex,
          edits,
          pdfjsDocForWhiteout,
          degradations,
        )
      }
    } finally {
      if (pdfjsDocForWhiteout) await pdfjsDocForWhiteout.destroy()
    }

    // Clear _textLayerEdits on pages we handled via paragraph edits so
    // serializeEditsToPdf's internal legacy path doesn't re-apply them.
    // (This mutates the `pages` array we pass down, not state; state
    // clearing happens below after the save completes.)
    const pagesForSerializerBase = state.pages.map((p) => {
      if (!pagesWithParaEdits.has(p.pageIndex)) return p
      const { _textLayerEdits, ...rest } = p as any
      void _textLayerEdits
      return rest
    })
    const manualRedactions = await collectManualRedactionsForSave(
      workingBytes,
      pagesForSerializerBase,
      zoom,
    )
    const pagesForSerializer = manualRedactions.pages

    // A hand-drawn opaque black box that fails the redaction-bar
    // heuristic saves as a SHAPE — it hides content without removing
    // it. Tell the user so they don't ship a fake redaction.
    for (const page of pagesForSerializerBase) {
      if (page.deleted) continue
      for (const obj of findUnclassifiedOpaqueRects(page.fabricJSON)) {
        const w = Math.round(Math.abs(Number(obj.width ?? 0) * Number(obj.scaleX ?? 1)))
        const h = Math.round(Math.abs(Number(obj.height ?? 0) * Number(obj.scaleY ?? 1)))
        degradations.record({
          area: 'redact.unclassified_opaque_rect',
          detail:
            `page ${page.pageIndex + 1}: an opaque black ${w}×${h} px rectangle was saved as a ` +
            'drawn shape, not a redaction - content underneath remains in the file',
          pageIndex: page.pageIndex,
        })
      }
    }

    // Second pass: Fabric objects, page rotations/deletions, header/footer.
    // Skip entirely when nothing in this pass applies — otherwise
    // pd-lib re-serializes the whole doc through its parser, which:
    //   (a) loses the engine bake's incremental-update shape (our
    //       1.5 MB original + 500-byte increment becomes a 7 KB
    //       pd-lib re-write), and
    //   (b) hits fontkit's `tables undefined` bug on real PDFs.
    //
    // Needs-second-pass detection must match what serializeEditsToPdf
    // actually touches: Fabric annots, page rotations, page deletions,
    // header/footer rendering. Paragraph + text + image edits already
    // ran in the first pass and don't need anything here.
    const needsSerializerPass =
      !!state.headerFooter ||
      hasPageStructureChange ||
      pagesForSerializer.some((p) => {
        const fabricObjs = (p.fabricJSON as { objects?: unknown[] } | null)?.objects
        const hasFabric = Array.isArray(fabricObjs) && fabricObjs.length > 0
        const hasManagedNativeSticky = Array.isArray(p._nativeStickyNotes) && p._nativeStickyNotes.length > 0
        // editSerializer.ts:289-328 is where form-fill values get baked
        // into the PDF via pd-lib getForm()/setText/check/select. Skip
        // the pass and those calls never run, so the saved bytes have
        // no /V entries even though the user filled every field [B13].
        const hasFormValues = !!(p.formValues && Object.keys(p.formValues).length > 0)
        // editSerializer.ts:167-169 picks up p.pageSize and calls
        // pdfPage.setSize. Without this gate, PageSizeDialog's apply
        // mutates state but the bytes go through the no-op fast-path
        // and the new media_box never lands on disk.
        const hasPageSize = !!(p as { pageSize?: { width: number; height: number } }).pageSize
        return hasFabric || hasManagedNativeSticky || hasFormValues || hasPageSize || p.rotation !== 0 || p.deleted
      })

    let outArray: Uint8Array
    if (needsSerializerPass) {
      const outBytes = await serializeEditsToPdf(workingBytes, pagesForSerializer, zoom, {
        headerFooter: state.headerFooter,
        collector: degradations,
      })
      outArray = outBytes instanceof Uint8Array ? outBytes : new Uint8Array(outBytes)
    } else {
      outArray =
        workingBytes instanceof Uint8Array ? workingBytes : new Uint8Array(workingBytes)
    }

    // Legal Guarantee: every page carrying a mark is flattened to a secured
    // image BY CONSTRUCTION (not just image-overlap pages). Read live at save
    // time. Applies whether or not this is a committing save — a print of an
    // LG document also flattens — but only a COMMIT trips the post-save
    // re-enable-autosave toast + history barrier below.
    const legalGuaranteeOn = useUIStore.getState().legalGuaranteeRedaction
    let legalGuaranteeFlattened = false
    let redactionNeedles: RedactionNeedle[] | null = null
    if (manualRedactions.rects.length > 0) {
      // Gate-2 P2: redaction rects are collected in the page coordinates
      // the user drew on, but a pending in-session rotation is applied by
      // the serializer pass BEFORE the redaction burns — the box would
      // land on rotated content at the wrong position and remove the
      // WRONG text while the marked text ships. Refuse the combination;
      // each operation is safe on its own, sequenced across two saves.
      const rotatedPendingPages = new Set(
        state.pages.filter((p) => !p.deleted && p.rotation !== 0).map((p) => p.pageIndex),
      )
      const rotationConflict = manualRedactions.rects.find((r) => rotatedPendingPages.has(r.page))
      if (rotationConflict !== undefined) {
        throw new Error(
          `Save refused: page ${rotationConflict.page + 1} has both a pending rotation and ` +
            'redaction marks in the same save - the redaction would be burned at the wrong ' +
            'position. Save the rotation first, then mark and save the redaction.',
        )
      }
      // Verified redaction (Session 3): applyRedactions THROWS when the
      // post-transform permanence check finds surviving content — a
      // refused save keeps the on-disk file untouched.
      const redactionResult = await applyRedactions(outArray, manualRedactions.rects, degradations, {
        forceRaster: legalGuaranteeOn,
      })
      outArray = redactionResult.bytes
      redactionNeedles = redactionResult.needles
      legalGuaranteeFlattened = legalGuaranteeOn
    }

    // A3 / session tagpreserve — restore tagged-PDF structure if the
    // original was tagged. No-op when tagSnapshot.wasTagged is false.
    //
    // Three outcomes, decided by what the edit actually touched:
    //   Phase A (passthrough) — NO tagged-page content was rewritten and
    //     no pages were added/removed (e.g. an encryption-only or
    //     form-fill-only save): the original /StructTreeRoot still travels
    //     intact through serializeEditsToPdf's pd-lib round-trip, so keep
    //     outArray VERBATIM (best fidelity) and skip the rebuild. A census
    //     guard confirms the tree really survived before we claim it.
    //   Phase B (type preservation) — a content edit rewrote part of the
    //     doc but pages were not added/removed: rebuild, re-asserting the
    //     ORIGINAL semantic hierarchy (H/L/Table/Figure/Link/Form types +
    //     nesting) from the captured structSpec instead of flattening.
    //   Fallback (flatten) — page-set changed, no captured spec, or a
    //     preserve rebuild threw: the legacy /P-per-page rebuild.
    if (tagSnapshot && tagSnapshot.wasTagged) {
      // Did any edit rewrite a tagged page's content stream (or change a
      // page's identity)? Encryption + form-fills + sticky-note annotations
      // are EXCLUDED — they don't touch the marked content the struct tree
      // depends on, so the original tree stays valid.
      const taggedPageContentRewritten = state.pages.some((p) => {
        const para = (p as { _paragraphEdits?: unknown[] })._paragraphEdits
        const text = (p as { _textLayerEdits?: unknown[] })._textLayerEdits
        const img = (p as { _imageEdits?: unknown[] })._imageEdits
        const moves = (p as { _paragraphMoves?: unknown[] })._paragraphMoves
        const fabric = (p.fabricJSON as { objects?: unknown[] } | null)?.objects
        const pageSize = (p as { pageSize?: unknown }).pageSize
        return (Array.isArray(para) && para.length > 0)
          || (Array.isArray(text) && text.length > 0)
          || (Array.isArray(img) && img.length > 0)
          || (Array.isArray(moves) && moves.length > 0)
          || (Array.isArray(fabric) && fabric.length > 0)
          || !!pageSize
          || p.rotation !== 0
          || p.deleted
      })
        || !!state.headerFooter
        || manualRedactions.rects.length > 0
        || !!(linkedChainsForEditCheck && linkedChainsForEditCheck.length > 0)
      // Page deletes/inserts/reorders break the captured spec's /Pg → page
      // mapping, so preserve mode is unsafe; fall back to the flat rebuild.
      const pageSetChanged = hasPageStructureChange || state.pages.some((p) => p.deleted)

      let handled = false

      // ── Phase A — passthrough ────────────────────────────────────────
      if (!taggedPageContentRewritten && !pageSetChanged) {
        try {
          const after = await extractRoleCensus(outArray)
          const lost = computeFlattenedRoles(tagSnapshot.roleCounts, after)
          if (lost.length === 0) {
            degradations.record({
              area: 'tag.structure_preserved_fully',
              detail:
                'no tagged-page content was rewritten; the original structure tree was kept ' +
                'intact through the save',
            })
            handled = true
          }
          // If the tree unexpectedly degraded in the pipeline (lost>0), fall
          // through to the rebuild so the saved file is still tagged.
        } catch {
          // Census re-parse best-effort; on failure rebuild defensively.
        }
      }

      // ── Phase B / fallback — rebuild ─────────────────────────────────
      if (!handled) {
        const preserveStructure =
          !pageSetChanged && !!tagSnapshot.structSpec && tagSnapshot.structSpec.length > 0
        const preRestoreBytes = outArray
        let restoreKept = false
        let preserveApplied = false

        // The tag snapshot was taken BEFORE redaction ran — restoring it can
        // resurrect redacted text through /Alt, /ActualText, or structure
        // strings. Re-verify after every successful rebuild; on any survival
        // keep the redacted (un-restored) bytes.
        const reverifyRedaction = async (restoredBytes: Uint8Array): Promise<boolean> => {
          if (!redactionNeedles) return true
          const verdict = await verifyRedactionPermanence(
            restoredBytes,
            redactionNeedles,
            manualRedactions.rects,
            degradations,
          )
          if (verdict.failures.length > 0) {
            degradations.record({
              area: 'tag.restore_skipped_redaction',
              detail:
                'tagged-PDF structure was not restored after redaction: the restored ' +
                `structure would resurrect redacted content (${verdict.failures[0]})`,
            })
            return false
          }
          return true
        }

        try {
          outArray = await restoreTagsAfterSave(outArray, tagSnapshot, state.pageCount, { preserveStructure })
          if (await reverifyRedaction(outArray)) {
            restoreKept = true
            preserveApplied = preserveStructure
          } else {
            outArray = preRestoreBytes
          }
        } catch (err) {
          console.warn(`[pdfHandler.save] tag restore (preserve=${preserveStructure}) failed:`, err)
          // A preserve rebuild that threw retries with the flat rebuild
          // before giving up — never lose tags over the richer attempt.
          if (preserveStructure) {
            degradations.record({
              area: 'tag.structure_preservation_failed',
              detail: `type-preserving rebuild failed; fell back to flat rebuild: ${err instanceof Error ? err.message : String(err)}`,
            })
            try {
              outArray = await restoreTagsAfterSave(preRestoreBytes, tagSnapshot, state.pageCount, { preserveStructure: false })
              if (await reverifyRedaction(outArray)) restoreKept = true
              else outArray = preRestoreBytes
            } catch (err2) {
              outArray = preRestoreBytes
              degradations.record({
                area: 'tag.restore_failed',
                detail: `tag restore failed; saved file may lose accessibility tags: ${err2 instanceof Error ? err2.message : String(err2)}`,
              })
            }
          } else {
            outArray = preRestoreBytes
            degradations.record({
              area: 'tag.restore_failed',
              detail: `tag restore failed; saved file may lose accessibility tags: ${err instanceof Error ? err.message : String(err)}`,
            })
          }
        }

        // Census-based outcome record. Only when the rebuild was KEPT — a
        // restore that threw (tag.restore_failed) or was reverted for
        // redaction (tag.restore_skipped_redaction) already recorded above
        // and ships the un-restored bytes. Best-effort: the re-parse never
        // blocks a save.
        if (restoreKept && tagSnapshot.roleCounts) {
          try {
            const after = await extractRoleCensus(outArray)
            const { preserved, flattened } = summarizeStructureOutcome(tagSnapshot.roleCounts, after)
            if (flattened.length === 0) {
              degradations.record({
                area: preserveApplied ? 'tag.structure_preserved_types' : 'tag.structure_preserved_fully',
                detail: preserveApplied
                  ? `semantic structure re-asserted on the edited document: ${preserved.join(', ') || 'roles'} preserved`
                  : 'original structure kept through the save',
              })
            } else {
              if (preserveApplied && preserved.length > 0) {
                degradations.record({
                  area: 'tag.structure_preserved_types',
                  detail: `preserved: ${preserved.join(', ')}; flattened: ${describeFlattenedRoles(flattened)}`,
                })
              }
              degradations.record({
                area: 'tag.structure_flattened',
                detail:
                  `tagged structure rebuilt as generic paragraphs on save: ${describeFlattenedRoles(flattened)} ` +
                  'collapsed to /P (edits that touch a semantic element still collapse it; full ' +
                  'per-element MCID rewrite deferred - see KNOWN-LIMITATIONS §8a)',
              })
            }
          } catch {
            // Census re-parse is best-effort instrumentation, not the save
            // itself; a parse hiccup must never fail an otherwise-good save.
          }
        }
      }
    }

    // Optional metadata wipe (the checkbox beside the redaction tools). Runs as the
    // LAST content transform before encryption — AFTER tag-restore, because the
    // tag/struct rebuild (installStructTree) fills in DEFAULT Creator/Producer
    // ("Open Satchel") + a fresh date + a new XMP when the metadata is empty, so a
    // wipe placed before it would be re-stamped. Running last guarantees the saved
    // (then encrypted) file ships with no identifying /Info or XMP metadata. For a
    // tagged doc this also drops the accessibility XMP — an accepted tradeoff of an
    // explicit "wipe metadata" request (recorded). Best-effort: a failure records
    // loud (metadata.wipe_failed) but never aborts the save.
    // Two independent triggers reach this single scrub:
    //   • wipeMetadataOnSave — the persistent checkbox beside the redaction
    //     tools: wipe on EVERY committing save.
    //   • _wipeMetadataAfterRedaction — the one-shot per-save choice from the
    //     SECOND modal that pops after the destructive redaction strong-save
    //     ("scrub identifying metadata? highly recommended"). Set on the format
    //     state just before this save; carried into this SAME pass so the scrub
    //     rides the redaction save (no second open/save) and recorded with the
    //     redaction-specific success area so the toast says so.
    const scrubAfterRedaction = !!state._wipeMetadataAfterRedaction
    if (commit && (useUIStore.getState().wipeMetadataOnSave || scrubAfterRedaction)) {
      try {
        const { stripMetadata } = await import('../../services/pdfOps')
        outArray = await stripMetadata(outArray)
        degradations.record({
          area: scrubAfterRedaction ? 'metadata.scrubbed_after_redaction' : 'metadata.wiped',
          detail:
            (scrubAfterRedaction
              ? 'document metadata (/Info dict + XMP packet) scrubbed alongside the redaction at the user request'
              : 'document metadata (/Info dict + XMP packet) wiped on save at the user request') +
            (tagSnapshot && tagSnapshot.wasTagged ? ' (incl. the tagged-PDF accessibility XMP)' : ''),
        })
      } catch (err) {
        degradations.record({
          area: 'metadata.wipe_failed',
          detail:
            'metadata wipe was requested but failed; identifying metadata may remain ' +
            `in the saved file: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
    }

    // Data-loss guard. pd-lib's re-serialization has a known bug on
    // some PDFs (ObjStm-compressed xref, certain embedded-font setups):
    // it can produce an output that's <5 % of the source size, dropping
    // embedded fonts + compressed objects. In past sessions this wrote
    // tiny corrupted files over user originals during autosave. If the
    // output is drastically smaller than the in-memory source, abort
    // the save and surface the error — better to keep edits pending
    // than silently destroy the on-disk file.
    //
    // Threshold: 50 % of source size. Legitimate saves produce output
    // at least as large as the source (engine bake adds bytes;
    // serializeEditsToPdf usually holds roughly steady or grows with
    // annots). A drop below 50 % is a pd-lib failure mode, not a
    // legitimate result.
    const sourceSize = state.pdfBytes.byteLength
    // The data-loss guard catches the pd-lib failure mode where a
    // multi-megabyte ObjStm-compressed source is re-serialized down
    // to a few KB with embedded fonts dropped. Only meaningful for
    // sources of substantial size — small PDFs (under 8 KB) routinely
    // grow OR shrink on a clean save and a 50 % delta has no
    // signal-to-noise. Bump the floor to 8 KB so PageSize / Crop /
    // Bates / etc. on tiny invoice fixtures aren't false-positive
    // aborted.
    //
    // Manual redactions are also exempt: the true-redaction path
    // intentionally rewrites affected pages and may rasterize image-like
    // redactions, so output size is not a reliable corruption signal for
    // that security operation.
    const isManualRedactionRewrite = manualRedactions.rects.length > 0
    const isEngineOnlyParagraphBake =
      usedEngineParagraphBake &&
      !usedLegacyParagraphFallback &&
      !needsSerializerPass
    if (
      !isManualRedactionRewrite &&
      !isEngineOnlyParagraphBake &&
      outArray.byteLength < sourceSize / 2 &&
      sourceSize > 8192
    ) {
      const msg =
        `pdf save produced suspiciously small output ` +
        `(${outArray.byteLength} B vs ${sourceSize} B source). ` +
        `This is a known pd-lib re-serialization bug on some PDFs. ` +
        `Aborting to prevent corrupting the on-disk file; your edits ` +
        `remain in memory. Try: (a) Save As to a NEW filename, ` +
        `(b) convert via File → Reduce Size first, or ` +
        `(c) if autosave fired, disable autosave until the source is rewritten.`
      console.error('[pdfHandler.save]', msg)
      throw new Error(msg)
    }

    // Final pass: AES-256 password + permission encryption. Runs last
    // so all edit byte-patches happen against cleartext bytes. Skipped
    // when the user hasn't set a password AND no permission flags are
    // active; permissions-only encryption still routes through here so
    // owner-only restrictions are enforced.
    //
    // Skipped for print: the user already supplied the password to open the
    // doc; the printout must render directly, not pop a password prompt in
    // the print iframe's PDF viewer.
    if (commit && state.encryption && (state.encryption.userPassword || state.encryption.ownerPassword)) {
      // Final cleartext permanence re-check (Session 3): encryption is
      // the last transform, and after it the needles are ciphertext —
      // this is the LAST point where redacted-content survival is
      // detectable. Guards any pipeline stage inserted between the
      // redaction and the encryption.
      if (redactionNeedles) {
        const finalVerdict = await verifyRedactionPermanence(
          outArray,
          redactionNeedles,
          manualRedactions.rects,
          degradations,
        )
        if (finalVerdict.failures.length > 0) {
          throw new Error(
            'Redaction verification failed before encryption - redacted content would ' +
              'survive in the encrypted file, so the save was refused. ' +
              finalVerdict.failures.join('; '),
          )
        }
      }
      try {
        outArray = await encryptPdf(outArray, {
          algorithm: state.encryption.algorithm ?? 'AES_256',
          userPassword: state.encryption.userPassword || undefined,
          ownerPassword: state.encryption.ownerPassword || undefined,
          permissions: state.encryption.permissions,
        })
      } catch (err) {
        console.error('[pdfHandler.save] encryption failed:', err)
        throw new Error(
          'PDF encryption failed; refusing to save unprotected bytes over a protected output.',
        )
      }
    }

    // Print path stops here: hand back the decrypted WYSIWYG bytes without
    // mutating tab state, emitting an undo entry, or clearing history. The
    // pending edits stay live so the canvas keeps showing them and the next
    // real Save still flushes them to disk.
    if (!commit) return outArray

    // Session-1 channel: assemble the persistent report + the one-shot
    // toast notices. The report carries EVERYTHING (info included);
    // the toast subset is security+fidelity plus the established
    // info-level guidance areas.
    const degradationList = degradations.list()
    const noticeItems = degradationList.filter(
      (d) => d.severity !== 'info' || TOAST_VISIBLE_INFO_AREAS.has(d.area),
    )
    const saveReport: SaveReport = {
      saveSeq,
      timestamp: Date.now(),
      fastPath: false,
      degradations: degradationList,
      paragraphPaths,
      ...(engineSummaries.length > 0 ? { engineSummaries } : {}),
    }

    // Sync the serialized bytes back into state. Without this, the canvas
    // keeps rendering the pre-save pdfBytes, so visually nothing changes
    // even though the file on disk has the edit. Also clear the pending
    // edit markers — they've all been flushed.
    withReplay(() => useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => {
      // _postSaveWarning is the REMOVED legacy single-slot key — still
      // stripped here so states persisted by older sessions can't
      // resurface a stale string through the new toast path.
      const {
        _linkedChains,
        _historyBarrierOnSave,
        _postSaveWarning,
        _postSaveNotices,
        _pendingSaveDegradations,
        _postSaveLegalGuaranteeApplied: _staleLgApplied,
        // One-shot: consumed by THIS save's metadata-scrub slot above. Strip it
        // on commit so the NEXT ordinary (non-redaction) save does not silently
        // re-wipe metadata.
        _wipeMetadataAfterRedaction: _consumedScrubFlag,
        ...rest
      } = prev as PdfFormatState & { _linkedChains?: LinkedChain[]; _postSaveWarning?: string }
      void _linkedChains
      void _historyBarrierOnSave
      void _postSaveWarning
      void _postSaveNotices
      void _pendingSaveDegradations
      void _staleLgApplied
      void _consumedScrubFlag
      return {
        ...rest,
        pdfBytes: outArray,
        pages: prev.pages.map((p) => {
          const {
            _paragraphEdits,
            _textLayerEdits,
            _imageEdits,
            _paragraphMoves,
            _savePreviewParagraphEdits,
            _savePreviewImageEdits,
            _livePreviewParagraphEdits,
            ...rest2
          } = p as any
          void _paragraphEdits
          void _textLayerEdits
          void _imageEdits
          void _paragraphMoves
          void _savePreviewParagraphEdits
          void _savePreviewImageEdits
          void _livePreviewParagraphEdits
          const committedPage =
            manualRedactions.rects.length > 0
              ? {
                  ...(rest2 as PdfPageState),
                  fabricJSON: stripManualRedactionObjects(
                    (rest2 as PdfPageState).fabricJSON,
                  ).fabricJSON,
                }
              : (rest2 as PdfPageState)
          return {
            ...committedPage,
            _nativeStickyNotes: collectStickyNoteSnapshots(committedPage),
            ...(_paragraphEdits && _paragraphEdits.length > 0
              ? {
                  _savePreviewParagraphEdits:
                    enrichedEditsForPreview?.get((rest2 as PdfPageState).pageIndex) ??
                    _paragraphEdits,
                }
              : {}),
            ...(_imageEdits && _imageEdits.length > 0
              ? { _savePreviewImageEdits: _imageEdits }
              : {}),
          }
        }),
        _lastSaveReport: saveReport,
        ...(noticeItems.length > 0 ? { _postSaveNotices: noticeItems } : {}),
        // One-shot: a committing save that flattened redacted pages under
        // Legal Guarantee. lib/actions reads it to surface the "applied
        // permanently — re-enable autosave" toast, then clears it.
        ...(commit && legalGuaranteeFlattened ? { _postSaveLegalGuaranteeApplied: true } : {}),
      }
    }))
    // Only destructive/security saves are undo barriers. Routine saves
    // keep session history so the user can still undo ordinary edits
    // after writing bytes to disk. Page deletion, burned redaction, and
    // encryption commits clear history so sensitive pre-save bytes cannot
    // be resurrected with undo after the user commits the rewrite.
    if (clearHistoryAfterSave) useHistoryStore.getState().clear()

    return outArray
  },

  cleanup: (tabId) => {
    useFormatStore.getState().clearFormatState(tabId)
  },

  canConvertTo: ['image'],
  capabilities: { edit: true, annotate: true, search: true, zoom: true }
}
