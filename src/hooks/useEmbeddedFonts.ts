// Engine-side embedded-font extraction + registration — S8.5 front half.
//
// Pulls raw font-program bytes out of the current PDF page via the
// Rust engine, registers each font with the browser's `FontFace` API,
// and returns a compact stack the paragraph editor can stuff into
// `font-family` so in-edit text renders in the document's actual
// typeface.
//
// The key user-visible behavior — and the reason this lives in S8.5
// rather than S8 — is **subset coverage detection**. Embedded PDF
// fonts are almost always subsetted: they contain only the glyphs the
// original page needed. When the user types a character outside the
// subset, the browser silently falls back to whatever comes next in
// the font stack, producing a visible style jump mid-word. We expose
// a `subsetCoversText()` helper so callers can warn the user (or
// switch to a system font paragraph-wide) before they commit the edit.

import { invoke } from '@tauri-apps/api/core'
import { useEffect, useMemo, useState } from 'react'

type EngineFormat = 'Type1' | 'TrueType' | 'OpenType'

export interface EngineExtractedFont {
  /** PostScript name as recorded in the PDF. Subsetted fonts carry a
   *  6-char `ABCDEF+` prefix (e.g. `AAABBB+Helvetica-Bold`). */
  psName: string
  /** [object_number, generation] of the FontDescriptor object —
   *  useful for disambiguating multiple fonts sharing a PS name. */
  fontDescriptorId: [number, number]
  /** Font-program format. Type1 is effectively unusable on the web. */
  format: EngineFormat
  /** Raw bytes of the font program (TrueType / CFF / etc.). */
  bytes: number[]
}

export interface LoadedFontHandle {
  /** The `FontFace` actually registered with `document.fonts`. */
  face: FontFace
  /** PS name reported by the engine (with subset prefix intact). */
  psName: string
  /** Subset prefix stripped — usable family name for CSS stacks. */
  family: string
  /** True when `psName` carries an `ABCDEF+` subset prefix. Callers
   *  use this to decide whether subset-coverage warnings apply. */
  subsetted: boolean
  /** The characters this font will render. Populated lazily on first
   *  coverage check via the browser's `FontFace.load().then(() => ...)`
   *  path isn't actually exposed by the spec, so we instead keep a
   *  `subsettedGlyphs` set derived from the font's `cmap` when we
   *  have the bytes available. For this hook's scope we only surface
   *  the `subsetted` flag — the coverage util lives in
   *  `subsetCoversText` below, which runs off the font bytes
   *  directly. */
}

export interface UseEmbeddedFontsInput {
  pdfBytes: Uint8Array | undefined
  pageIndex: number
  enabled?: boolean
}

export interface UseEmbeddedFontsOutput {
  /** Fonts loaded into `document.fonts` and ready to reference by
   *  name. Order matches the engine's extraction order, which mirrors
   *  the page's Font-resource order (so the first entry is typically
   *  the body copy). */
  fonts: LoadedFontHandle[]
  /** `font-family` stack ready to paste into a CSS declaration. Each
   *  family is quoted. Falls back to a sensible sans-serif default
   *  so partial-extraction failures still render something. */
  fontStack: string
  /** True while the IPC call or FontFace registration is in flight. */
  loading: boolean
  /** Last error from extraction, or null on success. */
  error: string | null
}

/**
 * Strip the `ABCDEF+` subset prefix PDF producers prepend to
 * embedded-font PostScript names. Returns the original string
 * unchanged when no prefix is present.
 */
export function stripSubsetPrefix(psName: string): string {
  // Per PDF spec §9.6.4: prefix is exactly 6 uppercase letters
  // followed by `+`. Real-world fixtures sometimes use lowercase
  // or 7-char prefixes, so accept the looser 5-8 letters + `+`.
  const m = /^[A-Za-z]{5,8}\+(.+)$/.exec(psName)
  return m ? m[1] : psName
}

/**
 * Returns true iff the PS name has a subset prefix — meaning the font
 * contains only a GLYPH SUBSET of the face, not the full repertoire.
 */
export function isSubsetted(psName: string): boolean {
  return /^[A-Za-z]{5,8}\+/.test(psName)
}

/**
 * Parse a TrueType / OpenType font's `cmap` table into the set of
 * Unicode code points it can render. Returns null if the bytes don't
 * look like a TT/OT font (e.g. Type1 → not web-renderable anyway).
 *
 * Used by `subsetCoversText` below to warn the user when typed text
 * would fall off the end of the embedded subset.
 *
 * This is deliberately minimal — we only read cmap format 4 + 12,
 * which covers virtually every real-world font. Exotic formats are
 * treated as "no coverage info, assume OK" to avoid false positives.
 */
