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
import { useUIStore } from '../../stores/uiStore'
import { withReplay } from '../../stores/historyStore'
import {
  clusterParagraphs,
  getParagraphStyledRunsFromStream,
  getParagraphTextColorsFromStream,
  sampleParagraphBackgrounds,
  type ParagraphBox,
  type TextItem,
} from '../../services/pdfParagraphs'
import {
  blockedAutoReflowMessage,
  obstacleBlockedAutoReflowMessage,
} from '../../services/pdfLayoutIntelligence'
import {
  flowEditBlockedByObstacle,
  computeReflowDeltasWithReport,
  type ReflowParagraph,
} from '../../services/pdfReflow'
import {
  type ParagraphEdit,
  type TextAlign,
  type StyledRun,
  editCarriesRunStyling,
  expandParagraphBboxForDecorationMask,
  expandParagraphEditMaskForDecorations,
  paragraphStyleHasDecoration,
  syncRunsToEdit,
} from '../../services/pdfParagraphEdits'
import {
  growParagraphBboxForStyledText,
  paragraphStylePatchNeedsAutoGrow,
} from '../../services/pdfParagraphAutoGrow'
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
import {
  fabricJsonHasRedactionMarkForTarget,
  redactionMarkTargetId,
  stageElementRedactionMark,
} from '../../services/pdfRedactionMarks'
import type { PdfFormatState } from './index'

// Project the live page clusters into the lightweight shape the reflow
// service plans with, so blur-time gating runs the exact same geometric
// obstacle check the save path will run.
function toReflowParagraphs(paragraphs: ParagraphBox[]): ReflowParagraph[] {
  return paragraphs.map((p) => ({
    paragraphId: p.id,
    bbox: { ...p.bbox },
    originalText: p.originalText,
    fontSize: p.fontSize,
    fontFamily: p.fontFamily,
    layoutRole: p.layout?.role,
    layoutSafeForAutoReflow: p.layout?.safeForAutoReflow,
    layoutFlowId: p.layout?.flowId,
    layoutReasons: p.layout?.reasons,
  }))
}

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

// ── Rich-text run helpers ────────────────────────────────────────────
// Per-selection formatting stores a paragraph as StyledRun[] (see
// pdfParagraphEdits). The contentEditable is the live source of truth while
// editing: we seed it from runs (runsToHtml) and read runs back out
// (readStyledRuns); the browser owns the span DOM + caret, we only
// serialize at the boundaries. fontSize is stored in PDF pt but rendered as
// CSS px scaled by the current zoom, so px = pt * scale on the way in and
// pt = px / scale on the way out.

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** CSS color (rgb()/rgba()/#hex) → #rrggbb, or undefined when unparseable. */
function cssColorToHex(c: string | undefined | null): string | undefined {
  if (!c) return undefined
  const s = c.trim()
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase()
  if (/^#[0-9a-f]{3}$/i.test(s)) {
    return ('#' + s.slice(1).split('').map((ch) => ch + ch).join('')).toLowerCase()
  }
  const m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i)
  if (m) {
    const h = (n: string) => Math.max(0, Math.min(255, parseInt(n, 10))).toString(16).padStart(2, '0')
    return `#${h(m[1])}${h(m[2])}${h(m[3])}`
  }
  return undefined
}

/** Inline CSS for one run — only fields it explicitly sets, so unset fields
 *  inherit the editor's box-level default styling. */
function runInlineStyle(run: StyledRun, scale: number): string {
  const parts: string[] = []
  if (run.bold !== undefined) parts.push(`font-weight:${run.bold ? 'bold' : 'normal'}`)
  if (run.italic !== undefined) parts.push(`font-style:${run.italic ? 'italic' : 'normal'}`)
  if (run.underline !== undefined || run.strikethrough !== undefined) {
    const deco = [run.underline ? 'underline' : '', run.strikethrough ? 'line-through' : '']
      .filter(Boolean).join(' ')
    parts.push(`text-decoration-line:${deco || 'none'}`)
  }
  if (run.color) parts.push(`color:${run.color}`)
  if (run.fontSize !== undefined) parts.push(`font-size:${run.fontSize * scale}px`)
  return parts.join(';')
}

/** Serialize runs → contentEditable innerHTML (one <span> per styled run,
 *  <br> for embedded newlines). */
function runsToHtml(runs: StyledRun[], scale: number): string {
  return runs
    .map((run) => {
      const style = runInlineStyle(run, scale)
      const inner = run.text.split('\n').map(escapeHtml).join('<br>')
      return style ? `<span style="${style}">${inner}</span>` : inner
    })
    .join('')
}

interface ResolvedRunStyle {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strikethrough?: boolean
  color?: string
  fontSize?: number
}

/** Resolve a DOM text node's effective character style by walking its
 *  ancestor chain up to (not including) the editor div. Nearest-defining
 *  ancestor wins per property; properties no ancestor sets stay undefined
 *  (→ inherit the paragraph default). */
function resolveNodeStyle(node: Node, editorEl: HTMLElement, scale: number): ResolvedRunStyle {
  const out: ResolvedRunStyle = {}
  let cur: Node | null = node.parentNode
  while (cur && cur !== editorEl && cur.nodeType === 1) {
    const e = cur as HTMLElement
    const tag = e.nodeName
    const st = e.style
    if (out.bold === undefined) {
      if (tag === 'B' || tag === 'STRONG') out.bold = true
      else if (st.fontWeight === 'bold' || st.fontWeight === 'bolder') out.bold = true
      else if (st.fontWeight === 'normal' || st.fontWeight === 'lighter') out.bold = false
      else if (st.fontWeight) { const n = parseInt(st.fontWeight, 10); if (!isNaN(n)) out.bold = n >= 600 }
    }
    if (out.italic === undefined) {
      if (tag === 'I' || tag === 'EM') out.italic = true
      else if (st.fontStyle) out.italic = st.fontStyle === 'italic' || st.fontStyle === 'oblique'
    }
    const deco = st.textDecorationLine || st.textDecoration
    if (deco) {
      if (out.underline === undefined && /underline/.test(deco)) out.underline = true
      if (out.strikethrough === undefined && /line-through/.test(deco)) out.strikethrough = true
      if (deco.trim() === 'none') {
        if (out.underline === undefined) out.underline = false
        if (out.strikethrough === undefined) out.strikethrough = false
      }
    }
    if (out.underline === undefined && tag === 'U') out.underline = true
    if (out.strikethrough === undefined && (tag === 'S' || tag === 'STRIKE' || tag === 'DEL')) out.strikethrough = true
    if (out.color === undefined && st.color) out.color = cssColorToHex(st.color)
    if (out.fontSize === undefined && st.fontSize.endsWith('px')) {
      const px = parseFloat(st.fontSize)
      if (!isNaN(px) && scale > 0) out.fontSize = px / scale
    }
    cur = cur.parentNode
  }
  return out
}

/** Read the editor DOM back into StyledRun[], merging adjacent text with
 *  identical effective style and preserving newlines like readMultilineText. */
function readStyledRuns(editorEl: HTMLElement, scale: number): StyledRun[] {
  const BLOCK = new Set(['DIV', 'P', 'LI', 'BLOCKQUOTE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'])
  const segs: { text: string; style: ResolvedRunStyle; key: string }[] = []
  let lastNewline = true
  const keyOf = (s: ResolvedRunStyle) =>
    JSON.stringify([s.bold ?? null, s.italic ?? null, s.underline ?? null, s.strikethrough ?? null, s.color ?? null, s.fontSize ?? null])
  const emit = (text: string, style: ResolvedRunStyle) => {
    if (!text) return
    const key = keyOf(style)
    const last = segs[segs.length - 1]
    if (last && last.key === key) last.text += text
    else segs.push({ text, style, key })
    lastNewline = text.endsWith('\n')
  }
  const emitNewline = () => {
    const last = segs[segs.length - 1]
    if (last) { last.text += '\n' } else segs.push({ text: '\n', style: {}, key: keyOf({}) })
    lastNewline = true
  }
  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      const t = node.textContent ?? ''
      if (t.length > 0) emit(t, resolveNodeStyle(node, editorEl, scale))
      return
    }
    if (node.nodeType !== 1) return
    const e = node as Element
    if (e.nodeName === 'BR') { emitNewline(); return }
    const isBlock = BLOCK.has(e.nodeName)
    if (isBlock && !lastNewline && segs.length > 0) emitNewline()
    for (const child of Array.from(e.childNodes)) walk(child)
    if (isBlock && !lastNewline) emitNewline()
  }
  for (const child of Array.from(editorEl.childNodes)) walk(child)
  const last = segs[segs.length - 1]
  if (last && last.text.endsWith('\n')) {
    last.text = last.text.slice(0, -1)
    if (last.text === '') segs.pop()
  }
  return segs.map((s) => ({ text: s.text, ...s.style }))
}

/** Apply a character style to the current selection inside `editorEl`. Uses
 *  execCommand for bold/italic/underline/strike/color (the browser handles
 *  split/merge + toggle-off correctly) and a manual span wrap for arbitrary
 *  pt font sizes (execCommand 'fontSize' only supports the 1–7 scale).
 *  Returns false when there is no usable selection inside the editor. */
type CharStyleAttr = 'bold' | 'italic' | 'underline' | 'strikethrough' | 'color' | 'fontSize'
function formatSelection(
  editorEl: HTMLElement,
  attr: CharStyleAttr,
  value: boolean | string | number,
  scale: number,
): boolean {
  const sel = typeof window !== 'undefined' ? window.getSelection() : null
  if (!sel || sel.rangeCount === 0) return false
  const range = sel.getRangeAt(0)
  if (range.collapsed || !editorEl.contains(range.commonAncestorContainer)) return false
  try { document.execCommand('styleWithCSS', false, 'true') } catch { /* not fatal */ }
  switch (attr) {
    case 'bold': return document.execCommand('bold')
    case 'italic': return document.execCommand('italic')
    case 'underline': return document.execCommand('underline')
    case 'strikethrough': return document.execCommand('strikeThrough')
    case 'color': return document.execCommand('foreColor', false, String(value))
    case 'fontSize': {
      const span = document.createElement('span')
      span.style.fontSize = `${Number(value) * scale}px`
      try {
        span.appendChild(range.extractContents())
        range.insertNode(span)
        const nr = document.createRange()
        nr.selectNodeContents(span)
        sel.removeAllRanges()
        sel.addRange(nr)
      } catch { return false }
      return true
    }
  }
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
   *  Part of the modeless-editing refactor (docs/MODELESS.md Phase A).
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

function writePendingEditsForPage(
  tabId: string,
  pageIndex: number,
  edits: ParagraphEdit[],
  options: { markDirty?: boolean } = {},
) {
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
  if (edits.length > 0 && options.markDirty !== false) {
    useTabStore.getState().setTabDirty(tabId, true)
  }
  // If we just cleared the last edit, leave the dirty flag alone —
  // other edit systems (Fabric, page rotates) might still be dirty.
  void anyDirty
}

// Live reflow preview (Session 6 D1). Debounce keystroke-driven reflow
// recomputation so typing doesn't run the obstacle/collision walk on
// every input event (commitEdit already runs flowEditBlockedByObstacle
// once per keystroke; this is the SECOND, neighbor-shift pass).
const LIVE_PREVIEW_DEBOUNCE_MS = 160

/** Equality on the live-preview neighbor-shift set: same paragraphs with
 *  the same positionDelta. Lets the writer skip a no-op store update so a
 *  static page doesn't churn renders on every debounce tick. */
function liveEditsEqual(
  a: ParagraphEdit[] | undefined,
  b: ParagraphEdit[],
): boolean {
  const aa = a ?? []
  if (aa.length !== b.length) return false
  const byId = new Map(aa.map((e) => [e.paragraphId, e]))
  for (const e of b) {
    const prev = byId.get(e.paragraphId)
    if (!prev) return false
    const pd = prev.positionDelta ?? { dx: 0, dy: 0 }
    const nd = e.positionDelta ?? { dx: 0, dy: 0 }
    if (Math.abs(pd.dx - nd.dx) > 0.01 || Math.abs(pd.dy - nd.dy) > 0.01) return false
  }
  return true
}

/** Write the live reflow-preview neighbor shifts for a page. NOT a
 *  document edit: it never marks the tab dirty, is wrapped in withReplay,
 *  and is excluded from undo snapshots (historyStore cloneValue skip-list)
 *  + from the save bytes (the save commit strips it). Equality-guarded so
 *  a no-op recompute doesn't trigger a render. */
function writeLivePreviewEditsForPage(
  tabId: string,
  pageIndex: number,
  edits: ParagraphEdit[],
) {
  const state = useFormatStore.getState().data[tabId] as PdfFormatState | undefined
  const page = state?.pages.find((p) => p.pageIndex === pageIndex) as
    | (PdfFormatState['pages'][number] & { _livePreviewParagraphEdits?: ParagraphEdit[] })
    | undefined
  if (liveEditsEqual(page?._livePreviewParagraphEdits, edits)) return
  withReplay(() => {
    useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({
      ...prev,
      pages: prev.pages.map((p) =>
        p.pageIndex === pageIndex
          ? ({
              ...p,
              _livePreviewParagraphEdits: edits.length > 0 ? edits : undefined,
            } as PdfFormatState['pages'][number])
          : p,
      ),
    }))
  })
}

