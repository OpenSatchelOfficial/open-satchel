import { useState, useEffect, useRef, useCallback } from 'react'
import type { FormatViewerProps } from '../types'
import { useFormatStore } from '../../stores/formatStore'
import { useTabStore } from '../../stores/tabStore'
import type { PdfFormatState, PdfPageState } from './index'
import { PDFDocument, degrees } from 'pdf-lib'
import { canDeletePageSelection } from './pageDeleteGuards'

interface Props extends FormatViewerProps {
  onClose: () => void
}

type PageFilter = 'all' | 'odd' | 'even'

export default function PdfPageManager({ tabId, onClose }: Props) {
  const state = useFormatStore((s) => s.data[tabId] as PdfFormatState | undefined)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const [filter, setFilter] = useState<PageFilter>('all')

  if (!state) return null

  const pages = state.pages

  const toggleSelect = (index: number, e: React.MouseEvent) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (e.ctrlKey || e.metaKey) {
        if (next.has(index)) next.delete(index)
        else next.add(index)
      } else if (e.shiftKey && prev.size > 0) {
        const lastSelected = Math.max(...Array.from(prev))
        const [start, end] = index > lastSelected ? [lastSelected, index] : [index, lastSelected]
        for (let i = start; i <= end; i++) next.add(i)
      } else {
        if (next.size === 1 && next.has(index)) {
          next.clear()
        } else {
          next.clear()
          next.add(index)
        }
      }
      return next
    })
  }

  const updatePages = (updater: (pages: PdfPageState[]) => PdfPageState[]) => {
    useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({
      ...prev,
      pages: updater(prev.pages)
    }))
    useTabStore.getState().setTabDirty(tabId, true)
  }

  const handleDelete = () => {
    if (selected.size === 0) return
    if (!canDeletePageSelection(pages, selected)) return
    updatePages((pages) =>
      pages.map((p, i) => selected.has(i) ? { ...p, deleted: true } : p)
    )
    setSelected(new Set())
  }

  const handleRotateCW = () => {
    if (selected.size === 0) return
    updatePages((pages) =>
      pages.map((p, i) =>
        selected.has(i) ? { ...p, rotation: ((p.rotation + 90) % 360) as 0 | 90 | 180 | 270 } : p
      )
    )
  }

  const handleRotateCCW = () => {
    if (selected.size === 0) return
    updatePages((pages) =>
      pages.map((p, i) =>
        selected.has(i) ? { ...p, rotation: ((p.rotation + 270) % 360) as 0 | 90 | 180 | 270 } : p
      )
    )
  }

  const handleInsertBlank = () => {
    const insertAt = selected.size > 0 ? Math.max(...Array.from(selected)) + 1 : pages.length
    updatePages((pages) => {
      const newPage: PdfPageState = {
        pageIndex: -1 - Date.now(), // Negative index means blank page
        rotation: 0,
        deleted: false,
        fabricJSON: null,
        formValues: null
      }
      const updated = [...pages]
      updated.splice(insertAt, 0, newPage)
      return updated
    })
    setSelected(new Set())
  }

  const handleDuplicate = () => {
    if (selected.size === 0) return
    updatePages((pages) => {
      const result: PdfPageState[] = []
      for (let i = 0; i < pages.length; i++) {
        result.push(pages[i])
        if (selected.has(i)) {
          result.push({
            ...pages[i],
            fabricJSON: pages[i].fabricJSON ? JSON.parse(JSON.stringify(pages[i].fabricJSON)) : null
          })
        }
      }
      return result
    })
    setSelected(new Set())
  }

  const handleExtract = async () => {
    if (selected.size === 0) return
    try {
      const source = await PDFDocument.load(state.pdfBytes)
      const extracted = await PDFDocument.create()
      const selectedPages = Array.from(selected).sort((a, b) => a - b)

      for (const idx of selectedPages) {
        const page = pages[idx]
        if (page.pageIndex < 0) {
          // Blank page
          extracted.addPage()
        } else {
          const [copiedPage] = await extracted.copyPages(source, [page.pageIndex])
          if (page.rotation !== 0) {
            copiedPage.setRotation(degrees(page.rotation))
          }
          extracted.addPage(copiedPage)
        }
      }

      const extractedBytes = await extracted.save()
      const path = await window.api.file.saveAs(new Uint8Array(extractedBytes))
      if (path) {
        // Saved successfully
      }
    } catch (err) {
      console.error('Extract failed:', err)
    }
  }

  const handleDragStart = (index: number) => {
    setDragIndex(index)
  }

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault()
    setDragOverIndex(index)
  }

  const handleDrop = (targetIndex: number) => {
    if (dragIndex === null || dragIndex === targetIndex) {
      setDragIndex(null)
      setDragOverIndex(null)
      return
    }
    updatePages((pages) => {
      const updated = [...pages]
      const [moved] = updated.splice(dragIndex, 1)
      updated.splice(targetIndex, 0, moved)
      return updated
    })
    setSelected(new Set())
    setDragIndex(null)
    setDragOverIndex(null)
  }

  const handleDragEnd = () => {
    setDragIndex(null)
    setDragOverIndex(null)
  }

  const handleRestore = () => {
    if (selected.size === 0) return
    updatePages((pages) =>
      pages.map((p, i) => selected.has(i) ? { ...p, deleted: false } : p)
    )
    setSelected(new Set())
  }

  const hasDeletedInSelection = Array.from(selected).some((i) => pages[i]?.deleted)
  const canDeleteSelection = canDeletePageSelection(pages, selected)

  return (
    <div data-testid="page-manager-dialog" style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
    }} onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{
        background: 'var(--bg-primary)', borderRadius: 8, padding: 0,
        border: '1px solid var(--border)', width: '80vw', maxWidth: 900,
        height: '80vh', display: 'flex', flexDirection: 'column',
        overflow: 'hidden'
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '12px 20px', borderBottom: '1px solid var(--border)', flexShrink: 0
        }}>
          <h3 style={{ margin: 0, fontSize: 16, color: 'var(--text-primary)' }}>Page Manager</h3>
          <button onClick={onClose} style={{
            fontSize: 18, background: 'transparent', border: 'none',
            color: 'var(--text-secondary)', cursor: 'pointer'
          }}>x</button>
        </div>

        {/* Toolbar */}
        <div style={{
          display: 'flex', gap: 6, padding: '8px 20px',
          borderBottom: '1px solid var(--border)', flexShrink: 0, flexWrap: 'wrap', alignItems: 'center'
        }}>
          <select
            data-testid="page-filter"
            value={filter}
            onChange={(e) => {
              const f = e.target.value as PageFilter
              setFilter(f)
              if (f === 'all') { setSelected(new Set()); return }
              const want = f === 'odd' ? 0 : 1 // odd pages are displayed as 1,3,5 → indices 0,2,4
              setSelected(new Set(pages.map((_, i) => i).filter((i) => i % 2 === want)))
            }}
            style={{
              padding: '5px 8px', fontSize: 11, borderRadius: 4,
              background: 'var(--bg-surface)', color: 'var(--text-primary)',
              border: '1px solid var(--border)', cursor: 'pointer'
            }}
          >
            <option value="all">All Pages</option>
            <option value="odd">Odd Pages</option>
            <option value="even">Even Pages</option>
          </select>
          <ActionBtn label="Rotate CW" onClick={handleRotateCW} disabled={selected.size === 0} />
          <ActionBtn label="Rotate CCW" onClick={handleRotateCCW} disabled={selected.size === 0} />
          <ActionBtn label="Delete" onClick={handleDelete} disabled={!canDeleteSelection} danger />
          {hasDeletedInSelection && (
            <ActionBtn label="Restore" onClick={handleRestore} />
          )}
          <div style={{ width: 1, height: 24, background: 'var(--border)' }} />
          <ActionBtn label="Insert Blank" onClick={handleInsertBlank} />
          <ActionBtn label="Duplicate" onClick={handleDuplicate} disabled={selected.size === 0} />
          <ActionBtn label="Extract as PDF" onClick={handleExtract} disabled={selected.size === 0} />
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: 'var(--text-muted)', alignSelf: 'center' }}>
            {pages.length} pages | {selected.size} selected
          </span>
        </div>

        {/* Page grid */}
        <div style={{
          flex: 1, overflow: 'auto', padding: 20,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
          gap: 12, alignContent: 'start'
        }}>
          {pages.map((page, index) => (
            <PageThumbnailCard
              key={`${page.pageIndex}-${index}`}
              page={page}
              index={index}
              isSelected={selected.has(index)}
              isDragOver={dragOverIndex === index}
              isDragging={dragIndex === index}
              pdfBytes={state.pdfBytes}
              onClick={(e) => toggleSelect(index, e)}
              onDragStart={() => handleDragStart(index)}
              onDragOver={(e) => handleDragOver(e, index)}
              onDrop={() => handleDrop(index)}
              onDragEnd={handleDragEnd}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function PageThumbnailCard({
  page, index, isSelected, isDragOver, isDragging, pdfBytes,
  onClick, onDragStart, onDragOver, onDrop, onDragEnd
}: {
  page: PdfPageState; index: number; isSelected: boolean;
  isDragOver: boolean; isDragging: boolean; pdfBytes: Uint8Array;
  onClick: (e: React.MouseEvent) => void;
  onDragStart: () => void; onDragOver: (e: React.DragEvent) => void;
  onDrop: () => void; onDragEnd: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [rendered, setRendered] = useState(false)

  const renderThumbnail = useCallback(async () => {
    const canvas = canvasRef.current
    if (!canvas || rendered) return

    if (page.pageIndex < 0) {
      // Blank page
      canvas.width = 120
      canvas.height = 160
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, 120, 160)
      ctx.strokeStyle = '#cccccc'
      ctx.strokeRect(0, 0, 120, 160)
      ctx.fillStyle = '#999999'
      ctx.font = '12px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('Blank', 60, 85)
      setRendered(true)
      return
    }

    try {
      const pdfjsLib = await import('pdfjs-dist')
      const doc = await pdfjsLib.getDocument({ data: pdfBytes.slice() }).promise
      const pdfPage = await doc.getPage(page.pageIndex + 1)
      // Combine intrinsic page rotation with user rotation
      const intrinsicRotation = (pdfPage as any).rotate || 0
      const effectiveRotation = (intrinsicRotation + page.rotation) % 360
      const viewport = pdfPage.getViewport({ scale: 0.25, rotation: effectiveRotation })
      canvas.width = viewport.width
      canvas.height = viewport.height
      const ctx = canvas.getContext('2d')!
      await pdfPage.render({ canvasContext: ctx, viewport }).promise
      pdfPage.cleanup()
      doc.destroy()
      setRendered(true)
    } catch (err) {
      console.error('Thumbnail render failed:', err)
    }
  }, [pdfBytes, page.pageIndex, page.rotation, rendered])

  useEffect(() => { renderThumbnail() }, [renderThumbnail])
  useEffect(() => { setRendered(false) }, [page.rotation])

  return (
    <div
      draggable
      data-testid={`pm-tile-${index}`}
      data-page-index={page.pageIndex}
      data-page-deleted={page.deleted ? '1' : '0'}
      data-page-rotation={page.rotation}
      data-page-selected={isSelected ? '1' : '0'}
      onClick={onClick}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      style={{
        position: 'relative', padding: 8, borderRadius: 6, cursor: 'pointer',
        border: isSelected ? '2px solid var(--accent)' : isDragOver ? '2px dashed var(--accent)' : '2px solid var(--border)',
        background: isSelected ? 'var(--bg-surface)' : 'var(--bg-primary)',
        opacity: page.deleted ? 0.35 : isDragging ? 0.5 : 1,
        transition: 'border-color 0.15s, opacity 0.15s, background 0.15s',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4
      }}
    >
      <canvas ref={canvasRef} style={{ width: '100%', maxHeight: 180, display: 'block', borderRadius: 2 }} />
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        width: '100%', fontSize: 11, color: 'var(--text-muted)'
      }}>
        <span>Page {index + 1}</span>
        {page.deleted && <span style={{ color: 'var(--danger)', fontSize: 9 }}>DELETED</span>}
        {page.rotation !== 0 && <span style={{ fontSize: 9 }}>{page.rotation}deg</span>}
      </div>
    </div>
  )
}

function ActionBtn({ label, onClick, disabled, danger }: {
  label: string; onClick: () => void; disabled?: boolean; danger?: boolean
}) {
  // Derive a stable testid from the label so tests can target buttons
  // by data-testid="pm-rotate-cw", "pm-delete", etc. (label-based
  // ribbon_click_button works too but a dedicated id is more durable
  // when copy changes.)
  const testid = 'pm-' + label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return (
    <button data-testid={testid} onClick={onClick} disabled={disabled} style={{
      padding: '5px 12px', fontSize: 11, borderRadius: 4,
      background: danger ? 'var(--danger)' : 'var(--bg-surface)',
      color: danger ? '#fff' : 'var(--text-primary)',
      border: '1px solid var(--border)',
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.4 : 1, fontWeight: 500,
      transition: 'background 0.1s'
    }}>{label}</button>
  )
}
