import type { FormatHandler } from '../types'
import PdfViewer from './PdfViewer'
import PdfSidebar from './PdfSidebar'
import PdfToolbar from './PdfToolbar'
import { useFormatStore } from '../../stores/formatStore'
import { useHistoryStore, withReplay } from '../../stores/historyStore'
import { serializeEditsToPdf } from '../../services/editSerializer'
import { applyTextEditsToBytes, type TextLayerEdit } from '../../services/pdfTextEdits'
import { applyParagraphEditsToBytes, type ParagraphEdit } from '../../services/pdfParagraphEdits'
import { applyImageEditsToBytes, type ImageEdit } from '../../services/pdfImageEdits'
import { bakeParagraphEditsViaEngine } from '../../services/pdfEngineBake'
import { computeReflowDeltas, type ReflowParagraph } from '../../services/pdfReflow'
import { clusterParagraphs } from '../../services/pdfParagraphs'
import {
  expandMovesToEdits,
  mergeMoveEditsWithExisting,
  type ParagraphMove,
} from '../../services/pdfParagraphMove'
import {
  flowTextThroughChain,
  expandChainToEdits,
  monospaceMeasure,
  type LinkedChain,
} from '../../services/pdfLinkedBlocks'
import {
  extractTagSnapshot,
  restoreTagsAfterSave,
  type TagSnapshot,
} from '../../services/pdfStructPreserve'
import { encryptPdf, type PermissionFlags } from '../../services/pdfCrypto'
import { verifySignatures } from '../../services/pdfSign'
import { useUIStore } from '../../stores/uiStore'
import * as pdfjsLib from 'pdfjs-dist'

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
}

