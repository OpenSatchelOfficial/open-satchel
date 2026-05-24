import { useEffect, useState } from 'react'
import { useFormatStore } from '../../stores/formatStore'
import { useTabStore } from '../../stores/tabStore'
import type { PdfFormatState } from './index'
import {
  readMetadata, writeMetadata, stripMetadata,
  splitEveryN, splitPdf,
  compressPdf,
  pdfToImages, imagesToPdf,
  applyBatesNumbering,
  flattenForm,
  rotatePages,
  extractText,
  setPdfThumbnail, setPdfThumbnailFromPage,
  setPageLabels, sanitizePdf,
  type PageLabelRange, type PageLabelStyle,
} from '../../services/pdfOps'
import { executeWorkflow, PRESET_WORKFLOWS, type ActionStep, type ActionStepType } from '../../services/actionWizard'
import { validatePdfA } from '../../services/pdfAValidation'
import { convertToPdfA, type ConvertReport } from '../../services/pdfAConvert'
import type { PdfAProfile } from '../../services/pdfAXmp'
import { readStructureTree, isTaggedPdf, listStructureTags, type StructTag } from '../../services/pdfAccessibility'
import { autoTagDocument, type AutoTagReport } from '../../services/pdfAutoTag'
import { setDocumentLang, setFigureAltText, countFiguresWithoutAlt } from '../../services/pdfStructTree'
import { checkAccessibility, type A11yResult } from '../../services/pdfA11yChecker'
import { listEmbeddedImages, replaceEmbeddedImage, resizeEmbeddedImage } from '../../services/pdfImageOps'
import { PDFDocument, PDFName, PDFNumber, PDFDict } from 'pdf-lib'
import { pdfToWord } from '../../services/pdfToWord'
import {
  pdfToText, pdfToExcel, pdfToPpt,
  extractAllPictures, toImageOnlyPdf,
  insertPagesFromPdf, replacePagesFromPdf,
  applyPageBackground, addPageNumbers,
  exportHighlightsFromPages,
} from '../../services/pdfConvert'
import { readBookmarks, writeFlatBookmarks, type Bookmark } from '../../services/pdfBookmarks'
import { findAcrossPages, replaceAcrossPages, spellCheckPages, readPageAloud, stopReading } from '../../services/pdfTextOps'
import { comparePdfs } from '../../services/pdfCompare'
import { generateSelfSignedCert, signPdf, listSignatures, type CertIdentity } from '../../services/pdfSign'

interface Props {
  tabId: string
  onClose: () => void
}

type Section = 'metadata' | 'organize' | 'convert' | 'bookmarks' | 'text' | 'compare' | 'optimize' | 'sign' | 'pages' | 'highlights' | 'thumbnail' | 'pagelabels' | 'sanitize' | 'wizard' | 'pdfa' | 'accessibility' | 'images' | 'crop' | 'links' | 'redact_verify' | 'fonts' | 'stats'

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'metadata', label: 'Metadata' },
  { id: 'stats', label: 'Statistics' },
  { id: 'thumbnail', label: 'Thumbnail' },
  { id: 'organize', label: 'Organize' },
  { id: 'pages', label: 'Pages' },
  { id: 'pagelabels', label: 'Page Labels' },
  { id: 'crop', label: 'Crop Pages' },
  { id: 'convert', label: 'Convert' },
  { id: 'images', label: 'Images' },
  { id: 'bookmarks', label: 'Bookmarks' },
  { id: 'links', label: 'Links' },
  { id: 'text', label: 'Text' },
  { id: 'highlights', label: 'Highlights' },
  { id: 'compare', label: 'Compare' },
  { id: 'sign', label: 'Sign' },
  { id: 'redact_verify', label: 'Redact Verify' },
  { id: 'optimize', label: 'Optimize' },
  { id: 'fonts', label: 'Fonts' },
  { id: 'sanitize', label: 'Sanitize' },
  { id: 'wizard', label: 'Action Wizard' },
  { id: 'pdfa', label: 'PDF/A' },
  { id: 'accessibility', label: 'Accessibility' },
]

async function downloadBytes(_name: string, bytes: Uint8Array, _mime = 'application/pdf') {
  await window.api.file.saveAs(bytes)
}

export default function PdfAdvancedDialog({ tabId, onClose }: Props) {
  const [section, setSection] = useState<Section>('metadata')
  const [status, setStatus] = useState<string>('')
  const state = useFormatStore((s) => s.data[tabId] as PdfFormatState | undefined)

  if (!state) return null

  return (
    <div data-testid="advanced-dialog" style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
    }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{
        background: 'var(--bg-primary)', borderRadius: 8, padding: 0,
        border: '1px solid var(--border)', width: '72vw', maxWidth: 900, height: '72vh',
        display: 'flex', flexDirection: 'column', overflow: 'hidden'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 16px', borderBottom: '1px solid var(--border)' }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>Advanced PDF Tools</h3>
          <button onClick={onClose} style={{ fontSize: 18, background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>✕</button>
        </div>
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          <nav style={{ width: 140, borderRight: '1px solid var(--border)', padding: 8, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                data-testid={`nav-${s.id}`}
                onClick={() => { setSection(s.id); setStatus('') }}
                style={{
                  padding: '6px 10px', textAlign: 'left', fontSize: 12, borderRadius: 4,
                  background: section === s.id ? 'var(--accent)' : 'transparent',
                  color: section === s.id ? 'var(--bg-primary)' : 'var(--text-primary)',
                  border: 'none', cursor: 'pointer',
                }}
              >{s.label}</button>
            ))}
          </nav>
          <div style={{ flex: 1, padding: 16, overflow: 'auto' }}>
            {section === 'metadata' && <MetadataSection state={state} tabId={tabId} onStatus={setStatus} />}
            {section === 'thumbnail' && <ThumbnailSection state={state} tabId={tabId} onStatus={setStatus} />}
            {section === 'organize' && <OrganizeSection state={state} tabId={tabId} onStatus={setStatus} />}
            {section === 'pages' && <PagesSection state={state} tabId={tabId} onStatus={setStatus} />}
            {section === 'convert' && <ConvertSection state={state} onStatus={setStatus} />}
            {section === 'bookmarks' && <BookmarksSection state={state} tabId={tabId} onStatus={setStatus} />}
            {section === 'text' && <TextSection state={state} tabId={tabId} onStatus={setStatus} />}
            {section === 'highlights' && <HighlightsSection state={state} onStatus={setStatus} />}
            {section === 'compare' && <CompareSection state={state} onStatus={setStatus} />}
            {section === 'sign' && <SignSection state={state} tabId={tabId} onStatus={setStatus} />}
            {section === 'optimize' && <OptimizeSection state={state} tabId={tabId} onStatus={setStatus} />}
            {section === 'pagelabels' && <PageLabelsSection state={state} tabId={tabId} onStatus={setStatus} />}
            {section === 'sanitize' && <SanitizeSection state={state} tabId={tabId} onStatus={setStatus} />}
            {section === 'wizard' && <WizardSection state={state} tabId={tabId} onStatus={setStatus} />}
            {section === 'pdfa' && <PdfASection state={state} tabId={tabId} onStatus={setStatus} />}
            {section === 'accessibility' && <AccessibilitySection state={state} tabId={tabId} onStatus={setStatus} />}
            {section === 'images' && <ImagesSection state={state} tabId={tabId} onStatus={setStatus} />}
            {section === 'crop' && <CropSection state={state} tabId={tabId} onStatus={setStatus} />}
            {section === 'links' && <LinksSection state={state} tabId={tabId} onStatus={setStatus} />}
            {section === 'redact_verify' && <RedactVerifySection state={state} onStatus={setStatus} />}
            {section === 'fonts' && <FontsSection state={state} onStatus={setStatus} />}
            {section === 'stats' && <StatsSection state={state} />}
          </div>
        </div>
        {status && (
          <div data-testid="advanced-status" style={{ padding: '6px 16px', borderTop: '1px solid var(--border)', fontSize: 11, color: 'var(--text-secondary)' }}>{status}</div>
        )}
      </div>
    </div>
  )
}

// ---------- Sections ----------

const inp = { width: '100%', padding: '6px 8px', fontSize: 12, background: 'var(--bg-surface)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 3 } as React.CSSProperties
const label = { fontSize: 11, color: 'var(--text-secondary)', display: 'block', marginBottom: 3 } as React.CSSProperties
const btn = { padding: '6px 12px', fontSize: 12, background: 'var(--accent)', color: 'var(--bg-primary)', border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 500 } as React.CSSProperties
const btnSecondary = { ...btn, background: 'var(--bg-surface)', color: 'var(--text-primary)' }
const row = { display: 'flex', gap: 8, marginTop: 10 } as React.CSSProperties

function MetadataSection({ state, tabId, onStatus }: { state: PdfFormatState; tabId: string; onStatus: (s: string) => void }) {
  const [title, setTitle] = useState('')
  const [author, setAuthor] = useState('')
  const [subject, setSubject] = useState('')
  const [keywords, setKeywords] = useState('')
  useEffect(() => {
    (async () => {
      const m = await readMetadata(state.pdfBytes)
      setTitle(m.title ?? ''); setAuthor(m.author ?? ''); setSubject(m.subject ?? ''); setKeywords(m.keywords?.join(', ') ?? '')
    })()
  }, [state.pdfBytes])

  const save = async () => {
    const updated = await writeMetadata(state.pdfBytes, {
      title, author, subject,
      keywords: keywords ? keywords.split(',').map((k) => k.trim()).filter(Boolean) : [],
    })
    useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({ ...prev, pdfBytes: updated }))
    useTabStore.getState().setTabDirty(tabId, true)
    onStatus(`Metadata saved to document (${updated.byteLength} bytes).`)
  }
  const strip = async () => {
    const stripped = await stripMetadata(state.pdfBytes)
    useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({ ...prev, pdfBytes: stripped }))
    useTabStore.getState().setTabDirty(tabId, true)
    setTitle(''); setAuthor(''); setSubject(''); setKeywords('')
    onStatus('Metadata stripped.')
  }

  return (
    <div data-testid="section-metadata">
      <h4 style={{ marginTop: 0, fontSize: 13 }}>Document Metadata</h4>
      <label style={label}>Title</label><input data-testid="meta-title" style={inp} value={title} onChange={(e) => setTitle(e.target.value)} />
      <label style={{ ...label, marginTop: 8 }}>Author</label><input data-testid="meta-author" style={inp} value={author} onChange={(e) => setAuthor(e.target.value)} />
      <label style={{ ...label, marginTop: 8 }}>Subject</label><input data-testid="meta-subject" style={inp} value={subject} onChange={(e) => setSubject(e.target.value)} />
      <label style={{ ...label, marginTop: 8 }}>Keywords (comma-separated)</label><input data-testid="meta-keywords" style={inp} value={keywords} onChange={(e) => setKeywords(e.target.value)} />
      <div style={row}>
        <button data-testid="meta-save" style={btn} onClick={save}>Save</button>
        <button data-testid="meta-strip" style={btnSecondary} onClick={strip}>Strip all metadata</button>
      </div>
    </div>
  )
}

