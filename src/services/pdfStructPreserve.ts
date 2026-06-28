// A3 — Tagged-PDF round-trip preservation.
//
// User edits text in a tagged PDF. The bake stage rewrites Tj
// operands but doesn't keep the /StructTreeRoot's MCID parents in
// sync — saved PDF still has a /StructTreeRoot but the tags may
// reference content that no longer matches what the user sees,
// and overlay-baked replacement text isn't tagged at all.
//
// Strategy: snapshot-and-restore.
//   1. Before save, capture a tag snapshot:
//      - wasTagged flag
//      - Document /Lang
//      - Document /Title
//      - All /Figure elems with their /Alt text (alt text is the
//        most user-visible piece authors invest time in; the
//        fast path here keeps it from getting silently dropped)
//   2. After save, if wasTagged, re-run installStructTree with a
//      synthetic spec that wraps every page's content in /P + the
//      preserved /Figure entries with /Alt restored.
//
// This produces a freshly-tagged PDF whose /StructTreeRoot is
// consistent with the post-edit content. veraPDF UA-1 should
// pass against the output even when the inner Tj operands have
// been completely rewritten, because the tag tree is rebuilt
// from current content + preserved alt text.
//
// Limits (deferred to a follow-up):
//   - Heading levels (H1/H2/H3) revert to /P (we'd need
//     paragraph-cluster heuristics to detect headings post-edit).
//   - List structure (/L /LI) collapses to /P.
//   - Table structure (/Table /TR /TH /TD) collapses to /P.
//   - Per-element /Lang overrides not preserved (only doc /Lang).
//
// Real-world: most authors only invest in /Lang, /Title, and image
// alt text. The full structure usually comes from the authoring
// tool's auto-tagger and gets re-derived just fine on re-tag. The
// items above can be added when the parity matrix shows demand.

import {
  PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFString, PDFHexString, PDFNumber,
} from 'pdf-lib'
import { installStructTree, type StructElemSpec } from './pdfStructTree'

export interface TagSnapshot {
  wasTagged: boolean
  lang?: string
  title?: string
  figures: Array<{
    /** XObject name as it appears in the content stream. Empty
     *  string when the original element wasn't bound to a specific
     *  XObject (rare — most figures reference one). */
    xObjectName: string
    alt?: string
    actualText?: string
    lang?: string
    /** 0-based index of the page this /Figure's /Pg points at.
     *  undefined when /Pg is absent or unresolvable. Session 8:
     *  restore puts the figure back on its REAL page, not page 0. */
    pageIndex?: number
  }>
  /** Census of EVERY structure role in the original tree, by /S name
   *  (e.g. { Document: 1, H1: 2, L: 1, LI: 3, Table: 1, TR: 4 }).
   *  Session 8 uses this to detect when the snapshot-and-restore
   *  rebuild flattens real semantic structure to /P, so the loss is
   *  RECORDED (tag.structure_flattened) instead of silent. */
  roleCounts: Record<string, number>
  /** Session tagpreserve: the original semantic hierarchy captured as a
   *  StructElemSpec tree, ready to re-feed installStructTree so a
   *  content-rewriting edit-save can PRESERVE heading/list/table/figure/
   *  link/form types + nesting instead of flattening to /P. The synthetic
   *  per-page /P content wrappers (the elems that OWN the MCIDs) are
   *  DELIBERATELY excluded — installStructTree regenerates fresh ones from
   *  the post-edit content streams, so keeping the originals would double
   *  the wrappers and leave stale MCID references. Link/Form elements carry
   *  the resolved /Annots index of their /OBJR target so the rebuild can
   *  re-bind the annotation. Empty when the tree had no preservable
   *  semantic structure (or extraction failed). */
  structSpec?: StructElemSpec[]
}

/** Structure roles whose loss-to-/P is a real accessibility-fidelity
 *  degradation worth recording. Excludes the roles the flat rebuild
 *  legitimately keeps (Document root, P body, Figure with alt) and
 *  the decorative/transparent ones (Artifact, Span, NonStruct). PDF
 *  2.0 standard structure roles per pdfStructTree.STANDARD_ROLES. */
const SEMANTIC_STRUCTURE_ROLES = new Set([
  'Part', 'Sect', 'Div', 'Art', 'Quote', 'Note', 'Reference', 'BibEntry',
  'Code', 'Caption', 'TOC', 'TOCI', 'Index', 'Formula',
  'H', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'L', 'LI', 'Lbl', 'LBody',
  'Table', 'TR', 'TH', 'TD', 'THead', 'TBody', 'TFoot',
  'Link', 'Form',
])

