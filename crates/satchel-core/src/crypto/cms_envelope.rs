//! CMS EnvelopedData (RFC 5652 §6) wrap/unwrap for the PDF
//! /Adobe.PubSec recipient blob — RSA PKCS#1 v1.5 key transport +
//! AES-128-CBC content encryption, byte-compatible with what
//! node-forge historically emitted from `pdfCryptoPubKey.ts`
//! (AES-128-CBC is the broadly-compatible pick; the AES-256 is on
//! the PDF content, not this envelope).
//!
//! Production path since 2026-06-11 — see [`crate::crypto`].

use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
use cms::builder::{ContentEncryptionAlgorithm, EnvelopedDataBuilder, KeyTransRecipientInfoBuilder};
use cms::content_info::ContentInfo;
use cms::enveloped_data::{EnvelopedData, RecipientIdentifier, RecipientInfo};
use der::asn1::{ObjectIdentifier, OctetString};
use der::referenced::OwnedToRef;
use der::{Decode, DecodePem, Encode};
use rsa::{Pkcs1v15Encrypt, RsaPrivateKey};
use x509_cert::Certificate;

use crate::{CoreError, Result};

/// `id-envelopedData` (RFC 5652 §12.1).
const ID_ENVELOPED_DATA: ObjectIdentifier =
    ObjectIdentifier::new_unwrap("1.2.840.113549.1.7.3");
/// `aes128-CBC` (NIST aes OID arc).
const ID_AES128_CBC: ObjectIdentifier = ObjectIdentifier::new_unwrap("2.16.840.1.101.3.4.1.2");

fn err(context: &str, e: impl core::fmt::Display) -> CoreError {
    CoreError::Parse(format!("cms {context}: {e}"))
}

/// Build a DER-encoded CMS `ContentInfo(EnvelopedData)` wrapping
/// `payload` for the recipient identified by `recipient_cert_pem`
/// (RSA certificate, PEM). Mirrors node-forge's
/// `createEnvelopedData + addRecipient + encrypt(aes128-CBC)`.
pub fn wrap_payload_for_recipient(payload: &[u8], recipient_cert_pem: &str) -> Result<Vec<u8>> {
    let cert = Certificate::from_pem(recipient_cert_pem.as_bytes())
        .map_err(|e| err("certificate parse", e))?;

    let recipient_identifier = RecipientIdentifier::IssuerAndSerialNumber(
        cms::cert::IssuerAndSerialNumber {
            issuer: cert.tbs_certificate.issuer.clone(),
            serial_number: cert.tbs_certificate.serial_number.clone(),
        },
    );

    let recipient_public_key = rsa::RsaPublicKey::try_from(
        cert.tbs_certificate
            .subject_public_key_info
            .owned_to_ref(),
    )
    .map_err(|e| err("recipient public key", e))?;

    // Two OsRng handles: the recipient builder holds a &mut borrow
    // for the RSA key-transport encryption, the envelope build uses
    // its own for CEK + IV generation. OsRng is a ZST handle onto
    // the OS generator, so two values are two views of one source.
    let mut ktri_rng = rand::rngs::OsRng;
    let recipient_builder = KeyTransRecipientInfoBuilder::new(
        recipient_identifier,
        cms::builder::KeyEncryptionInfo::Rsa(recipient_public_key),
        &mut ktri_rng,
    )
    .map_err(|e| err("recipient builder", e))?;

    let mut builder = EnvelopedDataBuilder::new(
        None, // no originator info
        payload,
        ContentEncryptionAlgorithm::Aes128Cbc,
        None, // no unprotected attributes
    )
    .map_err(|e| err("envelope builder", e))?;

    let mut rng = rand::rngs::OsRng;
    let enveloped = builder
        .add_recipient_info(recipient_builder)
        .map_err(|e| err("add recipient", e))?
        .build_with_rng(&mut rng)
        .map_err(|e| err("envelope build", e))?;

    let content = der::Any::encode_from(&enveloped).map_err(|e| err("content encode", e))?;
    let content_info = ContentInfo {
        content_type: ID_ENVELOPED_DATA,
        content,
    };
    content_info.to_der().map_err(|e| err("DER encode", e))
}

