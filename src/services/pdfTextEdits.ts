// Apply text-layer edits to raw PDF bytes.
//
// Input: the current pdfBytes, a page index, a list of span edits keyed by
// their position in pdfjs TextLayer order, and (optionally) the pdfjs doc
// we need for whiteout fallback positioning.
//
// Output: new pdfBytes with the edits applied. Two paths:
//   - Standard-encoding text → rewrite the content stream operator in place.
//   - CMap/hex-encoded text → whiteout the original and draw the replacement
//     on top. Lossy (font fidelity suffers) but correct.
//
// Extracted from PdfViewer so EditableTextLayer can call it live per
// keystroke (debounced).

import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import {
  parseContentStream,
  getPageContentBytes,
  writePageContentBytes,
  serializeContentStream,
  applyTextReplacement,
  encodeTextToBytes,
} from './contentStreamParser'
import { extractTextItems } from './pdfTextExtract'

export interface TextLayerEdit {
  /** Index into pdfjs TextLayer's textContent.items for the page. */
  spanIndex: number
  originalText: string
  newText: string
}

function runIsCMapEncoded(rawString: { type: string; value: Uint8Array } | undefined): boolean {
  if (!rawString || rawString.type !== 'hex') return false
  const raw = rawString.value
  if (!raw || raw.length === 0) return false
  let nonPrintable = 0
  for (let b = 0; b < raw.length; b++) {
    if (raw[b] < 0x20 || raw[b] > 0x7e) nonPrintable++
  }
  return nonPrintable / raw.length > 0.2
}

/**
 * Apply edits for a single page to the PDF bytes. Returns the updated bytes.
 * Non-destructive — caller decides when to persist to state.
 */
export async function applyTextEditsToBytes(
  pdfBytes: Uint8Array,
  pageIndex: number,
  edits: TextLayerEdit[],
  pdfjsDoc: PDFDocumentProxy | null,
): Promise<Uint8Array> {
  if (edits.length === 0) return pdfBytes

  const doc = await PDFDocument.load(pdfBytes)
  const streamData = getPageContentBytes(doc, pageIndex)
  if (!streamData) return pdfBytes

  const parsed = parseContentStream(streamData.bytes)
  let streamModified = false
  const whiteoutEdits: TextLayerEdit[] = []

  for (const edit of edits) {
    const run = parsed.textRuns[edit.spanIndex]
    if (!run) {
      // Span has no matching content-stream run — fall back to whiteout.
      whiteoutEdits.push(edit)
      continue
    }
    if (runIsCMapEncoded(run.rawString)) {
      whiteoutEdits.push(edit)
      continue
    }
    // Standard encoding: replace in place.
    const newBytes = encodeTextToBytes(edit.newText)
    applyTextReplacement(parsed, run.opIndex, newBytes, run.tjElementIndex)
    streamModified = true
  }

  if (streamModified) {
    const newStreamBytes = serializeContentStream(parsed.operators, streamData.bytes)
    writePageContentBytes(streamData.stream, newStreamBytes, true)
  }

  if (whiteoutEdits.length > 0 && pdfjsDoc) {
    try {
      const { items } = await extractTextItems(pdfjsDoc, pageIndex)
      const pdfPage = doc.getPage(pageIndex)
      const font = await doc.embedFont(StandardFonts.Helvetica)

      for (const edit of whiteoutEdits) {
        const item = items[edit.spanIndex]
        if (!item) continue

        // Slightly oversize the rect so antialiasing fringes don't peek through.
        const pad = item.height * 0.15
        pdfPage.drawRectangle({
          x: item.x - pad,
          y: item.y - pad,
          width: item.width + pad * 2,
          height: item.height + pad * 2,
          color: rgb(1, 1, 1),
          opacity: 1,
        })

        if (edit.newText.trim()) {
          const fontSize = Math.max(8, Math.min(item.fontSize, 36))
          pdfPage.drawText(edit.newText, {
            x: item.x,
            y: item.y,
            size: fontSize,
            font,
            color: rgb(0, 0, 0),
          })
        }
      }
    } catch (err) {
      // Whiteout is best-effort — if pdfjs text extraction fails we'd
      // rather preserve the standard-encoding edits than reject the whole call.
      console.error('[pdfTextEdits] whiteout fallback failed:', err)
    }
  }

  const out = await doc.save()
  return new Uint8Array(out)
}
