# Open Satchel — Privacy & Security Statement

Last updated: 2026-05-24

Open Satchel is designed for privacy-conscious users and regulated
industries that cannot rely on cloud-based document editors. This
page documents every place the app touches the network, what data it
handles, and what auditing controls are available.

---

## 1. Headline

- **No telemetry.** The app has no analytics, crash-reporting service,
  feature-usage pings, or license-check server. It does make a signed
  update check to GitHub Releases so users can receive patched builds.
- **No accounts.** No sign-up, no login, no license-check server.
- **No cloud sync.** Your files stay on the device. "Cloud" file
  access is limited to folders your OS already mounts (Google Drive,
  OneDrive, Dropbox desktop clients) — those uploads are controlled
  by those apps, not Open Satchel.
- **AGPL source.** Source is published under AGPL-3.0-only so users and
  buyers can audit every network call, every read, and every write.
  Organizations that need non-AGPL terms, procurement terms, support,
  engine, SDK, OEM, or redistribution rights can license those separately.

---

## 2. Network calls the app makes

Open Satchel makes network calls **only** for the cases listed below.
Document content, filenames, license keys, and user settings are never
sent by these calls.

| # | When | To | Why | Data sent | Can be disabled? |
|---|---|---|---|---|---|
| 1 | RFC 3161 time-stamp during PDF signing | User-selected TSA URL (FreeTSA, DigiCert, Sectigo, Entrust, etc). | Embeds a trusted timestamp in a signature. | The TimeStampReq — a ~200-byte hash of the signature. No document content, no metadata. | Yes — uncheck "Add timestamp" in the Sign dialog. |
| 2 | OCSP / CRL lookup during LTV-enabled PDF signing | The OCSP responder named in the signing cert. | Long-Term Validation embeds cert revocation proof. | The cert serial number. No document content. | Yes — uncheck "Embed LTV data" in the Sign dialog. |
| 3 | Tesseract OCR trained-data download | `cdn.jsdelivr.net` | Downloads language model files (`eng.traineddata`, etc) on first OCR run per language. ~2-10 MB per language. Cached locally after the first download — never fetched again for that language. | An HTTP GET for the model file. No document content, no user data. | Yes — pre-place `.traineddata` files in the app data directory for air-gapped operation (see below). |
| 4 | Signed update check | `github.com` / `objects.githubusercontent.com` through the Open Satchel GitHub Releases feed | Checks whether a newer signed installer is available and downloads it only after the user chooses to install. | HTTPS GET metadata such as current app version, OS target, and CPU architecture. No document content, filenames, license data, or user settings. | Block GitHub Releases at the network layer, or build from source with the updater plugin/config removed. |

