// Pdfium native-view path — renders a PDF page to PNG via the
// Tauri-side pdfium binding, returns a blob URL the caller can drop
// into an `<img>` tag. For heavy documents (>5 MB) this beats pdfjs
// significantly: pdfium runs natively + caches its parse, while
// pdfjs holds the entire document in JS memory and re-rasterizes
// each page on every zoom change.
//
// View-only — the editor still uses pdfjs because pdfium PNGs have
// no text layer for selection / copy / paragraph clustering. The
// PageRenderer flips between paths based on (size threshold AND
// not-edit-mode).
//
// LRU cache: keyed by `${bytesHash}:${pageIndex}:${scale}`. Bytes
// hash is a fast 32-bit FNV-1a over the first/last 4 KB and the
// length — collision-resistant enough for cache-key purposes (we
// only need to distinguish documents that DIFFER, not detect
// integrity tampering). Cap = 64 entries by default; eviction on
// insert when full also revokes the blob URL so memory pressure
// stays bounded even with many open tabs.

import { invoke } from '@tauri-apps/api/core'

interface CacheEntry {
  url: string
  blob: Blob
  bytesUsed: number
}

// Cap was 64. On a 33MB landscape doc each PNG is 5-15MB; 64 ×
// 10MB = 640MB of blob memory pinned in the renderer. Cut to 16:
// covers a ±5 page virt-window across two zoom buckets with room
// for the post-save invalidation churn, while bounding the cache
// at ~160MB worst-case. The on-disk Rust LRU still holds the full
// set so re-renders are still a memcpy on cache miss.
const DEFAULT_MAX_ENTRIES = 16
// Lowered from 5MB → 2MB after the FormFieldRenderer + paragraph-cluster
// fixes shifted the perf bottleneck onto pdfjs's per-page rasterize.
// Pdfium native render beats pdfjs canvas at any non-trivial doc size;
// the threshold exists only to spare tiny PDFs the IPC round-trip cost.
const HEAVY_THRESHOLD_BYTES = 2 * 1024 * 1024

class LruCache {
  private map = new Map<string, CacheEntry>()
  constructor(private maxEntries: number = DEFAULT_MAX_ENTRIES) {}

  get(key: string): CacheEntry | undefined {
    const entry = this.map.get(key)
    if (entry) {
      // LRU touch: re-insert moves the key to the back.
      this.map.delete(key)
      this.map.set(key, entry)
    }
    return entry
  }

  set(key: string, entry: CacheEntry): void {
    if (this.map.has(key)) {
      const prev = this.map.get(key)!
      URL.revokeObjectURL(prev.url)
      this.map.delete(key)
    }
    this.map.set(key, entry)
    while (this.map.size > this.maxEntries) {
      const oldestKey = this.map.keys().next().value as string | undefined
      if (!oldestKey) break
      const oldest = this.map.get(oldestKey)!
      URL.revokeObjectURL(oldest.url)
      this.map.delete(oldestKey)
    }
  }

  clear(): void {
    for (const e of this.map.values()) URL.revokeObjectURL(e.url)
    this.map.clear()
  }

  size(): number { return this.map.size }
}

const cache = new LruCache()

/** Normalise the IPC PNG payload to a Uint8Array. The Rust render
 *  commands now return `tauri::ipc::Response`, so the JS side gets
 *  an ArrayBuffer (raw octet-stream). The legacy Vec<u8> path that
 *  inflated to a `number[]` is kept as a fallback in case any caller
 *  is still pinned to the old version mid-rebuild. */
function pngToUint8(png: ArrayBuffer | number[] | Uint8Array): Uint8Array {
  if (png instanceof Uint8Array) return png
  if (png instanceof ArrayBuffer) return new Uint8Array(png)
  // ArrayBuffer with Symbol.toStringTag undefined (some webviews) —
  // detect via byteLength instead of instanceof.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyPng = png as any
  if (anyPng && typeof anyPng.byteLength === 'number' && typeof anyPng.slice === 'function' && !Array.isArray(png)) {
    return new Uint8Array(anyPng)
  }
  return new Uint8Array(png as number[])
}

/** FNV-1a 32-bit over the first 4096 + last 4096 bytes + length.
 *  Cheap enough to recompute on every render; collision rate at the
 *  cache level (max 64 keys) is negligible. */
