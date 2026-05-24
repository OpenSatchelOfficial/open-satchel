// Frontend wrapper for the PKCS#11 (HSM / smart card / YubiKey)
// signing path. Delegates the private-key RSA-sign to a hardware
// token via the Rust cryptoki-backed Tauri commands; the rest of the
// PDF signing ceremony (ByteRange placeholder + PKCS#7 envelope
// assembly) runs in JS against zgapdfsigner like the P12 path.
//
// Call shape:
//   1. await listSlots(modulePath) → let user pick a slot
//   2. await listCertificates(modulePath, slotId, pin) → pick a key
//   3. await signPdfWithPkcs11(pdfBytes, opts) → signed PDF
//
// The Tauri commands use "session-per-call" semantics — no persistent
// state between calls. PIN is sent on every request that needs
// authentication; the frontend holds the PIN in memory for the
// duration of a signing flow, never persists.

import { invoke } from '@tauri-apps/api/core'

export interface Pkcs11Slot {
  slotId: number
  slotDescription: string
  manufacturer: string
  tokenPresent: boolean
  tokenLabel: string | null
  tokenSerial: string | null
  loginRequired: boolean
}

export interface Pkcs11Certificate {
  idHex: string
  label: string
  certDerB64: string
  subject: string
  issuer: string
}

/**
 * Well-known PKCS#11 module paths per platform. Use as defaults in
 * the UI's module-path picker; user can override. Empty array for a
 * module means "no common path on this platform — prompt user to
 * browse for the .dll/.so/.dylib".
 */
export const WELL_KNOWN_MODULES: Record<string, { label: string; paths: string[] }[]> = {
  win32: [
    { label: 'SoftHSM2 (dev)', paths: [
      'C:\\Program Files\\SoftHSM2\\lib\\softhsm2-x64.dll',
      'C:\\Program Files (x86)\\SoftHSM2\\lib\\softhsm2.dll',
    ] },
    { label: 'YubiKey (PIV)', paths: [
      'C:\\Program Files\\Yubico\\YubiKey Manager\\ykcs11.dll',
    ] },
    { label: 'OpenSC (PIV / CAC)', paths: [
      'C:\\Windows\\System32\\opensc-pkcs11.dll',
      'C:\\Program Files\\OpenSC Project\\OpenSC\\pkcs11\\opensc-pkcs11.dll',
    ] },
    { label: 'SafeNet eToken', paths: [
      'C:\\Windows\\System32\\eTPKCS11.dll',
    ] },
  ],
  linux: [
    { label: 'SoftHSM2 (dev)', paths: [
      '/usr/lib/softhsm/libsofthsm2.so',
      '/usr/lib64/softhsm/libsofthsm2.so',
    ] },
    { label: 'OpenSC (PIV / CAC)', paths: [
      '/usr/lib/x86_64-linux-gnu/opensc-pkcs11.so',
      '/usr/lib64/opensc-pkcs11.so',
    ] },
  ],
  darwin: [
    { label: 'SoftHSM2 (dev)', paths: [
      '/usr/local/lib/softhsm/libsofthsm2.so',
      '/opt/homebrew/lib/softhsm/libsofthsm2.so',
    ] },
    { label: 'OpenSC (PIV / CAC)', paths: [
      '/usr/local/lib/opensc-pkcs11.so',
      '/Library/OpenSC/lib/opensc-pkcs11.dylib',
    ] },
  ],
}

/** Enumerate all slots the given PKCS#11 module knows about. Empty
 *  slots are included — the UI may want to render them as a prompt
 *  to insert a token. */
export async function listSlots(modulePath: string): Promise<Pkcs11Slot[]> {
  const raw = await invoke<Array<{
    slot_id: number
    slot_description: string
    manufacturer: string
    token_present: boolean
    token_label: string | null
    token_serial: string | null
    login_required: boolean
  }>>('pkcs11_list_slots', { modulePath })
  return raw.map((r) => ({
    slotId: r.slot_id,
    slotDescription: r.slot_description,
    manufacturer: r.manufacturer,
    tokenPresent: r.token_present,
    tokenLabel: r.token_label,
    tokenSerial: r.token_serial,
    loginRequired: r.login_required,
  }))
}

/** Log into the given slot and list every X.509 certificate the user
 *  has access to. The DER bytes are returned base64-encoded so the
 *  caller can parse the cert + build the PKCS#7 envelope. */
export async function listCertificates(
  modulePath: string,
  slotId: number,
  pin: string,
): Promise<Pkcs11Certificate[]> {
  const raw = await invoke<Array<{
    id_hex: string
    label: string
    cert_der_b64: string
    subject: string
    issuer: string
  }>>('pkcs11_list_certificates', { modulePath, slotId, pin })
  return raw.map((r) => ({
    idHex: r.id_hex,
    label: r.label,
    certDerB64: r.cert_der_b64,
    subject: r.subject,
    issuer: r.issuer,
  }))
}

/** Low-level: sign the given hash (raw bytes) with the private key
 *  whose CKA_ID is `keyIdHex`. Mechanism controls whether the hash
 *  is pre-digested (RSA_PKCS) or the token hashes it internally
 *  (SHA256_RSA_PKCS etc.). For PDF signing over the ByteRange
 *  SHA-256, use "RSA_PKCS" with a DigestInfo-prefixed 51-byte buffer. */
export async function signHash(
  modulePath: string,
  slotId: number,
  pin: string,
  keyIdHex: string,
  hash: Uint8Array,
  mechanism: 'RSA_PKCS' | 'SHA256_RSA_PKCS' | 'SHA384_RSA_PKCS' | 'SHA512_RSA_PKCS' = 'RSA_PKCS',
): Promise<Uint8Array> {
  const sig = await invoke<number[]>('pkcs11_sign_hash', {
    modulePath,
    slotId,
    pin,
    keyIdHex,
    hash: Array.from(hash),
    mechanism,
  })
  return new Uint8Array(sig)
}

/**
 * DigestInfo ASN.1 prefix for SHA-256 — used to wrap a raw 32-byte
 * SHA-256 digest into the 51-byte buffer PKCS#1 v1.5 RSA expects.
 * Constant across all SHA-256 signatures.
 *   SEQUENCE (49 bytes)
 *     SEQUENCE (13 bytes)
 *       OID 2.16.840.1.101.3.4.2.1 (sha256)
 *       NULL
 *     OCTET STRING (32 bytes) — the digest
 */
export const SHA256_DIGEST_INFO_PREFIX = new Uint8Array([
  0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86,
  0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05,
  0x00, 0x04, 0x20,
])

/** Convenience: hash the input with SHA-256, prepend DigestInfo,
 *  sign via PKCS#11 RSA_PKCS mechanism. Returns the raw signature
 *  bytes suitable for embedding in a PKCS#7 SignerInfo. */
export async function signSha256WithPkcs11(
  modulePath: string,
  slotId: number,
  pin: string,
  keyIdHex: string,
  content: Uint8Array,
): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', content)
  const buf = new Uint8Array(SHA256_DIGEST_INFO_PREFIX.length + 32)
  buf.set(SHA256_DIGEST_INFO_PREFIX, 0)
  buf.set(new Uint8Array(digest), SHA256_DIGEST_INFO_PREFIX.length)
  return signHash(modulePath, slotId, pin, keyIdHex, buf, 'RSA_PKCS')
}
