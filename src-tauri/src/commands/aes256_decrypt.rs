//! Native AES-256 (PDF `/V 5`, revisions 5 and 6) decryption.
//!
//! Closes KNOWN-LIMITATIONS §1/§9d for the standard StdCF/AESV3 case by
//! removing the external-qpdf dependency. lopdf 0.32's encryption module
//! is RC4-only (`get_encryption_key` accepts V=1/2 R=2/3; `decrypt_object`
//! does per-object MD5+RC4), so the PDF 2.0 hardened KDF (ISO 32000-2
//! algorithm 2.B, R=6) and the Adobe Ext-Level-3 KDF (R=5) had to be
//! shelled out to qpdf.
//!
//! This module ports the algorithm-2.B KDF that
//! `src/services/pdfCryptoR6.ts` already encodes in the forward (encrypt)
//! direction, recovers the File Encryption Key (FEK) from `/UE` (user
//! password) or `/OE` (owner password), and then AES-256-CBC-decrypts
//! every string and stream under the FEK. For `/V 5` the per-object key
//! IS the FEK directly — there is no per-object salt derivation (unlike
//! the RC4 / AES-128 revisions lopdf handles), so each object's content
//! is simply `IV(16) || AES-256-CBC(plaintext, key=FEK, iv=IV)`.
//!
//! Scope: native handles the common, spec-clean shape — `/V 5`,
//! `/StmF /StdCF`, `/StrF /StdCF`, `/CF /StdCF /CFM /AESV3`,
//! `/EncryptMetadata true`. Anything exotic (non-StdCF crypt filters,
//! `StmF != StrF`, `EncryptMetadata false`, an object-stream xref lopdf
//! cannot parse while encrypted) returns `Unsupported`, and the caller
//! falls back to qpdf — so this strictly widens what opens in-process
//! without regressing the qpdf path.
//!
//! Correctness is pinned three ways in the tests below: the algorithm-2.B
//! KDF must reproduce the committed fixture's `/U` hash (an artifact
//! independently produced by `pdfCryptoR6.ts` and independently verified
//! openable by qpdf), and the full round-trip must yield a document whose
//! page content streams decompress cleanly under both the user and owner
//! password.

use aes::{Aes128, Aes256};
use cbc::{Decryptor, Encryptor};
use cipher::{
    block_padding::{NoPadding, Pkcs7},
    BlockDecryptMut, BlockEncryptMut, KeyIvInit,
};
use lopdf::{Document, Object, ObjectId};
use sha2::{Digest, Sha256, Sha384, Sha512};

type Aes128CbcEnc = Encryptor<Aes128>;
type Aes256CbcDec = Decryptor<Aes256>;

/// Outcome of a native AES-256 decrypt attempt. The three arms let the
/// caller choose between surfacing a precise wrong-password error and
/// shelling out to qpdf for a variant this module declines.
#[derive(Debug)]
pub enum NativeDecryptOutcome {
    /// Decrypted bytes with no `/Encrypt` dict — ready to write back.
    Ok(Vec<u8>),
    /// The password verified-wrong against BOTH `/U` and `/O`. qpdf would
    /// also reject it, so the caller surfaces a wrong-password message
    /// rather than the misleading "install qpdf" detour.
    WrongPassword,
    /// A crypt-filter variant this module does not handle (carries a
    /// developer-facing reason). The caller falls back to qpdf.
    Unsupported(String),
}

