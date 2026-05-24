// Side-by-side visual PDF compare viewer. Picks a second PDF from the
// file system, rasterizes both, shows them next to each other with
// text-level diff segments rendered above the right page (insertions
// green, deletions red). Pairs with the pdfCompare service.

import { useEffect, useMemo, useState } from 'react'
import { comparePdfs, type ComparePdfsResult } from '../../services/pdfCompare'
import { pdfToImages } from '../../services/pdfOps'

interface Props {
  leftBytes: Uint8Array
  onClose: () => void
}

export default function VisualCompareDialog({ leftBytes, onClose }: Props) {
  const [rightBytes, setRightBytes] = useState<Uint8Array | null>(null)
  const [leftPngs, setLeftPngs] = useState<Uint8Array[]>([])
  const [rightPngs, setRightPngs] = useState<Uint8Array[]>([])
  const [diff, setDiff] = useState<ComparePdfsResult | null>(null)
  const [activePage, setActivePage] = useState(0)

  const pickFile = () => {
    const input = document.createElement('input')
    input.type = 'file'; input.accept = 'application/pdf'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      setRightBytes(new Uint8Array(await file.arrayBuffer()))
    }
    input.click()
  }

  useEffect(() => {
    if (!rightBytes) return
    (async () => {
      const [lp, rp, d] = await Promise.all([
        pdfToImages(leftBytes, { scale: 1.2 }),
        pdfToImages(rightBytes, { scale: 1.2 }),
        comparePdfs(leftBytes, rightBytes),
      ])
      setLeftPngs(lp); setRightPngs(rp); setDiff(d)
    })()
  }, [leftBytes, rightBytes])

  const leftUrl = useMemo(() => leftPngs[activePage] ? URL.createObjectURL(new Blob([leftPngs[activePage] as unknown as BlobPart], { type: 'image/png' })) : null, [leftPngs, activePage])
  const rightUrl = useMemo(() => rightPngs[activePage] ? URL.createObjectURL(new Blob([rightPngs[activePage] as unknown as BlobPart], { type: 'image/png' })) : null, [rightPngs, activePage])
  useEffect(() => () => { if (leftUrl) URL.revokeObjectURL(leftUrl); if (rightUrl) URL.revokeObjectURL(rightUrl) }, [leftUrl, rightUrl])

  const pageDiff = diff?.pages[activePage]
  const pageCount = Math.max(leftPngs.length, rightPngs.length)

  return (
    <div data-testid="visual-compare" style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100,
    }} onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ background: 'var(--bg-primary)', borderRadius: 8, width: '92vw', height: '92vh', display: 'flex', flexDirection: 'column', border: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 16px', borderBottom: '1px solid var(--border)' }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>Compare — side by side</h3>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            {!rightBytes && <button data-testid="vc-pick" onClick={pickFile} style={{ padding: '6px 12px', background: 'var(--accent)', color: 'var(--bg-primary)', border: 'none', borderRadius: 4, cursor: 'pointer' }}>Pick second PDF…</button>}
            {diff && (
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                Similarity: <strong>{(diff.summary.similarity * 100).toFixed(1)}%</strong> · +{diff.summary.inserted} / −{diff.summary.deleted}
              </span>
            )}
            <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 18 }}>✕</button>
          </div>
        </div>
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          {pageCount > 1 && (
            <nav data-testid="vc-pages" style={{ width: 80, borderRight: '1px solid var(--border)', overflowY: 'auto', padding: 6 }}>
              {Array.from({ length: pageCount }).map((_, i) => (
                <button key={i}
                  onClick={() => setActivePage(i)}
                  style={{
                    display: 'block', width: '100%', padding: '6px 8px', marginBottom: 3, fontSize: 11, cursor: 'pointer',
                    background: activePage === i ? 'var(--accent)' : 'var(--bg-surface)',
                    color: activePage === i ? 'var(--bg-primary)' : 'var(--text-primary)',
                    border: 'none', borderRadius: 3, textAlign: 'left',
                  }}
                >Page {i + 1}</button>
              ))}
            </nav>
          )}
          <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
            <div style={{ flex: 1, overflow: 'auto', background: 'var(--bg-secondary)', borderRight: '1px solid var(--border)' }}>
              {leftUrl && <img data-testid="vc-left" src={leftUrl} style={{ width: '100%', display: 'block' }} />}
            </div>
            <div style={{ flex: 1, overflow: 'auto', background: 'var(--bg-secondary)', position: 'relative' }}>
              {rightUrl && <img data-testid="vc-right" src={rightUrl} style={{ width: '100%', display: 'block' }} />}
            </div>
            {pageDiff && (
              <aside data-testid="vc-diff" style={{ width: 280, borderLeft: '1px solid var(--border)', overflow: 'auto', padding: 8, fontSize: 11, fontFamily: 'monospace' }}>
                <div style={{ marginBottom: 6, color: 'var(--text-secondary)' }}>Page {activePage + 1} · {(pageDiff.similarity * 100).toFixed(1)}% similar</div>
                {pageDiff.segments.map((s, i) => (
                  <div key={i} style={{
                    padding: '2px 4px', marginBottom: 1,
                    background: s.op === 'insert' ? 'rgba(166,227,161,0.25)' : s.op === 'delete' ? 'rgba(243,139,168,0.25)' : 'transparent',
                    color: s.op === 'insert' ? 'var(--success)' : s.op === 'delete' ? 'var(--danger)' : 'var(--text-primary)',
                    textDecoration: s.op === 'delete' ? 'line-through' : 'none',
                    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  }}>
                    {s.op === 'insert' ? '+ ' : s.op === 'delete' ? '− ' : '  '}{s.text}
                  </div>
                ))}
              </aside>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
