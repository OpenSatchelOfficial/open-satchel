/* Open Satchel — custom monoline icon set (Redesign v2).
 *
 * 16px grid, 1.5 stroke, square caps, currentColor fill. Tuned for the
 * compact density default. Each icon is a small functional component
 * so consumers can customise size + style via props.
 *
 * Brand: <Satchel /> renders the stack-of-files-with-nib mark. Use this
 * as the app icon, splash, and dock chip — it's the "many formats, one
 * editor" signature.
 */
import type { CSSProperties, ReactNode } from 'react'

interface IconProps {
  size?: number
  style?: CSSProperties
  className?: string
}

const Svg = ({
  size = 16,
  children,
  style,
  className,
}: IconProps & { children: ReactNode }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="square"
    strokeLinejoin="miter"
    className={className}
    style={{ flexShrink: 0, display: 'block', ...style }}
    aria-hidden
  >
    {children}
  </svg>
)

/* ─── Brand: Satchel mark (custom — stack of file corners + editor nib) ─── */
export function Satchel({ size = 16, style }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      style={{ flexShrink: 0, display: 'block', ...style }}
      aria-hidden
    >
      {/* back sheet — clearly offset left + rotated */}
      <path
        d="M2.6 4.2 h4.8 l1.6 1.6 v6.0 a.6 .6 0 0 1 -.6 .6 h-5.8 a.6 .6 0 0 1 -.6 -.6 v-7.0 a.6 .6 0 0 1 .6 -.6 z"
        transform="rotate(-12 5.5 8.5)"
        stroke="currentColor"
        strokeWidth={1.1}
        strokeLinejoin="round"
        fill="var(--bg-surface, #fff)"
        opacity={0.85}
      />
      {/* middle sheet — offset right + rotated */}
      <path
        d="M5.6 3.6 h4.8 l1.6 1.6 v6.0 a.6 .6 0 0 1 -.6 .6 h-5.8 a.6 .6 0 0 1 -.6 -.6 v-7.0 a.6 .6 0 0 1 .6 -.6 z"
        transform="rotate(10 8.5 8)"
        stroke="currentColor"
        strokeWidth={1.1}
        strokeLinejoin="round"
        fill="var(--bg-surface, #fff)"
      />
      {/* front sheet — straight, with folded corner */}
      <path
        d="M4.0 4.4 h4.8 l1.8 1.8 v5.8 a.6 .6 0 0 1 -.6 .6 h-6.0 a.6 .6 0 0 1 -.6 -.6 v-7.0 a.6 .6 0 0 1 .6 -.6 z"
        stroke="currentColor"
        strokeWidth={1.2}
        strokeLinejoin="round"
        fill="var(--bg-surface, #fff)"
      />
      {/* folded corner */}
      <path
        d="M8.8 4.4 v1.8 h1.8"
        stroke="currentColor"
        strokeWidth={1.1}
        strokeLinejoin="round"
        fill="none"
      />
      {/* shared baseline across the front sheet */}
      <path
        d="M5.2 9.6 h4.0"
        stroke="currentColor"
        strokeWidth={1.1}
        strokeLinecap="round"
      />
      {/* editor nib / caret on top — accent-coloured, sits at upper-right */}
      <path
        d="M11.4 1.6 l2.0 2.0 -3.8 3.8 -2.2 .2 .2 -2.2 z"
        fill="var(--accent)"
        stroke="var(--bg-surface, #fff)"
        strokeWidth={0.7}
        strokeLinejoin="round"
      />
    </svg>
  )
}

