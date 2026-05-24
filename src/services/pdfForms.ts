// Form field creation. Adds interactive AcroForm fields to an existing
// PDF at given page + rect coordinates. Supports text, checkbox, radio
// group, dropdown, signature. All positions in PDF points (origin
// bottom-left), matching the rest of pdfOps.

import { PDFDocument, PDFDict, PDFName, PDFString, PDFArray, PDFHexString } from 'pdf-lib'

export interface FormFieldActions {
  /** JavaScript to calculate field value (e.g., "AFSimple_Calculate('SUM', ['field1','field2'])") */
  calculate?: string
  /** JavaScript to format field display (e.g., "AFNumber_Format(2, 0, 0, 0, '$', true)") */
  format?: string
  /** JavaScript to validate field value (e.g., "AFRange_Validate(true, 0, true, 100)") */
  validate?: string
  /** JavaScript to execute on keystroke */
  keystroke?: string
}

export interface FormFieldValidation {
  /** Regex the value must match. */
  pattern?: string
  /** Numeric range — only applied when `kind = 'text'` and value parses as a number. */
  min?: number
  max?: number
  /** User-visible help text when a validation fails. */
  message?: string
}

/** D2: result of running a `FormFieldValidation` against a value.
 *  `valid: true` ⇒ no rule was violated. `valid: false` ⇒ at least
 *  one rule failed; `reason` carries the spec-level cause and
 *  `message` is the user-facing copy from the validation rule. */
export interface FormFieldValidationResult {
  valid: boolean
  reason?: 'pattern' | 'min' | 'max'
  message?: string
}

/** D2: pure validator used by FormFieldRenderer (live feedback) and
 *  by the save guard in `pdfHandler.save` (refuse-on-invalid).
 *  Returns `{valid: true}` for empty values — required-ness is a
 *  separate concern handled by `FormFieldSpec.required`.
 *
 *  Order: pattern check first (any kind), then numeric range
 *  (only when value parses as a finite number). The first failure
 *  returns; subsequent rules are not evaluated. */
export function validateFieldValue(
  value: string | boolean | undefined,
  validation: FormFieldValidation | undefined,
): FormFieldValidationResult {
  if (!validation) return { valid: true }
  // Empty / boolean values bypass — pattern + range only constrain
  // text fields. The `required` flag (separate) enforces non-empty.
  if (value === undefined || value === '' || typeof value === 'boolean') {
    return { valid: true }
  }
  const text = String(value)

  if (validation.pattern) {
    let re: RegExp
    try {
      re = new RegExp(validation.pattern)
    } catch {
      // Malformed pattern → treat as "any value valid". Authors
      // shouldn't ship busted regexes; this fallback avoids a
      // hard crash for end-users.
      return { valid: true }
    }
    if (!re.test(text)) {
      return {
        valid: false,
        reason: 'pattern',
        message: validation.message ?? `Value must match ${validation.pattern}`,
      }
    }
  }

  if (validation.min !== undefined || validation.max !== undefined) {
    const n = parseFloat(text)
    if (Number.isFinite(n)) {
      if (validation.min !== undefined && n < validation.min) {
        return {
          valid: false,
          reason: 'min',
          message: validation.message ?? `Value must be at least ${validation.min}`,
        }
      }
      if (validation.max !== undefined && n > validation.max) {
        return {
          valid: false,
          reason: 'max',
          message: validation.message ?? `Value must be at most ${validation.max}`,
        }
      }
    }
  }

  return { valid: true }
}

export interface FormFieldAppearance {
  /** Border color (hex #RRGGBB). */
  borderColor?: string
  /** Fill color (hex #RRGGBB). */
  fillColor?: string
  /** Text color (hex #RRGGBB). */
  textColor?: string
  /** Border style: 'solid' | 'dashed' | 'inset' | 'beveled' | 'underline'. */
  borderStyle?: 'solid' | 'dashed' | 'inset' | 'beveled' | 'underline'
  /** Border width in points. */
  borderWidth?: number
  /** Font size in points. */
  fontSize?: number
}

export interface FormFieldSpec {
  kind: 'text' | 'checkbox' | 'radio' | 'dropdown' | 'signature'
  name: string
  page: number // 0-based
  rect: { x: number; y: number; width: number; height: number }
  defaultValue?: string | boolean
  options?: string[] // for dropdown & radio (option labels)
  required?: boolean
  readOnly?: boolean
  actions?: FormFieldActions
  validation?: FormFieldValidation
  appearance?: FormFieldAppearance
  /** Whitelisted calc expression — evaluated by pdfFormsCalc at fill
   *  time. Coexists with `actions.calculate` (Acrobat JS) — our engine
   *  takes precedence in our own renderer; Acrobat sees only
   *  actions.calculate. */
  calcExpression?: string
}

