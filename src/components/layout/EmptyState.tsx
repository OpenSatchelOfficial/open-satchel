import { useEffect, useState, type CSSProperties } from 'react'
import { recentApi, pinnedApi, folderFavoritesApi, dirnameOf, fileApi, type RecentEntry } from '../../lib/ipc'
import { openFile, openFromPath } from '../../lib/actions'
import { I, type IconName } from '../icons'
import Logo from '../Logo'
import OnboardingTour, { shouldAutoShowTour } from '../OnboardingTour'
import { getEffectiveBinding, formatBinding } from '../../lib/shortcuts'
import { t } from '../../lib/i18n'
import { useLocale } from '../../hooks/useLocale'

/** Empty state — hero + drop zone + recents grid + format support row +
 *  ethos footer. The page sits inside an `os-paper-grain` wash so the
 *  warm-paper light theme has texture; dark theme renders the same
 *  layout against a deep ink wash.
 *
 *  Recents come from `recentApi` (the same source the previous EmptyState
 *  used) and clicks go through the existing `openFile` / `openFromPath`
 *  actions — no upstream API surface mocked here. */
export default function EmptyState() {
  const [recent, setRecent] = useState<RecentEntry[]>([])
  const [filter, setFilter] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [pinned, setPinned] = useState<Set<string>>(() => new Set(pinnedApi.get()))
  const [folderFavs, setFolderFavs] = useState<string[]>(() => folderFavoritesApi.get())
  // Subscribe to locale changes so the t() calls below re-render
  // immediately when the user flips the dropdown in Preferences.
  useLocale()
  // Tour auto-shows once on a fresh install (no recents in storage).
  // After dismissal, localStorage prevents replay.
  const [tourOpen, setTourOpen] = useState(false)

  useEffect(() => {
    recentApi
      .get()
      .then((r) => {
        setRecent(r)
        if (shouldAutoShowTour(r.length)) setTourOpen(true)
      })
      .catch(() => {
        if (shouldAutoShowTour(0)) setTourOpen(true)
      })
  }, [])

  const filtered = recent.filter((r) => {
    const q = filter.trim().toLowerCase()
    if (!q) return true
    return r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q)
  })

  // Split: pinned items first (in pin-order from localStorage),
  // unpinned after (in recents order). The pin API stores paths only,
  // so we re-anchor against the live recents list to keep metadata
  // (last_opened, format) — and silently drop pins whose recents
  // entry was cleared, which prevents stale pins from accumulating.
  const pinnedRecents: RecentEntry[] = []
  const unpinnedRecents: RecentEntry[] = []
  for (const r of filtered) {
    if (pinned.has(r.path)) pinnedRecents.push(r)
    else unpinnedRecents.push(r)
  }

  const togglePin = (path: string) => {
    if (pinned.has(path)) {
      pinnedApi.unpin(path)
      setPinned(new Set(pinnedApi.get()))
    } else {
      pinnedApi.pin(path)
      setPinned(new Set(pinnedApi.get()))
    }
  }

  const removeFolderFav = (path: string) => {
    setFolderFavs(folderFavoritesApi.remove(path))
  }
  // Add a folder favorite. Tries the native Tauri folder picker
  // first (cleanest UX); falls back to a prompt() with the
  // most-recent file's dirname pre-filled if Tauri's dialog isn't
  // available (browser preview).
  const addFolderFav = async () => {
    try {
      const picked = await fileApi.pickFolderPath()
      if (picked) {
        setFolderFavs(folderFavoritesApi.add(picked))
        return
      }
      // null = cancel
      if (picked === null) return
    } catch {
      // Tauri command not registered (browser preview, old build,
      // etc.) — fall through to prompt().
    }
    let candidate: string | null = null
    if (recent.length > 0) {
      candidate = dirnameOf(recent[0].path)
    }
    const path = window.prompt(
      'Folder path to add to favorites:',
      candidate ?? '',
    )
    if (!path) return
    setFolderFavs(folderFavoritesApi.add(path.trim()))
  }
  // Click a folder favorite → open the standard file picker (Tauri
  // picker doesn't yet honor a defaultPath param; a follow-up Rust
  // command can add that wiring). For now, the click is a "navigate
  // me there mentally" + opens the picker so you don't have to
  // memorize the path. Reveals via shell.open if Tauri is present.
  const openFolderFav = (path: string) => {
    // Best-effort: Tauri's plugin-shell can open the folder in the
    // OS file manager. If unavailable (browser preview), fall back
    // to copying to clipboard so the user can paste into the next
    // open-file dialog.
    void (async () => {
      try {
        const shell = await import('@tauri-apps/plugin-shell')
        await shell.open(path)
      } catch {
        try {
          await navigator.clipboard.writeText(path)
        } catch {
          /* ignore */
        }
        void openFile()
      }
    })()
  }

  return (
    <div
      className="os-paper-grain"
      style={{
        height: '100%',
        overflow: 'auto',
        display: 'flex',
        justifyContent: 'center',
        padding: '48px 32px 56px',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 880,
          display: 'flex',
          flexDirection: 'column',
          gap: 32,
        }}
      >
        {/* Hero */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 18 }}>
          <div
            style={{
              width: 44,
              height: 44,
              display: 'grid',
              placeItems: 'center',
              color: 'var(--accent)',
              background: 'var(--accent-tint)',
              borderRadius: 10,
              flexShrink: 0,
            }}
          >
            <Logo size={22} />
          </div>
          <div style={{ flex: 1 }}>
            <div
              className="os-serif"
              style={{
                fontSize: 32,
                fontWeight: 500,
                letterSpacing: -0.6,
                lineHeight: 1.05,
                color: 'var(--ink)',
              }}
            >
              Open Satchel
            </div>
            <div style={{ fontSize: 13, color: 'var(--ink-2)', marginTop: 4 }}>
              {t('empty.tagline')}
            </div>
            <div
              className="os-mono"
              style={{
                display: 'flex',
                gap: 14,
                fontSize: 10.5,
                color: 'var(--ink-3)',
                marginTop: 10,
                flexWrap: 'wrap',
                textTransform: 'uppercase',
                letterSpacing: 0.6,
              }}
            >
              <span>v0.1.0 · m1 scaffold</span>
              <span>·</span>
              <span>tauri 2 + rust</span>
              <span>·</span>
              <span>AGPL source</span>
            </div>
          </div>
        </div>

        {/* Drop zone */}
        <div
          data-testid="empty-state-drop"
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            void openFile()
          }}
          onClick={() => void openFile()}
          style={{
            border: `1.5px dashed ${dragOver ? 'var(--accent)' : 'var(--line-strong)'}`,
            background: dragOver ? 'var(--accent-tint)' : 'var(--bg-surface)',
            borderRadius: 12,
            padding: '28px 24px',
            display: 'flex',
            alignItems: 'center',
            gap: 18,
            cursor: 'pointer',
            transition: 'all 120ms ease',
            boxShadow: dragOver ? 'var(--shadow-md)' : 'var(--shadow-sm)',
          }}
        >
          <div
            style={{
              width: 38,
              height: 38,
              display: 'grid',
              placeItems: 'center',
              borderRadius: 8,
              background: 'var(--bg-sunken)',
              color: 'var(--ink-2)',
            }}
          >
            <I.Drop size={18} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>
              {t('empty.drop-cta')}
            </div>
            <div
              className="os-mono"
              style={{
                fontSize: 10.5,
                color: 'var(--ink-3)',
                marginTop: 4,
                letterSpacing: 0.4,
              }}
            >
              {t('empty.drop-sub')}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {/* Pulls from the live shortcuts registry so customized
                bindings ('file.open' rebound to e.g. Ctrl+Shift+O)
                show up here instead of the hardcoded default. */}
            <KbdRow keys={formatBinding(getEffectiveBinding('file.open')).split('+')} />
          </div>
        </div>

        {/* Folder favorites */}
        {(folderFavs.length > 0 || recent.length > 0) && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <div
                className="os-mono"
                style={{
                  fontSize: 10.5,
                  fontWeight: 600,
                  color: 'var(--ink-3)',
                  textTransform: 'uppercase',
                  letterSpacing: 0.8,
                }}
              >
                {t('empty.folders-header')}
              </div>
              <div style={{ flex: 1, height: 1, background: 'var(--line)' }} />
              <button
                data-testid="folder-fav-add"
                onClick={addFolderFav}
                title="Add a folder to your quick-access favorites. Click adds the dirname of your most-recent file by default; you can paste a different path."
                style={{
                  fontSize: 10.5,
                  color: 'var(--accent)',
                  border: '1px solid var(--accent)',
                  background: 'var(--accent-tint)',
                  borderRadius: 4,
                  padding: '2px 8px',
                  cursor: 'pointer',
                  fontFamily: '"JetBrains Mono", monospace',
                  letterSpacing: 0.4,
                  textTransform: 'uppercase',
                }}
              >
                {t('empty.add-folder')}
              </button>
            </div>
            {folderFavs.length === 0 ? (
              <div
                style={{
                  padding: '8px 12px',
                  textAlign: 'center',
                  color: 'var(--ink-3)',
                  fontSize: 11,
                  fontStyle: 'italic',
                  marginBottom: 12,
                }}
              >
                No favorite folders yet. Click + Folder to add one.
              </div>
            ) : (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: 6,
                  marginBottom: 12,
                }}
              >
                {folderFavs.map((fp) => (
                  <div
                    key={fp}
                    data-testid={`folder-fav-${fp}`}
                    onClick={() => openFolderFav(fp)}
                    title={`Open ${fp}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '6px 10px',
                      borderRadius: 6,
                      background: 'var(--bg-surface)',
                      border: '1px solid var(--line)',
                      cursor: 'pointer',
                      minWidth: 0,
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'var(--bg-hover)'
                      e.currentTarget.style.borderColor = 'var(--line-strong)'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'var(--bg-surface)'
                      e.currentTarget.style.borderColor = 'var(--line)'
                    }}
                  >
                    <span style={{ color: 'var(--accent)', flexShrink: 0, display: 'inline-flex' }}>
                      <I.Outline size={14} />
                    </span>
                    <span
                      className="os-mono"
                      style={{
                        flex: 1,
                        fontSize: 10.5,
                        color: 'var(--ink)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        minWidth: 0,
                      }}
                    >
                      {fp}
                    </span>
                    <button
                      data-testid={`folder-fav-remove-${fp}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        removeFolderFav(fp)
                      }}
                      title="Remove from favorites"
                      style={{
                        width: 18,
                        height: 18,
                        padding: 0,
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--ink-4)',
                        cursor: 'pointer',
                        fontSize: 14,
                        lineHeight: 1,
                        flexShrink: 0,
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Recents */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <div
              className="os-mono"
              style={{
                fontSize: 10.5,
                fontWeight: 600,
                color: 'var(--ink-3)',
                textTransform: 'uppercase',
                letterSpacing: 0.8,
              }}
            >
              {t('empty.recent-header')}
            </div>
            <div style={{ flex: 1, height: 1, background: 'var(--line)' }} />
            {recent.length > 0 && (
              <button
                onClick={async () => {
                  await recentApi.clear()
                  setRecent([])
                }}
                style={{
                  fontSize: 10.5,
                  color: 'var(--ink-3)',
                  border: '1px solid var(--line)',
                  background: 'var(--bg-surface)',
                  borderRadius: 4,
                  padding: '2px 8px',
                  cursor: 'pointer',
                  fontFamily: '"JetBrains Mono", monospace',
                  letterSpacing: 0.4,
                  textTransform: 'uppercase',
                }}
              >
                Clear
              </button>
            )}
            <div style={{ position: 'relative' }}>
              <div
                style={{
                  position: 'absolute',
                  left: 8,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  color: 'var(--ink-3)',
                  pointerEvents: 'none',
                  display: 'inline-flex',
                }}
              >
                <I.Search size={12} />
              </div>
              <input
                placeholder="Filter…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                style={{
                  height: 26,
                  padding: '0 8px 0 26px',
                  fontSize: 11.5,
                  width: 160,
                  border: '1px solid var(--line)',
                  borderRadius: 6,
                  background: 'var(--bg-surface)',
                  color: 'var(--ink)',
                  outline: 'none',
                  fontFamily: 'inherit',
                }}
              />
            </div>
          </div>

          {recent.length === 0 ? (
            <div
              style={{
                padding: '24px 16px',
                textAlign: 'center',
                color: 'var(--ink-3)',
                fontSize: 12,
                background: 'var(--bg-surface)',
                border: '1px dashed var(--line-strong)',
                borderRadius: 8,
              }}
            >
              {t('empty.no-recents')}
            </div>
          ) : (
            <>
              {pinnedRecents.length > 0 && (
                <>
                  <div
                    className="os-mono"
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      color: 'var(--accent)',
                      textTransform: 'uppercase',
                      letterSpacing: 0.6,
                      marginBottom: 6,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    <I.Pin size={12} />
                    Pinned
                  </div>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 1fr',
                      gap: 6,
                      marginBottom: 12,
                    }}
                  >
                    {pinnedRecents.map((r) =>
                      renderRecentRow(r, true, togglePin, setRecent),
                    )}
                  </div>
                </>
              )}
              {unpinnedRecents.length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                  {unpinnedRecents.map((r) =>
                    renderRecentRow(r, false, togglePin, setRecent),
                  )}
                </div>
              )}
              {pinnedRecents.length === 0 && unpinnedRecents.length === 0 && (
                <div
                  style={{
                    padding: 24,
                    textAlign: 'center',
                    color: 'var(--ink-3)',
                    fontSize: 12,
                  }}
                >
                  No recent files match "{filter}".
                </div>
              )}
            </>
          )}
        </div>

        {/* Format support — honest tiering: PDF is the only format with a
            full editor today. Other handlers ship in M5 (read+light-edit)
            / M6 (full editor) per the roadmap. Showing them muted with a
            "soon" badge keeps the universal-file-editor promise honest
            without over-promising. */}
        <div>
          <div
            className="os-mono"
            style={{
              fontSize: 10.5,
              fontWeight: 600,
              color: 'var(--ink-3)',
              textTransform: 'uppercase',
              letterSpacing: 0.8,
              marginBottom: 10,
            }}
          >
            Available now
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr',
              gap: 6,
              marginBottom: 16,
            }}
          >
            {FORMAT_TILES.filter(([, , ready]) => ready).map(([fmt, label]) => {
              const Icon = I[fmt] as React.ComponentType<{ size?: number }>
              return (
                <div
                  key={label}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '10px 12px',
                    border: '1px solid var(--accent)',
                    borderRadius: 8,
                    background: 'var(--accent-tint)',
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: 'var(--ink)',
                  }}
                >
                  <span style={{ color: 'var(--accent)', display: 'inline-flex' }}>
                    <Icon size={18} />
                  </span>
                  <span style={{ flex: 1 }}>{label}</span>
                  <span
                    className="os-mono"
                    style={{
                      fontSize: 9.5,
                      fontWeight: 700,
                      color: 'var(--accent)',
                      textTransform: 'uppercase',
                      letterSpacing: 0.8,
                    }}
                  >
                    Full editor
                  </span>
                </div>
              )
            })}
          </div>

          <div
            className="os-mono"
            style={{
              fontSize: 10.5,
              fontWeight: 600,
              color: 'var(--ink-3)',
              textTransform: 'uppercase',
              letterSpacing: 0.8,
              marginBottom: 10,
            }}
          >
            Coming in M5 · M6
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6 }}>
            {FORMAT_TILES.filter(([, , ready]) => !ready).map(([fmt, label]) => {
              const Icon = I[fmt] as React.ComponentType<{ size?: number }>
              return (
                <div
                  key={label}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 10px',
                    border: '1px dashed var(--line-strong)',
                    borderRadius: 6,
                    background: 'var(--bg-surface)',
                    fontSize: 11.5,
                    color: 'var(--ink-3)',
                    position: 'relative',
                  }}
                  title={`${label} support is on the roadmap (M5 read+light-edit, M6 full editor). Use Acrobat/Office for now.`}
                >
                  <span style={{ color: 'var(--ink-4)', display: 'inline-flex' }}>
                    <Icon size={16} />
                  </span>
                  <span style={{ flex: 1 }}>{label}</span>
                  <span
                    className="os-mono"
                    style={{
                      fontSize: 9,
                      fontWeight: 700,
                      color: 'var(--ink-4)',
                      textTransform: 'uppercase',
                      letterSpacing: 0.6,
                      background: 'var(--bg-sunken)',
                      padding: '2px 5px',
                      borderRadius: 3,
                    }}
                  >
                    Soon
                  </span>
                </div>
              )
            })}
          </div>
        </div>

        {/* Ethos footer */}
        <div
          style={{
            marginTop: 8,
            padding: '16px 18px',
            borderRadius: 10,
            background: 'var(--bg-sunken)',
            border: '1px solid var(--line)',
            display: 'flex',
            gap: 24,
            flexWrap: 'wrap',
          }}
        >
          {ethosRows().map(([h, b]) => (
            <div key={h} style={{ flex: '1 1 160px' }}>
              <div
                className="os-mono"
                style={{
                  fontSize: 10.5,
                  fontWeight: 700,
                  color: 'var(--accent)',
                  textTransform: 'uppercase',
                  letterSpacing: 0.6,
                }}
              >
                {h}
              </div>
              <div
                style={{
                  fontSize: 11.5,
                  color: 'var(--ink-2)',
                  marginTop: 3,
                  lineHeight: 1.45,
                }}
              >
                {b}
              </div>
            </div>
          ))}
        </div>
      </div>
      {tourOpen && <OnboardingTour onClose={() => setTourOpen(false)} />}
    </div>
  )
}

