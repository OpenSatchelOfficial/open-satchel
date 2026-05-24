// EditableParagraphLayer — Acrobat-style paragraph-level editing.
//
// This is the inline text editor we land on after learning that span-level
// (per-TJ-element) editing causes visual flicker and produces fragmented
// edits. Acrobat, Foxit, and WPS all work at the paragraph level with
// visible bounding boxes. This component does the same:
//
//   1. Cluster pdfjs text items into paragraph boxes at mount
//   2. Draw a thin outline over each paragraph
//   3. On click, the clicked paragraph becomes a contenteditable div
//      sized to the bbox. Browser reflow handles wrapping while typing.
//   4. On blur or on every input, store the diff in `_paragraphEdits`
//      on the page state — no canvas repaint during editing
//   5. On save, pdfHandler.save whiteouts the bbox and draws the new
//      text in its place via applyParagraphEditsToBytes

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { useFormatStore } from '../../stores/formatStore'
import { useTabStore } from '../../stores/tabStore'
import { withReplay } from '../../stores/historyStore'
import {
  clusterParagraphs,
  getParagraphTextColorsFromStream,
  sampleParagraphBackgrounds,
  type ParagraphBox,
  type TextItem,
} from '../../services/pdfParagraphs'
import type { ParagraphEdit, TextAlign } from '../../services/pdfParagraphEdits'
import { runOcr } from '../../services/pdfOcr'
import {
  clusterOcrPageToParagraphs,
  ocrParagraphsToBoxes,
} from '../../services/pdfOcrToParagraphs'
import type { ParagraphMove } from '../../services/pdfParagraphMove'
import type { LinkedChain, LinkedFrame } from '../../services/pdfLinkedBlocks'
import {
  skipBboxFromParagraphBbox,
  useEngineStrippedRender,
} from '../../hooks/useEngineStrippedRender'
import type { PdfFormatState } from './index'

// Walk a contenteditable's children and produce the user-visible text
// with newlines preserved. Handles <br>, block-level wrappers (<div>,
// <p>, <li>, ...) that browsers create when Enter is pressed.
//
// textContent flattens newlines (was G7 in the ledger — multi-line
// paragraph edits saved as a single line). innerText would do this
// too, but it forces layout calc on every read; this walker stays
// off the layout-thrash path.
function readMultilineText(el: HTMLElement): string {
  const BLOCK = new Set(['DIV', 'P', 'LI', 'BLOCKQUOTE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'])
  const out: string[] = []
  let lastNewline = true
  const walk = (node: Node): void => {
    if (node.nodeType === 3) { // text node
      const t = node.textContent ?? ''
      if (t.length > 0) { out.push(t); lastNewline = t.endsWith('\n') }
      return
    }
    if (node.nodeType !== 1) return
    const e = node as Element
    if (e.nodeName === 'BR') {
      out.push('\n'); lastNewline = true; return
    }
    const isBlock = BLOCK.has(e.nodeName)
    // Browsers wrap a new line in <div> on Enter. The first <div> at
    // the top level is the "current line" — don't prepend a newline
    // for it. Subsequent block siblings DO start a new line.
    if (isBlock && !lastNewline && out.length > 0) {
      out.push('\n'); lastNewline = true
    }
    for (const child of Array.from(e.childNodes)) walk(child)
    if (isBlock && !lastNewline) { out.push('\n'); lastNewline = true }
  }
  for (const child of Array.from(el.childNodes)) walk(child)
  // Trim a single trailing \n added by a block close — the user
  // didn't type that and it leaks into save.
  let result = out.join('')
  if (result.endsWith('\n')) result = result.slice(0, -1)
  return result
}

interface Props {
  tabId: string
  pageIndex: number
  pdfDoc: PDFDocumentProxy
  /** Displayed canvas width in CSS pixels. */
  width: number
  /** Displayed canvas height in CSS pixels. */
  height: number
  /** When true, paragraph outlines are rendered and click-to-edit is
   *  armed. When false, the layer stays MOUNTED — cluster state and
   *  pending `_paragraphEdits` remain cached — but the outlines are
   *  hidden and the whole layer has pointer-events:none so clicks
   *  fall through to Fabric / the canvas. Flipping this prop is
   *  instant because no remount / re-cluster happens.
   *
   *  Part of the modeless-editing refactor.
   *  Previously the layer only mounted when tool === 'edit_text' and
   *  unmounted otherwise, which blew away cluster state on every tool
   *  switch AND prevented annotations on other layers from being seen
   *  because THIS layer (when mounted) covered them. Always-mount +
   *  prop-gated visibility avoids both. */
  active?: boolean
  /** True after the sibling pdfjs canvas has painted the current
   *  pdfDoc. Used to hold post-save previews until the new saved
   *  pixels are actually visible. */
  renderReady?: boolean
}

// pdfParagraphs.ts now resolves fontFamily from pdfjs's styles map and
// emits bold/italic flags, so we use those per-paragraph instead of a
// single global stack.
const FALLBACK_FONT_STACK = `-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif`

function readPendingEditsForPage(tabId: string, pageIndex: number): ParagraphEdit[] {
  const state = useFormatStore.getState().data[tabId] as PdfFormatState | undefined
  if (!state) return []
  const page = state.pages.find((p) => p.pageIndex === pageIndex) as
    | (PdfFormatState['pages'][number] & { _paragraphEdits?: ParagraphEdit[] })
    | undefined
  return page?._paragraphEdits ?? []
}

/** Append a ParagraphMove to the source page's _paragraphMoves slot.
 *  Save expansion in pdfHandler.save converts each into (mask + draw)
 *  edit pair so the destination page draws the moved text. */
function pushParagraphMove(
  tabId: string,
  fromPage: number,
  move: ParagraphMove,
): void {
  useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({
    ...prev,
    pages: prev.pages.map((p) => {
      if (p.pageIndex !== fromPage) return p
      const cur = ((p as unknown as { _paragraphMoves?: ParagraphMove[] })._paragraphMoves ?? []) as ParagraphMove[]
      return ({ ...p, _paragraphMoves: [...cur, move] } as PdfFormatState['pages'][number])
    }),
  }))
  useTabStore.getState().setTabDirty(tabId, true)
}

/** Replace (or initialize) the document-level linked chains list.
 *  Chains live at format-state root since a chain spans pages. */
function writeLinkedChains(tabId: string, chains: LinkedChain[]): void {
  useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({
    ...prev,
    _linkedChains: chains.length > 0 ? chains : undefined,
  } as PdfFormatState & { _linkedChains?: LinkedChain[] }))
  if (chains.length > 0) useTabStore.getState().setTabDirty(tabId, true)
}

function readLinkedChains(tabId: string): LinkedChain[] {
  const state = useFormatStore.getState().data[tabId] as
    | (PdfFormatState & { _linkedChains?: LinkedChain[] })
    | undefined
  return state?._linkedChains ?? []
}

function writePendingEditsForPage(tabId: string, pageIndex: number, edits: ParagraphEdit[]) {
  useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({
    ...prev,
    pages: prev.pages.map((p) =>
      p.pageIndex === pageIndex
        ? ({ ...p, _paragraphEdits: edits.length > 0 ? edits : undefined } as any)
        : p,
    ),
  }))
  // Mark dirty iff any page has pending edits.
  const anyDirty = useFormatStore
    .getState()
    .data[tabId] != null
  if (edits.length > 0) useTabStore.getState().setTabDirty(tabId, true)
  // If we just cleared the last edit, leave the dirty flag alone —
  // other edit systems (Fabric, page rotates) might still be dirty.
  void anyDirty
}

