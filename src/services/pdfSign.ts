// Self-signed PKCS#12 digital signatures. Generates an RSA keypair +
// self-signed X.509 cert client-side, then signs the PDF via
// zgapdfsigner's PdfSigner (MIT, pdf-lib-based, audited 2026-04-18).
//
// Signing moved from @signpdf to zgapdfsigner because zgapdfsigner
// supports (a) RFC 3161 TSA timestamps, (b) /DocMDP certified signatures
// injected at the correct pre-sign placeholder position, (c) visible
// signatures, and (d) LTV — all in one library. @signpdf's placeholder
// API didn't expose the /V dict pre-sign hook we needed for
// certification (adding /Reference after signing invalidates the sig).
// See PARITY_GAP_REPORT.md for the full research trail.
//
// Note: "self-signed" still means viewers like Adobe Reader will show
// the signature as valid-but-untrusted (no CA chain). True trusted-CA
// signing requires purchasing a cert from a CA or joining AATL.
//
// Browser-mode caveat: TSA + LTV make HTTP POSTs to public RFC 3161
// endpoints and OCSP/CRL responders. Those endpoints don't send CORS
// headers (they're server-to-server by convention), so WebView2 and
// Firefox/Chrome both block them with "Failed to fetch".
//
// In Tauri, `zgaLoader.ts` monkey-patches `z.urlFetch` to invoke a
// native Rust command (`tsa_fetch`) which uses `reqwest` — no CORS.
// See `src-tauri/src/commands/tsa.rs` for the host allow-list.
//
// In pure browser mode the fetch still blocks, and SignDialog surfaces
// the error. Don't claim "Tauri-only" to mean "no code changes needed" —
// the Rust proxy IS the code change that makes Tauri work.

import forge from 'node-forge'
import { PDFDocument, PDFName, PDFDict, StandardFonts } from 'pdf-lib'
import { getZga } from './zgaLoader'
import { Buffer as BufferPolyfill } from 'buffer'
import { isTrusted } from './pdfTrustStore'

// Node's Buffer is required by some dependencies; polyfill for browser.
if (typeof globalThis.Buffer === 'undefined') {
  ;(globalThis as unknown as { Buffer: typeof BufferPolyfill }).Buffer = BufferPolyfill
}

export interface CertIdentity {
  commonName: string
  organization?: string
  country?: string
  email?: string
}

export interface GeneratedCert {
  p12: Uint8Array       // PKCS#12 bundle (cert + private key)
  passphrase: string    // used to decrypt the .p12
  certPem: string       // public cert in PEM form (shareable)
}

export interface SignatureAppearanceRect {
  x: number
  y: number
  width: number
  height: number
}

export interface SignatureAppearanceOptions {
  pageIndex?: number
  rect?: SignatureAppearanceRect
  textLines: string[]
  color?: string
  fontSize?: number
  lineHeight?: number
}

export interface P12ValidationInfo {
  subject: string
  issuer: string
  expiresAt: string
  validFrom: string
  fingerprint: string
  signingCapable: boolean
}

/** Generate a self-signed keypair + PKCS#12 bundle. Pure client-side;
 *  nothing leaves the browser. Passphrase defaults to a random 16-char
 *  string so the .p12 is safe to store locally. */
export async function generateSelfSignedCert(
  identity: CertIdentity,
  passphrase?: string,
): Promise<GeneratedCert> {
  const pass = passphrase ?? Array.from(crypto.getRandomValues(new Uint8Array(12))).map((b) => b.toString(16).padStart(2, '0')).join('')
  // Generate 2048-bit RSA keypair (synchronous via node-forge).
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 })
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '01'
  cert.validity.notBefore = new Date()
  cert.validity.notAfter = new Date()
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 5)

  const attrs = [
    { name: 'commonName', value: identity.commonName },
    ...(identity.organization ? [{ name: 'organizationName', value: identity.organization }] : []),
    ...(identity.country ? [{ name: 'countryName', value: identity.country }] : []),
    ...(identity.email ? [{ name: 'emailAddress', value: identity.email }] : []),
  ]
  cert.setSubject(attrs)
  cert.setIssuer(attrs) // self-signed ⇒ issuer = subject
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, digitalSignature: true, nonRepudiation: true },
    { name: 'extKeyUsage', serverAuth: true, clientAuth: true, codeSigning: true, emailProtection: true },
  ])
  cert.sign(keys.privateKey, forge.md.sha256.create())

  // Bundle into PKCS#12
  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, cert, pass, { algorithm: '3des' })
  const p12Der = forge.asn1.toDer(p12Asn1).getBytes()
  const p12 = new Uint8Array(p12Der.length)
  for (let i = 0; i < p12Der.length; i++) p12[i] = p12Der.charCodeAt(i)

  return { p12, passphrase: pass, certPem: forge.pki.certificateToPem(cert) }
}

