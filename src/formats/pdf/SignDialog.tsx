import { useEffect, useState } from 'react'
import { useFormatStore } from '../../stores/formatStore'
import { useTabStore } from '../../stores/tabStore'
import { useUIStore } from '../../stores/uiStore'
import type { PdfFormatState } from './index'
import {
  generateSelfSignedCert, listSignatures, verifySignatures,
  importP12FromArrayBuffer, validateP12,
  type CertIdentity, type P12ValidationInfo, type SignOptions, type VerifyResult,
} from '../../services/pdfSign'
import {
  listSlots, listCertificates, WELL_KNOWN_MODULES,
  type Pkcs11Slot, type Pkcs11Certificate,
} from '../../services/pdfSignPkcs11'
import { composeAppearanceLines, composeAppearancePreview } from '../../services/pdfSignAppearance'
import { addTrustedCert } from '../../services/pdfTrustStore'
import { finalizeSecurityCopy } from '../../services/pdfSecurityFinalize'

interface Props {
  tabId: string
  onClose: () => void
}

/** All-in-one signature dialog. Shows existing sigs + verification
 *  badges, supports generate + sign + certify. */
export default function SignDialog({ tabId, onClose }: Props) {
  const state = useFormatStore((s) => s.data[tabId] as PdfFormatState | undefined)
  const currentPage = useUIStore((s) => s.currentPage)
  const [tab, setTab] = useState<'sign' | 'verify' | 'hwtoken'>('verify')
  const [hwModulePath, setHwModulePath] = useState<string>(() => {
    const platform = typeof navigator !== 'undefined' && /windows/i.test(navigator.userAgent) ? 'win32'
      : typeof navigator !== 'undefined' && /mac/i.test(navigator.userAgent) ? 'darwin'
      : 'linux'
    return WELL_KNOWN_MODULES[platform]?.[0]?.paths?.[0] ?? ''
  })
  const [hwPin, setHwPin] = useState('')
  const [hwSlots, setHwSlots] = useState<Pkcs11Slot[] | null>(null)
  const [hwSlotId, setHwSlotId] = useState<number | null>(null)
  const [hwCerts, setHwCerts] = useState<Pkcs11Certificate[] | null>(null)
  const [hwCertIdHex, setHwCertIdHex] = useState<string>('')
  const [hwLoading, setHwLoading] = useState<false | 'slots' | 'certs' | 'signing'>(false)
  const [cn, setCn] = useState('My Name')
  const [org, setOrg] = useState('')
  const [reason, setReason] = useState('Approved')
  const [location, setLocation] = useState('')
  const [contactInfo, setContactInfo] = useState('')
  // Visibility toggles for the visible-signature appearance. Each
  // toggle controls whether the corresponding field gets baked into
  // the signature stamp (the /AP stream's text). When off, the value
  // still goes to the underlying CMS / signed dictionary (so verifier
  // tools can see e.g. the reason in the PKCS#7 SignerInfo) but the
  // visible stamp suppresses it. Mirrors Acrobat's appearance editor.
  const [showSignerName, setShowSignerName] = useState(true)
  const [showDate, setShowDate] = useState(true)
  const [showReason, setShowReason] = useState(true)
  const [showLocation, setShowLocation] = useState(false)
  const [showContact, setShowContact] = useState(false)
  const [certifyLevel, setCertifyLevel] = useState<'none' | '1' | '2' | '3'>('none')
  const [tsaUrl, setTsaUrl] = useState('')
  const TSA_PRESETS: Array<{ name: string; url: string }> = [
    { name: '- No timestamp', url: '' },
    { name: 'FreeTSA', url: 'https://freetsa.org/tsr' },
    { name: 'DigiCert', url: 'http://timestamp.digicert.com' },
    { name: 'Sectigo', url: 'http://timestamp.sectigo.com' },
    { name: 'Entrust', url: 'http://timestamp.entrust.net/TSS/RFC3161sha2TS' },
  ]
  const [cert, setCert] = useState<{ p12: Uint8Array; passphrase: string; certPem?: string; source: 'generated' | 'imported'; info?: P12ValidationInfo } | null>(null)
  /** Pending P12 bytes after file-picker, before user enters passphrase. */
  const [pendingP12, setPendingP12] = useState<{ bytes: Uint8Array; filename: string } | null>(null)
  const [p12Passphrase, setP12Passphrase] = useState('')
  /** Enable LTV (Long-Term Validation): embed OCSP/CRL + full cert chain
   *  in /DSS so the signature stays verifiable after the signing cert
   *  expires or the CA's OCSP responder goes offline. Tauri-only because
   *  OCSP fetches go through the same Rust proxy as TSA. Self-signed
   *  certs get silently skipped by zga's addDss — only meaningful for
   *  CA-issued certs (imported via .p12). */
  const [ltv, setLtv] = useState(false)
  const [results, setResults] = useState<VerifyResult[]>([])
  const [loadingVerify, setLoadingVerify] = useState(true)
  const [status, setStatus] = useState('')
  const [running, setRunning] = useState(false)
  const [pendingFinalize, setPendingFinalize] = useState<'p12' | 'hw' | null>(null)

  const loadVerify = async () => {
    // Always pull fresh bytes from the store — `state` here is captured
    // from the render before this async handler fired, which is stale
    // right after sign(). getState() sees the post-sign bytes.
    const freshState = useFormatStore.getState().data[tabId] as PdfFormatState | undefined
    if (!freshState) return
    setLoadingVerify(true)
    try {
      const list = await listSignatures(freshState.pdfBytes)
      if (list.length === 0) {
        setResults([])
      } else {
        setResults(await verifySignatures(freshState.pdfBytes))
      }
    } finally {
      setLoadingVerify(false)
    }
  }

  useEffect(() => { void loadVerify() }, [state?.pdfBytes])

  if (!state) return null

  const generate = async () => {
    setRunning(true)
    setStatus('Generating self-signed certificate…')
    try {
      const identity: CertIdentity = { commonName: cn, organization: org || undefined }
      const c = await generateSelfSignedCert(identity)
      setCert({ ...c, source: 'generated' })
      setPendingFinalize(null)
      setStatus(`Certificate generated. Passphrase embedded; sign below.`)
    } catch (e) {
      setStatus(e instanceof Error ? `Error: ${e.message}` : 'Failed')
    } finally {
      setRunning(false)
    }
  }

  /** Open a file picker for a .p12 / .pfx, stash the bytes, then prompt
   *  the user for the passphrase. Once confirmed, we call
   *  importP12FromArrayBuffer and swap it into the cert state. */
  const pickP12 = async () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.p12,.pfx,application/x-pkcs12'
    input.onchange = async () => {
      const f = input.files?.[0]
      if (!f) return
      const buf = await f.arrayBuffer()
      setPendingP12({ bytes: new Uint8Array(buf), filename: f.name })
      setP12Passphrase('')
      setStatus(`Loaded "${f.name}" - enter the PKCS#12 passphrase to activate.`)
    }
    input.click()
  }

  /** Confirm the pending P12 using the typed passphrase. This parses the
   *  PKCS#12 immediately so a wrong passphrase never becomes the active cert. */
  const confirmP12 = () => {
    if (!pendingP12) return
    try {
      const p12 = importP12FromArrayBuffer(pendingP12.bytes.buffer)
      const info = validateP12(p12, p12Passphrase)
      setCert({ p12, passphrase: p12Passphrase, source: 'imported', info })
      setStatus(
        `Imported "${pendingP12.filename}" (${info.subject}). ` +
        `${info.signingCapable ? 'Signing-capable.' : 'Certificate does not advertise digital-signature key usage.'}`,
      )
      setPendingP12(null)
      setP12Passphrase('')
    } catch (e) {
      setStatus(e instanceof Error ? `Import failed: ${e.message}` : 'Import failed')
    }
  }

  // ── PKCS#11 hardware-token flow ──────────────────────────────────
  const hwRefreshSlots = async () => {
    if (!hwModulePath) { setStatus('Pick a PKCS#11 module path first.'); return }
    setHwLoading('slots')
    setStatus(`Loading slots from ${hwModulePath}…`)
    try {
      const slots = await listSlots(hwModulePath)
      setHwSlots(slots)
      const firstPresent = slots.find(s => s.tokenPresent)
      if (firstPresent) setHwSlotId(firstPresent.slotId)
      setStatus(`Found ${slots.length} slot(s), ${slots.filter(s => s.tokenPresent).length} with a token present.`)
    } catch (e) {
      setStatus(e instanceof Error ? `Module load failed: ${e.message}` : 'Module load failed')
    } finally {
      setHwLoading(false)
    }
  }
  const hwRefreshCerts = async () => {
    if (hwSlotId == null) { setStatus('Pick a slot first.'); return }
    if (!hwPin) { setStatus('Enter the token PIN first.'); return }
    setHwLoading('certs')
    setStatus('Logging in + reading certificates…')
    try {
      const certs = await listCertificates(hwModulePath, hwSlotId, hwPin)
      setHwCerts(certs)
      if (certs.length > 0) setHwCertIdHex(certs[0].idHex)
      setStatus(`Found ${certs.length} certificate(s) on the token.`)
    } catch (e) {
      setStatus(e instanceof Error ? `Login / list failed: ${e.message}` : 'Login / list failed')
    } finally {
      setHwLoading(false)
    }
  }
  const trustHwCert = async () => {
    const c = hwCerts?.find(x => x.idHex === hwCertIdHex)
    if (!c) return
    // Decode cert DER from base64, hash, add to user trust store.
    // Future verification of this signer goes straight to "valid"
    // (green) instead of "valid-untrusted" (yellow).
    const bin = atob(c.certDerB64)
    const der = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i)
    const hash = await crypto.subtle.digest('SHA-256', der)
    const fp = Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, '0')).join('')
    addTrustedCert({ fingerprint: fp, label: c.subject || c.label })
    setStatus(`Added "${c.subject || c.label}" to the user trust store.`)
  }

  const signKind = certifyLevel !== 'none' ? 'certify' as const : 'sign' as const
  const signFlavor = certifyLevel !== 'none' ? `certified (L${certifyLevel})` : 'signed'

  const appearanceFor = (signerName: string): SignOptions['appearance'] => {
    const textLines = composeAppearanceLines({
      showSignerName,
      showDate,
      showReason,
      showLocation,
      showContact,
      cn: signerName,
      reason,
      location,
      contactInfo,
    })
    return textLines.length > 0
      ? {
          pageIndex: currentPage,
          textLines,
          color: '#1e1e2e',
          fontSize: 10,
          lineHeight: 12,
        }
      : undefined
  }

  const baseSignOptions = (signerName: string): SignOptions => ({
    reason: reason || undefined,
    location: location || undefined,
    signerName: signerName || undefined,
    contactInfo: contactInfo || undefined,
    certifyLevel: certifyLevel === 'none' ? undefined : Number(certifyLevel) as 1 | 2 | 3,
    appearance: appearanceFor(signerName),
  })

  const suggestedCopyName = (suffix: string) => {
    const tab = useTabStore.getState().tabs.find((t) => t.id === tabId)
    const base = (tab?.fileName || 'signed-document.pdf').replace(/\.pdf$/i, '')
    return `${base}-${suffix}.pdf`
  }

  const saveDraftFirst = async () => {
    setStatus('Saving draft before creating protected copy...')
    const actions = await import('../../lib/actions')
    await actions.saveActiveTab()
  }

  const openSignedCopy = async (path?: string) => {
    if (!path) return
    const actions = await import('../../lib/actions')
    await actions.openFromPath(path)
    onClose()
  }

  const runP12Finalize = async (saveDraft: boolean) => {
    if (!cert) { setStatus('Generate or import a cert first.'); return }
    setRunning(true)
    setPendingFinalize(null)
    const withTsa = tsaUrl ? ' + TSA' : ''
    setStatus(`Creating ${signFlavor}${withTsa} copy...`)
    try {
      if (saveDraft) await saveDraftFirst()
      const signerName = cn || cert.info?.subject || 'Open Satchel signer'
      const result = await finalizeSecurityCopy(tabId, {
        kind: signKind,
        p12: cert.p12,
        passphrase: cert.passphrase,
        signOptions: {
          ...baseSignOptions(signerName),
          tsaUrl: tsaUrl || undefined,
          ltv: ltv || undefined,
        },
        suggestedName: suggestedCopyName(signKind === 'certify' ? 'certified' : 'signed'),
      })
      setStatus(
        result.path
          ? `Created ${signFlavor}${withTsa} copy. Original tab is unchanged.`
          : `Created ${signFlavor}${withTsa} bytes, but Save As was canceled. Original tab is unchanged.`,
      )
      await openSignedCopy(result.path)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed'
      const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
      const fetchError = msg.includes('CORS') || msg.includes('Network') || msg.includes('fetch')
      setStatus(
        fetchError && !isTauri
          ? `TSA failed (browser CORS blocks TSA POSTs; run the Tauri build for TSA/LTV): ${msg}`
          : `Error: ${msg}`,
      )
    } finally {
      setRunning(false)
    }
  }

  const runHwFinalize = async (saveDraft: boolean) => {
    if (hwSlotId == null || !hwPin || !hwCertIdHex) {
      setStatus('Pick a slot, enter PIN, and select a certificate first.')
      return
    }
    const certObj = hwCerts?.find(c => c.idHex === hwCertIdHex)
    if (!certObj) { setStatus('Selected cert not found in the enumeration.'); return }
    setHwLoading('signing')
    setPendingFinalize(null)
    setStatus('Creating signed copy via PKCS#11 token...')
    try {
      if (saveDraft) await saveDraftFirst()
      const signerName = cn || certObj.subject || certObj.label
      const result = await finalizeSecurityCopy(tabId, {
        kind: 'pkcs11-sign',
        pkcs11Options: {
          modulePath: hwModulePath,
          slotId: hwSlotId,
          pin: hwPin,
          keyIdHex: hwCertIdHex,
          certDerB64: certObj.certDerB64,
          ...baseSignOptions(signerName),
        },
        suggestedName: suggestedCopyName(signKind === 'certify' ? 'certified-hw' : 'signed-hw'),
      })
      setStatus(
        result.path
          ? `Created signed hardware-token copy. Original tab is unchanged.`
          : `Created signed bytes, but Save As was canceled. Original tab is unchanged.`,
      )
      await openSignedCopy(result.path)
    } catch (e) {
      setStatus(e instanceof Error ? `Hardware sign failed: ${e.message}` : 'Hardware sign failed')
    } finally {
      setHwLoading(false)
    }
  }

  const requestSign = () => {
    if (!cert) { setStatus('Generate a cert first.'); return }
    setPendingFinalize('p12')
  }

  const requestHwSign = () => {
    if (hwSlotId == null || !hwPin || !hwCertIdHex) {
      setStatus('Pick a slot, enter PIN, and select a certificate first.')
      return
    }
    setPendingFinalize('hw')
  }

  return (
    <div
      data-testid="sign-dialog"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: 'var(--bg-primary)', borderRadius: 8, padding: 20,
        border: '1px solid var(--border)', width: 560, maxHeight: '85vh',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>Digital Signatures</h3>
          <button onClick={onClose} style={{ background:'transparent', border:'none', color:'var(--text-primary)', cursor:'pointer', fontSize:18 }}>✕</button>
        </div>

        <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--border)', marginBottom: 10 }}>
          <TabBtn active={tab === 'verify'} onClick={() => setTab('verify')} testId="sign-tab-verify">Verify ({results.length})</TabBtn>
          <TabBtn active={tab === 'sign'} onClick={() => setTab('sign')} testId="sign-tab-sign">Sign…</TabBtn>
          <TabBtn active={tab === 'hwtoken'} onClick={() => setTab('hwtoken')} testId="sign-tab-hwtoken">Hardware token</TabBtn>
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {tab === 'verify' && (
            <>
              {loadingVerify ? (
                <div style={{ padding: 16, fontSize: 11, color: 'var(--text-muted)' }}>Verifying signatures…</div>
              ) : results.length === 0 ? (
                <div style={{ padding: 16, fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>
                  No signatures on this document yet.
                </div>
              ) : (
                results.map((r, i) => <VerifyRow key={i} idx={i} r={r} />)
              )}
            </>
          )}

          {tab === 'sign' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <p style={{ margin: 0, fontSize: 11, color: 'var(--text-secondary)' }}>
                Create a signed copy of the current document. Finish visual signatures, form fills, redactions, and edits first; the original tab stays editable, and later edits to the signed copy can invalidate its cryptographic signature. Adobe Reader will show self-signed certs as valid-but-untrusted.
              </p>
              <Field label="Common Name (signer)">
                <input data-testid="sign-cn" style={inp} value={cn} onChange={(e) => setCn(e.target.value)} />
              </Field>
              <Field label="Organization (optional)">
                <input data-testid="sign-org" style={inp} value={org} onChange={(e) => setOrg(e.target.value)} />
              </Field>
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <Field label="Reason">
                    <input data-testid="sign-reason" style={inp} value={reason} onChange={(e) => setReason(e.target.value)} />
                  </Field>
                </div>
                <div style={{ flex: 1 }}>
                  <Field label="Location">
                    <input data-testid="sign-location" style={inp} value={location} onChange={(e) => setLocation(e.target.value)} />
                  </Field>
                </div>
              </div>

              <Field label="Certify level (empty = ordinary approval signature)">
                <select data-testid="sign-certify" style={inp}
                  value={certifyLevel}
                  onChange={(e) => setCertifyLevel(e.target.value as typeof certifyLevel)}>
                  <option value="none">- None (approval signature)</option>
                  <option value="1">Level 1 - No changes allowed</option>
                  <option value="2">Level 2 - Form fill + signatures allowed</option>
                  <option value="3">Level 3 - Form fill + sigs + annotations allowed</option>
                </select>
              </Field>

              <Field label="Contact info (optional)">
                <input data-testid="sign-contact" style={inp} value={contactInfo} onChange={(e) => setContactInfo(e.target.value)} placeholder="email or phone" />
              </Field>

              {/* Visible-signature appearance editor — toggles control
                  what gets baked into the visible stamp on the page.
                  Underlying signed dict still carries reason/location/etc
                  (so PKCS#7 SignerInfo verifiers see them); only the
                  drawn appearance respects these toggles. Mirrors
                  Acrobat's "Configure Visible Signature Appearance" UX. */}
              <div data-testid="sign-appearance-editor" style={{ marginTop: 8, padding: 10, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg-surface)' }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>
                  Visible signature appearance
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, fontSize: 10.5 }}>
                  <SigAppearanceToggle
                    testid="sign-show-name"
                    label="Signer name"
                    value={showSignerName}
                    onChange={setShowSignerName}
                  />
                  <SigAppearanceToggle
                    testid="sign-show-date"
                    label="Date / time"
                    value={showDate}
                    onChange={setShowDate}
                  />
                  <SigAppearanceToggle
                    testid="sign-show-reason"
                    label="Reason"
                    value={showReason}
                    onChange={setShowReason}
                  />
                  <SigAppearanceToggle
                    testid="sign-show-location"
                    label="Location"
                    value={showLocation}
                    onChange={setShowLocation}
                  />
                  <SigAppearanceToggle
                    testid="sign-show-contact"
                    label="Contact info"
                    value={showContact}
                    onChange={setShowContact}
                  />
                </div>
                <div data-testid="sign-appearance-preview" style={{ marginTop: 8, padding: 10, border: '1px dashed var(--accent)', borderRadius: 4, background: 'var(--bg-primary)', minHeight: 64 }}>
                  <div style={{ fontSize: 9.5, color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.6 }}>
                    Preview
                  </div>
                  {composeAppearancePreview({ showSignerName, showDate, showReason, showLocation, showContact, cn, reason, location, contactInfo }).map((line, i) => (
                    <div key={i} style={{ fontSize: 11, color: 'var(--text-primary)', fontFamily: 'monospace', lineHeight: 1.4 }}>
                      {line}
                    </div>
                  ))}
                </div>
              </div>

              <Field label="TSA (RFC 3161 timestamp - Tauri desktop build; browser preview CORS-blocks public TSAs)">
                <select data-testid="sign-tsa" style={inp}
                  value={tsaUrl}
                  onChange={(e) => setTsaUrl(e.target.value)}>
                  {TSA_PRESETS.map((p) => (
                    <option key={p.name} value={p.url}>{p.name}</option>
                  ))}
                </select>
              </Field>

              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-secondary)', userSelect: 'none' }}>
                <input
                  data-testid="sign-ltv"
                  type="checkbox"
                  checked={ltv}
                  onChange={(e) => setLtv(e.target.checked)}
                />
                <span>
                  Enable LTV (Long-Term Validation) - embed OCSP + full chain in /DSS.
                  Requires CA-issued cert; zga silently skips for self-signed.
                  Tauri-only (OCSP fetches go through the Rust proxy).
                </span>
              </label>

              {/* Pending P12 passphrase prompt — shown only when a file is loaded but not yet activated. */}
              {pendingP12 && (
                <div data-testid="sign-p12-pending" style={{
                  padding: 8, marginTop: 4, border: '1px solid var(--border)', borderRadius: 4,
                  background: 'var(--bg-surface)', display: 'flex', flexDirection: 'column', gap: 6,
                }}>
                  <div style={{ fontSize: 11, color: 'var(--text-primary)' }}>
                    Passphrase for <strong>{pendingP12.filename}</strong>:
                  </div>
                  <input
                    data-testid="sign-p12-passphrase"
                    type="password"
                    autoFocus
                    style={inp}
                    value={p12Passphrase}
                    onChange={(e) => setP12Passphrase(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') confirmP12() }}
                    placeholder="••••••••"
                  />
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={confirmP12} disabled={!p12Passphrase} style={btnPrimary}>
                      Activate
                    </button>
                    <button onClick={() => { setPendingP12(null); setP12Passphrase(''); setStatus('') }} style={btnSecondary}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                <button data-testid="sign-gen" onClick={generate} disabled={running}
                  style={btnSecondary}>
                  {cert?.source === 'generated' ? 'Regenerate cert' : 'Generate cert'}
                </button>
                <button data-testid="sign-import" onClick={pickP12} disabled={running}
                  style={btnSecondary}>
                  Import .p12 / .pfx
                </button>
                <button data-testid="sign-sign" onClick={requestSign} disabled={!cert || running}
                  style={{ ...btnPrimary, opacity: (!cert || running) ? 0.5 : 1 }}>
                  {running ? 'Signing…'
                    : certifyLevel !== 'none' ? `Certify & sign (L${certifyLevel})`
                    : ltv && tsaUrl ? 'Sign + LTV + TSA'
                    : ltv ? 'Sign with LTV'
                    : tsaUrl ? 'Sign with timestamp'
                    : 'Sign'}
                </button>
              </div>
              {pendingFinalize === 'p12' && (
                <SecurityFinalizePrompt
                  createLabel="Create Signed Copy"
                  onCancel={() => setPendingFinalize(null)}
                  onSaveDraft={() => void runP12Finalize(true)}
                  onCreate={() => void runP12Finalize(false)}
                  busy={running}
                />
              )}
              {cert && (
                <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                  Active cert: {cert.source === 'imported' ? 'imported .p12' : 'self-signed (generated)'}
                  {cert.info ? ` · ${cert.info.subject} · expires ${cert.info.expiresAt.slice(0, 10)}` : ''}
                  {cert.info && !cert.info.signingCapable ? ' · key usage warning' : ''}
                </div>
              )}
            </div>
          )}

          {tab === 'hwtoken' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <p style={{ margin: 0, fontSize: 11, color: 'var(--text-secondary)' }}>
                Sign using a YubiKey, smart card (PIV / CAC), or HSM via PKCS#11.
                The private key never leaves the token.
              </p>

              <Field label="PKCS#11 module (.dll / .so / .dylib)">
                <div style={{ display: 'flex', gap: 6 }}>
                  <select data-testid="hw-module-preset" style={{ ...inp, flex: 1 }}
                    value={hwModulePath}
                    onChange={(e) => { setHwModulePath(e.target.value); setHwSlots(null); setHwCerts(null) }}>
                    {(WELL_KNOWN_MODULES[
                      typeof navigator !== 'undefined' && /windows/i.test(navigator.userAgent) ? 'win32'
                      : typeof navigator !== 'undefined' && /mac/i.test(navigator.userAgent) ? 'darwin'
                      : 'linux'
                    ] ?? []).flatMap(g => g.paths.map(p => (
                      <option key={g.label + p} value={p}>{g.label} - {p}</option>
                    )))}
                    <option value="">- Custom path…</option>
                  </select>
                </div>
                {hwModulePath === '' && (
                  <input data-testid="hw-module-custom" style={{ ...inp, marginTop: 4 }}
                    placeholder="C:\path\to\pkcs11.dll"
                    onChange={(e) => setHwModulePath(e.target.value)} />
                )}
              </Field>

              <div style={{ display: 'flex', gap: 8 }}>
                <button data-testid="hw-load-slots" onClick={hwRefreshSlots}
                  disabled={!hwModulePath || !!hwLoading}
                  style={btnSecondary}>
                  {hwLoading === 'slots' ? 'Loading slots…' : 'Load slots'}
                </button>
              </div>

              {hwSlots && (
                <Field label="Slot">
                  <select data-testid="hw-slot" style={inp}
                    value={hwSlotId ?? ''}
                    onChange={(e) => { setHwSlotId(Number(e.target.value)); setHwCerts(null) }}>
                    <option value="">- Select slot -</option>
                    {hwSlots.map(s => (
                      <option key={s.slotId} value={s.slotId}
                        disabled={!s.tokenPresent}>
                        Slot {s.slotId} - {s.tokenLabel ?? '(no token)'}
                        {s.tokenSerial ? ` - serial ${s.tokenSerial.trim()}` : ''}
                      </option>
                    ))}
                  </select>
                </Field>
              )}

              {hwSlots && hwSlotId != null && (
                <Field label="Token PIN">
                  <input data-testid="hw-pin" type="password" style={inp}
                    value={hwPin} onChange={(e) => setHwPin(e.target.value)}
                    placeholder="••••" />
                </Field>
              )}

              {hwSlots && hwSlotId != null && hwPin && (
                <div style={{ display: 'flex', gap: 8 }}>
                  <button data-testid="hw-load-certs" onClick={hwRefreshCerts}
                    disabled={!!hwLoading}
                    style={btnSecondary}>
                    {hwLoading === 'certs' ? 'Logging in…' : 'List certificates on token'}
                  </button>
                </div>
              )}

              {hwCerts && hwCerts.length > 0 && (
                <Field label="Signing certificate">
                  <select data-testid="hw-cert" style={inp}
                    value={hwCertIdHex}
                    onChange={(e) => setHwCertIdHex(e.target.value)}>
                    {hwCerts.map(c => (
                      <option key={c.idHex} value={c.idHex}>
                        {c.subject || c.label} {c.idHex ? `(id ${c.idHex.slice(0, 8)}…)` : ''}
                      </option>
                    ))}
                  </select>
                </Field>
              )}

              {hwCerts && hwCerts.length === 0 && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  No certificates on this token. Import one with your token's
                  management tool (YubiKey Manager, PIV Tool, etc.).
                </div>
              )}

              {hwCerts && hwCerts.length > 0 && (
                <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                  <button data-testid="hw-sign" onClick={requestHwSign}
                    disabled={!hwCertIdHex || !!hwLoading}
                    style={{ ...btnPrimary, opacity: (!hwCertIdHex || !!hwLoading) ? 0.5 : 1 }}>
                    {hwLoading === 'signing' ? 'Signing…'
                      : certifyLevel !== 'none' ? `Certify & sign (L${certifyLevel})`
                      : 'Sign with hardware token'}
                  </button>
                  <button data-testid="hw-trust" onClick={trustHwCert}
                    disabled={!hwCertIdHex || !!hwLoading}
                    style={btnSecondary}>
                    Trust this signer
                  </button>
                </div>
              )}
              {pendingFinalize === 'hw' && (
                <SecurityFinalizePrompt
                  createLabel="Create Signed Copy"
                  onCancel={() => setPendingFinalize(null)}
                  onSaveDraft={() => void runHwFinalize(true)}
                  onCreate={() => void runHwFinalize(false)}
                  busy={hwLoading === 'signing'}
                />
              )}

              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
                Reason / Location / Certify level / Signer name and visible appearance are picked up
                from the Sign tab. Switch tabs to edit them before creating the signed copy.
              </div>
            </div>
          )}
        </div>

        {status && (
          <div data-testid="sign-status" style={{
            marginTop: 10, padding: 6, background: 'var(--bg-surface)', borderRadius: 3,
            fontSize: 11, color: 'var(--text-primary)',
          }}>{status}</div>
        )}
      </div>
    </div>
  )
}

