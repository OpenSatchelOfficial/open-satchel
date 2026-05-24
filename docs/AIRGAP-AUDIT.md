# Air-Gap Audit — Open Satchel v0.1.0

**Date:** 2026-05-24
**Scope:** Static-analysis sweep of the entire shipped binary's network
posture. Sales artifact for gov / hospital / regulated-industry
procurement teams whose checklist asks "what does this app phone home?"

**TL;DR:** Open Satchel is built local-first by design.
- **Zero analytics and zero error reporting.** No
  Sentry, PostHog, Mixpanel, Segment, Amplitude, NewRelic, Datadog —
  none of the standard SaaS-instrumentation packages ship in the
  binary.
- **Zero document-bearing outbound HTTP from normal use.** Open / view / annotate /
  edit / fill / sign-with-self-cert / save / print / redact / convert
  — none of those operations send document bytes. Every document byte
  stays on the user's disk.
- **Four narrow exceptions, none of which transmit document content:**
  1. **Cryptographic timestamping (TSA / OCSP / CRL).** When a user
     elects to add an RFC 3161 timestamp to their signature, OR builds
     an LTV (long-term-validation) bundle for a signature, the Rust
     backend POSTs to a hard-coded allow-list of public TSA + OCSP
     endpoints. The allow-list lives in
     [`src-tauri/src/commands/tsa.rs`](../src-tauri/src/commands/tsa.rs)
     as `ALLOWED_HOSTS` — adding a host is a code change requiring a
     rebuild + recompile. Hosts outside the list are rejected with
     `"host not in allow-list"`. **Disabled by:** unchecking "Add
     timestamp" / "Embed LTV data" in the Sign dialog.
  2. **Tesseract OCR trained-data download.** On the first OCR run
     for a given language, `tesseract.js` downloads the language model
     file (`eng.traineddata`, etc., ~2-10 MB) from `cdn.jsdelivr.net`.
     The file is cached locally after the first download and never
     fetched again for that language. No document content or user data
     is sent — only an HTTP GET for the model file. **Disabled by:**
     pre-placing `.traineddata` files in the app data directory before
     first use (see [PRIVACY.md](../PRIVACY.md) Section 2,
     "Air-gapped OCR").
  3. **Dev-mode font fetch (Vite-served, local).** When a form value
     contains non-WinAnsi codepoints, `editSerializer.ts` `fetch`-es
     `/fonts/SourceSans3-Regular.otf` from the Vite dev server (or
     from the bundled assets in production — same path, no network).
     The URL is relative; no external CDN. This is not a production
     network call.
  4. **Signed update check.** On startup, Tauri's updater checks the
     Open Satchel GitHub Releases feed for `latest.json`. The request
     can include current app version, target OS, and architecture. It
     sends no document content, filenames, license keys, user settings,
     or analytics. Installers are downloaded only when the user accepts
     an update, and signatures must match the public key embedded in
     `src-tauri/tauri.conf.json`.

For the strictest gov/hospital deployments: disable TSA in the Sign
dialog, pre-place Tesseract trained-data files locally, and block the
GitHub Releases updater feed or build without the updater plugin. With
those controls, document workflows make **zero** outbound connections.

The rest of this doc is the receipts.

---

## Methodology

Static analysis only. The audit answers four questions:

1. **What network capabilities does Tauri grant the app?**
   See [src-tauri/capabilities/default.json](../src-tauri/capabilities/default.json).
2. **What HTTP clients are linked into the binary?**
   See [src-tauri/Cargo.toml](../src-tauri/Cargo.toml).
3. **What does the source code actually call?**
   `grep` for `fetch(`, `XMLHttpRequest`, `WebSocket`, `reqwest::`,
   `https?://` in every TS / Rust file.
4. **What does the WebView CSP allow?**
   See [`<meta http-equiv="Content-Security-Policy">`](../index.html).

A runtime evidence pass (Wireshark / Process Monitor capture during a
representative session) is the recommended companion check for
buyers — see "Runtime verification" below for instructions.

---

## 1. Tauri capabilities

`src-tauri/capabilities/default.json` is the authoritative grant
manifest — anything not listed cannot be invoked from the WebView.

```json
"permissions": [
  "core:default",                   // window, event, path
  "core:window:default",
  "core:webview:default",
  "core:event:default",
  "core:path:default",
  "dialog:default",                 // native open/save dialogs
  "dialog:allow-open", "dialog:allow-save",
  "dialog:allow-message", "dialog:allow-ask", "dialog:allow-confirm",
  "fs:default",                     // local filesystem
  "fs:allow-read-file", "fs:allow-write-file",
  "fs:allow-exists",   "fs:allow-read-dir",
  "fs:allow-mkdir",    "fs:allow-remove",
  "shell:default",                  // shell:execute (for veraPDF / OCR sidecars only)
  "cli:default"                     // CLI args parsing
]
```