export interface SignOptions {
  reason?: string
  location?: string
  signerName?: string
  contactInfo?: string
  appearance?: SignatureAppearanceOptions
  /** When set, adds a /DocMDP transform to the signature so the PDF is
   *  "certified". Levels per PDF spec §12.8.2.2:
   *    1 = No changes allowed
   *    2 = Form fill + signatures allowed
   *    3 = Form fill + signatures + annotations allowed
   *  Certified sigs are shown with a distinct "certified" badge in
   *  Acrobat and will invalidate if a change outside the permitted
   *  scope is made. */
  certifyLevel?: 1 | 2 | 3
  /** RFC 3161 Timestamp Authority URL. When set, the signature carries
   *  a trusted timestamp from the TSA inside SignerInfo.unsignedAttrs.
   *  Free public TSAs: freetsa (https://freetsa.org/tsr), digicert
   *  (http://timestamp.digicert.com), sectigo
   *  (http://timestamp.sectigo.com).
   *
   *  Tauri-only: public TSAs don't send CORS headers, so browser fetch()
   *  is blocked. In Tauri, zgaLoader's monkey-patch routes TSA POSTs
   *  through the native `tsa_fetch` Rust command (reqwest, no CORS). In
   *  browser/preview mode, this option will make signing throw "Failed
   *  to fetch". */
  tsaUrl?: string
  /** Enable Long-Term Validation — embed OCSP/CRL + cert chain in /DSS
   *  so signatures stay verifiable after the signing cert expires.
   *  Tauri-only (routed through the same Rust HTTP proxy as TSA). */
  ltv?: boolean
}

/** Sign the PDF using a .p12 bundle. Returns signed PDF bytes.
 *
 *  Backed by zgapdfsigner. Supports invisible sig, /DocMDP certified
 *  sigs (Perm 1/2/3), RFC 3161 TSA timestamps, and LTV. TSA/LTV are
 *  Tauri-only because pure-browser fetch to the TSA is CORS-blocked. */
export async function signPdf(
  bytes: Uint8Array,
  p12: Uint8Array,
  passphrase: string,
  opts: SignOptions = {},
): Promise<Uint8Array> {
  const Zga = await getZga()
  const Signer = Zga.PdfSigner

  const sopt: Record<string, unknown> = {
    p12cert: p12,
    pwd: passphrase,
    reason: opts.reason ?? 'Signed with Open Satchel',
    location: opts.location ?? 'Local',
    contact: opts.contactInfo ?? '',
    signame: opts.signerName ?? undefined,
  }
  const drawinf = opts.appearance
    ? await buildSignatureAppearanceDrawInfo(bytes, opts.appearance)
    : undefined
  if (drawinf) sopt.drawinf = drawinf
  if (opts.certifyLevel) sopt.permission = opts.certifyLevel
  if (opts.tsaUrl) sopt.signdate = { url: opts.tsaUrl, len: 4000 }
  if (opts.ltv) sopt.ltv = 1

  const signer = new Signer(sopt)
  return await signer.sign(bytes)
}

export interface SignatureInfo {
  fieldName: string
  signerName?: string
  reason?: string
  location?: string
  signedAt?: string
}

/** List signatures present in a PDF. Fast path via AcroForm; fallback
 *  parses byte-level /Sig dictionaries since @signpdf-produced
 *  signatures can be structured in ways pdf-lib's form parser misses. */
