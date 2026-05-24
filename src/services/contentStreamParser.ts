// PDF Content Stream Tokenizer, Parser, and Serializer
//
// Parses decompressed PDF content stream bytes into structured operators,
// enabling true text editing at the content-stream level. This is the
// foundation for Acrobat-parity body text editing.
//
// PDF content streams use postfix notation:
//   BT /F1 12 Tf 100 700 Td (Hello) Tj ET
//
// Reference: ISO 32000-1:2008, Section 7.8.2 (Content Streams)

import { PDFDocument, PDFName, PDFNumber, PDFRawStream } from 'pdf-lib'
import pako from 'pako'

// ── Types ──────────────────────────────────────────────────────────

export interface PdfString {
  type: 'literal' | 'hex'
  value: Uint8Array      // raw bytes (decoded from hex or literal escapes)
  decoded: string         // best-effort UTF-8/Latin-1 decode
}

export type TJArrayElement = {
  kind: 'string'
  value: PdfString
} | {
  kind: 'number'
  value: number
}

export interface ContentStreamOp {
  operator: string
  args: unknown[]         // numbers, PdfString, TJArrayElement[], PDFName strings
  byteOffset: number
  byteLength: number
}

export interface TextState {
  fontName: string
  fontSize: number
  x: number
  y: number
  lineX: number           // x set by Td/TD/Tm (for T* line start)
  lineY: number
}

export interface TextRun {
  text: string
  rawString: PdfString
  fontName: string
  fontSize: number
  x: number
  y: number
  opIndex: number
  isTJ: boolean           // true if part of a TJ array
  tjElementIndex?: number // index within TJ array
  /** Non-stroking (fill) color in effect when this text run was emitted,
   *  in 0-1 RGB. PDF spec default is {0,0,0} (black). We track g/rg/k
   *  and best-effort scn; CMYK is converted to RGB naively. This is
   *  the AUTHORITATIVE text color from the PDF source — the editor
   *  reads it so "edit Description" re-uses the same colour the author
   *  put on the run, regardless of the background or any luminance
   *  heuristic. */
  fillColor: { r: number; g: number; b: number }
}

/** A composite transform matrix (6 values in PDF order: a b c d e f)
 *  representing an affine transform applied by a `cm` operator. */
export type CtmMatrix = [number, number, number, number, number, number]

/** One image draw in the content stream — a `/ImN Do` call, attributed
 *  with the graphics-state CTM in effect at the time of the Do. We also
 *  record the byte range of the most recent `cm` op whose args made up
 *  the transform, so `applyImageEditsToBytes` can rewrite just those
 *  bytes to move/resize the image without rewriting the rest of the
 *  stream. */
export interface ImageDraw {
  /** XObject name as it appears in the content stream (with leading "/"
   *  stripped). For most PDFs this is "Im0", "Im1", "FXE1", etc. */
  xObjectName: string
  /** Composite transform in effect when the Do fired. Units are in PDF
   *  user-space. Equal to `cmLast × ctmPrior` when there is a preceding
   *  `cm` in this q/Q scope. */
  ctm: CtmMatrix
  /** CTM in effect just BEFORE the last `cm` op inside the current q/Q
   *  scope. Combined with the byte-level replacement, this lets save-
   *  time code compute new cm args that produce an arbitrary target
   *  CTM without rewriting any surrounding cm op (whose byte offsets
   *  would shift). When `cmByteRange` is null there was no cm in scope,
   *  so `ctmPrior === ctm`. */
  ctmPrior: CtmMatrix
  /** Byte offset + length of the LAST `cm` op whose args contributed
   *  to this CTM. This is the surgical target for translate/scale
   *  rewrites. Null if no cm preceded the Do inside the current q/Q
   *  block (e.g. the image is drawn at identity). */
  cmByteRange: { start: number; length: number } | null
  /** Index in `operators[]` where the Do appeared. */
  opIndex: number
  /** Byte offset of the Do itself. */
  doByteOffset: number
}

export interface ParsedContentStream {
  operators: ContentStreamOp[]
  textRuns: TextRun[]
  imageDraws: ImageDraw[]
  rawBytes: Uint8Array
}

// ── Tokenizer ──────────────────────────────────────────────────────

const enum CharCode {
  Space = 0x20,
  Tab = 0x09,
  LF = 0x0A,
  CR = 0x0D,
  FormFeed = 0x0C,
  Null = 0x00,
  LeftParen = 0x28,
  RightParen = 0x29,
  LessThan = 0x3C,
  GreaterThan = 0x3E,
  LeftBracket = 0x5B,
  RightBracket = 0x5D,
  Slash = 0x2F,
  Percent = 0x25,
  Backslash = 0x5C,
  Plus = 0x2B,
  Minus = 0x2D,
  Dot = 0x2E,
  Zero = 0x30,
  Nine = 0x39,
  A_upper = 0x41,
  F_upper = 0x46,
  a_lower = 0x61,
  f_lower = 0x66,
  n_lower = 0x6E,
  r_lower = 0x72,
  t_lower = 0x74,
  b_lower = 0x62,
}

type Token =
  | { type: 'number'; value: number; offset: number; length: number }
  | { type: 'string'; value: PdfString; offset: number; length: number }
  | { type: 'name'; value: string; offset: number; length: number }
  | { type: 'operator'; value: string; offset: number; length: number }
  | { type: 'array_start'; offset: number; length: number }
  | { type: 'array_end'; offset: number; length: number }

function isWhitespace(c: number): boolean {
  return c === CharCode.Space || c === CharCode.Tab || c === CharCode.LF ||
         c === CharCode.CR || c === CharCode.FormFeed || c === CharCode.Null
}

function isDigit(c: number): boolean {
  return c >= CharCode.Zero && c <= CharCode.Nine
}

function isHexDigit(c: number): boolean {
  return isDigit(c) ||
    (c >= CharCode.A_upper && c <= CharCode.F_upper) ||
    (c >= CharCode.a_lower && c <= CharCode.f_lower)
}

function isDelimiter(c: number): boolean {
  return c === CharCode.LeftParen || c === CharCode.RightParen ||
    c === CharCode.LessThan || c === CharCode.GreaterThan ||
    c === CharCode.LeftBracket || c === CharCode.RightBracket ||
    c === CharCode.Slash || c === CharCode.Percent
}

