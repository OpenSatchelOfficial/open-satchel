// High-level app actions invoked from the toolbar, shortcuts, and command
// palette. Keep these side-effectful and UI-aware so UI components stay lean.
//
// All IPC goes through `window.api.*` (installed by electron-api-shim.ts),
// which is dual-mode: Tauri in production/dev, browser fallbacks in
// zenlink/manual-browser testing. Do NOT import from lib/ipc.ts here — it
// calls Tauri invoke directly and would bypass browser mode.

import { useTabStore } from '../stores/tabStore'
import { useFormatStore } from '../stores/formatStore'
import { withReplay } from '../stores/historyStore'
import { detectFormat } from '../types/tabs'
import { getHandler, getHandlerForExtension } from '../formats/registry'
import { isEncrypted, removeEncryption, readEncryptionPolicy } from '../services/pdfCrypto'
import { printPdfTab } from '../services/pdfPrint'
import { useUIStore } from '../stores/uiStore'
import { countManualRedactions } from '../services/pdfManualRedactions'
import { humanizeDegradation } from '../services/saveDegradations'

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

function saveErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  if (typeof err === 'string' && err.trim()) return err
  try {
    const json = JSON.stringify(err)
    if (json) return json
  } catch {
    /* fall through */
  }
  return String(err)
}

function showSaveFailure(context: string, err: unknown): void {
  const message = saveErrorMessage(err)
  console.error(`[${context}] failed:`, err)
  useUIStore.getState().setSaveNotice({
    tone: 'error',
    message: `Save failed: ${message}`,
    expiresAt: Date.now() + 15000,
  })
}

/** Legal-Guarantee post-save (or post-apply) success toast. A green success
 *  banner with a one-click "re-enable autosave" action that turns LG off and
 *  restores the prior autosave setting (the uiStore setter owns that). Any
 *  notable notices from the save (e.g. dropped page interactivity) ride along
 *  as items beneath the success headline so nothing is hidden by the success.
 *  Exported so BOTH the manual-marks save path and the find-&-redact dialog
 *  (which bakes at Apply) surface the identical lifecycle toast. */
export function showLegalGuaranteeAppliedToast(
  extraItems: Array<{ severity: 'info' | 'fidelity' | 'security'; message: string }> = [],
  hiddenInfoCount = 0,
): void {
  const items = [
    {
      severity: 'info' as const,
      message:
        '✅ Redaction applied permanently — the redacted page(s) were flattened to secured ' +
        'images. The content is destroyed at the pixel level and there is no undo.',
    },
    ...extraItems,
  ]
  useUIStore.getState().setSaveNotice({
    tone: extraItems.some((i) => i.severity === 'security') ? 'error' : 'success',
    message: 'Redaction applied permanently.',
    items,
    hiddenInfoCount,
    action: {
      label: 'Done — re-enable autosave',
      run: () => useUIStore.getState().setLegalGuaranteeRedaction(false),
    },
    // Lingers — the user should get a clear chance to take the autosave action.
    expiresAt: Date.now() + 30000,
  })
}

function showPostSaveWarning(tabId: string): void {
  const state = useFormatStore.getState().getFormatState<any>(tabId)
  // Session-1 channel: the save writes a structured one-shot notice
  // list (security → fidelity → toast-visible info, pre-sorted). The
  // toast shows ALL of them — the old single-string slot could only
  // ever surface the first of two simultaneous degradations.
  const notices = state?._postSaveNotices as
    | Array<{ severity: 'info' | 'fidelity' | 'security'; area: string; detail: string }>
    | undefined
  const lgApplied = !!state?._postSaveLegalGuaranteeApplied
  if (!lgApplied && (!notices || notices.length === 0)) return

  const reportCount = state?._lastSaveReport?.degradations?.length ?? notices?.length ?? 0
  const noticeMsgs = (notices ?? []).map((d) => ({ severity: d.severity, message: humanizeDegradation(d) }))
  const hiddenInfoCount = Math.max(0, reportCount - noticeMsgs.length)

  if (lgApplied) {
    // A committing save flattened redacted pages under Legal Guarantee:
    // surface the permanent-redaction success + re-enable-autosave action,
    // carrying any notable notices as items so they are not lost.
    showLegalGuaranteeAppliedToast(noticeMsgs, hiddenInfoCount)
  } else {
    const highest = notices![0].severity
    useUIStore.getState().setSaveNotice({
      tone: highest === 'security' ? 'error' : highest === 'fidelity' ? 'warn' : 'info',
      message: humanizeDegradation(notices![0]),
      items: noticeMsgs,
      hiddenInfoCount,
      // Security notices linger longer — they must not be missable.
      expiresAt: Date.now() + (highest === 'security' ? 20000 : 12000),
    })
  }
  withReplay(() => {
    useFormatStore.getState().updateFormatState<any>(tabId, (prev) => {
      const { _postSaveNotices, _postSaveLegalGuaranteeApplied, ...rest } = prev as any
      void _postSaveNotices
      void _postSaveLegalGuaranteeApplied
      return rest
    })
  })
}