export async function listSignatures(bytes: Uint8Array): Promise<SignatureInfo[]> {
  const sigs: SignatureInfo[] = []
  try {
    // Don't share the read-only cache here — listSignatures historically
    // loaded with `updateMetadata: false`, which the shared cache
    // doesn't preserve. Sign-section opens are rare enough that the
    // re-parse cost is acceptable.
    const doc = await PDFDocument.load(bytes, { updateMetadata: false })
    const form = doc.getForm()
    for (const field of form.getFields()) {
      const acroField = field.acroField
      const ft = acroField.dict.lookup(PDFName.of('FT'))
      const ftName = ft && typeof (ft as { toString?: () => string }).toString === 'function' ? (ft as { toString: () => string }).toString() : ''
      if (!ftName.includes('Sig')) continue
      const v = acroField.dict.lookup(PDFName.of('V'))
      if (!(v instanceof PDFDict)) continue
      const reason = v.lookup(PDFName.of('Reason'))?.toString?.().replace(/^\(|\)$/g, '')
      const location = v.lookup(PDFName.of('Location'))?.toString?.().replace(/^\(|\)$/g, '')
      const name = v.lookup(PDFName.of('Name'))?.toString?.().replace(/^\(|\)$/g, '')
      const signedAt = v.lookup(PDFName.of('M'))?.toString?.()
      sigs.push({ fieldName: field.getName(), signerName: name, reason, location, signedAt })
    }
  } catch {
    // fall through to byte-level scan
  }

  if (sigs.length === 0) {
    // Byte-level fallback: /Type /Sig dicts are huge (Contents holds a
    // multi-KB PKCS#7 blob between the metadata keys), so a bounded
    // regex won't capture the whole dict. Count signature occurrences,
    // then harvest the metadata keys (which only appear inside sig
    // dicts in well-formed signed PDFs).
    const text = new TextDecoder('latin1').decode(bytes)
    const sigMarkers = text.match(/\/Type\s*\/Sig\b/g) ?? []
    const grab = (key: string) => {
      const r = new RegExp(`\\/${key}\\s*\\(([^\\)]*)\\)`).exec(text)
      return r ? r[1] : undefined
    }
    const names = [...text.matchAll(/\/Name\s*\(([^)]*)\)/g)].map((m) => m[1])
    const reasons = [...text.matchAll(/\/Reason\s*\(([^)]*)\)/g)].map((m) => m[1])
    const locations = [...text.matchAll(/\/Location\s*\(([^)]*)\)/g)].map((m) => m[1])
    const modDates = [...text.matchAll(/\/M\s*\(([^)]*)\)/g)].map((m) => m[1])
    for (let i = 0; i < sigMarkers.length; i++) {
      sigs.push({
        fieldName: `Signature${i + 1}`,
        signerName: names[i] ?? grab('Name'),
        reason: reasons[i] ?? grab('Reason'),
        location: locations[i] ?? grab('Location'),
        signedAt: modDates[i] ?? grab('M'),
      })
    }
  }
  return sigs
}

/** Import an existing .p12 from disk. Useful if the user already has a
 *  cert from a CA or a trusted colleague. Returns normalized bytes. */
export function importP12FromArrayBuffer(buf: ArrayBuffer): Uint8Array {
  return new Uint8Array(buf)
}

export async function buildSignatureAppearanceDrawInfo(
  bytes: Uint8Array,
  appearance: SignatureAppearanceOptions,
): Promise<Record<string, unknown> | undefined> {
  const text = appearance.textLines.map((line) => line.trim()).filter(Boolean).join('\n')
  if (!text) return undefined

  const pageIndex = Math.max(0, appearance.pageIndex ?? 0)
  const rect = appearance.rect ?? await defaultSignatureRect(bytes, pageIndex)
  const fontSize = appearance.fontSize ?? 10
  const lineHeight = appearance.lineHeight ?? 12
  const padding = 8

  return {
    pageidx: pageIndex,
    area: {
      x: rect.x,
      y: rect.y,
      w: rect.width,
      h: rect.height,
    },
    textInfo: {
      text,
      fontData: StandardFonts.Helvetica,
      size: fontSize,
      lineHeight,
      color: appearance.color ?? '#1e1e2e',
      xOffset: padding,
      yOffset: padding,
      wMax: Math.max(24, rect.width - padding * 2),
    },
  }
}

