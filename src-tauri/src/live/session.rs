// LiveSession — per-tab state for live-edit mode.
//
// Owns the authoritative EditModel, the append-only op log writer, and
// bookkeeping for atomic persistence. One instance per open tab, keyed
// off a client-supplied tab id. Lives inside LiveSessionsState (managed
// by Tauri) for the lifetime of the session.
//
// Phase 2 implements the durability layer: every accepted op appends
// a line to ops.jsonl; periodic checkpoints serialize the whole
// EditModel to model.json and truncate the log. On next open, any
// existing session directory is replayed to reconstruct state.

#[cfg(test)]
use crate::live::model::Op;
use crate::live::model::{EditModel, LogEntry};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::fs;
use tokio::io::{AsyncWriteExt, BufWriter};
use tokio::sync::Mutex as AsyncMutex;

/// Persisted session metadata. Written to meta.json at session open and
/// on every checkpoint. Keeps the original source path so we can warn
/// the user if they try to resume against a different file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMeta {
    pub tab_id: String,
    pub source_path: String,
    pub source_hash: String,
    pub opened_at: u64,
    pub last_touched_at: u64,
    pub last_checkpoint_version: u64,
}

pub struct LiveSession {
    pub tab_id: String,
    pub source_path: PathBuf,
    pub source_hash: [u8; 32],
    pub session_dir: PathBuf,
    /// Kept in memory for fast bake. LRU eviction at the LiveSessionsState
    /// layer drops this (see eviction_policy.rs when built).
    pub source_bytes: Arc<AsyncMutex<Option<Arc<Vec<u8>>>>>,
    pub model: Arc<AsyncMutex<EditModel>>,
    pub log_writer: Arc<AsyncMutex<BufWriter<fs::File>>>,
    pub last_applied_version: Arc<AtomicU64>,
    pub last_checkpoint_version: Arc<AtomicU64>,
    pub last_touched: Arc<AtomicU64>,
}

impl LiveSession {
    /// Open or resume a session for (tab_id, source_path). If a session
    /// directory exists and matches the current file's SHA-256 hash,
    /// its model.json + ops.jsonl are replayed. Otherwise a fresh model
    /// is created.
    pub async fn open(
        tab_id: String,
        source_path: PathBuf,
        source_bytes: Vec<u8>,
        sessions_root: PathBuf,
    ) -> std::io::Result<(Self, Option<EditModel>)> {
        let source_hash = sha256_bytes(&source_bytes);
        let hash_hex = hex_lower(&source_hash);
        let session_dir = sessions_root.join(&hash_hex);
        fs::create_dir_all(&session_dir).await?;

        let model_path = session_dir.join("model.json");
        let ops_path = session_dir.join("ops.jsonl");
        let meta_path = session_dir.join("meta.json");

        // Load existing model.json checkpoint if present.
        let mut model = EditModel {
            source_hash: hash_hex.clone(),
            ..Default::default()
        };
        let mut had_existing = false;
        if model_path.exists() {
            if let Ok(data) = fs::read(&model_path).await {
                if let Ok(m) = serde_json::from_slice::<EditModel>(&data) {
                    // Only adopt if the hash matches — guards against a
                    // different file ending up at the same path.
                    if m.source_hash == hash_hex {
                        model = m;
                        had_existing = true;
                    }
                }
            }
        }

        // Replay any ops.jsonl lines on top of the checkpoint. Lines
        // may be partially written if the app crashed mid-append;
        // unparseable trailing lines are ignored (at most one op lost).
        if ops_path.exists() {
            if let Ok(data) = fs::read(&ops_path).await {
                let text = String::from_utf8_lossy(&data);
                for line in text.lines() {
                    if line.is_empty() {
                        continue;
                    }
                    if let Ok(entry) = serde_json::from_str::<LogEntry>(line) {
                        if entry.version > model.version {
                            model.apply(&entry.op);
                            model.version = entry.version;
                            had_existing = true;
                        }
                    }
                }
            }
        }

        // Prepare append-only op log writer.
        let log_file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&ops_path)
            .await?;
        let log_writer = BufWriter::new(log_file);

        let now = unix_now();
        let meta = SessionMeta {
            tab_id: tab_id.clone(),
            source_path: source_path.to_string_lossy().to_string(),
            source_hash: hash_hex.clone(),
            opened_at: now,
            last_touched_at: now,
            last_checkpoint_version: model.version,
        };
        let _ = fs::write(
            &meta_path,
            serde_json::to_vec_pretty(&meta).unwrap_or_default(),
        )
        .await;

        let session = LiveSession {
            tab_id,
            source_path,
            source_hash,
            session_dir,
            source_bytes: Arc::new(AsyncMutex::new(Some(Arc::new(source_bytes)))),
            model: Arc::new(AsyncMutex::new(model.clone())),
            log_writer: Arc::new(AsyncMutex::new(log_writer)),
            last_applied_version: Arc::new(AtomicU64::new(model.version)),
            last_checkpoint_version: Arc::new(AtomicU64::new(model.version)),
            last_touched: Arc::new(AtomicU64::new(now)),
        };

