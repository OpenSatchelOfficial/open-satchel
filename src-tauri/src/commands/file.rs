// File I/O commands. These replace the Electron window.api.file.* surface.
//
// Design notes:
// - Bytes cross the IPC boundary as Vec<u8>. Tauri serializes this efficiently
//   (no base64 overhead). For files >50 MB we should eventually switch to
//   streaming via a Tauri channel, but that's a later optimization.
// - All paths come in as String and we canonicalize/normalize on the Rust
//   side so the frontend never has to think about path separators.
// - File dialogs are invoked from the frontend via tauri-plugin-dialog
//   directly; these commands exist for the cases where the backend needs
//   to own the dialog (e.g. save-as with suggested filename).

use crate::error::AppError;
use crate::Result;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

#[derive(Debug, Serialize, Deserialize)]
pub struct LoadedFile {
    pub path: String,
    pub name: String,
    pub bytes: Vec<u8>,
    pub size: u64,
}

fn file_name_of(path: &Path) -> String {
    path.file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string()
}

/// Open a file dialog and return ONLY the chosen path — no read.
///
/// Pairs with `tauri-plugin-fs.readFile` on the JS side for the
/// same reason `pick_save_path` exists for writes: the legacy
/// `open_file_dialog` returns `LoadedFile { bytes: Vec<u8> }`
/// which Tauri 2's default invoke encoding marshals as a
/// JSON-array of N numbers. On a 33 MB PDF that's ~150 MB of JSON
/// string + V8 array-boxing — measured to OOM the WebView on
/// brand-guidelines.pdf (33 MB) and crash with "Out of Memory" in
/// dev. plugin-fs.readFile uses the binary IPC channel; the dialog
/// path is now identical-cost to drag-drop / openPath.
///
/// Returns `None` when the user cancels.
#[tauri::command]
pub async fn pick_open_path(app: AppHandle) -> Result<Option<String>> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<PathBuf>>();
    app.dialog().file().pick_file(move |file_path| {
        let _ = tx.send(file_path.and_then(|f| f.into_path().ok()));
    });
    let picked = rx
        .await
        .map_err(|e| AppError::Other(anyhow::anyhow!("dialog channel closed: {e}")))?;
    Ok(picked.map(|p| p.to_string_lossy().to_string()))
}

/// Open a file dialog and return the loaded bytes if the user picked one.
///
/// Returns `None` when the user cancels. Returns an error only for real
/// I/O failures after a file was selected.
///
/// **DEPRECATED for files >1 MB** — use `pick_open_path` + plugin-fs
/// `readFile` instead. The Vec<u8> marshal in this command is the
/// JSON-array path that OOMs the WebView on multi-MB files.
#[tauri::command]
pub async fn open_file_dialog(app: AppHandle) -> Result<Option<LoadedFile>> {
    // tauri-plugin-dialog's pick_file is callback-based, so we bridge to
    // async via a oneshot channel.
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<PathBuf>>();
    app.dialog().file().pick_file(move |file_path| {
        let _ = tx.send(file_path.and_then(|f| f.into_path().ok()));
    });

    let picked = rx
        .await
        .map_err(|e| AppError::Other(anyhow::anyhow!("dialog channel closed: {e}")))?;
    let Some(path) = picked else { return Ok(None) };

    let bytes = fs::read(&path)?;
    let size = bytes.len() as u64;
    Ok(Some(LoadedFile {
        name: file_name_of(&path),
        path: path.to_string_lossy().to_string(),
        bytes,
        size,
    }))
}

/// Load a file from a known path (recent files, drag-and-drop, CLI args).
#[tauri::command]
pub fn open_file_path(path: String) -> Result<LoadedFile> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(AppError::NotFound(path));
    }
    let bytes = fs::read(&p)?;
    let size = bytes.len() as u64;
    Ok(LoadedFile {
        name: file_name_of(&p),
        path: p.to_string_lossy().to_string(),
        bytes,
        size,
    })
}

/// Save bytes to an existing path (Ctrl+S on a tab that has a file path).
#[tauri::command]
pub fn save_file(path: String, bytes: Vec<u8>) -> Result<()> {
    fs::write(PathBuf::from(path), bytes)?;
    Ok(())
}

/// Open the save dialog and return ONLY the chosen path — no write.
/// Pairs with `tauri-plugin-fs.writeFile` on the JS side for callers
/// who want to bypass the Vec<u8> → JSON-array marshal that
/// [`save_file_dialog`] uses (which costs ~hundreds of ms per MB on
/// large PDFs). Returns `None` if the user cancels.
#[tauri::command]
pub async fn pick_save_path(
    app: AppHandle,
    suggested_name: Option<String>,
) -> Result<Option<String>> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<PathBuf>>();
    let mut builder = app.dialog().file();
    if let Some(name) = suggested_name {
        builder = builder.set_file_name(&name);
    }
    builder.save_file(move |file_path| {
        let _ = tx.send(file_path.and_then(|f| f.into_path().ok()));
    });
    let picked = rx
        .await
        .map_err(|e| AppError::Other(anyhow::anyhow!("dialog channel closed: {e}")))?;
    Ok(picked.map(|p| p.to_string_lossy().to_string()))
}