function hexVal(c: number): number {
  if (c >= CharCode.Zero && c <= CharCode.Nine) return c - CharCode.Zero
  if (c >= CharCode.A_upper && c <= CharCode.F_upper) return c - CharCode.A_upper + 10
  if (c >= CharCode.a_lower && c <= CharCode.f_lower) return c - CharCode.a_lower + 10
  return 0
}

export function tokenize(bytes: Uint8Array): Token[] {
  const tokens: Token[] = []
  let i = 0
  const len = bytes.length

  while (i < len) {
    // Skip whitespace
    while (i < len && isWhitespace(bytes[i])) i++
    if (i >= len) break

    const start = i
    const c = bytes[i]

    // Comment: skip to end of line
    if (c === CharCode.Percent) {
      while (i < len && bytes[i] !== CharCode.LF && bytes[i] !== CharCode.CR) i++
      continue
    }

    // Literal string: (...)
    if (c === CharCode.LeftParen) {
      i++ // skip (
      let depth = 1
      const raw: number[] = []
      while (i < len && depth > 0) {
        const ch = bytes[i]
        if (ch === CharCode.Backslash && i + 1 < len) {
          i++ // skip backslash
          const esc = bytes[i]
          if (esc === CharCode.n_lower) { raw.push(CharCode.LF); i++ }
          else if (esc === CharCode.r_lower) { raw.push(CharCode.CR); i++ }
          else if (esc === CharCode.t_lower) { raw.push(CharCode.Tab); i++ }
          else if (esc === CharCode.b_lower) { raw.push(0x08); i++ }
          else if (esc === CharCode.LeftParen) { raw.push(CharCode.LeftParen); i++ }
          else if (esc === CharCode.RightParen) { raw.push(CharCode.RightParen); i++ }
          else if (esc === CharCode.Backslash) { raw.push(CharCode.Backslash); i++ }
          else if (esc >= CharCode.Zero && esc <= CharCode.Zero + 7) {
            // Octal escape: up to 3 digits
            let octal = esc - CharCode.Zero
            if (i + 1 < len && bytes[i + 1] >= CharCode.Zero && bytes[i + 1] <= CharCode.Zero + 7) {
              i++; octal = octal * 8 + (bytes[i] - CharCode.Zero)
              if (i + 1 < len && bytes[i + 1] >= CharCode.Zero && bytes[i + 1] <= CharCode.Zero + 7) {
                i++; octal = octal * 8 + (bytes[i] - CharCode.Zero)
              }
            }
            raw.push(octal & 0xFF)
            i++
          } else if (esc === CharCode.LF) {
            i++ // line continuation
            if (i < len && bytes[i] === CharCode.CR) i++
          } else if (esc === CharCode.CR) {
            i++ // line continuation
            if (i < len && bytes[i] === CharCode.LF) i++
          } else {
            raw.push(esc); i++ // unknown escape, pass through
          }
        } else if (ch === CharCode.LeftParen) { depth++; raw.push(ch); i++ }
        else if (ch === CharCode.RightParen) { depth--; if (depth > 0) raw.push(ch); i++ }
        else { raw.push(ch); i++ }
      }
      const value = new Uint8Array(raw)
      tokens.push({
        type: 'string',
        value: { type: 'literal', value, decoded: decodePdfBytes(value) },
        offset: start,
        length: i - start,
      })
      continue
    }

    // Hex string: <...>
    if (c === CharCode.LessThan && i + 1 < len && bytes[i + 1] !== CharCode.LessThan) {
      i++ // skip <
      const hexChars: number[] = []
      while (i < len && bytes[i] !== CharCode.GreaterThan) {
        if (isHexDigit(bytes[i])) hexChars.push(bytes[i])
        i++
      }
      if (i < len) i++ // skip >
      // Pad odd-length hex strings with trailing 0
      if (hexChars.length % 2 !== 0) hexChars.push(CharCode.Zero)
      const value = new Uint8Array(hexChars.length / 2)
      for (let j = 0; j < value.length; j++) {
        value[j] = (hexVal(hexChars[j * 2]) << 4) | hexVal(hexChars[j * 2 + 1])
      }
      tokens.push({
        type: 'string',
        value: { type: 'hex', value, decoded: decodePdfBytes(value) },
        offset: start,
        length: i - start,
      })
      continue
    }

    // Name: /Something
    if (c === CharCode.Slash) {
      i++ // skip /
      let name = ''
      while (i < len && !isWhitespace(bytes[i]) && !isDelimiter(bytes[i])) {
        if (bytes[i] === 0x23 && i + 2 < len) { // #XX hex escape in names
          name += String.fromCharCode((hexVal(bytes[i + 1]) << 4) | hexVal(bytes[i + 2]))
          i += 3
        } else {
          name += String.fromCharCode(bytes[i])
          i++
        }
      }
      tokens.push({ type: 'name', value: name, offset: start, length: i - start })
      continue
    }

    // Array delimiters
    if (c === CharCode.LeftBracket) {
      tokens.push({ type: 'array_start', offset: start, length: 1 })
      i++
      continue
    }
    if (c === CharCode.RightBracket) {
      tokens.push({ type: 'array_end', offset: start, length: 1 })
      i++
      continue
    }

    // Number or operator
    if (isDigit(c) || c === CharCode.Plus || c === CharCode.Minus || c === CharCode.Dot) {
      // Try to parse as number
      const numStart = i
      if (c === CharCode.Plus || c === CharCode.Minus) i++
      let hasDot = false
      if (i < len && bytes[i] === CharCode.Dot) { hasDot = true; i++ }
      let hasDigits = false
      while (i < len && isDigit(bytes[i])) { hasDigits = true; i++ }
      if (!hasDot && i < len && bytes[i] === CharCode.Dot) { hasDot = true; i++; while (i < len && isDigit(bytes[i])) { hasDigits = true; i++ } }

      if (hasDigits) {
        const numStr = new TextDecoder().decode(bytes.slice(numStart, i))
        tokens.push({ type: 'number', value: parseFloat(numStr), offset: numStart, length: i - numStart })
        continue
      }
      // Not a valid number, fall through to operator
      i = numStart
    }

    // Inline image: BI ... ID <data> EI — skip the entire block
    if (c === 0x42 && i + 1 < len && bytes[i + 1] === 0x49) { // 'B','I'
      // Check if it's actually BI operator (followed by whitespace)
      if (i + 2 >= len || isWhitespace(bytes[i + 2]) || isDelimiter(bytes[i + 2])) {
        // Find ID (image data start)
        let j = i + 2
        while (j < len - 1) {
          if (bytes[j] === 0x49 && bytes[j + 1] === 0x44 && (j + 2 >= len || isWhitespace(bytes[j + 2]))) {
            // Found ID, now find EI
            j += 2
            if (j < len && isWhitespace(bytes[j])) j++ // skip whitespace after ID
            // Scan for EI preceded by whitespace
            while (j < len - 1) {
              if (bytes[j] === 0x45 && bytes[j + 1] === 0x49 && (j === 0 || isWhitespace(bytes[j - 1])) && (j + 2 >= len || isWhitespace(bytes[j + 2]) || isDelimiter(bytes[j + 2]))) {
                j += 2
                break
              }
              j++
            }
            break
          }
          j++
        }
        // Emit the entire BI..EI block as a single operator
        tokens.push({ type: 'operator', value: '__inline_image', offset: start, length: j - start })
        i = j
        continue
      }
    }

    // Operator keyword (alphabetic)
    {
      const opStart = i
      while (i < len && !isWhitespace(bytes[i]) && !isDelimiter(bytes[i])) i++
      if (i > opStart) {
        const op = new TextDecoder().decode(bytes.slice(opStart, i))
        tokens.push({ type: 'operator', value: op, offset: opStart, length: i - opStart })
      } else {
        i++ // skip unrecognized byte
      }
    }
  }

  return tokens
}

