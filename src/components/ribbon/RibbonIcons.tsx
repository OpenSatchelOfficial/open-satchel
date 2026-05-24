// Open Satchel — ribbon icons.
// Ported from the design package (Open Satchel Redesign v2 / icons.jsx).
// 16px grid, 1.5 stroke, currentColor — every icon picks up the button's
// color so light/dark/accent themes flow through automatically.
//
// Adding a new icon: drop a new entry in `RibbonIcons` keyed by the icon
// name. Then either pass `icon="<name>"` to RBtn, or add a label →
// iconName mapping in `LABEL_TO_ICON` so existing RBtn callsites pick it
// up without code changes.

import type React from 'react'

interface IconProps {
  size?: number
  className?: string
}

const Svg = ({ size = 16, children, className }: IconProps & { children: React.ReactNode }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="square"
    strokeLinejoin="miter"
    style={{ flexShrink: 0, display: 'block' }}
    className={className}
    aria-hidden="true"
  >
    {children}
  </svg>
)

export const RibbonIcons: Record<string, React.FC<IconProps>> = {
  /* ─── Brand mark — "Satchel" ─── */
  Satchel: ({ size = 16 }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.6 4.2 h4.8 l1.6 1.6 v6.0 a.6 .6 0 0 1 -.6 .6 h-5.8 a.6 .6 0 0 1 -.6 -.6 v-7.0 a.6 .6 0 0 1 .6 -.6 z"
            transform="rotate(-12 5.5 8.5)"
            stroke="currentColor" strokeWidth={1.1} strokeLinejoin="round" fill="var(--bg-surface, #fff)" opacity={0.85}/>
      <path d="M5.6 3.6 h4.8 l1.6 1.6 v6.0 a.6 .6 0 0 1 -.6 .6 h-5.8 a.6 .6 0 0 1 -.6 -.6 v-7.0 a.6 .6 0 0 1 .6 -.6 z"
            transform="rotate(10 8.5 8)"
            stroke="currentColor" strokeWidth={1.1} strokeLinejoin="round" fill="var(--bg-surface, #fff)"/>
      <path d="M4.0 4.4 h4.8 l1.8 1.8 v5.8 a.6 .6 0 0 1 -.6 .6 h-6.0 a.6 .6 0 0 1 -.6 -.6 v-7.0 a.6 .6 0 0 1 .6 -.6 z"
            stroke="currentColor" strokeWidth={1.2} strokeLinejoin="round" fill="var(--bg-surface, #fff)"/>
      <path d="M8.8 4.4 v1.8 h1.8" stroke="currentColor" strokeWidth={1.1} strokeLinejoin="round" fill="none"/>
      <path d="M5.2 9.6 h4.0" stroke="currentColor" strokeWidth={1.1} strokeLinecap="round"/>
      <path d="M11.4 1.6 l2.0 2.0 -3.8 3.8 -2.2 .2 .2 -2.2 z"
            fill="var(--accent)" stroke="var(--bg-surface, #fff)" strokeWidth={0.7} strokeLinejoin="round"/>
    </svg>
  ),

  /* ─── App-shell ─── */
  Open: (p) => <Svg {...p}><path d="M2.5 4.5h4l1.5 1.5h5.5v6.5a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V4.5z" /><path d="M2.5 7h11" /></Svg>,
  Save: (p) => <Svg {...p}><path d="M3 2.5h8.5L13.5 4.5V13a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5z" /><path d="M5 2.5v3h5v-3" /><path d="M5 13.5v-4h6v4" /></Svg>,
  Plus: (p) => <Svg {...p}><path d="M8 3.5v9M3.5 8h9" /></Svg>,
  Search: (p) => <Svg {...p}><circle cx="7" cy="7" r="3.75" /><path d="M9.75 9.75 13 13" /></Svg>,
  Sidebar: (p) => <Svg {...p}><rect x="2.5" y="3" width="11" height="10" rx="1" /><path d="M6 3v10" /></Svg>,
  Close: (p) => <Svg {...p}><path d="M4 4l8 8M12 4l-8 8" /></Svg>,
  Chevron: (p) => <Svg {...p}><path d="M4 6l4 4 4-4" /></Svg>,

  /* ─── Tool primitives ─── */
  Hand: (p) => <Svg {...p}><path d="M5.5 8V4.25a.75.75 0 0 1 1.5 0V8m0 0V3.25a.75.75 0 0 1 1.5 0V8m0 0V3.75a.75.75 0 0 1 1.5 0V8m0 0V5.25a.75.75 0 0 1 1.5 0V10c0 2-1.5 3.5-3.5 3.5S5 12.5 5 11l-1.5-2.5a.75.75 0 0 1 1.25-.75L5.5 9" /></Svg>,
  Cursor: (p) => <Svg {...p}><path d="M3.5 2.5l3 10 1.5-3.5 3.5-1.5z" /></Svg>,
  Type: (p) => <Svg {...p}><path d="M3.5 4.5V3.5h9v1M8 3.5v9M6 12.5h4" /></Svg>,
  Highlight: (p) => <Svg {...p}><path d="M3 13.5h10" /><path d="M5 11.5l1-3.5 4-4 2.5 2.5-4 4-3.5 1z" /></Svg>,
  Comment: (p) => <Svg {...p}><path d="M2.5 3.5h11v7H7l-2.5 2.5v-2.5h-2z" /></Svg>,
  Pen: (p) => <Svg {...p}><path d="M2.5 13.5l1-3 7-7 2 2-7 7z" /><path d="M9.5 4.5l2 2" /></Svg>,
  Shape: (p) => <Svg {...p}><rect x="2.5" y="2.5" width="6" height="6" /><circle cx="10.5" cy="10.5" r="3" /></Svg>,
  Stamp: (p) => <Svg {...p}><path d="M5 8.5V6a3 3 0 0 1 6 0v2.5" /><rect x="3" y="8.5" width="10" height="2.5" /><path d="M3.5 13.5h9" /></Svg>,
  Sign: (p) => <Svg {...p}><path d="M2.5 11.5c1.5 0 2.5-7 4-7s.5 6 2 6 1.5-3.5 3-3.5 1 3 2 3" /><path d="M2.5 13.5h11" /></Svg>,
  Lock: (p) => <Svg {...p}><rect x="3.5" y="7" width="9" height="6.5" rx="1" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></Svg>,
  Pages: (p) => <Svg {...p}><rect x="2.5" y="3" width="6" height="8" /><rect x="6.5" y="5" width="7" height="8" /></Svg>,
  Tools: (p) => <Svg {...p}><path d="M10 2.5l3.5 3.5-1.5 1.5-3.5-3.5z" /><path d="M9 4.5L3 10.5l-.5 2.5 2.5-.5L11 6.5" /></Svg>,
  Batch: (p) => <Svg {...p}><rect x="2.5" y="2.5" width="6" height="6" /><rect x="7.5" y="7.5" width="6" height="6" /><path d="M8.5 4.5h2v2" /></Svg>,
  Insert: (p) => <Svg {...p}><rect x="2.5" y="3" width="11" height="10" /><path d="M8 6v4M6 8h4" /></Svg>,
  Review: (p) => <Svg {...p}><path d="M3 3.5h10v7H8L5 13v-2.5H3z" /><path d="M5.5 6h5M5.5 8h3" /></Svg>,

  /* ─── Format glyphs ─── */
  FilePdf: (p) => <Svg {...p}><path d="M3.5 2h6L12.5 5v9a.5.5 0 0 1-.5.5H3.5A.5.5 0 0 1 3 14V2.5a.5.5 0 0 1 .5-.5z" /><path d="M9.5 2v3H12.5" /><path d="M5 8.5v3M5 8.5h1.25a.75.75 0 0 1 0 1.5H5M8 11.5v-3h.75A.75.75 0 0 1 9.5 9.25v1.5a.75.75 0 0 1-.75.75H8m2.5 0v-3h1.5m-1.5 1.5h1" strokeWidth={1} /></Svg>,
  FileMd: (p) => <Svg {...p}><path d="M3.5 2h6L12.5 5v9a.5.5 0 0 1-.5.5H3.5A.5.5 0 0 1 3 14V2.5a.5.5 0 0 1 .5-.5z" /><path d="M9.5 2v3H12.5" /><path d="M4.5 11.5v-3l1.25 1.5L7 8.5v3M9 8.5v3m0-3 1 1.25L11 8.5v3" strokeWidth={1} /></Svg>,
  FileDoc: (p) => <Svg {...p}><path d="M3.5 2h6L12.5 5v9a.5.5 0 0 1-.5.5H3.5A.5.5 0 0 1 3 14V2.5a.5.5 0 0 1 .5-.5z" /><path d="M9.5 2v3H12.5" /><path d="M5 9h6M5 11h4" /></Svg>,
  FileXls: (p) => <Svg {...p}><path d="M3.5 2h6L12.5 5v9a.5.5 0 0 1-.5.5H3.5A.5.5 0 0 1 3 14V2.5a.5.5 0 0 1 .5-.5z" /><path d="M9.5 2v3H12.5" /><path d="M5 8.5h6M5 10.5h6M7.5 8.5v3.5" /></Svg>,
  FilePpt: (p) => <Svg {...p}><path d="M3.5 2h6L12.5 5v9a.5.5 0 0 1-.5.5H3.5A.5.5 0 0 1 3 14V2.5a.5.5 0 0 1 .5-.5z" /><path d="M9.5 2v3H12.5" /><rect x="5" y="8.5" width="6" height="3.5" /></Svg>,
  FileImg: (p) => <Svg {...p}><path d="M3.5 2h6L12.5 5v9a.5.5 0 0 1-.5.5H3.5A.5.5 0 0 1 3 14V2.5a.5.5 0 0 1 .5-.5z" /><path d="M9.5 2v3H12.5" /><circle cx="6" cy="9.5" r=".75" /><path d="M5 12.5l2-2 2 1.5 2-2.5" /></Svg>,
  FileCode: (p) => <Svg {...p}><path d="M3.5 2h6L12.5 5v9a.5.5 0 0 1-.5.5H3.5A.5.5 0 0 1 3 14V2.5a.5.5 0 0 1 .5-.5z" /><path d="M9.5 2v3H12.5" /><path d="M6.5 9 5 10.5l1.5 1.5M9.5 9l1.5 1.5L9.5 12" /></Svg>,
  FileJson: (p) => <Svg {...p}><path d="M3.5 2h6L12.5 5v9a.5.5 0 0 1-.5.5H3.5A.5.5 0 0 1 3 14V2.5a.5.5 0 0 1 .5-.5z" /><path d="M9.5 2v3H12.5" /><path d="M6.5 8.5c-1 0-1 1.5-1 2 0 1-1 1-1 1 0 0 1 0 1 1 0 .5 0 2 1 2M9.5 8.5c1 0 1 1.5 1 2 0 1 1 1 1 1 0 0-1 0-1 1 0 .5 0 2-1 2" /></Svg>,
  FileCsv: (p) => <Svg {...p}><path d="M3.5 2h6L12.5 5v9a.5.5 0 0 1-.5.5H3.5A.5.5 0 0 1 3 14V2.5a.5.5 0 0 1 .5-.5z" /><path d="M9.5 2v3H12.5" /><path d="M5 8.5v4M5 8.5h6M5 10.5h6M7.5 8.5v4M9.75 8.5v4" /></Svg>,
  FileHtml: (p) => <Svg {...p}><path d="M3.5 2h6L12.5 5v9a.5.5 0 0 1-.5.5H3.5A.5.5 0 0 1 3 14V2.5a.5.5 0 0 1 .5-.5z" /><path d="M9.5 2v3H12.5" /><path d="M5.5 9 4 10.5l1.5 1.5M10.5 9 12 10.5l-1.5 1.5M9 8.5l-2 4" /></Svg>,

  /* ─── Sidebar nav ─── */
  Thumbs: (p) => <Svg {...p}><rect x="2.5" y="2.5" width="4.5" height="5" /><rect x="9" y="2.5" width="4.5" height="5" /><rect x="2.5" y="8.5" width="4.5" height="5" /><rect x="9" y="8.5" width="4.5" height="5" /></Svg>,
  Outline: (p) => <Svg {...p}><path d="M2.5 4h11M5 7.5h8.5M5 11h8.5M2.5 7.5h.5M2.5 11h.5" /></Svg>,
  Layers: (p) => <Svg {...p}><path d="M8 2.5l5.5 3L8 8.5l-5.5-3z" /><path d="M2.5 8.5L8 11.5l5.5-3" /><path d="M2.5 11.5L8 14.5l5.5-3" /></Svg>,
  Bookmark: (p) => <Svg {...p}><path d="M4 2.5h8v11l-4-2.5-4 2.5z" /></Svg>,
  Attach: (p) => <Svg {...p}><path d="M11.5 5.5L6 11a2 2 0 0 1-2.83-2.83L8.5 2.83a3 3 0 0 1 4.24 4.24L7.5 12.5" /></Svg>,

  /* ─── Status / system ─── */
  Sun: (p) => <Svg {...p}><circle cx="8" cy="8" r="3" /><path d="M8 1.5v1.5M8 13v1.5M1.5 8h1.5M13 8h1.5M3.3 3.3l1 1M11.7 11.7l1 1M3.3 12.7l1-1M11.7 4.3l1-1" /></Svg>,
  Moon: (p) => <Svg {...p}><path d="M12.5 9.5A5 5 0 0 1 6.5 3.5a5.5 5.5 0 1 0 6 6z" /></Svg>,
  Dot: (p) => <Svg {...p}><circle cx="8" cy="8" r="2" fill="currentColor" stroke="none" /></Svg>,
  Drag: (p) => <Svg {...p}><circle cx="6" cy="4" r=".5" fill="currentColor" /><circle cx="10" cy="4" r=".5" fill="currentColor" /><circle cx="6" cy="8" r=".5" fill="currentColor" /><circle cx="10" cy="8" r=".5" fill="currentColor" /><circle cx="6" cy="12" r=".5" fill="currentColor" /><circle cx="10" cy="12" r=".5" fill="currentColor" /></Svg>,
  Drop: (p) => <Svg {...p}><path d="M3 8.5h10M8 4v9M5 6.5l3-3 3 3" /></Svg>,
  ZoomOut: (p) => <Svg {...p}><circle cx="7" cy="7" r="3.75" /><path d="M5.25 7h3.5M9.75 9.75 13 13" /></Svg>,
  ZoomIn: (p) => <Svg {...p}><circle cx="7" cy="7" r="3.75" /><path d="M5.25 7h3.5M7 5.25v3.5M9.75 9.75 13 13" /></Svg>,
  Print: (p) => <Svg {...p}><path d="M4.5 5.5V2.5h7v3" /><rect x="2.5" y="5.5" width="11" height="6" /><rect x="4.5" y="9.5" width="7" height="4" /></Svg>,
  Eye: (p) => <Svg {...p}><path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" /><circle cx="8" cy="8" r="1.75" /></Svg>,
  Trash: (p) => <Svg {...p}><path d="M2.5 4h11M5.5 4V2.5h5V4M4 4l.5 9.5h7L12 4" /></Svg>,
  Check: (p) => <Svg {...p}><path d="M3 8.5l3 3 7-7" /></Svg>,
  More: (p) => <Svg {...p}><circle cx="3.5" cy="8" r=".75" fill="currentColor" /><circle cx="8" cy="8" r=".75" fill="currentColor" /><circle cx="12.5" cy="8" r=".75" fill="currentColor" /></Svg>,
  RotateCw: (p) => <Svg {...p}><path d="M13 8a5 5 0 1 1-2-4M13 3v3h-3" /></Svg>,
  Sliders: (p) => <Svg {...p}><path d="M3 4.5h6M11 4.5h2M3 8h2M7 8h6M3 11.5h6M11 11.5h2" /><circle cx="10" cy="4.5" r="1.25" /><circle cx="6" cy="8" r="1.25" /><circle cx="10" cy="11.5" r="1.25" /></Svg>,

  /* ─── Extended PDF tools ─── */
  Image: (p) => <Svg {...p}><rect x="2.5" y="3" width="11" height="10" /><circle cx="6" cy="6.5" r="1" /><path d="M3 12.5l3-3 3 2.5 2-2 2.5 2.5" /></Svg>,
  Link: (p) => <Svg {...p}><path d="M7 9l2-2M6.5 11.5L5 13a2.5 2.5 0 0 1-3.5-3.5L3 8M9.5 4.5 11 3a2.5 2.5 0 0 1 3.5 3.5L13 8" /></Svg>,
  Audio: (p) => <Svg {...p}><path d="M4 6h2l3-2.5v9L6 10H4z" /><path d="M11 6.5c.7.5.7 2.5 0 3" /></Svg>,
  Video: (p) => <Svg {...p}><rect x="2.5" y="4" width="8" height="8" /><path d="M10.5 7l3-1.5v5L10.5 9z" /></Svg>,
  Underline: (p) => <Svg {...p}><path d="M5 3.5v5a3 3 0 0 0 6 0v-5M3.5 13h9" /></Svg>,
  Strike: (p) => <Svg {...p}><path d="M2.5 8h11" /><path d="M5 5.5a2.5 2 0 0 1 2.5-2h2M11 10.5a2.5 2 0 0 1-2.5 2h-2" /></Svg>,
  Replace: (p) => <Svg {...p}><path d="M3 5h7l-2-2M13 11H6l2 2" /></Svg>,
  Eraser: (p) => <Svg {...p}><path d="M9 2.5l4 4-6.5 6.5h-4l-1-1z" /><path d="M5.5 6l4 4" /></Svg>,
  Redact: (p) => <Svg {...p}><rect x="2.5" y="5" width="11" height="6" fill="currentColor" stroke="none" /></Svg>,
  Measure: (p) => <Svg {...p}><path d="M2 9.5l1.5-1.5 1 1 1.5-1.5 1 1 1.5-1.5 1 1 1.5-1.5 1 1L13 5l1 1-7 7-5-5z" /></Svg>,
  Speaker: (p) => <Svg {...p}><path d="M3 6h2l3-2.5v9L5 10H3z" /><path d="M10 5.5c1.5 1 1.5 4 0 5M11.5 4c2.5 1.5 2.5 6.5 0 8" /></Svg>,
  Ocr: (p) => <Svg {...p}><path d="M2.5 5V3.5h3M13.5 5V3.5h-3M2.5 11v1.5h3M13.5 11v1.5h-3" /><path d="M5 7.5h6M5 9.5h4" /></Svg>,
  Compare: (p) => <Svg {...p}><rect x="2.5" y="3" width="5" height="10" /><rect x="8.5" y="3" width="5" height="10" /><path d="M5 6h0M11 6h0M5 9h0M11 9h0" strokeWidth={2} /></Svg>,
  X: (p) => <Svg {...p}><path d="M4 4l8 8M12 4l-8 8" /></Svg>,
  Circle: (p) => <Svg {...p}><circle cx="8" cy="8" r="4.5" /></Svg>,
  Minus: (p) => <Svg {...p}><path d="M3 8h10" /></Svg>,
  Date: (p) => <Svg {...p}><rect x="2.5" y="3.5" width="11" height="9.5" /><path d="M2.5 6h11M5 2.5v2M11 2.5v2" /></Svg>,
  Certify: (p) => <Svg {...p}><path d="M8 1.5l1.5 2 2.5-.5-.5 2.5 2 1.5-2 1.5.5 2.5-2.5-.5L8 12l-1.5-2-2.5.5.5-2.5-2-1.5 2-1.5-.5-2.5 2.5.5z" /><path d="M6 7.5l1.5 1.5L10 6.5" /></Svg>,
  Watermark: (p) => <Svg {...p}><rect x="2.5" y="3" width="11" height="10" /><path d="M5 11l6-6" strokeOpacity={0.5} /><path d="M6 9.5l4-4" strokeOpacity={0.4} /></Svg>,
  Merge: (p) => <Svg {...p}><path d="M4 2.5v3a3 3 0 0 0 3 3h3M12 2.5v3a3 3 0 0 1-3 3H6M8 8.5v5M5.5 11l2.5 2.5L10.5 11" /></Svg>,
  Split: (p) => <Svg {...p}><path d="M8 2.5v5M5.5 5l2.5-2.5L10.5 5M4 13.5v-3a3 3 0 0 1 3-3h3M12 13.5v-3a3 3 0 0 0-3-3H6" /></Svg>,
  Resize: (p) => <Svg {...p}><path d="M3 6V3h3M13 10v3h-3M3 3l4 4M13 13l-4-4" /></Svg>,
  Crop: (p) => <Svg {...p}><path d="M4.5 2v9.5h9M2 4.5h9.5V14" /></Svg>,
  Info: (p) => <Svg {...p}><circle cx="8" cy="8" r="5.5" /><path d="M8 7v4M8 5v.5" /></Svg>,
  Audit: (p) => <Svg {...p}><rect x="2.5" y="2.5" width="11" height="11" /><path d="M5 11V8M8 11V5M11 11V9.5" /></Svg>,
  Compress: (p) => <Svg {...p}><path d="M3 5l3-3v6H2.5M13 11l-3 3V8h3.5M2.5 8h11" /></Svg>,
  Snip: (p) => <Svg {...p}><circle cx="5" cy="5" r="1.5" /><circle cx="5" cy="11" r="1.5" /><path d="M6.5 5L13 11M6.5 11L13 5" /></Svg>,
  Ruler: (p) => <Svg {...p}><path d="M2 9l7-7 5 5-7 7z" /><path d="M5 5l1 1M7 7l1 1M9 9l1 1M4 7l1 1M6 9l1 1M8 11l1 1" /></Svg>,
  Grid: (p) => <Svg {...p}><rect x="2.5" y="2.5" width="11" height="11" /><path d="M2.5 6h11M2.5 9.5h11M6 2.5v11M9.5 2.5v11" /></Svg>,
  Snap: (p) => <Svg {...p}><path d="M2.5 5.5h2.5v-3M13.5 5.5H11v-3M2.5 10.5h2.5v3M13.5 10.5H11v3" /><path d="M8 6v4M6 8h4" /></Svg>,
  Scroll: (p) => <Svg {...p}><rect x="5.5" y="2.5" width="5" height="11" rx="2" /><path d="M8 5v2.5" /></Svg>,
  Wizard: (p) => <Svg {...p}><path d="M11 3l1 1M13 5l1 1M3 13l8-8" /><path d="M2 11l1.5-.5.5-1.5.5 1.5L6 11l-1.5.5-.5 1.5-.5-1.5z" /></Svg>,
  Watch: (p) => <Svg {...p}><path d="M2.5 4.5h4l1.5 1.5h5.5v6.5a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V4.5z" /><circle cx="8" cy="9" r="1.5" /></Svg>,
}

