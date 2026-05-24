import { useEffect, useRef, useState } from 'react'
import DialogBase from './DialogBase'
import {
  openEncryptedPdfRequest,
  setEncryptedPdfOpenHandler,
  type EncryptedPdfOpenRequest,
} from '../lib/actions'

export default function EncryptedOpenDialog() {
  const [request, setRequest] = useState<EncryptedPdfOpenRequest | null>(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    return setEncryptedPdfOpenHandler((next) => {
      setRequest(next)
      setPassword('')
      setError(null)
      setBusy(false)
    })
  }, [])

  useEffect(() => {
    if (!request) return
    const id = window.setTimeout(() => inputRef.current?.focus(), 40)
    return () => window.clearTimeout(id)
  }, [request])

  const close = () => {
    if (busy) return
    setRequest(null)
    setPassword('')
    setError(null)
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!request || busy) return
    setBusy(true)
    setError(null)
    try {
      await openEncryptedPdfRequest(request, password)
      setRequest(null)
      setPassword('')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogBase
      open={!!request}
      onClose={close}
      title="Open Protected PDF"
      subtitle={request ? request.name : undefined}
      width={440}
      data-testid="encrypted-open-dialog"
      footerMeta="Password is used only to unlock this file locally."
      footer={
        <>
          <button
            className="btn-ghost"
            type="button"
            onClick={close}
            disabled={busy}
            data-testid="encrypted-open-cancel"
          >
            Cancel
          </button>
          <button
            className="btn-primary"
            type="submit"
            form="encrypted-open-form"
            disabled={busy || password.length === 0}
            data-testid="encrypted-open-submit"
          >
            {busy ? 'Opening...' : 'Open'}
          </button>
        </>
      }
    >
      <form id="encrypted-open-form" onSubmit={submit}>
        <div className="os-field">
          <label htmlFor="encrypted-open-password">Password</label>
          <input
            ref={inputRef}
            id="encrypted-open-password"
            className="os-input"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            data-testid="encrypted-open-password"
          />
        </div>
        {error && (
          <div
            role="alert"
            data-testid="encrypted-open-error"
            style={{
              border: '1px solid var(--bad)',
              color: 'var(--bad)',
              background: 'color-mix(in srgb, var(--bad) 10%, transparent)',
              borderRadius: 8,
              padding: '10px 12px',
              fontSize: 12,
              lineHeight: 1.45,
            }}
          >
            {error}
          </div>
        )}
      </form>
    </DialogBase>
  )
}
