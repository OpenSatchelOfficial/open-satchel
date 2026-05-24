import { useEffect } from 'react'
import AppShell from './components/layout/AppShell'
import EncryptedOpenDialog from './components/EncryptedOpenDialog'
import UpdateNoticeToast from './components/UpdateNoticeToast'
import { registerGlobalShortcuts } from './lib/shortcuts'
import { useAutoSave } from './hooks/useAutoSave'
import { useUIStore, applyAccent } from './stores/uiStore'

// Re-export action helpers that were historically attached to App.tsx in
// the Electron codebase. Copied components import them from '../App'.
// All live in lib/actions now; these aliases keep import paths stable.
export {
  openFile,
  openFromPath as openFileFromPath,
  saveActiveTab as saveFile,
  saveActiveTabAs as saveFileAs,
  closeActiveTab,
  saveTabById,
} from './lib/actions'

export default function App() {
  const theme = useUIStore((s) => s.theme)
  const density = useUIStore((s) => s.density)
  const accent = useUIStore((s) => s.accent)

  // Mirror theme + density to <html> AND <body> so the [data-theme] /
  // [data-density] selectors in global.css resolve regardless of which
  // root the redesign components anchor to. uiStore's setTheme/setDensity
  // also write these, but this effect covers the initial render and any
  // direct store mutation that bypassed the action.
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.dataset.density = density
    document.body.dataset.theme = theme
    document.body.dataset.density = density
  }, [theme, density])

  // Re-apply accent whenever theme or accent changes. The dark-theme
  // CSS block sets its own --accent, so we have to override at the
  // documentElement style level (with !important) — see applyAccent.
  useEffect(() => {
    applyAccent(accent, theme)
  }, [accent, theme])

  useEffect(() => {
    const cleanup = registerGlobalShortcuts()
    return cleanup
  }, [])

  // Subscribe to uiStore.tool / uiStore.zoom and push history entries
  // so Ctrl+Z reverts the last tool change or zoom step. Lives here
  // (not in registerGlobalShortcuts) because it's a Zustand
  // subscription, not a window-keydown listener — clean lifecycle
  // separation. Subscribed once at mount; unsubscribed on unmount.
  useEffect(() => {
    let cleanup: (() => void) | null = null
    void import('./lib/undo-redo').then(({ subscribeUiHistory }) => {
      cleanup = subscribeUiHistory()
    })
    return () => { cleanup?.() }
  }, [])

  // Global Escape-to-close: when Escape fires anywhere, look for the
  // topmost open modal dialog (matching our `*-dialog` testid convention)
  // and dispatch a click on its backdrop wrapper. Every modal in this
  // codebase implements
  //   onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
  // on the outermost div, so clicking the wrapper itself triggers the
  // dialog's onClose. This is standard accessibility UX and saves
  // every dialog from wiring its own keydown listener.
  //
  // Skip when a contenteditable element is the active element so users
  // can press Escape to exit inline edit mode without closing the
  // surrounding dialog.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const active = document.activeElement as HTMLElement | null
      if (active?.isContentEditable) return
      const dialogs = Array.from(document.querySelectorAll<HTMLElement>(
        // Most dialogs follow the *-dialog testid convention. A handful
        // pre-date that convention (snip-pin, visual-compare,
        // batch-rename, batch-collect) — list them explicitly so
        // Escape still works there.
        [
          '[data-testid$="-dialog"]',
          '[data-testid="snip-pin"]',
          '[data-testid="visual-compare"]',
          '[data-testid="batch-rename"]',
          '[data-testid="batch-collect"]',
        ].join(','),
      ))
      if (dialogs.length === 0) return
      // Pick the topmost (highest computed z-index, ties broken by
      // last-rendered).
      const top = dialogs
        .map((el) => ({ el, z: parseInt(getComputedStyle(el).zIndex || '0', 10) || 0 }))
        .sort((a, b) => b.z - a.z)[0].el
      const rect = top.getBoundingClientRect()
      // Dispatch a click whose target IS the backdrop element so the
      // onClick handler's `e.target === e.currentTarget` check passes.
      top.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, cancelable: true, button: 0,
        clientX: rect.left + 1, clientY: rect.top + 1, view: window,
      }))
      top.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true, cancelable: true, button: 0,
        clientX: rect.left + 1, clientY: rect.top + 1, view: window,
      }))
      top.dispatchEvent(new MouseEvent('click', {
        bubbles: true, cancelable: true, button: 0,
        clientX: rect.left + 1, clientY: rect.top + 1, view: window,
      }))
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  useAutoSave()

  return (
    <>
      <AppShell />
      <EncryptedOpenDialog />
      <UpdateNoticeToast />
    </>
  )
}