function OrganizeSection({ state, tabId, onStatus }: { state: PdfFormatState; tabId: string; onStatus: (s: string) => void }) {
  const [n, setN] = useState(2)
  const [batesPrefix, setBatesPrefix] = useState('ACME-')
  const [batesStart, setBatesStart] = useState(1)
  const [rotateAll, setRotateAll] = useState<90 | 180 | 270>(90)

  const doSplit = async () => {
    const chunks = await splitEveryN(state.pdfBytes, n)
    for (let i = 0; i < chunks.length; i++) await downloadBytes(`split-${i + 1}.pdf`, chunks[i])
    onStatus(`Split into ${chunks.length} files (downloaded).`)
  }
  const doBates = async () => {
    const stamped = await applyBatesNumbering(state.pdfBytes, { prefix: batesPrefix, start: batesStart, digits: 6 })
    useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({ ...prev, pdfBytes: stamped }))
    useTabStore.getState().setTabDirty(tabId, true)
    onStatus(`Bates numbering applied (${batesPrefix}${String(batesStart).padStart(6,'0')}+)`)
  }
  const doRotateAll = async () => {
    const rotated = await rotatePages(state.pdfBytes, rotateAll)
    useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({ ...prev, pdfBytes: rotated }))
    useTabStore.getState().setTabDirty(tabId, true)
    onStatus(`Rotated all pages ${rotateAll}° on the saved bytes.`)
  }
  const doFlatten = async () => {
    const flat = await flattenForm(state.pdfBytes)
    await downloadBytes('flattened.pdf', flat)
    onStatus('Form fields flattened (downloaded).')
  }

  return (
    <div data-testid="section-organize">
      <h4 style={{ marginTop: 0, fontSize: 13 }}>Split PDF</h4>
      <label style={label}>Every N pages</label>
      <input data-testid="split-n" type="number" min={1} style={inp} value={n} onChange={(e) => setN(Number(e.target.value))} />
      <div style={row}><button data-testid="split-go" style={btn} onClick={doSplit}>Split & download</button></div>

      <h4 style={{ marginTop: 18, fontSize: 13 }}>Bates Numbering</h4>
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 2 }}><label style={label}>Prefix</label><input data-testid="bates-prefix" style={inp} value={batesPrefix} onChange={(e) => setBatesPrefix(e.target.value)} /></div>
        <div style={{ flex: 1 }}><label style={label}>Start</label><input data-testid="bates-start" type="number" style={inp} value={batesStart} onChange={(e) => setBatesStart(Number(e.target.value))} /></div>
      </div>
      <div style={row}><button data-testid="bates-go" style={btn} onClick={doBates}>Apply Bates</button></div>

      <h4 style={{ marginTop: 18, fontSize: 13 }}>Rotate all pages</h4>
      <select data-testid="rot-angle" style={inp} value={rotateAll} onChange={(e) => setRotateAll(Number(e.target.value) as 90|180|270)}>
        <option value={90}>90°</option><option value={180}>180°</option><option value={270}>270°</option>
      </select>
      <div style={row}><button data-testid="rot-go" style={btn} onClick={doRotateAll}>Rotate all</button></div>

      <h4 style={{ marginTop: 18, fontSize: 13 }}>Flatten Form Fields</h4>
      <div style={row}><button data-testid="flatten-go" style={btnSecondary} onClick={doFlatten}>Flatten & download</button></div>
    </div>
  )
}

function ConvertSection({ state, onStatus }: { state: PdfFormatState; onStatus: (s: string) => void }) {
  const [scale, setScale] = useState(2)
  // Wrap every conversion in try/catch so a thrown error surfaces in
  // the dialog status. Pre-fix, pdfToPpt could blow the stack on
  // multi-page PDFs (chunked btoa fix in services/pdfConvert.ts) and
  // toPpt's promise would reject silently — UI showed no signal.
  const guard = async (label: string, fn: () => Promise<void>) => {
    try { await fn() }
    catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`[${label}] failed:`, e)
      onStatus(`${label} error: ${msg}`)
    }
  }
  const toWord = () => guard('PDF→Word', async () => {
    const bytes = await pdfToWord(state.pdfBytes)
    await downloadBytes('converted.docx', bytes, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    onStatus(`PDF→Word exported (${bytes.byteLength} bytes).`)
  })
  const toExcel = () => guard('PDF→Excel', async () => {
    const bytes = await pdfToExcel(state.pdfBytes)
    await downloadBytes('converted.xlsx', bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    onStatus(`PDF→Excel exported (${bytes.byteLength} bytes).`)
  })
  const toPpt = () => guard('PDF→PPT', async () => {
    const bytes = await pdfToPpt(state.pdfBytes)
    await downloadBytes('converted.pptx', bytes, 'application/vnd.openxmlformats-officedocument.presentationml.presentation')
    onStatus(`PDF→PPT exported (${bytes.byteLength} bytes).`)
  })
  const toTxt = () => guard('PDF→TXT', async () => {
    const text = await pdfToText(state.pdfBytes)
    const blob = new Uint8Array(new TextEncoder().encode(text))
    await downloadBytes('converted.txt', blob, 'text/plain')
    onStatus(`PDF→TXT exported (${blob.byteLength} bytes).`)
  })
  const toImages = async () => {
    const imgs = await pdfToImages(state.pdfBytes, { scale })
    for (let i = 0; i < imgs.length; i++) await downloadBytes(`page-${i + 1}.png`, imgs[i], 'image/png')
    onStatus(`Exported ${imgs.length} PNGs.`)
  }
  const toImageOnly = async () => {
    const bytes = await toImageOnlyPdf(state.pdfBytes)
    await downloadBytes('image-only.pdf', bytes)
    onStatus(`Image-only PDF exported (text now unselectable).`)
  }
  const extractPics = async () => {
    const pics = await extractAllPictures(state.pdfBytes, { scale: 2 })
    for (let i = 0; i < pics.length; i++) await downloadBytes(`picture-${i + 1}.png`, pics[i], 'image/png')
    onStatus(`Extracted ${pics.length} picture(s).`)
  }
  const imagesToPdfFromPicker = async () => {
    const input = document.createElement('input')
    input.type = 'file'; input.accept = 'image/png,image/jpeg'; input.multiple = true
    input.onchange = async () => {
      const files = input.files ? Array.from(input.files) : []
      if (!files.length) return
      const arrays: Uint8Array[] = await Promise.all(files.map(async (f) => new Uint8Array(await f.arrayBuffer())))
      const out = await imagesToPdf(arrays)
      await downloadBytes('from-images.pdf', out)
      onStatus(`Created PDF from ${arrays.length} image(s).`)
    }
    input.click()
  }
  return (
    <div data-testid="section-convert">
      <h4 style={{ marginTop: 0, fontSize: 13 }}>Convert</h4>
      <div style={row}><button data-testid="conv-word" style={btn} onClick={toWord}>PDF → Word (.docx)</button></div>
      <div style={row}><button data-testid="conv-excel" style={btn} onClick={toExcel}>PDF → Excel (.xlsx)</button></div>
      <div style={row}><button data-testid="conv-ppt" style={btn} onClick={toPpt}>PDF → PowerPoint (.pptx)</button></div>
      <div style={row}><button data-testid="conv-txt" style={btn} onClick={toTxt}>PDF → TXT</button></div>
      <div style={row}>
        <label style={{ ...label, marginBottom: 0, alignSelf: 'center' }}>PNG scale</label>
        <input data-testid="conv-scale" type="number" min={1} max={4} step={0.5} style={{ ...inp, width: 60 }} value={scale} onChange={(e) => setScale(Number(e.target.value))} />
        <button data-testid="conv-png" style={btn} onClick={toImages}>PDF → Images (PNG)</button>
      </div>
      <div style={row}><button data-testid="conv-imgonly" style={btnSecondary} onClick={toImageOnly}>To Image-only PDF</button></div>
      <div style={row}><button data-testid="conv-extract" style={btnSecondary} onClick={extractPics}>Extract Pictures</button></div>
      <div style={row}><button data-testid="conv-img2pdf" style={btnSecondary} onClick={imagesToPdfFromPicker}>Image(s) → PDF…</button></div>
    </div>
  )
}

function PagesSection({ state, tabId, onStatus }: { state: PdfFormatState; tabId: string; onStatus: (s: string) => void }) {
  const [pageNumFormat, setPageNumFormat] = useState<'N' | 'N of M' | 'Page N' | 'Page N of M'>('Page N of M')
  const [bgColor, setBgColor] = useState('#fafbf4')

  const addNumbers = async () => {
    const bytes = await addPageNumbers(state.pdfBytes, { format: pageNumFormat })
    useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({ ...prev, pdfBytes: bytes }))
    useTabStore.getState().setTabDirty(tabId, true)
    onStatus(`Page numbers added (${pageNumFormat}).`)
  }
  const applyBackground = async () => {
    const hex = bgColor.replace('#', '')
    const r = parseInt(hex.slice(0, 2), 16) / 255
    const g = parseInt(hex.slice(2, 4), 16) / 255
    const b = parseInt(hex.slice(4, 6), 16) / 255
    const bytes = await applyPageBackground(state.pdfBytes, { color: [r, g, b] })
    useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({ ...prev, pdfBytes: bytes }))
    useTabStore.getState().setTabDirty(tabId, true)
    onStatus(`Applied background color ${bgColor}.`)
  }
  const insertFromPicker = async () => {
    const input = document.createElement('input')
    input.type = 'file'; input.accept = 'application/pdf'
    input.onchange = async () => {
      const file = input.files?.[0]; if (!file) return
      const srcBytes = new Uint8Array(await file.arrayBuffer())
      const bytes = await insertPagesFromPdf(state.pdfBytes, srcBytes, state.pageCount)
      useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({ ...prev, pdfBytes: bytes }))
      useTabStore.getState().setTabDirty(tabId, true)
      onStatus(`Inserted pages from ${file.name} at end.`)
    }
    input.click()
  }
  const replaceFromPicker = async () => {
    const input = document.createElement('input')
    input.type = 'file'; input.accept = 'application/pdf'
    input.onchange = async () => {
      const file = input.files?.[0]; if (!file) return
      const srcBytes = new Uint8Array(await file.arrayBuffer())
      const bytes = await replacePagesFromPdf(state.pdfBytes, srcBytes, 1, 1, 1)
      useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({ ...prev, pdfBytes: bytes }))
      useTabStore.getState().setTabDirty(tabId, true)
      onStatus(`Replaced page 1 with page 1 of ${file.name}.`)
    }
    input.click()
  }

  return (
    <div data-testid="section-pages">
      <h4 style={{ marginTop: 0, fontSize: 13 }}>Page Numbers</h4>
      <select data-testid="pn-format" style={inp} value={pageNumFormat} onChange={(e) => setPageNumFormat(e.target.value as 'Page N of M')}>
        <option>Page N of M</option>
        <option>Page N</option>
        <option>N of M</option>
        <option>N</option>
      </select>
      <div style={row}><button data-testid="pn-go" style={btn} onClick={addNumbers}>Add page numbers</button></div>

      <h4 style={{ marginTop: 18, fontSize: 13 }}>Background Color</h4>
      <input data-testid="bg-color" type="color" style={{ ...inp, height: 32, padding: 0, border: 'none' }} value={bgColor} onChange={(e) => setBgColor(e.target.value)} />
      <div style={row}><button data-testid="bg-go" style={btn} onClick={applyBackground}>Apply background</button></div>

      <h4 style={{ marginTop: 18, fontSize: 13 }}>Insert / Replace Pages</h4>
      <div style={row}>
        <button data-testid="insert-pages" style={btnSecondary} onClick={insertFromPicker}>Insert from PDF…</button>
        <button data-testid="replace-pages" style={btnSecondary} onClick={replaceFromPicker}>Replace page 1…</button>
      </div>
    </div>
  )
}

