// PDF accessibility checker — runs the top 12 PDF/UA + Section 508
// rules that cover the 90% of procurement-blocker issues.
//
// Not a full PAC 3 / veraPDF replacement (those check 100+ rules).
// We focus on what actually moves needles for gov / corp procurement:
//
//   1.  Document is tagged              (/StructTreeRoot present)
//   2.  /MarkInfo /Marked = true        (assistive-tech key)
//   3.  Catalog /Lang set               (BCP 47 language)
//   4.  Document title in metadata
//   5.  /ViewerPreferences /DisplayDocTitle = true
//   6.  Every /Figure has /Alt or /ActualText
//   7.  Heading hierarchy is sequential (no H1 → H3 jumps)
//   8.  No nested /Figure                (illegal in PDF/UA)
//   9.  Form fields have /TU (tooltip)
//   10. Page /Tabs = /S (structure-based tab order)
//   11. PDF version >= 1.4
//   12. No JS / OpenAction / AA (auto-actions break screen reader flow)
//
// Score: 100 - (errors × 8 + warnings × 3). Compliant = 0 errors.
// Mirrors the shape of pdfAValidation.ts so the UI can reuse the same
// result-rendering component.

import { PDFDocument, PDFName, PDFDict, PDFArray, PDFString } from 'pdf-lib'

export interface A11yIssue {
  severity: 'error' | 'warning' | 'info'
  code: string
  message: string
  remediation?: string
  /** Page index if the issue is page-localized. */
  page?: number
}

export interface A11yResult {
  isCompliant: boolean
  profile: string
  issues: A11yIssue[]
  score: number
  /** Quick-glance counts. */
  stats: {
    isTagged: boolean
    figureCount: number
    figuresWithAlt: number
    headingLevels: number[]
  }
}

