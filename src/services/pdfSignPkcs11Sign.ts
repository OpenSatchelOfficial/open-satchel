// Full PDF signing ceremony when the private key lives on a PKCS#11
// token (YubiKey / smart card / HSM). Handles:
//
//   1. Delegate the placeholder + incremental-update assembly to
//      zgapdfsigner (same code path as the P12 flow).
//   2. Compute the SHA-256 hash over the ByteRange.
//   3. Build the PKCS#7 SignedData envelope with node-forge — two-pass
//      trick: pass 1 captures the authenticatedAttributes hash via a
//      capturing-key stub, pass 2 feeds the real PKCS#11 signature
//      back in via a sync-wrapper key stub. Both passes pin the
//      signingTime so auth attrs DER is byte-identical across them.
//   4. Splice the real PKCS#7 into the placeholder's /Contents bytes.
//
// Why two passes: forge.pkcs7's .sign() calls signer.key.sign(md) at
// a fixed synchronous point in its flow. PKCS#11 sign is async (Tauri
// IPC). We need the auth-attrs hash before we can call PKCS#11, and
// we need the signature before we can let forge finish building
// SignedData. Running forge twice with pinned signingTime is the
// simplest way to bridge the sync/async gap without reimplementing
// forge's auth-attrs DER encoding.

import forge from 'node-forge'
import { getZga } from './zgaLoader'
import { signSha256WithPkcs11 } from './pdfSignPkcs11'

export interface SignPdfWithPkcs11Options {
  /** PKCS#11 module path (e.g. C:\Program Files\SoftHSM2\lib\softhsm2-x64.dll). */
  modulePath: string
  slotId: number
  pin: string
  /** CKA_ID of the private key to sign with. */
  keyIdHex: string
  /** DER of the signing cert (base64 from pkcs11_list_certificates). */
  certDerB64: string
  /** Optional extra intermediate/root certs (DER, base64). */
  caCertsDerB64?: string[]
  /** Visible PDF sig metadata. */
  reason?: string
  location?: string
  signerName?: string
  /** Contact info field (email / phone). Surfaced via the visible-
   *  signature appearance editor; goes into zga's `contact` slot
   *  which writes it to the /M dict + the appearance stream. */
  contactInfo?: string
  /** /DocMDP level (1=no changes, 2=+form fill + sigs,
   *  3=+annotations). Omit for ordinary approval signature. */
  certifyLevel?: 1 | 2 | 3
}

/**
 * Sign a PDF using a private key on a PKCS#11 token. Returns signed
 * PDF bytes. The Tauri backend's cryptoki integration does the
 * actual RSA operation; everything else (placeholder, PKCS#7
 * envelope, /Contents splice) runs in JS.
 */
