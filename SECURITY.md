# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

Only the latest release receives security fixes. We do not back-port
patches to older minor versions.

## Reporting a vulnerability

**Do not open a public issue.** Security reports must stay private
until a fix ships.

1. Email **security@opensatchel.dev** with:
   - A description of the vulnerability and its impact.
   - Steps to reproduce, including any test PDF / fixture file.
   - The version (or commit SHA) you tested against.
2. You will receive an acknowledgement within **72 hours**.
3. We will provide a fix timeline within **7 calendar days** of triage.
4. Critical vulnerabilities (remote code execution, data exfiltration,
   signature bypass) are targeted for a patch within **14 calendar
   days**. Non-critical issues are scheduled for the next release.
5. Once the fix ships, we will credit you in the release notes (unless
   you prefer to remain anonymous).

## Scope

The following are in scope for security reports:

- The Open Satchel desktop application (Tauri shell + WebView frontend).
- The Rust PDF engine (`src-tauri/src/pdf_engine/`).
- Cryptographic operations: AES-256 encryption, RSA/ECDSA signing,
  PKCS#11 hardware-token integration, LTV embedding.
- Commercial license verification (Ed25519 JWT) — signature bypass or
  privilege escalation through forged tokens.

Out of scope:

- Third-party dependencies with their own security policies (pdfjs,
  pdf-lib, Tesseract.js, Fabric.js, lopdf, etc.). Report those
  upstream; we will update our pinned version once a fix is available.
- The marketing site or documentation content.
- Denial-of-service via malformed PDFs that cause high CPU / memory
  usage but no code execution — these are tracked as bugs, not
  security issues.

## Disclosure policy

We follow coordinated disclosure:

- Reporters may publish details **90 days** after the initial report,
  or once a fix is released, whichever comes first.
- We will not pursue legal action against researchers acting in good
  faith under this policy.
- We ask that you do not access, modify, or delete data belonging to
  other users during testing.

## Security architecture

Open Satchel is a local-first desktop app. The primary security
properties are:

- **No document-bearing network egress.** Network-capable paths are
  limited to signed update checks, first-run OCR model downloads, and
  opt-in RFC 3161 TSA timestamping / OCSP/CRL lookups during PDF
  signing. See [PRIVACY.md](PRIVACY.md) for the complete network table.
- **No telemetry or analytics.** The updater checks GitHub Releases for
  signed artifacts; it does not send documents, filenames, license
  data, user settings, or usage events.
- **No accounts or authentication server.** The app inherits the OS
  user identity.
- **Source available for audit.** Buyers can build from source and
  verify the binary matches the audited code.
- **AES-256 (PDF 2.0 R=6) encryption** for document protection.
- **PKCS#11 hardware-token signing** for non-exportable private keys.
- **True content-stream redaction** — redacted text is removed from
  the PDF, not painted over.

## Known limitations

See [docs/KNOWN-LIMITATIONS.md](docs/KNOWN-LIMITATIONS.md) for an
honest catalogue of current capability gaps, including AES-256
native R=5/R=6 decryption and CJK/RTL editing fidelity.

Known third-party dependency advisories are tracked in
[DEPENDENCY-RISK.md](DEPENDENCY-RISK.md), including accepted public-beta
risks for Fabric.js and SheetJS.

## PGP key

A signing key for security advisories will be published here once
release signing infrastructure is in place.
