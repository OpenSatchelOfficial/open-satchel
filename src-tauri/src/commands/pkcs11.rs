// PKCS#11 signing path for hardware tokens, smart cards, and HSMs.
//
// Wraps the `cryptoki` crate (PKCS#11 v2.40 safe bindings) with Tauri
// commands the frontend calls from pdfSignPkcs11.ts. Loads whatever
// PKCS#11 module the user configures:
//   • SoftHSM2 (dev/CI): C:\Program Files\SoftHSM2\lib\softhsm2-x64.dll
//   • YubiKey:          C:\Program Files\Yubico\YubiKey Manager\ykcs11.dll
//   • OpenSC PIV/CAC:   C:\Windows\System32\opensc-pkcs11.dll
//   • Thales SafeNet:   C:\Program Files\SafeNet\LunaClient\cryptoki.dll
//   • US DoD CAC:       via ActivClient or the card's bundled driver
//
// All state is per-call — the PKCS#11 C API is session-based but we
// don't hold sessions across commands (simpler; user may physically
// remove a token between calls). Slot/token state can change at any
// moment, so each command reloads and re-opens.

use cryptoki::context::{CInitializeArgs, Pkcs11};
use cryptoki::mechanism::Mechanism;
use cryptoki::object::{Attribute, AttributeType, ObjectClass};
use cryptoki::session::UserType;
use cryptoki::slot::Slot;
use cryptoki::types::AuthPin;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct Pkcs11Slot {
    /// PKCS#11 slot ID (used internally by other commands).
    pub slot_id: u64,
    /// Slot description from the module (e.g. "SoftHSM slot ID 0x0").
    pub slot_description: String,
    /// Manufacturer ID — useful to distinguish one token from another
    /// when multiple are plugged in.
    pub manufacturer: String,
    /// True if a token is currently present in the slot. Empty slots
    /// are typically listed but unusable.
    pub token_present: bool,
    /// Token label (user-assigned name during init). Empty if no token.
    pub token_label: Option<String>,
    /// Token serial — unique per physical device, survives reformat.
    pub token_serial: Option<String>,
    /// True if the token requires PIN login before reading private keys.
    /// Nearly always true for real HSMs / smart cards; false for some
    /// attended software simulators.
    pub login_required: bool,
}

#[derive(Debug, Serialize)]
pub struct Pkcs11Certificate {
    /// CKA_ID — opaque token-specific handle, used to target this key
    /// in a subsequent pkcs11_sign_hash call.
    pub id_hex: String,
    /// CKA_LABEL — human-readable label assigned at key-import time.
    pub label: String,
    /// Full DER bytes of the X.509 certificate (base64 for JSON
    /// transport — the frontend needs to hash this for the sig cert
    /// chain).
    pub cert_der_b64: String,
    /// Subject DN in readable form.
    pub subject: String,
    /// Issuer DN.
    pub issuer: String,
}

/// List every slot the module knows about. Call with an absolute path
/// to the PKCS#11 module (e.g. softhsm2-x64.dll). Returns a list even
/// if no tokens are present — the UI may want to show empty slots to
/// the user.
#[tauri::command]
pub fn pkcs11_list_slots(module_path: String) -> Result<Vec<Pkcs11Slot>, String> {
    let pkcs11 = load_module(&module_path)?;
    let slots = pkcs11
        .get_all_slots()
        .map_err(|e| format!("get_all_slots: {e}"))?;
    let mut out = Vec::with_capacity(slots.len());
    for slot in slots {
        match slot_info(&pkcs11, slot) {
            Ok(info) => out.push(info),
            Err(_) => {
                // Slot exists but module can't describe it — surface
                // a minimal stub so the UI can still render "slot N
                // (uninitialized)".
                out.push(Pkcs11Slot {
                    slot_id: u64::from(slot.id()),
                    slot_description: String::new(),
                    manufacturer: String::new(),
                    token_present: false,
                    token_label: None,
                    token_serial: None,
                    login_required: false,
                });
            }
        }
    }
    Ok(out)
}

