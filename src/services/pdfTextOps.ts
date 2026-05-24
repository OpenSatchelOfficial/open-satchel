// Text operations that work on Fabric text objects layered on the PDF.
// Native PDF body text editing (Acrobat's "point-and-click") requires
// rewriting content streams — out of scope. These ops cover the fabric
// overlay text (Add Text, Watermark, etc.) which is what our users
// actually author.

import type { PdfFormatState, PdfPageState } from '../formats/pdf'

// ---------- Find / Replace across fabric text objects ----------

export interface FindMatch {
  pageIndex: number
  objectIndex: number
  text: string
  start: number
  end: number
}

export interface FindOpts {
  caseSensitive?: boolean
  wholeWord?: boolean
  regex?: boolean
}

function buildPattern(needle: string, opts: FindOpts): RegExp {
  let source = needle
  if (!opts.regex) source = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (opts.wholeWord) source = `\\b(?:${source})\\b`
  const flags = 'g' + (opts.caseSensitive ? '' : 'i')
  return new RegExp(source, flags)
}

export function findAcrossPages(pages: PdfPageState[], needle: string, opts: FindOpts = {}): FindMatch[] {
  if (!needle) return []
  const re = buildPattern(needle, opts)
  const out: FindMatch[] = []
  pages.forEach((page, pageIndex) => {
    if (page.deleted) return
    const fj = page.fabricJSON as { objects?: Array<Record<string, unknown>> } | null
    const objs = fj?.objects ?? []
    objs.forEach((obj, objectIndex) => {
      const text = (obj as { text?: string }).text
      if (typeof text !== 'string') return
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(text)) !== null) {
        out.push({ pageIndex, objectIndex, text, start: m.index, end: m.index + m[0].length })
        if (m[0].length === 0) re.lastIndex += 1
      }
    })
  })
  return out
}

export function replaceAcrossPages(
  pages: PdfPageState[],
  needle: string,
  replacement: string,
  opts: FindOpts = {}
): { pages: PdfPageState[]; replacements: number } {
  if (!needle) return { pages, replacements: 0 }
  const re = buildPattern(needle, opts)
  let replacements = 0
  const nextPages = pages.map((page) => {
    if (page.deleted) return page
    const fj = page.fabricJSON as { objects?: Array<Record<string, unknown>> } | null
    if (!fj?.objects) return page
    const nextObjs = fj.objects.map((obj) => {
      const text = (obj as { text?: string }).text
      if (typeof text !== 'string') return obj
      re.lastIndex = 0
      const matches = text.match(re)
      if (!matches) return obj
      replacements += matches.length
      return { ...obj, text: text.replace(re, replacement) }
    })
    return { ...page, fabricJSON: { ...fj, objects: nextObjs } }
  })
  return { pages: nextPages, replacements }
}

// ---------- Spell check (heuristic dictionary-free) ----------

// We avoid pulling a dictionary dependency. Instead we flag "likely
// typos" by combining a small common-english allowlist with heuristics
// (unusual bigrams, repeated letters, words with only vowels, etc.).
// This is conservative — it will miss real misspellings — but gives
// actionable hints without a 5MB dictionary.

const COMMON_WORDS = new Set<string>([
  'the','of','and','to','a','in','is','it','you','that','he','was','for','on','are','as',
  'with','his','they','i','at','be','this','have','from','or','one','had','by','word',
  'but','not','what','all','were','we','when','your','can','said','there','use','an',
  'each','which','she','do','how','their','if','will','up','other','about','out','many',
  'then','them','these','so','some','her','would','make','like','him','into','time',
  'has','look','two','more','write','go','see','number','no','way','could','people',
  'my','than','first','been','call','who','its','now','find','long','down','day','did',
  'get','come','made','may','part',
  'hello','world','harness','test','page','draft','copy','approved','confidential',
])

export interface TypoFlag {
  pageIndex: number
  objectIndex: number
  word: string
  start: number
  end: number
}

function looksSuspicious(word: string): boolean {
  const w = word.toLowerCase()
  if (w.length < 3) return false
  if (COMMON_WORDS.has(w)) return false
  // Has at least one vowel? If not, almost certainly nonsense.
  if (!/[aeiouy]/.test(w)) return true
  // 4+ same letter in a row
  if (/(.)\1{3,}/.test(w)) return true
  // 4+ consonants in a row (rare in English)
  if (/[bcdfghjklmnpqrstvwxz]{4,}/i.test(w)) return true
  // Numbers mashed into letters (1337-speak typos)
  if (/[a-z][0-9][a-z]/i.test(w) && w.length > 4) return true
  return false
}

