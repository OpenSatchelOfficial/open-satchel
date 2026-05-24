// OCR pipeline for PDFs — rasterize page, run Tesseract.js, optionally
// produce a searchable PDF. Extracted from OcrDialog so the same code
// runs from the OCR modal, the Batch dialog, and the Action Wizard's
// `ocr` step.
//
// Pre-processing: orientation detection (PSM OSD), rough projection
// deskew, script-based language auto-detect. All three are optional
// and default to on — each adds <1s/page on a typical scan.

import { useFormatStore } from '../stores/formatStore'
import { useTabStore } from '../stores/tabStore'
import type { PdfFormatState } from '../formats/pdf'

export type OcrOutputMode = 'clipboard' | 'newtab' | 'searchable'
export type OcrScope = 'current' | 'all'

export interface OcrOptions {
  language: string
  scope: OcrScope
  dpi: 150 | 300 | 600
  outputMode: OcrOutputMode
  autoRotate: boolean
  deskew: boolean
  autoDetectLanguage: boolean
  /** Words with confidence below this are flagged as suspects. */
  suspectThreshold: number
}

export interface OcrSuspect {
  pageNum: number
  text: string
  confidence: number
  // Pixel-space bbox on the rasterized page at `dpi`.
  x0: number; y0: number; x1: number; y1: number
  // Rasterized page dimensions at `dpi` — needed to re-crop for review.
  pageW: number; pageH: number
}

export interface OcrPageData {
  pageNum: number
  words: Array<{ text: string; x: number; y: number; w: number; h: number }>
  vpWidth: number
  vpHeight: number
}

export interface OcrResult {
  fullText: string
  ocrPageData: OcrPageData[]
  suspects: OcrSuspect[]
  rasterizedPages: Array<{ pageNum: number; canvasDataURL: string; width: number; height: number }>
  // True if a language auto-detected different from the one passed in.
  detectedLanguage?: string
}

export interface OcrProgress {
  step: 'init' | 'osd' | 'recognize' | 'assemble'
  pageIndex: number
  totalPages: number
  pct: number
  statusText: string
}

// Tesseract script-name → language mapping. Covers what our UI offers
// plus sensible fallbacks. Tesseract's OSD returns script names from
// its osdmodel — see `tessdata/osd.traineddata`.
const SCRIPT_TO_LANG: Record<string, string> = {
  Latin: 'eng',
  Greek: 'eng',     // No dedicated Greek in our pack — Latin model reads the Latin letters
  Cyrillic: 'rus',
  Arabic: 'ara',
  Hebrew: 'eng',
  Han: 'chi_sim',
  Hiragana: 'jpn',
  Katakana: 'jpn',
  HanS: 'chi_sim',
  HanT: 'chi_tra',
  Japanese: 'jpn',
  Korean: 'kor',
  Hangul: 'kor',
  Devanagari: 'eng',
  Thai: 'eng',
}

/** Rough deskew via projection-profile variance. Tries rotations in a
 *  narrow range (±5°) and picks the one whose horizontal projection
 *  histogram has the highest variance — a well-aligned text page has
 *  dense "row" bands separated by whitespace, which maximizes variance.
 *  Returns the skew angle in degrees (the rotation that WILL be applied
 *  to correct; positive = clockwise).
 *
 *  Uses a downscaled grayscale pass for speed — input canvas is scaled
 *  to ~400px on the long axis before the sweep. <150ms on a 300dpi
 *  letter page. */
