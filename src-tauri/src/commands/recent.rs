// Recent-files storage. Replaces the Electron electron-store-backed service.
//
// Persistence: JSON file at <app-config-dir>/recent.json.
// Order: most-recent-first, deduplicated by path, capped at 50.

use crate::error::AppError;
use crate::Result;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

const MAX_RECENT: usize = 50;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentEntry {
    pub path: String,
    pub name: String,
    pub format: String,
    pub last_opened: i64, // unix seconds
}

fn recent_path(app: &AppHandle) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::Other(anyhow::anyhow!("config dir unavailable: {e}")))?;
    fs::create_dir_all(&dir)?;
    Ok(dir.join("recent.json"))
}

fn load(app: &AppHandle) -> Result<Vec<RecentEntry>> {
    let p = recent_path(app)?;
    if !p.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&p)?;
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }
    let list: Vec<RecentEntry> = serde_json::from_str(&raw).unwrap_or_default();
    Ok(list)
}

fn store(app: &AppHandle, list: &[RecentEntry]) -> Result<()> {
    let p = recent_path(app)?;
    let raw = serde_json::to_string_pretty(list)?;
    fs::write(p, raw)?;
    Ok(())
}

// Serialize concurrent access. Contention will be rare (UI-driven calls) so a
// single mutex is fine for now.
static LOCK: Mutex<()> = Mutex::new(());

#[tauri::command]
pub fn recent_get(app: AppHandle) -> Result<Vec<RecentEntry>> {
    let _g = LOCK.lock().unwrap();
    load(&app)
}

#[tauri::command]
pub fn recent_add(
    app: AppHandle,
    path: String,
    name: String,
    format: String,
) -> Result<Vec<RecentEntry>> {
    let _g = LOCK.lock().unwrap();
    let mut list = load(&app)?;
    list.retain(|e| e.path != path);
    list.insert(
        0,
        RecentEntry {
            path,
            name,
            format,
            last_opened: chrono::Utc::now().timestamp(),
        },
    );
    list.truncate(MAX_RECENT);
    store(&app, &list)?;
    Ok(list)
}

#[tauri::command]
pub fn recent_remove(app: AppHandle, path: String) -> Result<Vec<RecentEntry>> {
    let _g = LOCK.lock().unwrap();
    let mut list = load(&app)?;
    list.retain(|e| e.path != path);
    store(&app, &list)?;
    Ok(list)
}

#[tauri::command]
pub fn recent_clear(app: AppHandle) -> Result<()> {
    let _g = LOCK.lock().unwrap();
    store(&app, &[])?;
    Ok(())
}
