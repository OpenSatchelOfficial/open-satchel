// PDF encryption wrapper around zgapdfsigner's PdfCryptor. pd-lib itself
// has no encryption support — the earlier `save({userPassword, …})`
// casts were silently ignored. zgapdfsigner implements PDF spec
// Revision 6 (AES-256 CBC) correctly against node-forge primitives.
// Audited 2026-04-18 (see PARITY_GAP_REPORT.md); pinned to 2.7.6.
//
// The Tauri/browser split doesn't matter for encryption — no network
// calls — so this works in both Tauri and the zenlink browser-mode
// shim.
//
// permissions: zgapdfsigner's `permissions` array is a BLOCKLIST —
// each string names an operation to DISABLE on the output PDF.
// Supported values: "print", "modify", "copy", "annot-forms",
// "fill-forms", "extract", "assemble", "print-high".
//
// Open Satchel's UI expresses permissions as allowlist ("allow
// printing" checkbox = true means print is permitted). So we
// INVERT: for each flag the UI sets to false, we add the
// corresponding string to zga's blocklist. A flag that's true (or
// undefined) stays off the blocklist → permitted.
//
// Caught via scripts/audit-encryption.mjs — prior code treated the
// zga array as an allowlist, producing PDFs whose /P bits were the
// opposite of what the user checked in the dialog.

import { PDFDocument, PDFDict, PDFName, PDFNumber } from 'pdf-lib'
import { getZga } from './zgaLoader'
import { upgradeR5ToR6 } from './pdfCryptoR6'

export type EncryptionAlgorithm = 'RC4_40' | 'RC4_128' | 'AES_128' | 'AES_256'

/** AES-256 revision: 5 = Adobe Ext Level 3 (zga native), 6 = PDF 2.0
 *  hardened KDF. 6 is recommended; 5 is still cryptographically
 *  AES-256 but has weaker password hashing (brute-force ~5 orders of
 *  magnitude cheaper than R=6 for the same password). Upgrade from
 *  R=5 → R=6 is done via pdfCryptoR6.upgradeR5ToR6 — zga encrypts at
 *  R=5, we replace /Encrypt fields with R=6-derived /U /O /UE /OE. */
export type Aes256Revision = 5 | 6

export interface PermissionFlags {
  /** Allow printing. Combine with printHigh for high-res. */
  print?: boolean
  /** Allow high-resolution printing. Implied by print=true unless you
   *  set print:true and printHigh:false explicitly (= low-res only). */
  printHigh?: boolean
  /** Allow modifying the document (content edits). */
  modify?: boolean
  /** Allow copy/extract of text + images. */
  copy?: boolean
  /** Allow modifying annotations + filling form fields. */
  annotForms?: boolean
  /** Allow fill-in of forms (subset of annotForms). */
  fillForms?: boolean
  /** Allow text/graphics extraction for accessibility / indexing. */
  extract?: boolean
  /** Allow document assembly (insert/rotate/delete pages, bookmarks). */
  assemble?: boolean
}

export interface EncryptOptions {
  algorithm?: EncryptionAlgorithm
  userPassword?: string
  ownerPassword?: string
  permissions?: PermissionFlags
  /** For AES_256 only: which revision of the password KDF to use.
   *  Defaults to 6 (PDF 2.0, hardened). Pass 5 for maximum backwards
   *  compat with very old readers (Acrobat 9-X era). Ignored for
   *  non-AES_256 algorithms. */
  aes256Revision?: Aes256Revision
}

const DEFAULT_ALGO: EncryptionAlgorithm = 'AES_256'
const DEFAULT_AES256_REVISION: Aes256Revision = 6

