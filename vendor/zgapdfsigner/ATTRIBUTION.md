# zgapdfsigner — vendored copy

This directory contains a **vendored copy** of [`zgapdfsigner`](https://github.com/zboris12/zgapdfsigner)
by [zboris12](https://github.com/zboris12), version **2.7.6** (published 2026-04-18).

Source: <https://github.com/zboris12/zgapdfsigner>
License: [MIT](./LICENSE) (preserved)
npm: <https://www.npmjs.com/package/zgapdfsigner>

## Why vendored?

Open Satchel relies on this library for three features where Open Satchel's
own code would otherwise be months of work:

- **AES-256 Revision 6 PDF encryption** (`PdfCryptor`) — PDF spec key
  derivation + CBC encrypt of the file key + stream/string rewrite.
- **Certified signatures with `/DocMDP`** (`PdfSigner.permission`) —
  inserts the `/Reference` + catalog `/Perms` at the correct pre-sign
  placeholder position so the signature's ByteRange covers the MDP
  transform and Acrobat shows the certified badge.
- **RFC 3161 TSA timestamps + LTV embed** — POSTs to a TSA, splices the
  timestamp token into the signer's `unsignedAttrs`, embeds OCSP/CRL
  responses in `/DSS` for long-term validity.

The package has a single npm maintainer. We vendor rather than depend
to insulate Open Satchel from:

1. A maintainer account compromise or supply-chain attack on future
   npm publishes.
2. The package going unmaintained without warning.
3. A breaking update in 2.8+ we haven't audited.

## Provenance audit

Pre-vendor audit (2026-04-18) confirmed:

- No malware, no obfuscation beyond the Closure-compiled `dist/*.min.js`.
- No `postinstall` / `preinstall` scripts.
- Network calls limited to seven whitelisted public RFC 3161 TSA
  endpoints (FreeTSA, DigiCert, Sectigo, Entrust, Apple, SSL.com,
  LangEdge).
- npm tarball SHA-256 byte-for-byte identical to the GitHub source at
  tag `v2.7.6` / commit `7686f4e3`.
- `dist/zgapdfsigner.min.js` reproducibly built from the `lib/*.js`
  sources via the maintainer's `build.sh` (Google Closure Compiler).

## What's included

```
vendor/zgapdfsigner/
  LICENSE              — MIT license from the upstream package
  lib/                 — readable source files
    zgaindex.js        — namespace + base utilities
    zgafetch.js        — RFC 3161 TSA HTTP client
    zgacertsutil.js    — X.509 cert chain + validity helpers
    zgapdfcryptor.js   — PDF R6 AES-256 encryption
    zgapdfsigner.js    — PKCS#7 signing + DocMDP + TSA embed + LTV
    zganode.js         — Node entry point (not used in browser build)
    zganode.d.ts       — TypeScript type definitions
  dist/
    zgapdfsigner.min.js — browser UMD bundle (what we actually load)
```

## How it's loaded

`src/services/zgaLoader.ts` injects `vendor/zgapdfsigner/dist/zgapdfsigner.min.js`
as a `<script>` tag after pre-populating `window.PDFLib`, `window.forge`,
`window.pako` with ESM imports of those dependencies. The UMD bundle
registers `globalThis.Zga`. See the loader file for specifics.

## How to update

If upstream ships a new version we want to adopt:

1. `npm view zgapdfsigner@<new-version>` — check metadata.
2. Re-audit using the same checklist as the original vendor pass
   (malware / obfuscation scan, install scripts, network endpoints,
   tarball hash equality with the GitHub source tag, reproducible
   build of the minified bundle).
3. Download the tarball: `npm pack zgapdfsigner@<new-version>`.
4. Diff the old `lib/*.js` against the new; read every changed line.
5. If clean: `rm -rf vendor/zgapdfsigner/lib vendor/zgapdfsigner/dist`
   then re-copy from the extracted package.
6. Update this file's version number + date + commit hash.
7. Update the Attribution note in `README.md` + the app About dialog
   to reflect the new version.

Do NOT auto-update. This is a trust anchor; treat it like a commit
of someone else's code into your repo, because that's what it is.

## Credit

This vendored copy exists because `zboris12` wrote and freely licensed
the underlying crypto work. Please star the upstream repo if you use
Open Satchel's encryption / signing features:
<https://github.com/zboris12/zgapdfsigner>
