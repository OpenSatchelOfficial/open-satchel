// PDF /StructTreeRoot writer — install or extend the structure tree
// for PDF/UA + Section 508 compliance.
//
// Hand-rolled because pd-lib has no helpers for /StructTreeRoot (it's
// not a v1.x API surface). We mutate `PDFDocument.context` directly to
// register `/Type /StructTreeRoot`, /K root, /ParentTree, plus child
// /StructElem objects.
//
// Marked-content strategy (v1):
//   We use page-level association — each /StructElem references /Pg
//   (the page) and uses /K = page object ref or a numeric MCID we
//   synthesize ONLY for new content we add (alt-text figures,
//   /ActualText overrides). For existing content streams we do NOT
//   rewrite text operators (BDC/EMC).
//
//   Practical result: PAC 3 issues a *warning* about the missing
//   marked-content links but does not hard-fail tagging structure
//   rules. The tree is real, screen readers can walk it. Strict
//   PDF/UA conformance with full marked-content is v1.1 work
//   (rewriting every Tj/TJ in pd-lib without an AST emitter is brittle).
//
// Minimum spec dump (PDF/UA-1):
//
//   Catalog adds:
//     /MarkInfo   << /Marked true >>
//     /Lang       (en-US)
//     /ViewerPreferences << /DisplayDocTitle true >>
//     /StructTreeRoot << /Type /StructTreeRoot
//                       /K <Document StructElem ref>
//                       /ParentTree << /Nums [] >> >>
//
//   StructElem (each):
//     << /Type /StructElem
//        /S /Document | /P | /H1 | /H2 | /H3 | /Figure | /Artifact | /L | /LI | …
//        /P <parent ref>
//        /Pg <page ref>            (for page-leaf elems)
//        /K <int|array|child ref>  (children — int = MCID we authored)
//        /Alt (alt text)            (for /Figure)
//        /T   (title)               (optional — human-readable label)
//     >>

import {
  PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFNumber,
  PDFString, PDFHexString, PDFRawStream,
} from 'pdf-lib'
import { buildBasicXmp } from './pdfAXmp'
import {
  parseContentStream, getPageContentBytes, replacePageContents,
  type ContentStreamOp,
} from './contentStreamParser'

/**
 * Standard PDF tag types (PDF 2.0 standard structure roles).
 * Anything outside this set should go through /RoleMap.
 */
export const STANDARD_ROLES = [
  'Document', 'Part', 'Sect', 'Div', 'Span', 'Quote',
  'P', 'H', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'L', 'LI', 'Lbl', 'LBody',
  'Table', 'TR', 'TH', 'TD', 'THead', 'TBody', 'TFoot',
  'Caption', 'Figure', 'Formula', 'Form',
  'Link', 'Reference', 'Note', 'BibEntry',
  'Code', 'Annot',
  'Artifact',
] as const

export type StandardRole = typeof STANDARD_ROLES[number]

export interface StructElemSpec {
  /** PDF tag type (S entry). Use STANDARD_ROLES or add via roleMap. */
  S: string
  /** Page index (0-based) the elem refers to. -1 for non-page elems. */
  pageIndex?: number
  /** Children (recursive). */
  children?: StructElemSpec[]
  /** Alt text — required for /Figure to be PDF/UA-compliant. */
  Alt?: string
  /** ActualText — overrides what screen readers announce. */
  ActualText?: string
  /** Per-element language (overrides catalog /Lang). */
  Lang?: string
  /** Title — human-readable label, NOT presented to assistive tech. */
  T?: string
  /** BBox for the element in page coordinates [x1,y1,x2,y2]. */
  BBox?: [number, number, number, number]
  /** XObject ref name (for /Figure entries that wrap a specific image). */
  xObjectName?: string
}

export interface StructTreeSpec {
  /** Document language (BCP 47 code, e.g. "en-US"). */
  lang?: string
  /** Document title (also written to PDF metadata if not set). */
  title?: string
  /** Root tag type — almost always /Document. */
  rootType?: StandardRole
  /** The structure tree itself. */
  children: StructElemSpec[]
}

/**
 * Install or replace the entire /StructTreeRoot with the given spec.
 * Sets /MarkInfo /Marked true and /Lang on catalog.
 *
 * Idempotent on re-run — replaces the existing tree wholesale rather
 * than merging. Callers that want to preserve existing tags should
 * read the tree first, mutate, then pass the result here.
 */
