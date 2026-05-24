// AES-256 revision 6 upgrade (PDF 2.0 / ISO 32000-2 §7.6.4.3.3).
//
// zgapdfsigner 2.7.6 emits /R=5 (Adobe Extension Level 3, 2008) — the
// cipher is AES-256 either way, but R=5's key-derivation from the
// password is a single SHA-256 round. R=6 replaces that with the
// "hash algorithm 2.B" iterated-hash that hardens password→key
// derivation by ~5 orders of magnitude for brute-force attacks.
//
// Approach here:
//   1. Let zgapdfsigner do the heavy lifting (object encryption with
//      AES-256-CBC using a random File Encryption Key).
//   2. Extract the FEK from zga's /UE using R=5's KDF (single SHA-256).
//   3. Recompute /U, /O, /UE, /OE, /Perms using R=6's hash algorithm
//      2.B. Update /R from 5 to 6.
//   4. Write the R=6 /Encrypt dict back into the PDF.
//
// Object encryption bytes are unchanged — AES-256-CBC is the same
// primitive in both revisions. Only the /Encrypt dict fields that
// encode the password-to-key derivation are swapped.
//
// Credit: zgapdfsigner (MIT, © zboris12) does steps 1 and object
// encryption; we add steps 2–4 on top. See
// https://github.com/zboris12/zgapdfsigner and the CREDITS file.

import forge from 'node-forge'
import { PDFDocument, PDFDict, PDFName, PDFNumber, PDFString, PDFHexString } from 'pdf-lib'

export interface UpgradeR6Options {
  userPassword?: string
  ownerPassword?: string
}

/**
 * Upgrade an R=5 AES-256 encrypted PDF to R=6. Expects bytes already
 * encrypted by zgapdfsigner with mode AES_256. Returns bytes whose
 * /Encrypt dict declares /R=6 with R=6-derived /U, /O, /UE, /OE,
 * /Perms. The object ciphertext is byte-identical to the input —
 * only the header metadata changes.
 *
 * Both passwords must be supplied so we can re-encrypt the FEK with
 * R=6-derived intermediate keys for both the user and owner path.
 * If only userPassword is set, pass it as ownerPassword too (zga
 * does the same for R=5).
 */
