import { useEffect, useState } from 'react'
import { useFormatStore } from '../../stores/formatStore'
import { useTabStore } from '../../stores/tabStore'
import type { PdfFormatState } from './index'
import { isEncrypted, removeEncryption as removeEncryptionService, type PermissionFlags } from '../../services/pdfCrypto'
import DialogBase from '../../components/DialogBase'

interface Props {
  tabId?: string
  onClose: () => void
  onApply?: (userPassword: string, ownerPassword: string) => void
}

type Algorithm = 'RC4_40' | 'RC4_128' | 'AES_128' | 'AES_256'

function algorithmLabel(algo: Algorithm): string {
  switch (algo) {
    case 'RC4_40': return 'RC4 40-bit'
    case 'RC4_128': return 'RC4 128-bit'
    case 'AES_128': return 'AES-128'
    case 'AES_256': return 'AES-256'
  }
}

const ALL_PERMS_ON: PermissionFlags = {
  print: true,
  printHigh: true,
  modify: true,
  copy: true,
  annotForms: true,
  fillForms: true,
  extract: true,
  assemble: true,
}

const LockIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
)

const EyeIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
)

/** Password + permissions dialog. See full comment below the component. */
export default function PasswordDialog({ tabId, onClose, onApply }: Props) {
  const [userPassword, setUserPassword] = useState('')
  const [ownerPassword, setOwnerPassword] = useState('')
  const [showPasswords, setShowPasswords] = useState(false)
  const [algorithm, setAlgorithm] = useState<Algorithm>('AES_256')
  const [perms, setPerms] = useState<PermissionFlags>({ ...ALL_PERMS_ON })
  const [status, setStatus] = useState('')
  const [removing, setRemoving] = useState(false)

  useEffect(() => {
    if (!tabId) return
    const state = useFormatStore.getState().data[tabId] as PdfFormatState | undefined
    if (state?.encryption) {
      setUserPassword(state.encryption.userPassword || '')
      setOwnerPassword(state.encryption.ownerPassword || '')
      if (state.encryption.algorithm) setAlgorithm(state.encryption.algorithm as Algorithm)
      if (state.encryption.permissions) setPerms(state.encryption.permissions)
    }
  }, [tabId])

  const setPerm = (key: keyof PermissionFlags, value: boolean) => {
    setPerms((prev) => ({ ...prev, [key]: value }))
  }
  const allOn = () => setPerms({ ...ALL_PERMS_ON })
  const allOff = () => setPerms({})

  const applyToStore = () => {
    if (!tabId) return
    useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({
      ...prev,
      encryption: {
        userPassword,
        ownerPassword: ownerPassword || userPassword,
        algorithm,
        permissions: perms,
      },
    }))
  }

  const handleApply = () => {
    applyToStore()
    if (onApply) onApply(userPassword, ownerPassword || userPassword)
    onClose()
  }

  const removeEncryption = async () => {
    if (!tabId) return
    const state = useFormatStore.getState().data[tabId] as PdfFormatState | undefined
    if (!state) { onClose(); return }
    // G4: if the bytes are still encrypted on disk (file opened from
    // an encrypted source), pd-lib's save chain will emit encrypted
    // output again because the /Encrypt dict + ciphertext streams
    // persist. Route through the pdfCrypto.removeEncryption service
    // (Rust lopdf decrypt + drop /Encrypt). Skip the round-trip when
    // only the in-memory permissions flag was set.
    setRemoving(true)
    setStatus('')
    try {
      if (isEncrypted(state.pdfBytes)) {
        const password =
          state.encryption?.userPassword ||
          state.encryption?.ownerPassword ||
          userPassword ||
          ownerPassword ||
          ''
        const decrypted = await removeEncryptionService(state.pdfBytes, password)
        useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({
          ...prev,
          pdfBytes: decrypted,
          encryption: undefined,
        }))
      } else {
        useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({
          ...prev,
          encryption: undefined,
        }))
      }
    } catch (e) {
      console.error('[removeEncryption] failed:', e)
      setStatus(
        e instanceof Error
          ? `Remove protection failed: ${e.message}`
          : 'Remove protection failed.',
      )
      return
    } finally {
      setRemoving(false)
    }
    useTabStore.getState().setTabDirty(tabId, true)
    onClose()
  }

  const mode: 'password' | 'permissions-only' | 'empty' = userPassword
    ? 'password'
    : ownerPassword && Object.values(perms).some((v) => v === false)
      ? 'permissions-only'
      : 'empty'

  const canApply = mode !== 'empty'

  return (
    <DialogBase
      open
      onClose={onClose}
      title="Encrypt with password"
      subtitle={`${algorithmLabel(algorithm)}. The password is never sent off-device.`}
      icon={<LockIcon />}
      data-testid="password-dialog"
      footerMeta={<>{algorithmLabel(algorithm)} · open-source crypto</>}
      footer={
        <>
          <button className="os-danger-btn" data-testid="pwd-remove" onClick={removeEncryption} disabled={removing}>
            {removing ? 'Removing...' : 'Remove protection'}
          </button>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary"
            data-testid="pwd-apply"
            onClick={handleApply}
            disabled={!canApply}
          >
            Encrypt
          </button>
        </>
      }
    >
      <div className="os-field">
        <label htmlFor="pwd-user">User password</label>
        <div className="os-input-wrap">
          <input
            id="pwd-user"
            data-testid="pwd-user"
            className="os-input"
            type={showPasswords ? 'text' : 'password'}
            value={userPassword}
            onChange={(e) => setUserPassword(e.target.value)}
            placeholder="Required to open the file"
          />
          <button
            className="os-reveal"
            type="button"
            onClick={() => setShowPasswords((v) => !v)}
            title={showPasswords ? 'Hide' : 'Show'}
            aria-label={showPasswords ? 'Hide passwords' : 'Show passwords'}
          >
            <EyeIcon />
          </button>
        </div>
      </div>

      <div className="os-field">
        <label htmlFor="pwd-owner">Owner password (optional)</label>
        <div className="os-input-wrap">
          <input
            id="pwd-owner"
            data-testid="pwd-owner"
            className="os-input"
            type={showPasswords ? 'text' : 'password'}
            value={ownerPassword}
            onChange={(e) => setOwnerPassword(e.target.value)}
            placeholder="Restricts editing & printing"
          />
          <button
            className="os-reveal"
            type="button"
            onClick={() => setShowPasswords((v) => !v)}
            title={showPasswords ? 'Hide' : 'Show'}
            aria-label={showPasswords ? 'Hide passwords' : 'Show passwords'}
          >
            <EyeIcon />
          </button>
        </div>
      </div>

      <div className="os-field">
        <label htmlFor="pwd-algo">Encryption algorithm</label>
        <select
          id="pwd-algo"
          data-testid="pwd-algo"
          className="os-input"
          value={algorithm}
          onChange={(e) => setAlgorithm(e.target.value as Algorithm)}
        >
          <option value="RC4_40">RC4 40-bit (legacy)</option>
          <option value="RC4_128">RC4 128-bit</option>
          <option value="AES_128">AES-128</option>
          <option value="AES_256">AES-256 (recommended)</option>
        </select>
      </div>

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 8,
        }}
      >
        <label style={{ marginBottom: 0 }}>Permissions</label>
        <div style={{ display: 'inline-flex', gap: 4 }}>
          <button className="rbtn rbtn-small" data-testid="perms-all-on" onClick={allOn}>
            All on
          </button>
          <button className="rbtn rbtn-small" data-testid="perms-all-off" onClick={allOff}>
            All off
          </button>
        </div>
      </div>

      <div className="os-perms">
        <PermBox label="Print" value={perms.print} onChange={(v) => setPerm('print', v)} testId="perm-print" />
        <PermBox label="Print high-res" value={perms.printHigh} onChange={(v) => setPerm('printHigh', v)} testId="perm-printHigh" />
        <PermBox label="Modify contents" value={perms.modify} onChange={(v) => setPerm('modify', v)} testId="perm-modify" />
        <PermBox label="Copy text" value={perms.copy} onChange={(v) => setPerm('copy', v)} testId="perm-copy" />
        <PermBox label="Annotations" value={perms.annotForms} onChange={(v) => setPerm('annotForms', v)} testId="perm-annotForms" />
        <PermBox label="Fill forms" value={perms.fillForms} onChange={(v) => setPerm('fillForms', v)} testId="perm-fillForms" />
        <PermBox label="A11y extract" value={perms.extract} onChange={(v) => setPerm('extract', v)} testId="perm-extract" />
        <PermBox label="Assemble pages" value={perms.assemble} onChange={(v) => setPerm('assemble', v)} testId="perm-assemble" />
      </div>

      <div
        style={{
          marginTop: 14,
          padding: '10px 12px',
          borderRadius: 10,
          fontSize: 11.5,
          color: 'var(--text-secondary)',
          background:
            mode === 'empty'
              ? 'color-mix(in srgb, var(--danger) 14%, transparent)'
              : 'var(--bg-surface)',
          border: '1px solid var(--hairline)',
        }}
      >
        <strong style={{ color: 'var(--text-primary)' }}>Current mode:</strong>{' '}
        {mode === 'password' && 'Password-protected (requires password to open).'}
        {mode === 'permissions-only' &&
          'Permissions-only (opens freely; restrictions enforced by reader).'}
        {mode === 'empty' &&
          'No protection set. Enter a password OR an owner password with restricted permissions.'}
      </div>
      {status && (
        <div
          data-testid="pwd-status"
          style={{
            marginTop: 10,
            padding: '8px 10px',
            fontSize: 11.5,
            background: 'color-mix(in srgb, var(--danger) 14%, transparent)',
            border: '1px solid var(--hairline)',
            borderRadius: 6,
            color: 'var(--text-primary)',
          }}
        >
          {status}
        </div>
      )}
    </DialogBase>
  )
}

function PermBox({
  label,
  value,
  onChange,
  testId,
}: {
  label: string
  value: boolean | undefined
  onChange: (v: boolean) => void
  testId?: string
}) {
  return (
    <label>
      <input
        type="checkbox"
        className="os-toggle"
        data-testid={testId}
        checked={!!value}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  )
}
