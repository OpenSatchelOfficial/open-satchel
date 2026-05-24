// Auto-detect form-field candidates on a flat PDF.
//
// Heuristic pipeline, no OpenCV dependency:
//
//   1. Rasterize each page at 150dpi via pdfjs (reusing the app's
//      existing pdfjs worker — no extra bundle).
//   2. Binarize to dark/light (gray < 150 = dark).
//   3. Run a row-scan: find horizontal runs of ≥40 consecutive dark
//      pixels with ≥2px of whitespace above and below — classic "fill
//      in your name" underline.
//   4. Run a small-square scan for checkboxes: 10–22px squares whose
//      perimeter is ≥70% dark and whose interior is ≥80% light (empty
//      box) or ≥80% dark (checked). Skip overlapping detections.
//
// Output maps pixel coordinates back to PDF user-space for direct
// feeding into FormFieldSpec[]. Confidence field lets the UI sort
// and filter weak hits.

import type { FormFieldSpec } from './pdfForms'

export interface DetectedField {
  spec: Omit<FormFieldSpec, 'name'>
  confidence: number
  /** Rendered-page pixel bbox — for UI preview overlays. */
  pxBbox: { x: number; y: number; w: number; h: number }
  /** "underline" | "checkbox" — helps the UI show icons. */
  detectedAs: 'underline' | 'checkbox'
}

