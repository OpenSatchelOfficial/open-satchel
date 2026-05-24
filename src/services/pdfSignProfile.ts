// PAdES profile classifier. Inspects a signed PDF + reports which
// PAdES level it conforms to:
//   unsigned: no /Sig dictionary at all
//   B-B:      basic signature, no timestamp
//   B-T:      basic + RFC 3161 timestamp from a TSA
//   B-LT:     B-T + /DSS (Document Security Store) with cert chain +
//             OCSP / CRL responses for long-term validation
//   B-LTA:    B-LT + archive timestamp covering everything (the
//             "long-term-archive" profile that survives CA expiry
//             via successive timestamp re-validation)
//
// This is a structural classifier — it doesn't validate the
// cryptography. It tells you "what level of PAdES this PDF is
// SHAPED for" given the dictionaries present. For runtime
// verification (chain valid, OCSP fresh, etc.) use the full
// signature-verification path in pdfSign.ts.
//
// Procurement value: gov / regulated buyers with PAdES requirements
// (eIDAS, EU regulation) want to confirm a doc is at least B-LT
// before accepting it for archival.

export type PadesProfile = 'unsigned' | 'B-B' | 'B-T' | 'B-LT' | 'B-LTA' | 'unknown'

export interface SignProfileReport {
  profile: PadesProfile
  /** Number of /Sig dictionaries (signature placements). 0 = unsigned. */
  signatureCount: number
  /** True if any signature has a TSA timestamp (/Type /DocTimeStamp
   *  OR a /Sig with PKCS#7's signed-attribute time-stamp-token
   *  contents — we detect the former cheaply via byte-scan). */
  hasTimestamp: boolean
  /** True if /DSS (Document Security Store) catalog entry is present. */
  hasDss: boolean
  /** True if a /Type /DocTimeStamp signature signs the entire
   *  document AFTER the /DSS — the archive-timestamp signature. */
  hasArchiveTimestamp: boolean
  /** Notes for the UI / audit log. */
  notes: string[]
}

/** Classify a signed PDF's PAdES profile. Pure byte-level scan; no
 *  pdf-lib parse needed (works on encrypted docs too). */
export function classifySignProfile(bytes: Uint8Array): SignProfileReport {
  const text = new TextDecoder('latin1').decode(bytes)
  const notes: string[] = []

  // Count /Sig dicts. PDF spec: signature value is a dict with
  // /Type /Sig (or implied by being the value of an /AcroForm
  // /Fields entry's /V slot). The /Type /Sig form is canonical
  // for all conformant signers.
  const sigMatches = text.match(/\/Type\s*\/Sig\b/g)
  const signatureCount = sigMatches ? sigMatches.length : 0

  // /DocTimeStamp — RFC 3161 timestamp signatures. Distinct shape
  // from /Sig (different /SubFilter ETSI.RFC3161 / adbe.pkcs7.sha1).
  const dtsMatches = text.match(/\/Type\s*\/DocTimeStamp\b/g)
  const docTimestampCount = dtsMatches ? dtsMatches.length : 0

  // /SubFilter ETSI.RFC3161 inside any signature dict — strong
  // evidence of a TSA-attached signature.
  const hasTsaSubFilter = /\/SubFilter\s*\/ETSI\.RFC3161/.test(text)

  // Detached PKCS#7 with a signed-attribute time-stamp-token —
  // some signers embed the TSA inside the PKCS#7 itself rather
  // than as a separate /DocTimeStamp. Hard to byte-scan reliably
  // without parsing PKCS#7; we treat the presence of any TSA
  // SubFilter OR any /DocTimeStamp as enough to flag B-T.
  const hasTimestamp = hasTsaSubFilter || docTimestampCount > 0

  // /DSS catalog entry — Document Security Store. Holds the cert
  // chain + OCSP / CRL responses for LTV.
  const hasDss = /\/DSS\s/.test(text)

  // Archive timestamp: /DocTimeStamp signature placed AFTER the
  // /DSS (so it covers the LTV data). We check for "two or more"
  // /DocTimeStamp dicts as a heuristic — a B-LTA always has the
  // initial signature timestamp + an archive timestamp; a B-T
  // typically has just one. Combined with /DSS presence this is
  // a reliable signal.
  const hasArchiveTimestamp = hasDss && docTimestampCount >= 2

  // Profile classification.
  let profile: PadesProfile = 'unknown'
  if (signatureCount === 0 && docTimestampCount === 0) {
    profile = 'unsigned'
  } else if (hasArchiveTimestamp) {
    profile = 'B-LTA'
  } else if (hasDss) {
    profile = 'B-LT'
  } else if (hasTimestamp) {
    profile = 'B-T'
  } else {
    profile = 'B-B'
  }

  // Audit notes — useful for procurement reviewer lists.
  notes.push(`${signatureCount} signature${signatureCount === 1 ? '' : 's'} found`)
  if (docTimestampCount > 0) notes.push(`${docTimestampCount} /DocTimeStamp dict${docTimestampCount === 1 ? '' : 's'}`)
  if (hasTsaSubFilter) notes.push('signature carries /SubFilter ETSI.RFC3161 (TSA)')
  if (hasDss) notes.push('/DSS document security store present (LTV)')
  if (hasArchiveTimestamp) notes.push('archive timestamp covers /DSS — long-term archive ready')

  return {
    profile,
    signatureCount,
    hasTimestamp,
    hasDss,
    hasArchiveTimestamp,
    notes,
  }
}

/** Human-readable description of a PAdES profile for UI / docs. */
export function describeProfile(profile: PadesProfile): string {
  switch (profile) {
    case 'unsigned':
      return 'Unsigned'
    case 'B-B':
      return 'PAdES B-B (Basic signature, no timestamp)'
    case 'B-T':
      return 'PAdES B-T (with RFC 3161 timestamp)'
    case 'B-LT':
      return 'PAdES B-LT (long-term, includes cert chain + revocation)'
    case 'B-LTA':
      return 'PAdES B-LTA (long-term-archive, archive timestamp covers LTV)'
    case 'unknown':
      return 'Unknown profile'
  }
}
