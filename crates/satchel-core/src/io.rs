//! IO boundary traits — discipline rule 2.
//!
//! The core never calls `std::fs` (clippy enforces this). Instead,
//! shells hand the core implementations of [`DocumentSource`] /
//! [`DocumentSink`]:
//!
//! - the desktop shell implements them over `std::fs`
//!   (`src-tauri/src/core_io.rs`),
//! - a WASM shell implements them over the File API / blobs,
//! - a server implements them over streams.
//!
//! The in-memory [`BytesSource`] / [`BytesSink`] live here because
//! they are platform-free and every shell (and every test) needs
//! them.

use crate::{CoreError, Result};

/// Anything that can produce the bytes of a document.
///
/// Implementations should be cheap to construct; the (potentially
/// expensive) read happens in [`read_all`](DocumentSource::read_all).
pub trait DocumentSource {
    /// Produce the complete document bytes.
    ///
    /// Called at most once per load by the core; implementations may
    /// consume internal state (hence `&mut`).
    fn read_all(&mut self) -> Result<Vec<u8>>;

    /// Human-readable origin for diagnostics — a path, a URL,
    /// `"memory"`. Never parsed, only displayed and logged.
    fn describe(&self) -> String;
}

/// Anything that can accept the bytes of a document.
pub trait DocumentSink {
    /// Persist the complete document bytes.
    fn write_all(&mut self, bytes: &[u8]) -> Result<()>;

    /// Human-readable destination for diagnostics. Never parsed.
    fn describe(&self) -> String;
}

/// In-memory [`DocumentSource`] over an owned byte buffer.
///
/// The canonical source for tests and for shells that already hold
/// the document in memory (drag-and-drop payloads, IPC buffers,
/// WASM blobs).
pub struct BytesSource {
    bytes: Option<Vec<u8>>,
    label: String,
}

impl BytesSource {
    /// Wrap an owned buffer. `label` is the [`describe`]
    /// (DocumentSource::describe) string — pass the original file
    /// name when known, or something like `"memory"`.
    pub fn new(bytes: Vec<u8>, label: impl Into<String>) -> Self {
        Self {
            bytes: Some(bytes),
            label: label.into(),
        }
    }
}

impl DocumentSource for BytesSource {
    fn read_all(&mut self) -> Result<Vec<u8>> {
        self.bytes
            .take()
            .ok_or_else(|| CoreError::Io(format!("{}: bytes already consumed", self.label)))
    }

    fn describe(&self) -> String {
        self.label.clone()
    }
}

/// In-memory [`DocumentSink`] that collects written bytes for the
/// caller to retrieve — the standard sink for tests and WASM shells.
#[derive(Default)]
pub struct BytesSink {
    bytes: Vec<u8>,
    label: String,
}

impl BytesSink {
    /// Create an empty sink labeled for diagnostics.
    pub fn new(label: impl Into<String>) -> Self {
        Self {
            bytes: Vec::new(),
            label: label.into(),
        }
    }

    /// The bytes written so far (the full document after a save).
    pub fn into_bytes(self) -> Vec<u8> {
        self.bytes
    }

    /// Borrow the written bytes without consuming the sink.
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
}

impl DocumentSink for BytesSink {
    fn write_all(&mut self, bytes: &[u8]) -> Result<()> {
        self.bytes.clear();
        self.bytes.extend_from_slice(bytes);
        Ok(())
    }

    fn describe(&self) -> String {
        self.label.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bytes_source_round_trips() {
        let mut src = BytesSource::new(vec![1, 2, 3], "memory");
        assert_eq!(src.describe(), "memory");
        assert_eq!(src.read_all().unwrap(), vec![1, 2, 3]);
        // Second read reports consumption instead of silently
        // returning an empty document.
        assert!(src.read_all().is_err());
    }

    #[test]
    fn bytes_sink_collects_last_write() {
        let mut sink = BytesSink::new("memory");
        sink.write_all(&[9, 9]).unwrap();
        sink.write_all(&[1, 2, 3]).unwrap();
        assert_eq!(sink.bytes(), &[1, 2, 3]);
        assert_eq!(sink.into_bytes(), vec![1, 2, 3]);
    }
}
