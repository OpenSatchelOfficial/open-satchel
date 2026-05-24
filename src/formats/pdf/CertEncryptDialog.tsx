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
import { useFormatStore } from '../../stores/formatStore'
import { useTabStore } from '../../stores/tabStore'
import type { PdfFormatState } from './index'
import { encryptPdfToCerts } from '../../services/pdfCryptoPubKey'
import DialogBase from '../../components/DialogBase'
import forge from 'node-forge'

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

  const handleEncrypt = async () => {
    if (recipients.length === 0) {
      setStatus('Add at least one recipient certificate.')
      return
    }
    const state = useFormatStore.getState().data[tabId] as PdfFormatState | undefined
    if (!state) {
      setStatus('No PDF state.')
      return
    }
    setBusy(true)
    setStatus('Encrypting…')
    try {
      const out = await encryptPdfToCerts(state.pdfBytes, {
        recipientCertsPem: recipients.map((r) => r.pem),
      })
      // Replace pdfBytes in the format store so subsequent saves use
      // the encrypted bytes. Mark dirty so the user can Ctrl+S into a
      // file path of their choice.
      useFormatStore.getState().updateFormatState<PdfFormatState>(tabId, (prev) => ({
        ...prev,
        pdfBytes: out,
      }))
      useTabStore.getState().setTabDirty(tabId, true)
      setStatus(
        `Encrypted to ${recipients.length} recipient${recipients.length === 1 ? '' : 's'}. ` +
        `File is now V=5 AES-256 cert-encrypted; save with Ctrl+S to write to disk.`,
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
            onClick={handleEncrypt}
            disabled={busy || recipients.length === 0}
          >
            {busy ? 'Encrypting…' : 'Encrypt'}
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
        {/* Programmatic-click button kept so accessibility tooling can
            trigger the file picker. The native <input type=file> only
            opens its picker on a real user gesture, so this button
            invokes .click() on the hidden input on user activation. */}
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
          cert's matching private key will be required to decrypt.
        </div>
      </div>

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
            background: status.startsWith('Encrypted')
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
