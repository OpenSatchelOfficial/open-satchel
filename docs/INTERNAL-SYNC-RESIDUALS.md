# Internal → Public 0.5.0 feature sync — what landed, and the honest residuals

This document records the sync that brought the public repo
(`OpenSatchelOfficial/open-satchel`, frozen at 0.1.1) up to the internal
development build's **0.5.0** product feature set. It is a curated sync,
not a flat copy: product code was ported, the public-only auto-updater +
docs + branding were preserved, and the internal dev/test infrastructure
was deliberately left out.

Done as a sequence of building, committed phases. Neither repo was pushed.

## What landed

**Rust backend (`sync(rust)`)**
- Converted the repo to a cargo **workspace** and vendored
  `crates/satchel-core` — the UI-independent document core that provides
  the RustCrypto **CMS envelope** builder (certificate-based encryption)
  and the **fallback/degradation channel** the engine records through.
- Synced `src-tauri/src/` (engine, verify, cert-encrypt, font, pdf, live,
  `pdf_engine/*`) with the 0.5.0 commands: redaction-permanence probes
  (`pdf_probe_glyph_procedures`, `pdf_probe_region_fill`,
  `pdf_redaction_permanence_check`), `cms_wrap_recipient`,
  `pdfa_get_cjk_substitute`, `font_coverage`, `pdf_open_health`,
  `pdf_extract_font_payload`. New files `commands/aes256_decrypt.rs`,
  `core_io.rs`, `bin/extract_pdf_text.rs`.
- Bundled the CJK subset font (`vendor/fonts/NotoSansSC-Subset.ttf` +
  its OFL license) for the Chinese PDF/A path.
- `lib.rs` was **merged**: internal's command registrations grafted onto
  the preserved public-only updater + process plugins and the
  commercial-license module.

**Frontend (`sync(frontend)`)**
- Synced 203 `src/` files (services, components, stores, formats, lib,
  hooks, styles), excluding the MCP test bridge `src/test-hooks/`.
- New redaction / layout / print / degradation services and the
  `ConfirmModal` + `RedactionMarkTool` components landed; the new
  redaction / metadata-scrub / legal-guarantee toggles are surfaced via
  `StatusBar.tsx`.
- `vite.config.ts` adopted the internal's `serveTesseractAssets` (OCR
  worker/core/lang) and `serveVendorAssets` (the vendored zgapdfsigner
  UMD bundle) plugins, which serve in dev **and copy into `dist/`**.