export async function installStructTree(
  bytes: Uint8Array,
  spec: StructTreeSpec,
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes)
  const ctx = doc.context

  // 1. Set /Lang on catalog (BCP 47 tag).
  const lang = spec.lang ?? 'en-US'
  doc.catalog.set(PDFName.of('Lang'), PDFString.of(lang))

  // 2. Set /MarkInfo /Marked true (assistive-tech consumers key on this).
  const markInfo = ctx.obj({ Marked: true })
  doc.catalog.set(PDFName.of('MarkInfo'), markInfo)

  // 3. Set /ViewerPreferences /DisplayDocTitle true so reader uses
  //    the metadata title rather than the filename. PDF/UA requires
  //    this when a title is set.
  let viewerPrefsRef = doc.catalog.get(PDFName.of('ViewerPreferences'))
  let viewerPrefs: PDFDict | undefined
  if (viewerPrefsRef) {
    viewerPrefs = ctx.lookup(viewerPrefsRef) as PDFDict | undefined
  }
  if (!viewerPrefs) {
    viewerPrefs = PDFDict.withContext(ctx)
    const ref = ctx.register(viewerPrefs)
    doc.catalog.set(PDFName.of('ViewerPreferences'), ref)
  }
  viewerPrefs.set(PDFName.of('DisplayDocTitle'), ctx.obj(true) as any)

  // 4. Optional title — written to the DocInfo /Title AND overrides
  //    any prior value (including pd-lib's "untitled" / "anonymous"
  //    placeholders). Viewers like Foxit / Adobe / Preview read
  //    docinfo /Title for their tab labels + Accessibility property
  //    reports; leaving a placeholder there produces an "untitled"
  //    tab even when the XMP dc:title is correct. PDF/UA §7.1 also
  //    wants a non-empty title alongside /ViewerPreferences
  //    /DisplayDocTitle=true (set below).
  if (spec.title) {
    doc.setTitle(spec.title)
  }

  // 5. Build the structure tree. We register a placeholder
  //    StructTreeRoot first so child /P (parent) refs can point
  //    to it before the root dict is fully built.
  const rootDict = PDFDict.withContext(ctx)
  rootDict.set(PDFName.of('Type'), PDFName.of('StructTreeRoot'))
  const rootRef = ctx.register(rootDict)

  // Top-level Document element.
  const rootType = spec.rootType ?? 'Document'
  const docElem = PDFDict.withContext(ctx)
  docElem.set(PDFName.of('Type'), PDFName.of('StructElem'))
  docElem.set(PDFName.of('S'), PDFName.of(rootType))
  docElem.set(PDFName.of('P'), rootRef)
  const docRef = ctx.register(docElem)

  // Recursively materialize children.
  const childRefs: PDFRef[] = []
  for (const childSpec of spec.children) {
    const ref = materializeElem(doc, childSpec, docRef)
    childRefs.push(ref)
  }
  if (childRefs.length > 0) {
    docElem.set(PDFName.of('K'), ctx.obj(childRefs) as any)
  }

  // ParentTree — number tree mapping MCIDs back to struct elems.
  // Empty in v1 since we don't author MCID associations for existing
  // content. PAC 3 wants this dict present even if empty.
  const parentTree = ctx.obj({ Nums: ctx.obj([]) as any })
  rootDict.set(PDFName.of('ParentTree'), parentTree)
  rootDict.set(PDFName.of('K'), docRef)

  // 6. Wire StructTreeRoot into catalog.
  doc.catalog.set(PDFName.of('StructTreeRoot'), rootRef)

  // 7. Set /Tabs /S on every page — PDF/UA requires structure-based
  //    tab order so screen readers traverse fields in tag-tree order
  //    rather than insertion order.
  for (let i = 0; i < doc.getPageCount(); i++) {
    const page = doc.getPage(i)
    page.node.set(PDFName.of('Tabs'), PDFName.of('S'))
  }

  // 7b. Marked-content wrap.
  //     PDF/UA §7.1 test 3 ("content shall be marked as Artifact or
  //     tagged as real content") requires every drawable operator to
  //     live inside a BDC/EMC pair.
  //
  //     Strategy: per page, walk the content stream and wrap
  //       - text ops (Tj/TJ/'/") in /P <</MCID N>> BDC ... EMC
  //       - painting + image ops in /Artifact BDC ... EMC
  //     For each page that produced text MCIDs, register a synthetic
  //     /P StructElem whose /K = [0, 1, ..., N-1] and /Pg = that page.
  //     These synthetic elems become children of docElem alongside any
  //     user-provided spec elements. /ParentTree + /StructParents are
  //     populated so veraPDF can resolve MCID → struct-elem lookups.
  await wrapContentStreamsWithMarkedContent(doc, docRef, docElem, rootDict, childRefs)

  // 8. Write an XMP metadata stream to the catalog.
  //    PDF/UA §7.1 test 8 requires /Catalog to have a /Metadata key
  //    pointing at an XMP stream. veraPDF fails without it even when
  //    the struct tree is otherwise valid.
  if (!doc.catalog.get(PDFName.of('Metadata'))) {
    const xmp = buildBasicXmp({
      title: spec.title || doc.getTitle() || undefined,
      creator: 'Open Satchel',
      producer: 'Open Satchel',
    }, { pdfUa1: true })
    const xmpBytes = new TextEncoder().encode(xmp)
    const xmpDict = ctx.obj({
      Type: PDFName.of('Metadata'),
      Subtype: PDFName.of('XML'),
      Length: xmpBytes.length,
    })
    const xmpStream = PDFRawStream.of(xmpDict, xmpBytes)
    const xmpRef = ctx.register(xmpStream)
    doc.catalog.set(PDFName.of('Metadata'), xmpRef)
  }

  return new Uint8Array(await doc.save())
}

