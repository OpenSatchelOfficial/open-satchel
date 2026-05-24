import { useEffect, useState, useCallback, useRef } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { useFormatStore } from '../../stores/formatStore'
import { useTabStore } from '../../stores/tabStore'
import type { PdfFormatState } from './index'
import { tryEvaluateCalc, type CalcContext } from '../../services/pdfFormsCalc'
import { validateFieldValue, type FormFieldValidation } from '../../services/pdfForms'

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface FormFieldRendererProps {
  tabId: string
  pageIndex: number
  /** Already-loaded pdfjs document. Reusing it avoids the per-page
   *  `pdfjs.getDocument({ data: pdfBytes.slice() })` round-trip that
   *  was the dominant cause of heap pressure on heavy docs (32MB ×
   *  N pages = ~1GB peak). PageRenderer holds a single instance for
   *  the whole tab; passing it through is the right ownership shape. */
  pdfDoc: PDFDocumentProxy
  zoom: number
  pageWidth: number
  pageHeight: number
}

interface FormField {
  fieldName: string
  fieldType: 'Tx' | 'Btn' | 'Ch'
  fieldValue: string | boolean | null
  /** Per-widget on-state value. Different from `fieldValue` for radio
   *  groups: every radio in the group shares one fieldValue (the
   *  group's selection) but each widget has its own buttonValue (the
   *  on-state name written into /V when this specific button is
   *  selected). pdf.js exposes this as `ann.buttonValue` on individual
   *  Btn widgets. Used to give each radio in a group a unique testid. */
  buttonValue: string | null
  rect: number[]
  isCheckbox: boolean
  isRadioButton: boolean
  isMultiline: boolean
  options: Array<{ displayValue: string; exportValue: string }>
  radioGroupName: string | null
  pageHeightPts: number
}