function flagsToPermissionStrings(flags: PermissionFlags | undefined): string[] {
  if (!flags) return []
  const out: string[] = []
  // Blocklist semantics: push the string iff the UI said "don't allow".
  // An undefined flag = not explicitly denied = permitted (stays off list).
  //
  // zga's string → bit mapping (from the UMD bundle):
  //   "print"=4(b3) "modify"=8(b4) "copy-extract"=16(b5) "annot-forms"=32(b6)
  //   "fill-forms"=256(b9) "extract"=512(b10) "assemble"=1024(b11)
  //   "print-high"=2048(b12)
  //   "copy"=2(b2) — PDF spec reserves bit 2; zga uses this name for a
  //   non-standard slot. Don't use — route PDF's copy-text permission
  //   through "copy-extract" (bit 5) to match what Acrobat reads.
  if (flags.print === false) out.push('print')
  if (flags.printHigh === false) out.push('print-high')
  if (flags.modify === false) out.push('modify')
  if (flags.copy === false) out.push('copy-extract')
  if (flags.annotForms === false) out.push('annot-forms')
  if (flags.fillForms === false) out.push('fill-forms')
  if (flags.extract === false) out.push('extract')
  if (flags.assemble === false) out.push('assemble')
  return out
}

/** Encrypt a PDF with AES-256 + permissions. Returns bytes ready for
 *  saving. If neither userPassword nor ownerPassword is set, falls
 *  back to a permissions-only encryption (user can open without a
 *  password but can't bypass the permission bits). */
export async function encryptPdf(bytes: Uint8Array, opts: EncryptOptions): Promise<Uint8Array> {
  const Zga = await getZga()
  const modeName = opts.algorithm ?? DEFAULT_ALGO
  const mode = Zga.Crypto.Mode[modeName]
  if (mode === undefined) {
    throw new Error(`Unknown encryption algorithm: ${modeName}`)
  }

  const encOpt = {
    mode,
    userpwd: opts.userPassword || undefined,
    ownerpwd: opts.ownerPassword || opts.userPassword || undefined,
    permissions: flagsToPermissionStrings(opts.permissions),
  }

  const cryptor = new Zga.PdfCryptor(encOpt)

  // encryptPdf returns a pdf-lib PDFDocument. Save with useObjectStreams:false
  // so the encryption dict + xref layout work with downstream viewers
  // (Acrobat Reader is pickier about object-stream layouts in
  // encrypted PDFs than uncompressed).
  const pdfdoc = await cryptor.encryptPdf(bytes)
  const zgaOutput = await pdfdoc.save({ useObjectStreams: false })

  // For AES_256, optionally upgrade R=5 → R=6 (PDF 2.0 hardened KDF).
  // Object ciphertext is byte-identical (same AES-256-CBC primitive);
  // only /U, /O, /UE, /OE, /R in the /Encrypt dict change. See
  // pdfCryptoR6.ts for the KDF math.
  if (modeName === 'AES_256') {
    const rev = opts.aes256Revision ?? DEFAULT_AES256_REVISION
    if (rev === 6) {
      return upgradeR5ToR6(zgaOutput, {
        userPassword: opts.userPassword || opts.ownerPassword || '',
        ownerPassword: opts.ownerPassword || opts.userPassword || '',
      })
    }
  }
  return zgaOutput
}

/** True if bytes appear to be an encrypted PDF. Detects the /Encrypt
 *  entry in the trailer — trivial byte-level scan, doesn't require a
 *  full parse. Useful for the save-with-password dialog so we can
 *  warn before clobbering existing encryption. */
export function isEncrypted(bytes: Uint8Array): boolean {
  // Scan the last 4KB for /Encrypt — the trailer is always near EOF.
  const tail = bytes.subarray(Math.max(0, bytes.length - 4096))
  const text = new TextDecoder('latin1').decode(tail)
  return /\/Encrypt\b/.test(text)
}

/** The /Encrypt policy read off an encrypted PDF *before* we decrypt it,
 *  so a re-save can re-apply the SAME permission bits instead of silently
 *  resetting them to all-allowed (the gauntlet C residual). `permissions`
 *  maps each PDF /P bit to a PermissionFlags boolean (granted → true);
 *  `hasUserPassword` is true when /U-style protection requires a password
 *  just to open (used to detect a password-model change on re-save). */