/**
 * Map ribbon button labels (text) to RibbonIcons keys. Keeps the existing
 * RBtn callsites in PdfToolbar.tsx untouched — RBtn auto-resolves the
 * icon from the label. Any label that lacks an entry here renders as
 * text-only (the previous behaviour).
 *
 * Naming conventions in the design (chat1.md): per-group rebuild based on
 * `PdfToolbar.tsx`. Mappings below mirror the design's tools.jsx pairs.
 */
export const LABEL_TO_ICON: Record<string, string> = {
  // Home — Select
  'Select': 'Cursor',
  'Read mode': 'Eye',
  // Home — Text
  'Edit Text': 'Type',
  'Edit Image': 'Image',
  'Add Text': 'Type',
  // Home — Draw / Sign
  'Freehand': 'Pen',
  'Signature': 'Sign',
  'Add Signature': 'Sign',
  'Add Initials': 'Stamp',
  // Insert
  'Image': 'Image',
  'Sticky Note': 'Comment',
  'Headers & Footers': 'Pages',
  'Page Numbers': 'Pages',
  'Bates': 'Pages',
  'Bates Numbers': 'Pages',
  'Rectangle': 'Shape',
  'Ellipse': 'Shape',
  'Line': 'Minus',
  'Arrow': 'Shape',
  'Approved': 'Stamp',
  'Draft': 'Stamp',
  'Confidential': 'Stamp',
  'Reviewed': 'Stamp',
  'Void': 'Stamp',
  'Custom…': 'Plus',
  'Link': 'Link',
  'Edit Links': 'Link',
  'Named Dests': 'Bookmark',
  'Audio': 'Audio',
  'Video': 'Video',
  // Annotate
  'Highlight': 'Highlight',
  'Highlight Area': 'Highlight',
  'Area Hi-lite': 'Highlight',
  'Underline': 'Underline',
  'Strikethrough': 'Strike',
  'Text Box': 'Comment',
  'Insert Text': 'Insert',
  'Replace Text': 'Replace',
  'Wipe Off': 'Eraser',
  'Redact': 'Redact',
  'Measure': 'Measure',
  'Hide Annot.': 'Eye',
  'Comments': 'Comment',
  // Review
  'Search': 'Search',
  'Find & Replace': 'Search',
  'Spell Check': 'Check',
  'Read Aloud': 'Speaker',
  'Print': 'Print',
  'OCR': 'Ocr',
  'Compare Docs': 'Compare',
  'Compare Report': 'Review',
  // Fill & Sign
  'Text Comment': 'Comment',
  'Cross': 'X',
  'Check': 'Check',
  'Circle': 'Circle',
  'Dot': 'Dot',
  'Add Picture': 'Image',
  'Add Date': 'Date',
  'Sign & Certify': 'Certify',
  'Verify Signatures': 'Check',
  'Verify Sigs': 'Check',
  // Protect
  'Add Watermark': 'Watermark',
  'Password Protect': 'Lock',
  'Encrypt to Certs': 'Lock',
  'Time Stamp': 'Date',
  // Pages
  'Page Manager': 'Pages',
  'Rotate': 'RotateCw',
  'Merge PDFs': 'Merge',
  'Split PDF': 'Split',
  'Page Size': 'Resize',
  'Crop Pages': 'Crop',
  'Page Labels': 'Pages',
  // Tools — Advanced
  'Advanced Tools…': 'Sliders',
  'Advanced…': 'Sliders',
  'Properties': 'Info',
  'Initial View…': 'Eye',
  'Initial View': 'Eye',
  'Audit Size': 'Audit',
  'Layers (OCG)': 'Layers',
  // Tools — Document
  'PDF Compressor': 'Compress',
  'Merge PDF': 'Merge',
  // Tools — Text / Capture
  'Extract Text': 'Type',
  'Snip & Pin': 'Snip',
  'Snip and Pin': 'Snip',
  // Tools — Images
  'Extract Images': 'Image',
  'Replace Image': 'Image',
  // Tools — Forms
  'Form Designer': 'Insert',
  'Auto-detect Fields': 'Insert',
  'Auto-detect': 'Insert',
  'Form Place': 'Insert',
  'Form Place Tool': 'Insert',
  // Tools — Layout
  'Rulers': 'Ruler',
  'Grid': 'Grid',
  'Snap': 'Snap',
  'Layers': 'Layers',
  // Tools — View
  'Auto Scroll': 'Scroll',
  'Eye Protection': 'Eye',
  // Tools — Fonts
  'Import Font': 'Plus',
  // Batch
  'Action Wizard': 'Wizard',
  'PDF → Word': 'FileDoc',
  'PDF → PPT': 'FilePpt',
  'PDF → Excel': 'FileXls',
  'Image-only PDF': 'FileImg',
  'To Image-only PDF': 'FileImg',
  'Compress': 'Compress',
  'Batch Print': 'Print',
  'Batch PDF Printing': 'Print',
  'Batch Rename': 'Batch',
  'Batch Rename Files': 'Batch',
  'Batch OCR': 'Ocr',
  'File Collect': 'Batch',
  'Watched Folders': 'Watch',
}

export function lookupIcon(label: string): React.FC<IconProps> | null {
  const key = LABEL_TO_ICON[label]
  if (!key) return null
  return RibbonIcons[key] ?? null
}
