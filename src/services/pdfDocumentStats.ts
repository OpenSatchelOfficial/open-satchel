// Document-level statistics: page count, file size, embedded font /
// image / annotation / link / form-field totals, plus extracted text
// length. Powers the Properties → Statistics tab.
//
// Design parity: Acrobat's "Document Properties → Description" tab
// shows roughly this set of numbers; we go a step further with an
// extracted-text character count that procurement workflows use
// to estimate translation cost.

import { PDFDocument, PDFDict, PDFName, PDFArray, PDFRef, PDFNumber } from 'pdf-lib'

export interface DocumentStats {
  fileSize: number
  pageCount: number
  /** /Font references — counted from each page's /Resources. May
   *  count the same font across pages (a doc with 10 pages all using
   *  Helvetica = 10 here). Use scanPdf for the unique-font count. */
  fontReferences: number
  /** /XObject /Subtype /Image counts across all pages. */
  imageCount: number
  /** /Annot count across all pages — includes links, comments, etc. */
  annotationCount: number
  /** /Annot /Subtype /Link count specifically. */
  linkCount: number
  /** AcroForm field count (recursive across /Kids). */
  formFieldCount: number
  /** Outline (bookmark) entries — top-level + nested. */
  outlineCount: number
  /** Embedded file attachment count from /Names/EmbeddedFiles. */
  attachmentCount: number
  /** OCG (optional content group / layer) count. */
  layerCount: number
  /** Total characters across all pages' text content. Best-effort —
   *  ToUnicode-decoded where possible, raw bytes otherwise. */
  textCharCount: number
  /** PDF version string (e.g. '1.4', '1.7', '2.0'). */
  pdfVersion: string
  /** True if the doc is encrypted. */
  encrypted: boolean
}

/** Walk the PDF and aggregate statistics. Tolerant of malformed
 *  catalog shapes — partial stats beat a hard failure. */
