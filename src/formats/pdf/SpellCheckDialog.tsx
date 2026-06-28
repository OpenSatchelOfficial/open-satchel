import { useEffect, useState } from 'react'
import { useFormatStore } from '../../stores/formatStore'
import { useUIStore } from '../../stores/uiStore'
import type { PdfFormatState } from './index'
import { spellCheckPages, type TypoFlag } from '../../services/pdfTextOps'

interface Props {
  tabId: string
  onClose: () => void
}

/** Heuristic spell check of fabric text objects (overlay annotations +
 *  sticky notes). Uses pdfTextOps.spellCheckPages which flags words
 *  with unusual bigrams, missing vowels, repeated letters, etc. No
 *  dictionary dep — conservative but dep-free. Clicking a flagged word
 *  jumps the viewer to that page. */
export default function SpellCheckDialog({ tabId, onClose }: Props) {
  const state = useFormatStore((s) => s.data[tabId] as PdfFormatState | undefined)
  const setCurrentPage = useUIStore((s) => s.setCurrentPage)
  const [flags, setFlags] = useState<TypoFlag[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!state) return
    setLoading(true)
    // Synchronous service but wrap in timeout to unblock the dialog paint.
    const handle = setTimeout(() => {
      setFlags(spellCheckPages(state.pages))
      setLoading(false)
    }, 30)
    return () => clearTimeout(handle)
  }, [state?.pages])

  if (!state) return null

  const jumpTo = (pageIndex: number) => {
    const visible = state.pages.filter((p) => !p.deleted)
    const displayIdx = visible.findIndex((p) => p.pageIndex === pageIndex)
    if (displayIdx >= 0) {
      setCurrentPage(displayIdx)
      const el = document.querySelector(`[data-page-display-index="${displayIdx}"]`) as HTMLElement | null
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }

  // Group by page for readability
  const byPage = new Map<number, TypoFlag[]>()
  for (const f of flags) {
    const arr = byPage.get(f.pageIndex) ?? []
    arr.push(f)
    byPage.set(f.pageIndex, arr)
  }

  return (
    <div
      data-testid="spell-check-dialog"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: 'var(--bg-primary)', borderRadius: 8, padding: 20,
        border: '1px solid var(--border)', width: 440, maxHeight: '80vh',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>Spell Check</h3>
          <button onClick={onClose} style={{ background:'transparent', border:'none', color:'var(--text-primary)', cursor:'pointer', fontSize:18 }}>✕</button>
        </div>

        <p style={{ margin: '0 0 10px 0', fontSize: 10, color: 'var(--text-secondary)' }}>
          Heuristic scan of overlay text (Add Text boxes, sticky notes, watermarks).
          Dictionary-free - flags suspicious bigrams + consonant runs. False positives expected.
        </p>

        <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
          {loading ? (
            <div style={{ padding: 12, fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>Scanning…</div>
          ) : flags.length === 0 ? (
            <div style={{ padding: 16, fontSize: 12, color: 'var(--success)', textAlign: 'center' }}>
              No suspicious words flagged.
            </div>
          ) : (
            <>
              <div data-testid="spell-summary" style={{ padding: 6, fontSize: 11, color: 'var(--text-secondary)' }}>
                {flags.length} suspicious word{flags.length === 1 ? '' : 's'} across {byPage.size} page{byPage.size === 1 ? '' : 's'}.
              </div>
              {[...byPage.entries()].sort(([a], [b]) => a - b).map(([pageIdx, pageFlags]) => (
                <div key={pageIdx} style={{ marginBottom: 10 }}>
                  <div style={{
                    fontSize: 10, color: 'var(--text-muted)', fontWeight: 600,
                    textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4,
                  }}>Page {pageIdx + 1}</div>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {pageFlags.map((f, i) => (
                      <button
                        key={i}
                        data-testid={`typo-${pageIdx}-${i}`}
                        onClick={() => { jumpTo(pageIdx); onClose() }}
                        style={{
                          padding: '3px 8px', fontSize: 11, borderRadius: 3,
                          background: 'rgba(243, 139, 168, 0.15)',
                          color: 'var(--text-primary)',
                          border: '1px solid rgba(243, 139, 168, 0.35)',
                          cursor: 'pointer', fontFamily: 'monospace',
                        }}>
                        {f.word}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
          <button onClick={onClose} style={{
            padding: '6px 16px', background: 'var(--bg-surface)', color: 'var(--text-primary)',
            border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer', fontSize: 12,
          }}>Close</button>
        </div>
      </div>
    </div>
  )
}
