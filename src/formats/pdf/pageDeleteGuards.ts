import type { PdfPageState } from './index'

export function hasActivePageAfterDeleting(
  pages: PdfPageState[],
  shouldDelete: (page: PdfPageState, index: number) => boolean,
): boolean {
  return pages.some((page, index) => !page.deleted && !shouldDelete(page, index))
}

export function canDeletePageBySourceIndex(pages: PdfPageState[], pageIndex: number): boolean {
  return hasActivePageAfterDeleting(pages, (page) => page.pageIndex === pageIndex)
}

export function canDeletePageSelection(pages: PdfPageState[], selected: Set<number>): boolean {
  if (selected.size === 0) return false
  const hasActiveSelectedPage = pages.some((page, index) => selected.has(index) && !page.deleted)
  return hasActiveSelectedPage && hasActivePageAfterDeleting(pages, (_page, index) => selected.has(index))
}
