// Apply image-move (and eventually resize) edits to PDF bytes on save.
//
// Architecture mirrors pdfParagraphEdits: EditableImageLayer (UI)
// collects deltas of the form
//   { pageIndex, xObjectName, dx, dy, scaleX, scaleY }
// keyed on the XObject name found on that page. This service walks the
// page's content stream, finds each `cm ... /<name> Do` block, and
// rewrites the cm op to apply the new translation/scale. Every other
// byte stays identical to the original — same surgical-patch invariant
// the paragraph save path uses.
//
// Why cm-rewrite rather than replacing the Do block with a new draw:
//   - Preserves the XObject reference (so the image data itself isn't
//     duplicated).
//   - Preserves any ExtGState/color state around the Do.
//   - Respects PDF viewers that rely on stream structure (no Contents-
//     array flattening surprises).
//
// Limitations:
//   - Only the LAST cm inside the Do's enclosing q...Q scope is
//     rewritten. If the original stream concatenated multiple cm ops
//     before the Do (rare), only the last one is mutated; we rely on
//     parseContentStream's CTM composition to compute the effective
//     transform so the user sees correct positioning.
//   - No rotation handling via the drag UI. Scale + translate only.
//   - If cmByteRange is null (image drawn at identity CTM with no cm
//     preceding the Do in the scope), we skip the edit — inserting a
//     new cm would shift byte offsets for every subsequent operator
//     which breaks the patch contract. Fallback is future work.

import { PDFDocument } from 'pdf-lib'
import {
  parseContentStream,
  getPageContentLayout,
  patchPageContentStreams,
  encodeCmOp,
  type ImageDraw,
  type CtmMatrix,
} from './contentStreamParser'

/** Invert a 2D affine matrix in [a b c d e f] form. Returns null if the
 *  matrix is singular (shouldn't happen for image cms produced by any
 *  sane authoring tool). */
function invertCtm(m: CtmMatrix): CtmMatrix | null {
  const [a, b, c, d, e, f] = m
  const det = a * d - b * c
  if (Math.abs(det) < 1e-12) return null
  return [
    d / det,
    -b / det,
    -c / det,
    a / det,
    (c * f - d * e) / det,
    (b * e - a * f) / det,
  ]
}

/** Format a float for PDF content-stream embedding. Matches the
 *  bake-stage convention: fixed-point, trailing zeros trimmed,
 *  no scientific notation. */
function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return '0'
  const s = v.toFixed(4)
  const trimmed = s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
  return trimmed === '' || trimmed === '-' ? '0' : trimmed
}

/** Matrix product `lhs × rhs` in PDF's row-vector convention. */
function mul(lhs: CtmMatrix, rhs: CtmMatrix): CtmMatrix {
  const [a1, b1, c1, d1, e1, f1] = lhs
  const [a2, b2, c2, d2, e2, f2] = rhs
  return [
    a1 * a2 + b1 * c2,
    a1 * b2 + b1 * d2,
    c1 * a2 + d1 * c2,
    c1 * b2 + d1 * d2,
    e1 * a2 + f1 * c2 + e2,
    e1 * b2 + f1 * d2 + f2,
  ]
}

export interface ImageEdit {
  /** XObject reference name as it appears in the content stream, without
   *  the leading slash. Matches ImageDraw.xObjectName. */
  xObjectName: string
  /** Translation delta in PDF user-space points. Positive dy is UP
   *  (PDF convention) — the UI layer converts from viewport y-down to
   *  PDF y-up before committing. */
  dx: number
  dy: number
  /** Scale factors applied to the original cm's a and d components.
   *  1 = no change. Use the same value for both to keep aspect ratio. */
  scaleX?: number
  scaleY?: number
  /** Rotation in degrees, CCW around the image's bbox center. Composed
   *  with scale + translate by post-multiplying a rotation matrix
   *  centered on the image origin. */
  rotateDegrees?: number
  /** Mirror along the vertical axis (flip horizontal — left/right
   *  mirror). Multiplies the a component by -1 and shifts tx. */
  flipH?: boolean
  /** Mirror along the horizontal axis (flip vertical — top/bottom
   *  mirror). Multiplies the d component by -1 and shifts ty. */
  flipV?: boolean
  /** Sub-rectangle of the image to keep (crop). Coords are in the
   *  image's unit square: (0,0) = bottom-left, (1,1) = top-right.
   *  Implemented by inserting `<aabb_in_user_space> re W n` BEFORE
   *  the cm op so the clip is in ctmPrior space and intersects with
   *  any existing clip. The image bytes are unchanged — only the
   *  visible portion is restricted. Unrotated images only
   *  (b==c==0); rotated draws are skipped silently. */
  cropBox?: { x0: number; y0: number; x1: number; y1: number }
}

/** Index a page's image draws by xObjectName. When the same name is
 *  drawn multiple times on one page (e.g. a repeated watermark image),
 *  we only surface the first occurrence — resolving "which of the
 *  three copies did the user drag" needs stable per-instance ids. */