export function spellCheckPages(pages: PdfPageState[]): TypoFlag[] {
  const out: TypoFlag[] = []
  pages.forEach((page, pageIndex) => {
    if (page.deleted) return
    const fj = page.fabricJSON as { objects?: Array<Record<string, unknown>> } | null
    const objs = fj?.objects ?? []
    objs.forEach((obj, objectIndex) => {
      const text = (obj as { text?: string }).text
      if (typeof text !== 'string') return
      const re = /[A-Za-z][A-Za-z'-]*/g
      let m: RegExpExecArray | null
      while ((m = re.exec(text)) !== null) {
        if (looksSuspicious(m[0])) {
          out.push({ pageIndex, objectIndex, word: m[0], start: m.index, end: m.index + m[0].length })
        }
      }
    })
  })
  return out
}

// ---------- Read aloud (SpeechSynthesis) ----------

/** Read fabric overlay text objects on a page aloud. Kept for callers
 *  that don't have a live pdfjs document in hand — it only sees text
 *  the user added via the editor, not the PDF's body content. */
export function readPageAloud(state: PdfFormatState, pageIndex: number, opts: { rate?: number; voice?: string } = {}): SpeechSynthesisUtterance | null {
  const page = state.pages[pageIndex]
  if (!page || page.deleted) return null
  const fj = page.fabricJSON as { objects?: Array<Record<string, unknown>> } | null
  const items = (fj?.objects ?? [])
    .filter((o) => typeof (o as { text?: string }).text === 'string')
    .sort((a, b) => ((a as { top?: number }).top ?? 0) - ((b as { top?: number }).top ?? 0))
  const text = items.map((o) => (o as { text: string }).text).join('. ')
  if (!text) return null
  return speakText(text, opts)
}

/** Read the PDF's body text on a page in content-stream y-order.
 *  Falls back to fabric overlay sort if pdfDoc is missing or extraction
 *  yields no text. This is what users expect from "Read Aloud" — hearing
 *  the document, not the user's overlay annotations. pdfDoc is typed
 *  loosely because pdfjs types are behind a heavy import — we access a
 *  narrow slice of the API and guard everything in try/catch. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readPdfPageAloud(
  pdfDoc: any,
  state: PdfFormatState | null,
  pageIndex: number,
  opts: { rate?: number; voice?: string } = {}
): Promise<SpeechSynthesisUtterance | null> {
  let text = ''
  if (pdfDoc) {
    try {
      const page = await pdfDoc.getPage(pageIndex + 1)
      const vp = page.getViewport({ scale: 1 })
      const tc = await page.getTextContent()
      // pdfjs gives items in content-stream order with transform[5] = y
      // in user-space. Convert to top-down viewport y (vp.height - y) and
      // bucket by ~line height, then emit left-to-right within each line.
      // TextMarkedContent items (without str) are filtered out.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const items = (tc.items as any[])
        .map((it) => {
          const s = typeof it.str === 'string' ? it.str.trim() : ''
          const tr = Array.isArray(it.transform) ? it.transform : []
          const x = tr[4] ?? 0
          const yUp = tr[5] ?? 0
          return { s, x, y: vp.height - yUp, eol: it.hasEOL === true }
        })
        .filter((it) => it.s.length > 0 || it.eol)
      // Line height estimate: median |dy| between items; fall back to 12.
      const dys: number[] = []
      for (let i = 1; i < items.length; i++) {
        const d = Math.abs(items[i].y - items[i - 1].y)
        if (d > 0.5) dys.push(d)
      }
      dys.sort((a, b) => a - b)
      const lineH = Math.max(8, dys[Math.floor(dys.length / 2)] ?? 12)
      const bucketed = new Map<number, Array<{ s: string; x: number }>>()
      for (const it of items) {
        if (!it.s) continue
        const key = Math.round(it.y / lineH)
        if (!bucketed.has(key)) bucketed.set(key, [])
        bucketed.get(key)!.push({ s: it.s, x: it.x })
      }
      const lines = [...bucketed.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, bucket]) => bucket.sort((a, b) => a.x - b.x).map((b) => b.s).join(' '))
      text = lines.join('. ')
      page.cleanup()
    } catch {
      text = ''
    }
  }
  if (!text && state) {
    // Fallback to fabric overlay order.
    const u = readPageAloud(state, pageIndex, opts)
    return u
  }
  if (!text) return null
  return speakText(text, opts)
}

function speakText(text: string, opts: { rate?: number; voice?: string }): SpeechSynthesisUtterance {
  const u = new SpeechSynthesisUtterance(text)
  u.rate = opts.rate ?? 1
  if (opts.voice) {
    const v = window.speechSynthesis.getVoices().find((vo) => vo.name === opts.voice)
    if (v) u.voice = v
  }
  window.speechSynthesis.cancel()
  window.speechSynthesis.speak(u)
  return u
}

/** List available TTS voices. Returns [] until the browser populates
 *  the list async — call this after a `voiceschanged` event or poll
 *  briefly on mount. */
export function listVoices(): SpeechSynthesisVoice[] {
  if (typeof window === 'undefined' || !window.speechSynthesis) return []
  return window.speechSynthesis.getVoices()
}

export function stopReading(): void {
  window.speechSynthesis.cancel()
}
