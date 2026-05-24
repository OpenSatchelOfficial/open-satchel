import { registerFormat } from './registry'
import { pdfHandler } from './pdf/index'

// v1 lineup. Add handlers here as each format lands.
export function registerAllFormats(): void {
  registerFormat(pdfHandler)
  // TODO M5: markdown, code, csv, json, html, image
  // TODO M6: docx, xlsx, pptx
}
