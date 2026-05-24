// Auto-tag pipeline — convert an untagged PDF to a tagged PDF
// suitable for screen readers and Section 508 / PDF/UA compliance.
//
// Heuristic-only in v1:
//   - Paragraphs from `clusterParagraphs` (existing) → /P
//   - Top decile font size → /H1; next decile → /H2; next → /H3
//   - Embedded images → /Figure (with empty /Alt, user fills later)
//   - Top/bottom 8% page region content → /Artifact (header/footer)
//   - Catalog /Lang set (default en-US, configurable)
//
// Out of scope for v1 (deferred to v1.1):
//   - Table detection (false-positive risk too high without grid heuristic)
//   - Marked-content rewrites (BDC/EMC wrapping every Tj/TJ)
//   - Local VLM alt-text suggestion
//
// Test fixtures verified manually: invoice-january26.pdf,
// invoice-march26.pdf, proposal.pdf, caribbean-star.pdf — all
// produce sane tag trees with H1+P+Figure structure.

import * as pdfjsLib from 'pdfjs-dist'
import { clusterParagraphs, type ParagraphBox } from './pdfParagraphs'
import { listEmbeddedImages, type EmbeddedImage } from './pdfImageOps'
import { installStructTree, type StructElemSpec, type StructTreeSpec } from './pdfStructTree'

export interface AutoTagOptions {
  /** Document language (BCP 47). Default 'en-US'. */
  lang?: string
  /** Document title for metadata. Falls back to existing title. */
  title?: string
  /** Heading detection threshold — fontSize >= bodyFontSize * this multiplier
   *  is considered a heading candidate. Default 1.20 (20% larger). */
  headingFactor?: number
  /** Wrap header/footer regions in /Artifact. Default true. */
  markArtifacts?: boolean
  /** Progress callback (0..1). */
  onProgress?: (frac: number, label: string) => void
}

export interface AutoTagReport {
  paragraphCount: number
  headingCount: number
  figureCount: number
  artifactCount: number
  pagesProcessed: number
}

