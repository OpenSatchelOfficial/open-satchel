import React, { useEffect, useRef, useState } from 'react'
import './PdfToolbar.css'
import { useFontStore } from '../../stores/fontStore'
import type { FormatViewerProps } from '../types'
import { useUIStore } from '../../stores/uiStore'
import { useFormatStore } from '../../stores/formatStore'
import { useTabStore } from '../../stores/tabStore'
import type { TextOptions, Tool } from '../../types/pdf'
import type { PdfFormatState } from './index'
import { STAMPS, STAMP_TOKEN_SHORTCUTS, TEXT_STAMP_INDEX } from '../../components/editor/StampTool'
import WatermarkDialog, { type WatermarkOptions } from './WatermarkDialog'
import PasswordDialog from './PasswordDialog'
import CertEncryptDialog from './CertEncryptDialog'
import PdfPageManager from './PdfPageManager'
import PdfMergeDialog from './PdfMergeDialog'
import OcrDialog from './OcrDialog'
import HeaderFooterDialog from './HeaderFooterDialog'
import FontPicker from './FontPicker'
import PageSizeDialog from './PageSizeDialog'
import PdfAdvancedDialog from './PdfAdvancedDialog'
import SnipPinDialog from './SnipPinDialog'
import SearchAndRedactDialog from './SearchAndRedactDialog'
import BatchDialog from './BatchDialog'
import WatchedFoldersDialog from './WatchedFoldersDialog'
import CustomStampsDialog from './CustomStampsDialog'
import OcgLayersDialog from './OcgLayersDialog'
import OptimizerAuditDialog from './OptimizerAuditDialog'
import InitialViewDialog from './InitialViewDialog'
import AutoDetectFieldsDialog from './AutoDetectFieldsDialog'
import VisualCompareDialog from './VisualCompareDialog'
import MetadataDialog from './MetadataDialog'
import SplitDialog from './SplitDialog'
import PageNumbersDialog from './PageNumbersDialog'
import BatesDialog from './BatesDialog'
import ExtractImagesDialog from './ExtractImagesDialog'
import CropPagesDialog from './CropPagesDialog'
import CompareReportDialog from './CompareReportDialog'
import ReplaceImageDialog from './ReplaceImageDialog'
import SignDialog from './SignDialog'
import ActionWizardDialog from './ActionWizardDialog'
import FormDesignerDialog from './FormDesignerDialog'
import SpellCheckDialog from './SpellCheckDialog'
import PageLabelsDialog from './PageLabelsDialog'
import LinkEditorDialog from './LinkEditorDialog'
import NamedDestinationsDialog from './NamedDestinationsDialog'
import { readPdfPageAloud, stopReading, listVoices } from '../../services/pdfTextOps'
import { printPdfTab } from '../../services/pdfPrint'
import { countManualRedactions } from '../../services/pdfManualRedactions'
import { useFormatStore as useFS2 } from '../../stores/formatStore'
import { useViewerFeatures } from '../../services/viewerFeatures'
import { useFormatStore as useFS } from '../../stores/formatStore'
import { usePdfDocument } from '../../components/viewer/usePdfDocument'
import {
  loadRibbonOrder, saveRibbonOrder, resetRibbonOrder, reorder,
  type PdfRibbonTab,
} from '../../components/layout/toolbarOrder'
import OrderedToolGroup from '../../components/layout/OrderedToolGroup'
import { lookupIcon, RibbonIcons } from '../../components/ribbon/RibbonIcons'

type RibbonTab = PdfRibbonTab

// Each ribbon tab pairs with one icon from the Open Satchel design.
// Mapping mirrors tools.jsx — tabs are spatially familiar to users
// who'd reach for Acrobat's tab bar but visually distinct via the
// monoline iconography.
const TAB_ICON: Record<RibbonTab, string> = {
  Home: 'Cursor',
  Insert: 'Insert',
  Annotate: 'Highlight',
  Review: 'Review',
  FillSign: 'Sign',
  Protect: 'Lock',
  Pages: 'Pages',
  Tools: 'Tools',
  Batch: 'Batch',
}

const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 28, 32, 36, 48, 60, 72]

const LINE_SPACINGS = [1.0, 1.15, 1.5, 2.0]
const PARAGRAPH_STYLE_EVENT = 'open-satchel:paragraph-style'

function markTextToolbarInteraction() {
  ;(window as Window & { __openSatchelTextToolbarPointerAt?: number })
    .__openSatchelTextToolbarPointerAt = Date.now()
}

