# SBOM — Software Bill of Materials

**Format:** CycloneDX 1.5 (OWASP-blessed; NIST SSDF compliant)
**Output:** `sbom/sbom.cyclonedx.json`
**Generation:** `npm run sbom`

## Why

Government, hospital, and regulated buyers increasingly require an
SBOM as a procurement-checklist item — a machine-readable inventory of
every third-party dependency in the shipped binary. Open Satchel's
SBOM lets your security/compliance team:

- **Audit licenses** — confirm the project license and third-party MIT,
  Apache, BSD, and other dependency licenses are acceptable
- **Track CVEs** — feed into Dependency-Track / Snyk / FOSSA
- **Verify supply chain** — every dep has a PURL + integrity hash

## Generating

```sh
npm run sbom
```

This produces `sbom/sbom.cyclonedx.json`. The file is gitignored
because the `serialNumber` (uuid) and `timestamp` change per run; you
get reproducible component lists from the same lockfiles, so
diff-stable component counts.

Latest run scope:

- ~507 npm components (from `package-lock.json`)
- ~598 cargo components (from `src-tauri/Cargo.lock`)
- ~1105 total

## What's in each component

```json
{
  "type": "library",
  "bom-ref": "pkg:npm/react@18.3.1",
  "name": "react",
  "version": "18.3.1",
  "purl": "pkg:npm/react@18.3.1",
  "licenses": [{ "license": { "id": "MIT" } }],
  "scope": "required",
  "properties": [
    { "name": "open-satchel:source", "value": "package-lock.json" },
    { "name": "open-satchel:resolved", "value": "https://registry.npmjs.org/..." },
    { "name": "open-satchel:integrity", "value": "sha512-..." }
  ]
}
```

- **`bom-ref`** + **`purl`** are PackageURL strings (purl spec) — the
  industry-standard component identifier.
- **`licenses`** uses SPDX license IDs from the package's manifest
  (`license` field in `package.json` for npm; lookup against crates.io
  for cargo, currently best-effort and may be empty).
- **`scope`** distinguishes runtime (`required`) from dev-only
  (`optional`).
- **`integrity`** (npm only) carries the lockfile's SHA-512 hash —
  matches `package-lock.json` `integrity` field. Tampered tarballs
  fail this hash on `npm ci` install.

## How procurement consumes it

Common ingestion paths:

- **OWASP Dependency-Track** (open-source) — dashboards CVEs across
  components, alerts on new vulns. Free; runs on-prem.
- **FOSSA** (commercial) — license compliance + vulnerability scan.
- **Snyk** (commercial) — same.
- **Manual diff** — diff against the prior release's BOM to see which
  components changed. The component list is sorted by PURL so a plain
  `diff` is meaningful.

Hand the BOM to your security team; the pitch is "every third-party
component in this binary, machine-readable, version-pinned, with
integrity hashes for supply-chain verification."

## CI / per-release pinning

The intent is to attach the SBOM to each GitHub release as a release
artifact (alongside the signed binary). The `serialNumber` + timestamp
provide per-release unique identity; the component list is
deterministic from the lockfiles, so a build-from-source SBOM at the
same git SHA produces the same component set (modulo serial/timestamp).

Example release-artifact attachment:

```sh
npm run sbom
gh release upload v0.1.0 sbom/sbom.cyclonedx.json
```

## Spec compatibility

The output file validates against:

- CycloneDX 1.5 JSON schema
- OWASP CycloneDX validator (online or `cyclonedx-cli validate`)
- Dependency-Track default ingestion
- Most SBOM tooling that accepts CycloneDX 1.4+

If a buyer requires SPDX format instead, post-process with
`cyclonedx-cli convert --output-format spdx`.

## Cargo license coverage

The `Cargo.lock` file does not carry license metadata (unlike npm's
`package.json`). To close this gap:

- **`cargo-license`** (`cargo install cargo-license`) dumps the SPDX
  license ID for every crate in the dependency tree. Run
  `cargo license --json > cargo-licenses.json` to produce a
  machine-readable snapshot.
- The SBOM generator will be updated to merge `cargo-licenses.json`
  into the CycloneDX output so that every Cargo component has a
  populated `licenses` field.
- Until that merge ships, buyers can run `cargo license` themselves
  from the tagged source to confirm all Cargo dependencies are
  permissively licensed. The current tree is MIT / Apache-2.0 /
  BSD-2/3-Clause throughout — no copyleft in the shipped binary.

## Vulnerability scanning

The SBOM is the inventory; CVE matching happens downstream. Recommended
workflows:

| Tool | How |
|------|-----|
| **OWASP Dependency-Track** (free, on-prem) | Upload `sbom.cyclonedx.json`. Dashboard shows CVEs, alerts on new vulns. |
| **`cargo audit`** | `cargo install cargo-audit && cargo audit`. Checks Cargo deps against RustSec advisory DB. |
| **`npm audit`** | `npm audit --omit=dev`. Checks npm deps against the GitHub Advisory Database. |
| **Snyk / FOSSA** (commercial) | Ingest the CycloneDX SBOM for license + vulnerability analysis. |

We plan to gate `cargo audit` and `npm audit` in CI so that known
vulnerabilities block the release pipeline.

A vulnerability scan output (`vuln-scan-report.json`) will be
attached to each GitHub Release alongside the SBOM once the CI gate
is in place.

## Limitations

- **Build-time deps only.** `package-lock.json` and `Cargo.lock` cover
  what compiles into the binary. Runtime-injected deps (system
  libraries, OS-loaded fonts) are out of scope — those are the host's
  responsibility.
- **Cargo license merge is pending.** License fields for Cargo
  components in the CycloneDX output are currently empty. See "Cargo
  license coverage" above for the interim workaround.

## Related

- [`docs/COMPLIANCE-CHECKLIST.md`](COMPLIANCE-CHECKLIST.md) — broader
  compliance posture (HIPAA, FedRAMP, SOC 2, licensing).
- [`docs/SSDF-ATTESTATION.md`](SSDF-ATTESTATION.md) — NIST SSDF
  practice mapping (includes supply-chain practices).
- [`docs/AIRGAP-AUDIT.md`](AIRGAP-AUDIT.md) — the runtime air-gap
  evidence; SBOM is the build-time complement.
