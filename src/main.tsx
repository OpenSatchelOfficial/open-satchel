// Shim must load BEFORE anything imports window.api (format handlers,
// services, dialogs). Side-effect import is intentional.
import './lib/electron-api-shim'

import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { registerAllFormats } from './formats/registerAll'
import { installHotFolderListeners } from './services/hotFolder'
import './styles/global.css'

registerAllFormats()

// Fire-and-forget — subscribes to Tauri events for hot-folder triggers
// and CLI action dispatch. No-ops in browser mode.
void installHotFolderListeners()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
