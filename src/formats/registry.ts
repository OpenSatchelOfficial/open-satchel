import type { FormatHandler } from './types'
import type { DocumentFormat } from '../types/tabs'

const handlers = new Map<DocumentFormat, FormatHandler>()
const extensionMap = new Map<string, FormatHandler>()

export function registerFormat(handler: FormatHandler): void {
  handlers.set(handler.format, handler)
  for (const ext of handler.extensions) {
    extensionMap.set(ext.toLowerCase().replace(/^\./, ''), handler)
  }
}

export function getHandler(format: DocumentFormat): FormatHandler | undefined {
  return handlers.get(format)
}

export function getHandlerForExtension(ext: string): FormatHandler | undefined {
  return extensionMap.get(ext.toLowerCase().replace(/^\./, ''))
}

export function getAllHandlers(): FormatHandler[] {
  return Array.from(handlers.values())
}

export function getAllSupportedExtensions(): string[] {
  return Array.from(extensionMap.keys())
}
