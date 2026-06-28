import { registerFormat } from './registry'
import { pdfHandler } from './pdf/index'

// v1 lineup. Add handlers here as each format lands.
// See DEFERRED_FORMATS.md for the v1.1+ queue.
export function registerAllFormats(): void {
  registerFormat(pdfHandler)
  // TODO M5: markdown, code, csv, json, html, image
  // TODO M6: docx, xlsx, pptx
}
