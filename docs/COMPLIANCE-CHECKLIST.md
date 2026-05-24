# Compliance Checklist — Open Satchel v0.1.0

**Purpose:** Procurement-checklist artifact for gov / hospital /
regulated-industry buyers. Plain-English mapping of the standard
compliance frameworks to what Open Satchel actually does, what's
the customer's responsibility, and what we explicitly do NOT claim.

**Last updated:** 2026-05-24

> **Not legal advice.** This document is a technical mapping, not a
> compliance certification. We are not lawyers; you (the buyer) are
> the ultimate compliance owner for your deployment. We are happy to
> answer specific questions and produce additional artifacts on
> request.

---

## Architecture facts that drive every framework below

These are the shape facts that make most compliance work tractable:

1. **Local-first, single-tenant by definition.** Open Satchel is a
   desktop app installed on each user's machine. There is no SaaS
   tier, no shared cloud, no multi-tenant database. Every user
   operates in a tenant-of-one — their own machine.
2. **No document data leaves the device** during normal operation. See
   [AIRGAP-AUDIT.md](AIRGAP-AUDIT.md) for the static-analysis
   evidence. Network exceptions are signed update checks, opt-in RFC
   3161 TSA timestamping, OCSP/CRL revocation checks (allow-listed in
   source) when the user signs a document, and first-run OCR model
   downloads when a language model is not already local.
3. **No telemetry, no analytics, no license-check server.** The
   updater checks GitHub Releases for signed artifacts; it does not send
   documents, filenames, license keys, user settings, or analytics.
4. **Source is available for audit**, the binary is buildable from source by
   the buyer, and the build is reproducible. Auditors can confirm
   the shipping binary matches the audited source.
5. **No accounts, no logins, no email gate.** The app starts with
   "open a file." There is no identity surface to compromise.

---

## HIPAA (Health Insurance Portability and Accountability Act, US)

| Safeguard | What Open Satchel provides | Customer responsibility |
|-----------|----------------------------|-------------------------|
| §164.312(a) Access controls | Files inherit OS-level ACLs (NTFS / POSIX). The app does not bypass them. | Provision per-user OS accounts. Use an EDR/MDM that enforces device login. |
| §164.312(b) Audit controls | App writes to local file timestamps + the OS's own filesystem audit log. App-level audit log is **out of scope for v1** — see "Non-claims" below. | Use Windows Event Log / macOS unified log / Linux auditd at the OS layer. |
| §164.312(c) Integrity | Saves are byte-incremental (engine bake) for unsigned PDFs and signature-preserving for signed PDFs. AES-256 (PDF 2.0 R=6) encryption available. | Decide whether to enforce password protection at the policy layer. |
| §164.312(d) Authentication | OS user authentication. Optional PKCS#11 hardware token for signing. | Same as 312(a). |
| §164.312(e) Transmission security | **Not applicable in normal use** — Open Satchel doesn't transmit. When the user opts into a TSA timestamp, the request goes over TLS to an allow-listed timestamp authority. | If TSA is allowed in your deployment, you've already approved that endpoint as a third-party sub-processor. |
| §164.314(a) Business Associate Agreement | **Not required by default for local-only use** — in normal operation, Open Satchel runs entirely on the user's device and the vendor does not see, store, or transmit PHI. However, a BAA **may be required** if any future engagement gives the vendor access to PHI — for example through support channels that handle PHI-containing files, managed deployment services, cloud-hosted processing tiers, telemetry or diagnostics that could capture PHI, or any file-handling arrangement where the vendor touches protected data. | Confirm with your privacy officer whether your specific deployment scenario requires a BAA. For purely local, self-supported use, it typically does not. If your organization requires a BAA regardless of architecture, contact us to discuss terms. |
| §164.316 Documentation | This document + [AIRGAP-AUDIT.md](AIRGAP-AUDIT.md), [REPRODUCIBLE-BUILD.md](REPRODUCIBLE-BUILD.md), [SBOM.md](SBOM.md), [SECURITY.md](../SECURITY.md), and [PRIVACY.md](../PRIVACY.md). All shipped in the public source tree. | Retain copies with your HIPAA documentation set. |

**PHI handling in practice.** When a user opens a PDF containing
PHI in Open Satchel:
- The bytes are read from disk into the app's process memory.
- They stay in memory while the user edits.
- On save, they're written back to disk (or to a different file via
  Save-As) and the in-memory copy is reused for the active tab.
- On close, the in-memory copy is dropped.

There is no external transmission, no upload, no analytics sample
of the file content, no error report including the file content.
PHI in a PDF opened with Open Satchel never leaves the user's
machine.

---

## FedRAMP (Federal Risk and Authorization Management Program, US Gov)

