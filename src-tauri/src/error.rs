use serde::{Serialize, Serializer};

// Unified error type for all Tauri commands.
// We want errors to serialize nicely across the IPC boundary so the frontend
// can show specific messages rather than a generic "failed".
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),

    #[error("file not found: {0}")]
    NotFound(String),

    #[error("invalid argument: {0}")]
    InvalidArgument(String),

    #[error("format not supported: {0}")]
    UnsupportedFormat(String),

    #[error("pdf engine error: {0}")]
    Pdf(String),

    #[error("{0}")]
    Other(#[from] anyhow::Error),
}

// Tauri command results must be serializable. We flatten to a single string
// for now; we can add structured codes later if the frontend needs to
// distinguish error kinds programmatically.
impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.to_string().as_ref())
    }
}