export default function EditableParagraphLayer({ tabId, pageIndex, pdfDoc, width, height, active = true, renderReady = true }: Props) {
  const [paragraphs, setParagraphs] = useState<ParagraphBox[]>([])
  // Items snapshot from the cluster call. Populated by the main
  // cluster effect so commit-time edits can carry pdfjs TextLayer
  // indices without paying for a second clusterParagraphs() pass.
  // Declared early so the cluster useEffect can reference it.
  const itemsRef = useRef<TextItem[]>([])
  const [basePageSize, setBasePageSize] = useState<{ w: number; h: number } | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [ocrRunning, setOcrRunning] = useState(false)
  const [ocrError, setOcrError] = useState<string | null>(null)
  const [clusterDone, setClusterDone] = useState(false)
  // A2 + linked-blocks UI state.
  // movePickerOpen: shows the destination-page select for the active
  //   paragraph. Closes after the user picks a page (or cancels).
  // linkingMode: true while the user has clicked "Start chain" on
  //   one paragraph and is waiting to click a second paragraph to
  //   complete the chain. Cleared when chain completes or user
  //   presses Esc / clicks outside.
  // linkingFirstFrame: the first frame captured when linking began.
  //   Used together with the second-clicked frame to assemble a
  //   LinkedChain entry on the format-store.
  const [movePickerOpen, setMovePickerOpen] = useState(false)
  const [linkingMode, setLinkingMode] = useState(false)
  const [movePreviewBbox, setMovePreviewBbox] = useState<ParagraphBox['bbox'] | null>(null)
  // In-progress chain frames. Built up as the user clicks paragraphs
  // while linkingMode is on. End chain writes them to _linkedChains;
  // Cancel discards them. Supports any number of frames (N ≥ 2).
  const [linkingFrames, setLinkingFrames] = useState<LinkedFrame[]>([])
  const layerRef = useRef<HTMLDivElement>(null)
  // Format state for page count + tab-level access (for movePicker).
  const formatState = useFormatStore((s) => s.data[tabId] as PdfFormatState | undefined)
  const totalPageCount = formatState?.pageCount ?? 0

  // When the layer goes inactive (tool flipped away from Edit Text) we
  // clear the per-paragraph active focus. Without this, reactivating
  // Edit Text later would remount the ParagraphEditor for the stale
  // activeId with active=true — and the seeding effect's `if (active)
  // return` guard would skip filling textContent from the pending
  // edit, leaving the caret in a visibly empty box. Acrobat's Edit
  // Text tool also deactivates the current caret when you switch
  // tools — matching behavior.
  useEffect(() => {
    if (!active && activeId !== null) setActiveId(null)
  }, [active, activeId])

  // Cross-layer activation hygiene. Each page gets its own layer
  // instance with its own `activeId` state. When the user clicks a
  // paragraph on page 2, page 1's layer doesn't know — its
  // `activeId` stays pinned to whatever was last active on page 1,
  // leaving a stale contentEditable that the DOM happily returns
  // from querySelector('[contenteditable="true"]'). In live UX this
  // doesn't usually bite because the user clicks ONE paragraph at a
  // time and the prior one loses focus, but: (a) blur events don't
  // fire reliably when the focused element scrolls out of view or
  // is remounted, and (b) programmatic tests hit this constantly.
  // Solution: every layer listens at the document level for
  // pointerdown; if the hit target isn't inside THIS layer's own
  // DOM subtree, clear local activeId. O(N_visible_pages) listeners,
  // negligible.
  useEffect(() => {
    if (!active) return
    const onOutside = (e: Event) => {
      const el = layerRef.current
      if (!el) return
      const target = e.target as Node | null
      if (target && el.contains(target)) return // click inside this layer — ignore
      setActiveId(null)
    }
    // Listen on both pointerdown (real user clicks) and click (covers
    // synthesized .click() calls that bypass the pointer path — common
    // in automation + some keyboard activation paths). Capture-phase so
    // we fire before child handlers that might stopPropagation.
    document.addEventListener('pointerdown', onOutside, true)
    document.addEventListener('click', onOutside, true)
    return () => {
      document.removeEventListener('pointerdown', onOutside, true)
      document.removeEventListener('click', onOutside, true)
    }
  }, [active])

  // Cluster paragraphs once per (pdfDoc, pageIndex). Re-runs if pdfBytes
  // change because pdfDoc identity then changes.
  //
  // Heavy work (pdfjs text extraction + content-stream color parse +
  // canvas bg sampling) is gated behind requestIdleCallback so it
  // doesn't block first-paint. The clusterer takes 100-500ms per
  // page on heavy PDFs; running it eagerly per page-mount during
  // initial open multiplied that across N visible pages and kept
  // the main thread blocked throughout. Idle-gating means the
  // canvas paints first, the user sees content immediately, and
  // the cluster fills in within the next 50-200ms idle window —
  // before they could possibly click into a paragraph.
  useEffect(() => {
    let cancelled = false
    let idleHandle: number | null = null

    // Wait for the sibling canvas to signal paint completion before
    // sampling bg colors. Previously clusterParagraphs resolved ~200ms
    // in but the pdfjs canvas render ran ~300ms+; sampling ran against
    // a blank white canvas and marked every paragraph as light-bg, so
    // the save mask painted white over dark headers.
    const waitForCanvas = async (): Promise<HTMLCanvasElement | null> => {
      const start = Date.now()
      const MAX_WAIT = 2500
      while (Date.now() - start < MAX_WAIT) {
        if (cancelled) return null
        const layer = layerRef.current
        const sibling = layer?.parentElement?.querySelector('canvas') as HTMLCanvasElement | null
        if (sibling && sibling.width > 0 && sibling.dataset.ready === '1') return sibling
        await new Promise((r) => setTimeout(r, 50))
      }
      // Timed out; use whatever canvas exists, accept potential inaccuracy.
      const layer = layerRef.current
      return (layer?.parentElement?.querySelector('canvas') as HTMLCanvasElement | null) ?? null
    }

    const runCluster = async () => {
      try {
        const res = await clusterParagraphs(pdfDoc, pageIndex)
        if (cancelled) return
        // Side-channel the items into itemsRef so commit-time edits
        // can carry the pdfjs TextLayer indices without us paying for
        // a second clusterParagraphs() pass.
        itemsRef.current = res.items
        let finalParagraphs = res.paragraphs

        // Authoritative text color from the PDF's own content stream.
        // The layer-hosting format store holds the raw pdfBytes; we
        // parse them once per page to pull graphics-state colors and
        // attach them to each paragraph. No luminance heuristic — the
        // color is whatever the PDF author set with rg/g/k/scn.
        const state = useFormatStore.getState().data[tabId] as PdfFormatState | undefined
        const pdfBytes = state?.pdfBytes
        if (pdfBytes) {
          try {
            const colorMap = await getParagraphTextColorsFromStream(
              pdfBytes,
              pageIndex,
              res.paragraphs,
              res.pageHeight,
            )
            if (cancelled) return
            finalParagraphs = finalParagraphs.map((p) => {
              const c = colorMap.get(p.id)
              if (!c) return p
              // Luminance of the text color — used by the in-edit
              // mask to pick dark-behind-light-text vs the reverse.
              // Works regardless of the actual bg color.
              const r = parseInt(c.slice(1, 3), 16) / 255
              const g = parseInt(c.slice(3, 5), 16) / 255
              const b = parseInt(c.slice(5, 7), 16) / 255
              const lum = 0.299 * r + 0.587 * g + 0.114 * b
              return { ...p, color: c, onDarkBackground: lum > 0.5 }
            })
          } catch (err) {
            console.warn('[EditableParagraphLayer] text-color extract failed:', err)
          }
        }

        // Background color for save-time mask — still sampled from
        // canvas because the content stream doesn't give us a clean
        // "what was painted behind this text" without replaying the
        // graphics ops. Requires the canvas to be rendered.
        const canvas = await waitForCanvas()
        if (cancelled) return
        if (canvas && canvas.width > 0) {
          finalParagraphs = sampleParagraphBackgrounds(canvas, finalParagraphs, res.pageWidth)
        }
        setParagraphs(finalParagraphs)
        setBasePageSize({ w: res.pageWidth, h: res.pageHeight })
        setClusterDone(true)
      } catch (err) {
        // Surface but don't crash the page render — paragraphs just
        // won't be available until the user clicks something that
        // triggers a fresh cluster.
        console.error('[EditableParagraphLayer] cluster failed:', err)
        setClusterDone(true)
      }
    }

    // Defer past first-paint with a 100ms setTimeout. Simpler than
    // requestIdleCallback (which had cross-WebView2 reliability issues
    // when the cancel ran before the doc destroyed).
    idleHandle = window.setTimeout(() => { void runCluster() }, 100)

    return () => {
      cancelled = true
      if (idleHandle !== null) window.clearTimeout(idleHandle)
    }
  }, [pdfDoc, pageIndex])

  // OCR a scanned page on demand. The "Run OCR + edit" overlay
  // surfaces only when the clusterer found zero paragraphs (= no
  // extractable text); clicking it rasterizes this single page,
  // routes the bytes through Tesseract, and synthesizes ParagraphBox
  // entries so the rest of the editor (click, drag, type) just works.
  // Save lands through the overlay-bake path because itemIndices is
  // empty — there's no original Tj run to surgically rewrite anyway.
  const runOcrForThisPage = useCallback(async () => {
    setOcrError(null)
    setOcrRunning(true)
    try {
      const state = useFormatStore.getState().data[tabId] as PdfFormatState | undefined
      const pdfBytes = state?.pdfBytes
      if (!pdfBytes) throw new Error('PDF bytes missing from format store')
      const dpi = 300
      const result = await runOcr(
        pdfBytes,
        [pageIndex],
        0,
        {
          scope: 'current',
          language: 'eng',
          dpi,
          autoRotate: true,
          autoDetectLanguage: false,
          deskew: true,
          outputMode: 'clipboard',
          suspectThreshold: 60,
        },
      )
      const ocrPage = result.ocrPageData[0]
      if (!ocrPage) throw new Error('OCR returned no page data')
      const ocrParas = clusterOcrPageToParagraphs(ocrPage, pageIndex)
      const ocrScale = dpi / 72
      const boxes = ocrParagraphsToBoxes(ocrParas, ocrScale) as ParagraphBox[]
      setParagraphs(boxes)
      // Update basePageSize from OCR canvas dimensions if not yet set.
      if (!basePageSize) {
        setBasePageSize({
          w: ocrPage.vpWidth / ocrScale,
          h: ocrPage.vpHeight / ocrScale,
        })
      }
    } catch (err) {
      console.error('[EditableParagraphLayer] OCR failed:', err)
      setOcrError(err instanceof Error ? err.message : String(err))
    } finally {
      setOcrRunning(false)
    }
  }, [tabId, pageIndex, basePageSize])

  // A2 — move active paragraph to another page.
  // Picks up the active paragraph's bbox + style from the cluster
  // result, captures any pending edit's text, and writes a
  // ParagraphMove record on the source page's _paragraphMoves slot.
  // pdfHandler.save expands these to (mask + draw) edits at save time.
  const moveActiveParagraphToPage = useCallback((toPage: number) => {
    if (activeId === null || toPage === pageIndex) {
      setMovePickerOpen(false)
      return
    }
    const para = paragraphs.find((p) => p.id === activeId)
    if (!para) {
      setMovePickerOpen(false)
      return
    }
    const pending = readPendingEditsForPage(tabId, pageIndex).find(
      (e) => e.paragraphId === activeId,
    )
    const text = pending?.newText ?? para.originalText
    pushParagraphMove(tabId, pageIndex, {
      paragraphId: para.id,
      fromPage: pageIndex,
      toPage,
      // Land at same x + same vertical offset on the target page.
      // User can drag-fine-tune after save once the new position is
      // visible on the destination page.
      fromBbox: { ...para.bbox },
      toBbox: { ...para.bbox },
      text,
      fontSize: para.fontSize,
      fontFamily: para.fontFamily,
      bold: para.bold,
      italic: para.italic,
      color: para.color,
      backgroundColor: para.backgroundColor,
    })
    setActiveId(null)
    setMovePickerOpen(false)
  }, [activeId, pageIndex, paragraphs, tabId])

  // Linked-blocks — start a chain from the active paragraph.
  // Captures the first frame, flips linkingMode on so each next
  // paragraph click adds another frame. User clicks "End chain" to
  // finalize (or "Cancel" to discard). Supports N ≥ 2 frames.
  const startLinkChain = useCallback(() => {
    if (activeId === null) return
    const para = paragraphs.find((p) => p.id === activeId)
    if (!para) return
    setLinkingFrames([{
      paragraphId: para.id,
      bbox: { ...para.bbox },
      pageIndex,
      fontSize: para.fontSize,
      fontFamily: para.fontFamily,
      bold: para.bold,
      italic: para.italic,
      color: para.color,
      backgroundColor: para.backgroundColor,
    }])
    setLinkingMode(true)
    setActiveId(null)
  }, [activeId, paragraphs, pageIndex])

  const cancelLinkChain = useCallback(() => {
    setLinkingMode(false)
    setLinkingFrames([])
  }, [])

  // Append the clicked paragraph as the next frame in the in-progress
  // chain. Skips if the same paragraph id is already in the chain
  // (no-op rather than a degenerate self-link).
  const addFrameToLinkChain = useCallback((para: ParagraphBox) => {
    setLinkingFrames((prev) => {
      if (prev.some((f) => f.paragraphId === para.id)) return prev
      return [...prev, {
        paragraphId: para.id,
        bbox: { ...para.bbox },
        pageIndex,
        fontSize: para.fontSize,
        fontFamily: para.fontFamily,
        bold: para.bold,
        italic: para.italic,
        color: para.color,
        backgroundColor: para.backgroundColor,
      }]
    })
  }, [pageIndex])

  // Finalize the chain — writes _linkedChains. Requires ≥ 2 frames
  // (a 1-frame chain is just a regular paragraph).
  const endLinkChain = useCallback(() => {
    if (linkingFrames.length < 2) {
      cancelLinkChain()
      return
    }
    // Seed the chain's text payload from each frame's originalText
    // joined with newlines. Flow algorithm redistributes on save.
    const seedTextParts: string[] = []
    for (const frame of linkingFrames) {
      const para = paragraphs.find((p) => p.id === frame.paragraphId)
      if (para) seedTextParts.push(para.originalText)
    }
    const chain: LinkedChain = {
      id: `chain_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      frames: [...linkingFrames],
      text: seedTextParts.join('\n'),
    }
    const existing = readLinkedChains(tabId)
    writeLinkedChains(tabId, [...existing, chain])
    cancelLinkChain()
  }, [linkingFrames, paragraphs, tabId, cancelLinkChain])

  // CSS-pixels per PDF-user-space-unit. pdfjs returns geometry at scale=1,
  // the canvas is rendered at zoom — we scale the overlay to match.
  const scale = basePageSize ? width / basePageSize.w : 1

  // Subscribe to this page's _paragraphEdits array so the layer re-renders
  // whenever the store changes (history undo/redo, drag-commit, or a
  // typing commit). The selector returns the array reference — zustand
  // triggers a re-render whenever that reference changes, which is on
  // every writePendingEditsForPage. Children then see fresh `pending` and
  // fresh `committedDelta` props, so positional changes from undo/redo
  // propagate without a remount.
  //
  // `_paragraphEdits` is a runtime field the layer attaches to each
  // PdfPageState; it isn't part of the formal type so we cast per-page.
  const pageEdits = useFormatStore((s): ParagraphEdit[] | undefined => {
    const state = s.data[tabId] as PdfFormatState | undefined
    const page = state?.pages.find((p) => p.pageIndex === pageIndex) as
      | (PdfFormatState['pages'][number] & { _paragraphEdits?: ParagraphEdit[] })
      | undefined
    return page?._paragraphEdits
  })
  const pageSavePreviewEdits = useFormatStore((s): ParagraphEdit[] | undefined => {
    const state = s.data[tabId] as PdfFormatState | undefined
    const page = state?.pages.find((p) => p.pageIndex === pageIndex) as
      | (PdfFormatState['pages'][number] & { _savePreviewParagraphEdits?: ParagraphEdit[] })
      | undefined
    return page?._savePreviewParagraphEdits
  })

  useEffect(() => {
    if (!renderReady || !pageSavePreviewEdits || pageSavePreviewEdits.length === 0) return
    withReplay(() => {
      useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({
        ...prev,
        pages: prev.pages.map((p) => {
          if (p.pageIndex !== pageIndex) return p
          const { _savePreviewParagraphEdits, ...rest } = p as any
          void _savePreviewParagraphEdits
          return rest
        }),
      }))
    })
  }, [renderReady, pageSavePreviewEdits, tabId, pageIndex])

  const pendingById = useMemo(() => {
    const edits: ParagraphEdit[] =
      pageEdits && pageEdits.length > 0
        ? pageEdits
        : pageSavePreviewEdits ?? []
    return new Map(edits.map((e) => [e.paragraphId, e]))
  }, [pageEdits, pageSavePreviewEdits])

  // (itemsRef declared at top of component — populated by cluster effect.)

  // Snapshot of _paragraphEdits at the moment the user CLICKS INTO a
  // paragraph. We diff against this when they leave (blur OR activeId
  // changes) and push ONE history entry per commit — per-keystroke
  // pushes would bloat the stack and make undo feel jumpy.
  const editSessionBeforeRef = useRef<ParagraphEdit[] | undefined>(undefined)
  // Mirror of activeId one-render behind so a useEffect can detect the
  // exact transition from "something active" → "nothing active" and
  // flush history. onBlur isn't reliable (automation, focus-steal).
  const prevActiveIdRef = useRef<string | null>(null)

  const commitEdit = useCallback(
    (para: ParagraphBox, newText: string, overrideAlign?: TextAlign) => {
      const existing = readPendingEditsForPage(tabId, pageIndex)
      const without = existing.filter((e) => e.paragraphId !== para.id)
      const prevEdit = existing.find((e) => e.paragraphId === para.id)
      const align = overrideAlign ?? prevEdit?.align
      const positionDelta = prevEdit?.positionDelta
      // Preserve styleChanged across commitEdit rewrites. If the caller
      // passed overrideAlign (contextual-toolbar align change), that IS
      // a style change; flag it. Otherwise inherit from prevEdit.
      const styleChanged = prevEdit?.styleChanged || overrideAlign !== undefined
      const isNoop = newText === para.originalText && !align && !positionDelta && !styleChanged
      const itemOriginalTexts = para.itemIndices.map((idx) => itemsRef.current[idx]?.str ?? '')
      const next: ParagraphEdit[] = isNoop
        ? without
        : [
            ...without,
            {
              paragraphId: para.id,
              bbox: para.bbox,
              originalText: para.originalText,
              newText,
              fontSize: para.fontSize,
              color: para.color,
              backgroundColor: para.backgroundColor,
              fontFamily: para.fontFamily,
              bold: para.bold,
              italic: para.italic,
              align,
              itemIndices: [...para.itemIndices],
              itemOriginalTexts,
              positionDelta,
              styleChanged,
            },
          ]
      writePendingEditsForPage(tabId, pageIndex, next)
    },
    [tabId, pageIndex],
  )

  // Commit a new drag offset for this paragraph. Text, alignment, and
  // other edit fields are preserved; only positionDelta changes. Pushes
  // one history entry per drag (onPointerUp), not per mousemove.
  const commitMove = useCallback(
    (para: ParagraphBox, delta: { dx: number; dy: number }) => {
      const existing = readPendingEditsForPage(tabId, pageIndex)
      const without = existing.filter((e) => e.paragraphId !== para.id)
      const prevEdit = existing.find((e) => e.paragraphId === para.id)
      // Drop positionDelta back to undefined when it lands back at origin
      // so isNoop cleanup still fires if text+align are also unchanged.
      const isZero = Math.abs(delta.dx) < 0.01 && Math.abs(delta.dy) < 0.01
      const newDelta = isZero ? undefined : delta
      const newText = prevEdit?.newText ?? para.originalText
      const align = prevEdit?.align
      const isNoop = newText === para.originalText && !align && !newDelta
      const itemOriginalTexts =
        prevEdit?.itemOriginalTexts ??
        para.itemIndices.map((idx) => itemsRef.current[idx]?.str ?? '')
      const next: ParagraphEdit[] = isNoop
        ? without
        : [
            ...without,
            {
              paragraphId: para.id,
              bbox: para.bbox,
              originalText: para.originalText,
              newText,
              fontSize: para.fontSize,
              color: para.color,
              backgroundColor: para.backgroundColor,
              fontFamily: para.fontFamily,
              bold: para.bold,
              italic: para.italic,
              align,
              itemIndices: [...para.itemIndices],
              itemOriginalTexts,
              positionDelta: newDelta,
              styleChanged: prevEdit?.styleChanged,
            },
          ]
      writePendingEditsForPage(tabId, pageIndex, next)
    },
    [tabId, pageIndex],
  )

  const beginEditSession = useCallback(() => {
    editSessionBeforeRef.current = readPendingEditsForPage(tabId, pageIndex).map((e) => ({ ...e }))
  }, [tabId, pageIndex])

  const endEditSession = useCallback(() => {
    const before = editSessionBeforeRef.current
    editSessionBeforeRef.current = undefined
    if (before === undefined) return
    const after = readPendingEditsForPage(tabId, pageIndex).map((e) => ({ ...e }))
    if (JSON.stringify(before) === JSON.stringify(after)) return
  }, [tabId, pageIndex])

  // Activation watcher: on any change to activeId, start or end the
  // edit session. Covers the automation case where programmatic
  // .blur() doesn't fire React's synthetic onBlur, AND keeps a single
  // source of truth for session lifecycle (no double-counting if the
  // user clicks from one paragraph directly to another — activeId
  // transitions A → null only briefly, or A → B with just one push).
  useEffect(() => {
    const prev = prevActiveIdRef.current
    if (prev !== null && activeId !== prev) {
      // Leaving a previously-active paragraph — flush.
      endEditSession()
    }
    if (activeId !== null && activeId !== prev) {
      // Entering a new paragraph.
      beginEditSession()
    }
    prevActiveIdRef.current = activeId
  }, [activeId, beginEditSession, endEditSession])

  const setParagraphAlign = useCallback(
    (para: ParagraphBox, align: TextAlign) => {
      // Alignment changes are their own atomic history entry — snapshot
      // before and flush after with a direct push, regardless of the
      // active-session machinery.
      const existing = readPendingEditsForPage(tabId, pageIndex)
      const prev = existing.find((e) => e.paragraphId === para.id)
      const text = prev?.newText ?? para.originalText
      commitEdit(para, text, align)
    },
    [tabId, pageIndex, commitEdit],
  )

  // Phase E — contextual toolbar props. Both callbacks push their own
  // history entry so each font-size or color tweak can be undone
  // atomically, without getting bundled into the running edit-session
  // snapshot from commitEdit.
  const updateFieldOnEdit = useCallback(
    (para: ParagraphBox, patch: Partial<ParagraphEdit>) => {
      const existing = readPendingEditsForPage(tabId, pageIndex)
      const without = existing.filter((e) => e.paragraphId !== para.id)
      const prev = existing.find((e) => e.paragraphId === para.id)
      const itemOriginalTexts =
        prev?.itemOriginalTexts ??
        para.itemIndices.map((idx) => itemsRef.current[idx]?.str ?? '')
      const merged: ParagraphEdit = {
        paragraphId: para.id,
        // Preserve a prior resize through subsequent style edits.
        // Without this, a font-size tweak after a corner-grip resize
        // would silently revert the bbox to the original cluster
        // dimensions. patch.bbox below still wins for fresh resizes.
        bbox: prev?.bbox ?? para.bbox,
        originalText: para.originalText,
        newText: prev?.newText ?? para.originalText,
        fontSize: prev?.fontSize ?? para.fontSize,
        color: prev?.color ?? para.color,
        backgroundColor: prev?.backgroundColor ?? para.backgroundColor,
        bold: prev?.bold ?? para.bold,
        italic: prev?.italic ?? para.italic,
        fontFamily: prev?.fontFamily ?? para.fontFamily,
        align: prev?.align,
        itemIndices: [...para.itemIndices],
        itemOriginalTexts,
        positionDelta: prev?.positionDelta,
        ...patch,
      }
      const next = [...without, merged]
      writePendingEditsForPage(tabId, pageIndex, next)
    },
    [tabId, pageIndex],
  )

  const setParagraphFontSize = useCallback(
    (para: ParagraphBox, fontSize: number) => {
      // styleChanged forces the save pipeline to overlay-bake, which
      // re-emits Tf so the new size sticks; the rewrite path only
      // touches Tj operands and would silently drop font-size changes.
      updateFieldOnEdit(para, { fontSize, styleChanged: true })
    },
    [updateFieldOnEdit],
  )

  const setParagraphColor = useCallback(
    (para: ParagraphBox, color: string) => {
      updateFieldOnEdit(para, { color, styleChanged: true })
    },
    [updateFieldOnEdit],
  )

  const setParagraphFontFamily = useCallback(
    (para: ParagraphBox, fontFamily: string) => {
      // Forces overlay-bake (engine can't rewrite a Tj's font reference
      // in place — needs a fresh Tf in the appended overlay stream).
      // Engine's overlay-bake supports the Standard 14 families today
      // (G2 still open for arbitrary custom fonts) — the toolbar's
      // dropdown only offers fonts the engine can honor.
      updateFieldOnEdit(para, { fontFamily, styleChanged: true })
    },
    [updateFieldOnEdit],
  )

  const setParagraphLineHeight = useCallback(
    (para: ParagraphBox, lineHeight: number) => {
      // Line-spacing changes go through the overlay-bake path because
      // they affect leading/TL emission across multi-line paragraphs.
      updateFieldOnEdit(para, { lineHeight, styleChanged: true })
    },
    [updateFieldOnEdit],
  )

  /** Commit a resize. Constrained to grow-only (newBbox.width/height
   *  >= original) so the bake-stage whiteout doesn't underexpose
   *  original glyphs that fall outside a shrunk bbox. styleChanged
   *  forces overlay-bake which honors the new bbox via the existing
   *  bbox-driven whiteout + drawText path. */
  const commitResize = useCallback(
    (para: ParagraphBox, newBbox: ParagraphBox['bbox']) => {
      const safe = {
        x: Math.min(newBbox.x, para.bbox.x),
        y: Math.min(newBbox.y, para.bbox.y),
        width: Math.max(newBbox.width, para.bbox.width),
        height: Math.max(newBbox.height, para.bbox.height),
      }
      updateFieldOnEdit(para, { bbox: safe, styleChanged: true })
    },
    [updateFieldOnEdit],
  )

  // Historical note: there used to be a "canvas pixel-fill" effect here
  // that painted a solid rectangle directly onto the pdfjs canvas over
  // each active-or-edited paragraph's bbox. It was a zero-latency
  // fallback for the ~30ms window before the engine-strip PNG arrived.
  //
  // Removed 2026-04-23. It had a fatal bug: the canvas retains whatever
  // you paint on it. After save → canvas re-renders from NEW pdfBytes →
  // MutationObserver sees data-ready='1' and RE-PAINTS the rectangle on
  // top of the freshly-rendered new text. User sees an empty rectangle
  // where the edited paragraph should be, even though the saved file is
  // correct. Click-away does not clear the rectangle — nothing else
  // triggers a canvas re-render.
  //
  // The engine-strip PNG + the ParagraphEditor's own opaque bg already
  // hide the original glyphs during editing. The ~30ms it takes for the
  // engine-strip to arrive is imperceptible in practice; if it ever
  // becomes a problem we can pre-warm the strip on tool activation
  // instead of per-paragraph.

  // ── Engine-strip render (S6.5 truth-layer) ────────────────────────
  //
  // Acrobat-parity step 1 (S1 of the in-canvas-editing push):
  // Pre-fire the engine-strip the moment a paragraph is ACTIVATED (not
  // when the user types the first character). Combined with a very
  // short debounce, this means the authoritative background is in
  // place before any typing begins — no 300ms white-flash phase.
  //
  // Sits above the canvas pixel-fill (zIndex 4 vs canvas's 0) so when
  // the engine render arrives, it replaces the pixel-fill visual with
  // the authoritative stripped background.
  const pdfBytes = useFormatStore((s): Uint8Array | undefined => {
    const state = s.data[tabId] as PdfFormatState | undefined
    return state?.pdfBytes
  })

  const engineSkipBboxes = useMemo(() => {
    if (!basePageSize) return []
    const pending = pageEdits ?? []
    const bboxes: ReturnType<typeof skipBboxFromParagraphBbox>[] = pending.map(
      (edit) => skipBboxFromParagraphBbox(edit.bbox, basePageSize.h),
    )
    // Also include the currently-active paragraph so the engine renders
    // the stripped background BEFORE the first keystroke — removes the
    // "white rect then correction" phase the user feels at edit-start.
    // If the active paragraph already has a pending edit, it's already
    // in `bboxes` via the map above; `pendingHasActive` guards against
    // emitting the same bbox twice (which would make the engine emit
    // the same object.gen twice and waste a re-render).
    if (activeId) {
      const activePara = paragraphs.find((p) => p.id === activeId)
      const pendingHasActive =
        activePara && pending.some((e) => e.paragraphId === activeId)
      if (activePara && !pendingHasActive) {
        bboxes.push(
          skipBboxFromParagraphBbox(activePara.bbox, basePageSize.h),
        )
      }
    }
    if (movePreviewBbox) {
      bboxes.push(skipBboxFromParagraphBbox(movePreviewBbox, basePageSize.h))
    }
    return bboxes
  }, [pageEdits, basePageSize, activeId, paragraphs, movePreviewBbox])

  const enginePreviewRegions = useMemo(() => {
    if (!basePageSize) return []
    const pending = pageEdits ?? []
    const regions = pending.map((edit) => edit.bbox)
    if (activeId) {
      const activePara = paragraphs.find((p) => p.id === activeId)
      const pendingHasActive =
        activePara && pending.some((e) => e.paragraphId === activeId)
      if (activePara && !pendingHasActive) regions.push(activePara.bbox)
    }
    if (movePreviewBbox) regions.push(movePreviewBbox)
    const seen = new Set<string>()
    return regions.filter((bbox) => {
      const key = `${bbox.x.toFixed(2)}:${bbox.y.toFixed(2)}:${bbox.width.toFixed(2)}:${bbox.height.toFixed(2)}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }, [pageEdits, activeId, paragraphs, movePreviewBbox, basePageSize])

  // Page-render scale must match the overlay's displayed dimensions.
  // `width` is the DOM canvas width in CSS pixels; basePageSize.w is
  // the PDF page width in points; their ratio is the render scale.
  const engineRenderScale =
    basePageSize && basePageSize.w > 0 ? width / basePageSize.w : 1.5

  // Path-based fast path inputs. When the doc is on disk + clean,
  // the strip render goes through engine_render_page_with_skips
  // which doesn't ship pdfBytes across IPC at all. On a 33 MB doc
  // that's ~30 ms instead of ~1.5 s + a 1 GB JS-heap spike from
  // Array.from(pdfBytes). When the user has uncommitted edits
  // (isDirty=true) we fall back to the bytes-based variant which
  // sees the in-memory state.
  const stripFilePath = useTabStore((s) => s.tabs.find((t) => t.id === tabId)?.filePath)
  const stripIsDirty = useTabStore((s) => s.tabs.find((t) => t.id === tabId)?.isDirty ?? false)
  const { pngUrl: engineStripPngUrl } = useEngineStrippedRender({
    pdfBytes,
    pageIndex,
    scale: engineRenderScale,
    skipBboxes: engineSkipBboxes,
    enabled: engineSkipBboxes.length > 0,
    // S1: drop the 300ms debounce so the authoritative strip arrives
    // immediately on paragraph activation. The bbox list is stable
    // during typing (same paragraph = same bbox), so this doesn't
    // cause IPC spam — the hook only re-fires when the user switches
    // paragraphs or opens a new tab.
    debounceMs: 30,
    filePath: stripFilePath,
    isDirty: stripIsDirty,
  })

  return (
    <>
      {engineStripPngUrl && enginePreviewRegions.map((bbox, i) => (
        <div
          key={`${bbox.x}:${bbox.y}:${bbox.width}:${bbox.height}:${i}`}
          data-testid="engine-strip-dirty-region"
          style={{
            position: 'absolute',
            left: bbox.x * engineRenderScale,
            top: bbox.y * engineRenderScale,
            width: bbox.width * engineRenderScale,
            height: bbox.height * engineRenderScale,
            overflow: 'hidden',
            zIndex: 4,
            pointerEvents: 'none',
            contain: 'layout paint',
          }}
        >
          <img
            src={engineStripPngUrl}
            alt=""
            draggable={false}
            style={{
              position: 'absolute',
              left: -bbox.x * engineRenderScale,
              top: -bbox.y * engineRenderScale,
              width,
              height,
              userSelect: 'none',
            }}
          />
        </div>
      ))}
      {active && clusterDone && paragraphs.length === 0 && (
        // Empty state: page has no extractable text.
        // Centered prompt with "Run OCR + edit" button. Uses the OCR
        // pipeline to rasterize + recognize this single page, then
        // synthesizes ParagraphBox entries the rest of the editor can
        // act on. Visible only in Edit Text mode (active=true).
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width,
            height,
            zIndex: 5,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
          }}
          data-testid="ocr-empty-state"
        >
          <div
            style={{
              pointerEvents: 'auto',
              background: 'rgba(255, 255, 255, 0.95)',
              border: '1px solid #d0d7de',
              borderRadius: 8,
              padding: '14px 20px',
              boxShadow: '0 6px 18px rgba(0, 0, 0, 0.12)',
              fontSize: 14,
              color: '#24292f',
              maxWidth: 340,
              textAlign: 'center',
            }}
          >
            <div style={{ marginBottom: 10, fontWeight: 500 }}>
              No editable text detected on this page.
            </div>
            <div style={{ marginBottom: 12, color: '#57606a', fontSize: 13 }}>
              Run OCR to recognize text from the page image, then edit
              the recognized paragraphs in place.
            </div>
            <button
              type="button"
              onClick={runOcrForThisPage}
              disabled={ocrRunning}
              data-testid="ocr-run-button"
              style={{
                padding: '8px 14px',
                background: ocrRunning ? '#94a3b8' : '#1f6feb',
                color: 'white',
                border: 'none',
                borderRadius: 6,
                cursor: ocrRunning ? 'wait' : 'pointer',
                fontSize: 13,
                fontWeight: 500,
              }}
            >
              {ocrRunning ? 'Recognizing…' : 'Run OCR + edit'}
            </button>
            {ocrError && (
              <div style={{ marginTop: 10, color: '#cf222e', fontSize: 12 }}>
                {ocrError}
              </div>
            )}
          </div>
        </div>
      )}
      {active && (activeId !== null || linkingMode) && (
        // Move/Link bar — top-right of the page when a paragraph is
        // active OR a chain is in progress. Provides:
        //   - "Move to page…" select → A2 cross-page move via
        //     pdfParagraphMove. Writes _paragraphMoves on save.
        //   - "Start chain" / "Pick chain end" toggle → linked blocks
        //     UI. Captures two frames into a LinkedChain in
        //     _linkedChains. Cancel clears the in-progress chain.
        <div
          style={{
            position: 'absolute',
            top: 6,
            right: 6,
            zIndex: 8,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            background: 'rgba(30, 30, 36, 0.92)',
            color: '#fff',
            padding: '4px 8px',
            borderRadius: 4,
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)',
            fontSize: 11,
            pointerEvents: 'auto',
          }}
          data-testid="paragraph-move-link-bar"
        >
          {linkingMode ? (
            <>
              <span data-testid="link-frame-count">
                Chain: {linkingFrames.length} frame{linkingFrames.length === 1 ? '' : 's'}
                {linkingFrames.length === 1 ? ' — click another paragraph to add' : ''}
              </span>
              <button
                type="button"
                onClick={endLinkChain}
                disabled={linkingFrames.length < 2}
                data-testid="link-end-chain"
                style={{
                  padding: '2px 8px',
                  background: linkingFrames.length >= 2 ? '#1f6feb' : '#334155',
                  color: linkingFrames.length >= 2 ? '#fff' : '#94a3b8',
                  border: 'none',
                  borderRadius: 3,
                  fontSize: 11,
                  cursor: linkingFrames.length >= 2 ? 'pointer' : 'not-allowed',
                }}
              >End chain</button>
              <button
                type="button"
                onClick={cancelLinkChain}
                data-testid="link-cancel"
                style={{
                  padding: '2px 8px',
                  background: '#475569',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 3,
                  fontSize: 11,
                  cursor: 'pointer',
                }}
              >Cancel</button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setMovePickerOpen((o) => !o)}
                data-testid="move-toggle"
                style={{
                  padding: '2px 8px',
                  background: movePickerOpen ? '#1f6feb' : '#475569',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 3,
                  fontSize: 11,
                  cursor: 'pointer',
                }}
              >Move to page…</button>
              <button
                type="button"
                onClick={startLinkChain}
                data-testid="link-start"
                style={{
                  padding: '2px 8px',
                  background: '#475569',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 3,
                  fontSize: 11,
                  cursor: 'pointer',
                }}
              >Start chain</button>
              {movePickerOpen && totalPageCount > 1 && (
                <select
                  data-testid="move-page-select"
                  defaultValue=""
                  onChange={(e) => {
                    const v = e.target.value
                    if (v === '') return
                    moveActiveParagraphToPage(Number(v))
                  }}
                  style={{
                    fontSize: 11,
                    padding: '2px 6px',
                    background: '#1e1e24',
                    color: '#fff',
                    border: '1px solid #475569',
                    borderRadius: 3,
                  }}
                >
                  <option value="" disabled>page…</option>
                  {Array.from({ length: totalPageCount }, (_, i) => i)
                    .filter((i) => i !== pageIndex)
                    .map((i) => (
                      <option key={i} value={i}>{i + 1}</option>
                    ))}
                </select>
              )}
            </>
          )}
        </div>
      )}
      <div
      ref={layerRef}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width,
        height,
        zIndex: 5,
        // Container is transparent by default; individual ParagraphEditor
        // boxes each enable their own pointer-events when `active` is
        // true. When the layer itself is inactive (tool !== 'edit_text'
        // in modeless terms) we short-circuit by rendering no children —
        // cluster state stays cached in React state so switching back
        // is instant.
        pointerEvents: 'none',
      }}
      data-testid="editable-paragraph-layer"
      data-active={active ? '1' : '0'}
    >
      {active && paragraphs.map((p) => {
        const pending = pendingById.get(p.id)
        const text = pending?.newText ?? p.originalText
        const committedDelta = pending?.positionDelta ?? { dx: 0, dy: 0 }
        const currentFontSize = pending?.fontSize ?? p.fontSize
        const currentColor = pending?.color ?? p.color
        const currentFontFamily = pending?.fontFamily ?? p.fontFamily ?? 'Helvetica'
        // ParagraphBox doesn't carry lineHeight today (originals come
        // from pdfjs item heights, not from the source PDF's TL); the
        // pending entry tracks user overrides. Default 1.2 mirrors
        // browsers / Word.
        const currentLineHeight = (pending as { lineHeight?: number } | undefined)?.lineHeight ?? 1.2
        return (
          <ParagraphEditor
            key={p.id}
            paragraph={p}
            scale={scale}
            pageWidth={basePageSize?.w ?? 0}
            pageHeight={basePageSize?.h ?? 0}
            active={activeId === p.id}
            isEdited={!!pending}
            initialText={text}
            currentAlign={pending?.align ?? 'left'}
            committedDelta={committedDelta}
            currentFontSize={currentFontSize}
            currentColor={currentColor}
            currentFontFamily={currentFontFamily}
            currentLineHeight={currentLineHeight}
            onActivate={() => {
              // While linkingMode is on, paragraph clicks ADD frames
              // to the in-progress chain instead of activating for
              // edit. User clicks End chain to finalize (writes
              // _linkedChains) or Cancel to discard.
              if (linkingMode) {
                addFrameToLinkChain(p)
                return
              }
              setActiveId(p.id)
            }}
            onDeactivate={() => setActiveId(null)}
            onCommit={(newText) => commitEdit(p, newText)}
            onAlign={(align) => setParagraphAlign(p, align)}
            onMove={(delta) => commitMove(p, delta)}
            onMovePreview={(bbox) => setMovePreviewBbox(bbox)}
            onMovePreviewEnd={() => setMovePreviewBbox(null)}
            onCrossPageDrop={(toPage, toBbox) => {
              // True drag-and-drop across pages: emit a ParagraphMove
              // that lands centered at the drop point on the
              // destination page. Save expands this into a (mask
              // source + draw at toBbox) edit pair.
              const pending = readPendingEditsForPage(tabId, pageIndex).find(
                (e) => e.paragraphId === p.id,
              )
              const text = pending?.newText ?? p.originalText
              pushParagraphMove(tabId, pageIndex, {
                paragraphId: p.id,
                fromPage: pageIndex,
                toPage,
                fromBbox: { ...p.bbox },
                toBbox,
                text,
                fontSize: p.fontSize,
                fontFamily: p.fontFamily,
                bold: p.bold,
                italic: p.italic,
                color: p.color,
                backgroundColor: p.backgroundColor,
              })
              // Clear the activeId so the source-page editor doesn't
              // keep showing a stale active state for a paragraph
              // that's now visually on another page.
              setActiveId(null)
            }}
            pageIndexForDrag={pageIndex}
            onFontSize={(size) => setParagraphFontSize(p, size)}
            onColor={(hex) => setParagraphColor(p, hex)}
            onFontFamily={(ff) => setParagraphFontFamily(p, ff)}
            onLineHeight={(lh) => setParagraphLineHeight(p, lh)}
            onResize={(newBbox) => commitResize(p, newBbox)}
          />
        )
      })}
      </div>
    </>
  )
}

