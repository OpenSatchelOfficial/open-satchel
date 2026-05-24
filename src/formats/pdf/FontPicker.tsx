import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useFontStore, STANDARD_FONTS } from '../../stores/fontStore'
import { useUIStore } from '../../stores/uiStore'

const FONT_FAMILIES: { label: string; fonts: string[] }[] = [
  {
    label: 'Helvetica',
    fonts: ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique']
  },
  {
    label: 'Times',
    fonts: ['Times-Roman', 'Times-Bold', 'Times-Italic']
  },
  {
    label: 'Courier',
    fonts: ['Courier', 'Courier-Bold', 'Courier-Oblique']
  },
  {
    label: 'Other',
    fonts: ['Symbol', 'ZapfDingbats']
  }
]

export default function FontPicker() {
  const [open, setOpen] = useState(false)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const fontStore = useFontStore()
  const textOptions = useUIStore((s) => s.textOptions)
  const setTextOptions = useUIStore((s) => s.setTextOptions)

  // Load fonts on first render
  useEffect(() => {
    fontStore.loadFonts()
  }, [])

  // Compute portal coordinates from button rect when opening, and track
  // scroll/resize so the menu stays anchored.
  useEffect(() => {
    if (!open) return
    const updatePos = () => {
      const rect = buttonRef.current?.getBoundingClientRect()
      if (!rect) return
      setMenuPos({ top: rect.bottom + 2, left: rect.left })
    }
    updatePos()
    window.addEventListener('scroll', updatePos, true)
    window.addEventListener('resize', updatePos)
    return () => {
      window.removeEventListener('scroll', updatePos, true)
      window.removeEventListener('resize', updatePos)
    }
  }, [open])

  // Close dropdown when clicking outside (accounting for portaled menu)
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      const t = e.target as Node
      if (ref.current && ref.current.contains(t)) return
      if (menuRef.current && menuRef.current.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const handleSelect = (fontFamily: string, customFontId?: string) => {
    setTextOptions({ fontFamily, customFontId })
    setOpen(false)
  }

  const handleImport = async () => {
    await fontStore.importFont()
  }

  const currentLabel = textOptions.fontFamily.replace(/-/g, ' ')

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        ref={buttonRef}
        onClick={() => setOpen(!open)}
        // Don't pull focus from an in-edit Textbox.
        onMouseDown={(e) => e.preventDefault()}
        data-testid="font-picker-button"
        style={{
          padding: '2px 6px',
          fontSize: 11,
          borderRadius: 3,
          background: 'var(--bg-surface)',
          color: 'var(--text-secondary)',
          border: 'none',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
          maxWidth: 120,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          display: 'flex',
          alignItems: 'center',
          gap: 4
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)' }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--bg-surface)' }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{currentLabel}</span>
        <span style={{ fontSize: 8, lineHeight: 1 }}>&#9662;</span>
      </button>

      {open && menuPos && createPortal(
        <div ref={menuRef} data-testid="font-picker-menu" style={{
          position: 'fixed',
          top: menuPos.top,
          left: menuPos.left,
          zIndex: 10000,
          background: 'var(--bg-primary)',
          border: '1px solid var(--border)',
          borderRadius: 4,
          boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
          minWidth: 200,
          maxHeight: 320,
          overflowY: 'auto',
          padding: '4px 0'
        }}>
          {/* Standard Fonts */}
          <div style={{ padding: '4px 8px', fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Standard Fonts
          </div>
          {FONT_FAMILIES.map((group) => (
            <div key={group.label}>
              {group.fonts.map((font) => (
                <FontOption
                  key={font}
                  font={font}
                  label={font.replace(/-/g, ' ')}
                  active={textOptions.fontFamily === font && !textOptions.customFontId}
                  onClick={() => handleSelect(font, undefined)}
                />
              ))}
            </div>
          ))}

          {/* Custom Fonts */}
          {fontStore.customFonts.length > 0 && (
            <>
              <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
              <div style={{ padding: '4px 8px', fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                Custom Fonts
              </div>
              {fontStore.customFonts.map((f) => (
                <FontOption
                  key={f.id}
                  font={f.name}
                  label={f.name}
                  active={textOptions.customFontId === f.id}
                  onClick={() => handleSelect(f.name, f.id)}
                  onRemove={() => fontStore.removeFont(f.id)}
                />
              ))}
            </>
          )}

          {/* Import button */}
          <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
          <button
            onClick={handleImport}
            style={{
              display: 'block',
              width: '100%',
              padding: '6px 10px',
              fontSize: 11,
              background: 'transparent',
              color: 'var(--accent)',
              border: 'none',
              cursor: 'pointer',
              textAlign: 'left'
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
          >
            + Import Font...
          </button>
        </div>,
        document.body
      )}
    </div>
  )
}

function FontOption({ font, label, active, onClick, onRemove }: {
  font: string
  label: string
  active: boolean
  onClick: () => void
  onRemove?: () => void
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '4px 10px',
        fontSize: 12,
        cursor: 'pointer',
        background: active ? 'var(--accent)' : 'transparent',
        color: active ? '#1e1e2e' : 'var(--text-primary)',
        fontFamily: font
      }}
      onClick={onClick}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'var(--bg-hover)' }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = active ? 'var(--accent)' : 'transparent' }}
    >
      <span>{label}</span>
      {onRemove && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove() }}
          style={{
            background: 'transparent',
            border: 'none',
            color: active ? '#1e1e2e' : 'var(--text-muted)',
            cursor: 'pointer',
            fontSize: 12,
            padding: '0 2px',
            lineHeight: 1
          }}
          title="Remove font"
        >
          x
        </button>
      )}
    </div>
  )
}
