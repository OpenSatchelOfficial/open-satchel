//! Public-key (cert-based) PDF encryption.
//!
//! NATIVE since 2026-06-11 (Night-2 decision #3): the shell owns the
//! WHOLE pipeline — seed + FEK generation, CMS EnvelopedData
//! construction per recipient cert (satchel-core RustCrypto, where
//! node-forge used to do it JS-side), object walking, AES-256-CBC
//! body encryption, /Encrypt dict installation. Secret material
//! (seed, FEK) never crosses the IPC boundary anymore.
//!
//! Reference: ISO 32000-2 §7.6.5 (public-key security handlers)
//! + Adobe Supplement to ISO 32000 (V=5 layout).
//!
//! V=5 doesn't do per-object key derivation — the FEK is used
//! directly with a per-object random IV. FEK = SHA-256(seed) where
//! `seed` is the 20-byte payload prefix wrapped in each recipient
//! envelope; payload = seed || /P (little-endian i32).

use crate::error::AppError;
use crate::Result;
use aes::Aes256;
use cbc::Encryptor;
use cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
use lopdf::{Dictionary, Document, Object, ObjectId};
use rand::RngCore;
use satchel_core::crypto::cms_envelope;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::io::Cursor;

/// Tauri command — the native end-to-end path. JS passes cleartext
/// PDF bytes + recipient certificate PEMs + permission flags;
/// everything secret is generated and consumed on this side.
#[tauri::command]
pub async fn pdf_encrypt_to_certs(
    bytes: Vec<u8>,
    recipient_certs_pem: Vec<String>,
    permissions: i32,
) -> Result<Vec<u8>> {
    tokio::task::spawn_blocking(move || {
        encrypt_pdf_to_certs_native(&bytes, &recipient_certs_pem, permissions)
    })
    .await
    .map_err(|e| AppError::Pdf(format!("pdf_encrypt_to_certs task: {e}")))?
}

/// Tauri command — envelope primitive for tests/tooling: wrap an
/// explicit payload for one recipient cert via the native CMS
/// builder. Exposed so the `pdf_build_cert_envelope` test hook
/// exercises the production envelope code, not a JS shadow.
#[tauri::command]
pub fn cms_wrap_recipient(payload: Vec<u8>, cert_pem: String) -> Result<Vec<u8>> {
    cms_envelope::wrap_payload_for_recipient(&payload, &cert_pem)
        .map_err(|e| AppError::Pdf(format!("cms wrap: {e}")))
}

/// Native pipeline: generate seed → build per-recipient CMS
/// envelopes (RustCrypto) → derive FEK → encrypt the document body.
pub fn encrypt_pdf_to_certs_native(
    bytes: &[u8],
    recipient_certs_pem: &[String],
    permissions: i32,
) -> Result<Vec<u8>> {
    if recipient_certs_pem.is_empty() {
        return Err(AppError::Pdf(
            "cert-encrypt: at least one recipient certificate required".into(),
        ));
    }

    // 20-byte random seed; payload = seed || /P little-endian.
    let mut seed = [0u8; 20];
    rand::thread_rng().fill_bytes(&mut seed);
    let payload = recipient_payload(&seed, permissions);

    let envelopes: Vec<Vec<u8>> = recipient_certs_pem
        .iter()
        .map(|pem| {
            cms_envelope::wrap_payload_for_recipient(&payload, pem)
                .map_err(|e| AppError::Pdf(format!("cert-encrypt: envelope: {e}")))
        })
        .collect::<Result<_>>()?;

    let fek = derive_fek(&seed);
    encrypt_pdf_to_certs(bytes, &envelopes, &fek, permissions)
}

/// 24-byte recipient payload: 20-byte seed || 4-byte /P
/// (little-endian signed) — the layout Adobe writes and the old JS
/// `buildRecipientPayload` produced.
fn recipient_payload(seed: &[u8; 20], permissions: i32) -> Vec<u8> {
    let mut payload = Vec::with_capacity(24);
    payload.extend_from_slice(seed);
    payload.extend_from_slice(&permissions.to_le_bytes());
    payload
}