// ── Parser ─────────────────────────────────────────────────────────

// Text-related operators that we need to understand
const TEXT_OPS = new Set([
  'BT', 'ET', 'Tf', 'Tm', 'Td', 'TD', 'T*', 'Tj', 'TJ',
  'Tc', 'Tw', 'Tz', 'TL', 'Ts', 'Tr', "'", '"'
])

/** Subset of the PDF graphics state that affects text rendering. PDF
 *  spec says the text state is also part of the full graphics stack
 *  but our tokenizer tracks text state separately and that's been
 *  working; this struct holds only what we need to attribute colors
 *  to text runs. */
interface GraphicsState {
  /** Current non-stroking (fill) color, 0-1 RGB. Text with default
   *  render mode (Tr 0) is filled with this color. */
  fillColor: { r: number; g: number; b: number }
  /** Text rendering mode (Tr). 0=fill, 1=stroke, 2=fill+stroke,
   *  3=invisible, 4-7=clipping variants. We record it but currently
   *  only use fill for paragraph-level color attribution. */
  renderMode: number
  /** Current non-stroking color space name (e.g. '/DeviceRGB',
   *  '/DeviceGray'). Used to interpret ambiguous `scn` calls when we
   *  see them. */
  colorSpace: string
}

function defaultGraphicsState(): GraphicsState {
  return {
    fillColor: { r: 0, g: 0, b: 0 },
    renderMode: 0,
    colorSpace: '/DeviceGray',
  }
}

function cloneGraphicsState(s: GraphicsState): GraphicsState {
  return {
    fillColor: { r: s.fillColor.r, g: s.fillColor.g, b: s.fillColor.b },
    renderMode: s.renderMode,
    colorSpace: s.colorSpace,
  }
}

/** Naive CMYK→RGB. The true conversion depends on the output intent
 *  (typically sRGB) but most PDFs we care about use DeviceRGB anyway;
 *  this approximation is accurate enough to decide "red vs. blue"
 *  which is all the color picker needs as a starting value. */
function cmykToRgb(c: number, m: number, y: number, k: number): { r: number; g: number; b: number } {
  const r = (1 - Math.min(1, c)) * (1 - Math.min(1, k))
  const g = (1 - Math.min(1, m)) * (1 - Math.min(1, k))
  const b = (1 - Math.min(1, y)) * (1 - Math.min(1, k))
  return { r, g, b }
}

/** Identity 3×3 affine matrix as stored in a 6-value PDF CTM. */
const IDENTITY_CTM: CtmMatrix = [1, 0, 0, 1, 0, 0]

/** Concatenate two PDF CTMs for a `cm m2` op applied on top of CTM `m1`.
 *
 *  PDF uses row-vector convention: a point `p` transforms as `p' = p × CTM`.
 *  Per ISO 32000-1 §8.3.2, `cm` with matrix M pre-multiplies the current
 *  CTM: `CTM' ← M × CTM`. So for points, `p_device = p × (M × CTM)`, which
 *  means the LATEST cm is applied to the user point FIRST, then prior cms
 *  in reverse order.
 *
 *  Using the PDF spec's [a b c d e f] layout representing
 *    [ a b 0 ]
 *    [ c d 0 ]
 *    [ e f 1 ]
 *  the result of `m2 × m1` in [a b c d e f] form is computed below. */
function concatCtm(m1: CtmMatrix, m2: CtmMatrix): CtmMatrix {
  const [a1, b1, c1, d1, e1, f1] = m1
  const [a2, b2, c2, d2, e2, f2] = m2
  return [
    a2 * a1 + b2 * c1,
    a2 * b1 + b2 * d1,
    c2 * a1 + d2 * c1,
    c2 * b1 + d2 * d1,
    e2 * a1 + f2 * c1 + e1,
    e2 * b1 + f2 * d1 + f1,
  ]
}

/** One frame of the graphics-state stack we track for image draws. Only
 *  the CTM + "last cm byte range in this scope" are stashed; the scope
 *  resets on `q` so a `cm` inside a nested q/Q is correctly attributed
 *  to that nested save/restore. */
interface CtmFrame {
  ctm: CtmMatrix
  /** CTM value captured right BEFORE the last `cm` op in this scope
   *  was applied. Used by image-edit to compute new cm args without
   *  touching surrounding byte offsets. */
  ctmPriorToLastCm: CtmMatrix
  lastCmRange: { start: number; length: number } | null
}