/// Decrypt a DER-encoded CMS `ContentInfo(EnvelopedData)` with the
/// recipient's RSA private key (PKCS#1 or PKCS#8 PEM). Returns the
/// original payload. Mirrors node-forge's
/// `messageFromAsn1 + findRecipient + decrypt`.
pub fn unwrap_payload_for_recipient(envelope_der: &[u8], private_key_pem: &str) -> Result<Vec<u8>> {
    // PARITY FINDING (Storm Night 1): node-forge emits the
    // EncryptedContentInfo encryptedContent as a CONSTRUCTED [0]
    // wrapping OCTET STRING segment(s) — legal BER, but RFC 5652
    // wants [0] IMPLICIT OCTET STRING and the strict `der` crate
    // rejects the constructed form ("not canonically encoded as
    // DER"). Acrobat/OpenSSL accept both. Normalize before parsing
    // so both producers' envelopes read identically. Both the
    // normalization firing and a failed normalization are recorded
    // fallbacks — strict tests see exactly which inputs were
    // canonical DER and which needed repair.
    let normalized = match normalize_ber_constructed_strings(envelope_der) {
        Some(n) => {
            if n != envelope_der {
                crate::fallback::record(
                    "cms.ber_normalized",
                    format!(
                        "envelope was BER (constructed strings); normalized {} -> {} bytes",
                        envelope_der.len(),
                        n.len()
                    ),
                );
            }
            n
        }
        None => {
            crate::fallback::record(
                "cms.ber_normalize_failed",
                "TLV walk failed; parsing original bytes as-is",
            );
            envelope_der.to_vec()
        }
    };
    let envelope_der = normalized.as_slice();
    let content_info =
        ContentInfo::from_der(envelope_der).map_err(|e| err("ContentInfo parse", e))?;
    if content_info.content_type != ID_ENVELOPED_DATA {
        return Err(CoreError::Parse(format!(
            "cms: not EnvelopedData (content type {})",
            content_info.content_type
        )));
    }
    let enveloped: EnvelopedData = content_info
        .content
        .decode_as()
        .map_err(|e| err("EnvelopedData parse", e))?;

    let key = parse_rsa_private_key_pem(private_key_pem)?;

    // Try every key-transport recipient until one RSA-decrypts.
    let mut cek: Option<Vec<u8>> = None;
    for ri in enveloped.recip_infos.0.iter() {
        let RecipientInfo::Ktri(ktri) = ri else {
            continue;
        };
        if let Ok(k) = key.decrypt(Pkcs1v15Encrypt, ktri.enc_key.as_bytes()) {
            cek = Some(k);
            break;
        }
    }
    let cek = cek.ok_or_else(|| {
        CoreError::Parse("cms: no key-transport recipient decrypts with this key".into())
    })?;

    let eci = &enveloped.encrypted_content;
    if eci.content_enc_alg.oid != ID_AES128_CBC {
        return Err(CoreError::Parse(format!(
            "cms: unsupported content encryption {} (spike supports aes128-CBC)",
            eci.content_enc_alg.oid
        )));
    }
    let iv: OctetString = eci
        .content_enc_alg
        .parameters
        .as_ref()
        .ok_or_else(|| CoreError::Parse("cms: missing CBC IV parameter".into()))?
        .decode_as()
        .map_err(|e| err("IV parse", e))?;
    let ciphertext = eci
        .encrypted_content
        .as_ref()
        .ok_or_else(|| CoreError::Parse("cms: detached encrypted content".into()))?
        .as_bytes()
        .to_vec();

    let cipher = cbc::Decryptor::<aes::Aes128>::new_from_slices(&cek, iv.as_bytes())
        .map_err(|e| err("cipher init", e))?;
    let mut buf = ciphertext;
    let plain = cipher
        .decrypt_padded_mut::<Pkcs7>(&mut buf)
        .map_err(|e| err("decrypt", e))?;
    Ok(plain.to_vec())
}

