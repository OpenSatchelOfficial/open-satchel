// Visible-signature appearance composer. Pure helper extracted from
// SignDialog so it can be unit-tested without bundling the whole
// React component tree, and so future signers (batch sign, action
// wizard) can reuse the same line-composition logic.
//
// The toggles + fields here mirror Acrobat's "Configure Visible
// Signature Appearance" panel: each on/off boolean controls whether
// the corresponding line appears in the rendered signature stamp.

export interface SignAppearanceOptions {
  showSignerName: boolean
  showDate: boolean
  showReason: boolean
  showLocation: boolean
  showContact: boolean
  /** Common name / signer name. Skipped if showSignerName=false or empty. */
  cn: string
  reason: string
  location: string
  contactInfo: string
  /** Optional fixed timestamp for tests / batch sign. Default = now. */
  now?: Date
}

/** Build the lines for the live preview pane. Mirrors the order
 *  Acrobat uses: signer name on the first line, then date, then
 *  reason, location, contact each on their own line if enabled. */
export function composeAppearancePreview(opts: SignAppearanceOptions): string[] {
  const out = composeAppearanceLines(opts)
  if (out.length === 0) out.push('(empty signature stamp - toggle visibility above)')
  return out
}

export function composeAppearanceLines(opts: SignAppearanceOptions): string[] {
  const out: string[] = []
  const now = opts.now ?? new Date()
  if (opts.showSignerName && opts.cn) out.push(`Signed by: ${opts.cn}`)
  if (opts.showDate) out.push(`Date: ${now.toLocaleString()}`)
  if (opts.showReason && opts.reason) out.push(`Reason: ${opts.reason}`)
  if (opts.showLocation && opts.location) out.push(`Location: ${opts.location}`)
  if (opts.showContact && opts.contactInfo) out.push(`Contact: ${opts.contactInfo}`)
  return out
}
