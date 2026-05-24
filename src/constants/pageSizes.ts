export const PAGE_SIZES: Record<string, { width: number; height: number; label: string }> = {
  'A0': { width: 2384, height: 3370, label: 'A0 (841 x 1189 mm)' },
  'A1': { width: 1684, height: 2384, label: 'A1 (594 x 841 mm)' },
  'A2': { width: 1191, height: 1684, label: 'A2 (420 x 594 mm)' },
  'A3': { width: 842, height: 1191, label: 'A3 (297 x 420 mm)' },
  'A4': { width: 595, height: 842, label: 'A4 (210 x 297 mm)' },
  'A5': { width: 420, height: 595, label: 'A5 (148 x 210 mm)' },
  'A6': { width: 298, height: 420, label: 'A6 (105 x 148 mm)' },
  'A7': { width: 210, height: 298, label: 'A7 (74 x 105 mm)' },
  'A8': { width: 147, height: 210, label: 'A8 (52 x 74 mm)' },
  'A9': { width: 105, height: 147, label: 'A9 (37 x 52 mm)' },
  'A10': { width: 74, height: 105, label: 'A10 (26 x 37 mm)' },
  'B0': { width: 2835, height: 4008, label: 'B0 (1000 x 1414 mm)' },
  'B1': { width: 2004, height: 2835, label: 'B1 (707 x 1000 mm)' },
  'B2': { width: 1417, height: 2004, label: 'B2 (500 x 707 mm)' },
  'B3': { width: 1001, height: 1417, label: 'B3 (353 x 500 mm)' },
  'B4': { width: 709, height: 1001, label: 'B4 (250 x 353 mm)' },
  'B5': { width: 499, height: 709, label: 'B5 (176 x 250 mm)' },
  'Letter': { width: 612, height: 792, label: 'Letter (8.5 x 11 in)' },
  'Legal': { width: 612, height: 1008, label: 'Legal (8.5 x 14 in)' },
  'Tabloid': { width: 792, height: 1224, label: 'Tabloid (11 x 17 in)' },
  'Ledger': { width: 1224, height: 792, label: 'Ledger (17 x 11 in)' },
  'Executive': { width: 522, height: 756, label: 'Executive (7.25 x 10.5 in)' },
}

const TOLERANCE = 5

/**
 * Match page dimensions (in points) to a known page size name.
 * Returns null if no match is found within tolerance.
 */
export function getPageSizeName(width: number, height: number): string | null {
  for (const [name, size] of Object.entries(PAGE_SIZES)) {
    if (
      (Math.abs(width - size.width) <= TOLERANCE && Math.abs(height - size.height) <= TOLERANCE) ||
      (Math.abs(width - size.height) <= TOLERANCE && Math.abs(height - size.width) <= TOLERANCE)
    ) {
      return name
    }
  }
  return null
}