export default function PdfToolbar({ tabId }: FormatViewerProps) {
  const ui = useUIStore()
  const vf = useViewerFeatures()
  const textStampInputRef = useRef<HTMLTextAreaElement | null>(null)
  const [ribbonTab, setRibbonTab] = useState<RibbonTab>('Home')
  const [showWatermark, setShowWatermark] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [showCertEncrypt, setShowCertEncrypt] = useState(false)
  const [showPageManager, setShowPageManager] = useState(false)
  const [showMerge, setShowMerge] = useState(false)
  const [showOcr, setShowOcr] = useState(false)
  const [showHeaderFooter, setShowHeaderFooter] = useState(false)
  const [showPageSize, setShowPageSize] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [showSnipPin, setShowSnipPin] = useState(false)
  const [showFindRedact, setShowFindRedact] = useState(false)
  const [showBatchPrint, setShowBatchPrint] = useState(false)
  const [showBatchRename, setShowBatchRename] = useState(false)
  const [showBatchOcr, setShowBatchOcr] = useState(false)
  const [showFileCollect, setShowFileCollect] = useState(false)
  const [showWatchedFolders, setShowWatchedFolders] = useState(false)
  const [showCustomStamps, setShowCustomStamps] = useState(false)
  const [showOcgLayers, setShowOcgLayers] = useState(false)
  const [showOptimizerAudit, setShowOptimizerAudit] = useState(false)
  const [showInitialView, setShowInitialView] = useState(false)
  const [showAutoDetect, setShowAutoDetect] = useState(false)
  const [showVisualCompare, setShowVisualCompare] = useState(false)
  const [showMetadata, setShowMetadata] = useState(false)
  const [showSplit, setShowSplit] = useState(false)
  const [showPageNumbers, setShowPageNumbers] = useState(false)
  const [showBates, setShowBates] = useState(false)
  const [showExtractImages, setShowExtractImages] = useState(false)
  const [showCropPages, setShowCropPages] = useState(false)
  const [showCompareReport, setShowCompareReport] = useState(false)
  const [showSpellCheck, setShowSpellCheck] = useState(false)
  const [isReading, setIsReading] = useState(false)
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => listVoices())
  const [selectedVoice, setSelectedVoice] = useState<string>('')
  const ttPdfBytes = useFS2((s) => (s.data[tabId] as PdfFormatState | undefined)?.pdfBytes)
  const pendingRedactionCount = useFormatStore((s) =>
    countManualRedactions(s.data[tabId] as PdfFormatState | undefined),
  )
  const pdfDocForTools = usePdfDocument(ttPdfBytes ?? null)
  // Print the document via an off-screen PDF iframe — NOT window.print(),
  // which would rasterize the whole app (ribbon, sidebar, tabs). See
  // services/pdfPrint.ts.
  const handlePrint = async () => {
    try {
      await printPdfTab(tabId)
    } catch (e) {
      console.error('[print] failed:', e)
    }
  }
  const setTextFormatting = (patch: Partial<TextOptions>) => {
    markTextToolbarInteraction()
    ui.setTextOptions(patch)
    if (ui.tool !== 'edit_text') return
    const detail: Record<string, unknown> = {}
    if (typeof patch.fontSize === 'number') detail.fontSize = patch.fontSize
    if (typeof patch.color === 'string') detail.color = patch.color
    if (typeof patch.fontFamily === 'string') detail.fontFamily = patch.fontFamily
    if (typeof patch.customFontId === 'string' || patch.customFontId === undefined) {
      if ('customFontId' in patch) detail.customFontId = patch.customFontId
    }
    if (typeof patch.bold === 'boolean') detail.bold = patch.bold
    if (typeof patch.italic === 'boolean') detail.italic = patch.italic
    if (typeof patch.underline === 'boolean') detail.underline = patch.underline
    if (typeof patch.strikethrough === 'boolean') detail.strikethrough = patch.strikethrough
    if (typeof patch.textAlign === 'string') detail.align = patch.textAlign
    if (typeof patch.lineHeight === 'number') detail.lineHeight = patch.lineHeight
    if (Object.keys(detail).length > 0) {
      window.dispatchEvent(new CustomEvent(PARAGRAPH_STYLE_EVENT, { detail }))
    }
  }
  const activateTextStamp = () => {
    ui.setSelectedStamp(TEXT_STAMP_INDEX)
    ui.setTool('stamp')
  }
  const insertStampToken = (token: string) => {
    const input = textStampInputRef.current
    const current = ui.textStampTemplate
    const useCaret = !!input && document.activeElement === input
    const start = useCaret ? input.selectionStart ?? current.length : current.length
    const end = useCaret ? input.selectionEnd ?? start : start
    const spacerBefore = start > 0 && !/\s$/.test(current.slice(0, start)) ? ' ' : ''
    const spacerAfter = end < current.length && !/^\s/.test(current.slice(end)) ? ' ' : ''
    const next = `${current.slice(0, start)}${spacerBefore}${token}${spacerAfter}${current.slice(end)}`
    const caret = start + spacerBefore.length + token.length
    ui.setTextStampTemplate(next)
    requestAnimationFrame(() => {
      textStampInputRef.current?.focus()
      textStampInputRef.current?.setSelectionRange(caret, caret)
    })
  }

  // Voices populate asynchronously on first page load in Chromium-based
  // browsers — listen for voiceschanged so the picker isn't stuck empty.
  useEffect(() => {
    const refresh = () => setVoices(listVoices())
    refresh()
    window.speechSynthesis?.addEventListener?.('voiceschanged', refresh)
    return () => window.speechSynthesis?.removeEventListener?.('voiceschanged', refresh)
  }, [])
  const [showPageLabels, setShowPageLabels] = useState(false)
  const [showLinkEditor, setShowLinkEditor] = useState(false)
  const [showNamedDests, setShowNamedDests] = useState(false)
  const [showReplaceImage, setShowReplaceImage] = useState(false)
  const [showSign, setShowSign] = useState(false)
  const [showWizard, setShowWizard] = useState(false)
  const [showFormDesigner, setShowFormDesigner] = useState(false)

  const handleWatermark = (text: string, options: WatermarkOptions) => {
    // page_index 0 → "odd" (Page 1). page_index 1 → "even" (Page 2).
    const pageMatches = (pageIdx: number): boolean => {
      if (options.applyTo === 'all') return true
      if (options.applyTo === 'odd') return pageIdx % 2 === 0
      return pageIdx % 2 === 1
    }
    const trimmed = text.trim()

    useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({
      ...prev,
      pages: prev.pages.map((p, pageIdx) => {
        const existing = p.fabricJSON as any || { version: '6.4.0', objects: [] }
        const prevObjects: any[] = existing.objects || []
        // Always strip any existing watermark textboxes on pages this
        // apply touches — empty-text means "remove", non-empty means
        // "replace".
        const withoutWatermark = pageMatches(pageIdx)
          ? prevObjects.filter((o) => !o.__watermark)
          : prevObjects
        if (!pageMatches(pageIdx) || !trimmed) {
          return { ...p, fabricJSON: { ...existing, objects: withoutWatermark } }
        }
        return {
          ...p,
          fabricJSON: {
            ...existing,
            objects: [...withoutWatermark, {
              type: 'textbox', text: trimmed, left: 200, top: 350,
              fontSize: options.fontSize, fill: options.color, opacity: options.opacity,
              angle: options.angle, fontFamily: 'Impact, sans-serif', fontWeight: 'bold',
              textAlign: 'center', width: 400, selectable: true, editable: false,
              __watermark: true,
            }]
          }
        }
      })
    }))
    useTabStore.getState().setTabDirty(tabId, true)
    setShowWatermark(false)
  }

  // PasswordDialog writes directly to the store now (handles algorithm +
  // permissions + permissions-only mode). We keep this callback lean
  // for back-compat; the dialog marks the tab dirty and closes itself.
  const handlePassword = (_userPassword: string, _ownerPassword: string) => {
    useTabStore.getState().setTabDirty(tabId, true)
  }

  const [ribbonTabs, setRibbonTabs] = useState<RibbonTab[]>(() => loadRibbonOrder())
  const [dragFromIdx, setDragFromIdx] = useState<number | null>(null)
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null)
  const tabLabel = (t: RibbonTab) => t === 'FillSign' ? 'Fill & Sign' : t

  const commitOrder = (next: RibbonTab[]) => {
    setRibbonTabs(next)
    saveRibbonOrder(next)
    // (No history push — ribbon drag-reorder is UI state, and undo
    // is document history only per the 2026-06-11 decision.)
  }
  // (The __pdfRibbonSetTabs window hook is gone with ribbon-order
  // undo — its only consumer was the deleted ui:ribbonOrder replay.)
  const handleTabContextMenu = (e: React.MouseEvent) => {
    // Right-click the tab strip → reset to default order.
    e.preventDefault()
    if (window.confirm('Reset ribbon tab order to default?')) {
      commitOrder(resetRibbonOrder())
    }
  }

  return (
    <div className="rb-root">
      {/* Tab strip — drag to reorder; right-click resets to default. */}
      <div
        className="rb-tabs"
        onContextMenu={handleTabContextMenu}
        title="Drag tabs to reorder. Right-click to reset to default."
      >
        {ribbonTabs.map((tab, idx) => {
          const isActive = ribbonTab === tab
          const isDropTarget = dragOverIdx === idx && dragFromIdx !== null && dragFromIdx !== idx
          return (
            <button
              key={tab}
              type="button"
              draggable
              onDragStart={(e) => {
                setDragFromIdx(idx)
                e.dataTransfer.effectAllowed = 'move'
                // Firefox requires some data to be set or drag aborts.
                e.dataTransfer.setData('text/plain', tab)
              }}
              onDragOver={(e) => {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                if (dragOverIdx !== idx) setDragOverIdx(idx)
              }}
              onDragLeave={() => {
                if (dragOverIdx === idx) setDragOverIdx(null)
              }}
              onDrop={(e) => {
                e.preventDefault()
                if (dragFromIdx !== null && dragFromIdx !== idx) {
                  commitOrder(reorder(ribbonTabs, dragFromIdx, idx))
                }
                setDragFromIdx(null)
                setDragOverIdx(null)
              }}
              onDragEnd={() => {
                setDragFromIdx(null)
                setDragOverIdx(null)
              }}
              onClick={() => setRibbonTab(tab)}
              className={`rb-tab${isActive ? ' active' : ''}${isDropTarget ? ' drop-target' : ''}${dragFromIdx === idx ? ' dragging' : ''}`}
            >
              {(() => {
                // Each ribbon tab gets a small monoline icon to the
                // left of its label (per design spec). Mapping mirrors
                // tools.jsx in the design package.
                const TabIcon = RibbonIcons[TAB_ICON[tab]] ?? null
                return TabIcon ? <TabIcon size={13} /> : null
              })()}
              <span>{tabLabel(tab)}</span>
            </button>
          )
        })}
      </div>

      {/* Ribbon content. Flex-wraps to a second row on narrow windows. */}
      <div className="rb-body">
        {ribbonTab === 'Home' && (
          <>
            <RibbonGroup label="Select">
              <RBtn text="Select" active={ui.tool === 'select'} onClick={() => ui.setTool('select')} />
              {/* Phase D (docs/MODELESS.md): Read mode toggle. When on,
                  paragraph outlines are hidden, Fabric annotations are
                  view-only, all tools no-op. User can flip back to edit
                  any time. Placed in the Select group so it's the very
                  first affordance a user sees on the Home ribbon. */}
              <RBtn text={ui.readMode ? '✎ Edit' : '👁 Read'}
                active={ui.readMode}
                onClick={() => ui.toggleReadMode()} />
            </RibbonGroup>
            <RibbonGroup label="Text">
              <RBtn text="Edit Text" active={ui.tool === 'edit_text'}
                onClick={() => ui.setTool(ui.tool === 'edit_text' ? 'select' : 'edit_text')} />
              <RBtn text="Edit Image" active={ui.tool === 'edit_image'}
                onClick={() => ui.setTool(ui.tool === 'edit_image' ? 'select' : 'edit_image')} />
              <RBtn text="Add Text" active={ui.tool === 'text'} onClick={() => ui.setTool('text')} />
              <div
                onPointerDownCapture={markTextToolbarInteraction}
                onMouseDownCapture={markTextToolbarInteraction}
                style={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}
              >
                <FontPicker
                  onTextFormatting={setTextFormatting}
                  markTextToolbarInteraction={markTextToolbarInteraction}
                />
                <select value={ui.textOptions.fontSize}
                  data-testid="pdf-text-font-size"
                  onChange={(e) => setTextFormatting({ fontSize: Number(e.target.value) })}
                  style={{ width: 48, fontSize: 10, padding: '2px 4px' }}>
                  {FONT_SIZES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
                <input type="color" value={ui.textOptions.color}
                  data-testid="pdf-text-color"
                  onChange={(e) => setTextFormatting({ color: e.target.value })}
                  style={{ width: 20, height: 18, border: 'none', cursor: 'pointer', padding: 0 }} />
              </div>
              <div
                onPointerDownCapture={markTextToolbarInteraction}
                onMouseDownCapture={markTextToolbarInteraction}
                style={{ display: 'flex', alignItems: 'center', gap: 3 }}
              >
                <MiniBtn text="B" active={ui.textOptions.bold} onClick={() => setTextFormatting({ bold: !ui.textOptions.bold })} bold testId="pdf-text-bold" />
                <MiniBtn text="I" active={ui.textOptions.italic} onClick={() => setTextFormatting({ italic: !ui.textOptions.italic })} italic testId="pdf-text-italic" />
                <MiniBtn text="U" active={ui.textOptions.underline} onClick={() => setTextFormatting({ underline: !ui.textOptions.underline })} testId="pdf-text-underline" underline />
                <MiniBtn text="S" active={ui.textOptions.strikethrough} onClick={() => setTextFormatting({ strikethrough: !ui.textOptions.strikethrough })} testId="pdf-text-strikethrough" strike />
                <span style={{ width: 1, height: 14, background: 'var(--border)', margin: '0 2px' }} />
                <MiniBtn text="&#8676;" active={ui.textOptions.textAlign === 'left'} onClick={() => setTextFormatting({ textAlign: 'left' })} testId="pdf-text-align-left" />
                <MiniBtn text="&#8700;" active={ui.textOptions.textAlign === 'center'} onClick={() => setTextFormatting({ textAlign: 'center' })} testId="pdf-text-align-center" />
                <MiniBtn text="&#8677;" active={ui.textOptions.textAlign === 'right'} onClick={() => setTextFormatting({ textAlign: 'right' })} testId="pdf-text-align-right" />
                <span style={{ width: 1, height: 14, background: 'var(--border)', margin: '0 2px' }} />
                <select value={ui.textOptions.lineHeight}
                  data-testid="pdf-text-line-height"
                  onChange={(e) => setTextFormatting({ lineHeight: Number(e.target.value) })}
                  style={{ width: 46, fontSize: 10, padding: '2px 2px' }}
                  title="Line spacing">
                  {LINE_SPACINGS.map((s) => (
                    <option key={s} value={s}>{s.toFixed(s === 1 ? 1 : 2)}</option>
                  ))}
                </select>
                <label
                  data-testid="pdf-text-auto-layout-toggle"
                  title="Auto layout edited PDF text"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    height: 22,
                    padding: '0 6px',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    fontSize: 10,
                    color: ui.autoLayoutTextEdits ? 'var(--accent)' : 'var(--ink-2)',
                    background: ui.autoLayoutTextEdits ? 'var(--bg-active)' : 'transparent',
                    whiteSpace: 'nowrap',
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={ui.autoLayoutTextEdits}
                    onChange={(e) => ui.setAutoLayoutTextEdits(e.target.checked)}
                    style={{ margin: 0, accentColor: 'var(--accent)' }}
                  />
                  <span>Auto layout</span>
                </label>
              </div>
            </RibbonGroup>
            <RibbonGroup label="Draw">
              <RBtn text="Freehand" active={ui.tool === 'draw'} onClick={() => ui.setTool('draw')} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                <input type="color" value={ui.drawingOptions.color}
                  onChange={(e) => ui.setDrawingOptions({ color: e.target.value })}
                  style={{ width: 20, height: 18, border: 'none', cursor: 'pointer', padding: 0 }} />
                <input type="range" min={1} max={20} value={ui.drawingOptions.width}
                  onChange={(e) => ui.setDrawingOptions({ width: Number(e.target.value) })}
                  style={{ width: 50, accentColor: 'var(--accent)' }} />
              </div>
            </RibbonGroup>
            <RibbonGroup label="Sign">
              <RBtn text="Signature" active={ui.tool === 'signature'} onClick={() => ui.setTool('signature')} />
            </RibbonGroup>
          </>
        )}

        {ribbonTab === 'Insert' && (
          <>
            <RibbonGroup label="Content">
              <OrderedToolGroup
                groupId="insert_content"
                items={{
                  image: () => <RBtn text="Image" active={ui.tool === 'image'} onClick={() => ui.setTool('image')} />,
                  sticky_note: () => <RBtn text="Sticky Note" active={ui.tool === 'sticky_note'} onClick={() => ui.setTool('sticky_note')} />,
                }}
              />
            </RibbonGroup>
            <RibbonGroup label="Page Layout">
              <RBtn text="Headers & Footers" onClick={() => setShowHeaderFooter(true)} />
              <span style={{ fontSize: 9, color: 'var(--text-muted)', lineHeight: 1.3 }}>Add page numbers,<br/>dates, custom text</span>
            </RibbonGroup>
            <RibbonGroup label="Shapes">
              <OrderedToolGroup
                groupId="shapes"
                items={{
                  shape_rect: () => <RBtn text="Rectangle" active={ui.tool === 'shape_rect'} onClick={() => ui.setTool('shape_rect')} />,
                  shape_circle: () => <RBtn text="Ellipse" active={ui.tool === 'shape_circle'} onClick={() => ui.setTool('shape_circle')} />,
                  shape_line: () => <RBtn text="Line" active={ui.tool === 'shape_line'} onClick={() => ui.setTool('shape_line')} />,
                  shape_arrow: () => <RBtn text="Arrow" active={ui.tool === 'shape_arrow'} onClick={() => ui.setTool('shape_arrow')} />,
                }}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 3, marginTop: 2 }}>
                <input type="color" value={ui.shapeColor} onChange={(e) => ui.setShapeColor(e.target.value)}
                  style={{ width: 20, height: 18, border: 'none', cursor: 'pointer', padding: 0 }} />
                <input type="range" min={1} max={8} value={ui.shapeStrokeWidth}
                  onChange={(e) => ui.setShapeStrokeWidth(Number(e.target.value))}
                  style={{ width: 50, accentColor: 'var(--accent)' }} />
              </div>
            </RibbonGroup>
            <RibbonGroup label="Stamps">
              {STAMPS.slice(0, 5).map((s, i) => (
                <RBtn key={i} text={s.label ?? s.text} active={ui.tool === 'stamp' && ui.selectedStamp === i}
                  onClick={() => { ui.setSelectedStamp(i); ui.setTool('stamp') }}
                  color={s.color} small />
              ))}
              {STAMPS.slice(5).map((s, i) => (
                <RBtn key={i + 5} text={s.label ?? s.text} active={ui.tool === 'stamp' && ui.selectedStamp === i + 5}
                  onClick={() => { ui.setSelectedStamp(i + 5); ui.setTool('stamp') }}
                  color={s.color} small />
              ))}
              <div className="stamp-template-strip">
                <textarea
                  ref={textStampInputRef}
                  data-testid="pdf-text-stamp-template"
                  className="stamp-template-input"
                  value={ui.textStampTemplate}
                  rows={1}
                  spellCheck={false}
                  onChange={(e) => ui.setTextStampTemplate(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      activateTextStamp()
                    }
                  }}
                  title="Text stamp template"
                />
                <RBtn text="Text Stamp" active={ui.tool === 'stamp' && ui.selectedStamp === TEXT_STAMP_INDEX}
                  onClick={activateTextStamp}
                  title="Place the typed text stamp" small />
              </div>
              <div className="stamp-token-row" aria-label="Stamp tokens">
                {STAMP_TOKEN_SHORTCUTS.map((t) => (
                  <button
                    key={t.token}
                    type="button"
                    className="stamp-token-btn"
                    title={t.token}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => insertStampToken(t.token)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              <RBtn text="Custom…" onClick={() => setShowCustomStamps(true)}
                title="Manage and import custom stamps (PNG/JPEG)" small />
            </RibbonGroup>
            <RibbonGroup label="Media">
              <RBtn text="Link" active={ui.tool === 'link'} onClick={() => ui.setTool('link')} />
              <RBtn text="Edit Links" onClick={() => setShowLinkEditor(true)} />
              <RBtn text="Named Dests" onClick={() => setShowNamedDests(true)} />
              <RBtn text="Audio" active={ui.tool === 'audio'} onClick={() => ui.setTool('audio')} />
              <RBtn text="Video" active={ui.tool === 'video'} onClick={() => ui.setTool('video')} />
            </RibbonGroup>
          </>
        )}

        {ribbonTab === 'Annotate' && (
          <>
            <RibbonGroup label="Highlight">
              {/* Drag-reorderable tile container — persists per-user
                  via ribbonGroupOrder.ts. Right-click any tile to
                  reset this group to the canonical default. The
                  color/width/opacity panel below stays in fixed
                  position since it's the highlight tool's
                  configuration, not its own tool. */}
              <OrderedToolGroup
                groupId="highlight"
                items={{
                  highlight: () => <RBtn text="Highlight" active={ui.tool === 'highlight'} onClick={() => ui.setTool('highlight')} title="Highlight selected text - right-click to reset tool order" />,
                  highlight_area: () => <RBtn text="Highlight Area" active={ui.tool === 'highlight_area'} onClick={() => ui.setTool('highlight_area')} title="Drag a rectangle to highlight" />,
                  underline: () => <RBtn text="Underline" active={ui.tool === 'underline'} onClick={() => ui.setTool('underline')} title="Underline selected text" />,
                  strikethrough: () => <RBtn text="Strikethrough" active={ui.tool === 'strikethrough'} onClick={() => ui.setTool('strikethrough')} title="Strike through selected text" />,
                }}
              />
              <div style={{ display: 'flex', gap: 3, marginTop: 2, alignItems: 'center' }}>
                {['#f9e2af', '#a6e3a1', '#89b4fa', '#f38ba8', '#cba6f7'].map((c) => (
                  <button key={c} onClick={() => ui.setHighlightColor(c)} style={{
                    width: 16, height: 16, borderRadius: 2, border: c === ui.highlightColor ? '2px solid #fff' : '1px solid var(--border)',
                    background: c, cursor: 'pointer', padding: 0
                  }} />
                ))}
                {/* Custom color picker — when none of the 5 presets matches
                    the current color, the swatch shows that custom color
                    with a colored ring so the user can see it's active. */}
                <input
                  type="color"
                  data-testid="highlight-custom-color"
                  value={ui.highlightColor || '#ffeb3b'}
                  onChange={(e) => ui.setHighlightColor(e.target.value)}
                  title="Custom highlight color"
                  style={{
                    width: 18, height: 18, padding: 0,
                    border: ['#f9e2af', '#a6e3a1', '#89b4fa', '#f38ba8', '#cba6f7'].includes(ui.highlightColor)
                      ? '1px solid var(--border)'
                      : '2px solid #fff',
                    borderRadius: 2,
                    cursor: 'pointer',
                    background: 'transparent',
                  }}
                />
              </div>
              <div style={{ display: 'flex', gap: 3, marginTop: 2 }}>
                {(['thin', 'medium', 'thick'] as const).map((w) => (
                  <button key={w} onClick={() => ui.setHighlightWidth(w)}
                    title={`${w} - ${w === 'thin' ? '4' : w === 'medium' ? '8' : '14'}pt`}
                    style={{
                      padding: '2px 6px', fontSize: 9,
                      background: ui.highlightWidth === w ? 'var(--accent)' : 'var(--bg-surface)',
                      color: ui.highlightWidth === w ? 'var(--bg-primary)' : 'var(--text-primary)',
                      border: '1px solid var(--border)', borderRadius: 2, cursor: 'pointer',
                    }}>
                    {w === 'thin' ? '▁' : w === 'medium' ? '▂' : '▃'}
                  </button>
                ))}
                {([['50%', 0.5], ['80%', 0.8]] as const).map(([label, v]) => (
                  <button key={String(v)} onClick={() => ui.setHighlightOpacity(v)}
                    title={`Opacity ${label}`}
                    style={{
                      padding: '2px 4px', fontSize: 9,
                      background: Math.abs(ui.highlightOpacity - v) < 0.01 ? 'var(--accent)' : 'var(--bg-surface)',
                      color: Math.abs(ui.highlightOpacity - v) < 0.01 ? 'var(--bg-primary)' : 'var(--text-primary)',
                      border: '1px solid var(--border)', borderRadius: 2, cursor: 'pointer',
                    }}>
                    {label}
                  </button>
                ))}
              </div>
            </RibbonGroup>
            <RibbonGroup label="Comment">
              <RBtn text="Text Box" active={ui.tool === 'textbox_note'} onClick={() => ui.setTool('textbox_note')} />
              <RBtn text="Insert Text" active={ui.tool === 'insert_text_marker'} onClick={() => ui.setTool('insert_text_marker')} />
              <RBtn text="Replace Text" active={ui.tool === 'replace_text_marker'} onClick={() => ui.setTool('replace_text_marker')} />
              <RBtn text="Wipe Off" active={ui.tool === 'wipe_off'} onClick={() => ui.setTool('wipe_off')} />
            </RibbonGroup>
            <RibbonGroup label="Redaction">
              <RBtn text="Mark Redaction" icon="Redact" active={ui.tool === 'mark_redaction'} onClick={() => ui.setTool('mark_redaction')} />
              <RBtn text="Redact" active={ui.tool === 'redact'} onClick={() => ui.setTool('redact')} />
              <RBtn text="Find &amp; Redact…" data-testid="ribbon-find-redact" onClick={() => setShowFindRedact(true)} />
              {pendingRedactionCount > 0 && (
                <span
                  data-testid="redaction-pending-count"
                  style={{
                    alignSelf: 'center',
                    padding: '2px 6px',
                    border: '2px solid #000',
                    borderRadius: 3,
                    color: '#000',
                    background: '#fff',
                    fontSize: 10,
                    fontWeight: 700,
                    lineHeight: 1.2,
                  }}
                >
                  {pendingRedactionCount} marked
                </span>
              )}
            </RibbonGroup>
            <RibbonGroup label="Measure">
              <RBtn text="Measure" active={ui.tool === 'measure'} onClick={() => ui.setTool('measure')} />
            </RibbonGroup>
            <RibbonGroup label="View">
              <RBtn text={vf.hideAnnotations ? 'Show Annotations' : 'Hide Annotations'}
                active={vf.hideAnnotations}
                onClick={() => vf.setHideAnnotations(!vf.hideAnnotations)} />
              <RBtn text={ui.showComments ? 'Hide Comments' : 'Show Comments'}
                active={ui.showComments}
                onClick={() => ui.toggleComments()} />
            </RibbonGroup>
          </>
        )}

        {ribbonTab === 'Review' && (
          <>
            <RibbonGroup label="Find">
              <RBtn text="Search" active={ui.searchVisible} onClick={() => ui.toggleSearch()} />
              <RBtn text="Find &amp; Replace" onClick={() => useUIStore.getState().openReplace()} />
              <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>Ctrl+F / Ctrl+H</span>
            </RibbonGroup>
            <RibbonGroup label="Proofing">
              <RBtn text="Spell Check" onClick={() => setShowSpellCheck(true)} />
              <RBtn text={isReading ? '⏸ Stop' : '▶ Read Aloud'}
                onClick={async () => {
                  if (isReading) { stopReading(); setIsReading(false); return }
                  const st = useFS2.getState().data[tabId] as PdfFormatState | undefined
                  if (!st) return
                  const u = await readPdfPageAloud(pdfDocForTools, st, ui.currentPage, { voice: selectedVoice || undefined })
                  if (u) {
                    setIsReading(true)
                    u.onend = () => setIsReading(false)
                  }
                }} />
              {voices.length > 0 && (
                <select
                  value={selectedVoice}
                  onChange={(e) => setSelectedVoice(e.target.value)}
                  style={{ fontSize: 10, maxWidth: 160, padding: '1px 2px' }}
                  title="Voice for Read Aloud"
                >
                  <option value="">Default voice</option>
                  {voices.map((v) => (
                    <option key={v.voiceURI} value={v.name}>{v.name} ({v.lang})</option>
                  ))}
                </select>
              )}
            </RibbonGroup>
            <RibbonGroup label="Print">
              <RBtn text="Print" onClick={() => void handlePrint()} />
              <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>Ctrl+P</span>
            </RibbonGroup>
            <RibbonGroup label="Text Recognition">
              <RBtn text="OCR" onClick={() => setShowOcr(true)} />
              <span style={{ fontSize: 9, color: 'var(--text-muted)', lineHeight: 1.3 }}>Extract text from<br/>scanned pages</span>
            </RibbonGroup>
          </>
        )}

        {ribbonTab === 'Protect' && (
          <>
            <RibbonGroup label="Watermark">
              <RBtn text="Add Watermark" onClick={() => setShowWatermark(true)} />
            </RibbonGroup>
            <RibbonGroup label="Encrypt">
              <RBtn text="Password Protect" onClick={() => setShowPassword(true)} />
              <RBtn text="Encrypt to Certs" onClick={() => setShowCertEncrypt(true)} />
            </RibbonGroup>
            <RibbonGroup label="Certificate">
              <RBtn text="Sign &amp; Certify" onClick={() => setShowSign(true)} />
              <RBtn text="Verify Signatures" onClick={() => setShowSign(true)} />
            </RibbonGroup>
            <RibbonGroup label="Visible Stamp">
              <RBtn text="Visible Timestamp" active={ui.tool === 'fill_timestamp'} onClick={() => ui.setTool('fill_timestamp')} />
            </RibbonGroup>
          </>
        )}

        {ribbonTab === 'FillSign' && (
          <>
            <RibbonGroup label="Marks">
              <OrderedToolGroup
                groupId="marks"
                items={{
                  textbox_note: () => <RBtn text="Text Comment" active={ui.tool === 'textbox_note'} onClick={() => ui.setTool('textbox_note')} />,
                  fill_cross: () => <RBtn text="✕ Cross" active={ui.tool === 'fill_cross'} onClick={() => ui.setTool('fill_cross')} />,
                  fill_check: () => <RBtn text="✓ Check" active={ui.tool === 'fill_check'} onClick={() => ui.setTool('fill_check')} />,
                  fill_circle: () => <RBtn text="◯ Circle" active={ui.tool === 'fill_circle'} onClick={() => ui.setTool('fill_circle')} />,
                }}
              />
              <RBtn text="─ Line" active={ui.tool === 'fill_line'} onClick={() => ui.setTool('fill_line')} />
              <RBtn text="• Dot" active={ui.tool === 'fill_dot'} onClick={() => ui.setTool('fill_dot')} />
            </RibbonGroup>
            <RibbonGroup label="Insert">
              <RBtn text="Add Picture" active={ui.tool === 'image'} onClick={() => ui.setTool('image')} />
              <RBtn text="Add Date" active={ui.tool === 'fill_date'} onClick={() => ui.setTool('fill_date')} />
            </RibbonGroup>
            <RibbonGroup label="Signature">
              <RBtn text="Add Signature" active={ui.tool === 'signature'} onClick={() => ui.setTool('signature')} />
              <RBtn text="Add Initials" active={ui.tool === 'fill_initials'} onClick={() => ui.setTool('fill_initials')} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>Initials:</span>
                <input
                  type="text"
                  value={ui.initials}
                  onChange={(e) => ui.setInitials(e.target.value.slice(0, 4))}
                  style={{ width: 40, fontSize: 11, padding: '1px 4px' }}
                  maxLength={4}
                />
              </div>
            </RibbonGroup>
            <RibbonGroup label="Certificate">
              <RBtn text="Sign &amp; Certify" onClick={() => setShowSign(true)} />
            </RibbonGroup>
          </>
        )}

        {ribbonTab === 'Pages' && (
          <>
            <RibbonGroup label="Manage">
              <RBtn text="Page Manager" onClick={() => setShowPageManager(true)} />
              <span style={{ fontSize: 9, color: 'var(--text-muted)', lineHeight: 1.3 }}>Reorder, rotate,<br/>delete pages</span>
            </RibbonGroup>
            <RibbonGroup label="Combine">
              <RBtn text="Merge PDFs" onClick={() => setShowMerge(true)} />
              <RBtn text="Split PDF" onClick={() => setShowSplit(true)} />
              <span style={{ fontSize: 9, color: 'var(--text-muted)', lineHeight: 1.3 }}>Combine multiple<br/>PDFs into one</span>
            </RibbonGroup>
            <RibbonGroup label="Size">
              <RBtn text="Page Size" onClick={() => setShowPageSize(true)} />
              <RBtn text="Crop Pages" onClick={() => setShowCropPages(true)} />
              <span style={{ fontSize: 9, color: 'var(--text-muted)', lineHeight: 1.3 }}>Change page<br/>dimensions</span>
            </RibbonGroup>
            <RibbonGroup label="Numbering">
              <RBtn text="Page Numbers" onClick={() => setShowPageNumbers(true)} />
              <RBtn text="Bates" onClick={() => setShowBates(true)} />
              <RBtn text="Page Labels" onClick={() => setShowPageLabels(true)} />
              <span style={{ fontSize: 9, color: 'var(--text-muted)', lineHeight: 1.3 }}>Arabic / Roman<br/>/Bates/Labels</span>
            </RibbonGroup>
          </>
        )}

        {ribbonTab === 'Tools' && (
          <>
            <RibbonGroup label="Advanced">
              <RBtn text="Advanced Tools…" onClick={() => setShowAdvanced(true)} />
              <RBtn text="Properties" onClick={() => setShowMetadata(true)} />
              <RBtn text="Initial View…" onClick={() => setShowInitialView(true)}
                title="Set how the PDF opens (first page, layout, panels)" />
              <RBtn text="Audit Size" onClick={() => setShowOptimizerAudit(true)}
                title="Show byte breakdown by object type and filter" />
              <RBtn text="Layers (OCG)" onClick={() => setShowOcgLayers(true)}
                title="Toggle visibility of PDF optional-content layers" />
            </RibbonGroup>
            <RibbonGroup label="Document">
              <RBtn text="PDF Compressor" onClick={() => setShowAdvanced(true)} />
              <RBtn text="Merge PDF" onClick={() => setShowMerge(true)} />
              <RBtn text="Split PDF" onClick={() => setShowSplit(true)} />
            </RibbonGroup>
            <RibbonGroup label="Text">
              <RBtn text="Extract Text" onClick={() => setShowAdvanced(true)} />
              <RBtn text="Find &amp; Replace" onClick={() => useUIStore.getState().openReplace()} />
            </RibbonGroup>
            <RibbonGroup label="Capture">
              <RBtn text="Snip &amp; Pin" onClick={() => setShowSnipPin(true)} />
            </RibbonGroup>
            <RibbonGroup label="Compare">
              <RBtn text="Compare Docs" onClick={() => setShowVisualCompare(true)} />
              <RBtn text="Compare Report" onClick={() => setShowCompareReport(true)} />
            </RibbonGroup>
            <RibbonGroup label="Images">
              <RBtn text="Extract Images" onClick={() => setShowExtractImages(true)} />
              <RBtn text="Replace Image" onClick={() => setShowReplaceImage(true)} />
            </RibbonGroup>
            <RibbonGroup label="Batch">
              <RBtn text="Batch Rename" onClick={() => setShowBatchRename(true)} />
              <RBtn text="Batch Print" onClick={() => setShowBatchPrint(true)} />
              <RBtn text="Batch OCR" onClick={() => setShowBatchOcr(true)} />
              <RBtn text="File Collect" onClick={() => setShowFileCollect(true)} />
              <RBtn text="Watched Folders" onClick={() => setShowWatchedFolders(true)}
                title="Hot-folder automation: run an action when new files land" />
            </RibbonGroup>
            <RibbonGroup label="Layout">
              <RBtn text="Form Designer" onClick={() => setShowFormDesigner(true)} />
              <RBtn text="Auto-detect Fields" onClick={() => setShowAutoDetect(true)}
                title="Scan flat PDF for underlines + checkboxes → AcroForm fields" />
              <RBtn text="Form Place Tool" active={ui.tool === 'form_designer'}
                onClick={() => ui.setTool(ui.tool === 'form_designer' ? 'select' : 'form_designer')} />
              <RBtn text="Rulers" active={ui.showRulers} onClick={() => ui.toggleRulers()} />
              <RBtn text="Grid" active={ui.showGrid} onClick={() => ui.toggleGrid()} />
              <RBtn text="Snap" active={ui.snapToGrid} onClick={() => ui.toggleSnapToGrid()}
                title={`Snap guides + fabric objects to ${ui.gridSize}pt grid`} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>Grid</span>
                <input
                  type="number"
                  min={5}
                  max={500}
                  step={5}
                  value={ui.gridSize}
                  onChange={(e) => ui.setGridSize(Number(e.target.value))}
                  style={{ width: 42, fontSize: 11, padding: '1px 4px' }}
                  title="Grid spacing in pt"
                />
              </div>
              <RBtn text="Layers" active={ui.showLayers} onClick={() => ui.toggleLayers()} />
            </RibbonGroup>
            <RibbonGroup label="View">
              <RBtn text={vf.autoScroll ? 'Stop Auto Scroll' : 'Auto Scroll'}
                active={vf.autoScroll}
                onClick={() => vf.setAutoScroll(!vf.autoScroll)} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 3 }} title={`Auto-scroll speed: ${vf.autoScrollSpeed} px/tick`}>
                <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>Speed</span>
                <input
                  type="range"
                  min={5}
                  max={120}
                  step={5}
                  value={vf.autoScrollSpeed}
                  onChange={(e) => vf.setAutoScrollSpeed(Number(e.target.value))}
                  style={{ width: 80 }}
                />
                <span style={{ fontSize: 10, color: 'var(--text-muted)', minWidth: 22, textAlign: 'right' }}>{vf.autoScrollSpeed}</span>
              </div>
              <RBtn text={vf.eyeProtection ? 'Normal View' : 'Eye Protection'}
                active={vf.eyeProtection}
                onClick={() => vf.setEyeProtection(!vf.eyeProtection)} />
            </RibbonGroup>
            <RibbonGroup label="Fonts">
              <FallbackFontPicker />
              <ImportFontButton />
            </RibbonGroup>
          </>
        )}

        {ribbonTab === 'Batch' && (
          <>
            <RibbonGroup label="Wizard">
              <RBtn text="Action Wizard" onClick={() => setShowWizard(true)} />
              <span style={{ fontSize: 9, color: 'var(--text-muted)', lineHeight: 1.3 }}>Build + run<br/>multi-step chains</span>
            </RibbonGroup>
            <RibbonGroup label="Convert">
              <RBtn text="PDF → Word" onClick={() => setShowAdvanced(true)} />
              <RBtn text="PDF → PPT" onClick={() => setShowAdvanced(true)} />
              <RBtn text="PDF → Excel" onClick={() => setShowAdvanced(true)} />
              <RBtn text="To Image-only PDF" onClick={() => setShowAdvanced(true)} />
            </RibbonGroup>
            <RibbonGroup label="Document">
              <RBtn text="Compress" onClick={() => setShowAdvanced(true)} />
              <RBtn text="Merge PDF" onClick={() => setShowMerge(true)} />
              <RBtn text="Split PDF" onClick={() => setShowSplit(true)} />
            </RibbonGroup>
            <RibbonGroup label="Multi-file">
              <RBtn text="Batch PDF Printing" onClick={() => setShowBatchPrint(true)} />
              <RBtn text="Batch Rename Files" onClick={() => setShowBatchRename(true)} />
            </RibbonGroup>
          </>
        )}
      </div>

      {showWatermark && <WatermarkDialog
        onClose={() => setShowWatermark(false)}
        onApply={handleWatermark}
        onUnbake={async (text: string) => {
          // G5: strip baked watermark text from pdfBytes content streams.
          // Calls Rust pdf_remove_watermark_text. Best-effort — only
          // catches Helvetica/standard-14 baked text (which is what
          // pd-lib's drawText watermark path emits).
          try {
            const state = useFormatStore.getState().data[tabId] as PdfFormatState | undefined
            if (!state) return
            const { invoke } = await import('@tauri-apps/api/core')
            const r = await invoke<{ bytes: number[]; blocks_removed: number; pages_affected: number[] }>(
              'pdf_remove_watermark_text',
              { bytes: Array.from(state.pdfBytes), watermark_text: text },
            )
            useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({
              ...prev,
              pdfBytes: new Uint8Array(r.bytes),
            }))
            useTabStore.getState().setTabDirty(tabId, true)
            console.info(`[unbake] removed ${r.blocks_removed} block(s) across pages ${r.pages_affected.join(',')}`)
          } catch (e) {
            console.error('[unbake] failed:', e)
          }
          setShowWatermark(false)
        }}
      />}
      {showPassword && <PasswordDialog tabId={tabId} onClose={() => setShowPassword(false)} onApply={handlePassword} />}
      {showCertEncrypt && <CertEncryptDialog tabId={tabId} onClose={() => setShowCertEncrypt(false)} />}
      {showPageManager && <PdfPageManager tabId={tabId} onClose={() => setShowPageManager(false)} />}
      {showMerge && <PdfMergeDialog onClose={() => setShowMerge(false)} />}
      {showOcr && <OcrDialog tabId={tabId} onClose={() => setShowOcr(false)} />}
      {showHeaderFooter && <HeaderFooterDialog tabId={tabId} onClose={() => setShowHeaderFooter(false)} />}
      {showPageSize && <PageSizeDialog tabId={tabId} onClose={() => setShowPageSize(false)} />}
      {showAdvanced && <PdfAdvancedDialog tabId={tabId} onClose={() => setShowAdvanced(false)} />}
      {showSnipPin && <SnipPinDialog tabId={tabId} onClose={() => setShowSnipPin(false)} />}
      {showFindRedact && <SearchAndRedactDialog tabId={tabId} onClose={() => setShowFindRedact(false)} />}
      {showBatchPrint && <BatchDialog mode="print" onClose={() => setShowBatchPrint(false)} />}
      {showBatchRename && <BatchDialog mode="rename" onClose={() => setShowBatchRename(false)} />}
      {showBatchOcr && <BatchDialog mode="ocr" onClose={() => setShowBatchOcr(false)} />}
      {showFileCollect && <BatchDialog mode="collect" onClose={() => setShowFileCollect(false)} />}
      {showWatchedFolders && <WatchedFoldersDialog onClose={() => setShowWatchedFolders(false)} />}
      {showCustomStamps && <CustomStampsDialog onClose={() => setShowCustomStamps(false)} />}
      {showOcgLayers && <OcgLayersDialog tabId={tabId} onClose={() => setShowOcgLayers(false)} />}
      {showOptimizerAudit && <OptimizerAuditDialog tabId={tabId} onClose={() => setShowOptimizerAudit(false)} />}
      {showInitialView && <InitialViewDialog tabId={tabId} onClose={() => setShowInitialView(false)} />}
      {showAutoDetect && <AutoDetectFieldsDialog tabId={tabId} onClose={() => setShowAutoDetect(false)} />}
      {showVisualCompare && <VisualCompareDialog tabId={tabId} onClose={() => setShowVisualCompare(false)} />}
      {showMetadata && <MetadataDialog tabId={tabId} onClose={() => setShowMetadata(false)} />}
      {showSplit && <SplitDialog tabId={tabId} onClose={() => setShowSplit(false)} />}
      {showPageNumbers && <PageNumbersDialog tabId={tabId} onClose={() => setShowPageNumbers(false)} />}
      {showBates && <BatesDialog tabId={tabId} onClose={() => setShowBates(false)} />}
      {showExtractImages && <ExtractImagesDialog tabId={tabId} onClose={() => setShowExtractImages(false)} />}
      {showCropPages && <CropPagesDialog tabId={tabId} onClose={() => setShowCropPages(false)} />}
      {showCompareReport && <CompareReportDialog tabId={tabId} onClose={() => setShowCompareReport(false)} />}
      {showSpellCheck && <SpellCheckDialog tabId={tabId} onClose={() => setShowSpellCheck(false)} />}
      {showPageLabels && <PageLabelsDialog tabId={tabId} onClose={() => setShowPageLabels(false)} />}
      {showLinkEditor && <LinkEditorDialog tabId={tabId} onClose={() => setShowLinkEditor(false)} />}
      {showNamedDests && <NamedDestinationsDialog tabId={tabId} onClose={() => setShowNamedDests(false)} />}
      {showReplaceImage && <ReplaceImageDialog tabId={tabId} onClose={() => setShowReplaceImage(false)} />}
      {showSign && <SignDialog tabId={tabId} onClose={() => setShowSign(false)} />}
      {showWizard && <ActionWizardDialog tabId={tabId} onClose={() => setShowWizard(false)} />}
      {showFormDesigner && <FormDesignerDialog tabId={tabId} onClose={() => setShowFormDesigner(false)} />}
    </div>
  )
}

