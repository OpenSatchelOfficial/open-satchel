// Hot-folder watch management + auto-run workflow on new files.
//
// Subscribe to Tauri events `hotfolder:new-file` and `cli:run-action`
// once at app boot. When a file arrives, load the associated action
// JSON, read the file bytes, run `executeWorkflow`, and save the
// result next to the source (or according to the action's output
// intent).

import { useCallback } from 'react'
import { executeWorkflow, type ActionWorkflow } from './actionWizard'

export interface HotFolderEntry {
  id: string
  path: string
  actionJsonPath: string | null
  enabled: boolean
}

export function useHotFolderWatch() {
  const refresh = useCallback(async (): Promise<HotFolderEntry[]> => {
    if (!window.api?.folder?.listWatched) return []
    try {
      return await window.api.folder.listWatched()
    } catch {
      return []
    }
  }, [])

  const addWatch = useCallback(async (): Promise<HotFolderEntry | null> => {
    if (!window.api?.folder?.watch) throw new Error('Hot-folder watch requires the Tauri build.')
    // Pick folder first.
    const folderPath = await pickSingleFolder()
    if (!folderPath) return null
    // Then optionally pick an action JSON — can be skipped for manual-per-file flows.
    const actionJson = await pickOptionalActionJson()
    return await window.api.folder.watch(folderPath, actionJson)
  }, [])

  const removeWatch = useCallback(async (id: string) => {
    if (!window.api?.folder?.unwatch) return
    await window.api.folder.unwatch(id)
  }, [])

  return { refresh, addWatch, removeWatch }
}

async function pickSingleFolder(): Promise<string | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tauri = (globalThis as any).__TAURI_INTERNALS__ ? await import('@tauri-apps/plugin-dialog') : null
  if (!tauri) return null
  const r = await tauri.open({ directory: true, multiple: false })
  if (!r) return null
  return typeof r === 'string' ? r : (r as { path: string }).path
}

async function pickOptionalActionJson(): Promise<string | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tauri = (globalThis as any).__TAURI_INTERNALS__ ? await import('@tauri-apps/plugin-dialog') : null
  if (!tauri) return null
  const r = await tauri.open({
    multiple: false,
    filters: [{ name: 'Action Workflow', extensions: ['json'] }],
    title: 'Pick action JSON (Cancel to skip)',
  })
  if (!r) return null
  return typeof r === 'string' ? r : (r as { path: string }).path
}

// -------- Boot-time event subscription --------

let _subscribed = false

/** Call once at app boot. Registers listeners for hotfolder:new-file
 *  and cli:run-action events and runs the associated workflow. */
export async function installHotFolderListeners(): Promise<void> {
  if (_subscribed) return
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (!(globalThis as any).__TAURI_INTERNALS__) return
  const { listen } = await import('@tauri-apps/api/event')

  await listen<{ watch_id: string; path: string; action_json_path: string | null }>(
    'hotfolder:new-file',
    async (evt) => {
      try {
        const { path, action_json_path } = evt.payload
        // Guard against recursive re-processing of our own output files.
        // deriveOutputPath emits `<stem>-processed.<ext>` so any incoming
        // file that already matches that pattern is something WE wrote —
        // skip it. Without this guard, each run's output triggers the
        // watcher, producing N nested -processed-processed-… files.
        if (isOurOwnOutput(path)) return
        if (!action_json_path) {
          console.info('[hot-folder] file arrived but no action configured:', path)
          return
        }
        const fileBytes = await readFileBytes(path)
        const workflow = await loadWorkflowFromJson(action_json_path)
        const res = await executeWorkflow(fileBytes, workflow)
        if (res.success) {
          const outPath = deriveOutputPath(path, res.outputFormat)
          await writeFileBytes(outPath, res.outputBytes)
          console.info('[hot-folder] processed:', path, '->', outPath)
        } else {
          console.warn('[hot-folder] workflow failed on', path, res.log)
        }
      } catch (e) {
        console.error('[hot-folder] handler error:', e)
      }
    },
  )

  // CLI dispatch — pull parsed args from Rust state on mount.
  // Race-free vs the earlier event-based approach: Rust stashed the
  // args during setup(), and we pick them up now that the WebView +
  // listener graph are guaranteed ready.
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const args = await invoke<{ action_path: string; input_path: string } | null>(
      'cli_get_pending_args',
    )
    if (args) {
      await runCliBatch(args.action_path, args.input_path)
    }
  } catch (e) {
    console.warn('[cli] pending-args fetch failed:', e)
  }

  _subscribed = true
}