function VerifyRow({ idx, r }: { idx: number; r: VerifyResult }) {
  const color = r.summary === 'valid' ? '#3ecc7f'
    : r.summary === 'valid-untrusted' ? '#e6b400'
    : r.summary === 'modified' ? '#e05858'
    : r.summary === 'invalid' ? '#e05858'
    : '#888'
  const icon = r.summary === 'valid' ? '✓'
    : r.summary === 'valid-untrusted' ? '!'
    : r.summary === 'modified' ? '✗'
    : r.summary === 'invalid' ? '✗'
    : '?'
  return (
    <div data-testid={`verify-row-${idx}`} style={{
      padding: 10, marginBottom: 6, borderRadius: 4,
      background: 'var(--bg-surface)', border: '1px solid var(--border)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <div style={{
          width: 22, height: 22, borderRadius: 11,
          background: color, color: '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontWeight: 700, fontSize: 12,
        }}>{icon}</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
            {r.signerName || r.fieldName}
            {r.certified && <span style={{
              marginLeft: 6, fontSize: 9, padding: '1px 5px', borderRadius: 2,
              background: 'rgba(80,160,220,0.2)', color: 'var(--text-primary)',
              textTransform: 'uppercase',
            }}>Certified · L{r.certifyLevel ?? '?'}</span>}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
            {r.reason && `${r.reason} · `}
            {r.location && `${r.location} · `}
            {r.signedAt && prettyDate(r.signedAt)}
          </div>
        </div>
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 4 }}>{r.message}</div>
      <div style={{ display: 'flex', gap: 8, fontSize: 9, flexWrap: 'wrap' }}>
        <Check label="Crypto" ok={r.signatureValid} />
        <Check label="Not modified" ok={r.documentUnmodified} />
        <Check label="Cert in validity" ok={r.certValidNow} />
      </div>
      {r.subject && (
        <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 4, fontFamily: 'monospace' }}>
          Subject: {r.subject}
        </div>
      )}
    </div>
  )
}

