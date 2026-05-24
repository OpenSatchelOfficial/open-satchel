// High-fidelity PDF → Office conversion via an installed LibreOffice.
//
// Our built-in pdfjs-based converters (pdfToWord, pdfToExcel, pdfToPpt)
// are positioned-text-run approximations. Fidelity is ~30-60% depending
// on layout complexity — fine for text-heavy docs, breaks on multi-
// column or table-heavy PDFs.
//
// LibreOffice's PDF import is positioned-text-box-grid based — not
// paragraph-flow, but materially better for complex layouts. Fidelity
// ceiling ~60-65%. We ship nothing (LO is 300+ MB); user must have it
// installed. Detection runs on demand; if LO isn't present we fall
// back to the built-in converter with a warning.
//
// Tauri-only feature. Browser mode always uses the built-ins.

import { invoke } from '@tauri-apps/api/core'

export interface LibreOfficeInfo {
  available: boolean
  path: string | null
  version: string | null
}

const isTauri = typeof (globalThis as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined'

let _detectionCache: LibreOfficeInfo | null = null

/** Cached detection — LO doesn't get installed/uninstalled mid-session,
 *  so caching the result avoids 300-400ms per export after the first. */
export async function detectLibreOffice(): Promise<LibreOfficeInfo> {
  if (!isTauri) return { available: false, path: null, version: null }
  if (_detectionCache) return _detectionCache
  try {
    const info = await invoke<LibreOfficeInfo>('libreoffice_detect')
    _detectionCache = info
    return info
  } catch {
    const fallback: LibreOfficeInfo = { available: false, path: null, version: null }
    _detectionCache = fallback
    return fallback
  }
}

export type OfficeTarget = 'docx' | 'xlsx' | 'pptx' | 'rtf' | 'html' | 'odt' | 'ods' | 'odp' | 'txt'

/** Convert via LO. Throws if LO isn't installed or the shell-out fails.
 *  Callers should usually use `convertPdfHighFidelity` which falls
 *  back to the built-in converter when LO isn't available. */
export async function libreOfficeConvert(bytes: Uint8Array, target: OfficeTarget): Promise<Uint8Array> {
  if (!isTauri) throw new Error('LibreOffice sidecar requires the Tauri build.')
  const raw = await invoke<number[]>('libreoffice_convert', {
    bytes: Array.from(bytes),
    targetFormat: target,
  })
  return Uint8Array.from(raw)
}

/** Convert using the best available engine — LO if installed for docx/
 *  xlsx/pptx, otherwise our built-in pdfjs-based converters. Returns a
 *  metadata field so UI can surface which engine was used (corps care). */
export interface ConvertResult {
  bytes: Uint8Array
  engine: 'libreoffice' | 'builtin'
  format: OfficeTarget
  /** Present when engine === 'libreoffice'. */
  libreOfficeVersion?: string
}

export async function convertPdfHighFidelity(
  bytes: Uint8Array,
  target: OfficeTarget,
  opts: { preferBuiltin?: boolean } = {},
): Promise<ConvertResult> {
  const lo = await detectLibreOffice()

  if (lo.available && !opts.preferBuiltin && isSupportedByLo(target)) {
    try {
      const out = await libreOfficeConvert(bytes, target)
      return {
        bytes: out,
        engine: 'libreoffice',
        format: target,
        libreOfficeVersion: lo.version ?? undefined,
      }
    } catch (e) {
      console.warn('[pdfToOffice] LibreOffice convert failed, falling back to built-in:', e)
      // Fall through to built-in
    }
  }

  // Built-in fallback
  const out = await runBuiltin(bytes, target)
  return { bytes: out, engine: 'builtin', format: target }
}

function isSupportedByLo(t: OfficeTarget): boolean {
  return ['docx', 'xlsx', 'pptx', 'rtf', 'html', 'odt', 'ods', 'odp', 'txt'].includes(t)
}

async function runBuiltin(bytes: Uint8Array, target: OfficeTarget): Promise<Uint8Array> {
  switch (target) {
    case 'docx': {
      const { pdfToWord } = await import('./pdfToWord')
      return await pdfToWord(bytes)
    }
    case 'xlsx': {
      const { pdfToExcel } = await import('./pdfConvert')
      return await pdfToExcel(bytes)
    }
    case 'pptx': {
      const { pdfToPpt } = await import('./pdfConvert')
      return await pdfToPpt(bytes)
    }
    case 'txt': {
      const { pdfToText } = await import('./pdfConvert')
      const text = await pdfToText(bytes)
      return new TextEncoder().encode(text)
    }
    case 'rtf':
    case 'html':
    case 'odt':
    case 'ods':
    case 'odp':
      throw new Error(`Built-in fallback doesn't support ${target}. Install LibreOffice for this format.`)
  }
}
