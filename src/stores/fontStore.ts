import { create } from 'zustand'

export const STANDARD_FONTS = [
  'Helvetica',
  'Helvetica-Bold',
  'Helvetica-Oblique',
  'Times-Roman',
  'Times-Bold',
  'Times-Italic',
  'Courier',
  'Courier-Bold',
  'Courier-Oblique',
  'Symbol',
  'ZapfDingbats'
] as const

export interface CustomFont {
  id: string
  name: string
  fileName: string
}

interface FontState {
  customFonts: CustomFont[]
  loaded: boolean
  loadFonts: () => Promise<void>
  importFont: () => Promise<void>
  removeFont: (id: string) => Promise<void>
}

export const useFontStore = create<FontState>((set, get) => ({
  customFonts: [],
  loaded: false,

  loadFonts: async () => {
    if (get().loaded) return
    try {
      const entries = await window.api.font.list()
      const fonts: CustomFont[] = entries.map((e) => ({
        id: e.id,
        name: e.name,
        fileName: e.fileName
      }))

      // Load each custom font into the browser via FontFace API
      for (const font of fonts) {
        try {
          const bytes = await window.api.font.getBytes(font.id)
          const fontFace = new FontFace(font.name, bytes.buffer)
          await fontFace.load()
          document.fonts.add(fontFace)
        } catch (err) {
          console.warn(`Failed to load font "${font.name}" into browser:`, err)
        }
      }

      set({ customFonts: fonts, loaded: true })
    } catch (err) {
      console.error('Failed to load fonts:', err)
      set({ loaded: true })
    }
  },

  importFont: async () => {
    try {
      const entry = await window.api.font.import()
      if (!entry) return

      // Load into browser
      try {
        const bytes = await window.api.font.getBytes(entry.id)
        const fontFace = new FontFace(entry.name, bytes.buffer)
        await fontFace.load()
        document.fonts.add(fontFace)
      } catch (err) {
        console.warn(`Failed to load imported font "${entry.name}" into browser:`, err)
      }

      set((s) => ({
        customFonts: [...s.customFonts, { id: entry.id, name: entry.name, fileName: entry.fileName }]
      }))
    } catch (err) {
      console.error('Failed to import font:', err)
    }
  },

  removeFont: async (id: string) => {
    try {
      await window.api.font.remove(id)
      set((s) => ({
        customFonts: s.customFonts.filter((f) => f.id !== id)
      }))
    } catch (err) {
      console.error('Failed to remove font:', err)
    }
  }
}))