async function detectSkew(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<number> {
  const MAX_DIM = 400
  const w0 = (canvas as HTMLCanvasElement).width
  const h0 = (canvas as HTMLCanvasElement).height
  const scale = MAX_DIM / Math.max(w0, h0)
  if (scale >= 1) return projectionSkew(canvas as OffscreenCanvas)

  const small = new OffscreenCanvas(Math.max(1, Math.round(w0 * scale)), Math.max(1, Math.round(h0 * scale)))
  const ctx = small.getContext('2d')!
  ctx.drawImage(canvas as CanvasImageSource, 0, 0, small.width, small.height)
  return projectionSkew(small)
}

function projectionSkew(canvas: OffscreenCanvas): number {
  const ctx = canvas.getContext('2d')!
  const { width, height } = canvas
  const src = ctx.getImageData(0, 0, width, height)
  const srcData = src.data
  // Gray threshold — anything darker than 180 = ink.
  const gray = new Uint8ClampedArray(width * height)
  for (let i = 0, j = 0; i < srcData.length; i += 4, j++) {
    const g = (srcData[i] + srcData[i + 1] + srcData[i + 2]) / 3
    gray[j] = g < 180 ? 1 : 0
  }
  let bestAngle = 0
  let bestScore = -1
  // ±5° in 0.5° steps.
  for (let ang = -5; ang <= 5; ang += 0.5) {
    const rad = (ang * Math.PI) / 180
    const sin = Math.sin(rad), cos = Math.cos(rad)
    const rows = new Uint32Array(height)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (gray[y * width + x] !== 1) continue
        const cx = x - width / 2, cy = y - height / 2
        const ry = Math.round(cx * sin + cy * cos + height / 2)
        if (ry >= 0 && ry < height) rows[ry]++
      }
    }
    let mean = 0
    for (let r = 0; r < rows.length; r++) mean += rows[r]
    mean /= rows.length
    let variance = 0
    for (let r = 0; r < rows.length; r++) {
      const d = rows[r] - mean
      variance += d * d
    }
    if (variance > bestScore) { bestScore = variance; bestAngle = ang }
  }
  return bestAngle
}

/** Run Tesseract in OSD mode to detect orientation + script. Falls
 *  back silently if the OSD model isn't available — it's only needed
 *  for auto-rotate + auto-lang. */
async function detectOrientationAndScript(
  imageData: ImageData,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Tesseract: any,
): Promise<{ rotation: 0 | 90 | 180 | 270; script: string | null }> {
  try {
    // PSM 0 = OSD only. With default eng language + LSTM it still does
    // OSD because osd.traineddata is bundled.
    const result = await Tesseract.recognize(imageData as unknown as ImageData, 'osd', {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tessedit_pageseg_mode: 0,
    } as unknown as Record<string, unknown>)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const osd = (result.data as any).osd
    // Orientation is sometimes a prose string in `osd`. Parse it.
    if (typeof osd === 'string') {
      const rotMatch = /Rotate:\s*(\d+)/.exec(osd)
      const scriptMatch = /Script:\s*(\w+)/.exec(osd)
      const rot = rotMatch ? Number(rotMatch[1]) : 0
      const script = scriptMatch ? scriptMatch[1] : null
      const normalized: 0 | 90 | 180 | 270 =
        rot === 90 || rot === 180 || rot === 270 ? rot : 0
      return { rotation: normalized, script }
    }
    return { rotation: 0, script: null }
  } catch {
    return { rotation: 0, script: null }
  }
}

/** Rotate an OffscreenCanvas by multiples of 90° into a new canvas.
 *  Pure transform — no pixel resampling, so it's lossless. */
function rotate90(src: OffscreenCanvas, deg: 0 | 90 | 180 | 270): OffscreenCanvas {
  if (deg === 0) return src
  const { width, height } = src
  const rotated = deg === 180
    ? new OffscreenCanvas(width, height)
    : new OffscreenCanvas(height, width)
  const ctx = rotated.getContext('2d')!
  ctx.save()
  ctx.translate(rotated.width / 2, rotated.height / 2)
  ctx.rotate((deg * Math.PI) / 180)
  ctx.drawImage(src, -width / 2, -height / 2)
  ctx.restore()
  return rotated
}

/** Apply a fine rotation (typically ±5°) via pixel resample. Used
 *  after projection-deskew. White-fills the backdrop so the resulting
 *  image has clean white margins, not transparent. */
function rotateFine(src: OffscreenCanvas, deg: number): OffscreenCanvas {
  if (Math.abs(deg) < 0.1) return src
  const { width, height } = src
  const rad = (deg * Math.PI) / 180
  const sin = Math.abs(Math.sin(rad))
  const cos = Math.abs(Math.cos(rad))
  const newW = Math.ceil(width * cos + height * sin)
  const newH = Math.ceil(width * sin + height * cos)
  const out = new OffscreenCanvas(newW, newH)
  const ctx = out.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, newW, newH)
  ctx.translate(newW / 2, newH / 2)
  ctx.rotate(-rad)
  ctx.drawImage(src, -width / 2, -height / 2)
  return out
}

