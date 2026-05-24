import { Canvas, FabricImage } from 'fabric'

export async function placeSignature(
  canvas: Canvas,
  dataUrl: string,
  x: number,
  y: number,
  onSave: () => void
): Promise<void> {
  const img = await FabricImage.fromURL(dataUrl)
  const maxWidth = canvas.width! * 0.3
  const scale = Math.min(maxWidth / img.width!, 1)

  img.set({
    left: x,
    top: y,
    scaleX: scale,
    scaleY: scale,
    selectable: true
  })

  canvas.add(img)
  canvas.setActiveObject(img)
  onSave()
}