/* ---- Ribbon building blocks ---- */

function RibbonGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rgrp" data-group-label={label}>
      <div className="rgrp-row">{children}</div>
      <span className="rgrp-label">{label}</span>
    </div>
  )
}

// Ribbon controls use onMouseDown={preventDefault} so a click does not pull
// focus away from an in-edit Fabric Textbox. Without this, clicking e.g.
// the B button while typing exits editing mode and can feel like the
// textbox "deselected".
const preventFocusSteal = (
  e: React.MouseEvent<HTMLButtonElement> | React.PointerEvent<HTMLButtonElement>,
) => e.preventDefault()

function RBtn({ text, active, onClick, color, small, title, icon, bold: _bold, italic: _italic, 'data-testid': testid }: {
  text: string; active?: boolean; onClick?: () => void; color?: string; small?: boolean; title?: string; bold?: boolean; italic?: boolean
  'data-testid'?: string
  /** Explicit icon name to render above the label. Overrides label-based
   *  auto-lookup. Pass `null` (or the literal string `"none"`) to force
   *  text-only rendering for a button that the auto-lookup would
   *  otherwise match. */
  icon?: keyof typeof RibbonIcons | 'none' | null
}) {
  // Resolve the SVG icon component. Explicit `icon` prop wins; otherwise
  // we look up by label so existing RBtn callsites get icons for free.
  let Icon: React.FC<{ size?: number }> | null = null
  if (icon === 'none' || icon === null) {
    Icon = null
  } else if (typeof icon === 'string') {
    Icon = RibbonIcons[icon] ?? null
  } else {
    Icon = lookupIcon(text)
  }

  return (
    <button
      type="button"
      onClick={onClick}
      onPointerDown={preventFocusSteal}
      onMouseDown={preventFocusSteal}
      title={title ?? text}
      data-testid={testid}
      className={`rbtn${active ? ' active' : ''}${small ? ' rbtn-small' : ''}${Icon ? ' rbtn-tile' : ''}`}
      style={color && !active ? { color } : undefined}
    >
      {Icon && <Icon size={16} />}
      <span className="rbtn-label">{text}</span>
    </button>
  )
}