function pendingRedactionCount(tabId: string): number {
  const tab = useTabStore.getState().tabs.find((t) => t.id === tabId)
  if (!tab || tab.format !== 'pdf') return 0
  return countManualRedactions(useFormatStore.getState().data[tabId] as any)
}

/** Set the one-shot "scrub metadata on this redaction save" flag on the tab's
 *  format state. Wrapped in withReplay so it never pushes an undo entry, and
 *  guarded so it only writes when the value actually changes (avoid store
 *  churn). pdfHandler.save() reads this at the top of the next save and runs
 *  stripMetadata in its post-tag-restore slot; the committing write-back strips
 *  it so it stays one-shot. */
function setMetadataScrubAfterRedaction(tabId: string, on: boolean): void {
  const current = useFormatStore.getState().getFormatState<{ _wipeMetadataAfterRedaction?: boolean }>(tabId)
  if (!current) return
  if (!!current._wipeMetadataAfterRedaction === on) return
  withReplay(() => {
    useFormatStore.getState().updateFormatState<Record<string, unknown>>(tabId, (prev) => {
      if (on) return { ...prev, _wipeMetadataAfterRedaction: true }
      const { _wipeMetadataAfterRedaction, ...rest } = prev as Record<string, unknown>
      void _wipeMetadataAfterRedaction
      return rest
    })
  })
}

/** Read + consume a one-shot boolean test override stashed on window. Mirrors
 *  the redaction-decision override so test drivers can answer either modal
 *  deterministically without the wire blocking on a real modal. */
function consumeWindowDecision(key: '__openSatchelRedactionSaveDecision' | '__openSatchelMetadataScrubDecision'): boolean | undefined {
  const w = window as unknown as Record<string, boolean | undefined>
  const value = w[key]
  if (typeof value === 'boolean') {
    delete w[key]
    return value
  }
  return undefined
}

