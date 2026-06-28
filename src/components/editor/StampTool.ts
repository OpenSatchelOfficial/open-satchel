import { Canvas, Textbox, Rect, Group, type TPointerEventInfo } from 'fabric'

export interface StampDef {
  /** Stamp text. Supports the dynamic tokens: `{date}`, `{time}`,
   *  `{datetime}`, `{user}`, `{user-full}`, `{day}`. Tokens expand at
   *  apply time, so two stamps placed an hour apart get different
   *  timestamps. Acrobat parity (A9). */
  text: string
  label?: string
  color: string
  bgColor: string
  fontSize?: number
  minWidth?: number
  maxWidth?: number
  angle?: number
  /** Optional preset id — when present, the stamp library shows
   *  expanded preview text in the swatch grid. */
  id?: string
}

const CUSTOM_STAMPS_KEY = 'open-satchel:custom-stamps'
const USER_NAME_KEY = 'open-satchel:user-name'
export const DEFAULT_TEXT_STAMP_TEMPLATE = 'Reviewed by {user} on {date}'

export const STAMP_TOKEN_SHORTCUTS = [
  { label: 'Date', token: '{date}' },
  { label: 'Time', token: '{time}' },
  { label: 'User', token: '{user}' },
  { label: 'Full', token: '{user-full}' },
  { label: 'Day', token: '{day}' },
  { label: 'DateTime', token: '{datetime}' },
  { label: 'ISO', token: '{date-iso}' },
] as const

/** Read the configured user name (set in Preferences flyout) for
 *  dynamic stamp tokens. Falls back to "User" so stamps still
 *  render readable text on a fresh install — UI surfaces the config
 *  point next to the stamp library. */
export function getStampUserName(): string {
  try {
    const v = localStorage.getItem(USER_NAME_KEY)
    if (v && v.trim().length > 0) return v.trim()
  } catch {
    /* localStorage unavailable */
  }
  return 'User'
}

export function setStampUserName(name: string): void {
  try {
    localStorage.setItem(USER_NAME_KEY, name)
  } catch {
    /* quota / privacy mode */
  }
}

/** Expand `{date}`, `{time}`, `{datetime}`, `{user}`, `{user-full}`,
 *  `{day}` tokens in a stamp template. Date format is locale-aware
 *  short date (e.g. "4/26/2026" in en-US, "26/04/2026" in en-GB) so
 *  signed stamps read naturally for the local team. ISO format is
 *  available via `{date-iso}` for legal / structured use. */
export function expandStampTokens(template: string, now: Date = new Date()): string {
  const user = getStampUserName()
  // Initials: take first letter of each whitespace-delimited part,
  // capitalize, max 4. "Jay-Quan McCleary" → "JM".
  const initials = user
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase())
    .slice(0, 4)
    .join('')
  const replacements: Record<string, string> = {
    '{date}': now.toLocaleDateString(),
    '{date-iso}': now.toISOString().slice(0, 10),
    '{time}': now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    '{datetime}': now.toLocaleString(),
    '{user}': initials || 'User',
    '{user-full}': user,
    '{day}': now.toLocaleDateString([], { weekday: 'long' }),
  }
  return template.replace(/\{[a-zA-Z-]+\}/g, (m) => replacements[m] ?? m)
}

export interface CustomStamp {
  id: string
  label: string
  /** Base64 data URL of the stamp image (PNG). */
  dataUrl: string
  addedAt: number
}

/** Load user-imported stamps from localStorage. Browser-mode usage is
 *  sufficient — Tauri users get the same list via localStorage in the
 *  WebView2 user-data dir, which persists across launches. */
