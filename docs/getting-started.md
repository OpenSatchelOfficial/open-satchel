# Getting Started with Open Satchel

Open Satchel is a local-first PDF editor. Everything runs on your
machine; no cloud, no account, no telemetry.

This guide covers the 20 minutes of using the app — enough to open
a PDF, make real edits, sign, and save. See
[features.md](./features.md) for the deeper feature reference.

---

## Install

### Desktop (recommended)

Download the latest installer from the releases page. Launch.

- **Windows:** Open Satchel installs to `%APPDATA%\Local\Programs\Open
  Satchel`. Start menu shortcut is added.
- **macOS:** Drag to `/Applications`.
- **Linux:** `.deb`, `.rpm`, and `.AppImage` provided.

### Browser mode (dev testing only)

If you cloned the source:
```bash
npm install
npm run dev
```
Open `http://localhost:1420`. Browser mode is intended for testing;
some features (hot-folder watch, CLI, LibreOffice sidecar) require
the desktop build.

---

## Opening a PDF

Three ways:
1. **File → Open** (or `Ctrl+O`)
2. **Drag a PDF onto the window**
3. Recent files list on the start page

Tabs at the top — open multiple PDFs simultaneously, switch with
clicks or `Ctrl+Tab`.

---

## The ribbon

Feature groups along the top:

| Tab | What's there |
|---|---|
| **Home** | Primary tools (select / edit text / edit image), text formatting |
| **Insert** | Add text, images, stamps, watermarks, signatures |
| **Annotate** | Highlight / underline / strikethrough, sticky notes, drawing tools, comments |
| **Review** | Find / replace, spell check, read aloud, OCR |
| **Protect** | Password + permissions (AES-256), certificate sign |
| **Fill & Sign** | Checkboxes, crosses, dates, signature drop |
| **Pages** | Rotate, reorder, merge, split, crop, Bates numbering |
| **Tools** | Advanced — everything else (form designer, links, audit, layers, initial view) |
| **Batch** | Batch print, rename, OCR, convert across multiple files |

---

## Editing text

1. Click **Home → Edit Text**
2. Click any paragraph — it turns into a live-edit box
3. Type your changes, click outside to commit
4. `Ctrl+S` to save

Open Satchel uses surgical content-stream patches — your edits
modify only the specific text run you changed, preserving every
other byte of the PDF (fonts, layout, signatures on other content).
No full-doc re-serialization.

**CJK / Arabic:** fully supported via a pure-Rust font subsetter
(harfbuzz-subset). Works without Adobe Acrobat installed.

---

## Editing images

1. Click **Home → Edit Image**
2. Click an image — handles appear + a toolbar
3. Toolbar buttons: ↺/↻ rotate 90°, ↔ flip horizontal, ↕ flip
   vertical, ✂ crop

All edits persist into the PDF's content stream (cm matrix rewrite
for rotate/flip; re-encoded JPEG + updated cm for crop).

Crop currently supports JPEG images. Non-JPEG images (FlateDecoded
PNG-like, JBIG2) show a clear error message.

---

## Annotating

Annotate ribbon. Highlight text, add sticky notes, draw with the
pen tool, drop stamps.

Three highlighter widths (thin/medium/thick) and two opacity presets
(50% / 80%). Pick in the Annotate ribbon.

### Comments

Click any annotation to select it. Right-click → Add comment.

Comments panel (Annotate → Show Comments) shows every comment with:
- Author + page + kind
- Status dropdown (open / accepted / rejected / completed / cancelled)
- Reply button (replies become linked children)
- Export as XFDF (Acrobat-compatible) or summary PDF
- Import XFDF from other tools

### Stamps

10 built-in stamps + **custom library** (Insert → Stamps →
Custom…). Import PNG/JPEG; your library persists across sessions.

---

## Filling forms

Open a PDF with form fields — they render live with the expected
controls.