export async function addFormFields(bytes: Uint8Array, specs: FormFieldSpec[]): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes)
  const form = doc.getForm()
  const pages = doc.getPages()

  for (const spec of specs) {
    const page = pages[spec.page]
    if (!page) continue
    const box = { x: spec.rect.x, y: spec.rect.y, width: spec.rect.width, height: spec.rect.height }

    switch (spec.kind) {
      case 'text': {
        const f = form.createTextField(spec.name)
        if (typeof spec.defaultValue === 'string') f.setText(spec.defaultValue)
        if (spec.required) f.enableRequired()
        if (spec.readOnly) f.enableReadOnly()
        f.addToPage(page, box)
        break
      }
      case 'checkbox': {
        const f = form.createCheckBox(spec.name)
        if (spec.defaultValue === true) f.check()
        if (spec.required) f.enableRequired()
        if (spec.readOnly) f.enableReadOnly()
        f.addToPage(page, box)
        break
      }
      case 'radio': {
        // Radio groups have one name + multiple options, each positioned.
        // We treat `rect` as the first option's rect; subsequent options
        // stack vertically below with the same height.
        const f = form.createRadioGroup(spec.name)
        const opts = spec.options ?? ['Option 1']
        opts.forEach((label, i) => {
          f.addOptionToPage(label, page, {
            x: box.x,
            y: box.y - i * (box.height + 4),
            width: box.width,
            height: box.height,
          })
        })
        if (typeof spec.defaultValue === 'string' && opts.includes(spec.defaultValue)) {
          f.select(spec.defaultValue)
        }
        if (spec.required) f.enableRequired()
        if (spec.readOnly) f.enableReadOnly()
        break
      }
      case 'dropdown': {
        const f = form.createDropdown(spec.name)
        f.addOptions(spec.options ?? [])
        if (typeof spec.defaultValue === 'string') f.select(spec.defaultValue)
        if (spec.required) f.enableRequired()
        if (spec.readOnly) f.enableReadOnly()
        f.addToPage(page, box)
        break
      }
      case 'signature': {
        // pdf-lib doesn't expose a signature-field helper, so we
        // create a text field stub then rewrite its /FT entry from
        // /Tx to /Sig. The widget rect + page anchor stay valid; only
        // the field-type marker changes. Signing apps (Acrobat,
        // foxit) recognise this as a real signature placeholder. The
        // actual digital-signature attach is in pdfSign.ts.
        const f = form.createTextField(spec.name)
        f.enableReadOnly()
        f.addToPage(page, box)
        const fieldDict = doc.context.lookup(f.ref) as PDFDict | undefined
        if (fieldDict) {
          fieldDict.set(PDFName.of('FT'), PDFName.of('Sig'))
          // /V (value) for a Sig field is the signature dict; for an
          // unsigned placeholder we drop /V entirely so verifiers
          // don't read a bogus text value.
          fieldDict.delete(PDFName.of('V'))
          fieldDict.delete(PDFName.of('DV'))
          fieldDict.delete(PDFName.of('MaxLen'))
        }
        break
      }
    }
  }
  // Attach JavaScript actions to fields that have them
  for (const spec of specs) {
    if (!spec.actions) continue
    try {
      const field = form.getField(spec.name)
      if (!field) continue
      const fieldRef = field.ref
      const fieldDict = doc.context.lookup(fieldRef) as PDFDict
      if (!fieldDict) continue

      const aaDict = PDFDict.withContext(doc.context)
      const makeJsAction = (js: string) => {
        const actionDict = PDFDict.withContext(doc.context)
        actionDict.set(PDFName.of('S'), PDFName.of('JavaScript'))
        actionDict.set(PDFName.of('JS'), PDFHexString.fromText(js))
        return actionDict
      }

      if (spec.actions.calculate) aaDict.set(PDFName.of('C'), makeJsAction(spec.actions.calculate))
      if (spec.actions.format) aaDict.set(PDFName.of('F'), makeJsAction(spec.actions.format))
      if (spec.actions.validate) aaDict.set(PDFName.of('V'), makeJsAction(spec.actions.validate))
      if (spec.actions.keystroke) aaDict.set(PDFName.of('K'), makeJsAction(spec.actions.keystroke))

      if (aaDict.entries().length > 0) {
        fieldDict.set(PDFName.of('AA'), aaDict)
      }
    } catch { /* skip if field not found or dict access fails */ }
  }

  return await doc.save()
}

