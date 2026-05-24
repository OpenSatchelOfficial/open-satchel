import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Vite config tuned for Tauri 2.x dev loop.
// - fixed port (Tauri reads it from tauri.conf.json -> devUrl)
// - ignore src-tauri changes so HMR doesn't thrash during Rust rebuilds
// - conditional build target per OS (Tauri uses Edge WebView2 on Windows,
//   WebKit on macOS/Linux)
const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  plugins: [react()],
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