/** Render one recents row, pinned or not. The pin star toggles via
 *  `togglePin`. Click anywhere on the row (except the pin button)
 *  opens the file. If openFromPath fails, the row's recents entry
 *  is removed (assumes the file moved or deleted). */
function renderRecentRow(
  r: RecentEntry,
  isPinned: boolean,
  togglePin: (path: string) => void,
  setRecent: (entries: RecentEntry[]) => void,
) {
  const iconName = ICON_BY_FORMAT[r.format] ?? 'FilePdf'
  const Icon = I[iconName] as React.ComponentType<{ size?: number }>
  return (
    <div
      key={r.path}
      data-testid={isPinned ? `recent-row-pinned-${r.path}` : `recent-row-${r.path}`}
      onClick={async () => {
        try {
          await openFromPath(r.path)
        } catch {
          const updated = await recentApi.remove(r.path)
          setRecent(updated)
        }
      }}
      style={{
        ...recentRowStyle,
        ...(isPinned
          ? { borderColor: 'var(--accent)', background: 'var(--accent-tint)' }
          : {}),
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = isPinned ? 'var(--accent-tint)' : 'var(--bg-hover)'
        e.currentTarget.style.borderColor = isPinned ? 'var(--accent)' : 'var(--line-strong)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = isPinned ? 'var(--accent-tint)' : 'var(--bg-surface)'
        e.currentTarget.style.borderColor = isPinned ? 'var(--accent)' : 'var(--line)'
      }}
    >
      <span style={{ color: 'var(--accent)', flexShrink: 0, display: 'inline-flex' }}>
        <Icon size={16} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 500,
            color: 'var(--ink)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {r.name}
        </div>
        <div
          className="os-mono"
          style={{
            fontSize: 10,
            color: 'var(--ink-3)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            marginTop: 2,
          }}
        >
          {r.path}
        </div>
      </div>
      <div
        className="os-mono"
        style={{
          fontSize: 10,
          color: 'var(--ink-3)',
          textAlign: 'right',
          flexShrink: 0,
        }}
      >
        {formatRelativeTime(r.last_opened)}
      </div>
      <button
        data-testid={`recent-pin-toggle-${r.path}`}
        onClick={(e) => {
          e.stopPropagation()
          togglePin(r.path)
        }}
        title={isPinned ? 'Unpin' : 'Pin to top'}
        style={{
          width: 22,
          height: 22,
          padding: 0,
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: isPinned ? 'var(--accent)' : 'var(--ink-4)',
          display: 'inline-grid',
          placeItems: 'center',
          flexShrink: 0,
          opacity: isPinned ? 1 : 0.5,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.opacity = '1'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.opacity = isPinned ? '1' : '0.5'
        }}
      >
        <I.Pin size={12} />
      </button>
    </div>
  )
}

