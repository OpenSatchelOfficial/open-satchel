//! Parser/store facade — the seam between core document logic and
//! whatever actually parses PDF bytes.
//!
//! Today the only backend is lopdf (`crate::backend::lopdf_store`,
//! behind the `lopdf-backend` feature). The long arc replaces it
//! with an own parser; because core logic only sees these traits and
//! [`crate::pdf::object`] types, that replacement is a backend swap,
//! not core surgery.
//!
//! The trait surface grows per migrated consumer — it intentionally
//! carries only what core logic actually uses tonight, not a
//! speculative full PDF API.

use crate::pdf::object::PdfDict;
use crate::Result;

/// A parser/store backend that can open PDF documents from bytes.
///
/// Bytes, not paths — IO stays behind
/// [`DocumentSource`](crate::io::DocumentSource) on the shell side.
pub trait DocumentStore {
    /// Parse a document. Fails with [`CoreError::Parse`]
    /// (crate::CoreError::Parse) when the bytes are not a readable
    /// PDF.
    fn open(&self, bytes: &[u8]) -> Result<Box<dyn DocumentHandle>>;
}

/// An open document, queryable through core-owned types only.
pub trait DocumentHandle {
    /// Number of pages reachable through the page tree.
    fn page_count(&self) -> u32;

    /// The trailer `/Info` dictionary with its values resolved into
    /// core objects, or `None` when the document has no Info dict.
    fn info_dict(&self) -> Option<PdfDict>;

    /// The document catalog's `/Metadata` XMP stream, decompressed
    /// when the backend can decode the filter (raw stream bytes
    /// otherwise), or `None` when absent.
    fn xmp_metadata(&self) -> Option<Vec<u8>>;

    /// The PDF version header, e.g. `"1.7"`.
    fn version(&self) -> String;
}
