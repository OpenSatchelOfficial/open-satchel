// Unified batch operations dialog: PDF Print, PDF Rename, File Collect,
// batch conversion. Accepts a file-picker selection, runs the chosen
// op over each file, and either downloads results or opens Print.

import { useState } from 'react'
import { compressPdf } from '../../services/pdfOps'
import { pdfToText, toImageOnlyPdf } from '../../services/pdfConvert'
import { runOcr, buildSearchablePdf } from '../../services/pdfOcr'
import { convertPdfHighFidelity, detectLibreOffice } from '../../services/pdfToOffice'

type Mode = 'print' | 'rename' | 'collect' | 'convert' | 'ocr'

interface Props {
  mode: Mode
  onClose: () => void
}

async function download(_name: string, bytes: Uint8Array, _mime = 'application/octet-stream') {
  await window.api.file.saveAs(bytes)
}

const title: Record<Mode, string> = {
  print: 'Batch PDF Printing',
  rename: 'Batch Rename Files',
  collect: 'File Collect',
  convert: 'Batch Convert',
  ocr: 'Batch OCR (Make Searchable)',
}

export default function BatchDialog({ mode, onClose }: Props) {
  const [files, setFiles] = useState<File[]>([])
  const [pattern, setPattern] = useState('{name}-{n}')
  const [prefix, setPrefix] = useState('')
  const [target, setTarget] = useState<'word' | 'ppt' | 'excel' | 'txt' | 'imgonly' | 'compress'>('compress')
  const [ocrLang, setOcrLang] = useState('eng')
  const [ocrAutoRotate, setOcrAutoRotate] = useState(true)
  const [ocrDeskew, setOcrDeskew] = useState(true)
  const [ocrAutoLang, setOcrAutoLang] = useState(false)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [ocrProgress, setOcrProgress] = useState({ file: 0, pct: 0, text: '' })

  const pick = () => {
    const input = document.createElement('input')
    input.type = 'file'; input.accept = 'application/pdf'; input.multiple = true
    input.onchange = () => { setFiles(input.files ? Array.from(input.files) : []) }
    input.click()
  }

  const pickFolder = async () => {
    if (!window.api?.folder?.pick) { setStatus('Folder pick requires Electron.'); return }
    const result = await window.api.folder.pick(['.pdf'])
    if (!result || result.length === 0) { setStatus('No PDF files found in folder.'); return }
    // Convert IPC results to File-like objects for the existing pipeline
    const fileList = result.map(f => new File([f.bytes], f.name, { type: 'application/pdf' }))
    setFiles(fileList)
    setStatus(`Found ${fileList.length} PDF(s) in folder.`)
  }

  const runPrint = async () => {
    setBusy(true)
    for (const f of files) {
      const bytes = new Uint8Array(await f.arrayBuffer())
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const blob = new Blob([bytes as any], { type: 'application/pdf' })
      const url = URL.createObjectURL(blob)
      const w = window.open(url, '_blank')
      if (w) setTimeout(() => { try { w.print() } catch {} }, 800)
    }
    setStatus(`Opened ${files.length} file(s) for printing.`)
    setBusy(false)
  }

  const runRename = async () => {
    setBusy(true)
    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      const name = pattern.replace('{name}', f.name.replace(/\.pdf$/i, '')).replace('{n}', String(i + 1).padStart(3, '0')).replace('{prefix}', prefix) + '.pdf'
      const buf = await f.arrayBuffer()
      await download(name, new Uint8Array(buf), 'application/pdf')
    }
    setStatus(`Renamed & downloaded ${files.length} file(s).`)
    setBusy(false)
  }

  const runCollect = async () => {
    setBusy(true)
    // "Collect" = zip-less grouping — just re-download each file with a common prefix
    for (let i = 0; i < files.length; i++) {
      const bytes = new Uint8Array(await files[i].arrayBuffer())
      await download(`${prefix || 'collected'}-${String(i + 1).padStart(3, '0')}.pdf`, bytes, 'application/pdf')
    }
    setStatus(`Collected ${files.length} file(s) into prefix "${prefix || 'collected'}".`)
    setBusy(false)
  }

  const runConvert = async () => {
    setBusy(true)
    const lo = await detectLibreOffice()
    let engineNote = ''
    for (let i = 0; i < files.length; i++) {
      const bytes = new Uint8Array(await files[i].arrayBuffer())
      const base = files[i].name.replace(/\.pdf$/i, '')
      try {
        if (target === 'compress') await download(`${base}-compressed.pdf`, await compressPdf(bytes), 'application/pdf')
        else if (target === 'word') {
          const r = await convertPdfHighFidelity(bytes, 'docx')
          engineNote = r.engine === 'libreoffice' ? ' (via LibreOffice)' : ' (built-in)'
          await download(`${base}.docx`, r.bytes, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
        }
        else if (target === 'ppt') {
          const r = await convertPdfHighFidelity(bytes, 'pptx')
          engineNote = r.engine === 'libreoffice' ? ' (via LibreOffice)' : ' (built-in)'
          await download(`${base}.pptx`, r.bytes, 'application/vnd.openxmlformats-officedocument.presentationml.presentation')
        }
        else if (target === 'excel') {
          const r = await convertPdfHighFidelity(bytes, 'xlsx')
          engineNote = r.engine === 'libreoffice' ? ' (via LibreOffice)' : ' (built-in)'
          await download(`${base}.xlsx`, r.bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        }
        else if (target === 'txt') { const t = await pdfToText(bytes); await download(`${base}.txt`, new Uint8Array(new TextEncoder().encode(t)), 'text/plain') }
        else if (target === 'imgonly') await download(`${base}-image-only.pdf`, await toImageOnlyPdf(bytes), 'application/pdf')
      } catch (e) { setStatus(`Failed on ${files[i].name}: ${(e as Error).message}`) }
    }
    const loStatus = lo.available ? `LibreOffice detected${lo.version ? ` (${lo.version.split('\n')[0]})` : ''}.` : 'LibreOffice not installed - used built-in converter.'
    setStatus(`Converted ${files.length} file(s) → ${target}${engineNote}. ${loStatus}`)
    setBusy(false)
  }

  const runOcrBatch = async () => {
    setBusy(true)
    setOcrProgress({ file: 0, pct: 0, text: 'Starting…' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pdfjs = await import('pdfjs-dist') as any
    let ok = 0
    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      const bytes = new Uint8Array(await f.arrayBuffer())
      setOcrProgress({ file: i, pct: 0, text: `Loading ${f.name}…` })
      try {
        const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise
        const n = doc.numPages
        doc.destroy()
        const res = await runOcr(bytes, Array.from({ length: n }, (_, k) => k), 0, {
          language: ocrLang, scope: 'all', dpi: 300, outputMode: 'searchable',
          autoRotate: ocrAutoRotate, deskew: ocrDeskew, autoDetectLanguage: ocrAutoLang, suspectThreshold: 70,
        }, (p) => setOcrProgress({ file: i, pct: Math.round(p.pct * 100), text: `[${i + 1}/${files.length}] ${p.statusText}` }))
        const searchable = await buildSearchablePdf(bytes, res.ocrPageData)
        const base = f.name.replace(/\.pdf$/i, '')
        await download(`${base}-searchable.pdf`, searchable, 'application/pdf')
        ok++
      } catch (e) {
        setStatus(`Failed on ${f.name}: ${(e as Error).message}`)
      }
    }
    setOcrProgress({ file: files.length, pct: 100, text: 'Done.' })
    setStatus(`OCR complete: ${ok} of ${files.length} file(s) saved as *-searchable.pdf.`)
    setBusy(false)
  }

  const run = () => {
    if (files.length === 0) { setStatus('Pick files first.'); return }
    if (mode === 'print') return runPrint()
    if (mode === 'rename') return runRename()
    if (mode === 'collect') return runCollect()
    if (mode === 'convert') return runConvert()
    if (mode === 'ocr') return runOcrBatch()
  }

  return (
    <div data-testid={`batch-${mode}`} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.6)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000 }}
         onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ background:'var(--bg-primary)', borderRadius:8, padding:16, minWidth:460, border:'1px solid var(--border)' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom: 14 }}>
          <h3 style={{ margin: 0, fontSize: 14 }}>{title[mode]}</h3>
          <button onClick={onClose} style={{ fontSize: 18, background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>✕</button>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button data-testid="batch-pick" onClick={pick} style={{ padding: '6px 12px', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
            Pick PDFs… ({files.length} selected)
          </button>
          <button data-testid="batch-pick-folder" onClick={pickFolder} style={{ padding: '6px 12px', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
            Pick Folder…
          </button>
        </div>
        {mode === 'rename' && (
          <div style={{ marginTop: 10 }}>
            <label style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Pattern (use {'{name}'}, {'{n}'}, {'{prefix}'})</label>
            <input data-testid="batch-pattern" value={pattern} onChange={(e) => setPattern(e.target.value)} style={{ width: '100%', padding: 6, background:'var(--bg-surface)', color:'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 3 }} />
            <label style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 6, display: 'block' }}>Prefix</label>
            <input data-testid="batch-prefix" value={prefix} onChange={(e) => setPrefix(e.target.value)} style={{ width: '100%', padding: 6, background:'var(--bg-surface)', color:'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 3 }} />
          </div>
        )}
        {mode === 'collect' && (
          <div style={{ marginTop: 10 }}>
            <label style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Output prefix</label>
            <input data-testid="batch-collect-prefix" value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="collected" style={{ width: '100%', padding: 6, background:'var(--bg-surface)', color:'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 3 }} />
          </div>
        )}
        {mode === 'convert' && (
          <div style={{ marginTop: 10 }}>
            <label style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Target format</label>
            <select data-testid="batch-target" value={target} onChange={(e) => setTarget(e.target.value as 'compress')} style={{ width: '100%', padding: 6, background:'var(--bg-surface)', color:'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 3 }}>
              <option value="compress">Compress (PDF)</option>
              <option value="word">PDF → Word (.docx)</option>
              <option value="ppt">PDF → PowerPoint (.pptx)</option>
              <option value="excel">PDF → Excel (.xlsx)</option>
              <option value="txt">PDF → TXT</option>
              <option value="imgonly">To Image-only PDF</option>
            </select>
          </div>
        )}
        {mode === 'ocr' && (
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div>
              <label style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Language</label>
              <select value={ocrLang} onChange={(e) => setOcrLang(e.target.value)} disabled={busy || ocrAutoLang}
                style={{ width: '100%', padding: 6, background: 'var(--bg-surface)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 3 }}>
                <option value="eng">English</option>
                <option value="fra">French</option>
                <option value="deu">German</option>
                <option value="spa">Spanish</option>
                <option value="ita">Italian</option>
                <option value="rus">Russian</option>
                <option value="chi_sim">Chinese (Simplified)</option>
                <option value="chi_tra">Chinese (Traditional)</option>
                <option value="jpn">Japanese</option>
                <option value="kor">Korean</option>
                <option value="ara">Arabic</option>
              </select>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-primary)' }}>
              <input type="checkbox" checked={ocrAutoLang} onChange={(e) => setOcrAutoLang(e.target.checked)} disabled={busy} />
              Auto-detect language per file (OSD script)
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-primary)' }}>
              <input type="checkbox" checked={ocrAutoRotate} onChange={(e) => setOcrAutoRotate(e.target.checked)} disabled={busy} />
              Auto-rotate (fix 90/180/270°)
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-primary)' }}>
              <input type="checkbox" checked={ocrDeskew} onChange={(e) => setOcrDeskew(e.target.checked)} disabled={busy} />
              Deskew (±5°)
            </label>
            {busy && (
              <div>
                <div style={{ height: 5, borderRadius: 3, background: 'var(--bg-surface)', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${ocrProgress.pct}%`, background: 'var(--accent)' }} />
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3 }}>{ocrProgress.text}</div>
              </div>
            )}
          </div>
        )}
        <div style={{ display:'flex', gap:8, marginTop: 14 }}>
          <button data-testid="batch-run" onClick={run} disabled={busy || files.length === 0} style={{ padding: '6px 12px', background: 'var(--accent)', color: 'var(--bg-primary)', border: 'none', borderRadius: 4, cursor: busy ? 'wait' : 'pointer' }}>
            {busy ? 'Working…' : 'Run'}
          </button>
        </div>
        {status && <div data-testid="batch-status" style={{ marginTop: 10, fontSize: 11, color: 'var(--text-secondary)' }}>{status}</div>}
      </div>
    </div>
  )
}