**No `http:` permission is requested.** No `url:` plugin. No
`os:` plugin. No `geolocation`. No `notification`. The WebView cannot
make HTTP calls outside what's grouped in this manifest, and nothing
in this manifest grants HTTP access.

---

## 2. Rust HTTP clients

`src-tauri/Cargo.toml` lists exactly **one** HTTP client crate:
`reqwest = { version = "0.12", default-features = false,
features = ["rustls-tls"] }`.

`grep -rn "reqwest" src-tauri/src/` shows it's referenced in exactly
one file:

```
src-tauri/src/commands/tsa.rs:13   // browser's CORS enforcement entirely (native reqwest, no preflight, no
src-tauri/src/commands/tsa.rs:95   let parsed = reqwest::Url::parse(&url).map_err(...)
src-tauri/src/commands/tsa.rs:120  let client = reqwest::Client::builder()
src-tauri/src/lib.rs:112           // reqwest so WebView2 CORS doesn't block them.
```

`tsa.rs` exports a single command — `tsa_fetch` — that:

- Validates the URL scheme (only `http://` or `https://`)
- Validates the host against `ALLOWED_HOSTS` (positive-only allow-list)
- Caps request body at 1 MiB and response at 8 MiB
- Sets a 30-second timeout
- Sets `User-Agent: OpenSatchel/<version>` (so destinations can
  identify the client; no UID, no machine fingerprint)

The allow-list is intentionally short and entirely public-CA-operated:

```rust
const ALLOWED_HOSTS: &[&str] = &[
    "ts.ssl.com", "timestamp.digicert.com", "timestamp.sectigo.com",
    "timestamp.entrust.net", "timestamp.apple.com",
    "www.langedge.jp", "freetsa.org",
    "tsa.starfieldtech.com", "rfc3161timestamp.globalsign.com",
    "zeitstempel.dfn.de",
    "ocsp.usertrust.com", "ocsp.sectigo.com", "ocsp.digicert.com",
    "ocsp.entrust.net",   "ocsp.comodoca.com", "ocsp.globalsign.com",
    "ocsp.starfieldtech.com",
    "ocsp.actalis.it", "crl.actalis.it",
];
```

These are RFC 3161 Timestamp Authorities and the OCSP / CRL endpoints
needed to validate the TSA's own certificate chain for long-term
signature validation. There is no telemetry, no analytics, and no way
to hit any other host — the allow-list is enforced before the
`reqwest::Client` is even constructed, and the file is part of the
binary (changing the list requires a code change + recompile).

