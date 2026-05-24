# Known Limitations

Honest list of what Open Satchel currently can NOT do, why, and the
workaround / future-fix path. Every entry has a code reference so a
future contributor can find the seam.

This file exists because shipping software with quiet limitations is
a marketing-vs-procurement disaster — the user finds out months in
when their gov / hospital review fails and they file a refund. Better
to catalogue the gaps up front.

---

## 1. AES-256 R=5 / R=6 native decryption

**Symptom.** Password-protected PDFs whose `/Encrypt` dict declares
`/V 5 /R 5` or `/V 5 /R 6` open through Open Satchel when `qpdf` is
available on `PATH`. If `qpdf` is not installed, the app surfaces a
precise error explaining that the high-revision AES-256 decrypt
fallback is unavailable.

**Why.** The native Rust decrypt path routes through `lopdf 0.32`,
which covers RC4-family revisions and partial AES-128, but not the
PDF 2.0 algorithm-2.B KDF used by `/R 5` and `/R 6`. Open Satchel now
detects those PDFs and calls a local `qpdf --decrypt` fallback.

**Workarounds (current).**

  1. Install `qpdf` and make sure it is available on `PATH`, then open
     the protected PDF normally.

  2. Re-save the source PDF in Adobe Acrobat with security removed,
     then open the resaved copy in Open Satchel.

**Future fix.** Implement the `/R 5` and `/R 6` KDF directly in Rust
so this fallback no longer depends on an external `qpdf` install.

**Coverage:** Unit tests pin the detector's accuracy for `/R 5`,
`/R 6`, `/R 4`, RC4, and non-encrypted PDFs.

---

## 2. Exact custom-font fidelity for Standard-14-shaped family names

**Symptom.** Editing text whose source font name is Standard-14-shaped
or office-suite-shaped (for example Arial, Calibri, Cambria, Helvetica,
Times, Courier) can save with the matching Standard-14 family metrics
instead of embedding the exact installed font file.

**Why.** There are two paths now. The pd-lib paragraph fallback in
`src/services/pdfParagraphEdits.ts` does call `resolveSystemFont()`
and can embed/subset an installed font. The engine bake path in
`src/services/pdfEngineBake.ts`, however, first calls
`isStandard14Family()`. Names such as `calibri`, `arial`, and `cambria`
are intentionally treated as sans/serif Standard-14-compatible
families and skip `populateEmbeddedFonts()`, so installing Calibri does
not automatically make the engine path embed Calibri.

**Workarounds (current).**

  1. For non-Standard-14 family names, install the source font on the
     user's system; `resolveSystemFont()` can pick it up and embed it.

  2. For Arial/Calibri/Cambria-style names, expect Standard-14
     substitution in the engine bake path unless that classifier is
     changed.

**Future fix.** If exact installed-font fidelity for Arial/Calibri/
Cambria matters more than the current compact Standard-14 path, narrow
`isStandard14Family()` and route those names through embedded-font
resolution. Keep this separate from PDF/A's
`pdfa_get_standard14_substitute` flow, which already locates
Arial/Liberation/DejaVu-style substitutes for archival conversion.

---

## 3. PDF/A-1b conversion of CJK / RTL source PDFs

**Symptom.** Converting a Chinese / Arabic / Hebrew PDF to PDF/A-1b
fails veraPDF cross-validation with a font-metrics rule violation.

**Why.** PDF/A-1b's font-embedding requirement applies to every
glyph the document references. Our embedder (Standard 14 paths +
G2 system-resolve) covers Latin-only families. CJK / RTL sources
typically ship a CIDFontType2 font with custom ToUnicode CMap;
embedding those at the byte level requires honoring the CMap
+ /CIDSystemInfo round-trip, which is in scope for D7 Bucket D
(future) but NOT yet implemented.

**Workarounds (current).**

  1. Convert to PDF/A-2b or PDF/A-3b if the receiving archive accepts a
     basic conformance profile. These are the PDF/A conversion profiles
     currently supported by `src/services/pdfAConvert.ts`.

  2. For PDF/A-2u or PDF/A-3u, use Open Satchel to validate only, then
     use an external converter when the archive requires Unicode
     conformance. The UI marks 2u/3u as validate-only in
     `PdfAdvancedDialog.tsx`.

**Future fix.** D7 — implement Identity-H emission + custom
ToUnicode / ActualText coverage for the PDF/A Unicode paths without
breaking the existing A-1b/A-2b/A-3b converter.

---

## What ISN'T listed here

Standard things we *do* support that occasionally get questioned:

- **AES-256 V=5 / R=4 (legacy AES-128).** Supported via lopdf's
  partial /R 4 path.
- **PDF/A-1b conversion of Latin-text sources.** Fully supported,
  cross-validated by veraPDF (`scripts/cross-validate.mjs`).
- **DocMDP-certified PDFs that DON'T need editing.** Open + view
  fine; the B4 enforce-on-load gate only fires when the user
  attempts a destructive save.
- **Bold / italic in custom fonts.** G3 handles all four (regular /
  bold / italic / bold-italic) variants of the resolved system font;
  the hot-take "Open Satchel doesn't do bold" is wrong as of
  2026-04-26.
- **Multi-page redaction.** Tested forensically under 5 encoding
  variants per fixture.