/// FEK = SHA-256(seed) per the Adobe V=5 supplement (single
/// recipient class) — matches the old JS `deriveFekFromSeeds`.
fn derive_fek(seed: &[u8]) -> Vec<u8> {
    let mut hasher = Sha256::new();
    hasher.update(seed);
    hasher.finalize().to_vec()
}

type Aes256CbcEnc = Encryptor<Aes256>;

/// Encrypt a cleartext PDF for cert-based delivery (body-encryption
/// half — callers normally go through [`encrypt_pdf_to_certs_native`]
/// which also builds the envelopes and derives the FEK).
///
/// `bytes`             — cleartext input PDF.
/// `recipient_envelopes` — DER-encoded CMS EnvelopedData per recipient
///                          (satchel-core RustCrypto builder).
/// `fek`                — 32-byte file encryption key. Must match what
///                          the envelopes wrap.
/// `permissions`        — PDF /P signed-int permission flags.
///
/// Returns the encrypted PDF bytes.
pub fn encrypt_pdf_to_certs(
    bytes: &[u8],
    recipient_envelopes: &[Vec<u8>],
    fek: &[u8],
    permissions: i32,
) -> Result<Vec<u8>> {
    if fek.len() != 32 {
        return Err(AppError::Pdf(format!(
            "cert-encrypt: FEK must be 32 bytes (got {})",
            fek.len()
        )));
    }
    if recipient_envelopes.is_empty() {
        return Err(AppError::Pdf(
            "cert-encrypt: at least one recipient envelope required".into(),
        ));
    }

    let mut cursor = Cursor::new(bytes);
    let mut doc = Document::load_from(&mut cursor)
        .map_err(|e| AppError::Pdf(format!("cert-encrypt: parse: {e}")))?;

    // Collect every indirect object id once so we don't iterate the
    // map while mutating. Skip the trailer's Encrypt entry (we'll
    // install a fresh one below).
    let object_ids: Vec<ObjectId> = doc.objects.keys().copied().collect();

    // Empty by design — V=5 spec says /Encrypt + xref streams stay
    // cleartext; we identify those by /Type /XRef on the stream
    // dict in encrypt_object below, and the /Encrypt dict is added
    // AFTER this loop so it can never appear here.
    let never_encrypt: BTreeSet<ObjectId> = BTreeSet::new();

    let mut new_objects: Vec<(ObjectId, Object)> = Vec::with_capacity(object_ids.len());
    for id in object_ids.iter().copied() {
        let obj = match doc.objects.get(&id) {
            Some(o) => o.clone(),
            None => continue,
        };
        let encrypted = encrypt_object(obj, fek, &never_encrypt, id)?;
        new_objects.push((id, encrypted));
    }
    for (id, obj) in new_objects {
        doc.objects.insert(id, obj);
    }

    // Build the /Encrypt dict.
    let mut enc_dict = Dictionary::new();
    enc_dict.set("Filter", Object::Name(b"Adobe.PubSec".to_vec()));
    enc_dict.set("SubFilter", Object::Name(b"adbe.pkcs7.s5".to_vec()));
    enc_dict.set("V", Object::Integer(5));
    enc_dict.set("Length", Object::Integer(256));
    enc_dict.set("P", Object::Integer(permissions as i64));

    // /CF /DefaultCryptFilter — V=5 spec requires /Recipients live
    // on the per-filter dict, not the outer /Encrypt dict.
    let mut default_cf = Dictionary::new();
    default_cf.set("CFM", Object::Name(b"AESV3".to_vec()));
    default_cf.set("Length", Object::Integer(32));
    let recipients_arr: Vec<Object> = recipient_envelopes
        .iter()
        .map(|env| Object::String(env.clone(), lopdf::StringFormat::Hexadecimal))
        .collect();
    default_cf.set("Recipients", Object::Array(recipients_arr));
    let mut cf = Dictionary::new();
    cf.set("DefaultCryptFilter", Object::Dictionary(default_cf));
    enc_dict.set("CF", Object::Dictionary(cf));
    enc_dict.set("StmF", Object::Name(b"DefaultCryptFilter".to_vec()));
    enc_dict.set("StrF", Object::Name(b"DefaultCryptFilter".to_vec()));

    let enc_id = doc.add_object(Object::Dictionary(enc_dict));
    doc.trailer.set("Encrypt", Object::Reference(enc_id));

    // Save the modified doc. lopdf's save_to writes a classic xref +
    // trailer + %%EOF — exactly what V=5 cert encrypt expects.
    let mut out = Vec::new();
    doc.save_to(&mut out)
        .map_err(|e| AppError::Pdf(format!("cert-encrypt: save: {e}")))?;
    Ok(out)
}