function saveRequiresHistoryBarrier(state: PdfFormatState): boolean {
  const hasDeletedPage = state.pages.some((p) => p.deleted)
  const hasSecurityRewrite = state._historyBarrierOnSave === true
  const hasEncryptionCommit = !!(
    state.encryption &&
    (state.encryption.userPassword || state.encryption.ownerPassword)
  )
  return hasDeletedPage || hasSecurityRewrite || hasEncryptionCommit
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

export interface HeaderFooterConfig {
  headerLeft: string; headerCenter: string; headerRight: string
  footerLeft: string; footerCenter: string; footerRight: string
  fontFamily: string; fontSize: number; color: string
  applyTo: 'all' | 'odd' | 'even'
  marginTop: number; marginBottom: number
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
    if (pageCount == null) {
      const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise
      pageCount = doc.numPages
      doc.destroy()
    }

    const pages: PdfPageState[] = Array.from({ length: pageCount }, (_, i) => ({
      pageIndex: i,
      rotation: 0,
      deleted: false,
      fabricJSON: null,
      formValues: null
    }))

    // B4: DocMDP enforce-on-load. Run a one-shot signature check; if
    // any signature is /DocMDP-certified, capture the /P level and the
    // signer's subject so the save guard + UI banner can react. Failures
    // (malformed signature, parse errors) leave docMdpLevel undefined —
    // the document opens unrestricted, matching pre-B4 behavior.
    let docMdpLevel: 1 | 2 | 3 | undefined
    let certifiedSigner: string | undefined
    try {
      const sigs = await verifySignatures(bytes)
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
    }
    useFormatStore.getState().setFormatState(tabId, state)
  },

  save: async (tabId) => {
    const tSaveStart = performance.now()
    const state = useFormatStore.getState().getFormatState<PdfFormatState>(tabId)
    if (!state) throw new Error('No PDF state for tab')
    const zoom = useUIStore.getState().zoom

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
      if (state._historyBarrierOnSave) clearSaveBarrierFlag(tabId)
      if (clearHistoryAfterSave) useHistoryStore.getState().clear()
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
    if (state.docMdpLevel) {
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
      const hasHeaderFooter = !!state.headerFooter
      const hasFormFill = state.pages.some(
        (p) => p.formValues && Object.keys(p.formValues).length > 0,
      )

      const breach: string[] = []
      if (state.docMdpLevel === 1) {
        if (hasFabric || hasFormFill || hasParaOrTextEdit || hasPageMod || hasHeaderFooter) {
          breach.push('any change forbidden under DocMDP /P=1 (No Changes Allowed)')
        }
      } else if (state.docMdpLevel === 2) {
        if (hasParaOrTextEdit) breach.push('paragraph / text edits')
        if (hasPageMod) breach.push('page rotation or deletion')
        if (hasHeaderFooter) breach.push('header/footer changes')
        if (hasFabric) breach.push('annotations / drawings')
      } else if (state.docMdpLevel === 3) {
        if (hasParaOrTextEdit) breach.push('paragraph / text edits')
        if (hasPageMod) breach.push('page rotation or deletion')
        if (hasHeaderFooter) breach.push('header/footer changes')
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
          const segs = flowTextThroughChain(ch, monospaceMeasure)
          const chainEdits = expandChainToEdits(ch, segs, originalTextById)
          for (const [page, edits] of chainEdits) {
            const cur = paraEditsByPage.get(page) ?? []
            const existingIds = new Set(cur.map((e) => e.paragraphId))
            const additions = edits.filter((e) => !existingIds.has(e.paragraphId))
            paraEditsByPage.set(page, [...cur, ...additions])
          }
        }
      }

      // S2 — Cross-page paragraph reflow on delete.
      //
      // Detect deletions (edits with empty newText). When any are
      // present, re-cluster every page in the document so the reflow
      // service knows what paragraphs sit below the deleted ones, and
      // synthesize shift-up entries for those followers. The engine
      // bake then drops them into place: original text masked at its
      // bbox, replacement text drawn at bbox + positionDelta.
      //
      // Skipped entirely when no deletion is present, so paragraph
      // edits that just change text or style stay on the existing fast
      // path with no extra clustering cost.
      const hasDeletion = [...paraEditsByPage.values()].some((edits) =>
        edits.some((e) => e.newText === '' && e.originalText !== ''),
      )
      let editsForBake = paraEditsByPage
      if (hasDeletion) {
        try {
          const paragraphsByPage = new Map<number, ReflowParagraph[]>()
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
              const { paragraphs } = await clusterParagraphs(
                pdfjsDocForWhiteout,
                idx,
              )
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
                })),
              )
            }
            editsForBake = computeReflowDeltas(
              paragraphsByPage,
              paraEditsByPage,
            )
          }
        } catch (err) {
          // Reflow is best-effort. If clustering fails (heavy PDF,
          // unusual structure, OOM), fall back to the unenriched
          // edits — user gets the old "delete leaves a hole" behavior
          // for this save instead of a failed save.
          console.warn('[pdfHandler.save] S2 reflow skipped:', err)
        }
      }

      const engineBaked =
        editsForBake.size > 0
          ? await bakeParagraphEditsViaEngine(workingBytes, editsForBake)
          : null

      if (engineBaked) {
        workingBytes = engineBaked.bytes
        for (const pageIndex of editsForBake.keys()) {
          pagesWithParaEdits.add(pageIndex)
        }
        console.log(
          `[pdfHandler.save] engine bake: +${engineBaked.summary.appendedBytes} bytes,`,
          `${engineBaked.summary.newObjectsEmitted} new objects`,
        )
      } else if (editsForBake.size > 0) {
        // Engine unavailable or errored — use pd-lib path.
        const fallback = (useUIStore.getState() as any).fallbackFontFamily as string | undefined
        for (const [pageIndex, paraEdits] of editsForBake) {
          workingBytes = await applyParagraphEditsToBytes(
            workingBytes,
            pageIndex,
            paraEdits,
            {
              fallbackFont: (fallback as any) || 'Helvetica',
              // Pass the pdfjs doc we opened above so applyParagraphEditsToBytes
              // can blank CMap-encoded runs via whiteout fallback inside
              // applyTextEditsToBytes. Without this, CMap fonts would leave
              // ghost text in the content stream.
              pdfjsDoc: pdfjsDocForWhiteout,
            },
          )
          pagesWithParaEdits.add(pageIndex)
        }
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
        )
      }
    } finally {
      if (pdfjsDocForWhiteout) await pdfjsDocForWhiteout.destroy()
    }

    // Clear _textLayerEdits on pages we handled via paragraph edits so
    // serializeEditsToPdf's internal legacy path doesn't re-apply them.
    // (This mutates the `pages` array we pass down, not state; state
    // clearing happens below after the save completes.)
    const pagesForSerializer = state.pages.map((p) => {
      if (!pagesWithParaEdits.has(p.pageIndex)) return p
      const { _textLayerEdits, ...rest } = p as any
      void _textLayerEdits
      return rest
    })

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
      state.pages.some((p) => {
        const fabricObjs = (p.fabricJSON as { objects?: unknown[] } | null)?.objects
        const hasFabric = Array.isArray(fabricObjs) && fabricObjs.length > 0
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
        return hasFabric || hasFormValues || hasPageSize || p.rotation !== 0 || p.deleted
      })

    let outArray: Uint8Array
    if (needsSerializerPass) {
      const outBytes = await serializeEditsToPdf(workingBytes, pagesForSerializer, zoom, {
        headerFooter: state.headerFooter,
      })
      outArray = outBytes instanceof Uint8Array ? outBytes : new Uint8Array(outBytes)
    } else {
      outArray =
        workingBytes instanceof Uint8Array ? workingBytes : new Uint8Array(workingBytes)
    }

    // A3 — restore tagged-PDF structure if the original was tagged.
    // No-op when tagSnapshot.wasTagged is false. Re-runs the existing
    // installStructTree path which rebuilds /StructTreeRoot from
    // current content + preserved alt text, so the saved PDF still
    // passes veraPDF UA-1 even when text content changed underneath.
    if (tagSnapshot && tagSnapshot.wasTagged) {
      try {
        outArray = await restoreTagsAfterSave(outArray, tagSnapshot, state.pageCount)
      } catch (err) {
        // Restoration is best-effort. Bail and keep the un-restored
        // bytes rather than aborting the save — better to ship an
        // un-tagged file than lose the user's edits.
        console.warn('[pdfHandler.save] tag restore failed:', err)
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
    if (outArray.byteLength < sourceSize / 2 && sourceSize > 8192) {
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
    if (state.encryption && (state.encryption.userPassword || state.encryption.ownerPassword)) {
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

    // Sync the serialized bytes back into state. Without this, the canvas
    // keeps rendering the pre-save pdfBytes, so visually nothing changes
    // even though the file on disk has the edit. Also clear the pending
    // edit markers — they've all been flushed.
    withReplay(() => useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => {
      const { _linkedChains, _historyBarrierOnSave, ...rest } = prev as PdfFormatState & { _linkedChains?: LinkedChain[] }
      void _linkedChains
      void _historyBarrierOnSave
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
            ...rest2
          } = p as any
          void _paragraphEdits
          void _textLayerEdits
          void _imageEdits
          void _paragraphMoves
          void _savePreviewParagraphEdits
          void _savePreviewImageEdits
          return {
            ...rest2,
            ...(_paragraphEdits && _paragraphEdits.length > 0
              ? { _savePreviewParagraphEdits: _paragraphEdits }
              : {}),
            ...(_imageEdits && _imageEdits.length > 0
              ? { _savePreviewImageEdits: _imageEdits }
              : {}),
          }
        }),
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
