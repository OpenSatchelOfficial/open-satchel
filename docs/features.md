# Features

Comprehensive reference — everything Open Satchel does today. See
[getting-started.md](./getting-started.md) for a hands-on walkthrough.

---

## PDF core

### Viewing
- Pan, zoom (fit width / page / custom %), thumbnails sidebar
- Continuous scroll + single-page modes
- Dark mode, eye-protection color tint
- Auto-scroll with speed slider (5–120 px/tick)
- Multi-tab open (Ctrl+Tab)

### Search
- Case-sensitive toggle, whole-word toggle, regex toggle
- **Pattern presets:** SSN, phone, email, credit card, URL, date
  (clicking populates regex + auto-enables regex mode)
- Multi-page search across the open document

### Navigation
- Bookmarks panel (read + write)
- Named destinations editor
- Rulers, grid, snap-to-grid
- Draggable user guides (click ruler to add, drag to move,
  double-click to delete)

### Read Aloud (TTS)
- Uses browser SpeechSynthesis + Tauri SAPI
- Reads PDF body text in content-stream y-order (not just fabric
  overlay text — matches what the user sees)
- Voice picker (all installed system voices)

### Accessibility
- Structure-tree reader (tag tree enumeration)
- _Tagged PDF authoring + full checker: planned post-v1_

---

## Edit text

- Surgical content-stream patches — only the edited text run changes;
  every other byte is identical to the original
- Font change, size, style (bold / italic / underline / strike)
- Line spacing, char spacing
- Paragraph alignment
- Fallback-font selector (Helvetica / Times / Courier) for when the
  original font can't be re-embedded
- CJK / Arabic support via pure-Rust harfbuzz-subset (no Adobe
  dependency)

---

## Edit images

- List every embedded image (name, page, size, filter, byte count)
- Move image (drag — content-stream cm matrix rewrite)
- Resize image (JPEG re-encode + cm rewrite)
- **Rotate 90° CW / CCW** — lossless cm matrix composition
- **Flip H / V** — sign-flip on cm `a` / `d` components
- **Crop** (JPEG only currently) — re-encode at new bbox + cm
  rewrite so cropped result lands at user-specified on-page rect
- Replace image (swap XObject stream with new JPEG bytes)
- Extract all images → per-file save-as OR save all to folder
  (Tauri: single folder picker then bulk write)

---

## Edit pages

- Drag-reorder
- Rotate individual pages
- Delete / restore pages
- Merge multiple PDFs
- Split by range / size / bookmark
- Extract page range
- Crop pages
- Page numbering (Arabic, Roman, custom format, start value, range)
- Bates numbering (prefix / digits builder)
- Page labels
- Header / footer with live preview
- Watermark (text + image)
- Insert / replace pages from another PDF

---

## Annotate

- Highlight (3 widths × 2 opacity presets)
- Underline, strikethrough
- Sticky notes, text boxes
- Freehand draw (pen tool)
- Shapes (rect, circle, ellipse, line, polygon)
- Arrow, measure tool
- Stamp library (10 built-in + user-imported PNG/JPEG)
- Comments panel with:
  - Sort by page / author / status
  - Filter by author / status
  - Reply (linked thread)
  - Status dropdown per comment
  - Export to XFDF (Acrobat interop)
  - Export as summary PDF
  - Import XFDF
- Redaction (true content-stream removal, not overlay)
- Wipe / whiteout

---

## Forms

- Render existing AcroForm fields live
- Text, checkbox, radio group, dropdown, signature
- **Auto-detect fields on flat PDFs** — rasterize + underline/square
  heuristic + review-and-accept UI
- Form Designer (drag fields, property inspector)
- Flatten form on save
- **Whitelisted calc expression language** — SUM/AVG/IF/arithmetic/
  string funcs, no JS eval (see getting-started for examples)
- Validation types: regex pattern, min/max, required (renderer
  enforcement in progress)
- Appearance types: border style/color, fill, text color, font

---

## Signatures

