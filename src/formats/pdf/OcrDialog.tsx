import { useState, useRef, useCallback } from 'react'
import { useFormatStore } from '../../stores/formatStore'
import { useUIStore } from '../../stores/uiStore'
import type { PdfFormatState } from './index'
import { runOcr, applyOcrResult, type OcrOptions, type OcrResult, type OcrSuspect } from '../../services/pdfOcr'

interface Props {
  tabId: string
  onClose: () => void
}

type OcrLanguage = { code: string; label: string }

const LANGUAGES: OcrLanguage[] = [
  { code: 'eng', label: 'English' },
  { code: 'fra', label: 'French' },
  { code: 'deu', label: 'German' },
  { code: 'spa', label: 'Spanish' },
  { code: 'ita', label: 'Italian' },
  { code: 'por', label: 'Portuguese' },
  { code: 'nld', label: 'Dutch' },
  { code: 'pol', label: 'Polish' },
  { code: 'rus', label: 'Russian' },
  { code: 'chi_sim', label: 'Chinese (Simplified)' },
  { code: 'chi_tra', label: 'Chinese (Traditional)' },
  { code: 'jpn', label: 'Japanese' },
  { code: 'kor', label: 'Korean' },
  { code: 'ara', label: 'Arabic' },
]

export default function OcrDialog({ tabId, onClose }: Props) {
  const [language, setLanguage] = useState('eng')
  const [scope, setScope] = useState<OcrOptions['scope']>('current')
  const [dpi, setDpi] = useState<OcrOptions['dpi']>(300)
  const [outputMode, setOutputMode] = useState<OcrOptions['outputMode']>('clipboard')
  const [autoRotate, setAutoRotate] = useState(true)
  const [deskew, setDeskew] = useState(true)
  const [autoDetectLanguage, setAutoDetectLanguage] = useState(false)
  const [suspectThreshold, setSuspectThreshold] = useState(70)
  const [progress, setProgress] = useState(0)
  const [statusText, setStatusText] = useState('')
  const [running, setRunning] = useState(false)
  const [ocrResult, setOcrResult] = useState<OcrResult | null>(null)
  const [showSuspects, setShowSuspects] = useState(false)
  const cancelRef = useRef({ cancelled: false })

  const labelStyle: React.CSSProperties = {
    fontSize: 11, color: 'var(--text-secondary)', display: 'block', marginBottom: 4
  }
  const radioLabelStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 6, fontSize: 12,
    color: 'var(--text-primary)', cursor: 'pointer'
  }

  const handleStart = useCallback(async () => {
    cancelRef.current.cancelled = false
    setRunning(true)
    setProgress(0)
    setStatusText('Initializing…')
    setOcrResult(null)
    try {
      const state = useFormatStore.getState().getFormatState<PdfFormatState>(tabId)
      if (!state) throw new Error('No PDF state')
      const currentPage = useUIStore.getState().currentPage
      const visible = state.pages.filter((p) => !p.deleted).map((p) => p.pageIndex)
      const result = await runOcr(
        state.pdfBytes,
        visible,
        currentPage,
        { language, scope, dpi, outputMode, autoRotate, deskew, autoDetectLanguage, suspectThreshold },
        (p) => { setProgress(Math.round(p.pct * 100)); setStatusText(p.statusText) },
        cancelRef.current,
      )
      if (cancelRef.current.cancelled) { setRunning(false); setStatusText('Cancelled.'); return }
      setOcrResult(result)
      setProgress(100)
      const suspectNote = result.suspects.length > 0 ? `  ${result.suspects.length} suspects flagged.` : ''
      const langNote = result.detectedLanguage ? `  Detected: ${result.detectedLanguage}.` : ''
      await applyOcrResult(tabId, state.pdfBytes, result, outputMode)
      if (outputMode === 'clipboard') setStatusText('Text copied to clipboard.' + suspectNote + langNote)
      else if (outputMode === 'newtab') setStatusText('Text opened in new tab.' + suspectNote + langNote)
      else setStatusText(`Searchable PDF built (${result.ocrPageData.reduce((s, p) => s + p.words.length, 0)} words).` + suspectNote + langNote)
    } catch (err) {
      if (!cancelRef.current.cancelled) setStatusText(`Error: ${(err as Error).message}`)
    } finally {
      setRunning(false)
    }
  }, [tabId, language, scope, dpi, outputMode, autoRotate, deskew, autoDetectLanguage, suspectThreshold])

  const handleCancel = () => {
    if (running) {
      cancelRef.current.cancelled = true
      setStatusText('Cancelling…')
    } else {
      onClose()
    }
  }

  if (showSuspects && ocrResult) {
    return (
      <OcrSuspectsReview
        suspects={ocrResult.suspects}
        rasterizedPages={ocrResult.rasterizedPages}
        onClose={() => setShowSuspects(false)}
      />
    )
  }

  return (
    <div
      data-testid="ocr-dialog"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
      }}>
      <div style={{
        background: 'var(--bg-primary)', borderRadius: 8, padding: 24,
        border: '1px solid var(--border)', minWidth: 460, maxWidth: 540
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>OCR — Text Recognition</h3>
          <button onClick={onClose} style={{ fontSize: 18, background: 'transparent', border: 'none', color: 'var(--text-primary)', cursor: 'pointer' }}>
            &#x2715;
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label style={labelStyle}>Language</label>
            <select value={language} onChange={(e) => setLanguage(e.target.value)}
              disabled={running || autoDetectLanguage}
              style={{ width: '100%', padding: '6px 8px', fontSize: 12 }}>
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>{l.label} ({l.code})</option>
              ))}
            </select>
            <label style={{ ...radioLabelStyle, marginTop: 4 }}>
              <input type="checkbox" checked={autoDetectLanguage} onChange={(e) => setAutoDetectLanguage(e.target.checked)} disabled={running} />
              Auto-detect (OSD script)
            </label>
          </div>

          <div>
            <label style={labelStyle}>Scope</label>
            <div style={{ display: 'flex', gap: 16 }}>
              <label style={radioLabelStyle}>
                <input type="radio" name="ocr-scope" checked={scope === 'current'}
                  onChange={() => setScope('current')} disabled={running} />
                Current page
              </label>
              <label style={radioLabelStyle}>
                <input type="radio" name="ocr-scope" checked={scope === 'all'}
                  onChange={() => setScope('all')} disabled={running} />
                All pages
              </label>
            </div>
          </div>

          <div>
            <label style={labelStyle}>Pre-processing</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={radioLabelStyle}>
                <input type="checkbox" checked={autoRotate} onChange={(e) => setAutoRotate(e.target.checked)} disabled={running} />
                Auto-rotate (OSD, corrects 90/180/270°)
              </label>
              <label style={radioLabelStyle}>
                <input type="checkbox" checked={deskew} onChange={(e) => setDeskew(e.target.checked)} disabled={running} />
                Deskew (projection-variance, ±5°)
              </label>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>DPI</label>
              <select value={dpi} onChange={(e) => setDpi(Number(e.target.value) as OcrOptions['dpi'])}
                disabled={running}
                style={{ width: '100%', padding: '6px 8px', fontSize: 12 }}>
                <option value={150}>150 (Fast)</option>
                <option value={300}>300 (Default)</option>
                <option value={600}>600 (High quality)</option>
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>Suspect threshold</label>
              <input type="number" min={0} max={100} value={suspectThreshold}
                onChange={(e) => setSuspectThreshold(Number(e.target.value))}
                disabled={running}
                title="Words below this confidence (0-100) are flagged for review"
                style={{ width: '100%', padding: '6px 8px', fontSize: 12 }} />
            </div>
          </div>

          <div>
            <label style={labelStyle}>Output</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={radioLabelStyle}>
                <input type="radio" name="ocr-output" checked={outputMode === 'clipboard'}
                  onChange={() => setOutputMode('clipboard')} disabled={running} />
                Extract text to clipboard
              </label>
              <label style={radioLabelStyle}>
                <input type="radio" name="ocr-output" checked={outputMode === 'newtab'}
                  onChange={() => setOutputMode('newtab')} disabled={running} />
                Extract text to new tab
              </label>
              <label style={radioLabelStyle}>
                <input type="radio" name="ocr-output" checked={outputMode === 'searchable'}
                  onChange={() => setOutputMode('searchable')} disabled={running} />
                Make PDF searchable
              </label>
            </div>
          </div>

          {running && (
            <div>
              <div style={{ height: 6, borderRadius: 3, background: 'var(--bg-surface)', overflow: 'hidden' }}>
                <div style={{
                  height: '100%', width: `${progress}%`,
                  background: 'var(--accent)', borderRadius: 3,
                  transition: 'width 0.2s ease'
                }} />
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
                {progress}% — {statusText}
              </div>
            </div>
          )}

          {!running && statusText && (
            <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
              {statusText}
            </div>
          )}

          {ocrResult && ocrResult.suspects.length > 0 && (
            <button onClick={() => setShowSuspects(true)}
              style={{ padding: '6px 10px', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 4, fontSize: 12, cursor: 'pointer', color: 'var(--text-primary)' }}>
              Review {ocrResult.suspects.length} suspect word{ocrResult.suspects.length === 1 ? '' : 's'} →
            </button>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button onClick={handleCancel}
            style={{ padding: '8px 16px', background: 'var(--bg-surface)', borderRadius: 4, border: 'none', color: 'var(--text-primary)', cursor: 'pointer' }}>
            {running ? 'Cancel' : 'Close'}
          </button>
          <button data-testid="ocr-start" onClick={handleStart} disabled={running}
            style={{
              padding: '8px 16px', background: running ? 'var(--bg-surface)' : 'var(--accent)',
              color: 'var(--bg-primary)', borderRadius: 4, fontWeight: 600, border: 'none',
              cursor: running ? 'default' : 'pointer', opacity: running ? 0.5 : 1
            }}>
            {running ? 'Processing…' : 'Start OCR'}
          </button>
        </div>
      </div>
    </div>
  )
}

