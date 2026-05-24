import { useState, useEffect, useMemo } from 'react'
import { useUIStore } from '../../stores/uiStore'
import { useFormatStore } from '../../stores/formatStore'
import { useTabStore } from '../../stores/tabStore'
import type { PdfFormatState } from './index'
import { findAcrossPages, replaceAcrossPages, type FindMatch } from '../../services/pdfTextOps'
import {
  buildBodyReplaceEdits,
  countReplacementsInEdits,
} from '../../services/pdfFindReplaceBody'
import type { ParagraphEdit } from '../../services/pdfParagraphEdits'
import { usePdfDocument } from '../../components/viewer/usePdfDocument'
import { t } from '../../lib/i18n'
import { useLocale } from '../../hooks/useLocale'

interface Props {
  tabId: string
}

/** Floating Find & Replace bar. Like Acrobat's Ctrl+H panel — docks at
 *  top-right of the viewer, doesn't block the page. Covers fabric text
 *  objects (Add Text, watermarks, sticky notes, comments). Content-stream
 *  body text uses the paragraph editor + surgical byte-patch save.
 */
export default function FindReplaceDialog({ tabId }: Props) {
  const open = useUIStore((s) => s.findReplaceOpen)
  const mode = useUIStore((s) => s.findReplaceMode)
  const close = useUIStore((s) => s.closeFindReplace)
  const state = useFormatStore((s) => s.data[tabId] as PdfFormatState | undefined)
  // pdfDoc for body-text scanning. Hooked here (not just in PdfViewer)
  // so the dialog can re-cluster paragraphs on demand without
  // depending on EditableParagraphLayer's transient state. Returns
  // null while bytes are loading or the document is closed; we guard
  // the body-replace path on it.
  const pdfDoc = usePdfDocument(state?.pdfBytes ?? null)
  // Subscribe to locale changes so the t() lookups below re-render
  // when the user flips the dropdown in Preferences.
  useLocale()

  const [find, setFind] = useState('')
  const [replace, setReplace] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [regex, setRegex] = useState(false)
  const [status, setStatus] = useState('')
  // Cursor-based navigation: matches[cursor] is the focused match.
  // Find Prev / Next walk this index; Replace replaces only the
  // focused match (vs Replace All which mutates everything).
  const [cursor, setCursor] = useState(0)

  // Live match list — recomputed on input change. Memoized so
  // navigation buttons can reuse the same array without re-finding
  // on every click.
  const matches: FindMatch[] = useMemo(() => {
    if (!state || !find) return []
    try {
      return findAcrossPages(state.pages, find, { caseSensitive, wholeWord, regex })
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Invalid pattern')
      return []
    }
  }, [find, caseSensitive, wholeWord, regex, state])

  const matchCount = matches.length
  const pageCount = useMemo(() => new Set(matches.map((m) => m.pageIndex)).size, [matches])

  useEffect(() => {
    setStatus('')
    setCursor(0)
  }, [find, caseSensitive, wholeWord, regex])

  // Jump to the focused match's page when cursor moves. Mirrors the
  // behaviour of every Find dialog in the wild.
  const setCurrentPage = useUIStore((s) => s.setCurrentPage)
  useEffect(() => {
    if (!find || matches.length === 0) return
    const m = matches[cursor]
    if (!m) return
    setCurrentPage(m.pageIndex)
    const el = document.querySelector(`[data-page-display-index="${m.pageIndex}"]`) as HTMLElement | null
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [cursor, matches, find, setCurrentPage])

  const findNext = () => {
    if (matchCount === 0) return
    setCursor((c) => (c + 1) % matchCount)
  }
  const findPrev = () => {
    if (matchCount === 0) return
    setCursor((c) => (c - 1 + matchCount) % matchCount)
  }

  // Replace ONLY the currently-focused match. Falls back to Replace
  // All semantics if cursor is out of range. Preserves formatting
  // because each fabric object is spread (...obj) before its text
  // is touched — every style field carries through.
  const replaceCurrent = () => {
    if (!state || matchCount === 0) return
    const m = matches[cursor]
    if (!m) return
    try {
      const flags = caseSensitive ? 'g' : 'gi'
      // Build a position-anchored substitution so we only replace
      // the specific match instance (not all occurrences in the
      // object's text).
      const before = state.pages[m.pageIndex]
      const fj = before.fabricJSON as { objects?: Array<Record<string, unknown>> } | null
      if (!fj?.objects) return
      const obj = fj.objects[m.objectIndex] as { text?: string } | undefined
      if (!obj || typeof obj.text !== 'string') return
      const newText = obj.text.slice(0, m.start) + replace + obj.text.slice(m.end)
      const nextObjs = fj.objects.map((o, i) =>
        i === m.objectIndex ? { ...o, text: newText } : o,
      )
      useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => {
        const pages = prev.pages.map((p, idx) =>
          idx === m.pageIndex ? { ...p, fabricJSON: { ...fj, objects: nextObjs } } : p,
        )
        return { ...prev, pages }
      })
      useTabStore.getState().setTabDirty(tabId, true)
      setStatus(`Replaced 1 of ${matchCount}.`)
      // Cursor stays on the same index — the search re-runs on the
      // updated state and the next match (if any) takes this slot.
      // Cap at the new match count.
      void flags
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Replace failed')
    }
  }

  if (!open || !state) return null

  const doReplaceAll = async () => {
    try {
      // Phase A — fabric overlay objects (Add Text, watermarks).
      const res = replaceAcrossPages(state.pages, find, replace, { caseSensitive, wholeWord, regex })
      // Phase B — body PDF paragraphs via cluster + ParagraphEdit
      // synthesis. Routes through engine bake on save so original
      // formatting is preserved (rewrite path keeps the PDF's own
      // font/size). Skipped silently if pdfDoc isn't ready or the
      // body cluster yields nothing.
      let bodyReplacements = 0
      let pagesWithBodyEdits: PdfFormatState['pages'] = res.pages
      if (pdfDoc) {
        const bodyEdits = await buildBodyReplaceEdits(
          pdfDoc,
          find,
          replace,
          { caseSensitive, wholeWord, regex },
        )
        bodyReplacements = countReplacementsInEdits(bodyEdits, find, {
          caseSensitive,
          wholeWord,
          regex,
        })
        if (bodyEdits.size > 0) {
          // Merge per-page: existing _paragraphEdits from interactive
          // editing get UNIONed with the body-replace synthesised edits.
          // Conflict resolution: synthesised edit wins for paragraphs
          // it touched (interactive edit on the SAME paragraphId is
          // dropped). Other pages and other paragraphs are untouched.
          pagesWithBodyEdits = res.pages.map((p) => {
            const newEdits = bodyEdits.get(p.pageIndex)
            if (!newEdits || newEdits.length === 0) return p
            const existing = ((p as unknown as { _paragraphEdits?: ParagraphEdit[] })._paragraphEdits ?? []) as ParagraphEdit[]
            const newIds = new Set(newEdits.map((e) => e.paragraphId))
            const merged = [
              ...existing.filter((e) => !newIds.has(e.paragraphId)),
              ...newEdits,
            ]
            return { ...p, _paragraphEdits: merged } as PdfFormatState['pages'][number]
          })
        }
      }
      useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({
        ...prev,
        pages: pagesWithBodyEdits,
      }))
      useTabStore.getState().setTabDirty(tabId, true)
      const total = res.replacements + bodyReplacements
      setStatus(
        `Replaced ${total} occurrence${total === 1 ? '' : 's'}` +
        (bodyReplacements > 0 ? ` (incl. ${bodyReplacements} in body text).` : '.'),
      )
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Replace failed')
    }
  }

  return (
    <div
      data-testid="findreplace-dialog"
      style={{
        position: 'absolute', top: 8, right: 8, zIndex: 100,
        width: 340, padding: 10,
        background: 'var(--bg-primary)', border: '1px solid var(--border)',
        borderRadius: 6, boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
        display: 'flex', flexDirection: 'column', gap: 6,
      }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
          {mode === 'replace' ? `${t('common.find')} & ${t('common.replace')}` : t('common.find')}
        </span>
        <button onClick={close} style={{
          background: 'transparent', border: 'none', color: 'var(--text-muted)',
          cursor: 'pointer', fontSize: 14,
        }}>✕</button>
      </div>

      <input
        data-testid="findreplace-find-input"
        value={find}
        onChange={(e) => setFind(e.target.value)}
        placeholder={t('find.placeholder')}
        autoFocus
        style={inputStyle}
      />

      {mode === 'replace' && (
        <input
          data-testid="findreplace-replace-input"
          value={replace}
          onChange={(e) => setReplace(e.target.value)}
          placeholder={t('find.replace-placeholder')}
          style={inputStyle}
        />
      )}

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 10, color: 'var(--text-secondary)' }}>
        <CheckLabel label={t('find.match-case')} checked={caseSensitive} onChange={setCaseSensitive} testId="findreplace-case" />
        <CheckLabel label={t('find.whole-word')} checked={wholeWord} onChange={setWholeWord} testId="findreplace-word" />
        <CheckLabel label={t('find.regex')} checked={regex} onChange={setRegex} testId="findreplace-regex" />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-muted)', gap: 8 }}>
        <span data-testid="findreplace-count">
          {find
            ? matchCount > 0
              ? `${cursor + 1} / ${matchCount} on ${pageCount} page${pageCount === 1 ? '' : 's'}`
              : 'No matches'
            : 'Type to search'}
        </span>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          {/* Find Prev / Next: walk matches one at a time. Cursor
              auto-jumps to the focused match's page on change. */}
          <button
            data-testid="findreplace-find-prev"
            onClick={findPrev}
            disabled={matchCount === 0}
            title="Previous match"
            style={navBtnStyle(matchCount === 0)}
          >
            ‹
          </button>
          <button
            data-testid="findreplace-find-next"
            onClick={findNext}
            disabled={matchCount === 0}
            title="Next match"
            style={navBtnStyle(matchCount === 0)}
          >
            ›
          </button>
          {mode === 'replace' && (
            <>
              <button
                data-testid="findreplace-replace-current"
                onClick={replaceCurrent}
                disabled={!find || matchCount === 0}
                title="Replace this match (preserves formatting via per-object spread)"
                style={secondaryBtnStyle}
              >
                Replace
              </button>
              <button
                data-testid="findreplace-replace-all"
                onClick={doReplaceAll}
                disabled={!find || matchCount === 0}
                style={primaryBtnStyle(!find || matchCount === 0)}
              >
                Replace all
              </button>
            </>
          )}
          {mode !== 'replace' && (
            <button
              data-testid="findreplace-switch-replace"
              onClick={() => useUIStore.getState().openReplace()}
              style={secondaryBtnStyle}
            >
              Replace…
            </button>
          )}
        </div>
      </div>

      {status && (
        <div data-testid="findreplace-status" style={{
          fontSize: 10, color: status.startsWith('Replaced') ? 'var(--success)' : 'var(--danger)',
          padding: '2px 0',
        }}>{status}</div>
      )}
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '5px 8px', fontSize: 12,
  background: 'var(--bg-surface)', border: '1px solid var(--border)',
  borderRadius: 3, color: 'var(--text-primary)', boxSizing: 'border-box',
}