/** Pure diff: which SEMANTIC roles present in `before` were reduced or
 *  removed in `after`. Returns one entry per lost role with its before
 *  and (possibly 0) after count. Used by the save path to record
 *  tag.structure_flattened from the ORIGINAL census vs the census of
 *  what the restore rebuild ACTUALLY shipped (re-parsed output) — so a
 *  future restore that preserves some roles narrows the record
 *  automatically rather than over-reporting. */
export function computeFlattenedRoles(
  before: Record<string, number>,
  after: Record<string, number>,
): Array<{ role: string; before: number; after: number }> {
  const lost: Array<{ role: string; before: number; after: number }> = []
  for (const role of Object.keys(before)) {
    if (!SEMANTIC_STRUCTURE_ROLES.has(role)) continue
    const b = before[role] ?? 0
    const a = after[role] ?? 0
    if (a < b) lost.push({ role, before: b, after: a })
  }
  // Stable, deterministic order (by role name) for a reproducible detail.
  lost.sort((x, y) => x.role.localeCompare(y.role))
  return lost
}

/** One-line human/machine summary of a flattened-roles diff for the
 *  degradation `detail`. */
export function describeFlattenedRoles(
  lost: Array<{ role: string; before: number; after: number }>,
): string {
  return lost.map((l) => `${l.role}×${l.before}`).join(', ')
}

/** Compare an original role census to a post-save census and classify the
 *  outcome for the structure-preservation records:
 *  - preserved: SEMANTIC roles that still have at least one instance in
 *    the saved file (type+nesting survived the save).
 *  - flattened: SEMANTIC roles whose count dropped (collapsed toward /P).
 *  A role can appear in BOTH when a partial preserve kept some instances
 *  and lost others — that is the honest report. */
export function summarizeStructureOutcome(
  before: Record<string, number>,
  after: Record<string, number>,
): { preserved: string[]; flattened: Array<{ role: string; before: number; after: number }> } {
  const flattened = computeFlattenedRoles(before, after)
  const preserved: string[] = []
  for (const role of Object.keys(before)) {
    if (!SEMANTIC_STRUCTURE_ROLES.has(role)) continue
    if ((after[role] ?? 0) > 0) preserved.push(role)
  }
  preserved.sort((a, b) => a.localeCompare(b))
  return { preserved, flattened }
}

/** Re-walk a (saved) PDF's struct tree and return only the role
 *  census. Safe on untagged / unparseable input (returns {}). Used
 *  AFTER restore to measure what actually shipped. */
export async function extractRoleCensus(
  bytes: Uint8Array,
): Promise<Record<string, number>> {
  let doc: PDFDocument
  try {
    doc = await PDFDocument.load(bytes, {
      throwOnInvalidObject: false,
      ignoreEncryption: true,
    })
  } catch {
    return {}
  }
  const structTreeRoot = doc.catalog.get(PDFName.of('StructTreeRoot'))
  if (!structTreeRoot) return {}
  const { roleCounts } = walkStructTree(doc, structTreeRoot)
  return roleCounts
}

/** Extract the bare-minimum tag info we restore. Safe on
 *  unmarked PDFs — returns wasTagged=false + empty figures. */
export async function extractTagSnapshot(
  bytes: Uint8Array,
): Promise<TagSnapshot> {
  const doc = await PDFDocument.load(bytes, {
    throwOnInvalidObject: false,
    ignoreEncryption: true,
  })
  const ctx = doc.context

  // Detect tagged: catalog has /MarkInfo /Marked true OR
  // /StructTreeRoot present. Either is sufficient — both should
  // be there for a well-formed tagged PDF.
  const markInfoEntry = doc.catalog.get(PDFName.of('MarkInfo'))
  const markInfo = markInfoEntry ? ctx.lookup(markInfoEntry) : undefined
  const markedEntry = markInfo instanceof PDFDict
    ? markInfo.get(PDFName.of('Marked'))
    : undefined
  const isMarked =
    !!markedEntry &&
    (markedEntry.toString() === 'true' || markedEntry.toString() === '/true')
  const structTreeRoot = doc.catalog.get(PDFName.of('StructTreeRoot'))
  const wasTagged = isMarked || !!structTreeRoot

  if (!wasTagged) {
    return { wasTagged: false, figures: [], roleCounts: {} }
  }

  // Doc /Lang.
  const langEntry = doc.catalog.get(PDFName.of('Lang'))
  let lang: string | undefined
  if (langEntry) {
    const v = ctx.lookup(langEntry)
    if (v instanceof PDFString) lang = v.asString()
    else if (v instanceof PDFHexString) lang = v.decodeText()
  }

  // Doc title from PDFInfo.
  const title = doc.getTitle() || undefined

  // Single walk: full role census + /Figure elems (with real page).
  const { roleCounts, figures } = walkStructTree(doc, structTreeRoot)

  // Capture the semantic hierarchy for type-preserving restore (Phase B).
  // Best-effort: a malformed tree must still yield a usable snapshot (the
  // flat rebuild remains the fallback), so never let extraction throw out
  // of the snapshot.
  let structSpec: StructElemSpec[] | undefined
  try {
    structSpec = buildStructSpec(doc, structTreeRoot)
  } catch (err) {
    console.warn('[extractTagSnapshot] structSpec extraction failed:', err)
    structSpec = undefined
  }

  return { wasTagged, lang, title, figures, roleCounts, structSpec }
}