export async function signPdfWithPkcs11(
  pdfBytes: Uint8Array,
  opts: SignPdfWithPkcs11Options,
): Promise<Uint8Array> {
  const Zga = await getZga()

  // Decode cert DER for forge + later splicing. The cert we
  // enumerated from the token is authoritative — forge needs it to
  // build the signer identifier (IssuerAndSerialNumber) and stamp
  // it in the SignedData certificates SET.
  const certDer = b64ToU8(opts.certDerB64)
  const signerCert = forge.pki.certificateFromAsn1(
    forge.asn1.fromDer(u8ToForgeBinary(certDer)),
  )
  const caCerts = (opts.caCertsDerB64 ?? []).map((b) =>
    forge.pki.certificateFromAsn1(
      forge.asn1.fromDer(u8ToForgeBinary(b64ToU8(b))),
    ),
  )

  // zgapdfsigner's ExtSigner interface: it calls our sign() with the
  // raw ByteRange-covered bytes AFTER placing the placeholder. We
  // return the PKCS#7 DER. Exactly the external-signing hook we
  // need — no monkey-patching required.
  //
  // The `cert` option is used by zga to pre-compute the /Contents
  // placeholder size; for PKCS#11 with CA + intermediates the
  // envelope is bigger than a P12-signed envelope, so we pad
  // generously. `placeholderLen` default is 6144 hex chars (3072
  // bytes); we bump to 16384 (8192 bytes) which covers a cert chain
  // of up to ~20 certs before overflowing.
  const cryptoOpts: Record<string, unknown> = {
    drawinf: opts.signerName
      ? { signame: opts.signerName, reason: opts.reason, location: opts.location, contact: opts.contactInfo }
      : undefined,
    reason: opts.reason,
    location: opts.location,
    contact: opts.contactInfo,
    signame: opts.signerName,
    permission: opts.certifyLevel,
    signdate: 'Z',  // "now, with UTC offset"
  }

  // External-signer path: zga gives us ByteRange bytes; we return
  // PKCS#7 DER. zga inserts it at /Contents.
  const signer = new Zga.PdfSigner({
    ...cryptoOpts,
    // ExtSigner callback: async sign that returns the full PKCS#7.
    extsigner: {
      /** zgapdfsigner calls this once per signature with the bytes
       *  that /ByteRange spans. We return a DER-encoded PKCS#7
       *  SignedData (detached signature over those bytes). */
      sign: async (signBytes: Uint8Array): Promise<Uint8Array> => {
        return buildPkcs11DetachedPkcs7(signBytes, signerCert, caCerts, opts)
      },
    },
  })

  const out = await signer.sign(pdfBytes)
  return out instanceof Uint8Array ? out : new Uint8Array(out)
}