/// Attempt to decrypt an AES-256 `/V 5` (R=5 or R=6) PDF entirely
/// in-process. `rev` is the detector's revision hint; the parsed
/// `/Encrypt` dict's `/R` takes precedence when present.
pub fn decrypt_aes256_native(bytes: &[u8], password: &str, rev: u8) -> NativeDecryptOutcome {
    use NativeDecryptOutcome::Unsupported;

    let mut doc = match Document::load_mem(bytes) {
        Ok(d) => d,
        // An encrypted object-stream xref (or any structural shape lopdf
        // cannot parse while still encrypted) lands here — let qpdf try.
        Err(e) => return Unsupported(format!("native: lopdf load failed: {e}")),
    };

    let enc_id = match doc.trailer.get(b"Encrypt").and_then(Object::as_reference) {
        Ok(id) => id,
        Err(_) => return Unsupported("native: no /Encrypt reference in trailer".into()),
    };
    let enc = match doc.get_object(enc_id).and_then(|o| o.as_dict()) {
        Ok(d) => d.clone(),
        Err(_) => return Unsupported("native: /Encrypt is not a dictionary".into()),
    };

    // ── Scope guard: only the spec-clean StdCF/AESV3 shape ──────────
    let v = enc.get(b"V").and_then(|o| o.as_i64()).unwrap_or(0);
    if v != 5 {
        return Unsupported(format!("native: /V {v} is not 5 (AES-256)"));
    }
    let r = enc
        .get(b"R")
        .and_then(|o| o.as_i64())
        .map(|n| n as u8)
        .unwrap_or(rev);
    if r != 5 && r != 6 {
        return Unsupported(format!("native: /R {r} is not 5 or 6"));
    }
    let stmf = enc
        .get(b"StmF")
        .ok()
        .and_then(|o| o.as_name().ok())
        .map(|n| n.to_vec())
        .unwrap_or_default();
    let strf = enc
        .get(b"StrF")
        .ok()
        .and_then(|o| o.as_name().ok())
        .map(|n| n.to_vec())
        .unwrap_or_default();
    if stmf != b"StdCF" || strf != b"StdCF" {
        return Unsupported("native: non-StdCF crypt filter (StmF/StrF)".into());
    }
    let cfm_is_aesv3 = (|| -> Option<bool> {
        let cf = enc.get(b"CF").ok()?.as_dict().ok()?;
        let stdcf = cf.get(b"StdCF").ok()?.as_dict().ok()?;
        let cfm = stdcf.get(b"CFM").ok()?.as_name().ok()?;
        Some(cfm == b"AESV3")
    })()
    .unwrap_or(false);
    if !cfm_is_aesv3 {
        return Unsupported("native: StdCF /CFM is not /AESV3".into());
    }
    // EncryptMetadata=false means the /Metadata stream is plaintext (an
    // Identity crypt filter). We gate it out rather than corrupt that
    // stream by decrypting it — qpdf handles the false case.
    let metadata_encrypted = enc
        .get(b"EncryptMetadata")
        .and_then(|o| o.as_bool())
        .unwrap_or(true);
    if !metadata_encrypted {
        return Unsupported("native: /EncryptMetadata false".into());
    }

    // ── Read the password-derivation fields ─────────────────────────
    let u = match enc.get(b"U").and_then(Object::as_str) {
        Ok(s) if s.len() == 48 => s.to_vec(),
        _ => return Unsupported("native: /U missing or not 48 bytes".into()),
    };
    let o = match enc.get(b"O").and_then(Object::as_str) {
        Ok(s) if s.len() == 48 => s.to_vec(),
        _ => return Unsupported("native: /O missing or not 48 bytes".into()),
    };
    let ue = match enc.get(b"UE").and_then(Object::as_str) {
        Ok(s) if s.len() == 32 => s.to_vec(),
        _ => return Unsupported("native: /UE missing or not 32 bytes".into()),
    };
    let oe = match enc.get(b"OE").and_then(Object::as_str) {
        Ok(s) if s.len() == 32 => s.to_vec(),
        _ => return Unsupported("native: /OE missing or not 32 bytes".into()),
    };

    // /U and /O layout: hash(32) || validation_salt(8) || key_salt(8).
    let u_hash = &u[0..32];
    let u_validation_salt = &u[32..40];
    let u_key_salt = &u[40..48];
    let o_hash = &o[0..32];
    let o_validation_salt = &o[32..40];
    let o_key_salt = &o[40..48];

    let pw = password_bytes(password);

    // Try the user password first, then the owner password. The /O
    // computation mixes in the full 48-byte /U (per ISO 32000-2).
    let fek: [u8; 32] = if kdf(r, &pw, u_validation_salt, None) == u_hash {
        match recover_fek(r, &pw, u_key_salt, None, &ue) {
            Some(k) => k,
            None => return Unsupported("native: /UE FEK decrypt failed".into()),
        }
    } else if kdf(r, &pw, o_validation_salt, Some(&u)) == o_hash {
        match recover_fek(r, &pw, o_key_salt, Some(&u), &oe) {
            Some(k) => k,
            None => return Unsupported("native: /OE FEK decrypt failed".into()),
        }
    } else {
        return NativeDecryptOutcome::WrongPassword;
    };

    // ── Walk every object and decrypt strings + stream content ──────
    let ids: Vec<ObjectId> = doc.objects.keys().copied().collect();
    for id in ids {
        if id == enc_id {
            continue; // the /Encrypt dict is never encrypted
        }
        if let Some(obj) = doc.objects.get_mut(&id) {
            if let Err(e) = decrypt_object_in_place(obj, &fek) {
                // A non-XRef stream that fails strict decrypt means the
                // FEK or the crypt model is wrong for this file — do not
                // ship a half-decrypted document; let qpdf own it.
                return Unsupported(format!("native: object {id:?} decrypt failed: {e}"));
            }
        }
    }

    // Strip the encryption: remove /Encrypt from the trailer and drop the
    // dict object. lopdf has no encryptor on save, so the output is clean
    // plaintext (mirrors Document::decrypt's final step).
    doc.trailer.remove(b"Encrypt");
    doc.objects.remove(&enc_id);

    let mut out = Vec::with_capacity(bytes.len());
    match doc.save_to(&mut out) {
        Ok(_) => NativeDecryptOutcome::Ok(out),
        Err(e) => Unsupported(format!("native: save failed: {e}")),
    }
}