function HighlightsSection({ state, onStatus }: { state: PdfFormatState; onStatus: (s: string) => void }) {
  const [items, setItems] = useState<Array<{ page: number; text: string }>>([])
  const run = async () => {
    const extr = await extractText(state.pdfBytes)
    const hls = exportHighlightsFromPages(state.pages, extr)
    setItems(hls)
    onStatus(`${hls.length} highlight(s) exported.`)
  }
  const download = async () => {
    const content = items.map((h) => `Page ${h.page + 1}: ${h.text}`).join('\n')
    const blob = new Uint8Array(new TextEncoder().encode(content))
    await downloadBytes('highlights.txt', blob, 'text/plain')
    onStatus('Highlights saved to highlights.txt.')
  }
  return (
    <div data-testid="section-highlights">
      <h4 style={{ marginTop: 0, fontSize: 13 }}>Export Highlights</h4>
      <div style={row}><button data-testid="hl-scan" style={btn} onClick={run}>Scan highlighted text</button></div>
      {items.length > 0 && (
        <>
          <div data-testid="hl-list" style={{ marginTop: 10, padding: 8, background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 3, fontSize: 11, maxHeight: 200, overflow: 'auto' }}>
            {items.map((h, i) => (
              <div key={i}>Page {h.page + 1}: <em>{h.text}</em></div>
            ))}
          </div>
          <div style={row}><button data-testid="hl-save" style={btnSecondary} onClick={download}>Download as .txt</button></div>
        </>
      )}
    </div>
  )
}