/**
 * Walk every page's content stream and wrap every drawable operator
 * in a BDC/EMC marked-content pair. Text ops (Tj/TJ/'/") get a
 * tagged /P with a sequential MCID; painting + image ops get
 * /Artifact (decorative, not in reading order).
 *
 * For each page that produced text MCIDs, register a synthetic /P
 * StructElem under docElem whose /K references the page's MCIDs
 * and whose /Pg is the page. This keeps the tagged content reachable
 * from the struct tree, which is what screen readers walk.
 *
 * Populates rootDict /ParentTree (Nums map of /StructParents → array
 * of struct-elem refs indexed by MCID) and each page's
 * /StructParents integer.
 *
 * Required by PDF/UA-1 §7.1 test 3 ("content shall be marked as
 * Artifact or tagged as real content") + the parent-tree consistency
 * rules that depend on it.
 */
async function wrapContentStreamsWithMarkedContent(
  doc: PDFDocument,
  docRef: PDFRef,
  docElem: PDFDict,
  rootDict: PDFDict,
  existingChildRefs: PDFRef[],
): Promise<void> {
  const ctx = doc.context
  // Accumulate /ParentTree entries: alternating (structParents, refsArray)
  const parentTreeNums: Array<PDFNumber | PDFArray> = []
  const addedPageElems: PDFRef[] = []

  // Text-show operators (PDF 1.7 §9.4.3). '"' and "'" are move-to-
  // next-line variants.
  const TEXT_OPS = new Set(['Tj', 'TJ', "'", '"'])
  // Drawing-related ops that veraPDF counts as "content" for the
  // PDF/UA §7.1 test 3 wrap rule. Path construction (m/l/c/v/y/h/re),
  // clipping (W/W*), path painting (S/s/f/F/f*/B/B*/b/b*/n), images
  // (Do), shading (sh). Wrapping each individually as /Artifact keeps
  // the semantics simple — nothing painted on the page participates
  // in the accessible reading order unless it's a text op.
  const PAINT_OPS = new Set([
    'm', 'l', 'c', 'v', 'y', 'h', 're',
    'S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n',
    'W', 'W*',
    'Do', 'sh',
  ])

  // Operators that appear inside BT/ET — text-state setters. These
  // produce no output but are often sandwiched between a /P BDC and
  // the Tj they precede; we want them OUTSIDE the /P wrap so the
  // wrap contains exactly one content-producing op.
  const TEXT_STATE_OPS = new Set([
    'Tc', 'Tw', 'Tz', 'TL', 'Tf', 'Tr', 'Ts',
    'Td', 'TD', 'Tm', 'T*',
    'BT', 'ET',
  ])

  for (let pageIdx = 0; pageIdx < doc.getPageCount(); pageIdx++) {
    const info = getPageContentBytes(doc, pageIdx)
    if (!info || info.bytes.length === 0) continue

    const parsed = parseContentStream(info.bytes)
    const ops = parsed.operators

    // Pre-scan: for each BT at index i, find its matching ET and
    // record whether any text-show op lives in between. Empty BT/ET
    // blocks (state-only) are tagged so we can wrap the whole block
    // as /Artifact — they still count as "content" to veraPDF
    // otherwise, and the wrap satisfies §7.1 test 3.
    const btHasText = new Array<boolean>(ops.length).fill(false)
    const btEndIdx = new Array<number>(ops.length).fill(-1)
    const btStartIdxOfEt = new Array<number>(ops.length).fill(-1)
    for (let i = 0; i < ops.length; i++) {
      if (ops[i].operator !== 'BT') continue
      let hasText = false
      let j = i + 1
      for (; j < ops.length; j++) {
        if (ops[j].operator === 'ET') break
        if (TEXT_OPS.has(ops[j].operator)) hasText = true
      }
      btHasText[i] = hasText
      btEndIdx[i] = j
      if (j < ops.length) btStartIdxOfEt[j] = i
    }

    // Strategy: wrap each text-show op individually in /P with an MCID
    // (tagged content, reachable via struct tree). Everything else —
    // state ops, path construction + painting, images — wraps in
    // /Artifact <</Type/Pagination>> BDC … EMC (decorative, not in
    // reading order). /P and /Artifact are SIBLINGS, never nested
    // (PDF 14289-1 §7.1 forbids real content inside an artifact).
    //
    // PDF spec requires /Artifact to have a property list (or inline
    // property dict) when used as a marked-content tag — a bare
    // `/Artifact BDC` is legal per PDF 32000-1 but some validators
    // (and PDF/UA itself) expect `/Artifact <<…>> BDC` at minimum.
    const ARTIFACT_BDC = '/Artifact <</Type/Pagination>> BDC\n'

    const chunks: Uint8Array[] = []
    const emit = (s: string) => chunks.push(new TextEncoder().encode(s))
    const emitOp = (op: ContentStreamOp) => {
      chunks.push(info.bytes.slice(op.byteOffset, op.byteOffset + op.byteLength))
      emit('\n')
    }

    let mcid = 0
    let wrappedAny = false
    let inArtifact = false
    const openArt = () => { if (!inArtifact) { emit(ARTIFACT_BDC); inArtifact = true } }
    const closeArt = () => { if (inArtifact) { emit('EMC\n'); inArtifact = false } }

    for (let i = 0; i < ops.length; i++) {
      const op = ops[i]
      // NOTE: do NOT drop `n` here. Despite the name "no-op end-path",
      // `n` is a path-painting op: it terminates the current path
      // WITHOUT filling/stroking, which is exactly what commits a
      // pending W/W* clipping operator. Dropping it leaves the
      // construction-state path open, so the next `re … f*` call
      // unions the previous (full-page-clip) rect into the new
      // path and `f*` fills the entire page black [V2 P0 #1].

      if (op.operator === 'BT') {
        const endIdx = btEndIdx[i]
        const hasText = btHasText[i]
        closeArt()
        if (hasText) {
          // BT stays outside /P. Each Tj inside gets its own /P BDC.
          emitOp(ops[i])
          for (let j = i + 1; j < endIdx; j++) {
            if (TEXT_OPS.has(ops[j].operator)) {
              emit(`/P <</MCID ${mcid}>> BDC\n`)
              emitOp(ops[j])
              emit('EMC\n')
              mcid++
              wrappedAny = true
            } else {
              emitOp(ops[j])
            }
          }
          if (endIdx < ops.length) emitOp(ops[endIdx])
        } else {
          // State-only BT/ET — wrap as artifact (dropping BT/ET per se).
          openArt()
          for (let j = i + 1; j < endIdx; j++) emitOp(ops[j])
          closeArt()
          wrappedAny = true
        }
        i = endIdx
        continue
      }

      if (TEXT_OPS.has(op.operator)) {
        // Stray text-show outside BT/ET — rare/malformed.
        closeArt()
        emit(`/P <</MCID ${mcid}>> BDC\n`)
        emitOp(op)
        emit('EMC\n')
        mcid++
        wrappedAny = true
        continue
      }

      // Any other op (state, path, paint, Do, sh): accumulate inside
      // a running /Artifact block.
      openArt()
      emitOp(op)
      wrappedAny = true
    }
    closeArt()

    if (!wrappedAny) continue

    const total = chunks.reduce((s, c) => s + c.length, 0)
    const out = new Uint8Array(total)
    let ofs = 0
    for (const c of chunks) { out.set(c, ofs); ofs += c.length }
    replacePageContents(doc, pageIdx, out)

    // Build parent-tree entry for this page's text MCIDs.
    if (mcid > 0) {
      const pageElem = PDFDict.withContext(ctx)
      pageElem.set(PDFName.of('Type'), PDFName.of('StructElem'))
      pageElem.set(PDFName.of('S'), PDFName.of('P'))
      pageElem.set(PDFName.of('P'), docRef)
      pageElem.set(PDFName.of('Pg'), doc.getPage(pageIdx).ref)
      const kArr: PDFNumber[] = []
      for (let m = 0; m < mcid; m++) kArr.push(PDFNumber.of(m))
      pageElem.set(PDFName.of('K'), ctx.obj(kArr) as unknown as PDFArray)
      const pageElemRef = ctx.register(pageElem)
      addedPageElems.push(pageElemRef)

      // /ParentTree entry: each MCID on this page → pageElemRef
      const ownersArr: PDFRef[] = []
      for (let m = 0; m < mcid; m++) ownersArr.push(pageElemRef)
      const structParents = parentTreeNums.length / 2
      doc.getPage(pageIdx).node.set(PDFName.of('StructParents'), PDFNumber.of(structParents))
      parentTreeNums.push(PDFNumber.of(structParents))
      parentTreeNums.push(ctx.obj(ownersArr) as unknown as PDFArray)
    }
  }

  // Append the synthetic page elems to docElem /K so they live
  // inside the struct tree. Combine with the user's existing children.
  if (addedPageElems.length > 0) {
    const merged: PDFRef[] = [...existingChildRefs, ...addedPageElems]
    docElem.set(PDFName.of('K'), ctx.obj(merged) as unknown as PDFArray)
  }

  // Install /ParentTree on the StructTreeRoot. Replaces the earlier
  // empty placeholder.
  const parentTreeDict = ctx.obj({
    Nums: ctx.obj(parentTreeNums) as unknown as PDFArray,
  })
  rootDict.set(PDFName.of('ParentTree'), parentTreeDict)
  // PDF spec: /ParentTreeNextKey is the next available structParents
  // int — veraPDF uses it to verify no collisions.
  rootDict.set(PDFName.of('ParentTreeNextKey'), PDFNumber.of(parentTreeNums.length / 2))
}