        let restored = if had_existing && !model.is_empty() {
            Some(model)
        } else {
            None
        };
        Ok((session, restored))
    }

    pub async fn apply_op(&self, entry: &LogEntry) -> std::io::Result<()> {
        // Strict monotonic version check.
        let prev = self.last_applied_version.load(Ordering::Acquire);
        if entry.version <= prev {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("stale op: prev version {}, got {}", prev, entry.version),
            ));
        }
        {
            let mut model = self.model.lock().await;
            model.apply(&entry.op);
            model.version = entry.version;
        }
        // Append to ops.jsonl.
        let line = serde_json::to_string(entry).map_err(|e| {
            std::io::Error::new(std::io::ErrorKind::Other, format!("serialize: {e}"))
        })?;
        {
            let mut writer = self.log_writer.lock().await;
            writer.write_all(line.as_bytes()).await?;
            writer.write_all(b"\n").await?;
            // Flush buffer every op — cheap, bounds data loss on crash
            // to at most the OS file-buffer window. Callers that want
            // fsync guarantees should call sync_data via a separate
            // command; default stays on the "batched" side of the
            // durability knob.
            writer.flush().await?;
        }
        self.last_applied_version
            .store(entry.version, Ordering::Release);
        self.last_touched.store(unix_now(), Ordering::Release);
        Ok(())
    }

    /// Checkpoint: write the current EditModel to model.json (atomic
    /// via tmp+rename) and truncate ops.jsonl. Idempotent — safe to
    /// call more often than necessary.
    pub async fn checkpoint(&self) -> std::io::Result<u64> {
        let model_snapshot = {
            let model = self.model.lock().await;
            model.clone()
        };
        let version = model_snapshot.version;
        let last_cp = self.last_checkpoint_version.load(Ordering::Acquire);
        if version <= last_cp {
            return Ok(version); // nothing to checkpoint
        }

        let tmp = self.session_dir.join("model.json.tmp");
        let final_path = self.session_dir.join("model.json");
        let bytes = serde_json::to_vec_pretty(&model_snapshot).map_err(|e| {
            std::io::Error::new(std::io::ErrorKind::Other, format!("serialize: {e}"))
        })?;
        fs::write(&tmp, &bytes).await?;
        fs::rename(&tmp, &final_path).await?;

        // Truncate ops.jsonl by reopening with truncate flag. Any ops
        // with version > checkpoint are lost — we just wrote them into
        // model.json, so they're already durable.
        let new_log = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(self.session_dir.join("ops.jsonl"))
            .await?;
        {
            let mut writer = self.log_writer.lock().await;
            // Replace the underlying file handle. Safe because we hold
            // the mutex — no other task can be mid-write.
            *writer = BufWriter::new(new_log);
        }

        self.last_checkpoint_version
            .store(version, Ordering::Release);
        Ok(version)
    }

    /// Close the session. `commit=true` keeps the session directory
    /// for future resume; `commit=false` deletes it.
    pub async fn close(&self, commit: bool) -> std::io::Result<()> {
        if commit {
            // Final checkpoint ensures model.json reflects the latest
            // state; ops.jsonl is truncated to empty.
            let _ = self.checkpoint().await;
            Ok(())
        } else {
            // Best-effort cleanup. Errors here are informational only —
            // orphan session dirs are swept by the eviction cron.
            let _ = fs::remove_dir_all(&self.session_dir).await;
            Ok(())
        }
    }

    pub async fn get_source_bytes(&self) -> std::io::Result<Arc<Vec<u8>>> {
        {
            let guard = self.source_bytes.lock().await;
            if let Some(bytes) = &*guard {
                return Ok(bytes.clone());
            }
        }
        // Evicted — reload from disk + re-verify the hash.
        let bytes = fs::read(&self.source_path).await?;
        let hash = sha256_bytes(&bytes);
        if hash != self.source_hash {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "source file changed on disk since session opened",
            ));
        }
        let arc = Arc::new(bytes);
        *self.source_bytes.lock().await = Some(arc.clone());
        Ok(arc)
    }
}

/// Tauri-managed container for all open live sessions, keyed by tab id.
pub struct LiveSessionsState(pub Mutex<HashMap<String, Arc<LiveSession>>>);

impl LiveSessionsState {
    pub fn new() -> Self {
        LiveSessionsState(Mutex::new(HashMap::new()))
    }

    pub fn get(&self, tab_id: &str) -> Option<Arc<LiveSession>> {
        self.0.lock().ok().and_then(|m| m.get(tab_id).cloned())
    }

    pub fn insert(&self, tab_id: String, session: Arc<LiveSession>) {
        if let Ok(mut m) = self.0.lock() {
            m.insert(tab_id, session);
        }
    }

    pub fn remove(&self, tab_id: &str) -> Option<Arc<LiveSession>> {
        self.0.lock().ok().and_then(|mut m| m.remove(tab_id))
    }
}

impl Default for LiveSessionsState {
    fn default() -> Self {
        Self::new()
    }
}