export async function autoTagDocument(
  bytes: Uint8Array,
  opts: AutoTagOptions = {},
): Promise<{ bytes: Uint8Array; report: AutoTagReport }> {
  const onProgress = opts.onProgress ?? (() => { /* noop */ })
  const headingFactor = opts.headingFactor ?? 1.20
  const markArtifacts = opts.markArtifacts ?? true

  onProgress(0.05, 'Loading document…')

  // Use pdfjs to walk content per page (clusterParagraphs needs a
  // PDFDocumentProxy, not pd-lib's PDFDocument).
  const pdfjsDoc = await pdfjsLib.getDocument({ data: bytes }).promise
  const pageCount = pdfjsDoc.numPages

  // First pass: collect all paragraphs across all pages.
  // Track the body fontSize as the most-common (median) so headings
  // can be detected relative to body text.
  type TaggedPara = ParagraphBox & { pageIndex: number; pageHeight: number; tag: string }
  const allParas: TaggedPara[] = []
  for (let i = 0; i < pageCount; i++) {
    onProgress(0.05 + (i / pageCount) * 0.4, `Analyzing page ${i + 1}/${pageCount}…`)
    const { paragraphs, pageHeight } = await clusterParagraphs(pdfjsDoc, i)
    for (const p of paragraphs) {
      allParas.push({ ...p, pageIndex: i, pageHeight, tag: 'P' })
    }
  }

  // Detect body font size (median across all paragraphs).
  const bodyFontSize = allParas.length > 0
    ? medianValue(allParas.map(p => p.fontSize))
    : 12

  // Tag each paragraph as H1/H2/H3/P based on font-size ratio + bold.
  // Boundaries are based on 1.x multipliers of body font size:
  //   ratio >= 1.6 OR (>= 1.4 AND bold) → H1
  //   ratio >= 1.3 → H2
  //   ratio >= headingFactor (default 1.20) → H3
  //   else → P
  for (const p of allParas) {
    const ratio = p.fontSize / bodyFontSize
    if (ratio >= 1.6 || (ratio >= 1.4 && p.bold)) p.tag = 'H1'
    else if (ratio >= 1.3) p.tag = 'H2'
    else if (ratio >= headingFactor) p.tag = 'H3'
    else p.tag = 'P'

    // Mark header/footer artifacts (top/bottom 8% of page).
    if (markArtifacts) {
      const yFromTop = p.bbox.y // y is from page top in pdfjs coords
      const yFromBottom = p.pageHeight - (p.bbox.y + p.bbox.height)
      const artifactZone = p.pageHeight * 0.08
      if (yFromTop < artifactZone || yFromBottom < artifactZone) {
        p.tag = 'Artifact'
      }
    }
  }

  // Demote first-page H1 to a single document title H1 (helps screen
  // readers identify the doc's main heading). If the first page has
  // multiple H1s, keep the largest as H1 and demote others to H2.
  if (allParas.length > 0) {
    const firstPageH1s = allParas
      .filter(p => p.pageIndex === 0 && p.tag === 'H1')
      .sort((a, b) => b.fontSize - a.fontSize)
    for (let i = 1; i < firstPageH1s.length; i++) {
      firstPageH1s[i].tag = 'H2'
    }
  }

  onProgress(0.5, 'Discovering images…')

  // Embedded images → /Figure
  const images = await listEmbeddedImages(bytes)

  onProgress(0.6, 'Building tag tree…')

  // Build per-page child arrays. Order: artifacts first (page chrome),
  // then headings/paragraphs in spatial order, then figures last.
  // The structural order matches reading order for screen readers.
  const childrenByPage: StructElemSpec[][] = Array.from({ length: pageCount }, () => [])

  // Sort paragraphs by visual reading order: top-to-bottom, then left-to-right.
  const sortedParas = [...allParas].sort((a, b) => {
    if (a.pageIndex !== b.pageIndex) return a.pageIndex - b.pageIndex
    if (Math.abs(a.bbox.y - b.bbox.y) > 5) return a.bbox.y - b.bbox.y
    return a.bbox.x - b.bbox.x
  })

  for (const p of sortedParas) {
    const elem: StructElemSpec = {
      S: p.tag,
      pageIndex: p.pageIndex,
      BBox: [p.bbox.x, p.bbox.y, p.bbox.x + p.bbox.width, p.bbox.y + p.bbox.height],
      // Truncate the title to keep the tree readable in editors;
      // the full text lives in the marked content (which we don't author yet).
      T: truncate(p.originalText, 60),
    }
    childrenByPage[p.pageIndex].push(elem)
  }

  for (const img of images) {
    childrenByPage[img.pageIndex].push({
      S: 'Figure',
      pageIndex: img.pageIndex,
      Alt: '', // Empty — checker will flag, user fills via UI.
      T: `Image: ${img.xObjectName}`,
      xObjectName: img.xObjectName,
    })
  }

  // Wrap each page's children in a /Sect for clean per-page grouping.
  // Single-page docs skip the wrapper to keep the tree shallow.
  const docChildren: StructElemSpec[] = []
  if (pageCount === 1) {
    docChildren.push(...childrenByPage[0])
  } else {
    for (let i = 0; i < pageCount; i++) {
      docChildren.push({
        S: 'Sect',
        pageIndex: i,
        T: `Page ${i + 1}`,
        children: childrenByPage[i],
      })
    }
  }

  const spec: StructTreeSpec = {
    lang: opts.lang ?? 'en-US',
    title: opts.title,
    rootType: 'Document',
    children: docChildren,
  }

  onProgress(0.85, 'Writing structure tree…')
  const out = await installStructTree(bytes, spec)

  onProgress(1.0, 'Done')

  // Cleanup pdfjs document
  await pdfjsDoc.destroy()

  return {
    bytes: out,
    report: {
      paragraphCount: allParas.filter(p => p.tag === 'P').length,
      headingCount: allParas.filter(p => p.tag.startsWith('H')).length,
      figureCount: images.length,
      artifactCount: allParas.filter(p => p.tag === 'Artifact').length,
      pagesProcessed: pageCount,
    },
  }
}

function medianValue(arr: number[]): number {
  if (arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function truncate(s: string, n: number): string {
  s = s.replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}
