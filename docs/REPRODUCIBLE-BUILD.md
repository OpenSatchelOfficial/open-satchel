# Reproducible Build Recipe

**Goal:** any reviewer with the same git SHA + the same toolchain
versions can rebuild the binary and get a byte-identical (or
ABI-identical) artifact, then verify it matches what we shipped.

This is procurement-grade evidence that no supply-chain tampering
happened between source commit and signed binary.

---

## Toolchain pin

| Tool | Pinned version | How to verify |
|------|----------------|---------------|
| Node | **18.x or 20.x LTS** | `node --version` |
| npm | bundled with Node | `npm --version` |
| Rust | **1.83.0 stable** (msrv) | `rustc --version` |
| Cargo | bundled with Rust | `cargo --version` |
| Tauri CLI | **2.x** | pulled by `npm ci` from package.json |
| Platform | Win 11 / macOS 13+ / Ubuntu 22.04 | `uname -a` |

For exact lockfile-resolved versions of every transitive dep, see
[`docs/SBOM.md`](SBOM.md) — a CycloneDX BOM is generated per-release
via `npm run sbom`.

If you use [rustup](https://rustup.rs):

```sh
rustup toolchain install 1.83.0
rustup default 1.83.0
```

---

## Build recipe

Three steps. **Do not** add `--legacy-peer-deps` or `--force` to npm —
those are the slot where tampering hides.

```sh
# 1. Check out the exact commit you want to verify.
git clone https://github.com/OpenSatchelOfficial/open-satchel.git
cd Open-Satchel
git checkout <SHA>

# 2. Verify lockfile integrity is intact.
git status                                    # must be clean
git log -1 --format=%H                        # confirm SHA matches
sha256sum package-lock.json src-tauri/Cargo.lock

# 3a. Install dependencies — STRICT lockfile mode.
npm ci                                        # NOT npm install
node scripts/install-pdfium.mjs               # native binding
node scripts/install-form-font.mjs            # Source Sans 3 OTF

# 3b. Build.
npm run build                                 # Vite (TypeScript) bundle
cd src-tauri && cargo build --release         # Rust binary
cd ..
npx tauri build                               # full installer / .app / .deb
```

`npm ci` is the critical step: it refuses to proceed unless the
lockfile is in sync with `package.json` and every package's integrity
hash matches `package-lock.json`. This is the equivalent of `cargo`'s
default behavior with `Cargo.lock` (which is already strict).

---

## Verification

### 1. Lockfile hashes

```sh
sha256sum package-lock.json src-tauri/Cargo.lock
```

Compare against the values published in the GitHub release notes for
the corresponding tag. A mismatch means either:

- You're not on the tagged SHA (`git log -1 --format=%H`).
- Someone modified the lockfile between the tag and your checkout —
  contact the release engineer immediately.

### 2. SBOM diff

```sh
npm run sbom
diff <(jq -r '.components[] | "\(.purl)"' sbom/sbom.cyclonedx.json | sort) \
     <(jq -r '.components[] | "\(.purl)"' /path/to/release/sbom.cyclonedx.json | sort)
```

Empty diff = identical component list. The `serialNumber` and
`timestamp` differ per run; everything else should match for the same
git SHA.

### 3. Binary hash (best-effort)

```sh
sha256sum src-tauri/target/release/open-satchel       # or .exe / .app
```

**Caveat:** byte-identical reproducibility for native binaries
requires:

- Same compiler version (Rust 1.83.0).
- Same linker version (varies by OS/distro).
- `SOURCE_DATE_EPOCH` set to commit timestamp (eliminates embedded
  build timestamps).
- No timestamp / build-host strings injected (`--remap-path-prefix`
  to scrub local paths).

We don't currently produce 100% byte-identical binaries across hosts —
the linker + build host inject strings. Component-level
reproducibility (lockfile-pinned versions + integrity hashes) IS
guaranteed.

### 4. Static gates

`npm run verify` runs four reproducibility-critical gates locally:

```
✓ TypeScript type-check
✓ Vite production build
✓ Cargo lib tests (43 tests)
✓ SBOM generation
```

All four pass on a clean checkout = environment is set up correctly.
A pure-source change (no toolchain version drift) should never break
these.

---

## Air-gap verification

The build process can run fully offline once dependencies are fetched.
After the initial `npm ci` and `cargo fetch`, no network access is
required:

```sh
# Pre-fetch everything (online).
npm ci
cargo fetch --manifest-path src-tauri/Cargo.toml
node scripts/install-pdfium.mjs
node scripts/install-form-font.mjs

# Disconnect the network.
# Build offline.
npm run build
cd src-tauri && cargo build --release --offline
```

The `--offline` flag tells cargo to refuse any network operation —
useful for verifying the lockfile-resolved deps fully cover the build.

---

## Troubleshooting

**`npm ci` errors with "lockfile out of sync":**
Lockfile was edited or `package.json` was edited without running
`npm install`. Don't `npm install` to fix it — that defeats the
audit. Instead, regenerate the lockfile from a clean SHA:

```sh
git checkout package-lock.json
npm ci
```

**`cargo build` fetches a new dep version:**
Shouldn't happen — `Cargo.lock` is committed. If it does, somebody
updated `Cargo.toml` without running `cargo update`. Same fix as
above:

```sh
git checkout src-tauri/Cargo.lock
cargo build --offline
```

**Build succeeds but binary hash differs from release:**
Expected unless you control linker version + SOURCE_DATE_EPOCH +
build-host paths. The lockfile + SBOM diff is the authoritative
"same source" signal.

---

## Related

- [`docs/SBOM.md`](SBOM.md) — component-level inventory format.
- [`docs/AIRGAP-AUDIT.md`](AIRGAP-AUDIT.md) — runtime air-gap evidence.
- [`docs/COMPLIANCE-CHECKLIST.md`](COMPLIANCE-CHECKLIST.md) — broader
  procurement posture.
