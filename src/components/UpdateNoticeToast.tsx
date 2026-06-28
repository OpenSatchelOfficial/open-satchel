import { useEffect, useState, type CSSProperties } from 'react'
import {
  checkForAppUpdate,
  humanUpdateError,
  installPendingAppUpdate,
  restartToApplyUpdate,
  type AppUpdateInfo,
  type AppUpdateProgress,
} from '../services/appUpdater'

type ToastState =
  | { kind: 'idle' }
  | { kind: 'available'; update: AppUpdateInfo }
  | { kind: 'installing'; update: AppUpdateInfo; message: string }
  | { kind: 'staged'; update: AppUpdateInfo; message?: string }
  | { kind: 'error'; message: string }

export default function UpdateNoticeToast() {
  const [state, setState] = useState<ToastState>({ kind: 'idle' })

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void checkForAppUpdate()
        .then((result) => {
          if (result.kind === 'available') {
            setState({ kind: 'available', update: result.update })
          }
        })
        .catch(() => {
          // Startup checks stay quiet: a missing first-release manifest,
          // offline laptop, or captive network should not interrupt work.
        })
    }, 2500)
    return () => window.clearTimeout(timer)
  }, [])

  if (state.kind === 'idle') return null

  async function install(update: AppUpdateInfo) {
    setState({ kind: 'installing', update, message: 'Preparing update...' })
    try {
      await installPendingAppUpdate((progress) => {
        setState({
          kind: 'installing',
          update,
          message: progressMessage(progress),
        })
      })
      // Control returns here only when the app did not auto-restart during the
      // installer handoff, so the new version is staged and needs a restart.
      setState({ kind: 'staged', update })
    } catch (e: unknown) {
      setState({ kind: 'error', message: humanUpdateError(e) })
    }
  }

  async function restart(update: AppUpdateInfo) {
    setState({ kind: 'staged', update, message: 'Restarting...' })
    try {
      await restartToApplyUpdate()
    } catch {
      setState({
        kind: 'staged',
        update,
        message:
          'Could not restart automatically. Close and reopen Open Satchel to finish updating.',
      })
    }
  }

  return (
    <div data-testid="update-notice-toast" style={toastStyle}>
      {state.kind === 'available' && (
        <>
          <div style={titleStyle}>Update {state.update.version} is available</div>
          {state.update.body && <div style={bodyStyle}>{state.update.body}</div>}
          <div style={actionsStyle}>
            <button
              data-testid="update-install"
              onClick={() => void install(state.update)}
              style={primaryBtnStyle}
            >
              Install
            </button>
            <button
              data-testid="update-dismiss"
              onClick={() => setState({ kind: 'idle' })}
              style={secondaryBtnStyle}
            >
              Later
            </button>
          </div>
        </>
      )}

      {state.kind === 'installing' && (
        <>
          <div style={titleStyle}>Installing {state.update.version}</div>
          <div style={bodyStyle}>{state.message}</div>
        </>
      )}

      {state.kind === 'staged' && (
        <>
          <div style={titleStyle}>Update {state.update.version} downloaded</div>
          <div style={bodyStyle}>
            {state.message ?? 'Restart to finish installing.'}
          </div>
          <div style={actionsStyle}>
            <button
              data-testid="update-restart"
              onClick={() => void restart(state.update)}
              style={primaryBtnStyle}
            >
              Restart now
            </button>
            <button
              data-testid="update-restart-later"
              onClick={() => setState({ kind: 'idle' })}
              style={secondaryBtnStyle}
            >
              Later
            </button>
          </div>
        </>
      )}

      {state.kind === 'error' && (
        <>
          <div style={titleStyle}>Update failed</div>
          <div style={bodyStyle}>{state.message}</div>
          <div style={actionsStyle}>
            <button
              data-testid="update-error-dismiss"
              onClick={() => setState({ kind: 'idle' })}
              style={secondaryBtnStyle}
            >
              Dismiss
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function progressMessage(progress: AppUpdateProgress): string {
  switch (progress.kind) {
    case 'started':
      return progress.contentLength
        ? `Downloading ${formatBytes(progress.contentLength)}...`
        : 'Downloading update...'
    case 'progress':
      return progress.contentLength
        ? `${formatBytes(progress.downloaded)} of ${formatBytes(progress.contentLength)} downloaded`
        : `${formatBytes(progress.downloaded)} downloaded`
    case 'finished':
      return 'Download complete. Installing...'
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

const toastStyle: CSSProperties = {
  position: 'fixed',
  right: 18,
  bottom: 36,
  width: 320,
  maxWidth: 'calc(100vw - 36px)',
  zIndex: 80,
  padding: '12px 14px',
  borderRadius: 8,
  border: '1px solid var(--line-strong)',
  background: 'var(--bg-surface)',
  boxShadow: 'var(--shadow-lg)',
  color: 'var(--ink-1)',
}

const titleStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  marginBottom: 4,
}

const bodyStyle: CSSProperties = {
  fontSize: 11.5,
  color: 'var(--ink-2)',
  lineHeight: 1.45,
}

const actionsStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  marginTop: 10,
}

const primaryBtnStyle: CSSProperties = {
  height: 28,
  padding: '0 12px',
  fontSize: 12,
  fontWeight: 500,
  color: 'var(--accent-fg, #fff)',
  background: 'var(--accent)',
  border: 'none',
  borderRadius: 5,
  cursor: 'pointer',
}

const secondaryBtnStyle: CSSProperties = {
  height: 28,
  padding: '0 12px',
  fontSize: 12,
  color: 'var(--ink-2)',
  background: 'var(--bg-surface)',
  border: '1px solid var(--line)',
  borderRadius: 5,
  cursor: 'pointer',
}
