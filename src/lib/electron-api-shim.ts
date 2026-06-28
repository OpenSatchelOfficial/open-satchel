// Electron `window.api` shim with dual-mode environment detection.
//
// Tauri runtime (production + `npm run tauri:dev`): every call routes
// through Tauri's IPC via `invoke`. Real OS dialogs, real filesystem,
// real Rust commands.
//
// Browser runtime (`npm run dev` hit from Chrome/Zen/anywhere): swaps
// in in-browser fallbacks so the entire PDF editor runs without Tauri.
// File open uses <input type="file">, save triggers a blob download,
// recent files live in localStorage, etc. Lets us drive the app with
// zenlink/Playwright/manual testing against `http://localhost:1420/`
// without spinning up Tauri for every iteration.
//
// The ported PDF codebase (formats/pdf/**, services/*) only ever talks
// to `window.api.*`. This file is the only place that knows which
// runtime we're in; every other file stays runtime-agnostic.
//
// Test automation helpers exposed on window in browser mode only:
//   window.__loadTestPdf(path): fetch+open a PDF from Vite's public dir
//   window.__lastSave:          Uint8Array of the most recent saveAs call
//   window.__lastSavedName:     the file name from the most recent saveAs
//   window.__triggerFilePicker: bypass the <input> element with a File

import { invoke } from '@tauri-apps/api/core'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { readFile as fsReadFile, writeFile as fsWriteFile } from '@tauri-apps/plugin-fs'
import { PDFDocument } from 'pdf-lib'

// ── Environment detection ───────────────────────────────────────────
// Tauri injects __TAURI_INTERNALS__ on the global scope at boot, well
// before our app code runs. Checking for it is the canonical way to
// detect which shell we're in.
const isTauri = typeof (globalThis as unknown as { __TAURI_INTERNALS__?: unknown })
  .__TAURI_INTERNALS__ !== 'undefined'

/** LoadedFile shape as returned by Rust `LoadedFile` struct. */
interface LoadedFileRust {
  path: string
  name: string
  bytes: number[]
  size: number
}

function toBytes(b: number[] | Uint8Array): Uint8Array {
  if (b instanceof Uint8Array) return b
  return Uint8Array.from(b)
}

function fromBytes(b: Uint8Array): number[] {
  return Array.from(b)
}

interface FilePair {
  bytes: Uint8Array
  path: string
}

interface RecentEntry {
  path: string
  name: string
  format: string
  lastOpened: number
}

// ══════════════════════════════════════════════════════════════════
//  TAURI IMPLEMENTATIONS
// ══════════════════════════════════════════════════════════════════

// Read raw bytes from disk via the Tauri 2 plugin-fs binary IPC
// channel. This is materially faster than `invoke('open_file_path')`
// for large files because plugin-fs streams Uint8Array directly
// instead of marshalling Vec<u8> as a JSON array of numbers (which
// inflates to ~3× the byte count over the bridge and hits a hot
// JSON.parse on the JS side). For a 32MB PDF the difference is ~7s
// (JSON path) vs ~150ms (binary path) on the dev machine. Used as
// the open path for both the dialog flow and openPath; falls back
// to the legacy invoke path on any plugin-fs error so existing
// capabilities-restricted setups still work.
//
// fsReadFile is imported eagerly at the top of this file so the
// FIRST call doesn't pay dynamic-import cost (~3 s in dev with HMR).
async function readBytesFast(path: string): Promise<Uint8Array> {
  try {
    return await fsReadFile(path)
  } catch (err) {
    console.warn(
      '[file.openPath] plugin-fs readFile failed, falling back to invoke:',
      (err as Error)?.message,
    )
    const r = await invoke<LoadedFileRust>('open_file_path', { path })
    return toBytes(r.bytes)
  }
}

