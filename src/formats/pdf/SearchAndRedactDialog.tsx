import { useEffect, useState } from 'react'
import { useFormatStore } from '../../stores/formatStore'
import { useTabStore } from '../../stores/tabStore'
import type { PdfFormatState } from './index'
import {
  PRESET_PATTERNS,
  presetByLabel,
  findPatternMatches,
  dedupOverlappingMatches,
  loadPatternBundle,
  type PatternMatch,
  type RedactPattern,
} from '../../services/pdfRedactPatterns'
import { applyRedactions } from '../../services/pdfRedact'

interface Props {
  tabId: string
  onClose: () => void
}

/** Acrobat-parity Find & Redact dialog. User picks a subset of the
 *  built-in patterns (SSN, email, phone, etc.) plus optional custom
 *  regex; clicks Find to count matches; clicks Apply to redact.
 *
 *  Formatting note: this consumes the pdfRedactPatterns service
 *  (already shipped + 8 unit tests passing), and routes the rect
 *  list to the existing applyRedactions service which rasterizes
 *  redacted pages and burns opaque rects — same trust posture as
 *  hand-drawn redaction. */
export default function SearchAndRedactDialog({ tabId, onClose }: Props) {
  const state = useFormatStore((s) => s.data[tabId] as PdfFormatState | undefined)
  const [enabled, setEnabled] = useState<Record<string, boolean>>(() => ({
    SSN: true,
    Email: true,
    Phone: true,
    'Credit card': false,
    'Account number': false,
    Date: false,
  }))
  const [customLabel, setCustomLabel] = useState('Custom')
  const [customSource, setCustomSource] = useState('')
  const [matches, setMatches] = useState<PatternMatch[]>([])
  const [busy, setBusy] = useState<false | 'finding' | 'applying'>(false)
  const [status, setStatus] = useState('')
  // Patterns loaded from a JSON bundle (legal / privacy team's
  // canonical PII set). Pushed alongside the built-in presets at
  // find time. Cleared via "Clear bundle" or page reload.
  const [bundlePatterns, setBundlePatterns] = useState<RedactPattern[]>([])
  const [bundleName, setBundleName] = useState<string>('')

  const importBundle = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,application/json'
    input.onchange = async () => {
      const f = input.files?.[0]
      if (!f) return
      try {
        const text = await f.text()
        const { name, patterns } = loadPatternBundle(text)
        setBundlePatterns(patterns)
        setBundleName(name)
        setStatus(`Loaded bundle "${name}" — ${patterns.length} pattern${patterns.length === 1 ? '' : 's'}.`)
      } catch (e) {
        setStatus(e instanceof Error ? `Bundle load failed: ${e.message}` : 'Bundle load failed')
      }
    }
    input.click()
  }
  const clearBundle = () => {
    setBundlePatterns([])
    setBundleName('')
  }

  useEffect(() => {
    setMatches([])
    setStatus('')
  }, [state?.pdfBytes])

  if (!state) return null

  const buildPatterns = (): RedactPattern[] => {
    const out: RedactPattern[] = []
    for (const p of PRESET_PATTERNS) {
      if (enabled[p.label]) {
        const fresh = presetByLabel(p.label)
        if (fresh) out.push(fresh)
      }
    }
    if (customSource.trim()) {
      try {
        out.push({
          label: customLabel.trim() || 'Custom',
          re: new RegExp(customSource, 'g'),
        })
      } catch (e) {
        setStatus(`Invalid custom regex: ${(e as Error).message}`)
      }
    }
    out.push(...bundlePatterns)
    return out
  }

  const find = async () => {
    setBusy('finding')
    setStatus('Loading PDF for scan…')
    try {
      const patterns = buildPatterns()
      if (patterns.length === 0) {
        setStatus('No patterns selected.')
        setMatches([])
        return
      }
      const pdfjs = await import('pdfjs-dist')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const doc = await (pdfjs as any).getDocument({ data: state.pdfBytes.slice() }).promise
      const found = await findPatternMatches(doc, patterns)
      const deduped = dedupOverlappingMatches(found)
      setMatches(deduped)
      setStatus(
        deduped.length === 0
          ? 'No matches.'
          : `Found ${deduped.length} match${deduped.length === 1 ? '' : 'es'} across ${
              new Set(deduped.map((m) => m.page)).size
            } page${new Set(deduped.map((m) => m.page)).size === 1 ? '' : 's'}.`,
      )
    } catch (e) {
      setStatus(`Find failed: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const apply = async () => {
    if (matches.length === 0) return
    setBusy('applying')
    setStatus('Burning redactions…')
    try {
      const out = await applyRedactions(
        state.pdfBytes,
        matches.map((m) => m.rect),
      )
      useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({
        ...prev,
        pdfBytes: out,
        _historyBarrierOnSave: true,
      }))
      useTabStore.getState().setTabDirty(tabId, true)
      setStatus(`Redacted ${matches.length} match${matches.length === 1 ? '' : 'es'}.`)
      setMatches([])
      // Auto-close after 1s — the redaction is done; user wants
      // to see the result.
      setTimeout(onClose, 900)
    } catch (e) {
      setStatus(`Apply failed: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      data-testid="search-redact-dialog"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        style={{
          width: 540,
          background: 'var(--bg-primary)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          maxHeight: '85vh',
          overflowY: 'auto',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0, fontSize: 16, color: 'var(--text-primary)' }}>
            Find &amp; Redact patterns
          </h3>
          <button
            data-testid="search-redact-close"
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              fontSize: 18,
              cursor: 'pointer',
              color: 'var(--text-primary)',
            }}
          >
            ×
          </button>
        </div>

        <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          Pick patterns to scan for. Apply burns opaque rectangles over every
          match — same forensic guarantee as the manual redaction tool (no
          recoverable text in the output).
        </div>

        <div>
          <div
            className="os-mono"
            style={{
              fontSize: 10,
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: 0.6,
              marginBottom: 6,
            }}
          >
            Built-in patterns
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
            {PRESET_PATTERNS.map((p) => (
              <label
                key={p.label}
                data-testid={`search-redact-toggle-${p.label}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={enabled[p.label] ?? false}
                  onChange={(e) => setEnabled({ ...enabled, [p.label]: e.target.checked })}
                />
                <span>{p.label}</span>
                <span
                  className="os-mono"
                  style={{ fontSize: 9, color: 'var(--text-muted)' }}
                  title={p.re.source}
                >
                  /{p.re.source.length > 28 ? p.re.source.slice(0, 28) + '…' : p.re.source}/
                </span>
              </label>
            ))}
          </div>
        </div>

        <div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 6,
            }}
          >
            <div
              className="os-mono"
              style={{
                fontSize: 10,
                color: 'var(--text-muted)',
                textTransform: 'uppercase',
                letterSpacing: 0.6,
              }}
            >
              Pattern bundle (JSON)
            </div>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              {bundleName && (
                <span data-testid="search-redact-bundle-name" style={{ fontSize: 10, color: 'var(--accent)', fontFamily: '"JetBrains Mono", monospace' }}>
                  {bundleName} ({bundlePatterns.length})
                </span>
              )}
              <button
                data-testid="search-redact-import-bundle"
                onClick={importBundle}
                style={{
                  padding: '3px 8px',
                  fontSize: 10,
                  borderRadius: 3,
                  background: 'var(--bg-surface)',
                  color: 'var(--text-primary)',
                  border: '1px solid var(--border)',
                  cursor: 'pointer',
                }}
              >
                Import…
              </button>
              {bundlePatterns.length > 0 && (
                <button
                  data-testid="search-redact-clear-bundle"
                  onClick={clearBundle}
                  style={{
                    padding: '3px 8px',
                    fontSize: 10,
                    borderRadius: 3,
                    background: 'transparent',
                    color: 'var(--text-muted)',
                    border: '1px solid var(--border)',
                    cursor: 'pointer',
                  }}
                >
                  Clear
                </button>
              )}
            </div>
          </div>
        </div>

        <div>
          <div
            className="os-mono"
            style={{
              fontSize: 10,
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: 0.6,
              marginBottom: 6,
            }}
          >
            Custom regex
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              data-testid="search-redact-custom-label"
              value={customLabel}
              onChange={(e) => setCustomLabel(e.target.value)}
              placeholder="Label"
              style={{
                width: 120,
                padding: '5px 8px',
                fontSize: 11,
                background: 'var(--bg-surface)',
                border: '1px solid var(--border)',
                borderRadius: 3,
                color: 'var(--text-primary)',
              }}
            />
            <input
              data-testid="search-redact-custom-source"
              value={customSource}
              onChange={(e) => setCustomSource(e.target.value)}
              placeholder="\\bACME-\\d{4}\\b"
              style={{
                flex: 1,
                padding: '5px 8px',
                fontSize: 11,
                fontFamily: '"JetBrains Mono", monospace',
                background: 'var(--bg-surface)',
                border: '1px solid var(--border)',
                borderRadius: 3,
                color: 'var(--text-primary)',
              }}
            />
          </div>
        </div>

        {matches.length > 0 && (
          <div
            data-testid="search-redact-matches"
            style={{
              border: '1px solid var(--border)',
              borderRadius: 4,
              maxHeight: 200,
              overflowY: 'auto',
              padding: 6,
              fontSize: 11,
              fontFamily: '"JetBrains Mono", monospace',
            }}
          >
            {matches.slice(0, 50).map((m, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, padding: '2px 0' }}>
                <span style={{ color: 'var(--accent)', minWidth: 24 }}>p{m.page + 1}</span>
                <span style={{ color: 'var(--text-muted)', minWidth: 70 }}>{m.pattern}</span>
                <span style={{ color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {m.text}
                </span>
              </div>
            ))}
            {matches.length > 50 && (
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4, fontStyle: 'italic' }}>
                + {matches.length - 50} more (apply will redact all)
              </div>
            )}
          </div>
        )}

        {status && (
          <div data-testid="search-redact-status" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
            {status}
          </div>
        )}

        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 4 }}>
          <button
            data-testid="search-redact-find"
            onClick={find}
            disabled={busy !== false}
            style={{
              padding: '6px 14px',
              fontSize: 12,
              borderRadius: 4,
              background: 'var(--bg-surface)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border)',
              cursor: busy ? 'not-allowed' : 'pointer',
            }}
          >
            {busy === 'finding' ? 'Scanning…' : 'Find'}
          </button>
          <button
            data-testid="search-redact-apply"
            onClick={apply}
            disabled={busy !== false || matches.length === 0}
            style={{
              padding: '6px 14px',
              fontSize: 12,
              borderRadius: 4,
              background: matches.length > 0 ? 'var(--accent)' : 'var(--bg-surface)',
              color: matches.length > 0 ? 'var(--bg-primary)' : 'var(--text-muted)',
              border: 'none',
              cursor: matches.length === 0 || busy ? 'not-allowed' : 'pointer',
              fontWeight: 600,
              opacity: matches.length === 0 ? 0.5 : 1,
            }}
          >
            {busy === 'applying'
              ? 'Burning…'
              : matches.length === 0
              ? 'Apply'
              : `Redact ${matches.length} match${matches.length === 1 ? '' : 'es'}`}
          </button>
        </div>
      </div>
    </div>
  )
}
