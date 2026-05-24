import { useEffect, useRef, useState } from 'react'
import { Canvas as FabricCanvas, PencilBrush } from 'fabric'

interface Props {
  onClose: () => void
  onConfirm: (dataUrl: string) => void
}

export default function SignatureDialog({ onClose, onConfirm }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fabricRef = useRef<FabricCanvas | null>(null)
  const [mode, setMode] = useState<'draw' | 'type'>('draw')
  const [typedText, setTypedText] = useState('')

  // Fabric owns the <canvas>. Keep the <canvas> element mounted for the
  // whole dialog lifetime (hide via CSS when in Type mode) so we can use
  // a single init+dispose pair and avoid DOM-unmount races.
  useEffect(() => {
    const el = canvasRef.current
    if (!el || fabricRef.current) return

    const fc = new FabricCanvas(el, {
      width: 400,
      height: 150,
      backgroundColor: '#ffffff',
      isDrawingMode: true
    })
    const brush = new PencilBrush(fc)
    brush.color = '#000033'
    brush.width = 2
    fc.freeDrawingBrush = brush
    fabricRef.current = fc

    return () => {
      fc.dispose()
      fabricRef.current = null
    }
  }, [])

  // Keep isDrawingMode in sync so clicks on the pad paint only when visible.
  useEffect(() => {
    const fc = fabricRef.current
    if (!fc) return
    fc.isDrawingMode = mode === 'draw'
  }, [mode])

  const handleClear = () => {
    const fc = fabricRef.current
    if (!fc) return
    fc.clear()
    fc.backgroundColor = '#ffffff'
    fc.renderAll()
  }

  const handleConfirm = () => {
    if (mode === 'draw') {
      const fc = fabricRef.current
      if (!fc) return
      const dataUrl = fc.toDataURL({ format: 'png', multiplier: 2 })
      onConfirm(dataUrl)
      return
    }

    // Typed signature — render to an offscreen canvas as PNG.
    if (!typedText.trim()) return
    const tempCanvas = document.createElement('canvas')
    tempCanvas.width = 400
    tempCanvas.height = 150
    const ctx = tempCanvas.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 400, 150)
    ctx.fillStyle = '#000033'
    ctx.font = 'italic 36px "Dancing Script", cursive, "Segoe Script", "Comic Sans MS"'
    ctx.textBaseline = 'middle'
    ctx.fillText(typedText, 20, 75)
    onConfirm(tempCanvas.toDataURL('image/png'))
  }

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      background: 'rgba(0,0,0,0.6)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1000
    }}>
      <div style={{
        background: 'var(--bg-primary)',
        borderRadius: 8,
        padding: 24,
        border: '1px solid var(--border)',
        minWidth: 450
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>Create Signature</h3>
          <button onClick={onClose} style={{ fontSize: 18 }}>✕</button>
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <button
            onClick={() => setMode('draw')}
            style={{
              padding: '6px 16px',
              borderRadius: 4,
              background: mode === 'draw' ? 'var(--accent)' : 'var(--bg-surface)',
              color: mode === 'draw' ? 'var(--bg-primary)' : 'var(--text-primary)'
            }}
          >
            Draw
          </button>
          <button
            onClick={() => setMode('type')}
            style={{
              padding: '6px 16px',
              borderRadius: 4,
              background: mode === 'type' ? 'var(--accent)' : 'var(--bg-surface)',
              color: mode === 'type' ? 'var(--bg-primary)' : 'var(--text-primary)'
            }}
          >
            Type
          </button>
        </div>

        {/* Keep the draw pad mounted for the dialog's lifetime; hide it in Type mode. */}
        <div style={{ display: mode === 'draw' ? 'block' : 'none' }}>
          <canvas
            ref={canvasRef}
            style={{ border: '1px solid var(--border)', borderRadius: 4, cursor: 'crosshair' }}
          />
          <button
            onClick={handleClear}
            style={{
              marginTop: 8,
              padding: '4px 12px',
              background: 'var(--bg-surface)',
              borderRadius: 4,
              fontSize: 12
            }}
          >
            Clear
          </button>
        </div>

        {mode === 'type' && (
          <div>
            <input
              type="text"
              value={typedText}
              onChange={(e) => setTypedText(e.target.value)}
              placeholder="Type your signature..."
              style={{
                width: '100%',
                padding: '12px',
                fontSize: 24,
                fontStyle: 'italic',
                fontFamily: '"Segoe Script", "Comic Sans MS", cursive'
              }}
            />
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button
            onClick={onClose}
            style={{ padding: '8px 16px', background: 'var(--bg-surface)', borderRadius: 4 }}
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={mode === 'type' && !typedText.trim()}
            style={{
              padding: '8px 16px',
              background: 'var(--accent)',
              color: 'var(--bg-primary)',
              borderRadius: 4,
              fontWeight: 600,
              opacity: mode === 'type' && !typedText.trim() ? 0.5 : 1,
              cursor: mode === 'type' && !typedText.trim() ? 'not-allowed' : 'pointer'
            }}
          >
            Use Signature
          </button>
        </div>
      </div>
    </div>
  )
}