/// Walk one indirect object and encrypt its strings + stream
/// content under the FEK with random per-element IVs. Objects
/// in `never_encrypt` (xref streams, the encrypt dict itself)
/// are passed through untouched.
fn encrypt_object(
    obj: Object,
    fek: &[u8],
    never_encrypt: &BTreeSet<ObjectId>,
    id: ObjectId,
) -> Result<Object> {
    if never_encrypt.contains(&id) {
        return Ok(obj);
    }
    match obj {
        Object::Stream(mut s) => {
            // Skip /XRef streams — those carry the cross-reference
            // table and are read by the parser before /Encrypt is
            // resolved.
            let is_xref = s
                .dict
                .get(b"Type")
                .ok()
                .and_then(|o| o.as_name().ok())
                .map(|n| n == b"XRef")
                .unwrap_or(false);
            if is_xref {
                return Ok(Object::Stream(s));
            }
            // Make sure we encrypt the DECOMPRESSED content. PDF
            // viewers decrypt before applying /Filter, so we must
            // produce ciphertext over the post-decompression bytes.
            // For streams we hold cleartext (lopdf already
            // decompresses on access), but to round-trip cleanly we
            // strip /Filter + /Length first.
            let plaintext = s.content.clone();
            s.dict.remove(b"Filter");
            s.dict.remove(b"DecodeParms");
            let encrypted = aes_cbc_encrypt(&plaintext, fek)?;
            s.content = encrypted;
            // Refresh /Length to ciphertext length (= 16 IV + padded).
            s.dict
                .set("Length", Object::Integer(s.content.len() as i64));
            s.start_position = None;
            Ok(Object::Stream(s))
        }
        Object::Dictionary(d) => {
            let new_d = encrypt_dict_strings(d, fek)?;
            Ok(Object::Dictionary(new_d))
        }
        Object::String(bytes, fmt) => {
            let ct = aes_cbc_encrypt(&bytes, fek)?;
            Ok(Object::String(ct, fmt))
        }
        Object::Array(arr) => {
            let mut out = Vec::with_capacity(arr.len());
            for el in arr {
                out.push(encrypt_object(el, fek, never_encrypt, id)?);
            }
            Ok(Object::Array(out))
        }
        other => Ok(other),
    }
}

fn encrypt_dict_strings(dict: Dictionary, fek: &[u8]) -> Result<Dictionary> {
    let mut new_dict = Dictionary::new();
    for (k, v) in dict.iter() {
        let new_v = encrypt_object(v.clone(), fek, &BTreeSet::new(), (0, 0))?;
        new_dict.set(k.clone(), new_v);
    }
    Ok(new_dict)
}

