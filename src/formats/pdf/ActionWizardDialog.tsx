import { useState } from 'react'
import { useFormatStore } from '../../stores/formatStore'
import { useTabStore } from '../../stores/tabStore'
import type { PdfFormatState } from './index'
import { executeWorkflow, PRESET_WORKFLOWS, type ActionStep, type ActionStepType, type ActionWorkflow } from '../../services/actionWizard'
import { resolveWysiwygSecurityBytes } from '../../services/pdfSecurityFinalize'

interface Props {
  tabId: string
  onClose: () => void
}

const STEP_LIBRARY: Array<{ type: ActionStepType; label: string; description: string }> = [
  { type: 'sanitize', label: 'Sanitize', description: 'Strip metadata, XMP, scripts, attachments, hidden layers' },
  { type: 'compress', label: 'Compress', description: 'Downsample images + strip redundant objects' },
  { type: 'bates', label: 'Bates numbering', description: 'Legal counter burned into each page footer' },
  { type: 'flatten_transparency', label: 'Flatten transparency', description: 'Rasterize layered transparency' },
  { type: 'to_word', label: 'Convert → Word', description: 'Export as .docx (terminal step)' },
  { type: 'to_excel', label: 'Convert → Excel', description: 'Export as .xlsx (terminal step)' },
  { type: 'to_ppt', label: 'Convert → PowerPoint', description: 'Export as .pptx (terminal step)' },
  { type: 'to_text', label: 'Convert → Text', description: 'Extract plain text (terminal step)' },
  { type: 'to_image_only', label: 'Convert → Image-only PDF', description: 'Rasterize every page' },
]

/** Action Wizard — build a multi-step workflow + run on the current
 *  document or a folder of PDFs. Mirrors Acrobat's "Action Wizard". */
