// User-managed trust store for signature verification.
//
// Bridges the "valid-untrusted" gap in pdfSign.verifySignatures.
// Acrobat treats signatures with self-signed OR out-of-AATL certs as
// yellow-triangle "unknown". Our equivalent is the `valid-untrusted`
// summary. When a user explicitly trusts a signer's cert (via this
// store), the next verify pass upgrades that signer to `valid`.
//
// Two sources of trust:
//   1. User-added entries — local, per-user, localStorage-backed.
//      Added via file-import (the .cer / .pem / .crt file a partner
//      sent you) or by "trust this signer" on a currently-yellow
//      verification result.
//   2. Bundled AATL snapshot — seeded from src/data/aatlSnapshot.ts
//      with ~20 root CA fingerprints covering DigiCert, Entrust,
//      GlobalSign, IdenTrust, Sectigo, SwissSign, QuoVadis, Buypass,
//      T-Systems. Same matching logic as user trust; just a different
//      load source. Refresh procedure documented in aatlSnapshot.ts.
//
// Matching key: SHA-256 of the cert DER (lowercase hex, 64 chars).
// This is what Adobe and Windows certstore display as the "cert
// thumbprint".

import { AATL_BUNDLED_ENTRIES } from '../data/aatlSnapshot'

const KEY = 'open-satchel:trusted-certs'

export interface TrustedCert {
  /** SHA-256 of cert DER, lowercase hex (64 chars). */
  fingerprint: string
  /** Human-readable label shown in UI. Subject CN is a good default. */
  label: string
  /** ISO 8601 timestamp when the cert was trusted. */
  addedAt: string
  /** Optional trust-flags for future granularity (sig only vs document-
   *  certification etc.). Today any entry = fully trusted. */
  trustFlags?: {
    signatures?: boolean
    certifiedDocs?: boolean
    dynamicContent?: boolean
  }
}

export function listTrustedCerts(): TrustedCert[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isValidEntry)
  } catch {
    return []
  }
}

export function isTrusted(fingerprint: string): boolean {
  if (!fingerprint) return false
  const fp = fingerprint.toLowerCase()
  // User-trusted wins first — it's the explicit "yes, this signer" act.
  for (const c of listTrustedCerts()) {
    if (c.fingerprint.toLowerCase() === fp) return true
  }
  // Bundled AATL snapshot (empty in v1 — see file header).
  for (const c of aatlEntries) {
    if (c.fingerprint.toLowerCase() === fp) return true
  }
  return false
}

export function addTrustedCert(entry: Omit<TrustedCert, 'addedAt'>): TrustedCert {
  const record: TrustedCert = {
    fingerprint: entry.fingerprint.toLowerCase(),
    label: entry.label,
    addedAt: new Date().toISOString(),
    trustFlags: entry.trustFlags,
  }
  const existing = listTrustedCerts().filter(c => c.fingerprint !== record.fingerprint)
  const next = [...existing, record]
  save(next)
  return record
}

export function removeTrustedCert(fingerprint: string): void {
  const fp = fingerprint.toLowerCase()
  const next = listTrustedCerts().filter(c => c.fingerprint !== fp)
  save(next)
}

/** Clear ALL user-added trusts. Bundled AATL entries survive. */
export function clearUserTrusts(): void {
  save([])
}

/** Import a .cer/.pem/.crt file. Returns the computed fingerprint so
 *  the caller can confirm with the user before calling addTrustedCert.
 *  Accepts either DER bytes directly or a PEM-wrapped string. */
export async function fingerprintFromCertBytes(bytes: Uint8Array): Promise<string> {
  const der = await toCertDer(bytes)
  const hash = await crypto.subtle.digest('SHA-256', der)
  return bufferToHex(hash)
}

// ── Private ─────────────────────────────────────────────────────────

function save(list: TrustedCert[]): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* quota or unavailable — silent */
  }
}

function isValidEntry(x: unknown): x is TrustedCert {
  if (!x || typeof x !== 'object') return false
  const e = x as Partial<TrustedCert>
  return typeof e.fingerprint === 'string'
      && /^[0-9a-f]{64}$/i.test(e.fingerprint)
      && typeof e.label === 'string'
      && typeof e.addedAt === 'string'
}

function bufferToHex(buf: ArrayBuffer): string {
  const arr = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < arr.length; i++) s += arr[i].toString(16).padStart(2, '0')
  return s
}

async function toCertDer(bytes: Uint8Array): Promise<Uint8Array> {
  // PEM detection — starts with "-----BEGIN".
  const head = new TextDecoder('latin1').decode(bytes.slice(0, 32))
  if (head.startsWith('-----BEGIN')) {
    const text = new TextDecoder('utf-8').decode(bytes)
    const match = text.match(/-----BEGIN CERTIFICATE-----\s*([\s\S]*?)\s*-----END CERTIFICATE-----/)
    if (!match) throw new Error('PEM block not a CERTIFICATE')
    const b64 = match[1].replace(/\s+/g, '')
    const binary = atob(b64)
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
    return out
  }
  return bytes
}

// ── Bundled AATL ───────────────────────────────────────────────────
// Converted from src/data/aatlSnapshot.ts's structured list to the
// TrustedCert shape at module load so isTrusted's lookup loop
// iterates TrustedCert uniformly with the user-added entries.
const aatlEntries: TrustedCert[] = AATL_BUNDLED_ENTRIES.map((e) => ({
  fingerprint: e.fingerprint.toLowerCase(),
  label: `[AATL] ${e.label}`,
  addedAt: '2000-01-01T00:00:00Z',  // sentinel for "bundled, not user-added"
}))

/** True if the cert matches a bundled AATL entry (not a user trust).
 *  UI uses this to distinguish "trusted because Adobe trusts them"
 *  from "trusted because you clicked Trust this signer". */
export function isBundledAatl(fingerprint: string): boolean {
  const fp = fingerprint.toLowerCase()
  return aatlEntries.some((c) => c.fingerprint === fp)
}
