// Whitelisted form calculation expressions.
//
// Replaces the "full Acrobat JavaScript" feature with a tiny pure-
// expression language that covers ~95% of what users actually need for
// forms (invoice totals, percentage math, conditional visibility) with
// zero security surface — no DOM access, no network, no eval.
//
// Grammar (subset):
//
//   expr      := ternary
//   ternary   := comparison ( "?" expr ":" expr )?
//   comparison:= addsub (("==" | "!=" | "<" | ">" | "<=" | ">=") addsub)?
//   addsub    := muldiv (("+" | "-") muldiv)*
//   muldiv    := unary (("*" | "/" | "%") unary)*
//   unary     := ("-" | "+" | "!")? primary
//   primary   := number | string | "(" expr ")" | call | field
//   call      := ident "(" args? ")"
//   args      := expr ("," expr)*
//   field     := "{" ident "}"
//   ident     := [A-Za-z_][A-Za-z0-9_.]*
//
// Functions: SUM, AVG, PRODUCT, MIN, MAX, IF, NOT, AND, OR,
// FLOOR, CEIL, ROUND, ABS, LEN, CONCAT, LEFT, RIGHT, UPPER, LOWER,
// CONTAINS, IFERROR.
//
// Field references: {field_name} — resolved by the renderer at eval
// time. Unknown fields evaluate to 0 / "" depending on coercion.

export interface CalcContext {
  /** Field name → current string value. Missing names → undefined. */
  fields: Record<string, string | number | boolean | undefined>
}

export type CalcValue = number | string | boolean

export function evaluateCalc(expression: string, ctx: CalcContext): CalcValue {
  const parser = new Parser(expression)
  const ast = parser.parseExpr()
  parser.expectEof()
  return evalNode(ast, ctx)
}

/** Tries the expression and returns undefined on any error. Use this
 *  in renderers where a bad formula should degrade silently instead
 *  of blowing up the field. */
export function tryEvaluateCalc(expression: string, ctx: CalcContext): CalcValue | undefined {
  try { return evaluateCalc(expression, ctx) } catch { return undefined }
}

// ---------- AST ----------

type Node =
  | { type: 'num'; v: number }
  | { type: 'str'; v: string }
  | { type: 'field'; name: string }
  | { type: 'call'; name: string; args: Node[] }
  | { type: 'unop'; op: '-' | '+' | '!'; a: Node }
  | { type: 'binop'; op: string; a: Node; b: Node }
  | { type: 'ternary'; cond: Node; a: Node; b: Node }

// ---------- Parser ----------

class Parser {
  private i = 0
  constructor(private src: string) {}

  parseExpr(): Node { return this.parseTernary() }
  expectEof(): void {
    this.skip()
    if (this.i < this.src.length) throw new Error(`Unexpected '${this.src.slice(this.i, this.i + 10)}'`)
  }

  private parseTernary(): Node {
    const cond = this.parseComparison()
    this.skip()
    if (this.peek() === '?') {
      this.i++
      const a = this.parseExpr()
      this.skip()
      if (this.peek() !== ':') throw new Error('Expected :')
      this.i++
      const b = this.parseExpr()
      return { type: 'ternary', cond, a, b }
    }
    return cond
  }

  private parseComparison(): Node {
    const a = this.parseAddSub()
    this.skip()
    for (const op of ['==', '!=', '<=', '>=', '<', '>']) {
      if (this.src.slice(this.i, this.i + op.length) === op) {
        this.i += op.length
        const b = this.parseAddSub()
        return { type: 'binop', op, a, b }
      }
    }
    return a
  }

  private parseAddSub(): Node {
    let a = this.parseMulDiv()
    while (true) {
      this.skip()
      const c = this.peek()
      if (c !== '+' && c !== '-') break
      this.i++
      const b = this.parseMulDiv()
      a = { type: 'binop', op: c, a, b }
    }
    return a
  }