/* ─── File / format glyphs ─── */
const FileBase = ({ size, children }: { size?: number; children: ReactNode }) => (
  <Svg size={size}>
    <path d="M3.5 2h6L12.5 5v9a.5.5 0 0 1-.5.5H3.5A.5.5 0 0 1 3 14V2.5a.5.5 0 0 1 .5-.5z" />
    <path d="M9.5 2v3H12.5" />
    {children}
  </Svg>
)
export const FilePdf = ({ size }: IconProps) => (
  <FileBase size={size}>
    <path
      d="M5 8.5v3M5 8.5h1.25a.75.75 0 0 1 0 1.5H5M8 11.5v-3h.75A.75.75 0 0 1 9.5 9.25v1.5a.75.75 0 0 1-.75.75H8m2.5 0v-3h1.5m-1.5 1.5h1"
      strokeWidth={1}
    />
  </FileBase>
)
export const FileMd = ({ size }: IconProps) => (
  <FileBase size={size}>
    <path d="M4.5 11.5v-3l1.25 1.5L7 8.5v3M9 8.5v3m0-3 1 1.25L11 8.5v3" strokeWidth={1} />
  </FileBase>
)
export const FileDoc = ({ size }: IconProps) => (
  <FileBase size={size}>
    <path d="M5 9h6M5 11h4" />
  </FileBase>
)
export const FileXls = ({ size }: IconProps) => (
  <FileBase size={size}>
    <path d="M5 8.5h6M5 10.5h6M7.5 8.5v3.5" />
  </FileBase>
)
export const FilePpt = ({ size }: IconProps) => (
  <FileBase size={size}>
    <rect x={5} y={8.5} width={6} height={3.5} />
  </FileBase>
)
export const FileImg = ({ size }: IconProps) => (
  <FileBase size={size}>
    <circle cx={6} cy={9.5} r={0.75} />
    <path d="M5 12.5l2-2 2 1.5 2-2.5" />
  </FileBase>
)
export const FileCode = ({ size }: IconProps) => (
  <FileBase size={size}>
    <path d="M6.5 9 5 10.5l1.5 1.5M9.5 9l1.5 1.5L9.5 12" />
  </FileBase>
)
export const FileJson = ({ size }: IconProps) => (
  <FileBase size={size}>
    <path d="M6.5 8.5c-1 0-1 1.5-1 2 0 1-1 1-1 1 0 0 1 0 1 1 0 .5 0 2 1 2M9.5 8.5c1 0 1 1.5 1 2 0 1 1 1 1 1 0 0-1 0-1 1 0 .5 0 2-1 2" />
  </FileBase>
)
export const FileCsv = ({ size }: IconProps) => (
  <FileBase size={size}>
    <path d="M5 8.5v4M5 8.5h6M5 10.5h6M7.5 8.5v4M9.75 8.5v4" />
  </FileBase>
)
export const FileHtml = ({ size }: IconProps) => (
  <FileBase size={size}>
    <path d="M5.5 9 4 10.5l1.5 1.5M10.5 9 12 10.5l-1.5 1.5M9 8.5l-2 4" />
  </FileBase>
)