const DEFAULT_PARAGRAPH_LINE_HEIGHT = 1.2
const ADD_TEXT_BOX_DEFAULT_WIDTH = 220

type EditableParagraphBox = ParagraphBox & {
  isNewTextBox?: boolean
}

interface ParagraphCommitOptions {
  clipToBbox?: boolean
  /** Styled character runs read from the live editor. When the key is
   *  present, it replaces the edit's runs (undefined clears them, e.g. the
   *  user deleted all styled text); when absent, prior runs are preserved. */
  runs?: StyledRun[]
}

function normalizeHexColor(hex: string | undefined): string {
  if (!hex) return ''
  const trimmed = hex.trim().toLowerCase()
  if (/^#[0-9a-f]{3}$/.test(trimmed)) {
    return `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`
  }
  return trimmed
}

function sameParagraphBbox(a: ParagraphBox['bbox'] | undefined, b: ParagraphBox['bbox']): boolean {
  if (!a) return true
  return (
    Math.abs(a.x - b.x) < 0.01 &&
    Math.abs(a.y - b.y) < 0.01 &&
    Math.abs(a.width - b.width) < 0.01 &&
    Math.abs(a.height - b.height) < 0.01
  )
}

function paragraphEditChangesStyleOrLayout(para: ParagraphBox, edit: ParagraphEdit): boolean {
  const lineHeight = (edit as { lineHeight?: number }).lineHeight
  return (
    // Per-run styling lives in `runs`, not the flat fields, so the flat
    // diff below would miss it and drop a "bold just this word" edit.
    editCarriesRunStyling(edit) ||
    !sameParagraphBbox(edit.bbox, para.bbox) ||
    Math.abs((edit.fontSize ?? para.fontSize) - para.fontSize) >= 0.01 ||
    normalizeHexColor(edit.color) !== normalizeHexColor(para.color) ||
    normalizedFontFamily(edit.fontFamily ?? para.fontFamily ?? '') !==
      normalizedFontFamily(para.fontFamily ?? '') ||
    Boolean(edit.bold) !== Boolean(para.bold) ||
    Boolean(edit.italic) !== Boolean(para.italic) ||
    Boolean(edit.underline) ||
    Boolean(edit.strikethrough) ||
    (edit.align !== undefined && edit.align !== 'left') ||
    (lineHeight !== undefined && Math.abs(lineHeight - DEFAULT_PARAGRAPH_LINE_HEIGHT) >= 0.01)
  )
}

function paragraphEditHasMeaningfulChange(
  para: ParagraphBox,
  edit: ParagraphEdit,
  styleChanged = paragraphEditChangesStyleOrLayout(para, edit),
): boolean {
  const moved =
    edit.positionDelta !== undefined &&
    (Math.abs(edit.positionDelta.dx) >= 0.01 || Math.abs(edit.positionDelta.dy) >= 0.01)
  return edit.newText !== para.originalText || moved || styleChanged
}

function isNewTextBoxEdit(edit: ParagraphEdit): boolean {
  return (edit as ParagraphEdit & { isNewTextBox?: boolean }).isNewTextBox === true
}

function syntheticParagraphFromEdit(edit: ParagraphEdit): EditableParagraphBox {
  return {
    id: edit.paragraphId,
    itemIndices: [],
    lines: [{
      y: edit.bbox.y,
      fontSize: edit.fontSize,
      text: edit.newText,
      itemIndices: [],
      x: edit.bbox.x,
      width: edit.bbox.width,
    }],
    bbox: edit.bbox,
    originalText: '',
    fontSize: edit.fontSize,
    fontName: edit.fontFamily ?? 'Helvetica',
    fontFamily: edit.fontFamily ?? 'Helvetica',
    italic: edit.italic ?? false,
    bold: edit.bold ?? false,
    color: edit.color ?? '#000000',
    onDarkBackground: false,
    backgroundColor: edit.backgroundColor ?? 'transparent',
    ...(edit.runs ? { runs: edit.runs } : {}),
    isNewTextBox: true,
  }
}

type EnginePreviewRegion = {
  bbox: ParagraphBox['bbox']
  backgroundColor?: string
  preferSolidMask?: boolean
}

type OverlapSourceRedrawRegion = {
  bbox: ParagraphBox['bbox']
  backgroundColor?: string
  redrawParagraphs: ParagraphBox[]
}

function expandPreviewMaskBbox(
  bbox: ParagraphBox['bbox'],
  pageSize: { w: number; h: number },
  pad = 4,
): ParagraphBox['bbox'] {
  const x0 = Math.max(0, bbox.x - pad)
  const y0 = Math.max(0, bbox.y - pad)
  const x1 = Math.min(pageSize.w, bbox.x + bbox.width + pad)
  const y1 = Math.min(pageSize.h, bbox.y + bbox.height + pad)
  return {
    x: x0,
    y: y0,
    width: Math.max(0, x1 - x0),
    height: Math.max(0, y1 - y0),
  }
}

function previewMaskBboxForStyle(
  bbox: ParagraphBox['bbox'],
  pageSize: { w: number; h: number },
  style: Pick<ParagraphEdit, 'underline' | 'strikethrough' | 'runs'>,
  fontSize: number,
): ParagraphBox['bbox'] {
  const decorated = paragraphStyleHasDecoration(style)
    ? expandParagraphBboxForDecorationMask(bbox, fontSize, pageSize)
    : bbox
  return expandPreviewMaskBbox(decorated, pageSize)
}

function paragraphBboxesOverlap(
  a: ParagraphBox['bbox'],
  b: ParagraphBox['bbox'],
  tolerance = 0.5,
): boolean {
  const left = Math.max(a.x, b.x)
  const top = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  return right - left > tolerance && bottom - top > tolerance
}