/** Children of /K that the spec must IGNORE when reproducing structure:
 *  raw MCID integers (content owned by the page wrapper, regenerated by
 *  installStructTree) and /OBJR annotation references (re-bound via the
 *  Link/Form annotIndices mechanism). */
function isMcidChild(v: unknown): boolean {
  return v instanceof PDFNumber
}

/** Build a StructElemSpec[] mirror of the original tree's semantic
 *  hierarchy, suitable for re-feeding installStructTree.
 *
 *  Excludes the synthetic per-page /P content wrappers (a /P whose /K is
 *  entirely MCID integers — it carries no semantic meaning, only the
 *  page's marked-content; installStructTree rebuilds an equivalent from
 *  the post-edit streams). For /Link and /Form, resolves each /OBJR's
 *  target annotation to its index in the owning page's /Annots so the
 *  rebuild can re-emit the OBJR + /StructParent binding.
 *
 *  Depth- and cycle-guarded. */
function buildStructSpec(
  doc: PDFDocument,
  rootRef: ReturnType<PDFDict['get']>,
): StructElemSpec[] {
  const ctx = doc.context
  if (!rootRef) return []
  const visited = new Set<string>()

  // page ref (objNum:gen) → 0-based index, for resolving /Pg + /Annots.
  const pageIndexByRef = new Map<string, number>()
  const pages = doc.getPages()
  for (let i = 0; i < pages.length; i++) {
    const ref = pages[i].ref
    if (ref instanceof PDFRef) {
      pageIndexByRef.set(`${ref.objectNumber}:${ref.generationNumber}`, i)
    }
  }
  const resolvePageIndex = (pgEntry: ReturnType<PDFDict['get']>): number | undefined => {
    if (pgEntry instanceof PDFRef) {
      return pageIndexByRef.get(`${pgEntry.objectNumber}:${pgEntry.generationNumber}`)
    }
    return undefined
  }

  // Resolve a /Scope and /BBox out of an element's /A attribute(s) — they
  // live in attribute objects ({ O: /Table, Scope } / { O: /Layout, BBox }),
  // which may be a single dict or an array of dicts.
  const readAttrs = (node: PDFDict): { scope?: 'Row' | 'Column' | 'Both'; bbox?: [number, number, number, number] } => {
    const out: { scope?: 'Row' | 'Column' | 'Both'; bbox?: [number, number, number, number] } = {}
    const aEntry = node.get(PDFName.of('A'))
    if (!aEntry) return out
    const aVal = ctx.lookup(aEntry)
    const dicts: PDFDict[] = []
    if (aVal instanceof PDFArray) {
      for (let i = 0; i < aVal.size(); i++) {
        const d = ctx.lookup(aVal.get(i))
        if (d instanceof PDFDict) dicts.push(d)
      }
    } else if (aVal instanceof PDFDict) {
      dicts.push(aVal)
    }
    for (const d of dicts) {
      const sc = d.get(PDFName.of('Scope'))?.toString()
      if (sc === '/Row') out.scope = 'Row'
      else if (sc === '/Column') out.scope = 'Column'
      else if (sc === '/Both') out.scope = 'Both'
      const bb = ctx.lookup(d.get(PDFName.of('BBox')))
      if (bb instanceof PDFArray && bb.size() === 4) {
        const nums = [] as number[]
        for (let i = 0; i < 4; i++) {
          const n = bb.get(i)
          if (n instanceof PDFNumber) nums.push(n.asNumber())
        }
        if (nums.length === 4) out.bbox = [nums[0], nums[1], nums[2], nums[3]]
      }
    }
    return out
  }

  // For Link/Form: the /Annots indices of the OBJR target annotations.
  const resolveAnnotIndices = (node: PDFDict, kArr: PDFArray, pageIndex: number | undefined): number[] => {
    if (pageIndex === undefined || pageIndex < 0 || pageIndex >= pages.length) return []
    const annots = ctx.lookup(pages[pageIndex].node.get(PDFName.of('Annots')))
    if (!(annots instanceof PDFArray)) return []
    // Build ref→index for this page's /Annots.
    const annotIdx = new Map<string, number>()
    for (let i = 0; i < annots.size(); i++) {
      const r = annots.get(i)
      if (r instanceof PDFRef) annotIdx.set(`${r.objectNumber}:${r.generationNumber}`, i)
    }
    const out: number[] = []
    for (let i = 0; i < kArr.size(); i++) {
      const child = ctx.lookup(kArr.get(i))
      if (child instanceof PDFDict && child.get(PDFName.of('Type'))?.toString() === '/OBJR') {
        const objRef = child.get(PDFName.of('Obj'))
        if (objRef instanceof PDFRef) {
          const idx = annotIdx.get(`${objRef.objectNumber}:${objRef.generationNumber}`)
          if (idx !== undefined) out.push(idx)
        }
      }
    }
    return out
  }

  const MAX_DEPTH = 40
  const buildElem = (entry: ReturnType<PDFDict['get']>, depth: number): StructElemSpec | null => {
    if (depth > MAX_DEPTH) return null
    const node = ctx.lookup(entry)
    if (!(node instanceof PDFDict)) return null
    if (entry instanceof PDFRef) {
      const key = `${entry.objectNumber}:${entry.generationNumber}`
      if (visited.has(key)) return null
      visited.add(key)
    }
    const sName = node.get(PDFName.of('S'))?.toString() ?? ''
    if (!sName.startsWith('/')) return null
    const role = sName.slice(1)
    const pageIndex = resolvePageIndex(node.get(PDFName.of('Pg')))

    const kEntry = node.get(PDFName.of('K'))
    const kVal = kEntry ? ctx.lookup(kEntry) : undefined

    // Classify children.
    const structChildren: ReturnType<PDFDict['get']>[] = []
    let hasMcid = false
    let hasObjr = false
    if (kVal instanceof PDFArray) {
      for (let i = 0; i < kVal.size(); i++) {
        const c = kVal.get(i)
        if (isMcidChild(c)) { hasMcid = true; continue }
        const cd = ctx.lookup(c)
        if (cd instanceof PDFDict) {
          const t = cd.get(PDFName.of('Type'))?.toString()
          if (t === '/OBJR') { hasObjr = true; continue }
          if (t === '/StructElem' || cd.get(PDFName.of('S'))) { structChildren.push(c); continue }
        }
      }
    } else if (kVal instanceof PDFDict) {
      const t = kVal.get(PDFName.of('Type'))?.toString()
      if (t === '/StructElem' || kVal.get(PDFName.of('S'))) structChildren.push(kEntry)
    } else if (isMcidChild(kVal)) {
      hasMcid = true
    }

    // Skip the synthetic per-page content wrapper: a /P (or /Span) that
    // owns ONLY MCIDs and has no semantic children. installStructTree
    // regenerates these from the post-edit content streams.
    if (hasMcid && structChildren.length === 0 && !hasObjr && (role === 'P' || role === 'Span')) {
      return null
    }

    const spec: StructElemSpec = { S: role }
    if (pageIndex !== undefined) spec.pageIndex = pageIndex
    const alt = pdfStringToText(node.get(PDFName.of('Alt')), ctx)
    if (alt !== undefined) spec.Alt = alt
    const actual = pdfStringToText(node.get(PDFName.of('ActualText')), ctx)
    if (actual !== undefined) spec.ActualText = actual
    const elemLang = pdfStringToText(node.get(PDFName.of('Lang')), ctx)
    if (elemLang !== undefined) spec.Lang = elemLang
    const title = pdfStringToText(node.get(PDFName.of('T')), ctx)
    if (title !== undefined) spec.T = title
    const { scope, bbox } = readAttrs(node)
    if (scope) spec.Scope = scope
    if (bbox) spec.BBox = bbox

    // Link/Form OBJR re-binding.
    if ((role === 'Link' || role === 'Form') && kVal instanceof PDFArray) {
      const ai = resolveAnnotIndices(node, kVal, pageIndex)
      if (ai.length > 0) spec.annotIndices = ai
    }

    // Recurse into struct-elem children.
    const children: StructElemSpec[] = []
    for (const c of structChildren) {
      const cs = buildElem(c, depth + 1)
      if (cs) children.push(cs)
    }
    if (children.length > 0) spec.children = children
    return spec
  }

  const root = ctx.lookup(rootRef)
  if (!(root instanceof PDFDict)) return []
  const docK = root.get(PDFName.of('K'))
  const docKVal = docK ? ctx.lookup(docK) : undefined
  // The /Document element(s). Usually a single /Document StructElem; its
  // /K holds the real top-level structure children.
  const out: StructElemSpec[] = []
  const collectFromDocElem = (docElemEntry: ReturnType<PDFDict['get']>): void => {
    const docElem = ctx.lookup(docElemEntry)
    if (!(docElem instanceof PDFDict)) return
    const childK = docElem.get(PDFName.of('K'))
    const childKVal = childK ? ctx.lookup(childK) : undefined
    if (childKVal instanceof PDFArray) {
      for (let i = 0; i < childKVal.size(); i++) {
        const cs = buildElem(childKVal.get(i), 1)
        if (cs) out.push(cs)
      }
    } else if (childKVal instanceof PDFDict) {
      const cs = buildElem(childK, 1)
      if (cs) out.push(cs)
    }
  }
  if (docKVal instanceof PDFArray) {
    for (let i = 0; i < docKVal.size(); i++) collectFromDocElem(docKVal.get(i))
  } else if (docKVal instanceof PDFDict) {
    collectFromDocElem(docK)
  }
  return out
}

