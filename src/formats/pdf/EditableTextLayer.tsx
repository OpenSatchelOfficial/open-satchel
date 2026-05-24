// EditableTextLayer — makes each PDF text run contenteditable.
//
// Design:
//   - Mount over the rendered canvas; pdfjs TextLayer positions spans
//     pixel-perfectly on top of the visible text.
//   - While edit_text tool is active, every non-whitespace span becomes
//     contenteditable.
//   - Typing into a span stamps its current DOM text into pendingEdits
//     kept on the page state (`_textLayerEdits`).
//   - Edited spans become opaque (black text on near-solid white) so the
//     user sees their edit immediately, covering the canvas text below.
//     Unedited spans stay transparent so the canvas render remains the
//     source of truth for everything else.
//   - The canvas is NEVER re-rendered mid-edit. The debounced live-apply
//     variant we tried caused the whole page to flash white every ~400ms
//     (canvas repaint during PDF save round-trip). Too fragile.
//   - The edits are flushed to pdfBytes at save time — see
//     `pdfHandler.save` in formats/pdf/index.ts, which calls
//     `applyTextEditsToBytes` before serializing other edits.

import { useEffect, useRef } from 'react'
import { TextLayer } from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { PdfFormatState } from './index'
import { useFormatStore } from '../../stores/formatStore'
import { useTabStore } from '../../stores/tabStore'
import type { TextLayerEdit } from '../../services/pdfTextEdits'

interface Props {
  tabId: string
  pageIndex: number
  pdfDoc: PDFDocumentProxy
  width: number
  height: number
}

// Read pending edits for this page from the format store so we can re-apply
// the data-edited marker after tool toggles and tab switches.
function readPendingEdits(tabId: string, pageIndex: number): TextLayerEdit[] {
  const state = useFormatStore.getState().data[tabId] as PdfFormatState | undefined
  if (!state) return []
  const page = state.pages.find((p) => p.pageIndex === pageIndex) as
    | (PdfFormatState['pages'][number] & { _textLayerEdits?: TextLayerEdit[] })
    | undefined
  return page?._textLayerEdits ?? []
}

// Write the full edit list for this page back to the store. Keyed by
// spanIndex so each keystroke only touches that one span's entry.
function writePendingEdits(tabId: string, pageIndex: number, edits: TextLayerEdit[]) {
  useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({
    ...prev,
    pages: prev.pages.map((p) =>
      p.pageIndex === pageIndex
        ? ({ ...p, _textLayerEdits: edits.length > 0 ? edits : undefined } as any)
        : p,
    ),
  }))
  // Any pending edits mean the tab is dirty.
  useTabStore.getState().setTabDirty(tabId, edits.length > 0)
}

export default function EditableTextLayer({ tabId, pageIndex, pdfDoc, width, height }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let cancelled = false

    const render = async () => {
      try {
        const page = await pdfDoc.getPage(pageIndex + 1)
        if (cancelled) { page.cleanup(); return }

        const viewport = page.getViewport({ scale: 1 })
        const textContent = await page.getTextContent()
        if (cancelled) { page.cleanup(); return }

        container.innerHTML = ''

        const scaleFactor = width / viewport.width
        container.style.setProperty('--scale-factor', String(scaleFactor))

        const textLayer = new TextLayer({
          textContentSource: textContent,
          container,
          viewport,
        })
        await textLayer.render()
        if (cancelled) { page.cleanup(); return }

        // Restore data-edited markers from state so edits survive tab or
        // tool toggles.
        const pending = readPendingEdits(tabId, pageIndex)
        const pendingByIdx = new Map<number, TextLayerEdit>()
        for (const e of pending) pendingByIdx.set(e.spanIndex, e)

        const divs = textLayer.textDivs
        divs.forEach((div, idx) => {
          const originalText = div.textContent || ''
          if (!originalText.trim()) return

          div.contentEditable = 'true'
          div.spellcheck = false
          div.style.cursor = 'text'
          // Keep the original as a data attribute so the input handler
          // doesn't need a closure over a map that could go stale.
          div.dataset.original = originalText

          // If we already have a pending edit for this span, paint it in
          // (textContent + edited marker) so the user sees their change
          // when the panel is re-mounted.
          const pendingEdit = pendingByIdx.get(idx)
          if (pendingEdit && pendingEdit.newText !== originalText) {
            div.textContent = pendingEdit.newText
            div.dataset.edited = 'true'
          }

          div.addEventListener('input', () => {
            const newText = div.textContent || ''
            const baseline = div.dataset.original ?? ''

            // Recompute the full edit list from DOM — cheap, and avoids
            // subtle races between keystrokes and store updates.
            const allEdits: TextLayerEdit[] = []
            divs.forEach((d, i) => {
              const baseline = d.dataset.original
              if (baseline === undefined) return
              const text = d.textContent || ''
              if (text !== baseline) {
                allEdits.push({ spanIndex: i, originalText: baseline, newText: text })
              }
            })

            if (newText !== baseline) {
              div.dataset.edited = 'true'
            } else {
              delete div.dataset.edited
            }

            writePendingEdits(tabId, pageIndex, allEdits)
          })
        })

        page.cleanup()
      } catch (err) {
        console.error('[EditableTextLayer] render failed:', err)
      }
    }

    render()
    return () => {
      cancelled = true
    }
  }, [pdfDoc, pageIndex, width, height, tabId])

  return (
    <>
      <style>{`
        [data-testid="editable-text-layer"] span {
          position: absolute;
          white-space: pre;
          transform-origin: 0% 0%;
          /* Transparent by default so the canvas render shows through. */
          color: transparent;
          pointer-events: auto;
          caret-color: #000;
          border-radius: 1px;
        }
        /* Hover affordance: dashed outline so users discover spans. */
        [data-testid="editable-text-layer"] span:hover {
          outline: 1px dashed rgba(137,180,250,0.6);
        }
        /* Focus: thin solid outline. Text stays transparent unless the span
           has a pending edit — users don't want a white background on every
           span they click. */
        [data-testid="editable-text-layer"] span:focus {
          outline: 1px solid #89b4fa;
        }
        /* Edited: show the new text on top of the canvas. Near-opaque white
           hides the original canvas glyphs underneath. */
        [data-testid="editable-text-layer"] span[data-edited="true"] {
          color: #000;
          background: rgba(255,255,255,0.95);
        }
        [data-testid="editable-text-layer"] br {
          display: none;
        }
      `}</style>
      <div
        ref={containerRef}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width,
          height,
          zIndex: 5,
          lineHeight: 1.0,
          opacity: 1,
          overflow: 'hidden',
          background: 'transparent',
        }}
        data-testid="editable-text-layer"
      />
    </>
  )
}