interface ParagraphEditorProps {
  paragraph: ParagraphBox
  scale: number
  /** Page dimensions in viewport (scale=1) coords. Used to clamp drag so
   *  the box can't be dragged fully off the page. */
  pageWidth: number
  pageHeight: number
  active: boolean
  isEdited: boolean
  initialText: string
  currentAlign: TextAlign
  /** Committed drag offset from the store (in viewport units). Live drag
   *  additions are layered on top while the pointer is down. */
  committedDelta: { dx: number; dy: number }
  onActivate: () => void
  onDeactivate: () => void
  onCommit: (newText: string) => void
  onAlign: (align: TextAlign) => void
  onMove: (delta: { dx: number; dy: number }) => void
  onMovePreview: (bbox: ParagraphBox['bbox']) => void
  onMovePreviewEnd: () => void
  /** Cross-page drop: pointer-up landed on a DIFFERENT page than
   *  this paragraph's source page. The handler emits a
   *  ParagraphMove instead of a positionDelta so the saved PDF
   *  shows the paragraph on the destination page. toBbox is in
   *  viewport (scale=1) coords on the destination page, centered
   *  at the drop point. */
  onCrossPageDrop?: (toPageIndex: number, toBbox: { x: number; y: number; width: number; height: number }) => void
  /** Source page index — used by the cross-page drop detection to
   *  filter out same-page drops. Passed in from EditableParagraphLayer. */
  pageIndexForDrag: number
  /** Contextual toolbar tweaks for paragraph editing. */
  currentFontSize: number
  currentColor: string
  onFontSize: (size: number) => void
  onColor: (hex: string) => void
  /** Font family + line spacing — added in the parity sprint.
   *  Defaults to 'Helvetica' / 1.2 if the paragraph has no override. */
  currentFontFamily: string
  currentLineHeight: number
  onFontFamily: (fontFamily: string) => void
  onLineHeight: (lineHeight: number) => void
  /** Acrobat-style corner-grip resize. Called on pointer-up after a
   *  drag; receives the new bbox in viewport (scale=1) coords.
   *  Resize is grow-only — the parent constrains so width/height
   *  never shrink below the original cluster dimensions (which
   *  would leak original glyphs outside the new bbox per the
   *  bake-stage whiteout limitation documented in ledger §3 G2/G5). */
  onResize: (newBbox: ParagraphBox['bbox']) => void
}