const tauriFile = {
  async open(): Promise<FilePair | null> {
    // Use the Rust dialog to get JUST the path — no bytes ever cross
    // the JSON-array IPC. The legacy `open_file_dialog` command
    // returned `LoadedFile { bytes: Vec<u8> }` which Tauri 2's
    // default invoke encoding marshals as a JSON-array of N numbers.
    // On a 33 MB PDF that's ~150 MB of JSON string + V8 boxing — it
    // OOMs the WebView (verified on brand-guidelines.pdf, 33 MB).
    //
    // `pick_open_path` returns just the path; we then read bytes via
    // plugin-fs's binary IPC channel.
    const path = await invoke<string | null>('pick_open_path')
    if (!path) return null
    const bytes = await readBytesFast(path)
    return { path, bytes }
  },
  async openPath(path: string): Promise<FilePair> {
    const bytes = await readBytesFast(path)
    return { path, bytes }
  },
  async save(bytes: Uint8Array, path: string): Promise<void> {
    // Route through tauri-plugin-fs's writeFile rather than our
    // `save_file` Tauri command. The latter takes Vec<u8>, which
    // forces us to convert Uint8Array → Array.from(bytes) on the JS
    // side; Tauri 2's default invoke encoding then JSON-stringifies
    // that array of N numbers (~5× larger on the wire than the raw
    // binary path) and V8 pays ~hundreds of ms of boxing overhead
    // per MB. plugin-fs.writeFile sends the Uint8Array via Tauri's
    // binary IPC channel — measured 10–20× faster on multi-MB
    // payloads, which on a 5MB caribbean-star save means ~50ms
    // instead of "a hot second". See [perf sprint Item C].
    //
    // Imported eagerly at module top so the FIRST save doesn't pay
    // dynamic-import cost (measured ~3s in dev with HMR + chunks).
    await fsWriteFile(path, bytes)
  },
  async saveAs(bytes: Uint8Array, suggestedName?: string): Promise<string | null> {
    // Pick the path via the dedicated `pick_save_path` Rust command
    // (returns the chosen path with no write), then route the write
    // through plugin-fs.writeFile to bypass the JSON-array marshal.
    // Same rationale as `save` above.
    const picked = await invoke<string | null>('pick_save_path', {
      suggestedName: suggestedName ?? null,
    })
    if (!picked) return null
    await fsWriteFile(picked, bytes)
    return picked
  },
  async openMultiple(): Promise<FilePair[] | null> {
    const picked = await openDialog({ multiple: true })
    if (!picked) return null
    const paths = Array.isArray(picked) ? picked : [picked]
    const out: FilePair[] = []
    for (const entry of paths) {
      const p = typeof entry === 'string' ? entry : (entry as { path: string }).path
      const r = await invoke<LoadedFileRust>('open_file_path', { path: p })
      out.push({ path: r.path, bytes: toBytes(r.bytes) })
    }
    return out
  },
  async pickImages(): Promise<{ bytes: Uint8Array; name: string }[] | null> {
    const picked = await openDialog({
      multiple: true,
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico'] }],
    })
    if (!picked) return null
    const paths = Array.isArray(picked) ? picked : [picked]
    const out: { bytes: Uint8Array; name: string }[] = []
    for (const entry of paths) {
      const p = typeof entry === 'string' ? entry : (entry as { path: string }).path
      const r = await invoke<LoadedFileRust>('open_file_path', { path: p })
      out.push({ bytes: toBytes(r.bytes), name: r.name })
    }
    return out
  },
}

interface WatchedFolderRust {
  id: string
  path: string
  action_json_path: string | null
  enabled: boolean
}

const tauriFolder = {
  async pick(
    extensions?: string[],
  ): Promise<{ path: string; name: string; bytes: Uint8Array }[] | null> {
    const r = await invoke<LoadedFileRust[] | null>('pick_folder', {
      extensions: extensions ?? null,
      maxFiles: null,
    })
    if (!r) return null
    return r.map((f) => ({ path: f.path, name: f.name, bytes: toBytes(f.bytes) }))
  },
  async watch(path: string, actionJsonPath: string | null) {
    const r = await invoke<WatchedFolderRust>('watch_folder', { path, actionJsonPath })
    return { id: r.id, path: r.path, actionJsonPath: r.action_json_path, enabled: r.enabled }
  },
  async unwatch(id: string) {
    await invoke('unwatch_folder', { id })
  },
  async listWatched() {
    const rs = await invoke<WatchedFolderRust[]>('list_watched_folders')
    return rs.map((r) => ({ id: r.id, path: r.path, actionJsonPath: r.action_json_path, enabled: r.enabled }))
  },
}

const tauriRecent = {
  async get(): Promise<RecentEntry[]> {
    const rs = await invoke<Array<{ path: string; name: string; format: string; last_opened: number }>>('recent_get')
    return rs.map((r) => ({ path: r.path, name: r.name, format: r.format, lastOpened: r.last_opened * 1000 }))
  },
  async add(path: string, name: string, format: string): Promise<void> {
    await invoke('recent_add', { path, name, format })
  },
  async remove(path: string): Promise<void> {
    await invoke('recent_remove', { path })
  },
  async clear(): Promise<void> {
    await invoke('recent_clear')
  },
}