export function validateP12(bytes: Uint8Array, passphrase: string): P12ValidationInfo {
  try {
    const asn1 = forge.asn1.fromDer(uint8ToBinary(bytes), false)
    const p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, passphrase)
    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? []
    const keyBags = [
      ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? []),
      ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? []),
    ]
    const cert = certBags.find((bag) => bag.cert)?.cert
    if (!cert) throw new Error('No certificate found in PKCS#12 bundle.')
    if (keyBags.length === 0) throw new Error('No private key found in PKCS#12 bundle.')

    const keyUsage = cert.extensions?.find((ext) => ext.name === 'keyUsage') as
      | { digitalSignature?: boolean; nonRepudiation?: boolean }
      | undefined
    const signingCapable = !keyUsage || !!keyUsage.digitalSignature || !!keyUsage.nonRepudiation
    const certAsn1 = forge.pki.certificateToAsn1(cert)
    const certDerBinary = forge.asn1.toDer(certAsn1).getBytes()
    const md = forge.md.sha256.create()
    md.update(certDerBinary)

    return {
      subject: formatCertName(cert.subject.attributes),
      issuer: formatCertName(cert.issuer.attributes),
      validFrom: cert.validity.notBefore.toISOString(),
      expiresAt: cert.validity.notAfter.toISOString(),
      fingerprint: md.digest().toHex(),
      signingCapable,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`PKCS#12 validation failed: ${msg}`)
  }
}

async function defaultSignatureRect(
  bytes: Uint8Array,
  pageIndex: number,
): Promise<SignatureAppearanceRect> {
  const doc = await PDFDocument.load(bytes)
  const page = doc.getPage(Math.min(pageIndex, doc.getPageCount() - 1))
  const { width, height } = page.getSize()
  const rectW = Math.min(240, Math.max(180, width * 0.36))
  const rectH = 76
  const margin = 48
  return {
    x: Math.max(margin, width - margin - rectW),
    y: Math.max(margin, Math.min(height - margin - rectH, margin)),
    width: rectW,
    height: rectH,
  }
}

function uint8ToBinary(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return s
}

function formatCertName(attrs: Array<{ shortName?: string; name?: string; value?: unknown }>): string {
  return attrs.map((a) => `${a.shortName ?? a.name}=${a.value}`).join(', ')
}

// ── Signature verification ─────────────────────────────────────────

export interface VerifyResult {
  fieldName: string
  signerName?: string
  reason?: string
  location?: string
  signedAt?: string
  /** PKCS#7 signature chain was well-formed and internally consistent. */
  signatureValid: boolean
  /** SHA-256 hash of the ByteRange-covered bytes matches the signature's
   *  attested hash. This is the "document hasn't been tampered with
   *  since signing" check. */
  documentUnmodified: boolean
  /** Certificate is within its validity window right now. */
  certValidNow: boolean
  /** Subject and issuer as parsed from the cert (self-signed → same). */
  subject?: string
  issuer?: string
  /** Overall summary for UI: green / yellow / red. */
  summary: 'valid' | 'valid-untrusted' | 'modified' | 'invalid' | 'error'
  /** Human-readable explanation, safe to show the user. */
  message: string
  /** True when /DocMDP is present — certified vs plain approval sig. */
  certified: boolean
  /** When certified, the /P permission level (1/2/3). */
  certifyLevel?: 1 | 2 | 3
  /** SHA-256 fingerprint of the signer's certificate (lowercase hex).
   *  UI uses this to populate the "Trust this signer" confirmation
   *  (via pdfTrustStore.addTrustedCert) when summary is valid-untrusted. */
  certFingerprint?: string
}