export async function runOcr(
  pdfBytes: Uint8Array,
  visiblePageIndices: number[],
  currentVisibleIndex: number,
  opts: OcrOptions,
  onProgress?: (p: OcrProgress) => void,
  cancelSignal?: { cancelled: boolean },
): Promise<OcrResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Tesseract = await import('tesseract.js') as any
  const pdfjsLib = await import('pdfjs-dist')

  const doc = await pdfjsLib.getDocument({ data: pdfBytes.slice() }).promise
  const pagesToProcess: number[] =
    opts.scope === 'current'
      ? [(visiblePageIndices[currentVisibleIndex] ?? 0) + 1]
      : visiblePageIndices.map((p) => p + 1)

  const allText: string[] = []
  const ocrPageData: OcrPageData[] = []
  const suspects: OcrSuspect[] = []
  const rasterizedPages: OcrResult['rasterizedPages'] = []
  let detectedLanguage: string | undefined
  const scale = opts.dpi / 72
  const totalPages = pagesToProcess.length

  for (let i = 0; i < pagesToProcess.length; i++) {
    if (cancelSignal?.cancelled) break

    const pageNum = pagesToProcess[i]
    onProgress?.({ step: 'init', pageIndex: i, totalPages, pct: i / totalPages, statusText: `Rendering page ${i + 1}/${totalPages}…` })

    const page = await doc.getPage(pageNum)
    const viewport = page.getViewport({ scale })
    let canvas = new OffscreenCanvas(Math.floor(viewport.width), Math.floor(viewport.height))
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await page.render({ canvasContext: ctx as any, viewport }).promise

    // Pre-processing: OSD (if auto-rotate or auto-lang) then deskew.
    if (opts.autoRotate || opts.autoDetectLanguage) {
      onProgress?.({ step: 'osd', pageIndex: i, totalPages, pct: (i + 0.2) / totalPages, statusText: `Detecting orientation (page ${i + 1})…` })
      const smallW = Math.min(600, canvas.width)
      const smallH = Math.round((smallW / canvas.width) * canvas.height)
      const small = new OffscreenCanvas(smallW, smallH)
      small.getContext('2d')!.drawImage(canvas, 0, 0, smallW, smallH)
      const smallData = small.getContext('2d')!.getImageData(0, 0, smallW, smallH)
      const osd = await detectOrientationAndScript(smallData, Tesseract)
      if (opts.autoRotate && osd.rotation !== 0) {
        canvas = rotate90(canvas, osd.rotation)
      }
      if (opts.autoDetectLanguage && osd.script && SCRIPT_TO_LANG[osd.script]) {
        const mapped = SCRIPT_TO_LANG[osd.script]
        if (mapped !== opts.language) detectedLanguage = mapped
      }
    }

    if (opts.deskew) {
      onProgress?.({ step: 'osd', pageIndex: i, totalPages, pct: (i + 0.3) / totalPages, statusText: `Deskewing page ${i + 1}…` })
      const skewAngle = await detectSkew(canvas)
      if (Math.abs(skewAngle) > 0.25) canvas = rotateFine(canvas, skewAngle)
    }

    const effectiveLang = detectedLanguage ?? opts.language
    const imageData = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height)

    onProgress?.({ step: 'recognize', pageIndex: i, totalPages, pct: (i + 0.4) / totalPages, statusText: `Recognizing page ${i + 1} (${effectiveLang})…` })

    const result = await Tesseract.recognize(imageData as unknown as ImageData, effectiveLang, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger: (m: any) => {
        if (m.status === 'recognizing text') {
          const pct = (i + 0.4 + m.progress * 0.5) / totalPages
          onProgress?.({ step: 'recognize', pageIndex: i, totalPages, pct, statusText: `Recognizing page ${i + 1}: ${Math.round(m.progress * 100)}%` })
        }
      },
    })

    // Text assembly — preserve layout via block/para/line/word structure
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resultData = result.data as any
    if (resultData.blocks && resultData.blocks.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const blocks = [...resultData.blocks].sort((a: any, b: any) => a.bbox.y0 - b.bbox.y0)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const layoutText = blocks.map((block: any) => {
        if (!block.paragraphs) return block.text || ''
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return block.paragraphs.map((para: any) => {
          if (!para.lines) return para.text || ''
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return para.lines.map((line: any) => {
            if (!line.words) return line.text || ''
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const words = [...line.words].sort((a: any, b: any) => a.bbox.x0 - b.bbox.x0)
            let text = ''
            for (let w = 0; w < words.length; w++) {
              if (w > 0) {
                const gap = words[w].bbox.x0 - words[w - 1].bbox.x1
                text += gap > 30 ? '\t' : ' '
              }
              text += words[w].text
            }
            return text
          }).join('\n')
        }).join('\n\n')
      }).join('\n\n\n')
      allText.push(layoutText)
    } else {
      allText.push(resultData.text)
    }

    // Word-level bbox collection for searchable mode + suspects
    const words0 = resultData.words as Array<{
      text: string; confidence?: number
      bbox: { x0: number; y0: number; x1: number; y1: number }
    }> | undefined
    if (words0) {
      for (const w of words0) {
        if (opts.outputMode === 'searchable' && w.text.trim()) {
          if (ocrPageData[ocrPageData.length - 1]?.pageNum !== pageNum) {
            ocrPageData.push({ pageNum, words: [], vpWidth: viewport.width / scale, vpHeight: viewport.height / scale })
          }
          ocrPageData[ocrPageData.length - 1].words.push({
            text: w.text,
            x: w.bbox.x0 / scale,
            y: w.bbox.y0 / scale,
            w: (w.bbox.x1 - w.bbox.x0) / scale,
            h: (w.bbox.y1 - w.bbox.y0) / scale,
          })
        }
        if (typeof w.confidence === 'number' && w.confidence < opts.suspectThreshold && w.text.trim().length > 1) {
          suspects.push({
            pageNum,
            text: w.text,
            confidence: w.confidence,
            x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1,
            pageW: canvas.width, pageH: canvas.height,
          })
        }
      }
    }

    // Save a dataURL of the preprocessed page so suspects UI can crop
    // the exact pixels Tesseract saw (post-rotate/deskew).
    rasterizedPages.push({
      pageNum,
      canvasDataURL: await offscreenToDataURL(canvas),
      width: canvas.width,
      height: canvas.height,
    })

    page.cleanup()
  }
  doc.destroy()

  return {
    fullText: allText.join('\n\n--- Page Break ---\n\n'),
    ocrPageData,
    suspects,
    rasterizedPages,
    detectedLanguage,
  }
}