/// Recursively decrypt the strings and stream content of one object.
/// Mirrors the encrypt direction in `cert_encrypt::encrypt_object`:
/// streams decrypt their content (XRef streams are never encrypted),
/// dictionaries/arrays recurse, strings decrypt best-effort.
fn decrypt_object_in_place(obj: &mut Object, fek: &[u8]) -> Result<(), String> {
    match obj {
        Object::Stream(stream) => {
            let is_xref = stream
                .dict
                .get(b"Type")
                .ok()
                .and_then(|o| o.as_name().ok())
                .map(|n| n == b"XRef")
                .unwrap_or(false);
            if is_xref {
                return Ok(()); // xref streams are read before /Encrypt resolves
            }
            // Streams are strictly decrypted: a failure here is fatal
            // (wrong FEK / unexpected crypt model) — never shipped silently.
            let plain = aes_cbc_decrypt_strict(&stream.content, fek)?;
            stream.set_content(plain);
            stream
                .dict
                .set("Length", Object::Integer(stream.content.len() as i64));
            stream.start_position = None;
            Ok(())
        }
        Object::String(content, _fmt) => {
            // Strings are best-effort: a valid-PKCS7 decrypt replaces the
            // ciphertext; anything else is left untouched (a string that
            // was not encrypted — e.g. a malformed producer's edge — must
            // not be corrupted by a forced decrypt). In a spec-clean V=5
            // document every string outside /Encrypt and /ID is encrypted,
            // so this branch decrypts them all.
            if let Some(plain) = aes_cbc_decrypt_lenient(content, fek) {
                *content = plain;
            }
            Ok(())
        }
        Object::Dictionary(dict) => {
            for (_k, v) in dict.iter_mut() {
                decrypt_object_in_place(v, fek)?;
            }
            Ok(())
        }
        Object::Array(arr) => {
            for v in arr.iter_mut() {
                decrypt_object_in_place(v, fek)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// AES-256-CBC decrypt where the first 16 bytes are the IV and the
/// remainder is PKCS#7-padded ciphertext (the PDF V=5 string/stream
/// model). Errors on any malformed input — used for streams.
fn aes_cbc_decrypt_strict(data: &[u8], fek: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() < 32 || data.len() % 16 != 0 {
        return Err(format!(
            "ciphertext length {} is not a valid AES-CBC payload (IV + >=1 block)",
            data.len()
        ));
    }
    let (iv, body) = data.split_at(16);
    let dec = Aes256CbcDec::new_from_slices(fek, iv).map_err(|e| format!("cipher init: {e}"))?;
    let mut buf = body.to_vec();
    let plain = dec
        .decrypt_padded_mut::<Pkcs7>(&mut buf)
        .map_err(|e| format!("PKCS7 unpad: {e}"))?;
    Ok(plain.to_vec())
}

/// Best-effort variant for strings: returns `None` (leave as-is) when the
/// input is not a well-formed AES-CBC + PKCS7 payload.
fn aes_cbc_decrypt_lenient(data: &[u8], fek: &[u8]) -> Option<Vec<u8>> {
    if data.len() < 32 || data.len() % 16 != 0 {
        return None;
    }
    let (iv, body) = data.split_at(16);
    let dec = Aes256CbcDec::new_from_slices(fek, iv).ok()?;
    let mut buf = body.to_vec();
    dec.decrypt_padded_mut::<Pkcs7>(&mut buf).ok().map(<[u8]>::to_vec)
}

/// Recover the 32-byte File Encryption Key by decrypting `/UE` (or `/OE`)
/// under the intermediate key. `IV` is all-zero, no padding (the spec's
/// fixed model), so the 32-byte ciphertext yields exactly 32 plaintext
/// bytes.
fn recover_fek(
    rev: u8,
    password: &[u8],
    key_salt: &[u8],
    additional_u: Option<&[u8]>,
    ue: &[u8],
) -> Option<[u8; 32]> {
    if ue.len() != 32 {
        return None;
    }
    let inter = kdf(rev, password, key_salt, additional_u);
    let dec = Aes256CbcDec::new_from_slices(&inter, &[0u8; 16]).ok()?;
    let mut buf = ue.to_vec();
    let fek = dec.decrypt_padded_mut::<NoPadding>(&mut buf).ok()?;
    if fek.len() != 32 {
        return None;
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(fek);
    Some(out)
}

/// The password-to-key derivation. R=6 uses the iterated algorithm 2.B;
/// R=5 (Adobe Ext Level 3) uses a single SHA-256. Both consume
/// `password || salt || [additional_u]`.
fn kdf(rev: u8, password: &[u8], salt: &[u8], additional_u: Option<&[u8]>) -> [u8; 32] {
    if rev >= 6 {
        hash_algorithm_2b(password, salt, additional_u)
    } else {
        let mut h = Sha256::new();
        h.update(password);
        h.update(salt);
        if let Some(u) = additional_u {
            h.update(u);
        }
        let d = h.finalize();
        let mut out = [0u8; 32];
        out.copy_from_slice(&d);
        out
    }
}

/// Hash algorithm 2.B (ISO 32000-2 §7.6.4.3.3) — the iterated
/// password-to-key derivation R=6 introduces. ~64 AES-128-CBC rounds with
/// a per-round SHA-256/384/512 selected by the running ciphertext.
///
/// Port of `hashAlgorithm2B` in `src/services/pdfCryptoR6.ts`. Note that
/// K1 = `(password || K || [U]) × 64` is ALWAYS a multiple of 16 (64 = 4×16
/// times any unit length), so the AES-128-CBC step is exactly block-aligned
/// and needs no padding — `NoPadding` matches the TS `pad = () => true`
/// (padding-disabled) forge call.
fn hash_algorithm_2b(password: &[u8], salt: &[u8], additional_u: Option<&[u8]>) -> [u8; 32] {
    // Step (a): K = SHA-256(password || salt || [U]).
    let mut k: Vec<u8> = {
        let mut h = Sha256::new();
        h.update(password);
        h.update(salt);
        if let Some(u) = additional_u {
            h.update(u);
        }
        h.finalize().to_vec()
    };

    // Step (b): iterate until round > 63 AND the last byte of E <= round-32.
    let mut round: i64 = 0;
    let mut last_byte_e: i64 = 0;
    const MAX_ROUNDS: i64 = 64 * 16; // safety net — the spec converges well before this
    while round < 64 || last_byte_e > round - 32 {
        if round >= MAX_ROUNDS {
            break;
        }
        // K1 = (password || K || [U]) repeated 64 times.
        let unit = password.len() + k.len() + additional_u.map_or(0, <[u8]>::len);
        let mut k1 = Vec::with_capacity(unit * 64);
        for _ in 0..64 {
            k1.extend_from_slice(password);
            k1.extend_from_slice(&k);
            if let Some(u) = additional_u {
                k1.extend_from_slice(u);
            }
        }
        // E = AES-128-CBC(K1, key=K[0..16], iv=K[16..32], no padding).
        let e = aes128_cbc_encrypt_nopad(&k1, &k[0..16], &k[16..32]);
        // Next hash chosen by (sum of first 16 bytes of E) mod 3.
        let sum: u32 = e[0..16].iter().map(|&b| u32::from(b)).sum::<u32>() % 3;
        k = match sum {
            0 => {
                let mut h = Sha256::new();
                h.update(&e);
                h.finalize().to_vec()
            }
            1 => {
                let mut h = Sha384::new();
                h.update(&e);
                h.finalize().to_vec()
            }
            _ => {
                let mut h = Sha512::new();
                h.update(&e);
                h.finalize().to_vec()
            }
        };
        last_byte_e = i64::from(*e.last().unwrap());
        round += 1;
    }

    let mut out = [0u8; 32];
    out.copy_from_slice(&k[0..32]);
    out
}

/// AES-128-CBC encrypt with no padding. `data` must be block-aligned
/// (algorithm 2.B's K1 always is).
fn aes128_cbc_encrypt_nopad(data: &[u8], key: &[u8], iv: &[u8]) -> Vec<u8> {
    debug_assert_eq!(data.len() % 16, 0, "K1 must be block-aligned");
    let enc = Aes128CbcEnc::new_from_slices(key, iv).expect("aes-128 init (16-byte key/iv)");
    let mut buf = data.to_vec();
    let n = buf.len();
    let out = enc
        .encrypt_padded_mut::<NoPadding>(&mut buf, n)
        .expect("aes-128-cbc no-pad encrypt of block-aligned input");
    out.to_vec()
}

/// PDF 2.0 passwords are UTF-8, truncated to 127 bytes (ISO 32000-2
/// §7.6.4.3.4). We mirror `pdfCryptoR6.ts` `bytesOfPassword`.
fn password_bytes(pw: &str) -> Vec<u8> {
    let b = pw.as_bytes();
    if b.len() > 127 {
        b[..127].to_vec()
    } else {
        b.to_vec()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The committed AES-256 R=6 fixture, produced by
    /// `scripts/_gen-encrypted-fixture.mjs` (zgapdfsigner + pdfCryptoR6)
    /// and independently openable by qpdf. user pw `user-pass-123`,
    /// owner pw `owner-pass-456`.
    fn fixture_bytes() -> Vec<u8> {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../test-pdfs/roundtrip/encrypt-test-aes256.pdf");
        std::fs::read(&p).unwrap_or_else(|e| panic!("read AES-256 fixture {p:?}: {e}"))
    }

    /// Pull the parsed `/U` (48 bytes) and `/R` out of the fixture.
    fn fixture_u_and_rev(bytes: &[u8]) -> (Vec<u8>, u8) {
        let doc = Document::load_mem(bytes).expect("load fixture");
        let enc_id = doc
            .trailer
            .get(b"Encrypt")
            .and_then(Object::as_reference)
            .expect("/Encrypt ref");
        let enc = doc.get_object(enc_id).unwrap().as_dict().unwrap();
        let u = enc.get(b"U").and_then(Object::as_str).unwrap().to_vec();
        let r = enc.get(b"R").and_then(|o| o.as_i64()).unwrap() as u8;
        (u, r)
    }

    /// Algorithm 2.B must reproduce the fixture's /U hash from the user
    /// password — a vector independently produced by pdfCryptoR6.ts and
    /// independently validated by qpdf opening the same file. If this
    /// passes, the KDF byte-matches two other implementations.
    #[test]
    fn hash2b_reproduces_fixture_user_hash() {
        let bytes = fixture_bytes();
        let (u, r) = fixture_u_and_rev(&bytes);
        assert_eq!(r, 6, "fixture is the R=6 case");
        let u_hash = &u[0..32];
        let u_validation_salt = &u[32..40];
        let computed = hash_algorithm_2b(b"user-pass-123", u_validation_salt, None);
        assert_eq!(
            &computed[..],
            u_hash,
            "algorithm 2.B must reproduce the fixture's /U validation hash"
        );
    }

    /// Full round-trip: decrypt under BOTH the user and owner password,
    /// reload, assert not encrypted, and assert a page content stream
    /// decompresses cleanly (which only happens if the stream decrypt was
    /// byte-correct — a wrong FEK yields random bytes that fail FlateDecode).
    #[test]
    fn decrypts_fixture_under_user_and_owner_password() {
        let bytes = fixture_bytes();
        for pw in ["user-pass-123", "owner-pass-456"] {
            match decrypt_aes256_native(&bytes, pw, 6) {
                NativeDecryptOutcome::Ok(out) => {
                    let doc = Document::load_mem(&out)
                        .unwrap_or_else(|e| panic!("reload decrypted ({pw}): {e}"));
                    assert!(!doc.is_encrypted(), "output still has /Encrypt ({pw})");
                    let pages = doc.get_pages();
                    let (_n, &page_id) = pages.iter().next().expect("at least one page");
                    let content = doc
                        .get_page_content(page_id)
                        .unwrap_or_else(|e| panic!("page content must decompress ({pw}): {e}"));
                    assert!(!content.is_empty(), "decrypted page content empty ({pw})");
                }
                other => panic!("expected Ok decrypting with {pw}, got {other:?}"),
            }
        }
    }

    /// A wrong password is detected natively (verified against /U and /O)
    /// — never silently handed to qpdf, so the caller can surface a clean
    /// wrong-password message.
    #[test]
    fn wrong_password_returns_wrong_password() {
        let bytes = fixture_bytes();
        match decrypt_aes256_native(&bytes, "definitely-not-the-password", 6) {
            NativeDecryptOutcome::WrongPassword => {}
            other => panic!("expected WrongPassword, got {other:?}"),
        }
    }

    /// An unencrypted PDF has no /Encrypt — native declines (Unsupported),
    /// so the caller's flow is unchanged for non-encrypted input.
    #[test]
    fn unencrypted_input_is_unsupported() {
        let mut doc = Document::with_version("1.5");
        let mut catalog = lopdf::Dictionary::new();
        catalog.set("Type", Object::Name(b"Catalog".to_vec()));
        let cat = doc.add_object(Object::Dictionary(catalog));
        doc.trailer.set("Root", Object::Reference(cat));
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        match decrypt_aes256_native(&bytes, "x", 6) {
            NativeDecryptOutcome::Unsupported(_) => {}
            other => panic!("expected Unsupported for unencrypted input, got {other:?}"),
        }
    }
}
