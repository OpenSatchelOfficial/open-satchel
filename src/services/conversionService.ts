import type { DocumentFormat } from '../types/tabs'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

export interface ConversionTarget {
  format: DocumentFormat
  label: string
  extension: string
  icon: string
}

type ConvertFn = (source: Uint8Array) => Promise<Uint8Array>

// Registry: sourceFormat -> targetFormat -> conversion function
const registry = new Map<DocumentFormat, Map<DocumentFormat, { fn: ConvertFn; target: ConversionTarget }>>()

function register(
  sourceFormat: DocumentFormat,
  target: ConversionTarget,
  fn: ConvertFn
): void {
  if (!registry.has(sourceFormat)) {
    registry.set(sourceFormat, new Map())
  }
  registry.get(sourceFormat)!.set(target.format, { fn, target })
}

export function getAvailableConversions(sourceFormat: DocumentFormat): ConversionTarget[] {
  const targets = registry.get(sourceFormat)
  if (!targets) return []
  return Array.from(targets.values()).map((v) => v.target)
}

export async function convert(
  sourceFormat: DocumentFormat,
  targetFormat: DocumentFormat,
  sourceBytes: Uint8Array
): Promise<Uint8Array> {
  const targets = registry.get(sourceFormat)
  if (!targets) throw new Error(`No conversions registered for format: ${sourceFormat}`)
  const entry = targets.get(targetFormat)
  if (!entry) throw new Error(`Cannot convert ${sourceFormat} to ${targetFormat}`)
  return entry.fn(sourceBytes)
}

// --- Helper: text to PDF ---
async function textToPdf(text: string, title?: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold)
  const fontSize = 11
  const lineHeight = fontSize * 1.4
  const margin = 50
  const pageWidth = 595.28 // A4
  const pageHeight = 841.89

  const usableWidth = pageWidth - 2 * margin
  const usableHeight = pageHeight - 2 * margin

  // Simple word-wrap
  const lines: string[] = []
  const rawLines = text.split('\n')
  for (const rawLine of rawLines) {
    if (rawLine.trim() === '') {
      lines.push('')
      continue
    }
    const words = rawLine.split(' ')
    let currentLine = ''
    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word
      const width = font.widthOfTextAtSize(testLine, fontSize)
      if (width > usableWidth && currentLine) {
        lines.push(currentLine)
        currentLine = word
      } else {
        currentLine = testLine
      }
    }
    if (currentLine) lines.push(currentLine)
  }

  let page = doc.addPage([pageWidth, pageHeight])
  let y = pageHeight - margin

  // Title
  if (title) {
    page.drawText(title, {
      x: margin, y, font: boldFont, size: 16,
      color: rgb(0.1, 0.1, 0.1)
    })
    y -= 30
  }

  for (const line of lines) {
    if (y < margin + lineHeight) {
      page = doc.addPage([pageWidth, pageHeight])
      y = pageHeight - margin
    }
    if (line.trim()) {
      page.drawText(line, {
        x: margin, y, font, size: fontSize,
        color: rgb(0.15, 0.15, 0.15)
      })
    }
    y -= lineHeight
  }

  return new Uint8Array(await doc.save())
}

// --- Helper: simple markdown to HTML ---
function markdownToHtml(md: string): string {
  let html = md
    // Headers
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    // Bold/italic
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Code blocks
    .replace(/```[\s\S]*?```/g, (match) => {
      const code = match.replace(/```\w*\n?/, '').replace(/\n?```$/, '')
      return `<pre><code>${code}</code></pre>`
    })
    // Inline code
    .replace(/`(.+?)`/g, '<code>$1</code>')
    // Links
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>')
    // Unordered lists
    .replace(/^\s*[-*] (.+)$/gm, '<li>$1</li>')
    // Horizontal rules
    .replace(/^---$/gm, '<hr/>')
    // Paragraphs
    .replace(/\n\n/g, '</p><p>')

  // Wrap list items
  html = html.replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>')
  // Remove duplicate nested ul tags
  html = html.replace(/<\/ul>\s*<ul>/g, '')

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; line-height: 1.6; color: #333; }
  h1, h2, h3 { color: #111; } code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; font-size: 0.9em; }
  pre { background: #f4f4f4; padding: 12px; border-radius: 6px; overflow-x: auto; }
  pre code { background: none; padding: 0; } a { color: #0066cc; }
  hr { border: none; border-top: 1px solid #ddd; margin: 20px 0; }
</style></head>
<body><p>${html}</p></body>
</html>`
}

// --- Helper: strip HTML tags for text extraction ---
function htmlToPlainText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li>/gi, '  - ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ============================================================
// Register conversions
// ============================================================

// Markdown -> HTML
register(
  'markdown',
  { format: 'html', label: 'HTML', extension: 'html', icon: '🌐' },
  async (source) => {
    const md = new TextDecoder().decode(source)
    const html = markdownToHtml(md)
    return new TextEncoder().encode(html)
  }
)

// Markdown -> PDF
register(
  'markdown',
  { format: 'pdf', label: 'PDF', extension: 'pdf', icon: '📄' },
  async (source) => {
    const md = new TextDecoder().decode(source)
    return textToPdf(md, undefined)
  }
)

// HTML -> PDF
register(
  'html',
  { format: 'pdf', label: 'PDF', extension: 'pdf', icon: '📄' },
  async (source) => {
    const html = new TextDecoder().decode(source)
    const text = htmlToPlainText(html)
    return textToPdf(text, undefined)
  }
)

// CSV -> XLSX
register(
  'csv',
  { format: 'xlsx', label: 'Excel Spreadsheet', extension: 'xlsx', icon: '📊' },
  async (source) => {
    const XLSX = await import('xlsx')
    const csv = new TextDecoder().decode(source)
    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.aoa_to_sheet(
      csv.split(/\r?\n/).filter((l) => l.trim()).map((line) => {
        const result: string[] = []
        let current = ''
        let inQuotes = false
        for (const char of line) {
          if (char === '"') { inQuotes = !inQuotes; continue }
          if (char === ',' && !inQuotes) { result.push(current.trim()); current = ''; continue }
          current += char
        }
        result.push(current.trim())
        return result
      })
    )
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
    const buffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
    return new Uint8Array(buffer)
  }
)

// XLSX -> CSV
register(
  'xlsx',
  { format: 'csv', label: 'CSV', extension: 'csv', icon: '📋' },
  async (source) => {
    const XLSX = await import('xlsx')
    const wb = XLSX.read(source, { type: 'array' })
    const firstSheet = wb.Sheets[wb.SheetNames[0]]
    const csv = XLSX.utils.sheet_to_csv(firstSheet)
    return new TextEncoder().encode(csv)
  }
)

// Plain Text -> PDF
register(
  'plaintext',
  { format: 'pdf', label: 'PDF', extension: 'pdf', icon: '📄' },
  async (source) => {
    const text = new TextDecoder().decode(source)
    return textToPdf(text, undefined)
  }
)

// Code -> PDF
register(
  'code',
  { format: 'pdf', label: 'PDF', extension: 'pdf', icon: '📄' },
  async (source) => {
    const text = new TextDecoder().decode(source)
    return textToPdf(text, undefined)
  }
)