/** Walk the whole struct tree once, returning a census of every /S
 *  role and the /Figure elements (with alt/actual-text/lang and their
 *  resolved real page index). Cycle-guarded. Safe on a missing root. */
function walkStructTree(
  doc: PDFDocument,
  rootRef: ReturnType<PDFDict['get']>,
): { roleCounts: Record<string, number>; figures: TagSnapshot['figures'] } {
  const ctx = doc.context
  const roleCounts: Record<string, number> = {}
  const figures: TagSnapshot['figures'] = []
  if (!rootRef) return { roleCounts, figures }
  const visited = new Set<string>()

  // page ref (objNum:gen) → 0-based index, for resolving /Figure /Pg.
  const pageIndexByRef = new Map<string, number>()
  const pages = doc.getPages()
  for (let i = 0; i < pages.length; i++) {
    const ref = pages[i].ref
    if (ref instanceof PDFRef) {
      pageIndexByRef.set(`${ref.objectNumber}:${ref.generationNumber}`, i)
    }
  }

  const resolvePageIndex = (
    pgEntry: ReturnType<PDFDict['get']>,
  ): number | undefined => {
    if (pgEntry instanceof PDFRef) {
      return pageIndexByRef.get(`${pgEntry.objectNumber}:${pgEntry.generationNumber}`)
    }
    return undefined
  }

  const visit = (entry: ReturnType<PDFDict['get']>): void => {
    if (!entry) return
    const node = ctx.lookup(entry)
    if (!(node instanceof PDFDict)) return
    // Cycle guard.
    if (entry instanceof PDFRef) {
      const key = `${entry.objectNumber}:${entry.generationNumber}`
      if (visited.has(key)) return
      visited.add(key)
    }

    const sEntry = node.get(PDFName.of('S'))
    const sName = sEntry?.toString() ?? ''
    if (sName.startsWith('/')) {
      const role = sName.slice(1)
      roleCounts[role] = (roleCounts[role] ?? 0) + 1
      if (role === 'Figure') {
        const altEntry = node.get(PDFName.of('Alt'))
        const actEntry = node.get(PDFName.of('ActualText'))
        const figLangEntry = node.get(PDFName.of('Lang'))
        // /Pg is a direct ref on the figure elem; on a leaf it may be
        // inherited from an ancestor we don't track — best-effort.
        figures.push({
          xObjectName: '', // Recovering xObjectName from the structure
                            // tree alone is not 1:1 — would need a content-
                            // stream walk. We collect alt-text only and
                            // the restore step matches by figure-index.
          alt: pdfStringToText(altEntry, ctx),
          actualText: pdfStringToText(actEntry, ctx),
          lang: pdfStringToText(figLangEntry, ctx),
          pageIndex: resolvePageIndex(node.get(PDFName.of('Pg'))),
        })
      }
    }

    // Recurse into /K children.
    const kEntry = node.get(PDFName.of('K'))
    if (!kEntry) return
    const kVal = ctx.lookup(kEntry)
    if (kVal instanceof PDFArray) {
      for (let i = 0; i < kVal.size(); i++) {
        const child = kVal.get(i)
        if (child) visit(child)
      }
    } else if (kVal instanceof PDFDict) {
      visit(kEntry)
    }
  }

  // The catalog's /StructTreeRoot ref points to a dict; visit its /K.
  const root = ctx.lookup(rootRef)
  if (root instanceof PDFDict) {
    const k = root.get(PDFName.of('K'))
    if (k) visit(k)
  }
  return { roleCounts, figures }
}

