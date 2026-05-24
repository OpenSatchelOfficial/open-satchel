// Unified click-routing primitives for the PDF editor.
//
// Modeless-editing click dispatcher.
// Today's behavior is implemented via a mix of CSS pointer-events and
// per-tool Fabric event listeners — it works but the logic is spread
// across four files. This module centralizes:
//
//   1. The tool taxonomy — which tools are "primary modes" (live-
//      editing on a document, priority-ordered), which are "drop-on-
//      click" actions (place one object and return to Select), which
//      are "drag-to-create" (repeat-friendly, tool stays active), etc.
//   2. The priority table below — for a given tool,
//      which layers get first pick at a click.
//   3. `shouldAutoRevertAfterDrop(tool)` — does this tool auto-revert
//      to Select after one use? (true for drop-on-click action tools,
//      false for primary modes and drag-to-create tools).
//
// Callers so far:
//   - FabricCanvas listens to `object:added` and flips to Select when
//     `shouldAutoRevertAfterDrop(tool)` is true. That's the Phase B
//     user-facing win — you don't get stuck in "Add Text" forever.
//   - A global Escape handler calls `shouldAutoRevertAfterDrop` plus
//     a fallthrough for drag-to-create so Escape always de-modes.
//
// The priority-ordered hit-test (`routeClick`) is scaffolded but not
// wired into the live dispatch yet — current layer interactions still
// resolve via CSS pointer-events, which happens to match the table.
// Phase C (context toolbar) will lean on `routeClick` when we need
// explicit routing (e.g. clicking a Fabric object that sits inside a
// paragraph bbox in Edit Text mode).

import type { Tool } from '../../types/pdf'

/** Logical layers that can claim a click. */
export type Layer = 'paragraph' | 'image' | 'fabric' | 'empty'

/** Tool categories — determines activation semantics. */
export type ToolCategory =
  | 'primary'         // select, edit_text — long-lived; tool only changes on explicit user action
  | 'drop'            // one click places an object → auto-revert to select
  | 'drag'            // click-and-drag creates an object → tool stays for repeat use
  | 'designer'        // specialized form-designer mode; its own UX
  | 'fill-stamp'      // Fill & Sign quick-stamps; drop-like but kept separate for color/size config

/**
 * Stable tool → category mapping. Source of truth for any UX code
 * that needs to differentiate how a tool behaves.
 */
export const TOOL_CATEGORY: Record<Tool, ToolCategory> = {
  // Primary
  select: 'primary',
  edit_text: 'primary',
  edit_image: 'primary',
  // Drop-on-click (auto-revert wins)
  text: 'drop',
  image: 'drop',
  signature: 'drop',
  sticky_note: 'drop',
  stamp: 'drop',
  // Link is drag-to-create (Acrobat-style: drag a rect, then prompt
  // URL) — classifying it as 'drop' caused object:added's auto-revert
  // timer to swap the tool to 'select' ~30ms after mousedown, which
  // stripped the Link mouse:move/mouse:up handlers mid-drag. Result:
  // only the first 2–3 mousemoves landed, rect width never reached
  // the final mouse position, prompt never fired, __linkUrl never set.
  link: 'drag',
  audio: 'drop',
  video: 'drop',
  textbox_note: 'drop',
  insert_text_marker: 'drop',
  replace_text_marker: 'drop',
  // Drag-to-create (tool persists — Acrobat-style repeat)
  draw: 'drag',
  highlight: 'drag',
  highlight_area: 'drag',
  underline: 'drag',
  strikethrough: 'drag',
  redact: 'drag',
  wipe_off: 'drag',
  shape_rect: 'drag',
  shape_circle: 'drag',
  shape_line: 'drag',
  shape_arrow: 'drag',
  measure: 'drag',
  // Designer
  form: 'designer',
  form_designer: 'designer',
  // Fill & Sign quick-stamps
  fill_cross: 'fill-stamp',
  fill_check: 'fill-stamp',
  fill_circle: 'fill-stamp',
  fill_line: 'fill-stamp',
  fill_dot: 'fill-stamp',
  fill_date: 'fill-stamp',
  fill_initials: 'fill-stamp',
  fill_timestamp: 'fill-stamp',
}

/**
 * Priority order of layers for a given tool. First entry gets first
 * chance to claim a click; if it doesn't claim (e.g. click misses the
 * layer's hit regions), the next layer is tried. The `empty` entry
 * represents "nothing under cursor" — for action tools that's where
 * the action fires.
 *
 * Central priority table for modeless click handling.
 */
export function hitTestPriority(tool: Tool): Layer[] {
  const cat = TOOL_CATEGORY[tool]
  switch (cat) {
    case 'primary':
      if (tool === 'edit_text') return ['paragraph', 'fabric', 'empty']
      if (tool === 'edit_image') return ['image', 'fabric', 'empty']
      return ['fabric', 'paragraph', 'empty']
    case 'drop':
    case 'fill-stamp':
      // Action tools: placing the object is the whole point. The
      // hit-test order matters less — any click triggers the drop.
      // Listed here for completeness.
      return ['empty', 'paragraph', 'fabric']
    case 'drag':
      // Drag-to-create: Fabric captures the drag lifecycle.
      return ['fabric', 'paragraph', 'empty']
    case 'designer':
      // Designer owns its own dispatch; nothing else wins.
      return ['fabric', 'empty', 'paragraph']
  }
}

/**
 * Whether the tool should auto-revert to `select` after its action
 * completes. True for drop-on-click action tools (one click → done).
 * False for primary modes (they never auto-revert) and drag-to-create
 * tools (user typically applies the tool repeatedly — matches Acrobat).
 *
 * Called from FabricCanvas's `object:added` listener.
 */
export function shouldAutoRevertAfterDrop(tool: Tool): boolean {
  const cat = TOOL_CATEGORY[tool]
  return cat === 'drop' || cat === 'fill-stamp'
}

/**
 * Whether pressing Escape while this tool is active should revert to
 * Select. Covers drag-to-create tools and any non-primary mode — the
 * "I'm stuck in a tool, get me back to Select" escape hatch.
 *
 * Called from a global keydown listener. Should only fire if NO
 * paragraph editor is currently active (Escape on an active paragraph
 * should reset the paragraph's text, per existing behavior).
 */
export function shouldEscapeRevertToSelect(tool: Tool): boolean {
  const cat = TOOL_CATEGORY[tool]
  return cat !== 'primary' && cat !== 'designer'
}