function SignSection({ state, tabId, onStatus }: { state: PdfFormatState; tabId: string; onStatus: (s: string) => void }) {
  const [cn, setCn] = useState('My Name')
  const [org, setOrg] = useState('')
  const [reason, setReason] = useState('Approved')
  const [location, setLocation] = useState('')
  const [cert, setCert] = useState<{ p12: Uint8Array; passphrase: string; certPem: string } | null>(null)
  const [sigs, setSigs] = useState<Array<{ fieldName: string; signerName?: string; reason?: string; location?: string; signedAt?: string }>>([])

  useEffect(() => {
    (async () => setSigs(await listSignatures(state.pdfBytes)))()
  }, [state.pdfBytes])

  const gen = async () => {
    const identity: CertIdentity = { commonName: cn, organization: org || undefined }
    const c = await generateSelfSignedCert(identity)
    setCert(c)
    onStatus(`Self-signed cert generated for "${cn}" (passphrase auto-set).`)
  }
  const sign = async () => {
    if (!cert) { onStatus('Generate a cert first.'); return }
    const bytes = await signPdf(state.pdfBytes, cert.p12, cert.passphrase, { reason, location, signerName: cn })
    useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({ ...prev, pdfBytes: bytes }))
    useTabStore.getState().setTabDirty(tabId, true)
    setSigs(await listSignatures(bytes))
    onStatus(`Document signed by "${cn}".`)
  }
  const downloadP12 = async () => {
    if (!cert) return
    const slug = cn.replace(/\W+/g, '_')
    await downloadBytes(`${slug}.p12`, cert.p12, 'application/x-pkcs12')
    const pemBytes = new Uint8Array(new TextEncoder().encode(cert.certPem))
    await downloadBytes(`${slug}-passphrase.txt`, new Uint8Array(new TextEncoder().encode(cert.passphrase)), 'text/plain')
    await downloadBytes(`${slug}-public.pem`, pemBytes, 'application/x-pem-file')
    onStatus('Cert bundle + passphrase + public .pem downloaded.')
  }

  return (
    <div data-testid="section-sign">
      <h4 style={{ marginTop: 0, fontSize: 13 }}>Digital Signature (Self-Signed)</h4>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>Generate a free self-signed certificate on your device and sign the PDF. Adobe Reader will show the signature as "valid but untrusted" (no CA chain).</div>

      <label style={label}>Common Name (signer)</label><input data-testid="sign-cn" style={inp} value={cn} onChange={(e) => setCn(e.target.value)} />
      <label style={{ ...label, marginTop: 8 }}>Organization (optional)</label><input data-testid="sign-org" style={inp} value={org} onChange={(e) => setOrg(e.target.value)} />
      <label style={{ ...label, marginTop: 8 }}>Reason</label><input data-testid="sign-reason" style={inp} value={reason} onChange={(e) => setReason(e.target.value)} />
      <label style={{ ...label, marginTop: 8 }}>Location</label><input data-testid="sign-location" style={inp} value={location} onChange={(e) => setLocation(e.target.value)} />

      <div style={row}>
        <button data-testid="sign-gen" style={btnSecondary} onClick={gen}>{cert ? 'Regenerate cert' : 'Generate cert'}</button>
        <button data-testid="sign-sign" style={btn} onClick={sign} disabled={!cert}>Sign document</button>
        {cert && <button data-testid="sign-download" style={btnSecondary} onClick={downloadP12}>Download cert bundle</button>}
      </div>

      {sigs.length > 0 && (
        <div data-testid="sign-list" style={{ marginTop: 14, padding: 8, background: 'var(--bg-surface)', borderRadius: 3, fontSize: 11 }}>
          <strong>Existing signatures ({sigs.length})</strong>
          {sigs.map((s, i) => (
            <div key={i} style={{ marginTop: 4 }}>
              {s.signerName ?? s.fieldName} · {s.reason ?? '—'} · {s.location ?? '—'} · {s.signedAt ?? '—'}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function BookmarksSection({ state, tabId, onStatus }: { state: PdfFormatState; tabId: string; onStatus: (s: string) => void }) {
  const [bms, setBms] = useState<Bookmark[]>([])
  useEffect(() => { readBookmarks(state.pdfBytes).then(setBms) }, [state.pdfBytes])
  const update = (i: number, patch: Partial<Bookmark>) => setBms((prev) => prev.map((b, idx) => idx === i ? { ...b, ...patch } : b))
  const add = () => setBms((prev) => [...prev, { title: 'New bookmark', page: 0 }])
  const remove = (i: number) => setBms((prev) => prev.filter((_, idx) => idx !== i))
  const save = async () => {
    const bytes = await writeFlatBookmarks(state.pdfBytes, bms)
    useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({ ...prev, pdfBytes: bytes }))
    useTabStore.getState().setTabDirty(tabId, true)
    onStatus(`Wrote ${bms.length} bookmark(s) to document.`)
  }

  return (
    <div data-testid="section-bookmarks">
      <h4 style={{ marginTop: 0, fontSize: 13 }}>Bookmarks / Outline</h4>
      {bms.map((bm, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
          <input data-testid={`bm-title-${i}`} style={inp} value={bm.title} onChange={(e) => update(i, { title: e.target.value })} />
          <input data-testid={`bm-page-${i}`} type="number" min={0} style={{ ...inp, width: 80 }} value={bm.page + 1} onChange={(e) => update(i, { page: Number(e.target.value) - 1 })} />
          <button onClick={() => remove(i)} style={{ ...btnSecondary, background: 'var(--danger)', color: '#fff' }}>✕</button>
        </div>
      ))}
      <div style={row}>
        <button data-testid="bm-add" style={btnSecondary} onClick={add}>+ Add bookmark</button>
        <button data-testid="bm-save" style={btn} onClick={save}>Save bookmarks</button>
      </div>
    </div>
  )
}

function TextSection({ state, tabId, onStatus }: { state: PdfFormatState; tabId: string; onStatus: (s: string) => void }) {
  const [find, setFind] = useState('')
  const [replace, setReplace] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)

  const doFind = () => {
    const matches = findAcrossPages(state.pages, find, { caseSensitive })
    onStatus(`${matches.length} match(es) across ${new Set(matches.map((m) => m.pageIndex)).size} page(s).`)
  }
  const doReplace = () => {
    const res = replaceAcrossPages(state.pages, find, replace, { caseSensitive })
    useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({ ...prev, pages: res.pages }))
    useTabStore.getState().setTabDirty(tabId, true)
    onStatus(`Replaced ${res.replacements} occurrence(s).`)
  }
  const doSpell = () => {
    const flags = spellCheckPages(state.pages)
    onStatus(`${flags.length} possible typo(s): ${flags.slice(0, 5).map((f) => f.word).join(', ')}${flags.length > 5 ? '…' : ''}`)
  }
  const doReadAloud = () => {
    const u = readPageAloud(state, 0)
    onStatus(u ? 'Speaking page 1…' : 'Nothing to read on page 1.')
  }
  const doStop = () => { stopReading(); onStatus('Stopped.') }

  return (
    <div data-testid="section-text">
      <h4 style={{ marginTop: 0, fontSize: 13 }}>Find &amp; Replace</h4>
      <label style={label}>Find</label><input data-testid="find-input" style={inp} value={find} onChange={(e) => setFind(e.target.value)} />
      <label style={{ ...label, marginTop: 8 }}>Replace with</label><input data-testid="replace-input" style={inp} value={replace} onChange={(e) => setReplace(e.target.value)} />
      <label style={{ fontSize: 11, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
        <input type="checkbox" data-testid="find-case" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} /> Case sensitive
      </label>
      <div style={row}>
        <button data-testid="find-go" style={btnSecondary} onClick={doFind}>Find all</button>
        <button data-testid="replace-go" style={btn} onClick={doReplace}>Replace all</button>
      </div>

      <h4 style={{ marginTop: 18, fontSize: 13 }}>Spell Check</h4>
      <div style={row}><button data-testid="spell-go" style={btnSecondary} onClick={doSpell}>Scan for typos</button></div>

      <h4 style={{ marginTop: 18, fontSize: 13 }}>Read Aloud</h4>
      <div style={row}>
        <button data-testid="read-go" style={btnSecondary} onClick={doReadAloud}>Read page 1</button>
        <button data-testid="read-stop" style={btnSecondary} onClick={doStop}>Stop</button>
      </div>
    </div>
  )
}

function CompareSection({ state, onStatus }: { state: PdfFormatState; onStatus: (s: string) => void }) {
  const [result, setResult] = useState<null | { pages: number; inserted: number; deleted: number; similarity: number }>(null)
  const pickAndCompare = () => {
    const input = document.createElement('input')
    input.type = 'file'; input.accept = 'application/pdf'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      const other = new Uint8Array(await file.arrayBuffer())
      const r = await comparePdfs(state.pdfBytes, other)
      setResult({ pages: r.pages.length, inserted: r.summary.inserted, deleted: r.summary.deleted, similarity: r.summary.similarity })
      onStatus(`Compared: ${Math.round(r.summary.similarity * 100)}% similar · +${r.summary.inserted} / −${r.summary.deleted} lines`)
    }
    input.click()
  }
  return (
    <div data-testid="section-compare">
      <h4 style={{ marginTop: 0, fontSize: 13 }}>Compare Documents</h4>
      <div style={row}><button data-testid="compare-pick" style={btn} onClick={pickAndCompare}>Pick second PDF…</button></div>
      {result && (
        <div data-testid="compare-result" style={{ marginTop: 12, fontSize: 12, color: 'var(--text-secondary)' }}>
          <div>Pages compared: {result.pages}</div>
          <div>Lines inserted: <strong style={{ color: 'var(--success)' }}>+{result.inserted}</strong></div>
          <div>Lines deleted: <strong style={{ color: 'var(--danger)' }}>−{result.deleted}</strong></div>
          <div>Similarity: <strong>{(result.similarity * 100).toFixed(1)}%</strong></div>
        </div>
      )}
    </div>
  )
}

function ThumbnailSection({ state, tabId, onStatus }: { state: PdfFormatState; tabId: string; onStatus: (s: string) => void }) {
  const [sourcePage, setSourcePage] = useState(1)
  const [coverMode, setCoverMode] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [lastImage, setLastImage] = useState<Uint8Array | null>(null)

  // Previously-picked image persisted as data URL
  const urlOf = (bytes: Uint8Array, mime = 'image/png') => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return URL.createObjectURL(new Blob([bytes as any], { type: mime }))
  }

  const useSelectedPage = async () => {
    const bytes = await setPdfThumbnailFromPage(state.pdfBytes, sourcePage - 1, coverMode)
    // Also grab that page as a preview image for the UI
    const imgs = await pdfToImages(state.pdfBytes, { scale: 1 })
    const pngBytes = imgs[sourcePage - 1] ?? imgs[0]
    if (pngBytes) {
      if (previewUrl) URL.revokeObjectURL(previewUrl)
      setPreviewUrl(urlOf(pngBytes))
      setLastImage(pngBytes)
    }
    useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({ ...prev, pdfBytes: bytes }))
    useTabStore.getState().setTabDirty(tabId, true)
    onStatus(`Thumbnail set from page ${sourcePage}${coverMode ? ' (+ cover page prepended)' : ''}.`)
  }

  const pickImage = () => {
    const input = document.createElement('input')
    input.type = 'file'; input.accept = 'image/png,image/jpeg'
    input.onchange = async () => {
      const file = input.files?.[0]; if (!file) return
      const imageBytes = new Uint8Array(await file.arrayBuffer())
      const bytes = await setPdfThumbnail(state.pdfBytes, {
        imageBytes,
        pagesForEmbed: 'all',
        prependCoverPage: coverMode,
      })
      if (previewUrl) URL.revokeObjectURL(previewUrl)
      setPreviewUrl(urlOf(imageBytes, file.type || 'image/png'))
      setLastImage(imageBytes)
      useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({ ...prev, pdfBytes: bytes }))
      useTabStore.getState().setTabDirty(tabId, true)
      onStatus(`Thumbnail set from ${file.name}${coverMode ? ' (+ cover page prepended)' : ''}.`)
    }
    input.click()
  }

  return (
    <div data-testid="section-thumbnail">
      <h4 style={{ marginTop: 0, fontSize: 13 }}>Custom Thumbnail</h4>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>
        Embeds a thumbnail image in the PDF (shown by Acrobat-class viewers) and optionally adds a cover page
        at the front of the document.
      </div>

      <label style={{ fontSize: 11, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
        <input
          type="checkbox"
          data-testid="thumb-cover-mode"
          checked={coverMode}
          onChange={(e) => setCoverMode(e.target.checked)}
        />
        Also prepend as cover page (page 1)
      </label>

      <h5 style={{ fontSize: 12, marginBottom: 6 }}>Use a page from this PDF</h5>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <input
          data-testid="thumb-page-num"
          type="number" min={1} max={state.pageCount}
          value={sourcePage}
          onChange={(e) => setSourcePage(Math.max(1, Math.min(state.pageCount, Number(e.target.value))))}
          style={{ ...inp, width: 80 }}
        />
        <button data-testid="thumb-use-page" onClick={useSelectedPage} style={btn}>Use page {sourcePage}</button>
      </div>

      <h5 style={{ fontSize: 12, marginBottom: 6 }}>Or upload your own image</h5>
      <div style={row}>
        <button data-testid="thumb-upload" onClick={pickImage} style={btnSecondary}>Choose PNG or JPG…</button>
      </div>

      {previewUrl && (
        <div data-testid="thumb-preview-box" style={{ marginTop: 14, padding: 8, background: 'var(--bg-surface)', borderRadius: 3 }}>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>Current thumbnail</div>
          <img data-testid="thumb-preview" src={previewUrl} style={{ maxHeight: 140, display: 'block', border: '1px solid var(--border)', borderRadius: 3 }} />
          {lastImage && (
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
              {lastImage.byteLength.toLocaleString()} bytes · {lastImage[0] === 0x89 ? 'PNG' : 'JPG'}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Document Properties → Fonts tab. Lists every embedded font with
 *  PostScript name + family + subsetted flag. Acrobat exposes the
 *  same list under Properties → Fonts; procurement reviewers scan
 *  it to confirm font licensing, subset coverage, and that the
 *  doc isn't relying on system-fallback fonts (which break PDF/A
 *  conformance). */
function FontsSection({
  state,
  onStatus,
}: {
  state: PdfFormatState
  onStatus: (s: string) => void
}) {
  const [fonts, setFonts] = useState<Array<{ psName: string; family: string; subsetted: boolean }>>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const list = await window.api.font.scanPdf(state.pdfBytes)
        if (!cancelled) {
          setFonts(list)
          setLoading(false)
        }
      } catch (e) {
        if (!cancelled) {
          onStatus(e instanceof Error ? `Error: ${e.message}` : 'Font scan failed')
          setFonts([])
          setLoading(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [state.pdfBytes, onStatus])

  const subsettedCount = fonts.filter((f) => f.subsetted).length
  const fullEmbedCount = fonts.length - subsettedCount

  return (
    <div data-testid="section-fonts">
      <h4 style={{ marginTop: 0, fontSize: 13 }}>Fonts</h4>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>
        Every font reference in the PDF. Subset (✂) means only the glyphs the doc uses are embedded; full-embed means the entire font is shipped.
      </div>
      {loading && <div data-testid="fonts-loading" style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>Scanning…</div>}
      {!loading && fonts.length === 0 && (
        <div data-testid="fonts-empty" style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>
          No /Font dictionaries found in the PDF.
        </div>
      )}
      {!loading && fonts.length > 0 && (
        <>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 8, fontFamily: '"JetBrains Mono", monospace' }}>
            {fonts.length} font{fonts.length === 1 ? '' : 's'} · {subsettedCount} subset · {fullEmbedCount} full-embed
          </div>
          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: 4,
              maxHeight: 360,
              overflowY: 'auto',
            }}
          >
            <table data-testid="fonts-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <thead>
                <tr style={{ background: 'var(--bg-surface)', position: 'sticky', top: 0 }}>
                  <th style={fontTh}>Family</th>
                  <th style={fontTh}>PostScript Name</th>
                  <th style={fontTh}>Subset</th>
                </tr>
              </thead>
              <tbody>
                {fonts.map((f, i) => (
                  <tr
                    key={`${f.psName}_${i}`}
                    data-testid={`fonts-row-${i}`}
                    style={{ borderTop: '1px solid var(--border)' }}
                  >
                    <td style={fontTd}>{f.family || '—'}</td>
                    <td style={{ ...fontTd, fontFamily: '"JetBrains Mono", monospace', fontSize: 10 }}>
                      {f.psName}
                    </td>
                    <td style={{ ...fontTd, textAlign: 'center', color: f.subsetted ? 'var(--accent)' : 'var(--text-muted)' }}>
                      {f.subsetted ? '✂' : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

const fontTh: React.CSSProperties = {
  textAlign: 'left',
  padding: '6px 8px',
  fontWeight: 600,
  fontSize: 10,
  color: 'var(--text-secondary)',
  textTransform: 'uppercase',
  letterSpacing: 0.4,
}
const fontTd: React.CSSProperties = {
  padding: '5px 8px',
  fontSize: 11,
  color: 'var(--text-primary)',
}

/** Document Statistics tab. Aggregates page count, file size,
 *  fonts/images/annotations/links/forms/outlines/attachments/layers
 *  + best-effort character count. Acrobat shows roughly the same
 *  set under Properties → Description; the per-line numeric
 *  layout is the standard procurement-friendly format. */
function StatsSection({ state }: { state: PdfFormatState }) {
  const [stats, setStats] = useState<import('../../services/pdfDocumentStats').DocumentStats | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const m = await import('../../services/pdfDocumentStats')
        const s = await m.generateDocumentStats(state.pdfBytes)
        if (!cancelled) {
          setStats(s)
          setLoading(false)
        }
      } catch {
        if (!cancelled) {
          setStats(null)
          setLoading(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [state.pdfBytes])

  return (
    <div data-testid="section-stats">
      <h4 style={{ marginTop: 0, fontSize: 13 }}>Document statistics</h4>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>
        Aggregate counts across the document. Numbers re-scan whenever the
        bytes change (post-save / undo / sanitize).
      </div>
      {loading && <div data-testid="stats-loading" style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>Computing…</div>}
      {!loading && stats && (
        <table data-testid="stats-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <tbody>
            <StatsRow label="File size" value={formatBytes(stats.fileSize)} testid="stats-file-size" />
            <StatsRow label="PDF version" value={stats.pdfVersion || 'unknown'} testid="stats-pdf-version" />
            <StatsRow label="Encrypted" value={stats.encrypted ? 'Yes' : 'No'} testid="stats-encrypted" />
            <StatsRow label="Pages" value={stats.pageCount.toLocaleString()} testid="stats-page-count" />
            <StatsRow label="Font references" value={stats.fontReferences.toLocaleString()} testid="stats-fonts" />
            <StatsRow label="Images" value={stats.imageCount.toLocaleString()} testid="stats-images" />
            <StatsRow label="Annotations" value={stats.annotationCount.toLocaleString()} testid="stats-annotations" />
            <StatsRow label="Links" value={stats.linkCount.toLocaleString()} testid="stats-links" />
            <StatsRow label="Form fields" value={stats.formFieldCount.toLocaleString()} testid="stats-fields" />
            <StatsRow label="Bookmarks" value={stats.outlineCount.toLocaleString()} testid="stats-bookmarks" />
            <StatsRow label="Embedded files" value={stats.attachmentCount.toLocaleString()} testid="stats-attachments" />
            <StatsRow label="Optional content (layers)" value={stats.layerCount.toLocaleString()} testid="stats-layers" />
            <StatsRow label="Text characters (approx.)" value={stats.textCharCount.toLocaleString()} testid="stats-chars" />
          </tbody>
        </table>
      )}
    </div>
  )
}

function StatsRow({ label, value, testid }: { label: string; value: string; testid: string }) {
  return (
    <tr data-testid={testid} style={{ borderBottom: '1px solid var(--border)' }}>
      <td style={{ padding: '6px 8px', color: 'var(--text-secondary)', fontSize: 11 }}>{label}</td>
      <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: '"JetBrains Mono", monospace', color: 'var(--text-primary)' }}>{value}</td>
    </tr>
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function OptimizeSection({ state, tabId, onStatus }: { state: PdfFormatState; tabId: string; onStatus: (s: string) => void }) {
  const before = state.pdfBytes.byteLength
  const run = async () => {
    const out = await compressPdf(state.pdfBytes)
    useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({ ...prev, pdfBytes: out }))
    useTabStore.getState().setTabDirty(tabId, true)
    onStatus(`Optimized: ${before} → ${out.byteLength} bytes (${(100 * (before - out.byteLength) / before).toFixed(1)}% saved).`)
  }
  return (
    <div data-testid="section-optimize">
      <h4 style={{ marginTop: 0, fontSize: 13 }}>Compress / Optimize</h4>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>Current size: <strong>{before.toLocaleString()} bytes</strong></div>
      <button data-testid="optimize-go" style={btn} onClick={run}>Optimize now</button>
    </div>
  )
}

function PageLabelsSection({ state, tabId, onStatus }: { state: PdfFormatState; tabId: string; onStatus: (s: string) => void }) {
  const [ranges, setRanges] = useState<{ from: number; style: PageLabelStyle; prefix: string; start: number }[]>([
    { from: 0, style: 'D', prefix: '', start: 1 }
  ])
  const styles: { value: PageLabelStyle; label: string }[] = [
    { value: 'D', label: '1, 2, 3 (Decimal)' },
    { value: 'R', label: 'I, II, III (Roman UC)' },
    { value: 'r', label: 'i, ii, iii (Roman LC)' },
    { value: 'A', label: 'A, B, C (Letter UC)' },
    { value: 'a', label: 'a, b, c (Letter LC)' },
  ]
  const addRange = () => setRanges([...ranges, { from: ranges.length > 0 ? ranges[ranges.length - 1].from + 1 : 0, style: 'D', prefix: '', start: 1 }])
  const removeRange = (i: number) => setRanges(ranges.filter((_, idx) => idx !== i))
  const updateRange = (i: number, field: string, value: unknown) => {
    setRanges(ranges.map((r, idx) => idx === i ? { ...r, [field]: value } : r))
  }
  const apply = async () => {
    const labelRanges: PageLabelRange[] = ranges.map(r => ({
      from: r.from,
      style: r.style,
      prefix: r.prefix || undefined,
      start: r.start,
    }))
    const out = await setPageLabels(state.pdfBytes, labelRanges)
    useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({ ...prev, pdfBytes: out }))
    useTabStore.getState().setTabDirty(tabId, true)
    onStatus(`Applied ${ranges.length} page label range(s).`)
  }
  return (
    <div data-testid="section-pagelabels">
      <h4 style={{ marginTop: 0, fontSize: 13 }}>Page Labels</h4>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>Set custom numbering styles (i, ii, iii → 1, 2, 3 → A, B, C) for different page ranges.</div>
      {ranges.map((r, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
          <label style={{ fontSize: 11, width: 50 }}>Page {r.from + 1}+</label>
          <input type="number" min={1} value={r.from + 1} style={{ width: 50, fontSize: 11, padding: '2px 4px' }}
            onChange={(e) => updateRange(i, 'from', Math.max(0, Number(e.target.value) - 1))} />
          <select value={r.style} style={{ fontSize: 11, padding: '2px 4px' }}
            onChange={(e) => updateRange(i, 'style', e.target.value)}>
            {styles.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
          <input placeholder="Prefix" value={r.prefix} style={{ width: 70, fontSize: 11, padding: '2px 4px' }}
            onChange={(e) => updateRange(i, 'prefix', e.target.value)} />
          <label style={{ fontSize: 11 }}>Start:</label>
          <input type="number" min={1} value={r.start} style={{ width: 40, fontSize: 11, padding: '2px 4px' }}
            onChange={(e) => updateRange(i, 'start', Math.max(1, Number(e.target.value)))} />
          {ranges.length > 1 && <button style={{ fontSize: 10, padding: '1px 4px', color: 'var(--danger)' }} onClick={() => removeRange(i)}>x</button>}
        </div>
      ))}
      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
        <button style={btn} onClick={addRange}>+ Add Range</button>
        <button style={btn} onClick={apply}>Apply Labels</button>
      </div>
    </div>
  )
}

function SanitizeSection({ state, tabId, onStatus }: { state: PdfFormatState; tabId: string; onStatus: (s: string) => void }) {
  const [opts, setOpts] = useState({
    stripMetadata: true,
    stripXmp: true,
    stripJavaScript: true,
    stripAttachments: true,
    stripHiddenLayers: true,
    stripAnnotations: false,
    stripForms: false,
  })
  // Pre-removal report. Populated on mount + after every sanitize so
  // the UI reflects what's actually still in the file. Acrobat's
  // Sanitize wizard works the same way — show what would be removed
  // before the user commits, then re-scan after to confirm. [§9.6.2]
  const [report, setReport] = useState<import('../../services/pdfSanitizeReport').SanitizeReport | null>(null)
  const [scanning, setScanning] = useState(false)

  // Re-scan whenever the underlying bytes change (post-save / undo).
  const bytes = state.pdfBytes
  useEffect(() => {
    let cancelled = false
    setScanning(true)
    void import('../../services/pdfSanitizeReport')
      .then(({ generateSanitizeReport }) => generateSanitizeReport(bytes))
      .then((r) => {
        if (!cancelled) {
          setReport(r)
          setScanning(false)
        }
      })
      .catch((e) => {
        if (!cancelled) {
          console.warn('[sanitize] scan failed:', e)
          setReport(null)
          setScanning(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [bytes])

  const toggle = (key: string) => setOpts({ ...opts, [key]: !(opts as Record<string, boolean>)[key] })
  const run = async () => {
    const out = await sanitizePdf(state.pdfBytes, opts)
    const saved = state.pdfBytes.byteLength - out.byteLength
    useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({ ...prev, pdfBytes: out }))
    useTabStore.getState().setTabDirty(tabId, true)
    onStatus(`Sanitized. Removed ${saved > 0 ? saved.toLocaleString() + ' bytes of' : ''} hidden data.`)
  }

  // Map each toggle to the live count from the report. Empty string
  // means "report not loaded yet" — we still show the toggle so the
  // user can pre-set their selection while the scan completes.
  const formatCount = (n: number, label: string): string => {
    if (n <= 0) return '— none found'
    return `${n} ${label}${n === 1 ? '' : 's'}`
  }
  const counts: Record<string, string> = report
    ? {
        stripMetadata: report.metadata.present
          ? `— ${[report.metadata.title && 'title', report.metadata.author && 'author', report.metadata.subject && 'subject', (report.metadata.keywords?.length ?? 0) > 0 && `${report.metadata.keywords?.length} keyword(s)`, report.metadata.creator && 'creator', report.metadata.producer && 'producer'].filter(Boolean).join(', ')}`
          : '— none found',
        stripXmp: report.xmp.present ? `— ${report.xmp.bytes} bytes` : '— none found',
        stripJavaScript: formatCount(report.javascript.count, 'action'),
        stripAttachments: report.attachments.count > 0
          ? `— ${report.attachments.count} file(s): ${report.attachments.names.slice(0, 3).join(', ')}${report.attachments.names.length > 3 ? '…' : ''}`
          : '— none found',
        stripHiddenLayers: formatCount(report.layers.count, 'layer'),
        stripAnnotations: formatCount(report.annotations.totalCount, 'annotation'),
        stripForms: report.forms.fieldCount > 0
          ? `— ${report.forms.fieldCount} field(s)${report.forms.hasXfa ? ' + XFA' : ''}`
          : '— none found',
      }
    : {}

  const items: { key: string; label: string; desc: string }[] = [
    { key: 'stripMetadata', label: 'Document metadata', desc: 'Title, author, creator, producer, dates' },
    { key: 'stripXmp', label: 'XMP metadata stream', desc: 'Extended metadata (creation software, edit history)' },
    { key: 'stripJavaScript', label: 'JavaScript & actions', desc: 'OpenAction, page actions, embedded scripts' },
    { key: 'stripAttachments', label: 'Embedded file attachments', desc: 'Files embedded inside the PDF' },
    { key: 'stripHiddenLayers', label: 'Hidden layers (OCG)', desc: 'Optional content groups / hidden layers' },
    { key: 'stripAnnotations', label: 'All annotations', desc: 'Comments, markup, links (destructive)' },
    { key: 'stripForms', label: 'Interactive forms', desc: 'AcroForm + XFA form data (destructive)' },
  ]

  // Total of items the user has TOGGLED ON, so the run button reads
  // "Remove N items" — clearer than "Sanitize Now" for procurement
  // reviewers ("show me exactly what you're going to delete").
  const totalSelected = report
    ? (
        (opts.stripMetadata && report.metadata.present ? 1 : 0) +
        (opts.stripXmp && report.xmp.present ? 1 : 0) +
        (opts.stripJavaScript ? report.javascript.count : 0) +
        (opts.stripAttachments ? report.attachments.count : 0) +
        (opts.stripHiddenLayers ? report.layers.count : 0) +
        (opts.stripAnnotations ? report.annotations.totalCount : 0) +
        (opts.stripForms ? report.forms.fieldCount : 0)
      )
    : 0

  return (
    <div data-testid="section-sanitize">
      <h4 style={{ marginTop: 0, fontSize: 13 }}>Sanitize Document</h4>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
        Remove hidden information from the PDF for privacy and compliance. The
        report below shows what's currently in the file; toggle what to remove
        and click the run button.
      </div>
      {scanning && !report && (
        <div data-testid="sanitize-scanning" style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8, fontStyle: 'italic' }}>
          Scanning document…
        </div>
      )}
      {items.map(it => {
        const count = counts[it.key] ?? ''
        const isEmpty = count === '— none found'
        return (
          <label
            key={it.key}
            data-testid={`sanitize-toggle-${it.key}`}
            style={{
              display: 'flex',
              gap: 6,
              alignItems: 'flex-start',
              marginBottom: 6,
              cursor: isEmpty ? 'default' : 'pointer',
              fontSize: 12,
              opacity: isEmpty ? 0.5 : 1,
            }}
          >
            <input
              type="checkbox"
              checked={(opts as Record<string, boolean>)[it.key]}
              onChange={() => toggle(it.key)}
              disabled={isEmpty}
              style={{ marginTop: 2 }}
            />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 500, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span>{it.label}</span>
                {count && (
                  <span
                    data-testid={`sanitize-count-${it.key}`}
                    style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: '"JetBrains Mono", monospace' }}
                  >
                    {count}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{it.desc}</div>
            </div>
          </label>
        )
      })}
      <button
        data-testid="sanitize-run"
        style={{ ...btn, opacity: totalSelected === 0 ? 0.5 : 1, cursor: totalSelected === 0 ? 'not-allowed' : 'pointer' }}
        disabled={totalSelected === 0}
        onClick={run}
      >
        {totalSelected > 0 ? `Remove ${totalSelected} item${totalSelected === 1 ? '' : 's'}` : 'Nothing to remove'}
      </button>
    </div>
  )
}

// ── Action Wizard ────────────────────────────────────────────────

function WizardSection({ state, tabId, onStatus }: { state: PdfFormatState; tabId: string; onStatus: (s: string) => void }) {
  const allSteps: { type: ActionStepType; label: string }[] = [
    { type: 'compress', label: 'Compress / Optimize' },
    { type: 'sanitize', label: 'Deep Sanitize' },
    { type: 'flatten_transparency', label: 'Flatten Transparency' },
    { type: 'bates', label: 'Bates Numbering' },
    { type: 'to_word', label: 'Convert to Word' },
    { type: 'to_excel', label: 'Convert to Excel' },
    { type: 'to_ppt', label: 'Convert to PowerPoint' },
    { type: 'to_text', label: 'Convert to Text' },
    { type: 'to_image_only', label: 'Convert to Image-Only PDF' },
  ]
  const [steps, setSteps] = useState<ActionStep[]>([])
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState('')
  const [logs, setLogs] = useState<string[]>([])

  const addStep = (type: ActionStepType, label: string) => setSteps([...steps, { type, label }])
  const removeStep = (i: number) => setSteps(steps.filter((_, idx) => idx !== i))
  const moveStep = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= steps.length) return
    const copy = [...steps]; [copy[i], copy[j]] = [copy[j], copy[i]]
    setSteps(copy)
  }

  const runWorkflow = async () => {
    if (steps.length === 0) { onStatus('Add steps first.'); return }
    setRunning(true); setLogs([])
    const result = await executeWorkflow(state.pdfBytes, { name: 'Custom', steps }, (step, total, label) => {
      setProgress(`Step ${step + 1}/${total}: ${label}`)
    })
    setLogs(result.log)
    if (result.success) {
      if (result.outputFormat === 'pdf') {
        useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({ ...prev, pdfBytes: result.outputBytes }))
        useTabStore.getState().setTabDirty(tabId, true)
        onStatus('Workflow complete — PDF updated.')
      } else {
        await downloadBytes('output.' + result.outputFormat, result.outputBytes)
        onStatus('Workflow complete — file downloaded.')
      }
    } else {
      onStatus('Workflow failed — check log.')
    }
    setRunning(false); setProgress('')
  }

  const runPreset = async (idx: number) => {
    setRunning(true)
    const result = await executeWorkflow(state.pdfBytes, PRESET_WORKFLOWS[idx])
    if (result.success) {
      useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({ ...prev, pdfBytes: result.outputBytes }))
      useTabStore.getState().setTabDirty(tabId, true)
      onStatus(`"${PRESET_WORKFLOWS[idx].name}" complete.`)
    }
    setRunning(false)
  }

  return (
    <div data-testid="section-wizard">
      <h4 style={{ marginTop: 0, fontSize: 13 }}>Action Wizard</h4>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>Chain multiple operations into a workflow. Steps run sequentially.</div>

      <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 4 }}>Presets</div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 12, flexWrap: 'wrap' }}>
        {PRESET_WORKFLOWS.map((wf, i) => (
          <button key={i} style={btn} disabled={running} onClick={() => runPreset(i)}>{wf.name}</button>
        ))}
      </div>

      <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 4 }}>Custom Workflow</div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 8, flexWrap: 'wrap' }}>
        {allSteps.map(s => (
          <button key={s.type} style={{ ...btn, fontSize: 10 }} onClick={() => addStep(s.type, s.label)}>+ {s.label}</button>
        ))}
      </div>

      {steps.length > 0 && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 4, padding: 6, marginBottom: 8 }}>
          {steps.map((s, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 0', fontSize: 11 }}>
              <span style={{ width: 18, textAlign: 'center', color: 'var(--text-muted)' }}>{i + 1}</span>
              <span style={{ flex: 1 }}>{s.label}</span>
              <button style={{ fontSize: 9, padding: '1px 3px' }} onClick={() => moveStep(i, -1)}>^</button>
              <button style={{ fontSize: 9, padding: '1px 3px' }} onClick={() => moveStep(i, 1)}>v</button>
              <button style={{ fontSize: 9, padding: '1px 3px', color: 'var(--danger)' }} onClick={() => removeStep(i)}>x</button>
            </div>
          ))}
        </div>
      )}

      <button style={btn} disabled={running || steps.length === 0} onClick={runWorkflow}>
        {running ? progress || 'Running...' : 'Run Workflow'}
      </button>

      {logs.length > 0 && (
        <pre style={{ marginTop: 8, fontSize: 10, color: 'var(--text-muted)', maxHeight: 120, overflow: 'auto', background: 'var(--bg-surface)', padding: 6, borderRadius: 3 }}>
          {logs.join('\n')}
        </pre>
      )}
    </div>
  )
}