function KbdRow({ keys }: { keys: string[] }) {
  return (
    <div style={{ display: 'flex', gap: 3 }}>
      {keys.map((k) => (
        <kbd
          key={k}
          style={{
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 10.5,
            minWidth: 20,
            height: 22,
            padding: '0 6px',
            display: 'inline-grid',
            placeItems: 'center',
            border: '1px solid var(--line-strong)',
            borderBottom: '2px solid var(--line-strong)',
            background: 'var(--bg-surface)',
            color: 'var(--ink-2)',
            borderRadius: 4,
          }}
        >
          {k}
        </kbd>
      ))}
    </div>
  )
}

const recentRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '8px 10px',
  borderRadius: 6,
  background: 'var(--bg-surface)',
  border: '1px solid var(--line)',
  cursor: 'pointer',
  minWidth: 0,
  transition: 'background 80ms ease, border-color 80ms ease',
}

const ICON_BY_FORMAT: Record<string, IconName> = {
  pdf: 'FilePdf',
  markdown: 'FileMd',
  docx: 'FileDoc',
  xlsx: 'FileXls',
  pptx: 'FilePpt',
  image: 'FileImg',
  svg: 'FileImg',
  code: 'FileCode',
  json: 'FileJson',
  csv: 'FileCsv',
  html: 'FileHtml',
}

