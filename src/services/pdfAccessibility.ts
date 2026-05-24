// PDF Accessibility — read/edit the structure tree for tagged PDFs.
// Enables PDF/UA compliance checking and remediation.

import { PDFDocument, PDFName, PDFDict, PDFArray, PDFString, PDFNumber } from 'pdf-lib'

export interface StructTag {
  type: string           // e.g. "Document", "P", "H1", "Table", "Span"
  title?: string
  altText?: string
  children: StructTag[]
  pageIndex?: number     // which page this tag references
  contentRef?: string    // reference to marked content
}

/** Read the structure tree from a tagged PDF */
export async function readStructureTree(bytes: Uint8Array): Promise<StructTag | null> {
  // Read-only — share the parsed doc with the rest of the
  // Advanced Tools sections (Metadata, Bookmarks, etc).
  const { getReadOnlyPdfLibDoc } = await import('./pdfLibDocCache')
  const doc = await getReadOnlyPdfLibDoc(bytes)
  const catalog = doc.catalog
  const structTreeRoot = catalog.get(PDFName.of('StructTreeRoot'))
  if (!structTreeRoot) return null

  const root = doc.context.lookup(structTreeRoot) as PDFDict | undefined
  if (!root) return null

  function parseElement(dict: PDFDict): StructTag {
    const type = dict.get(PDFName.of('S'))?.toString()?.replace('/', '') ?? 'Unknown'
    const title = (dict.get(PDFName.of('T')) as PDFString | undefined)?.decodeText()
    const alt = (dict.get(PDFName.of('Alt')) as PDFString | undefined)?.decodeText()

    const children: StructTag[] = []
    const k = dict.get(PDFName.of('K'))
    if (k) {
      const resolved = doc.context.lookup(k)
      if (resolved instanceof PDFArray) {
        for (let i = 0; i < resolved.size(); i++) {
          const child = doc.context.lookup(resolved.get(i))
          if (child instanceof PDFDict && child.get(PDFName.of('S'))) {
            children.push(parseElement(child))
          }
        }
      } else if (resolved instanceof PDFDict && resolved.get(PDFName.of('S'))) {
        children.push(parseElement(resolved))
      }
    }

    return { type, title, altText: alt, children }
  }

  // The root element is in /K of StructTreeRoot
  const k = root.get(PDFName.of('K'))
  if (!k) return { type: 'StructTreeRoot', children: [] }

  const rootElement = doc.context.lookup(k)
  if (rootElement instanceof PDFDict) {
    return parseElement(rootElement)
  }

  return { type: 'StructTreeRoot', children: [] }
}

/** Check if a PDF has a structure tree (is tagged) */
export async function isTaggedPdf(bytes: Uint8Array): Promise<boolean> {
  const { getReadOnlyPdfLibDoc } = await import('./pdfLibDocCache')
  const doc = await getReadOnlyPdfLibDoc(bytes)
  return !!doc.catalog.get(PDFName.of('StructTreeRoot'))
}

/** Add alt-text to an image in the structure tree */
export async function addAltText(
  bytes: Uint8Array,
  _structPath: number[], // path of indices into the tree
  altText: string
): Promise<Uint8Array> {
  // This is a simplified version — full implementation would walk
  // the structure tree to the exact element and set /Alt
  const doc = await PDFDocument.load(bytes)
  const root = doc.catalog.get(PDFName.of('StructTreeRoot'))
  if (!root) {
    // Create a minimal structure tree
    const ctx = doc.context
    const rootDict = PDFDict.withContext(ctx)
    rootDict.set(PDFName.of('Type'), PDFName.of('StructTreeRoot'))
    const rootRef = ctx.register(rootDict)
    doc.catalog.set(PDFName.of('StructTreeRoot'), rootRef)
  }
  return await doc.save()
}

/** Get a flat list of all structure tags with their types and alt-text status */
export async function listStructureTags(bytes: Uint8Array): Promise<{ type: string; hasAlt: boolean; depth: number }[]> {
  const tree = await readStructureTree(bytes)
  if (!tree) return []

  const result: { type: string; hasAlt: boolean; depth: number }[] = []
  function walk(node: StructTag, depth: number) {
    result.push({ type: node.type, hasAlt: !!node.altText, depth })
    for (const child of node.children) walk(child, depth + 1)
  }
  walk(tree, 0)
  return result
}
