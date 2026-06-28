export interface PageState {
  pageIndex: number
  rotation: 0 | 90 | 180 | 270
  deleted: boolean
  fabricJSON: Record<string, unknown> | null
  formValues: Record<string, string | boolean> | null
}

export interface DocumentState {
  pdfBytes: Uint8Array | null
  filePath: string | null
  fileName: string | null
  isDirty: boolean
  pageCount: number
  pages: PageState[]
}

export type Tool =
  | 'select'
  | 'text'
  | 'draw'
  | 'image'
  | 'signature'
  | 'form'
  | 'highlight'
  | 'underline'
  | 'strikethrough'
  | 'mark_redaction'
  | 'redact'
  | 'shape_rect'
  | 'shape_circle'
  | 'shape_line'
  | 'shape_arrow'
  | 'sticky_note'
  | 'stamp'
  // New WPS-parity tools:
  | 'wipe_off'
  | 'highlight_area'
  | 'textbox_note'
  | 'link'
  | 'audio'
  | 'video'
  | 'insert_text_marker'
  | 'replace_text_marker'
  | 'measure'
  | 'form_designer'
  | 'edit_text'
  | 'edit_image'
  // Fill & Sign quick-stamps
  | 'fill_cross'
  | 'fill_check'
  | 'fill_circle'
  | 'fill_line'
  | 'fill_dot'
  | 'fill_date'
  | 'fill_initials'
  | 'fill_timestamp'

export interface DrawingOptions {
  color: string
  width: number
  opacity: number
}

export interface TextOptions {
  fontFamily: string
  fontSize: number
  color: string
  bold: boolean
  italic: boolean
  underline: boolean
  strikethrough: boolean
  textAlign: 'left' | 'center' | 'right'
  lineHeight: number
  charSpacing: number
  customFontId?: string
}

export type AccentName = 'amber' | 'forest' | 'iris' | 'ink'
export type LayoutMode = 'ribbon' | 'rail'
export type DensityName = 'compact' | 'balanced' | 'roomy'
export type ThemeName = 'light' | 'dark'

export interface SaveNoticeItem {
  severity: 'info' | 'fidelity' | 'security'
  message: string
}

export interface SaveNotice {
  message: string
  /** Accent semantic for the toast — maps to --accent, --good, --warn, --bad. */
  tone: 'info' | 'success' | 'warn' | 'error'
  expiresAt: number
  /** Session-1 degradation channel: structured per-degradation lines.
   *  When present the toast renders ALL of them stacked (security
   *  visually distinct) instead of the single `message`, which stays
   *  as the one-line fallback for older callers. */
  items?: SaveNoticeItem[]
  /** Info-level degradations not shown in full — rendered as a
   *  collapsed "+N info" line; full text lives in the save report. */
  hiddenInfoCount?: number
  /** Optional single action button (e.g. the Legal-Guarantee post-save
   *  "Done — re-enable autosave"). Clicking runs `run` then dismisses. */
  action?: { label: string; run: () => void }
}

/** An in-app blocking confirmation, used instead of window.confirm — which
 *  WebView2 SILENTLY SUPPRESSES in the packaged production build, so a
 *  destructive-action warning (e.g. the redaction "no undo" prompt) would
 *  never appear for users. The promise-based requestConfirm stores `resolve`
 *  here; the <ConfirmModal> renders it and calls resolveConfirm(true|false). */
export interface ConfirmDialogState {
  title: string
  message: string
  confirmLabel: string
  cancelLabel: string
  /** 'danger' = destructive/irreversible (red confirm button). */
  tone: 'warn' | 'danger'
  resolve: (ok: boolean) => void
}