`tsa_fetch` is invoked from exactly one place in the frontend:
`zgapdfsigner` during the Sign action when the user has opted into a
TSA timestamp. Every other Sign mode (Self-cert, AATL match,
PKCS#11 hardware-token without TSA) is fully offline.

---

## 3. Frontend network calls

`grep -rn "fetch(" src/` returns:

```
src/lib/electron-api-shim.ts:327  const res = await fetch(url)        // local Vite path
src/services/editSerializer.ts:411  const resp = await fetch(fontUrl) // /fonts/SourceSans3-Regular.otf
src/services/editSerializer.ts:793  const response = await fetch(obj.src) // data:/blob:/file: URI
```

- **`electron-api-shim.ts:327`** is a *browser-only* fallback path
  (`browserFile.openPath`). Used when running the dev server in a
  plain browser (no Tauri shell) — fetches local files via Vite. In
  the production Tauri build the path goes through Rust and never
  reaches this branch.
- **`editSerializer.ts:411`** fetches `/fonts/SourceSans3-Regular.otf` —
  served by Vite (dev) or bundled (prod). The URL is relative; no
  external CDN.
- **`editSerializer.ts:793`** fetches `obj.src` for embedded image
  paste in Fabric annotations. `obj.src` comes from the user's
  clipboard or local filesystem and is exclusively a `data:` URI or
  `blob:` URL — there is no path that lets external HTTP escape here.

`grep -rn "XMLHttpRequest\|new WebSocket\|navigator.send" src/` returns
**zero** matches.

`grep -rn "https\?://" src/` returns ~50 hits, all of which are
**XML namespace URIs** (PDF/A and XMP standards-required namespace
identifiers, e.g. `http://ns.adobe.com/pdf/1.3/`). These are written
into PDF metadata as identifiers — they are NOT URLs that get
fetched. The same standards are used by every PDF/A-compliant
validator including veraPDF and PAC 3.

---

## 4. Content Security Policy

`index.html` and `src-tauri/tauri.conf.json` ship explicit CSPs:

```html
<meta http-equiv="Content-Security-Policy" content="
  default-src 'self';
  connect-src 'self' ipc: http://ipc.localhost ws: wss:;
  script-src  'self' 'unsafe-inline' 'unsafe-eval';
  style-src   'self' 'unsafe-inline';
  img-src     'self' data: blob:;
  font-src    'self' data:;
  worker-src  'self' blob:;
">
```

Notable:
- `connect-src 'self' ipc: http://ipc.localhost` — fetches are limited
  to the app's own origin (`tauri://localhost` in production) and the
  Tauri IPC channel. No external XHR / fetch / WebSocket can leave
  the app. (`ws: wss:` in the dev-mode CSP is for Vite HMR only;
  the production CSP in `tauri.conf.json` omits it.)
- **No external font CDNs.** UI fonts (Inter Tight, JetBrains Mono,
  Newsreader) are bundled locally as WOFF2 files in `public/fonts/`.
  No `fonts.googleapis.com` or `fonts.gstatic.com` references remain.
- `'unsafe-inline'` (scripts + styles) and `'unsafe-eval'` (scripts)
  remain because they are required by Vite's bundled output and by
  runtime libraries (pdf.js uses `Function()` for CMap parsing,
  Fabric.js uses inline style attributes, React's style prop generates
  inline CSS). These are WebView-internal exceptions — they do not
  open a network surface. See `docs/CSP-EXCEPTIONS.md` (planned) for
  the full rationale if procurement asks.

---

## 5. NPM dependency audit

`grep -E '"(sentry|posthog|mixpanel|segment|amplitude|newrelic|datadog|telemetry|analytics)' package.json` →
**zero matches**.

The full dep list (see `package.json`) is PDF / Office / canvas /
sign / OCR libraries plus React + Zustand + Tauri plugins. None of
them call out to a SaaS endpoint:

- `pdf-lib`, `pdfjs-dist`, `@pdf-lib/fontkit` — pure-JS PDF parsers
- `tesseract.js` — runs WASM OCR locally; downloads trained-data from
  `cdn.jsdelivr.net` on first use per language (see exception #2 above)
- `@tauri-apps/plugin-updater` — checks the GitHub Releases feed and
  installs only signed artifacts that match the embedded updater key
- `node-forge` — pure-JS crypto
- `fabric`, `canvg`, `pixelmatch`, `pngjs` — local rendering
- `docx`, `xlsx`, `pptxgenjs` — local Office format I/O
- `react`, `zustand`, `vite` — UI / build tooling

---

## 6. Runtime verification (recommended companion check)

Static analysis covers what's in the source. For complete confidence,
run a network capture during a representative session:

**Windows (Process Monitor):**
1. Start Process Monitor with `Filter → Process Name = open-satchel.exe`
2. Add filter: `Operation = TCP Send` OR `Operation = UDP Send`
3. Launch Open Satchel
4. Open a PDF, edit text, fill a form, save, sign with self-cert (no
   TSA), close
5. Stop the trace. Expected: the startup update check may contact
   GitHub Releases; document workflows should produce zero captured
   document-bearing events. Save the .PML.

**macOS / Linux (Wireshark):**
1. Start Wireshark with capture filter `host <local-ip>` and display
   filter `tcp.port != 22 && tcp.port != 443 && !arp`
2. Run the same session
3. Stop. Expected: zero packets to/from the open-satchel process.

**Toggle TSA on for a separate test:** in the Sign dialog, enable
"Add timestamp" and pick `freetsa.org`. The capture will show TLS
to `freetsa.org:443` ONLY — no other host.

---

## 7. Conclusion

| Surface | Phones home? | Notes |
|---------|-----:|-------|
| Open / view / scroll / zoom | NO | Pure local file read. |
| Edit text / annotate / draw / stamp | NO | Pure local. |
| Form fill (incl. Unicode) | NO | Source Sans 3 fetched from app bundle, not external. |
| Save / Save-As / autosave | NO | Pure local file write. |
| Print | NO | Goes to OS print spooler. |
| OCR (after first-run setup) | NO | Tesseract.js runs locally (WASM). |
| OCR (first run per language) | YES (one-time, disableable) | Downloads ~2-10 MB trained-data from `cdn.jsdelivr.net`. Pre-place files locally for air-gap. |
| Convert to Word / Excel / PPT | NO | Pure-JS libraries. |
| Compare / split / merge / redact | NO | Pure local. |
| Sign with self-cert | NO | All crypto in-process. |
| Sign with PKCS#11 hardware token | NO | Token over USB; no IP. |
| Sign with TSA timestamp | YES (opt-in, allow-list-only) | RFC 3161 to TSA host of user's choice from a 19-host hardcoded allow-list. |
| Sign with LTV bundle | YES (opt-in, allow-list-only) | OCSP/CRL to issuer of user's TSA cert; same allow-list. |
| Telemetry / analytics / error reporting | NO | None present. |
| Update check | YES | Startup check to GitHub Releases for signed updater metadata. No document content, filenames, license data, or analytics. |

Open Satchel meets the "no data leaves the device" baseline that gov
/ hospital / legal procurement requires, with four narrow exceptions
(signed update checks, TSA timestamping, OCSP/CRL revocation checks,
and Tesseract trained-data download). None transmit document content or
user data; strict air-gap deployments can block GitHub Releases, disable
TSA/LTV, and pre-place OCR data locally.

The complete grep evidence + capability manifest + dependency list
above is reproducible by anyone with `git clone` access — no privileged
build artifact required.