function Check({ label, ok }: { label: string; ok: boolean }) {
  return (
    <span style={{
      padding: '2px 6px', borderRadius: 2,
      background: ok ? 'rgba(62,204,127,0.15)' : 'rgba(224,88,88,0.15)',
      color: ok ? '#3ecc7f' : '#e05858',
    }}>
      {ok ? '✓' : '✗'} {label}
    </span>
  )
}

function prettyDate(m: string): string {
  // PDF date strings: D:YYYYMMDDHHmmSS+HH'mm'
  const match = /^D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?/.exec(m)
  if (!match) return m
  const [, y, mo, d, h = '00', mi = '00'] = match
  return `${y}-${mo}-${d} ${h}:${mi}`
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={{ fontSize: 11, color: 'var(--text-secondary)', display: 'block', marginBottom: 3 }}>{label}</label>
      {children}
    </div>
  )
}

function TabBtn({ active, onClick, children, testId }: {
  active: boolean; onClick: () => void; children: React.ReactNode; testId?: string
}) {
  return (
    <button data-testid={testId} onClick={onClick} style={{
      padding: '6px 16px', fontSize: 12, fontWeight: active ? 600 : 400,
      color: active ? 'var(--accent)' : 'var(--text-secondary)',
      background: 'transparent',
      borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
      border: 'none', borderRadius: 0, cursor: 'pointer',
    }}>{children}</button>
  )
}