/// Log in to the given slot with the user's PIN and enumerate every
/// X.509 certificate on the token. The cert DER is returned so the
/// caller can pick which signing-key to use (PDF signatures need the
/// cert chain in the PKCS#7 envelope; we ask the token for it).
#[tauri::command]
pub fn pkcs11_list_certificates(
    module_path: String,
    slot_id: u64,
    pin: String,
) -> Result<Vec<Pkcs11Certificate>, String> {
    let pkcs11 = load_module(&module_path)?;
    let slot = find_slot(&pkcs11, slot_id)?;
    let session = pkcs11
        .open_ro_session(slot)
        .map_err(|e| format!("open session: {e}"))?;
    let pin = AuthPin::new(pin);
    session
        .login(UserType::User, Some(&pin))
        .map_err(|e| format!("login: {e}"))?;

    let cert_class = Attribute::Class(ObjectClass::CERTIFICATE);
    let handles = session
        .find_objects(&[cert_class])
        .map_err(|e| format!("find certificates: {e}"))?;

    let mut out = Vec::with_capacity(handles.len());
    for h in handles {
        let attrs = session
            .get_attributes(
                h,
                &[
                    AttributeType::Id,
                    AttributeType::Label,
                    AttributeType::Value,
                    AttributeType::Subject,
                    AttributeType::Issuer,
                ],
            )
            .map_err(|e| format!("get_attributes: {e}"))?;
        let id_hex = attrs
            .iter()
            .find_map(|a| {
                if let Attribute::Id(b) = a {
                    Some(bytes_to_hex(b))
                } else {
                    None
                }
            })
            .unwrap_or_default();
        let label = attrs
            .iter()
            .find_map(|a| {
                if let Attribute::Label(b) = a {
                    Some(bytes_to_utf8_lossy(b))
                } else {
                    None
                }
            })
            .unwrap_or_default();
        let cert_der = attrs
            .iter()
            .find_map(|a| {
                if let Attribute::Value(b) = a {
                    Some(b.clone())
                } else {
                    None
                }
            })
            .unwrap_or_default();
        let subject = attrs
            .iter()
            .find_map(|a| {
                if let Attribute::Subject(b) = a {
                    Some(dn_bytes_to_string(b))
                } else {
                    None
                }
            })
            .unwrap_or_default();
        let issuer = attrs
            .iter()
            .find_map(|a| {
                if let Attribute::Issuer(b) = a {
                    Some(dn_bytes_to_string(b))
                } else {
                    None
                }
            })
            .unwrap_or_default();
        use base64::{engine::general_purpose::STANDARD, Engine};
        let cert_der_b64 = STANDARD.encode(&cert_der);
        out.push(Pkcs11Certificate {
            id_hex,
            label,
            cert_der_b64,
            subject,
            issuer,
        });
    }
    Ok(out)
}

/// Sign a pre-computed hash with the private key that matches the
/// given certificate ID (CKA_ID). Returns raw PKCS#1 v1.5 RSA signature
/// bytes — the frontend wraps these in the PDF PKCS#7 envelope.
///
/// `mechanism` is "SHA256_RSA_PKCS" | "SHA384_RSA_PKCS" | "SHA512_RSA_PKCS"
/// | "RSA_PKCS" (pre-hashed input, caller already digested). Most PDF
/// signing uses "RSA_PKCS" with a SHA-256 digest prefixed by the
/// DigestInfo ASN.1 header.
#[tauri::command]
pub fn pkcs11_sign_hash(
    module_path: String,
    slot_id: u64,
    pin: String,
    key_id_hex: String,
    hash: Vec<u8>,
    mechanism: String,
) -> Result<Vec<u8>, String> {
    let pkcs11 = load_module(&module_path)?;
    let slot = find_slot(&pkcs11, slot_id)?;
    let session = pkcs11
        .open_rw_session(slot)
        .map_err(|e| format!("open session: {e}"))?;
    let pin = AuthPin::new(pin);
    session
        .login(UserType::User, Some(&pin))
        .map_err(|e| format!("login: {e}"))?;

    let key_id = hex_to_bytes(&key_id_hex).map_err(|e| format!("invalid key_id_hex: {e}"))?;
    let template = [
        Attribute::Class(ObjectClass::PRIVATE_KEY),
        Attribute::Id(key_id),
    ];
    let keys = session
        .find_objects(&template)
        .map_err(|e| format!("find_objects: {e}"))?;
    let priv_key = keys
        .first()
        .copied()
        .ok_or_else(|| "No private key on token matches the given CKA_ID".to_string())?;

    let mech = match mechanism.as_str() {
        "RSA_PKCS" => Mechanism::RsaPkcs,
        "SHA256_RSA_PKCS" => Mechanism::Sha256RsaPkcs,
        "SHA384_RSA_PKCS" => Mechanism::Sha384RsaPkcs,
        "SHA512_RSA_PKCS" => Mechanism::Sha512RsaPkcs,
        other => return Err(format!("Unsupported mechanism: {other}")),
    };

    let sig = session
        .sign(&mech, priv_key, &hash)
        .map_err(|e| format!("sign: {e}"))?;
    Ok(sig)
}

