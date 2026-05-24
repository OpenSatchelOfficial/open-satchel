import { useEffect, useState } from 'react'
import { useFormatStore } from '../../stores/formatStore'
import type { PdfFormatState } from './index'
import { checkAccessibility, type A11yIssue, type A11yResult } from '../../services/pdfA11yChecker'

interface Props {
  tabId: string
}

/** Sidebar accessibility-issues panel. Lists every issue
 *  checkAccessibility surfaces with severity + remediation hint.
 *  Re-runs on bytes change so post-save scans keep the list in sync.
 *
 *  Procurement value: gov / hospital / regulated buyers running PAC 3
 *  / veraPDF expect a working pre-flight inside the editor; this is
 *  the in-app flow that mirrors what they'll run externally. */
export default function A11yPanel({ tabId }: Props) {
  const state = useFormatStore((s) => s.data[tabId] as PdfFormatState | undefined)
  const [result, setResult] = useState<A11yResult | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!state) return
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const r = await checkAccessibility(state.pdfBytes)
        if (!cancelled) {
          setResult(r)
          setLoading(false)
        }
      } catch {
        if (!cancelled) {
          setResult(null)
          setLoading(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [state?.pdfBytes])

  if (!state) return null

  return (
    <div
      data-testid="a11y-panel"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        padding: 6,
        gap: 4,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
          Accessibility
        </span>
        {result && (
          <span
            data-testid="a11y-score"
            style={{
              fontSize: 10,
              fontFamily: '"JetBrains Mono", monospace',
              color: result.isCompliant ? 'var(--success, #4ade80)' : 'var(--accent)',
              padding: '2px 6px',
              borderRadius: 3,
              background: 'var(--bg-surface)',
            }}
          >
            {result.score}/100 · {result.profile}
          </span>
        )}
      </div>

      {loading && (
        <div
          data-testid="a11y-loading"
          style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic', padding: 12 }}
        >
          Scanning…
        </div>
      )}

      {!loading && result && (
        <>
          <div
            style={{
              fontSize: 10,
              color: 'var(--text-muted)',
              fontFamily: '"JetBrains Mono", monospace',
              padding: '4px 6px',
              background: 'var(--bg-surface)',
              borderRadius: 3,
              marginBottom: 4,
            }}
            data-testid="a11y-stats"
          >
            tagged: {result.stats.isTagged ? 'yes' : 'no'} · figures:{' '}
            {result.stats.figuresWithAlt}/{result.stats.figureCount} alt · headings:{' '}
            {result.stats.headingLevels.length || '—'}
          </div>

          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 3 }}>
            {result.issues.length === 0 ? (
              <div
                style={{
                  padding: 18,
                  textAlign: 'center',
                  fontSize: 11,
                  color: 'var(--success, #4ade80)',
                }}
              >
                ✓ No issues found.
              </div>
            ) : (
              result.issues.map((issue, i) => <IssueRow key={i} issue={issue} index={i} />)
            )}
          </div>
        </>
      )}
    </div>
  )
}

function IssueRow({ issue, index }: { issue: A11yIssue; index: number }) {
  const sevColor =
    issue.severity === 'error'
      ? 'var(--danger, #f87171)'
      : issue.severity === 'warning'
      ? 'var(--accent)'
      : 'var(--text-muted)'
  const sevGlyph = issue.severity === 'error' ? '✕' : issue.severity === 'warning' ? '!' : 'i'
  return (
    <div
      data-testid={`a11y-issue-${index}`}
      style={{
        padding: 6,
        border: '1px solid var(--border)',
        borderRadius: 3,
        background: 'var(--bg-surface)',
        display: 'flex',
        gap: 6,
        alignItems: 'flex-start',
      }}
    >
      <span
        style={{
          width: 16,
          height: 16,
          borderRadius: 999,
          background: sevColor,
          color: 'var(--bg-primary)',
          fontSize: 10,
          fontWeight: 700,
          display: 'inline-grid',
          placeItems: 'center',
          flexShrink: 0,
          marginTop: 1,
        }}
      >
        {sevGlyph}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-primary)' }}>
          {issue.message}
        </div>
        {issue.remediation && (
          <div
            style={{
              fontSize: 10,
              color: 'var(--text-secondary)',
              marginTop: 3,
              lineHeight: 1.4,
            }}
          >
            {issue.remediation}
          </div>
        )}
        <div
          className="os-mono"
          style={{
            fontSize: 9,
            color: 'var(--text-muted)',
            marginTop: 3,
            letterSpacing: 0.4,
          }}
        >
          {issue.code}
          {typeof issue.page === 'number' ? ` · page ${issue.page + 1}` : ''}
        </div>
      </div>
    </div>
  )
}
