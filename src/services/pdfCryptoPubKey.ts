// A10 — Certificate-based encryption (PDF /Filter /Adobe.PubSec).
//
// Encrypts the document body with AES-256 (delegated to zgapdfsigner)
// using a randomly-generated File Encryption Key, then wraps that
// FEK in CMS EnvelopedData per recipient certificate so only the
// matching private key can recover it. The /Encrypt dict declares
// /Filter /Adobe.PubSec /SubFilter /adbe.pkcs7.s5 /V 5 with /Length
// 256; viewers (Acrobat, Foxit) decrypt by walking /Recipients,
// trying each blob against installed certs in their key store, then
// using the recovered FEK to decrypt object streams.
//
// Reference: ISO 32000-2 §7.6.5 (public-key security handlers) +
// PKCS#7 / RFC 5652 (CMS) for the EnvelopedData wrapper.
//
// Pipeline:
//   1. Generate 32-byte random FEK + 4 random IV bytes.
//   2. zga encrypts the document body with AES-256 R=5 using a
//      throwaway password whose KDF outputs an FEK we predict.
//   3. We know that FEK (it's the same one we generated in step 1
//      because we control the throwaway password and salts via
//      a deterministic derivation).
//   4. Replace /Encrypt with the pubkey form: /Filter /Adobe.PubSec
//      /SubFilter /adbe.pkcs7.s5 /V 5 /Length 256 /Recipients [ ... ]
//      /CF << /DefaultCryptFilter << /CFM /AESV3 /Length 32 >> >>
//      /StmF /DefaultCryptFilter /StrF /DefaultCryptFilter.

import forge from 'node-forge'
import { PDFDocument, PDFArray, PDFDict, PDFName, PDFNumber, PDFHexString } from 'pdf-lib'

export interface PubKeyEncryptOptions {
  /** Recipient certificates in PEM format. The encrypted PDF will
   *  decrypt only with a private key matching one of these certs. */
  recipientCertsPem: string[]
  /** PDF /P permission integer (signed 32-bit). Use the same bit
   *  semantics as password-based encryption. Defaults to all
   *  permissions (-4 = 0xFFFFFFFC). */
  permissions?: number
}

const DEFAULT_PERMISSIONS = -4 // bits 3..32 set, bits 1-2 reserved 0

/**
 * Build the per-recipient envelope blob for the /Recipients array.
 *
 * Per PDF spec §7.6.5.2 (Adobe.PubSec /SubFilter /adbe.pkcs7.s5):
 * each blob is a CMS EnvelopedData (RFC 5652 §6) containing a
 * 24-byte payload =
 *   [20 bytes random + 4 bytes /P (little-endian) + ... NO, sorry:]
 *
 * Actually: payload = 20-byte random seed + 4-byte permission word.
 * The seed is also used by the security handler to derive the FEK
 * (concat all seeds, hash, etc. — but for our case we compute the
 * FEK directly from a single 20-byte seed since we use only one
 * recipient class).
 *
 * Returns the DER-encoded CMS EnvelopedData blob as Uint8Array.
 *
 * Public/exported because the tests verify the round-trip
 * (encrypt with cert pubkey → decrypt with cert privkey → same
 * payload bytes).
 */
export function wrapPayloadForRecipient(
  payload: Uint8Array,
  certPem: string,
): Uint8Array {
  const cert = forge.pki.certificateFromPem(certPem)
  const env = forge.pkcs7.createEnvelopedData()
  env.addRecipient(cert)
  env.content = forge.util.createBuffer(uint8ToBinary(payload))
  // AES-128-CBC for content encryption is the broadly-compatible
  // pick (Acrobat reads it; OpenSSL reads it). AES-256 isn't
  // mandated by /Adobe.PubSec; the AES-256 encryption is on the
  // PDF content, not on this envelope.
  env.encrypt(undefined, forge.pki.oids['aes128-CBC'])
  const asn1 = env.toAsn1()
  const der = forge.asn1.toDer(asn1).getBytes()
  return binaryToUint8(der)
}

/**
 * Decrypt a recipient blob with the matching private key. Used by
 * tests to verify wrapPayloadForRecipient round-trips. Real PDF
 * viewers do this internally.
 */
export function unwrapPayloadForRecipient(
  envelopeDer: Uint8Array,
  certPem: string,
  privateKeyPem: string,
): Uint8Array {
  const asn1 = forge.asn1.fromDer(uint8ToBinary(envelopeDer))
  const env = forge.pkcs7.messageFromAsn1(asn1)
  const cert = forge.pki.certificateFromPem(certPem)
  const privateKey = forge.pki.privateKeyFromPem(privateKeyPem)
  // forge's decrypt API requires the recipient match - first arg is
  // the recipient (so we can pick by issuer/serial), second is the
  // private key.
  // Type cast: forge.pkcs7's TS bindings don't surface decrypt cleanly.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const envAny = env as any
  const recipient = envAny.findRecipient(cert)
  if (!recipient) throw new Error('No matching recipient found')
  envAny.decrypt(recipient, privateKey)
  const decryptedBinary: string = envAny.content.getBytes()
  return binaryToUint8(decryptedBinary)
}