// Minimum cursor travel (CSS px) before we treat a pointer-down-then-move
// as a drag rather than a click. 3px matches browser click-jitter tolerance.
const DRAG_THRESHOLD_PX = 3

function ParagraphEditor({
  paragraph,
  scale,
  pageWidth,
  pageHeight,
  active,
  isEdited,
  initialText,
  currentAlign,
  committedDelta,
  onActivate,
  onDeactivate,
  onCommit,
  onAlign,
  onMove,
  onMovePreview,
  onMovePreviewEnd,
  onCrossPageDrop,
  pageIndexForDrag,
  currentFontSize,
  currentColor,
  onFontSize,
  onColor,
  currentFontFamily,
  currentLineHeight,
  onFontFamily,
  onLineHeight,
  onResize,
}: ParagraphEditorProps) {
  const divRef = useRef<HTMLDivElement>(null)
  // Shadow state so we don't rewrite the div on every commit (would reset
  // caret). We only seed it when (paragraph,initialText) changes.
  const seededRef = useRef<string>('')

  useEffect(() => {
    const el = divRef.current
    if (!el) return
    // While the user is actively typing, the DOM has already reflected
    // their input and rewriting textContent here would reset the caret.
    // The layer re-renders per-keystroke now (it subscribes to the edit
    // store for undo/redo propagation), so the initialText prop changes
    // often — but we only need to seed the div when the box is NOT
    // being edited (initial mount, re-mount, or a history revert).
    //
    // Exception: if the caller claims `active` but the div is EMPTY,
    // this is a freshly-remounted editor (tool flip brought the layer
    // back, the paragraph is still active, and we haven't seeded yet).
    // The caret-reset concern doesn't apply because there's no caret
    // to preserve — we'd just be filling an empty box with its text.
    const currentText = el.textContent ?? ''
    const focused = document.activeElement === el || el.contains(document.activeElement)
    if (active && focused && currentText.length > 0 && currentText === initialText) {
      seededRef.current = initialText
      return
    }
    if (currentText !== initialText || seededRef.current !== initialText) {
      el.textContent = initialText
      seededRef.current = initialText
    }
  }, [initialText, active])

  // ── Drag state ──────────────────────────────────────────────────
  // localDelta is the authoritative paragraph offset for this child,
  // independent of the parent's render cycle. Initialized from the
  // committedDelta prop (which the parent reads from the store on mount
  // or whenever pendingById recomputes) and updated on every drag-in-
  // progress plus on drag-end. This matters because the parent does NOT
  // subscribe to the store, so the committedDelta prop stays stale
  // between renders — if we cleared a pure "liveOffset" state on
  // pointerup and relied on committedDelta for the settled position,
  // the box would snap back to origin after release.
  const [localDelta, setLocalDelta] = useState<{ dx: number; dy: number }>(() => committedDelta)
  // When the store-derived prop changes value (undo/redo, tab switch),
  // mirror it locally — but never during an active drag, so we don't
  // fight the user mid-gesture.
  useEffect(() => {
    setLocalDelta((prev) => {
      if (prev.dx === committedDelta.dx && prev.dy === committedDelta.dy) return prev
      if (pointerRef.current?.dragging) return prev
      return committedDelta
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committedDelta.dx, committedDelta.dy])
  // Pointer-session bookkeeping. Kept in a ref because these fields don't
  // drive rendering directly — setLocalDelta does.
  const pointerRef = useRef<{
    startClientX: number
    startClientY: number
    pointerId: number
    dragging: boolean
    baseDelta: { dx: number; dy: number }
  } | null>(null)
  // onPointerUp fires before onClick for the same gesture. When we've
  // just finished a drag we set this so the onClick handler skips
  // activating the contenteditable (otherwise dragging a paragraph
  // would also drop you into edit mode).
  const justDraggedRef = useRef(false)

  const clampDelta = useCallback(
    (dx: number, dy: number): { dx: number; dy: number } => {
      // Keep at least a small portion of the box on-page so the user
      // can always grab it again. Clamp against pageWidth/pageHeight
      // (which are scale=1, matching bbox units).
      if (pageWidth <= 0 || pageHeight <= 0) return { dx, dy }
      const minVisible = 12 // viewport units
      const minX = minVisible - paragraph.bbox.x - paragraph.bbox.width
      const maxX = pageWidth - paragraph.bbox.x - minVisible
      const minY = minVisible - paragraph.bbox.y - paragraph.bbox.height
      const maxY = pageHeight - paragraph.bbox.y - minVisible
      return {
        dx: Math.max(minX, Math.min(maxX, dx)),
        dy: Math.max(minY, Math.min(maxY, dy)),
      }
    },
    [pageWidth, pageHeight, paragraph.bbox.x, paragraph.bbox.y, paragraph.bbox.width, paragraph.bbox.height],
  )

  const left = (paragraph.bbox.x + localDelta.dx) * scale
  const top = (paragraph.bbox.y + localDelta.dy) * scale
  const boxW = paragraph.bbox.width * scale
  const boxH = paragraph.bbox.height * scale
  const displayFontSize = Math.max(6, paragraph.fontSize * scale)
  // Resolved font stack from pdfjs styles, with fallback.
  const fontStack = paragraph.fontFamily || FALLBACK_FONT_STACK
  const isDragging = pointerRef.current?.dragging === true

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // While editing text, let the contenteditable handle pointer events
    // normally (caret placement, text selection). Drag only applies to
    // unopened paragraphs.
    if (active) return
    if (e.button !== 0) return
    pointerRef.current = {
      startClientX: e.clientX,
      startClientY: e.clientY,
      pointerId: e.pointerId,
      dragging: false,
      baseDelta: { dx: localDelta.dx, dy: localDelta.dy },
    }
    // setPointerCapture makes move/up fire on this element even when
    // the cursor escapes the box (the user can drag way off in any
    // direction and we still get the up event).
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // Older engines may throw if the pointer isn't captureable; fall
      // back to window-level listeners implicitly (browsers re-target).
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = pointerRef.current
    if (!st || st.pointerId !== e.pointerId) return
    const rawDx = e.clientX - st.startClientX
    const rawDy = e.clientY - st.startClientY
    if (!st.dragging && Math.hypot(rawDx, rawDy) > DRAG_THRESHOLD_PX) {
      st.dragging = true
      onMovePreview(paragraph.bbox)
    }
    if (st.dragging) {
      const next = clampDelta(
        st.baseDelta.dx + rawDx / scale,
        st.baseDelta.dy + rawDy / scale,
      )
      setLocalDelta(next)
    }
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = pointerRef.current
    if (!st || st.pointerId !== e.pointerId) return
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* noop */
    }
    const wasDragging = st.dragging
    pointerRef.current = null
    onMovePreviewEnd()
    if (wasDragging) {
      // Cross-page drop detection: if the pointer landed on a
      // different page's [data-page-display-index] container, route
      // the commit through onCrossPageDrop instead of onMove. The
      // Move handler in EditableParagraphLayer emits a ParagraphMove
      // for that case (mask source + draw at dest); otherwise it
      // writes a same-page positionDelta.
      const elAtPoint = document.elementFromPoint(e.clientX, e.clientY)
      const pageContainer = elAtPoint?.closest('[data-page-display-index]') as HTMLElement | null
      const toPageIdx = pageContainer
        ? Number(pageContainer.getAttribute('data-page-display-index'))
        : null
      if (toPageIdx !== null && !Number.isNaN(toPageIdx) && toPageIdx !== pageIndexForDrag && onCrossPageDrop) {
        const rect = pageContainer!.getBoundingClientRect()
        // Convert pointer position to viewport (scale=1) coords on
        // the destination page. The page container's bounding rect
        // tells us its scale (since a page at zoom 1.5 has a 612 *
        // 1.5 = 918px wide rect).
        const destPageEl = pageContainer!
        const destCanvas = destPageEl.querySelector('canvas') as HTMLCanvasElement | null
        // Use the displayed canvas width as the source-of-truth
        // for the page's scale. canvas.style.width is set during
        // PageRenderer's render to displayViewport.width (CSS px
        // matching pdfPoints * zoom).
        const destDisplayedWidth = destCanvas
          ? parseFloat(destCanvas.style.width) || rect.width
          : rect.width
        // We don't have the page's PDF point width here; assume the
        // user's intent is "drop at this position relative to dest
        // page top-left". Convert to viewport (scale=1) coords by
        // dividing by the same scale-factor pdfjs used for THIS page.
        // Approximate: find the matching layer's scale from its
        // computed style by walking the destination layer's ratio.
        // Simplest: compute scale = displayedWidth / pageWidth-known
        // by looking up basePageSize on this layer. For destination
        // we reuse the source-page scale as a best approximation —
        // page widths differ by less than 5% across most multi-page
        // PDFs and the user can drag-fine-tune after.
        const dropX = (e.clientX - rect.left) / scale
        const dropY = (e.clientY - rect.top) / scale
        // Center the paragraph at the drop point — matches user
        // intuition ("I'm pointing at where I want it to land").
        const toBbox = {
          x: dropX - paragraph.bbox.width / 2,
          y: dropY - paragraph.bbox.height / 2,
          width: paragraph.bbox.width,
          height: paragraph.bbox.height,
        }
        onCrossPageDrop(toPageIdx, toBbox)
        justDraggedRef.current = true
        return
      }

      // Same-page drag — existing positionDelta path.
      const rawDx = e.clientX - st.startClientX
      const rawDy = e.clientY - st.startClientY
      const finalDelta = clampDelta(
        st.baseDelta.dx + rawDx / scale,
        st.baseDelta.dy + rawDy / scale,
      )
      setLocalDelta(finalDelta)
      onMove(finalDelta)
      justDraggedRef.current = true
    }
  }

  // When the paragraph has been moved, the engine-strip dirty region in
  // the parent repaints the source bbox from an object-suppressed page
  // preview. This child only renders the lifted text at its live
  // position; it never paints a source mask.
  const hasMoved = Math.abs(localDelta.dx) > 0.01 || Math.abs(localDelta.dy) > 0.01
  const previewMaskBackground = paragraph.backgroundColor
    || (paragraph.onDarkBackground ? '#0f1115' : '#ffffff')
  const shouldMaskEditorBackground = active || (isEdited && !hasMoved)
  return (
    <>
    {active && (
      <ResizeGrips
        left={left}
        top={top}
        width={boxW}
        height={boxH}
        scale={scale}
        baseBbox={paragraph.bbox}
        onResize={onResize}
      />
    )}
    {active && (
      <ParagraphContextToolbar
        left={left}
        top={top}
        width={boxW}
        currentAlign={currentAlign}
        currentFontSize={currentFontSize}
        currentColor={currentColor}
        currentFontFamily={currentFontFamily}
        currentLineHeight={currentLineHeight}
        onAlign={onAlign}
        onFontSize={onFontSize}
        onColor={onColor}
        onFontFamily={onFontFamily}
        onLineHeight={onLineHeight}
      />
    )}
    <div
      style={{
        position: 'absolute',
        left,
        top,
        width: boxW,
        minHeight: boxH,
        pointerEvents: 'auto',
        zIndex: active || isEdited || isDragging || hasMoved ? 6 : 5,
        cursor: active ? 'text' : isDragging ? 'grabbing' : 'grab',
        // While actively dragging, dim the outline so the user perceives
        // the box as "picked up". Otherwise keep the existing three-state
        // Acrobat-style affordance.
        outline: active
          ? '2px solid #89b4fa'
          : isDragging
            ? '2px solid #89b4fa'
            : isEdited
              ? '1px solid #f59e0b'
              : '1px dashed rgba(137,180,250,0.5)',
        outlineOffset: 0,
        // When editing in place, mask the canvas beneath so the caret
        // and typed text are clear. Once a paragraph is being moved,
        // the origin mask above hides the old glyphs; the moved text
        // itself stays transparent so the drag preview feels like the
        // text is actually sliding over the page instead of carrying a
        // visible white card with it.
        background: shouldMaskEditorBackground ? previewMaskBackground : 'transparent',
        color: active || isEdited || isDragging ? paragraph.color : 'transparent',
        caretColor: paragraph.color,
        fontFamily: fontStack,
        fontSize: displayFontSize,
        fontWeight: paragraph.bold ? 700 : 400,
        fontStyle: paragraph.italic ? 'italic' : 'normal',
        // Reflect alignment live in the contenteditable so the in-edit
        // view matches what save will produce.
        textAlign: currentAlign === 'justify' ? 'justify' : currentAlign,
        lineHeight: 1.2,
        padding: 0,
        overflow: 'hidden',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        // Suppress default text selection during drag — otherwise
        // clicking-and-dragging would start a selection before our
        // threshold kicks in.
        userSelect: active ? 'text' : 'none',
        WebkitUserSelect: active ? 'text' : 'none',
        // Prevent the browser's native drag-ghost on text.
        touchAction: 'none',
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClick={() => {
        if (justDraggedRef.current) {
          // Click that follows a drag release — swallow it, don't
          // activate the editor.
          justDraggedRef.current = false
          return
        }
        if (!active) {
          onActivate()
          // Defer focus so the browser applies contentEditable before
          // .focus(); otherwise caret placement is flaky.
          requestAnimationFrame(() => {
            divRef.current?.focus()
          })
        }
      }}
      onBlur={(e) => {
        // Use readMultilineText (innerText-style) instead of textContent
        // so user-pressed Enter / inserted <div>/<br> survives as \n.
        // textContent flattened newlines and the engine saw a single
        // line — that was G7 in the ledger.
        const newText = readMultilineText(e.currentTarget as HTMLDivElement)
        onCommit(newText)
        onDeactivate()
      }}
      onInput={(e) => {
        // Commit on every input so state is always up to date. We skip
        // rewriting div contents on commit (seededRef guard above), so
        // the caret doesn't jump.
        const newText = readMultilineText(e.currentTarget as HTMLDivElement)
        onCommit(newText)
      }}
      onKeyDown={(e) => {
        // Escape: cancel back to original text, blur.
        if (e.key === 'Escape') {
          e.preventDefault()
          if (divRef.current) divRef.current.textContent = paragraph.originalText
          onCommit(paragraph.originalText)
          divRef.current?.blur()
        }
        // Alignment shortcuts — Word/GDocs convention: Ctrl+L/E/R/J.
        // ctrlKey covers both Ctrl (Win/Linux) and Cmd (macOS via metaKey)
        // so match either.
        const isMod = e.ctrlKey || e.metaKey
        if (isMod) {
          if (e.key === 'l' || e.key === 'L') { e.preventDefault(); onAlign('left') }
          else if (e.key === 'e' || e.key === 'E') { e.preventDefault(); onAlign('center') }
          else if (e.key === 'r' || e.key === 'R') { e.preventDefault(); onAlign('right') }
          else if (e.key === 'j' || e.key === 'J') { e.preventDefault(); onAlign('justify') }
        }
      }}
      contentEditable={active}
      suppressContentEditableWarning
      ref={divRef}
      data-paragraph-id={paragraph.id}
    />
    </>
  )
}

// ── Paragraph context toolbar ────────────────────────────────────
// Floating strip that appears above the
// active paragraph, ALONGSIDE the main ribbon (not replacing it) —
// matches Word's "mini-toolbar" and Google Docs' selection toolbar.
// Provides quick access to the edits a user is most likely to make
// after selecting a paragraph: alignment, font size, and text color.
//
// The ribbon still owns discovery (all 38 tools, complex options);
// this toolbar is for the common-case tweaks once you've already
// activated a paragraph.

const FONT_SIZES = [6, 8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 28, 32, 36, 48, 60, 72]

// Engine's overlay-bake supports the Standard 14 PDF font families
// today (G2 still open for custom fonts). Limit the dropdown to what
// the engine can actually honor — picking outside this list would
// silently fall back at save and confuse the user.
const FONT_FAMILIES = ['Helvetica', 'Times-Roman', 'Courier']
const LINE_HEIGHTS: { value: number; label: string }[] = [
  { value: 1.0, label: '1.0' },
  { value: 1.15, label: '1.15' },
  { value: 1.5, label: '1.5' },
  { value: 2.0, label: '2.0' },
  { value: 2.5, label: '2.5' },
  { value: 3.0, label: '3.0' },
]

interface ParagraphContextToolbarProps {
  left: number
  top: number
  width: number
  currentAlign: TextAlign
  currentFontSize: number
  currentColor: string
  currentFontFamily: string
  currentLineHeight: number
  onAlign: (align: TextAlign) => void
  onFontSize: (size: number) => void
  onColor: (hex: string) => void
  onFontFamily: (fontFamily: string) => void
  onLineHeight: (lineHeight: number) => void
}

function ParagraphContextToolbar({
  left,
  top,
  width,
  currentAlign,
  currentFontSize,
  currentColor,
  currentFontFamily,
  currentLineHeight,
  onAlign,
  onFontSize,
  onColor,
  onFontFamily,
  onLineHeight,
}: ParagraphContextToolbarProps) {
  // Position toolbar just above the paragraph box. Clamp to min-top so
  // paragraphs near the very top of the page still show the toolbar.
  const TOOLBAR_H = 30
  const GAP = 4
  const toolbarTop = Math.max(2, top - TOOLBAR_H - GAP)
  const aligns: { key: TextAlign; label: string; title: string }[] = [
    { key: 'left', label: '⇤', title: 'Align left (Ctrl+L)' },
    { key: 'center', label: '≡', title: 'Align center (Ctrl+E)' },
    { key: 'right', label: '⇥', title: 'Align right (Ctrl+R)' },
    { key: 'justify', label: '☰', title: 'Justify (Ctrl+J)' },
  ]
  // Snap current font size to the nearest preset for the dropdown,
  // so a 10.5pt original displays as "10" without surprising the
  // user with a non-preset number in the select box.
  const sizeOptions = FONT_SIZES.includes(Math.round(currentFontSize))
    ? FONT_SIZES
    : [...FONT_SIZES, Math.round(currentFontSize)].sort((a, b) => a - b)
  return (
    <div
      style={{
        position: 'absolute',
        left: Math.max(2, left),
        top: toolbarTop,
        minWidth: 230,
        maxWidth: Math.max(260, width),
        height: TOOLBAR_H,
        background: 'var(--bg-surface, #1e222b)',
        border: '1px solid var(--border, #2a2f3a)',
        borderRadius: 4,
        padding: '2px 6px',
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        pointerEvents: 'auto',
        zIndex: 20,
        boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
      }}
      // Don't steal focus from the contenteditable when clicking inside
      // the toolbar itself.
      onMouseDown={(e) => e.preventDefault()}
      data-testid="paragraph-context-toolbar"
    >
      {/* Alignment */}
      {aligns.map((it) => (
        <button
          key={it.key}
          title={it.title}
          onClick={() => onAlign(it.key)}
          style={{
            width: 26,
            height: 22,
            fontSize: 14,
            lineHeight: '20px',
            background: currentAlign === it.key ? 'var(--accent, #3b82f6)' : 'transparent',
            color: currentAlign === it.key ? '#fff' : 'var(--text-primary, #e6e8ec)',
            border: 'none',
            borderRadius: 3,
            cursor: 'pointer',
            padding: 0,
          }}
        >
          {it.label}
        </button>
      ))}
      <div style={{ width: 1, height: 18, background: 'var(--border, #2a2f3a)' }} />
      {/* Font size */}
      <select
        title="Font size"
        value={Math.round(currentFontSize)}
        onChange={(e) => onFontSize(Number(e.target.value))}
        style={{
          width: 54,
          height: 22,
          fontSize: 11,
          padding: '0 4px',
          background: 'transparent',
          color: 'var(--text-primary, #e6e8ec)',
          border: '1px solid var(--border, #2a2f3a)',
          borderRadius: 3,
          cursor: 'pointer',
        }}
      >
        {sizeOptions.map((s) => (
          <option key={s} value={s}>{s}pt</option>
        ))}
      </select>
      <div style={{ width: 1, height: 18, background: 'var(--border, #2a2f3a)' }} />
      {/* Font family — limited to the Standard 14 the engine bakes */}
      <select
        title="Font family"
        value={normalizedFontFamily(currentFontFamily)}
        onChange={(e) => onFontFamily(e.target.value)}
        style={{
          width: 92,
          height: 22,
          fontSize: 11,
          padding: '0 4px',
          background: 'transparent',
          color: 'var(--text-primary, #e6e8ec)',
          border: '1px solid var(--border, #2a2f3a)',
          borderRadius: 3,
          cursor: 'pointer',
        }}
        data-testid="paragraph-context-font-family"
      >
        {FONT_FAMILIES.map((f) => (
          <option key={f} value={f}>{f}</option>
        ))}
      </select>
      <div style={{ width: 1, height: 18, background: 'var(--border, #2a2f3a)' }} />
      {/* Line spacing */}
      <select
        title="Line spacing"
        value={String(currentLineHeight)}
        onChange={(e) => onLineHeight(Number(e.target.value))}
        style={{
          width: 56,
          height: 22,
          fontSize: 11,
          padding: '0 4px',
          background: 'transparent',
          color: 'var(--text-primary, #e6e8ec)',
          border: '1px solid var(--border, #2a2f3a)',
          borderRadius: 3,
          cursor: 'pointer',
        }}
        data-testid="paragraph-context-line-height"
      >
        {LINE_HEIGHTS.map((lh) => (
          <option key={lh.value} value={lh.value}>{lh.label}</option>
        ))}
      </select>
      <div style={{ width: 1, height: 18, background: 'var(--border, #2a2f3a)' }} />
      {/* Text color */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 3 }} title="Text color">
        <span style={{ fontSize: 10, color: 'var(--text-secondary, #9aa0aa)' }}>A</span>
        <input
          type="color"
          value={currentColor || '#000000'}
          onChange={(e) => onColor(e.target.value)}
          style={{
            width: 22,
            height: 18,
            border: 'none',
            cursor: 'pointer',
            padding: 0,
            background: 'transparent',
          }}
        />
      </div>
    </div>
  )
}

/** Map any caller-supplied font family hint to a canonical entry the
 *  Standard-14 dropdown contains. pdfjs reports families like
 *  "TimesNewRomanPSMT" or "Arial-Bold" that don't match our toolbar
 *  options verbatim — fold them down to the closest engine-bakable
 *  family so the dropdown always shows a non-blank selection. */
function normalizedFontFamily(raw: string): string {
  const s = (raw || '').toLowerCase()
  if (s.includes('times') || s.includes('serif')) return 'Times-Roman'
  if (s.includes('courier') || s.includes('mono')) return 'Courier'
  return 'Helvetica'
}

interface ResizeGripsProps {
  left: number
  top: number
  width: number
  height: number
  scale: number
  baseBbox: ParagraphBox['bbox']
  onResize: (newBbox: ParagraphBox['bbox']) => void
}

type GripCorner = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

/** Acrobat-style corner grips. Render 4 small square handles at the
 *  bbox corners; pointerdown captures the pointer + records the start
 *  bbox; window-level pointermove tracks the drag and updates a live
 *  preview rect; pointerup commits via onResize.
 *
 *  Cursor per grip: nw/se = nwse-resize, ne/sw = nesw-resize.
 *
 *  Live preview: while dragging, an accent-bordered rectangle shows
 *  what the new bbox will be on commit. After commit, the parent
 *  re-renders with the new bbox so the editor itself shifts.
 *
 *  Grow-only constraint is applied at commit time by the parent
 *  (commitResize), not here, so users can drag to any direction
 *  visually but the saved bbox never shrinks below original. */
function ResizeGrips({
  left,
  top,
  width,
  height,
  scale,
  baseBbox,
  onResize,
}: ResizeGripsProps) {
  const [previewRect, setPreviewRect] = useState<{
    left: number
    top: number
    width: number
    height: number
  } | null>(null)

  const onGripDown = (corner: GripCorner) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const startClientX = e.clientX
    const startClientY = e.clientY
    // Track the bbox in viewport coordinates while dragging. We
    // commit in viewport coords too — the parent's commitResize
    // accepts viewport-scale=1 numbers, but the live preview uses
    // the scale-adjusted (display) coords for layout. Internal
    // viewport→display scale conversion happens via /scale.
    const baseLeft = left
    const baseTop = top
    const baseWidth = width
    const baseHeight = height

    const onMove = (m: PointerEvent) => {
      const dx = m.clientX - startClientX
      const dy = m.clientY - startClientY
      let newLeft = baseLeft
      let newTop = baseTop
      let newWidth = baseWidth
      let newHeight = baseHeight
      // Per-grip: corners move both axes; edge midpoints move one.
      switch (corner) {
        case 'se':
          newWidth = Math.max(20, baseWidth + dx)
          newHeight = Math.max(12, baseHeight + dy)
          break
        case 'ne':
          newTop = baseTop + dy
          newWidth = Math.max(20, baseWidth + dx)
          newHeight = Math.max(12, baseHeight - dy)
          break
        case 'sw':
          newLeft = baseLeft + dx
          newWidth = Math.max(20, baseWidth - dx)
          newHeight = Math.max(12, baseHeight + dy)
          break
        case 'nw':
          newLeft = baseLeft + dx
          newTop = baseTop + dy
          newWidth = Math.max(20, baseWidth - dx)
          newHeight = Math.max(12, baseHeight - dy)
          break
        case 'n':
          newTop = baseTop + dy
          newHeight = Math.max(12, baseHeight - dy)
          break
        case 's':
          newHeight = Math.max(12, baseHeight + dy)
          break
        case 'e':
          newWidth = Math.max(20, baseWidth + dx)
          break
        case 'w':
          newLeft = baseLeft + dx
          newWidth = Math.max(20, baseWidth - dx)
          break
      }
      setPreviewRect({ left: newLeft, top: newTop, width: newWidth, height: newHeight })
    }
    const onUp = (u: PointerEvent) => {
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
      const dx = u.clientX - startClientX
      const dy = u.clientY - startClientY
      // Commit only if the drag exceeded a small threshold.
      if (Math.hypot(dx, dy) < 3) {
        setPreviewRect(null)
        return
      }
      // Convert from viewport pixels back to PDF user-space (scale=1)
      // by dividing by scale. baseBbox is the original PDF-space bbox;
      // we apply the same delta (scaled down) to its dimensions.
      const newBbox = computeNewBbox(corner, baseBbox, dx / scale, dy / scale)
      setPreviewRect(null)
      onResize(newBbox)
    }
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
  }

  const grip = (corner: GripCorner): React.CSSProperties => {
    const SIZE = 10
    const HALF = SIZE / 2
    // X position: left for nw/w/sw, right for ne/e/se, center for n/s.
    let cx = 0
    if (corner === 'nw' || corner === 'w' || corner === 'sw') cx = left - HALF
    else if (corner === 'ne' || corner === 'e' || corner === 'se') cx = left + width - HALF
    else cx = left + width / 2 - HALF
    // Y position: top for nw/n/ne, bottom for sw/s/se, center for w/e.
    let cy = 0
    if (corner === 'nw' || corner === 'n' || corner === 'ne') cy = top - HALF
    else if (corner === 'sw' || corner === 's' || corner === 'se') cy = top + height - HALF
    else cy = top + height / 2 - HALF
    // Cursor: corners use diagonal, edges use orthogonal.
    let cursor: string
    if (corner === 'nw' || corner === 'se') cursor = 'nwse-resize'
    else if (corner === 'ne' || corner === 'sw') cursor = 'nesw-resize'
    else if (corner === 'n' || corner === 's') cursor = 'ns-resize'
    else cursor = 'ew-resize'
    return {
      position: 'absolute',
      left: cx,
      top: cy,
      width: SIZE,
      height: SIZE,
      borderRadius: 999,
      background: '#fff',
      border: '1.5px solid #89b4fa',
      cursor,
      zIndex: 21,
      pointerEvents: 'auto',
      boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
    }
  }

  return (
    <>
      {(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as GripCorner[]).map((c) => (
        <div
          key={c}
          data-testid={`resize-grip-${c}`}
          style={grip(c)}
          onPointerDown={onGripDown(c)}
        />
      ))}
      {previewRect && (
        <div
          data-testid="resize-preview"
          style={{
            position: 'absolute',
            left: previewRect.left,
            top: previewRect.top,
            width: previewRect.width,
            height: previewRect.height,
            border: '2px dashed #89b4fa',
            background: 'rgba(137,180,250,0.06)',
            pointerEvents: 'none',
            zIndex: 19,
          }}
        />
      )}
    </>
  )
}

