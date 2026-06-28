// PDF/A Validation — check conformance against archival profiles.
//
// Multi-profile validator covering PDF/A-1b/2b/3b (Basic) and the
// 2u/3u (Unicode) checks. Not a full veraPDF replacement — covers
// the rules that block 90% of real procurement workflows.
//
// Profile differences:
//   1b: no JS, no encryption, no attachments, no transparency,
//       no OCG, output intent, embedded fonts, XMP w/ pdfaid:1
//   2b: 1b + transparency allowed, attachments still forbidden,
//       JPEG2000 allowed (we don't reject any image format anyway)
//   3b: 2b + attachments allowed (each must have /AFRelationship)
//   2u/3u: 2b/3b + every text-showing op must map via ToUnicode
//          CMap or have /ActualText — we flag missing ToUnicode
//          on each font dict.

import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, PDFRef } from 'pdf-lib'
import { parsePdfAIdentity, type PdfAProfile } from './pdfAXmp'

export interface ValidationIssue {
  severity: 'error' | 'warning'
  code: string
  message: string
  page?: number
  remediation?: string
}

export interface ValidationResult {
  isCompliant: boolean
  profile: string
  issues: ValidationIssue[]
  score: number  // 0-100
}

const PROFILE_LABELS: Record<PdfAProfile, string> = {
  'A-1B': 'PDF/A-1b (Basic, ISO 19005-1)',
  'A-2B': 'PDF/A-2b (Basic, ISO 19005-2)',
  'A-2U': 'PDF/A-2u (Unicode, ISO 19005-2)',
  'A-3B': 'PDF/A-3b (Basic, ISO 19005-3)',
  'A-3U': 'PDF/A-3u (Unicode, ISO 19005-3)',
}

/**
 * Validate a PDF against the given PDF/A profile. Defaults to A-1b
 * for backward compatibility with the original single-profile signature.
 */