function SecurityFinalizePrompt({
  createLabel,
  onCancel,
  onSaveDraft,
  onCreate,
  busy,
}: {
  createLabel: string
  onCancel: () => void
  onSaveDraft: () => void
  onCreate: () => void
  busy: boolean
}) {
  return (
    <div data-testid="security-finalize-prompt" style={{
      marginTop: 8,
      padding: 10,
      border: '1px solid var(--warn)',
      borderRadius: 4,
      background: 'rgba(230, 180, 0, 0.10)',
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
    }}>
      <div style={{ fontSize: 11, color: 'var(--text-primary)', fontWeight: 600 }}>
        Create a protected copy?
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--text-secondary)', lineHeight: 1.45 }}>
        Finish edits before signing. Open Satchel will bake the current document into a new signed copy;
        the original tab stays editable, and editing the signed copy later can invalidate its signature.
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        <button type="button" onClick={onCancel} disabled={busy} style={btnSecondary}>Cancel</button>
        <button type="button" onClick={onSaveDraft} disabled={busy} style={btnSecondary}>Save Draft First</button>
        <button type="button" onClick={onCreate} disabled={busy} style={btnPrimary}>{createLabel}</button>
      </div>
    </div>
  )
}

const inp: React.CSSProperties = {
  width: '100%', padding: '6px 8px', fontSize: 12,
  background: 'var(--bg-surface)', border: '1px solid var(--border)',
  borderRadius: 3, color: 'var(--text-primary)', boxSizing: 'border-box',
}
const btnPrimary: React.CSSProperties = {
  padding: '6px 16px', background: 'var(--accent)', color: 'var(--bg-primary)',
  border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 600,
}
const btnSecondary: React.CSSProperties = {
  padding: '6px 16px', background: 'var(--bg-surface)', color: 'var(--text-primary)',
  border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer', fontSize: 12,
}

/** A single visibility toggle in the appearance editor. Compact
 *  (label + checkbox in a row) so 5 toggles fit in two rows of two
 *  without crowding. */
function SigAppearanceToggle({
  label,
  value,
  onChange,
  testid,
}: {
  label: string
  value: boolean
  onChange: (v: boolean) => void
  testid: string
}) {
  return (
    <label
      data-testid={testid}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        cursor: 'pointer',
        userSelect: 'none',
        color: 'var(--text-primary)',
      }}
    >
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        style={{ margin: 0 }}
      />
      <span>{label}</span>
    </label>
  )
}

// composeAppearancePreview lives in services/pdfSignAppearance.ts —
// re-exported here is intentional for backward-compat; new callers
// should import from the service module directly.
export { composeAppearancePreview } from '../../services/pdfSignAppearance'
