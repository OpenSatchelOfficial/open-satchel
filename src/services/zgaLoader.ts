// Browser-compatible loader for zgapdfsigner.
//
// Loads from the VENDORED copy at `vendor/zgapdfsigner/dist/zgapdfsigner.min.js`,
// not the npm package — see `vendor/zgapdfsigner/ATTRIBUTION.md` for
// provenance and the MIT license. Vendoring insulates Open Satchel
// from a single-maintainer npm package compromise.
//
// Upstream: https://github.com/zboris12/zgapdfsigner (MIT, v2.7.6).
//
// The original npm `main` field points at lib/zganode.js which uses
// CommonJS `require` for node-forge, pdf-lib, pdf-fontkit, plus
// lib/zgafetch.js has a top-level `require("url")` that Vite can't
// polyfill. We sidestep this by loading the self-contained UMD
// bundle as a script, after pre-populating the globals it expects
// (pdf-lib, node-forge, pako) — the pattern the upstream README
// recommends for browser use.

import * as forge from 'node-forge'
import * as PDFLib from 'pdf-lib'
import * as pako from 'pako'
import { invoke } from '@tauri-apps/api/core'

// The dist is a self-executing UMD file that attaches to `globalThis`.
// We pre-populate the deps it looks up before triggering the import
// side-effect so the registration succeeds.
declare global {
  interface Window {
    PDFLib?: unknown
    forge?: unknown
    pako?: unknown
    Zga?: unknown
  }
}

if (typeof window !== 'undefined') {
  // The UMD bundle's feature-detection path does `globalThis.PDFLib`
  // etc. Fill them in before the bundle runs.
  window.PDFLib = PDFLib
  window.forge = forge
  window.pako = pako
}

// Side-effect import: the min bundle attaches `globalThis.Zga`.
// We use `?url` + script injection rather than `import` so Vite
// doesn't try to parse the minified source.
let zgaReady: Promise<void> | null = null
async function ensureLoaded(): Promise<void> {
  if (zgaReady) return zgaReady
  zgaReady = (async () => {
    if (typeof window === 'undefined') throw new Error('zgapdfsigner requires a browser-like global')
    if (window.Zga) return
    // Vendored path — served by Vite from repo root at /vendor/...
    // In production (Tauri) the file is bundled via publicDir.
    const modUrl = new URL(
      /* @vite-ignore */
      '/vendor/zgapdfsigner/dist/zgapdfsigner.min.js',
      window.location.href,
    ).href
    await new Promise<void>((resolve, reject) => {
      const s = document.createElement('script')
      s.src = modUrl
      s.onload = () => resolve()
      s.onerror = (e) => reject(new Error(`Failed to load zgapdfsigner UMD bundle: ${e}`))
      document.head.appendChild(s)
    })
    if (!window.Zga) throw new Error('zgapdfsigner loaded but Zga global not attached')
  })()
  return zgaReady
}

export interface ZgaAPI {
  Crypto: { Mode: Record<'RC4_40' | 'RC4_128' | 'AES_128' | 'AES_256', number> }
  PdfCryptor: new (opts: {
    mode: number
    userpwd?: string
    ownerpwd?: string
    permissions?: string[]
    pubkeys?: Array<{ c: Uint8Array | ArrayBuffer; p?: string[] }>
  }) => {
    encryptPdf: (pdf: Uint8Array) => Promise<{ save: (opts?: unknown) => Promise<Uint8Array> }>
  }
  PdfSigner: new (opts: Record<string, unknown>) => {
    sign: (pdf: Uint8Array) => Promise<Uint8Array>
  }
  TsaFetcher?: unknown
}

