import { useEffect, useState } from 'react'
import { useFormatStore } from '../../stores/formatStore'
import { useTabStore } from '../../stores/tabStore'
import { useUIStore } from '../../stores/uiStore'
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
import { SaveDegradationCollector, humanizeDegradation } from '../../services/saveDegradations'
import {
  countManualRedactions,
  stripManualRedactionObjects,
} from '../../services/pdfManualRedactions'
import { showLegalGuaranteeAppliedToast, saveActiveTab } from '../../lib/actions'

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
 *  list to the existing applyRedactions service which removes
 *  recoverable text and falls back to raster replacement for image-like
 *  regions — same trust posture as hand-drawn redaction. */
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
  // Optional metadata wipe on save — surfaced right beside the redaction
  // actions so "sanitize this document for release" is one obvious choice.
  const wipeMetadata = useUIStore((s) => s.wipeMetadataOnSave)
  const setWipeMetadata = useUIStore((s) => s.setWipeMetadataOnSave)
  // Legal Guarantee: permanent, irrecoverable, by-construction redaction.
  // Ticking the checkbox opens a 2-page walkthrough; the flag only PERSISTS
  // after the final confirm. Unticking with pending marks prompts first.
  const legalGuarantee = useUIStore((s) => s.legalGuaranteeRedaction)
  const setLegalGuarantee = useUIStore((s) => s.setLegalGuaranteeRedaction)
  const [lgWalkthrough, setLgWalkthrough] = useState<null | 1 | 2>(null)
  const [lgUntickGuard, setLgUntickGuard] = useState(false)
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
        setStatus(`Loaded bundle "${name}" - ${patterns.length} pattern${patterns.length === 1 ? '' : 's'}.`)
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
      // Throws (and leaves the document untouched) when the post-redaction
      // permanence verification finds surviving content — surfaced via the
      // catch below as the dialog status.
      //
      // Verifier gate-2 P1: every degradation the pipeline records here
      // (raster fallback, metadata scrub, short-needle classification, …)
      // is stashed into _pendingSaveDegradations so the NEXT save's report
      // carries it — that save takes the no-edit fast path because the
      // bytes are already baked, and a collector created there would
      // otherwise start empty.
      const collector = new SaveDegradationCollector()
      const out = await applyRedactions(
        state.pdfBytes,
        matches.map((m) => m.rect),
        collector,
        // Legal Guarantee: flatten every matched page to a secured image by
        // construction, not just image-overlap pages.
        { forceRaster: legalGuarantee },
      )
      const recorded = collector.list()
      useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({
        ...prev,
        pdfBytes: out.bytes,
        _historyBarrierOnSave: true,
        ...(recorded.length > 0
          ? {
              _pendingSaveDegradations: [
                ...(prev._pendingSaveDegradations ?? []),
                ...recorded,
              ],
            }
          : {}),
      }))
      useTabStore.getState().setTabDirty(tabId, true)
      const notable = recorded.filter((d) => d.severity !== 'info')
      setStatus(
        `Redacted ${matches.length} match${matches.length === 1 ? '' : 'es'}.` +
          (notable.length > 0
            ? ` Notes: ${[...new Set(notable.map((d) => d.area))].join(', ')}`
            : ''),
      )
      setMatches([])
      if (legalGuarantee) {
        // Find-&-redact bakes into the working bytes at Apply, so this IS the
        // commit point for this path — surface the permanent-redaction toast
        // (with the re-enable-autosave action) here, mirroring the manual-
        // marks save path. The redacted bytes still persist on the next save.
        showLegalGuaranteeAppliedToast(
          notable.map((d) => ({ severity: d.severity, message: humanizeDegradation(d) })),
        )
        setTimeout(onClose, 900)
      } else if (notable.length === 0) {
        // Auto-close after 1s — the redaction is done; user wants to see the
        // result. With notable degradations, stay open so the user reads them.
        setTimeout(onClose, 900)
      }
    } catch (e) {
      setStatus(`Apply failed: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  // ── Legal Guarantee lifecycle ────────────────────────────────────
  const onToggleLegalGuarantee = (checked: boolean) => {
    if (checked) {
      // Ticking opens the walkthrough; the flag persists only on final confirm.
      setLgWalkthrough(1)
      return
    }
    // Unticking: if uncommitted manual marks are pending, guard the choice.
    if (countManualRedactions(state) > 0) {
      setLgUntickGuard(true)
      return
    }
    setLegalGuarantee(false)
  }
  const confirmLegalGuarantee = () => {
    setLegalGuarantee(true)
    setLgWalkthrough(null)
  }
  const discardPendingMarks = () => {
    useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({
      ...prev,
      pages: prev.pages.map((p) => ({
        ...p,
        fabricJSON: stripManualRedactionObjects(p.fabricJSON).fabricJSON,
      })),
    }))
    setLegalGuarantee(false)
    setLgUntickGuard(false)
  }
  const saveWithLegalGuaranteeNow = () => {
    setLgUntickGuard(false)
    // Keep LG on; the standard save path applies the pending marks with
    // forceRaster and surfaces the permanent-redaction toast itself.
    void saveActiveTab()
  }

  return (
    <>
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
          match - same forensic guarantee as the manual redaction tool (no
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

        {!legalGuarantee && (
          <div
            data-testid="search-redact-lg-nudge"
            style={{
              border: '1px solid var(--accent)',
              background: 'color-mix(in srgb, var(--accent) 10%, transparent)',
              borderRadius: 6,
              padding: '8px 10px',
              fontSize: 11,
              color: 'var(--text-primary)',
              lineHeight: 1.5,
            }}
          >
            <strong style={{ color: 'var(--accent)' }}>Recommended for legally-binding redaction:</strong>{' '}
            enable <em>Legal Guarantee</em> below. It makes redaction permanent and
            irrecoverable by construction - the standard for releasing documents to
            courts, regulators, or the public.
          </div>
        )}

        <label
          data-testid="search-redact-legal-guarantee"
          title="Permanent, irrecoverable redaction. Flattens redacted pages to images and disables autosave."
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 11,
            color: legalGuarantee ? 'var(--accent)' : 'var(--text-secondary)',
            fontWeight: legalGuarantee ? 600 : 400,
            cursor: 'pointer',
            marginTop: 2,
          }}
        >
          <input
            type="checkbox"
            checked={legalGuarantee}
            onChange={(e) => onToggleLegalGuarantee(e.target.checked)}
          />
          Legal Guarantee - permanent, irrecoverable redaction (flattens pages, autosave off)
        </label>

        <label
          data-testid="search-redact-wipe-metadata"
          title="Also remove the document's metadata - title, author, creator, producer, creation/modification dates, and the XMP packet - on save. Applies to every save while checked."
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 11,
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            marginTop: 2,
          }}
        >
          <input
            type="checkbox"
            checked={wipeMetadata}
            onChange={(e) => setWipeMetadata(e.target.checked)}
          />
          Also wipe document metadata on save (author, producer, dates, XMP)
        </label>

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

    {lgWalkthrough !== null && (
      <div
        data-testid="lg-walkthrough"
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.7)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1100,
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) setLgWalkthrough(null)
        }}
      >
        <div
          style={{
            width: 480,
            background: 'var(--bg-primary)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: 22,
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 18 }}>🔒</span>
            <h3 style={{ margin: 0, fontSize: 16, color: 'var(--text-primary)' }}>
              Enable Legal Guarantee - {lgWalkthrough === 1 ? 'How it works' : 'What happens when you save'}
            </h3>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <span style={{ flex: 1, height: 3, borderRadius: 2, background: 'var(--accent)' }} />
            <span style={{ flex: 1, height: 3, borderRadius: 2, background: lgWalkthrough === 2 ? 'var(--accent)' : 'var(--border)' }} />
          </div>

          {lgWalkthrough === 1 ? (
            <div style={{ fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.6 }}>
              <p style={{ marginTop: 0 }}>
                Legal Guarantee makes redaction <strong>permanent and irrecoverable by
                construction</strong> - the standard required for government, legal, and
                regulated releases.
              </p>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                <li>
                  <strong>Autosave is turned OFF.</strong> Redaction is destructive, so it
                  only ever happens on a <em>deliberate</em> save you trigger yourself.
                  Continue with caution.
                </li>
                <li>
                  <strong>Undo / redo keep working normally</strong> while you edit - right
                  up until your next manual save.
                </li>
              </ul>
            </div>
          ) : (
            <div style={{ fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.6 }}>
              <p style={{ marginTop: 0 }}>When you save with Legal Guarantee on:</p>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                <li>Each redacted page is <strong>flattened to a secured image</strong>.</li>
                <li>The content under your marks is <strong>destroyed at the pixel level</strong> - it cannot be recovered by any viewer or tool.</li>
                <li>Those pages <strong>lose selectable text</strong> (they become images).</li>
                <li>The undo history is <strong>cleared</strong>, and <strong>the save cannot be undone</strong>.</li>
              </ul>
              <p style={{ marginBottom: 0, color: 'var(--warn)' }}>
                Finish all other edits to these pages <strong>before</strong> you save.
              </p>
            </div>
          )}

          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 4 }}>
            {lgWalkthrough === 2 && (
              <button
                data-testid="lg-walkthrough-back"
                onClick={() => setLgWalkthrough(1)}
                style={{ padding: '6px 14px', fontSize: 12, borderRadius: 4, background: 'var(--bg-surface)', color: 'var(--text-primary)', border: '1px solid var(--border)', cursor: 'pointer' }}
              >
                Back
              </button>
            )}
            <button
              data-testid="lg-walkthrough-cancel"
              onClick={() => setLgWalkthrough(null)}
              style={{ padding: '6px 14px', fontSize: 12, borderRadius: 4, background: 'var(--bg-surface)', color: 'var(--text-muted)', border: '1px solid var(--border)', cursor: 'pointer' }}
            >
              Cancel
            </button>
            {lgWalkthrough === 1 ? (
              <button
                data-testid="lg-walkthrough-next"
                onClick={() => setLgWalkthrough(2)}
                style={{ padding: '6px 14px', fontSize: 12, borderRadius: 4, background: 'var(--accent)', color: 'var(--bg-primary)', border: 'none', fontWeight: 600, cursor: 'pointer' }}
              >
                Next
              </button>
            ) : (
              <button
                data-testid="lg-walkthrough-enable"
                onClick={confirmLegalGuarantee}
                style={{ padding: '6px 14px', fontSize: 12, borderRadius: 4, background: 'var(--accent)', color: 'var(--bg-primary)', border: 'none', fontWeight: 600, cursor: 'pointer' }}
              >
                I understand - enable
              </button>
            )}
          </div>
        </div>
      </div>
    )}

    {lgUntickGuard && (
      <div
        data-testid="lg-untick-guard"
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.7)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1100,
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) setLgUntickGuard(false)
        }}
      >
        <div
          style={{
            width: 460,
            background: 'var(--bg-primary)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: 22,
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }}
        >
          <h3 style={{ margin: 0, fontSize: 15, color: 'var(--text-primary)' }}>
            Turn off Legal Guarantee with redaction marks pending?
          </h3>
          <div style={{ fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.6 }}>
            This document still has uncommitted redaction marks. Turning off Legal
            Guarantee now means a later save would redact them <em>without</em> the
            permanent flatten guarantee.
          </div>
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <button
              data-testid="lg-untick-save-now"
              onClick={saveWithLegalGuaranteeNow}
              style={{ padding: '6px 14px', fontSize: 12, borderRadius: 4, background: 'var(--accent)', color: 'var(--bg-primary)', border: 'none', fontWeight: 600, cursor: 'pointer' }}
            >
              Save with Legal Guarantee now
            </button>
            <button
              data-testid="lg-untick-discard"
              onClick={discardPendingMarks}
              style={{ padding: '6px 14px', fontSize: 12, borderRadius: 4, background: 'var(--bg-surface)', color: 'var(--bad)', border: '1px solid var(--border)', cursor: 'pointer' }}
            >
              Discard marks
            </button>
            <button
              data-testid="lg-untick-cancel"
              onClick={() => setLgUntickGuard(false)}
              style={{ padding: '6px 14px', fontSize: 12, borderRadius: 4, background: 'var(--bg-surface)', color: 'var(--text-muted)', border: '1px solid var(--border)', cursor: 'pointer' }}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  )
}