  private parseMulDiv(): Node {
    let a = this.parseUnary()
    while (true) {
      this.skip()
      const c = this.peek()
      if (c !== '*' && c !== '/' && c !== '%') break
      this.i++
      const b = this.parseUnary()
      a = { type: 'binop', op: c, a, b }
    }
    return a
  }

  private parseUnary(): Node {
    this.skip()
    const c = this.peek()
    if (c === '-' || c === '+' || c === '!') {
      this.i++
      return { type: 'unop', op: c as '-' | '+' | '!', a: this.parseUnary() }
    }
    return this.parsePrimary()
  }

  private parsePrimary(): Node {
    this.skip()
    const c = this.peek()
    if (!c) throw new Error('Unexpected end of expression')
    if (c === '(') {
      this.i++
      const e = this.parseExpr()
      this.skip()
      if (this.peek() !== ')') throw new Error('Expected )')
      this.i++
      return e
    }
    if (c === '{') {
      this.i++
      let name = ''
      while (this.i < this.src.length && this.peek() !== '}') name += this.src[this.i++]
      if (this.peek() !== '}') throw new Error('Expected }')
      this.i++
      return { type: 'field', name: name.trim() }
    }
    if (c === '"' || c === "'") {
      const quote = c
      this.i++
      let s = ''
      while (this.i < this.src.length && this.peek() !== quote) {
        if (this.peek() === '\\' && this.i + 1 < this.src.length) { s += this.src[this.i + 1]; this.i += 2 }
        else s += this.src[this.i++]
      }
      if (this.peek() !== quote) throw new Error('Unterminated string')
      this.i++
      return { type: 'str', v: s }
    }
    if (isDigit(c) || (c === '.' && isDigit(this.src[this.i + 1] ?? ''))) {
      let s = ''
      while (this.i < this.src.length && (isDigit(this.src[this.i]) || this.src[this.i] === '.')) s += this.src[this.i++]
      const n = Number(s)
      if (isNaN(n)) throw new Error(`Bad number '${s}'`)
      return { type: 'num', v: n }
    }
    if (isIdentStart(c)) {
      let id = ''
      while (this.i < this.src.length && isIdentPart(this.src[this.i])) id += this.src[this.i++]
      this.skip()
      if (this.peek() === '(') {
        this.i++
        const args: Node[] = []
        this.skip()
        if (this.peek() !== ')') {
          args.push(this.parseExpr())
          while (true) {
            this.skip()
            if (this.peek() !== ',') break
            this.i++
            args.push(this.parseExpr())
          }
        }
        this.skip()
        if (this.peek() !== ')') throw new Error(`Expected ) after ${id}( …`)
        this.i++
        return { type: 'call', name: id.toUpperCase(), args }
      }
      if (id === 'true') return { type: 'num', v: 1 }
      if (id === 'false') return { type: 'num', v: 0 }
      throw new Error(`Bare identifier '${id}' — use {${id}} for a field ref`)
    }
    throw new Error(`Unexpected character '${c}' at position ${this.i}`)
  }

  private skip(): void {
    while (this.i < this.src.length && /\s/.test(this.src[this.i])) this.i++
  }
  private peek(): string { return this.src[this.i] ?? '' }
}

