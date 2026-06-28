import { useEffect, useState, type CSSProperties } from 'react'
import Logo from './Logo'

interface Step {
  /** Heading shown in the tooltip card. */
  title: string
  /** Body copy. Plain string; line breaks via \n. */
  body: string
  /** Optional shortcut hint shown as a kbd row at the bottom. */
  shortcut?: string
  /** CSS selector for the element to highlight. The tour cuts a
   *  spotlight hole in the dim overlay around this element's bbox.
   *  If null/missing, the card centers in the viewport (welcome /
   *  goodbye steps). */
  target?: string
}

const TOUR_KEY = 'open-satchel:onboarding-tour-completed'

const STEPS: Step[] = [
  {
    title: 'Welcome to Open Satchel',
    body: 'Quick tour - 5 steps, ~30 seconds. You can skip anytime; the tour won\'t auto-replay.',
  },
  {
    title: 'Open a PDF to get started',
    body: 'Drop a file on this zone, or click to browse. The drop zone tracks the rest of the editor; once a PDF is open, ribbons + sidebars surface around the page.',
    shortcut: 'Ctrl+O',
    target: '[data-testid="empty-state-drop"]',
  },
  {
    title: 'Edit text directly on the page',
    body: 'Click any paragraph in the open PDF to edit it inline - Acrobat-style. The mini-toolbar that pops up has alignment, font size, font family, line spacing, and color.',
  },
  {
    title: 'Customize keyboard shortcuts',
    body: 'Open Preferences (top-right gear) → Customize… to remap any global shortcut. Save, Find, Replace, Command Palette - all rebindable.',
    target: '[data-testid="prefs-open-shortcuts"]',
  },
  {
    title: 'Local-first, no cloud',
    body: 'Everything stays on your machine. No account. No telemetry. AGPL source. Audit the binary yourself - see docs/AIRGAP-AUDIT.md and the SBOM.',
  },
]

/** First-launch onboarding tour. Auto-shows once if no recents are
 *  present in localStorage; thereafter the user can re-open via the
 *  '?' button in the toolbar. Each step has an optional CSS selector
 *  that cuts a spotlight hole around the highlighted UI element. */