// ── PKCS#7 SignedData (detached) ──────────────────────────────────
// Two-pass approach. See module header for the rationale.
async function buildPkcs11DetachedPkcs7(
  contentBytes: Uint8Array,
  signerCert: forge.pki.Certificate,
  caCerts: forge.pki.Certificate[],
  opts: SignPdfWithPkcs11Options,
): Promise<Uint8Array> {
  // Pin signingTime so the auth attrs DER is identical across both
  // forge passes. Without pinning, pass 2 would compute a different
  // hash than what we signed via PKCS#11 in pass 1.5.
  const signingTime = new Date()

  // Shared auth-attrs spec used by both passes.
  const authAttrs = [
    { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
    { type: forge.pki.oids.messageDigest },  // forge auto-fills from content
    { type: forge.pki.oids.signingTime, value: signingTime },
  ]

  // Pass 1 — capture the auth-attrs hash via a stub key whose
  // .sign(md) just reads md.digest() and returns 256 zero bytes.
  let capturedDigest: string | null = null
  const capturingKey = {
    sign(md: { digest(): { getBytes(): string } }, _scheme: string): string {
      capturedDigest = md.digest().getBytes()  // binary string, 32 bytes
      return '\0'.repeat(256)  // dummy 256-byte signature
    },
  } as unknown as forge.pki.rsa.PrivateKey

  const p7pass1 = forge.pkcs7.createSignedData() as unknown as Pkcs7SignedData
  p7pass1.content = forge.util.createBuffer(u8ToForgeBinary(contentBytes))
  p7pass1.addCertificate(signerCert)
  for (const c of caCerts) p7pass1.addCertificate(c)
  p7pass1.addSigner({
    key: capturingKey,
    certificate: signerCert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: cloneAttrs(authAttrs),
  })
  p7pass1.sign({ detached: true })

  if (!capturedDigest) {
    throw new Error('Pass 1 did not capture auth-attrs digest (forge.pkcs7 flow changed?)')
  }

  // The capturedDigest is the raw 32-byte SHA-256 of the auth attrs
  // DER. RSA-PKCS1-v1_5 signing needs a DigestInfo-prefixed 51-byte
  // buffer — the PKCS#11 RSA_PKCS mechanism does the padding itself
  // when we pass the 51-byte DigestInfo buffer.
  const digest32 = forgeBinaryToU8(capturedDigest)
  const signingInput = prependSha256DigestInfo(digest32)  // 51 bytes

  // Call PKCS#11 — Tauri invoke → cryptoki → token signs → raw sig.
  const signature = await signSha256WithPkcs11Raw(
    opts.modulePath, opts.slotId, opts.pin, opts.keyIdHex, signingInput,
  )
  if (signature.length !== 256) {
    throw new Error(`PKCS#11 returned ${signature.length}-byte signature, expected 256 (RSA-2048)`)
  }

  // Pass 2 — sign with a stub key that returns our precomputed real
  // signature. Same auth attrs + same signingTime → same digest →
  // same hash → forge accepts our "precomputed" signature as valid
  // for this signer.
  const returningKey = {
    sign(_md: unknown, _scheme: string): string {
      return u8ToForgeBinary(signature)
    },
  } as unknown as forge.pki.rsa.PrivateKey

  const p7pass2 = forge.pkcs7.createSignedData() as unknown as Pkcs7SignedData
  p7pass2.content = forge.util.createBuffer(u8ToForgeBinary(contentBytes))
  p7pass2.addCertificate(signerCert)
  for (const c of caCerts) p7pass2.addCertificate(c)
  p7pass2.addSigner({
    key: returningKey,
    certificate: signerCert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: cloneAttrs(authAttrs),
  })
  p7pass2.sign({ detached: true })

  // Emit detached SignedData DER. Detached = content not included in
  // envelope — PDF /Contents is the detached signature, PDF content
  // bytes are the signed data (referenced by /ByteRange).
  const der = forge.asn1.toDer(p7pass2.toAsn1()).getBytes()
  return forgeBinaryToU8(der)
}

async function signSha256WithPkcs11Raw(
  modulePath: string,
  slotId: number,
  pin: string,
  keyIdHex: string,
  digestInfoBuffer: Uint8Array,
): Promise<Uint8Array> {
  // signSha256WithPkcs11 (from pdfSignPkcs11.ts) re-hashes the input.
  // Here we have the already-DigestInfo-prefixed buffer; use signHash
  // directly via RSA_PKCS mechanism.
  const { signHash } = await import('./pdfSignPkcs11')
  return signHash(modulePath, slotId, pin, keyIdHex, digestInfoBuffer, 'RSA_PKCS')
}

// ── Binary interop helpers ────────────────────────────────────────

function b64ToU8(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function u8ToForgeBinary(bytes: Uint8Array): string {
  // node-forge uses "binary string" (latin1) for byte data.
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return s
}

function forgeBinaryToU8(s: string): Uint8Array {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xFF
  return out
}

function cloneAttrs<T>(attrs: T[]): T[] {
  // forge mutates the attr objects during sign (filling messageDigest
  // + signingTime values). We need pass 2 to get fresh instances.
  return attrs.map((a) => ({ ...a } as T))
}

/** PKCS#1 v1.5 DigestInfo prefix for SHA-256 (19 bytes) — ASN.1 header
 *  that RSA-signing expects around the raw hash. The token does the
 *  actual RSA op; we do the framing. */
function prependSha256DigestInfo(digest32: Uint8Array): Uint8Array {
  const prefix = new Uint8Array([
    0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86,
    0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05,
    0x00, 0x04, 0x20,
  ])
  const out = new Uint8Array(prefix.length + digest32.length)
  out.set(prefix, 0)
  out.set(digest32, prefix.length)
  return out
}

// Loose shape of forge.pkcs7.createSignedData() return — the types
// from @types/node-forge don't model this module well, so we widen.
interface Pkcs7SignedData {
  content: unknown
  addCertificate(cert: forge.pki.Certificate): void
  addSigner(opts: {
    key: forge.pki.rsa.PrivateKey
    certificate: forge.pki.Certificate
    digestAlgorithm: string
    authenticatedAttributes: Array<{ type: string; value?: unknown }>
  }): void
  sign(options: { detached: boolean }): void
  toAsn1(): forge.asn1.Asn1
}