export function loadCustomStamps(): CustomStamp[] {
  try {
    const raw = localStorage.getItem(CUSTOM_STAMPS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function saveCustomStamps(list: CustomStamp[]): void {
  try {
    localStorage.setItem(CUSTOM_STAMPS_KEY, JSON.stringify(list))
  } catch {
    // Quota — drop silently; user will see stale list.
  }
}

export async function importCustomStampFromFile(file: File): Promise<CustomStamp> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  // Detect PNG/JPEG; normalize to data URL at encoded size. A smarter
  // pipeline would downscale huge images; v1 trusts the user.
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50
  const isJpeg = bytes[0] === 0xFF && bytes[1] === 0xD8
  if (!isPng && !isJpeg) throw new Error('Only PNG and JPEG stamps are supported.')
  const mime = isPng ? 'image/png' : 'image/jpeg'
  const dataUrl: string = await new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result))
    fr.onerror = () => reject(new Error('Could not read stamp file'))
    fr.readAsDataURL(new Blob([bytes], { type: mime }))
  })
  const stamp: CustomStamp = {
    id: `custom_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    label: file.name.replace(/\.(png|jpe?g)$/i, '').slice(0, 32) || 'Stamp',
    dataUrl,
    addedAt: Date.now(),
  }
  const list = loadCustomStamps()
  list.push(stamp)
  saveCustomStamps(list)
  return stamp
}

export function removeCustomStamp(id: string): void {
  const list = loadCustomStamps().filter((s) => s.id !== id)
  saveCustomStamps(list)
}

export const STAMPS: StampDef[] = [
  // Static stamps
  { id: 'approved', text: 'APPROVED', color: '#1f7a4d', bgColor: 'rgba(31,122,77,0.10)' },
  { id: 'rejected', text: 'REJECTED', color: '#b42318', bgColor: 'rgba(180,35,24,0.10)' },
  { id: 'draft', text: 'DRAFT', color: '#9a6700', bgColor: 'rgba(154,103,0,0.10)' },
  { id: 'confidential', text: 'CONFIDENTIAL', color: '#93370d', bgColor: 'rgba(147,55,13,0.10)', minWidth: 156 },
  { id: 'final', text: 'FINAL', color: '#175cd3', bgColor: 'rgba(23,92,211,0.10)' },
  { id: 'copy', text: 'COPY', color: '#475467', bgColor: 'rgba(71,84,103,0.10)' },
  { id: 'void', text: 'VOID', color: '#b42318', bgColor: 'rgba(180,35,24,0.10)' },
  { id: 'urgent', text: 'URGENT', color: '#b54708', bgColor: 'rgba(181,71,8,0.10)' },
  { id: 'reviewed', text: 'REVIEWED', color: '#1f7a4d', bgColor: 'rgba(31,122,77,0.10)' },
  { id: 'sign-here', text: 'SIGN HERE', color: '#6941c6', bgColor: 'rgba(105,65,198,0.10)' },
  // Dynamic stamps — A9 Acrobat parity. Tokens expand at apply time
  // via `expandStampTokens`; placing the same stamp twice with an
  // hour between yields two different timestamps.
  { id: 'approved-dyn', label: 'Approved Date', text: 'APPROVED · {user} · {date}', color: '#1f7a4d', bgColor: 'rgba(31,122,77,0.10)', fontSize: 13, minWidth: 170 },
  { id: 'reviewed-dyn', label: 'Reviewed Time', text: 'REVIEWED {date} {time}', color: '#1f7a4d', bgColor: 'rgba(31,122,77,0.10)', fontSize: 13, minWidth: 170 },
  { id: 'received-dyn', label: 'Received', text: 'RECEIVED {date}', color: '#175cd3', bgColor: 'rgba(23,92,211,0.10)', fontSize: 13, minWidth: 136 },
  { id: 'signed-dyn', label: 'Signed', text: 'SIGNED · {user-full} · {datetime}', color: '#6941c6', bgColor: 'rgba(105,65,198,0.10)', fontSize: 13, minWidth: 210 },
]

export const TEXT_STAMP_INDEX = STAMPS.length

export function makeTextStampDef(template: string): StampDef {
  const text = template.trim() || DEFAULT_TEXT_STAMP_TEMPLATE
  return {
    id: 'text-stamp',
    label: 'Text Stamp',
    text,
    color: '#175cd3',
    bgColor: 'rgba(23,92,211,0.09)',
    fontSize: 13,
    minWidth: 150,
    maxWidth: 360,
    angle: 0,
  }
}

function estimateTextWidth(text: string, fontSize: number): number {
  let width = 0
  for (const ch of text) {
    if (ch === ' ') width += fontSize * 0.32
    else if (/[A-Z0-9]/.test(ch)) width += fontSize * 0.62
    else if (/[il.,:;]/.test(ch)) width += fontSize * 0.28
    else width += fontSize * 0.52
  }
  return width
}

export function applyStampTool(
  canvas: Canvas,
  stamp: StampDef,
  onSave: () => void
): void {
  canvas.isDrawingMode = false
  canvas.selection = false
  canvas.defaultCursor = 'crosshair'

  canvas.on('mouse:down', (e: TPointerEventInfo) => {
    if (e.target) return
    const pointer = canvas.getScenePoint(e.e)

    // Expand dynamic tokens at insertion time so two stamps placed
    // an hour apart get different timestamps. Static stamps pass
    // through unchanged (no `{...}` tokens to match).
    const expandedText = expandStampTokens(stamp.text)
    const lines = expandedText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    const safeLines = lines.length > 0 ? lines : [DEFAULT_TEXT_STAMP_TEMPLATE]
    const fontSize = stamp.fontSize ?? 15
    const lineHeightPx = Math.ceil(fontSize * 1.28)
    const maxLineWidth = Math.max(...safeLines.map((line) => estimateTextWidth(line, fontSize)))
    const textWidth = Math.max(
      stamp.minWidth ?? 96,
      Math.min(stamp.maxWidth ?? 340, Math.ceil(maxLineWidth + 34)),
    )
    const height = Math.max(34, safeLines.length * lineHeightPx + 16)

    const bg = new Rect({
      width: textWidth,
      height,
      fill: stamp.bgColor,
      stroke: stamp.color,
      strokeWidth: 1.5,
      rx: 3,
      ry: 3
    })

    const bar = new Rect({
      width: 4,
      height,
      fill: stamp.color,
      strokeWidth: 0,
      rx: 2,
      ry: 2
    })

    const label = new Textbox(safeLines.join('\n'), {
      width: textWidth - 20,
      top: 8,
      left: 13,
      fontSize,
      fill: stamp.color,
      fontFamily: 'Arial, Helvetica, sans-serif',
      fontWeight: '700',
      lineHeight: 1.05,
      charSpacing: 20,
      textAlign: safeLines.length > 1 ? 'left' : 'center',
      editable: false,
    })

    const group = new Group([bg, bar, label], {
      left: pointer.x,
      top: pointer.y,
      selectable: true,
      angle: stamp.angle ?? 0
    })

    ;(group as any).__isStamp = true

    canvas.add(group)
    canvas.setActiveObject(group)
    onSave()
  })
}