export default function ActionWizardDialog({ tabId, onClose }: Props) {
  const state = useFormatStore((s) => s.data[tabId] as PdfFormatState | undefined)
  const [workflow, setWorkflow] = useState<ActionWorkflow>({ name: 'Custom workflow', steps: [] })
  const [runMode, setRunMode] = useState<'current' | 'folder'>('current')
  const [progress, setProgress] = useState<{ step: number; total: number; label: string } | null>(null)
  const [log, setLog] = useState<string[]>([])
  const [running, setRunning] = useState(false)

  if (!state) return null

  const addStep = (type: ActionStepType) => {
    const def = STEP_LIBRARY.find((s) => s.type === type)
    if (!def) return
    setWorkflow((prev) => ({ ...prev, steps: [...prev.steps, { type, label: def.label }] }))
  }
  const removeStep = (i: number) => {
    setWorkflow((prev) => ({ ...prev, steps: prev.steps.filter((_, idx) => idx !== i) }))
  }
  const move = (i: number, dir: -1 | 1) => {
    setWorkflow((prev) => {
      const j = i + dir
      if (j < 0 || j >= prev.steps.length) return prev
      const steps = [...prev.steps]
      ;[steps[i], steps[j]] = [steps[j], steps[i]]
      return { ...prev, steps }
    })
  }
  const loadPreset = (name: string) => {
    const p = PRESET_WORKFLOWS.find((w) => w.name === name)
    if (p) setWorkflow({ name: p.name, steps: p.steps.map((s) => ({ ...s })) })
  }
  const exportWorkflow = async () => {
    const json = JSON.stringify(workflow, null, 2)
    const blob = new Blob([json], { type: 'application/json' })
    ;(globalThis as unknown as { __lastSavedName?: string }).__lastSavedName = `${workflow.name.replace(/\W+/g, '_')}.action.json`
    await window.api.file.saveAs(new Uint8Array(await blob.arrayBuffer()))
  }
  const importWorkflow = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'application/json'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      try {
        const text = await file.text()
        const parsed = JSON.parse(text) as ActionWorkflow
        if (parsed && Array.isArray(parsed.steps)) setWorkflow(parsed)
      } catch (e) {
        setLog((l) => [...l, `Import failed: ${e instanceof Error ? e.message : 'unknown'}`])
      }
    }
    input.click()
  }

  const run = async () => {
    if (workflow.steps.length === 0) return
    setRunning(true)
    setLog([])
    setProgress({ step: 0, total: workflow.steps.length, label: 'Starting…' })
    try {
      if (runMode === 'current') {
        const hasSignStep = workflow.steps.some((step) => step.type === 'sign')
        const sourceBytes = hasSignStep ? await resolveWysiwygSecurityBytes(tabId) : state.pdfBytes
        await runOne(`current document (${sourceBytes.byteLength.toLocaleString()} bytes)`, sourceBytes, true)
      } else {
        // Multi-file: prompt for a folder selection. Browsers can't
        // iterate directories without <input type=file webkitdirectory>;
        // we use that to collect every .pdf under the picked folder.
        const input = document.createElement('input')
        input.type = 'file'
        ;(input as HTMLInputElement & { webkitdirectory?: boolean }).webkitdirectory = true
        input.multiple = true
        input.onchange = async () => {
          const files = input.files ? Array.from(input.files).filter((f) => f.name.toLowerCase().endsWith('.pdf')) : []
          setLog((l) => [...l, `Found ${files.length} PDF${files.length === 1 ? '' : 's'} in folder.`])
          if (files.length === 0) { setRunning(false); return }
          for (let i = 0; i < files.length; i++) {
            const bytes = new Uint8Array(await files[i].arrayBuffer())
            await runOne(files[i].name, bytes, false)
          }
          setRunning(false)
        }
        input.click()
        return
      }
    } finally {
      setProgress(null)
      if (runMode === 'current') setRunning(false)
    }
  }

  const runOne = async (fileName: string, bytes: Uint8Array, isCurrent: boolean) => {
    setLog((l) => [...l, `▶ ${fileName}`])
    const result = await executeWorkflow(bytes, workflow, (step, total, label) => {
      setProgress({ step: step + 1, total, label: `${fileName}: ${label}` })
    })
    for (const line of result.log) setLog((l) => [...l, `  ${line}`])
    if (!result.success) {
      setLog((l) => [...l, `  ✗ Workflow failed on ${fileName}.`])
      return
    }
    const outName = isCurrent
      ? `${workflow.name.replace(/\W+/g, '_')}.${result.outputFormat}`
      : `${fileName.replace(/\.pdf$/i, '')}.${result.outputFormat}`
    ;(globalThis as unknown as { __lastSavedName?: string }).__lastSavedName = outName
    const saved = await window.api.file.saveAs(result.outputBytes)
    if (saved) {
      setLog((l) => [...l, `  ✓ Saved ${outName} (${result.outputBytes.byteLength.toLocaleString()} bytes).`])
      const workflowSigns = workflow.steps.some((step) => step.type === 'sign')
      if (isCurrent && result.outputFormat === 'pdf' && !workflowSigns) {
        useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({ ...prev, pdfBytes: result.outputBytes }))
        useTabStore.getState().setTabDirty(tabId, true)
      } else if (isCurrent && workflowSigns) {
        setLog((l) => [...l, '  Signed workflow output saved as a protected copy; original tab unchanged.'])
      }
    } else {
      setLog((l) => [...l, `  • ${fileName} output ready but save was cancelled.`])
    }
  }

  return (
    <div
      data-testid="action-wizard-dialog"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: 'var(--bg-primary)', borderRadius: 8, padding: 20,
        border: '1px solid var(--border)', width: '72vw', maxWidth: 820,
        maxHeight: '82vh', display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>Action Wizard</h3>
          <button onClick={onClose} style={{ background:'transparent', border:'none', color:'var(--text-primary)', cursor:'pointer', fontSize:18 }}>✕</button>
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center' }}>
          <input data-testid="wizard-name" value={workflow.name}
            onChange={(e) => setWorkflow((p) => ({ ...p, name: e.target.value }))}
            style={{ flex: 1, ...inp }} />
          <select data-testid="wizard-preset" onChange={(e) => loadPreset(e.target.value)} defaultValue=""
            style={{ ...inp, width: 200 }}>
            <option value="" disabled>Load preset…</option>
            {PRESET_WORKFLOWS.map((p) => (<option key={p.name} value={p.name}>{p.name}</option>))}
          </select>
          <button onClick={importWorkflow} style={btnSecondary}>Import</button>
          <button onClick={exportWorkflow} disabled={workflow.steps.length === 0} style={btnSecondary}>Export</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, flex: 1, minHeight: 0 }}>
          <div style={{
            border: '1px solid var(--border)', borderRadius: 4, padding: 8,
            display: 'flex', flexDirection: 'column', gap: 4, overflowY: 'auto',
          }}>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Step library</div>
            {STEP_LIBRARY.map((def) => (
              <button key={def.type} data-testid={`lib-${def.type}`} onClick={() => addStep(def.type)}
                style={{
                  textAlign: 'left', padding: 6, fontSize: 11, borderRadius: 3,
                  background: 'var(--bg-surface)', color: 'var(--text-primary)',
                  border: '1px solid var(--border)', cursor: 'pointer',
                }}>
                <div style={{ fontWeight: 600 }}>+ {def.label}</div>
                <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>{def.description}</div>
              </button>
            ))}
          </div>

          <div style={{
            border: '1px solid var(--border)', borderRadius: 4, padding: 8,
            display: 'flex', flexDirection: 'column', gap: 4, overflowY: 'auto',
          }}>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Workflow steps ({workflow.steps.length})
            </div>
            {workflow.steps.length === 0 ? (
              <div style={{ padding: 16, fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>
                Click step names on the left to add them.
              </div>
            ) : (
              workflow.steps.map((step, i) => (
                <div key={i} data-testid={`wf-step-${i}`}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 4, padding: 6,
                    background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 3,
                  }}>
                  <span style={{ fontSize: 9, color: 'var(--text-muted)', minWidth: 18 }}>{i + 1}.</span>
                  <span style={{ flex: 1, fontSize: 11 }}>{step.label}</span>
                  <button onClick={() => move(i, -1)} disabled={i === 0} style={smBtn(i === 0)}>▲</button>
                  <button onClick={() => move(i, 1)} disabled={i === workflow.steps.length - 1} style={smBtn(i === workflow.steps.length - 1)}>▼</button>
                  <button data-testid={`wf-del-${i}`} onClick={() => removeStep(i)} style={{ ...smBtn(false), color: 'var(--danger)' }}>✕</button>
                </div>
              ))
            )}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 10, fontSize: 11 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="radio" checked={runMode === 'current'} onChange={() => setRunMode('current')} />
            Run on current document
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="radio" checked={runMode === 'folder'} onChange={() => setRunMode('folder')} />
            Run on folder of PDFs
          </label>
        </div>

        {progress && (
          <div style={{ marginTop: 8 }}>
            <div style={{ height: 4, background: 'var(--bg-surface)', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{
                height: '100%', width: `${Math.round((progress.step / progress.total) * 100)}%`,
                background: 'var(--accent)', transition: 'width 0.2s',
              }} />
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 2 }}>
              {progress.step}/{progress.total} — {progress.label}
            </div>
          </div>
        )}

        {log.length > 0 && (
          <div data-testid="wizard-log" style={{
            marginTop: 8, padding: 8, fontSize: 10,
            background: 'var(--bg-surface)', borderRadius: 3,
            color: 'var(--text-primary)', fontFamily: 'monospace',
            maxHeight: 120, overflowY: 'auto', whiteSpace: 'pre-wrap',
          }}>
            {log.join('\n')}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button onClick={onClose} style={btnSecondary}>Close</button>
          <button data-testid="wizard-run" onClick={run}
            disabled={running || workflow.steps.length === 0}
            style={{ ...btnPrimary, opacity: (running || workflow.steps.length === 0) ? 0.5 : 1 }}>
            {running ? 'Running…' : `Run${runMode === 'folder' ? ' on folder' : ''}`}
          </button>
        </div>
      </div>
    </div>
  )
}

const inp: React.CSSProperties = {
  padding: '5px 8px', fontSize: 12,
  background: 'var(--bg-surface)', border: '1px solid var(--border)',
  borderRadius: 3, color: 'var(--text-primary)', boxSizing: 'border-box',
}
const btnPrimary: React.CSSProperties = {
  padding: '6px 16px', background: 'var(--accent)', color: 'var(--bg-primary)',
  border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 600,
}
const btnSecondary: React.CSSProperties = {
  padding: '5px 12px', background: 'var(--bg-surface)', color: 'var(--text-primary)',
  border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer', fontSize: 11,
}
const smBtn = (disabled: boolean): React.CSSProperties => ({
  width: 20, height: 20, padding: 0, fontSize: 10,
  background: 'transparent', border: 'none',
  color: 'var(--text-primary)',
  cursor: disabled ? 'not-allowed' : 'pointer',
  opacity: disabled ? 0.3 : 1,
  borderRadius: 2,
})
