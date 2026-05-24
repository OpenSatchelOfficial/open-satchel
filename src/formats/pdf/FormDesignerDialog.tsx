import { useEffect, useState } from 'react'
import { useFormatStore } from '../../stores/formatStore'
import { useTabStore } from '../../stores/tabStore'
import { useUIStore } from '../../stores/uiStore'
import type { PdfFormatState } from './index'
import { addFormFields, listFormFields, deleteFormField, type FormFieldSpec, type FormFieldInfo } from '../../services/pdfForms'
import { flattenForm } from '../../services/pdfOps'

interface Props {
  tabId: string
  onClose: () => void
}

type FieldKind = FormFieldSpec['kind']

/** Build AcroForm fields — text, checkbox, radio, dropdown, signature.
 *  Lists existing fields with delete + jump-to-page, exposes a "Add
 *  field" form for new placements, supports "Flatten all fields" to
 *  convert interactivity into static page content. */
export default function FormDesignerDialog({ tabId, onClose }: Props) {
  const state = useFormatStore((s) => s.data[tabId] as PdfFormatState | undefined)
  const setCurrentPage = useUIStore((s) => s.setCurrentPage)
  const [fields, setFields] = useState<FormFieldInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState('')

  // New-field form
  const [kind, setKind] = useState<FieldKind>('text')
  const [name, setName] = useState('field1')
  const [page, setPage] = useState(1)
  const [x, setX] = useState(100)
  const [y, setY] = useState(700)
  const [width, setWidth] = useState(200)
  const [height, setHeight] = useState(24)
  const [defaultValue, setDefaultValue] = useState('')
  const [optionsText, setOptionsText] = useState('Option 1\nOption 2')
  const [required, setRequired] = useState(false)
  const [readOnly, setReadOnly] = useState(false)

  const reload = async () => {
    if (!state) return
    setLoading(true)
    try {
      const list = await listFormFields(state.pdfBytes)
      setFields(list)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void reload() }, [state?.pdfBytes])

  if (!state) return null

  const totalPages = state.pages.filter((p) => !p.deleted).length

  const addField = async () => {
    setStatus('Adding field…')
    const spec: FormFieldSpec = {
      kind,
      name,
      page: Math.max(0, Math.min(totalPages - 1, page - 1)),
      rect: { x, y, width, height },
      defaultValue: kind === 'checkbox' ? defaultValue.toLowerCase() === 'true' : defaultValue,
      options: (kind === 'dropdown' || kind === 'radio')
        ? optionsText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
        : undefined,
      required, readOnly,
    }
    try {
      const bytes = await addFormFields(state.pdfBytes, [spec])
      useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({ ...prev, pdfBytes: bytes }))
      useTabStore.getState().setTabDirty(tabId, true)
      setStatus(`Added "${name}" (${kind}) on page ${page}.`)
      setName((n) => nextFieldName(n))
      await reload()
    } catch (e) {
      setStatus(e instanceof Error ? `Error: ${e.message}` : 'Failed')
    }
  }

  const removeField = async (fieldName: string) => {
    setStatus(`Deleting ${fieldName}…`)
    try {
      const bytes = await deleteFormField(state.pdfBytes, fieldName)
      useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({ ...prev, pdfBytes: bytes }))
      useTabStore.getState().setTabDirty(tabId, true)
      setStatus(`Deleted "${fieldName}".`)
      await reload()
    } catch (e) {
      setStatus(e instanceof Error ? `Error: ${e.message}` : 'Failed')
    }
  }

  const flattenAll = async () => {
    setStatus('Flattening form fields…')
    try {
      const bytes = await flattenForm(state.pdfBytes)
      useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({ ...prev, pdfBytes: bytes }))
      useTabStore.getState().setTabDirty(tabId, true)
      setStatus('All form fields flattened into page content.')
      await reload()
    } catch (e) {
      setStatus(e instanceof Error ? `Error: ${e.message}` : 'Failed')
    }
  }

  const jumpTo = (pageIdx: number) => {
    const visible = state.pages.filter((p) => !p.deleted)
    const idx = visible.findIndex((_, i) => i === pageIdx)
    if (pageIdx < visible.length) {
      setCurrentPage(pageIdx)
      const el = document.querySelector(`[data-page-display-index="${pageIdx}"]`) as HTMLElement | null
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
    void idx
  }

  return (
    <div
      data-testid="form-designer-dialog"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: 'var(--bg-primary)', borderRadius: 8, padding: 20,
        border: '1px solid var(--border)', width: '78vw', maxWidth: 860,
        maxHeight: '85vh', display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>Form Designer</h3>
          <button onClick={onClose} style={{ background:'transparent', border:'none', color:'var(--text-primary)', cursor:'pointer', fontSize:18 }}>✕</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 10, flex: 1, minHeight: 0 }}>
          {/* Existing fields list */}
          <div style={{
            border: '1px solid var(--border)', borderRadius: 4, padding: 8,
            display: 'flex', flexDirection: 'column', gap: 4, overflowY: 'auto',
          }}>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Existing fields ({fields.length})
            </div>
            {loading ? (
              <div style={{ padding: 12, fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>Loading…</div>
            ) : fields.length === 0 ? (
              <div style={{ padding: 12, fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>
                No form fields. Use the form on the right to add one.
              </div>
            ) : (
              fields.map((f, i) => (
                <div key={i} data-testid={`field-${i}`}
                  style={{
                    padding: 6, borderRadius: 3,
                    background: 'var(--bg-surface)', border: '1px solid var(--border)',
                  }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 2, background: 'var(--bg-primary)', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                      {f.type}
                    </span>
                    <span style={{ flex: 1, fontSize: 11, fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {f.name}
                    </span>
                    {f.page !== undefined && (
                      <button data-testid={`field-jump-${i}`} onClick={() => jumpTo(f.page!)}
                        style={smBtn}>p{f.page + 1}</button>
                    )}
                    <button data-testid={`field-del-${i}`} onClick={() => removeField(f.name)}
                      style={{ ...smBtn, color: 'var(--danger)' }}>✕</button>
                  </div>
                  {f.rect && (
                    <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 2, fontFamily: 'monospace' }}>
                      {Math.round(f.rect.x)},{Math.round(f.rect.y)} · {Math.round(f.rect.width)}×{Math.round(f.rect.height)} pt
                      {f.value !== undefined && ` · "${String(f.value).slice(0, 30)}"`}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>

          {/* Add-field form */}
          <div style={{
            border: '1px solid var(--border)', borderRadius: 4, padding: 8,
            display: 'flex', flexDirection: 'column', gap: 6, overflowY: 'auto',
          }}>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
              New field
            </div>

            <Field label="Type">
              <select data-testid="new-field-kind" value={kind}
                onChange={(e) => setKind(e.target.value as FieldKind)} style={inp}>
                <option value="text">Text</option>
                <option value="checkbox">Checkbox</option>
                <option value="radio">Radio group</option>
                <option value="dropdown">Dropdown</option>
                <option value="signature">Signature (read-only stub)</option>
              </select>
            </Field>

            <Field label="Name">
              <input data-testid="new-field-name" value={name} onChange={(e) => setName(e.target.value)} style={inp} />
            </Field>

            <div style={{ display: 'flex', gap: 6 }}>
              <Field label="Page">
                <input data-testid="new-field-page" type="number" min={1} max={totalPages} value={page}
                  onChange={(e) => setPage(Number(e.target.value))} style={{ ...inp, width: 60 }} />
              </Field>
              <Field label="X">
                <input type="number" value={x} onChange={(e) => setX(Number(e.target.value))} style={{ ...inp, width: 70 }} />
              </Field>
              <Field label="Y (from bottom)">
                <input type="number" value={y} onChange={(e) => setY(Number(e.target.value))} style={{ ...inp, width: 70 }} />
              </Field>
            </div>

            <div style={{ display: 'flex', gap: 6 }}>
              <Field label="Width">
                <input type="number" value={width} onChange={(e) => setWidth(Number(e.target.value))} style={{ ...inp, width: 80 }} />
              </Field>
              <Field label="Height">
                <input type="number" value={height} onChange={(e) => setHeight(Number(e.target.value))} style={{ ...inp, width: 80 }} />
              </Field>
            </div>

            <Field label={kind === 'checkbox' ? 'Default checked (true/false)' : 'Default value'}>
              <input data-testid="new-field-default" value={defaultValue} onChange={(e) => setDefaultValue(e.target.value)} style={inp} />
            </Field>

            {(kind === 'dropdown' || kind === 'radio') && (
              <Field label="Options (one per line)">
                <textarea data-testid="new-field-options" value={optionsText}
                  onChange={(e) => setOptionsText(e.target.value)}
                  style={{ ...inp, minHeight: 50, resize: 'vertical', fontFamily: 'inherit' }} />
              </Field>
            )}

            <div style={{ display: 'flex', gap: 10, fontSize: 11, color: 'var(--text-secondary)' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} /> Required
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} /> Read-only
              </label>
            </div>

            <button data-testid="new-field-add" onClick={addField}
              style={{ ...btnPrimary, marginTop: 4 }}>Add field</button>
          </div>
        </div>

        {status && (
          <div data-testid="form-status" style={{
            marginTop: 10, padding: 6, background: 'var(--bg-surface)', borderRadius: 3,
            fontSize: 11, color: 'var(--text-primary)',
          }}>{status}</div>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12 }}>
          <button data-testid="flatten-all" onClick={flattenAll} disabled={fields.length === 0}
            style={{ ...btnSecondary, opacity: fields.length === 0 ? 0.5 : 1 }}>
            Flatten all fields
          </button>
          <button data-testid="form-designer-close" onClick={onClose} style={btnSecondary}>Close</button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={{ fontSize: 10, color: 'var(--text-secondary)', display: 'block', marginBottom: 2 }}>{label}</label>
      {children}
    </div>
  )
}

function nextFieldName(n: string): string {
  const m = /^(.*?)(\d+)$/.exec(n)
  if (!m) return n + '1'
  return `${m[1]}${parseInt(m[2], 10) + 1}`
}

const inp: React.CSSProperties = {
  width: '100%', padding: '4px 6px', fontSize: 11,
  background: 'var(--bg-surface)', border: '1px solid var(--border)',
  borderRadius: 3, color: 'var(--text-primary)', boxSizing: 'border-box',
}
const btnPrimary: React.CSSProperties = {
  padding: '6px 12px', background: 'var(--accent)', color: 'var(--bg-primary)',
  border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600,
}
const btnSecondary: React.CSSProperties = {
  padding: '6px 14px', background: 'var(--bg-surface)', color: 'var(--text-primary)',
  border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer', fontSize: 11,
}
const smBtn: React.CSSProperties = {
  padding: '2px 6px', fontSize: 9, borderRadius: 2,
  background: 'var(--bg-primary)', color: 'var(--text-primary)',
  border: '1px solid var(--border)', cursor: 'pointer',
}