export async function upgradeR5ToR6(
  bytes: Uint8Array,
  opts: UpgradeR6Options,
): Promise<Uint8Array> {
  const userPw = opts.userPassword ?? ''
  const ownerPw = opts.ownerPassword ?? userPw

  // Parse the encrypted PDF. `ignoreEncryption` lets pd-lib walk the
  // object graph without decrypting streams — we only need /Encrypt
  // dict access, not content.
  const doc = await PDFDocument.load(bytes, {
    throwOnInvalidObject: false,
    ignoreEncryption: true,
    updateMetadata: false,
  })
  const ctx = doc.context
  const encryptRef = ctx.trailerInfo.Encrypt
  if (!encryptRef) throw new Error('upgradeR5ToR6: no /Encrypt dict — not encrypted')
  const encDict = ctx.lookup(encryptRef)
  if (!(encDict instanceof PDFDict)) throw new Error('upgradeR5ToR6: /Encrypt is not a dictionary')

  const V = numberAttr(encDict, 'V')
  const R = numberAttr(encDict, 'R')
  if (V !== 5 || R !== 5) {
    throw new Error(`upgradeR5ToR6: expected V=5 R=5 (AES-256 Adobe Ext 3), got V=${V} R=${R}`)
  }

  const UBytes = byteStringAttr(encDict, 'U')
  const OBytes = byteStringAttr(encDict, 'O')
  const UEBytes = byteStringAttr(encDict, 'UE')
  const OEBytes = byteStringAttr(encDict, 'OE')
  const PermsBytes = byteStringAttr(encDict, 'Perms')
  const PInt = numberAttr(encDict, 'P')
  if (!UBytes || !OBytes || !UEBytes || !OEBytes || !PermsBytes || PInt == null) {
    throw new Error('upgradeR5ToR6: /Encrypt dict missing one of U/O/UE/OE/Perms/P')
  }
  if (UBytes.length !== 48 || OBytes.length !== 48) {
    throw new Error(`upgradeR5ToR6: /U and /O must be 48 bytes (got ${UBytes.length}/${OBytes.length})`)
  }
  if (UEBytes.length !== 32 || OEBytes.length !== 32) {
    throw new Error(`upgradeR5ToR6: /UE and /OE must be 32 bytes (got ${UEBytes.length}/${OEBytes.length})`)
  }
  if (PermsBytes.length !== 16) {
    throw new Error(`upgradeR5ToR6: /Perms must be 16 bytes (got ${PermsBytes.length})`)
  }

  // /U structure (both R=5 and R=6): hash(32) || validation_salt(8) || key_salt(8)
  const uValidationSalt = UBytes.slice(32, 40)
  const uKeySalt = UBytes.slice(40, 48)
  const oValidationSalt = OBytes.slice(32, 40)
  const oKeySalt = OBytes.slice(40, 48)

  // Step 1: Extract the File Encryption Key by decrypting R=5's /UE.
  //   intermediate_key_R5 = SHA-256(password + key_salt)
  //   FEK = AES-256-CBC-decrypt(UE, key=intermediate_key_R5, IV=zero, no padding)
  const interR5User = sha256(concat(bytesOfPassword(userPw), uKeySalt))
  const fek = aes256CbcDecryptNoPad(UEBytes, interR5User, zeroIv())
  if (fek.length !== 32) {
    throw new Error(`upgradeR5ToR6: FEK decrypt produced ${fek.length} bytes (expected 32). Wrong userPassword?`)
  }

  // Quick sanity-check: recompute /U's first 32 bytes with R=5 hash
  // and compare to the stored U hash. If mismatch, the userPassword
  // we were given doesn't match what zga used.
  const uHashR5Actual = sha256(concat(bytesOfPassword(userPw), uValidationSalt))
  if (!bytesEqual(uHashR5Actual, UBytes.slice(0, 32))) {
    throw new Error('upgradeR5ToR6: R=5 /U hash mismatch — userPassword does not match the one zga encrypted with')
  }

  // Same verification on owner path. For R=5 /O, the hash is
  // SHA-256(password || validation_salt || U_first_48_bytes).
  const oHashR5Actual = sha256(concat(bytesOfPassword(ownerPw), oValidationSalt, UBytes))
  if (!bytesEqual(oHashR5Actual, OBytes.slice(0, 32))) {
    throw new Error('upgradeR5ToR6: R=5 /O hash mismatch — ownerPassword does not match')
  }

  // Step 2: Recompute /U, /O, /UE, /OE, /Perms with R=6 hash 2.B.
  //
  // Per ISO 32000-2 §7.6.4.3:
  //   /U[0..31]  = hash2B(userPassword, uValidationSalt)
  //   /U[32..39] = uValidationSalt (reused)
  //   /U[40..47] = uKeySalt (reused)
  //   intermediate_R6_user = hash2B(userPassword, uKeySalt)
  //   /UE = AES-256-CBC(FEK, key=intermediate_R6_user, IV=zero, no pad)
  //
  //   /O[0..31]  = hash2B(ownerPassword, oValidationSalt, U_first_48)
  //   /O[32..39] = oValidationSalt
  //   /O[40..47] = oKeySalt
  //   intermediate_R6_owner = hash2B(ownerPassword, oKeySalt, U_first_48)
  //   /OE = AES-256-CBC(FEK, key=intermediate_R6_owner, IV=zero, no pad)
  //
  //   /Perms = AES-256-ECB(16-byte perms block, key=FEK, no pad)  — unchanged across R=5/R=6
  const newUhash = hashAlgorithm2B(bytesOfPassword(userPw), uValidationSalt, null)
  const newU = concat(newUhash, uValidationSalt, uKeySalt)
  const interR6User = hashAlgorithm2B(bytesOfPassword(userPw), uKeySalt, null)
  const newUE = aes256CbcEncryptNoPad(fek, interR6User, zeroIv())

  const u48 = newU  // R=6 spec refers to "U" first 48 bytes for the /O hash.
  const newOhash = hashAlgorithm2B(bytesOfPassword(ownerPw), oValidationSalt, u48)
  const newO = concat(newOhash, oValidationSalt, oKeySalt)
  const interR6Owner = hashAlgorithm2B(bytesOfPassword(ownerPw), oKeySalt, u48)
  const newOE = aes256CbcEncryptNoPad(fek, interR6Owner, zeroIv())

  // /Perms is unchanged — it's AES-256-ECB(perms_block, FEK). FEK
  // didn't change; perms_block didn't change; ciphertext is
  // bit-identical to R=5's. We copy through.
  const newPerms = PermsBytes

  // Step 3: Write /R = 6 + the recomputed fields. /V stays 5.
  encDict.set(PDFName.of('R'), PDFNumber.of(6))
  encDict.set(PDFName.of('U'), PDFHexString.of(bytesToHex(newU)))
  encDict.set(PDFName.of('O'), PDFHexString.of(bytesToHex(newO)))
  encDict.set(PDFName.of('UE'), PDFHexString.of(bytesToHex(newUE)))
  encDict.set(PDFName.of('OE'), PDFHexString.of(bytesToHex(newOE)))
  encDict.set(PDFName.of('Perms'), PDFHexString.of(bytesToHex(newPerms)))

  // Save with classic xref — same rationale as pdfAConvert.
  return new Uint8Array(await doc.save({ useObjectStreams: false }))
}