async function offscreenToDataURL(canvas: OffscreenCanvas): Promise<string> {
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result))
    fr.onerror = reject
    fr.readAsDataURL(blob)
  })
}

/** Build a searchable PDF from the original bytes + per-word OCR data.
 *  Embeds invisible Helvetica text at each word's position. */
export async function buildSearchablePdf(
  originalBytes: Uint8Array,
  ocrPageData: OcrPageData[],
): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib')
  const pdfDoc = await PDFDocument.load(originalBytes)
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica)
  for (const pageData of ocrPageData) {
    const idx = pageData.pageNum - 1
    if (idx < 0 || idx >= pdfDoc.getPageCount()) continue
    const pdfPage = pdfDoc.getPage(idx)
    const { height: pageH } = pdfPage.getSize()
    for (const word of pageData.words) {
      if (!word.text.trim()) continue
      const fontSize = Math.max(4, Math.min(word.h * 0.8, 20))
      const pdfY = pageH - word.y - word.h
      pdfPage.drawText(word.text, {
        x: word.x, y: pdfY, size: fontSize, font, color: rgb(0, 0, 0), opacity: 0,
      })
    }
  }
  return await pdfDoc.save()
}

/** Apply OCR result to the current tab — either writes text to clipboard,
 *  opens it in a new tab, or replaces pdfBytes with a searchable version. */
export async function applyOcrResult(
  tabId: string,
  originalBytes: Uint8Array,
  result: OcrResult,
  outputMode: OcrOutputMode,
): Promise<void> {
  if (outputMode === 'clipboard') {
    await navigator.clipboard.writeText(result.fullText)
    return
  }
  if (outputMode === 'newtab') {
    const blob = new Blob([result.fullText], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    window.open(url, '_blank')
    return
  }
  // searchable
  const out = await buildSearchablePdf(originalBytes, result.ocrPageData)
  useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({
    ...prev, pdfBytes: out, pageCount: prev.pageCount,
  }))
  useTabStore.getState().setTabDirty(tabId, true)
}