// Fallback font dropdown — lets users pick the system font used when the
// original PDF font can't be re-embedded. Mirrors Acrobat's "Fallback font
// for editing" preference. Applied by pdfParagraphEdits at save time.
function FallbackFontPicker() {
  const fallback = useUIStore((s) => s.fallbackFontFamily)
  const setFallbackFont = useUIStore((s) => s.setFallbackFont)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>Fallback:</span>
      <select
        value={fallback}
        onChange={(e) => setFallbackFont(e.target.value as 'Helvetica' | 'TimesRoman' | 'Courier')}
        style={{ fontSize: 10, padding: '2px 4px', width: 90 }}
        title="Fallback font used when an edited PDF's original font can't be re-embedded"
      >
        <option value="Helvetica">Helvetica</option>
        <option value="TimesRoman">Times Roman</option>
        <option value="Courier">Courier</option>
      </select>
    </div>
  )
}

// One-click font import — opens the system file dialog, loads the font
// bytes into the browser via FontFace API, and persists it to the
// imported-fonts index under %APPDATA%/open-satchel/fonts/.
function ImportFontButton() {
  const importFont = useFontStore((s) => s.importFont)
  const customFonts = useFontStore((s) => s.customFonts)
  const loadFonts = useFontStore((s) => s.loadFonts)
  useEffect(() => { void loadFonts() }, [loadFonts])
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <button
        onClick={() => void importFont()}
        style={{
          padding: '3px 10px', fontSize: 11, borderRadius: 3,
          background: 'var(--bg-surface)', color: 'var(--text-primary)',
          cursor: 'pointer', border: 'none', whiteSpace: 'nowrap',
        }}
        title="Import a .ttf/.otf font file for use in edits"
      >
        Import Font…
      </button>
      <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>
        {customFonts.length > 0 ? `${customFonts.length} imported` : 'none'}
      </span>
    </div>
  )
}

function MiniBtn({ text, active, onClick, bold, italic, underline, strike, testId }: {
  text: string; active?: boolean; onClick?: () => void; bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; testId?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onPointerDown={preventFocusSteal}
      onMouseDown={preventFocusSteal}
      data-testid={testId}
      className={`rminibtn${active ? ' active' : ''}`}
      style={{
        fontWeight: bold ? 700 : 600,
        fontStyle: italic ? 'italic' : 'normal',
        textDecorationLine: [underline ? 'underline' : '', strike ? 'line-through' : '']
          .filter(Boolean)
          .join(' ') || 'none',
      }}
    >
      {text}
    </button>
  )
}
