# Contributing to Open Satchel

Thank you for using Open Satchel. This file explains how the project
accepts feedback, how we handle bug reports, and why we cannot accept
external code contributions at this time.

---

## TL;DR

- **Bug reports** → [open a GitHub issue](https://github.com/JayQuan-McCleary/open-satchel/issues)
  with reproduction steps and the version you tested.
- **Feature requests** → also a GitHub issue, prefix the title with `[feature]`.
- **Security vulnerabilities** → **do not file a public issue.** Email
  `security@opensatchel.dev` per [SECURITY.md](SECURITY.md).
- **Commercial licensing questions** → `licensing@opensatchel.dev`
  or the [licensing page](https://opensatchel.dev/licensing).
- **Pull requests with code** → please do not. We explain why below.

---

## Why we do not accept external code contributions

Open Satchel is dual-licensed — AGPL-3.0-only for public use, and a
commercial license for organizations that need non-AGPL terms. This
dual-licensing model only works if the project maintains sole
copyright over the codebase. The moment we accept code from an
outside contributor without a signed Contributor License Agreement
(CLA), the right to relicense that contribution under commercial
terms is lost — which would break the entire commercial-licensing
model that funds ongoing development.

Many small dual-licensed projects use CLAs, but CLAs introduce
real friction for casual contributors and meaningful legal
overhead for us. We have chosen the cleaner path: keep the
copyright on a single legal entity, do the implementation work
ourselves, and credit issue reporters in release notes.

We know this is unusual for an open-source project. We make this
explicit so that nobody invests effort in a PR that we cannot accept.

---

## What we welcome (in detail)

### Bug reports

Excellent bug reports include:

1. **The version or commit you tested.** Tag from the `About` dialog
   or `package.json`.
2. **Your OS, including version.** Windows 11 23H2 vs Windows 10 21H2
   is the kind of detail that matters.
3. **A reproduction.** Either step-by-step instructions or — even
   better — a minimal PDF that triggers the issue. Attach to the
   issue. If the PDF contains sensitive content, redact it first OR
   email it privately to `security@opensatchel.dev`.
4. **What you expected to happen vs what happened.**
5. **Any error text from the app** (lower-right toast, or the
   developer console if you used `View → Toggle Developer Tools`).

### Feature requests

Be specific about the use case, not just the feature. "Add Bates
numbering with custom prefix and start number, because our litigation
team formats them as `CASE-2024-NNNNNN`" is much more actionable than
"add Bates numbering." Open Satchel ships a lot of features; the
ones that get prioritized are the ones with clear, documented use
cases.

### Documentation fixes

If you find a typo, a broken link, or a section that's just plain
wrong, please file an issue with a one-line description and the link.
We will fix it in the next release. (The same no-code-PR rule applies
to documentation, since some of our docs are licensed alongside the
source.)

### Translations

We are not accepting translations at this stage. Open Satchel ships
in English only for now. If you have a strong opinion about which
locale to prioritize for v1.x, file an issue.

---

## Bug-triage policy

| Severity | Response target | Patch target |
|----------|-----------------|--------------|
| Critical (RCE, signature bypass, data loss, data exfiltration) | 72 hours | 14 days |
| High (functional regression in shipped feature, security weakness without active exploit) | 7 days | 30 days |
| Medium (cosmetic bug, edge-case feature failure) | 14 days | Next minor release |
| Low (polish, nice-to-have, feature request) | 30 days | When prioritized |

Commercial license holders may have shorter SLAs documented in their
agreement.

---

## Release notes credit

We credit issue reporters in release notes for any bug they reported
that we fix in that release, unless the reporter asks to remain
anonymous. If you want credit attributed to a name, handle, or
organization other than your GitHub username, mention it in the
issue.

Security disclosures follow the SECURITY.md disclosure policy
separately.

---

## Code of conduct (informal)

Be respectful. Be precise. Do not file duplicate issues without
checking existing ones first. Do not file feature requests as bug
reports. Do not paste PDFs that contain personally identifiable
information of third parties without consent. Beyond that, the usual
common sense applies.

---

## Questions about this policy

If something here is unclear or you think we should reconsider, email
`licensing@opensatchel.dev` and we will respond. We do not always
agree, but we always read.