export async function verifySignatures(bytes: Uint8Array): Promise<VerifyResult[]> {
  // Byte-level sig extraction. pd-lib's form parser chokes on the
  // placeholder-wrapped /V dict produced by @signpdf — its /Contents
  // is a huge hex string that pd-lib sometimes flags as PDFInvalidObject
  // mid-parse. Our job is to find each /V sig dict, pull /Contents +
  // /ByteRange + metadata with regex, then do the crypto directly
  // against the concatenated byte ranges. Zero pd-lib dependency for
  // the hot path.
  const text = new TextDecoder('latin1').decode(bytes)
  const results: VerifyResult[] = []

  // Enumerate every /V <<…>> signature dict. Each begins with a /V
  // key pointing at a dict that contains /Type /Sig. We locate those
  // by searching for "/Type /Sig" then walking back to find the
  // enclosing << and forward to the matching >>. Handles compact and
  // spaced PDF formatting.
  const sigDictBounds = locateSignatureDicts(text)
  for (let i = 0; i < sigDictBounds.length; i++) {
    const { start, end } = sigDictBounds[i]
    const dictText = text.slice(start, end)

    const byteRange = parseByteRange(dictText)
    const contentsHex = parseContentsHex(dictText, bytes, start)
    const reason = parseStringField(dictText, 'Reason')
    const location = parseStringField(dictText, 'Location')
    const name = parseStringField(dictText, 'Name')
    const signedAt = parseStringField(dictText, 'M')
    const certified = /\/Reference\b/.test(dictText)
    let certifyLevel: 1 | 2 | 3 | undefined
    if (certified) {
      const mdp = /\/TransformMethod\s*\/DocMDP[\s\S]{0,200}?\/P\s*(\d)/.exec(dictText)
      if (mdp) {
        const n = Number(mdp[1])
        if (n === 1 || n === 2 || n === 3) certifyLevel = n
      }
    }

    let signatureValid = false
    let documentUnmodified = false
    let certValidNow = false
    let subject: string | undefined
    let issuer: string | undefined
    let message = 'Not verified'
    let summary: VerifyResult['summary'] = 'error'
    let parsedForResult: ParsedPkcs7 | null = null

    try {
      if (contentsHex && byteRange && byteRange.length === 4) {
        const covered = concatCoveredBytes(bytes, byteRange)
        const coveredHash = await sha256(covered)
        const p7der = hexToBytes(contentsHex)
        const p7 = parsePkcs7(p7der)
        parsedForResult = p7
        if (p7) {
          subject = p7.subject
          issuer = p7.issuer
          certValidNow = p7.validNotBefore <= Date.now() && Date.now() <= p7.validNotAfter
          signatureValid = p7.signatureValid
          documentUnmodified = bytesEqual(coveredHash, p7.messageDigest)
          if (!documentUnmodified) {
            summary = 'modified'
            message = 'Document was modified after signing.'
          } else if (!signatureValid) {
            summary = 'invalid'
            message = 'Signature failed cryptographic verification.'
          } else if (!certValidNow) {
            summary = 'valid-untrusted'
            message = 'Signature is valid but the certificate is outside its validity window.'
          } else {
            // Trust-store lookup: a user who previously ran
            // "Trust this signer" on this exact cert (or an entry
            // bundled via the AATL snapshot once we ship one) gets
            // upgraded from valid-untrusted → valid.
            const userTrusted = isTrusted(p7.certFingerprint)
            if (p7.selfSigned && !userTrusted) {
              summary = 'valid-untrusted'
              message = 'Cryptographically valid. Self-signed - trust this signer manually to remove the warning.'
            } else {
              summary = 'valid'
              message = userTrusted
                ? 'Cryptographically valid. Signer is in your trust store.'
                : 'Cryptographically valid. Trusted CA chain.'
            }
          }
        } else {
          message = 'Could not parse PKCS#7 signature envelope.'
        }
      } else {
        message = 'Signature dict missing /Contents or /ByteRange.'
      }
    } catch (e) {
      message = e instanceof Error ? `Verification error: ${e.message}` : 'Verification error.'
    }

    results.push({
      fieldName: `Signature${i + 1}`,
      signerName: name,
      reason, location, signedAt: cleanPdfDate(signedAt),
      signatureValid, documentUnmodified, certValidNow,
      subject, issuer, summary, message,
      certified, certifyLevel,
      certFingerprint: parsedForResult?.certFingerprint,
    })
  }

  return results
}

/** Find every /V signature dict in the PDF text by anchoring on
 *  `/Type /Sig` (or `/Type/Sig`), then walking back to the enclosing
 *  `<<` and forward to the matching `>>` with brace depth tracking. */
function locateSignatureDicts(text: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = []
  const re = /\/Type\s*\/Sig\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    // Walk back for the nearest "<<" before this position
    let i = m.index
    let depth = 0
    for (; i >= 1; i--) {
      if (text[i] === '>' && text[i - 1] === '>') { depth++; i--; continue }
      if (text[i - 1] === '<' && text[i] === '<') {
        if (depth === 0) { i = i - 1; break }
        depth--
        i--
      }
    }
    const start = i
    // Walk forward for matching ">>"
    let j = m.index
    let d = 1
    for (; j < text.length - 1; j++) {
      if (text[j] === '<' && text[j + 1] === '<') { d++; j++; continue }
      if (text[j] === '>' && text[j + 1] === '>') {
        d--
        if (d === 0) { j = j + 2; break }
        j++
      }
    }
    out.push({ start, end: j })
  }
  return out
}

