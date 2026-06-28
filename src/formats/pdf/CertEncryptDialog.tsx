// Cert-based encryption dialog.
//
// Lets the user pick one or more recipient X.509 certificates
// (PEM or DER), then runs encryptPdfToCerts to produce a V=5
// AES-256 cert-encrypted PDF that only the matching private keys
// can decrypt.
//
// Pipeline: pick certs → load PEM bytes → call encryptPdfToCerts
// → save the result via the standard saveAs flow.
//
// Cert input:
//   - Drop one or more .pem / .crt / .cer files.
//   - DER-encoded certs are auto-converted to PEM via node-forge.
//   - Each cert displays its CN + issuer + serial for confirmation
//     before the user fires the encrypt.

import { useRef, useState } from 'react'
import { useTabStore } from '../../stores/tabStore'
import DialogBase from '../../components/DialogBase'
import forge from 'node-forge'
import { finalizeSecurityCopy } from '../../services/pdfSecurityFinalize'

interface Props {
  tabId: string
  onClose: () => void
}

interface RecipientCert {
  fileName: string
  pem: string
  cn: string
  issuer: string
  serial: string
}

const CertIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M7 8h10M7 12h6M7 16h4" />
  </svg>
)

function describeCert(pem: string): { cn: string; issuer: string; serial: string } {
  const cert = forge.pki.certificateFromPem(pem)
  const cnAttr = cert.subject.getField('CN')
  const issuerCnAttr = cert.issuer.getField('CN')
  return {
    cn: cnAttr?.value ?? '(no CN)',
    issuer: issuerCnAttr?.value ?? '(no issuer CN)',
    serial: cert.serialNumber || '(no serial)',
  }
}

/** Detect whether bytes are PEM (text "-----BEGIN") or DER (binary).
 *  DER gets wrapped via node-forge into PEM for downstream uniformity. */
function bytesToPem(bytes: Uint8Array, fileName: string): string {
  // Quick check: PEM always starts with "-----BEGIN".
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 32))
  if (head.startsWith('-----BEGIN')) {
    return new TextDecoder('utf-8').decode(bytes)
  }
  // Otherwise treat as DER.
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  const asn1 = forge.asn1.fromDer(bin)
  const cert = forge.pki.certificateFromAsn1(asn1)
  void fileName
  return forge.pki.certificateToPem(cert)
}

