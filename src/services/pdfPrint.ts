// Print a PDF document — the document, not the app.
//
// The naive path (window.print()) rasterizes the entire app DOM: ribbon,
// sidebar, tab strip and all. What the user wants is the page they're
// looking at. So instead we serialize the current document to bytes and
// hand those to an off-screen <iframe> whose only content is the PDF. The
// browser/WebView prints that frame — just the document, full vector
// quality, correct pagination, every page.
//
// blob: framing is gated by the `frame-src 'self' blob:` CSP directive
// (index.html + tauri.conf.json). Without it the iframe load is blocked.

import { getHandler } from '../formats/registry'
import { useFormatStore } from '../stores/formatStore'
import { stateHasManualRedactions, type ManualRedactionDocumentState } from './pdfManualRedactions'

/**
 * Produce the bytes to print for a tab: the current WYSIWYG document with
 * every pending edit (annotations, paragraph rewrites, form fills, stamps…)
 * baked in, decrypted, and with no persistence side effects — printing must
 * never commit a redaction barrier, password-protect the printout, or clear
 * undo history. See the PDF handler's `save({ forPrint: true })` option.
 *
 * Routed through the format registry (not a direct pdfHandler import) to keep
 * this service out of the pdf/index → PdfToolbar → pdfPrint import cycle.
 *
 * If the bake pipeline throws (DocMDP guard, pd-lib data-loss guard, exotic
 * structure), fall back to the last-loaded bytes so Print always works —
 * those omit unsaved edits but are a valid, printable document.
 */
export async function resolvePrintBytes(tabId: string): Promise<Uint8Array> {
  const handler = getHandler('pdf')
  if (!handler) throw new Error('PDF handler not registered')
  try {
    return await handler.save(tabId, { forPrint: true })
  } catch (err) {
    console.warn('[print] edit bake failed; printing last-loaded bytes', err)
    const state = useFormatStore
      .getState()
      .getFormatState<{ pdfBytes?: Uint8Array }>(tabId)
    if (!state?.pdfBytes) throw new Error('No PDF state for tab')
    return state.pdfBytes
  }
}

/**
 * Resolve the bytes to EXPORT / CONVERT / RENDER / SPLIT / COMPARE for a tab —
 * the single redaction-aware choke point for every OUTPUT path that consumes
 * `state.pdfBytes` and bypasses `save()`.
 *
 * Under the pending-redaction model, `state.pdfBytes` is the LIVE, UN-redacted
 * document: manual redaction marks live in the Fabric overlay and are not baked
 * into the bytes until a save. An export/convert/render that reads `pdfBytes`
 * directly would therefore ship the secret verbatim (data exports) or in the
 * clear pixels (image renders) — gauntlet PEL-1/2/3.
 *
 * So when the tab has PENDING manual redaction marks, bake them in first via
 * `save({ forPrint: true })` — which applies pending redactions (and all WYSIWYG
 * edits) and returns the bytes WITHOUT persisting / clearing history / writing
 * to disk. FAIL-CLOSED: if the bake throws (e.g. a redaction cannot be verified)
 * the error propagates and the output is refused — it NEVER falls back to the
 * un-redacted bytes (unlike resolvePrintBytes, where a print of last-loaded
 * bytes is acceptable; an export of the secret is not).
 *
 * With no pending redactions this returns the live bytes unchanged — no cost or
 * behavior change on the common path.
 */
export async function resolveOutputBytes(tabId: string): Promise<Uint8Array> {
  const state = useFormatStore
    .getState()
    .getFormatState<ManualRedactionDocumentState & { pdfBytes?: Uint8Array }>(tabId)
  if (stateHasManualRedactions(state)) {
    const handler = getHandler('pdf')
    if (!handler) throw new Error('PDF handler not registered')
    // No try/catch: a failed bake must REFUSE the output, not leak.
    return await handler.save(tabId, { forPrint: true })
  }
  if (!state?.pdfBytes) throw new Error('No PDF state for tab')
  return state.pdfBytes
}

/**
 * Print raw PDF bytes via a hidden, same-origin iframe. Resolves once the
 * print dialog has been opened (and the frame torn down). Rejects only if
 * the frame can't load the document at all.
 */
export function printPdfBytes(bytes: Uint8Array): Promise<void> {
  // Expose the exact bytes handed to the printer for automation/asserts,
  // mirroring window.__lastSave. Lets a test confirm Print ships the
  // document — not an HTML rasterization of the app chrome.
  ;(window as unknown as { __lastPrintBytes?: Uint8Array }).__lastPrintBytes = bytes

  // Copy into a fresh ArrayBuffer-backed view: `bytes` may be a subarray of
  // a larger pool buffer, and Blob would otherwise capture the whole pool.
  const blob = new Blob([bytes.slice()], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)

  const iframe = document.createElement('iframe')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.title = 'Print document'
  // Keep it in the layout (display:none frames don't always paint/print in
  // Chromium) but invisible and non-interactive.
  iframe.style.cssText =
    'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none;'

  return new Promise<void>((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      if (settled) return
      settled = true
      URL.revokeObjectURL(url)
      iframe.remove()
      resolve()
    }

    iframe.onload = () => {
      const win = iframe.contentWindow
      if (!win) {
        URL.revokeObjectURL(url)
        iframe.remove()
        reject(new Error('print iframe has no contentWindow'))
        return
      }
      try {
        // afterprint fires when the dialog is dismissed (printed OR
        // cancelled). Tear down then so the blob URL and node don't leak.
        win.addEventListener('afterprint', cleanup, { once: true })
        win.focus()
        win.print()
        // Safety net: some engines never fire afterprint for a frame window.
        // The dialog is modal, so by the time this runs the user has long
        // since dismissed it — just reclaim the node.
        window.setTimeout(cleanup, 60_000)
      } catch (err) {
        URL.revokeObjectURL(url)
        iframe.remove()
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    }
    iframe.onerror = () => {
      URL.revokeObjectURL(url)
      iframe.remove()
      reject(new Error('print iframe failed to load the PDF'))
    }

    document.body.appendChild(iframe)
    iframe.src = url
  })
}

/** Resolve the tab's WYSIWYG bytes and send them to the print dialog. */
export async function printPdfTab(tabId: string): Promise<void> {
  const bytes = await resolvePrintBytes(tabId)
  await printPdfBytes(bytes)
}
