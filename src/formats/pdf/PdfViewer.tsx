import { useEffect, useRef, useState, useCallback } from 'react'
import type { FormatViewerProps } from '../types'
import { useFormatStore } from '../../stores/formatStore'
import { useUIStore } from '../../stores/uiStore'
import type { PdfFormatState } from './index'
import PageRenderer from './PageRenderer'
import PageRendererLight from './PageRendererLight'
import { invalidateLightRenderCache } from './pageRendererLightCache'
import PdfSearchBar, { type SearchOpts } from './PdfSearchBar'
import { invoke } from '@tauri-apps/api/core'
import { useTabStore } from '../../stores/tabStore'
import { usePdfDocument } from '../../components/viewer/usePdfDocument'
import { useViewerFeatures, installAutoScroll, EYE_PROTECTION_FILTER } from '../../services/viewerFeatures'
import LayersPanel from '../../components/editor/LayersPanel'
import ZoomWidget from './ZoomWidget'
import FindReplaceDialog from './FindReplaceDialog'
import CommentsPanel from './CommentsPanel'

// NOTE: The prior tool-switch text-edit batch apply was removed. Edits now
// apply live per keystroke inside EditableTextLayer (see
// services/pdfTextEdits.ts + EditableTextLayer.tsx). This prevents the
// "everything reverts on Select" UX hazard and removes the white-fade
// visual on focused spans.

