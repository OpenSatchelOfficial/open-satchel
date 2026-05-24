// Hot-folder watcher — observe a directory and emit a Tauri event
// whenever a new PDF lands. The frontend subscribes to "hotfolder:new-file"
// and runs the action workflow associated with the watch.
//
// Each `watch_folder` call returns an opaque ID. The mapping
// ID → (path, action_json_path, debouncer) lives in WATCH_REGISTRY.
// `unwatch_folder(id)` drops the entry, which also drops the debouncer
// (closing the OS file-watch handle). `list_watched` is read-only.
//
// Debouncing: we use notify-debouncer-full with a 1s timer so a file
// being copied into the folder doesn't fire until the copy finishes
// (otherwise we'd open a zero-byte or partial PDF).

use notify::{EventKind, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::error::AppError;

#[derive(Clone, Debug, Serialize)]
pub struct WatchedFolder {
    pub id: String,
    pub path: String,
    pub action_json_path: Option<String>,
    pub enabled: bool,
}

#[derive(Clone, Serialize)]
struct FileEvent {
    watch_id: String,
    path: String,
    action_json_path: Option<String>,
}

struct WatchEntry {
    info: WatchedFolder,
    // Dropping this disposes the watcher thread.
    _debouncer: Debouncer<notify::RecommendedWatcher, RecommendedCache>,
}

// Single global registry — there's at most one Tauri app instance per
// process, and the registry only holds watcher handles so a Mutex is
// plenty for the expected access pattern (occasional add/remove,
// read-on-event via watch_id lookup which is not load-bearing).
static WATCH_REGISTRY: Mutex<Option<HashMap<String, WatchEntry>>> = Mutex::new(None);

fn registry() -> &'static Mutex<Option<HashMap<String, WatchEntry>>> {
    &WATCH_REGISTRY
}

#[tauri::command]
pub async fn watch_folder(
    app: AppHandle,
    path: String,
    action_json_path: Option<String>,
) -> std::result::Result<WatchedFolder, AppError> {
    let canonical = PathBuf::from(&path);
    if !canonical.is_dir() {
        return Err(AppError::InvalidArgument(format!(
            "not a directory: {path}"
        )));
    }

    let id = Uuid::new_v4().to_string();
    let id_for_event = id.clone();
    let action_for_event = action_json_path.clone();
    let app_for_event = app.clone();

    let mut debouncer = new_debouncer(
        Duration::from_millis(1000),
        None,
        move |res: DebounceEventResult| {
            let events = match res {
                Ok(e) => e,
                Err(_errs) => return,
            };
            for ev in events {
                let is_new_file =
                    matches!(ev.event.kind, EventKind::Create(_) | EventKind::Modify(_));
                if !is_new_file {
                    continue;
                }
                for path in &ev.event.paths {
                    // Filter: only emit for files that look like PDFs.
                    let is_pdf = path
                        .extension()
                        .and_then(|e| e.to_str())
                        .map(|e| e.eq_ignore_ascii_case("pdf"))
                        .unwrap_or(false);
                    if !is_pdf || !path.is_file() {
                        continue;
                    }
                    let payload = FileEvent {
                        watch_id: id_for_event.clone(),
                        path: path.to_string_lossy().to_string(),
                        action_json_path: action_for_event.clone(),
                    };
                    let _ = app_for_event.emit("hotfolder:new-file", payload);
                }
            }
        },
    )
    .map_err(|e| AppError::Other(anyhow::anyhow!("watcher init: {e}")))?;

    debouncer
        .watch(&canonical, RecursiveMode::NonRecursive)
        .map_err(|e| AppError::Other(anyhow::anyhow!("watch: {e}")))?;

    let info = WatchedFolder {
        id: id.clone(),
        path: canonical.to_string_lossy().to_string(),
        action_json_path,
        enabled: true,
    };

    let mut reg = registry()
        .lock()
        .map_err(|e| AppError::Other(anyhow::anyhow!("lock: {e}")))?;
    let map = reg.get_or_insert_with(HashMap::new);
    map.insert(
        id.clone(),
        WatchEntry {
            info: info.clone(),
            _debouncer: debouncer,
        },
    );

    Ok(info)
}

#[tauri::command]
pub async fn unwatch_folder(id: String) -> std::result::Result<(), AppError> {
    let mut reg = registry()
        .lock()
        .map_err(|e| AppError::Other(anyhow::anyhow!("lock: {e}")))?;
    if let Some(map) = reg.as_mut() {
        // Dropping the WatchEntry drops the debouncer and closes the
        // file-watch handle.
        map.remove(&id);
    }
    Ok(())
}

#[tauri::command]
pub async fn list_watched_folders() -> std::result::Result<Vec<WatchedFolder>, AppError> {
    let reg = registry()
        .lock()
        .map_err(|e| AppError::Other(anyhow::anyhow!("lock: {e}")))?;
    let out = reg
        .as_ref()
        .map(|m| m.values().map(|e| e.info.clone()).collect())
        .unwrap_or_default();
    Ok(out)
}