FedRAMP authorizes cloud services, not desktop applications, so the
direct framework doesn't apply. But individual NIST 800-53 controls
are commonly cited in agency procurement requirements regardless.
Mapping the most-cited:

| Control | Status | Notes |
|---------|--------|-------|
| AC-3 Access Enforcement | Inherits OS | App relies on OS ACLs; no app-level access matrix to misconfigure. |
| AU-2 Audit Events | Partial | OS-level filesystem audit covers reads/writes. App-level audit is out of scope. |
| CM-2 Baseline Configuration | Met | Single binary, no runtime configuration server. The shipping bundle = the baseline. |
| CM-7 Least Functionality | Met | Network-capable paths are limited to signed updates, OCR model downloads, and signing validation/timestamp flows documented in PRIVACY.md. |
| CP-9 System Backup | Customer | Buyer's backup policy applies to user files. App is stateless across runs except for `recents` list. |
| IA-2 Identification & Authentication | Inherits OS | OS user identity is the app's identity. |
| RA-5 Vulnerability Scanning | Met | Source is public; CVE scans are reproducible by buyer. |
| SC-7 Boundary Protection | **Met by design** | App makes no document-bearing network calls. Update checks go to GitHub Releases; TSA/OCSP calls are opt-in and allow-listed. The app's network boundary is "the OS process." |
| SC-13 Cryptographic Protection | Met | AES-256 (R=6, PDF 2.0) for password encryption; RSA-2048 / RSA-3072 / RSA-4096 / EC-P256 / EC-P384 for signatures via PKCS#11. NIST-approved algorithms throughout. |
| SC-28 Protection of Information at Rest | Customer-configurable | App supports password-encrypting any saved PDF; the cipher is AES-256. Whether to enforce is a customer policy. |
| SI-7 Software, Firmware, & Information Integrity | Partial | Source is version-controlled with attributed commits; binary build is reproducible from source with SHA-256 checksums published per release. Code signing (Authenticode / Developer ID) is planned pre-v1.0. |

**Air-Gap deployments.** Open Satchel can be used in FedRAMP-style
air-gapped environments if outbound GitHub Releases access is blocked
or the updater is removed in a local build, TSA timestamping is disabled
at signing time, and OCR trained-data files are pre-placed locally.

---

## SOC 2 (Service Organization Control 2, AICPA)

SOC 2 audits a service organization's processing of customer data.
Same architecture argument as HIPAA — Open Satchel is a desktop
tool, not a service, and we don't process customer data. But buyers
in B2B procurement still ask the SOC 2 mapping. Trust Service
Criteria:

| TSC | Mapping |
|-----|---------|
| Security | OS-level + AES-256 PDF encryption + checksum-verifiable binary (code signing planned pre-v1.0). No SaaS attack surface because there's no SaaS. |
| Availability | Local app, no service uptime to track. Buyer provisions endpoints. |
| Processing Integrity | Save pipeline is incremental + signature-preserving. Data-loss guard rejects suspiciously-small output. PDF/A-1b output is designed for veraPDF validation. |
| Confidentiality | No data leaves the device. AES-256 password-encryption available. |
| Privacy | No personal data collection. No analytics. No accounts. |

**SOC 2 report.** We don't have one. SOC 2 attestation is for service
organizations; we'd be attesting to "the desktop binary doesn't do X"
which is the wrong shape of assertion. Equivalent evidence: the
public source tree + [AIRGAP-AUDIT.md](AIRGAP-AUDIT.md) + the
reproducible build.

---

## US state privacy laws

| Law | Jurisdiction | Mapping |
|-----|--------------|---------|
| CCPA / CPRA | California | We are not a "business" or "service provider" in the CCPA sense — we don't collect, sell, or share personal information. Buyers running Open Satchel may be the business; we don't process data on their behalf. |
| CDPA | Virginia | Same as CCPA. |
| CPA | Colorado | Same. |
| CTDPA | Connecticut | Same. |
| UCPA | Utah | Same. |
| BIPA (biometric) | Illinois | We don't collect biometric data. PKCS#11 hardware-token signing reads the token's *certificate*, not biometric template. |

**Data subject access requests.** Open Satchel doesn't store data
about identifiable users. We have nothing to disclose, delete, or
correct in response to a DSAR. The buyer's own use of Open Satchel
to handle PII / PHI is governed by their own DSAR process.

---

## EU / GDPR

We don't have EU presence and don't process personal data of EU
residents in the GDPR sense (no controller / processor relationship
with end users). The desktop app's local-only architecture means
personal data in PDFs opened with the app stays under the user's
control entirely.

For buyers operating in the EU, an Open Satchel deployment doesn't
add a sub-processor — the binary doesn't transmit data, so no DPA
with us is technically required (consult your DPO).