function pdfStringToText(
  entry: ReturnType<PDFDict['get']>,
  ctx: PDFDocument['context'],
): string | undefined {
  if (!entry) return undefined
  const v = ctx.lookup(entry)
  if (v instanceof PDFString) return v.asString()
  if (v instanceof PDFHexString) return v.decodeText()
  return undefined
}

/** Recursively clamp a captured spec's pageIndex into [0, pageCount-1]
 *  (a stale index would make materializeElem silently drop /Pg, leaving a
 *  page-less elem — a veraPDF failure class). Returns a fresh tree; never
 *  mutates the snapshot. */
function remapSpecPages(specs: StructElemSpec[], pageCount: number): StructElemSpec[] {
  const clamp = (s: StructElemSpec): StructElemSpec => {
    const out: StructElemSpec = { ...s }
    if (out.pageIndex !== undefined && out.pageIndex >= 0) {
      out.pageIndex = Math.min(out.pageIndex, Math.max(0, pageCount - 1))
    }
    if (s.children && s.children.length > 0) {
      out.children = s.children.map(clamp)
    }
    return out
  }
  return specs.map(clamp)
}

/** Restore tagged structure on the saved bytes. Re-runs installStructTree.
 *
 *  Two modes:
 *  - preserve (opts.preserveStructure + a non-empty snapshot.structSpec):
 *    re-asserts the ORIGINAL semantic hierarchy (H/L/Table/Figure/Link/
 *    Form types + nesting), remapping each elem's page into range. The
 *    installer regenerates the per-page /P content wrappers + MCIDs from
 *    the post-edit streams, so the preserved semantic elems are
 *    content-less markers (type+nesting real, per-element MCID↔run
 *    association NOT rebuilt — KNOWN-LIMITATIONS §8a). Used when a content
 *    edit rewrote part of a tagged doc but pages were not added/removed.
 *  - flatten (default): the legacy rebuild — one /P per page + the
 *    preserved /Figure entries. Used as the safe fallback (page-set
 *    changed, no structSpec, or a preserve rebuild threw upstream).
 *
 *  No-op when snapshot.wasTagged is false. */
