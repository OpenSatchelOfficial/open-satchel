import { useEffect, useState } from 'react'
import { useFormatStore } from '../../stores/formatStore'
import { useTabStore } from '../../stores/tabStore'
import type { PdfFormatState } from './index'
import { readMetadata, writeMetadata, stripMetadata } from '../../services/pdfOps'
import { readXmpCustomProps, writeXmpCustomProps, type XmpCustomProp } from '../../services/pdfMisc'

interface Props {
  tabId: string
  onClose: () => void
}

/** Direct metadata editor — title, author, subject, keywords, creator,
 *  producer, dates. Mirrors Acrobat's File > Properties > Description. */
export default function MetadataDialog({ tabId, onClose }: Props) {
  const state = useFormatStore((s) => s.data[tabId] as PdfFormatState | undefined)
  const [title, setTitle] = useState('')
  const [author, setAuthor] = useState('')
  const [subject, setSubject] = useState('')
  const [keywords, setKeywords] = useState('')
  const [creator, setCreator] = useState('')
  const [producer, setProducer] = useState('')
  const [creationDate, setCreationDate] = useState('')
  const [modificationDate, setModificationDate] = useState('')
  const [status, setStatus] = useState('')
  const [customProps, setCustomProps] = useState<XmpCustomProp[]>([])

  useEffect(() => {
    if (!state) return
    ;(async () => {
      const m = await readMetadata(state.pdfBytes)
      setTitle(m.title ?? '')
      setAuthor(m.author ?? '')
      setSubject(m.subject ?? '')
      setKeywords(m.keywords?.join(', ') ?? '')
      setCreator(m.creator ?? '')
      setProducer(m.producer ?? '')
      setCreationDate(m.creationDate ? toIsoLocal(m.creationDate) : '')
      setModificationDate(m.modificationDate ? toIsoLocal(m.modificationDate) : '')
      setCustomProps(await readXmpCustomProps(state.pdfBytes))
    })()
  }, [state?.pdfBytes])

  if (!state) return null

  const save = async () => {
    let updated = await writeMetadata(state.pdfBytes, {
      title, author, subject,
      keywords: keywords ? keywords.split(',').map((k) => k.trim()).filter(Boolean) : [],
      creator, producer,
      creationDate: creationDate ? new Date(creationDate) : undefined,
      modificationDate: modificationDate ? new Date(modificationDate) : new Date(),
    })
    // Valid props only (all three fields populated).
    const validCustom = customProps.filter((p) => p.namespace.trim() && p.name.trim())
    if (validCustom.length > 0 || customProps.length > 0) {
      updated = await writeXmpCustomProps(updated, validCustom)
    }
    useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({ ...prev, pdfBytes: updated }))
    useTabStore.getState().setTabDirty(tabId, true)
    setStatus(`Saved (${updated.byteLength.toLocaleString()} bytes).`)
  }

  const strip = async () => {
    const stripped = await stripMetadata(state.pdfBytes)
    useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({ ...prev, pdfBytes: stripped }))
    useTabStore.getState().setTabDirty(tabId, true)
    setTitle(''); setAuthor(''); setSubject(''); setKeywords('')
    setCreator(''); setProducer('')
    setStatus('All metadata stripped.')
  }

  return (
    <div
      data-testid="metadata-dialog"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: 'var(--bg-primary)', borderRadius: 8, padding: 20,
        border: '1px solid var(--border)', width: 480, maxHeight: '85vh', overflow: 'auto',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>Document Properties</h3>
          <button onClick={onClose} style={{
            background: 'transparent', border: 'none', color: 'var(--text-primary)',
            cursor: 'pointer', fontSize: 18,
          }}>✕</button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Field label="Title">
            <input data-testid="meta-title" style={inp} value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Author">
            <input data-testid="meta-author" style={inp} value={author} onChange={(e) => setAuthor(e.target.value)} />
          </Field>
          <Field label="Subject">
            <input data-testid="meta-subject" style={inp} value={subject} onChange={(e) => setSubject(e.target.value)} />
          </Field>
          <Field label="Keywords (comma-separated)">
            <input data-testid="meta-keywords" style={inp} value={keywords} onChange={(e) => setKeywords(e.target.value)} />
          </Field>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <Field label="Creator">
                <input data-testid="meta-creator" style={inp} value={creator} onChange={(e) => setCreator(e.target.value)} />
              </Field>
            </div>
            <div style={{ flex: 1 }}>
              <Field label="Producer">
                <input data-testid="meta-producer" style={inp} value={producer} onChange={(e) => setProducer(e.target.value)} />
              </Field>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <Field label="Created">
                <input data-testid="meta-created" type="datetime-local" style={inp}
                  value={creationDate} onChange={(e) => setCreationDate(e.target.value)} />
              </Field>
            </div>
            <div style={{ flex: 1 }}>
              <Field label="Modified">
                <input data-testid="meta-modified" type="datetime-local" style={inp}
                  value={modificationDate} onChange={(e) => setModificationDate(e.target.value)} />
              </Field>
            </div>
          </div>
        </div>

        <div style={{ marginTop: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <h4 style={{ margin: 0, fontSize: 12, color: 'var(--text-primary)' }}>Custom XMP properties</h4>
            <button
              data-testid="meta-custom-add"
              onClick={() => setCustomProps([...customProps, { namespace: '', prefix: '', name: '', value: '' }])}
              style={{ padding: '2px 8px', fontSize: 10, background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 2, color: 'var(--text-primary)', cursor: 'pointer' }}>
              + Add property
            </button>
          </div>
          {customProps.length === 0 ? (
            <div style={{ fontSize: 10, color: 'var(--text-muted)', padding: 6, border: '1px dashed var(--border)', borderRadius: 3 }}>
              No custom properties. Typical use: rights statements, internal IDs, compliance tags.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {customProps.map((p, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '1.2fr 0.5fr 1fr 2fr auto', gap: 4 }}>
                  <input placeholder="Namespace (URI)" style={{ ...inp, fontSize: 10 }}
                    value={p.namespace} onChange={(e) => { const np = [...customProps]; np[i] = { ...p, namespace: e.target.value }; setCustomProps(np) }} />
                  <input placeholder="Prefix" style={{ ...inp, fontSize: 10 }}
                    value={p.prefix} onChange={(e) => { const np = [...customProps]; np[i] = { ...p, prefix: e.target.value }; setCustomProps(np) }} />
                  <input placeholder="Name" style={{ ...inp, fontSize: 10 }}
                    value={p.name} onChange={(e) => { const np = [...customProps]; np[i] = { ...p, name: e.target.value }; setCustomProps(np) }} />
                  <input placeholder="Value" style={{ ...inp, fontSize: 10 }}
                    value={p.value} onChange={(e) => { const np = [...customProps]; np[i] = { ...p, value: e.target.value }; setCustomProps(np) }} />
                  <button onClick={() => setCustomProps(customProps.filter((_, j) => j !== i))}
                    style={{ padding: '2px 6px', fontSize: 10, background: 'transparent', border: '1px solid var(--border)', borderRadius: 2, color: 'var(--text-muted)', cursor: 'pointer' }}>✕</button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{
          marginTop: 10, padding: 8, background: 'var(--bg-surface)', borderRadius: 4,
          fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.4,
        }}>
          File size: {state.pdfBytes.byteLength.toLocaleString()} bytes · {state.pages.length} pages
        </div>

        {status && (
          <div data-testid="meta-status" style={{ marginTop: 8, fontSize: 11, color: 'var(--success)' }}>{status}</div>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 16 }}>
          <button data-testid="meta-strip" onClick={strip} style={btnDanger}>Strip all metadata</button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onClose} style={btnSecondary}>Cancel</button>
            <button data-testid="meta-save" onClick={save} style={btnPrimary}>Save</button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={{ fontSize: 11, color: 'var(--text-secondary)', display: 'block', marginBottom: 3 }}>{label}</label>
      {children}
    </div>
  )
}

function toIsoLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const inp: React.CSSProperties = {
  width: '100%', padding: '6px 8px', fontSize: 12,
  background: 'var(--bg-surface)', border: '1px solid var(--border)',
  borderRadius: 3, color: 'var(--text-primary)', boxSizing: 'border-box',
}

const btnPrimary: React.CSSProperties = {
  padding: '6px 16px', background: 'var(--accent)', color: 'var(--bg-primary)',
  border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 600,
}

const btnSecondary: React.CSSProperties = {
  padding: '6px 16px', background: 'var(--bg-surface)', color: 'var(--text-primary)',
  border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer', fontSize: 12,
}

const btnDanger: React.CSSProperties = {
  padding: '6px 16px', background: 'var(--danger)', color: '#fff',
  border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12,
}