export function codepointsFromFontBytes(bytes: Uint8Array): Set<number> | null {
  const cov = new Set<number>()
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u32 = (off: number) => view.getUint32(off)
  const u16 = (off: number) => view.getUint16(off)
  const tag = u32(0)
  // Valid OT/TTF magic numbers.
  // 0x00010000 = TrueType; 0x4F54544F = 'OTTO' (CFF/OpenType);
  // 0x74727565 = 'true' (legacy Apple); 0x74746366 = 'ttcf' (collection).
  if (
    tag !== 0x00010000 &&
    tag !== 0x4F54544F &&
    tag !== 0x74727565
  ) {
    return null
  }
  const numTables = u16(4)
  // Find the cmap table.
  let cmapOffset = -1
  for (let i = 0; i < numTables; i++) {
    const recordOff = 12 + i * 16
    const tableTag = u32(recordOff)
    if (tableTag === 0x636D6170) {
      // 'cmap'
      cmapOffset = u32(recordOff + 8)
      break
    }
  }
  if (cmapOffset < 0) return null

  const numSubtables = u16(cmapOffset + 2)
  for (let i = 0; i < numSubtables; i++) {
    const recOff = cmapOffset + 4 + i * 8
    const subOffset = cmapOffset + u32(recOff + 4)
    const format = u16(subOffset)
    if (format === 4) {
      // Segment-mapped format — BMP only.
      const segCountX2 = u16(subOffset + 6)
      const segCount = segCountX2 / 2
      const endCodesOff = subOffset + 14
      const startCodesOff = endCodesOff + segCountX2 + 2
      for (let s = 0; s < segCount; s++) {
        const end = u16(endCodesOff + s * 2)
        const start = u16(startCodesOff + s * 2)
        if (end === 0xFFFF && start === 0xFFFF) continue
        for (let cp = start; cp <= end; cp++) cov.add(cp)
      }
    } else if (format === 12) {
      // Segmented coverage — supports full Unicode range.
      const numGroups = u32(subOffset + 12)
      for (let g = 0; g < numGroups; g++) {
        const groupOff = subOffset + 16 + g * 12
        const start = u32(groupOff)
        const end = u32(groupOff + 4)
        for (let cp = start; cp <= end; cp++) cov.add(cp)
      }
    }
    // Other formats (0, 2, 6, 14) skipped — extremely rare on web.
  }

  return cov.size > 0 ? cov : null
}

/**
 * Check whether every codepoint in `text` is covered by at least one
 * of the loaded fonts' `cmap` tables. Returns the list of *missing*
 * codepoints (empty array = fully covered) so callers can highlight
 * them or write a specific warning.
 *
 * If NONE of the fonts could have their coverage parsed (Type1 stack,
 * corrupt bytes, etc.) this returns an empty array — "no info, assume
 * ok" is less noisy than false alarms.
 */
export function subsetCoversText(
  text: string,
  fontsWithBytes: { bytes: Uint8Array }[],
): number[] {
  const merged = new Set<number>()
  let anyParsed = false
  for (const f of fontsWithBytes) {
    const cp = codepointsFromFontBytes(f.bytes)
    if (cp) {
      anyParsed = true
      for (const c of cp) merged.add(c)
    }
  }
  if (!anyParsed) return [] // no coverage info, assume ok
  const missing: number[] = []
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    if (cp == null) continue
    if (!merged.has(cp)) missing.push(cp)
  }
  return missing
}

const FALLBACK_STACK = `-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif`

/**
 * React hook: extract embedded fonts for a page, register them with
 * the browser via FontFace, return a stack string for CSS usage.
 *
 * Handles the lifecycle of FontFace registration: de-registers any
 * fonts loaded by a previous render when the input changes, so the
 * document's font set stays bounded.
 */
export function useEmbeddedFonts({
  pdfBytes,
  pageIndex,
  enabled = true,
}: UseEmbeddedFontsInput): UseEmbeddedFontsOutput {
  const [fonts, setFonts] = useState<LoadedFontHandle[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled || !pdfBytes || pdfBytes.byteLength === 0) {
      return
    }
    let cancelled = false
    setLoading(true)
    // Keep track of registered FontFaces so we can de-register on
    // cleanup — unbounded document.fonts growth would hurt
    // memory + font-matching performance.
    const registered: FontFace[] = []

    ;(async () => {
      try {
        const extracted = await invoke<EngineExtractedFont[]>(
          'engine_extract_page_fonts_from_bytes',
          {
            bytes: Array.from(pdfBytes),
            pageIndex,
          },
        )
        if (cancelled) return

        const handles: LoadedFontHandle[] = []
        for (const e of extracted) {
          // Type1 is unusable in browsers — skip silently.
          if (e.format === 'Type1') continue
          const family = stripSubsetPrefix(e.psName)
          const bytes = e.bytes instanceof Uint8Array
            ? e.bytes
            : new Uint8Array(e.bytes)
          try {
            const face = new FontFace(family, bytes.buffer, {
              style: 'normal',
              weight: '400',
              display: 'swap',
            })
            await face.load()
            if (cancelled) break
            document.fonts.add(face)
            registered.push(face)
            handles.push({
              face,
              psName: e.psName,
              family,
              subsetted: isSubsetted(e.psName),
            })
          } catch (faceErr) {
            // One bad font shouldn't tank the whole set. Log + skip.
            console.warn(`[useEmbeddedFonts] skipped ${e.psName}:`, faceErr)
          }
        }
        if (!cancelled) {
          setFonts(handles)
          setError(null)
        }
      } catch (e: unknown) {
        if (cancelled) return
        const msg = e instanceof Error ? e.message : String(e)
        console.warn('[useEmbeddedFonts] extraction failed:', msg)
        setError(msg)
        setFonts([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
      for (const face of registered) {
        try {
          document.fonts.delete(face)
        } catch {
          /* noop */
        }
      }
    }
  }, [pdfBytes, pageIndex, enabled])

  const fontStack = useMemo(() => {
    if (fonts.length === 0) return FALLBACK_STACK
    const quoted = fonts.map((f) => `'${f.family.replace(/'/g, "\\'")}'`).join(', ')
    return `${quoted}, ${FALLBACK_STACK}`
  }, [fonts])

  return { fonts, fontStack, loading, error }
}