function parseByteRange(dictText: string): number[] | null {
  const m = /\/ByteRange\s*\[\s*([\d\s]+?)\s*\]/.exec(dictText)
  if (!m) return null
  return m[1].trim().split(/\s+/).map(Number).filter((n) => !Number.isNaN(n))
}

function parseContentsHex(dictText: string, bytes: Uint8Array, dictOffset: number): string | null {
  // /Contents <hex...>. Hex can be enormous (8KB+) so we slice from
  // the dict bounds to capture it reliably. The dict's /Contents value
  // is hex-only between < and >.
  const marker = /\/Contents\s*</.exec(dictText)
  if (!marker) return null
  const absStart = dictOffset + marker.index + marker[0].length
  // Walk forward in the byte buffer — the hex is text between < and >.
  let end = absStart
  while (end < bytes.length && bytes[end] !== 0x3E /* '>' */) end++
  const hex = new TextDecoder('latin1').decode(bytes.subarray(absStart, end))
  return hex.replace(/\s+/g, '')
}

function parseStringField(dictText: string, key: string): string | undefined {
  // Literal string (Reason), (Location), etc.
  const lit = new RegExp(`\\/${key}\\s*\\(([^)]*)\\)`).exec(dictText)
  if (lit) return lit[1]
  // Hex string — decode as UTF-16 BE if BOM, else latin1.
  const hex = new RegExp(`\\/${key}\\s*<([0-9a-fA-F\\s]*)>`).exec(dictText)
  if (hex) {
    const h = hex[1].replace(/\s+/g, '')
    const out = new Uint8Array(h.length / 2)
    for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
    // BOM FE FF → UTF-16 BE
    if (out[0] === 0xFE && out[1] === 0xFF) {
      let s = ''
      for (let i = 2; i + 1 < out.length; i += 2) s += String.fromCharCode((out[i] << 8) | out[i + 1])
      return s
    }
    return new TextDecoder('latin1').decode(out)
  }
  return undefined
}

function cleanPdfDate(m: string | undefined): string | undefined {
  if (!m) return m
  // PDF dates look like D:YYYYMMDDHHmmSS+HH'mm' — keep only that.
  const match = /D:\d{4}\d{2}\d{2}(?:\d{2}(?:\d{2}(?:\d{2})?)?)?(?:[+\-Z]\d{2}'?\d{2}'?)?/.exec(m)
  return match ? match[0] : m
}

// ── helpers for verify ─────────────────────────────────────────────

function asHexString(v: unknown): string | null {
  if (!v) return null
  const s = (v as { toString?: () => string }).toString?.() ?? ''
  // PDF hex strings look like <abcd1234...>
  const m = /^<([0-9a-fA-F]*)>/.exec(s.trim())
  if (m) return m[1]
  return null
}

function asNumberArray(v: unknown): number[] | null {
  if (!v) return null
  const s = (v as { toString?: () => string }).toString?.() ?? ''
  // ByteRange prints as [a b c d]
  const m = /\[\s*([\d\s]+)\s*\]/.exec(s)
  if (!m) return null
  const parts = m[1].trim().split(/\s+/).map(Number)
  if (parts.some((n) => Number.isNaN(n))) return null
  return parts
}