**Auto-detect fields** on a flat PDF: Tools → Layout → Auto-detect
Fields. Heuristic scan of underlines + small squares. Review hits
before committing.

### Form calc expressions

Instead of Acrobat JavaScript (which we don't support for security
reasons), calculate field values with a safe whitelisted language.

Examples:
- `SUM({qty}, {tax}, {shipping})`
- `ROUND({qty} * {price} * (1 + {tax}), 2)`
- `IF({qty} > 10, "bulk", "retail")`
- `UPPER(LEFT({name}, 3))`

Functions: SUM, AVG, PRODUCT, MIN, MAX, IF, NOT, AND, OR, FLOOR,
CEIL, ROUND, ABS, LEN, CONCAT, LEFT, RIGHT, UPPER, LOWER, CONTAINS,
IFERROR.

No JavaScript eval, no DOM access, no network — just pure arithmetic.

---

## OCR

Review → OCR. Run on current page or all pages.

Options:
- Auto-rotate (OSD detection, corrects 90/180/270°)
- Deskew (±5° projection-variance)
- Auto-detect language (OSD script mapping)
- 14 built-in languages (English, Chinese simpl/trad, Japanese,
  Korean, French, German, Spanish, Italian, Portuguese, Dutch,
  Polish, Russian, Arabic)
- Suspect threshold — words below confidence N are flagged for
  review in a post-OCR dialog

Output modes: clipboard (just the text), new tab (text file), or
searchable PDF (invisible text overlay — Ctrl+F finds it).

**Batch OCR across files:** Tools → Batch → Batch OCR. Pick a
folder, all PDFs are converted to searchable versions.

---

## Signing

Protect → Sign & Certify. Three modes:

1. **Signature** — standard digital signature
2. **Certified signature** — with /DocMDP; any unauthorized edit
   invalidates the cert
3. **Sign + Time Stamp** — adds an RFC 3161 TSA countersign

Certificate options:
- Generate self-signed (in-memory only)
- Import P12 / PFX (your CA-issued cert)
- Long-Term Validation (LTV) — embeds OCSP + cert chain so
  verification works offline

Verified in Foxit PDF Reader; Acrobat Reader DC compatibility is in
the verification checklist for v1 launch.

---

## Hot folder (Tauri only)

Tools → Batch → Watched Folders.

Pick a folder + an `.action.json` workflow. When a PDF lands in
that folder, the workflow runs automatically, output saves next to
the source. For auto-archiving scans, bulk OCR, etc.

---

## Saving

`Ctrl+S` — saves to the original path.
**Save As** (`Ctrl+Shift+S`) — pick a new location.

Open Satchel saves as incremental updates when possible, preserving
signatures and every byte of unmodified content.

---

## What's NOT here (by design)

- No cloud save. Use your OS's cloud-folder clients (Dropbox,
  OneDrive, etc.) for cloud sync.
- No real-time collaboration.
- No account / login. No email required.
- No telemetry or analytics. See
  [PRIVACY.md](../PRIVACY.md) for the full network-call inventory.
- No Acrobat-JS form scripts (by design — security). See the
  whitelisted calc language above.

---

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+O` | Open |
| `Ctrl+S` | Save |
| `Ctrl+Shift+S` | Save As |
| `Ctrl+P` | Print |
| `Ctrl+F` | Find |
| `Ctrl+H` | Find & Replace |
| `Ctrl+Z` / `Ctrl+Y` | Undo / Redo |
| `Ctrl+Tab` | Next tab |
| `Ctrl+Shift+Tab` | Previous tab |
| `Ctrl+W` | Close tab |
| `Ctrl+K` | Command palette (feature search) |

---

## Getting help

- **Bug reports** → GitHub issues
- **Commercial licensing** → see [pricing](https://open-satchel.dev/pricing)
- **Privacy / security questions** → see
  [PRIVACY.md](../PRIVACY.md)

---

Next: read [features.md](./features.md) for the complete feature
reference.