export async function detectFieldsOnFlatPdf(
  pdfBytes: Uint8Array,
  pageIndex: number,
  dpi = 150,
): Promise<DetectedField[]> {
  const pdfjsLib = await import('pdfjs-dist')
  const doc = await pdfjsLib.getDocument({ data: pdfBytes.slice() }).promise
  try {
    const page = await doc.getPage(pageIndex + 1)
    const scale = dpi / 72
    const viewport = page.getViewport({ scale })
    const W = Math.floor(viewport.width)
    const H = Math.floor(viewport.height)
    const canvas = new OffscreenCanvas(W, H)
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, W, H)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await page.render({ canvasContext: ctx as any, viewport }).promise
    const pageSize = page.getViewport({ scale: 1 })
    page.cleanup()

    // Binarize
    const img = ctx.getImageData(0, 0, W, H).data
    const dark = new Uint8Array(W * H)
    for (let i = 0, j = 0; i < img.length; i += 4, j++) {
      const g = (img[i] + img[i + 1] + img[i + 2]) / 3
      dark[j] = g < 150 ? 1 : 0
    }

    const out: DetectedField[] = []

    // --- Underline scan: horizontal runs with whitespace above/below.
    // For each y, find maximal runs of dark; keep if width ≥ 40px and
    // the 2 rows above + 2 below are majority-light.
    const MIN_W = 40
    const MAX_H_FOR_UNDERLINE = 3  // must be a thin line
    for (let y = 2; y < H - 2; y++) {
      let runStart = -1
      for (let x = 0; x <= W; x++) {
        const d = x < W ? dark[y * W + x] : 0
        if (d === 1 && runStart < 0) runStart = x
        if (d === 0 && runStart >= 0) {
          const runLen = x - runStart
          if (runLen >= MIN_W) {
            // Check that this is a THIN line — rows y-1 and y+1 should be
            // mostly dark too (line is 1-3px tall); rows y-3 and y+3
            // should be mostly light (no dense text below).
            let thickness = 1
            for (let dy = 1; dy <= MAX_H_FOR_UNDERLINE; dy++) {
              let coveredBelow = 0
              for (let xx = runStart; xx < x; xx++) if (dark[(y + dy) * W + xx] === 1) coveredBelow++
              if (coveredBelow / runLen >= 0.6) thickness++
              else break
            }
            if (thickness <= MAX_H_FOR_UNDERLINE) {
              // Whitespace check
              let aboveDark = 0, belowDark = 0
              let immediateAboveDark = 0
              for (let xx = runStart; xx < x; xx++) {
                if (y - 5 >= 0 && dark[(y - 5) * W + xx] === 1) aboveDark++
                if (y + thickness + 4 < H && dark[(y + thickness + 4) * W + xx] === 1) belowDark++
                // Row immediately above the underline (gap between
                // label text and line) is the strongest signal that
                // we're looking at a true underline vs. the bottom
                // edge of a thick filled block (e.g., redaction bar)
                // [V2 P0 #2].
                if (y - 1 >= 0 && dark[(y - 1) * W + xx] === 1) immediateAboveDark++
              }
              const aboveFrac = aboveDark / runLen
              const belowFrac = belowDark / runLen
              const immediateAboveFrac = immediateAboveDark / runLen
              // Above can be text (header label), below MUST be white-ish,
              // and the row immediately above must NOT be ≥70% dark — a
              // mostly-dark row right above the line means this is the
              // bottom edge of a filled block, not a standalone underline.
              if (belowFrac < 0.2 && immediateAboveFrac < 0.7) {
                const confidence = Math.min(1, (1 - belowFrac) * Math.min(1, runLen / 150))
                const pxBbox = { x: runStart, y: y - 16, w: runLen, h: 16 + thickness }
                out.push({
                  spec: {
                    kind: 'text',
                    page: pageIndex,
                    rect: pxToUserSpace(pxBbox, W, H, pageSize.width, pageSize.height),
                  },
                  confidence,
                  pxBbox,
                  detectedAs: 'underline',
                })
                // Skip forward so we don't re-emit from the same run
                // continuing pixel-by-pixel.
                y += 1
              }
            }
          }
          runStart = -1
        }
      }
    }

    // --- Checkbox scan: dark-perimeter squares 10–22px.
    // Sampled sparsely — step by 4px to keep it fast.
    //
    // A real checkbox is a STANDALONE shape: thin perimeter + light
    // pixels just OUTSIDE the perimeter (it's drawn discrete on a
    // background, not a chunk of a larger blob).
    //
    // Without that "isolated" check, the heuristic flags:
    //   - rasterized REDACTION bars (every 10-22px sub-square inside
    //     a solid-black region passes perimeter+interior tests with
    //     interiorRatio≈1.0 "checked"). V2 P0 #2 saw 180 false hits
    //     per single redaction.
    //   - INVOICE table-grid intersections (a square that lines up
    //     with grid lines has all 4 edges dark; cell interior is
    //     light → "empty checkbox"). V2 P1 #4 saw 10040 false hits.
    //
    // Negative test: pixels just outside the perimeter, on each of
    // the 4 sides, must be ≥70% LIGHT. Fails for redaction blobs
    // (outside is also dark) AND for grid intersections (grid lines
    // extend past the candidate).
    const minSide = 10, maxSide = 22
    const accepted: Array<{ x: number; y: number; w: number; h: number }> = []
    for (let y = 0; y < H - maxSide; y += 4) {
      for (let x = 0; x < W - maxSide; x += 4) {
        // Probe a few square sizes
        for (let side = minSide; side <= maxSide; side += 4) {
          // Perimeter darkness ratio
          let perimDark = 0, perimTotal = 0
          for (let i = 0; i < side; i++) {
            if (dark[y * W + x + i]) perimDark++
            if (dark[(y + side - 1) * W + x + i]) perimDark++
            perimTotal += 2
          }
          for (let i = 1; i < side - 1; i++) {
            if (dark[(y + i) * W + x]) perimDark++
            if (dark[(y + i) * W + x + side - 1]) perimDark++
            perimTotal += 2
          }
          const perimRatio = perimDark / perimTotal
          if (perimRatio < 0.7) continue
          // Interior should be either mostly light (empty) or mostly dark (checked)
          let interiorDark = 0, interiorTotal = 0
          for (let iy = 2; iy < side - 2; iy++) {
            for (let ix = 2; ix < side - 2; ix++) {
              if (dark[(y + iy) * W + x + ix]) interiorDark++
              interiorTotal++
            }
          }
          const interiorRatio = interiorTotal > 0 ? interiorDark / interiorTotal : 0
          const empty = interiorRatio < 0.2
          const checked = interiorRatio > 0.8
          if (!empty && !checked) continue
          // Isolation check: the row 2px above the box, the row 2px
          // below, the col 2px left, the col 2px right must each be
          // mostly light. Real checkbox = standalone glyph; redaction
          // blob = continuous dark; grid intersection = dark lines
          // extending past the candidate.
          const GAP = 2
          const yAbove = y - GAP
          const yBelow = y + side - 1 + GAP
          const xLeft = x - GAP
          const xRight = x + side - 1 + GAP
          if (yAbove < 0 || yBelow >= H || xLeft < 0 || xRight >= W) continue
          let outsideDark = 0
          let outsideTotal = 0
          for (let i = 0; i < side; i++) {
            if (dark[yAbove * W + x + i]) outsideDark++
            if (dark[yBelow * W + x + i]) outsideDark++
            outsideTotal += 2
          }
          for (let i = 0; i < side; i++) {
            if (dark[(y + i) * W + xLeft]) outsideDark++
            if (dark[(y + i) * W + xRight]) outsideDark++
            outsideTotal += 2
          }
          const outsideDarkRatio = outsideDark / outsideTotal
          // Real isolated checkbox: <30% of the surrounding ring is
          // dark. Solid blob / grid intersection: ≥30%.
          if (outsideDarkRatio >= 0.3) continue
          // De-dupe against already-accepted boxes
          if (accepted.some((r) =>
            Math.abs(r.x - x) < 8 && Math.abs(r.y - y) < 8 && Math.abs(r.w - side) < 8)) continue
          accepted.push({ x, y, w: side, h: side })
          const pxBbox = { x, y, w: side, h: side }
          out.push({
            spec: {
              kind: 'checkbox',
              page: pageIndex,
              rect: pxToUserSpace(pxBbox, W, H, pageSize.width, pageSize.height),
              defaultValue: checked,
            },
            confidence: perimRatio * (empty ? 0.9 : 0.85),
            pxBbox,
            detectedAs: 'checkbox',
          })
          break
        }
      }
    }

    return out
  } finally {
    doc.destroy()
  }
}

function pxToUserSpace(
  px: { x: number; y: number; w: number; h: number },
  W: number, H: number,
  userW: number, userH: number,
): { x: number; y: number; width: number; height: number } {
  const sx = userW / W
  const sy = userH / H
  // PDF user-space y grows UP; pixel y grows DOWN. Input px.y is the
  // TOP of the pixel bbox; convert to the BOTTOM-LEFT y in user-space.
  return {
    x: px.x * sx,
    y: (H - px.y - px.h) * sy,
    width: px.w * sx,
    height: px.h * sy,
  }
}

/** Assign unique names to detected fields based on their position so
 *  the caller can pass them through addFormFields. Names default to
 *  "text_1", "check_1" etc., preserving order. */
export function namedFromDetection(detected: DetectedField[]): FormFieldSpec[] {
  let textN = 1, checkN = 1
  return detected.map((d) => {
    const name = d.detectedAs === 'underline' ? `text_${textN++}` : `check_${checkN++}`
    return { ...d.spec, name } as FormFieldSpec
  })
}