function byName(imageDraws: ImageDraw[]): Map<string, ImageDraw> {
  const out = new Map<string, ImageDraw>()
  for (const d of imageDraws) {
    if (!out.has(d.xObjectName)) out.set(d.xObjectName, d)
  }
  return out
}

/** Apply image edits to a single page by rewriting cm-op byte ranges.
 *  Returns the new PDF bytes, or the input bytes if no edits matched. */
export async function applyImageEditsToBytes(
  bytes: Uint8Array,
  pageIndex: number,
  edits: ImageEdit[],
): Promise<Uint8Array> {
  if (edits.length === 0) return bytes

  const pdfDoc = await PDFDocument.load(bytes)
  const layout = getPageContentLayout(pdfDoc, pageIndex)
  if (!layout) return bytes

  const parsed = parseContentStream(layout.bytes)
  const byNameMap = byName(parsed.imageDraws)

  const patches: Array<{ start: number; end: number; replacement: Uint8Array }> = []

  for (const edit of edits) {
    const draw = byNameMap.get(edit.xObjectName)
    if (!draw || !draw.cmByteRange) continue

    const ctm = draw.ctm
    let scaleX = edit.scaleX ?? 1
    let scaleY = edit.scaleY ?? 1
    if (edit.flipH) scaleX = -scaleX
    if (edit.flipV) scaleY = -scaleY

    // The CTM for an image is `[a b c d e f]` applied to the unit square
    // {(0,0)→(1,1)}. Image origin is at (e, f) in user-space. We want
    // to:
    //   1. Optionally scale (affects unit-square size)
    //   2. Optionally flip (equivalent to negative scale, shifted back)
    //   3. Optionally rotate around the image's bbox center
    //   4. Apply the translation delta
    //
    // Compose by starting from scaled-and-flipped ctm, then rotating
    // around the image center if requested, then translating.
    let desiredCtm: CtmMatrix = [
      ctm[0] * scaleX,
      ctm[1] * scaleX,
      ctm[2] * scaleY,
      ctm[3] * scaleY,
      ctm[4],
      ctm[5],
    ]
    // After a flip the image's e/f still represent the UNFLIPPED corner,
    // not the flipped one. Compensate so the post-flip bbox sits where
    // the original bbox was (same bottom-left corner).
    if (edit.flipH) desiredCtm[4] = ctm[4] + ctm[0]
    if (edit.flipV) desiredCtm[5] = ctm[5] + ctm[3]

    if (edit.rotateDegrees && edit.rotateDegrees % 360 !== 0) {
      const rad = (edit.rotateDegrees * Math.PI) / 180
      const cosT = Math.cos(rad)
      const sinT = Math.sin(rad)
      // Rotate around the image's bbox center in user-space (unrotated).
      const cx = ctm[4] + ctm[0] / 2
      const cy = ctm[5] + ctm[3] / 2
      // desired' = T(cx, cy) × R × T(-cx, -cy) × desired
      const t1: CtmMatrix = [1, 0, 0, 1, -cx, -cy]
      const r: CtmMatrix = [cosT, sinT, -sinT, cosT, 0, 0]
      const t2: CtmMatrix = [1, 0, 0, 1, cx, cy]
      desiredCtm = mul(mul(mul(desiredCtm, t1), r), t2)
    }

    desiredCtm[4] += edit.dx
    desiredCtm[5] += edit.dy

    // The composed CTM at Do time obeys `desired = new_last_cm × ctm_prior`.
    // Solve for new_last_cm: new_last_cm = desired × inv(ctm_prior).
    // This keeps every other byte (earlier cms, surrounding q/Q,
    // unrelated ops) identical to the original, preserving the surgical
    // patch invariant used by the rest of the save pipeline.
    const priorInv = invertCtm(draw.ctmPrior)
    if (!priorInv) continue
    const newLastCm = mul(desiredCtm, priorInv)

    const replacement = encodeCmOp(newLastCm)

    // Crop: prepend a clip rectangle in ctmPrior space. The clip
    // intersects with any existing clip (PDF spec §8.5.4 — `W`),
    // and gets restored when the image's enclosing q/Q pops.
    // Skips rotated images (b==c==0 check on the original cm)
    // because the AABB of a rotated unit-square crop loses
    // accuracy along the long diagonal.
    let combinedReplacement = replacement
    if (
      edit.cropBox &&
      Math.abs(ctm[1]) < 1e-6 &&
      Math.abs(ctm[2]) < 1e-6
    ) {
      const { x0, y0, x1, y1 } = edit.cropBox
      const lo = { x: Math.min(x0, x1), y: Math.min(y0, y1) }
      const hi = { x: Math.max(x0, x1), y: Math.max(y0, y1) }
      // Image-space corner → ctmPrior-space using the new cm so
      // the clip aligns with where the image will draw after the
      // scale/flip/rotate composition we just emitted.
      const transform = (px: number, py: number): { x: number; y: number } => {
        const a = newLastCm[0], b = newLastCm[1], c = newLastCm[2], d = newLastCm[3]
        const e = newLastCm[4], f = newLastCm[5]
        return { x: a * px + c * py + e, y: b * px + d * py + f }
      }
      const corners = [
        transform(lo.x, lo.y),
        transform(hi.x, lo.y),
        transform(hi.x, hi.y),
        transform(lo.x, hi.y),
      ]
      const xs = corners.map((p) => p.x)
      const ys = corners.map((p) => p.y)
      const cx = Math.min(...xs)
      const cy = Math.min(...ys)
      const cw = Math.max(...xs) - cx
      const ch = Math.max(...ys) - cy
      const clipBytes = new TextEncoder().encode(
        `${fmtNum(cx)} ${fmtNum(cy)} ${fmtNum(cw)} ${fmtNum(ch)} re W n\n`,
      )
      const merged = new Uint8Array(clipBytes.length + replacement.length)
      merged.set(clipBytes, 0)
      merged.set(replacement, clipBytes.length)
      combinedReplacement = merged
    }

    patches.push({
      start: draw.cmByteRange.start,
      end: draw.cmByteRange.start + draw.cmByteRange.length,
      replacement: combinedReplacement,
    })
  }

  if (patches.length === 0) return bytes

  patchPageContentStreams(layout, patches)
  return await pdfDoc.save()
}

