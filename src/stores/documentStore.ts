import { create } from 'zustand'
import type { DocumentState, PageState } from '../types/pdf'

interface DocumentActions {
  loadDocument: (bytes: Uint8Array, path: string | null, pageCount: number) => void
  closeDocument: () => void
  setDirty: (dirty: boolean) => void
  setFilePath: (path: string) => void
  updatePageFabricJSON: (pageIndex: number, json: Record<string, unknown>) => void
  updatePageFormValues: (pageIndex: number, values: Record<string, string | boolean>) => void
  rotatePage: (pageIndex: number) => void
  deletePage: (pageIndex: number) => void
  restorePage: (pageIndex: number) => void
  reorderPages: (fromIndex: number, toIndex: number) => void
}

export const useDocumentStore = create<DocumentState & DocumentActions>((set) => ({
  pdfBytes: null,
  filePath: null,
  fileName: null,
  isDirty: false,
  pageCount: 0,
  pages: [],

  loadDocument: (bytes, path, pageCount) => {
    const fileName = path ? path.split(/[/\\]/).pop() || null : null
    const pages: PageState[] = Array.from({ length: pageCount }, (_, i) => ({
      pageIndex: i,
      rotation: 0,
      deleted: false,
      fabricJSON: null,
      formValues: null
    }))
    set({ pdfBytes: bytes, filePath: path, fileName, isDirty: false, pageCount, pages })
  },

  closeDocument: () =>
    set({
      pdfBytes: null,
      filePath: null,
      fileName: null,
      isDirty: false,
      pageCount: 0,
      pages: []
    }),

  setDirty: (dirty) => set({ isDirty: dirty }),

  setFilePath: (path) => {
    const fileName = path.split(/[/\\]/).pop() || null
    set({ filePath: path, fileName })
  },

  updatePageFabricJSON: (pageIndex, json) =>
    set((state) => ({
      pages: state.pages.map((p) =>
        p.pageIndex === pageIndex ? { ...p, fabricJSON: json } : p
      ),
      isDirty: true
    })),

  updatePageFormValues: (pageIndex, values) =>
    set((state) => ({
      pages: state.pages.map((p) =>
        p.pageIndex === pageIndex ? { ...p, formValues: values } : p
      ),
      isDirty: true
    })),

  rotatePage: (pageIndex) =>
    set((state) => ({
      pages: state.pages.map((p) =>
        p.pageIndex === pageIndex
          ? { ...p, rotation: ((p.rotation + 90) % 360) as PageState['rotation'] }
          : p
      ),
      isDirty: true
    })),

  deletePage: (pageIndex) =>
    set((state) => ({
      pages: state.pages.map((p) =>
        p.pageIndex === pageIndex ? { ...p, deleted: true } : p
      ),
      isDirty: true
    })),

  restorePage: (pageIndex) =>
    set((state) => ({
      pages: state.pages.map((p) =>
        p.pageIndex === pageIndex ? { ...p, deleted: false } : p
      ),
      isDirty: true
    })),

  reorderPages: (fromIndex, toIndex) =>
    set((state) => {
      const pages = [...state.pages]
      const [moved] = pages.splice(fromIndex, 1)
      pages.splice(toIndex, 0, moved)
      return { pages, isDirty: true }
    })
}))
