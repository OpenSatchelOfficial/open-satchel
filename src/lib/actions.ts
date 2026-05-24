// High-level app actions invoked from the toolbar, shortcuts, and command
// palette. Keep these side-effectful and UI-aware so UI components stay lean.
//
// All IPC goes through `window.api.*` (installed by electron-api-shim.ts),
// which is dual-mode: Tauri in production/dev, browser fallbacks in
// manual browser testing. Do NOT import from lib/ipc.ts here — it
// calls Tauri invoke directly and would bypass browser mode.

import { useTabStore } from '../stores/tabStore'
import { useFormatStore } from '../stores/formatStore'
import { detectFormat } from '../types/tabs'
import { getHandler, getHandlerForExtension } from '../formats/registry'
import { isEncrypted, removeEncryption } from '../services/pdfCrypto'

export interface EncryptedPdfOpenRequest {
  id: string
  path: string
  name: string
  bytes: Uint8Array
}

export interface EncryptedPdfOpenResult {
  tabId: string
  path: string
  name: string
  encrypted: boolean
  decryptedBytes: number
  sourceBytes: number
}

type EncryptedPdfOpenHandler = (request: EncryptedPdfOpenRequest) => void

let encryptedPdfOpenHandler: EncryptedPdfOpenHandler | null = null
let encryptedPdfOpenSeq = 0

export function setEncryptedPdfOpenHandler(handler: EncryptedPdfOpenHandler | null): () => void {
  encryptedPdfOpenHandler = handler
  return () => {
    if (encryptedPdfOpenHandler === handler) encryptedPdfOpenHandler = null
  }
}

export async function openFile(): Promise<void> {
  const loaded = await window.api.file.open()
  if (!loaded) return
  const name = loaded.path.split(/[/\\]/).pop() ?? loaded.path
  await openLoadedOrEncryptedPdf(loaded.path, name, loaded.bytes)
}

// Open a file from a known path. If bytes are passed, skip the disk read —
// callers that just produced the bytes (merge output, convert output) can
// pass them directly to avoid a round-trip through the OS file cache.
export async function openFromPath(path: string, preloadedBytes?: Uint8Array): Promise<void> {
  if (preloadedBytes) {
    const name = path.split(/[/\\]/).pop() ?? path
    await openLoadedOrEncryptedPdf(path, name, preloadedBytes)
    return
  }
  const loaded = await window.api.file.openPath(path)
  const name = loaded.path.split(/[/\\]/).pop() ?? loaded.path
  await openLoadedOrEncryptedPdf(loaded.path, name, loaded.bytes)
}

async function openLoadedOrEncryptedPdf(path: string, name: string, bytes: Uint8Array): Promise<void> {
  if (detectFormat(path) === 'pdf' && isEncrypted(bytes)) {
    if (!encryptedPdfOpenHandler) {
      throw new Error('This PDF is encrypted and needs a password before it can be opened.')
    }
    encryptedPdfOpenHandler({
      id: `encrypted-open-${++encryptedPdfOpenSeq}`,
      path,
      name,
      bytes,
    })
    return
  }
  await openLoadedFile(path, name, bytes)
}

export async function openEncryptedPdfRequest(
  request: EncryptedPdfOpenRequest,
  password: string,
): Promise<EncryptedPdfOpenResult> {
  return openEncryptedLoadedPdf(request.path, request.name, request.bytes, password)
}

export async function openEncryptedPdfFromPath(
  path: string,
  password: string,
): Promise<EncryptedPdfOpenResult> {
  const loaded = await window.api.file.openPath(path)
  const name = loaded.path.split(/[/\\]/).pop() ?? loaded.path
  return openEncryptedLoadedPdf(loaded.path, name, loaded.bytes, password)
}

function normalizeOpenPassword(password: string): string {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('Password required to open encrypted PDF.')
  }
  return password
}

function encryptedOpenError(err: unknown): Error {
  const raw = err instanceof Error ? err.message : String(err)
  if (/AES-256 revision|qpdf/i.test(raw)) {
    return new Error(raw)
  }
  return new Error(`Could not unlock this PDF with that password. ${raw}`)
}

async function openEncryptedLoadedPdf(
  path: string,
  name: string,
  bytes: Uint8Array,
  passwordInput: string,
): Promise<EncryptedPdfOpenResult> {
  const password = normalizeOpenPassword(passwordInput)
  if (detectFormat(path) !== 'pdf') {
    throw new Error('Encrypted open is only supported for PDF files.')
  }
  if (!isEncrypted(bytes)) {
    const tabId = await openLoadedFile(path, name, bytes)
    return {
      tabId,
      path,
      name,
      encrypted: false,
      decryptedBytes: bytes.byteLength,
      sourceBytes: bytes.byteLength,
    }
  }

  let decrypted: Uint8Array
  try {
    decrypted = await removeEncryption(bytes, password)
  } catch (err) {
    throw encryptedOpenError(err)
  }

  const tabId = await openLoadedFile(path, name, decrypted)
  useFormatStore.getState().updateFormatState<any>(tabId, (prev) => ({
    ...prev,
    _openedEncryptedSource: true,
    encryption: {
      ...(prev?.encryption ?? {}),
      userPassword: password,
      ownerPassword: prev?.encryption?.ownerPassword ?? password,
      algorithm: prev?.encryption?.algorithm ?? 'AES_256',
    },
  }))
  return {
    tabId,
    path,
    name,
    encrypted: true,
    decryptedBytes: decrypted.byteLength,
    sourceBytes: bytes.byteLength,
  }
}

