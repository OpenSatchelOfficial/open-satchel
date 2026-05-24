# Credits

Open Satchel stands on the shoulders of a short list of third-party
libraries. Open Satchel's own code is licensed under AGPL-3.0-only, with
commercial licenses available for organizations that need non-AGPL terms. The
components below are licensed under their own terms and credited here.

## Vendored dependencies

### zgapdfsigner — © zboris12
- **Repo:** https://github.com/zboris12/zgapdfsigner
- **License:** MIT
- **Vendored at:** `vendor/zgapdfsigner/`
- **Used for:** PDF signature placeholder + incremental update
  assembly, TSA timestamp embedding, LTV /DSS, and AES-256 (R=5)
  object encryption.

  We extend zgapdfsigner's AES-256 R=5 output to the PDF 2.0 hardened
  R=6 revision on top — `src/services/pdfCryptoR6.ts` extracts the
  file-encryption key from zga's R=5 /UE, rehashes the password via
  ISO 32000-2 §7.6.4.3.3's "hash algorithm 2.B", and rewrites
  /U /O /UE /OE /R in the output /Encrypt dict. Object ciphertext is
  unchanged — AES-256-CBC is the same primitive in both revisions.

  Thank you zboris12 — zgapdfsigner's external-signer hook and
  certified-sig support are what made the hardware-token signing
  path (PKCS#11 / YubiKey / smart card) feasible without rewriting
  the whole sig ceremony. 👑

### cryptoki — Parsec / Project Everest
- **Repo:** https://github.com/parallaxsecond/rust-cryptoki
- **License:** Apache-2.0
- **Used for:** Safe Rust wrapper around any PKCS#11 v2.40 module
  (SoftHSM2, YubiKey, OpenSC, Thales, etc.) — powers the hardware-
  token signing path in `src-tauri/src/commands/pkcs11.rs`.

### SoftHSM2 — OpenDNSSEC / disig (Windows port)
- **Repo:** https://github.com/disig/SoftHSM2-for-Windows
- **License:** BSD-2-Clause
- **Not redistributed** — used in-tree for developer testing only
  (`tools/softhsm/`, gitignored). `scripts/test-pkcs11.mjs` downloads
  + configures it on first run.

### veraPDF — veraPDF Consortium
- **Repo:** https://github.com/veraPDF
- **License:** GPLv3 / MPLv2 dual
- **Not redistributed** — used as an external cross-validator at
  dev-time only (`tools/verapdf/`, gitignored). See
  `scripts/cross-validate.mjs`.

### PDFium — Google / Chromium project
- **Repo:** https://pdfium.googlesource.com/pdfium/
- **License:** BSD-3-Clause, with the PDFium/Chromium notice and patent
  grant terms carried by the upstream distribution.
- **Runtime binary:** installed locally by `scripts/install-pdfium.mjs`
  into `src-tauri/resources/pdfium/` from the pinned bblanchon PDFium
  release.
- **Used for:** native PDF page rendering and PNG rasterization through
  the Rust `pdfium-render` wrapper.
- **Release note:** if a release bundle includes a PDFium shared library,
  include the upstream PDFium/Chromium license notice beside that binary
  (for example, `LICENSES/pdfium.txt`).

## Typography

### Fraunces — Undercase Type
- **Designers:** Phaedra Charles, Flavia Zimbardi
- **Repo:** https://github.com/undercasetype/Fraunces
- **License:** SIL Open Font License 1.1 (OFL)
- **Used for:** The Open Satchel brand wordmark — variable axes set
  to optical size 144, soft 100, weight 500, title case, tracking
  −0.005em. Appears on the marketing site, app splash, About dialog,
  and brand assets (favicon, OG image, social cards).
- **License file:** ship `OFL.txt` from upstream alongside any
  bundled .woff2 / .ttf in `public/fonts/fraunces/`.

### Source Sans 3 — Adobe / Paul D. Hunt
- **Repo:** https://github.com/adobe-fonts/source-sans
- **License:** SIL Open Font License 1.1 (OFL)
- **Vendored at:** `public/fonts/SourceSans3-Regular.otf`
- **Used for:** PDF text-extraction fallback in the rendering pipeline.

### Noto Sans — The Noto Project Authors
- **Repo:** https://github.com/notofonts/noto-fonts
- **License:** SIL Open Font License 1.1 (OFL)
- **Vendored at:** `scripts/fonts/NotoSans-Regular.ttf`
- **Used for:** Embedded-font Rust test fixture.

### Runtime UI typography (bundled locally)

The app's UI fonts are bundled as WOFF2 files in `public/fonts/` for
air-gap compatibility and CSP compliance. No external font CDN is
contacted at runtime. The CSS fallback stack in `src/styles/global.css`
still includes system fonts for graceful degradation. All three are OFL.

- **Inter Tight** — primary UI/body, by Rasmus Andersson.
  https://github.com/rsms/inter
  Bundled at: `public/fonts/inter-tight/InterTight-latin.woff2`
- **JetBrains Mono** — monospace, by JetBrains.
  https://github.com/JetBrains/JetBrainsMono
  Bundled at: `public/fonts/jetbrains-mono/JetBrainsMono-latin.woff2`
- **Newsreader** — display serif, by Production Type for Google Fonts.
  https://github.com/productiontype/newsreader
  Bundled at: `public/fonts/newsreader/Newsreader-latin.woff2`

## NPM packages

Licenses as of 2026-04-20:

| Package | License |
|---|---|
| pdf-lib | MIT |
| @pdf-lib/fontkit | MIT |
| node-forge | BSD-3-Clause OR GPL-2.0 (we use BSD) |
| pako | MIT |
| fabric | MIT |
| pdfjs-dist | Apache-2.0 |
| tesseract.js | Apache-2.0 |
| xlsx | Apache-2.0 |
| docx, pptxgenjs | MIT |
| react, react-dom | MIT |
| @tauri-apps/* | Apache-2.0 OR MIT |
| jszip | MIT OR GPL-3.0-or-later |
| tsx, typescript | MIT / Apache-2.0 |
| uuid, zustand, vite | MIT |

All reviewed for compatibility with the current AGPL-3.0-only and commercial
dual-licensing direction. Some packages are dual-licensed; Open Satchel relies
on the permissive option where one is offered. See the per-package
`node_modules/*/LICENSE` files for the full terms.

## Standards + specs

- **PDF 1.7 + 2.0** — ISO 32000-1, ISO 32000-2. The specifications
  our output targets.
- **PDF/A-1b** — ISO 19005-1.
- **PDF/UA-1** — ISO 14289-1.
- **PKCS#7 / CMS** — RFC 5652, used in signature envelopes.
- **PKCS#11 v2.40** — OASIS, used for hardware-token signing.
- **RFC 3161** — time-stamp protocol (TSA).

## License

Open Satchel is licensed under AGPL-3.0-only by default (see `LICENSE`).
Commercial app, engine, OEM, white-label, and redistribution licenses are
available for organizations that need non-AGPL terms.