**Calls 1-2** (TSA and OCSP) are routed through the Tauri-native Rust
HTTP client (not the WebView's JS `fetch`) to a strict host allow-
list maintained in `src-tauri/src/commands/tsa.rs`. Any URL not on
the allow-list is rejected.

**Call 3** (Tesseract) is made by the `tesseract.js` library inside
the WebView. It only fires the first time you run OCR in a given
language and does not send any document content.

**Call 4** (updates) is handled by Tauri's updater plugin. Update
artifacts must verify against the public key embedded in
`src-tauri/tauri.conf.json`; a bad signature is rejected before install.

**No other code in the app makes network calls.** Any network
activity beyond the cases above is a bug — report it.

### Air-gapped OCR

For environments that cannot permit any outbound connection, place the
needed `.traineddata` files (available from the
[tessdata](https://github.com/tesseract-ocr/tessdata) repository) in
the app's data directory before first OCR use:

- **Windows:** `%APPDATA%\dev.opensatchel.desktop\tessdata\`
- **macOS:** `~/Library/Application Support/dev.opensatchel.desktop/tessdata/`
- **Linux:** `~/.config/dev.opensatchel.desktop/tessdata/`

When the files are already present, Tesseract.js skips the download
entirely.

---

## 3. What data Open Satchel handles

### Document content
Stays in RAM + your chosen save location. Never transmitted except
as described in Section 2 (and even then, only hashes — not content).

### User settings
- Recent files list
- Ribbon + toolbar preferences
- Custom stamps (PNG/JPEG imports)
- Font imports
- Guides/rulers layouts

All stored in:
- **Tauri (desktop)**: the OS config directory
  (`%APPDATA%\dev.opensatchel.desktop` on Windows,
  `~/.config/dev.opensatchel.desktop` on Linux,
  `~/Library/Application Support/dev.opensatchel.desktop` on macOS)
- **Browser mode** (localhost dev/test): `localStorage`

Nothing is uploaded. You can inspect, edit, or wipe the config dir
at any time.

### Clipboard
"Copy to clipboard" (extract text, copy annotation, etc) writes
directly to the OS clipboard. Open Satchel never reads your clipboard
without you invoking a paste action in the app.

### Files opened
The app records the full path in the recent-files list (locally,
visible on the start page). Clear it with the "Clear recent" action.
No file content or filename leaves the device.

---

## 4. Third-party dependencies

Every runtime dependency is vetted for network behavior. The table
below lists the full picture as of 2026-05-24.

| Dependency | Purpose | Network? | License |
|---|---|---|---|
| Tauri 2.x | App shell | Updater plugin checks GitHub Releases; other shell paths are local unless a feature listed in Section 2 is invoked | MIT / Apache-2.0 |
| React + Vite | UI framework + dev server | Dev-only; production bundles are static | MIT |
| pdf-lib | PDF read/write | No | MIT |
| pdfjs-dist | PDF rendering + text extraction | No | Apache-2.0 |
| Fabric.js | Canvas annotation overlay | No | MIT |
| Tesseract.js | OCR | Downloads trained-data `.traineddata` files from cdn.jsdelivr.net on first OCR run only. Cached locally after. | Apache-2.0 |
| zgapdfsigner (vendored) | PDF digital signing | Calls user-selected TSA / OCSP URLs (see Section 2) | MIT |
| node-forge | PKI, certs, PKCS#7 | No | BSD-3-Clause |
| docx | PDF → Word writer | No | MIT |
| xlsx | PDF → Excel writer | No | Apache-2.0 (Community edition) |
| pptxgenjs | PDF → PowerPoint writer | No | MIT |
| tauri-plugin-updater | Signed app updates | Checks GitHub Releases and downloads a signed installer after user approval | MIT / Apache-2.0 |
| tauri-plugin-process | Relaunch after update | No | MIT / Apache-2.0 |
| reqwest (Rust) | TSA + OCSP HTTP proxy and updater transport dependency | Yes, for the Section 2 flows only | MIT / Apache-2.0 |
| notify + notify-debouncer-full (Rust) | Hot-folder file watching | No | MIT / CC0 |

The runtime dependency set is commercially reviewable: most packages are MIT,
Apache-2.0, BSD, or OFL, and a few are dual-licensed packages where Open
Satchel relies on the permissive option. See `CREDITS.md`, the generated SBOM,
and the package/crate license files for the canonical notices.

**The routine off-device calls users should know about:** the updater
checks GitHub Releases for signed builds, and Tesseract.js pulls
language trained-data (`eng.traineddata`, etc) from `cdn.jsdelivr.net`
the first time you run OCR in a given language. OCR data is cached
afterwards. For fully air-gapped operation, pre-place the `.traineddata`
files in the app data directory and block GitHub Releases or build
without the updater.

---

## 5. Digital signatures

Signatures are cryptographically verifiable without any server.
- Self-signed (generated in-app) uses an ECDSA P-256 or RSA 2048
  private key held only in memory until you explicitly import a
  PKCS#12 bundle.
- P12 import reads the private key once, keeps it in memory, and
  erases it when the signing operation completes. It is never
  written to disk by Open Satchel.
- TSA timestamps are optional. If enabled, only the signature hash
  is sent to the TSA — not the document.
- Long-Term Validation embeds the OCSP response + cert chain in the
  PDF's `/DSS` dictionary so verification works offline forever.

---

## 6. Redaction

The "redact" tool performs true content-stream redaction — the text
under the redaction mark is removed from the PDF, not painted over.
Cross-check with the Audit Size dialog (Tools > Advanced > Audit
Size) to confirm redacted content streams are actually smaller.

---

## 7. Software supply chain

- **Code signing** is planned for pre-v1.0 launch (Windows
  Authenticode + macOS Developer ID). Until then, binaries are
  unsigned — buyers should compile from source or verify the
  published SHA-256 checksum against their own build.
- **Release checksums.** Each GitHub Release will include a
  `SHA256SUMS.txt` file listing the SHA-256 hash of every published
  artifact. Verify with `sha256sum -c SHA256SUMS.txt`.
- **SBOM per release.** A CycloneDX 1.5 SBOM (`sbom.cyclonedx.json`)
  is attached to each release for supply-chain auditing. See
  [docs/SBOM.md](docs/SBOM.md).
- Source is buildable from the tagged commit with the commands in
  `README.md`. Byte-for-byte reproducibility is not guaranteed across
  host toolchains yet; verify releases with the published SHA-256
  checksums and use `docs/REPRODUCIBLE-BUILD.md` for the audit recipe.
- Vendored dependencies (zgapdfsigner) live in `/vendor/` with
  unchanged upstream hashes for anyone who wants to verify the
  vendor copy matches the upstream npm tarball.

---

## 8. Content Security Policy

The WebView ships an explicit CSP in both `index.html` (dev) and
`src-tauri/tauri.conf.json` (production). Key properties:

- **No external domains.** `connect-src`, `style-src`, `font-src`,
  and `img-src` are all limited to `'self'` and data/blob URIs.
  No external CDN, analytics endpoint, or font host is whitelisted.
- **`'unsafe-inline'` (scripts + styles).** Required by Vite's
  bundled output, React's `style` prop (generates inline CSS), and
  Fabric.js (inline style attributes on canvas elements). These are
  WebView-internal — they do not open a network attack surface.
- **`'unsafe-eval'` (scripts).** Required by pdf.js (uses
  `Function()` for CMap and font parsing at runtime). Removing it
  breaks PDF rendering. This is a WebView-internal exception — no
  external code is eval'd.

These CSP exceptions are standard for Chromium-based WebView desktop
apps that bundle complex JS libraries. They do not grant network
access or weaken the air-gap posture documented in Section 2.

For procurement teams that require a CSP with no `unsafe-*`
directives: this would require upstream changes to pdf.js and
Fabric.js. We will track those upstream efforts and tighten the CSP
when possible.

---

## 9. Your rights & responsibilities

- You own everything the app produces.
- The software license applies to code; documents you create with
  the app are yours unconditionally.
- The app makes no attempt to phone-home, license-check, or remote-
  wipe.
- If you're deploying this in a regulated environment, the Audit
  Size + Sanitize dialogs + AGPL source availability should support
  typical security review requirements. A commercial license adds
  negotiated non-AGPL terms, procurement paperwork, support, and any
  engine/OEM embedding or redistribution rights stated in the agreement.

---

## 10. Reporting security issues

If you find a vulnerability, **please do not open a public issue**.
Email **security@opensatchel.dev**. See [SECURITY.md](SECURITY.md)
for the full disclosure policy, response timelines, and scope.

---

*This statement reflects the app as of the linked commit. If a
future version changes the network or data-handling behavior, this
file changes with it. Diff-friendly — check `git log PRIVACY.md`
for history.*