/** Runtime-only preview helper: return PDF bytes for a page with matching
 * image/form XObject draw operators removed from that page's content stream.
 *
 * This is intentionally not used by save. It exists solely for the edit
 * compositor so a moved image can look "lifted" while its source area shows
 * the page underneath, without adding a white DOM mask or changing durable
 * PDF semantics.
 */
export async function suppressImageDrawsForPreview(
  bytes: Uint8Array,
  pageIndex: number,
  xObjectNames: string[],
): Promise<Uint8Array> {
  const names = new Set(xObjectNames.filter(Boolean))
  if (names.size === 0) return bytes

  const pdfDoc = await PDFDocument.load(bytes)
  const layout = getPageContentLayout(pdfDoc, pageIndex)
  if (!layout) return bytes

  const parsed = parseContentStream(layout.bytes)
  const patches: Array<{ start: number; end: number; replacement: Uint8Array }> = []

  for (const draw of parsed.imageDraws) {
    if (!names.has(draw.xObjectName)) continue
    const op = parsed.operators[draw.opIndex]
    if (!op || op.operator !== 'Do') continue
    patches.push({
      start: op.byteOffset,
      end: op.byteOffset + op.byteLength,
      replacement: new TextEncoder().encode(' '),
    })
  }

  if (patches.length === 0) return bytes
  patchPageContentStreams(layout, patches)
  return await pdfDoc.save()
}

/** Convenience — list all image draws on a page with their effective
 *  positions in PDF user-space. Used by EditableImageLayer to render
 *  the bounding boxes. Each entry includes the inferred draw rect
 *  assuming cm represents [w 0 0 h tx ty] (the common case); for
 *  rotated images the caller should fall back to a bounding-box
 *  computation using all four corners of the unit square. */
export interface ImageDrawRect {
  xObjectName: string
  /** Bottom-left origin in PDF user-space. */
  x: number
  y: number
  /** Effective width/height in PDF user-space (= abs of a/d for
   *  unrotated images). */
  width: number
  height: number
  /** True when cm contained rotation/shear. Bounding box in this case
   *  is an axis-aligned approximation of the rotated rect. */
  rotated: boolean
  cmPresent: boolean
}

export async function listImageDrawsOnPage(
  bytes: Uint8Array,
  pageIndex: number,
): Promise<ImageDrawRect[]> {
  const pdfDoc = await PDFDocument.load(bytes)
  const layout = getPageContentLayout(pdfDoc, pageIndex)
  if (!layout) return []

  const parsed = parseContentStream(layout.bytes)
  return parsed.imageDraws.map((d) => rectFromCtm(d))
}

export function rectFromCtm(draw: ImageDraw): ImageDrawRect {
  const [a, b, c, d, e, f] = draw.ctm
  const rotated = Math.abs(b) > 1e-6 || Math.abs(c) > 1e-6
  if (!rotated) {
    // Unit square {(0,0),(1,0),(1,1),(0,1)} under [a 0 0 d e f] maps to
    // {(e,f),(e+a,f),(e+a,f+d),(e,f+d)}. Width/height can be negative
    // if the image is flipped — normalize to a positive rect.
    const x = Math.min(e, e + a)
    const y = Math.min(f, f + d)
    return {
      xObjectName: draw.xObjectName,
      x, y,
      width: Math.abs(a),
      height: Math.abs(d),
      rotated: false,
      cmPresent: draw.cmByteRange !== null,
    }
  }
  // Rotated: transform all four corners and take the bounding box.
  const corners = [
    [0, 0], [1, 0], [1, 1], [0, 1],
  ].map(([ux, uy]) => [a * ux + c * uy + e, b * ux + d * uy + f])
  const xs = corners.map((p) => p[0])
  const ys = corners.map((p) => p[1])
  return {
    xObjectName: draw.xObjectName,
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
    rotated: true,
    cmPresent: draw.cmByteRange !== null,
  }
}