/**
 * Build the 24-byte recipient payload = 20-byte seed || 4-byte
 * permissions (little-endian). The 20 random bytes are what the
 * security handler hashes (along with similar bytes from other
 * recipients) to derive the FEK; for a single-recipient encrypt
 * we keep them simple — they're cryptographically random.
 *
 * Permissions encoding: the same /P signed-int bit layout as
 * password-based encryption. We pack as little-endian since
 * Adobe writes that way in the public-key envelope.
 */
export function buildRecipientPayload(
  seed20: Uint8Array,
  permissions: number,
): Uint8Array {
  if (seed20.length !== 20) throw new Error(`seed must be 20 bytes (got ${seed20.length})`)
  const out = new Uint8Array(24)
  out.set(seed20, 0)
  // 4-byte signed int little-endian. Use DataView for sign correctness.
  new DataView(out.buffer).setInt32(20, permissions, true)
  return out
}

/**
 * Compute the FEK from the recipient seed(s). Per PDF spec, the FEK
 * is derived by hashing the concat of all 20-byte seeds (each
 * unwrapped from its envelope), then for AES-256 the hash output is
 * iterated to 32 bytes. With a single recipient: FEK = SHA-256(seed20).
 *
 * Returns a 32-byte FEK suitable for AES-256 object encryption.
 */
export function deriveFekFromSeeds(seeds: Uint8Array[]): Uint8Array {
  // Per Adobe Supplement to ISO 32000 (Acrobat 9 / V=5):
  // permsHash = SHA-256(seed20 [|| seed20_2 || ...] || /P bytes (skipped at V=5))
  // The cipher key is the first n bytes of permsHash; for AES-256, all 32.
  const md = forge.md.sha256.create()
  for (const s of seeds) md.update(uint8ToBinary(s))
  return binaryToUint8(md.digest().getBytes())
}

/**
 * Build the /Encrypt dictionary entries for V=5 /Adobe.PubSec
 * pubkey encryption. Returns an object that callers spread into a
 * PDFDict via PDF-lib's API. (Pure data; doesn't touch the file.)
 */
export function buildPubKeyEncryptDictData(
  recipientEnvelopes: Uint8Array[],
  permissions: number = DEFAULT_PERMISSIONS,
): {
  Filter: string
  SubFilter: string
  V: number
  Length: number
  P: number
  Recipients: Uint8Array[]
  CFShape: { defaultName: 'DefaultCryptFilter'; CFM: 'AESV3'; Length: 32 }
} {
  return {
    Filter: 'Adobe.PubSec',
    SubFilter: 'adbe.pkcs7.s5',
    V: 5,
    Length: 256, // bits — 32-byte AES-256 key
    P: permissions,
    Recipients: recipientEnvelopes,
    CFShape: {
      defaultName: 'DefaultCryptFilter',
      CFM: 'AESV3',
      Length: 32,
    },
  }
}

// ── Wire into a PDF document ────────────────────────────────────

/**
 * Encrypt a PDF end-to-end for a set of recipient certificates.
 *
 * Pipeline:
 *  1. Generate a 20-byte random seed.
 *  2. FEK = SHA-256(seed) per Adobe V=5 spec.
 *  3. For each recipient cert: build a CMS EnvelopedData blob
 *     wrapping the 24-byte payload (seed || /P little-endian).
 *  4. Hand off the cleartext PDF + envelopes + FEK + permissions
 *     to the Rust `pdf_encrypt_to_certs` command, which walks
 *     every indirect object, AES-256-CBC encrypts strings + stream
 *     content (random per-object IV), and installs the V=5
 *     /Encrypt dict with /Filter /Adobe.PubSec /SubFilter
 *     /adbe.pkcs7.s5 and /Recipients on /CF/DefaultCryptFilter.
 *
 * Returns the encrypted PDF bytes — ready to save to disk.
 * Adobe Reader (and any V=5-aware viewer) recognises the dict
 * and decrypts via the matching cert's private key.
 */
export async function encryptPdfToCerts(
  bytes: Uint8Array,
  opts: PubKeyEncryptOptions,
): Promise<Uint8Array> {
  if (!opts.recipientCertsPem || opts.recipientCertsPem.length === 0) {
    throw new Error('encryptPdfToCerts: at least one recipient cert required')
  }
  const permissions = opts.permissions ?? DEFAULT_PERMISSIONS
  const seedBin = forge.random.getBytesSync(20)
  const seed = binaryToUint8(seedBin)
  const payload = buildRecipientPayload(seed, permissions)
  const envelopes = opts.recipientCertsPem.map((pem) =>
    wrapPayloadForRecipient(payload, pem),
  )
  const fek = deriveFekFromSeeds([seed])
  // Rust IPC. Tauri v2 marshals Vec<u8> as number[] across the
  // boundary efficiently — multi-MB PDFs transit in single-digit ms.
  const { invoke } = await import('@tauri-apps/api/core')
  const out = await invoke<number[] | Uint8Array>('pdf_encrypt_to_certs', {
    bytes: Array.from(bytes),
    recipientEnvelopes: envelopes.map((e) => Array.from(e)),
    fek: Array.from(fek),
    permissions,
  })
  return out instanceof Uint8Array ? out : new Uint8Array(out)
}

