import { useEffect, useRef, useState } from 'react'
import type { FormatViewerProps } from '../types'
import { useFormatStore } from '../../stores/formatStore'
import { useTabStore } from '../../stores/tabStore'
import { useUIStore } from '../../stores/uiStore'
import type { PdfFormatState } from './index'
import BookmarksPanel from './BookmarksPanel'
import AttachmentsPanel from './AttachmentsPanel'
import A11yPanel from './A11yPanel'
import { canDeletePageBySourceIndex } from './pageDeleteGuards'

type SidebarTab = 'pages' | 'bookmarks' | 'attachments' | 'a11y'

export default function PdfSidebar({ tabId }: FormatViewerProps) {
  const state = useFormatStore((s) => s.data[tabId] as PdfFormatState | undefined)
  const currentPage = useUIStore((s) => s.currentPage)
  const setCurrentPage = useUIStore((s) => s.setCurrentPage)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const [tab, setTab] = useState<SidebarTab>('pages')

  if (!state) return null

  const rotatePage = (pageIndex: number) => {
    useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({
      ...prev,
      pages: prev.pages.map((p) =>
        p.pageIndex === pageIndex
          ? { ...p, rotation: ((p.rotation + 90) % 360) as 0 | 90 | 180 | 270 }
          : p
      )
    }))
    useTabStore.getState().setTabDirty(tabId, true)
  }

  const deletePage = (pageIndex: number) => {
    if (!canDeletePageBySourceIndex(state.pages, pageIndex)) return
    useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({
      ...prev,
      pages: prev.pages.map((p) =>
        p.pageIndex === pageIndex ? { ...p, deleted: true } : p
      )
    }))
    useTabStore.getState().setTabDirty(tabId, true)
  }

  const restorePage = (pageIndex: number) => {
    useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({
      ...prev,
      pages: prev.pages.map((p) =>
        p.pageIndex === pageIndex ? { ...p, deleted: false } : p
      )
    }))
    useTabStore.getState().setTabDirty(tabId, true)
  }

  const handleDragStart = (i: number) => setDragIndex(i)
  const handleDragOver = (e: React.DragEvent, i: number) => { e.preventDefault(); setDragOverIndex(i) }
  const handleDrop = (targetIndex: number) => {
    if (dragIndex === null || dragIndex === targetIndex) { setDragIndex(null); setDragOverIndex(null); return }
    useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => {
      const updated = [...prev.pages]
      const [moved] = updated.splice(dragIndex, 1)
      updated.splice(targetIndex, 0, moved)
      return { ...prev, pages: updated }
    })
    useTabStore.getState().setTabDirty(tabId, true)
    setDragIndex(null); setDragOverIndex(null)
  }
  const handleDragEnd = () => { setDragIndex(null); setDragOverIndex(null) }

  return (
    <div style={{
      background: 'var(--bg-primary)', borderRight: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
    }}>
      <div
        data-testid="sidebar-tabs"
        style={{
          display: 'flex', borderBottom: '1px solid var(--border)',
          flexShrink: 0, background: 'var(--bg-primary)',
        }}>
        <TabBtn active={tab === 'pages'} onClick={() => setTab('pages')} testId="tab-pages">Pages</TabBtn>
        <TabBtn active={tab === 'bookmarks'} onClick={() => setTab('bookmarks')} testId="tab-bookmarks">Bookmarks</TabBtn>
        <TabBtn active={tab === 'attachments'} onClick={() => setTab('attachments')} testId="tab-attachments">Files</TabBtn>
        <TabBtn active={tab === 'a11y'} onClick={() => setTab('a11y')} testId="tab-a11y">A11y</TabBtn>
      </div>

      {tab === 'pages' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: 8, minHeight: 0 }}>
          {state.pages.map((page, i) => (
            <PageThumbnail
              key={page.pageIndex}
              pageIndex={page.pageIndex}
              displayIndex={i}
              deleted={page.deleted}
              rotation={page.rotation}
              active={currentPage === i}
              pdfBytes={state.pdfBytes}
              isDragging={dragIndex === i}
              isDragOver={dragOverIndex === i}
              onClick={() => setCurrentPage(i)}
              onJumpTo={() => {
                // Double-click: select + scroll the main viewer to the page.
                // setCurrentPage updates the active-page indicator; the
                // scrollIntoView mirrors the BookmarksPanel/CommentsPanel
                // navigation pattern so all "jump to page N" gestures
                // feel identical.
                setCurrentPage(i)
                const el = document.querySelector(
                  `[data-page-display-index="${i}"]`,
                ) as HTMLElement | null
                el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }}
              onRotate={() => rotatePage(page.pageIndex)}
              onDelete={() => deletePage(page.pageIndex)}
              canDelete={!page.deleted && canDeletePageBySourceIndex(state.pages, page.pageIndex)}
              onRestore={() => restorePage(page.pageIndex)}
              onDragStart={() => handleDragStart(i)}
              onDragOver={(e) => handleDragOver(e, i)}
              onDrop={() => handleDrop(i)}
              onDragEnd={handleDragEnd}
            />
          ))}
        </div>
      )}
      {tab === 'bookmarks' && (
        <div style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
          <BookmarksPanel tabId={tabId} />
        </div>
      )}
      {tab === 'attachments' && (
        <div style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
          <AttachmentsPanel tabId={tabId} />
        </div>
      )}
      {tab === 'a11y' && (
        <div style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
          <A11yPanel tabId={tabId} />
        </div>
      )}
    </div>
  )
}