// ── PDF/A Validation + Remediation ───────────────────────────────

function PdfASection({ state, tabId, onStatus }: { state: PdfFormatState; tabId: string; onStatus: (s: string) => void }) {
  const [result, setResult] = useState<{ isCompliant: boolean; score: number; profile: string; issues: { severity: string; code: string; message: string; remediation?: string }[] } | null>(null)
  const [profile, setProfile] = useState<PdfAProfile>('A-1B')
  const [converting, setConverting] = useState(false)
  const [progress, setProgress] = useState<{ frac: number; label: string } | null>(null)
  const [convertReport, setConvertReport] = useState<ConvertReport | null>(null)

  const validate = async () => {
    const r = await validatePdfA(state.pdfBytes, profile)
    setResult(r)
    setConvertReport(null)
    onStatus(`${r.profile} score: ${r.score}/100 (${r.isCompliant ? 'Compliant' : 'Non-compliant'})`)
  }

  const convert = async () => {
    // 2u/3u are validate-only in v1 — convert pipeline doesn't generate
    // /ActualText. Surface that to the user rather than silently producing
    // a non-compliant Unicode profile.
    if (profile === 'A-2U' || profile === 'A-3U') {
      onStatus(`${profile} conversion not yet supported — use Validate to check existing compliance, or convert to ${profile.replace('U', 'B')} instead.`)
      return
    }
    setConverting(true)
    setProgress({ frac: 0, label: 'Starting…' })
    try {
      const { bytes, report } = await convertToPdfA(state.pdfBytes, {
        profile: profile as 'A-1B' | 'A-2B' | 'A-3B',
        onProgress: (frac, label) => setProgress({ frac, label }),
      })
      useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({ ...prev, pdfBytes: bytes }))
      useTabStore.getState().setTabDirty(tabId, true)
      setConvertReport(report)
      setResult(null)
      onStatus(`Converted to ${report.profile} — score ${report.finalScore}/100 (${report.isCompliant ? 'Compliant' : 'Non-compliant'})`)
    } catch (e) {
      onStatus(`Convert failed: ${String(e)}`)
    } finally {
      setConverting(false)
      setProgress(null)
    }
  }

  const remediate = async () => {
    if (!result) return
    let bytes = state.pdfBytes
    for (const issue of result.issues) {
      if (issue.code === 'PDFA-1') {
        const doc = await PDFDocument.load(bytes)
        doc.setTitle('Untitled Document')
        bytes = new Uint8Array(await doc.save())
      }
      if (issue.code === 'PDFA-2') bytes = await sanitizePdf(bytes, { stripJavaScript: true })
      if (issue.code === 'PDFA-4') bytes = await sanitizePdf(bytes, { stripAttachments: true })
      if (issue.code === 'PDFA-5') bytes = await sanitizePdf(bytes, { stripHiddenLayers: true })
    }
    useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({ ...prev, pdfBytes: bytes }))
    useTabStore.getState().setTabDirty(tabId, true)
    onStatus('Auto-remediation applied. Re-validate to check.')
    setResult(null)
  }

  return (
    <div data-testid="section-pdfa">
      <h4 style={{ marginTop: 0, fontSize: 13 }}>PDF/A Validation &amp; Conversion</h4>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
        Check conformance and convert to a PDF/A profile for archival, regulated, or government workflows.
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>Profile:</label>
        <select
          value={profile}
          onChange={(e) => { setProfile(e.target.value as PdfAProfile); setResult(null); setConvertReport(null) }}
          disabled={converting}
          style={{ padding: '3px 6px', fontSize: 11, background: 'var(--bg-input)', color: 'var(--text)', border: '1px solid var(--border)' }}
          data-testid="pdfa-profile-select"
        >
          <option value="A-1B">PDF/A-1b (strict, no transparency, ISO 19005-1)</option>
          <option value="A-2B">PDF/A-2b (allows transparency, ISO 19005-2)</option>
          <option value="A-3B">PDF/A-3b (allows attachments, ISO 19005-3)</option>
          <option value="A-2U">PDF/A-2u (Unicode, validate-only)</option>
          <option value="A-3U">PDF/A-3u (Unicode, validate-only)</option>
        </select>
        <button style={btn} onClick={validate} disabled={converting} data-testid="pdfa-validate">Validate</button>
        <button style={btn} onClick={convert} disabled={converting} data-testid="pdfa-convert">
          {converting ? 'Converting…' : `Convert to ${profile}`}
        </button>
        {result && result.issues.length > 0 && !converting && <button style={btn} onClick={remediate} data-testid="pdfa-autofix">Auto-Fix Issues</button>}
      </div>

      {progress && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{progress.label}</div>
          <div style={{ width: '100%', height: 4, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{ width: `${Math.round(progress.frac * 100)}%`, height: '100%', background: 'var(--accent, #4a9eff)', transition: 'width 0.2s ease' }} />
          </div>
        </div>
      )}

      {convertReport && (
        <div data-testid="pdfa-convert-report" style={{ marginBottom: 8, padding: 8, background: 'var(--bg-input, rgba(255,255,255,0.03))', border: '1px solid var(--border)', borderRadius: 4 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, color: convertReport.isCompliant ? 'var(--success)' : 'var(--danger)' }}>
            Converted to {convertReport.profile} — Score: {convertReport.finalScore}/100 ({convertReport.isCompliant ? 'Compliant' : 'Non-compliant'})
          </div>
          <div style={{ fontSize: 11 }}>
            {convertReport.steps.map((s, i) => (
              <div key={i} style={{ padding: '2px 0', display: 'flex', gap: 6 }}>
                <span style={{
                  color: s.status === 'done' ? 'var(--success, #a6e3a1)'
                    : s.status === 'warning' ? '#fab387'
                    : s.status === 'failed' ? 'var(--danger)'
                    : 'var(--text-muted)',
                  fontWeight: 500, minWidth: 60,
                }}>
                  [{s.status}]
                </span>
                <span style={{ minWidth: 110 }}>{s.name}</span>
                {s.detail && <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>{s.detail}</span>}
              </div>
            ))}
          </div>
          {convertReport.warnings.length > 0 && (
            <div style={{ marginTop: 8, fontSize: 10, color: '#fab387' }}>
              {convertReport.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
            </div>
          )}
        </div>
      )}

      {result && (
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, color: result.isCompliant ? 'var(--success)' : 'var(--danger)' }}>
            {result.profile} — Score: {result.score}/100 ({result.isCompliant ? 'Compliant' : 'Non-compliant'})
          </div>
          {result.issues.map((issue, i) => (
            <div key={i} style={{ padding: '4px 0', borderBottom: '1px solid var(--border)', fontSize: 11 }}>
              <span style={{ color: issue.severity === 'error' ? 'var(--danger)' : '#fab387', fontWeight: 500 }}>[{issue.code}]</span>{' '}
              {issue.message}
              {issue.remediation && <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>Fix: {issue.remediation}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Accessibility ────────────────────────────────────────────────

function AccessibilitySection({ state, tabId, onStatus }: { state: PdfFormatState; tabId: string; onStatus: (s: string) => void }) {
  const [checker, setChecker] = useState<A11yResult | null>(null)
  const [tree, setTree] = useState<StructTag | null>(null)
  const [taggingInProgress, setTaggingInProgress] = useState(false)
  const [progress, setProgress] = useState<{ frac: number; label: string } | null>(null)
  const [tagReport, setTagReport] = useState<AutoTagReport | null>(null)
  const [lang, setLang] = useState('en-US')
  const [figureCount, setFigureCount] = useState<{ total: number; missing: number } | null>(null)
  const [editingFigure, setEditingFigure] = useState<number | null>(null)
  const [altDraft, setAltDraft] = useState('')

  const runChecker = async () => {
    const r = await checkAccessibility(state.pdfBytes)
    setChecker(r)
    const tr = r.stats.isTagged ? await readStructureTree(state.pdfBytes) : null
    setTree(tr)
    const figs = await countFiguresWithoutAlt(state.pdfBytes)
    setFigureCount(figs)
    onStatus(`A11y score: ${r.score}/100 (${r.isCompliant ? 'Compliant' : 'Non-compliant'})`)
  }

  const runAutoTag = async () => {
    setTaggingInProgress(true)
    setProgress({ frac: 0, label: 'Starting…' })
    try {
      const { bytes, report } = await autoTagDocument(state.pdfBytes, {
        lang,
        onProgress: (frac, label) => setProgress({ frac, label }),
      })
      useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({ ...prev, pdfBytes: bytes }))
      useTabStore.getState().setTabDirty(tabId, true)
      setTagReport(report)
      onStatus(`Auto-tagged: ${report.headingCount} headings, ${report.paragraphCount} paragraphs, ${report.figureCount} figures across ${report.pagesProcessed} page(s).`)
      // Re-run checker on the new bytes
      const r = await checkAccessibility(bytes)
      setChecker(r)
      const tr = await readStructureTree(bytes)
      setTree(tr)
      const figs = await countFiguresWithoutAlt(bytes)
      setFigureCount(figs)
    } catch (e) {
      onStatus(`Auto-tag failed: ${String(e)}`)
    } finally {
      setTaggingInProgress(false)
      setProgress(null)
    }
  }

  const updateLang = async () => {
    try {
      const out = await setDocumentLang(state.pdfBytes, lang)
      useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({ ...prev, pdfBytes: out }))
      useTabStore.getState().setTabDirty(tabId, true)
      onStatus(`Document language set to ${lang}`)
    } catch (e) {
      onStatus(`Failed to set language: ${String(e)}`)
    }
  }

  const saveAltText = async (idx: number) => {
    try {
      const out = await setFigureAltText(state.pdfBytes, idx, altDraft)
      if (!out) {
        onStatus(`Figure index ${idx} not found in struct tree`)
        return
      }
      useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({ ...prev, pdfBytes: out }))
      useTabStore.getState().setTabDirty(tabId, true)
      setEditingFigure(null)
      setAltDraft('')
      onStatus(`Alt text saved for figure ${idx + 1}`)
      // Refresh
      const r = await checkAccessibility(out)
      setChecker(r)
      const tr = await readStructureTree(out)
      setTree(tr)
      const figs = await countFiguresWithoutAlt(out)
      setFigureCount(figs)
    } catch (e) {
      onStatus(`Failed to save alt text: ${String(e)}`)
    }
  }

  const renderTag = (tag: StructTag, depth: number): JSX.Element => (
    <div key={depth + tag.type + (tag.title || '')} style={{ paddingLeft: depth * 16, fontSize: 11, padding: '2px 0 2px ' + (depth * 16) + 'px' }}>
      <span style={{ color: 'var(--accent)', fontWeight: 500 }}>&lt;{tag.type}&gt;</span>
      {tag.title && <span style={{ color: 'var(--text-secondary)' }}> "{tag.title}"</span>}
      {tag.altText && <span style={{ color: 'var(--success)', fontSize: 10 }}> [alt: {tag.altText}]</span>}
      {tag.children.map((c) => renderTag(c, depth + 1))}
    </div>
  )

  return (
    <div data-testid="section-accessibility">
      <h4 style={{ marginTop: 0, fontSize: 13 }}>Accessibility &amp; Tagging</h4>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
        Tag the document for screen readers, set language, fill alt-text, and check Section 508 / PDF/UA compliance.
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button style={btn} onClick={runChecker} disabled={taggingInProgress} data-testid="a11y-check">Run Checker</button>
        <button style={btn} onClick={runAutoTag} disabled={taggingInProgress} data-testid="a11y-autotag">
          {taggingInProgress ? 'Tagging…' : 'Auto-Tag'}
        </button>
        <label style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 8 }}>Lang:</label>
        <input
          type="text"
          value={lang}
          onChange={(e) => setLang(e.target.value)}
          disabled={taggingInProgress}
          style={{ width: 60, padding: '2px 4px', fontSize: 11, background: 'var(--bg-input)', color: 'var(--text)', border: '1px solid var(--border)' }}
          data-testid="a11y-lang"
        />
        <button style={btn} onClick={updateLang} disabled={taggingInProgress}>Set Lang</button>
      </div>

      {progress && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{progress.label}</div>
          <div style={{ width: '100%', height: 4, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{ width: `${Math.round(progress.frac * 100)}%`, height: '100%', background: 'var(--accent, #4a9eff)', transition: 'width 0.2s ease' }} />
          </div>
        </div>
      )}

      {tagReport && (
        <div style={{ marginBottom: 8, padding: 6, background: 'var(--bg-input, rgba(255,255,255,0.03))', border: '1px solid var(--border)', borderRadius: 3, fontSize: 11 }}>
          Auto-tag complete: {tagReport.headingCount} headings, {tagReport.paragraphCount} paragraphs,{' '}
          {tagReport.figureCount} figures, {tagReport.artifactCount} artifacts ({tagReport.pagesProcessed} page{tagReport.pagesProcessed === 1 ? '' : 's'})
        </div>
      )}

      {checker && (
        <div style={{ marginBottom: 8, padding: 8, background: 'var(--bg-input, rgba(255,255,255,0.03))', border: '1px solid var(--border)', borderRadius: 4 }} data-testid="a11y-checker-report">
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, color: checker.isCompliant ? 'var(--success)' : 'var(--danger)' }}>
            {checker.profile} — Score: {checker.score}/100 ({checker.isCompliant ? 'Compliant' : 'Non-compliant'})
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
            Tagged: {checker.stats.isTagged ? 'yes' : 'no'} | Figures: {checker.stats.figuresWithAlt}/{checker.stats.figureCount} have alt-text | Headings: {checker.stats.headingLevels.length > 0 ? checker.stats.headingLevels.map(h => `H${h}`).join(', ') : '(none)'}
          </div>
          {checker.issues.map((issue, i) => (
            <div key={i} style={{ padding: '4px 0', borderTop: '1px solid var(--border)', fontSize: 11 }}>
              <span style={{ color: issue.severity === 'error' ? 'var(--danger)' : '#fab387', fontWeight: 500 }}>[{issue.code}]</span>{' '}
              {issue.message}
              {issue.remediation && <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>Fix: {issue.remediation}</div>}
            </div>
          ))}
        </div>
      )}

      {figureCount && figureCount.total > 0 && (
        <div style={{ marginBottom: 8 }} data-testid="a11y-alt-editor">
          <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 4 }}>
            Alt-text: {figureCount.total - figureCount.missing} / {figureCount.total} figures filled
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
            Click a Figure index to edit its alt text. Figures are numbered in document order.
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
            {Array.from({ length: figureCount.total }).map((_, i) => (
              <button
                key={i}
                style={{ ...btn, padding: '2px 8px', fontSize: 11 }}
                onClick={() => { setEditingFigure(i); setAltDraft('') }}
              >
                Figure {i + 1}
              </button>
            ))}
          </div>
          {editingFigure !== null && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                type="text"
                placeholder={`Alt text for Figure ${editingFigure + 1}…`}
                value={altDraft}
                onChange={(e) => setAltDraft(e.target.value)}
                style={{ flex: 1, padding: '4px 6px', fontSize: 12, background: 'var(--bg-input)', color: 'var(--text)', border: '1px solid var(--border)' }}
                autoFocus
                data-testid="a11y-alt-input"
              />
              <button style={btn} onClick={() => saveAltText(editingFigure)} disabled={altDraft.trim() === ''}>Save</button>
              <button style={btn} onClick={() => { setEditingFigure(null); setAltDraft('') }}>Cancel</button>
            </div>
          )}
        </div>
      )}

      {tree && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 500, marginBottom: 4 }}>Structure tree</div>
          <div style={{ maxHeight: 250, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 3, padding: 6, background: 'var(--bg-surface)' }}>
            {renderTag(tree, 0)}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Embedded Images ──────────────────────────────────────────────