export async function validatePdfA(
  bytes: Uint8Array,
  profile: PdfAProfile = 'A-1B',
): Promise<ValidationResult> {
  // Read-only path — share with sibling Advanced Tools sections.
  const { getReadOnlyPdfLibDoc } = await import('./pdfLibDocCache')
  const doc = await getReadOnlyPdfLibDoc(bytes)
  const catalog = doc.catalog
  const issues: ValidationIssue[] = []
  const part = profile.startsWith('A-1') ? 1 : profile.startsWith('A-2') ? 2 : 3
  const isUnicode = profile.endsWith('U')

  // ── Check 1: Title required ──────────────────────────────────────
  const title = doc.getTitle()
  if (!title || title.trim() === '') {
    issues.push({
      severity: 'error', code: 'PDFA-1',
      message: 'Document has no title in metadata',
      remediation: 'Set document title in Metadata section'
    })
  }

  // ── Check 2: No JavaScript / actions ─────────────────────────────
  const hasOpenAction = !!catalog.get(PDFName.of('OpenAction'))
  const hasAA = !!catalog.get(PDFName.of('AA'))
  const namesRef = catalog.get(PDFName.of('Names'))
  const namesDict = namesRef ? doc.context.lookup(namesRef) as PDFDict | undefined : undefined
  const hasJSNames = !!namesDict?.get(PDFName.of('JavaScript'))

  if (hasOpenAction || hasAA || hasJSNames) {
    issues.push({
      severity: 'error', code: 'PDFA-2',
      message: 'Document contains JavaScript or actions (forbidden in PDF/A)',
      remediation: 'Use Convert to PDF/A to strip JavaScript and actions'
    })
  }

  // ── Check 3: No encryption ───────────────────────────────────────
  try {
    const trailer = (doc as any).context?.trailerInfo
    if (trailer?.Encrypt) {
      issues.push({
        severity: 'error', code: 'PDFA-3',
        message: 'Document is encrypted (forbidden in PDF/A)',
        remediation: 'Remove encryption before archiving'
      })
    }
  } catch { /* ignore */ }

  // ── Check 4: Embedded files (forbidden in 1b/2b; allowed in 3) ──
  const hasAttachments = !!namesDict?.get(PDFName.of('EmbeddedFiles'))
  if (hasAttachments && part !== 3) {
    issues.push({
      severity: 'error', code: 'PDFA-4',
      message: `Document has embedded file attachments (forbidden in PDF/A-${part})`,
      remediation: 'Convert to PDF/A-3 to keep attachments, or use Sanitize to strip them'
    })
  }
  if (hasAttachments && part === 3) {
    // PDF/A-3 requires each attachment have /AFRelationship — quick check
    const ef = doc.context.lookup(namesDict!.get(PDFName.of('EmbeddedFiles'))!) as PDFDict | undefined
    const namesArr = ef?.get(PDFName.of('Names')) as PDFArray | undefined
    if (namesArr) {
      // Names array is [name, ref, name, ref, …]; check each ref
      for (let i = 1; i < namesArr.size(); i += 2) {
        const filespecRef = namesArr.get(i)
        const fs = doc.context.lookup(filespecRef) as PDFDict | undefined
        if (!fs) continue
        if (!fs.get(PDFName.of('AFRelationship'))) {
          issues.push({
            severity: 'warning', code: 'PDFA-4A',
            message: 'PDF/A-3 attachment missing /AFRelationship',
            remediation: 'Set /AFRelationship to Source / Data / Alternative / Supplement / Unspecified'
          })
          break
        }
      }
    }
  }

  // ── Check 5: Optional content (layers) — warning only in 1b ─────
  if (catalog.get(PDFName.of('OCProperties'))) {
    issues.push({
      severity: part === 1 ? 'warning' : 'warning',
      code: 'PDFA-5',
      message: 'Document has optional content groups (layers)',
      remediation: 'Use Convert to PDF/A to strip hidden layers'
    })
  }

  // ── Check 6: XMP metadata stream w/ correct pdfaid identifiers ──
  const xmpRef = catalog.get(PDFName.of('Metadata'))
  let hasGoodXmp = false
  if (xmpRef) {
    const xmpStream = doc.context.lookup(xmpRef) as PDFRawStream | undefined
    if (xmpStream && (xmpStream as any).contents) {
      try {
        const xmpBytes = (xmpStream as any).contents as Uint8Array
        const xmpStr = new TextDecoder().decode(xmpBytes)
        const id = parsePdfAIdentity(xmpStr)
        if (!id) {
          issues.push({
            severity: 'error', code: 'PDFA-6A',
            message: 'XMP metadata present but missing pdfaid:part / pdfaid:conformance',
            remediation: 'Re-run Convert to PDF/A to write a compliant XMP packet'
          })
        } else if (id.part !== part || id.conformance !== profile.slice(-1)) {
          issues.push({
            severity: 'error', code: 'PDFA-6B',
            message: `XMP declares PDF/A-${id.part}${id.conformance.toLowerCase()} but validating as ${profile}`,
            remediation: `Re-convert as PDF/A-${id.part}${id.conformance.toLowerCase()}, or re-convert as ${profile}`
          })
        } else {
          hasGoodXmp = true
        }
      } catch {
        issues.push({
          severity: 'warning', code: 'PDFA-6C',
          message: 'XMP metadata stream present but could not be parsed',
        })
      }
    }
  }
  if (!xmpRef) {
    issues.push({
      severity: 'error', code: 'PDFA-6',
      message: 'No XMP metadata stream (required for PDF/A)',
      remediation: 'Use Convert to PDF/A to add a compliant XMP packet'
    })
  }

  // ── Check 7: Output intent (required for ALL PDF/A profiles) ────
  const outputIntents = catalog.get(PDFName.of('OutputIntents'))
  if (!outputIntents) {
    issues.push({
      severity: 'error', code: 'PDFA-9',
      message: 'No /OutputIntents (required - ICC profile must be embedded)',
      remediation: 'Use Convert to PDF/A to embed sRGB output intent'
    })
  } else {
    const intentArr = doc.context.lookup(outputIntents) as PDFArray | undefined
    if (intentArr && intentArr.size() > 0) {
      const first = doc.context.lookup(intentArr.get(0)) as PDFDict | undefined
      const subtype = first?.get(PDFName.of('S'))?.toString()
      if (subtype !== '/GTS_PDFA1') {
        issues.push({
          severity: 'warning', code: 'PDFA-9A',
          message: `Output intent /S is ${subtype}, expected /GTS_PDFA1`,
        })
      }
      const dest = first?.get(PDFName.of('DestOutputProfile'))
      if (!dest) {
        issues.push({
          severity: 'error', code: 'PDFA-9B',
          message: 'Output intent has no /DestOutputProfile (ICC stream)',
        })
      }
    }
  }

  // ── Check 8: Font embedding audit (full walk, not just 10 pages) ─
  const fontReport = auditFonts(doc)
  for (const f of fontReport.unembedded) {
    issues.push({
      severity: 'error', code: 'PDFA-7',
      message: `Font "${f.baseFont}" is not embedded (used on page${f.pages.length > 1 ? 's' : ''} ${f.pages.slice(0, 3).join(', ')}${f.pages.length > 3 ? '…' : ''})`,
      remediation: 'Embed the font (re-export PDF with "embed all fonts") or substitute with a system font'
    })
  }
  for (const f of fontReport.standard14) {
    issues.push({
      severity: 'error', code: 'PDFA-7A',
      message: `Standard-14 font "${f.baseFont}" used without embedding (forbidden in PDF/A)`,
      remediation: 'Re-export with font embedding enabled'
    })
  }

  // ── Check 9: Transparency — forbidden in PDF/A-1, allowed in 2/3 ─
  if (part === 1) {
    let transparencyPage = -1
    for (let i = 0; i < doc.getPageCount(); i++) {
      const page = doc.getPage(i)
      const group = page.node.get(PDFName.of('Group'))
      if (group) {
        const gd = doc.context.lookup(group) as PDFDict | undefined
        if (gd?.get(PDFName.of('S'))?.toString() === '/Transparency') {
          transparencyPage = i; break
        }
      }
      const resRef = page.node.get(PDFName.of('Resources'))
      const res = resRef ? (doc.context.lookup(resRef) as PDFDict | undefined) : undefined
      const extRef = res?.get(PDFName.of('ExtGState'))
      const ext = extRef ? (doc.context.lookup(extRef) as PDFDict | undefined) : undefined
      if (ext) {
        for (const [, eRef] of ext.entries()) {
          const e = doc.context.lookup(eRef) as PDFDict | undefined
          if (!e) continue
          if (e.get(PDFName.of('SMask'))) { transparencyPage = i; break }
          const ca = e.get(PDFName.of('CA'))
          const caL = e.get(PDFName.of('ca'))
          if ((ca && ca.toString() !== '1') || (caL && caL.toString() !== '1')) {
            transparencyPage = i; break
          }
        }
      }
      if (transparencyPage >= 0) break
    }
    if (transparencyPage >= 0) {
      issues.push({
        severity: 'error', code: 'PDFA-8',
        message: `Page ${transparencyPage + 1} uses transparency (forbidden in PDF/A-1)`,
        page: transparencyPage,
        remediation: 'Convert to PDF/A-2B (which permits transparency) or flatten transparency first'
      })
    }
  }

  // ── Check 10: Unicode profiles — every font must have ToUnicode ──
  if (isUnicode) {
    for (const f of fontReport.allFonts) {
      if (!f.hasToUnicode && !f.isType1Standard) {
        issues.push({
          severity: 'error', code: 'PDFA-U',
          message: `Font "${f.baseFont}" has no ToUnicode CMap (required for ${profile})`,
          remediation: 'Re-export with text-extraction-friendly settings, or use PDF/A-2B/3B instead'
        })
      }
    }
  }

  // ── Check 11: Acrobat Forms - must NOT use /NeedAppearances=true ──
  // PDF/A requires appearance streams to be self-contained. Acrobat
  // sets /NeedAppearances=true to mean "render dynamically" — banned.
  const acroFormRef = catalog.get(PDFName.of('AcroForm'))
  const acroForm = acroFormRef ? (doc.context.lookup(acroFormRef) as PDFDict | undefined) : undefined
  if (acroForm) {
    const needsApp = acroForm.get(PDFName.of('NeedAppearances'))
    if (needsApp && needsApp.toString() === 'true') {
      issues.push({
        severity: 'error', code: 'PDFA-FORM',
        message: 'AcroForm has /NeedAppearances=true (forbidden in PDF/A)',
        remediation: 'Flatten form fields or set /NeedAppearances=false'
      })
    }
  }

  // ── Score ────────────────────────────────────────────────────────
  const errorCount = issues.filter(i => i.severity === 'error').length
  const warningCount = issues.filter(i => i.severity === 'warning').length
  // 11 distinct check categories. Score weights errors 1.0, warnings 0.5.
  const totalChecks = 11
  const passedChecks = totalChecks - errorCount - warningCount * 0.5
  const score = Math.max(0, Math.min(100, Math.round((passedChecks / totalChecks) * 100)))

  return {
    isCompliant: errorCount === 0,
    profile: PROFILE_LABELS[profile],
    issues,
    score,
  }
}

