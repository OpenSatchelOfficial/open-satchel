import { create } from 'zustand'
import type {
  UIState,
  Tool,
  DrawingOptions,
  TextOptions,
  SaveNotice,
  ConfirmDialogState,
  AccentName,
  LayoutMode,
  DensityName,
  ThemeName,
} from '../types/pdf'

interface UIActions {
  setCurrentPage: (page: number) => void
  setReadMode: (read: boolean) => void
  toggleReadMode: () => void
  setZoom: (zoom: number) => void
  zoomIn: () => void
  zoomOut: () => void
  resetZoom: () => void
  setTool: (tool: Tool) => void
  toggleSidebar: () => void
  setDrawingOptions: (opts: Partial<DrawingOptions>) => void
  setTextOptions: (opts: Partial<TextOptions>) => void
  setHighlightColor: (color: string) => void
  setHighlightWidth: (w: 'thin' | 'medium' | 'thick') => void
  setHighlightOpacity: (v: number) => void
  setShapeColor: (color: string) => void
  setShapeStrokeWidth: (width: number) => void
  setNoteColor: (color: string) => void
  setSelectedStamp: (index: number) => void
  setTextStampTemplate: (template: string) => void
  setInitials: (v: string) => void
  toggleSearch: () => void
  setSearchVisible: (v: boolean) => void
  setTheme: (t: ThemeName) => void
  toggleTheme: () => void
  setAccent: (a: AccentName) => void
  setLayout: (l: LayoutMode) => void
  toggleAnnotationGutter: () => void
  setShowAnnotationGutter: (v: boolean) => void
  toggleCommandPalette: () => void
  setCommandPaletteOpen: (v: boolean) => void
  openFind: () => void
  openReplace: () => void
  closeFindReplace: () => void
  setAutoSaveEnabled: (v: boolean) => void
  setAutoSaveInterval: (ms: number) => void
  setAutoSaveStatus: (s: 'idle' | 'saving' | 'saved') => void
  toggleAutoSave: () => void
  setAutoLayoutTextEdits: (v: boolean) => void
  toggleAutoLayoutTextEdits: () => void
  toggleRulers: () => void
  toggleGrid: () => void
  toggleSnapToGrid: () => void
  setGridSize: (v: number) => void
  toggleLayers: () => void
  toggleComments: () => void
  addGuide: (tabId: string, pageIndex: number, axis: 'h' | 'v', pos: number) => void
  moveGuide: (tabId: string, pageIndex: number, idx: number, pos: number) => void
  removeGuide: (tabId: string, pageIndex: number, idx: number) => void
  clearGuides: (tabId?: string, pageIndex?: number) => void
  // Fallback system font used when the original PDF font can't be
  // re-embedded (CMap/subset/license-locked). Mirrors Acrobat's
  // Preferences > Content Editing > "Fallback font for editing".
  setFallbackFont: (family: FallbackFontFamily) => void
  // §3: when true, the overlay bake EMBEDS the installed file for
  // office-suite family names (Arial/Calibri/Cambria/Georgia/…) on an
  // EXACT system-font match instead of substituting Standard-14 metrics.
  // Default OFF preserves the compact Standard-14 output; ON trades a
  // larger file for exact installed-font fidelity. Exact-match-gated to
  // avoid borrowing a wrong face on a fuzzy name match.
  setEmbedInstalledFonts: (v: boolean) => void
  // Optional metadata wipe on save (beside redactions). See UIState.wipeMetadataOnSave.
  setWipeMetadataOnSave: (v: boolean) => void
  toggleWipeMetadataOnSave: () => void
  /** Legal Guarantee redaction (beside redactions). See
   *  UIState.legalGuaranteeRedaction. Enabling it FORCE-DISABLES autosave
   *  (remembering the prior setting); disabling restores it. The atomic
   *  autosave lifecycle lives in this setter so every caller (checkbox
   *  walkthrough, post-save toast, MCP ui_set_legal_guarantee) gets it. */
  setLegalGuaranteeRedaction: (v: boolean) => void
  /** Density token. Accepts the v2 names (compact|balanced|roomy)
   *  AND the legacy ones (comfortable→balanced, spacious→roomy) so test
   *  scripts written against the old API keep working. */
  setDensity: (d: DensityName | 'comfortable' | 'spacious') => void
  setSaveNotice: (n: SaveNotice | null) => void
  /** Show a blocking in-app confirmation and await the user's choice. Use
   *  this instead of window.confirm (which WebView2 silently suppresses in the
   *  packaged build). Resolves true on confirm, false on cancel/dismiss. */
  requestConfirm: (opts: {
    title: string
    message: string
    confirmLabel?: string
    cancelLabel?: string
    tone?: 'warn' | 'danger'
  }) => Promise<boolean>
  /** Resolve the pending confirm dialog (called by <ConfirmModal>). */
  resolveConfirm: (ok: boolean) => void
}

