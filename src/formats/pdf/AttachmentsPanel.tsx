import { useEffect, useState } from 'react'
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFHexString, PDFString, PDFRawStream, PDFRef } from 'pdf-lib'
import { useFormatStore } from '../../stores/formatStore'
import { useTabStore } from '../../stores/tabStore'
import type { PdfFormatState } from './index'
import { addAttachments } from '../../services/pdfOps'

interface Props {
  tabId: string
}

interface AttachmentEntry {
  name: string
  size: number
  description?: string
  mimeType?: string
  bytes?: Uint8Array
}

/** Attachments panel — list embedded files in the PDF (/EmbeddedFiles
 *  name tree), add new ones, extract to disk, and remove. Mirrors
 *  Acrobat's Attachments panel. */
export default function AttachmentsPanel({ tabId }: Props) {
  const state = useFormatStore((s) => s.data[tabId] as PdfFormatState | undefined)
  const [items, setItems] = useState<AttachmentEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState('')

  const load = async () => {
    if (!state) return
    setLoading(true)
    try {
      const list = await listEmbeddedFiles(state.pdfBytes)
      setItems(list)
    } catch {
      setItems([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [state?.pdfBytes])

  if (!state) return null

  const extract = async (item: AttachmentEntry) => {
    if (!item.bytes) return
    ;(globalThis as unknown as { __lastSavedName?: string }).__lastSavedName = item.name
    await window.api.file.saveAs(item.bytes)
    setStatus(`Extracted ${item.name}.`)
  }

  const removeItem = async (name: string) => {
    try {
      const next = await removeEmbeddedFile(state.pdfBytes, name)
      useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({ ...prev, pdfBytes: next }))
      useTabStore.getState().setTabDirty(tabId, true)
      setStatus(`Removed ${name}.`)
      await load()
    } catch (e) {
      setStatus(e instanceof Error ? `Error: ${e.message}` : 'Remove failed')
    }
  }

  const addFile = async () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.onchange = async () => {
      const files = input.files ? Array.from(input.files) : []
      if (files.length === 0) return
      setStatus(`Embedding ${files.length} file${files.length === 1 ? '' : 's'}…`)
      try {
        const payloads = await Promise.all(files.map(async (f) => ({
          name: f.name,
          bytes: new Uint8Array(await f.arrayBuffer()),
          mimeType: f.type || undefined,
        })))
        const next = await addAttachments(state.pdfBytes, payloads)
        useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({ ...prev, pdfBytes: next }))
        useTabStore.getState().setTabDirty(tabId, true)
        setStatus(`Added ${files.length} attachment${files.length === 1 ? '' : 's'}.`)
        await load()
      } catch (e) {
        setStatus(e instanceof Error ? `Error: ${e.message}` : 'Add failed')
      }
    }
    input.click()
  }

  return (
    <div
      data-testid="attachments-panel"
      style={{
        display: 'flex', flexDirection: 'column', height: '100%',
        padding: 6, gap: 4,
      }}>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <button data-testid="att-add" onClick={addFile} style={panelBtnPrimary}>+ Attach file…</button>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{items.length} file{items.length === 1 ? '' : 's'}</span>
      </div>

      {status && (
        <div data-testid="att-status" style={{
          fontSize: 10, padding: '4px 6px', borderRadius: 3,
          background: 'var(--bg-surface)', color: 'var(--text-secondary)',
        }}>{status}</div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', padding: 2 }}>
        {loading ? (
          <div style={{ padding: 12, fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>
            Loading…
          </div>
        ) : items.length === 0 ? (
          <div style={{ padding: 12, fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>
            No attachments.<br />Click “+ Attach file” to embed one.
          </div>
        ) : (
          items.map((item, i) => (
            <div key={i} data-testid={`att-row-${i}`}
              style={{
                padding: 6, marginBottom: 2, borderRadius: 3,
                border: '1px solid var(--border)',
                background: 'var(--bg-surface)',
              }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{
                  flex: 1, fontSize: 11, fontWeight: 500,
                  color: 'var(--text-primary)', overflow: 'hidden',
                  textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{item.name}</span>
                <button
                  data-testid={`att-extract-${i}`}
                  onClick={() => extract(item)}
                  disabled={!item.bytes}
                  style={panelBtnSmall}
                  title="Extract to disk">⬇</button>
                <button
                  data-testid={`att-remove-${i}`}
                  onClick={() => removeItem(item.name)}
                  style={{ ...panelBtnSmall, color: 'var(--danger)' }}
                  title="Remove">✕</button>
              </div>
              <div style={{ display: 'flex', gap: 6, fontSize: 9, color: 'var(--text-muted)', marginTop: 2 }}>
                <span>{formatSize(item.size)}</span>
                {item.mimeType && <span>· {item.mimeType}</span>}
              </div>
              {item.description && (
                <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 2 }}>
                  {item.description}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

// ---------- PDF /EmbeddedFiles walker ----------

async function listEmbeddedFiles(bytes: Uint8Array): Promise<AttachmentEntry[]> {
  const doc = await PDFDocument.load(bytes)
  const out: AttachmentEntry[] = []

  const resolveRef = (v: unknown): unknown => v instanceof PDFRef ? doc.context.lookup(v) : v

  const catalog = doc.catalog
  const names = resolveRef(catalog.get(PDFName.of('Names'))) as PDFDict | undefined
  if (!names) return out
  const embeddedFiles = resolveRef(names.get(PDFName.of('EmbeddedFiles'))) as PDFDict | undefined
  if (!embeddedFiles) return out

  const walkNameTree = (node: PDFDict) => {
    const namesArr = resolveRef(node.get(PDFName.of('Names'))) as PDFArray | undefined
    if (namesArr) {
      const size = namesArr.size()
      for (let i = 0; i + 1 < size; i += 2) {
        const key = namesArr.get(i)
        const val = resolveRef(namesArr.get(i + 1))
        let name = ''
        if (key instanceof PDFString) name = key.asString()
        else if (key instanceof PDFHexString) name = key.decodeText()

        if (val instanceof PDFDict) {
          const ef = resolveRef(val.get(PDFName.of('EF'))) as PDFDict | undefined
          if (!ef) continue
          const fileSpec = resolveRef(ef.get(PDFName.of('F'))) as PDFRawStream | undefined
          if (!(fileSpec instanceof PDFRawStream)) continue
          const bytes = fileSpec.contents
          const size = bytes?.length ?? 0
          const descVal = val.get(PDFName.of('Desc'))
          let description: string | undefined
          if (descVal instanceof PDFString) description = descVal.asString()
          else if (descVal instanceof PDFHexString) description = descVal.decodeText()
          const mimeVal = fileSpec.dict.get(PDFName.of('Subtype'))
          const mimeType = mimeVal ? mimeVal.toString().replace(/^\//, '').replace(/#2F/g, '/') : undefined
          out.push({ name, size, description, mimeType, bytes })
        }
      }
    }
    const kids = resolveRef(node.get(PDFName.of('Kids'))) as PDFArray | undefined
    if (kids) {
      for (let i = 0; i < kids.size(); i++) {
        const kid = resolveRef(kids.get(i))
        if (kid instanceof PDFDict) walkNameTree(kid)
      }
    }
  }

  walkNameTree(embeddedFiles)
  return out
}

async function removeEmbeddedFile(bytes: Uint8Array, nameToRemove: string): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes)
  const resolveRef = (v: unknown): unknown => v instanceof PDFRef ? doc.context.lookup(v) : v

  const catalog = doc.catalog
  const names = resolveRef(catalog.get(PDFName.of('Names'))) as PDFDict | undefined
  if (!names) return await doc.save()
  const embeddedFiles = resolveRef(names.get(PDFName.of('EmbeddedFiles'))) as PDFDict | undefined
  if (!embeddedFiles) return await doc.save()

  const removeFromTree = (node: PDFDict) => {
    const namesArr = resolveRef(node.get(PDFName.of('Names'))) as PDFArray | undefined
    if (namesArr) {
      const kept: Array<unknown> = []
      const size = namesArr.size()
      for (let i = 0; i + 1 < size; i += 2) {
        const key = namesArr.get(i)
        let name = ''
        if (key instanceof PDFString) name = key.asString()
        else if (key instanceof PDFHexString) name = key.decodeText()
        if (name !== nameToRemove) {
          kept.push(namesArr.get(i))
          kept.push(namesArr.get(i + 1))
        }
      }
      const newArr = PDFArray.withContext(doc.context)
      for (const v of kept) newArr.push(v as Parameters<typeof newArr.push>[0])
      node.set(PDFName.of('Names'), newArr)
    }
    const kids = resolveRef(node.get(PDFName.of('Kids'))) as PDFArray | undefined
    if (kids) {
      for (let i = 0; i < kids.size(); i++) {
        const kid = resolveRef(kids.get(i))
        if (kid instanceof PDFDict) removeFromTree(kid)
      }
    }
  }

  removeFromTree(embeddedFiles)
  return await doc.save()
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

const panelBtnPrimary: React.CSSProperties = {
  padding: '3px 10px', fontSize: 10, borderRadius: 3,
  background: 'var(--accent)', color: 'var(--bg-primary)',
  border: 'none', cursor: 'pointer', fontWeight: 600,
}
const panelBtnSmall: React.CSSProperties = {
  width: 20, height: 20, padding: 0, fontSize: 10,
  background: 'transparent', border: 'none',
  color: 'var(--text-primary)', cursor: 'pointer', borderRadius: 2,
}
