//! Commercial-license verification.
//!
//! The license file is a plain-text Ed25519-signed JWT (compact
//! serialization). The Ed25519 public key is embedded at compile time
//! via `include_bytes!()`; the matching private key lives entirely
//! outside this repository and is held by the licensing service that
//! issues tokens.
//!
//! Verification is fully offline — there is no online revocation
//! check, by design, so the app continues to work in air-gapped
//! environments.
//!
//! **All editions are feature-identical.** A verified license only
//! influences the displayed edition label. No feature gating is
//! performed anywhere in the codebase based on license state. An
//! expired license simply reverts the displayed edition to
//! "Public Edition" and the software keeps working under AGPL-3.0.
//!
//! License IDs follow `OS-{NP|SM|MID|LG}-XXXX-XXXX-XXXX-XXXX`. Current
//! Paddle-issued tokens store this ID in the JWT `jti` claim and the
//! commercial tier in `tier`; older/manual tokens may still use
//! `license_id`. Both shapes are accepted.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use tauri::Manager;

const PUBKEY_PEM: &[u8] = include_bytes!("../keys/license_pubkey.pem");
const LICENSE_FILENAME: &str = "license.json";
const PUBLIC_EDITION: &str = "Public Edition";

/// Persisted license state. We keep the original token so every status
/// check re-verifies the signature + exp claim — an expired license
/// expires automatically without separate scheduling.
#[derive(Serialize, Deserialize)]
struct PersistedLicense {
    /// Raw JWT compact serialization, exactly as issued.
    token: String,
    /// Unix timestamp of first successful activation on this install.
    activated_at: i64,
}

#[derive(Clone, Debug)]
struct LicenseSession {
    token: String,
    activated_at: i64,
}

/// License information returned to the frontend for display.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LicenseInfo {
    pub license_id: String,
    pub edition: String,
    pub customer_email: Option<String>,
    pub expires_at: i64,
    pub activated_at: i64,
}

/// JWT claims as issued by the licensing service. `license_id` is the
/// legacy explicit license id, `jti` is the current JWT id issued by the
/// Paddle webhook, and `sub` is normally the customer email. Other
/// standard JWT claims (iat, iss, aud) may be present in the token —
/// serde ignores unknown fields, so we only declare what we use.
#[derive(Debug, Deserialize)]
struct Claims {
    #[serde(default)]
    sub: Option<String>,
    #[serde(default)]
    license_id: Option<String>,
    #[serde(default)]
    jti: Option<String>,
    #[serde(default)]
    tier: Option<String>,
    #[serde(default)]
    customer_email: Option<String>,
    exp: i64,
}

impl Claims {
    fn id(&self) -> Option<&str> {
        self.license_id
            .as_deref()
            .or(self.jti.as_deref())
            .or(self.sub.as_deref())
    }

    fn display_email(&self) -> Option<String> {
        self.customer_email.clone().or_else(|| {
            self.sub
                .as_deref()
                .filter(|value| looks_like_email(value))
                .map(ToString::to_string)
        })
    }
}

#[derive(Debug, thiserror::Error)]
pub enum LicenseError {
    #[error("license file not found")]
    NotFound,
    #[error("could not read license file: {0}")]
    Io(#[from] std::io::Error),
    #[error("license file is empty")]
    Empty,
    #[error("license signature verification failed")]
    Signature,
    #[error("license has expired")]
    Expired,
    #[error("license claim missing: {0}")]
    MissingClaim(&'static str),
    #[error("invalid license token: {0}")]
    Token(String),
    #[error("app data directory unavailable: {0}")]
    AppData(String),
}

impl serde::Serialize for LicenseError {
    fn serialize<S>(&self, ser: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        ser.serialize_str(&self.to_string())
    }
}

#[derive(Default)]
pub struct LicenseState(Mutex<Option<LicenseSession>>);

fn verify_token(token: &str) -> Result<Claims, LicenseError> {
    let key = DecodingKey::from_ed_pem(PUBKEY_PEM)
        .map_err(|e| LicenseError::Token(format!("pubkey parse: {e}")))?;
    let mut validation = Validation::new(Algorithm::EdDSA);
    validation.validate_exp = true;
    // The issuer does not currently set aud/iss claims; opt out of
    // requiring them so verification doesn't reject valid tokens.
    validation.required_spec_claims.clear();
    validation.validate_aud = false;
    let data = decode::<Claims>(token, &key, &validation).map_err(|e| {
        use jsonwebtoken::errors::ErrorKind;
        match e.kind() {
            ErrorKind::ExpiredSignature => LicenseError::Expired,
            ErrorKind::InvalidSignature => LicenseError::Signature,
            _ => LicenseError::Token(e.to_string()),
        }
    })?;
    Ok(data.claims)
}

fn edition_from_license_id(id: &str) -> &'static str {
    if id.starts_with("OS-NP-") {
        "Nonprofit / Education Edition"
    } else if id.starts_with("OS-SM-") {
        "Small Organization Edition"
    } else if id.starts_with("OS-MID-") {
        "Mid Organization Edition"
    } else if id.starts_with("OS-LG-") {
        "Large Organization Edition"
    } else {
        PUBLIC_EDITION
    }
}

fn edition_from_tier(tier: &str) -> Option<&'static str> {
    match tier.trim().to_ascii_lowercase().as_str() {
        "nonprofit"
        | "education"
        | "edu"
        | "np"
        | "nonprofit_education"
        | "nonprofit-education"
        | "nonprofit/education" => Some("Nonprofit / Education Edition"),
        "small" | "sm" => Some("Small Organization Edition"),
        "mid" | "medium" | "midmarket" | "mid-market" | "mid_market" | "mid org"
        | "mid organization" => Some("Mid Organization Edition"),
        "large" | "lg" | "enterprise" => Some("Large Organization Edition"),
        _ => None,
    }
}

