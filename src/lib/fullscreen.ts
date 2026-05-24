// Fullscreen toggle — wraps the Tauri 2 window API so callers can
// flip between windowed and fullscreen without importing the API
// directly each time. Falls back to the browser Fullscreen API when
// running in a non-Tauri environment (the dev preview, vite-only build).
//
// State is read from Tauri on demand (Tauri owns the window state),
// not mirrored in a Zustand store, to avoid drift if the user hits
// F11 or the OS fullscreen toggle outside our app code.

const isTauri = (): boolean =>
  typeof (globalThis as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined'

/** Read the current fullscreen state. Resolves to `false` if the API
 *  isn't available (browser preview without Fullscreen API). */
export async function isFullscreen(): Promise<boolean> {
  if (isTauri()) {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      return await getCurrentWindow().isFullscreen()
    } catch {
      return false
    }
  }
  return !!document.fullscreenElement
}

/** Set the window into the requested mode. */
export async function setFullscreen(value: boolean): Promise<void> {
  if (isTauri()) {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      await getCurrentWindow().setFullscreen(value)
      return
    } catch (e) {
      console.warn('[fullscreen] setFullscreen failed:', e)
      return
    }
  }
  // Browser fallback (vite-only dev preview).
  if (value) {
    try { await document.documentElement.requestFullscreen() } catch { /* user gesture required */ }
  } else if (document.fullscreenElement) {
    try { await document.exitFullscreen() } catch { /* ignore */ }
  }
}

/** Convenience: flip whatever the current state is. Used by Alt+Enter
 *  + the Preferences segmented control. */
export async function toggleFullscreen(): Promise<boolean> {
  const next = !(await isFullscreen())
  await setFullscreen(next)
  return next
}
