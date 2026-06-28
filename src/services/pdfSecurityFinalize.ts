import { getHandler } from '../formats/registry'
import { useFormatStore } from '../stores/formatStore'
import type { PdfFormatState } from '../formats/pdf'
import { encryptPdfToCerts } from './pdfCryptoPubKey'
import { signPdf, type SignOptions } from './pdfSign'
import { signPdfWithPkcs11, type SignPdfWithPkcs11Options } from './pdfSignPkcs11Sign'

export type SecurityFinalizeKind = 'cert-encrypt' | 'sign' | 'certify' | 'pkcs11-sign'

export interface SecurityFinalizeResult {
  kind: SecurityFinalizeKind
  bytes: Uint8Array
  path?: string
}

export type SecurityFinalizeOptions =
  | {
      kind: 'cert-encrypt'
      recipientCertsPem: string[]
      permissions?: number
      outputPath?: string
      suggestedName?: string
    }
  | {
      kind: 'sign' | 'certify'
      p12: Uint8Array
      passphrase: string
      signOptions: SignOptions
      outputPath?: string
      suggestedName?: string
    }
  | {
      kind: 'pkcs11-sign'
      pkcs11Options: SignPdfWithPkcs11Options
      outputPath?: string
      suggestedName?: string
    }

export async function finalizeSecurityCopy(
  tabId: string,
  options: SecurityFinalizeOptions,
): Promise<SecurityFinalizeResult> {
  const state = useFormatStore.getState().getFormatState<PdfFormatState>(tabId)
  if (!state) throw new Error('No PDF state for tab.')
  if (
    options.kind === 'cert-encrypt' &&
    state.encryption &&
    (state.encryption.userPassword || state.encryption.ownerPassword)
  ) {
    throw new Error(
      'This PDF already has pending password protection. Save or clear that protection before creating a certificate-encrypted copy.',
    )
  }

  const sourceBytes = await resolveWysiwygSecurityBytes(tabId)
  let protectedBytes: Uint8Array
  if (options.kind === 'cert-encrypt') {
    protectedBytes = await encryptPdfToCerts(sourceBytes, {
      recipientCertsPem: options.recipientCertsPem,
      permissions: options.permissions,
    })
  } else if (options.kind === 'pkcs11-sign') {
    protectedBytes = await signPdfWithPkcs11(sourceBytes, options.pkcs11Options)
  } else {
    protectedBytes = await signPdf(
      sourceBytes,
      options.p12,
      options.passphrase,
      options.signOptions,
    )
  }

  const path = await writeSecurityCopy(protectedBytes, options.outputPath, options.suggestedName)
  return { kind: options.kind, bytes: protectedBytes, ...(path ? { path } : {}) }
}

export async function resolveWysiwygSecurityBytes(tabId: string): Promise<Uint8Array> {
  const handler = getHandler('pdf')
  if (!handler) throw new Error('PDF handler not registered.')
  return await handler.save(tabId, { forPrint: true })
}

async function writeSecurityCopy(
  bytes: Uint8Array,
  outputPath?: string,
  suggestedName?: string,
): Promise<string | undefined> {
  if (outputPath) {
    const fs = await import('@tauri-apps/plugin-fs')
    await fs.writeFile(outputPath, bytes)
    return outputPath
  }
  const path = await window.api.file.saveAs(bytes, suggestedName)
  return path ?? undefined
}