// ── Helpers ────────────────────────────────────────────────────────

fn load_module(path: &str) -> Result<Pkcs11, String> {
    let pkcs11 = Pkcs11::new(path).map_err(|e| format!("load module {path}: {e}"))?;
    pkcs11
        .initialize(CInitializeArgs::OsThreads)
        .map_err(|e| format!("initialize: {e}"))?;
    Ok(pkcs11)
}

fn find_slot(pkcs11: &Pkcs11, slot_id: u64) -> Result<Slot, String> {
    let slots = pkcs11
        .get_all_slots()
        .map_err(|e| format!("get_all_slots: {e}"))?;
    slots
        .into_iter()
        .find(|s| u64::from(s.id()) == slot_id)
        .ok_or_else(|| format!("Slot {slot_id} not found"))
}

fn slot_info(pkcs11: &Pkcs11, slot: Slot) -> Result<Pkcs11Slot, String> {
    let info = pkcs11
        .get_slot_info(slot)
        .map_err(|e| format!("get_slot_info: {e}"))?;
    let token_present = info.token_present();
    let mut token_label = None;
    let mut token_serial = None;
    let mut login_required = false;
    if token_present {
        if let Ok(ti) = pkcs11.get_token_info(slot) {
            token_label = Some(ti.label().to_string());
            token_serial = Some(ti.serial_number().to_string());
            login_required = ti.login_required();
        }
    }
    Ok(Pkcs11Slot {
        slot_id: u64::from(slot.id()),
        slot_description: info.slot_description().to_string(),
        manufacturer: info.manufacturer_id().to_string(),
        token_present,
        token_label,
        token_serial,
        login_required,
    })
}

fn bytes_to_hex(b: &[u8]) -> String {
    let mut s = String::with_capacity(b.len() * 2);
    for byte in b {
        use std::fmt::Write;
        let _ = write!(s, "{:02x}", byte);
    }
    s
}

fn hex_to_bytes(s: &str) -> Result<Vec<u8>, String> {
    if s.len() % 2 != 0 {
        return Err(format!("odd-length hex ({} chars)", s.len()));
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|e| e.to_string()))
        .collect()
}

fn bytes_to_utf8_lossy(b: &[u8]) -> String {
    String::from_utf8_lossy(b)
        .trim_end_matches('\0')
        .to_string()
}

/// Best-effort human-readable DN from a DER-encoded Name. We don't
/// fully parse ASN.1 here — PDF cert display is informational and
/// the source-of-truth DER is still in cert_der_b64. Returns the
/// ASCII slice from the first CN if found, else hex.
fn dn_bytes_to_string(b: &[u8]) -> String {
    // Common Name OID = 2.5.4.3 = DER-encoded as 06 03 55 04 03
    const CN_OID: [u8; 5] = [0x06, 0x03, 0x55, 0x04, 0x03];
    if let Some(pos) = b.windows(5).position(|w| w == CN_OID) {
        // After the OID is a tagged string: tag byte, length, value.
        let after = &b[pos + 5..];
        if after.len() >= 2 {
            let len = after[1] as usize;
            if after.len() >= 2 + len {
                return String::from_utf8_lossy(&after[2..2 + len]).to_string();
            }
        }
    }
    bytes_to_hex(b)
}