// ── Bug workarounds for pdf-lib 1.17.1 + zga interaction ──────────────
//
// WHY THESE PATCHES EXIST
//
// Direct round-trip testing against Foxit PDF Reader (2026-04-18) found
// that PDFs signed via the default zga path are structurally broken:
// the xref table emitted by pdf-lib's save({useObjectStreams:false}) has
// entries for objects 57+ pointing at byte offsets that land INSIDE
// earlier font dicts — not at valid "N 0 obj" headers. Foxit does
// standards-compliant xref resolution, hits garbage at those offsets,
// and shows the signed PDF as blank with zero signatures in its
// Digital Signatures panel. Our own verifySignatures byte-greps for
// /Type /Sig directly and doesn't go through xref, which is why
// self-verification was passing for broken output.
//
// ROOT CAUSE
//
// zga's PdfSigner.sign() flow for the "fresh sign" case (no pre-existing
// sig field) does:
//   1. addSignHolder — adds new sig dict + widget objects to pdfdoc
//   2. z.newRefs.reorderPdfRefs(pdfdoc) — renumbers ALL refs sequentially
//      from 1 for "neatness" (zga's comment: "If the definitions of
//      references are too chaotic... we make the order of references
//      more neet")
//   3. pdfdoc.save({useObjectStreams:false}) — pdf-lib serializes
//
// In pdf-lib 1.17.1 the interaction between reorderPdfRefs' in-place
// ref mutation and the save path's xref-offset calculator produces
// stale offsets. The incremental-append path (zga's `appendIncrement`,
// used when signing a PDF that ALREADY has a sig field) is bug-free
// because it serializes only new objects and leaves the original bytes
// untouched.
//
// THE PATCH
//
// 1. Neutralize reorderPdfRefs — it's only there to protect pdf-lib's
//    save path from "chaotic refs", and we're not taking that path.
// 2. In saveAndSign, populate `apobjs` via findChangedObjects before
//    the default path runs. That flips the `apobjs.length > 0` check
//    inside saveAndSign to true, routing through appendIncrement
//    instead of pdfdoc.save.
//
// Result: fresh signs take the same byte-preserving incremental path
// that counter-signs already take. Original file bytes + new sig
// objects appended + correct xref + trailer with /Prev.
//
// PROVENANCE
//
// We don't modify the vendored zga source directly — that file is a
// trust anchor and changing it would complicate the "re-download, diff,
// review" update procedure in ATTRIBUTION.md. Patching at the
// JavaScript-prototype level from our loader keeps the vendored bytes
// identical while still fixing the real-world behavior.

interface ZgaInternals {
  newRefs: {
    reorderPdfRefs: (pdfdoc: unknown, enc?: boolean) => unknown
  }
  PdfSigner: {
    prototype: {
      saveAndSign: (pdfdoc: unknown) => Promise<Uint8Array>
      findChangedObjects: (pdfdoc: unknown, ignoreInfo?: boolean) => Promise<void>
      oriU8pdf: Uint8Array | null
      apobjs: unknown[] | null
    }
  }
  /** zga's HTTP function. Used by TsaFetcher to POST RFC 3161 requests
   *  and by addDss to fetch OCSP/CRL for LTV. Default implementation
   *  uses the browser's fetch(), which WebView2/Firefox/Chrome all
   *  CORS-block for public TSAs. We monkey-patch this to invoke a Rust
   *  command in Tauri mode. */
  urlFetch: (url: string, params?: {
    payload?: Uint8Array | ArrayBuffer
    headers?: Record<string, string>
    method?: string
  }) => Promise<Uint8Array>
  __osPatched?: boolean
}

/** True when running inside the Tauri desktop shell. Tauri 2.x sets
 *  `__TAURI_INTERNALS__` on window before any app script runs.
 *  Browser/preview mode doesn't have it. We use this to gate the Rust-
 *  side TSA proxy on the only environment where it's available. */
function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