function ImagesSection({ state, tabId, onStatus }: { state: PdfFormatState; tabId: string; onStatus: (s: string) => void }) {
  const [images, setImages] = useState<{ pageIndex: number; xObjectName: string; width: number; height: number; filter: string; byteLength: number }[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [newWidth, setNewWidth] = useState(0)
  const [newHeight, setNewHeight] = useState(0)

  const scan = async () => {
    const imgs = await listEmbeddedImages(state.pdfBytes)
    setImages(imgs)
    onStatus(`Found ${imgs.length} embedded image(s).`)
  }

  const resize = async () => {
    if (selected === null || newWidth < 1 || newHeight < 1) return
    const img = images[selected]
    try {
      const out = await resizeEmbeddedImage(state.pdfBytes, img.pageIndex, img.xObjectName, newWidth, newHeight)
      useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({ ...prev, pdfBytes: out }))
      useTabStore.getState().setTabDirty(tabId, true)
      onStatus(`Resized ${img.xObjectName} to ${newWidth}x${newHeight}.`)
      scan()
    } catch (e) { onStatus('Resize failed: ' + (e as Error).message) }
  }

  const replace = async () => {
    if (selected === null) return
    const img = images[selected]
    const input = document.createElement('input')
    input.type = 'file'; input.accept = 'image/jpeg,image/png'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      const bytes = new Uint8Array(await file.arrayBuffer())
      // Get dimensions from the image
      const bitmap = await createImageBitmap(new Blob([bytes]))
      try {
        const out = await replaceEmbeddedImage(state.pdfBytes, img.pageIndex, img.xObjectName, bytes, bitmap.width, bitmap.height)
        bitmap.close()
        useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({ ...prev, pdfBytes: out }))
        useTabStore.getState().setTabDirty(tabId, true)
        onStatus(`Replaced ${img.xObjectName} with ${file.name}.`)
        scan()
      } catch (e) { onStatus('Replace failed: ' + (e as Error).message) }
    }
    input.click()
  }

  return (
    <div data-testid="section-images">
      <h4 style={{ marginTop: 0, fontSize: 13 }}>Embedded Images</h4>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>List, resize, or replace images embedded in the PDF.</div>
      <button style={btn} onClick={scan}>Scan Images</button>

      {images.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
            <thead><tr style={{ borderBottom: '1px solid var(--border)' }}>
              <th style={{ textAlign: 'left', padding: 3 }}>Name</th>
              <th style={{ textAlign: 'left', padding: 3 }}>Page</th>
              <th style={{ textAlign: 'left', padding: 3 }}>Size</th>
              <th style={{ textAlign: 'left', padding: 3 }}>Format</th>
              <th style={{ textAlign: 'right', padding: 3 }}>Bytes</th>
            </tr></thead>
            <tbody>{images.map((img, i) => (
              <tr key={i} onClick={() => { setSelected(i); setNewWidth(img.width); setNewHeight(img.height) }}
                style={{ cursor: 'pointer', background: selected === i ? 'var(--bg-surface)' : 'transparent', borderBottom: '1px solid var(--border)' }}>
                <td style={{ padding: 3 }}>{img.xObjectName}</td>
                <td style={{ padding: 3 }}>{img.pageIndex + 1}</td>
                <td style={{ padding: 3 }}>{img.width}x{img.height}</td>
                <td style={{ padding: 3 }}>{img.filter}</td>
                <td style={{ padding: 3, textAlign: 'right' }}>{img.byteLength.toLocaleString()}</td>
              </tr>
            ))}</tbody>
          </table>

          {selected !== null && (
            <div style={{ marginTop: 8, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <label style={{ fontSize: 11 }}>Resize to:</label>
              <input type="number" value={newWidth} onChange={e => setNewWidth(Number(e.target.value))} style={{ width: 60, fontSize: 11, padding: '2px 4px' }} />
              <span style={{ fontSize: 11 }}>x</span>
              <input type="number" value={newHeight} onChange={e => setNewHeight(Number(e.target.value))} style={{ width: 60, fontSize: 11, padding: '2px 4px' }} />
              <button style={btn} onClick={resize}>Resize</button>
              <button style={btn} onClick={replace}>Replace...</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Crop Pages ───────────────────────────────────────────────────

function CropSection({ state, tabId, onStatus }: { state: PdfFormatState; tabId: string; onStatus: (s: string) => void }) {
  const [top, setTop] = useState(0)
  const [bottom, setBottom] = useState(0)
  const [left, setLeft] = useState(0)
  const [right, setRight] = useState(0)
  const [applyTo, setApplyTo] = useState<'all' | 'current'>('all')

  const crop = async () => {
    const doc = await PDFDocument.load(state.pdfBytes)
    const pages = doc.getPages()
    const currentPage = (await import('../../stores/uiStore')).useUIStore.getState().currentPage
    const targets = applyTo === 'all' ? pages : [pages[currentPage]].filter(Boolean)

    for (const page of targets) {
      const { width, height } = page.getSize()
      const cropBox = page.node.get(PDFName.of('CropBox'))
      // If CropBox exists, use it; otherwise use MediaBox dimensions
      page.node.set(PDFName.of('CropBox'), doc.context.obj([
        left,
        bottom,
        width - right,
        height - top
      ]))
    }

    const out = new Uint8Array(await doc.save())
    useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({ ...prev, pdfBytes: out }))
    useTabStore.getState().setTabDirty(tabId, true)
    onStatus(`Cropped ${targets.length} page(s): margins T=${top} B=${bottom} L=${left} R=${right} pt.`)
  }

  return (
    <div data-testid="section-crop">
      <h4 style={{ marginTop: 0, fontSize: 13 }}>Crop / Trim Pages</h4>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>Set crop margins (in points). Content outside the crop box is hidden but not removed.</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, maxWidth: 300, marginBottom: 8 }}>
        <label style={{ fontSize: 11 }}>Top: <input type="number" min={0} value={top} onChange={e => setTop(Number(e.target.value))} style={{ width: 60, fontSize: 11, padding: '2px 4px' }} /></label>
        <label style={{ fontSize: 11 }}>Bottom: <input type="number" min={0} value={bottom} onChange={e => setBottom(Number(e.target.value))} style={{ width: 60, fontSize: 11, padding: '2px 4px' }} /></label>
        <label style={{ fontSize: 11 }}>Left: <input type="number" min={0} value={left} onChange={e => setLeft(Number(e.target.value))} style={{ width: 60, fontSize: 11, padding: '2px 4px' }} /></label>
        <label style={{ fontSize: 11 }}>Right: <input type="number" min={0} value={right} onChange={e => setRight(Number(e.target.value))} style={{ width: 60, fontSize: 11, padding: '2px 4px' }} /></label>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <label style={{ fontSize: 11 }}><input type="radio" checked={applyTo === 'all'} onChange={() => setApplyTo('all')} /> All pages</label>
        <label style={{ fontSize: 11 }}><input type="radio" checked={applyTo === 'current'} onChange={() => setApplyTo('current')} /> Current page</label>
      </div>
      <button style={btn} onClick={crop}>Apply Crop</button>
    </div>
  )
}

// ── Link Editor ──────────────────────────────────────────────────

function LinksSection({ state, tabId, onStatus }: { state: PdfFormatState; tabId: string; onStatus: (s: string) => void }) {
  const [links, setLinks] = useState<{ page: number; url: string; rect: string }[]>([])

  const scan = async () => {
    const doc = await PDFDocument.load(state.pdfBytes)
    const found: { page: number; url: string; rect: string }[] = []
    for (let i = 0; i < doc.getPageCount(); i++) {
      const page = doc.getPage(i)
      const annots = page.node.get(PDFName.of('Annots'))
      if (!annots) continue
      const arr = doc.context.lookup(annots) as any
      if (!arr || !arr.size) continue
      for (let j = 0; j < arr.size(); j++) {
        const annotRef = arr.get(j)
        const annot = doc.context.lookup(annotRef) as PDFDict | undefined
        if (!annot) continue
        const subtype = annot.get(PDFName.of('Subtype'))?.toString()
        if (subtype !== '/Link') continue
        const action = annot.get(PDFName.of('A'))
        if (!action) continue
        const actionDict = doc.context.lookup(action) as PDFDict | undefined
        if (!actionDict) continue
        const uri = actionDict.get(PDFName.of('URI'))
        if (!uri) continue
        const rect = annot.get(PDFName.of('Rect'))
        found.push({
          page: i + 1,
          url: uri.toString().replace(/^\(|\)$/g, ''),
          rect: rect?.toString() ?? ''
        })
      }
    }
    setLinks(found)
    onStatus(`Found ${found.length} hyperlink(s).`)
  }

  const removeAllLinks = async () => {
    const doc = await PDFDocument.load(state.pdfBytes)
    for (let i = 0; i < doc.getPageCount(); i++) {
      const page = doc.getPage(i)
      const annots = page.node.get(PDFName.of('Annots'))
      if (!annots) continue
      const arr = doc.context.lookup(annots) as any
      if (!arr || !arr.size) continue
      // Filter out Link annotations
      const keep: any[] = []
      for (let j = 0; j < arr.size(); j++) {
        const annotRef = arr.get(j)
        const annot = doc.context.lookup(annotRef) as PDFDict | undefined
        if (!annot) { keep.push(annotRef); continue }
        const subtype = annot.get(PDFName.of('Subtype'))?.toString()
        if (subtype !== '/Link') keep.push(annotRef)
      }
      if (keep.length === 0) {
        page.node.delete(PDFName.of('Annots'))
      } else {
        page.node.set(PDFName.of('Annots'), doc.context.obj(keep))
      }
    }
    const out = new Uint8Array(await doc.save())
    useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({ ...prev, pdfBytes: out }))
    useTabStore.getState().setTabDirty(tabId, true)
    onStatus('All hyperlinks removed.')
    setLinks([])
  }

  return (
    <div data-testid="section-links">
      <h4 style={{ marginTop: 0, fontSize: 13 }}>Hyperlinks</h4>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>Scan and manage hyperlinks in the PDF.</div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <button style={btn} onClick={scan}>Scan Links</button>
        {links.length > 0 && <button style={{ ...btn, color: 'var(--danger)' }} onClick={removeAllLinks}>Remove All Links</button>}
      </div>
      {links.length > 0 && (
        <div style={{ maxHeight: 200, overflow: 'auto' }}>
          {links.map((l, i) => (
            <div key={i} style={{ padding: '3px 0', borderBottom: '1px solid var(--border)', fontSize: 11 }}>
              <span style={{ color: 'var(--text-muted)' }}>p{l.page}</span>{' '}
              <span style={{ color: 'var(--accent)', wordBreak: 'break-all' }}>{l.url}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Redaction Verification ───────────────────────────────────────

function RedactVerifySection({ state, onStatus }: { state: PdfFormatState; onStatus: (s: string) => void }) {
  const [result, setResult] = useState<{ safe: boolean; issues: string[] } | null>(null)

  const verify = async () => {
    const issues: string[] = []
    const doc = await PDFDocument.load(state.pdfBytes)

    // Check 1: Hidden text under black rectangles
    // We can't easily detect visual redactions, but we can check
    // if text content exists that might be hidden

    // Check 2: Metadata that might contain sensitive info
    if (doc.getTitle()?.trim()) issues.push('Document title is set — may contain sensitive info')
    if (doc.getAuthor()?.trim()) issues.push('Author field is set')

    // Check 3: XMP metadata
    if (doc.catalog.get(PDFName.of('Metadata'))) {
      issues.push('XMP metadata stream present — may contain edit history')
    }

    // Check 4: Embedded JavaScript
    if (doc.catalog.get(PDFName.of('OpenAction'))) {
      issues.push('OpenAction present — could contain executable code')
    }
    const names = doc.catalog.get(PDFName.of('Names'))
    if (names) {
      const namesDict = doc.context.lookup(names) as PDFDict | undefined
      if (namesDict?.get(PDFName.of('JavaScript'))) {
        issues.push('Embedded JavaScript found')
      }
      if (namesDict?.get(PDFName.of('EmbeddedFiles'))) {
        issues.push('Embedded file attachments found')
      }
    }

    // Check 5: Annotations that might contain hidden content
    let annotCount = 0
    for (let i = 0; i < doc.getPageCount(); i++) {
      const annots = doc.getPage(i).node.get(PDFName.of('Annots'))
      if (annots) {
        const arr = doc.context.lookup(annots) as any
        if (arr?.size) annotCount += arr.size()
      }
    }
    if (annotCount > 0) issues.push(`${annotCount} annotation(s) present — may contain comments or markup`)

    // Check 6: Form fields
    if (doc.catalog.get(PDFName.of('AcroForm'))) {
      issues.push('Interactive form fields present — may contain submitted data')
    }

    // Check 7: Text extraction to detect hidden text
    const extracted = await extractText(state.pdfBytes)
    const totalChars = extracted.reduce((s, p) => s + p.items.reduce((s2, it) => s2 + it.str.length, 0), 0)
    if (totalChars > 0) {
      issues.push(`${totalChars} characters of extractable text remain — redacted text should be unextractable`)
    }

    const safe = issues.length === 0
    setResult({ safe, issues })
    onStatus(safe ? 'Redaction verification passed — no hidden data found.' : `Found ${issues.length} potential issue(s).`)
  }

  return (
    <div data-testid="section-redact-verify">
      <h4 style={{ marginTop: 0, fontSize: 13 }}>Redaction Verification</h4>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>Check if the PDF has been properly redacted and no hidden data remains.</div>
      <button style={btn} onClick={verify}>Verify Redaction</button>

      {result && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: result.safe ? 'var(--success)' : 'var(--danger)', marginBottom: 6 }}>
            {result.safe ? 'Clean — no hidden data detected' : `${result.issues.length} issue(s) found`}
          </div>
          {result.issues.map((issue, i) => (
            <div key={i} style={{ padding: '3px 0', fontSize: 11, borderBottom: '1px solid var(--border)' }}>
              <span style={{ color: 'var(--danger)' }}>!</span> {issue}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
