import { useEffect, useState, type CSSProperties } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import Logo from './Logo'
import {
  checkForAppUpdate,
  humanUpdateError,
  installPendingAppUpdate,
  type AppUpdateInfo,
  type AppUpdateProgress,
} from '../services/appUpdater'

interface Props {
  onClose: () => void
}

interface LicenseInfo {
  license_id: string
  edition: string
  customer_email: string | null
  expires_at: number
  activated_at: number
}

type Status =
  | { kind: 'ok'; message: string }
  | { kind: 'err'; message: string }

const PUBLIC_EDITION = 'Public Edition'

/** About dialog. Shows version + edition + license info + procurement
 *  links so reviewers can verify the build's provenance and license
 *  state from inside the shipping binary. Mirrors Acrobat's Help →
 *  About flow.
 *
 *  All editions are feature-identical. The displayed edition label
 *  reflects an activated commercial license (or "Public Edition" when
 *  running under AGPL with no license).
 */
export default function AboutDialog({ onClose }: Props) {
  const [license, setLicense] = useState<LicenseInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status | null>(null)
  const [updateBusy, setUpdateBusy] = useState(false)
  const [availableUpdate, setAvailableUpdate] = useState<AppUpdateInfo | null>(null)
  const [updateStatus, setUpdateStatus] = useState<Status | null>(null)
  const [appVersion, setAppVersion] = useState('0.1.0')

  useEffect(() => {
    void invoke<LicenseInfo | null>('license_status')
      .then((info) => setLicense(info ?? null))
      .catch(() => {
        // Silent — the app falls back to Public Edition.
      })
  }, [])

  useEffect(() => {
    void invoke<string>('app_version')
      .then((version) => setAppVersion(version))
      .catch(() => {
        // Keep the build-time fallback if the runtime command is unavailable.
      })
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const editionLabel = license?.edition ?? PUBLIC_EDITION

  async function handleActivate() {
    setStatus(null)
    setBusy(true)
    try {
      const selected = await openDialog({
        multiple: false,
        directory: false,
        filters: [{ name: 'License file', extensions: ['licensekey', 'jwt', 'txt'] }],
      })
      if (typeof selected !== 'string') {
        setBusy(false)
        return
      }
      const info = await invoke<LicenseInfo>('license_activate', { path: selected })
      setLicense(info)
      setStatus({ kind: 'ok', message: `License activated: ${info.edition}. Thank you!` })
    } catch (e: unknown) {
      setStatus({ kind: 'err', message: humanError(e) })
    } finally {
      setBusy(false)
    }
  }

  async function handleDeactivate() {
    setStatus(null)
    const ok = window.confirm(
      'Deactivate this license and revert to Public Edition?\n\n' +
        'You can re-activate later from this dialog.',
    )
    if (!ok) return
    setBusy(true)
    try {
      await invoke('license_deactivate')
      setLicense(null)
      setStatus({
        kind: 'ok',
        message: 'License deactivated. Reverted to Public Edition.',
      })
    } catch (e: unknown) {
      setStatus({ kind: 'err', message: humanError(e) })
    } finally {
      setBusy(false)
    }
  }

  async function handleCheckForUpdate() {
    setUpdateStatus(null)
    setUpdateBusy(true)
    try {
      const result = await checkForAppUpdate()
      if (result.kind === 'available') {
        setAvailableUpdate(result.update)
        setUpdateStatus({
          kind: 'ok',
          message: `Update ${result.update.version} is ready to install.`,
        })
      } else {
        setAvailableUpdate(null)
        setUpdateStatus({ kind: 'ok', message: 'Open Satchel is up to date.' })
      }
    } catch (e: unknown) {
      setUpdateStatus({ kind: 'err', message: humanUpdateError(e) })
    } finally {
      setUpdateBusy(false)
    }
  }

  async function handleInstallUpdate() {
    if (!availableUpdate) return
    setUpdateBusy(true)
    setUpdateStatus({ kind: 'ok', message: 'Preparing update...' })
    try {
      await installPendingAppUpdate((progress) => {
        setUpdateStatus({ kind: 'ok', message: updateProgressMessage(progress) })
      })
    } catch (e: unknown) {
      setUpdateStatus({ kind: 'err', message: humanUpdateError(e) })
    } finally {
      setUpdateBusy(false)
    }
  }

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0, 0, 0, 0.5)',
          zIndex: 70,
        }}
      />
      <div
        data-testid="about-dialog"
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 480,
          maxHeight: 'calc(100vh - 40px)',
          overflowY: 'auto',
          background: 'var(--bg-surface)',
          border: '1px solid var(--line-strong)',
          borderRadius: 12,
          boxShadow: 'var(--shadow-lg)',
          zIndex: 71,
          padding: '20px 22px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 14 }}>
          <span
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
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="os-serif" style={{ fontSize: 22, fontWeight: 500, letterSpacing: -0.5 }}>
              Open Satchel
            </div>
            <div
              data-testid="about-edition"
              className="os-mono"
              style={{
                fontSize: 11,
                color: 'var(--ink-3)',
                marginTop: 4,
                letterSpacing: 0.4,
                textTransform: 'uppercase',
              }}
            >
              v{appVersion} · {editionLabel}
            </div>
          </div>
          <button
            data-testid="about-close"
            onClick={onClose}
            title="Close"
            style={{
              width: 26,
              height: 26,
              padding: 0,
              fontSize: 18,
              color: 'var(--ink-3)',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              borderRadius: 4,
            }}
          >
            ×
          </button>
        </div>

        <div style={{ fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.5, marginBottom: 16 }}>
          A local-first document workstation for sensitive files. Free under
          AGPL; commercial licenses available for non-AGPL terms and engine/OEM use.
        </div>

        <Section label="License">
          {license ? (
            <LicensedView info={license} busy={busy} onDeactivate={handleDeactivate} />
          ) : (
            <PublicView busy={busy} onActivate={handleActivate} />
          )}
          {status && (
            <div
              data-testid={`about-license-status-${status.kind}`}
              style={status.kind === 'ok' ? statusOkStyle : statusErrStyle}
            >
              {status.message}
            </div>
          )}
        </Section>

        <Section label="Updates">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={infoStyle}>
              Signed updates install from the Open Satchel GitHub release feed.
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                data-testid="about-update-check"
                onClick={() => void handleCheckForUpdate()}
                disabled={updateBusy}
                style={secondaryBtnStyle(updateBusy)}
              >
                {updateBusy ? 'Checking...' : 'Check for Updates'}
              </button>
              {availableUpdate && (
                <button
                  data-testid="about-update-install"
                  onClick={() => void handleInstallUpdate()}
                  disabled={updateBusy}
                  style={primaryBtnStyle(updateBusy)}
                >
                  {updateBusy ? 'Installing...' : `Install ${availableUpdate.version}`}
                </button>
              )}
            </div>
            {availableUpdate?.body && (
              <div style={infoStyle}>{availableUpdate.body}</div>
            )}
            {updateStatus && (
              <div
                data-testid={`about-update-status-${updateStatus.kind}`}
                style={updateStatus.kind === 'ok' ? statusOkStyle : statusErrStyle}
              >
                {updateStatus.message}
              </div>
            )}
          </div>
        </Section>

        <Section label="Stack">
          <span style={infoStyle}>Tauri 2 · Rust · React 18 · pdf-lib · pdfium · Tesseract</span>
        </Section>

        <Section label="Procurement">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <DocLink doc="docs/AIRGAP-AUDIT.md" label="Air-gap audit (no telemetry, no cloud calls)" />
            <DocLink doc="docs/COMPLIANCE-CHECKLIST.md" label="Compliance checklist (HIPAA / FedRAMP / SOC 2)" />
            <DocLink doc="docs/SBOM.md" label="SBOM — CycloneDX 1.5" />
            <DocLink doc="docs/REPRODUCIBLE-BUILD.md" label="Reproducible build recipe" />
          </div>
        </Section>

        <Section label="Source">
          <span style={infoStyle}>
            <a
              href="https://github.com/OpenSatchelOfficial/open-satchel"
              target="_blank"
              rel="noreferrer noopener"
              style={{ color: 'var(--accent)' }}
            >
              github.com/OpenSatchelOfficial/open-satchel
            </a>
            {' '}— AGPL source; the binary you run is the source you can audit.
          </span>
        </Section>

        <div
          style={{
            marginTop: 14,
            padding: '10px 0 0',
            borderTop: '1px solid var(--line)',
            fontSize: 10,
            color: 'var(--ink-3)',
            textAlign: 'center',
            fontFamily: '"JetBrains Mono", monospace',
            letterSpacing: 0.4,
          }}
        >
          built locally · no telemetry · no cloud · no AI calls
        </div>
      </div>
    </>
  )
}