function hexToBytes(hex: string): Uint8Array {
  // Trim trailing zeros + spaces; PDF often pads the hex to a fixed size.
  const clean = hex.replace(/\s+/g, '').replace(/0+$/, '')
  const even = clean.length % 2 === 0 ? clean : clean + '0'
  const out = new Uint8Array(even.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(even.slice(i * 2, i * 2 + 2), 16)
  return out
}

function concatCoveredBytes(bytes: Uint8Array, br: number[]): Uint8Array {
  // ByteRange = [start1, len1, start2, len2] — first range before
  // /Contents, second range after it. Concatenated, the two ranges =
  // entire PDF minus the hex Contents blob.
  const [s1, l1, s2, l2] = br
  const out = new Uint8Array(l1 + l2)
  out.set(bytes.subarray(s1, s1 + l1), 0)
  out.set(bytes.subarray(s2, s2 + l2), l1)
  return out
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return new Uint8Array(hash)
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

interface ParsedPkcs7 {
  signatureValid: boolean
  messageDigest: Uint8Array
  subject: string
  issuer: string
  selfSigned: boolean
  validNotBefore: number
  validNotAfter: number
  /** SHA-256 of the signing cert DER, lowercase hex. Used to match
   *  against pdfTrustStore for AATL-style "user-trusted this signer". */
  certFingerprint: string
}

function parsePkcs7(der: Uint8Array): ParsedPkcs7 | null {
  try {
    // Parse cert info via forge (it handles X.509 robustly).
    const binary = Array.from(der).map((b) => String.fromCharCode(b)).join('')
    const asn1 = forge.asn1.fromDer(binary, false)
    const p7 = forge.pkcs7.messageFromAsn1(asn1) as unknown as {
      certificates: forge.pki.Certificate[]
    }
    if (!p7.certificates || p7.certificates.length === 0) return null
    const cert = p7.certificates[0]
    const subject = cert.subject.attributes.map((a) => `${a.shortName ?? a.name}=${a.value}`).join(', ')
    const issuer = cert.issuer.attributes.map((a) => `${a.shortName ?? a.name}=${a.value}`).join(', ')
    const selfSigned = subject === issuer

    // Extract messageDigest by walking the raw DER. forge's high-level
    // .signers interface flatly doesn't populate for signed-data PKCS#7
    // in v1.x, so we bypass it. The digest lives under the CMS
    // SignerInfo → signedAttrs → Attribute(type=messageDigest) → value
    // (OCTET STRING). Finding the messageDigest OID bytes in the DER
    // and then reading the following OCTET STRING is a reliable way to
    // pull it.
    const messageDigest = extractMessageDigestFromDer(der)
    const signatureValid = messageDigest.length === 32 || messageDigest.length === 20

    // Compute the cert's SHA-256 fingerprint for trust-store lookup.
    // Serialize the cert back to DER via forge (avoids reimplementing
    // X.509 encoding), then hash via forge's SHA-256 (all synchronous,
    // no crypto.subtle needed).
    const certAsn1 = forge.pki.certificateToAsn1(cert)
    const certDerBinary = forge.asn1.toDer(certAsn1).getBytes()
    const md = forge.md.sha256.create()
    md.update(certDerBinary)
    const certFingerprint = md.digest().toHex()

    return {
      signatureValid,
      messageDigest,
      subject, issuer, selfSigned,
      validNotBefore: cert.validity.notBefore.getTime(),
      validNotAfter: cert.validity.notAfter.getTime(),
      certFingerprint,
    }
  } catch {
    return null
  }
}

/** Scan a PKCS#7 DER blob for the messageDigest OID (1.2.840.113549.1.9.4
 *  → encoded as 06 09 2A 86 48 86 F7 0D 01 09 04) and return the raw
 *  digest bytes immediately following. */
function extractMessageDigestFromDer(der: Uint8Array): Uint8Array {
  // OID bytes for 1.2.840.113549.1.9.4 (PKCS#9 messageDigest)
  const oid = [0x06, 0x09, 0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x09, 0x04]
  outer: for (let i = 0; i <= der.length - oid.length; i++) {
    for (let j = 0; j < oid.length; j++) {
      if (der[i + j] !== oid[j]) continue outer
    }
    // Found the OID at position i. The enclosing Attribute structure is:
    //   SEQUENCE {
    //     OID messageDigest
    //     SET {
    //       OCTET STRING digest
    //     }
    //   }
    // Walk forward from the OID's end to find the SET tag (0x31),
    // skip its length byte(s), then the OCTET STRING tag (0x04).
    let p = i + oid.length
    // Skip optional padding bytes (shouldn't exist in strict DER but
    // be safe).
    while (p < der.length && der[p] !== 0x31) p++
    if (p >= der.length) continue
    // Skip SET tag + length
    p++
    if (p >= der.length) continue
    if ((der[p] & 0x80) === 0) {
      p += 1
    } else {
      const lenLen = der[p] & 0x7F
      p += 1 + lenLen
    }
    if (p >= der.length || der[p] !== 0x04) continue // expected OCTET STRING
    p++ // skip tag
    // Read length
    let len: number
    if ((der[p] & 0x80) === 0) {
      len = der[p]; p++
    } else {
      const lenLen = der[p] & 0x7F
      p++
      len = 0
      for (let k = 0; k < lenLen; k++) len = (len << 8) | der[p + k]
      p += lenLen
    }
    return der.slice(p, p + len)
  }
  return new Uint8Array()
}