export default function CertEncryptDialog({ tabId, onClose }: Props) {
  const [recipients, setRecipients] = useState<RecipientCert[]>([])
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const addCertFiles = async (files: FileList | null) => {
    if (!files) return
    setStatus('')
    const additions: RecipientCert[] = []
    for (const file of Array.from(files)) {
      try {
        const buf = new Uint8Array(await file.arrayBuffer())
        const pem = bytesToPem(buf, file.name)
        const desc = describeCert(pem)
        additions.push({ fileName: file.name, pem, ...desc })
      } catch (e) {
        setStatus(`Skipped ${file.name}: ${(e as Error).message}`)
      }
    }
    if (additions.length > 0) setRecipients((prev) => [...prev, ...additions])
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const removeRecipient = (idx: number) => {
    setRecipients((prev) => prev.filter((_, i) => i !== idx))
  }

  const suggestedCopyName = () => {
    const tab = useTabStore.getState().tabs.find((t) => t.id === tabId)
    const base = (tab?.fileName || 'document.pdf').replace(/\.pdf$/i, '')
    return `${base}-cert-encrypted.pdf`
  }

  const handleEncrypt = async (saveDraft: boolean) => {
    if (recipients.length === 0) {
      setStatus('Add at least one recipient certificate.')
      return
    }
    setBusy(true)
    setConfirming(false)
    setStatus(saveDraft ? 'Saving draft, then creating encrypted copy...' : 'Creating encrypted copy...')
    try {
      if (saveDraft) {
        const actions = await import('../../lib/actions')
        await actions.saveActiveTab()
      }
      const result = await finalizeSecurityCopy(tabId, {
        kind: 'cert-encrypt',
        recipientCertsPem: recipients.map((r) => r.pem),
        suggestedName: suggestedCopyName(),
      })
      setStatus(
        result.path
          ? `Created encrypted copy for ${recipients.length} recipient${recipients.length === 1 ? '' : 's'}. Original tab is unchanged.`
          : 'Encrypted bytes were created, but Save As was canceled. Original tab is unchanged.',
      )
    } catch (e) {
      setStatus((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogBase
      open
      onClose={onClose}
      title="Encrypt to recipient certificates"
      subtitle="V=5 AES-256 + Adobe.PubSec — only matching private keys can decrypt."
      icon={<CertIcon />}
      data-testid="cert-encrypt-dialog"
      footer={
        <>
          <button className="btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn-primary"
            data-testid="cert-encrypt-apply"
            onClick={() => setConfirming(true)}
            disabled={busy || recipients.length === 0}
          >
            {busy ? 'Encrypting…' : 'Create encrypted copy...'}
          </button>
        </>
      }
    >
      <div className="os-field">
        <label>Recipient certificates ({recipients.length})</label>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pem,.crt,.cer,.der"
          multiple
          data-testid="cert-encrypt-file-input"
          onChange={(e) => addCertFiles(e.target.files)}
          style={{ marginTop: 4 }}
        />
        {/* Programmatic-click button so headless tests can fire the
            file picker via the patched HTMLInputElement.prototype.click
            (test-hooks/dialog-handlers pdf_inject_picked_file). The
            native <input type=file> only opens its picker on a real
            user gesture, so dispatched MouseEvents from dom_click
            don't trigger the picker codepath. */}
        <button
          type="button"
          className="btn-secondary"
          data-testid="cert-encrypt-pick"
          onClick={() => fileInputRef.current?.click()}
          style={{ marginTop: 6 }}
        >
          Pick certs…
        </button>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
          PEM (.pem/.crt) or DER (.cer/.der) X.509 certificates. Each
          cert's matching private key will be required to decrypt. Open Satchel
          creates a protected copy and leaves this working tab unchanged.
        </div>
      </div>

      {confirming && (
        <div data-testid="security-finalize-prompt" style={{
          margin: '10px 0',
          padding: 10,
          border: '1px solid var(--warn)',
          borderRadius: 6,
          background: 'rgba(230, 180, 0, 0.10)',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-primary)' }}>
            Create a certificate-encrypted copy?
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.45 }}>
            Finish edits before encrypting. The copy can only be opened by holders of the matching
            private keys; this original tab stays editable and unencrypted in memory.
          </div>
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <button type="button" className="btn-ghost" onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
            <button type="button" className="btn-secondary" onClick={() => void handleEncrypt(true)} disabled={busy}>Save Draft First</button>
            <button type="button" className="btn-primary" onClick={() => void handleEncrypt(false)} disabled={busy}>Create Protected Copy</button>
          </div>
        </div>
      )}

      {recipients.length > 0 && (
        <div className="os-field">
          <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
            {recipients.map((r, i) => (
              <li
                key={i}
                data-testid={`cert-recipient-${i}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '6px 8px',
                  marginBottom: 4,
                  background: 'var(--bg-surface)',
                  borderRadius: 6,
                  fontSize: 12,
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 500 }}>{r.cn}</div>
                  <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                    {r.fileName} · issuer: {r.issuer} · serial: {r.serial}
                  </div>
                </div>
                <button
                  type="button"
                  className="rbtn rbtn-small"
                  onClick={() => removeRecipient(i)}
                  data-testid={`cert-recipient-remove-${i}`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {status && (
        <div
          data-testid="cert-encrypt-status"
          style={{
            marginTop: 10,
            padding: '8px 10px',
            fontSize: 11.5,
            background: status.startsWith('Created')
              ? 'color-mix(in srgb, var(--success) 14%, transparent)'
              : 'color-mix(in srgb, var(--danger) 14%, transparent)',
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
