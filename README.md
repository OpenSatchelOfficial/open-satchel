# Open Satchel

**Local-first PDF editor. Free under AGPL. Commercial licenses available.**

Open Satchel is a local-first PDF editor for sensitive-file workflows:
editing, redaction, signing, forms, OCR, compression, and document
cleanup — without cloud uploads, accounts, telemetry, or subscription
lock-in. Word, Excel, PowerPoint, and other format support is planned
as the engine matures.

Open Satchel is dual-licensed: **AGPL-3.0-only** for the public source,
with a **commercial license** available for organizations that need
non-AGPL rights — proprietary embedding, OEM redistribution, private
modifications, signed builds, or formal procurement / support terms.

## Status

**Public Beta — May 2026.** First public release. PDF-focused. Active
development. Code-signed installers are pre-1.0 work in progress —
unsigned binaries will trigger Windows SmartScreen and macOS Gatekeeper
warnings on first run for now.

Known dependency advisories are tracked openly in
[DEPENDENCY-RISK.md](DEPENDENCY-RISK.md). The current public beta has
no known critical npm advisories after cleanup, but still carries high
advisories in Fabric.js and SheetJS that are documented there.

The previous Electron codebase (~93% Acrobat parity across 35+ formats)
is archived at
[JayQuan-McCleary/open-satchel-electron-archive](https://github.com/JayQuan-McCleary/open-satchel-electron-archive)
as reference material for the port.

## What works today

PDF editing, signing (including PKCS#11 / smart-card / HSM), redaction,
forms, OCR, compression, conversion (Word/Excel/PowerPoint via
LibreOffice headless sidecar), accessibility tooling (PDF/A-1b, PDF/UA-1,
veraPDF-validated), and document cleanup. See [docs/features.md](docs/features.md)
for the full feature list.

## What's missing (read this before filing an issue)

Honest known limitations live in [docs/KNOWN-LIMITATIONS.md](docs/KNOWN-LIMITATIONS.md).
The most-asked ones:

- **Code-signed installers:** in progress for 1.0. Until then,
  Windows / macOS show "unidentified developer" warnings on install.
- **AES-256 R=5/R=6 decrypt:** supported through a local `qpdf`
  fallback while the native Rust KDF remains in progress. If `qpdf`
  is missing, the app reports that clearly instead of silently failing.
- **Word / Excel / PowerPoint engines:** roadmap modules for v2.
  Today, those formats round-trip via the LibreOffice sidecar
  (~60% fidelity vs MSO). The native engines are separate modules.

## Roadmap

Other formats (DOCX, XLSX, PPTX, Markdown, CSV, JSON, HTML, images)
beyond round-trip-via-sidecar are planned for future milestones.
See [docs/KNOWN-LIMITATIONS.md](docs/KNOWN-LIMITATIONS.md) for the
current gap list.

## Stack

- **Frontend:** React 18 + TypeScript + Zustand + Vite
- **Shell:** Tauri 2 (Rust)
- **PDF engine:** PDFium rendering + Rust-native parsing/writing paths
- **Office engine (M6):** LibreOffice headless sidecar for DOCX/PPTX fidelity
- **Search (M7):** Tantivy full-text index

## Build & dev

```bash
npm install              # also fetches the pdfium shared library
npm run tauri:dev
```

`npm install` runs `scripts/install-pdfium.mjs` automatically (via
`postinstall`) to download the platform-correct pdfium binary into
`src-tauri/resources/pdfium/`. Tauri bundles it into the released app,
so end users get a working binary out of the box without a separate
install step. To re-download or refresh, run `npm run install-pdfium`.

Release builds use Tauri's signed updater artifacts. See
[docs/UPDATER.md](docs/UPDATER.md) for the GitHub Releases feed,
signing-key handling, and release checklist.

## Licensing

Open Satchel is dual-licensed:

- **AGPL-3.0-only** — the default. Anyone may use, study, modify, and
  redistribute Open Satchel under the terms of the GNU Affero General
  Public License v3.0. Personal, research, hobby, academic, and
  AGPL-compliant internal company use is fully covered. See
  [LICENSE](./LICENSE).

- **Commercial license** — available for organizations that cannot
  comply with AGPL or need additional rights: proprietary embedding,
  closed-source OEM redistribution, private modifications without
  releasing source, signed release builds, or formal procurement
  paperwork / support / SLA terms. See [COMMERCIAL-LICENSE.md](./COMMERCIAL-LICENSE.md)
  or contact `licensing@opensatchel.dev`.

The same source code is offered under both licenses — buyers choose
which terms fit their use. Final commercial terms are documented in a
signed agreement before any commercial rights take effect.

## Credits

Open Satchel's AES-256 password encryption, RFC 3161 timestamp integration, and /DocMDP certified signatures are powered by **[zgapdfsigner](https://github.com/zboris12/zgapdfsigner)** by [zboris12](https://github.com/zboris12) — MIT licensed, vendored at `vendor/zgapdfsigner/` with provenance notes in [ATTRIBUTION.md](./vendor/zgapdfsigner/ATTRIBUTION.md). If you use Open Satchel's signing or encryption features, please star the upstream repo.

Also building on: [pdf-lib](https://pdf-lib.js.org/), [pdf.js](https://mozilla.github.io/pdf.js/), [Fabric.js](http://fabricjs.com/), [Tesseract.js](https://tesseract.projectnaptha.com/), [node-forge](https://github.com/digitalbazaar/forge), and the Typst team's pure-Rust [subsetter](https://github.com/typst/subsetter) crate for CJK/Arabic font subsetting.

## Ethos

No email gate. No cloud sync. No telemetry. No AI API dependencies. All
document processing is local. Network activity is limited to signed
update checks, opt-in timestamp/OCSP calls during signing, and one-time
OCR language model downloads. See [PRIVACY.md](PRIVACY.md) for the
complete network inventory.
