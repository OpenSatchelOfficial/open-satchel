// Global keyboard shortcuts. Registered once at app mount from App.tsx.
//
// Architecture: a named-action registry maps stable string ids to
// (default key binding, runtime handler). User overrides are stored
// in localStorage and consulted on every keypress, so a customized
// binding survives reload. The default registry is the source of
// truth; the overrides layer never adds new actions, only swaps
// the key for an existing one.

import { useTabStore } from '../stores/tabStore'
import { useUIStore } from '../stores/uiStore'
import { openFile, saveActiveTab, saveActiveTabAs, closeActiveTab, printActiveTab } from './actions'
import { undo as doUndo, redo as doRedo } from './undo-redo'
import { toggleFullscreen } from './fullscreen'
import { shouldEscapeRevertToSelect } from '../formats/pdf/clickDispatcher'

export interface KeyBinding {
  ctrl?: boolean
  shift?: boolean
  alt?: boolean
  /** Single-character key ('s', 'a', '/'), or a named key from
   *  KeyboardEvent.key ('Tab', 'Escape', 'F1'…). Lowercased on compare. */
  key: string
}

/** Stable identifier for a shortcut action. New actions can be added
 *  here over time; existing ids must remain stable so user overrides
 *  in localStorage continue to apply. */
export type ShortcutId =
  | 'file.open'
  | 'file.save'
  | 'file.save-as'
  | 'file.print'
  | 'tab.close'
  | 'sidebar.toggle'
  | 'find.open'
  | 'replace.open'
  | 'command-palette.open'
  | 'edit.undo'
  | 'edit.redo'
  | 'edit.redo-y'
  | 'tab.next'
  | 'view.fullscreen'

interface ShortcutAction {
  id: ShortcutId
  label: string
  description: string
  defaultBinding: KeyBinding
  /** Returns true if the action handled the event (so we preventDefault). */
  run: (e: KeyboardEvent) => boolean | void
}

const STORAGE_KEY = 'open-satchel:shortcut-overrides'

/** Default registry. Order is the suggestion order in the settings
 *  panel; logic order doesn't matter (all bindings are matched
 *  exhaustively). */
const ACTIONS: ShortcutAction[] = [
  {
    id: 'file.open',
    label: 'Open file',
    description: 'Open a file from disk',
    defaultBinding: { ctrl: true, key: 'o' },
    run: () => { void openFile(); return true },
  },
  {
    id: 'file.save',
    label: 'Save',
    description: 'Save the active tab',
    defaultBinding: { ctrl: true, key: 's' },
    run: () => { void saveActiveTab(); return true },
  },
  {
    id: 'file.save-as',
    label: 'Save as…',
    description: 'Save the active tab to a new path',
    defaultBinding: { ctrl: true, shift: true, key: 's' },
    run: () => { void saveActiveTabAs(); return true },
  },
  {
    id: 'file.print',
    label: 'Print',
    description: 'Print the active document',
    // Returns true unconditionally so we always preventDefault — otherwise
    // the native WebView Ctrl+P fires and prints the whole app DOM (ribbon,
    // sidebar, tabs), which is the bug this binding exists to stop.
    defaultBinding: { ctrl: true, key: 'p' },
    run: () => { void printActiveTab(); return true },
  },
  {
    id: 'tab.close',
    label: 'Close tab',
    description: 'Close the active tab',
    defaultBinding: { ctrl: true, key: 'w' },
    run: () => { closeActiveTab(); return true },
  },
  {
    id: 'sidebar.toggle',
    label: 'Toggle sidebar',
    description: 'Show / hide the page sidebar',
    defaultBinding: { ctrl: true, key: 'b' },
    run: () => { useUIStore.getState().toggleSidebar(); return true },
  },
  {
    id: 'find.open',
    label: 'Find',
    description: 'Open the find bar',
    defaultBinding: { ctrl: true, key: 'f' },
    run: () => { useUIStore.getState().openFind(); return true },
  },
  {
    id: 'replace.open',
    label: 'Find & Replace',
    description: 'Open the find-and-replace dialog',
    defaultBinding: { ctrl: true, key: 'h' },
    run: () => { useUIStore.getState().openReplace(); return true },
  },
  {
    id: 'command-palette.open',
    label: 'Command palette',
    description: 'Open the command palette',
    defaultBinding: { ctrl: true, key: 'k' },
    run: () => { useUIStore.getState().setCommandPaletteOpen(true); return true },
  },
  {
    id: 'edit.undo',
    label: 'Undo',
    description: 'Undo the last edit',
    defaultBinding: { ctrl: true, key: 'z' },
    run: () => {
      // Blur any active contenteditable first so the current edit
      // session flushes to history before we pop. Without this,
      // typing then Ctrl+Z would pop an EARLIER entry and leave the
      // in-flight change orphaned.
      const ae = document.activeElement as HTMLElement | null
      if (ae && ae.isContentEditable) ae.blur()
      doUndo()
      return true
    },
  },
  {
    id: 'edit.redo',
    label: 'Redo',
    description: 'Redo the last undone edit',
    defaultBinding: { ctrl: true, shift: true, key: 'z' },
    run: () => {
      const ae = document.activeElement as HTMLElement | null
      if (ae && ae.isContentEditable) ae.blur()
      doRedo()
      return true
    },
  },
  {
    id: 'edit.redo-y',
    label: 'Redo (Ctrl+Y)',
    description: 'Windows-conventional redo binding (alternate)',
    defaultBinding: { ctrl: true, key: 'y' },
    run: () => {
      const ae = document.activeElement as HTMLElement | null
      if (ae && ae.isContentEditable) ae.blur()
      doRedo()
      return true
    },
  },
  {
    id: 'tab.next',
    label: 'Next tab',
    description: 'Cycle to the next open tab',
    defaultBinding: { ctrl: true, key: 'Tab' },
    run: () => {
      const { tabs, activeTabId, setActiveTab } = useTabStore.getState()
      if (tabs.length < 2 || !activeTabId) return false
      const idx = tabs.findIndex((t) => t.id === activeTabId)
      const next = tabs[(idx + 1) % tabs.length]
      setActiveTab(next.id)
      return true
    },
  },
  {
    id: 'view.fullscreen',
    label: 'Toggle fullscreen',
    description: 'Switch between windowed and fullscreen mode',
    defaultBinding: { alt: true, key: 'Enter' },
    run: () => { void toggleFullscreen(); return true },
  },
]

