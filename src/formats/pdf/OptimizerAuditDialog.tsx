// PDF Optimizer Audit — shows where the bytes are spent, Acrobat-style.
//
// Enumerates indirect objects by type+filter and charts the totals.
// No writes — purely a report. For actual compression use the existing
// PDF Compressor in Tools > Advanced.

import { useEffect, useState } from 'react'
import { useFormatStore } from '../../stores/formatStore'
import type { PdfFormatState } from './index'
import { auditSpaceUsage, type SpaceAudit } from '../../services/pdfMisc'

interface Props { tabId: string; onClose: () => void }

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export default function OptimizerAuditDialog({ tabId, onClose }: Props) {
  const state = useFormatStore((s) => s.data[tabId] as PdfFormatState | undefined)
  const [audit, setAudit] = useState<SpaceAudit | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!state) return
    auditSpaceUsage(state.pdfBytes).then((a) => { setAudit(a); setLoading(false) })
  }, [state?.pdfBytes])

  return (
    <div data-testid="optimizer-audit-dialog" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
         onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ background: 'var(--bg-primary)', borderRadius: 8, padding: 20, minWidth: 520, maxWidth: 720, maxHeight: '80vh', overflow: 'auto', border: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>Audit Space Usage</h3>
          <button data-testid="oa-close" onClick={onClose} style={{ fontSize: 18, background: 'transparent', border: 'none', color: 'var(--text-primary)', cursor: 'pointer' }}>✕</button>
        </div>

        {loading ? (
          <div style={{ padding: 20, fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>Analyzing indirect objects…</div>
        ) : audit ? (
          <>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>
              Total file size: <strong style={{ color: 'var(--text-primary)' }}>{formatBytes(audit.totalBytes)}</strong> ·
              Indirect-stream bytes: <strong style={{ color: 'var(--text-primary)' }}>{formatBytes(audit.totalIndirectBytes)}</strong>
              ({Math.round((audit.totalIndirectBytes / audit.totalBytes) * 100)}%).
              The rest is xref + trailer + catalog + non-stream dicts.
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <th style={th}>Category</th>
                  <th style={th}>Filter</th>
                  <th style={{ ...th, textAlign: 'right' }}>Count</th>
                  <th style={{ ...th, textAlign: 'right' }}>Total</th>
                  <th style={{ ...th, textAlign: 'right' }}>%</th>
                  <th style={th}>Bar</th>
                </tr>
              </thead>
              <tbody>
                {audit.buckets.map((b, i) => {
                  const pct = audit.totalIndirectBytes === 0
                    ? 0
                    : (b.totalBytes / audit.totalIndirectBytes) * 100
                  return (
                    <tr key={i} style={{ borderBottom: '1px solid var(--bg-surface)' }}>
                      <td style={td}>{b.label}</td>
                      <td style={{ ...td, color: 'var(--text-muted)' }}>{b.filter}</td>
                      <td style={{ ...td, textAlign: 'right' }}>{b.count}</td>
                      <td style={{ ...td, textAlign: 'right', fontWeight: 600 }}>{formatBytes(b.totalBytes)}</td>
                      <td style={{ ...td, textAlign: 'right' }}>{pct.toFixed(1)}%</td>
                      <td style={{ ...td, paddingLeft: 10 }}>
                        <div style={{ height: 6, width: 120, background: 'var(--bg-surface)', borderRadius: 3 }}>
                          <div style={{ height: '100%', width: `${Math.max(1, pct)}%`, background: 'var(--accent)', borderRadius: 3 }} />
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </>
        ) : null}
      </div>
    </div>
  )
}

const th: React.CSSProperties = { padding: '6px 8px', textAlign: 'left', fontWeight: 600, color: 'var(--text-secondary)', fontSize: 10, textTransform: 'uppercase' }
const td: React.CSSProperties = { padding: '6px 8px', color: 'var(--text-primary)' }