/**
 * Recursively materialize a StructElemSpec into PDFDict objects,
 * registering each as an indirect object. Returns the ref to the
 * created element.
 */
function materializeElem(doc: PDFDocument, spec: StructElemSpec, parent: PDFRef): PDFRef {
  const ctx = doc.context
  const elem = PDFDict.withContext(ctx)
  elem.set(PDFName.of('Type'), PDFName.of('StructElem'))
  elem.set(PDFName.of('S'), PDFName.of(spec.S))
  elem.set(PDFName.of('P'), parent)

  if (spec.pageIndex !== undefined && spec.pageIndex >= 0 && spec.pageIndex < doc.getPageCount()) {
    const page = doc.getPage(spec.pageIndex)
    elem.set(PDFName.of('Pg'), page.ref)
  }
  if (spec.Alt !== undefined) elem.set(PDFName.of('Alt'), PDFString.of(spec.Alt))
  if (spec.ActualText !== undefined) elem.set(PDFName.of('ActualText'), PDFString.of(spec.ActualText))
  if (spec.Lang) elem.set(PDFName.of('Lang'), PDFString.of(spec.Lang))
  if (spec.T) elem.set(PDFName.of('T'), PDFString.of(spec.T))
  if (spec.BBox) {
    const a = ctx.obj(spec.BBox.map(n => PDFNumber.of(n))) as any
    // Attribute object — wrap in /A array per PDF spec
    const attrDict = ctx.obj({ O: PDFName.of('Layout'), BBox: a })
    elem.set(PDFName.of('A'), ctx.obj([attrDict]) as any)
  }

  const elemRef = ctx.register(elem)

  // Children
  if (spec.children && spec.children.length > 0) {
    const childRefs = spec.children.map(c => materializeElem(doc, c, elemRef))
    elem.set(PDFName.of('K'), ctx.obj(childRefs) as any)
  }

  return elemRef
}