async function runCliBatch(actionPath: string, inputPath: string): Promise<void> {
  try {
    console.info(`runCliBatch: action=${actionPath} input=${inputPath}`)
    const workflow = await loadWorkflowFromJson(actionPath)
    console.info(`workflow loaded: ${workflow.name} (${workflow.steps.length} steps)`)
    const isFolder = await pathIsFolder(inputPath)
    const files = isFolder ? await listPdfsInFolder(inputPath) : [inputPath]
    console.info(`resolved ${files.length} file(s), isFolder=${isFolder}`)
    let ok = 0
    for (const f of files) {
      try {
        const bytes = await readFileBytes(f)
        console.info(`read ${f}: ${bytes.byteLength} bytes`)
        const res = await executeWorkflow(bytes, workflow)
        if (!res.success) { console.warn(`workflow FAILED on ${f}: ${res.log.join(' | ')}`); continue }
        const outPath = deriveOutputPath(f, res.outputFormat)
        await writeFileBytes(outPath, res.outputBytes)
        console.info(`wrote ${outPath}: ${res.outputBytes.byteLength} bytes`)
        ok++
      } catch (e) {
        console.info(`failed on ${f}: ${String(e)}`)
      }
    }
    console.info(`done: ${ok}/${files.length} succeeded; closing window`)
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      await getCurrentWindow().close()
    } catch (e) { console.warn(`close failed: ${String(e)}`) }
  } catch (e) {
    console.info(`dispatch fatal: ${String(e)}`)
  }
}

async function loadWorkflowFromJson(path: string): Promise<ActionWorkflow> {
  const raw = await readFileBytes(path)
  const text = new TextDecoder().decode(raw)
  return JSON.parse(text) as ActionWorkflow
}

async function readFileBytes(path: string): Promise<Uint8Array> {
  const r = await window.api.file.openPath(path)
  return r.bytes
}

async function writeFileBytes(path: string, bytes: Uint8Array): Promise<void> {
  await window.api.file.save(bytes, path)
}

function deriveOutputPath(inputPath: string, outputFormat: string): string {
  // input: C:\foo\doc.pdf  outputFormat: pdf  →  C:\foo\doc-processed.pdf
  // For non-PDF outputs, swap the extension.
  const sep = inputPath.includes('\\') ? '\\' : '/'
  const parts = inputPath.split(sep)
  const file = parts.pop()!
  const dir = parts.join(sep)
  const dot = file.lastIndexOf('.')
  const base = dot > 0 ? file.slice(0, dot) : file
  return `${dir}${sep}${base}-processed.${outputFormat}`
}

/** Recognize files WE wrote via deriveOutputPath — they end in
 *  `-processed.<ext>`. Skip them to prevent the watcher re-firing on
 *  its own output (which would cascade into ...-processed-processed-
 *  processed-… nesting). */
function isOurOwnOutput(path: string): boolean {
  const sep = path.includes('\\') ? '\\' : '/'
  const name = path.split(sep).pop() ?? ''
  const dot = name.lastIndexOf('.')
  if (dot < 0) return false
  const stem = name.slice(0, dot)
  return stem.endsWith('-processed')
}

async function pathIsFolder(path: string): Promise<boolean> {
  // Heuristic: try openPath; if it throws, fall back to treating as folder.
  try {
    await window.api.file.openPath(path)
    return false
  } catch {
    return true
  }
}

async function listPdfsInFolder(path: string): Promise<string[]> {
  if (!window.api?.folder?.pick) return []
  // Reuse the pick-folder Rust command by passing an already-known path
  // is not possible — pick_folder currently shows a dialog. For CLI use
  // we'll just iterate via the Tauri fs plugin:
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fs = await import('@tauri-apps/plugin-fs').catch(() => null as any)
  if (!fs) return []
  try {
    const entries = await fs.readDir(path)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return entries
      .filter((e: any) => e.name && e.name.toLowerCase().endsWith('.pdf'))
      .map((e: any) => `${path}${path.includes('\\') ? '\\' : '/'}${e.name}`)
  } catch {
    return []
  }
}