export function parseContentStream(bytes: Uint8Array): ParsedContentStream {
  const tokens = tokenize(bytes)
  const operators: ContentStreamOp[] = []
  const textRuns: TextRun[] = []
  const imageDraws: ImageDraw[] = []

  // Text state machine
  const state: TextState = { fontName: '', fontSize: 12, x: 0, y: 0, lineX: 0, lineY: 0 }
  let inText = false

  // Graphics state stack. q pushes a copy; Q pops. Color-affecting ops
  // mutate the top of stack. We seed with the PDF default (black fill)
  // so any text emitted before an explicit color op is recorded as
  // black — matches viewer behavior and the spec.
  const gstack: GraphicsState[] = [defaultGraphicsState()]
  const top = (): GraphicsState => gstack[gstack.length - 1]

  // CTM stack — shadows gstack for image-draw attribution. We keep this
  // separate so image tracking can evolve independently of color state.
  // Each frame holds the CTM in effect AND the byte range of the most
  // recent `cm` op whose args made up the current top-level translation
  // of this frame. That range is what applyImageEditsToBytes rewrites
  // to move/resize an image. `lastCmRange` resets on `q` (nested scope)
  // and is updated on each `cm`.
  const cstack: CtmFrame[] = [{
    ctm: [...IDENTITY_CTM] as CtmMatrix,
    ctmPriorToLastCm: [...IDENTITY_CTM] as CtmMatrix,
    lastCmRange: null,
  }]
  const ctop = (): CtmFrame => cstack[cstack.length - 1]

  const argStack: unknown[] = []
  let argStart = -1

  for (const token of tokens) {
    if (token.type === 'number' || token.type === 'string' || token.type === 'name') {
      if (argStart < 0) argStart = token.offset
      if (token.type === 'number') argStack.push(token.value)
      else if (token.type === 'string') argStack.push(token.value)
      else argStack.push(token.value) // name as string
      continue
    }

    if (token.type === 'array_start') {
      // Collect array elements until array_end
      if (argStart < 0) argStart = token.offset
      // We'll handle arrays by continuing to push to argStack with a marker
      argStack.push('__array_start')
      continue
    }

    if (token.type === 'array_end') {
      // Collect everything since __array_start into an array
      const arr: TJArrayElement[] = []
      while (argStack.length > 0) {
        const top = argStack.pop()
        if (top === '__array_start') break
        if (typeof top === 'number') arr.unshift({ kind: 'number', value: top })
        else if (top && typeof top === 'object' && 'type' in (top as object)) {
          arr.unshift({ kind: 'string', value: top as PdfString })
        }
      }
      argStack.push(arr)
      continue
    }

    if (token.type === 'operator') {
      const op = token.value
      const args = [...argStack]
      const opByteOffset = argStart >= 0 ? argStart : token.offset
      const opByteLength = (token.offset + token.length) - opByteOffset

      operators.push({
        operator: op,
        args,
        byteOffset: opByteOffset,
        byteLength: opByteLength,
      })

      const opIdx = operators.length - 1

      // Update graphics state first (color / mode ops).
      if (op === 'q') {
        gstack.push(cloneGraphicsState(top()))
        // Push a new CTM frame that inherits the parent's CTM but
        // starts with no cm-range attribution in this scope — nested
        // `cm` ops should not overwrite the outer scope's range.
        cstack.push({
          ctm: [...ctop().ctm] as CtmMatrix,
          ctmPriorToLastCm: [...ctop().ctm] as CtmMatrix,
          lastCmRange: null,
        })
      }
      else if (op === 'Q') {
        if (gstack.length > 1) gstack.pop()
        if (cstack.length > 1) cstack.pop()
      }
      else if (op === 'cm' && args.length >= 6) {
        const m: CtmMatrix = [
          Number(args[0]), Number(args[1]),
          Number(args[2]), Number(args[3]),
          Number(args[4]), Number(args[5]),
        ]
        const frame = ctop()
        // Capture what the CTM was BEFORE this cm — that's the
        // "prior" for the next Do in this scope.
        frame.ctmPriorToLastCm = [...frame.ctm] as CtmMatrix
        frame.ctm = concatCtm(frame.ctm, m)
        frame.lastCmRange = { start: opByteOffset, length: opByteLength }
      }
      else if (op === 'Do' && args.length >= 1) {
        const name = String(args[0]).replace(/^\//, '')
        imageDraws.push({
          xObjectName: name,
          ctm: [...ctop().ctm] as CtmMatrix,
          ctmPrior: [...ctop().ctmPriorToLastCm] as CtmMatrix,
          cmByteRange: ctop().lastCmRange ? { ...ctop().lastCmRange! } : null,
          opIndex: opIdx,
          doByteOffset: token.offset,
        })
      }
      else if (op === 'g' && args.length >= 1) {
        const v = Number(args[0])
        top().fillColor = { r: v, g: v, b: v }
        top().colorSpace = '/DeviceGray'
      }
      else if (op === 'rg' && args.length >= 3) {
        top().fillColor = {
          r: Number(args[0]),
          g: Number(args[1]),
          b: Number(args[2]),
        }
        top().colorSpace = '/DeviceRGB'
      }
      else if (op === 'k' && args.length >= 4) {
        top().fillColor = cmykToRgb(
          Number(args[0]),
          Number(args[1]),
          Number(args[2]),
          Number(args[3]),
        )
        top().colorSpace = '/DeviceCMYK'
      }
      else if (op === 'cs' && args.length >= 1) {
        top().colorSpace = String(args[0])
      }
      else if ((op === 'scn' || op === 'sc') && args.length >= 1) {
        // Interpret by current color space when possible; otherwise
        // fall back to arg count as a heuristic.
        const cs = top().colorSpace
        if (cs === '/DeviceRGB' && args.length >= 3) {
          top().fillColor = {
            r: Number(args[0]),
            g: Number(args[1]),
            b: Number(args[2]),
          }
        } else if (cs === '/DeviceCMYK' && args.length >= 4) {
          top().fillColor = cmykToRgb(
            Number(args[0]),
            Number(args[1]),
            Number(args[2]),
            Number(args[3]),
          )
        } else if (cs === '/DeviceGray' && args.length >= 1 && typeof args[0] === 'number') {
          const v = Number(args[0])
          top().fillColor = { r: v, g: v, b: v }
        } else if (args.length >= 3 && typeof args[0] === 'number') {
          // Best-effort: 3 numeric args → treat as RGB.
          top().fillColor = {
            r: Number(args[0]),
            g: Number(args[1]),
            b: Number(args[2]),
          }
        } else if (args.length === 1 && typeof args[0] === 'number') {
          const v = Number(args[0])
          top().fillColor = { r: v, g: v, b: v }
        }
      }
      else if (op === 'Tr' && args.length >= 1) {
        top().renderMode = Number(args[0])
      }

      // Update text state
      if (op === 'BT') { inText = true; state.x = 0; state.y = 0; state.lineX = 0; state.lineY = 0 }
      else if (op === 'ET') { inText = false }
      else if (op === 'Tf' && args.length >= 2) {
        state.fontName = String(args[0])
        state.fontSize = Number(args[1])
      }
      else if (op === 'Tm' && args.length >= 6) {
        state.x = Number(args[4])
        state.y = Number(args[5])
        state.lineX = state.x
        state.lineY = state.y
      }
      else if (op === 'Td' && args.length >= 2) {
        state.x = state.lineX + Number(args[0])
        state.y = state.lineY + Number(args[1])
        state.lineX = state.x
        state.lineY = state.y
      }
      else if (op === 'TD' && args.length >= 2) {
        state.x = state.lineX + Number(args[0])
        state.y = state.lineY + Number(args[1])
        state.lineX = state.x
        state.lineY = state.y
      }
      else if (op === 'T*') {
        // Move to start of next line (uses TL leading)
        state.y = state.lineY // approximate — TL not tracked yet
        state.x = state.lineX
      }
      else if (op === 'Tj' && args.length >= 1 && inText) {
        const str = args[0] as PdfString
        if (str && typeof str === 'object' && 'decoded' in str) {
          textRuns.push({
            text: str.decoded,
            rawString: str,
            fontName: state.fontName,
            fontSize: state.fontSize,
            x: state.x,
            y: state.y,
            opIndex: opIdx,
            isTJ: false,
            fillColor: { ...top().fillColor },
          })
        }
      }
      else if (op === 'TJ' && args.length >= 1 && inText) {
        const arr = args[0] as TJArrayElement[]
        if (Array.isArray(arr)) {
          arr.forEach((el, elIdx) => {
            if (el.kind === 'string') {
              textRuns.push({
                text: el.value.decoded,
                rawString: el.value,
                fontName: state.fontName,
                fontSize: state.fontSize,
                x: state.x,
                y: state.y,
                opIndex: opIdx,
                isTJ: true,
                tjElementIndex: elIdx,
                fillColor: { ...top().fillColor },
              })
            }
          })
        }
      }
      else if ((op === "'" || op === '"') && inText) {
        // ' and " operators: move to next line then show text
        if (args.length >= 1) {
          const lastArg = args[args.length - 1]
          if (lastArg && typeof lastArg === 'object' && 'decoded' in (lastArg as object)) {
            const str = lastArg as PdfString
            textRuns.push({
              text: str.decoded,
              rawString: str,
              fontName: state.fontName,
              fontSize: state.fontSize,
              x: state.lineX,
              y: state.y,
              opIndex: opIdx,
              isTJ: false,
              fillColor: { ...top().fillColor },
            })
          }
        }
      }

      argStack.length = 0
      argStart = -1
    }
  }

  return { operators, textRuns, imageDraws, rawBytes: bytes }
}

// ── Image cm-matrix patch helper ───────────────────────────────────

/** Serialise a CTM back to `a b c d e f cm` bytes. Numbers are printed
 *  with enough precision to round-trip through pdfjs's lexer (6 decimal
 *  places matches what Acrobat itself writes). Trailing zeros are
 *  trimmed so we don't add unnecessary bytes. */
export function encodeCmOp(ctm: CtmMatrix): Uint8Array {
  const fmt = (n: number): string => {
    if (!Number.isFinite(n)) return '0'
    // 6 digits, then strip trailing zeros + a trailing dot.
    const s = n.toFixed(6)
    return s.replace(/\.?0+$/, '').replace(/^-0$/, '0') || '0'
  }
  const text = `${fmt(ctm[0])} ${fmt(ctm[1])} ${fmt(ctm[2])} ${fmt(ctm[3])} ${fmt(ctm[4])} ${fmt(ctm[5])} cm`
  return new TextEncoder().encode(text)
}

// ── Serializer ─────────────────────────────────────────────────────

/** Encode a string as PDF literal string bytes: (escaped content) */
function encodeLiteralString(value: Uint8Array): Uint8Array {
  const parts: number[] = [CharCode.LeftParen]
  for (const b of value) {
    if (b === CharCode.LeftParen || b === CharCode.RightParen || b === CharCode.Backslash) {
      parts.push(CharCode.Backslash, b)
    } else {
      parts.push(b)
    }
  }
  parts.push(CharCode.RightParen)
  return new Uint8Array(parts)
}

/** Encode a string as PDF hex string bytes: <hex digits> */
function encodeHexString(value: Uint8Array): Uint8Array {
  const hex = Array.from(value, b => b.toString(16).padStart(2, '0')).join('')
  return new TextEncoder().encode('<' + hex + '>')
}

/** Encode a PdfString back to its original format */
export function encodePdfString(str: PdfString): Uint8Array {
  return str.type === 'hex' ? encodeHexString(str.value) : encodeLiteralString(str.value)
}

/** Serialize a full parsed content stream back to bytes */
export function serializeContentStream(ops: ContentStreamOp[], rawBytes: Uint8Array): Uint8Array {
  // Strategy: rebuild from original raw bytes, replacing only modified regions
  // This preserves non-text operators byte-for-byte
  const chunks: Uint8Array[] = []
  let cursor = 0

  for (const op of ops) {
    // Copy any bytes between the previous op and this one (whitespace, etc.)
    if (op.byteOffset > cursor) {
      chunks.push(rawBytes.slice(cursor, op.byteOffset))
    }

    if (op.operator === '__modified') {
      // This operator was replaced — use the serialized bytes stored in args[0]
      chunks.push(op.args[0] as Uint8Array)
    } else {
      // Copy original bytes verbatim
      chunks.push(rawBytes.slice(op.byteOffset, op.byteOffset + op.byteLength))
    }

    cursor = op.byteOffset + op.byteLength
  }

  // Copy trailing bytes
  if (cursor < rawBytes.length) {
    chunks.push(rawBytes.slice(cursor))
  }

  // Concatenate
  const totalLen = chunks.reduce((s, c) => s + c.length, 0)
  const result = new Uint8Array(totalLen)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

// ── Text Replacement ───────────────────────────────────────────────

/** Replace text in a Tj operator */
function buildReplacedTj(newTextBytes: Uint8Array, originalFormat: 'literal' | 'hex'): Uint8Array {
  const strBytes = originalFormat === 'hex'
    ? encodeHexString(newTextBytes)
    : encodeLiteralString(newTextBytes)
  const tjBytes = new TextEncoder().encode(' Tj')
  const result = new Uint8Array(strBytes.length + tjBytes.length)
  result.set(strBytes, 0)
  result.set(tjBytes, strBytes.length)
  return result
}

/** Replace text in a TJ operator, preserving kerning structure */
function buildReplacedTJ(
  originalArray: TJArrayElement[],
  newTexts: Map<number, Uint8Array> // elementIndex → new bytes
): Uint8Array {
  const parts: string[] = ['[']
  for (let i = 0; i < originalArray.length; i++) {
    const el = originalArray[i]
    if (el.kind === 'number') {
      parts.push(String(el.value))
    } else {
      const newBytes = newTexts.get(i) ?? el.value.value
      if (el.value.type === 'hex') {
        parts.push('<' + Array.from(newBytes, b => b.toString(16).padStart(2, '0')).join('') + '>')
      } else {
        // Literal string with escapes
        let s = '('
        for (const b of newBytes) {
          if (b === CharCode.LeftParen || b === CharCode.RightParen || b === CharCode.Backslash) s += '\\' + String.fromCharCode(b)
          else s += String.fromCharCode(b)
        }
        s += ')'
        parts.push(s)
      }
    }
    if (i < originalArray.length - 1) parts.push(' ')
  }
  parts.push('] TJ')
  return new TextEncoder().encode(parts.join(''))
}

/** Apply a text replacement to a parsed content stream.
 *  Marks the operator as '__modified' with serialized bytes. */
export function applyTextReplacement(
  parsed: ParsedContentStream,
  opIndex: number,
  newTextBytes: Uint8Array,
  tjElementIndex?: number
): void {
  const op = parsed.operators[opIndex]
  if (!op) return

  if (op.operator === 'Tj') {
    const original = op.args[0] as PdfString
    const replaced = buildReplacedTj(newTextBytes, original.type)
    op.operator = '__modified'
    op.args = [replaced]
  } else if (op.operator === 'TJ' && tjElementIndex !== undefined) {
    const arr = op.args[0] as TJArrayElement[]
    const replacements = new Map<number, Uint8Array>()
    replacements.set(tjElementIndex, newTextBytes)
    const replaced = buildReplacedTJ(arr, replacements)
    op.operator = '__modified'
    op.args = [replaced]
  }
}

// ── Text Reflow ────────────────────────────────────────────────────

/** Estimate text width in PDF points using average character width from pdfjs extraction data.
 *  Falls back to fontSize * 0.5 * charCount if no extraction data available. */
export function estimateTextWidth(
  text: string,
  fontSize: number,
  avgCharWidth?: number
): number {
  const acw = avgCharWidth ?? fontSize * 0.5
  return text.length * acw
}

/** Simple word-wrap: split text into lines that fit within maxWidth.
 *  Returns array of line strings. */
export function wordWrap(
  text: string,
  maxWidth: number,
  fontSize: number,
  avgCharWidth?: number
): string[] {
  const acw = avgCharWidth ?? fontSize * 0.5
  const words = text.split(/\s+/)
  const lines: string[] = []
  let current = ''

  for (const word of words) {
    const test = current ? current + ' ' + word : word
    if (test.length * acw > maxWidth && current) {
      lines.push(current)
      current = word
    } else {
      current = test
    }
  }
  if (current) lines.push(current)
  return lines.length > 0 ? lines : ['']
}

/**
 * Apply text replacement with reflow: if the new text is longer than the original,
 * word-wrap it and insert additional Td + Tj operators for extra lines.
 * If shorter, the extra space is left (future: could compact).
 */
export function applyTextReplacementWithReflow(
  parsed: ParsedContentStream,
  opIndex: number,
  newText: string,
  originalWidth: number,
  fontSize: number,
  lineHeight: number,
  avgCharWidth?: number,
  encodeFunc?: (text: string) => Uint8Array
): void {
  const encode = encodeFunc ?? encodeTextToBytes
  const lines = wordWrap(newText, originalWidth, fontSize, avgCharWidth)

  if (lines.length <= 1) {
    // Fits on one line — simple replacement
    const bytes = encode(lines[0] || '')
    applyTextReplacement(parsed, opIndex, bytes)
    return
  }

  // Multi-line: build replacement bytes with Td + Tj for each line
  const op = parsed.operators[opIndex]
  if (!op) return

  const original = op.args[0] as PdfString
  const strType = original?.type ?? 'hex'

  const parts: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const lineBytes = encode(lines[i])
    const strRepr = strType === 'hex'
      ? '<' + Array.from(lineBytes, b => b.toString(16).padStart(2, '0')).join('') + '>'
      : '(' + Array.from(lineBytes, b => {
          if (b === 0x28 || b === 0x29 || b === 0x5C) return '\\' + String.fromCharCode(b)
          return String.fromCharCode(b)
        }).join('') + ')'

    if (i > 0) {
      // Move down by lineHeight * fontSize
      const yOffset = -(fontSize * lineHeight)
      parts.push(`0 ${yOffset.toFixed(2)} Td`)
    }
    parts.push(`${strRepr} Tj`)
  }

  op.operator = '__modified'
  op.args = [new TextEncoder().encode(parts.join('\n'))]
}

// ── Stream Access ──────────────────────────────────────────────────

/** Decode a content stream's raw bytes, respecting a filter chain.
 *  Supports single names and filter arrays (e.g. `[/ASCII85Decode /FlateDecode]`).
 *  The January/February/March invoice PDFs we test against use exactly
 *  that chain — until this decoder landed, getPageContentBytes silently
 *  returned the ASCII85-encoded bytes as if they were plaintext ops,
 *  which the parser then couldn't make sense of. */
function filterNames(filterVal: unknown): string[] {
  if (!filterVal) return []
  // PDFArray of /Name entries
  const asArray = (filterVal as { asArray?: () => unknown[] }).asArray
  if (typeof asArray === 'function') {
    const arr = asArray.call(filterVal)
    const out: string[] = []
    for (const f of arr) {
      const asString = (f as { asString?: () => string }).asString
      out.push(typeof asString === 'function' ? asString.call(f) : String(f))
    }
    return out
  }
  // Single /Name
  const asString = (filterVal as { asString?: () => string }).asString
  if (typeof asString === 'function') return [asString.call(filterVal)]
  return [String(filterVal)]
}

function ascii85Decode(input: Uint8Array): Uint8Array {
  // ASCII85: 5 chars → 4 bytes. 'z' shortcut = 4 zero bytes. End marker: '~>'.
  let s = ''
  // Decode as latin1 — ASCII85 output is all ASCII 33-117.
  for (let i = 0; i < input.length; i++) s += String.fromCharCode(input[i])
  if (s.startsWith('<~')) s = s.slice(2)
  const end = s.indexOf('~>')
  if (end >= 0) s = s.slice(0, end)
  s = s.replace(/\s/g, '')
  const out: number[] = []
  let i = 0
  while (i < s.length) {
    if (s[i] === 'z') {
      out.push(0, 0, 0, 0)
      i++
      continue
    }
    let acc = 0
    let chars = 0
    while (chars < 5 && i < s.length) {
      const c = s.charCodeAt(i)
      i++
      if (c < 33 || c > 117) continue
      acc = acc * 85 + (c - 33)
      chars++
    }
    if (chars === 0) break
    const pad = 5 - chars
    for (let j = 0; j < pad; j++) acc = acc * 85 + 84
    out.push((acc >>> 24) & 0xff, (acc >>> 16) & 0xff, (acc >>> 8) & 0xff, acc & 0xff)
    if (pad > 0) out.length -= pad
  }
  return new Uint8Array(out)
}

function asciiHexDecode(input: Uint8Array): Uint8Array {
  let s = ''
  for (let i = 0; i < input.length; i++) s += String.fromCharCode(input[i])
  const end = s.indexOf('>')
  if (end >= 0) s = s.slice(0, end)
  s = s.replace(/\s/g, '')
  if (s.length % 2 === 1) s += '0'
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function decodeStream(raw: Uint8Array, filterVal: unknown): Uint8Array {
  const names = filterNames(filterVal)
  let current = raw
  for (const name of names) {
    switch (name) {
      case '/FlateDecode':
      case '/Fl':
        current = new Uint8Array(pako.inflate(current))
        break
      case '/ASCII85Decode':
      case '/A85':
        current = ascii85Decode(current)
        break
      case '/ASCIIHexDecode':
      case '/AHx':
        current = asciiHexDecode(current)
        break
      default:
        // Unknown/unsupported filter — bail out; caller gets whatever
        // partial decode we achieved, and the parser will skip what it
        // can't understand.
        return current
    }
  }
  return current
}

/** Get decompressed content stream bytes for a page */
export function getPageContentBytes(
  pdfDoc: PDFDocument,
  pageIndex: number
): { stream: PDFRawStream; bytes: Uint8Array; isCompressed: boolean } | null {
  try {
    const page = pdfDoc.getPage(pageIndex)
    const contentsRef = page.node.get(PDFName.of('Contents'))
    if (!contentsRef) return null

    const resolved = pdfDoc.context.lookup(contentsRef)
    if (!resolved) return null

    // Handle PDFArray of content streams (concatenate)
    if ('size' in resolved && typeof (resolved as any).size === 'function') {
      const arr = resolved as any
      const allBytes: number[] = []
      for (let i = 0; i < arr.size(); i++) {
        const ref = arr.get(i)
        const stream = pdfDoc.context.lookup(ref) as PDFRawStream
        if (stream && 'getContents' in stream) {
          const filterVal = stream.dict?.get(PDFName.of('Filter'))
          const raw = stream.getContents()
          const decoded = decodeStream(raw, filterVal)
          for (let j = 0; j < decoded.length; j++) allBytes.push(decoded[j])
          allBytes.push(CharCode.LF)
        }
      }
      const firstRef = arr.get(0)
      const firstStream = pdfDoc.context.lookup(firstRef) as PDFRawStream
      return { stream: firstStream, bytes: new Uint8Array(allBytes), isCompressed: true }
    }

    // Single stream (may still have a filter chain)
    const stream = resolved as PDFRawStream
    if (!stream || !('getContents' in stream)) return null
    const filterVal = stream.dict?.get(PDFName.of('Filter'))
    const raw = stream.getContents()
    const bytes = decodeStream(raw, filterVal)
    const isCompressed = filterNames(filterVal).length > 0
    return { stream, bytes, isCompressed }
  } catch (err) {
    console.warn('[contentStreamParser] getPageContentBytes failed:', err)
    return null
  }
}

/**
 * Extended content-stream access that preserves the per-sub-stream
 * layout so surgical patches can write back to the right pieces
 * without restructuring the Page's Contents array.
 *
 * getPageContentBytes concatenates all sub-streams with an LF between
 * them; `subStreams` records where each one's decoded bytes start and
 * end in that concatenated view. A caller with a patch at global
 * offset N finds the sub-stream containing N, converts to a local
 * offset, and rewrites just that sub-stream — leaving the Contents
 * array structure (and every other byte on the page, including the
 * /GS-xxx ExtGState references) untouched.
 *
 * This is the piece that makes the Acrobat-style "incremental update"
 * edit path work: only the bytes that belong to the edited Tj operator
 * change. Earlier replacePageContents-based code flattened the array
 * into one new stream, which under some PDFs broke rendering of
 * filled rectangles that sat under the edited text (FINDINGS.md #2).
 */
export interface PageContentLayout {
  /** Concatenated decoded bytes across every sub-stream. */
  bytes: Uint8Array
  isCompressed: boolean
  subStreams: Array<{
    stream: PDFRawStream
    /** Decoded-bytes offset in `bytes` where this sub-stream begins. */
    globalStart: number
    /** Exclusive end offset. */
    globalEnd: number
  }>
  /** Primary stream — in single-stream case it's the sole stream; in
   *  multi-stream it's the first. Kept for callers that still use the
   *  legacy `writePageContentBytes(stream, …)` API. */
  stream: PDFRawStream
}

export function getPageContentLayout(
  pdfDoc: PDFDocument,
  pageIndex: number,
): PageContentLayout | null {
  try {
    const page = pdfDoc.getPage(pageIndex)
    const contentsRef = page.node.get(PDFName.of('Contents'))
    if (!contentsRef) return null
    const resolved = pdfDoc.context.lookup(contentsRef)
    if (!resolved) return null

    const subStreams: PageContentLayout['subStreams'] = []
    const buf: number[] = []
    let primary: PDFRawStream | null = null

    // PDFArray of streams.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ('size' in resolved && typeof (resolved as any).size === 'function') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const arr = resolved as any
      for (let i = 0; i < arr.size(); i++) {
        const ref = arr.get(i)
        const stream = pdfDoc.context.lookup(ref) as PDFRawStream
        if (!stream || !('getContents' in stream)) continue
        const filterVal = stream.dict?.get(PDFName.of('Filter'))
        const raw = stream.getContents()
        const decoded = decodeStream(raw, filterVal)
        const globalStart = buf.length
        for (let j = 0; j < decoded.length; j++) buf.push(decoded[j])
        const globalEnd = buf.length
        buf.push(CharCode.LF)
        subStreams.push({ stream, globalStart, globalEnd })
        if (!primary) primary = stream
      }
      if (!primary) return null
      return {
        bytes: new Uint8Array(buf),
        subStreams,
        isCompressed: true,
        stream: primary,
      }
    }

    // Single stream.
    const stream = resolved as PDFRawStream
    if (!stream || !('getContents' in stream)) return null
    const filterVal = stream.dict?.get(PDFName.of('Filter'))
    const raw = stream.getContents()
    const bytes = decodeStream(raw, filterVal)
    const isCompressed = filterNames(filterVal).length > 0
    return {
      bytes,
      isCompressed,
      stream,
      subStreams: [{ stream, globalStart: 0, globalEnd: bytes.length }],
    }
  } catch (err) {
    console.warn('[contentStreamParser] getPageContentLayout failed:', err)
    return null
  }
}

/** Apply non-overlapping byte-range replacements to a buffer. Sorts
 *  patches by start and splices; returns a new Uint8Array. */
function applyPatchesToBuffer(
  original: Uint8Array,
  patches: Array<{ start: number; end: number; replacement: Uint8Array }>,
): Uint8Array {
  const sorted = [...patches].sort((a, b) => a.start - b.start)
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) {
      throw new Error(
        `overlapping patches at ${sorted[i - 1].end} vs ${sorted[i].start}`,
      )
    }
  }
  const chunks: Uint8Array[] = []
  let cursor = 0
  for (const p of sorted) {
    if (p.start > cursor) chunks.push(original.slice(cursor, p.start))
    chunks.push(p.replacement)
    cursor = p.end
  }
  if (cursor < original.length) chunks.push(original.slice(cursor))
  const total = chunks.reduce((s, c) => s + c.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

/**
 * Apply byte-range patches to a page's content streams IN PLACE,
 * preserving the Contents array structure. This is the surgical
 * alternative to replacePageContents — only the bytes that belong to
 * the patched operators change; every other byte (including filled-
 * rectangle ops, ExtGState references, and other sub-streams) stays
 * identical to the original.
 *
 * `patches[].start/end` are offsets into `layout.bytes` (the
 * concatenated decoded view). This function groups them by sub-stream
 * and rewrites each affected sub-stream independently.
 *
 * Assumption: no patch crosses a sub-stream boundary. Content-stream
 * operators (Tj, TJ, drawText, etc.) are always emitted into a single
 * stream, so this holds in practice for anything the editor produces.
 */
export function patchPageContentStreams(
  layout: PageContentLayout,
  patches: Array<{ start: number; end: number; replacement: Uint8Array }>,
): void {
  for (const sub of layout.subStreams) {
    const subPatches = patches
      .filter((p) => p.start >= sub.globalStart && p.end <= sub.globalEnd)
      .map((p) => ({
        start: p.start - sub.globalStart,
        end: p.end - sub.globalStart,
        replacement: p.replacement,
      }))
    if (subPatches.length === 0) continue
    const original = layout.bytes.slice(sub.globalStart, sub.globalEnd)
    const patched = applyPatchesToBuffer(original, subPatches)
    writePageContentBytes(sub.stream, patched, true)
  }
}

/**
 * Replace a page's entire Contents with a single new flate-compressed
 * stream.
 *
 * LEGACY — prefer `patchPageContentStreams` via `getPageContentLayout`
 * for new code. replacePageContents flattens the Contents array into
 * one stream; this is observably unsafe on some PDFs (see FINDINGS.md
 * #2 — filled rectangles rendered as small fragments after the
 * restructure). Kept for migration of older callers.
 */
export function replacePageContents(
  pdfDoc: PDFDocument,
  pageIndex: number,
  newBytes: Uint8Array,
): void {
  const page = pdfDoc.getPage(pageIndex)
  const compressed = pako.deflate(newBytes)
  // Register a fresh stream in the indirect object table.
  const dict = pdfDoc.context.obj({
    Length: compressed.length,
    Filter: 'FlateDecode',
  })
  const newStream = (PDFRawStream as unknown as {
    of: (d: unknown, b: Uint8Array) => PDFRawStream
  }).of(dict as unknown as object, compressed)
  const ref = pdfDoc.context.register(newStream)
  page.node.set(PDFName.of('Contents'), ref)
}

/** Write modified content stream bytes back to the page (legacy path;
 *  single-stream only, does NOT handle PDFArray-backed content). */
export function writePageContentBytes(
  stream: PDFRawStream,
  newBytes: Uint8Array,
  compress: boolean = true
): void {
  if (compress) {
    const compressed = pako.deflate(newBytes)
    // pdf-lib's PDFRawStream.contents is typed readonly in newer releases;
    // the field is still mutable at runtime, so we cast.
    ;(stream as unknown as { contents: Uint8Array }).contents = compressed
    stream.dict.set(PDFName.of('Length'), PDFNumber.of(compressed.length))
    stream.dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'))
  } else {
    ;(stream as unknown as { contents: Uint8Array }).contents = newBytes
    stream.dict.set(PDFName.of('Length'), PDFNumber.of(newBytes.length))
    stream.dict.delete(PDFName.of('Filter'))
  }
}

// ── Utilities ──────────────────────────────────────────────────────

/** Best-effort decode of PDF string bytes to Unicode */
function decodePdfBytes(bytes: Uint8Array): string {
  // Try UTF-16BE if starts with BOM
  if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
    let result = ''
    for (let i = 2; i < bytes.length - 1; i += 2) {
      result += String.fromCharCode((bytes[i] << 8) | bytes[i + 1])
    }
    return result
  }
  // Try UTF-8 first
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return decoded
  } catch {
    // Fall back to Latin-1 (covers PDFDocEncoding for most chars)
    return Array.from(bytes, b => String.fromCharCode(b)).join('')
  }
}

/** Encode a Unicode string to PDF string bytes (Latin-1 or UTF-16BE) */
export function encodeTextToBytes(text: string): Uint8Array {
  // Check if Latin-1 is sufficient
  let isLatin1 = true
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0xFF) { isLatin1 = false; break }
  }
  if (isLatin1) {
    const bytes = new Uint8Array(text.length)
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i)
    return bytes
  }
  // UTF-16BE with BOM
  const bytes = new Uint8Array(2 + text.length * 2)
  bytes[0] = 0xFE; bytes[1] = 0xFF
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    bytes[2 + i * 2] = (code >> 8) & 0xFF
    bytes[2 + i * 2 + 1] = code & 0xFF
  }
  return bytes
}
