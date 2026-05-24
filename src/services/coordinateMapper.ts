// PDF uses points (1/72 inch) with origin at bottom-left
// Fabric/canvas uses pixels with origin at top-left

export interface CoordinateMapper {
  fabricToPdf: (x: number, y: number) => { x: number; y: number }
  pdfToFabric: (x: number, y: number) => { x: number; y: number }
  sizeToPdf: (size: number) => number
  sizeToFabric: (size: number) => number
  scaleToPdf: (value: number) => number
}

export function createCoordinateMapper(
  canvasWidth: number,
  canvasHeight: number,
  pdfPageWidth: number,
  pdfPageHeight: number
): CoordinateMapper {
  const scaleX = pdfPageWidth / canvasWidth
  const scaleY = pdfPageHeight / canvasHeight

  return {
    fabricToPdf: (x: number, y: number) => ({
      x: x * scaleX,
      y: pdfPageHeight - y * scaleY
    }),

    pdfToFabric: (x: number, y: number) => ({
      x: x / scaleX,
      y: (pdfPageHeight - y) / scaleY
    }),

    sizeToPdf: (size: number) => size * scaleY,

    sizeToFabric: (size: number) => size / scaleY,

    scaleToPdf: (value: number) => value * scaleX
  }
}