export interface UIState {
  currentPage: number
  zoom: number
  tool: Tool
  sidebarOpen: boolean
  drawingOptions: DrawingOptions
  textOptions: TextOptions
  highlightColor: string
  /** Highlighter width preset (px). Applied when the highlight tool
   *  draws over text or a dragged region. */
  highlightWidth: 'thin' | 'medium' | 'thick'
  /** Highlighter opacity (0..1). Two presets: subtle + bold. */
  highlightOpacity: number
  shapeColor: string
  shapeStrokeWidth: number
  noteColor: string
  selectedStamp: number
  textStampTemplate: string
  initials: string
  searchVisible: boolean
  theme: ThemeName
  /** Redesign-v2 accent picker. Defaults to amber. */
  accent: AccentName
  /** Ribbon (chip tabs across format) vs Rail (slim 10-tool rail + ⌘K
   *  command launcher). Defaults to ribbon — that's the breadth-friendly
   *  surface for ~80 PDF tools. */
  layout: LayoutMode
  /** Stable annotation column to the right of the page. Empty shell for
   *  now; comments/threads bind in a later pass. */
  showAnnotationGutter: boolean
  commandPaletteOpen: boolean
  findReplaceOpen: boolean
  findReplaceMode: 'find' | 'replace'
  autoSaveEnabled: boolean
  autoSaveInterval: number
  autoSaveStatus: 'idle' | 'saving' | 'saved'
  autoLayoutTextEdits: boolean
  showRulers: boolean
  showGrid: boolean
  showLayers: boolean
  showComments: boolean
  snapToGrid: boolean
  gridSize: number
  // Guides are purely visual and not persisted into the PDF. Keyed by
  // `${tabId}:${pageIndex}` so different open tabs have independent
  // sets. UI-only state; cleared when the tab closes.
  guides: Record<string, Array<{ axis: 'h' | 'v'; pos: number }>>
  // Fallback font family used by paragraph editor whiteout-and-redraw
  // when the original embedded font can't be re-used. Kept in sync with
  // pdf-lib StandardFonts names.
  fallbackFontFamily: 'Helvetica' | 'TimesRoman' | 'Courier'
  /** §3: embed the installed file for office-suite font names
   *  (Arial/Calibri/Cambria/…) on an exact match instead of
   *  substituting Standard-14 metrics in the overlay bake. Default false
   *  (compact Standard-14 output); on trades file size for exact fidelity. */
  embedInstalledFonts: boolean
  /** When true, every committing save wipes document metadata (the /Info
   *  dict — title/author/subject/keywords/creator/producer/dates — and the
   *  XMP /Metadata packet). Surfaced as an optional checkbox beside the
   *  redaction tools, since "sanitize this document for release" is the
   *  same intent. Default false. */
  wipeMetadataOnSave: boolean
  /** Legal Guarantee redaction. When true, a committing save FLATTENS every
   *  page carrying a redaction mark to a secured image by construction
   *  (render → burn the marks into the pixels → replace /Contents → drop the
   *  original stream + scrub page metadata + flatten annotations), making the
   *  removal permanent and irrecoverable. Enabling it force-disables autosave
   *  so the destructive rasterize only commits on a deliberate manual save.
   *  Default false. Surfaced beside the metadata-wipe checkbox; ticking opens
   *  a 2-page walkthrough and the flag only persists after the final confirm. */
  legalGuaranteeRedaction: boolean
  /** Internal: the autosave-enabled state captured when Legal Guarantee was
   *  turned on, restored when it is turned off. null when LG is off. */
  autoSaveBeforeLegalGuarantee: boolean | null
  /** Phase D of docs/MODELESS.md — Read mode. When true, all editing
   *  chrome is suppressed: paragraph outlines hidden, Fabric objects
   *  rendered but non-interactive, no tool actions fire. The PDF is
   *  viewable like any other reader. Flipping back to `false` returns
   *  to the last-active edit tool. */
  readMode: boolean
  density: DensityName
  saveNotice: SaveNotice | null
  /** Pending in-app blocking confirmation (replaces window.confirm). Rendered
   *  by <ConfirmModal>; null when nothing is pending. */
  confirmDialog: ConfirmDialogState | null
}