export async function restoreTagsAfterSave(
  bytes: Uint8Array,
  snapshot: TagSnapshot,
  pageCount: number,
  opts: { preserveStructure?: boolean } = {},
): Promise<Uint8Array> {
  if (!snapshot.wasTagged) return bytes

  const preserve =
    !!opts.preserveStructure &&
    !!snapshot.structSpec &&
    snapshot.structSpec.length > 0

  let children: StructElemSpec[]
  if (preserve) {
    // structSpec already carries the /Figure elems (with /Alt + /BBox) in
    // their original nesting, so we do NOT separately append figures here.
    children = remapSpecPages(snapshot.structSpec!, pageCount)
  } else {
    children = []
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
      children.push({ S: 'P', pageIndex })
    }
    // Append figure entries on their REAL page (Session 8). The snapshot
    // resolved each /Figure's /Pg to a page index; clamp it into range in
    // case pages were deleted between snapshot and save (a stale index
    // would otherwise make materializeElem silently drop /Pg, leaving a
    // page-less /Figure — a new veraPDF failure class). Fall back to page
    // 0 only when /Pg was absent/unresolvable in the original.
    for (const fig of snapshot.figures) {
      let pageIndex = fig.pageIndex ?? 0
      if (pageIndex < 0) pageIndex = 0
      if (pageIndex > pageCount - 1) pageIndex = pageCount - 1
      children.push({
        S: 'Figure',
        pageIndex,
        Alt: fig.alt ?? 'Figure',
        ActualText: fig.actualText,
        Lang: fig.lang,
      })
    }
  }

  return installStructTree(bytes, {
    lang: snapshot.lang,
    title: snapshot.title,
    children,
  })
}
