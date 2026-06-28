// Action Wizard — multi-step batch workflow executor.
// Defines a pipeline of operations that run sequentially on PDF bytes.

import { compressPdf } from './pdfOps'
import { applyBatesNumbering, sanitizePdf, type BatesOptions, type SanitizeOptions } from './pdfOps'
import { pdfToText, toImageOnlyPdf } from './pdfConvert'
import { flattenTransparency } from './pdfFlatten'
import { runOcr, buildSearchablePdf, type OcrOptions } from './pdfOcr'
import { convertPdfHighFidelity } from './pdfToOffice'
import { signPdf, type SignOptions } from './pdfSign'

export type ActionStepType =
  | 'compress'
  | 'bates'
  | 'sanitize'
  | 'flatten_transparency'
  | 'to_word'
  | 'to_excel'
  | 'to_ppt'
  | 'to_text'
  | 'to_image_only'
  | 'ocr'
  | 'sign'
  | 'prompt'

/** Per-step sign options. Action-wizard sign steps require the
 *  caller to pre-load a P12 cert + passphrase into the step's
 *  options. The base64 inline is the simplest path for v1; v1.1
 *  can swap to a session-stored "lastUsedCert" slot so passphrases
 *  don't sit in step config. */
export interface SignStepOptions {
  /** P12 / PFX cert bytes as base64 (no data: prefix). */
  certB64: string
  /** Passphrase for the P12. Shipped inline by necessity for now;
   *  audited as a known limitation. */
  passphrase: string
  reason?: string
  location?: string
  signerName?: string
  contactInfo?: string
  appearance?: SignOptions['appearance']
  /** /DocMDP level (1 / 2 / 3). Omit for ordinary approval. */
  certifyLevel?: 1 | 2 | 3
  /** RFC 3161 TSA URL. Omit to skip. */
  tsaUrl?: string
}

export interface ActionStep {
  type: ActionStepType
  label: string
  options?: Record<string, unknown>
}

// Per-step OCR options. Not exported as OcrOptions to avoid a circular
// name (that lives in pdfOcr.ts). `scope` is fixed to 'all' for batch.
export type OcrStepOptions = Partial<Omit<OcrOptions, 'scope' | 'outputMode'>> & {
  outputMode?: Extract<OcrOptions['outputMode'], 'searchable' | 'clipboard' | 'newtab'>
}

// Prompt-step sentinel. `executeWorkflow` invokes the `onPrompt` callback
// and blocks until it resolves with either continue/cancel. Gives
// non-batch interactive flows a way to pause mid-chain.
export interface PromptStepResult { cancelled: boolean }

export interface ActionWorkflow {
  name: string
  steps: ActionStep[]
}

export interface WorkflowResult {
  success: boolean
  outputBytes: Uint8Array
  outputFormat: string    // 'pdf', 'docx', 'xlsx', 'pptx', 'txt'
  log: string[]
}

/** Execute a workflow on PDF bytes, returning the final result. The
 *  optional `onPrompt` callback is invoked for 'prompt' steps — the
 *  caller should show a modal and resolve with {cancelled} when the
 *  user responds. Omit it for fully-automated runs (prompts become
 *  no-ops). */
