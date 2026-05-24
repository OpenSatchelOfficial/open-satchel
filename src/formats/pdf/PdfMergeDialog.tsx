import { useState } from 'react'
import { useTabStore } from '../../stores/tabStore'
import { openFileFromPath } from '../../App'

interface MergeFile {
  id: string
  name: string
  path: string
  bytes: Uint8Array
}

interface Props {
  onClose: () => void
}

export default function PdfMergeDialog({ onClose }: Props) {
  const [files, setFiles] = useState<MergeFile[]>([])
  const [merging, setMerging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)

  const handleAddFiles = async () => {
    try {
      const result = await window.api.file.openMultiple()
      if (!result) return
      const pdfFiles = result.filter((f) => f.path.toLowerCase().endsWith('.pdf'))
      const newFiles: MergeFile[] = pdfFiles.map((f) => ({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: f.path.split(/[/\\]/).pop() || 'Unknown.pdf',
        path: f.path,
        bytes: f.bytes
      }))
      setFiles((prev) => [...prev, ...newFiles])
      setError(null)
    } catch (err) {
      setError('Failed to open files')
    }
  }

  const handleRemove = (id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id))
  }

  const handleMerge = async () => {
    if (files.length < 2) {
      setError('Add at least 2 PDFs to merge')
      return
    }

    setMerging(true)
    setError(null)

    try {
      const bytesArray = files.map((f) => f.bytes)
      const merged = await window.api.pdf.merge(bytesArray)
      const mergedBytes = new Uint8Array(merged)

      // Save the merged PDF
      const savePath = await window.api.file.saveAs(mergedBytes)
      if (savePath) {
        // Open the merged file as a new tab
        await openFileFromPath(savePath, mergedBytes)
        onClose()
      }
    } catch (err) {
      setError(`Merge failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setMerging(false)
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
    setFiles((prev) => {
      const updated = [...prev]
      const [moved] = updated.splice(dragIndex, 1)
      updated.splice(targetIndex, 0, moved)
      return updated
    })
    setDragIndex(null)
    setDragOverIndex(null)
  }

  const handleDragEnd = () => {
    setDragIndex(null)
    setDragOverIndex(null)
  }

  return (
    <div data-testid="merge-dialog" style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
    }} onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{
        background: 'var(--bg-primary)', borderRadius: 8, padding: 24,
        border: '1px solid var(--border)', minWidth: 480, maxWidth: 600,
        maxHeight: '70vh', display: 'flex', flexDirection: 'column'
      }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 16, color: 'var(--text-primary)' }}>Merge PDFs</h3>
          <button onClick={onClose} style={{
            fontSize: 18, background: 'transparent', border: 'none',
            color: 'var(--text-secondary)', cursor: 'pointer'
          }}>x</button>
        </div>

        {/* Add files button */}
        <button data-testid="merge-add-files" onClick={handleAddFiles} style={{
          padding: '10px 16px', fontSize: 12, borderRadius: 6,
          background: 'var(--bg-surface)', color: 'var(--text-primary)',
          border: '2px dashed var(--border)', cursor: 'pointer',
          marginBottom: 12, fontWeight: 500,
          transition: 'border-color 0.15s'
        }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--accent)' }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border)' }}
        >
          + Add PDF Files
        </button>

        {/* File list */}
        <div style={{
          flex: 1, overflow: 'auto', marginBottom: 12,
          border: files.length > 0 ? '1px solid var(--border)' : 'none', borderRadius: 4
        }}>
          {files.length === 0 ? (
            <div style={{
              padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12
            }}>
              No files added yet. Click "Add PDF Files" to get started.
            </div>
          ) : (
            files.map((file, index) => (
              <div
                key={file.id}
                draggable
                onDragStart={() => handleDragStart(index)}
                onDragOver={(e) => handleDragOver(e, index)}
                onDrop={() => handleDrop(index)}
                onDragEnd={handleDragEnd}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '8px 12px',
                  background: dragOverIndex === index ? 'var(--bg-surface)' : 'transparent',
                  borderBottom: '1px solid var(--border)',
                  opacity: dragIndex === index ? 0.5 : 1,
                  cursor: 'grab'
                }}
              >
                <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 20 }}>{index + 1}.</span>
                <span style={{ fontSize: 12, color: 'var(--text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {file.name}
                </span>
                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                  {(file.bytes.length / 1024).toFixed(0)} KB
                </span>
                <button onClick={() => handleRemove(file.id)} style={{
                  fontSize: 12, padding: '2px 6px', background: 'transparent',
                  border: 'none', color: 'var(--text-muted)', cursor: 'pointer'
                }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--danger)' }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)' }}
                >x</button>
              </div>
            ))
          )}
        </div>

        {/* Error */}
        {error && (
          <div data-testid="merge-error" style={{
            padding: '8px 12px', borderRadius: 4, marginBottom: 12,
            background: 'rgba(243, 139, 168, 0.15)', color: 'var(--danger)', fontSize: 12
          }}>
            {error}
          </div>
        )}

        {/* Footer */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose} style={{
            padding: '8px 16px', background: 'var(--bg-surface)', borderRadius: 4,
            border: 'none', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 12
          }}>
            Cancel
          </button>
          <button
            data-testid="merge-run"
            onClick={handleMerge}
            disabled={files.length < 2 || merging}
            style={{
              padding: '8px 20px', borderRadius: 4, fontWeight: 600, fontSize: 12,
              background: files.length >= 2 && !merging ? 'var(--accent)' : 'var(--bg-surface)',
              color: files.length >= 2 && !merging ? 'var(--bg-primary)' : 'var(--text-muted)',
              border: 'none', cursor: files.length >= 2 && !merging ? 'pointer' : 'not-allowed',
              opacity: files.length < 2 || merging ? 0.5 : 1
            }}
          >
            {merging ? 'Merging...' : `Merge ${files.length} PDFs`}
          </button>
        </div>
      </div>
    </div>
  )
}