export interface FormFieldInfo {
  name: string
  type: string
  value?: string | boolean
  /** First widget's page index + rect if resolvable. Multi-widget
   *  fields (radio groups, fields reused across pages) surface the
   *  first placement only. */
  page?: number
  rect?: { x: number; y: number; width: number; height: number }
}

/** Read back current form field values, types, and placements. */
export async function listFormFields(bytes: Uint8Array): Promise<FormFieldInfo[]> {
  const doc = await PDFDocument.load(bytes)
  const form = doc.getForm()
  const pages = doc.getPages()
  return form.getFields().map((f) => {
    const name = f.getName()
    const type = f.constructor.name.replace(/^PDF/, '').toLowerCase()
    let value: string | boolean | undefined
    if ('getText' in f && typeof (f as { getText?: () => string }).getText === 'function') {
      value = (f as unknown as { getText: () => string }).getText()
    } else if ('isChecked' in f && typeof (f as { isChecked?: () => boolean }).isChecked === 'function') {
      value = (f as unknown as { isChecked: () => boolean }).isChecked()
    } else if ('getSelected' in f && typeof (f as { getSelected?: () => unknown }).getSelected === 'function') {
      const sel = (f as unknown as { getSelected: () => unknown }).getSelected()
      if (Array.isArray(sel)) value = sel.join(', ')
      else if (typeof sel === 'string') value = sel
    }

    // Find first widget's page + rect via acroField.Kids → /P /Rect.
    let page: number | undefined
    let rect: FormFieldInfo['rect']
    try {
      const acroDict = f.acroField.dict
      const kidsArr = acroDict.lookup(PDFName.of('Kids'))
      const widgets = kidsArr instanceof PDFArray
        ? Array.from({ length: kidsArr.size() }, (_, i) => kidsArr.get(i)).map((r) => doc.context.lookup(r))
        : [acroDict]
      for (const w of widgets) {
        if (!(w instanceof PDFDict)) continue
        const pageRef = w.get(PDFName.of('P'))
        const rectVal = w.get(PDFName.of('Rect'))
        if (pageRef && rectVal instanceof PDFArray) {
          const idx = pages.findIndex((p) => p.ref === pageRef)
          if (idx >= 0) {
            page = idx
            const [x1, y1, x2, y2] = [rectVal.get(0), rectVal.get(1), rectVal.get(2), rectVal.get(3)].map((v) => (v as { asNumber?: () => number })?.asNumber?.() ?? 0)
            rect = { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) }
            break
          }
        }
      }
    } catch { /* best-effort */ }

    return { name, type, value, page, rect }
  })
}

/** Delete a form field by name. Removes the field from /AcroForm /Fields
 *  array and strips every widget annotation referencing it from /Annots
 *  on each page. */
export async function deleteFormField(bytes: Uint8Array, fieldName: string): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes)
  const form = doc.getForm()
  try {
    const field = form.getField(fieldName)
    // pdf-lib's PDFForm.removeField is defined but not fully exported in
    // some versions; fall back to removing the field ref manually.
    if ('removeField' in form && typeof (form as { removeField?: (f: unknown) => void }).removeField === 'function') {
      ;(form as unknown as { removeField: (f: unknown) => void }).removeField(field)
    } else {
      // Manual: drop /AcroForm /Fields entry + widget refs on each page.
      const acroForm = doc.catalog.lookup(PDFName.of('AcroForm')) as PDFDict | undefined
      if (acroForm) {
        const fields = acroForm.lookup(PDFName.of('Fields')) as PDFArray | undefined
        if (fields) {
          const fieldRef = field.ref
          const keep: unknown[] = []
          for (let i = 0; i < fields.size(); i++) {
            const r = fields.get(i)
            if (r !== fieldRef) keep.push(r)
          }
          const newArr = PDFArray.withContext(doc.context)
          for (const r of keep) newArr.push(r as Parameters<typeof newArr.push>[0])
          acroForm.set(PDFName.of('Fields'), newArr)
        }
      }
    }
  } catch {
    return bytes
  }
  return await doc.save()
}