fn sha256_bytes(bytes: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(bytes);
    let out = h.finalize();
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&out);
    arr
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

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Resolve the sessions root directory for the running platform. Uses
/// %LOCALAPPDATA%\Open Satchel\sessions on Windows, XDG_DATA_HOME on
/// Linux, ~/Library/Application Support/Open Satchel/sessions on macOS.
pub fn sessions_root() -> PathBuf {
    if let Ok(p) = std::env::var("OPEN_SATCHEL_SESSIONS_DIR") {
        // Env override — used by tests to isolate state per run.
        return PathBuf::from(p);
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(p) = std::env::var("LOCALAPPDATA") {
            return Path::new(&p).join("Open Satchel").join("sessions");
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = std::env::var("HOME") {
            return Path::new(&home).join("Library/Application Support/Open Satchel/sessions");
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        if let Ok(p) = std::env::var("XDG_DATA_HOME") {
            return Path::new(&p).join("open-satchel").join("sessions");
        }
        if let Ok(home) = std::env::var("HOME") {
            return Path::new(&home).join(".local/share/open-satchel/sessions");
        }
    }
    // Last resort: temp dir, scoped by user.
    std::env::temp_dir().join("open-satchel-sessions")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::live::model::{Bbox, ParagraphEdit};
    use tempfile::TempDir;

    async fn open_sample(tmp: &TempDir) -> (LiveSession, Option<EditModel>) {
        let bytes = b"hello pdf bytes".to_vec();
        LiveSession::open(
            "tab-1".into(),
            tmp.path().join("src.pdf"),
            bytes,
            tmp.path().join("sessions"),
        )
        .await
        .unwrap()
    }

    fn sample_entry(version: u64, text: &str) -> LogEntry {
        LogEntry {
            version,
            op: Op::UpsertEdit {
                page: 0,
                edit: ParagraphEdit {
                    paragraph_id: "p1".into(),
                    bbox: Bbox {
                        x: 0.0,
                        y: 0.0,
                        width: 100.0,
                        height: 20.0,
                    },
                    mask_bbox: None,
                    original_text: "orig".into(),
                    new_text: text.into(),
                    font_size: 12.0,
                    color: None,
                    background_color: None,
                    font_family: None,
                    bold: false,
                    italic: false,
                    underline: false,
                    strikethrough: false,
                    align: None,
                    line_height: None,
                    item_indices: vec![],
                    item_original_texts: vec![],
                    position_delta: None,
                    custom_font_id: None,
                },
            },
            undo_boundary: false,
            timestamp: 0,
        }
    }

    #[tokio::test]
    async fn fresh_open_returns_no_restored_model() {
        let tmp = TempDir::new().unwrap();
        let (_session, restored) = open_sample(&tmp).await;
        assert!(restored.is_none());
    }

    #[tokio::test]
    async fn apply_op_persists_to_log_and_replays_on_reopen() {
        let tmp = TempDir::new().unwrap();
        let bytes = b"hello pdf bytes".to_vec();
        let src_path = tmp.path().join("src.pdf");
        let sessions_root = tmp.path().join("sessions");

        {
            let (session, _) = LiveSession::open(
                "tab-1".into(),
                src_path.clone(),
                bytes.clone(),
                sessions_root.clone(),
            )
            .await
            .unwrap();
            session.apply_op(&sample_entry(1, "v1")).await.unwrap();
            session.apply_op(&sample_entry(2, "v2")).await.unwrap();
            session.close(true).await.unwrap();
        }
        // Reopen — should replay the log.
        let (_session, restored) =
            LiveSession::open("tab-1".into(), src_path, bytes, sessions_root)
                .await
                .unwrap();
        let model = restored.expect("restored model present");
        assert_eq!(model.version, 2);
        assert_eq!(model.pages.get(&0).unwrap().paragraphs[0].new_text, "v2");
    }

    #[tokio::test]
    async fn stale_op_is_rejected() {
        let tmp = TempDir::new().unwrap();
        let (session, _) = open_sample(&tmp).await;
        session.apply_op(&sample_entry(5, "ok")).await.unwrap();
        let err = session.apply_op(&sample_entry(3, "stale")).await;
        assert!(err.is_err());
    }

    #[tokio::test]
    async fn checkpoint_truncates_ops_log() {
        let tmp = TempDir::new().unwrap();
        let bytes = b"hello".to_vec();
        let (session, _) = LiveSession::open(
            "tab-1".into(),
            tmp.path().join("src.pdf"),
            bytes,
            tmp.path().join("sessions"),
        )
        .await
        .unwrap();
        session.apply_op(&sample_entry(1, "one")).await.unwrap();
        session.apply_op(&sample_entry(2, "two")).await.unwrap();
        let v = session.checkpoint().await.unwrap();
        assert_eq!(v, 2);
        // ops.jsonl should now be empty.
        let ops = fs::read_to_string(session.session_dir.join("ops.jsonl"))
            .await
            .unwrap();
        assert_eq!(ops, "");
        // model.json should have the latest.
        let model_bytes = fs::read(session.session_dir.join("model.json"))
            .await
            .unwrap();
        let model: EditModel = serde_json::from_slice(&model_bytes).unwrap();
        assert_eq!(model.version, 2);
    }
}