export default function FormFieldRenderer({
  tabId,
  pageIndex,
  pdfDoc,
  zoom,
  pageWidth,
  pageHeight
}: FormFieldRendererProps) {
  const [fields, setFields] = useState<FormField[]>([])
  const loadIdRef = useRef(0)

  // Get current form values from the store
  const formValues = useFormatStore(
    (s) => (s.data[tabId] as PdfFormatState | undefined)?.pages[pageIndex]?.formValues
  )

  // D2: pull validations once per render. Empty / undefined → no
  // field is constrained, validateFieldValue returns valid:true on
  // every call (cheap no-op).
  const fieldValidations = useFormatStore(
    (s) => (s.data[tabId] as PdfFormatState | undefined)?.fieldValidations,
  ) as Record<string, FormFieldValidation> | undefined

  // Load annotations from the PDF page
  useEffect(() => {
    const currentLoadId = ++loadIdRef.current
    let cancelled = false

    const loadAnnotations = async () => {
      try {
        // Reuse the shared pdfjs doc from PageRenderer instead of
        // re-loading bytes per page (was the dominant heap-cost on
        // heavy docs).
        const page = await pdfDoc.getPage(pageIndex + 1)
        if (cancelled) { page.cleanup(); return }

        const viewport = page.getViewport({ scale: 1 })
        const pageHeightPts = viewport.height

        const annotations = await page.getAnnotations()
        if (cancelled) { page.cleanup(); return }

        const widgetFields: FormField[] = []
        for (const ann of annotations) {
          if (ann.subtype !== 'Widget') continue
          if (!ann.fieldName) continue

          const fieldType = ann.fieldType as 'Tx' | 'Btn' | 'Ch'
          if (!['Tx', 'Btn', 'Ch'].includes(fieldType)) continue

          widgetFields.push({
            fieldName: ann.fieldName,
            fieldType,
            fieldValue: ann.fieldValue ?? null,
            buttonValue: typeof ann.buttonValue === 'string' ? ann.buttonValue : null,
            rect: ann.rect,
            isCheckbox: !!ann.checkBox,
            isRadioButton: !!ann.radioButton,
            isMultiline: !!(ann.multiLine),
            options: (ann.options || []).map((opt: any) => ({
              displayValue: typeof opt === 'string' ? opt : (opt.displayValue || opt.exportValue || ''),
              exportValue: typeof opt === 'string' ? opt : (opt.exportValue || opt.displayValue || '')
            })),
            radioGroupName: ann.radioButton ? ann.fieldName : null,
            pageHeightPts
          })
        }

        if (!cancelled && currentLoadId === loadIdRef.current) {
          setFields(widgetFields)
        }

        page.cleanup()
        // pdfDoc is owned by PageRenderer/PdfViewer — do NOT destroy.
      } catch (err) {
        console.error('Failed to load form annotations:', err)
      }
    }

    // Defer past first-paint with a 50ms setTimeout. Simpler than
    // requestIdleCallback (which had cross-WebView2 reliability issues
    // when the cancel ran before the doc destroyed).
    const handle = window.setTimeout(() => { void loadAnnotations() }, 50)
    return () => {
      cancelled = true
      window.clearTimeout(handle)
    }
  }, [pdfDoc, pageIndex])

  const updateField = useCallback(
    (fieldName: string, value: string | boolean) => {
      useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => {
        // 1. Apply the user's direct edit first.
        const nextPages = prev.pages.map((p, i) =>
          i === pageIndex
            ? { ...p, formValues: { ...(p.formValues || {}), [fieldName]: value } }
            : p,
        )

        // 2. B6: re-evaluate any calc expression that depends on this
        // field. Build a flat field-name → current-value snapshot
        // across ALL pages (forms span pages — calc on page 2 can
        // reference fields on page 1), then run calc for every entry
        // in fieldCalcExpressions whose body references the changed
        // field via {fieldName}. Cycle protection: cap iterations at
        // 8 — covers transitive deps like total ← sum(line items) ←
        // qty * unit price without infinite-looping on circular
        // references.
        const calcMap = prev.fieldCalcExpressions
        if (!calcMap || Object.keys(calcMap).length === 0) {
          return { ...prev, pages: nextPages }
        }

        let pages = nextPages
        for (let pass = 0; pass < 8; pass++) {
          const fields: CalcContext['fields'] = {}
          for (const p of pages) {
            const vals = p.formValues || {}
            for (const [k, v] of Object.entries(vals)) fields[k] = v
          }
          let mutated = false
          for (const [calcField, expression] of Object.entries(calcMap)) {
            // Quick filter: only re-evaluate calcs that mention the
            // just-changed field OR any field whose value moved on the
            // previous pass. The ${name} regex is purely structural —
            // matches the {name} field-ref token from pdfFormsCalc's
            // grammar.
            if (!new RegExp(`\\{${escapeRegex(fieldName)}\\}`).test(expression)
                && pass === 0) {
              // First pass: only evaluate calcs that depend on the
              // user's just-edited field. Subsequent passes cover
              // transitive chains.
              continue
            }
            const result = tryEvaluateCalc(expression, { fields })
            if (result === undefined) continue
            const nextValue: string | boolean = typeof result === 'boolean' ? result : String(result)
            const oldValue = fields[calcField]
            if (String(oldValue ?? '') === String(nextValue)) continue
            // Write the calc result onto the page that hosts the calc
            // field. We don't know which page that is — calcs can
            // reference fields cross-page. Walk pages and update the
            // first one that already has this field name in formValues
            // OR has no entry yet (defaults to current active page).
            let targetPageIdx = pageIndex
            for (let i = 0; i < pages.length; i++) {
              if (pages[i].formValues && (pages[i].formValues as Record<string, unknown>)[calcField] !== undefined) {
                targetPageIdx = i
                break
              }
            }
            pages = pages.map((p, i) =>
              i === targetPageIdx
                ? { ...p, formValues: { ...(p.formValues || {}), [calcField]: nextValue } }
                : p,
            )
            mutated = true
          }
          if (!mutated) break
        }

        return { ...prev, pages }
      })
      useTabStore.getState().setTabDirty(tabId, true)
    },
    [tabId, pageIndex],
  )

  if (fields.length === 0) return null

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: pageWidth,
        height: pageHeight,
        pointerEvents: 'none',
        zIndex: 1
      }}
    >
      {fields.map((field) => {
        const cssX = field.rect[0] * zoom
        const cssY = (field.pageHeightPts - field.rect[3]) * zoom
        const cssWidth = (field.rect[2] - field.rect[0]) * zoom
        const cssHeight = (field.rect[3] - field.rect[1]) * zoom

        // Determine current value: store override > original PDF value
        const storeValue = formValues?.[field.fieldName]
        const currentValue = storeValue !== undefined ? storeValue : field.fieldValue

        const fieldStyle: React.CSSProperties = {
          position: 'absolute',
          left: cssX,
          top: cssY,
          width: cssWidth,
          height: cssHeight,
          pointerEvents: 'auto',
          boxSizing: 'border-box',
          border: 'none',
          outline: 'none',
          background: 'rgba(173, 216, 255, 0.2)',
          padding: '1px 2px',
          margin: 0,
          fontFamily: 'sans-serif',
          fontSize: `${Math.max(8, Math.min(cssHeight * 0.7, 16 * zoom))}px`,
          color: '#000',
          transition: 'background 0.15s, box-shadow 0.15s'
        }

        // D2: live-validate the current value against any rule the
        // Form Designer attached to this field. Invalid values get
        // a red border + aria-invalid + the message as tooltip.
        const validationRule = fieldValidations?.[field.fieldName]
        const validationResult = validateFieldValue(
          currentValue as string | boolean | undefined,
          validationRule,
        )
        const validatedFieldStyle: React.CSSProperties = !validationResult.valid
          ? {
              ...fieldStyle,
              outline: '2px solid #d32f2f',
              outlineOffset: -1,
              background: 'rgba(211, 47, 47, 0.08)',
            }
          : fieldStyle

        if (field.fieldType === 'Tx') {
          if (field.isMultiline) {
            return (
              <textarea
                key={field.fieldName}
                style={{
                  ...validatedFieldStyle,
                  resize: 'none',
                  overflow: 'hidden'
                }}
                className="pdf-form-field"
                data-testid={`form-${field.fieldName}`}
                data-field-name={field.fieldName}
                data-field-type="text-multiline"
                aria-invalid={!validationResult.valid || undefined}
                title={validationResult.message}
                value={(currentValue as string) || ''}
                onChange={(e) => updateField(field.fieldName, e.target.value)}
              />
            )
          }
          return (
            <input
              key={field.fieldName}
              type="text"
              style={validatedFieldStyle}
              className="pdf-form-field"
              data-testid={`form-${field.fieldName}`}
              data-field-name={field.fieldName}
              data-field-type="text"
              aria-invalid={!validationResult.valid || undefined}
              title={validationResult.message}
              value={(currentValue as string) || ''}
              onChange={(e) => updateField(field.fieldName, e.target.value)}
            />
          )
        }

        if (field.fieldType === 'Btn') {
          if (field.isCheckbox) {
            const checked = typeof currentValue === 'boolean' ? currentValue : currentValue === 'Yes' || currentValue === 'On'
            return (
              <div
                key={field.fieldName}
                style={{
                  ...fieldStyle,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer'
                }}
                className="pdf-form-field"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  data-testid={`form-${field.fieldName}`}
                  data-field-name={field.fieldName}
                  data-field-type="checkbox"
                  onChange={(e) => updateField(field.fieldName, e.target.checked)}
                  style={{
                    width: Math.min(cssWidth, cssHeight) * 0.8,
                    height: Math.min(cssWidth, cssHeight) * 0.8,
                    margin: 0,
                    cursor: 'pointer',
                    accentColor: '#3b82f6'
                  }}
                />
              </div>
            )
          }

          if (field.isRadioButton) {
            const radioValue = typeof currentValue === 'string' ? currentValue : ''
            // pdfjs reports `buttonValue` as the per-widget appearance
            // state index ("0", "1", ...) but pd-lib's
            // RadioGroup.select(option) wants the option's export
            // value (e.g. "pro"). Resolve via `field.options` lookup;
            // fall back to buttonValue itself when options is empty
            // (some hand-crafted PDFs work this way) [B16].
            const idx = field.buttonValue !== null ? Number(field.buttonValue) : NaN
            const exportValue =
              !Number.isNaN(idx) && field.options[idx]?.exportValue
                ? field.options[idx].exportValue
                : field.buttonValue ?? ''
            return (
              <div
                key={field.fieldName + '-' + field.rect.join(',')}
                style={{
                  ...fieldStyle,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer'
                }}
                className="pdf-form-field"
              >
                <input
                  type="radio"
                  name={`radio-${tabId}-${pageIndex}-${field.fieldName}`}
                  checked={!!exportValue && radioValue === exportValue}
                  data-testid={`form-${field.fieldName}-${exportValue || 'on'}`}
                  data-field-name={field.fieldName}
                  data-field-type="radio"
                  data-field-option={exportValue}
                  onChange={() => {
                    // Sets the GROUP's value to THIS widget's export
                    // value. Re-clicking is a no-op — radios are
                    // mutually exclusive, deselecting requires a
                    // separate "clear" affordance the spec doesn't
                    // standardise.
                    if (exportValue) {
                      updateField(field.fieldName, exportValue)
                    }
                  }}
                  style={{
                    width: Math.min(cssWidth, cssHeight) * 0.8,
                    height: Math.min(cssWidth, cssHeight) * 0.8,
                    margin: 0,
                    cursor: 'pointer',
                    accentColor: '#3b82f6'
                  }}
                />
              </div>
            )
          }

          // Push button - render as a non-interactive visual indicator
          return null
        }

        if (field.fieldType === 'Ch') {
          return (
            <select
              key={field.fieldName}
              style={{
                ...fieldStyle,
                cursor: 'pointer',
                // Native appearance cast: React CSSProperties narrows to
                // the specific appearance keywords; 'auto' is valid at
                // runtime and restores OS default styling for date inputs.
                WebkitAppearance: 'auto' as unknown as React.CSSProperties['WebkitAppearance']
              }}
              className="pdf-form-field"
              data-testid={`form-${field.fieldName}`}
              data-field-name={field.fieldName}
              data-field-type="dropdown"
              value={(currentValue as string) || ''}
              onChange={(e) => updateField(field.fieldName, e.target.value)}
            >
              <option value="">--</option>
              {field.options.map((opt, idx) => (
                <option key={idx} value={opt.exportValue}>
                  {opt.displayValue}
                </option>
              ))}
            </select>
          )
        }

        return null
      })}

      <style>{`
        .pdf-form-field:hover {
          background: rgba(173, 216, 255, 0.35) !important;
        }
        .pdf-form-field:focus,
        .pdf-form-field:focus-within {
          background: rgba(173, 216, 255, 0.3) !important;
          box-shadow: 0 0 0 1.5px #3b82f6 !important;
          outline: none !important;
        }
      `}</style>
    </div>
  )
}