function applyBugfixPatches(Zga: ZgaAPI & ZgaInternals): void {
  if (Zga.__osPatched) return
  Zga.__osPatched = true

  // Patch 0: route TSA + OCSP/CRL requests through a Rust command when
  // running in Tauri. zga's default urlFetch uses browser fetch(), which
  // WebView2 (Tauri on Windows) CORS-blocks against public TSA endpoints
  // the same way Firefox/Chrome does. The Rust command is native HTTP,
  // no CORS. See src-tauri/src/commands/tsa.rs for the host allow-list.
  //
  // In browser/preview mode we leave the default in place — TSA is
  // a known-documented limitation there.
  if (isTauri()) {
    Zga.urlFetch = async (url, params) => {
      const payload = params?.payload
      const body = payload
        ? payload instanceof Uint8Array
          ? Array.from(payload)
          : Array.from(new Uint8Array(payload))
        : []
      const bytes = await invoke<number[]>('tsa_fetch', {
        url,
        body,
        headers: params?.headers ?? null,
      })
      return new Uint8Array(bytes)
    }
  }

  // Patch 1: reorderPdfRefs becomes a no-op. Upstream uses it to renumber
  // refs before pdf-lib's save path; we're routing around that save path
  // entirely (Patch 2), so the renumbering is both unnecessary and
  // actively harmful — it mutates shared PDFRef objects in ways that
  // confuse the incremental-append diff in findChangedObjects.
  Zga.newRefs.reorderPdfRefs = function (pdfdoc: unknown, enc?: boolean): unknown {
    if (!enc) return null
    // When encryption is requested we still need a reserved ref for the
    // /Encrypt dict. PDFLib.PDFContext.nextRef() allocates one without
    // the ref-renumbering side effects.
    const ctx = (pdfdoc as { context: { nextRef: () => unknown } }).context
    return ctx.nextRef()
  }

  // Patch 2: always take the incremental-append path. Upstream's default
  // path for a fresh sign (no pre-existing /Sig field) is
  // `pdfdoc.save({useObjectStreams: false})`, which in pdf-lib 1.17.1
  // emits an xref table whose entries for newly-added objects point at
  // byte offsets that land INSIDE earlier objects (confirmed by direct
  // Foxit round-trip — the sig dict gets written, but the catalog's
  // /Perms /DocMDP reference resolves to garbage). The incremental-append
  // path (`appendIncrement`) is standards-compliant PDF incremental-
  // update: original bytes preserved, new objects appended, classic xref
  // table, trailer with /Prev. Third-party readers handle it correctly.
  //
  // Populating `apobjs` via findChangedObjects flips upstream's internal
  // `if (this.apobjs.length > 0)` guard to the good branch. We then call
  // appendIncrement + signPdf directly rather than delegating to
  // saveAndSign so the sequence is inspectable and failures land on the
  // actual line rather than inside minified vendor code.
  interface SignerInternals {
    apobjs: unknown[] | null
    oriU8pdf: Uint8Array | null
    findChangedObjects: (doc: unknown) => Promise<void>
    appendIncrement: (doc: unknown) => Uint8Array
    signPdf: (pdfstr: string) => Promise<Uint8Array>
  }
  const SignerProto = Zga.PdfSigner.prototype
  SignerProto.saveAndSign = async function (pdfdoc: unknown): Promise<Uint8Array> {
    const self = this as unknown as SignerInternals
    if ((!self.apobjs || self.apobjs.length === 0) && self.oriU8pdf) {
      await self.findChangedObjects(pdfdoc)
    }
    const uarr = self.appendIncrement(pdfdoc)
    // zga's signPdf expects a latin1 string; chunk-build to avoid
    // the max-call-stack limit on String.fromCharCode.apply for
    // multi-MB buffers.
    let pdfstr = ''
    for (let i = 0; i < uarr.length; i += 0x8000) {
      pdfstr += String.fromCharCode.apply(
        null,
        Array.from(uarr.subarray(i, Math.min(i + 0x8000, uarr.length))),
      )
    }
    pdfstr += '\n' // zga's NEWLINE constant
    return await self.signPdf(pdfstr)
  }
}

/** Async accessor — returns the Zga namespace once the UMD bundle has
 *  loaded and attached to `window.Zga`. First call triggers the script
 *  injection; subsequent calls are near-instant. Applies bug workarounds
 *  for pdf-lib 1.17.1 on first load — see the block comment above. */
export async function getZga(): Promise<ZgaAPI> {
  await ensureLoaded()
  const Zga = window.Zga as unknown as ZgaAPI & ZgaInternals
  applyBugfixPatches(Zga)
  return Zga
}