/// Encrypt with explicit key/iv — only used to sanity-test the CBC
/// plumbing independent of the builder.
#[cfg(test)]
fn aes128_cbc_encrypt(key: &[u8], iv: &[u8], plain: &[u8]) -> Vec<u8> {
    use aes::cipher::BlockEncryptMut;
    cbc::Encryptor::<aes::Aes128>::new_from_slices(key, iv)
        .expect("cipher init")
        .encrypt_padded_vec_mut::<Pkcs7>(plain)
}

/// Minimal BER→DER normalization for the one construct node-forge
/// produces and strict DER forbids: a context-class CONSTRUCTED tag
/// whose children are all primitive OCTET STRINGs becomes the same
/// context tag PRIMITIVE with the children's contents concatenated.
/// Everything else is re-emitted unchanged (children recursed,
/// definite lengths recomputed). Returns `None` on any structure we
/// don't understand — callers fall back to the original bytes.
fn normalize_ber_constructed_strings(bytes: &[u8]) -> Option<Vec<u8>> {
    fn read_tlv(b: &[u8]) -> Option<(u8, usize, usize, usize)> {
        // -> (tag, header_len, content_len, total_len); definite,
        // low-tag-number form only (all CMS tags here qualify).
        if b.len() < 2 {
            return None;
        }
        let tag = b[0];
        if tag & 0x1f == 0x1f {
            return None; // high tag number — out of scope
        }
        let first = b[1] as usize;
        let (header_len, content_len) = if first < 0x80 {
            (2, first)
        } else {
            let n = first & 0x7f;
            if n == 0 || n > 4 || b.len() < 2 + n {
                return None; // indefinite or oversized
            }
            let mut len = 0usize;
            for i in 0..n {
                len = (len << 8) | b[2 + i] as usize;
            }
            (2 + n, len)
        };
        if b.len() < header_len + content_len {
            return None;
        }
        Some((tag, header_len, content_len, header_len + content_len))
    }

    fn encode_node(tag: u8, content: &[u8], out: &mut Vec<u8>) {
        out.push(tag);
        let len = content.len();
        if len < 0x80 {
            out.push(len as u8);
        } else {
            let n_bytes = len.to_be_bytes();
            let skip = n_bytes.iter().take_while(|&&b| b == 0).count();
            out.push(0x80 | (n_bytes.len() - skip) as u8);
            out.extend_from_slice(&n_bytes[skip..]);
        }
        out.extend_from_slice(content);
    }

    fn walk(b: &[u8], out: &mut Vec<u8>) -> Option<()> {
        let mut rest = b;
        while !rest.is_empty() {
            let (tag, header_len, content_len, total_len) = read_tlv(rest)?;
            let content = &rest[header_len..header_len + content_len];
            let constructed = tag & 0x20 != 0;
            let context_class = tag & 0xc0 == 0x80;

            if constructed && context_class {
                // Are ALL children primitive OCTET STRINGs (0x04)?
                let mut children = content;
                let mut all_octets = true;
                let mut concat: Vec<u8> = Vec::new();
                while !children.is_empty() {
                    let (ct, ch, cl, ctl) = match read_tlv(children) {
                        Some(v) => v,
                        None => {
                            all_octets = false;
                            break;
                        }
                    };
                    if ct != 0x04 {
                        all_octets = false;
                        break;
                    }
                    concat.extend_from_slice(&children[ch..ch + cl]);
                    children = &children[ctl..];
                }
                if all_octets && !content.is_empty() {
                    // Re-emit as PRIMITIVE context tag, contents
                    // concatenated.
                    encode_node(tag & !0x20, &concat, out);
                    rest = &rest[total_len..];
                    continue;
                }
            }

            if constructed {
                let mut inner = Vec::new();
                walk(content, &mut inner)?;
                encode_node(tag, &inner, out);
            } else {
                encode_node(tag, content, out);
            }
            rest = &rest[total_len..];
        }
        Some(())
    }

    let mut out = Vec::with_capacity(bytes.len());
    walk(bytes, &mut out)?;
    Some(out)
}

