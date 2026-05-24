import { Canvas, Textbox, Rect, Group, type TPointerEventInfo } from 'fabric'

export interface StampDef {
  /** Stamp text. Supports the dynamic tokens: `{date}`, `{time}`,
   *  `{datetime}`, `{user}`, `{user-full}`, `{day}`. Tokens expand at
   *  apply time, so two stamps placed an hour apart get different
   *  timestamps. Acrobat parity (A9). */
  text: string
  color: string
  bgColor: string
  /** Optional preset id — when present, the stamp library shows
   *  expanded preview text in the swatch grid. */
  id?: string
}

const CUSTOM_STAMPS_KEY = 'open-satchel:custom-stamps'
const USER_NAME_KEY = 'open-satchel:user-name'

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
  { id: 'approved', text: 'APPROVED', color: '#a6e3a1', bgColor: 'rgba(166,227,161,0.15)' },
  { id: 'rejected', text: 'REJECTED', color: '#f38ba8', bgColor: 'rgba(243,139,168,0.15)' },
  { id: 'draft', text: 'DRAFT', color: '#f9e2af', bgColor: 'rgba(249,226,175,0.15)' },
  { id: 'confidential', text: 'CONFIDENTIAL', color: '#f38ba8', bgColor: 'rgba(243,139,168,0.15)' },
  { id: 'final', text: 'FINAL', color: '#89b4fa', bgColor: 'rgba(137,180,250,0.15)' },
  { id: 'copy', text: 'COPY', color: '#6c7086', bgColor: 'rgba(108,112,134,0.15)' },
  { id: 'void', text: 'VOID', color: '#f38ba8', bgColor: 'rgba(243,139,168,0.15)' },
  { id: 'urgent', text: 'URGENT', color: '#fab387', bgColor: 'rgba(250,179,135,0.15)' },
  { id: 'reviewed', text: 'REVIEWED', color: '#a6e3a1', bgColor: 'rgba(166,227,161,0.15)' },
  { id: 'sign-here', text: 'SIGN HERE', color: '#cba6f7', bgColor: 'rgba(203,166,247,0.15)' },
  // Dynamic stamps — A9 Acrobat parity. Tokens expand at apply time
  // via `expandStampTokens`; placing the same stamp twice with an
  // hour between yields two different timestamps.
  { id: 'approved-dyn', text: 'APPROVED · {user} · {date}', color: '#a6e3a1', bgColor: 'rgba(166,227,161,0.15)' },
  { id: 'reviewed-dyn', text: 'REVIEWED {date} {time}', color: '#a6e3a1', bgColor: 'rgba(166,227,161,0.15)' },
  { id: 'received-dyn', text: 'RECEIVED {date}', color: '#89b4fa', bgColor: 'rgba(137,180,250,0.15)' },
  { id: 'signed-dyn', text: 'SIGNED · {user-full} · {datetime}', color: '#cba6f7', bgColor: 'rgba(203,166,247,0.15)' },
]

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
    const textWidth = expandedText.length * 14 + 30

    const bg = new Rect({
      width: textWidth,
      height: 40,
      fill: stamp.bgColor,
      stroke: stamp.color,
      strokeWidth: 3,
      rx: 4,
      ry: 4
    })

    const label = new Textbox(expandedText, {
      width: textWidth,
      top: 8,
      left: 0,
      fontSize: 18,
      fill: stamp.color,
      fontFamily: 'Impact, "Arial Black", sans-serif',
      fontWeight: 'bold',
      textAlign: 'center',
      editable: false
    })

    const group = new Group([bg, label], {
      left: pointer.x,
      top: pointer.y,
      selectable: true,
      angle: -15
    })

    ;(group as any).__isStamp = true

    canvas.add(group)
    canvas.setActiveObject(group)
    onSave()
  })
}
