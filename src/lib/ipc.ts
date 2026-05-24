// Thin typed wrapper around Tauri's `invoke`. Replaces the Electron
// `window.api.*` surface. Each exported function corresponds 1:1 to a
// #[tauri::command] in src-tauri/src/commands/.

import { invoke } from '@tauri-apps/api/core'

// ── Types mirror the Rust structs ────────────────────────────────────

export interface LoadedFile {
  path: string
  name: string
  bytes: number[] // serde serializes Vec<u8> as a JSON array of numbers
  size: number
}

export interface RecentEntry {
  path: string
  name: string
  format: string
  last_opened: number
}

export interface RenderedPage {
  width: number
  height: number
  png_bytes: number[]
}

// Small helper: convert the array-of-numbers bytes we get back from Tauri
// into a proper Uint8Array without a full copy loop.
export function bytesToUint8Array(bytes: number[]): Uint8Array {
  return Uint8Array.from(bytes)
}

// ── File ─────────────────────────────────────────────────────────────

export const fileApi = {
  async open(): Promise<LoadedFile | null> {
    return invoke<LoadedFile | null>('open_file_dialog')
  },
  async openPath(path: string): Promise<LoadedFile> {
    return invoke<LoadedFile>('open_file_path', { path })
  },
  async save(path: string, bytes: Uint8Array): Promise<void> {
    return invoke<void>('save_file', { path, bytes: Array.from(bytes) })
  },
  async saveAs(bytes: Uint8Array, suggestedName?: string): Promise<string | null> {
    return invoke<string | null>('save_file_dialog', {
      bytes: Array.from(bytes),
      suggestedName: suggestedName ?? null,
    })
  },
  async pickFolder(extensions?: string[], maxFiles?: number): Promise<LoadedFile[] | null> {
    return invoke<LoadedFile[] | null>('pick_folder', {
      extensions: extensions ?? null,
      maxFiles: maxFiles ?? null,
    })
  },
  /** Pick a folder + return ONLY its absolute path. Lighter than
   *  pickFolder for callers that just need the directory (folder
   *  favorites, scoped open-file dialogs). Returns null if the
   *  user cancels. */
  async pickFolderPath(): Promise<string | null> {
    return invoke<string | null>('pick_folder_path')
  },
  async hash(path: string): Promise<string> {
    return invoke<string>('hash_file', { path })
  },
}

// ── Recent ───────────────────────────────────────────────────────────

export const recentApi = {
  async get(): Promise<RecentEntry[]> {
    return invoke<RecentEntry[]>('recent_get')
  },
  async add(path: string, name: string, format: string): Promise<RecentEntry[]> {
    return invoke<RecentEntry[]>('recent_add', { path, name, format })
  },
  async remove(path: string): Promise<RecentEntry[]> {
    return invoke<RecentEntry[]>('recent_remove', { path })
  },
  async clear(): Promise<void> {
    return invoke<void>('recent_clear')
  },
}

// ── Folder favorites (localStorage, browser-mode safe) ───────────────

const FOLDER_FAVS_KEY = 'open-satchel:folder-favorites'

/** Folder favorites API. Stores absolute folder paths the user pins
 *  for quick access on the empty state. Browser- and Tauri-mode
 *  identical because both run with the same WebView2 user-data dir. */
export const folderFavoritesApi = {
  get(): string[] {
    try {
      const raw = localStorage.getItem(FOLDER_FAVS_KEY)
      if (!raw) return []
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string') : []
    } catch {
      return []
    }
  },
  add(path: string): string[] {
    const set = new Set(this.get())
    set.add(path)
    const list = [...set]
    try {
      localStorage.setItem(FOLDER_FAVS_KEY, JSON.stringify(list))
    } catch {
      /* quota — fail silently */
    }
    return list
  },
  remove(path: string): string[] {
    const list = this.get().filter((p) => p !== path)
    try {
      localStorage.setItem(FOLDER_FAVS_KEY, JSON.stringify(list))
    } catch {
      /* quota */
    }
    return list
  },
  clear(): void {
    try {
      localStorage.removeItem(FOLDER_FAVS_KEY)
    } catch {
      /* unavailable */
    }
  },
}

/** Best-effort dirname for a Windows / POSIX path. Pure string op
 *  so it works in browser mode without Tauri's path module. */
export function dirnameOf(filePath: string): string {
  if (!filePath) return ''
  // Strip trailing separator if any.
  const trimmed = filePath.replace(/[\\/]+$/, '')
  const sep = trimmed.includes('\\') ? '\\' : '/'
  const idx = trimmed.lastIndexOf(sep)
  if (idx <= 0) return trimmed
  return trimmed.slice(0, idx)
}

// ── Pinned recents (localStorage, browser-mode safe) ─────────────────

const PINNED_KEY = 'open-satchel:pinned-recents'

/** Pinned-recents API. Stores a flat array of file paths in
 *  localStorage; the EmptyState reads this set to filter the recents
 *  list into "Pinned" + "Recent" sections. Browser- and Tauri-mode
 *  identical because the WebView2 user-data dir persists localStorage
 *  per-app across launches. */
export const pinnedApi = {
  get(): string[] {
    try {
      const raw = localStorage.getItem(PINNED_KEY)
      if (!raw) return []
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string') : []
    } catch {
      return []
    }
  },
  pin(path: string): string[] {
    const set = new Set(this.get())
    set.add(path)
    const list = [...set]
    try {
      localStorage.setItem(PINNED_KEY, JSON.stringify(list))
    } catch {
      /* quota — fail silently, transient state */
    }
    return list
  },
  unpin(path: string): string[] {
    const list = this.get().filter((p) => p !== path)
    try {
      localStorage.setItem(PINNED_KEY, JSON.stringify(list))
    } catch {
      /* quota */
    }
    return list
  },
  isPinned(path: string): boolean {
    return this.get().includes(path)
  },
  clear(): void {
    try {
      localStorage.removeItem(PINNED_KEY)
    } catch {
      /* unavailable */
    }
  },
}

// ── PDF (stubs in M1, real in M2+) ───────────────────────────────────

export const pdfApi = {
  async pageCount(bytes: Uint8Array): Promise<number> {
    return invoke<number>('pdf_page_count', { bytes: Array.from(bytes) })
  },
  async renderPage(bytes: Uint8Array, pageIndex: number, scale: number): Promise<RenderedPage> {
    return invoke<RenderedPage>('pdf_render_page', {
      bytes: Array.from(bytes),
      pageIndex,
      scale,
    })
  },
  async extractText(bytes: Uint8Array, pageIndex: number): Promise<string> {
    return invoke<string>('pdf_extract_text', {
      bytes: Array.from(bytes),
      pageIndex,
    })
  },
}

// ── App ──────────────────────────────────────────────────────────────

export const appApi = {
  async version(): Promise<string> {
    return invoke<string>('app_version')
  },
}
