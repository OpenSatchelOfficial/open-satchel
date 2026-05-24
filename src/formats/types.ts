import type { ComponentType } from 'react'
import type { DocumentFormat } from '../types/tabs'

export interface FormatViewerProps {
  tabId: string
}

export interface FormatCapabilities {
  edit: boolean
  annotate: boolean
  search: boolean
  zoom: boolean
}

export interface FormatHandler {
  format: DocumentFormat
  extensions: string[]
  displayName: string
  icon: string

  /** Primary content component, rendered in the main pane. */
  Viewer: ComponentType<FormatViewerProps>

  /** Optional sidebar (thumbnails, TOC, layer list, etc.) */
  Sidebar?: ComponentType<FormatViewerProps>

  /** Optional format-specific ribbon (e.g. PDF's tool strip). */
  ToolbarExtras?: ComponentType<FormatViewerProps>

  /** Populate the per-tab format state in formatStore from file bytes. */
  load: (tabId: string, bytes: Uint8Array, filePath: string) => Promise<void>

  /** Serialize current state back to bytes for Save/Save As. */
  save: (tabId: string) => Promise<Uint8Array>

  /** Tear down on tab close. Release big objects, worker refs, etc. */
  cleanup?: (tabId: string) => void

  /** Declared conversion targets (informational; conversions are wired per-pair). */
  canConvertTo: DocumentFormat[]

  capabilities: FormatCapabilities
}