function matches(e: KeyboardEvent, k: KeyBinding): boolean {
  const ctrl = !!e.ctrlKey || !!e.metaKey
  return (
    e.key.toLowerCase() === k.key.toLowerCase() &&
    (k.ctrl ?? false) === ctrl &&
    (k.shift ?? false) === e.shiftKey &&
    (k.alt ?? false) === e.altKey
  )
}

/** Returns the user-customized binding for an action, or its default
 *  if no override is set. */
export function getEffectiveBinding(id: ShortcutId): KeyBinding {
  const overrides = loadOverrides()
  if (overrides[id]) return overrides[id]
  const action = ACTIONS.find((a) => a.id === id)
  if (!action) throw new Error(`unknown shortcut id: ${id}`)
  return action.defaultBinding
}

/** Format a binding as a human-readable label, e.g. "Ctrl+Shift+S".
 *  Used in the settings panel and tooltips. */
export function formatBinding(b: KeyBinding): string {
  const parts: string[] = []
  if (b.ctrl) parts.push('Ctrl')
  if (b.shift) parts.push('Shift')
  if (b.alt) parts.push('Alt')
  parts.push(b.key.length === 1 ? b.key.toUpperCase() : b.key)
  return parts.join('+')
}

/** Read the overrides map from localStorage. Returns an empty object
 *  if no overrides exist or the storage is corrupted. */
export function loadOverrides(): Partial<Record<ShortcutId, KeyBinding>> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    return parsed
  } catch {
    return {}
  }
}

/** Save a single override. Pass null to clear an action back to its
 *  default binding. */
export function setOverride(id: ShortcutId, binding: KeyBinding | null): void {
  const all = loadOverrides()
  if (binding === null) {
    delete all[id]
  } else {
    all[id] = binding
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
  } catch {
    /* quota / privacy mode — overrides degrade to in-memory only */
  }
}

/** Remove all customizations, restoring the entire defaults set. */
export function clearAllOverrides(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* unavailable */
  }
}

/** Snapshot the registry for a settings panel. */
export interface ShortcutEntry {
  id: ShortcutId
  label: string
  description: string
  defaultBinding: KeyBinding
  effectiveBinding: KeyBinding
  isCustomized: boolean
}

export function listShortcuts(): ShortcutEntry[] {
  const overrides = loadOverrides()
  return ACTIONS.map((a) => ({
    id: a.id,
    label: a.label,
    description: a.description,
    defaultBinding: a.defaultBinding,
    effectiveBinding: overrides[a.id] ?? a.defaultBinding,
    isCustomized: !!overrides[a.id],
  }))
}

/** Returns the action id whose effective binding matches `b`, or
 *  null if none. Used for conflict detection in the settings UI. */
export function findActionByBinding(b: KeyBinding, except?: ShortcutId): ShortcutId | null {
  const overrides = loadOverrides()
  for (const a of ACTIONS) {
    if (a.id === except) continue
    const eff = overrides[a.id] ?? a.defaultBinding
    if (
      eff.key.toLowerCase() === b.key.toLowerCase() &&
      (eff.ctrl ?? false) === (b.ctrl ?? false) &&
      (eff.shift ?? false) === (b.shift ?? false) &&
      (eff.alt ?? false) === (b.alt ?? false)
    ) {
      return a.id
    }
  }
  return null
}

export function registerGlobalShortcuts(): () => void {
  const handler = (e: KeyboardEvent) => {
    // Action-driven dispatch: walk the registry, applying user overrides.
    // Multiple actions can share a binding (e.g. edit.redo + edit.redo-y
    // both fire on Ctrl+Y/Ctrl+Shift+Z); we run the first match and stop.
    const overrides = loadOverrides()
    for (const a of ACTIONS) {
      const binding = overrides[a.id] ?? a.defaultBinding
      if (matches(e, binding)) {
        const handled = a.run(e)
        if (handled !== false) {
          e.preventDefault()
          return
        }
      }
    }

    // Escape: modeless-editing escape hatch. Stays out of the registry
    // because it's a contextual binding (only fires when a non-Select
    // tool is active) and shouldn't be customized — Esc is universal.
    if (e.key === 'Escape' && !e.ctrlKey && !e.shiftKey && !e.altKey) {
      const ae = document.activeElement as HTMLElement | null
      if (ae && ae.isContentEditable) return  // let the paragraph editor handle it
      const tool = useUIStore.getState().tool
      if (shouldEscapeRevertToSelect(tool)) {
        e.preventDefault()
        useUIStore.getState().setTool('select')
        return
      }
    }
  }

  window.addEventListener('keydown', handler)
  return () => window.removeEventListener('keydown', handler)
}
