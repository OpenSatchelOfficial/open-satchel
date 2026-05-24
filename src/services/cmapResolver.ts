// CMap Resolver — Bidirectional Glyph ↔ Unicode Mapping
//
// Many PDFs encode text as glyph indices rather than character codes.
// pdfjs decodes these via ToUnicode CMaps for display. We need the
// reverse mapping (Unicode → glyph bytes) to write edited text back
// into the content stream.
//
// Strategy: pdfjs has already decoded every character on the page.
// By matching pdfjs text items to content stream TextRuns by position,
// we can build a per-font character↔glyph bidirectional map from the
// existing data — no CMap parsing needed.

import type { PdfTextItem } from './pdfTextExtract'
import type { TextRun } from './contentStreamParser'

// ── Types ──────────────────────────────────────────────────────────

export interface FontGlyphMap {
  fontName: string
  unicodeToGlyph: Map<string, Uint8Array>   // "H" → [0x48] or [0x00, 0x48]
  glyphToUnicode: Map<string, string>        // hex "48" → "H"
  bytesPerGlyph: number                      // 1 or 2 (CID fonts use 2)
  isIdentityEncoding: boolean                // true if glyph bytes = raw char codes
}

// ── Builder ────────────────────────────────────────────────────────

/**
 * Build bidirectional glyph maps by correlating pdfjs-decoded text with
 * raw content stream bytes. Each pdfjs text item gives us the Unicode
 * characters; the corresponding TextRun gives us the raw glyph bytes.
 */
export function buildGlyphMaps(
  textItems: PdfTextItem[],
  textRuns: TextRun[],
  posTolerance: number = 5.0
): Map<string, FontGlyphMap> {
  const maps = new Map<string, FontGlyphMap>()

  // For each TextRun, find the best-matching pdfjs text item
  for (const run of textRuns) {
    if (!run.rawString || !run.text) continue

    let bestItem: PdfTextItem | null = null
    let bestDist = Infinity

    for (const item of textItems) {
      const dx = Math.abs(run.x - item.x)
      const dy = Math.abs(run.y - item.y)
      const dist = dx + dy
      if (dist < bestDist && dist < posTolerance * run.fontSize) {
        bestDist = dist
        bestItem = item
      }
    }

    if (!bestItem) continue

    // Get or create the font map
    let fontMap = maps.get(run.fontName)
    if (!fontMap) {
      fontMap = {
        fontName: run.fontName,
        unicodeToGlyph: new Map(),
        glyphToUnicode: new Map(),
        bytesPerGlyph: 1,
        isIdentityEncoding: true,
      }
      maps.set(run.fontName, fontMap)
    }

    const rawBytes = run.rawString.value
    const decodedText = bestItem.str

    // Determine bytes-per-glyph from the ratio of raw bytes to characters
    if (decodedText.length > 0 && rawBytes.length > 0) {
      const ratio = rawBytes.length / decodedText.length
      if (ratio >= 1.8 && ratio <= 2.2) {
        fontMap.bytesPerGlyph = 2  // CID font — 2 bytes per glyph
      }
    }

    const bpg = fontMap.bytesPerGlyph

    // Build character-level mappings
    const charCount = Math.min(decodedText.length, Math.floor(rawBytes.length / bpg))
    for (let i = 0; i < charCount; i++) {
      const char = decodedText[i]
      const glyphBytes = rawBytes.slice(i * bpg, (i + 1) * bpg)
      const hexKey = Array.from(glyphBytes, b => b.toString(16).padStart(2, '0')).join('')

      fontMap.unicodeToGlyph.set(char, glyphBytes)
      fontMap.glyphToUnicode.set(hexKey, char)

      // Check if this is identity encoding (glyph bytes = char code)
      if (bpg === 1 && glyphBytes[0] !== char.charCodeAt(0)) {
        fontMap.isIdentityEncoding = false
      } else if (bpg === 2) {
        const charCode = char.charCodeAt(0)
        if (glyphBytes[0] !== ((charCode >> 8) & 0xFF) || glyphBytes[1] !== (charCode & 0xFF)) {
          fontMap.isIdentityEncoding = false
        }
      }
    }
  }

  return maps
}

// ── Encoding ───────────────────────────────────────────────────────

/**
 * Encode a Unicode string to glyph bytes using the font's glyph map.
 * Returns null if any character can't be encoded (caller should fall back).
 */
export function encodeWithGlyphMap(
  text: string,
  fontMap: FontGlyphMap
): Uint8Array | null {
  if (fontMap.isIdentityEncoding) {
    // Simple case: glyph bytes = char codes
    if (fontMap.bytesPerGlyph === 1) {
      const bytes = new Uint8Array(text.length)
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i)
        if (code > 0xFF) return null // Can't encode in 1 byte
        bytes[i] = code
      }
      return bytes
    } else {
      const bytes = new Uint8Array(text.length * 2)
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i)
        bytes[i * 2] = (code >> 8) & 0xFF
        bytes[i * 2 + 1] = code & 0xFF
      }
      return bytes
    }
  }

  // Non-identity: look up each character in the glyph map
  const bpg = fontMap.bytesPerGlyph
  const result = new Uint8Array(text.length * bpg)
  for (let i = 0; i < text.length; i++) {
    const glyphBytes = fontMap.unicodeToGlyph.get(text[i])
    if (!glyphBytes) return null // Unknown character — can't encode
    result.set(glyphBytes, i * bpg)
  }
  return result
}

/**
 * Check if all characters in the new text can be encoded with the font's glyph map.
 * Returns the list of characters that can't be encoded.
 */
export function findUnmappedCharacters(
  text: string,
  fontMap: FontGlyphMap
): string[] {
  if (fontMap.isIdentityEncoding) {
    if (fontMap.bytesPerGlyph === 1) {
      return [...text].filter(c => c.charCodeAt(0) > 0xFF)
    }
    return [] // 2-byte identity can encode any BMP character
  }

  return [...text].filter(c => !fontMap.unicodeToGlyph.has(c))
}
