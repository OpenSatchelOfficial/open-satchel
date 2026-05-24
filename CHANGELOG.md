# Changelog

All notable user-visible changes to Open Satchel will be documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- Signed Tauri auto-updates via GitHub Releases, including startup
  update checks, an About-dialog manual update flow, updater artifact
  generation, and a release workflow that uploads `latest.json`.

## [0.1.0] — 2026-05-21

Initial public release of Open Satchel.

A local-first, no-paywall desktop file editor built on Tauri 2, Rust,
and React. PDF-focused for this release, with Word / Excel / PowerPoint
round-trips via the LibreOffice headless sidecar.

### Highlights

- **PDF editing** — text edits (inline and structural), paragraph
  reflow, image manipulation (move, scale, rotate, crop), page
  management (insert, delete, reorder, rotate), watermarks,
  headers / footers, page labels, and bookmarks.
- **Signing** — visible and invisible signatures with RFC 3161
  timestamps, PKCS#11 / smart-card / HSM support, /DocMDP certified
  signatures, and long-term validation (LTV) groundwork.
- **Redaction** — rasterized redactions, pattern-based search
  (SSN, credit card, custom regex), and an audit trail of removed
  text plus structure.
- **Forms** — fill, edit, design, and flatten AcroForms with a
  Unicode-aware fallback font.
- **OCR** — Tesseract.js on first use; languages download on demand.
- **Accessibility** — PDF/UA-1 tagging and reading-order tooling.
- **Compliance** — PDF/A-1b output and veraPDF-validated round-trips.
- **Security** — local-only by default. The only network calls are
  opt-in (TSA / OCSP during signing) or one-time (OCR language
  model download). See [PRIVACY.md](PRIVACY.md).
- **Commercial license activation** — offline Ed25519 JWT
  verification. Editions are feature-identical; the license only
  changes the displayed edition label and legal terms.

### Known limitations

See [docs/KNOWN-LIMITATIONS.md](docs/KNOWN-LIMITATIONS.md). Highlights:

- Unsigned installers — code signing is pre-1.0 work.
- AES-256 R=5/R=6 decryption currently uses a local `qpdf` fallback.
- Native Word / Excel / PowerPoint engines remain on the roadmap;
  today those formats round-trip via the LibreOffice sidecar
  (~60% fidelity vs MSO).
