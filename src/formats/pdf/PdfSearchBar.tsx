import { useState, useCallback, useEffect } from 'react'

export interface SearchOpts {
  regex?: boolean
  caseSensitive?: boolean
  wholeWord?: boolean
}

interface Props {
  visible: boolean
  onClose: () => void
  onSearch: (query: string, matchIndex: number, opts: SearchOpts) => void
  totalMatches: number
}

// Pattern presets — common data-discovery patterns. Clicking a preset
// fills the query with a regex literal and enables the regex toggle.
// Kept small and memorable. `\b` anchors prevent false positives mid-
// word for SSN/phone/card; email is intentionally loose (RFC 5322-lite
// — strict grammar would miss valid addresses and add false-negatives).
const PATTERN_PRESETS: Array<{ label: string; pattern: string; title: string }> = [
  { label: 'SSN', pattern: '\\b\\d{3}-\\d{2}-\\d{4}\\b', title: 'US Social Security (###-##-####)' },
  { label: 'Phone', pattern: '\\b\\(?\\d{3}\\)?[\\s.\\-]?\\d{3}[\\s.\\-]?\\d{4}\\b', title: 'US phone (###-###-####, (###) ###-####)' },
  { label: 'Email', pattern: '[A-Za-z0-9._%+\\-]+@[A-Za-z0-9.\\-]+\\.[A-Za-z]{2,}', title: 'Email address' },
  { label: 'Card', pattern: '\\b(?:\\d{4}[\\s\\-]?){3}\\d{4}\\b', title: 'Credit card (16 digits, spaces or dashes allowed)' },
  { label: 'URL', pattern: 'https?://\\S+', title: 'Web URL' },
  { label: 'Date', pattern: '\\b\\d{1,2}[/\\-]\\d{1,2}[/\\-]\\d{2,4}\\b', title: 'Date (M/D/YY, MM-DD-YYYY)' },
]

export default function PdfSearchBar({ visible, onClose, onSearch, totalMatches }: Props) {
  const [query, setQuery] = useState('')
  const [currentMatch, setCurrentMatch] = useState(0)
  const [regex, setRegex] = useState(false)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [showPresets, setShowPresets] = useState(false)

  const handleSearch = useCallback((q: string, idx: number) => {
    onSearch(q, idx, { regex, caseSensitive, wholeWord })
  }, [onSearch, regex, caseSensitive, wholeWord])

  useEffect(() => {
    if (query.length >= 2) {
      handleSearch(query, currentMatch)
    }
  }, [query, currentMatch, handleSearch])

  const nextMatch = () => {
    if (totalMatches > 0) {
      const next = (currentMatch + 1) % totalMatches
      setCurrentMatch(next)
    }
  }

  const prevMatch = () => {
    if (totalMatches > 0) {
      const prev = (currentMatch - 1 + totalMatches) % totalMatches
      setCurrentMatch(prev)
    }
  }

  const applyPreset = (pattern: string) => {
    setQuery(pattern)
    setRegex(true)
    setCurrentMatch(0)
    setShowPresets(false)
  }

  if (!visible) return null

  const toggleBtn = (active: boolean, label: string, title: string, onClick: () => void) => (
    <button
      onClick={onClick}
      title={title}
      style={{
        fontSize: 11,
        padding: '2px 6px',
        minWidth: 22,
        border: '1px solid var(--border)',
        borderRadius: 3,
        background: active ? 'var(--accent, #89b4fa)' : 'var(--bg-secondary, transparent)',
        color: active ? '#1e1e2e' : 'var(--text)',
        cursor: 'pointer',
      }}
    >{label}</button>
  )

  return (
    <div style={{
      position: 'absolute', top: 8, right: 8, zIndex: 100,
      display: 'flex', flexDirection: 'column', gap: 4,
      padding: '6px 10px', background: 'var(--bg-primary)',
      border: '1px solid var(--border)', borderRadius: 6,
      boxShadow: '0 4px 12px rgba(0,0,0,0.4)'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
          type="text"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setCurrentMatch(0) }}
          placeholder={regex ? 'Regex pattern...' : 'Search in PDF...'}
          autoFocus
          style={{ width: 220, padding: '4px 8px', fontSize: 12, fontFamily: regex ? 'ui-monospace, monospace' : undefined }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              if (e.shiftKey) prevMatch()
              else nextMatch()
            }
            if (e.key === 'Escape') onClose()
          }}
        />
        {toggleBtn(caseSensitive, 'Aa', 'Match case', () => { setCaseSensitive(!caseSensitive); setCurrentMatch(0) })}
        {toggleBtn(wholeWord, '\\b', 'Whole word', () => { setWholeWord(!wholeWord); setCurrentMatch(0) })}
        {toggleBtn(regex, '.*', 'Regular expression', () => { setRegex(!regex); setCurrentMatch(0) })}
        {toggleBtn(showPresets, '≡', 'Pattern presets (SSN, phone, email, card, URL, date)', () => setShowPresets(!showPresets))}
        {query.length >= 2 && (
          <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
            {totalMatches > 0 ? `${currentMatch + 1}/${totalMatches}` : 'No matches'}
          </span>
        )}
        <button onClick={prevMatch} style={{ fontSize: 14, padding: '0 4px' }} title="Previous (Shift+Enter)">▲</button>
        <button onClick={nextMatch} style={{ fontSize: 14, padding: '0 4px' }} title="Next (Enter)">▼</button>
        <button onClick={onClose} style={{ fontSize: 14, padding: '0 4px', color: 'var(--text-muted)' }} title="Close (Esc)">✕</button>
      </div>
      {showPresets && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, paddingTop: 2, borderTop: '1px solid var(--border)' }}>
          {PATTERN_PRESETS.map((p) => (
            <button
              key={p.label}
              onClick={() => applyPreset(p.pattern)}
              title={p.title}
              style={{
                fontSize: 11,
                padding: '2px 8px',
                border: '1px solid var(--border)',
                borderRadius: 3,
                background: 'var(--bg-secondary, transparent)',
                color: 'var(--text)',
                cursor: 'pointer',
              }}
            >{p.label}</button>
          ))}
        </div>
      )}
    </div>
  )
}