export type FallbackFontFamily = 'Helvetica' | 'TimesRoman' | 'Courier'

const ZOOM_STEPS = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0, 4.0]

/** Accent colour mapping. Each accent ships a (light, dark) pair plus
 *  matching tint/hover/ink so the swap is one setProperty call per var.
 *  Picked to feel distinct from Acrobat red AND from the previous
 *  blue-Fluent shell — burnt amber by default. */
export const ACCENT_PALETTE: Record<
  AccentName,
  {
    light: { accent: string; hover: string; tint: string; ink: string }
    dark: { accent: string; hover: string; tint: string; ink: string }
  }
> = {
  amber: {
    light: { accent: 'oklch(66% 0.155 52)',  hover: 'oklch(60% 0.165 50)', tint: 'oklch(94% 0.040 65)', ink: 'oklch(99% 0.005 80)' },
    dark:  { accent: 'oklch(75% 0.155 60)',  hover: 'oklch(80% 0.150 60)', tint: 'oklch(34% 0.060 55)', ink: 'oklch(18% 0.020 60)' },
  },
  forest: {
    light: { accent: 'oklch(52% 0.13 155)',  hover: 'oklch(46% 0.14 155)', tint: 'oklch(93% 0.04 155)', ink: 'oklch(99% 0.005 80)' },
    dark:  { accent: 'oklch(72% 0.14 155)',  hover: 'oklch(78% 0.13 155)', tint: 'oklch(28% 0.05 155)', ink: 'oklch(15% 0.02 155)' },
  },
  iris: {
    light: { accent: 'oklch(56% 0.16 290)',  hover: 'oklch(50% 0.17 290)', tint: 'oklch(94% 0.04 290)', ink: 'oklch(99% 0.005 80)' },
    dark:  { accent: 'oklch(72% 0.15 290)',  hover: 'oklch(78% 0.14 290)', tint: 'oklch(30% 0.06 290)', ink: 'oklch(15% 0.02 290)' },
  },
  ink: {
    light: { accent: 'oklch(28% 0.02 260)',  hover: 'oklch(20% 0.02 260)', tint: 'oklch(92% 0.01 260)', ink: 'oklch(99% 0.005 80)' },
    dark:  { accent: 'oklch(85% 0.01 80)',   hover: 'oklch(92% 0.005 80)', tint: 'oklch(28% 0.01 260)', ink: 'oklch(15% 0.012 258)' },
  },
}

/** Set --accent + co. for the current theme. We use !important because
 *  the dark-theme block in global.css overrides --accent — without
 *  !important an "amber → forest" toggle in dark mode would silently
 *  revert next render. */
export function applyAccent(name: AccentName, theme: ThemeName) {
  const a = ACCENT_PALETTE[name] ?? ACCENT_PALETTE.amber
  const v = theme === 'light' ? a.light : a.dark
  for (const el of [document.documentElement, document.body]) {
    el.style.setProperty('--accent', v.accent, 'important')
    el.style.setProperty('--accent-hover', v.hover, 'important')
    el.style.setProperty('--accent-tint', v.tint, 'important')
    el.style.setProperty('--accent-ink', v.ink, 'important')
  }
}

/** Map legacy density names (Fluent-era) to the v2 names. */
function normalizeDensity(d: DensityName | 'comfortable' | 'spacious'): DensityName {
  if (d === 'comfortable') return 'balanced'
  if (d === 'spacious') return 'roomy'
  return d
}