const primaryBtnStyle = (disabled: boolean): React.CSSProperties => ({
  padding: '4px 10px', fontSize: 11, borderRadius: 3,
  background: disabled ? 'var(--bg-surface)' : 'var(--accent)',
  color: disabled ? 'var(--text-muted)' : 'var(--bg-primary)',
  border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
  fontWeight: 600, opacity: disabled ? 0.5 : 1,
})

const secondaryBtnStyle: React.CSSProperties = {
  padding: '4px 10px', fontSize: 11, borderRadius: 3,
  background: 'var(--bg-surface)', color: 'var(--text-primary)',
  border: 'none', cursor: 'pointer',
}

const navBtnStyle = (disabled: boolean): React.CSSProperties => ({
  width: 24, height: 24, padding: 0, fontSize: 14, borderRadius: 3,
  background: 'var(--bg-surface)', color: disabled ? 'var(--text-muted)' : 'var(--text-primary)',
  border: '1px solid var(--border)',
  cursor: disabled ? 'not-allowed' : 'pointer',
  opacity: disabled ? 0.5 : 1,
  display: 'inline-grid', placeItems: 'center',
})

function CheckLabel({ label, checked, onChange, testId }: {
  label: string; checked: boolean; onChange: (v: boolean) => void; testId: string
}) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 3, cursor: 'pointer' }}>
      <input
        type="checkbox"
        data-testid={testId}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ margin: 0 }}
      />
      {label}
    </label>
  )
}
