# Dependency Risk Register

Current as of **2026-05-23** for Open Satchel `0.1.0` public beta.

This file documents known dependency advisories that are still present
after the first public-source cleanup. It is intentionally blunt: these
are accepted public-beta risks, not hidden claims of a fully hardened
enterprise release.

## Summary

`npm audit --omit=dev` reports:

| Severity | Status |
|---|---|
| Critical | 0 known after removing unused `@signpdf/*` packages |
| High | 5 advisories across 3 dependency areas |
| Moderate / Low | Not launch-blocking for this beta; reviewed separately |

The remaining high advisories are:

1. `fabric` stored-XSS advisory.
2. `fabric -> canvas -> @mapbox/node-pre-gyp -> tar` install-time archive advisories.
3. `xlsx` / SheetJS prototype-pollution and ReDoS advisories.

## Risk Levels

| Area | Audit severity | Open Satchel risk | Current decision |
|---|---:|---:|---|
| `fabric` SVG / object deserialization XSS | High | Medium | Accepted for public beta; upgrade requires regression pass |
| `canvas` / `node-pre-gyp` / `tar` chain | High | Low to Medium | Mostly install-time risk; accepted for public beta |
| `xlsx` SheetJS advisories | High | Medium | Accepted for public beta; replacement or isolation required |

## 1. Fabric.js Advisory

**Package:** `fabric`  
**Current range:** `^6.9.1`  
**Advisory:** `GHSA-hfvx-25r5-qc3w`  
**Audit recommendation:** upgrade to `fabric >= 7.2.0`.

`fabric@7.4.0` was published on **2026-05-18**, five days before this
risk register was written. Open Satchel does not blindly jump to a
brand-new major Fabric release immediately before public beta because
Fabric sits on core editing surfaces: annotations, drawing, stamps,
signature appearance, object selection, save/reopen, and PDF export.

**Practical exposure:** The advisory concerns unsafe SVG/object export
paths when untrusted object data is deserialized into Fabric. Open
Satchel is local-first and does not fetch collaborative remote canvases
or cloud-hosted Fabric JSON. The main risk is a malicious local document
or imported object causing dangerous Fabric state that later participates
in rendering/export.

**Mitigations already present:**

- No cloud sync or remote document ingestion.
- Tauri CSP limits network escape from the WebView.
- Canvas state is produced primarily through local UI gestures.
- Public beta status is clearly labeled.

**Next fix:** Run a dedicated Fabric 7 migration branch and compare
`7.2.0` and the current latest release against:

- Draw, highlight, stamp, sticky note, signature appearance.
- Object select/move/resize/delete.
- Save, reopen, undo, redo.
- PDF export and flattening.
- Existing Fabric JSON compatibility from saved documents.

## 2. Canvas / node-pre-gyp / tar Chain

**Packages:** `canvas`, `@mapbox/node-pre-gyp`, `tar`  
**Pulled through:** `fabric`  
**Audit severity:** High.

These advisories are primarily about archive extraction/path traversal
in the dependency install chain. They are not normal runtime paths where
opening a PDF in Open Satchel calls `tar`.

**Practical exposure:** A developer or builder running `npm install`
from the public repo consumes package archives and prebuilt native
assets. That is still a supply-chain concern, but it is different from
a user opening a local PDF and triggering app code.

**Mitigations already present:**

- `package-lock.json` pins exact dependency resolution.
- No `node_modules` are shipped in the public source folder.
- Production users receive Tauri app bundles, not a live npm install
workflow inside the app.

**Next fix:** Same as Fabric: upgrade Fabric after regression testing,
or replace Fabric if the major upgrade is too disruptive.

## 3. SheetJS / xlsx Advisories

**Package:** `xlsx`  
**Current range:** `^0.18.5`  
**Advisories:** prototype pollution and ReDoS.  
**Audit recommendation:** no fixed npm version available in this
package line.

Open Satchel uses `xlsx` for spreadsheet-oriented conversion/export
paths. Export-only usage is lower risk than parsing arbitrary untrusted
workbooks, but the package is still present in the runtime dependency
tree and must be treated as a real dependency risk.

**Practical exposure:** Malicious spreadsheet-like input, or conversion
code that parses attacker-controlled workbook content, could trigger
prototype pollution or high CPU regex behavior. This is less central
than PDF open/save, but it is not nothing.

**Mitigations already present:**

- The first public release is PDF-focused.
- Office/spreadsheet support is documented as limited and conversion-
  oriented.
- No cloud processing or server-side shared workbook ingestion exists.

**Next fix options:**

- Replace `xlsx` with a maintained alternative for the needed workbook
  write/read subset.
- Isolate spreadsheet parsing behind stricter file-size, worksheet-count,
  cell-count, and timeout limits.
- Remove spreadsheet conversion from public builds until a safer engine
  is selected.

## Release Decision

For `0.1.0` public beta, these risks are accepted with disclosure.

This is **not** a claim that Open Satchel is dependency-clean for
enterprise procurement. Before a security-reviewed `1.0`, the Fabric
and spreadsheet dependency risks should be resolved or explicitly
scoped out of the distributed build.