export async function executeWorkflow(
  bytes: Uint8Array,
  workflow: ActionWorkflow,
  onProgress?: (step: number, total: number, label: string) => void,
  onPrompt?: (label: string, message: string) => Promise<PromptStepResult>,
): Promise<WorkflowResult> {
  let current = bytes
  let format = 'pdf'
  const log: string[] = []

  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i]
    onProgress?.(i, workflow.steps.length, step.label)
    log.push(`Step ${i + 1}: ${step.label}...`)

    try {
      switch (step.type) {
        case 'compress':
          current = await compressPdf(current, step.options as any)
          log.push(`  Compressed: ${current.byteLength} bytes`)
          break
        case 'bates':
          current = await applyBatesNumbering(current, (step.options || {}) as BatesOptions)
          log.push(`  Bates numbering applied`)
          break
        case 'sanitize':
          current = await sanitizePdf(current, (step.options || {}) as SanitizeOptions)
          log.push(`  Sanitized`)
          break
        case 'flatten_transparency':
          current = await flattenTransparency(current, step.options as any)
          log.push(`  Transparency flattened`)
          break
        case 'to_word': {
          const r = await convertPdfHighFidelity(current, 'docx')
          current = r.bytes
          format = 'docx'
          log.push(`  Converted to Word (engine: ${r.engine}${r.libreOfficeVersion ? `, LO ${r.libreOfficeVersion}` : ''})`)
          break
        }
        case 'to_excel': {
          const r = await convertPdfHighFidelity(current, 'xlsx')
          current = r.bytes
          format = 'xlsx'
          log.push(`  Converted to Excel (engine: ${r.engine})`)
          break
        }
        case 'to_ppt': {
          const r = await convertPdfHighFidelity(current, 'pptx')
          current = r.bytes
          format = 'pptx'
          log.push(`  Converted to PowerPoint (engine: ${r.engine})`)
          break
        }
        case 'to_text': {
          const text = await pdfToText(current)
          current = new Uint8Array(new TextEncoder().encode(text))
          format = 'txt'
          log.push(`  Converted to text`)
          break
        }
        case 'to_image_only':
          current = await toImageOnlyPdf(current)
          log.push(`  Converted to image-only PDF`)
          break
        case 'ocr': {
          const o = (step.options || {}) as OcrStepOptions
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const pdfjs = await import('pdfjs-dist') as any
          const doc = await pdfjs.getDocument({ data: current.slice() }).promise
          const n = doc.numPages
          doc.destroy()
          const visible = Array.from({ length: n }, (_, i) => i)
          const res = await runOcr(current, visible, 0, {
            language: o.language ?? 'eng',
            scope: 'all',
            dpi: o.dpi ?? 300,
            outputMode: o.outputMode ?? 'searchable',
            autoRotate: o.autoRotate ?? true,
            deskew: o.deskew ?? true,
            autoDetectLanguage: o.autoDetectLanguage ?? false,
            suspectThreshold: o.suspectThreshold ?? 70,
          })
          if (o.outputMode === 'searchable' || o.outputMode === undefined) {
            current = await buildSearchablePdf(current, res.ocrPageData)
          } else if (o.outputMode === 'clipboard' || o.outputMode === 'newtab') {
            current = new Uint8Array(new TextEncoder().encode(res.fullText))
            format = 'txt'
          }
          log.push(`  OCR complete - ${res.ocrPageData.reduce((s, p) => s + p.words.length, 0)} words${res.suspects.length > 0 ? `, ${res.suspects.length} suspects` : ''}`)
          break
        }
        case 'sign': {
          const o = (step.options || {}) as Partial<SignStepOptions>
          if (!o.certB64 || !o.passphrase) {
            log.push('  ERROR: sign step requires certB64 + passphrase')
            return { success: false, outputBytes: current, outputFormat: format, log }
          }
          // base64 → Uint8Array. atob is safe in browser + Node 18+.
          const binary = atob(o.certB64)
          const p12 = new Uint8Array(binary.length)
          for (let i = 0; i < binary.length; i++) p12[i] = binary.charCodeAt(i)
          current = await signPdf(current, p12, o.passphrase, {
            reason: o.reason,
            location: o.location,
            signerName: o.signerName,
            contactInfo: o.contactInfo,
            certifyLevel: o.certifyLevel,
            tsaUrl: o.tsaUrl,
            appearance: o.appearance,
          })
          log.push(`  Signed${o.tsaUrl ? ' + TSA' : ''}${o.certifyLevel ? ` (certify L${o.certifyLevel})` : ''}`)
          break
        }
        case 'prompt': {
          if (onPrompt) {
            const msg = (step.options?.message as string) || step.label
            const r = await onPrompt(step.label, msg)
            if (r.cancelled) {
              log.push(`  Cancelled by user at prompt`)
              return { success: false, outputBytes: current, outputFormat: format, log }
            }
          }
          log.push(`  Prompt: ${step.label} (continued)`)
          break
        }
        default:
          log.push(`  Unknown step type: ${step.type} - skipped`)
      }
    } catch (err) {
      log.push(`  ERROR: ${(err as Error).message}`)
      return { success: false, outputBytes: current, outputFormat: format, log }
    }
  }

  onProgress?.(workflow.steps.length, workflow.steps.length, 'Done')
  log.push('Workflow complete.')
  return { success: true, outputBytes: current, outputFormat: format, log }
}

/** Preset workflows for common operations */
export const PRESET_WORKFLOWS: ActionWorkflow[] = [
  {
    name: 'Prepare for Distribution',
    steps: [
      { type: 'sanitize', label: 'Strip hidden data' },
      { type: 'compress', label: 'Optimize file size' },
    ]
  },
  {
    name: 'Prepare for Print',
    steps: [
      { type: 'flatten_transparency', label: 'Flatten transparency' },
      { type: 'compress', label: 'Optimize' },
    ]
  },
  {
    name: 'Archive (sanitize + compress + Bates)',
    steps: [
      { type: 'sanitize', label: 'Strip metadata & hidden data' },
      { type: 'bates', label: 'Apply Bates numbering', options: { prefix: 'ARCH-', digits: 6 } },
      { type: 'compress', label: 'Optimize' },
    ]
  },
  {
    name: 'OCR + Make Searchable',
    steps: [
      { type: 'ocr', label: 'OCR with auto-rotate + deskew', options: { autoRotate: true, deskew: true, outputMode: 'searchable' } },
    ]
  },
  {
    name: 'OCR + Sanitize + Compress (archive scanned docs)',
    steps: [
      { type: 'ocr', label: 'OCR with auto-rotate + deskew', options: { autoRotate: true, deskew: true, outputMode: 'searchable' } },
      { type: 'sanitize', label: 'Strip hidden data' },
      { type: 'compress', label: 'Optimize' },
    ]
  },
  // Gate-2 P3: copy must not imply a redaction-grade guarantee — this
  // preset strips DOCUMENT-level hidden data; it does NOT remove visible
  // page content. Redaction is its own verified tool.
  {
    name: 'Prep for Publication (sanitize + flatten + Bates - does NOT redact)',
    steps: [
      { type: 'sanitize', label: 'Strip metadata, JS, external refs (page content is NOT redacted)' },
      { type: 'flatten_transparency', label: 'Flatten transparency' },
      { type: 'bates', label: 'Apply Bates numbering', options: { prefix: 'PUB-', digits: 5 } },
      { type: 'compress', label: 'Optimize' },
    ]
  },
  {
    name: 'Optimize Only',
    steps: [
      { type: 'compress', label: 'Compress images + optimize streams' },
    ]
  },
  {
    name: 'Convert to Plain Text',
    steps: [
      { type: 'to_text', label: 'Extract text layer' },
    ]
  },
  {
    name: 'Pause for Review (example interactive chain)',
    steps: [
      { type: 'sanitize', label: 'Strip hidden data' },
      { type: 'prompt', label: 'Review sanitized output', options: { message: 'Check the file before continuing - click Continue to compress, or Cancel to stop.' } },
      { type: 'compress', label: 'Optimize' },
    ]
  },
]