/**
 * Add a single /Lang attribute on the catalog. Lighter-weight than
 * installStructTree when you just want to set the document language
 * without rebuilding the tree.
 */
export async function setDocumentLang(bytes: Uint8Array, lang: string): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes)
  doc.catalog.set(PDFName.of('Lang'), PDFString.of(lang))
  return new Uint8Array(await doc.save())
}

/**
 * Read or set MarkInfo /Marked. PDF/UA requires Marked=true.
 */
export async function setMarkInfoMarked(bytes: Uint8Array, marked = true): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes)
  const mi = doc.context.obj({ Marked: marked })
  doc.catalog.set(PDFName.of('MarkInfo'), mi)
  return new Uint8Array(await doc.save())
}

/**
 * Update the /Alt attribute on the Nth /Figure StructElem (by
 * document order from a depth-first walk). Used by the alt-text
 * editor UI.
 *
 * Returns null if no figure at that index, else updated bytes.
 */
export async function setFigureAltText(
  bytes: Uint8Array,
  figureIndex: number,
  altText: string,
): Promise<Uint8Array | null> {
  const doc = await PDFDocument.load(bytes)
  const root = doc.catalog.get(PDFName.of('StructTreeRoot'))
  if (!root) return null
  const rootDict = doc.context.lookup(root) as PDFDict | undefined
  if (!rootDict) return null

  let nth = 0
  let found: PDFDict | null = null
  const walk = (dict: PDFDict): boolean => {
    const s = dict.get(PDFName.of('S'))?.toString()
    if (s === '/Figure') {
      if (nth === figureIndex) {
        found = dict
        return true
      }
      nth++
    }
    const k = dict.get(PDFName.of('K'))
    if (!k) return false
    const resolved = doc.context.lookup(k)
    if (resolved instanceof PDFArray) {
      for (let i = 0; i < resolved.size(); i++) {
        const child = doc.context.lookup(resolved.get(i))
        if (child instanceof PDFDict) {
          if (walk(child)) return true
        }
      }
    } else if (resolved instanceof PDFDict) {
      if (walk(resolved)) return true
    }
    return false
  }
  walk(rootDict)

  if (!found) return null
  ;(found as PDFDict).set(PDFName.of('Alt'), PDFString.of(altText))
  return new Uint8Array(await doc.save())
}

