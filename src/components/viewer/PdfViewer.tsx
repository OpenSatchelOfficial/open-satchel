import { useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { useDocumentStore } from '../../stores/documentStore'
import { useUIStore } from '../../stores/uiStore'
import PageRenderer from './PageRenderer'
import { usePdfDocument } from './usePdfDocument'

export default function PdfViewer() {
  const pdfBytes = useDocumentStore((s) => s.pdfBytes)
  const pages = useDocumentStore((s) => s.pages)
  const setCurrentPage = useUIStore((s) => s.setCurrentPage)
  const containerRef = useRef<HTMLDivElement>(null)
  const pdfDoc = usePdfDocument(pdfBytes)

  const visiblePages = pages.filter((p) => !p.deleted)

  // Track current page based on scroll position
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const idx = Number((entry.target as HTMLElement).dataset.pageDisplayIndex)
            if (!isNaN(idx)) setCurrentPage(idx)
          }
        }
      },
      { root: container, threshold: 0.5 }
    )

    const pageEls = container.querySelectorAll('[data-page-display-index]')
    pageEls.forEach((el) => observer.observe(el))

    return () => observer.disconnect()
  }, [visiblePages.length, setCurrentPage])

  if (!pdfDoc) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)' }}>
        Loading PDF...
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      style={{
        overflow: 'auto',
        height: '100%',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '20px 0'
      }}
    >
      {visiblePages.map((page, displayIndex) => (
        <PageRenderer
          key={page.pageIndex}
          pdfDoc={pdfDoc}
          pageIndex={page.pageIndex}
          displayIndex={displayIndex}
          rotation={page.rotation}
        />
      ))}
    </div>
  )
}