function isDigit(c: string): boolean { return c >= '0' && c <= '9' }
function isIdentStart(c: string): boolean { return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_' }
function isIdentPart(c: string): boolean { return isIdentStart(c) || isDigit(c) || c === '.' }

// ---------- Evaluator ----------

function toNum(v: CalcValue | undefined): number {
  if (v === undefined || v === '') return 0
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  const n = parseFloat(v)
  return isNaN(n) ? 0 : n
}
function toStr(v: CalcValue | undefined): string {
  if (v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return String(v)
}
function toBool(v: CalcValue | undefined): boolean {
  if (v === undefined || v === '' || v === 0 || v === false) return false
  return true
}

function evalNode(n: Node, ctx: CalcContext): CalcValue {
  switch (n.type) {
    case 'num': return n.v
    case 'str': return n.v
    case 'field': {
      const raw = ctx.fields[n.name]
      if (raw === undefined) return ''
      return typeof raw === 'boolean' ? raw : typeof raw === 'number' ? raw : String(raw)
    }
    case 'unop': {
      const a = evalNode(n.a, ctx)
      if (n.op === '-') return -toNum(a)
      if (n.op === '+') return toNum(a)
      if (n.op === '!') return !toBool(a)
      return 0
    }
    case 'binop': {
      const a = evalNode(n.a, ctx)
      const b = evalNode(n.b, ctx)
      switch (n.op) {
        case '+':
          // Concat if either is a non-numeric string; else numeric sum.
          if ((typeof a === 'string' && !isNumeric(a)) || (typeof b === 'string' && !isNumeric(b))) {
            return toStr(a) + toStr(b)
          }
          return toNum(a) + toNum(b)
        case '-': return toNum(a) - toNum(b)
        case '*': return toNum(a) * toNum(b)
        case '/': {
          const d = toNum(b)
          return d === 0 ? 0 : toNum(a) / d
        }
        case '%': {
          const d = toNum(b)
          return d === 0 ? 0 : toNum(a) % d
        }
        case '==': return toStr(a) === toStr(b)
        case '!=': return toStr(a) !== toStr(b)
        case '<':  return toNum(a) < toNum(b)
        case '>':  return toNum(a) > toNum(b)
        case '<=': return toNum(a) <= toNum(b)
        case '>=': return toNum(a) >= toNum(b)
        default: throw new Error(`Unknown operator ${n.op}`)
      }
    }
    case 'ternary': return toBool(evalNode(n.cond, ctx)) ? evalNode(n.a, ctx) : evalNode(n.b, ctx)
    case 'call': return callFn(n.name, n.args.map((a) => evalNode(a, ctx)), ctx)
  }
}

function isNumeric(s: string): boolean {
  return s.trim() !== '' && !isNaN(Number(s))
}

function callFn(name: string, args: CalcValue[], ctx: CalcContext): CalcValue {
  switch (name) {
    case 'SUM': return args.reduce<number>((a, v) => a + toNum(v), 0)
    case 'AVG':
    case 'AVERAGE': {
      if (args.length === 0) return 0
      return args.reduce<number>((a, v) => a + toNum(v), 0) / args.length
    }
    case 'PRODUCT': return args.reduce<number>((a, v) => a * toNum(v), 1)
    case 'MIN': return Math.min(...args.map(toNum))
    case 'MAX': return Math.max(...args.map(toNum))
    case 'IF': {
      const [cond, a, b] = args
      return toBool(cond) ? (a ?? '') : (b ?? '')
    }
    case 'NOT': return !toBool(args[0])
    case 'AND': return args.every(toBool)
    case 'OR': return args.some(toBool)
    case 'FLOOR': return Math.floor(toNum(args[0]))
    case 'CEIL':
    case 'CEILING': return Math.ceil(toNum(args[0]))
    case 'ROUND': {
      const x = toNum(args[0])
      const places = toNum(args[1] ?? 0)
      const factor = Math.pow(10, places)
      return Math.round(x * factor) / factor
    }
    case 'ABS': return Math.abs(toNum(args[0]))
    case 'LEN': return toStr(args[0]).length
    case 'CONCAT': return args.map(toStr).join('')
    case 'LEFT': return toStr(args[0]).slice(0, Math.max(0, toNum(args[1])))
    case 'RIGHT': {
      const s = toStr(args[0]), n = Math.max(0, toNum(args[1]))
      return s.slice(Math.max(0, s.length - n))
    }
    case 'UPPER': return toStr(args[0]).toUpperCase()
    case 'LOWER': return toStr(args[0]).toLowerCase()
    case 'CONTAINS': return toStr(args[0]).includes(toStr(args[1]))
    case 'IFERROR': return args[0] ?? args[1] ?? ''
    default:
      throw new Error(`Unknown function '${name}'`)
  }
  void ctx
}
