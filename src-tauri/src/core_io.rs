//! Desktop-shell implementations of satchel-core's IO traits.
//!
//! satchel-core never touches `std::fs` (clippy enforces it there);
//! this module is where the desktop shell adapts the filesystem to
//! the core's [`DocumentSource`] / [`DocumentSink`] boundary. A WASM
//! shell would implement the same traits over the File API; the core
//! can't tell the difference — that's the point.

use satchel_core::io::{DocumentSink, DocumentSource};
use satchel_core::CoreError;
use std::path::{Path, PathBuf};

/// [`DocumentSource`] over a filesystem path.
pub struct FileSource {
    path: PathBuf,
}

impl FileSource {
    pub fn new(path: impl AsRef<Path>) -> Self {
        Self {
            path: path.as_ref().to_path_buf(),
        }
    }
}

impl DocumentSource for FileSource {
    fn read_all(&mut self) -> satchel_core::Result<Vec<u8>> {
        std::fs::read(&self.path)
            .map_err(|e| CoreError::Io(format!("{}: {e}", self.path.display())))
    }

    fn describe(&self) -> String {
        self.path.display().to_string()
    }
}

/// [`DocumentSink`] over a filesystem path. Writes are whole-file
/// replacements — matching how every existing save path in the app
/// already works (serialize full bytes, then persist).
pub struct FileSink {
    path: PathBuf,
}

impl FileSink {
    pub fn new(path: impl AsRef<Path>) -> Self {
        Self {
            path: path.as_ref().to_path_buf(),
        }
    }
}

impl DocumentSink for FileSink {
    fn write_all(&mut self, bytes: &[u8]) -> satchel_core::Result<()> {
        std::fs::write(&self.path, bytes)
            .map_err(|e| CoreError::Io(format!("{}: {e}", self.path.display())))
    }

    fn describe(&self) -> String {
        self.path.display().to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_source_and_sink_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("doc.bin");

        let mut sink = FileSink::new(&path);
        sink.write_all(&[5, 4, 3]).unwrap();

        let mut src = FileSource::new(&path);
        assert_eq!(src.read_all().unwrap(), vec![5, 4, 3]);
        assert_eq!(src.describe(), path.display().to_string());
    }

    #[test]
    fn file_source_missing_path_reports_io_error() {
        let mut src = FileSource::new("Z:/definitely/not/here.pdf");
        let err = src.read_all().unwrap_err();
        assert!(matches!(err, CoreError::Io(_)), "got: {err:?}");
    }
}