/// AES-256-CBC encrypt with PKCS#7 padding. Prepends a random 16-byte
/// IV to the ciphertext per PDF V=5 spec.
fn aes_cbc_encrypt(plaintext: &[u8], key: &[u8]) -> Result<Vec<u8>> {
    if key.len() != 32 {
        return Err(AppError::Pdf(
            "aes_cbc_encrypt: key must be 32 bytes".into(),
        ));
    }
    let mut iv = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut iv);

    let cipher = Aes256CbcEnc::new_from_slices(key, &iv)
        .map_err(|e| AppError::Pdf(format!("aes init: {e}")))?;

    // Padded length = ceil((plain + 1) / 16) * 16. Always at least
    // one full block of padding even if plaintext is block-aligned.
    let padded_len = ((plaintext.len() / 16) + 1) * 16;
    let mut buf = vec![0u8; padded_len];
    buf[..plaintext.len()].copy_from_slice(plaintext);
    let ct = cipher
        .encrypt_padded_mut::<Pkcs7>(&mut buf, plaintext.len())
        .map_err(|e| AppError::Pdf(format!("aes encrypt: {e}")))?;

    let mut out = Vec::with_capacity(16 + ct.len());
    out.extend_from_slice(&iv);
    out.extend_from_slice(ct);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tiny_pdf() -> Vec<u8> {
        // Use lopdf itself to generate a guaranteed-parseable doc.
        let mut doc = Document::with_version("1.4");
        let pages_id = doc.new_object_id();
        let content_stream =
            lopdf::Stream::new(Dictionary::new(), b"q 1 0 0 rg Q".to_vec()).with_compression(false);
        let content_id = doc.add_object(content_stream);
        let mut page_dict = Dictionary::new();
        page_dict.set("Type", Object::Name(b"Page".to_vec()));
        page_dict.set("Parent", Object::Reference(pages_id));
        page_dict.set(
            "MediaBox",
            Object::Array(vec![
                Object::Integer(0),
                Object::Integer(0),
                Object::Integer(100),
                Object::Integer(100),
            ]),
        );
        page_dict.set("Contents", Object::Reference(content_id));
        let page_id = doc.add_object(page_dict);
        let mut pages_dict = Dictionary::new();
        pages_dict.set("Type", Object::Name(b"Pages".to_vec()));
        pages_dict.set("Kids", Object::Array(vec![Object::Reference(page_id)]));
        pages_dict.set("Count", Object::Integer(1));
        doc.objects.insert(pages_id, Object::Dictionary(pages_dict));
        let mut catalog = Dictionary::new();
        catalog.set("Type", Object::Name(b"Catalog".to_vec()));
        catalog.set("Pages", Object::Reference(pages_id));
        let catalog_id = doc.add_object(catalog);
        doc.trailer.set("Root", Object::Reference(catalog_id));
        let mut out = Vec::new();
        doc.save_to(&mut out).unwrap();
        out
    }

    #[test]
    fn rejects_wrong_fek_length() {
        let r = encrypt_pdf_to_certs(&tiny_pdf(), &[vec![1, 2, 3]], &[0u8; 16], -4);
        assert!(r.is_err());
    }

    #[test]
    fn rejects_empty_recipients() {
        let r = encrypt_pdf_to_certs(&tiny_pdf(), &[], &[0u8; 32], -4);
        assert!(r.is_err());
    }

    #[test]
    fn produces_encrypt_dict_in_output() {
        let envelope = vec![0x30, 0x82, 0x01, 0x00]; // dummy DER prefix
        let fek = vec![0u8; 32];
        let out = encrypt_pdf_to_certs(&tiny_pdf(), &[envelope], &fek, -4)
            .expect("encrypt should succeed");
        let s = String::from_utf8_lossy(&out);
        assert!(
            s.contains("/Adobe.PubSec"),
            "/Adobe.PubSec marker missing in output"
        );
        assert!(s.contains("/adbe.pkcs7.s5"), "/SubFilter missing");
        assert!(s.contains("/AESV3"), "/AESV3 cipher mode missing");
    }

    fn fixture(name: &str) -> std::path::PathBuf {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../crates/satchel-core/tests/fixtures/cms")
            .join(name)
    }

    /// The full native pipeline, decrypt-verified end-to-end: encrypt
    /// a doc for the committed test cert, then play PDF viewer — pull
    /// the /Recipients envelope out of the OUTPUT FILE, unwrap it
    /// with the recipient's private key, derive the FEK from the
    /// recovered seed, and AES-decrypt the page content stream back
    /// to the original bytes. No half passes here: if any stage
    /// (envelope, payload layout, FEK derivation, body encryption)
    /// drifted, the final equality would fail.
    #[test]
    fn native_encrypt_round_trips_via_recipient_key() {
        let cert_pem = std::fs::read_to_string(fixture("test-only-recipient-cert.pem")).unwrap();
        let key_pem = std::fs::read_to_string(fixture("test-only-recipient-key.pem")).unwrap();

        let clear = tiny_pdf();
        let out =
            encrypt_pdf_to_certs_native(&clear, &[cert_pem], -4).expect("native encrypt");

        // Parse the OUTPUT and walk it like a viewer would.
        let doc = Document::load_mem(&out).expect("output parses");
        let enc_ref = doc.trailer.get(b"Encrypt").expect("/Encrypt present");
        let enc = match enc_ref {
            Object::Reference(r) => doc.get_object(*r).unwrap().as_dict().unwrap(),
            Object::Dictionary(d) => d,
            other => panic!("unexpected /Encrypt shape: {other:?}"),
        };
        assert_eq!(enc.get(b"Filter").unwrap().as_name().unwrap(), b"Adobe.PubSec");
        assert_eq!(enc.get(b"V").unwrap().as_i64().unwrap(), 5);
        let cf = enc.get(b"CF").unwrap().as_dict().unwrap();
        let default_cf = cf.get(b"DefaultCryptFilter").unwrap().as_dict().unwrap();
        let recipients = default_cf.get(b"Recipients").unwrap().as_array().unwrap();
        assert_eq!(recipients.len(), 1, "one recipient envelope");
        let envelope = recipients[0].as_str().unwrap();

        // Recipient side: unwrap with the private key (zero
        // fallbacks — our own envelope is strict DER).
        let payload = satchel_core::fallback::assert_no_fallbacks("native envelope", || {
            cms_envelope::unwrap_payload_for_recipient(envelope, &key_pem).expect("unwrap")
        });
        assert_eq!(payload.len(), 24, "seed20 || P4");
        assert_eq!(
            i32::from_le_bytes(payload[20..24].try_into().unwrap()),
            -4,
            "/P round-trips little-endian"
        );
        let fek = derive_fek(&payload[..20]);

        // Decrypt the page content stream with the recovered FEK.
        let pages = doc.get_pages();
        let (_, page_id) = pages.iter().next().expect("one page");
        let page = doc.get_object(*page_id).unwrap().as_dict().unwrap();
        let contents_id = match page.get(b"Contents").unwrap() {
            Object::Reference(r) => *r,
            other => panic!("unexpected /Contents shape: {other:?}"),
        };
        let stream = doc.get_object(contents_id).unwrap().as_stream().unwrap();
        let ct = &stream.content;
        assert!(ct.len() > 16, "IV + at least one block");
        use cbc::Decryptor;
        use cipher::BlockDecryptMut;
        let dec =
            Decryptor::<Aes256>::new_from_slices(&fek, &ct[..16]).expect("cipher init");
        let mut buf = ct[16..].to_vec();
        let plain = dec
            .decrypt_padded_mut::<Pkcs7>(&mut buf)
            .expect("content stream decrypts under recovered FEK");
        assert_eq!(plain, b"q 1 0 0 rg Q", "original content stream recovered");
    }

    #[test]
    fn native_rejects_empty_recipients() {
        let r = encrypt_pdf_to_certs_native(&tiny_pdf(), &[], -4);
        assert!(r.is_err());
    }

    #[test]
    fn native_rejects_garbage_cert() {
        let r = encrypt_pdf_to_certs_native(&tiny_pdf(), &["not a pem".to_string()], -4);
        assert!(r.is_err());
    }

    #[test]
    fn aes_cbc_round_trip() {
        use aes::Aes256;
        use cbc::Decryptor;
        use cipher::BlockDecryptMut;
        type Aes256CbcDec = Decryptor<Aes256>;
        let key = [0u8; 32];
        let plaintext = b"Hello, world!";
        let ct = aes_cbc_encrypt(plaintext, &key).unwrap();
        let iv: [u8; 16] = ct[..16].try_into().unwrap();
        let body = &ct[16..];
        let dec = Aes256CbcDec::new_from_slices(&key, &iv).unwrap();
        let mut buf = body.to_vec();
        let pt = dec
            .decrypt_padded_mut::<Pkcs7>(&mut buf)
            .expect("decrypt should pass");
        assert_eq!(pt, plaintext);
    }
}