/// Save-as: open dialog, write bytes, return chosen path. `None` if cancelled.
#[tauri::command]
pub async fn save_file_dialog(
    app: AppHandle,
    bytes: Vec<u8>,
    suggested_name: Option<String>,
) -> Result<Option<String>> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<PathBuf>>();
    let mut builder = app.dialog().file();
    if let Some(name) = suggested_name {
        builder = builder.set_file_name(&name);
    }
    builder.save_file(move |file_path| {
        let _ = tx.send(file_path.and_then(|f| f.into_path().ok()));
    });

    let picked = rx
        .await
        .map_err(|e| AppError::Other(anyhow::anyhow!("dialog channel closed: {e}")))?;
    let Some(path) = picked else { return Ok(None) };

    fs::write(&path, bytes)?;
    Ok(Some(path.to_string_lossy().to_string()))
}

/// Pick a folder and return only its absolute path. Lighter
/// alternative to `pick_folder` for callers that just need the path
/// (e.g. folder favorites on the empty state — they want to remember
/// the directory, not load every PDF inside it).
#[tauri::command]
pub async fn pick_folder_path(app: AppHandle) -> Result<Option<String>> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<PathBuf>>();
    app.dialog().file().pick_folder(move |dir| {
        let _ = tx.send(dir.and_then(|f| f.into_path().ok()));
    });
    let picked = rx
        .await
        .map_err(|e| AppError::Other(anyhow::anyhow!("dialog channel closed: {e}")))?;
    Ok(picked.map(|p| p.to_string_lossy().to_string()))
}

/// Pick a folder and return the list of files inside (recursive), filtered by
/// extensions. Preload byte contents up to a cap to keep memory bounded.
#[tauri::command]
pub async fn pick_folder(
    app: AppHandle,
    extensions: Option<Vec<String>>,
    max_files: Option<usize>,
) -> Result<Option<Vec<LoadedFile>>> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<PathBuf>>();
    app.dialog().file().pick_folder(move |dir| {
        let _ = tx.send(dir.and_then(|f| f.into_path().ok()));
    });

    let picked = rx
        .await
        .map_err(|e| AppError::Other(anyhow::anyhow!("dialog channel closed: {e}")))?;
    let Some(root) = picked else { return Ok(None) };

    let exts: Option<Vec<String>> = extensions.map(|v| {
        v.into_iter()
            .map(|s| s.trim_start_matches('.').to_ascii_lowercase())
            .collect()
    });
    let cap = max_files.unwrap_or(500);

    let mut files: Vec<LoadedFile> = Vec::new();
    walk_dir(&root, &exts, cap, &mut files);
    Ok(Some(files))
}

fn walk_dir(dir: &Path, exts: &Option<Vec<String>>, cap: usize, files: &mut Vec<LoadedFile>) {
    if files.len() >= cap {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if files.len() >= cap {
            return;
        }
        let path = entry.path();
        if path.is_dir() {
            walk_dir(&path, exts, cap, files);
        } else {
            let ext_ok = match exts {
                None => true,
                Some(list) => path
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|e| list.iter().any(|x| x.eq_ignore_ascii_case(e)))
                    .unwrap_or(false),
            };
            if !ext_ok {
                continue;
            }
            let Ok(bytes) = fs::read(&path) else { continue };
            let size = bytes.len() as u64;
            files.push(LoadedFile {
                name: file_name_of(&path),
                path: path.to_string_lossy().to_string(),
                bytes,
                size,
            });
        }
    }
}

/// SHA-256 hash of a file on disk, hex-encoded. Fast (reads in one shot).
/// For multi-GB files we'd stream — deferred until we support them.
#[tauri::command]
pub fn hash_file(path: String) -> Result<String> {
    let bytes = fs::read(PathBuf::from(path))?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(hex::encode(hasher.finalize()))
}

// Tiny hex encoder inlined so we don't pull the `hex` crate for one use.
mod hex {
    pub fn encode(bytes: impl AsRef<[u8]>) -> String {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let bytes = bytes.as_ref();
        let mut out = String::with_capacity(bytes.len() * 2);
        for &b in bytes {
            out.push(HEX[(b >> 4) as usize] as char);
            out.push(HEX[(b & 0x0f) as usize] as char);
        }
        out
    }
}