export function fnvHashOfBytes(bytes: Uint8Array): string {
  const HEAD = 4096
  const TAIL = 4096
  let h = 0x811c9dc5
  const head = bytes.subarray(0, Math.min(HEAD, bytes.length))
  const tail = bytes.subarray(Math.max(0, bytes.length - TAIL))
  for (let i = 0; i < head.length; i++) {
    h ^= head[i]
    h = (h * 0x01000193) >>> 0
  }
  for (let i = 0; i < tail.length; i++) {
    h ^= tail[i]
    h = (h * 0x01000193) >>> 0
  }
  // Mix in length so a truncated/extended doc hashes differently.
  const lenBytes = [
    bytes.length & 0xff,
    (bytes.length >>> 8) & 0xff,
    (bytes.length >>> 16) & 0xff,
    (bytes.length >>> 24) & 0xff,
  ]
  for (const b of lenBytes) {
    h ^= b
    h = (h * 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0') + ':' + bytes.length.toString(36)
}

/** Heuristic: should this document use the pdfium native render
 *  path instead of pdfjs? Returns true for large documents (>5 MB)
 *  by default. Override threshold via the `bytesThreshold` arg. */
export function shouldUsePdfiumRender(
  pdfBytes: Uint8Array,
  bytesThreshold: number = HEAVY_THRESHOLD_BYTES,
): boolean {
  if (!pdfBytes || pdfBytes.byteLength === 0) return false
  return pdfBytes.byteLength >= bytesThreshold
}

/** Render a single page via pdfium. Returns the cached blob URL on
 *  hit; calls the Tauri command + caches on miss. Errors propagate
 *  to the caller — the React component falls back to pdfjs render
 *  on any pdfium failure. */
export async function renderPageViaPdfium(
  pdfBytes: Uint8Array,
  pageIndex: number,
  scale: number,
  /** When the doc is on disk (most opens via the file dialog or a
   *  recent), prefer this path. The path-based command goes through
   *  the multi-process pdfium pool's LRU cache and ships ZERO bytes
   *  through the IPC channel. The bytes-based fallback is left for
   *  in-memory docs (post-save staged bytes, never-persisted
   *  conversions) but is materially slower on multi-MB files. */
  filePath?: string,
): Promise<string> {
  const key = `${fnvHashOfBytes(pdfBytes)}:${pageIndex}:${scale.toFixed(3)}`
  const hit = cache.get(key)
  if (hit) return hit.url

  let bytes: Uint8Array
  if (filePath) {
    // Path-based render — engine_render_page_lru uses the
    // multi-process pdfium pool with LRU cache. The Rust command
    // returns `tauri::ipc::Response` so the PNG body ships as raw
    // octet-stream — no JSON-array inflation, no V8 number-array
    // boxing. invoke() resolves to an ArrayBuffer for raw responses;
    // wrap in Uint8Array zero-copy.
    const png = await invoke<ArrayBuffer | number[] | Uint8Array>('engine_render_page_lru', {
      path: filePath,
      pageIndex,
      scale,
    })
    bytes = pngToUint8(png)
  } else {
    // In-memory fallback. The Vec<u8> Tauri marshal here forces
    // Array.from(bytes) on the JS side, which inflates a 33 MB
    // payload to ~150 MB JSON + V8 boxing — multi-second blocking
    // on the WebView. Reserved for documents that aren't backed
    // by a file (post-save before reload, in-memory conversions).
    // The PNG response side now ships raw (Response::new), but the
    // request side still pays the JSON-array cost — an in-memory
    // doc only path. Refactor to tauri::ipc::Request later.
    const png = await invoke<ArrayBuffer | number[] | Uint8Array>('engine_render_page_from_bytes', {
      bytes: Array.from(pdfBytes),
      pageIndex,
      scale,
    })
    bytes = pngToUint8(png)
  }
  const blob = new Blob([bytes], { type: 'image/png' })
  const url = URL.createObjectURL(blob)
  cache.set(key, { url, blob, bytesUsed: bytes.byteLength })
  return url
}

/** Force-clear the cache. Useful when the user closes a tab so we
 *  free blob URLs without waiting for LRU eviction. */
export function clearPdfiumRenderCache(): void {
  cache.clear()
}

/** Test-only: inspect cache size. */
export function pdfiumCacheSizeForTest(): number {
  return cache.size()
}
