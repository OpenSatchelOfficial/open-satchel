// Download a prebuilt pdfium shared library into
// src-tauri/resources/pdfium/ so Tauri can bundle it with the
// released application and the Rust render path
// (src-tauri/src/pdf_engine/render.rs) can dynamically load it.
//
// resources/ is gitignored because the pdfium binary is ~10 MB and
// redistribution tracks bblanchon/pdfium-binaries' release cadence.
// Every dev runs this script once (it's wired into the `postinstall`,
// `pretauri:dev`, and `pretauri:build` lifecycle hooks).
//
// At runtime, the Tauri shell sets PDFIUM_DYNAMIC_LIB_PATH to point
// at the bundled resource dir before the renderer is touched, so the
// shipped .exe / .app / .AppImage works without any extra user
// configuration.
//
// Multi-platform: dispatches by Node's process.platform + .arch to
// the right asset name in bblanchon's release. Supported:
//   • win32  + x64    → pdfium-win-x64.tgz       → pdfium.dll
//   • darwin + arm64  → pdfium-mac-arm64.tgz     → libpdfium.dylib
//   • darwin + x64    → pdfium-mac-x64.tgz       → libpdfium.dylib
//   • linux  + x64    → pdfium-linux-x64.tgz     → libpdfium.so
//   • linux  + arm64  → pdfium-linux-arm64.tgz   → libpdfium.so
//
// Usage: node scripts/install-pdfium.mjs
//
// Pre-req: Node 18+, `tar` on PATH (built-in on Windows 10+, macOS,
// Linux).

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  createWriteStream,
  copyFileSync,
  rmSync,
} from 'node:fs'
import { resolve, dirname, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { get } from 'node:https'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RESOURCE_DIR = resolve(ROOT, 'src-tauri', 'resources', 'pdfium')

// ── Pick the right asset for this host ────────────────────────────
function detectAsset() {
  const p = process.platform
  const a = process.arch
  if (p === 'win32' && a === 'x64') {
    return {
      asset: 'pdfium-win-x64.tgz',
      libInArchive: 'bin/pdfium.dll',
      libName: 'pdfium.dll',
    }
  }
  if (p === 'darwin' && a === 'arm64') {
    return {
      asset: 'pdfium-mac-arm64.tgz',
      libInArchive: 'lib/libpdfium.dylib',
      libName: 'libpdfium.dylib',
    }
  }
  if (p === 'darwin' && a === 'x64') {
    return {
      asset: 'pdfium-mac-x64.tgz',
      libInArchive: 'lib/libpdfium.dylib',
      libName: 'libpdfium.dylib',
    }
  }
  if (p === 'linux' && a === 'x64') {
    return {
      asset: 'pdfium-linux-x64.tgz',
      libInArchive: 'lib/libpdfium.so',
      libName: 'libpdfium.so',
    }
  }
  if (p === 'linux' && a === 'arm64') {
    return {
      asset: 'pdfium-linux-arm64.tgz',
      libInArchive: 'lib/libpdfium.so',
      libName: 'libpdfium.so',
    }
  }
  throw new Error(
    `unsupported platform ${p}/${a} — bblanchon/pdfium-binaries doesn't ship a prebuilt for this combination. Build pdfium from source.`,
  )
}

const target = detectAsset()
const verifyPath = resolve(RESOURCE_DIR, target.libName)

// Idempotency: if the lib is already in place, skip the download.
// Lets developers re-run `npm install` without re-downloading 10 MB.
if (existsSync(verifyPath)) {
  console.log(`pdfium already present at ${verifyPath} — skipping download`)
  process.exit(0)
}

mkdirSync(RESOURCE_DIR, { recursive: true })

// pdfium-render (src-tauri Cargo.toml) is pinned at 0.8.x, built
// against chromium release 7170. Bumping pdfium-render means
// bumping the asset version in lockstep — pdfium's ABI changes
// between chromium releases and a mismatch shows up as
// "GetProcAddress: procedure not found" at runtime when bindings
// call a function the shared library doesn't export. Tracking
// "latest" keeps us on bblanchon's most recent build; alarms
// surface in CI smoke tests.
const RELEASE_URL =
  `https://github.com/bblanchon/pdfium-binaries/releases/latest/download/${target.asset}`

// Work in a temp dir so partial / corrupt downloads don't poison
// the resource dir.
const tmp = mkdtempSync(join(tmpdir(), 'pdfium-install-'))
const archivePath = resolve(tmp, target.asset)

console.log(`Downloading ${RELEASE_URL} …`)
await new Promise((done, fail) => {
  function fetch(url, cb) {
    get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetch(res.headers.location, cb)
      }
      if (res.statusCode !== 200) {
        return fail(new Error(`HTTP ${res.statusCode}`))
      }
      const stream = createWriteStream(archivePath)
      res.pipe(stream)
      stream.on('finish', () => stream.close(cb))
    }).on('error', fail)
  }
  fetch(RELEASE_URL, done)
})
console.log('  → saved')

// ── Extract ────────────────────────────────────────────────────────
// Windows tar interprets colons as host separators, so passing an
// absolute path like `D:\...\file.tgz` confuses it. Run tar from the
// temp dir with a relative archive name.
console.log(`Extracting …`)
const relArchive = relative(tmp, archivePath).replace(/\\/g, '/')
const tar = spawnSync('tar', ['-xzf', relArchive], {
  cwd: tmp,
  encoding: 'utf8',
  windowsHide: true,
})
if (tar.status !== 0) {
  console.error('tar extraction failed')
  console.error(tar.stderr || tar.stdout)
  process.exit(2)
}

// ── Flatten ────────────────────────────────────────────────────────
// bblanchon's archives use bin/ (Windows) or lib/ (mac, linux)
// layouts. We flatten so PDFIUM_DYNAMIC_LIB_PATH at runtime points
// straight at the resource dir.
const extractedLib = resolve(tmp, target.libInArchive)
if (!existsSync(extractedLib)) {
  console.error(`Expected ${extractedLib} in extracted archive — not found`)
  process.exit(3)
}
copyFileSync(extractedLib, verifyPath)

// Clean up the temp dir — we already have the lib where we want it.
try {
  rmSync(tmp, { recursive: true, force: true })
} catch {
  // Best-effort cleanup; transient locks on Windows are harmless.
}

console.log('')
console.log(`pdfium installed at ${verifyPath}`)
console.log('')
console.log(`Tauri bundles this via "resources" in tauri.conf.json;`)
console.log(`at runtime, lib.rs setup() points PDFIUM_DYNAMIC_LIB_PATH`)
console.log(`at the resource dir so render.rs can bind to the library.`)
