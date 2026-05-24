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

export interface SaveNotice {
  message: string
  /** Accent semantic for the toast — maps to --accent, --good, --warn, --bad. */
  tone: 'info' | 'success' | 'warn' | 'error'
  expiresAt: number
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
  /** Read mode. When true, all editing
   *  chrome is suppressed: paragraph outlines hidden, Fabric objects
   *  rendered but non-interactive, no tool actions fire. The PDF is
   *  viewable like any other reader. Flipping back to `false` returns
   *  to the last-active edit tool. */
  readMode: boolean
  density: DensityName
  saveNotice: SaveNotice | null
}