export default function PdfViewer({ tabId }: FormatViewerProps) {
  const state = useFormatStore((s) => s.data[tabId] as PdfFormatState | undefined)
  const tool = useUIStore((s) => s.tool)
  const setCurrentPage = useUIStore((s) => s.setCurrentPage)
  const searchVisible = useUIStore((s) => s.searchVisible)
  const setSearchVisible = useUIStore((s) => s.setSearchVisible)
  const showLayers = useUIStore((s) => s.showLayers)
  const showComments = useUIStore((s) => s.showComments)
  const currentPage = useUIStore((s) => s.currentPage)
  const containerRef = useRef<HTMLDivElement>(null)
  const pdfDoc = usePdfDocument(state?.pdfBytes ?? null)
  const setZoom = useUIStore((s) => s.setZoom)
  const zoomFitDoneRef = useRef<string | null>(null)
  const [searchMatches, setSearchMatches] = useState(0)
  const [fabricCanvas, setFabricCanvas] = useState<unknown>(null)

  // Fit-to-width on first open. PDFs with wide page geometry
  // (landscape, A3, custom-large) overflow the editor container at
  // 100% zoom and force the user to manually scroll horizontally
  // or zoom out. Detect once per tab: read page-1's intrinsic
  // width, compare to the container's clientWidth, and clamp the
  // zoom so the page fits.
  useEffect(() => {
    if (!pdfDoc || !state?.pdfBytes) return
    if (zoomFitDoneRef.current === tabId) return
    const container = containerRef.current
    if (!container) return
    const containerW = container.clientWidth
    if (containerW <= 0) return
    // padding 20px each side from the container style.
    const usableW = containerW - 40
    let cancelled = false
    pdfDoc.getPage(1).then((page) => {
      if (cancelled) return
      const intrinsicRotation = (page as any).rotate || 0
      const vp = page.getViewport({ scale: 1, rotation: intrinsicRotation })
      page.cleanup()
      if (vp.width > usableW) {
        const fitZoom = Math.max(0.25, Math.min(4.0, usableW / vp.width))
        // Round to a nice 5% increment so the zoom widget reads
        // sanely (e.g. 75% rather than 72.4%).
        const nice = Math.round(fitZoom * 20) / 20
        setZoom(nice)
      }
      zoomFitDoneRef.current = tabId
    }).catch(() => {
      // Best-effort. If we fail to read page 1, leave zoom alone.
      zoomFitDoneRef.current = tabId
    })
    return () => { cancelled = true }
  }, [pdfDoc, state?.pdfBytes, tabId, setZoom])

  // Poll for the current page's fabric canvas when layers panel is open
  useEffect(() => {
    if (!showLayers) { setFabricCanvas(null); return }
    let cancelled = false
    const poll = () => {
      if (cancelled) return
      const els = [...document.querySelectorAll('canvas.lower-canvas')] as Element[]
      for (const el of els) {
        const fiberKey = Object.keys(el).find((k) => k.startsWith('__reactFiber'))
        if (!fiberKey) continue
        let fiber: any = (el as any)[fiberKey]
        while (fiber) {
          let hook = fiber.memoizedState
          while (hook) {
            const val = hook.memoizedState
            if (val && typeof val === 'object' && 'current' in val) {
              const cur = val.current
              if (cur && typeof cur.add === 'function' && typeof cur.toJSON === 'function' && cur.width > 400) {
                setFabricCanvas(cur)
                return
              }
            }
            hook = hook.next
          }
          fiber = fiber.return
        }
      }
      setTimeout(poll, 200)
    }
    poll()
    return () => { cancelled = true }
  }, [showLayers, currentPage])

  // Viewer feature flags (eye protection, auto-scroll, hide annotations)
  const eyeProtection = useViewerFeatures((s) => s.eyeProtection)
  const autoScroll = useViewerFeatures((s) => s.autoScroll)
  const autoScrollSpeed = useViewerFeatures((s) => s.autoScrollSpeed)
  const hideAnnotations = useViewerFeatures((s) => s.hideAnnotations)

  // Install / cancel auto-scroll interval on the viewport container
  useEffect(() => {
    installAutoScroll(containerRef.current, autoScrollSpeed, autoScroll)
    return () => installAutoScroll(null, 0, false)
  }, [autoScroll, autoScrollSpeed])

  // Toggle a class on the container so a stylesheet rule can hide the
  // fabric upper-canvas layer (annotations) without unmounting it.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    el.classList.toggle('satchel-hide-annotations', hideAnnotations)
  }, [hideAnnotations])

  const visiblePages = state?.pages.filter((p) => !p.deleted) ?? []

  // Page virtualization — only mount the heavy PageRenderer for pages
  // within VIRT_WINDOW of the active scroll position. Pages outside
  // the window get a lightweight placeholder div sized to the correct
  // height so the scroll geometry stays stable. Cuts heap pressure on
  // large docs from O(N pages) to O(window).
  //
  // The observer that updates currentPage runs on EVERY page's
  // placeholder + real renderer, so scrolling into a placeholder
  // promotes its neighbors to real renderers within the same frame.
  //
  // E2 perf: shrunk from 2 → 1 (5 pages mounted on first paint → 3).
  // First-paint cost on the 32MB brand-guidelines.pdf gate is dominated
  // by per-page PageRenderer mounts (pdfjs page proxy + canvas alloc +
  // text-layer + Fabric overlay), so the 40% mount-count reduction
  // moves the needle. IntersectionObserver promotes the next neighbor
  // to a real renderer the moment its placeholder enters the viewport.
  //
  // BUT: for small docs the virtualization is a UX regression. With
  // VIRT_WINDOW=1 a 5-page doc only mounts pages 0+1 on first paint;
  // pages 3-5 stay as "Page N" placeholders until the user scrolls
  // them into view. The observer fires on scroll, not on mount, so
  // a user who reaches the doc and immediately tries to interact with
  // pages 3-5 (Page Manager, Find, Auto-detect) sees nothing there.
  //
  // Mount strategy is now a thin wrapper around PageRendererLight,
  // which is the cheap path: a div with dimensions + an
  // IntersectionObserver that fires the bitmap render only when the
  // wrapper enters a 1500px pre-zone above/below the actual viewport.
  // That keeps the per-mount React reconciliation cost ~constant
  // (small) and lets us mount HUNDREDS of pages upfront without
  // blowing the heap on bitmap renders we'd never use.
  //
  //   ≤ FULL_MOUNT_THRESHOLD   → every page → PageRenderer (full)
  //   ≤ LIGHT_MOUNT_THRESHOLD  → every page → light (or full for
  //                              currentPage). All pages mounted —
  //                              no blank-slot placeholders. Bitmap
  //                              fetch is gated by IntersectionObserver
  //                              inside PageRendererLight so off-screen
  //                              pages don't fire pdfium renders.
  //   >  LIGHT_MOUNT_THRESHOLD → light within ±VIRT_WINDOW of currentPage,
  //                              blank slot outside. Window slides on
  //                              scroll via the scroll listener +
  //                              IntersectionObserver. For 50,000-page
  //                              docs we keep ~200 pages mounted at a
  //                              time, and PageRendererLight's own
  //                              visibility gate limits actual bitmap
  //                              renders to the few pages near the
  //                              viewport.
  // Mount strategy: only the ACTIVE page is full-mounted (pdfjs
  // canvas + Fabric + EditableParagraph + EditableImage). All
  // others are PageRendererLight (pdfjs canvas only).
  //
  // Annotation tools (Add Text, Highlight, etc) need a FabricCanvas
  // on the page the user clicks. To avoid forcing 15+ heavy
  // PageRenderers to mount simultaneously (which OOM'd the WebView
  // on graphics-heavy docs like brand-guidelines.pdf), we promote
  // a non-active page to active on click via a per-Light click
  // handler — see PageRendererLight's onClick. The user clicks
  // anywhere on a thumbnail-rendered page, that page becomes
  // active in one frame, gets the full editor surface, and the
  // Fabric handler picks up the next click as the actual
  // annotation gesture.
  const FULL_MOUNT_THRESHOLD = 1
  const LIGHT_MOUNT_THRESHOLD = 500  // mount every page as light up to 500
  const VIRT_WINDOW = 100            // ±100 pages light-mounted past 500-page threshold
  const SHARP_RADIUS = 3             // ±3 pages rendered at full DPR for smooth scroll
  const PRELOAD_MARGIN_PX = 1500     // ≈ 1-2 viewport heights above + below
  // Active page = the same value the rest of the app reads from the
  // store. Deriving it (instead of keeping a parallel useState) means
  // any path that updates currentPage — sidebar thumbnail click,
  // bookmarks panel, find-result jump, scroll observer, scroll
  // listener — promotes the right pages to real renderers without
  // each path having to remember to update both.
  const activePageIdx = currentPage
  // Track the placeholder's expected height per pageIndex so the
  // scroll height doesn't collapse. Placeholders default to a US-
  // letter-shaped 612×792-ish ratio at the current zoom; once the
  // real renderer mounts it overwrites the entry.
  const [pageHeights, setPageHeights] = useState<Record<number, number>>({})
  const placeholderH = (idx: number): number => {
    return pageHeights[idx] ?? Math.round(792 * (zoom ?? 1))
  }
  // (zoom isn't a prop here; if not in scope, we'll fall back to 792)
  const zoom = useUIStore((s) => s.zoom)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    // rootMargin expands the trigger area by PRELOAD_MARGIN_PX above
    // and below the viewport. A page placeholder/renderer "intersects"
    // as soon as it's within that distance, so setActivePageIdx fires
    // long before the page is actually visible — the next render's
    // window-shift mounts the renderer + canvas paints in time.
    let pending = false
    const updateCurrentFromViewportCenter = () => {
      if (pending) return
      pending = true
      requestAnimationFrame(() => {
        pending = false
        const wrappers = container.querySelectorAll<HTMLElement>('[data-page-display-index]')
        const cRect = container.getBoundingClientRect()
        const center = cRect.top + cRect.height / 2
        let bestIdx = -1
        let bestDist = Infinity
        wrappers.forEach((el) => {
          const r = el.getBoundingClientRect()
          const elCenter = r.top + r.height / 2
          const dist = Math.abs(elCenter - center)
          if (dist < bestDist) {
            bestDist = dist
            bestIdx = Number(el.dataset.pageDisplayIndex)
          }
        })
        if (bestIdx >= 0 && !isNaN(bestIdx)) {
          setCurrentPage(bestIdx)
        }
      })
    }

    const margin = `${PRELOAD_MARGIN_PX}px 0px ${PRELOAD_MARGIN_PX}px 0px`
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          updateCurrentFromViewportCenter()
        }
      },
      { root: container, threshold: 0.1, rootMargin: margin }
    )
    const pageEls = container.querySelectorAll('[data-page-display-index]')
    pageEls.forEach((el) => observer.observe(el))

    // A plain scroll listener computes the active page from the actual
    // viewport center. The IntersectionObserver above only wakes this
    // calculation; it does not choose from the preload margin, because
    // doing so can promote a lower page while the user scrolls upward and
    // make scroll anchoring feel like it snapped toward the bottom.
    const onScroll = updateCurrentFromViewportCenter
    container.addEventListener('scroll', onScroll, { passive: true })

    return () => {
      observer.disconnect()
      container.removeEventListener('scroll', onScroll)
    }
  }, [visiblePages.length, setCurrentPage])

  const isInWindow = (idx: number): boolean => {
    if (visiblePages.length <= LIGHT_MOUNT_THRESHOLD) return true
    return Math.abs(idx - activePageIdx) <= VIRT_WINDOW
  }

  // Hybrid mount: only the user's CURRENT page gets the heavy
  // PageRenderer (pdfjs canvas + Fabric + EditableParagraph +
  // EditableImage + Rulers). Every other in-window page gets
  // PageRendererLight — pdfium PNG via the Rust LRU. ~10-30×
  // cheaper React mount, plus PageRendererLight's own visibility
  // gate keeps the bitmap fetch lazy.
  //
  // Small docs (≤ FULL_MOUNT_THRESHOLD) keep the original "every
  // page is a full PageRenderer" behavior so there's zero regression
  // risk on the common case (5-page proposal, 1-page invoice, w-9
  // form, etc.).
  const isFullMount = (idx: number): boolean => {
    if (visiblePages.length <= FULL_MOUNT_THRESHOLD) return true
    return idx === currentPage
  }

  // Tab metadata for the path-based render (Rust side reads from
  // disk, no IPC byte transfer for big docs).
  const filePath = useTabStore((s) => s.tabs.find((t) => t.id === tabId)?.filePath)
  const isDirty = useTabStore((s) => s.tabs.find((t) => t.id === tabId)?.isDirty ?? false)

  // Prefetch hint: when currentPage settles, queue Rust render jobs
  // for the next +N and previous -N pages at the current zoom.
  //
  // Two safety bands matter for the heavy-doc case:
  //
  //  1. DEBOUNCE_MS — fast scrolling with PageDown fires currentPage
  //     changes one per keystroke. Without a debounce we'd queue
  //     N×20 prefetches in a few hundred ms, each a spawn_blocking
  //     pdfium render that pegs the worker pool and balloons the
  //     LRU. A 250 ms debounce coalesces a burst of cursor activity
  //     into a single prefetch right when the user pauses.
  //
  //  2. RING — was ±10 (= 20 pages). On a 33 MB doc that's 20
  //     concurrent pdfium renders even after debounce. Cut to ±3
  //     (= 6 pages), which is plenty for the visible viewport plus
  //     immediate-neighbour reveal on a scroll-tick. PageRendererLight
  //     still fires its own on-demand render for anything outside
  //     the prefetch ring, so reliability is unchanged.
  useEffect(() => {
    if (visiblePages.length <= FULL_MOUNT_THRESHOLD) return
    if (!filePath || isDirty) return
    const DEBOUNCE_MS = 250
    const RING = 3
    const timer = setTimeout(() => {
      const indices: number[] = []
      for (let off = -RING; off <= RING; off++) {
        const idx = currentPage + off
        if (idx === currentPage) continue
        if (idx < 0 || idx >= visiblePages.length) continue
        const page = visiblePages[idx]
        if (page && page.pageIndex >= 0) indices.push(page.pageIndex)
      }
      if (indices.length === 0) return
      const scale = (zoom ?? 1) * window.devicePixelRatio
      invoke('engine_prefetch_pages', {
        path: filePath,
        pageIndices: indices,
        scale,
      }).catch((err) => {
        console.debug('[PdfViewer] prefetch failed:', err)
      })
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [currentPage, filePath, isDirty, visiblePages.length, zoom])

  // After every save the disk bytes change — drop stale render cache
  // entries for this path. Tracked via a ref so we ONLY invalidate on
  // actual isDirty true→false transitions (= save just happened),
  // never on the open-flow where isDirty is false from the start
  // (which would clobber the cache entries our PageRendererLights
  // are filling in parallel right now).
  const wasDirtyRef = useRef(false)
  useEffect(() => {
    if (!filePath) return
    if (isDirty) {
      wasDirtyRef.current = true
      return
    }
    if (wasDirtyRef.current) {
      // We just transitioned dirty → clean (save completed).
      wasDirtyRef.current = false
      invoke('engine_invalidate_render_cache', { path: filePath }).catch(() => { /* swallow */ })
      invalidateLightRenderCache(filePath)
    }
  }, [filePath, isDirty])

  // Ctrl+F for find, Ctrl+H for find & replace
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault()
        useUIStore.getState().toggleSearch()
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'h') {
        e.preventDefault()
        useUIStore.getState().openReplace()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const handleSearch = useCallback(async (query: string, _matchIndex: number, opts: SearchOpts) => {
    if (!pdfDoc || query.length < 2) { setSearchMatches(0); return }
    let source = query
    if (!opts.regex) source = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (opts.wholeWord) source = `\\b(?:${source})\\b`
    let re: RegExp
    try {
      re = new RegExp(source, 'g' + (opts.caseSensitive ? '' : 'i'))
    } catch {
      // Invalid user regex — treat as zero matches rather than throwing
      setSearchMatches(0)
      return
    }
    let total = 0
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      const page = await pdfDoc.getPage(i)
      const textContent = await page.getTextContent()
      const text = textContent.items.map((item: any) => item.str).join(' ')
      const matches = text.match(re)
      if (matches) total += matches.length
      page.cleanup()
    }
    setSearchMatches(total)
  }, [pdfDoc])

  if (!pdfDoc || !state) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)' }}>
        Loading PDF...
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', height: '100%', width: '100%' }}>
      <div style={{ position: 'relative', flex: 1, minWidth: 0, overflow: 'hidden' }}>
        <PdfSearchBar
          visible={searchVisible}
          onClose={() => setSearchVisible(false)}
          onSearch={handleSearch}
          totalMatches={searchMatches}
        />
        <FindReplaceDialog tabId={tabId} />
        <div
          ref={containerRef}
          data-testid="pdf-viewer-scroll"
          style={{
            overflow: 'auto', height: '100%', width: '100%',
            display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '20px 0',
            filter: eyeProtection ? EYE_PROTECTION_FILTER : undefined,
          }}
        >
          {visiblePages.map((page, displayIndex) => {
            if (!isInWindow(displayIndex)) {
              // Outside the mount window — bare gray slot of correct
              // height to keep scroll geometry stable. No "Page N"
              // text (Acrobat shows the same: blank rectangle that
              // the eventual bitmap fades into).
              return (
                <div
                  key={page.pageIndex}
                  data-page-display-index={displayIndex}
                  data-page-placeholder="1"
                  style={{
                    width: 612 * (zoom ?? 1),
                    height: placeholderH(displayIndex),
                    marginBottom: 12,
                    background: '#fff',
                    flexShrink: 0,
                  }}
                />
              )
            }
            if (isFullMount(displayIndex)) {
              return (
                <PageRenderer
                  key={page.pageIndex}
                  tabId={tabId}
                  pdfDoc={pdfDoc}
                  pageIndex={page.pageIndex}
                  displayIndex={displayIndex}
                  rotation={page.rotation}
                  onDimensions={(h) => {
                    setPageHeights((prev) => prev[displayIndex] === h ? prev : { ...prev, [displayIndex]: h })
                  }}
                />
              )
            }
            return (
              <PageRendererLight
                key={page.pageIndex}
                tabId={tabId}
                pdfDoc={pdfDoc}
                pageIndex={page.pageIndex}
                displayIndex={displayIndex}
                rotation={page.rotation}
                nearActive={Math.abs(displayIndex - currentPage) <= SHARP_RADIUS}
                onDimensions={(h) => {
                  setPageHeights((prev) => prev[displayIndex] === h ? prev : { ...prev, [displayIndex]: h })
                }}
              />
            )
          })}
        </div>
        <ZoomWidget containerRef={containerRef} />
      </div>
      {showLayers && (
        <div style={{ width: 220, flexShrink: 0, borderLeft: '1px solid var(--border)', overflow: 'auto', background: 'var(--bg-primary)', padding: 6 }}>
          <LayersPanel fabricCanvas={fabricCanvas as Parameters<typeof LayersPanel>[0]['fabricCanvas']} />
        </div>
      )}
      {showComments && (
        <div style={{ width: 280, flexShrink: 0 }}>
          <CommentsPanel tabId={tabId} />
        </div>
      )}
    </div>
  )
}
