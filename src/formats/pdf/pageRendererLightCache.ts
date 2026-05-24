// Module-level shared blob-URL cache + concurrency limiter for the
// PageRendererLight render path.
//
// Lives in a separate module from the React component so Vite's
// React Fast Refresh keeps working — the plugin invalidates HMR for
// any file that mixes component and non-component exports, which
// then fails to apply changes during dev iteration.
//
// Two concerns handled here:
//
//   1. Shared blob-URL cache keyed by (path, page, scale_q).
//      Survives React strict-mode double-mounts AND component
//      remount-on-scroll. Without it, every mount fires its own
//      invoke('engine_render_page_lru'); the strict-mode unmount
//      cleanup-cancellation race aborts half the renders before
//      the bytes return. With it, the second mount reads the URL
//      the first mount produced — pdfium runs once per page.
//
//   2. Concurrency cap (MAX_CONCURRENT). Pdfium's thread_safe
//      wrapper serializes every render through one global mutex,
//      so firing 35 invokes simultaneously gains nothing — they
//      pile up in Tauri's IPC queue. Worse: 35 concurrent IPCs +
//      Rust spawn_blocking + pdfium per-thread-handle init proved
//      enough to crash open-satchel.exe (no panic logged — likely
//      a pdfium native-side issue under contention). A small
//      semaphore-style queue keeps the in-flight count to
//      MAX_CONCURRENT, which is plenty given pdfium serializes
//      anyway.

const blobCache = new Map<string, string>()
const inFlight = new Map<string, Promise<string>>()

const MAX_CONCURRENT = 2
let inFlightCount = 0
const queue: Array<() => void> = []

function acquireSlot(): Promise<void> {
  if (inFlightCount < MAX_CONCURRENT) {
    inFlightCount++
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    queue.push(() => {
      inFlightCount++
      resolve()
    })
  })
}

function releaseSlot(): void {
  inFlightCount--
  const next = queue.shift()
  if (next) next()
}

function cacheKey(path: string, pageIndex: number, scale: number): string {
  // Quantize scale to nearest 0.05 (matches Rust render_cache.rs).
  const q = Math.round(scale * 20) / 20
  return `${path}::${pageIndex}::${q.toFixed(2)}`
}

export async function fetchPageBitmap(
  path: string,
  pageIndex: number,
  scale: number,
  fetcher: () => Promise<Uint8Array>,
): Promise<string> {
  const key = cacheKey(path, pageIndex, scale)
  const hit = blobCache.get(key)
  if (hit) return hit
  const pending = inFlight.get(key)
  if (pending) return pending
  const promise = (async () => {
    await acquireSlot()
    try {
      const bytes = await fetcher()
      const blob = new Blob([bytes], { type: 'image/png' })
      const url = URL.createObjectURL(blob)
      blobCache.set(key, url)
      return url
    } finally {
      inFlight.delete(key)
      releaseSlot()
    }
  })()
  inFlight.set(key, promise)
  return promise
}

/** Drop every cached blob URL for a path. Call after a save: bytes
 *  on disk changed, prior renders are stale. */
export function invalidateLightRenderCache(path?: string): void {
  if (!path) {
    for (const url of blobCache.values()) URL.revokeObjectURL(url)
    blobCache.clear()
    inFlight.clear()
    return
  }
  for (const [key, url] of blobCache) {
    if (key.startsWith(`${path}::`)) {
      URL.revokeObjectURL(url)
      blobCache.delete(key)
    }
  }
}
