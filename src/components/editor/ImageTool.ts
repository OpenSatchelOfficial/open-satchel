import { Canvas, FabricImage } from 'fabric'

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
      const blob = new Blob([file.bytes])
      const url = URL.createObjectURL(blob)

      try {
        const img = await FabricImage.fromURL(url)
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
        canvas.add(img)
        canvas.setActiveObject(img)
        onSave()
      } finally {
        URL.revokeObjectURL(url)
      }
    }
  })
}