function PublicView({
  busy,
  onActivate,
}: {
  busy: boolean
  onActivate: () => void
}) {
  return (
    <div>
      <div style={{ fontSize: 11.5, color: 'var(--ink-2)', lineHeight: 1.5, marginBottom: 8 }}>
        You're using the <strong>Public Edition</strong> under AGPL-3.0. All
        features are available. Commercial licenses remove the AGPL
        share-alike requirement —{' '}
        <a
          href="https://opensatchel.dev/licensing"
          target="_blank"
          rel="noreferrer noopener"
          style={{ color: 'var(--accent)' }}
        >
          learn more
        </a>
        .
      </div>
      <button
        data-testid="about-license-activate"
        onClick={onActivate}
        disabled={busy}
        style={primaryBtnStyle(busy)}
      >
        {busy ? 'Activating…' : 'Activate License'}
      </button>
    </div>
  )
}

function LicensedView({
  info,
  busy,
  onDeactivate,
}: {
  info: LicenseInfo
  busy: boolean
  onDeactivate: () => void
}) {
  const expired = info.expires_at > 0 && info.expires_at * 1000 < Date.now()
  return (
    <div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11.5 }}>
        <Row label="Edition" value={info.edition} />
        <Row label="License ID" value={maskLicenseId(info.license_id)} mono />
        {info.customer_email && <Row label="Email" value={info.customer_email} />}
        <Row
          label="Expires"
          value={formatExpiry(info.expires_at)}
          mono
          tone={expired ? 'err' : undefined}
        />
      </div>
      {expired && (
        <div style={statusErrStyle}>
          Your commercial license expired on {formatExpiry(info.expires_at)}. The
          software continues to work under AGPL-3.0 terms.
        </div>
      )}
      <div style={{ marginTop: 10 }}>
        <button
          data-testid="about-license-deactivate"
          onClick={onDeactivate}
          disabled={busy}
          style={secondaryBtnStyle(busy)}
        >
          {busy ? 'Deactivating…' : 'Deactivate License'}
        </button>
      </div>
    </div>
  )
}