export async function checkAccessibility(bytes: Uint8Array): Promise<A11yResult> {
  // Read-only — share the parsed doc with sibling Advanced Tools
  // sections so opening the Accessibility tab doesn't re-parse a
  // 33 MB doc that Metadata or Bookmarks already loaded.
  const { getReadOnlyPdfLibDoc } = await import('./pdfLibDocCache')
  const doc = await getReadOnlyPdfLibDoc(bytes)
  const catalog = doc.catalog
  const issues: A11yIssue[] = []

  // Stats accumulator
  const stats = {
    isTagged: false,
    figureCount: 0,
    figuresWithAlt: 0,
    headingLevels: [] as number[],
  }

  // ── Rule 1: Document is tagged ──────────────────────────────────
  const structTreeRoot = catalog.get(PDFName.of('StructTreeRoot'))
  stats.isTagged = !!structTreeRoot
  if (!structTreeRoot) {
    issues.push({
      severity: 'error', code: 'A11Y-1',
      message: 'Document is not tagged (/StructTreeRoot missing)',
      remediation: 'Run Auto-Tag to generate a structure tree',
    })
  }

  // ── Rule 2: /MarkInfo /Marked = true ────────────────────────────
  const markInfoRef = catalog.get(PDFName.of('MarkInfo'))
  const markInfo = markInfoRef ? doc.context.lookup(markInfoRef) as PDFDict | undefined : undefined
  const marked = markInfo?.get(PDFName.of('Marked'))?.toString()
  if (marked !== 'true') {
    issues.push({
      severity: 'error', code: 'A11Y-2',
      message: 'Document missing /MarkInfo /Marked=true',
      remediation: 'Set in Auto-Tag or via the Lang/MarkInfo controls',
    })
  }

  // ── Rule 3: Catalog /Lang ───────────────────────────────────────
  const lang = catalog.get(PDFName.of('Lang'))
  if (!lang) {
    issues.push({
      severity: 'error', code: 'A11Y-3',
      message: 'Document language not set (/Lang on catalog missing)',
      remediation: 'Set the document language in the Accessibility panel',
    })
  }

  // ── Rule 4: Document title in metadata ──────────────────────────
  const title = doc.getTitle()
  if (!title || title.trim() === '') {
    issues.push({
      severity: 'error', code: 'A11Y-4',
      message: 'Document has no title in metadata',
      remediation: 'Set the title in the Metadata panel',
    })
  }

  // ── Rule 5: /ViewerPreferences /DisplayDocTitle = true ─────────
  const vpRef = catalog.get(PDFName.of('ViewerPreferences'))
  const vp = vpRef ? doc.context.lookup(vpRef) as PDFDict | undefined : undefined
  const displayDocTitle = vp?.get(PDFName.of('DisplayDocTitle'))?.toString()
  if (displayDocTitle !== 'true') {
    issues.push({
      severity: 'warning', code: 'A11Y-5',
      message: 'Viewer not asked to display the document title (DisplayDocTitle != true)',
      remediation: 'Auto-Tag sets this automatically',
    })
  }

  // ── Rules 6, 7, 8: figure alt-text + heading hierarchy + nesting ─
  if (structTreeRoot) {
    const rootDict = doc.context.lookup(structTreeRoot) as PDFDict | undefined
    if (rootDict) {
      const headingLevels: number[] = []
      const figureIssues: { hasAlt: boolean; nested: boolean }[] = []

      const walk = (dict: PDFDict, ancestorIsFigure: boolean) => {
        const s = dict.get(PDFName.of('S'))?.toString()
        let isFigure = false
        if (s === '/Figure') {
          isFigure = true
          // PDF/UA requires NON-EMPTY /Alt or /ActualText. Empty alt
          // strings don't satisfy the rule — decorative images should
          // be re-tagged as /Artifact instead.
          const alt = dict.get(PDFName.of('Alt')) as PDFString | undefined
          const actual = dict.get(PDFName.of('ActualText')) as PDFString | undefined
          const altText = alt?.decodeText() ?? ''
          const actualText = actual?.decodeText() ?? ''
          const hasAlt = altText.trim() !== '' || actualText.trim() !== ''
          figureIssues.push({ hasAlt, nested: ancestorIsFigure })
          stats.figureCount++
          if (hasAlt) stats.figuresWithAlt++
        }
        if (s && /^\/H[1-6]$/.test(s)) {
          headingLevels.push(parseInt(s.slice(2), 10))
        }
        const k = dict.get(PDFName.of('K'))
        if (!k) return
        const resolved = doc.context.lookup(k)
        if (resolved instanceof PDFArray) {
          for (let i = 0; i < resolved.size(); i++) {
            const child = doc.context.lookup(resolved.get(i))
            if (child instanceof PDFDict) walk(child, ancestorIsFigure || isFigure)
          }
        } else if (resolved instanceof PDFDict) {
          walk(resolved, ancestorIsFigure || isFigure)
        }
      }
      walk(rootDict, false)

      stats.headingLevels = headingLevels

      // Rule 6: missing /Alt on /Figure
      const missingAltCount = figureIssues.filter(f => !f.hasAlt).length
      if (missingAltCount > 0) {
        issues.push({
          severity: 'error', code: 'A11Y-6',
          message: `${missingAltCount} of ${figureIssues.length} /Figure elements lack /Alt or /ActualText`,
          remediation: 'Use the Alt-Text panel to add descriptions',
        })
      }

      // Rule 7: heading hierarchy
      let lastLevel = 0
      for (const level of headingLevels) {
        if (lastLevel > 0 && level > lastLevel + 1) {
          issues.push({
            severity: 'warning', code: 'A11Y-7',
            message: `Heading hierarchy skips a level (H${lastLevel} → H${level})`,
            remediation: 'Re-check Auto-Tag headings or manually demote/promote',
          })
          break // report once
        }
        lastLevel = level
      }

      // Rule 8: nested figures
      const nestedCount = figureIssues.filter(f => f.nested).length
      if (nestedCount > 0) {
        issues.push({
          severity: 'error', code: 'A11Y-8',
          message: `${nestedCount} /Figure element(s) nested inside another /Figure (forbidden in PDF/UA)`,
          remediation: 'Restructure the tag tree to put figures as siblings',
        })
      }
    }
  }

  // ── Rule 9: form fields with /TU (tooltip) ──────────────────────
  const acroFormRef = catalog.get(PDFName.of('AcroForm'))
  const acroForm = acroFormRef ? doc.context.lookup(acroFormRef) as PDFDict | undefined : undefined
  if (acroForm) {
    const fieldsRef = acroForm.get(PDFName.of('Fields'))
    const fields = fieldsRef ? doc.context.lookup(fieldsRef) as PDFArray | undefined : undefined
    if (fields && fields.size() > 0) {
      let missingTu = 0
      for (let i = 0; i < fields.size(); i++) {
        const field = doc.context.lookup(fields.get(i)) as PDFDict | undefined
        if (!field) continue
        if (!field.get(PDFName.of('TU'))) missingTu++
      }
      if (missingTu > 0) {
        issues.push({
          severity: 'warning', code: 'A11Y-9',
          message: `${missingTu} form field(s) lack tooltip (/TU)`,
          remediation: 'Set tooltips in the Form Designer',
        })
      }
    }
  }

  // ── Rule 10: page /Tabs = /S ───────────────────────────────────
  let tabOrderIssues = 0
  for (let i = 0; i < doc.getPageCount(); i++) {
    const page = doc.getPage(i)
    const tabs = page.node.get(PDFName.of('Tabs'))
    if (!tabs || tabs.toString() !== '/S') tabOrderIssues++
  }
  if (tabOrderIssues > 0 && structTreeRoot) {
    issues.push({
      severity: 'warning', code: 'A11Y-10',
      message: `${tabOrderIssues} page(s) lack /Tabs = /S (structure-based tab order)`,
      remediation: 'PDF/UA requires page /Tabs entry; Auto-Tag adds this',
    })
  }

  // ── Rule 11: PDF version >= 1.4 ────────────────────────────────
  // pdf-lib doesn't expose the header version directly; sniff bytes.
  const head = new TextDecoder('latin1').decode(bytes.slice(0, 16))
  const m = head.match(/^%PDF-(\d)\.(\d)/)
  if (m) {
    const major = parseInt(m[1], 10)
    const minor = parseInt(m[2], 10)
    if (major < 1 || (major === 1 && minor < 4)) {
      issues.push({
        severity: 'error', code: 'A11Y-11',
        message: `PDF version ${m[1]}.${m[2]} is below 1.4 (PDF/UA-1 minimum)`,
        remediation: 'Convert to PDF/A-1b (which sets header to 1.4)',
      })
    }
  }

  // ── Rule 12: no JavaScript / actions ───────────────────────────
  const hasJs = !!catalog.get(PDFName.of('OpenAction')) || !!catalog.get(PDFName.of('AA'))
  if (hasJs) {
    issues.push({
      severity: 'warning', code: 'A11Y-12',
      message: 'Document contains auto-actions (OpenAction or AA) - interferes with assistive tech',
      remediation: 'Run Sanitize to strip actions',
    })
  }

  // ── Score ───────────────────────────────────────────────────────
  const errors = issues.filter(i => i.severity === 'error').length
  const warnings = issues.filter(i => i.severity === 'warning').length
  const score = Math.max(0, 100 - errors * 8 - warnings * 3)

  return {
    isCompliant: errors === 0,
    profile: 'PDF/UA-1 + Section 508 (Top 12 rules)',
    issues,
    score,
    stats,
  }
}