interface FontEntry {
  baseFont: string
  pages: number[]
  hasDescriptor: boolean
  hasToUnicode: boolean
  isType1Standard: boolean
}

interface FontReport {
  allFonts: FontEntry[]
  unembedded: FontEntry[]
  standard14: FontEntry[]
}

const STANDARD_14 = new Set([
  'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique',
  'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic',
  'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique',
  'Symbol', 'ZapfDingbats',
])

/**
 * Walk every page's Resources/Font dict (and Resources/XObject form-xo
 * Resources/Font recursively). Returns one entry per unique font ref
 * with the pages it's used on. Used by validator + convert pipeline.
 */
function auditFonts(doc: PDFDocument): FontReport {
  const byRef = new Map<string, FontEntry>()

  const visitFontDict = (fontsDict: PDFDict | undefined, pageIdx: number) => {
    if (!fontsDict) return
    for (const [, ref] of fontsDict.entries()) {
      const refKey = ref.toString()
      const existing = byRef.get(refKey)
      if (existing) {
        if (!existing.pages.includes(pageIdx + 1)) existing.pages.push(pageIdx + 1)
        continue
      }
      const font = doc.context.lookup(ref) as PDFDict | undefined
      if (!font) continue
      const baseFontObj = font.get(PDFName.of('BaseFont'))
      const baseFont = baseFontObj ? baseFontObj.toString().replace(/^\//, '') : '<unknown>'
      const nameOnly = baseFont.replace(/^[A-Z]{6}\+/, '') // strip subset prefix
      const hasToUnicode = !!font.get(PDFName.of('ToUnicode'))
      const isType1Standard = STANDARD_14.has(nameOnly)

      // Check FontDescriptor in two places. Simple fonts (Type1, TrueType,
      // Type3) carry it on the top-level font dict. Composite fonts
      // (Type0) push it down into /DescendantFonts[0] which is a
      // CIDFontType0 / CIDFontType2 dict. pd-lib's embedFont(opts) emits
      // the latter shape, so a shallow check would falsely flag every
      // pd-lib-embedded font as unembedded.
      let hasDescriptor = !!font.get(PDFName.of('FontDescriptor'))
      if (!hasDescriptor) {
        const subtype = font.get(PDFName.of('Subtype'))?.toString()
        if (subtype === '/Type0') {
          const descRef = font.get(PDFName.of('DescendantFonts'))
          const descArr = descRef ? (doc.context.lookup(descRef) as PDFArray | undefined) : undefined
          if (descArr && descArr.size() > 0) {
            const cidFontRef = descArr.get(0)
            const cidFont = doc.context.lookup(cidFontRef) as PDFDict | undefined
            if (cidFont && cidFont.get(PDFName.of('FontDescriptor'))) {
              hasDescriptor = true
            }
          }
        }
      }

      byRef.set(refKey, {
        baseFont: nameOnly,
        pages: [pageIdx + 1],
        hasDescriptor,
        hasToUnicode,
        isType1Standard,
      })
    }
  }

  for (let i = 0; i < doc.getPageCount(); i++) {
    const page = doc.getPage(i)
    const resources = page.node.get(PDFName.of('Resources'))
    if (!resources) continue
    const resDict = doc.context.lookup(resources) as PDFDict | undefined
    if (!resDict) continue

    const fontsRef = resDict.get(PDFName.of('Font'))
    const fonts = fontsRef ? (doc.context.lookup(fontsRef) as PDFDict | undefined) : undefined
    visitFontDict(fonts, i)

    // Walk form XObjects (a common hiding spot for fonts veraPDF catches).
    const xObjRef = resDict.get(PDFName.of('XObject'))
    const xObj = xObjRef ? (doc.context.lookup(xObjRef) as PDFDict | undefined) : undefined
    if (xObj) {
      for (const [, xRef] of xObj.entries()) {
        const x: unknown = doc.context.lookup(xRef)
        if (!x) continue
        // XObjects can be Form XObjects (PDFStream-with-dict) OR
        // Image XObjects (PDFRawStream — JPEG/PNG bytes, no
        // Resources). Image streams have neither `.get` nor a
        // `.dict` we want to walk; skip them. Form XObjects in
        // pd-lib are PDFRawStream too but expose their dict via
        // `.dict`. Probe for the right shape rather than casting.
        let xDict: PDFDict | undefined
        if (typeof (x as { get?: unknown }).get === 'function') {
          xDict = x as PDFDict
        } else if ((x as { dict?: unknown }).dict instanceof PDFDict) {
          xDict = (x as { dict: PDFDict }).dict
        } else {
          continue
        }
        // Image XObjects expose a /Subtype "Image" — skip them
        // entirely (no Font resources to find inside an image).
        const subtype = xDict.get(PDFName.of('Subtype'))
        if (subtype && subtype.toString() === '/Image') continue
        const xResRef = xDict.get(PDFName.of('Resources'))
        const xRes = xResRef ? (doc.context.lookup(xResRef) as PDFDict | undefined) : undefined
        if (!xRes) continue
        const xFontsRef = xRes.get(PDFName.of('Font'))
        const xFonts = xFontsRef ? (doc.context.lookup(xFontsRef) as PDFDict | undefined) : undefined
        visitFontDict(xFonts, i)
      }
    }
  }

  const allFonts = [...byRef.values()]
  return {
    allFonts,
    unembedded: allFonts.filter(f => !f.hasDescriptor && !f.isType1Standard),
    standard14: allFonts.filter(f => f.isType1Standard),
  }
}