const FORMAT_TILES: ReadonlyArray<[IconName, string, boolean]> = [
  ['FilePdf', 'PDF', true],
  ['FileMd', 'Markdown', false],
  ['FileDoc', 'DOCX', false],
  ['FileXls', 'XLSX', false],
  ['FilePpt', 'PPTX', false],
  ['FileCode', 'Plain text', false],
  ['FileCsv', 'CSV', false],
  ['FileJson', 'JSON', false],
  ['FileHtml', 'HTML', false],
  ['FileImg', 'Images', false],
]

// Ethos rows are translated at render time via t(). Defined as
// i18n keys here so missing-translation fallback lands on the
// English seed in lib/i18n.ts.
const ETHOS_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['empty.ethos.no-subs', 'empty.ethos.no-subs-body'],
  ['empty.ethos.no-email', 'empty.ethos.no-email-body'],
  ['empty.ethos.no-cloud', 'empty.ethos.no-cloud-body'],
  ['empty.ethos.no-ai', 'empty.ethos.no-ai-body'],
]
function ethosRows() {
  return ETHOS_KEYS.map(([h, b]) => [t(h), t(b)] as const)
}

function formatRelativeTime(unixSeconds: number): string {
  const diff = Date.now() / 1000 - unixSeconds
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`
  return new Date(unixSeconds * 1000).toLocaleDateString()
}