fn looks_like_email(value: &str) -> bool {
    let Some((local, domain)) = value.split_once('@') else {
        return false;
    };
    !local.is_empty() && domain.contains('.') && !domain.ends_with('.')
}

fn claims_to_info(claims: Claims, activated_at: i64) -> Result<LicenseInfo, LicenseError> {
    let id = claims
        .id()
        .ok_or(LicenseError::MissingClaim("license_id"))?
        .to_string();
    let edition = claims
        .tier
        .as_deref()
        .and_then(edition_from_tier)
        .unwrap_or_else(|| edition_from_license_id(&id))
        .to_string();
    let customer_email = claims.display_email();
    Ok(LicenseInfo {
        edition,
        license_id: id,
        customer_email,
        expires_at: claims.exp,
        activated_at,
    })
}

fn license_path(app: &tauri::AppHandle) -> Result<PathBuf, LicenseError> {
    app.path()
        .app_data_dir()
        .map(|d| d.join(LICENSE_FILENAME))
        .map_err(|e| LicenseError::AppData(e.to_string()))
}

fn read_persisted(app: &tauri::AppHandle) -> Result<PersistedLicense, LicenseError> {
    let path = license_path(app)?;
    if !path.exists() {
        return Err(LicenseError::NotFound);
    }
    let raw = fs::read_to_string(&path)?;
    serde_json::from_str(&raw).map_err(|e| LicenseError::Token(format!("license.json: {e}")))
}

fn write_persisted(
    app: &tauri::AppHandle,
    persisted: &PersistedLicense,
) -> Result<(), LicenseError> {
    let path = license_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let raw = serde_json::to_string_pretty(persisted)
        .map_err(|e| LicenseError::Token(format!("serialize: {e}")))?;
    fs::write(&path, raw)?;
    Ok(())
}

fn session_to_info(session: &LicenseSession) -> Result<LicenseInfo, LicenseError> {
    let claims = verify_token(&session.token)?;
    claims_to_info(claims, session.activated_at)
}

fn try_load(app: &tauri::AppHandle) -> Option<LicenseSession> {
    let persisted = read_persisted(app).ok()?;
    let session = LicenseSession {
        token: persisted.token,
        activated_at: persisted.activated_at,
    };
    session_to_info(&session).ok()?;
    Some(session)
}

/// Called from `setup()` at app startup. Reads the persisted license,
/// re-verifies the token (so expired licenses don't leak through),
/// and populates `LicenseState`. Any error (missing file, bad
/// signature, expiry) silently leaves state as None — the app falls
/// back to Public Edition.
pub fn load_on_startup(app: &tauri::AppHandle) {
    let Some(session) = try_load(app) else {
        return;
    };
    let state = app.state::<LicenseState>();
    let lock = state.0.lock();
    if let Ok(mut g) = lock {
        *g = Some(session);
    }
}

#[tauri::command]
pub fn license_activate(
    path: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, LicenseState>,
) -> Result<LicenseInfo, LicenseError> {
    let token = fs::read_to_string(&path)?;
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err(LicenseError::Empty);
    }
    let claims = verify_token(&token)?;
    let activated_at = chrono::Utc::now().timestamp();
    let info = claims_to_info(claims, activated_at)?;
    let session = LicenseSession {
        token: token.clone(),
        activated_at,
    };
    write_persisted(
        &app,
        &PersistedLicense {
            token,
            activated_at,
        },
    )?;
    if let Ok(mut g) = state.0.lock() {
        *g = Some(session);
    }
    Ok(info)
}

#[tauri::command]
pub fn license_status(state: tauri::State<'_, LicenseState>) -> Option<LicenseInfo> {
    let mut guard = state.0.lock().ok()?;
    let Some(session) = guard.as_ref() else {
        return None;
    };
    match session_to_info(session) {
        Ok(info) => Some(info),
        Err(_) => {
            *guard = None;
            None
        }
    }
}