export const useUIStore = create<UIState & UIActions>((set, get) => ({
  currentPage: 0,
  zoom: 1.0,
  tool: 'select',
  sidebarOpen: true,
  drawingOptions: { color: '#000000', width: 2, opacity: 1 },
  textOptions: {
    fontFamily: 'Helvetica',
    fontSize: 16,
    color: '#000000',
    bold: false,
    italic: false,
    underline: false,
    strikethrough: false,
    textAlign: 'left' as const,
    lineHeight: 1.2,
    charSpacing: 0
  },
  highlightColor: '#f9e2af',
  highlightWidth: 'medium' as const,
  highlightOpacity: 0.5,
  shapeColor: '#f38ba8',
  shapeStrokeWidth: 2,
  noteColor: '#f9e2af',
  selectedStamp: 0,
  textStampTemplate: 'Reviewed by {user} on {date}',
  initials: 'AB',
  searchVisible: false,
  // Redesign-v2 flips the default to light. Both themes are equally
  // polished now; light is the warm-paper aesthetic the redesign was
  // built around.
  theme: 'light',
  accent: 'amber',
  layout: 'ribbon',
  showAnnotationGutter: false,
  commandPaletteOpen: false,
  findReplaceOpen: false,
  findReplaceMode: 'find',
  autoSaveEnabled: true,
  // Bumped from 30s → 2min: a 30s interval raced with multi-paragraph
  // edit sessions — autosave fired mid-sequence, cleared pending edits,
  // and a subsequent user Ctrl+S hit an inconsistent state where some
  // edits had been baked and others were fresh. At 2min, the window
  // covers a typical multi-paragraph edit cycle. A blur-aware autosave
  // (deferring while the user is actively typing) is the real fix —
  // see follow-up task.
  autoSaveInterval: 120000,
  autoSaveStatus: 'idle',
  autoLayoutTextEdits: false,
  showRulers: false,
  showGrid: false,
  showLayers: false,
  showComments: false,
  snapToGrid: false,
  gridSize: 50,
  guides: {},
  fallbackFontFamily: 'Helvetica' as FallbackFontFamily,
  embedInstalledFonts: false,
  wipeMetadataOnSave: false,
  legalGuaranteeRedaction: false,
  autoSaveBeforeLegalGuarantee: null,
  readMode: false,
  density: 'compact',
  saveNotice: null,
  confirmDialog: null,

  setCurrentPage: (page) => set({ currentPage: page }),
  setReadMode: (read) => set({ readMode: read }),
  toggleReadMode: () => set((s) => ({ readMode: !s.readMode })),
  setZoom: (zoom) => set({ zoom: Math.max(0.25, Math.min(4.0, zoom)) }),
  zoomIn: () =>
    set((state) => {
      const next = ZOOM_STEPS.find((s) => s > state.zoom)
      return { zoom: next ?? state.zoom }
    }),
  zoomOut: () =>
    set((state) => {
      const prev = [...ZOOM_STEPS].reverse().find((s) => s < state.zoom)
      return { zoom: prev ?? state.zoom }
    }),
  resetZoom: () => set({ zoom: 1.0 }),
  setTool: (tool) => set({ tool }),
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  setDrawingOptions: (opts) =>
    set((state) => ({ drawingOptions: { ...state.drawingOptions, ...opts } })),
  setTextOptions: (opts) =>
    set((state) => ({ textOptions: { ...state.textOptions, ...opts } })),
  setHighlightColor: (color) => set({ highlightColor: color }),
  setHighlightWidth: (w) => set({ highlightWidth: w }),
  setHighlightOpacity: (v) => set({ highlightOpacity: Math.max(0, Math.min(1, v)) }),
  setShapeColor: (color) => set({ shapeColor: color }),
  setShapeStrokeWidth: (width) => set({ shapeStrokeWidth: width }),
  setNoteColor: (color) => set({ noteColor: color }),
  setSelectedStamp: (index) => set({ selectedStamp: index }),
  setTextStampTemplate: (template) => set({ textStampTemplate: template }),
  setInitials: (v) => set({ initials: v }),
  toggleSearch: () => set((s) => ({ searchVisible: !s.searchVisible })),
  setSearchVisible: (v) => set({ searchVisible: v }),
  setTheme: (t) =>
    set(() => {
      document.documentElement.dataset.theme = t
      document.body.dataset.theme = t
      // Re-apply accent after theme switch so the dark-theme override of
      // --accent doesn't clobber our chosen colour.
      applyAccent(get().accent, t)
      return { theme: t }
    }),
  toggleTheme: () => {
    const next: ThemeName = get().theme === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.theme = next
    document.body.dataset.theme = next
    applyAccent(get().accent, next)
    set({ theme: next })
  },
  setAccent: (a) =>
    set(() => {
      applyAccent(a, get().theme)
      return { accent: a }
    }),
  setLayout: (l) => set({ layout: l }),
  toggleAnnotationGutter: () =>
    set((s) => ({ showAnnotationGutter: !s.showAnnotationGutter })),
  setShowAnnotationGutter: (v) => set({ showAnnotationGutter: v }),
  toggleCommandPalette: () => set((s) => ({ commandPaletteOpen: !s.commandPaletteOpen })),
  setCommandPaletteOpen: (v) => set({ commandPaletteOpen: v }),
  openFind: () => set({ findReplaceOpen: true, findReplaceMode: 'find' }),
  openReplace: () => set({ findReplaceOpen: true, findReplaceMode: 'replace' }),
  closeFindReplace: () => set({ findReplaceOpen: false }),
  setAutoSaveEnabled: (v) => set({ autoSaveEnabled: v }),
  setAutoSaveInterval: (ms) => set({ autoSaveInterval: ms }),
  setAutoSaveStatus: (s) => set({ autoSaveStatus: s }),
  toggleAutoSave: () => set((state) => ({ autoSaveEnabled: !state.autoSaveEnabled })),
  setAutoLayoutTextEdits: (v) => set({ autoLayoutTextEdits: v }),
  toggleAutoLayoutTextEdits: () =>
    set((state) => ({ autoLayoutTextEdits: !state.autoLayoutTextEdits })),
  toggleRulers: () => set((state) => ({ showRulers: !state.showRulers })),
  toggleGrid: () => set((state) => ({ showGrid: !state.showGrid })),
  toggleSnapToGrid: () => set((state) => ({ snapToGrid: !state.snapToGrid })),
  setGridSize: (v) => set({ gridSize: Math.max(5, Math.min(500, Math.round(v))) }),
  toggleLayers: () => set((state) => ({ showLayers: !state.showLayers })),
  toggleComments: () => set((state) => ({ showComments: !state.showComments })),
  addGuide: (tabId, pageIndex, axis, pos) =>
    set((state) => {
      const key = `${tabId}:${pageIndex}`
      const existing = state.guides[key] ?? []
      return { guides: { ...state.guides, [key]: [...existing, { axis, pos }] } }
    }),
  moveGuide: (tabId, pageIndex, idx, pos) =>
    set((state) => {
      const key = `${tabId}:${pageIndex}`
      const existing = state.guides[key] ?? []
      if (idx < 0 || idx >= existing.length) return {}
      const next = existing.slice()
      next[idx] = { ...next[idx], pos }
      return { guides: { ...state.guides, [key]: next } }
    }),
  removeGuide: (tabId, pageIndex, idx) =>
    set((state) => {
      const key = `${tabId}:${pageIndex}`
      const existing = state.guides[key] ?? []
      if (idx < 0 || idx >= existing.length) return {}
      const next = existing.slice()
      next.splice(idx, 1)
      return { guides: { ...state.guides, [key]: next } }
    }),
  clearGuides: (tabId, pageIndex) =>
    set((state) => {
      if (tabId === undefined) return { guides: {} }
      if (pageIndex === undefined) {
        const next = { ...state.guides }
        for (const k of Object.keys(next)) if (k.startsWith(`${tabId}:`)) delete next[k]
        return { guides: next }
      }
      const key = `${tabId}:${pageIndex}`
      const next = { ...state.guides }
      delete next[key]
      return { guides: next }
    }),
  setFallbackFont: (family) => set({ fallbackFontFamily: family }),
  setEmbedInstalledFonts: (v) => set({ embedInstalledFonts: v }),
  setWipeMetadataOnSave: (v) => set({ wipeMetadataOnSave: v }),
  toggleWipeMetadataOnSave: () => set((s) => ({ wipeMetadataOnSave: !s.wipeMetadataOnSave })),
  setLegalGuaranteeRedaction: (v) =>
    set((s) => {
      if (v === s.legalGuaranteeRedaction) return {}
      if (v) {
        // Turning LG ON: remember the current autosave setting and force
        // autosave OFF, so the destructive rasterize only ever commits on a
        // deliberate manual save (undo/redo keep working until that save).
        return {
          legalGuaranteeRedaction: true,
          autoSaveBeforeLegalGuarantee: s.autoSaveEnabled,
          autoSaveEnabled: false,
        }
      }
      // Turning LG OFF: restore the autosave setting captured when it was
      // enabled (default ON if we never captured one).
      return {
        legalGuaranteeRedaction: false,
        autoSaveEnabled: s.autoSaveBeforeLegalGuarantee ?? s.autoSaveEnabled,
        autoSaveBeforeLegalGuarantee: null,
      }
    }),
  setDensity: (d) =>
    set(() => {
      const norm = normalizeDensity(d)
      document.documentElement.dataset.density = norm
      return { density: norm }
    }),
  setSaveNotice: (n) => set({ saveNotice: n }),
  requestConfirm: (opts) => {
    // If a confirm is somehow already pending, resolve it false first so its
    // awaiter doesn't hang.
    const prev = get().confirmDialog
    if (prev) prev.resolve(false)
    return new Promise<boolean>((resolve) => {
      const dialog: ConfirmDialogState = {
        title: opts.title,
        message: opts.message,
        confirmLabel: opts.confirmLabel ?? 'Confirm',
        cancelLabel: opts.cancelLabel ?? 'Cancel',
        tone: opts.tone ?? 'warn',
        resolve,
      }
      set({ confirmDialog: dialog })
    })
  },
  resolveConfirm: (ok) => {
    const cd = get().confirmDialog
    set({ confirmDialog: null })
    if (cd) cd.resolve(ok)
  },
}))