interface FontInfoRust {
  id: string
  name: string
  family: string
  style: string
  file_name: string
  path: string
  source: 'system' | 'imported'
}
function adaptFontEntry(f: FontInfoRust) {
  return { id: f.id, name: f.name, fileName: f.file_name, style: f.style }
}

const tauriFont = {
  async list() {
    const imported = await invoke<FontInfoRust[]>('font_imported_list').catch(() => [])
    return imported.map(adaptFontEntry)
  },
  async listSystem() {
    const system = await invoke<FontInfoRust[]>('font_list_system').catch(() => [])
    return system.map((f) => ({ id: f.id, name: f.name, family: f.family, style: f.style, fileName: f.file_name }))
  },
  async import() {
    const r = await invoke<FontInfoRust | null>('font_import_file')
    return r ? adaptFontEntry(r) : null
  },
  async getBytes(fontId: string) {
    const raw = await invoke<number[]>('font_get_bytes', { id: fontId })
    return Uint8Array.from(raw)
  },
  async subset(fontId: string, _glyphs: string) {
    return this.getBytes(fontId)
  },
  /**
   * Subset arbitrary font bytes to only the glyphs required by the given
   * text. Replaces pd-lib's built-in subsetter for CJK / Arabic where
   * pd-lib produces garbage output (drops cmap glyphs + mangles GSUB).
   * Returns the subsetted TTF/OTF bytes ready for embedding.
   */
  async subsetBytes(bytes: Uint8Array, text: string): Promise<Uint8Array> {
    const codepoints: number[] = []
    for (const ch of text) {
      const cp = ch.codePointAt(0)
      if (cp !== undefined) codepoints.push(cp)
    }
    const raw = await invoke<number[]>('font_subset', {
      bytes: fromBytes(bytes),
      codepoints,
    })
    return Uint8Array.from(raw)
  },
  async remove(id: string) {
    if (!id.startsWith('imported:')) return
    await invoke('font_imported_remove', { id })
  },
  async scanPdf(bytes: Uint8Array) {
    const raw = await invoke<Array<{ ps_name: string; family: string; subsetted: boolean }>>(
      'font_scan_pdf',
      { bytes: fromBytes(bytes) },
    )
    return raw.map((r) => ({ psName: r.ps_name, family: r.family, subsetted: r.subsetted }))
  },
}

// ══════════════════════════════════════════════════════════════════
//  BROWSER IMPLEMENTATIONS
// ══════════════════════════════════════════════════════════════════
//
// Goals:
//   - file.open()   → <input type="file"> opens the OS file picker
//   - file.openPath → fetch() from public dir (works for test-pdfs/*)
//   - file.save*    → browser download via Blob URL; bytes also captured
//                     on window.__lastSave for automation assertions
//   - recent.*      → localStorage
//   - font.*        → empty lists; no-op imports
//   - folder.pick   → null (browsers don't expose folder roots)
//   - print/capture → window.print() / null
//
// We keep PDF merge/split shared — they're pure pdf-lib and work in
// both runtimes.

async function promptFilePick(options: {
  multiple?: boolean
  accept?: string
}): Promise<File[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    if (options.multiple) input.multiple = true
    if (options.accept) input.accept = options.accept
    input.style.display = 'none'
    // If the user cancels, 'change' never fires on some browsers;
    // resolve to null on focus return as a fallback.
    let resolved = false
    const onChange = () => {
      resolved = true
      const files = input.files ? Array.from(input.files) : null
      document.body.removeChild(input)
      resolve(files)
    }
    input.addEventListener('change', onChange, { once: true })
    window.addEventListener(
      'focus',
      () => {
        setTimeout(() => {
          if (!resolved) {
            document.body.contains(input) && document.body.removeChild(input)
            resolve(null)
          }
        }, 300)
      },
      { once: true },
    )
    document.body.appendChild(input)
    input.click()
  })
}

async function fileToPair(f: File): Promise<FilePair> {
  const bytes = new Uint8Array(await f.arrayBuffer())
  return { path: f.name, bytes }
}

