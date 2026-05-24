// Tauri commands for live-edit mode.
//
// The frontend owns the source-of-truth for RENDERING (Zustand
// mirror); Rust owns the source-of-truth for PERSISTENCE. Commands
// here are the bridge: each op flows through `live_apply_op`, Rust
// atomically applies to EditModel and appends to ops.jsonl, and the
// frontend can reopen the tab tomorrow to find its edits intact.
//
// See docs/LIVE-EDIT-PLAN.md for the full architecture.

use crate::live::model::{EditModel, LogEntry, Op};
use crate::live::session::{sessions_root, LiveSession, LiveSessionsState};
use crate::Result;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;

#[derive(Debug, Serialize)]
pub struct SessionOpenResult {
    /// Hex SHA-256 of the source PDF, for the frontend to round-trip
    /// with persistence paths / logging.
    #[serde(rename = "sourceHash")]
    pub source_hash: String,
    /// If a prior session exists and its hash matches, Rust returns the
    /// restored EditModel so the frontend can mirror it into Zustand
    /// before the user sees the empty page. Null on a fresh open.
    #[serde(rename = "restoredModel")]
    pub restored_model: Option<EditModel>,
    /// Set by the frontend when a signed PDF is detected upstream. This
    /// field is reserved for a future Rust-side scan that tells the
    /// frontend to auto-disable live mode. Always None for now.
    #[serde(rename = "signedWarning")]
    pub signed_warning: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct OpenSessionArgs {
    #[serde(rename = "tabId")]
    pub tab_id: String,
    #[serde(rename = "filePath")]
    pub file_path: String,
    /// Raw PDF bytes as read at the frontend. Rust hashes them to key
    /// the session dir and keeps them in memory for bake (subject to
    /// the LRU eviction policy).
    #[serde(rename = "sourceBytes")]
    pub source_bytes: Vec<u8>,
}

/// Open or resume a live-edit session for a tab.
#[tauri::command]
pub async fn live_session_open(
    state: State<'_, LiveSessionsState>,
    args: OpenSessionArgs,
) -> Result<SessionOpenResult> {
    let sessions_root = sessions_root();
    let (session, restored) = LiveSession::open(
        args.tab_id.clone(),
        PathBuf::from(args.file_path),
        args.source_bytes,
        sessions_root,
    )
    .await
    .map_err(|e| crate::error::AppError::Other(anyhow::anyhow!("live_session_open: {e}")))?;
    let source_hash = hex_lower(&session.source_hash);
    state.insert(args.tab_id, Arc::new(session));
    Ok(SessionOpenResult {
        source_hash,
        restored_model: restored,
        signed_warning: None,
    })
}

#[derive(Debug, Deserialize)]
pub struct ApplyOpArgs {
    #[serde(rename = "tabId")]
    pub tab_id: String,
    pub version: u64,
    pub op: Op,
    #[serde(default, rename = "undoBoundary")]
    pub undo_boundary: bool,
}

/// Apply a single op. Version must be strictly greater than every prior
/// accepted version for this tab; out-of-order ops return an error so
/// the frontend can resync.
#[tauri::command]
pub async fn live_apply_op(state: State<'_, LiveSessionsState>, args: ApplyOpArgs) -> Result<()> {
    let session = state
        .get(&args.tab_id)
        .ok_or_else(|| crate::error::AppError::NotFound(args.tab_id.clone()))?;
    let entry = LogEntry {
        version: args.version,
        op: args.op,
        undo_boundary: args.undo_boundary,
        timestamp: now_unix(),
    };
    session
        .apply_op(&entry)
        .await
        .map_err(|e| crate::error::AppError::Other(anyhow::anyhow!("apply_op: {e}")))?;
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct CheckpointArgs {
    #[serde(rename = "tabId")]
    pub tab_id: String,
}

/// Force a checkpoint — serialize the current EditModel to model.json
/// and truncate ops.jsonl. Called on tab blur or manual save. Normally
/// happens automatically on close.
#[tauri::command]
pub async fn live_checkpoint(
    state: State<'_, LiveSessionsState>,
    args: CheckpointArgs,
) -> Result<u64> {
    let session = state
        .get(&args.tab_id)
        .ok_or_else(|| crate::error::AppError::NotFound(args.tab_id.clone()))?;
    session
        .checkpoint()
        .await
        .map_err(|e| crate::error::AppError::Other(anyhow::anyhow!("checkpoint: {e}")))
}

#[derive(Debug, Deserialize)]
pub struct CloseSessionArgs {
    #[serde(rename = "tabId")]
    pub tab_id: String,
    /// If false, discards the session directory entirely (user chose
    /// "abandon edits"). Default true — persist for next open.
    #[serde(default = "default_true")]
    pub commit: bool,
}

fn default_true() -> bool {
    true
}

/// Close a live-edit session. Removes it from LiveSessionsState and
/// either finalizes the checkpoint (commit=true) or wipes the session
/// directory (commit=false).
#[tauri::command]
pub async fn live_session_close(
    state: State<'_, LiveSessionsState>,
    args: CloseSessionArgs,
) -> Result<()> {
    if let Some(session) = state.remove(&args.tab_id) {
        session
            .close(args.commit)
            .await
            .map_err(|e| crate::error::AppError::Other(anyhow::anyhow!("close: {e}")))?;
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct GetModelArgs {
    #[serde(rename = "tabId")]
    pub tab_id: String,
}

#[derive(Debug, Serialize)]
pub struct ModelSnapshot {
    pub model: EditModel,
    pub version: u64,
}

/// Return the current EditModel + version for a tab. Used by the Ctrl+S
/// bake path (frontend reads model, re-serializes via existing pipeline).
#[tauri::command]
pub async fn live_get_model(
    state: State<'_, LiveSessionsState>,
    args: GetModelArgs,
) -> Result<ModelSnapshot> {
    let session = state
        .get(&args.tab_id)
        .ok_or_else(|| crate::error::AppError::NotFound(args.tab_id.clone()))?;
    let model = session.model.lock().await.clone();
    let version = model.version;
    Ok(ModelSnapshot { model, version })
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
