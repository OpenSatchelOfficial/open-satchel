// HTTP proxy for RFC 3161 TSA + OCSP/CRL fetches.
//
// WHY THIS EXISTS
//
// zgapdfsigner does TSA timestamps + LTV via plain browser fetch(). Public
// TSA endpoints (FreeTSA, DigiCert, Sectigo, Entrust, SSL.com, LangEdge,
// Apple) and OCSP/CRL responders almost never send CORS headers — they're
// server-to-server interfaces, not browser-to-server. When the WebView2
// frontend (Chromium-based) tries to POST to them, the preflight +
// same-origin check blocks with "Failed to fetch".
//
// Routing those specific requests through this Rust command sidesteps the
// browser's CORS enforcement entirely (native reqwest, no preflight, no
// cross-origin policy). Response bytes come back to zga as a Uint8Array,
// identical shape to what fetch() would have returned.
//
// SECURITY
//
// Arbitrary-URL HTTP proxies are a known footgun (SSRF → internal scans,
// metadata-service reads, etc.). To keep the attack surface tight:
//
//   - URL scheme must be http or https.
//   - Host must match one of the TSA/OCSP endpoints we actually need, or
//     the user's explicitly-configured custom TSA. Nothing else reaches
//     the network via this command.
//   - Method is POST-only (all TSA + OCSP are POST; GET not needed).
//   - Body is capped at 1 MiB (real TSA requests are ~200 bytes; 1 MiB
//     leaves slack for OCSP requests which can be a few KB).
//   - Response is capped at 8 MiB (TSA tokens are 5-12 KB, OCSP responses
//     up to a few KB; 8 MiB is generous).
//   - Timeout is 30 seconds.
//
// The allow-list matches the TSA URLs zgapdfsigner hard-codes in its
// Signer dropdown (Zga.TSAURLS). When the user wires a custom TSA in the
// UI, the host must match one of these — custom per-host allow is not
// supported here to keep the security reasoning simple.

use std::collections::HashMap;
use std::time::Duration;

/// TSA + OCSP hosts that are explicitly allowed for outbound POST.
/// Matches the set zgapdfsigner ships in its Signer dropdown + common
/// OCSP responders used by public CAs.
///
/// Adding a host means: `open-satchel.exe` will POST arbitrary payloads
/// to that host on user action. Think before expanding.
const ALLOWED_HOSTS: &[&str] = &[
    // TSA endpoints — zga's Zga.TSAURLS
    "ts.ssl.com",
    "timestamp.digicert.com",
    "timestamp.sectigo.com",
    "timestamp.entrust.net",
    "timestamp.apple.com",
    "www.langedge.jp",
    "freetsa.org",
    // Additional TSA endpoints users commonly wire via the "custom TSA"
    // field. Each is a well-known public TSA operated by a CA.
    "tsa.starfieldtech.com",
    "rfc3161timestamp.globalsign.com",
    "zeitstempel.dfn.de",
    // OCSP responders for the trust-chain validation step in LTV.
    // Each name maps to one of the above TSAs' issuing CA.
    "ocsp.usertrust.com",
    "ocsp.sectigo.com",
    "ocsp.digicert.com",
    "ocsp.entrust.net",
    "ocsp.comodoca.com",
    "ocsp.globalsign.com",
    "ocsp.starfieldtech.com",
    // Actalis — free email/S/MIME cert issuer (commonly used as an
    // LTV test cert because they issue in minutes with just an email).
    "ocsp.actalis.it",
    "crl.actalis.it",
];

const MAX_BODY_BYTES: usize = 1024 * 1024; // 1 MiB
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024; // 8 MiB
const TIMEOUT_SECS: u64 = 30;

/// POST to an allow-listed TSA / OCSP endpoint and return the raw response
/// bytes. Invoked from the frontend (via `@tauri-apps/api/core` invoke) when
/// zgapdfsigner needs to sign with a TSA timestamp or build an LTV bundle.
///
/// Returns an `Err(String)` describing the failure on any of: URL parse,
/// disallowed host/scheme, body too large, HTTP error status, response
/// too large, or network timeout. Zga's caller surfaces this as "TSA
/// failed: <message>" in the sign dialog.
#[tauri::command]
pub async fn tsa_fetch(
    url: String,
    body: Vec<u8>,
    headers: Option<HashMap<String, String>>,
) -> std::result::Result<Vec<u8>, String> {
    // 1. Validate URL scheme + host against the allow-list.
    let parsed = reqwest::Url::parse(&url).map_err(|e| format!("invalid URL: {e}"))?;
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(format!("scheme must be http or https, got {scheme}"));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "URL has no host".to_string())?;
    if !ALLOWED_HOSTS.iter().any(|allowed| *allowed == host) {
        return Err(format!(
            "host not in allow-list: {host}. Allowed: {}",
            ALLOWED_HOSTS.join(", ")
        ));
    }

    // 2. Validate payload size.
    if body.len() > MAX_BODY_BYTES {
        return Err(format!(
            "request body too large: {} bytes > {} limit",
            body.len(),
            MAX_BODY_BYTES
        ));
    }

    // 3. Build the request. Default headers for TSA timestamping per RFC 3161
    //    are Content-Type: application/timestamp-query; Accept may be set by
    //    the caller if needed.
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(TIMEOUT_SECS))
        .user_agent(format!("OpenSatchel/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("failed to build HTTP client: {e}"))?;

    let mut req = client.post(parsed).body(body);
    // Set Content-Type defaulting to TSA's content-type if not provided.
    // Zga passes "Content-Type: application/timestamp-query" explicitly for
    // TSA; for OCSP it passes "application/ocsp-request". Honor whatever
    // the caller sent.
    let mut had_content_type = false;
    if let Some(headers) = headers {
        for (k, v) in headers {
            if k.eq_ignore_ascii_case("content-type") {
                had_content_type = true;
            }
            req = req.header(&k, &v);
        }
    }
    if !had_content_type {
        req = req.header("Content-Type", "application/timestamp-query");
    }

    // 4. Fire.
    let resp = req
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        let snippet = text.chars().take(500).collect::<String>();
        return Err(format!("HTTP {}: {}", status.as_u16(), snippet));
    }

    // 5. Read with size cap. We use bytes() (no streaming) since responses
    //    are small; the cap check on the resulting Vec is enough.
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("failed to read response: {e}"))?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(format!(
            "response too large: {} bytes > {} limit",
            bytes.len(),
            MAX_RESPONSE_BYTES
        ));
    }
    Ok(bytes.to_vec())
}