async function confirmPendingRedactionSave(tabId: string): Promise<boolean> {
  // Always clear any stale one-shot scrub flag first; it is re-set below ONLY
  // when this save is a confirmed redaction save with scrub accepted. This
  // guards the narrow path where a prior redaction save threw after the flag
  // was set (marks still pending) or the marks were cleared without a save —
  // an ordinary save must never inherit a previous redaction's scrub choice.
  setMetadataScrubAfterRedaction(tabId, false)

  const count = pendingRedactionCount(tabId)
  if (count === 0) return true

  // Test override for the redaction decision. When set, BOTH modals are
  // skipped (existing redaction drivers set only this key and would hang on a
  // modal they don't expect). A driver that ALSO wants the scrub can set the
  // separate __openSatchelMetadataScrubDecision override alongside it.
  const redactOverride = consumeWindowDecision('__openSatchelRedactionSaveDecision')
  if (typeof redactOverride === 'boolean') {
    if (!redactOverride) return false
    if (consumeWindowDecision('__openSatchelMetadataScrubDecision') === true) {
      setMetadataScrubAfterRedaction(tabId, true)
    }
    return true
  }

  // In-app modal — NOT window.confirm, which WebView2 silently suppresses in
  // the packaged build, so this destructive-save warning would never show.
  const plural = count === 1 ? 'area' : 'areas'
  const ok = await useUIStore.getState().requestConfirm({
    title: `Apply ${count} marked redaction ${plural} permanently?`,
    message:
      'Saving will permanently remove the visible text, images, and graphics under those marks, ' +
      'clear the undo history for this document, and write the redacted result to disk.\n\n' +
      'There is no undo after this save.',
    confirmLabel: 'Apply & save',
    cancelLabel: 'Cancel',
    tone: 'danger',
  })
  if (!ok) {
    useUIStore.getState().setSaveNotice({
      tone: 'warn',
      message: 'Save canceled. Redaction marks are still pending; the file was not changed.',
      expiresAt: Date.now() + 10000,
    })
    return false
  }

  // SECOND modal — offer a metadata scrub now that the redaction is committing.
  // This is the natural moment: the user is already accepting permanent
  // removal, and a redaction that leaves author/producer/timestamps/XMP intact
  // defeats the confidentiality guarantee for FOIA/gov/hospital workflows
  // (KNOWN-LIMITATIONS §9e). A test driver can pre-answer via
  // __openSatchelMetadataScrubDecision to avoid blocking on the modal.
  const scrubOverride = consumeWindowDecision('__openSatchelMetadataScrubDecision')
  // Skip the offer entirely when the persistent "wipe metadata on save"
  // preference is already ON: the save will wipe metadata regardless via that
  // standing choice, so prompting "Keep metadata?" here would be misleading
  // (the user's standing toggle would silently override a "Keep metadata"
  // click). The override is consumed above either way so it can't leak forward.
  if (useUIStore.getState().wipeMetadataOnSave) return true
  const scrub = typeof scrubOverride === 'boolean'
    ? scrubOverride
    : await useUIStore.getState().requestConfirm({
        title: 'Scrub document metadata? (highly recommended)',
        message:
          'The redaction will be applied. Also remove this document’s identifying metadata so it ' +
          'cannot leak who created the file or with what tool?\n\n' +
          'This removes the title, author, subject, keywords, creator, producer, creation and ' +
          'modification dates, and the XMP metadata packet.\n\n' +
          'Highly recommended: a redaction that leaves this metadata intact can still reveal the ' +
          'author and origin of the document.',
        confirmLabel: 'Scrub & save',
        cancelLabel: 'Keep metadata',
        tone: 'warn',
      })
  if (scrub) setMetadataScrubAfterRedaction(tabId, true)
  return true
}

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

  // Read the source /Encrypt /P permission policy from the ORIGINAL
  // ciphertext (the /P int is cleartext) BEFORE we lose it. Without this,
  // a re-save re-encrypts with `permissions: undefined` → empty blocklist
  // → every restriction the author set (no-print, no-copy, …) is silently
  // dropped to all-allowed on the round-trip (gauntlet Game C residual).
  const sourcePolicy = await readEncryptionPolicy(bytes).catch(() => null)

  const tabId = await openLoadedFile(path, name, decrypted)
  useFormatStore.getState().updateFormatState<any>(tabId, (prev) => ({
    ...prev,
    _openedEncryptedSource: true,
    encryption: {
      ...(prev?.encryption ?? {}),
      userPassword: password,
      ownerPassword: prev?.encryption?.ownerPassword ?? password,
      algorithm: prev?.encryption?.algorithm ?? 'AES_256',
      // Preserve the author's permission bits across the round-trip. Only
      // seed from the source when the user hasn't already chosen explicit
      // permissions for this tab (e.g. via the password dialog).
      permissions: prev?.encryption?.permissions ?? sourcePolicy?.permissions,
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

async function saveActiveTabImpl(): Promise<void> {
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
  if (!(await confirmPendingRedactionSave(activeTabId))) return

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
    showPostSaveWarning(activeTabId)
  } else {
    await saveActiveTabAsImpl()
  }
}

export async function saveActiveTab(): Promise<void> {
  try {
    await saveActiveTabImpl()
  } catch (err) {
    showSaveFailure('saveActiveTab', err)
    throw err
  }
}

async function saveActiveTabAsImpl(): Promise<void> {
  const { activeTabId, tabs, setTabDirty, setTabFilePath } = useTabStore.getState()
  if (!activeTabId) return
  const tab = tabs.find((t) => t.id === activeTabId)
  if (!tab) return
  const handler = getHandler(tab.format)
  if (!handler) return
  if (!(await confirmPendingRedactionSave(activeTabId))) return

  const bytes = await handler.save(activeTabId)
  const newPath = await window.api.file.saveAs(bytes)
  if (!newPath) return

  const newName = newPath.split(/[/\\]/).pop() ?? tab.fileName
  setTabFilePath(activeTabId, newPath, newName)
  setTabDirty(activeTabId, false)
  showPostSaveWarning(activeTabId)
  try {
    await window.api.recent.add(newPath, newName, tab.format)
  } catch (err) {
    console.warn('[recent] add failed', err)
  }
}

export async function saveActiveTabAs(): Promise<void> {
  try {
    await saveActiveTabAsImpl()
  } catch (err) {
    showSaveFailure('saveActiveTabAs', err)
    throw err
  }
}

// Save a specific tab by id. Used by useAutoSave and anywhere else that
// needs to save a non-active tab (e.g. "save all").
async function saveTabByIdImpl(tabId: string): Promise<void> {
  const { tabs, setTabDirty } = useTabStore.getState()
  const tab = tabs.find((t) => t.id === tabId)
  if (!tab) return
  const handler = getHandler(tab.format)
  if (!handler) return
  if (!(await confirmPendingRedactionSave(tabId))) return
  const bytes = await handler.save(tabId)
  if (tab.filePath) {
    await window.api.file.save(bytes, tab.filePath)
    setTabDirty(tabId, false)
    showPostSaveWarning(tabId)
  }
}

export async function saveTabById(tabId: string): Promise<void> {
  try {
    await saveTabByIdImpl(tabId)
  } catch (err) {
    showSaveFailure('saveTabById', err)
    throw err
  }
}

// Print the active document. PDF prints the real document bytes through an
// off-screen iframe (services/pdfPrint.ts) — never window.print(), which
// would rasterize the whole app chrome. Other formats have no document-print
// path yet; we deliberately no-op rather than fall through to a chrome print.
export async function printActiveTab(): Promise<void> {
  const { activeTabId, tabs } = useTabStore.getState()
  if (!activeTabId) return
  const tab = tabs.find((t) => t.id === activeTabId)
  if (!tab) return
  if (tab.format === 'pdf') {
    try {
      await printPdfTab(activeTabId)
    } catch (err) {
      console.error('[print] failed:', err)
    }
    return
  }
  console.info('[print] no document-print path for format:', tab.format)
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