/**
 * Convenience: count figures missing /Alt. Used by the checker.
 */
export async function countFiguresWithoutAlt(bytes: Uint8Array): Promise<{ total: number; missing: number }> {
  const doc = await PDFDocument.load(bytes)
  const root = doc.catalog.get(PDFName.of('StructTreeRoot'))
  if (!root) return { total: 0, missing: 0 }
  const rootDict = doc.context.lookup(root) as PDFDict | undefined
  if (!rootDict) return { total: 0, missing: 0 }

  let total = 0, missing = 0
  const walk = (dict: PDFDict) => {
    const s = dict.get(PDFName.of('S'))?.toString()
    if (s === '/Figure') {
      total++
      // Non-empty /Alt or /ActualText required (empty doesn't count).
      const alt = dict.get(PDFName.of('Alt')) as PDFString | undefined
      const actual = dict.get(PDFName.of('ActualText')) as PDFString | undefined
      const altT = alt?.decodeText().trim() ?? ''
      const actT = actual?.decodeText().trim() ?? ''
      if (altT === '' && actT === '') missing++
    }
    const k = dict.get(PDFName.of('K'))
    if (!k) return
    const resolved = doc.context.lookup(k)
    if (resolved instanceof PDFArray) {
      for (let i = 0; i < resolved.size(); i++) {
        const child = doc.context.lookup(resolved.get(i))
        if (child instanceof PDFDict) walk(child)
      }
    } else if (resolved instanceof PDFDict) {
      walk(resolved)
    }
  }
  walk(rootDict)
  return { total, missing }
}