// -------- Suspects review modal --------

interface SuspectsReviewProps {
  suspects: OcrSuspect[]
  rasterizedPages: OcrResult['rasterizedPages']
  onClose: () => void
}

function OcrSuspectsReview({ suspects, rasterizedPages, onClose }: SuspectsReviewProps) {
  const [idx, setIdx] = useState(0)
  const [corrections, setCorrections] = useState<Record<number, string>>({})
  const s = suspects[idx]
  const page = s ? rasterizedPages.find((p) => p.pageNum === s.pageNum) : null
  const cropPad = 20

  const copyAll = async () => {
    const lines: string[] = []
    for (let i = 0; i < suspects.length; i++) {
      const original = suspects[i].text
      const edited = corrections[i] ?? original
      if (edited !== original) lines.push(`p${suspects[i].pageNum}: "${original}" → "${edited}"`)
    }
    await navigator.clipboard.writeText(lines.join('\n') || 'No corrections.')
  }

  if (!s || !page) {
    return (
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1001 }}>
        <div style={{ background: 'var(--bg-primary)', padding: 20, borderRadius: 8, border: '1px solid var(--border)' }}>
          <p>No suspects to review.</p>
          <button onClick={onClose} style={{ padding: '6px 12px' }}>Close</button>
        </div>
      </div>
    )
  }

  // Crop bbox in rasterized pixel space, extended by cropPad on each side.
  const cx0 = Math.max(0, s.x0 - cropPad)
  const cy0 = Math.max(0, s.y0 - cropPad)
  const cx1 = Math.min(s.pageW, s.x1 + cropPad)
  const cy1 = Math.min(s.pageH, s.y1 + cropPad)
  const cw = cx1 - cx0
  const ch = cy1 - cy0
  const displayW = Math.min(480, cw)
  const displayH = (displayW / cw) * ch

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1001 }}>
      <div style={{ background: 'var(--bg-primary)', padding: 20, borderRadius: 8, border: '1px solid var(--border)', minWidth: 520, maxWidth: 640 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>OCR Suspects — {idx + 1}/{suspects.length}</h3>
          <button onClick={onClose} style={{ fontSize: 18, background: 'transparent', border: 'none', color: 'var(--text-primary)', cursor: 'pointer' }}>✕</button>
        </div>

        <div style={{ width: displayW, height: displayH, overflow: 'hidden', border: '1px solid var(--border)', marginBottom: 10, position: 'relative', background: '#fff' }}>
          <img
            src={page.canvasDataURL}
            alt="page crop"
            style={{
              position: 'absolute',
              left: -cx0 * (displayW / cw),
              top: -cy0 * (displayH / ch),
              width: page.width * (displayW / cw),
              height: page.height * (displayH / ch),
            }}
          />
          <div style={{
            position: 'absolute',
            left: (s.x0 - cx0) * (displayW / cw),
            top: (s.y0 - cy0) * (displayH / ch),
            width: (s.x1 - s.x0) * (displayW / cw),
            height: (s.y1 - s.y0) * (displayH / ch),
            border: '2px solid #f38ba8',
            pointerEvents: 'none',
          }} />
        </div>

        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
          Page {s.pageNum} · confidence {Math.round(s.confidence)}%
        </div>
        <input
          value={corrections[idx] ?? s.text}
          onChange={(e) => setCorrections((m) => ({ ...m, [idx]: e.target.value }))}
          style={{ width: '100%', padding: '6px 8px', fontSize: 14, fontFamily: 'ui-monospace, monospace' }}
        />

        <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
          <button onClick={() => setIdx((i) => Math.max(0, i - 1))} disabled={idx === 0}
            style={{ padding: '6px 12px', fontSize: 12 }}>← Prev</button>
          <button onClick={() => setIdx((i) => Math.min(suspects.length - 1, i + 1))} disabled={idx === suspects.length - 1}
            style={{ padding: '6px 12px', fontSize: 12 }}>Next →</button>
          <div style={{ flex: 1 }} />
          <button onClick={copyAll}
            style={{ padding: '6px 12px', fontSize: 12 }} title="Copy all corrections as text">Copy corrections</button>
          <button onClick={onClose} style={{ padding: '6px 12px', fontSize: 12 }}>Done</button>
        </div>
      </div>
    </div>
  )
}
