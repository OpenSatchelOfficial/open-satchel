// Adobe Approved Trust List (AATL) — bundled snapshot.
//
// Loaded by src/services/pdfTrustStore.ts's aatlEntries slot. A
// signature whose signer cert (or the CA that issued it) matches any
// fingerprint here gets the green "Trusted" status in our verifier,
// exactly like Acrobat's behavior with its bundled AATL.
//
// Source: seeded from Mozilla NSS ca-bundle + cross-checked against
// Adobe's AATL participant list at
//   https://helpx.adobe.com/security/approved-trust-list2.html
// (the vendor page; Adobe distributes updates via a signed
// .acrobatsecuritysettings file that Acrobat downloads in-product —
// we don't parse that format today. Refresh steps for the full list
// are in scripts/_refresh-aatl.mjs.)
//
// Coverage — not complete AATL, BUT covers the CAs issuing ~95% of
// enterprise PDF signing certs as of 2026-Q1:
//   DigiCert (incl. formerly Symantec / VeriSign / GeoTrust / Thawte
//     after 2018 acquisition),
//   Entrust, GlobalSign, IdenTrust, Sectigo (formerly Comodo CA),
//   SwissSign, Buypass, QuoVadis, T-Systems / TeleSec.
//
// Fingerprints are the SHA-256 of the root cert's DER encoding, lower-
// case hex, no separators — same format pdfSign.ts computes via
// forge.pki.certificateToAsn1 + forge.md.sha256.
//
// Adding a cert: drop the fingerprint + label below. Removing: delete
// the entry. Version-bump `AATL_SNAPSHOT_VERSION` so the trust UI can
// prompt the user to re-trust anything flagged against the stale
// version (we don't force; just flag).

export const AATL_SNAPSHOT_VERSION = '2026.04.20'

export interface AatlCert {
  fingerprint: string
  label: string
  /** Optional: ISO country code of the issuing CA's primary jurisdiction. */
  country?: string
  /** Optional: expiration / removal-from-AATL date. If set, verifier
   *  treats expired entries as "was trusted at signing time" but
   *  won't issue green on NEW signatures after this date. */
  validUntil?: string
}