- Self-signed (generate in-app)
- P12 / PFX import
- RFC 3161 Time-Stamp (TSA) — FreeTSA, DigiCert, Sectigo, Entrust;
  routed through native Rust to bypass WebView CORS
- Long-Term Validation (LTV) — embeds OCSP + cert chain in /DSS dict
- Certified signatures (/DocMDP L1/L2/L3)
- Multi-signature support (incremental update per sign)
- Verify signatures — shows crypto validity + cert trust + mod
  status
- Visible signature appearance _(coming — template editor)_

---

## Security + Redaction

- AES-256 encryption (via vendored zgapdfsigner)
- Separate user / owner passwords
- 8 permission bits (print / print-high / modify / copy / annot-
  forms / fill-forms / extract / assemble)
- Public-key (certificate-based) encryption _(planned)_
- True redaction (content-stream removal)
- Pattern find-and-redact _(planned)_
- Sanitize / strip hidden info
  (metadata, XMP, JavaScript, attachments, hidden layers,
  annotations, forms — toggleable)

---

## OCR

- Tesseract.js engine, 14 built-in language packs
- Auto-rotate via OSD (90/180/270° correction)
- Deskew via projection-variance sweep (±5°)
- Language auto-detect (OSD script → lang mapping)
- Confidence-based **suspects review** — low-conf words with pixel
  crop + editable text
- Output modes: clipboard / new tab / searchable PDF
- Batch across files (Tools → Batch → Batch OCR)
- Pipeline fits into action workflows via the `ocr` step type

---

## Batch / Action Wizard

- 9 built-in action presets
- Action step types: compress, bates, sanitize, flatten transparency,
  to_word, to_excel, to_ppt, to_text, to_image_only, ocr, prompt
- **Prompt step** — pauses chain for user confirmation
- **Hot-folder watch** (Tauri only) — drop PDFs in a folder, run
  the action automatically
- **CLI action runner** — `open-satchel --action foo.json --input
  folder/` for scripted automation
- Custom `.action.json` workflows — portable, share-friendly

---

## Compare / Diff

- Line-level text diff across two PDFs
- Pixel-level image diff (renders both pages, computes diff mask)
- Change report PDF — summary cover + annotated side-by-side
- Side-by-side visual compare with sync scroll

---

## Export to Office

- Word (.docx)
- Excel (.xlsx) with table detection
- PowerPoint (.pptx)
- Plain text (.txt)
- RTF, HTML, ODT, ODS, ODP (via LibreOffice sidecar)

**Fidelity:**
- **LibreOffice sidecar** (if LO installed) — ~60-65% fidelity;
  better for complex layouts, multi-column, tables
- **Built-in engine** (pdfjs text + layout inference) — ~30-60%
  fidelity; fine for text-heavy documents
- Engine is auto-detected; convert dialog shows which one ran

_Production-fidelity Office writers are planned for v1.1+ (custom
engine; LO ceiling is ~65%)_

---

## Misc / structure

- **XMP custom metadata editor** — arbitrary namespace / name /
  value triples, round-trip safe
- **OCG layers panel** — list, toggle visibility, save to catalog
- **Space-usage audit** — byte breakdown by object subtype + filter,
  bar chart view
- **Initial view editor** — opens-at-page, page layout (7 modes),
  page mode (7 panel states)
- Embedded-files attachments
- Link editor (URL / GoTo / GoToR / named dest)
- Bookmarks editor

---

## Cloud

- Works with OS-mounted cloud folders (Dropbox, OneDrive, Google
  Drive desktop clients — Open Satchel just sees them as local
  folders)
- No built-in cloud sync — by design

---

## What's deliberately NOT here

- Full Acrobat JavaScript in forms (security surface; whitelisted
  calc engine instead)
- Real-time collaborative editing (breaks local-first)
- PDF/X (print production — separate niche)
- Tagged PDF authoring tools (reader-side checker ships; authoring
  tools planned post-v1)
- Cloud-based OCR, cloud translation, etc.
