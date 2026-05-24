// Reader/viewer features that don't mutate the PDF: Auto Scroll, Eye
// Protection mode, Hide Annotations. All of these store preferences in
// a small zustand slice and apply CSS filter / interval effects
// directly.

import { create } from 'zustand'

export interface ViewerFeatureState {
  autoScroll: boolean
  autoScrollSpeed: number // px per tick
  eyeProtection: boolean
  hideAnnotations: boolean
  setAutoScroll: (v: boolean) => void
  setAutoScrollSpeed: (v: number) => void
  setEyeProtection: (v: boolean) => void
  setHideAnnotations: (v: boolean) => void
}

export const useViewerFeatures = create<ViewerFeatureState>((set) => ({
  autoScroll: false,
  autoScrollSpeed: 30,
  eyeProtection: false,
  hideAnnotations: false,
  setAutoScroll: (v) => set({ autoScroll: v }),
  setAutoScrollSpeed: (v) => set({ autoScrollSpeed: v }),
  setEyeProtection: (v) => set({ eyeProtection: v }),
  setHideAnnotations: (v) => set({ hideAnnotations: v }),
}))

/** Install the auto-scroll tick loop against a scrollable container.
 *  Returns a disposer. Safe to call multiple times; previous loop is
 *  cancelled. */
let _autoScrollHandle: number | null = null
export function installAutoScroll(container: HTMLElement | null, speed: number, enabled: boolean): void {
  if (_autoScrollHandle !== null) {
    window.clearInterval(_autoScrollHandle)
    _autoScrollHandle = null
  }
  if (!container || !enabled) return
  _autoScrollHandle = window.setInterval(() => {
    container.scrollBy({ top: Math.max(1, Math.round(speed / 15)), behavior: 'auto' })
  }, 50)
}

/** CSS filter string for eye-protection mode (warm tones, lower blue). */
export const EYE_PROTECTION_FILTER = 'sepia(0.15) saturate(0.9) hue-rotate(-8deg) brightness(0.96)'