- `vendor/zgapdfsigner/dist/zgapdfsigner.min.js` was added (it was
  missing in the public — the cause of the historical "packaged build
  can't encrypt" gap).

**Config (`sync(config)`)**
- `package.json` / `tauri.conf.json` / `Cargo.toml` bumped to **0.5.0**;
  CSP gained `frame-src 'self' blob:` for the blob-iframe print path;
  `@tesseract.js-data/{eng,osd}` added.

## What was preserved (public-only — untouched or merged in)

- **The auto-updater, in full:** `services/appUpdater.ts`,
  `components/UpdateNoticeToast.tsx`, the `tauri-plugin-updater` /
  `tauri-plugin-process` crates + npm plugins, the
  `tauri.conf.json` `updater` block (pubkey + GitHub-release endpoints +
  passive install), `bundle.createUpdaterArtifacts`, and
  `capabilities/default.json`'s `updater:default` / `process:default`.
- **The commercial-license module** (`license.rs` + the
  `license_activate/status/deactivate` commands + `LicenseState`).
- The `dev.opensatchel.desktop` identifier, the `resources/pdfium/*`
  bundling, and all public docs / `.github` / branding.

## What was excluded (internal dev/process infra — must never reach public)

`src/test-hooks/`, `tools/test-mcp/`, `.test-mcp/`, the internal test
corpus (`test-pdfs/`, `test-runs/`, `test-files/`), `CLAUDE.md` /
`AGENTS.md` / `memory/`, the planning docs, the orchestrator
(`scripts/hardening-overnight/`), and the internal ledger
(`docs/VERIFICATION.md`). **Verified: the test bridge
(`startTestHookServer` / `test-hooks` / `.test-mcp` markers) is absent
from `dist/`.**

## Honest residuals

1. **`AboutDialog.tsx` and `PreferencesFlyout.tsx` were intentionally
   NOT taken from internal.** The public versions are supersets — they
   carry the full license + auto-updater UI that the internal's older,
   simpler variants lack. Internal's only differences there were a stale
   hardcoded `v0.1.0` and a style tweak, so there was nothing to port.

2. **`@signpdf/*` was not carried over.** The internal lists three
   `@signpdf` packages but no source imports them — signing runs through
   the vendored `zgapdfsigner`. They were skipped to avoid dead deps and
   SBOM noise. If a signing path is later found to need `@signpdf`, add
   it back.

3. **Test/dev-only devDeps were not carried:** `@playwright/test`,
   `pixelmatch`, `pngjs`, `tsx`, `@types/uuid`. They serve the internal
   test corpus, which is excluded.

4. **The `serveTestPdfs` vite dev plugin was dropped** (it serves the
   internal test corpus, which the public doesn't have).

5. **Tauri core was bumped 2.10 → 2.11 on the npm side.** The fresh
   workspace Cargo.lock resolved the Rust `tauri` crate to 2.11.3, so
   `@tauri-apps/api` + `@tauri-apps/cli` were bumped to 2.11 to satisfy
   tauri-build's major/minor match check. The updater plugin stack
   (2.10.x) remains and is compatible.

6. **pdfium binding kept the public's approach.** The synced `render.rs`
   probes the exe dir, but the public continues to bundle pdfium via
   `bundle.resources` (`resources/pdfium/*`) and point
   `PDFIUM_DYNAMIC_LIB_PATH` at the resource dir from `lib.rs` — the
   exe-dir probe is a belt-and-suspenders fallback.

7. **`docs/KNOWN-LIMITATIONS.md` was not comprehensively refreshed.** It
   still reflects the 0.1.x baseline. The new 0.5.0 limitations
   (vector-graphics redaction rasterizes a page; tagged-PDF edit-save
   flattens a directly-edited element; CJK PDF/A is scoped to Simplified
   Chinese / TrueType) are summarized in the `CHANGELOG.md` `[0.5.0]`
   "Notes" section. Owner may want to fold these into KNOWN-LIMITATIONS.

   Likewise, the compliance/audit docs (`DEPENDENCY-RISK.md`,
   `docs/AIRGAP-AUDIT.md`, `docs/COMPLIANCE-CHECKLIST.md`, `docs/SBOM.md`)
   still carry their `v0.1.0` "audited as of …" stamps. These were left
   as-is on purpose: bumping the version string without re-running the
   audit would misrepresent them. Re-stamping them is an owner release
   step. (`crates/satchel-core` keeps its own independent `0.1.0` crate
   version — that is not the app version.)

8. **No GUI / end-to-end smoke was run against the packaged public
   build.** By design the public build has no MCP test bridge, so it
   can't be driven programmatically. The sync is verified at the
   build/packaging level (cargo check + vite build + a full
   `tauri build` producing the installer, with the bridge confirmed
   absent and the OCR/zga runtime assets confirmed copied into `dist/`).
   Functional GUI verification on the installed build is an owner step.

## Verification performed

- `cargo check --workspace` — green (satchel-core resolves; all new
  commands compile).
- `npm run build` (tsc --noEmit + vite build) — green; test bridge
  absent from `dist/`; tesseract + zgapdfsigner assets copied into
  `dist/`.
- `npm run tauri:build` — full pipeline green: vite build → release
  cargo+LTO build/link → WiX MSI → NSIS → updater signing. Produced
  `Open Satchel_0.5.0_x64-setup.exe` (~50 MB) and
  `Open Satchel_0.5.0_x64_en-US.msi` (~53 MB) under
  `target/release/bundle/`, each with a `.sig`, and staged
  `pdfium.dll` via `bundle.resources`.

  **Owner caveat:** the `.sig` updater artifacts from that build were
  signed with a *throwaway* key (to prove the pipeline), so tauri warns
  the secret key "does not match the public key from
  `plugins > updater > pubkey`". That warning is expected — it confirms
  the embedded owner pubkey is wired correctly. For the real release the
  owner must rebuild with `TAURI_SIGNING_PRIVATE_KEY` set to the private
  key that matches the embedded pubkey (the release CI does this).
