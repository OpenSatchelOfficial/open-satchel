import { Canvas, FabricImage } from 'fabric'

function inferImageMime(bytes: Uint8Array, name: string): string {
  const lower = name.toLowerCase()
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.bmp')) return 'image/bmp'
  return 'image/png'
}

function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return `data:${mime};base64,${btoa(binary)}`
}

export function applyImageTool(canvas: Canvas, onSave: () => void): void {
  canvas.isDrawingMode = false
  canvas.selection = false
  canvas.defaultCursor = 'crosshair'

  canvas.on('mouse:down', async (e) => {
    // Don't trigger if clicking on an existing object
    if (e.target) return

    const result = await window.api.file.pickImages()
    if (!result || result.length === 0) return

    const pointer = canvas.getScenePoint(e.e)

    for (const file of result) {
      const bytes = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(file.bytes)
      const mime = inferImageMime(bytes, file.name)
      const dataUrl = bytesToDataUrl(bytes, mime)
      const img = await FabricImage.fromURL(dataUrl)
      // Scale image to fit reasonably on page
      const maxDim = Math.min(canvas.width! * 0.5, canvas.height! * 0.5)
      const scale = Math.min(maxDim / img.width!, maxDim / img.height!, 1)
      img.set({
        left: pointer.x,
        top: pointer.y,
        scaleX: scale,
        scaleY: scale,
        selectable: true
      })
      ;(img as unknown as { __imageDataUrl?: string }).__imageDataUrl = dataUrl
      canvas.add(img)
      canvas.setActiveObject(img)
      onSave()
    }
  })
}