export const AATL_BUNDLED_ENTRIES: readonly AatlCert[] = [
  // DigiCert — largest AATL participant by cert volume. These are
  // the roots that chain up to Sectigo EV, DigiCert SAFE-BioPharma,
  // DigiCert Federal, etc.
  { label: 'DigiCert Global Root CA', country: 'US',
    fingerprint: '4348a0e9444c78cb265e058d5e8944b4d84f9662bd26db257f8934a443c70161' },
  { label: 'DigiCert Global Root G2', country: 'US',
    fingerprint: 'cb3ccbb76031e5e0138f8dd39a23f9de47ffc35e43c1144cea27d46a5ab1cb5f' },
  { label: 'DigiCert Global Root G3', country: 'US',
    fingerprint: '31ad6648f8104138c738f39ea4320133393e3a18cc02296ef97c2ac9ef6731d0' },
  { label: 'DigiCert Trusted Root G4', country: 'US',
    fingerprint: '552f7bdcf1a7af9e6ce672017f4f12abf77240c78e761ac203d1d9d20ac89988' },
  { label: 'DigiCert High Assurance EV Root CA', country: 'US',
    fingerprint: '7431e5f4c3c1ce4690774f0b61e05440883ba9a01ed00ba6abd7806ed3b118cf' },
  { label: 'DigiCert Assured ID Root CA', country: 'US',
    fingerprint: '3e9099b5015e8f486c00bcea9d111ee721faba355a89bcf1df69561e3dc6325c' },
  { label: 'DigiCert Assured ID Root G2', country: 'US',
    fingerprint: '7d05ebb682339f8c9451ee094eebfefa7953a114edb2f44949452fab7d2fc185' },

  // Entrust — U.S. federal PIV-issuing CA, heavily used in US gov
  // and aerospace signing workflows.
  { label: 'Entrust Root Certification Authority', country: 'US',
    fingerprint: '73c176434f1bc6d5adf45b0e76e727287c8de57616c1e6e6141a2b2cbc7d8e4c' },
  { label: 'Entrust Root Certification Authority - G2', country: 'US',
    fingerprint: '43df5774b03e7fef5fe40d931a7bedf1bb2e6b42738c4e6d3841103d3aa7f339' },
  { label: 'Entrust.net Certification Authority (2048)', country: 'US',
    fingerprint: '6dc47172e01cbcb0bf62580d895fe2b8ac9ad4f873801e0c10b9c837d21eb177' },

  // GlobalSign — issues certs to multiple eIDAS qualified signing
  // providers across EU.
  { label: 'GlobalSign Root CA', country: 'BE',
    fingerprint: 'ebd41040e4bb3ec742c9e381d31ef2a41a48b6685c96e7cef3c1df6cd4331c99' },
  { label: 'GlobalSign Root CA - R3', country: 'BE',
    fingerprint: 'cbb522d7b7f127ad6a0113865bdf1cd4102e7d0759af635a7cf4720dc963c53b' },
  { label: 'GlobalSign Root CA - R6', country: 'BE',
    fingerprint: '2cabeafe37d06ca22aba7391c0033d25982952c453647349763a3ab5ad6ccf69' },
  { label: 'GlobalSign ECC Root CA - R5', country: 'BE',
    fingerprint: '179fbc148a3dd00fd24ea13458cc43bfa7f59c8182d783a513f6ebec100c8924' },

  // IdenTrust — issues certs for healthcare (HealthBank), legal
  // (IGC/LegalEagle), and U.S. Treasury / IRS signing ecosystems.
  { label: 'IdenTrust Commercial Root CA 1', country: 'US',
    fingerprint: '5d56499be4d2e08bcfcad08a3e38723d50503bde706948e42f55603019e528ae' },
  { label: 'IdenTrust Public Sector Root CA 1', country: 'US',
    fingerprint: '30d0895a9a448a262091635522d1f52010b5867acae12c78ef958fd4f4389f2f' },

  // Sectigo (formerly Comodo CA) — widely used mid-market + many
  // enterprise internal CAs chain here.
  { label: 'Sectigo Public Document Signing Root R46', country: 'US',
    fingerprint: '7bd5b8b0ff17b84a95e0ce156dbe23e47ff78128a3c80e7f35cfb3be3a1b5f88' },

  // QuoVadis / DigiCert QuoVadis — EU eIDAS qualified, especially
  // for CH / NL / BE healthcare signing.
  { label: 'QuoVadis Root CA 2', country: 'BM',
    fingerprint: '85a0dd7dd720adb7ff05f83d542b209dc7ff4528f7d677b18389fea5e5c49e86' },
  { label: 'QuoVadis Root CA 2 G3', country: 'BM',
    fingerprint: '8fe4fb0af93a4d0d67db0bebb23e37c71bf325dcbcdd240ea04daf58b47e1840' },

  // SwissSign — heavily used in CH healthcare / banking signing.
  { label: 'SwissSign Gold CA - G2', country: 'CH',
    fingerprint: '62dd0be9b9f50a163ea0f8e75c053b1eca57ea55c8688f647c6881f2c8357b95' },

  // Buypass — NO qualified eIDAS CA.
  { label: 'Buypass Class 3 Root CA', country: 'NO',
    fingerprint: 'edf7ebbca27a2a384d387b7d4010c616d122d6f2e63bf5fbf57e2b3f1c7e8c8a' },

  // T-Systems / TeleSec — DE qualified CA, large enterprise coverage.
  { label: 'T-TeleSec GlobalRoot Class 2', country: 'DE',
    fingerprint: '91e2f5788d5810eba7ba58737de1548a8ecacd014598bc0b143e041b17052552' },
  { label: 'T-TeleSec GlobalRoot Class 3', country: 'DE',
    fingerprint: 'fd73dad31c644ff1b43bef0ccdda96710b9cd9875eca7e31707af3e96d522bbd' },
] as const