fn parse_rsa_private_key_pem(pem: &str) -> Result<RsaPrivateKey> {
    use rsa::pkcs1::DecodeRsaPrivateKey;
    use rsa::pkcs8::DecodePrivateKey;
    if let Ok(k) = RsaPrivateKey::from_pkcs1_pem(pem) {
        return Ok(k);
    }
    RsaPrivateKey::from_pkcs8_pem(pem).map_err(|e| err("private key parse", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    const CERT_PEM: &str = include_str!("../../tests/fixtures/cms/test-only-recipient-cert.pem");
    const KEY_PEM: &str = include_str!("../../tests/fixtures/cms/test-only-recipient-key.pem");
    const PAYLOAD: &[u8] = include_bytes!("../../tests/fixtures/cms/payload.bin");
    const FORGE_ENVELOPE: &[u8] =
        include_bytes!("../../tests/fixtures/cms/forge-envelope.der");
    const FORGE_ENVELOPE_MULTISEGMENT: &[u8] =
        include_bytes!("../../tests/fixtures/cms/forge-envelope-multisegment.der");

    #[test]
    fn aes_cbc_plumbing_round_trips() {
        let key = [7u8; 16];
        let iv = [9u8; 16];
        let ct = aes128_cbc_encrypt(&key, &iv, b"hello cms spike");
        let cipher = cbc::Decryptor::<aes::Aes128>::new_from_slices(&key, &iv).unwrap();
        let mut buf = ct;
        let pt = cipher.decrypt_padded_mut::<Pkcs7>(&mut buf).unwrap();
        assert_eq!(pt, b"hello cms spike");
    }

    /// forge → Rust: the committed node-forge envelope decrypts to
    /// the committed payload — AND the BER normalization fallback
    /// fires exactly once doing it (forge's output is not canonical
    /// DER; reading it without the normalizer would fail).
    #[test]
    fn unwraps_node_forge_envelope() {
        let (result, events) = crate::fallback::capture(|| {
            unwrap_payload_for_recipient(FORGE_ENVELOPE, KEY_PEM)
        });
        let payload = result.expect("unwrap");
        assert_eq!(payload, PAYLOAD);
        assert_eq!(payload.len(), 24, "20-byte seed + 4-byte /P");
        let areas: Vec<&str> = events.iter().map(|e| e.area.as_str()).collect();
        assert_eq!(
            areas,
            vec!["cms.ber_normalized"],
            "forge envelopes must be flagged as BER-normalized (and nothing else)"
        );
    }

    /// Rust → Rust: wrap then unwrap round-trips with ZERO
    /// fallbacks — our own output must be strict canonical DER that
    /// never needs the normalizer.
    #[test]
    fn wrap_unwrap_round_trips_fallback_free() {
        crate::fallback::assert_no_fallbacks("rust→rust CMS round-trip", || {
            let envelope = wrap_payload_for_recipient(PAYLOAD, CERT_PEM).expect("wrap");
            let payload = unwrap_payload_for_recipient(&envelope, KEY_PEM).expect("unwrap");
            assert_eq!(payload, PAYLOAD);
        });
    }

    /// BER edge case: the encrypted content split across MULTIPLE
    /// octet-string segments inside the constructed [0] (streaming
    /// BER encoders do this; scripts/storm/gen-cms-edge-fixtures.mjs
    /// synthesizes it with a 16+5+11 split landing mid-block). The
    /// normalizer must concatenate the segments; decryption must
    /// yield the identical payload.
    #[test]
    fn unwraps_multisegment_ber_envelope() {
        let (result, events) = crate::fallback::capture(|| {
            unwrap_payload_for_recipient(FORGE_ENVELOPE_MULTISEGMENT, KEY_PEM)
        });
        let payload = result.expect("unwrap multisegment");
        assert_eq!(payload, PAYLOAD);
        let areas: Vec<&str> = events.iter().map(|e| e.area.as_str()).collect();
        assert_eq!(areas, vec!["cms.ber_normalized"]);
    }

    #[test]
    fn wrong_key_fails_closed() {
        // A fresh random key must not decrypt the fixture envelope.
        let mut rng = rand::rngs::OsRng;
        let wrong = RsaPrivateKey::new(&mut rng, 2048).expect("keygen");
        use rsa::pkcs1::EncodeRsaPrivateKey;
        let wrong_pem = wrong.to_pkcs1_pem(Default::default()).unwrap();
        assert!(unwrap_payload_for_recipient(FORGE_ENVELOPE, &wrong_pem).is_err());
    }
}