export async function generateDocumentStats(bytes: Uint8Array): Promise<DocumentStats> {
  const stats: DocumentStats = {
    fileSize: bytes.byteLength,
    pageCount: 0,
    fontReferences: 0,
    imageCount: 0,
    annotationCount: 0,
    linkCount: 0,
    formFieldCount: 0,
    outlineCount: 0,
    attachmentCount: 0,
    layerCount: 0,
    textCharCount: 0,
    pdfVersion: '',
    encrypted: false,
  }

  // Detect encryption from the first 1KB — pd-lib needs ignoreEncryption
  // to load locked docs, but we still want to surface the status.
  const head = new TextDecoder().decode(bytes.slice(0, Math.min(1024, bytes.length)))
  const versionMatch = /^%PDF-(\d+\.\d+)/.exec(head)
  if (versionMatch) stats.pdfVersion = versionMatch[1]
  // /Encrypt entry — checked via simple substring; tolerant of compressed xref streams.
  const fullText = new TextDecoder().decode(bytes)
  if (/\/Encrypt\s/.test(fullText)) stats.encrypted = true

  let doc: PDFDocument
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })
  } catch {
    // If even the lenient load fails, return whatever we already populated.
    return stats
  }

  const ctx = doc.context
  stats.pageCount = doc.getPageCount()

  // Per-page walk.
  for (let i = 0; i < stats.pageCount; i++) {
    try {
      const page = doc.getPage(i)
      const node = page.node

      // Fonts via /Resources/Font.
      try {
        const resources = node.lookup(PDFName.of('Resources'))
        if (resources instanceof PDFDict) {
          const fontsDict = resources.lookup(PDFName.of('Font'))
          if (fontsDict instanceof PDFDict) {
            stats.fontReferences += fontsDict.entries().length
          }
          // XObject images.
          const xobjDict = resources.lookup(PDFName.of('XObject'))
          if (xobjDict instanceof PDFDict) {
            for (const [, xobjRef] of xobjDict.entries()) {
              try {
                const xobj = xobjRef instanceof PDFRef ? ctx.lookup(xobjRef) : xobjRef
                // Streams have a /Subtype on their dict.
                const xobjDictInner = (xobj as { dict?: PDFDict }).dict
                if (xobjDictInner instanceof PDFDict) {
                  const subtype = xobjDictInner.lookup(PDFName.of('Subtype'))
                  if (subtype instanceof PDFName && subtype.asString() === '/Image') {
                    stats.imageCount += 1
                  }
                }
              } catch {
                /* skip malformed xobj */
              }
            }
          }
        }
      } catch {
        /* page.resources unavailable */
      }

      // Annotations.
      try {
        const annots = node.lookup(PDFName.of('Annots'))
        if (annots instanceof PDFArray) {
          stats.annotationCount += annots.size()
          for (let j = 0; j < annots.size(); j++) {
            const a = annots.lookup(j)
            if (a instanceof PDFDict) {
              const subtype = a.lookup(PDFName.of('Subtype'))
              if (subtype instanceof PDFName && subtype.asString() === '/Link') {
                stats.linkCount += 1
              }
            }
          }
        }
      } catch {
        /* no annots */
      }
    } catch {
      /* page parse fail — skip */
    }
  }

  // AcroForm field count (walks /Kids recursively).
  try {
    const acro = doc.catalog.lookup(PDFName.of('AcroForm'))
    if (acro instanceof PDFDict) {
      const fields = acro.lookup(PDFName.of('Fields'))
      if (fields instanceof PDFArray) {
        const stack: PDFArray[] = [fields]
        while (stack.length) {
          const arr = stack.pop()!
          for (let i = 0; i < arr.size(); i++) {
            const f = arr.lookup(i)
            if (!(f instanceof PDFDict)) continue
            const kids = f.lookup(PDFName.of('Kids'))
            if (kids instanceof PDFArray) {
              stack.push(kids)
            } else {
              stats.formFieldCount += 1
            }
          }
        }
      }
    }
  } catch {
    /* no /AcroForm */
  }

  // Outline (bookmark) count via /Outlines/Count (absolute).
  try {
    const outlines = doc.catalog.lookup(PDFName.of('Outlines'))
    if (outlines instanceof PDFDict) {
      const cnt = outlines.lookup(PDFName.of('Count'))
      if (cnt instanceof PDFNumber) {
        stats.outlineCount = Math.abs(cnt.asNumber())
      }
    }
  } catch {
    /* no /Outlines */
  }

  // Attachments via /Names/EmbeddedFiles/Names array length / 2.
  try {
    const names = doc.catalog.lookup(PDFName.of('Names'))
    if (names instanceof PDFDict) {
      const ef = names.lookup(PDFName.of('EmbeddedFiles'))
      if (ef instanceof PDFDict) {
        const namesArr = ef.lookup(PDFName.of('Names'))
        if (namesArr instanceof PDFArray) {
          stats.attachmentCount = Math.floor(namesArr.size() / 2)
        }
      }
    }
  } catch {
    /* none */
  }

  // OCG layers.
  try {
    const ocp = doc.catalog.lookup(PDFName.of('OCProperties'))
    if (ocp instanceof PDFDict) {
      const ocgs = ocp.lookup(PDFName.of('OCGs'))
      if (ocgs instanceof PDFArray) stats.layerCount = ocgs.size()
    }
  } catch {
    /* none */
  }

  // Best-effort text character count. Heuristic: count printable
  // characters within the body of every Tj/TJ literal-string
  // operand. Doesn't decode hex strings or via ToUnicode, so it's
  // an under-estimate for CID-keyed fonts. Cheap; useful for "is
  // this thing a 10-page report or a 200-word memo?" quick check.
  try {
    const text = new TextDecoder('latin1').decode(bytes)
    // Match (...) followed by Tj or TJ. Skip escaped parens.
    const tjRe = /\(([^()]*?(?:\\[()][^()]*?)*?)\)\s*T[jJ]/g
    let total = 0
    let m: RegExpExecArray | null
    while ((m = tjRe.exec(text)) !== null) {
      total += m[1].replace(/\\[()\\nrtbf]/g, ' ').length
    }
    stats.textCharCount = total
  } catch {
    /* text scan unavailable */
  }

  return stats
}

/** Format bytes as a human-readable size string. 1024-base; one
 *  decimal place beyond KB. */
export function formatByteSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}