async function openLoadedFile(path: string, name: string, bytes: Uint8Array): Promise<string> {
  const format = detectFormat(path)
  if (!format) {
    console.warn(`[open] unknown format for ${path}`)
    throw new Error(`Unknown file format for ${path}`)
  }
  const handler = getHandler(format) ?? getHandlerForExtension(path.split('.').pop() ?? '')
  if (!handler) {
    console.warn(`[open] no handler registered for format ${format}`)
    throw new Error(`No handler registered for format ${format}`)
  }

  const wasAlreadyOpen = useTabStore.getState().tabs.some((t) => t.filePath === path)
  const tabId = useTabStore.getState().openTab(path, name, format)
  try {
    await handler.load(tabId, bytes, path)
  } catch (err) {
    if (!wasAlreadyOpen) useTabStore.getState().closeTab(tabId)
    throw err
  }
  try {
    await window.api.recent.add(path, name, format)
  } catch (err) {
    console.warn('[recent] add failed', err)
  }
  return tabId
}

export async function saveActiveTab(): Promise<void> {
  const { activeTabId, tabs, setTabDirty } = useTabStore.getState()
  if (!activeTabId) return
  const tab = tabs.find((t) => t.id === activeTabId)
  if (!tab) return
  const handler = getHandler(tab.format)
  if (!handler) return

  // Fast no-op for explicit Ctrl+S on a clean tab. Without this guard
  // we'd invoke pdfHandler.save (which returns state.pdfBytes verbatim
  // for empty edit sets) and then marshal those bytes through the
  // Tauri IPC + JSON-array conversion + disk write — typically 0.5-2s
  // for a 5MB file. Editors like VS Code treat Ctrl+S on a clean
  // buffer as a no-op; match that.
  if (!tab.isDirty && tab.filePath) {
    return
  }

  const t0 = performance.now()
  const bytes = await handler.save(activeTabId)
  const tHandlerSave = performance.now()
  if (tab.filePath) {
    await window.api.file.save(bytes, tab.filePath)
    const tDiskWrite = performance.now()
    if (tDiskWrite - t0 > 500) {
      console.log(
        `[saveActiveTab] slow save: handler=${(tHandlerSave - t0).toFixed(0)}ms ` +
        `disk=${(tDiskWrite - tHandlerSave).toFixed(0)}ms ` +
        `bytes=${bytes.byteLength}`,
      )
    }
    setTabDirty(activeTabId, false)
  } else {
    await saveActiveTabAs()
  }
}

export async function saveActiveTabAs(): Promise<void> {
  const { activeTabId, tabs, setTabDirty, setTabFilePath } = useTabStore.getState()
  if (!activeTabId) return
  const tab = tabs.find((t) => t.id === activeTabId)
  if (!tab) return
  const handler = getHandler(tab.format)
  if (!handler) return

  const bytes = await handler.save(activeTabId)
  const newPath = await window.api.file.saveAs(bytes)
  if (!newPath) return

  const newName = newPath.split(/[/\\]/).pop() ?? tab.fileName
  setTabFilePath(activeTabId, newPath, newName)
  setTabDirty(activeTabId, false)
  try {
    await window.api.recent.add(newPath, newName, tab.format)
  } catch (err) {
    console.warn('[recent] add failed', err)
  }
}

// Save a specific tab by id. Used by useAutoSave and anywhere else that
// needs to save a non-active tab (e.g. "save all").
export async function saveTabById(tabId: string): Promise<void> {
  const { tabs, setTabDirty } = useTabStore.getState()
  const tab = tabs.find((t) => t.id === tabId)
  if (!tab) return
  const handler = getHandler(tab.format)
  if (!handler) return
  const bytes = await handler.save(tabId)
  if (tab.filePath) {
    await window.api.file.save(bytes, tab.filePath)
    setTabDirty(tabId, false)
  }
}

export function closeActiveTab(): void {
  const { activeTabId, closeTab } = useTabStore.getState()
  if (!activeTabId) return
  const format = useFormatStore.getState()
  // Clean up the format state first, then close the tab.
  const tab = useTabStore.getState().tabs.find((t) => t.id === activeTabId)
  if (tab) {
    const handler = getHandler(tab.format)
    handler?.cleanup?.(activeTabId)
  }
  format.clearFormatState(activeTabId)
  closeTab(activeTabId)
}