/* ─── PDF tools ─── */
export const Open = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M2.5 4.5h4l1.5 1.5h5.5v6.5a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V4.5z" />
    <path d="M2.5 7h11" />
  </Svg>
)
export const Save = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M3 2.5h8.5L13.5 4.5V13a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5z" />
    <path d="M5 2.5v3h5v-3" />
    <path d="M5 13.5v-4h6v4" />
  </Svg>
)
export const Plus = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M8 3.5v9M3.5 8h9" />
  </Svg>
)
export const Search = ({ size }: IconProps) => (
  <Svg size={size}>
    <circle cx={7} cy={7} r={3.75} />
    <path d="M9.75 9.75 13 13" />
  </Svg>
)
export const Sidebar = ({ size }: IconProps) => (
  <Svg size={size}>
    <rect x={2.5} y={3} width={11} height={10} rx={1} />
    <path d="M6 3v10" />
  </Svg>
)
export const Close = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Svg>
)
export const Chevron = ({
  size = 16,
  dir = 'down',
}: IconProps & { dir?: 'down' | 'up' | 'right' | 'left' }) => {
  const map: Record<string, string> = {
    down: 'M4 6l4 4 4-4',
    up: 'M4 10l4-4 4 4',
    right: 'M6 4l4 4-4 4',
    left: 'M10 4l-4 4 4 4',
  }
  return (
    <Svg size={size}>
      <path d={map[dir]} />
    </Svg>
  )
}
export const Hand = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M5.5 8V4.25a.75.75 0 0 1 1.5 0V8m0 0V3.25a.75.75 0 0 1 1.5 0V8m0 0V3.75a.75.75 0 0 1 1.5 0V8m0 0V5.25a.75.75 0 0 1 1.5 0V10c0 2-1.5 3.5-3.5 3.5S5 12.5 5 11l-1.5-2.5a.75.75 0 0 1 1.25-.75L5.5 9" />
  </Svg>
)
export const Cursor = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M3.5 2.5l3 10 1.5-3.5 3.5-1.5z" />
  </Svg>
)
export const Type = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M3.5 4.5V3.5h9v1M8 3.5v9M6 12.5h4" />
  </Svg>
)
export const Highlight = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M3 13.5h10" />
    <path d="M5 11.5l1-3.5 4-4 2.5 2.5-4 4-3.5 1z" />
  </Svg>
)
export const Comment = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M2.5 3.5h11v7H7l-2.5 2.5v-2.5h-2z" />
  </Svg>
)
export const Pen = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M2.5 13.5l1-3 7-7 2 2-7 7z" />
    <path d="M9.5 4.5l2 2" />
  </Svg>
)
export const Shape = ({ size }: IconProps) => (
  <Svg size={size}>
    <rect x={2.5} y={2.5} width={6} height={6} />
    <circle cx={10.5} cy={10.5} r={3} />
  </Svg>
)
export const Stamp = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M5 8.5V6a3 3 0 0 1 6 0v2.5" />
    <rect x={3} y={8.5} width={10} height={2.5} />
    <path d="M3.5 13.5h9" />
  </Svg>
)
export const Sign = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M2.5 11.5c1.5 0 2.5-7 4-7s.5 6 2 6 1.5-3.5 3-3.5 1 3 2 3" />
    <path d="M2.5 13.5h11" />
  </Svg>
)
export const Lock = ({ size }: IconProps) => (
  <Svg size={size}>
    <rect x={3.5} y={7} width={9} height={6.5} rx={1} />
    <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
  </Svg>
)
export const Pages = ({ size }: IconProps) => (
  <Svg size={size}>
    <rect x={2.5} y={3} width={6} height={8} />
    <rect x={6.5} y={5} width={7} height={8} />
  </Svg>
)
export const Tools = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M10 2.5l3.5 3.5-1.5 1.5-3.5-3.5z" />
    <path d="M9 4.5L3 10.5l-.5 2.5 2.5-.5L11 6.5" />
  </Svg>
)
export const Batch = ({ size }: IconProps) => (
  <Svg size={size}>
    <rect x={2.5} y={2.5} width={6} height={6} />
    <rect x={7.5} y={7.5} width={6} height={6} />
    <path d="M8.5 4.5h2v2" />
  </Svg>
)
export const Insert = ({ size }: IconProps) => (
  <Svg size={size}>
    <rect x={2.5} y={3} width={11} height={10} />
    <path d="M8 6v4M6 8h4" />
  </Svg>
)
export const Review = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M3 3.5h10v7H8L5 13v-2.5H3z" />
    <path d="M5.5 6h5M5.5 8h3" />
  </Svg>
)
export const Thumbs = ({ size }: IconProps) => (
  <Svg size={size}>
    <rect x={2.5} y={2.5} width={4.5} height={5} />
    <rect x={9} y={2.5} width={4.5} height={5} />
    <rect x={2.5} y={8.5} width={4.5} height={5} />
    <rect x={9} y={8.5} width={4.5} height={5} />
  </Svg>
)
export const Outline = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M2.5 4h11M5 7.5h8.5M5 11h8.5M2.5 7.5h.5M2.5 11h.5" />
  </Svg>
)
export const Layers = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M8 2.5l5.5 3L8 8.5l-5.5-3z" />
    <path d="M2.5 8.5L8 11.5l5.5-3" />
    <path d="M2.5 11.5L8 14.5l5.5-3" />
  </Svg>
)
export const Bookmark = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M4 2.5h8v11l-4-2.5-4 2.5z" />
  </Svg>
)
export const Pin = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M9 1.5l-3.5 3.5L4 5.5v1.5l1 1L3 11l3 3 3-2-1-2 1.5-1.5h1.5L13.5 5.5z" />
  </Svg>
)
export const HelpCircle = ({ size }: IconProps) => (
  <Svg size={size}>
    <circle cx={8} cy={8} r={6.5} />
    <path d="M6 6.25a2 2 0 1 1 2.5 1.85c-.5.2-.5.7-.5 1.15M8 12.25v.01" />
  </Svg>
)
export const Attach = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M11.5 5.5L6 11a2 2 0 0 1-2.83-2.83L8.5 2.83a3 3 0 0 1 4.24 4.24L7.5 12.5" />
  </Svg>
)
export const Sun = ({ size }: IconProps) => (
  <Svg size={size}>
    <circle cx={8} cy={8} r={3} />
    <path d="M8 1.5v1.5M8 13v1.5M1.5 8h1.5M13 8h1.5M3.3 3.3l1 1M11.7 11.7l1 1M3.3 12.7l1-1M11.7 4.3l1-1" />
  </Svg>
)
export const Moon = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M12.5 9.5A5 5 0 0 1 6.5 3.5a5.5 5.5 0 1 0 6 6z" />
  </Svg>
)
export const Drop = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M3 8.5h10M8 4v9M5 6.5l3-3 3 3" />
  </Svg>
)
export const ZoomOut = ({ size }: IconProps) => (
  <Svg size={size}>
    <circle cx={7} cy={7} r={3.75} />
    <path d="M5.25 7h3.5M9.75 9.75 13 13" />
  </Svg>
)
export const ZoomIn = ({ size }: IconProps) => (
  <Svg size={size}>
    <circle cx={7} cy={7} r={3.75} />
    <path d="M5.25 7h3.5M7 5.25v3.5M9.75 9.75 13 13" />
  </Svg>
)
export const Eye = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
    <circle cx={8} cy={8} r={1.75} />
  </Svg>
)
export const Sliders = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M3 4.5h6M11 4.5h2M3 8h2M7 8h6M3 11.5h6M11 11.5h2" />
    <circle cx={10} cy={4.5} r={1.25} />
    <circle cx={6} cy={8} r={1.25} />
    <circle cx={10} cy={11.5} r={1.25} />
  </Svg>
)
export const Redact = ({ size }: IconProps) => (
  <Svg size={size}>
    <rect x={2.5} y={5} width={11} height={6} fill="currentColor" stroke="none" />
  </Svg>
)
export const More = ({ size }: IconProps) => (
  <Svg size={size}>
    <circle cx={3.5} cy={8} r={0.75} fill="currentColor" />
    <circle cx={8} cy={8} r={0.75} fill="currentColor" />
    <circle cx={12.5} cy={8} r={0.75} fill="currentColor" />
  </Svg>
)
export const Print = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M4.5 5.5V2.5h7v3" />
    <rect x={2.5} y={5.5} width={11} height={6} />
    <rect x={4.5} y={9.5} width={7} height={4} />
  </Svg>
)
export const Check = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M3 8.5l3 3 7-7" />
  </Svg>
)
export const Trash = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M2.5 4h11M5.5 4V2.5h5V4M4 4l.5 9.5h7L12 4" />
  </Svg>
)
export const RotateCw = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M13 8a5 5 0 1 1-2-4M13 3v3h-3" />
  </Svg>
)
export const Window = ({ size }: IconProps) => (
  <Svg size={size}>
    {/* Standard application window: outer frame + title bar + a single
     *  control dot. Visually distinct from the fullscreen variant. */}
    <rect x={2.5} y={3} width={11} height={10} rx={1} />
    <path d="M2.5 5.5h11" />
    <circle cx={4.25} cy={4.25} r={0.5} fill="currentColor" stroke="none" />
  </Svg>
)
export const Fullscreen = ({ size }: IconProps) => (
  <Svg size={size}>
    {/* Four corner brackets pointing outward — universal "expand to
     *  fullscreen" glyph (matches macOS/Win11 conventions). */}
    <path d="M2.5 6V2.5h3.5M13.5 6V2.5h-3.5M2.5 10v3.5h3.5M13.5 10v3.5h-3.5" />
  </Svg>
)
export const Undo = ({ size }: IconProps) => (
  <Svg size={size}>
    {/* Counter-clockwise arc with arrowhead on the left end. */}
    <path d="M3 8a5 5 0 1 0 2-4M3 3v3h3" />
  </Svg>
)
export const Redo = ({ size }: IconProps) => (
  <Svg size={size}>
    {/* Mirror of Undo. */}
    <path d="M13 8a5 5 0 1 1-2-4M13 3v3h-3" />
  </Svg>
)

/* ─── I.* aggregate (dynamic icon lookup by string name) ─── */
export const I = {
  Satchel,
  Open,
  Save,
  Plus,
  Search,
  Sidebar,
  Close,
  Chevron,
  Hand,
  Cursor,
  Type,
  Highlight,
  Comment,
  Pen,
  Shape,
  Stamp,
  Sign,
  Lock,
  Pages,
  Tools,
  Batch,
  Insert,
  Review,
  Thumbs,
  Outline,
  Layers,
  Bookmark,
  Pin,
  HelpCircle,
  Attach,
  Sun,
  Moon,
  Drop,
  ZoomOut,
  ZoomIn,
  Eye,
  Sliders,
  Redact,
  More,
  Print,
  Check,
  Trash,
  RotateCw,
  Window,
  Fullscreen,
  Undo,
  Redo,
  FilePdf,
  FileMd,
  FileDoc,
  FileXls,
  FilePpt,
  FileImg,
  FileCode,
  FileJson,
  FileCsv,
  FileHtml,
}

export type IconName = keyof typeof I