// ── Hash Algorithm 2.B (ISO 32000-2 §7.6.4.3.3) ────────────────────
//
// Iterated password-to-key derivation. ~64 AES-128-CBC rounds with
// a dynamically-selected SHA-256/384/512 each round. Output = first
// 32 bytes of the final hash. This is the cryptographic hardening
// R=6 introduces over R=5.
function hashAlgorithm2B(
  password: Uint8Array,
  salt: Uint8Array,
  additionalU: Uint8Array | null,  // U[0..47] for /O computation, null for /U
): Uint8Array {
  // Step a: K = SHA-256(password || salt || [U])
  let K = sha256(additionalU ? concat(password, salt, additionalU) : concat(password, salt))

  // Step b (iterated): loop until round > 63 AND last byte of E ≤ round
  let round = 0
  const MAX_ROUNDS = 64 * 16  // safety net — shouldn't reach
  let lastByteOfE = 0
  while (round < 64 || lastByteOfE > round - 32) {
    if (round >= MAX_ROUNDS) break

    // K1 = (password || K || [U]) × 64
    const k1Parts: Uint8Array[] = []
    for (let i = 0; i < 64; i++) {
      k1Parts.push(password)
      k1Parts.push(K)
      if (additionalU) k1Parts.push(additionalU)
    }
    const k1 = concat(...k1Parts)

    // E = AES-128-CBC(K1, key=K[0..15], IV=K[16..31], no padding)
    const aesKey = K.slice(0, 16)
    const iv = K.slice(16, 32)
    const E = aes128CbcEncryptNoPad(k1, aesKey, iv)

    // Pick next hash: sum of first 16 bytes of E mod 3 → SHA-256/384/512
    let sum = 0
    for (let i = 0; i < 16; i++) sum = (sum + E[i]) % 3
    K = sum === 0 ? sha256(E) : sum === 1 ? sha384(E) : sha512(E)

    lastByteOfE = E[E.length - 1]
    round++
  }

  return K.slice(0, 32)
}

// ── Forge primitives, wrapped for Uint8Array I/O ──────────────────

function sha256(data: Uint8Array): Uint8Array {
  const md = forge.md.sha256.create()
  md.update(u8ToForgeBinary(data))
  return forgeBinaryToU8(md.digest().getBytes())
}

function sha384(data: Uint8Array): Uint8Array {
  const md = forge.md.sha384.create()
  md.update(u8ToForgeBinary(data))
  return forgeBinaryToU8(md.digest().getBytes())
}

function sha512(data: Uint8Array): Uint8Array {
  const md = forge.md.sha512.create()
  md.update(u8ToForgeBinary(data))
  return forgeBinaryToU8(md.digest().getBytes())
}

function aes128CbcEncryptNoPad(data: Uint8Array, key: Uint8Array, iv: Uint8Array): Uint8Array {
  if (key.length !== 16) throw new Error(`aes128 key must be 16 bytes (got ${key.length})`)
  if (iv.length !== 16) throw new Error(`aes128 iv must be 16 bytes (got ${iv.length})`)
  if (data.length % 16 !== 0) throw new Error(`aes128 data must be multiple of 16 bytes (got ${data.length})`)
  const cipher = forge.cipher.createCipher('AES-CBC', u8ToForgeBinary(key))
  cipher.start({ iv: u8ToForgeBinary(iv) })
  // No padding mode via forge: push the whole plaintext as a single
  // 16-byte-aligned block. forge adds padding by default; we strip it.
  ;(cipher.mode as unknown as { pad: () => boolean }).pad = () => true
  cipher.update(forge.util.createBuffer(u8ToForgeBinary(data)))
  cipher.finish()
  return forgeBinaryToU8(cipher.output.getBytes())
}

function aes256CbcEncryptNoPad(data: Uint8Array, key: Uint8Array, iv: Uint8Array): Uint8Array {
  if (key.length !== 32) throw new Error(`aes256 key must be 32 bytes (got ${key.length})`)
  const cipher = forge.cipher.createCipher('AES-CBC', u8ToForgeBinary(key))
  cipher.start({ iv: u8ToForgeBinary(iv) })
  ;(cipher.mode as unknown as { pad: () => boolean }).pad = () => true
  cipher.update(forge.util.createBuffer(u8ToForgeBinary(data)))
  cipher.finish()
  return forgeBinaryToU8(cipher.output.getBytes())
}