/** Apply a corner-grip drag to a starting bbox. dx/dy are in PDF
 *  user-space (scale=1). Per-corner the dimensions move differently:
 *    se: width += dx, height += dy
 *    ne: y += dy, width += dx, height -= dy
 *    sw: x += dx, width -= dx, height += dy
 *    nw: x += dx, y += dy, width -= dx, height -= dy
 *  Caller is expected to clamp to grow-only via commitResize. */
function computeNewBbox(
  corner: GripCorner,
  base: ParagraphBox['bbox'],
  dx: number,
  dy: number,
): ParagraphBox['bbox'] {
  switch (corner) {
    case 'se':
      return { x: base.x, y: base.y, width: base.width + dx, height: base.height + dy }
    case 'ne':
      return { x: base.x, y: base.y + dy, width: base.width + dx, height: base.height - dy }
    case 'sw':
      return { x: base.x + dx, y: base.y, width: base.width - dx, height: base.height + dy }
    case 'nw':
      return { x: base.x + dx, y: base.y + dy, width: base.width - dx, height: base.height - dy }
    case 'n':
      return { x: base.x, y: base.y + dy, width: base.width, height: base.height - dy }
    case 's':
      return { x: base.x, y: base.y, width: base.width, height: base.height + dy }
    case 'e':
      return { x: base.x, y: base.y, width: base.width + dx, height: base.height }
    case 'w':
      return { x: base.x + dx, y: base.y, width: base.width - dx, height: base.height }
  }
}