function TabBtn({ active, onClick, children, testId }: {
  active: boolean; onClick: () => void; children: React.ReactNode; testId?: string
}) {
  return (
    <button
      data-testid={testId}
      onClick={onClick}
      style={{
        flex: 1, padding: '6px 4px', fontSize: 10, fontWeight: active ? 600 : 400,
        color: active ? 'var(--accent)' : 'var(--text-secondary)',
        background: 'transparent',
        borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
        border: 'none', borderRadius: 0, cursor: 'pointer',
        transition: 'color 0.1s, border-color 0.1s',
      }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'var(--bg-hover)' }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent' }}
    >
      {children}
    </button>
  )
}

function PageThumbnail({
  pageIndex, displayIndex, deleted, rotation, active, pdfBytes,
  isDragging, isDragOver,
  onClick, onJumpTo, onRotate, onDelete, canDelete, onRestore,
  onDragStart, onDragOver, onDrop, onDragEnd
}: {
  pageIndex: number; displayIndex: number; deleted: boolean; rotation: number;
  active: boolean; pdfBytes: Uint8Array;
  isDragging: boolean; isDragOver: boolean;
  /** Single-click: highlight this thumbnail without scrolling. Useful
   *  when the user is selecting + then issuing a page op. */
  onClick: () => void;
  /** Double-click: scroll the main viewer to this page AND select it. */
  onJumpTo: () => void;
  onRotate: () => void; onDelete: () => void; canDelete: boolean; onRestore: () => void;
  onDragStart: () => void; onDragOver: (e: React.DragEvent) => void; onDrop: () => void; onDragEnd: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState(false)
  const [shouldRender, setShouldRender] = useState(false)

  // Visibility gate. Without this, mounting a sidebar with 15+
  // thumbnails on a 33 MB PDF fires 15+ pdfjs.getPage(N) +
  // canvas-render calls in the same tick — each call blocks the
  // event loop while the worker decompresses content streams,
  // freezing the editor for 30-60 s. With the gate, only the few
  // thumbnails actually visible in the panel render eagerly; the
  // rest defer until the user scrolls the sidebar.
  useEffect(() => {
    if (shouldRender) return
    const el = wrapperRef.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') {
      // Old WebView fallback — render eagerly.
      setShouldRender(true)
      return
    }
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShouldRender(true)
          obs.disconnect()
        }
      },
      { rootMargin: '300px' }, // start rendering ~1 thumbnail-height ahead
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [shouldRender])

  useEffect(() => {
    if (!shouldRender) return
    let cancelled = false
    const render = async () => {
      const canvas = canvasRef.current
      if (!canvas) return
      try {
        // Share one pdfjs document across the whole tab — viewer +
        // every thumbnail + light pages all draw from the same
        // PDFDocumentProxy.
        const { getPdfDoc } = await import('../../components/viewer/pdfDocCache')
        const doc = await getPdfDoc(pdfBytes)
        if (cancelled) return
        const page = await doc.getPage(pageIndex + 1)
        if (cancelled) { page.cleanup(); return }
        const intrinsicRotation = (page as any).rotate || 0
        const effectiveRotation = (intrinsicRotation + rotation) % 360
        const viewport = page.getViewport({ scale: 0.2, rotation: effectiveRotation })
        canvas.width = viewport.width
        canvas.height = viewport.height
        const ctx = canvas.getContext('2d')!
        await page.render({ canvasContext: ctx, viewport }).promise
        page.cleanup()
        setError(false)
      } catch (err) {
        if (cancelled) return
        console.error('Thumbnail render error for page', pageIndex, err)
        setError(true)
        const ctx = canvas.getContext('2d')
        if (ctx) {
          canvas.width = 122; canvas.height = 158
          ctx.fillStyle = '#2a2a3a'
          ctx.fillRect(0, 0, 122, 158)
          ctx.fillStyle = '#f38ba8'
          ctx.font = 'bold 20px sans-serif'
          ctx.textAlign = 'center'
          ctx.fillText('!', 61, 86)
        }
      }
    }
    render()
    return () => { cancelled = true }
  }, [shouldRender, pdfBytes, pageIndex, rotation])

  return (
    <div
      ref={wrapperRef}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onClick={onClick}
      onDoubleClick={onJumpTo}
      title={`Page ${displayIndex + 1} — double-click to jump`}
      style={{
        position: 'relative', padding: 4, marginBottom: 4, borderRadius: 4,
        border: isDragOver ? '2px dashed var(--accent)' : active ? '2px solid var(--accent)' : '2px solid transparent',
        opacity: isDragging ? 0.4 : deleted ? 0.3 : 1, cursor: 'grab',
        background: active ? 'var(--bg-surface)' : 'transparent',
        transition: 'opacity 0.15s, border-color 0.15s',
        // Reserve space for the canvas so the IntersectionObserver
        // root can detect the slot before the canvas itself paints.
        // 122×158 matches the error-state placeholder dimensions.
        minHeight: 158,
      }}
    >
      <canvas ref={canvasRef} style={{ width: '100%', display: 'block', borderRadius: 2 }} />
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginTop: 2, fontSize: 10, color: 'var(--text-muted)'
      }}>
        <span>{displayIndex + 1}</span>
        <div style={{ display: 'flex', gap: 2 }}>
          <button title="Rotate" onClick={(e) => { e.stopPropagation(); onRotate() }}
            style={{ fontSize: 10, padding: '1px 3px', borderRadius: 2 }}>↻</button>
          {deleted ? (
            <button title="Restore" onClick={(e) => { e.stopPropagation(); onRestore() }}
              style={{ fontSize: 10, padding: '1px 3px', borderRadius: 2, color: 'var(--success)' }}>↩</button>
          ) : (
            <button title={canDelete ? 'Delete' : 'Cannot delete the only page'} disabled={!canDelete} onClick={(e) => { e.stopPropagation(); onDelete() }}
              style={{ fontSize: 10, padding: '1px 3px', borderRadius: 2, color: 'var(--danger)' }}>✕</button>
          )}
        </div>
      </div>
    </div>
  )
}