function aes256CbcDecryptNoPad(data: Uint8Array, key: Uint8Array, iv: Uint8Array): Uint8Array {
  const decipher = forge.cipher.createDecipher('AES-CBC', u8ToForgeBinary(key))
  decipher.start({ iv: u8ToForgeBinary(iv) })
  ;(decipher.mode as unknown as { unpad: () => boolean }).unpad = () => true
  decipher.update(forge.util.createBuffer(u8ToForgeBinary(data)))
  decipher.finish()
  return forgeBinaryToU8(decipher.output.getBytes())
}

function zeroIv(): Uint8Array {
  return new Uint8Array(16)
}

// ── Helpers for Uint8Array / forge-binary / hex ───────────────────

function u8ToForgeBinary(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return s
}
function forgeBinaryToU8(s: string): Uint8Array {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xFF
  return out
}
function concat(...arrs: Uint8Array[]): Uint8Array {
  let total = 0
  for (const a of arrs) total += a.length
  const out = new Uint8Array(total)
  let o = 0
  for (const a of arrs) { out.set(a, o); o += a.length }
  return out
}
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
function bytesToHex(b: Uint8Array): string {
  let s = ''
  for (const x of b) s += x.toString(16).padStart(2, '0')
  return s
}
function bytesOfPassword(pw: string): Uint8Array {
  // PDF 2.0 passwords are UTF-8, max 127 bytes. Truncate if longer.
  const encoded = new TextEncoder().encode(pw)
  return encoded.length > 127 ? encoded.slice(0, 127) : encoded
}

/** Decode PDF literal-string escapes. Per PDF 1.7 §7.3.4.2:
 *    \n \r \t \b \f — control chars
 *    \\ \( \)        — literal backslash / paren
 *    \ddd            — 1-to-3-digit octal byte
 *    \<newline>      — line-continuation (ignored)
 *  Any other \X is treated as literal X. */
function unescapePdfLiteralString(src: string): Uint8Array {
  const out: number[] = []
  let i = 0
  while (i < src.length) {
    const c = src.charCodeAt(i)
    if (c !== 0x5c) {  // not backslash
      out.push(c & 0xFF)
      i++
      continue
    }
    // Escape sequence
    if (i + 1 >= src.length) { out.push(0x5c); i++; continue }
    const next = src[i + 1]
    switch (next) {
      case 'n': out.push(0x0A); i += 2; break
      case 'r': out.push(0x0D); i += 2; break
      case 't': out.push(0x09); i += 2; break
      case 'b': out.push(0x08); i += 2; break
      case 'f': out.push(0x0C); i += 2; break
      case '(': out.push(0x28); i += 2; break
      case ')': out.push(0x29); i += 2; break
      case '\\': out.push(0x5C); i += 2; break
      case '\n': i += 2; break  // line continuation — drop
      case '\r':
        i += 2
        if (src[i] === '\n') i++  // CRLF line continuation
        break
      default:
        // Octal \ddd (1 to 3 digits)
        if (next >= '0' && next <= '7') {
          let j = i + 1
          let oct = 0
          let digits = 0
          while (digits < 3 && j < src.length && src[j] >= '0' && src[j] <= '7') {
            oct = oct * 8 + (src.charCodeAt(j) - 0x30)
            j++
            digits++
          }
          out.push(oct & 0xFF)
          i = j
        } else {
          // Unrecognized escape — PDF spec says drop the backslash.
          out.push(src.charCodeAt(i + 1) & 0xFF)
          i += 2
        }
    }
  }
  return new Uint8Array(out)
}

function numberAttr(d: PDFDict, name: string): number | null {
  const v = d.get(PDFName.of(name))
  return v instanceof PDFNumber ? v.asNumber() : null
}
function byteStringAttr(d: PDFDict, name: string): Uint8Array | null {
  const v = d.get(PDFName.of(name))
  if (v instanceof PDFHexString) {
    // Parse the hex string → raw bytes. PDFHexString.value is
    // private in pd-lib's type defs but readable at runtime.
    const clean = (v as unknown as { value: string }).value.replace(/\s+/g, '')
    const padded = clean.length % 2 ? clean + '0' : clean
    const out = new Uint8Array(padded.length / 2)
    for (let i = 0; i < out.length; i++) out[i] = parseInt(padded.substr(i * 2, 2), 16)
    return out
  }
  if (v instanceof PDFString) {
    // Literal string → decode PDF escape sequences. pd-lib's
    // PDFString.value keeps the raw source, including backslash
    // escapes — e.g. a byte 0x29 stored as "\)" is 2 chars in value
    // but 1 byte decoded. Unescape here so length matches the real
    // binary payload.
    const s = (v as unknown as { value: string }).value
    return unescapePdfLiteralString(s)
  }
  return null
}