function downloadBytes(bytes: Uint8Array, name: string): string {
  // Stash bytes unconditionally — zenlink/playwright read __lastSave to
  // assert exact output.
  ;(globalThis as unknown as { __lastSave?: Uint8Array; __lastSavedName?: string }).__lastSave = bytes
  ;(globalThis as unknown as { __lastSavedName?: string }).__lastSavedName = name

  // Suppress the blob-download anchor when running under automation.
  // The download gesture can knock extensions (zenlink's content script)
  // off the tab with a "missing host permission" error on the next call.
  // Flip to true from the console (or set localStorage.silentSave=1) to
  // keep saves silent during interactive debugging too.
  const silentByBridge = typeof (globalThis as unknown as { __claudeBridgeVersion?: unknown })
    .__claudeBridgeVersion !== 'undefined'
  const silentByLS = (() => {
    try { return localStorage.getItem('silentSave') === '1' } catch { return false }
  })()
  const silentByGlobal = !!(globalThis as unknown as { __silentSave?: boolean }).__silentSave
  if (silentByBridge || silentByLS || silentByGlobal) return name

  const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return name
}

const browserFile = {
  async open(): Promise<FilePair | null> {
    const files = await promptFilePick({})
    if (!files || files.length === 0) return null
    return fileToPair(files[0])
  },
  async openPath(path: string): Promise<FilePair> {
    // Vite serves any file in the repo root (and particularly in /public
    // and the project root) at its URL path. test-pdfs/foo.pdf is at
    // /test-pdfs/foo.pdf. We fetch it and return bytes.
    const url = path.startsWith('/') || /^https?:/i.test(path) ? path : `/${path}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`openPath(${path}): ${res.status} ${res.statusText}`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    return { path, bytes }
  },
  async save(bytes: Uint8Array, path: string): Promise<void> {
    // In browser mode there's no real overwrite-in-place. Trigger a
    // download with the same name so the user knows the save happened.
    const name = path.split(/[/\\]/).pop() || 'document.pdf'
    downloadBytes(bytes, name)
  },
  async saveAs(bytes: Uint8Array, suggestedName?: string): Promise<string | null> {
    const name = suggestedName
      || (globalThis as unknown as { __lastSavedName?: string }).__lastSavedName
      || `document-${Date.now()}.pdf`
    downloadBytes(bytes, name)
    return name
  },
  async openMultiple(): Promise<FilePair[] | null> {
    const files = await promptFilePick({ multiple: true })
    if (!files) return null
    return Promise.all(files.map(fileToPair))
  },
  async pickImages(): Promise<{ bytes: Uint8Array; name: string }[] | null> {
    const files = await promptFilePick({
      multiple: true,
      accept: 'image/png,image/jpeg,image/gif,image/bmp,image/webp,image/x-icon',
    })
    if (!files) return null
    return Promise.all(
      files.map(async (f) => ({ bytes: new Uint8Array(await f.arrayBuffer()), name: f.name })),
    )
  },
}

const browserFolder = {
  async pick(): Promise<{ path: string; name: string; bytes: Uint8Array }[] | null> {
    // Browsers offer webkitdirectory but exposing that through the same
    // shape as Tauri's folder.pick adds complexity for thin payoff in
    // testing mode. Return null — dialogs that need folder input show
    // their "not supported" state in browser mode.
    return null
  },
  async watch(_path: string, _actionJsonPath: string | null) {
    throw new Error('Hot-folder watch requires the Tauri build.')
  },
  async unwatch(_id: string) {
    // noop — no watches possible in browser mode
  },
  async listWatched() {
    return [] as Array<{ id: string; path: string; actionJsonPath: string | null; enabled: boolean }>
  },
}

// localStorage-backed recent files. Browser mode uses a namespaced key
// so it doesn't collide with anything else.
const RECENT_KEY = 'open-satchel:recent'
function loadBrowserRecent(): RecentEntry[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    if (!raw) return []
    return JSON.parse(raw)
  } catch {
    return []
  }
}
function saveBrowserRecent(list: RecentEntry[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list))
  } catch {
    // quota exceeded or disabled; non-fatal
  }
}
const browserRecent = {
  async get(): Promise<RecentEntry[]> {
    return loadBrowserRecent()
  },
  async add(path: string, name: string, format: string): Promise<void> {
    const list = loadBrowserRecent().filter((e) => e.path !== path)
    list.unshift({ path, name, format, lastOpened: Date.now() })
    saveBrowserRecent(list.slice(0, 50))
  },
  async remove(path: string): Promise<void> {
    saveBrowserRecent(loadBrowserRecent().filter((e) => e.path !== path))
  },
  async clear(): Promise<void> {
    saveBrowserRecent([])
  },
}

const browserFont = {
  async list() {
    return [] as Array<{ id: string; name: string; fileName: string; style: string }>
  },
  async listSystem() {
    return [] as Array<{ id: string; name: string; family: string; style: string; fileName: string }>
  },
  async import() {
    return null as null | { id: string; name: string; fileName: string; style: string }
  },
  async getBytes(_fontId: string) {
    return new Uint8Array()
  },
  async subset(_fontId: string, _glyphs: string) {
    return new Uint8Array()
  },
  async subsetBytes(bytes: Uint8Array, _text: string) {
    // Browser mode: no Rust subsetter available. Return the original
    // bytes unchanged; pd-lib's default path will handle them (poorly
    // for complex scripts, but browser mode is a testing shell anyway).
    return bytes
  },
  async remove(_id: string) {},
  async scanPdf(_bytes: Uint8Array) {
    return [] as Array<{ psName: string; family: string; subsetted: boolean }>
  },
}

// ══════════════════════════════════════════════════════════════════
//  SHARED (identical in both modes)
// ══════════════════════════════════════════════════════════════════

async function pdfMerge(bytesArray: Uint8Array[]): Promise<Uint8Array> {
  const merged = await PDFDocument.create()
  for (const bytes of bytesArray) {
    const src = await PDFDocument.load(bytes)
    const copied = await merged.copyPages(src, src.getPageIndices())
    copied.forEach((p) => merged.addPage(p))
  }
  return new Uint8Array(await merged.save())
}

async function pdfSplit(bytes: Uint8Array, ranges: [number, number][]): Promise<Uint8Array[]> {
  const src = await PDFDocument.load(bytes)
  const out: Uint8Array[] = []
  for (const [start, end] of ranges) {
    const part = await PDFDocument.create()
    const indices: number[] = []
    for (let i = start; i <= end; i++) indices.push(i)
    const copied = await part.copyPages(src, indices)
    copied.forEach((p) => part.addPage(p))
    out.push(new Uint8Array(await part.save()))
  }
  return out
}

async function printPdf(): Promise<boolean> {
  window.print()
  return true
}

async function captureScreen(): Promise<Uint8Array | null> {
  return null
}

function on(_channel: string, _cb: (...args: unknown[]) => void): () => void {
  return () => {}
}

// ══════════════════════════════════════════════════════════════════
//  ASSEMBLE + INSTALL
// ══════════════════════════════════════════════════════════════════

const api = {
  file: isTauri ? tauriFile : browserFile,
  pdf: { merge: pdfMerge, split: pdfSplit },
  recent: isTauri ? tauriRecent : browserRecent,
  font: isTauri ? tauriFont : browserFont,
  folder: isTauri ? tauriFolder : browserFolder,
  print: { pdf: printPdf },
  capture: { screen: captureScreen },
  on,
}

if (typeof window !== 'undefined') {
  ;(window as unknown as { api: typeof api }).api = api
  ;(window as unknown as { __isTauri: boolean }).__isTauri = isTauri

  // Automation helpers only in browser mode — avoid polluting the
  // Tauri window globals with test conveniences.
  if (!isTauri) {
    ;(window as unknown as {
      __loadTestPdf: (path: string) => Promise<void>
    }).__loadTestPdf = async (path: string) => {
      // Dynamic import avoids a circular dep between shim ←→ actions.
      const { openFromPath } = await import('./actions')
      const fileResult = await browserFile.openPath(path)
      const name = path.split(/[/\\]/).pop() || path
      await openFromPath(fileResult.path, fileResult.bytes)
      void name
    }
    // One-line env tag for console / zenlink to verify mode.
    console.info(
      `%cOpen Satchel: browser mode (zenlink/dev testing) — file ops go to <input type="file"> + downloads; recent files in localStorage.`,
      'color:#3b82f6',
    )
  }
}

export type SatchelAPI = typeof api

declare global {
  interface Window {
    api: SatchelAPI
    __isTauri: boolean
    __loadTestPdf?: (path: string) => Promise<void>
    __lastSave?: Uint8Array
    __lastSavedName?: string
  }
}
