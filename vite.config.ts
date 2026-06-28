import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'

// Vite config tuned for Tauri 2.x dev loop.
// - fixed port (Tauri reads it from tauri.conf.json -> devUrl)
// - ignore src-tauri changes so HMR doesn't thrash during Rust rebuilds
// - conditional build target per OS (Tauri uses Edge WebView2 on Windows,
//   WebKit on macOS/Linux)
//
// Synced from the internal 0.5.0 build: the OCR (tesseract) and the
// vendored zgapdfsigner runtime assets are served in dev AND copied into
// the production bundle. The internal-only `serveTestPdfs` dev fixture
// plugin is intentionally dropped here (no test corpus in the public repo).
const host = process.env.TAURI_DEV_HOST

function tesseractAssets(root: string): Array<{ route: string; source: string }> {
  const nm = path.resolve(root, 'node_modules')
  const coreDir = path.join(nm, 'tesseract.js-core')
  const langPackages = [
    { lang: 'eng', pkg: '@tesseract.js-data/eng' },
    { lang: 'osd', pkg: '@tesseract.js-data/osd' },
  ]
  const files: Array<{ route: string; source: string }> = [
    {
      route: '/tesseract/worker.min.js',
      source: path.join(nm, 'tesseract.js', 'dist', 'worker.min.js'),
    },
  ]
  for (const name of fs.readdirSync(coreDir)) {
    if (!/^tesseract-core.*\.(?:js|wasm)$/.test(name)) continue
    files.push({
      route: `/tesseract/core/${name}`,
      source: path.join(coreDir, name),
    })
  }
  for (const { lang, pkg } of langPackages) {
    for (const variant of ['4.0.0_best_int', '4.0.0']) {
      files.push({
        route: `/tesseract/lang/${variant}/${lang}.traineddata.gz`,
        source: path.join(nm, pkg, variant, `${lang}.traineddata.gz`),
      })
    }
  }
  return files
}

function tesseractAssetType(file: string): string {
  if (file.endsWith('.js')) return 'application/javascript; charset=utf-8'
  if (file.endsWith('.wasm')) return 'application/wasm'
  if (file.endsWith('.gz')) return 'application/gzip'
  return 'application/octet-stream'
}

/**
 * Vendored runtime assets that the app loads via a raw `<script src>` /
 * fetch against an absolute `/vendor/...` URL at RUNTIME — NOT through the
 * module graph (so Vite never sees them as imports and never bundles them).
 * The canonical case is `src/services/zgaLoader.ts`, which injects
 * `<script src="/vendor/zgapdfsigner/dist/zgapdfsigner.min.js">` to load the
 * PDF-encryption UMD bundle.
 *
 * In DEV, Vite's root file-serving happens to answer `/vendor/...` from the
 * repo, so this worked there. In a PRODUCTION build the file is NOT under
 * `public/` and nothing copied it into `dist/`, so the packaged app's script
 * injection 404'd and EVERY password/permission PDF encryption threw
 * "PDF encryption failed" — a release-only break the dev server was blind to.
 * Mirror the tesseract pattern: serve in dev + copy into the build output so
 * the bundled app finds it next to index.html.
 */
function vendorRuntimeAssets(root: string): Array<{ route: string; source: string }> {
  return [
    {
      route: '/vendor/zgapdfsigner/dist/zgapdfsigner.min.js',
      source: path.resolve(root, 'vendor', 'zgapdfsigner', 'dist', 'zgapdfsigner.min.js'),
    },
  ]
}

function serveVendorAssets(): Plugin {
  let root = process.cwd()
  let outDir = path.resolve(root, 'dist')
  return {
    name: 'open-satchel:vendor-assets',
    configResolved(config) {
      root = config.root
      outDir = path.resolve(root, config.build.outDir)
    },
    configureServer(server) {
      const files = new Map(vendorRuntimeAssets(server.config.root).map((f) => [f.route, f]))
      server.middlewares.use((req, res, next) => {
        if (!req.url) return next()
        const route = req.url.split('?')[0]
        const asset = files.get(route)
        if (!asset) return next()
        fs.stat(asset.source, (err, stat) => {
          if (err || !stat.isFile()) return next()
          res.setHeader('Content-Type', 'application/javascript; charset=utf-8')
          res.setHeader('Content-Length', String(stat.size))
          fs.createReadStream(asset.source).pipe(res)
        })
      })
    },
    writeBundle() {
      for (const asset of vendorRuntimeAssets(root)) {
        const dest = path.join(outDir, asset.route.replace(/^\//, ''))
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.copyFileSync(asset.source, dest)
      }
    },
  }
}

function serveTesseractAssets(): Plugin {
  let root = process.cwd()
  let outDir = path.resolve(root, 'dist')
  return {
    name: 'open-satchel:tesseract-assets',
    configResolved(config) {
      root = config.root
      outDir = path.resolve(root, config.build.outDir)
    },
    configureServer(server) {
      const files = new Map(tesseractAssets(server.config.root).map((f) => [f.route, f]))
      server.middlewares.use((req, res, next) => {
        if (!req.url) return next()
        const route = req.url.split('?')[0]
        const asset = files.get(route)
        if (!asset) return next()
        fs.stat(asset.source, (err, stat) => {
          if (err || !stat.isFile()) return next()
          res.setHeader('Content-Type', tesseractAssetType(asset.source))
          res.setHeader('Content-Length', String(stat.size))
          fs.createReadStream(asset.source).pipe(res)
        })
      })
    },
    writeBundle() {
      for (const asset of tesseractAssets(root)) {
        const dest = path.join(outDir, asset.route.replace(/^\//, ''))
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.copyFileSync(asset.source, dest)
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), serveTesseractAssets(), serveVendorAssets()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: 'ws', host, port: 1421 }
      : undefined,
    watch: { ignored: ['**/src-tauri/**'] }
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    target:
      process.env.TAURI_ENV_PLATFORM === 'windows'
        ? 'chrome105'
        : 'safari13',
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG
  }
})
