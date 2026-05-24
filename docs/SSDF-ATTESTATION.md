# NIST SSDF Attestation Notes

**Product:** Open Satchel v0.1.x
**Framework:** NIST Secure Software Development Framework (SSDF) v1.1
(SP 800-218)
**Last updated:** 2026-05-24

> This document maps Open Satchel's development practices to the NIST
> SSDF practice groups. It is a self-attestation for procurement review,
> not a third-party certification. EO 14028 (Improving the Nation's
> Cybersecurity) requires SSDF attestation for software sold to US
> federal agencies; this document supports that requirement.

---

## PO — Prepare the Organization

| Practice | ID | Status | Evidence |
|----------|----|--------|----------|
| Define security requirements | PO.1 | Met | Local-first architecture eliminates most network-facing attack surface. Security requirements documented in [SECURITY.md](../SECURITY.md) and [PRIVACY.md](../PRIVACY.md). |
| Maintain secure environments | PO.3 | Met | Development uses pinned dependency versions (`package-lock.json`, `Cargo.lock`). CI builds from locked dependencies only. |
| Define criteria for checks | PO.4 | Met | Four static verification gates (`npm run verify`): TypeScript strict-mode, Vite production build, Cargo library build, SBOM generation. All must pass before merge. |

---

## PS — Protect the Software

| Practice | ID | Status | Evidence |
|----------|----|--------|----------|
| Protect code from unauthorized access | PS.1 | Met | Source hosted on GitHub with branch protection on `main`. Commits are attributed to verified accounts. |
| Provide SBOM | PS.4 | Met | CycloneDX 1.5 SBOM generated via `npm run sbom`. Covers ~507 npm + ~598 Cargo components with PURL identifiers and integrity hashes. See [docs/SBOM.md](SBOM.md). |
| Archive and protect releases | PS.5 | Partial | Release binaries are published as GitHub Releases with signed Tauri updater artifacts and checksums. OS-level code signing is planned but not yet in place. |
| Secure the build | PS.6 | Met | Reproducible build from tagged source. Build commands documented in README.md. Vendored dependencies in `/vendor/` with upstream hash verification. |

---

## PW — Produce Well-Secured Software

| Practice | ID | Status | Evidence |
|----------|----|--------|----------|
| Design to meet security requirements | PW.1 | Met | Local-first architecture: no telemetry, no accounts, no cloud sync. Network calls limited to signed update checks, OCR model downloads, and opt-in TSA/OCSP with allow-listed endpoints. |
| Review designs for compliance | PW.2 | Met | Compliance posture documented in [COMPLIANCE-CHECKLIST.md](COMPLIANCE-CHECKLIST.md) covering HIPAA, FedRAMP controls, SOC 2, GDPR, and US state privacy laws. |
| Reuse secure components | PW.4 | Met | Cryptographic operations use vetted libraries: `node-forge` (BSD-3), `cryptoki` (Apache-2.0), AES-256 via `aes` crate. No hand-rolled crypto primitives. |
| Configure defaults securely | PW.9 | Met | The updater accepts only signed artifacts matching the embedded public key. TSA timestamping and OCSP are opt-in per signing operation. CSP headers restrict WebView capabilities. |
| Verify third-party components | PW.13 | Met | All runtime dependencies reviewed for network behavior (see [PRIVACY.md](../PRIVACY.md) Section 4). License audit in [CREDITS.md](../CREDITS.md). |

---

## RV — Respond to Vulnerabilities

| Practice | ID | Status | Evidence |
|----------|----|--------|----------|
| Identify and confirm vulnerabilities | RV.1 | Met | Vulnerability reports accepted at security@opensatchel.dev with 72-hour acknowledgement SLA. See [SECURITY.md](../SECURITY.md). |
| Assess and prioritize | RV.2 | Met | Critical vulnerabilities (RCE, data exfiltration, signature bypass) targeted for 14-day fix. Non-critical scheduled for next release. |
| Remediate | RV.3 | Met | Fixes shipped as patch releases. Affected versions documented in SECURITY.md supported-versions table. |
| Disclose vulnerabilities | RV.4 | Partial | Coordinated disclosure policy in SECURITY.md (90-day window). No formal CVE assignment process yet; will adopt for v1.0 stable. |

---

## Dependency and supply chain practices

| Area | Current state |
|------|---------------|
| **Lockfiles** | `package-lock.json` and `Cargo.lock` are committed and enforced (`npm ci` for installs). |
| **Integrity verification** | npm lockfile carries SHA-512 hashes per package. Cargo lockfile carries checksums. |
| **SBOM** | CycloneDX 1.5, attached to releases. See [SBOM.md](SBOM.md). |
| **Vulnerability scanning** | SBOM is consumable by Dependency-Track, Snyk, FOSSA for CVE matching. `cargo audit` and `npm audit` are available for manual runs; CI automation of these checks is planned. |
| **Vendored code** | `vendor/zgapdfsigner/` — upstream hash verified, attribution in `ATTRIBUTION.md`. |
| **License compliance** | All runtime deps are permissive (MIT, Apache-2.0, BSD-3). No copyleft in the shipped binary. veraPDF (GPL-3.0) is dev-time only. |

---

## Build and release process

1. Developer works on a feature branch.
2. Static gates run before merge: TypeScript check (`npx tsc --noEmit`),
   Vite production build (`npx vite build`), Rust check
   (`cargo check`), and Rust lib tests (`cargo test --lib`).
3. Feature-specific drivers exercise the live app for end-to-end
   verification before release.
4. Merge to `main` via pull request.
5. Release: tag, build, generate SBOM, publish SHA-256 checksums
   alongside the binary. (Code signing planned for pre-v1.0; see
   [SECURITY.md](../SECURITY.md).)

---

## Gaps and planned improvements

| Gap | Plan |
|-----|------|
| Code signing not yet in place | Planned pre-v1.0. Will use a code-signing certificate for Windows (Authenticode) and macOS (Developer ID). |
| No formal CVE assignment process | Will adopt for v1.0 stable, with a CNA or via MITRE's CVE request form. |
| Cargo license data not in SBOM | SBOM generator does not yet populate license fields for Cargo dependencies. Planned: bundle a license-cache regenerated quarterly. |
| No automated vulnerability scan in CI | Planned: `cargo audit` + `npm audit` as CI gates. |

---

*This attestation covers the development practices as of the listed
date. It is maintained in the source tree and versioned alongside the
code. Check `git log docs/SSDF-ATTESTATION.md` for history.*