function hasOverlappingNeighbor(
  bbox: ParagraphBox['bbox'],
  paragraphId: string,
  paragraphs: ParagraphBox[],
): boolean {
  return paragraphs.some((p) =>
    p.id !== paragraphId && paragraphBboxesOverlap(bbox, p.bbox),
  )
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
  const lastActiveIdRef = useRef<string | null>(null)
  const [frontParagraphStack, setFrontParagraphStack] = useState<string[]>([])
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
  const [movePreviewRegion, setMovePreviewRegion] = useState<EnginePreviewRegion | null>(null)
  const suppressNextLayerClickUntilRef = useRef(0)
  // In-progress chain frames. Built up as the user clicks paragraphs
  // while linkingMode is on. End chain writes them to _linkedChains;
  // Cancel discards them. Supports any number of frames (N ≥ 2).
  const [linkingFrames, setLinkingFrames] = useState<LinkedFrame[]>([])

  const bringParagraphToFront = useCallback((id: string) => {
    setFrontParagraphStack((prev) => [...prev.filter((x) => x !== id), id])
  }, [])

  const suppressNextLayerClickAfterDrag = useCallback(() => {
    suppressNextLayerClickUntilRef.current = Date.now() + 700
  }, [])

  useEffect(() => {
    if (paragraphs.length === 0) {
      setFrontParagraphStack((prev) => (prev.length === 0 ? prev : []))
      return
    }
    const liveIds = new Set(paragraphs.map((p) => p.id))
    setFrontParagraphStack((prev) => {
      const next = prev.filter((id) => liveIds.has(id))
      return next.length === prev.length ? prev : next
    })
  }, [paragraphs])
  const layerRef = useRef<HTMLDivElement>(null)
  // Format state for page count + tab-level access (for movePicker).
  const formatState = useFormatStore((s) => s.data[tabId] as PdfFormatState | undefined)
  const totalPageCount = formatState?.pageCount ?? 0
  const tool = useUIStore((s) => s.tool)
  const textOptions = useUIStore((s) => s.textOptions)
  const setTextOptions = useUIStore((s) => s.setTextOptions)
  const setTool = useUIStore((s) => s.setTool)
  const autoLayoutTextEdits = useUIStore((s) => s.autoLayoutTextEdits)

  // Expose cluster state to the test-hook driver. Each page keeps its
  // own entry keyed by pageIndex so tests can look up a paragraph's
  // full ParagraphBox (bbox, fontSize, color, fontFamily, bold, italic)
  // without scraping DOM styles. No-op outside test runs (the test-hook
  // bridge is the only consumer of window.__testParagraphs).
  useEffect(() => {
    if (typeof window === 'undefined') return
    const w = window as any
    if (!w.__testParagraphs) w.__testParagraphs = {}
    w.__testParagraphs[`${tabId}:${pageIndex}`] = paragraphs
    return () => {
      if (w.__testParagraphs) delete w.__testParagraphs[`${tabId}:${pageIndex}`]
    }
  }, [tabId, pageIndex, paragraphs])

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

  useEffect(() => {
    if (!active) return
    const onClickCapture = (e: MouseEvent) => {
      if (Date.now() > suppressNextLayerClickUntilRef.current) return
      const el = layerRef.current
      const target = e.target as Node | null
      if (!el || !target || !el.contains(target)) return
      e.preventDefault()
      e.stopPropagation()
      suppressNextLayerClickUntilRef.current = 0
    }
    document.addEventListener('click', onClickCapture, true)
    return () => document.removeEventListener('click', onClickCapture, true)
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
          try {
            const runMap = await getParagraphStyledRunsFromStream(
              pdfBytes,
              pageIndex,
              finalParagraphs,
              res.pageHeight,
              res.items,
            )
            if (cancelled) return
            if (runMap.size > 0) {
              finalParagraphs = finalParagraphs.map((p) => {
                const runs = runMap.get(p.id)
                return runs ? { ...p, runs } : p
              })
            }
          } catch (err) {
            console.warn('[EditableParagraphLayer] text-run decoration extract failed:', err)
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
    const runs = pending?.runs ?? para.runs
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
      ...(runs ? { runs } : {}),
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
  // Live reflow preview (Session 6 D1): the synthesized neighbor shifts
  // recomputed while typing, so neighbors move on INPUT — before blur/save.
  const pageLivePreviewEdits = useFormatStore((s): ParagraphEdit[] | undefined => {
    const state = s.data[tabId] as PdfFormatState | undefined
    const page = state?.pages.find((p) => p.pageIndex === pageIndex) as
      | (PdfFormatState['pages'][number] & { _livePreviewParagraphEdits?: ParagraphEdit[] })
      | undefined
    return page?._livePreviewParagraphEdits
  })
  const pageFabricJSON = useFormatStore((s): Record<string, unknown> | null => {
    const state = s.data[tabId] as PdfFormatState | undefined
    const page = state?.pages.find((p) => p.pageIndex === pageIndex)
    return page?.fabricJSON ?? null
  })
  const renderParagraphs = useMemo<EditableParagraphBox[]>(() => {
    const sourceIds = new Set(paragraphs.map((p) => p.id))
    const synthetic = (pageEdits ?? [])
      .filter((edit) => isNewTextBoxEdit(edit) && !sourceIds.has(edit.paragraphId))
      .map(syntheticParagraphFromEdit)
    return [...paragraphs, ...synthetic]
  }, [paragraphs, pageEdits])

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

  const dirtyById = useMemo(
    () => new Map((pageEdits ?? []).map((e) => [e.paragraphId, e])),
    [pageEdits],
  )
  const savedPreviewById = useMemo(() => {
    const edits: ParagraphEdit[] =
      pageEdits && pageEdits.length > 0
        ? []
        : pageSavePreviewEdits ?? []
    return new Map(edits.map((e) => [e.paragraphId, e]))
  }, [pageEdits, pageSavePreviewEdits])
  // Live preview only applies WHILE there are pending edits (the user is
  // actively typing); after save, pageEdits clears and the save-preview
  // channel takes over.
  const livePreviewById = useMemo(() => {
    const edits: ParagraphEdit[] =
      pageEdits && pageEdits.length > 0 ? pageLivePreviewEdits ?? [] : []
    return new Map(edits.map((e) => [e.paragraphId, e]))
  }, [pageEdits, pageLivePreviewEdits])
  // Order matters: live-preview neighbor shifts sit UNDER the user's own
  // dirty edits, so a paragraph the user edited always renders from its
  // real edit, never a synthesized shift.
  const pendingById = useMemo(
    () => new Map([...savedPreviewById, ...livePreviewById, ...dirtyById]),
    [dirtyById, savedPreviewById, livePreviewById],
  )

  // ── Live reflow preview (Session 6 D1) ──────────────────────────
  // While the user types, recompute the SAME single-page reflow the save
  // path runs and feed the neighbor shifts into _livePreviewParagraphEdits
  // so followers visibly move on INPUT — not just after blur/save. Gated
  // by the exact obstacle/safety logic save uses: a flow edit only exists
  // when autoLayout is on and the region is safe (commitEdit pins unsafe
  // edits to 'fixed'), and computeReflowDeltasWithReport independently
  // re-freezes unsafe edits + collision-checks obstacles, so unsafe
  // regions produce zero neighbor shifts. Deps are pageEdits + paragraphs
  // ONLY (never the live-preview field) to avoid a write→read→write loop.
  const livePreviewTimerRef = useRef<number | null>(null)
  useEffect(() => {
    const clearTimer = () => {
      if (livePreviewTimerRef.current !== null) {
        window.clearTimeout(livePreviewTimerRef.current)
        livePreviewTimerRef.current = null
      }
    }
    if (!active || tool !== 'edit_text') {
      clearTimer()
      return
    }
    const dirty = pageEdits ?? []
    clearTimer()
    livePreviewTimerRef.current = window.setTimeout(() => {
      livePreviewTimerRef.current = null
      const dirtyIds = new Set(dirty.map((e) => e.paragraphId))
      const hasFlowEdit = dirty.some(
        (e) => e.flowBehavior === 'flow' && e.originalText !== '',
      )
      let preview: ParagraphEdit[] = []
      if (hasFlowEdit) {
        const { editsByPage } = computeReflowDeltasWithReport(
          new Map([[pageIndex, toReflowParagraphs(paragraphs)]]),
          // Shallow-clone so the reflow's internal mutation never touches
          // the store's edit objects. Single-page: no cross-page spill in
          // the live preview (save owns multi-page).
          new Map([[pageIndex, dirty.map((e) => ({ ...e }))]]),
          { crossPageSpill: false },
        )
        const out = editsByPage.get(pageIndex) ?? []
        // Keep ONLY the synthesized neighbor shifts — paragraphs the user
        // did not edit, that gained a positionDelta from reflow. The
        // edited paragraphs render from dirtyById.
        preview = out.filter(
          (e) => !dirtyIds.has(e.paragraphId) && !!e.positionDelta,
        )
      }
      writeLivePreviewEditsForPage(tabId, pageIndex, preview)
    }, LIVE_PREVIEW_DEBOUNCE_MS)
    return clearTimer
  }, [active, tool, pageEdits, paragraphs, tabId, pageIndex])

  useEffect(() => {
    if (!active || tool !== 'edit_text' || !activeId) return
    const para = renderParagraphs.find((p) => p.id === activeId)
    if (!para) return
    const pending = pendingById.get(activeId)
    setTextOptions({
      fontSize: pending?.fontSize ?? para.fontSize,
      color: pending?.color ?? para.color,
      fontFamily: pending?.fontFamily ?? para.fontFamily ?? 'Helvetica',
      bold: pending?.bold ?? para.bold,
      italic: pending?.italic ?? para.italic,
      underline: pending?.underline ?? false,
      strikethrough: pending?.strikethrough ?? false,
      textAlign: pending?.align === 'justify' ? 'left' : pending?.align ?? 'left',
      lineHeight: (pending as { lineHeight?: number } | undefined)?.lineHeight ?? 1.2,
    })
  }, [active, tool, activeId, renderParagraphs, pendingById, setTextOptions])

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
    (
      para: ParagraphBox,
      newText: string,
      overrideAlign?: TextAlign,
      options?: ParagraphCommitOptions,
    ) => {
      const existing = readPendingEditsForPage(tabId, pageIndex)
      const without = existing.filter((e) => e.paragraphId !== para.id)
      const prevEdit = existing.find((e) => e.paragraphId === para.id)
      const align = overrideAlign ?? prevEdit?.align
      const positionDelta = prevEdit?.positionDelta
      const clipToBbox = options?.clipToBbox ?? prevEdit?.clipToBbox === true
      // Styled runs: an explicit `runs` key (even undefined) from the editor
      // replaces them; otherwise carry the prior runs forward through typing.
      const runs = options && 'runs' in options ? options.runs : prevEdit?.runs
      const itemOriginalTexts = para.itemIndices.map((idx) => itemsRef.current[idx]?.str ?? '')
      const draft: ParagraphEdit = {
        paragraphId: para.id,
        // Preserve style/layout fields through subsequent typing. A
        // previous version kept only the sticky styleChanged flag here,
        // which could route plain text edits to overlay even after the
        // actual style values had returned to the paragraph defaults.
        bbox: prevEdit?.bbox ?? para.bbox,
        ...(prevEdit?.maskBbox ? { maskBbox: prevEdit.maskBbox } : {}),
        originalText: para.originalText,
        newText,
        fontSize: prevEdit?.fontSize ?? para.fontSize,
        color: prevEdit?.color ?? para.color,
        backgroundColor: prevEdit?.backgroundColor ?? para.backgroundColor,
        fontFamily: prevEdit?.fontFamily ?? para.fontFamily,
        bold: prevEdit?.bold ?? para.bold,
        italic: prevEdit?.italic ?? para.italic,
        underline: prevEdit?.underline ?? false,
        strikethrough: prevEdit?.strikethrough ?? false,
        align,
        layoutRole: prevEdit?.layoutRole ?? para.layout?.role,
        layoutSafeForAutoReflow:
          prevEdit?.layoutSafeForAutoReflow ?? para.layout?.safeForAutoReflow,
        layoutFlowId: prevEdit?.layoutFlowId ?? para.layout?.flowId,
        layoutReasons: prevEdit?.layoutReasons ?? para.layout?.reasons,
        // Session 5: detected alignment + R5b font-recovery state ride
        // every edit so the save seam can preserve/record without a
        // save-time recluster. BOTH are tri-state: undefined = unknown
        // (detector had no evidence / recovery probe could not
        // complete) and must survive to the seam — never collapse it
        // into a positive claim (gate-2 P1).
        layoutDetectedAlign:
          prevEdit?.layoutDetectedAlign ?? para.layout?.align,
        layoutWeakCenterEvidence:
          prevEdit?.layoutWeakCenterEvidence ?? para.layout?.weakCenterEvidence,
        fontFamilyIsGenericFallback:
          prevEdit?.fontFamilyIsGenericFallback ??
          para.fontFamilyIsGenericFallback,
        itemIndices: [...para.itemIndices],
        itemOriginalTexts,
        positionDelta,
        ...(clipToBbox ? { clipToBbox: true } : {}),
        ...(prevEdit?.isNewTextBox ? { isNewTextBox: true } : {}),
        ...(prevEdit?.skipSourceMask ? { skipSourceMask: true } : {}),
        ...((prevEdit as { requiresOverlay?: boolean } | undefined)?.requiresOverlay
          ? { requiresOverlay: true }
          : {}),
        ...((prevEdit as { lineHeight?: number } | undefined)?.lineHeight !== undefined
          ? { lineHeight: (prevEdit as { lineHeight?: number }).lineHeight }
          : {}),
        ...(runs && runs.length > 0 ? { runs } : {}),
      }
      // Re-derive newText from runs + force overlay when the runs carry
      // styling, so a "bold just this word" edit persists and renders.
      let synced = syncRunsToEdit(draft)
      if (editCarriesRunStyling(synced)) {
        const grown = growParagraphBboxForStyledText(para, synced, basePageSize)
        if (!sameParagraphBbox(grown, synced.bbox)) {
          synced = {
            ...synced,
            bbox: grown,
            ...(synced.maskBbox ? {} : { maskBbox: para.bbox }),
          }
        }
      }
      if (synced.clipToBbox && (autoLayoutTextEdits || synced.newText.includes('\n'))) {
        const grown = growParagraphBboxForStyledText(para, synced, basePageSize)
        if (!sameParagraphBbox(grown, synced.bbox)) {
          synced = {
            ...synced,
            bbox: grown,
            ...(synced.maskBbox ? {} : { maskBbox: para.bbox }),
          }
        }
        delete synced.clipToBbox
      }
      const grewDown =
        synced.bbox.y + synced.bbox.height > para.bbox.y + para.bbox.height + 0.01
      if (
        autoLayoutTextEdits &&
        !synced.isNewTextBox &&
        !synced.skipSourceMask &&
        (synced.newText === '' || grewDown)
      ) {
        if (para.layout && !para.layout.safeForAutoReflow) {
          synced.flowBehavior = 'fixed'
          synced.layoutWarning = blockedAutoReflowMessage(para.layout)
        } else {
          const obstacle = flowEditBlockedByObstacle(
            toReflowParagraphs(paragraphs),
            synced,
            pageIndex,
          )
          if (obstacle) {
            synced.flowBehavior = 'fixed'
            synced.layoutWarning = obstacleBlockedAutoReflowMessage(obstacle.reason)
          } else {
            synced.flowBehavior = 'flow'
            delete synced.layoutWarning
          }
        }
      }
      synced = expandParagraphEditMaskForDecorations(synced, basePageSize, para.bbox)
      const styleChanged = paragraphEditChangesStyleOrLayout(para, synced)
      if (styleChanged) synced.styleChanged = true
      else delete synced.styleChanged
      const isNoop = !paragraphEditHasMeaningfulChange(para, synced, styleChanged)
      const next: ParagraphEdit[] = isNoop
        ? without
        : [...without, synced]
      writePendingEditsForPage(tabId, pageIndex, next)
    },
    [tabId, pageIndex, basePageSize, autoLayoutTextEdits, paragraphs],
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
      const runs = prevEdit?.runs ?? para.runs
      const itemOriginalTexts =
        prevEdit?.itemOriginalTexts ??
        para.itemIndices.map((idx) => itemsRef.current[idx]?.str ?? '')
      const draft: ParagraphEdit = {
        paragraphId: para.id,
        bbox: prevEdit?.bbox ?? para.bbox,
        ...(prevEdit?.maskBbox ? { maskBbox: prevEdit.maskBbox } : {}),
        originalText: para.originalText,
        newText,
        fontSize: prevEdit?.fontSize ?? para.fontSize,
        color: prevEdit?.color ?? para.color,
        backgroundColor: prevEdit?.backgroundColor ?? para.backgroundColor,
        fontFamily: prevEdit?.fontFamily ?? para.fontFamily,
        bold: prevEdit?.bold ?? para.bold,
        italic: prevEdit?.italic ?? para.italic,
        underline: prevEdit?.underline ?? false,
        strikethrough: prevEdit?.strikethrough ?? false,
        align,
        layoutRole: prevEdit?.layoutRole ?? para.layout?.role,
        layoutSafeForAutoReflow:
          prevEdit?.layoutSafeForAutoReflow ?? para.layout?.safeForAutoReflow,
        layoutFlowId: prevEdit?.layoutFlowId ?? para.layout?.flowId,
        layoutReasons: prevEdit?.layoutReasons ?? para.layout?.reasons,
        layoutDetectedAlign:
          prevEdit?.layoutDetectedAlign ?? para.layout?.align,
        layoutWeakCenterEvidence:
          prevEdit?.layoutWeakCenterEvidence ?? para.layout?.weakCenterEvidence,
        fontFamilyIsGenericFallback:
          prevEdit?.fontFamilyIsGenericFallback ??
          para.fontFamilyIsGenericFallback,
        itemIndices: [...para.itemIndices],
        itemOriginalTexts,
        positionDelta: newDelta,
        ...(prevEdit?.clipToBbox ? { clipToBbox: true } : {}),
        ...(prevEdit?.isNewTextBox ? { isNewTextBox: true } : {}),
        ...(prevEdit?.skipSourceMask ? { skipSourceMask: true } : {}),
        ...((prevEdit as { requiresOverlay?: boolean } | undefined)?.requiresOverlay
          ? { requiresOverlay: true }
          : {}),
        ...((prevEdit as { lineHeight?: number } | undefined)?.lineHeight !== undefined
          ? { lineHeight: (prevEdit as { lineHeight?: number }).lineHeight }
          : {}),
        ...(runs ? { runs } : {}),
      }
      let synced = syncRunsToEdit(draft)
      if (editCarriesRunStyling(synced)) {
        const grown = growParagraphBboxForStyledText(para, synced, basePageSize)
        if (!sameParagraphBbox(grown, synced.bbox)) {
          synced = {
            ...synced,
            bbox: grown,
            ...(synced.maskBbox ? {} : { maskBbox: para.bbox }),
          }
        }
      }
      synced = expandParagraphEditMaskForDecorations(synced, basePageSize, para.bbox)
      const styleChanged = paragraphEditChangesStyleOrLayout(para, synced)
      if (styleChanged) synced.styleChanged = true
      else delete synced.styleChanged
      const isNoop = !paragraphEditHasMeaningfulChange(para, synced, styleChanged)
      const next: ParagraphEdit[] = isNoop
        ? without
        : [...without, synced]
      writePendingEditsForPage(tabId, pageIndex, next)
    },
    [tabId, pageIndex, basePageSize],
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
    if (activeId) lastActiveIdRef.current = activeId
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
        ...(prev?.maskBbox ? { maskBbox: prev.maskBbox } : {}),
        originalText: para.originalText,
        newText: prev?.newText ?? para.originalText,
        fontSize: prev?.fontSize ?? para.fontSize,
        color: prev?.color ?? para.color,
        backgroundColor: prev?.backgroundColor ?? para.backgroundColor,
        bold: prev?.bold ?? para.bold,
        italic: prev?.italic ?? para.italic,
        underline: prev?.underline ?? false,
        strikethrough: prev?.strikethrough ?? false,
        fontFamily: prev?.fontFamily ?? para.fontFamily,
        align: prev?.align,
        layoutRole: prev?.layoutRole ?? para.layout?.role,
        layoutSafeForAutoReflow:
          prev?.layoutSafeForAutoReflow ?? para.layout?.safeForAutoReflow,
        layoutFlowId: prev?.layoutFlowId ?? para.layout?.flowId,
        layoutReasons: prev?.layoutReasons ?? para.layout?.reasons,
        layoutDetectedAlign:
          prev?.layoutDetectedAlign ?? para.layout?.align,
        layoutWeakCenterEvidence:
          prev?.layoutWeakCenterEvidence ?? para.layout?.weakCenterEvidence,
        fontFamilyIsGenericFallback:
          prev?.fontFamilyIsGenericFallback ??
          para.fontFamilyIsGenericFallback,
        itemIndices: [...para.itemIndices],
        itemOriginalTexts,
        positionDelta: prev?.positionDelta,
        ...(prev?.clipToBbox ? { clipToBbox: true } : {}),
        ...(prev?.isNewTextBox ? { isNewTextBox: true } : {}),
        ...(prev?.skipSourceMask ? { skipSourceMask: true } : {}),
        ...((prev as { requiresOverlay?: boolean } | undefined)?.requiresOverlay
          ? { requiresOverlay: true }
          : {}),
        // Preserve per-run styling through whole-box patches; `patch` may
        // still override (e.g. runs:undefined to clear).
        ...(prev?.runs ? { runs: prev.runs } : {}),
        ...patch,
      }
      if (patch.bbox && !sameParagraphBbox(patch.bbox, para.bbox)) {
        merged.maskBbox = prev?.maskBbox ?? para.bbox
      }
      if (paragraphStylePatchNeedsAutoGrow(patch)) {
        const grown = growParagraphBboxForStyledText(para, merged, basePageSize)
        if (!sameParagraphBbox(grown, para.bbox)) {
          merged.maskBbox = prev?.maskBbox ?? para.bbox
        }
        merged.bbox = grown
      }
      const grewDown =
        merged.bbox.y + merged.bbox.height > para.bbox.y + para.bbox.height + 0.01
      if (
        autoLayoutTextEdits &&
        !merged.isNewTextBox &&
        !merged.skipSourceMask &&
        (merged.newText === '' || grewDown)
      ) {
        if (para.layout && !para.layout.safeForAutoReflow) {
          merged.flowBehavior = 'fixed'
          merged.layoutWarning = blockedAutoReflowMessage(para.layout)
        } else {
          const obstacle = flowEditBlockedByObstacle(
            toReflowParagraphs(paragraphs),
            merged,
            pageIndex,
          )
          if (obstacle) {
            merged.flowBehavior = 'fixed'
            merged.layoutWarning = obstacleBlockedAutoReflowMessage(obstacle.reason)
          } else {
            merged.flowBehavior = 'flow'
            delete merged.layoutWarning
          }
        }
      }
      const normalized = expandParagraphEditMaskForDecorations(merged, basePageSize, para.bbox)
      const styleChanged = paragraphEditChangesStyleOrLayout(para, merged)
      if (styleChanged) normalized.styleChanged = true
      else delete normalized.styleChanged
      const next = paragraphEditHasMeaningfulChange(para, normalized, styleChanged)
        ? [...without, normalized]
        : without
      writePendingEditsForPage(tabId, pageIndex, next)
    },
    [tabId, pageIndex, basePageSize, autoLayoutTextEdits, paragraphs],
  )

  const setParagraphFontFamily = useCallback(
    (para: ParagraphBox, fontFamily: string) => {
      // Requires overlay-bake: changing font resources needs a fresh Tf
      // that may not exist in the original page resource dictionary.
      // Engine's overlay-bake supports the Standard 14 families today
      // (G2 still open for arbitrary custom fonts) — the toolbar's
      // dropdown only offers fonts the engine can honor.
      updateFieldOnEdit(para, { fontFamily, styleChanged: true, requiresOverlay: true })
    },
    [updateFieldOnEdit],
  )

  const setParagraphLineHeight = useCallback(
    (para: ParagraphBox, lineHeight: number) => {
      updateFieldOnEdit(para, { lineHeight, styleChanged: true, requiresOverlay: true })
    },
    [updateFieldOnEdit],
  )

  // Last non-collapsed selection made inside a paragraph editor. A ribbon
  // click moves focus off the editor and collapses the live selection, so we
  // restore this range before applying per-selection formatting.
  const savedSelectionRef = useRef<{ paragraphId: string; range: Range } | null>(null)
  useEffect(() => {
    const onSel = () => {
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0) return
      const range = sel.getRangeAt(0)
      if (range.collapsed) return
      const node = range.commonAncestorContainer
      const host = (node.nodeType === 1 ? (node as Element) : node.parentElement)
        ?.closest('[data-testid="paragraph-editor"]') as HTMLElement | null
      const pid = host?.getAttribute('data-paragraph-id')
      if (pid) savedSelectionRef.current = { paragraphId: pid, range: range.cloneRange() }
    }
    document.addEventListener('selectionchange', onSel)
    return () => document.removeEventListener('selectionchange', onSel)
  }, [])

  // Apply a character-level style. When there's a live (or just-made) text
  // selection inside the paragraph's editor, only that selection changes
  // (Acrobat-style per-run formatting); otherwise it falls back to a
  // whole-box style edit (the previous behavior).
  const applyCharStyle = useCallback(
    (
      para: ParagraphBox,
      attr: 'bold' | 'italic' | 'underline' | 'strikethrough' | 'color' | 'fontSize',
      value: boolean | string | number,
    ) => {
      const el = document.querySelector(
        `[data-paragraph-id="${CSS.escape(para.id)}"]`,
      ) as HTMLElement | null
      // Prefer a live in-editor selection; only restore the saved range when
      // focus moved to a toolbar and collapsed the live selection. (This also
      // lets automation set a selection then trigger formatting.)
      const live = window.getSelection()
      const liveUsable = !!(
        el && live && live.rangeCount > 0 &&
        !live.getRangeAt(0).collapsed &&
        el.contains(live.getRangeAt(0).commonAncestorContainer)
      )
      const saved = savedSelectionRef.current
      if (!liveUsable && el && saved && saved.paragraphId === para.id && live) {
        try {
          el.focus()
          live.removeAllRanges()
          live.addRange(saved.range)
        } catch { /* stale range — fall through to whole-box */ }
      }
      const applied = el ? formatSelection(el, attr, value, scale) : false
      if (applied && el) {
        const rawRuns = readStyledRuns(el, scale)
        const runs = editCarriesRunStyling({ runs: rawRuns } as ParagraphEdit) ? rawRuns : undefined
        const newText = readMultilineText(el)
        commitEdit(para, newText, undefined, { runs, clipToBbox: elementHasOverflow(el) })
        const sel = window.getSelection()
        if (sel && sel.rangeCount > 0 && !sel.getRangeAt(0).collapsed) {
          savedSelectionRef.current = { paragraphId: para.id, range: sel.getRangeAt(0).cloneRange() }
        }
        return
      }
      // No usable selection → whole-box style edit.
      const patch: Partial<ParagraphEdit> = { styleChanged: true }
      if (attr === 'color') patch.color = String(value)
      else if (attr === 'fontSize') patch.fontSize = Number(value)
      else {
        ;(patch as Record<string, unknown>)[attr] = !!value
        patch.requiresOverlay = true
      }
      updateFieldOnEdit(para, patch)
    },
    [scale, commitEdit, updateFieldOnEdit],
  )

  useEffect(() => {
    const onParagraphStyle = (event: Event) => {
      const detail = (event as CustomEvent<Partial<ParagraphEdit>>).detail
      if (!detail || typeof detail !== 'object') return
      const toolbarInteractionAt =
        (window as Window & { __openSatchelTextToolbarPointerAt?: number })
          .__openSatchelTextToolbarPointerAt ?? 0
      const targetId =
        activeId ??
        (Date.now() - toolbarInteractionAt < 1200 ? lastActiveIdRef.current : null)
      if (!targetId) return
      const para = renderParagraphs.find((p) => p.id === targetId)
      if (!para) return
      // Character attributes target just the selection when one exists
      // (Acrobat-style); applyCharStyle falls back to a whole-box edit when
      // nothing is selected. Box-level attributes (family, alignment,
      // line-spacing) always apply to the whole paragraph.
      let handledChar = false
      const charApply = (
        attr: 'bold' | 'italic' | 'underline' | 'strikethrough' | 'color' | 'fontSize',
        value: boolean | string | number,
      ) => {
        handledChar = true
        applyCharStyle(para, attr, value)
      }
      if (typeof detail.fontSize === 'number') charApply('fontSize', detail.fontSize)
      if (typeof detail.color === 'string') charApply('color', detail.color)
      if (typeof detail.bold === 'boolean') charApply('bold', detail.bold)
      if (typeof detail.italic === 'boolean') charApply('italic', detail.italic)
      if (typeof detail.underline === 'boolean') charApply('underline', detail.underline)
      if (typeof detail.strikethrough === 'boolean') charApply('strikethrough', detail.strikethrough)

      const patch: Partial<ParagraphEdit> = {}
      if (typeof detail.fontFamily === 'string') {
        patch.fontFamily = detail.fontFamily
        patch.requiresOverlay = true
      }
      if ('customFontId' in detail) {
        patch.customFontId =
          typeof detail.customFontId === 'string' ? detail.customFontId : undefined
        patch.requiresOverlay = true
      }
      if (typeof detail.align === 'string') patch.align = detail.align
      if (typeof (detail as { lineHeight?: unknown }).lineHeight === 'number') {
        patch.lineHeight = (detail as { lineHeight: number }).lineHeight
        patch.requiresOverlay = true
      }
      if (Object.keys(patch).length > 0) updateFieldOnEdit(para, { ...patch, styleChanged: true })
      else if (!handledChar) return
      bringParagraphToFront(para.id)
      setActiveId(para.id)
      requestAnimationFrame(() => {
        const el = document.querySelector(
          `[data-paragraph-id="${CSS.escape(para.id)}"]`,
        ) as HTMLElement | null
        el?.focus()
      })
    }
    window.addEventListener(PARAGRAPH_STYLE_EVENT, onParagraphStyle as EventListener)
    return () => {
      window.removeEventListener(PARAGRAPH_STYLE_EVENT, onParagraphStyle as EventListener)
    }
  }, [activeId, bringParagraphToFront, renderParagraphs, updateFieldOnEdit])

  const placeNewTextBox = useCallback((
    e: { target: EventTarget | null; currentTarget: HTMLDivElement; clientX: number; clientY: number },
  ) => {
    if (!active || tool !== 'text') return
    if (e.target !== e.currentTarget) return
    const rect = e.currentTarget.getBoundingClientRect()
    const pageW = basePageSize?.w ?? (width / Math.max(scale, 0.0001))
    const pageH = basePageSize?.h ?? (height / Math.max(scale, 0.0001))
    const rawX = (e.clientX - rect.left) / Math.max(scale, 0.0001)
    const rawY = (e.clientY - rect.top) / Math.max(scale, 0.0001)
    const fontSize = Math.max(1, textOptions.fontSize ?? 16)
    const lineHeight = Math.max(0.5, textOptions.lineHeight ?? DEFAULT_PARAGRAPH_LINE_HEIGHT)
    const boxWidth = Math.max(80, Math.min(ADD_TEXT_BOX_DEFAULT_WIDTH, pageW - rawX))
    const boxHeight = Math.max(fontSize * lineHeight, fontSize + 4)
    const x = Math.max(0, Math.min(rawX, Math.max(0, pageW - boxWidth)))
    const y = Math.max(0, Math.min(rawY, Math.max(0, pageH - boxHeight)))
    const id = `add_${pageIndex}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
    const edit: ParagraphEdit = {
      paragraphId: id,
      bbox: { x, y, width: boxWidth, height: boxHeight },
      maskBbox: { x, y, width: 0, height: 0 },
      originalText: '',
      newText: '',
      fontSize,
      color: textOptions.color ?? '#000000',
      backgroundColor: 'transparent',
      fontFamily: textOptions.fontFamily ?? 'Helvetica',
      bold: textOptions.bold ?? false,
      italic: textOptions.italic ?? false,
      underline: textOptions.underline ?? false,
      strikethrough: textOptions.strikethrough ?? false,
      align: textOptions.textAlign ?? 'left',
      lineHeight,
      itemIndices: [],
      itemOriginalTexts: [],
      isNewTextBox: true,
      skipSourceMask: true,
      requiresOverlay: true,
    }
    const existing = readPendingEditsForPage(tabId, pageIndex)
    writePendingEditsForPage(tabId, pageIndex, [...existing, edit], { markDirty: false })
    bringParagraphToFront(id)
    setActiveId(id)
    setTool('edit_text')
    requestAnimationFrame(() => {
      const el = document.querySelector(
        `[data-paragraph-id="${CSS.escape(id)}"]`,
      ) as HTMLElement | null
      el?.focus()
    })
  }, [
    active,
    tool,
    basePageSize,
    width,
    height,
    scale,
    textOptions,
    pageIndex,
    tabId,
    bringParagraphToFront,
    setTool,
  ])

  const markParagraphForRedaction = useCallback(
    (para: ParagraphBox, displayBbox: ParagraphBox['bbox'], delta: { dx: number; dy: number }) => {
      stageElementRedactionMark({
        tabId,
        pageIndex,
        targetId: redactionMarkTargetId('paragraph', pageIndex, para.id),
        rect: {
          left: (displayBbox.x + delta.dx) * scale,
          top: (displayBbox.y + delta.dy) * scale,
          width: displayBbox.width * scale,
          height: displayBbox.height * scale,
        },
        pageWidth: width,
        pageHeight: height,
      })
    },
    [tabId, pageIndex, scale, width, height],
  )

  /** Commit a resize. Constrained to grow-only (newBbox.width/height
   *  >= original) so saved text never gets an undersized live-edit box. */
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
    const pending = (pageEdits ?? []).filter((edit) => !edit.skipSourceMask)
    const shouldSkipMoveSourceMask = (edit: ParagraphEdit): boolean => {
      const delta = edit.positionDelta
      if (!delta || (Math.abs(delta.dx) < 0.01 && Math.abs(delta.dy) < 0.01)) {
        return false
      }
      return hasOverlappingNeighbor(edit.maskBbox ?? edit.bbox, edit.paragraphId, renderParagraphs)
    }
    const bboxes: ReturnType<typeof skipBboxFromParagraphBbox>[] = pending
      .filter((edit) => !shouldSkipMoveSourceMask(edit))
      .map((edit) => skipBboxFromParagraphBbox(
        expandPreviewMaskBbox(edit.maskBbox ?? edit.bbox, basePageSize),
        basePageSize.h,
      ))
    // Also include the currently-active paragraph so the engine renders
    // the stripped background BEFORE the first keystroke — removes the
    // "white rect then correction" phase the user feels at edit-start.
    // If the active paragraph already has a pending edit, it's already
    // in `bboxes` via the map above; `pendingHasActive` guards against
    // emitting the same bbox twice (which would make the engine emit
    // the same object.gen twice and waste a re-render).
    if (activeId) {
      const activePara = renderParagraphs.find((p) => p.id === activeId)
      const pendingHasActive =
        activePara && pending.some((e) => e.paragraphId === activeId)
      if (activePara && !activePara.isNewTextBox && !pendingHasActive) {
        bboxes.push(
          skipBboxFromParagraphBbox(
            previewMaskBboxForStyle(
              activePara.bbox,
              basePageSize,
              activePara,
              activePara.fontSize,
            ),
            basePageSize.h,
          ),
        )
      }
    }
    if (movePreviewRegion) {
      bboxes.push(skipBboxFromParagraphBbox(
        expandPreviewMaskBbox(movePreviewRegion.bbox, basePageSize),
        basePageSize.h,
      ))
    }
    return bboxes
  }, [pageEdits, basePageSize, activeId, renderParagraphs, movePreviewRegion])

  const enginePreviewRegions = useMemo(() => {
    if (!basePageSize) return []
    const pending = (pageEdits ?? []).filter((edit) => !edit.skipSourceMask)
    const paragraphById = new Map(renderParagraphs.map((p) => [p.id, p]))
    const shouldSkipMoveSourceMask = (edit: ParagraphEdit): boolean => {
      const delta = edit.positionDelta
      if (!delta || (Math.abs(delta.dx) < 0.01 && Math.abs(delta.dy) < 0.01)) {
        return false
      }
      return hasOverlappingNeighbor(edit.maskBbox ?? edit.bbox, edit.paragraphId, renderParagraphs)
    }
    const regions: EnginePreviewRegion[] = pending
      .filter((edit) => !shouldSkipMoveSourceMask(edit))
      .map((edit) => ({
        bbox: expandPreviewMaskBbox(edit.maskBbox ?? edit.bbox, basePageSize),
        backgroundColor:
          edit.backgroundColor ??
          paragraphById.get(edit.paragraphId)?.backgroundColor ??
          '#ffffff',
        preferSolidMask:
          edit.positionDelta !== undefined &&
          (Math.abs(edit.positionDelta.dx) >= 0.01 || Math.abs(edit.positionDelta.dy) >= 0.01),
      }))
    if (activeId) {
      const activePara = renderParagraphs.find((p) => p.id === activeId)
      const pendingHasActive =
        activePara && pending.some((e) => e.paragraphId === activeId)
      if (activePara && !activePara.isNewTextBox && !pendingHasActive) {
        regions.push({
          bbox: previewMaskBboxForStyle(
            activePara.bbox,
            basePageSize,
            activePara,
            activePara.fontSize,
          ),
          backgroundColor: activePara.backgroundColor ?? '#ffffff',
        })
      }
    }
    if (movePreviewRegion) {
      regions.push({
        ...movePreviewRegion,
        bbox: expandPreviewMaskBbox(movePreviewRegion.bbox, basePageSize),
      })
    }
    const seen = new Set<string>()
    return regions.filter((region) => {
      const bbox = region.bbox
      const key = `${bbox.x.toFixed(2)}:${bbox.y.toFixed(2)}:${bbox.width.toFixed(2)}:${bbox.height.toFixed(2)}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }, [pageEdits, activeId, renderParagraphs, movePreviewRegion, basePageSize])

  const overlapSourceRedrawRegions = useMemo<OverlapSourceRedrawRegion[]>(() => {
    if (!basePageSize) return []
    const pending = (pageEdits ?? []).filter((edit) => !edit.skipSourceMask)
    const paragraphById = new Map(renderParagraphs.map((p) => [p.id, p]))
    const movedOverlapRegions: OverlapSourceRedrawRegion[] = []
    for (const edit of pending) {
      const delta = edit.positionDelta
      if (!delta || (Math.abs(delta.dx) < 0.01 && Math.abs(delta.dy) < 0.01)) {
        continue
      }
      const sourcePara = paragraphById.get(edit.paragraphId)
      const sourceBbox = edit.maskBbox ?? sourcePara?.bbox ?? edit.bbox
      const redrawParagraphs = renderParagraphs.filter((p) => {
        if (p.id === edit.paragraphId) return false
        if (!paragraphBboxesOverlap(sourceBbox, p.bbox)) return false
        const neighborEdit = pendingById.get(p.id)
        const neighborDelta = neighborEdit?.positionDelta
        return !neighborDelta || (
          Math.abs(neighborDelta.dx) < 0.01 &&
          Math.abs(neighborDelta.dy) < 0.01
        )
      })
      if (redrawParagraphs.length === 0) continue
      movedOverlapRegions.push({
        bbox: expandPreviewMaskBbox(sourceBbox, basePageSize),
        backgroundColor:
          edit.backgroundColor ??
          sourcePara?.backgroundColor ??
          '#ffffff',
        redrawParagraphs,
      })
    }
    return movedOverlapRegions
  }, [pageEdits, renderParagraphs, pendingById, basePageSize])

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
  const { pngUrl: engineStripPngUrl, loading: engineStripLoading } = useEngineStrippedRender({
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

  const orderedParagraphs = useMemo(() => {
    if (frontParagraphStack.length === 0) return renderParagraphs
    const originalOrder = new Map(renderParagraphs.map((p, index) => [p.id, index]))
    const stackOrder = new Map(frontParagraphStack.map((id, index) => [id, index]))
    return [...renderParagraphs].sort((a, b) => {
      const ar = stackOrder.get(a.id)
      const br = stackOrder.get(b.id)
      if (ar === undefined && br === undefined) {
        return (originalOrder.get(a.id) ?? 0) - (originalOrder.get(b.id) ?? 0)
      }
      if (ar === undefined) return -1
      if (br === undefined) return 1
      return ar - br
    })
  }, [renderParagraphs, frontParagraphStack])

  const topParagraphId = frontParagraphStack[frontParagraphStack.length - 1] ?? null

  return (
    <>
      {enginePreviewRegions.map((region, i) => {
        const bbox = region.bbox
        const showFallback = region.preferSolidMask || engineStripLoading || !engineStripPngUrl
        return (
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
              background: showFallback ? (region.backgroundColor ?? '#ffffff') : 'transparent',
            }}
          >
            {!showFallback && (
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
            )}
          </div>
        )
      })}
      {overlapSourceRedrawRegions.map((region, i) => {
        const bbox = region.bbox
        return (
          <div
            key={`overlap-source:${bbox.x}:${bbox.y}:${bbox.width}:${bbox.height}:${i}`}
            data-testid="overlap-source-redraw-region"
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
              background: region.backgroundColor ?? '#ffffff',
            }}
          >
            {region.redrawParagraphs.map((p) => {
              const pending = pendingById.get(p.id)
              const redrawBbox = pending?.bbox ?? p.bbox
              const text = pending?.newText ?? p.originalText
              const fontSize = pending?.fontSize ?? p.fontSize
              const fontFamily = pending?.fontFamily ?? p.fontFamily ?? FALLBACK_FONT_STACK
              const color = pending?.color ?? p.color
              const lineHeight = (pending as { lineHeight?: number } | undefined)?.lineHeight ?? 1.2
              return (
                <div
                  key={p.id}
                  style={{
                    position: 'absolute',
                    left: (redrawBbox.x - bbox.x) * engineRenderScale,
                    top: (redrawBbox.y - bbox.y) * engineRenderScale,
                    width: redrawBbox.width * engineRenderScale,
                    height: redrawBbox.height * engineRenderScale,
                    overflow: 'hidden',
                    color,
                    fontFamily,
                    fontSize: Math.max(6, fontSize * engineRenderScale),
                    fontWeight: p.bold ? 700 : 400,
                    fontStyle: p.italic ? 'italic' : 'normal',
                    lineHeight,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {text}
                </div>
              )
            })}
          </div>
        )
      })}
      {active && tool === 'edit_text' && clusterDone && paragraphs.length === 0 && (
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
                {linkingFrames.length === 1 ? ' - click another paragraph to add' : ''}
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
      onClick={placeNewTextBox}
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
        pointerEvents: tool === 'text' ? 'auto' : 'none',
        cursor: tool === 'text' ? 'text' : 'default',
      }}
      data-testid="editable-paragraph-layer"
      data-active={active ? '1' : '0'}
    >
      {active && orderedParagraphs.map((p) => {
        const pending = pendingById.get(p.id)
        const isDirty = dirtyById.has(p.id)
        const isSavedPreview = savedPreviewById.has(p.id)
        const text = pending?.newText ?? p.originalText
        const committedDelta = pending?.positionDelta ?? { dx: 0, dy: 0 }
        const currentFontSize = pending?.fontSize ?? p.fontSize
        const currentColor = pending?.color ?? p.color
        const currentFontFamily = pending?.fontFamily ?? p.fontFamily ?? 'Helvetica'
        const currentBold = pending?.bold ?? p.bold
        const currentItalic = pending?.italic ?? p.italic
        const currentUnderline = pending?.underline ?? false
        const currentStrikethrough = pending?.strikethrough ?? false
        // ParagraphBox doesn't carry lineHeight today (originals come
        // from pdfjs item heights, not from the source PDF's TL); the
        // pending entry tracks user overrides. Default 1.2 mirrors
        // browsers / Word.
        const currentLineHeight = (pending as { lineHeight?: number } | undefined)?.lineHeight ?? 1.2
        const redactionTargetId = redactionMarkTargetId('paragraph', pageIndex, p.id)
        const isRedactionMarked = fabricJsonHasRedactionMarkForTarget(pageFabricJSON, redactionTargetId)
        return (
          <ParagraphEditor
            key={p.id}
            paragraph={p}
            scale={scale}
            pageWidth={basePageSize?.w ?? 0}
            pageHeight={basePageSize?.h ?? 0}
            active={activeId === p.id}
            isFront={topParagraphId === p.id}
            isEdited={!!pending}
            isDirty={isDirty}
            isSavedPreview={isSavedPreview}
            displayBbox={pending?.bbox ?? p.bbox}
            initialText={text}
            initialRuns={pending?.runs ?? p.runs}
            currentAlign={pending?.align ?? 'left'}
            committedDelta={committedDelta}
            currentFontSize={currentFontSize}
            currentColor={currentColor}
            currentFontFamily={currentFontFamily}
            currentLineHeight={currentLineHeight}
            currentBold={currentBold}
            currentItalic={currentItalic}
            currentUnderline={currentUnderline}
            currentStrikethrough={currentStrikethrough}
            markRedactionMode={tool === 'mark_redaction'}
            isRedactionMarked={isRedactionMarked}
            onMarkRedaction={() => markParagraphForRedaction(p, pending?.bbox ?? p.bbox, committedDelta)}
            onActivate={() => {
              // While linkingMode is on, paragraph clicks ADD frames
              // to the in-progress chain instead of activating for
              // edit. User clicks End chain to finalize (writes
              // _linkedChains) or Cancel to discard.
              if (linkingMode) {
                addFrameToLinkChain(p)
                return
              }
              bringParagraphToFront(p.id)
              setActiveId(p.id)
            }}
            onBringToFront={() => bringParagraphToFront(p.id)}
            onDeactivate={() => setActiveId(null)}
            onCommit={(newText, options) => commitEdit(p, newText, undefined, options)}
            onAlign={(align) => setParagraphAlign(p, align)}
            onMove={(delta) => commitMove(p, delta)}
            onMovePreview={(bbox) => {
              const sourceMaskBbox = basePageSize
                ? previewMaskBboxForStyle(
                  bbox,
                  basePageSize,
                  pending ?? p,
                  currentFontSize,
                )
                : bbox
              if (hasOverlappingNeighbor(sourceMaskBbox, p.id, renderParagraphs)) {
                setMovePreviewRegion(null)
                return
              }
              setMovePreviewRegion({
                bbox: sourceMaskBbox,
                backgroundColor: p.backgroundColor ?? '#ffffff',
                preferSolidMask: true,
              })
            }}
            onMovePreviewEnd={() => setMovePreviewRegion(null)}
            onSuppressNextLayerClick={suppressNextLayerClickAfterDrag}
            onCrossPageDrop={(toPage, toBbox) => {
              // True drag-and-drop across pages: emit a ParagraphMove
              // that lands centered at the drop point on the
              // destination page. Save expands this into a (mask
              // source + draw at toBbox) edit pair.
              const pending = readPendingEditsForPage(tabId, pageIndex).find(
                (e) => e.paragraphId === p.id,
              )
              const text = pending?.newText ?? p.originalText
              const runs = pending?.runs ?? p.runs
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
                ...(runs ? { runs } : {}),
              })
              // Clear the activeId so the source-page editor doesn't
              // keep showing a stale active state for a paragraph
              // that's now visually on another page.
              setActiveId(null)
              setFrontParagraphStack((prev) => prev.filter((id) => id !== p.id))
            }}
            pageIndexForDrag={pageIndex}
            onFontSize={(size) => applyCharStyle(p, 'fontSize', size)}
            onColor={(hex) => applyCharStyle(p, 'color', hex)}
            onFontFamily={(ff) => setParagraphFontFamily(p, ff)}
            onLineHeight={(lh) => setParagraphLineHeight(p, lh)}
            onBold={(bold) => applyCharStyle(p, 'bold', bold)}
            onItalic={(italic) => applyCharStyle(p, 'italic', italic)}
            onUnderline={(underline) => applyCharStyle(p, 'underline', underline)}
            onStrikethrough={(strikethrough) => applyCharStyle(p, 'strikethrough', strikethrough)}
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
  isFront: boolean
  isEdited: boolean
  isDirty: boolean
  isSavedPreview: boolean
  displayBbox: ParagraphBox['bbox']
  initialText: string
  /** Styled character runs for the current edit, if any. When present the
   *  editor seeds rich (per-span) HTML instead of plain text. */
  initialRuns?: StyledRun[]
  currentAlign: TextAlign
  /** Committed drag offset from the store (in viewport units). Live drag
   *  additions are layered on top while the pointer is down. */
  committedDelta: { dx: number; dy: number }
  onActivate: () => void
  onBringToFront: () => void
  onDeactivate: () => void
  onCommit: (newText: string, options?: ParagraphCommitOptions) => void
  onAlign: (align: TextAlign) => void
  onMove: (delta: { dx: number; dy: number }) => void
  onMovePreview: (bbox: ParagraphBox['bbox']) => void
  onMovePreviewEnd: () => void
  onSuppressNextLayerClick: () => void
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
  /** Phase E (docs/MODELESS.md): contextual toolbar tweaks. */
  currentFontSize: number
  currentColor: string
  onFontSize: (size: number) => void
  onColor: (hex: string) => void
  /** Font family + line spacing — added in the parity sprint.
   *  Defaults to 'Helvetica' / 1.2 if the paragraph has no override. */
  currentFontFamily: string
  currentLineHeight: number
  currentBold: boolean
  currentItalic: boolean
  currentUnderline: boolean
  currentStrikethrough: boolean
  markRedactionMode: boolean
  isRedactionMarked: boolean
  onMarkRedaction: () => void
  onFontFamily: (fontFamily: string) => void
  onLineHeight: (lineHeight: number) => void
  onBold: (bold: boolean) => void
  onItalic: (italic: boolean) => void
  onUnderline: (underline: boolean) => void
  onStrikethrough: (strikethrough: boolean) => void
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

function elementHasOverflow(el: HTMLElement): boolean {
  return (
    el.scrollHeight > el.clientHeight + 1 ||
    el.scrollWidth > el.clientWidth + 1
  )
}

function ParagraphEditor({
  paragraph,
  scale,
  pageWidth,
  pageHeight,
  active,
  isFront,
  isEdited,
  isDirty,
  isSavedPreview,
  displayBbox,
  initialText,
  initialRuns,
  currentAlign,
  committedDelta,
  onActivate,
  onBringToFront,
  onDeactivate,
  onCommit,
  onAlign,
  onMove,
  onMovePreview,
  onMovePreviewEnd,
  onSuppressNextLayerClick,
  onCrossPageDrop,
  pageIndexForDrag,
  currentFontSize,
  currentColor,
  onFontSize,
  onColor,
  currentFontFamily,
  currentLineHeight,
  currentBold,
  currentItalic,
  currentUnderline,
  currentStrikethrough,
  markRedactionMode,
  isRedactionMarked,
  onMarkRedaction,
  onFontFamily,
  onLineHeight,
  onBold,
  onItalic,
  onUnderline,
  onStrikethrough,
  onResize,
}: ParagraphEditorProps) {
  const divRef = useRef<HTMLDivElement>(null)
  // Shadow state so we don't rewrite the div on every commit (would reset
  // caret). We only seed it when (paragraph,initialText) changes.
  const seededRef = useRef<string>('')
  const editStartTextRef = useRef(initialText)
  const wasActiveRef = useRef(false)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [hasOverflow, setHasOverflow] = useState(false)

  useEffect(() => {
    if (active && !wasActiveRef.current) {
      editStartTextRef.current = initialText
    }
    if (!active) {
      editStartTextRef.current = initialText
      setFocused(false)
    }
    wasActiveRef.current = active
  }, [active, initialText])

  useEffect(() => {
    if (!active) return
    const syncFocus = () => setFocused(document.activeElement === divRef.current)
    syncFocus()
    const raf = requestAnimationFrame(syncFocus)
    return () => cancelAnimationFrame(raf)
  }, [active])

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
    // Rich seed when the edit carries per-run styling: spans instead of a
    // flat text node, so mixed bold/size/color shows live. seedSig keys the
    // re-seed decision so changing runs (while not typing) re-renders, but a
    // matching signature skips the rewrite that would reset the caret.
    const richHtml =
      initialRuns && editCarriesRunStyling({ runs: initialRuns } as ParagraphEdit)
        ? runsToHtml(initialRuns, scale)
        : null
    const seedSig = richHtml !== null ? `h:${richHtml}` : `t:${initialText}`
    const currentText = el.textContent ?? ''
    const focused = document.activeElement === el || el.contains(document.activeElement)
    if (active && focused && currentText.length > 0 && currentText === initialText) {
      seededRef.current = seedSig
      return
    }
    if (currentText !== initialText || seededRef.current !== seedSig) {
      if (richHtml !== null) el.innerHTML = richHtml
      else el.textContent = initialText
      seededRef.current = seedSig
    }
  }, [initialText, initialRuns, scale, active])

  const measureOverflow = useCallback(() => {
    requestAnimationFrame(() => {
      const el = divRef.current
      if (!el) return
      setHasOverflow(elementHasOverflow(el))
    })
  }, [])

  useEffect(() => {
    measureOverflow()
  }, [
    measureOverflow,
    initialText,
    active,
    currentAlign,
    currentFontSize,
    currentLineHeight,
    displayBbox.width,
    displayBbox.height,
    scale,
  ])

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
  const suppressImmediateDragClick = useCallback(() => {
    justDraggedRef.current = true
    // Chromium normally emits the drag-ending click immediately after
    // pointerup, before timers run. If it suppresses that click, clear the
    // guard so the user's next intentional click still opens the editor.
    window.setTimeout(() => {
      justDraggedRef.current = false
    }, 0)
  }, [])

  const clampDelta = useCallback(
    (dx: number, dy: number): { dx: number; dy: number } => {
      // Keep at least a small portion of the box on-page so the user
      // can always grab it again. Clamp against pageWidth/pageHeight
      // (which are scale=1, matching bbox units).
      if (pageWidth <= 0 || pageHeight <= 0) return { dx, dy }
      const minVisible = 12 // viewport units
      const minX = minVisible - displayBbox.x - displayBbox.width
      const maxX = pageWidth - displayBbox.x - minVisible
      const minY = minVisible - displayBbox.y - displayBbox.height
      const maxY = pageHeight - displayBbox.y - minVisible
      return {
        dx: Math.max(minX, Math.min(maxX, dx)),
        dy: Math.max(minY, Math.min(maxY, dy)),
      }
    },
    [pageWidth, pageHeight, displayBbox.x, displayBbox.y, displayBbox.width, displayBbox.height],
  )

  const left = (displayBbox.x + localDelta.dx) * scale
  const top = (displayBbox.y + localDelta.dy) * scale
  const boxW = displayBbox.width * scale
  const boxH = displayBbox.height * scale
  const displayFontSize = Math.max(6, currentFontSize * scale)
  // Resolved font stack from pdfjs styles, with fallback.
  const fontStack = currentFontFamily || paragraph.fontFamily || FALLBACK_FONT_STACK
  const isDragging = pointerRef.current?.dragging === true

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (markRedactionMode) {
      e.preventDefault()
      e.stopPropagation()
      onMarkRedaction()
      return
    }
    // While editing text, let the contenteditable handle pointer events
    // normally (caret placement, text selection). Drag only applies to
    // unopened paragraphs.
    if (active) return
    if (e.button !== 0) return
    onBringToFront()
    onDeactivate()
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
      onBringToFront()
      onMovePreview(displayBbox)
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
      onBringToFront()
      onSuppressNextLayerClick()
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
          x: dropX - displayBbox.width / 2,
          y: dropY - displayBbox.height / 2,
          width: displayBbox.width,
          height: displayBbox.height,
        }
        onCrossPageDrop(toPageIdx, toBbox)
        suppressImmediateDragClick()
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
      suppressImmediateDragClick()
    }
  }

  // When the paragraph has been moved, the engine-strip dirty region in
  // the parent repaints the source bbox from an object-suppressed page
  // preview. This child only renders the lifted text at its live
  // position; it never paints a source mask.
  const hasMoved = Math.abs(localDelta.dx) > 0.01 || Math.abs(localDelta.dy) > 0.01
  const movedPreviewWidthSlack = hasMoved && !active ? Math.max(48, displayFontSize * 8) : 0
  const previewMaskBackground = paragraph.backgroundColor === 'transparent'
    ? 'transparent'
    : paragraph.backgroundColor || (paragraph.onDarkBackground ? '#0f1115' : '#ffffff')
  const shouldMaskEditorBackground = active || isEdited || hasMoved || isDragging
  const isEditing = active && focused
  const paragraphState = isEditing
    ? 'editing'
    : isRedactionMarked
      ? 'redaction-marked'
      : active
      ? 'active'
      : isSavedPreview
        ? 'saved-preview'
        : isDirty
          ? 'dirty'
          : hovered
            ? 'hover'
            : 'idle'
  const outline =
    paragraphState === 'editing'
      ? '2px solid #0ea5e9'
      : paragraphState === 'redaction-marked'
        ? '3px solid #000000'
      : paragraphState === 'active'
        ? '2px solid #2563eb'
        : paragraphState === 'dirty'
          ? '1.5px solid #f59e0b'
          : paragraphState === 'saved-preview'
            ? '1.5px solid #22c55e'
            : paragraphState === 'hover'
              ? '1px dashed rgba(37, 99, 235, 0.85)'
              : '1px dashed rgba(37, 99, 235, 0.32)'
  const outlineOffset = isRedactionMarked ? 0 : active || isEdited || hovered ? 2 : 1
  const selectionShadow =
    paragraphState === 'editing'
      ? '0 0 0 4px rgba(14, 165, 233, 0.14)'
      : paragraphState === 'redaction-marked'
        ? '0 0 0 2px rgba(0, 0, 0, 0.20)'
      : paragraphState === 'active'
        ? '0 0 0 4px rgba(37, 99, 235, 0.12)'
        : paragraphState === 'dirty'
          ? '0 0 0 3px rgba(245, 158, 11, 0.10)'
          : paragraphState === 'saved-preview'
            ? '0 0 0 3px rgba(34, 197, 94, 0.10)'
            : 'none'
  const visibleTextColor = currentColor || paragraph.color
  const layerZ = isDragging
    ? 10
    : active
      ? 9
      : isFront
        ? 8
        : (isEdited || hasMoved)
          ? 7
          : 5
  return (
    <>
    {active && (
      <ResizeGrips
        left={left}
        top={top}
        width={boxW}
        height={boxH}
        scale={scale}
        baseBbox={displayBbox}
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
        currentBold={currentBold}
        currentItalic={currentItalic}
        currentUnderline={currentUnderline}
        currentStrikethrough={currentStrikethrough}
        onAlign={onAlign}
        onFontSize={onFontSize}
        onColor={onColor}
        onFontFamily={onFontFamily}
        onLineHeight={onLineHeight}
        onBold={onBold}
        onItalic={onItalic}
        onUnderline={onUnderline}
        onStrikethrough={onStrikethrough}
      />
    )}
    <div
      style={{
        position: 'absolute',
        left,
        top,
        width: boxW + movedPreviewWidthSlack,
        height: boxH,
        boxSizing: 'border-box',
        pointerEvents: 'auto',
        zIndex: layerZ,
        cursor: markRedactionMode ? 'pointer' : active ? 'text' : isDragging ? 'grabbing' : 'grab',
        outline: isDragging ? '2px solid #0ea5e9' : outline,
        outlineOffset,
        boxShadow: isDragging ? '0 0 0 4px rgba(14, 165, 233, 0.14)' : selectionShadow,
        // Mask the canvas beneath the live paragraph. Moved paragraphs
        // need the same destination mask after drag-end; otherwise an
        // overlapped paragraph underneath can visually bleed through
        // even though the moved paragraph is the correct top hit target.
        background: shouldMaskEditorBackground ? previewMaskBackground : 'transparent',
        color: active || isEdited || isDragging ? visibleTextColor : 'transparent',
        caretColor: visibleTextColor,
        fontFamily: fontStack,
        fontSize: displayFontSize,
        fontWeight: currentBold ? 700 : 400,
        fontStyle: currentItalic ? 'italic' : 'normal',
        textDecorationLine: [
          currentUnderline ? 'underline' : '',
          currentStrikethrough ? 'line-through' : '',
        ].filter(Boolean).join(' ') || 'none',
        // Reflect alignment live in the contenteditable so the in-edit
        // view matches what save will produce.
        textAlign: currentAlign === 'justify' ? 'justify' : currentAlign,
        lineHeight: currentLineHeight,
        padding: 0,
        overflow: 'hidden',
        whiteSpace: hasMoved && !active ? 'pre' : 'pre-wrap',
        wordBreak: hasMoved && !active ? 'normal' : 'break-word',
        // Suppress default text selection during drag — otherwise
        // clicking-and-dragging would start a selection before our
        // threshold kicks in.
        userSelect: active ? 'text' : 'none',
        WebkitUserSelect: active ? 'text' : 'none',
        // Prevent the browser's native drag-ghost on text.
        touchAction: 'none',
      }}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClick={() => {
        if (markRedactionMode) return
        if (justDraggedRef.current) {
          // Click that follows a drag release — swallow it, don't
          // activate the editor.
          justDraggedRef.current = false
          return
        }
        if (!active) {
          onBringToFront()
          onActivate()
          // Defer focus so the browser applies contentEditable before
          // .focus(); otherwise caret placement is flaky.
          requestAnimationFrame(() => {
            divRef.current?.focus()
            setFocused(document.activeElement === divRef.current)
            measureOverflow()
          })
        }
      }}
      onFocus={() => {
        setFocused(true)
        measureOverflow()
      }}
      onBlur={(e) => {
        setFocused(false)
        // Use readMultilineText (innerText-style) instead of textContent
        // so user-pressed Enter / inserted <div>/<br> survives as \n.
        // textContent flattened newlines and the engine saw a single
        // line — that was G7 in the ledger.
        const el = e.currentTarget as HTMLDivElement
        const newText = readMultilineText(el)
        // Capture per-run styling from the live DOM (spans). undefined when
        // the box is plain, so plain edits stay on the flat/rewrite path.
        const rawRuns = readStyledRuns(el, scale)
        const runs = editCarriesRunStyling({ runs: rawRuns } as ParagraphEdit) ? rawRuns : undefined
        onCommit(newText, { runs, clipToBbox: elementHasOverflow(el) })
        const nextFocus = e.relatedTarget
        const toolbarInteractionAt =
          (window as Window & { __openSatchelTextToolbarPointerAt?: number })
            .__openSatchelTextToolbarPointerAt ?? 0
        const fromTextToolbar = Date.now() - toolbarInteractionAt < 800
        const focusMovedToToolbar =
          nextFocus instanceof Element &&
          nextFocus.closest('[data-testid="paragraph-context-toolbar"], [data-group-label="Text"]')
        if (fromTextToolbar || focusMovedToToolbar) {
          measureOverflow()
          return
        }
        window.setTimeout(() => {
          const latestToolbarInteractionAt =
            (window as Window & { __openSatchelTextToolbarPointerAt?: number })
              .__openSatchelTextToolbarPointerAt ?? 0
          const latestFocus = document.activeElement
          const toolbarStillOwnsInteraction =
            Date.now() - latestToolbarInteractionAt < 800 ||
            (
              latestFocus instanceof Element &&
              latestFocus.closest('[data-testid="paragraph-context-toolbar"], [data-group-label="Text"]')
            )
          if (toolbarStillOwnsInteraction) {
            measureOverflow()
            return
          }
          onDeactivate()
          measureOverflow()
        }, 0)
      }}
      onInput={(e) => {
        // Commit on every input so state is always up to date. We skip
        // rewriting div contents on commit (seededRef guard above), so
        // the caret doesn't jump.
        const el = e.currentTarget as HTMLDivElement
        const newText = readMultilineText(el)
        // Capture per-run styling from the live DOM (spans). undefined when
        // the box is plain, so plain edits stay on the flat/rewrite path.
        const rawRuns = readStyledRuns(el, scale)
        const runs = editCarriesRunStyling({ runs: rawRuns } as ParagraphEdit) ? rawRuns : undefined
        onCommit(newText, { runs, clipToBbox: elementHasOverflow(el) })
        measureOverflow()
      }}
      onKeyDown={(e) => {
        // Escape: cancel the current edit session, blur.
        if (e.key === 'Escape') {
          e.preventDefault()
          const cancelText = editStartTextRef.current
          if (divRef.current) {
            divRef.current.textContent = cancelText
            seededRef.current = cancelText
          }
          onCommit(cancelText, {
            clipToBbox: divRef.current ? elementHasOverflow(divRef.current) : false,
          })
          measureOverflow()
          divRef.current?.blur()
          return
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
      data-testid="paragraph-editor"
      data-paragraph-id={paragraph.id}
      data-paragraph-state={paragraphState}
      data-dirty={isDirty ? '1' : '0'}
      data-front={isFront ? '1' : '0'}
      data-saved-preview={isSavedPreview ? '1' : '0'}
      data-overflow={hasOverflow ? '1' : '0'}
      data-focused={focused ? '1' : '0'}
      data-layout-role={paragraph.layout?.role ?? ''}
      data-layout-safe={paragraph.layout?.safeForAutoReflow === false ? '0' : '1'}
      data-layout-flow={paragraph.layout?.flowId ?? ''}
      data-layout-reasons={paragraph.layout?.reasons?.join('; ') ?? ''}
      data-layout-align={paragraph.layout?.align ?? ''}
      data-font-generic-fallback={paragraph.fontFamilyIsGenericFallback === true ? '1' : '0'}
    />
    {hasOverflow && (active || isEdited) && (
      <div
        data-testid="paragraph-overflow-indicator"
        title="Text overflow"
        style={{
          position: 'absolute',
          left: left + boxW + movedPreviewWidthSlack + 3,
          top: top + boxH - 9,
          width: 9,
          height: 9,
          background: '#f97316',
          clipPath: 'polygon(0 0, 100% 50%, 0 100%)',
          pointerEvents: 'none',
          zIndex: 22,
          filter: 'drop-shadow(0 1px 1px rgba(0,0,0,0.28))',
        }}
      />
    )}
    </>
  )
}

// ── Paragraph context toolbar ────────────────────────────────────
// Phase E of docs/MODELESS.md. Floating strip that appears above the
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
const PARAGRAPH_STYLE_EVENT = 'open-satchel:paragraph-style'

interface ParagraphContextToolbarProps {
  left: number
  top: number
  width: number
  currentAlign: TextAlign
  currentFontSize: number
  currentColor: string
  currentFontFamily: string
  currentLineHeight: number
  currentBold: boolean
  currentItalic: boolean
  currentUnderline: boolean
  currentStrikethrough: boolean
  onAlign: (align: TextAlign) => void
  onFontSize: (size: number) => void
  onColor: (hex: string) => void
  onFontFamily: (fontFamily: string) => void
  onLineHeight: (lineHeight: number) => void
  onBold: (bold: boolean) => void
  onItalic: (italic: boolean) => void
  onUnderline: (underline: boolean) => void
  onStrikethrough: (strikethrough: boolean) => void
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
  currentBold,
  currentItalic,
  currentUnderline,
  currentStrikethrough,
  onAlign,
  onFontSize,
  onColor,
  onFontFamily,
  onLineHeight,
  onBold,
  onItalic,
  onUnderline,
  onStrikethrough,
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
        minWidth: 286,
        maxWidth: Math.max(320, width),
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
      // toolbar buttons. Native form controls need their default
      // mousedown so select menus and color pickers can open.
      onMouseDown={(e) => {
        ;(window as Window & { __openSatchelTextToolbarPointerAt?: number })
          .__openSatchelTextToolbarPointerAt = Date.now()
        const target = e.target
        if (
          target instanceof Element &&
          target.closest('select, input, textarea, option')
        ) {
          return
        }
        e.preventDefault()
      }}
      onPointerDown={(e) => {
        ;(window as Window & { __openSatchelTextToolbarPointerAt?: number })
          .__openSatchelTextToolbarPointerAt = Date.now()
        const target = e.target
        if (
          target instanceof Element &&
          target.closest('select, input, textarea, option')
        ) {
          return
        }
        e.preventDefault()
      }}
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
      <button
        type="button"
        title="Bold"
        onClick={() => onBold(!currentBold)}
        data-testid="paragraph-context-bold"
        style={{
          width: 24,
          height: 22,
          fontSize: 13,
          lineHeight: '20px',
          fontWeight: 700,
          background: currentBold ? 'var(--accent, #3b82f6)' : 'transparent',
          color: currentBold ? '#fff' : 'var(--text-primary, #e6e8ec)',
          border: 'none',
          borderRadius: 3,
          cursor: 'pointer',
          padding: 0,
        }}
      >
        B
      </button>
      <button
        type="button"
        title="Italic"
        onClick={() => onItalic(!currentItalic)}
        data-testid="paragraph-context-italic"
        style={{
          width: 24,
          height: 22,
          fontSize: 13,
          lineHeight: '20px',
          fontStyle: 'italic',
          background: currentItalic ? 'var(--accent, #3b82f6)' : 'transparent',
          color: currentItalic ? '#fff' : 'var(--text-primary, #e6e8ec)',
          border: 'none',
          borderRadius: 3,
          cursor: 'pointer',
          padding: 0,
        }}
      >
        I
      </button>
      <button
        type="button"
        title="Underline"
        onClick={() => onUnderline(!currentUnderline)}
        data-testid="paragraph-context-underline"
        style={{
          width: 24,
          height: 22,
          fontSize: 13,
          lineHeight: '20px',
          textDecorationLine: 'underline',
          background: currentUnderline ? 'var(--accent, #3b82f6)' : 'transparent',
          color: currentUnderline ? '#fff' : 'var(--text-primary, #e6e8ec)',
          border: 'none',
          borderRadius: 3,
          cursor: 'pointer',
          padding: 0,
        }}
      >
        U
      </button>
      <button
        type="button"
        title="Strikethrough"
        onClick={() => onStrikethrough(!currentStrikethrough)}
        data-testid="paragraph-context-strikethrough"
        style={{
          width: 24,
          height: 22,
          fontSize: 13,
          lineHeight: '20px',
          textDecorationLine: 'line-through',
          background: currentStrikethrough ? 'var(--accent, #3b82f6)' : 'transparent',
          color: currentStrikethrough ? '#fff' : 'var(--text-primary, #e6e8ec)',
          border: 'none',
          borderRadius: 3,
          cursor: 'pointer',
          padding: 0,
        }}
      >
        S
      </button>
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
        data-testid="paragraph-context-font-size"
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
    const SIZE = 8
    const HALF = SIZE / 2
    const GAP = 3
    // X position: left for nw/w/sw, right for ne/e/se, center for n/s.
    let cx = 0
    if (corner === 'nw' || corner === 'w' || corner === 'sw') cx = left - SIZE - GAP
    else if (corner === 'ne' || corner === 'e' || corner === 'se') cx = left + width + GAP
    else cx = left + width / 2 - HALF
    // Y position: top for nw/n/ne, bottom for sw/s/se, center for w/e.
    let cy = 0
    if (corner === 'nw' || corner === 'n' || corner === 'ne') cy = top - SIZE - GAP
    else if (corner === 'sw' || corner === 's' || corner === 'se') cy = top + height + GAP
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
      borderRadius: 2,
      background: '#ffffff',
      border: '1px solid #2563eb',
      cursor,
      zIndex: 21,
      pointerEvents: 'auto',
      boxShadow: '0 1px 3px rgba(0,0,0,0.35)',
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