export interface EncryptionPolicy {
  permissions: PermissionFlags
  /** raw /P integer (signed 32-bit) as stored in the /Encrypt dict */
  pBits: number
  /** /R revision (2,3,4,5,6) — null if unreadable */
  revision: number | null
  /** /V version — null if unreadable */
  version: number | null
}

/** Read the permission policy (/P bits) from an encrypted PDF's /Encrypt
 *  dict WITHOUT needing the password. pd-lib's `ignoreEncryption` lets us
 *  walk the trailer + dict (the /P int is cleartext; only streams/strings
 *  are ciphertext). Returns null when there is no /Encrypt dict or /P is
 *  unreadable — callers then fall back to "no explicit restrictions".
 *
 *  PDF /P bit map (ISO 32000-1 Table 22, 1-indexed bits):
 *    b3 print, b4 modify, b5 copy/extract, b6 annot/forms,
 *    b9 fill-forms, b10 extract-for-a11y, b11 assemble, b12 print-high.
 *  A bit SET = that operation is GRANTED. */
export async function readEncryptionPolicy(
  bytes: Uint8Array,
): Promise<EncryptionPolicy | null> {
  try {
    const doc = await PDFDocument.load(bytes, {
      throwOnInvalidObject: false,
      ignoreEncryption: true,
      updateMetadata: false,
    })
    const ctx = doc.context
    const encryptRef = ctx.trailerInfo.Encrypt
    if (!encryptRef) return null
    const encDict = ctx.lookup(encryptRef)
    if (!(encDict instanceof PDFDict)) return null
    const pVal = encDict.get(PDFName.of('P'))
    const P = pVal instanceof PDFNumber ? pVal.asNumber() : null
    if (P == null) return null
    const rVal = encDict.get(PDFName.of('R'))
    const vVal = encDict.get(PDFName.of('V'))
    // Granted iff the bit is set. (1<<n is 0-indexed: PDF b3 = 1<<2.)
    const has = (mask: number) => (P & mask) !== 0
    const permissions: PermissionFlags = {
      print: has(4), // b3
      modify: has(8), // b4
      copy: has(16), // b5 copy/extract
      annotForms: has(32), // b6
      fillForms: has(256), // b9
      extract: has(512), // b10
      assemble: has(1024), // b11
      printHigh: has(2048), // b12
    }
    return {
      permissions,
      pBits: P,
      revision: rVal instanceof PDFNumber ? rVal.asNumber() : null,
      version: vVal instanceof PDFNumber ? vVal.asNumber() : null,
    }
  } catch {
    return null
  }
}

/** G4: produce a clean, unencrypted copy of an encrypted PDF.
 *
 *  Routes through the Rust `pdf_decrypt_bytes` Tauri command, which
 *  uses lopdf to:
 *    1. Parse the input bytes (lopdf reads encrypted files; the
 *       content streams stay ciphertext until decrypt() is called).
 *    2. Apply the password to derive the file-encryption key.
 *    3. Decrypt every encrypted object's stream + string in place.
 *    4. Re-emit the document via `Document::save_to`. lopdf's writer
 *       drops `/Encrypt` from the trailer when the in-memory doc is
 *       no longer flagged encrypted, so the output is a plain PDF.
 *
 *  Bytes that are not encrypted to start with round-trip unchanged
 *  (lopdf's save_to is non-destructive on a clean doc).
 *
 *  Throws on the wrong password or unsupported crypto. AES-256 R=5/R=6
 *  inputs use the qpdf fallback in commands/verify.rs until the native
 *  KDF is implemented directly. */
export async function removeEncryption(
  bytes: Uint8Array,
  password: string,
): Promise<Uint8Array> {
  // Tauri-only: the @tauri-apps/api import is dynamic so this file
  // still tree-shakes cleanly in browser / vitest contexts that
  // don't have tauri's IPC layer. Other services in this folder use
  // the same pattern (see pdfReflow, pdfImageEdits).
  const { invoke } = await import('@tauri-apps/api/core')
  const decrypted = await invoke<number[]>('pdf_decrypt_bytes', {
    bytes: Array.from(bytes),
    password,
  })
  return new Uint8Array(decrypted)
}