export default function OnboardingTour({ onClose }: { onClose: () => void }) {
  const [stepIdx, setStepIdx] = useState(0)
  const step = STEPS[stepIdx]
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null)

  // Resolve the spotlight target rect on every step change. Window
  // resize re-resolves so the spotlight tracks layout shifts.
  useEffect(() => {
    if (!step.target) {
      setTargetRect(null)
      return
    }
    const resolve = () => {
      const el = document.querySelector(step.target!)
      if (el instanceof HTMLElement) {
        setTargetRect(el.getBoundingClientRect())
      } else {
        setTargetRect(null)
      }
    }
    resolve()
    window.addEventListener('resize', resolve)
    return () => window.removeEventListener('resize', resolve)
  }, [step.target])

  // Esc skips the tour.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        finish()
      } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
        next()
      } else if (e.key === 'ArrowLeft') {
        prev()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const finish = () => {
    try {
      localStorage.setItem(TOUR_KEY, '1')
    } catch {
      /* private mode */
    }
    onClose()
  }

  const next = () => {
    if (stepIdx + 1 >= STEPS.length) {
      finish()
    } else {
      setStepIdx(stepIdx + 1)
    }
  }
  const prev = () => {
    if (stepIdx > 0) setStepIdx(stepIdx - 1)
  }

  // Card position: under the spotlight target if there's room, else
  // centered. Card is 320×auto.
  const CARD_W = 320
  let cardLeft: number
  let cardTop: number
  if (targetRect) {
    cardLeft = Math.max(16, Math.min(window.innerWidth - CARD_W - 16, targetRect.left + targetRect.width / 2 - CARD_W / 2))
    // Place under the target by default; if it'd overflow, place above.
    const wantBelow = targetRect.bottom + 200 < window.innerHeight
    cardTop = wantBelow ? targetRect.bottom + 12 : Math.max(16, targetRect.top - 200)
  } else {
    cardLeft = window.innerWidth / 2 - CARD_W / 2
    cardTop = window.innerHeight / 2 - 100
  }

  return (
    <>
      {/* Backdrop with optional spotlight cutout. The cutout is two
          rect-cliprule overlays — top/bottom/left/right of the target.
          When no target, just a uniform dim. */}
      {targetRect ? (
        <SpotlightBackdrop rect={targetRect} onClick={finish} />
      ) : (
        <div
          onClick={finish}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.6)',
            zIndex: 1000,
          }}
        />
      )}

      <div
        data-testid="onboarding-card"
        style={{
          position: 'fixed',
          left: cardLeft,
          top: cardTop,
          width: CARD_W,
          background: 'var(--bg-surface)',
          border: '1px solid var(--line-strong)',
          borderRadius: 12,
          boxShadow: '0 12px 48px rgba(0, 0, 0, 0.55)',
          zIndex: 1001,
          padding: '16px 18px 12px',
        }}
      >
        {/* Step counter / brand */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 10,
          }}
        >
          <span style={{ color: 'var(--accent)', display: 'inline-flex' }}>
            <Logo size={14} />
          </span>
          <span
            className="os-mono"
            style={{
              fontSize: 9.5,
              color: 'var(--ink-3)',
              letterSpacing: 0.7,
              textTransform: 'uppercase',
            }}
          >
            Step {stepIdx + 1} / {STEPS.length}
          </span>
        </div>

        {/* Title */}
        <div
          className="os-serif"
          style={{
            fontSize: 16,
            fontWeight: 500,
            letterSpacing: -0.2,
            color: 'var(--ink)',
            marginBottom: 6,
          }}
        >
          {step.title}
        </div>

        {/* Body */}
        <div
          style={{
            fontSize: 12,
            color: 'var(--ink-2)',
            lineHeight: 1.5,
            whiteSpace: 'pre-line',
          }}
        >
          {step.body}
        </div>

        {/* Shortcut chip */}
        {step.shortcut && (
          <div style={{ marginTop: 10, display: 'flex', gap: 4, alignItems: 'center' }}>
            <span style={{ fontSize: 10.5, color: 'var(--ink-3)' }}>Shortcut:</span>
            {step.shortcut.split('+').map((part, i, arr) => (
              <span key={i} style={{ display: 'inline-flex', alignItems: 'center' }}>
                <kbd
                  style={{
                    fontFamily: '"JetBrains Mono", monospace',
                    fontSize: 9.5,
                    padding: '2px 6px',
                    background: 'var(--bg-sunken)',
                    border: '1px solid var(--line)',
                    borderRadius: 3,
                    color: 'var(--ink-2)',
                  }}
                >
                  {part}
                </kbd>
                {i < arr.length - 1 && <span style={{ margin: '0 2px', fontSize: 10, color: 'var(--ink-3)' }}>+</span>}
              </span>
            ))}
          </div>
        )}

        {/* Footer: navigation + skip */}
        <div
          style={{
            marginTop: 14,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            justifyContent: 'space-between',
          }}
        >
          <button
            data-testid="onboarding-skip"
            onClick={finish}
            style={{
              padding: '4px 10px',
              fontSize: 11,
              color: 'var(--ink-3)',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            Skip tour
          </button>
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              data-testid="onboarding-prev"
              onClick={prev}
              disabled={stepIdx === 0}
              style={{
                padding: '5px 12px',
                fontSize: 11,
                background: 'var(--bg-surface)',
                color: 'var(--ink-2)',
                border: '1px solid var(--line)',
                borderRadius: 4,
                cursor: stepIdx === 0 ? 'not-allowed' : 'pointer',
                opacity: stepIdx === 0 ? 0.4 : 1,
              }}
            >
              Back
            </button>
            <button
              data-testid="onboarding-next"
              onClick={next}
              style={{
                padding: '5px 14px',
                fontSize: 11,
                fontWeight: 600,
                background: 'var(--accent)',
                color: 'var(--bg-primary)',
                border: 'none',
                borderRadius: 4,
                cursor: 'pointer',
              }}
            >
              {stepIdx + 1 >= STEPS.length ? 'Done' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

/** Should the tour auto-show on this launch? True when:
 *  - the user has never completed it (no flag in localStorage), AND
 *  - this is a fresh install (no recents). The two-condition guard
 *  prevents replay for an existing user who clears recents. */
export function shouldAutoShowTour(recentCount: number): boolean {
  try {
    if (localStorage.getItem(TOUR_KEY)) return false
  } catch {
    return false
  }
  return recentCount === 0
}

/** Allow the tour to be triggered manually (via a help button)
 *  even after it's been completed once. Clears the flag. */
export function resetTourCompletion(): void {
  try {
    localStorage.removeItem(TOUR_KEY)
  } catch {
    /* private mode */
  }
}

/** Backdrop with a spotlight cutout — four rectangles around the
 *  highlighted element so it stays bright while everything else is
 *  dimmed. Click outside finishes the tour. */
function SpotlightBackdrop({ rect, onClick }: { rect: DOMRect; onClick: () => void }) {
  const dim: CSSProperties = {
    position: 'fixed',
    background: 'rgba(0, 0, 0, 0.6)',
    zIndex: 1000,
    cursor: 'pointer',
  }
  // Four pieces around the spotlight: top, bottom, left, right.
  return (
    <>
      <div onClick={onClick} style={{ ...dim, top: 0, left: 0, right: 0, height: rect.top - 4 }} />
      <div
        onClick={onClick}
        style={{
          ...dim,
          top: rect.bottom + 4,
          left: 0,
          right: 0,
          bottom: 0,
        }}
      />
      <div onClick={onClick} style={{ ...dim, top: rect.top - 4, left: 0, width: rect.left - 4, height: rect.height + 8 }} />
      <div
        onClick={onClick}
        style={{
          ...dim,
          top: rect.top - 4,
          left: rect.right + 4,
          right: 0,
          height: rect.height + 8,
        }}
      />
      {/* Bright outline around the spotlight so it's clearly the
          subject of attention. */}
      <div
        style={{
          position: 'fixed',
          left: rect.left - 4,
          top: rect.top - 4,
          width: rect.width + 8,
          height: rect.height + 8,
          border: '2px solid var(--accent)',
          borderRadius: 8,
          zIndex: 1000,
          pointerEvents: 'none',
        }}
      />
    </>
  )
}
