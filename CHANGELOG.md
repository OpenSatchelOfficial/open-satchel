# Changelog

All notable user-visible changes to Open Satchel will be documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## Unreleased

## [0.5.2] - 2026-06-28

### Fixed

- **Update flow** - the in-app updater could download a new version but leave
  the app running the old one, with the toast stuck on "Installing..." when
  the installer handoff did not exit the app on its own. The updater now stages
  the download and shows a clear "Update downloaded - Restart to finish" prompt
  with a Restart button, so completing an update is always one click and never
  stalls silently. The app no longer restarts on its own, so an update can
  never close the app while you have unsaved work.

## [0.5.1] - 2026-06-28

### Fixed

- **App icon** - the Windows executable and taskbar icon was blank/generic on
  high-DPI displays because the bundled `.ico` carried only a single 32×32
  image. Regenerated the full icon set (16/24/32/48/64/256) from the brand
  mark so the icon renders crisply at every size. Same artwork, no design
  change. Existing 0.5.0 installs receive this via the auto-updater.

## [0.5.0] - 2026-06-27

Everything since the `0.1.x` public releases: a full document-integrity
hardening pass, an adversarial red/blue testing gauntlet, and the
accessibility + format-conformance work - folded into the public build.

### Redaction you can trust

- **Legal Guarantee** permanent redaction - marked pages flatten to a
  secured image so the underlying content is destroyed at the pixel
  level, and the result is verified by an independent render engine.
- Closed two redaction blind spots found by adversarial testing:
  **glyph-procedure** secrets (Type3 / Form-XObject / image-mask text)
  and **raw vector-graphics** secrets (paths drawn without a font or
  image) are now detected and removed, not merely covered. When a
  redaction overlaps that kind of content the affected page is
  rasterized so nothing recoverable survives.
- A redaction that removes nothing can no longer report success - the
  permanence check fails closed.
- Optional **metadata scrub** offered right after a redaction save
  (author, producer, title, dates, XMP).

### Accessibility (PDF/UA)

- **PDF/UA 9/9** - figures, links, and form fields pass PAC 2024 and
  veraPDF with zero errors.
- Tagged-PDF structure (headings, lists, tables, figures, links, form
  fields) is **preserved on edit-save** in the common cases instead of
  being flattened.

### Format conformance

- **Chinese → PDF/A-1b** (Simplified Chinese, TrueType): veraPDF-clean
  output with selectable text, backed by a bundled Noto Sans SC subset.

### Editing & engine

- True in-place text rewrite, per-selection rich-text formatting, and
  opt-in auto-layout reflow with a live preview (including cross-page
  and linked-block overflow).
- Font substitution / embedding and OCR-text editing, with an honest
  **degradation channel**: when a save can't be done losslessly the app
  records exactly what was approximated rather than failing silently.
- Certificate-based (public-key) PDF encryption now runs through a
  pure-Rust CMS envelope builder.
- pdfium is bundled (V8-free build) and binds with zero setup in the
  packaged app; cross-platform CI is green for the engine.

### Notes

- The auto-updater (signed updates via GitHub Releases, with in-app and
  About-dialog controls) from 0.1.1 is unchanged.
- The vector-graphics redaction safeguard rasterizes a page when a
  redaction overlaps vector content (charts, table borders,
  signatures) - that page loses selectable text. Use it knowingly.
- Tagged-PDF edit-save still flattens an element you directly edit, and
  CJK PDF/A is scoped to Simplified Chinese / TrueType. See
  [docs/KNOWN-LIMITATIONS.md](docs/KNOWN-LIMITATIONS.md).

## [0.1.1] - 2026-05-27

### Added

- In-app update controls in Preferences so users can manually check for,
  download, and install signed releases without leaving Open Satchel.
- Signed Tauri auto-updates via GitHub Releases, including startup
  update checks, an About-dialog manual update flow, updater artifact
  generation, and a release workflow that uploads `latest.json`.

## [0.1.0] - 2026-05-21

Initial public release of Open Satchel.

A local-first, no-paywall desktop file editor built on Tauri 2, Rust,
and React. PDF-focused for this release, with Word / Excel / PowerPoint
round-trips via the LibreOffice headless sidecar.

### Highlights

- **PDF editing** - text edits (inline and structural), paragraph
  reflow, image manipulation (move, scale, rotate, crop), page
  management (insert, delete, reorder, rotate), watermarks,
  headers / footers, page labels, and bookmarks.
- **Signing** - visible and invisible signatures with RFC 3161
  timestamps, PKCS#11 / smart-card / HSM support, /DocMDP certified
  signatures, and long-term validation (LTV) groundwork.
- **Redaction** - rasterized redactions, pattern-based search
  (SSN, credit card, custom regex), and an audit trail of removed
  text plus structure.
- **Forms** - fill, edit, design, and flatten AcroForms with a
  Unicode-aware fallback font.
- **OCR** - Tesseract.js on first use; languages download on demand.
- **Accessibility** - PDF/UA-1 tagging and reading-order tooling.
- **Compliance** - PDF/A-1b output and veraPDF-validated round-trips.
- **Security** - local-only by default. The only network calls are
  opt-in (TSA / OCSP during signing) or one-time (OCR language
  model download). See [PRIVACY.md](PRIVACY.md).
- **Commercial license activation** - offline Ed25519 JWT
  verification. Editions are feature-identical; the license only
  changes the displayed edition label and legal terms.

### Known limitations

See [docs/KNOWN-LIMITATIONS.md](docs/KNOWN-LIMITATIONS.md). Highlights:

- Unsigned installers - code signing is pre-1.0 work.
- AES-256 R=5/R=6 decryption currently uses a local `qpdf` fallback.
- Native Word / Excel / PowerPoint engines remain on the roadmap;
  today those formats round-trip via the LibreOffice sidecar
  (~60% fidelity vs MSO).
