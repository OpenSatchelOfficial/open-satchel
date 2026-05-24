# Accessibility Conformance Status

**Product:** Open Satchel v0.1.x
**Last updated:** 2026-05-02
**Contact:** security@opensatchel.dev (accessibility inquiries welcome
at the same address)

> This document is a self-assessment of Open Satchel's accessibility
> posture, not a third-party audit. It is structured to support
> Section 508, EN 301 549, and VPAT 2.5 procurement reviews. Formal
> VPAT/ACR certification is planned once the product reaches v1.0
> stable.

---

## 1. Summary

Open Satchel is a local-first desktop document workstation. Its
accessibility story has two sides:

1. **The app's own UI** — keyboard navigation, screen-reader
   compatibility, contrast, focus management.
2. **PDF accessibility output** — the app's ability to produce and
   preserve tagged, accessible PDF documents (PDF/UA-1).

Both are active areas of investment. This document covers what works,
what is partial, and what is not yet implemented.

---

## 2. App UI accessibility

### 2.1 Keyboard navigation

| Area | Status | Notes |
|------|--------|-------|
| Ribbon tabs | Supported | Arrow keys cycle tabs; Enter activates the selected tool. |
| Tool buttons | Supported | Tab order follows visual layout; each button has an `aria-label`. |
| Dialogs | Supported | Focus is trapped inside open dialogs; Escape closes. |
| Page navigation | Supported | Ctrl+Page Up/Down, Ctrl+Home/End. |
| PDF canvas (annotations) | Partial | Fabric.js canvas receives keyboard events for move/delete but does not expose individual objects to the accessibility tree. |
| Command palette | Supported | Ctrl+K opens; arrow keys + Enter navigate. |
| Context menus | Supported | Standard menu-role ARIA attributes. |

### 2.2 Screen reader support

The app runs inside a Tauri WebView (Chromium-based on Windows, WebKit
on macOS). Standard ARIA roles and live regions are used throughout the
React component tree.

Known gaps:

- **Canvas-based annotations** (Fabric.js overlay) are not surfaced to
  assistive technology as individual objects. Users can access the
  annotation list through the sidebar panel, which is a standard DOM
  list.
- **PDF page content** rendered via pdfjs is drawn to a `<canvas>`
  element. The invisible text layer (`textLayer`) provides selectable
  text that screen readers can access, but structural semantics (headings,
  lists, tables) from the PDF's tag tree are not mapped to the DOM.

### 2.3 Color and contrast

- The default light theme meets WCAG 2.1 AA contrast ratios (4.5:1
  for body text, 3:1 for large text and UI components).
- A dark theme is available (toggle via the ribbon or Ctrl+Shift+D).
- High-contrast mode inherits from the OS high-contrast setting on
  Windows.
- Focus indicators use a visible 2px outline that does not rely on
  color alone.

### 2.4 Motion and animation

- No auto-playing animations.
- Page transitions respect `prefers-reduced-motion`.
- The eye-protection tint (warm overlay) can be toggled independently.

---

## 3. PDF accessibility output (PDF/UA)

### 3.1 What works

- **PDF/UA-1 validation.** The app can validate existing PDFs against
  ISO 14289-1 (PDF/UA-1) using veraPDF as a cross-validator. The
  validation result is surfaced in the Advanced dialog.
- **Tagged PDF preservation.** When editing a tagged PDF, the app
  snapshots the structure tree before save and restores it after,
  preserving `/StructTreeRoot`, `/MarkInfo`, and `/Lang` metadata.
  See `src/services/pdfStructPreserve.ts`.
- **PDF/A-1b conversion.** Latin-text PDFs can be converted to
  PDF/A-1b with veraPDF cross-validation confirming conformance.
- **Bookmark editor.** The outline tree is editable (add, rename,
  reorder, delete), which is a key PDF/UA requirement.
- **Document language.** `/Lang` is set during PDF/A and PDF/UA
  conversion.

### 3.2 Partial / in progress

- **Tag tree editor.** The app preserves existing tags but does not
  yet expose a UI for editing the tag tree (adding headings, marking
  artifacts, setting reading order). This is a planned feature.
- **Alt text for images.** The app supports adding alt text to image
  annotations but does not yet propagate it into the PDF structure
  tree as `/Alt` entries.
- **Table header markup.** Existing table tags (`/TH`, `/TD`) are
  preserved but cannot be added or edited through the UI.
- **Reading order editor.** Not yet implemented. Reading order is
  preserved from the source PDF's tag tree if present.
- **Tab order.** Form-field tab order is preserved but a visual tab-
  order editor is not yet implemented.

### 3.3 Not yet supported

- **PDF/UA-2** (ISO 14289-2, based on PDF 2.0). We validate and
  preserve PDF/UA-1 only.
- **Automated remediation.** The app does not auto-tag untagged PDFs.
  Remediation is a manual process in v1.
- **PAC 3 integration.** The PDF Accessibility Checker (PAC 3) is the
  reference validator for PDF/UA. Integration is planned but not yet
  shipped. Current validation uses veraPDF.

---

## 4. Section 508 / EN 301 549 mapping

| Requirement | Status | Notes |
|-------------|--------|-------|
| 1194.21(a) Keyboard accessible | Supported | All interactive elements reachable via keyboard. Canvas annotations accessible via sidebar. |
| 1194.21(b) No interference with AT | Supported | Standard ARIA roles; no custom accessibility-tree overrides. |
| 1194.21(c) Focus indicator | Supported | Visible 2px outline on all focusable elements. |
| 1194.21(d) Information about UI elements | Partial | ARIA labels on all buttons and controls. Canvas objects not individually labeled in the a11y tree. |
| 1194.21(f) Text information through AT | Supported | PDF text layer is selectable; UI text is standard DOM. |
| 1194.21(g) No flashing above 3 Hz | Supported | No flashing content. |
| 1194.21(i) Color not sole means | Supported | All status indicators use shape + text in addition to color. |
| 1194.21(l) Electronic forms | Partial | PDF form fields are accessible. The app's own dialogs use standard form elements. |
| EN 301 549 §11.8.1-5 Authoring tool a11y | Partial | Accessible output is possible but not enforced; see Section 3 above. |

---

## 5. Planned improvements

- Tag tree editing UI (add headings, mark artifacts, set reading order).
- Alt text propagation to PDF structure tree.
- PAC 3 shell-out validator alongside veraPDF.
- Formal VPAT 2.5 / ACR from a third-party assessor at v1.0 stable.
- Tab-order visual editor for form fields.

---

## 6. Feedback

If you encounter an accessibility barrier, please report it:

- Email: security@opensatchel.dev
- GitHub issue with the `accessibility` label.

We treat accessibility bugs with the same priority as functional bugs.

---

*This document will be updated as features ship. Check `git log
docs/ACCESSIBILITY.md` for the revision history.*