function Row({
  label,
  value,
  mono,
  tone,
}: {
  label: string
  value: string
  mono?: boolean
  tone?: 'err'
}) {
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <span style={{ width: 88, color: 'var(--ink-3)', flexShrink: 0 }}>{label}</span>
      <span
        className={mono ? 'os-mono' : undefined}
        style={{
          color: tone === 'err' ? 'var(--danger, #c33)' : 'var(--ink-1)',
          flex: 1,
          overflowWrap: 'anywhere',
        }}
      >
        {value}
      </span>
    </div>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div
        className="os-mono"
        style={{
          fontSize: 9.5,
          color: 'var(--ink-3)',
          textTransform: 'uppercase',
          letterSpacing: 0.7,
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  )
}

function DocLink({ doc, label }: { doc: string; label: string }) {
  return (
    <div
      data-testid={`about-doc-${doc.split('/').pop()}`}
      style={{
        fontSize: 11.5,
        color: 'var(--ink-2)',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
      }}
    >
      <span
        className="os-mono"
        style={{
          fontSize: 10,
          color: 'var(--ink-4)',
          background: 'var(--bg-sunken)',
          padding: '1px 5px',
          borderRadius: 3,
        }}
      >
        {doc}
      </span>
      <span style={{ color: 'var(--ink-2)' }}>—</span>
      <span>{label}</span>
    </div>
  )
}

// License-ID format: OS-{TIER}-XXXX-XXXX-XXXX-XXXX (six dash-separated
// segments). Mask the middle two so an over-the-shoulder glance at the
// About dialog can't expose the full key.
function maskLicenseId(id: string): string {
  const parts = id.split('-')
  if (parts.length !== 6) return id
  return `${parts[0]}-${parts[1]}-${parts[2]}-••••-••••-${parts[5]}`
}

function formatExpiry(ts: number): string {
  if (!ts || ts <= 0) return '—'
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function humanError(e: unknown): string {
  const s =
    typeof e === 'string'
      ? e
      : ((e as { message?: string } | null)?.message ?? String(e))
  const lower = s.toLowerCase()
  if (lower.includes('expired')) return 'License has expired'
  if (lower.includes('signature')) return 'Signature verification failed'
  if (lower.includes('not found')) return 'License file not found'
  if (lower.includes('empty')) return 'License file is empty'
  return s
}

function updateProgressMessage(progress: AppUpdateProgress): string {
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

const infoStyle: CSSProperties = {
  fontSize: 11.5,
  color: 'var(--ink-2)',
  lineHeight: 1.5,
}

const statusOkStyle: CSSProperties = {
  marginTop: 10,
  padding: '6px 10px',
  borderRadius: 5,
  background: 'var(--accent-tint)',
  color: 'var(--ink-1)',
  fontSize: 11.5,
  lineHeight: 1.4,
}

const statusErrStyle: CSSProperties = {
  marginTop: 10,
  padding: '6px 10px',
  borderRadius: 5,
  background: 'rgba(204, 51, 51, 0.12)',
  color: 'var(--danger, #c33)',
  fontSize: 11.5,
  lineHeight: 1.4,
}

function primaryBtnStyle(busy: boolean): CSSProperties {
  return {
    height: 28,
    padding: '0 14px',
    fontSize: 12,
    fontWeight: 500,
    color: 'var(--accent-fg, #fff)',
    background: busy ? 'var(--ink-4)' : 'var(--accent)',
    border: 'none',
    borderRadius: 5,
    cursor: busy ? 'wait' : 'pointer',
  }
}

function secondaryBtnStyle(busy: boolean): CSSProperties {
  return {
    height: 26,
    padding: '0 12px',
    fontSize: 11.5,
    color: 'var(--ink-2)',
    background: 'var(--bg-surface)',
    border: '1px solid var(--line)',
    borderRadius: 5,
    cursor: busy ? 'wait' : 'pointer',
  }
}
