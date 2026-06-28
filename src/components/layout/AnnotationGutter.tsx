import { I } from '../icons'

/** Stable annotation column to the right of the page.
 *
 *  Empty shell for now — the redesign's intent is a permanent thread
 *  view (comments, replies, resolved-state) instead of floating
 *  popovers. Wiring to the existing comments store lands in a follow-up;
 *  this commit ships the toggle so users can preview the layout
 *  immediately. */
export default function AnnotationGutter() {
  return (
    <div
      style={{
        width: 'var(--gutter-w)',
        background: 'var(--bg-app)',
        borderLeft: '1px solid var(--line)',
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        overflow: 'auto',
        height: '100%',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          marginBottom: 4,
        }}
      >
        <span
          className="os-mono"
          style={{
            fontSize: 9.5,
            color: 'var(--ink-3)',
            textTransform: 'uppercase',
            letterSpacing: 0.7,
          }}
        >
          Annotations
        </span>
        <div style={{ flex: 1, height: 1, background: 'var(--line)' }} />
        <span className="os-mono" style={{ fontSize: 9.5, color: 'var(--ink-3)' }}>
          0
        </span>
      </div>

      <div
        style={{
          padding: 24,
          textAlign: 'center',
          color: 'var(--ink-3)',
          fontSize: 11,
          background: 'var(--bg-surface)',
          border: '1px dashed var(--line-strong)',
          borderRadius: 8,
          lineHeight: 1.5,
        }}
      >
        No annotations on this page yet. Highlight, comment, or stamp to
        start a thread - replies and resolves will land in this column.
      </div>

      <button
        style={{
          height: 32,
          fontSize: 11.5,
          color: 'var(--ink-3)',
          border: '1px dashed var(--line-strong)',
          borderRadius: 6,
          background: 'transparent',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          cursor: 'pointer',
          marginTop: 'auto',
        }}
      >
        <I.Plus size={11} /> Add annotation
      </button>
    </div>
  )
}