GDPR Articles relevant to the buyer's *use* of Open Satchel:
- Art. 5(1)(f) Integrity & confidentiality: AES-256 encryption available for sensitive files.
- Art. 32 Security of processing: hardware-token signing, redaction, and local-only processing.
- Art. 25 Data protection by design: local-first architecture maps to "data minimization" by default.

---

## License review (for buyer IT)

Open Satchel uses an AGPL-plus-commercial dual-license model:

- **AGPL-3.0-only** — anyone may use, study, modify, and redistribute
  Open Satchel under AGPL terms, including commercial users that can
  comply with AGPL obligations.
- **Commercial license** — for organizations that need non-AGPL terms,
  private modifications, proprietary embedding, procurement terms,
  support, signed builds, or negotiated deployment rights.
- **Engine / OEM license** — embedding, SDK, automation, white-label,
  redistribution, and product-building rights (separate from the app
  license).

**Common buyer questions:**

1. *"Do documents we create with Open Satchel become subject to the software license?"*
   No. The software license applies to the software. Documents you create or
   edit with Open Satchel remain entirely your IP under whatever license or
   confidentiality rules you choose.

2. *"Can we use the AGPL build for company documents?"*
   Yes, if your organization is comfortable with and complies with
   AGPL-3.0-only. Organizations that cannot accept AGPL obligations
   should use a commercial license.

3. *"Can we modify Open Satchel for internal workflows?"*
   Yes under AGPL terms, provided you comply with AGPL obligations. If
   you need private modifications without AGPL obligations, use a
   commercial license. Redistribution, hosted services, white-label builds,
   and embedding may require separate commercial engine/OEM rights.

4. *"Can we redistribute or white-label the app?"*
   Only under a written OEM/redistribution agreement.

5. *"What about the third-party libraries?"*
   The Cargo + npm dependency tree is reproducible from `Cargo.lock` and
   `package-lock.json`. Notable license footprint:
   - **pdfium**: BSD-3, dynamically loaded from the pinned local bundle path.
   - **SourceSans3-Regular.otf**: SIL Open Font License 1.1, fully
     redistributable. Used as Unicode-form-fill fallback when a form value
     contains non-WinAnsi codepoints.
   - **veraPDF binary** (test-time only, not in shipped binary): GPL-3.0.
     Buyer does not need this for runtime.
   - Most runtime dependencies: MIT / Apache-2 / BSD-3. See `package.json`,
     `src-tauri/Cargo.toml`, `CREDITS.md`, and the generated SBOM for the
     canonical list.

---

## Non-claims (things we explicitly do NOT assert)

In the interest of procurement honesty, we DON'T claim:

- **App-level audit log of every user action.** v1 doesn't write a
  per-action audit log. OS filesystem audit + the document's own
  history (signature trails) are the audit surfaces.
- **Multi-factor authentication for opening the app.** v1 inherits
  OS user identity only. PDFs themselves can be password-protected.
- **Forced password complexity / rotation policies.** Not enforced
  by the app — buyers can do this via OS group policy or via the
  password requirements they set on individual encrypted PDFs.
- **Centralized policy management / MDM integration.** Not in v1.
  Each install is independent. Buyers needing policy push can use
  Group Policy at the OS layer to deploy a config file.
- **Tamper-evident binary signing distributed by us.** Code signing
  (Windows Authenticode + macOS Developer ID) is planned for pre-v1.0.
  Until then, each GitHub Release includes a `SHA256SUMS.txt` for
  hash verification. Buyers can also compile from source and sign
  with their own internal CA for distribution.
- **"Compliant with" any specific standard certification.**
  Compliance is the buyer's deployment-specific assertion, not a
  vendor checkbox. We provide the architecture and evidence; the
  buyer's auditor maps to their framework.

---

## What to send your auditor

If your security team asks for our compliance package, send them:

1. This file (docs/COMPLIANCE-CHECKLIST.md)
2. [SECURITY.md](../SECURITY.md) — vulnerability disclosure policy and response SLAs
3. [PRIVACY.md](../PRIVACY.md) — complete network-call inventory and data-handling statement
4. [docs/ACCESSIBILITY.md](ACCESSIBILITY.md) — Section 508 / VPAT conformance status
5. [docs/SSDF-ATTESTATION.md](SSDF-ATTESTATION.md) — NIST SSDF practice mapping
6. [docs/SBOM.md](SBOM.md) — CycloneDX 1.5 SBOM generation and consumption guide
7. [docs/AIRGAP-AUDIT.md](AIRGAP-AUDIT.md) — static-analysis air-gap evidence
8. [LICENSE](../LICENSE) — AGPL-3.0-only terms
9. [COMMERCIAL-LICENSE.md](../COMMERCIAL-LICENSE.md) — commercial licensing overview
10. The link to the public source tree.

That covers the standard procurement intake for a desktop app. If
they need more, get in touch — most asks are something we can answer
in a follow-up Q&A doc.