/**
 * Lower-level helper kept around for tests + dict-shape inspection
 * — produces a pd-lib PDFDocument with the V=5 /Encrypt dict
 * embedded but body NOT encrypted. Useful when you want to verify
 * the dict structure without running the Rust encryptor. Production
 * callers should use `encryptPdfToCerts` above for end-to-end
 * encryption.
 */
export async function buildPubKeyEncryptDictForDocument(
  bytes: Uint8Array,
  opts: PubKeyEncryptOptions,
): Promise<{ doc: PDFDocument; fek: Uint8Array; seedHex: string }> {
  if (!opts.recipientCertsPem || opts.recipientCertsPem.length === 0) {
    throw new Error('At least one recipient certificate required')
  }
  const doc = await PDFDocument.load(bytes, {
    throwOnInvalidObject: false,
    ignoreEncryption: true,
  })
  const ctx = doc.context
  const permissions = opts.permissions ?? DEFAULT_PERMISSIONS

  // Per-encryption seed. Single seed shared across recipients —
  // matches Adobe's typical layout for class=DEFAULT recipients.
  const seedBin = forge.random.getBytesSync(20)
  const seed20 = binaryToUint8(seedBin)
  const payload = buildRecipientPayload(seed20, permissions)
  const envelopes = opts.recipientCertsPem.map((pem) =>
    wrapPayloadForRecipient(payload, pem),
  )

  const fek = deriveFekFromSeeds([seed20])

  // Build the /Encrypt dict.
  const encDict = ctx.obj({}) as PDFDict
  encDict.set(PDFName.of('Filter'), PDFName.of('Adobe.PubSec'))
  encDict.set(PDFName.of('SubFilter'), PDFName.of('adbe.pkcs7.s5'))
  encDict.set(PDFName.of('V'), PDFNumber.of(5))
  encDict.set(PDFName.of('Length'), PDFNumber.of(256))
  encDict.set(PDFName.of('P'), PDFNumber.of(permissions))
  // Recipients array of PKCS#7 envelopes (PDF byte strings).
  const recArray = PDFArray.withContext(ctx)
  for (const env of envelopes) {
    recArray.push(PDFHexString.of(bytesToHex(env)))
  }
  encDict.set(PDFName.of('Recipients'), recArray)

  // Crypt filter declaration. /DefaultCryptFilter is the conventional
  // name; /CFM /AESV3 selects AES-256 per ISO 32000-2 §7.6.5.
  const cf = ctx.obj({}) as PDFDict
  const defaultFilter = ctx.obj({}) as PDFDict
  defaultFilter.set(PDFName.of('CFM'), PDFName.of('AESV3'))
  defaultFilter.set(PDFName.of('Length'), PDFNumber.of(32))
  cf.set(PDFName.of('DefaultCryptFilter'), defaultFilter)
  encDict.set(PDFName.of('CF'), cf)
  encDict.set(PDFName.of('StmF'), PDFName.of('DefaultCryptFilter'))
  encDict.set(PDFName.of('StrF'), PDFName.of('DefaultCryptFilter'))

  const encRef = ctx.register(encDict)
  ctx.trailerInfo.Encrypt = encRef

  return {
    doc,
    fek,
    seedHex: bytesToHex(seed20),
  }
}

// ── Helpers (internal) ─────────────────────────────────────────────

function uint8ToBinary(arr: Uint8Array): string {
  let s = ''
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i])
  return s
}

function binaryToUint8(s: string): Uint8Array {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}

function bytesToHex(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0')
  return s
}

/**
 * Generate a self-signed test certificate + RSA private key, both
 * PEM-encoded. EXPORTED FOR TESTS — do not call from production
 * code. Returns { certPem, privateKeyPem } which can be used by
 * wrap/unwrap round-trip tests.
 */
export function generateTestSelfSignedCert(commonName: string = 'Test User'): {
  certPem: string
  privateKeyPem: string
} {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 })
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '01'
  cert.validity.notBefore = new Date()
  cert.validity.notAfter = new Date()
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1)
  const attrs = [
    { name: 'commonName', value: commonName },
    { name: 'organizationName', value: 'Test' },
    { name: 'countryName', value: 'US' },
  ]
  cert.setSubject(attrs)
  cert.setIssuer(attrs)
  cert.sign(keys.privateKey, forge.md.sha256.create())
  return {
    certPem: forge.pki.certificateToPem(cert),
    privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
  }
}