#[tauri::command]
pub fn license_deactivate(
    app: tauri::AppHandle,
    state: tauri::State<'_, LicenseState>,
) -> Result<(), LicenseError> {
    let path = license_path(&app)?;
    if path.exists() {
        fs::remove_file(&path)?;
    }
    if let Ok(mut g) = state.0.lock() {
        *g = None;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edition_prefixes_map() {
        assert_eq!(
            edition_from_license_id("OS-NP-AAAA-BBBB-CCCC-DDDD"),
            "Nonprofit / Education Edition"
        );
        assert_eq!(
            edition_from_license_id("OS-SM-AAAA-BBBB-CCCC-DDDD"),
            "Small Organization Edition"
        );
        assert_eq!(
            edition_from_license_id("OS-MID-AAAA-BBBB-CCCC-DDDD"),
            "Mid Organization Edition"
        );
        assert_eq!(
            edition_from_license_id("OS-LG-AAAA-BBBB-CCCC-DDDD"),
            "Large Organization Edition"
        );
        assert_eq!(edition_from_license_id("WHATEVER"), "Public Edition");
        assert_eq!(edition_from_license_id(""), "Public Edition");
    }

    #[test]
    fn claims_id_prefers_license_id_over_sub() {
        let c = Claims {
            sub: Some("OS-SM-1111-2222-3333-4444".into()),
            license_id: Some("OS-LG-9999-9999-9999-9999".into()),
            jti: Some("OS-MID-AAAA-BBBB-CCCC-DDDD".into()),
            tier: None,
            customer_email: None,
            exp: 0,
        };
        assert_eq!(c.id(), Some("OS-LG-9999-9999-9999-9999"));
    }

    #[test]
    fn claims_id_falls_back_to_jti_before_sub() {
        let c = Claims {
            sub: Some("buyer@example.com".into()),
            license_id: None,
            jti: Some("OS-SM-1111-2222-3333-4444".into()),
            tier: Some("small".into()),
            customer_email: None,
            exp: 0,
        };
        assert_eq!(c.id(), Some("OS-SM-1111-2222-3333-4444"));
    }

    #[test]
    fn claims_id_falls_back_to_sub() {
        let c = Claims {
            sub: Some("OS-SM-1111-2222-3333-4444".into()),
            license_id: None,
            jti: None,
            tier: None,
            customer_email: None,
            exp: 0,
        };
        assert_eq!(c.id(), Some("OS-SM-1111-2222-3333-4444"));
    }

    #[test]
    fn tier_claim_maps_all_paddle_editions() {
        let cases = [
            ("nonprofit", "Nonprofit / Education Edition"),
            ("small", "Small Organization Edition"),
            ("mid", "Mid Organization Edition"),
            ("large", "Large Organization Edition"),
        ];
        for (tier, expected_edition) in cases {
            let info = claims_to_info(
                Claims {
                    sub: Some("buyer@example.com".into()),
                    license_id: None,
                    jti: Some("OS-SM-1111-2222-3333-4444".into()),
                    tier: Some(tier.into()),
                    customer_email: None,
                    exp: 42,
                },
                7,
            )
            .unwrap();
            assert_eq!(info.license_id, "OS-SM-1111-2222-3333-4444");
            assert_eq!(info.edition, expected_edition);
            assert_eq!(info.customer_email.as_deref(), Some("buyer@example.com"));
            assert_eq!(info.expires_at, 42);
            assert_eq!(info.activated_at, 7);
        }
    }

    #[test]
    fn tier_claim_wins_over_license_id_prefix() {
        let info = claims_to_info(
            Claims {
                sub: Some("buyer@example.com".into()),
                license_id: Some("OS-SM-1111-2222-3333-4444".into()),
                jti: None,
                tier: Some("large".into()),
                customer_email: None,
                exp: 42,
            },
            7,
        )
        .unwrap();
        assert_eq!(info.edition, "Large Organization Edition");
    }

    #[test]
    fn explicit_customer_email_wins_over_sub_email() {
        let info = claims_to_info(
            Claims {
                sub: Some("buyer@example.com".into()),
                license_id: Some("OS-SM-1111-2222-3333-4444".into()),
                jti: None,
                tier: Some("small".into()),
                customer_email: Some("billing@example.org".into()),
                exp: 42,
            },
            7,
        )
        .unwrap();
        assert_eq!(info.customer_email.as_deref(), Some("billing@example.org"));
    }

    #[test]
    fn optional_real_license_key_matches_generator_schema() {
        let Ok(path) = std::env::var("OPEN_SATCHEL_TEST_LICENSE_KEY") else {
            return;
        };
        let token = fs::read_to_string(path).unwrap();
        let claims = verify_token(token.trim()).unwrap();
        let info = claims_to_info(claims, 0).unwrap();
        if let Ok(expected) = std::env::var("OPEN_SATCHEL_EXPECT_LICENSE_ID") {
            assert_eq!(info.license_id, expected);
        }
        if let Ok(expected) = std::env::var("OPEN_SATCHEL_EXPECT_EDITION") {
            assert_eq!(info.edition, expected);
        }
        assert!(info.license_id.starts_with("OS-"));
        assert_ne!(info.edition, PUBLIC_EDITION);
    }
}
