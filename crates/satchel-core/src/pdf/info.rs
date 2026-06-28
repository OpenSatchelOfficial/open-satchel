//! Document information reader — the first consumer migrated onto
//! the parser/store facade (ported from the shell's
//! `pdf_verify_metadata` in `src-tauri/src/commands/verify.rs`).
//!
//! Pure core logic: takes a [`DocumentHandle`], returns core types.
//! No backend names, no IO.

use crate::pdf::store::DocumentHandle;

/// How many bytes of decoded XMP to surface in
/// [`DocumentInfo::xmp_preview`]. Matches the shell's historical
/// 8 KB cap (enough for tests to find dc:* tags past the namespace
/// preamble, bounded so huge XMP bodies don't balloon IPC payloads).
pub const XMP_PREVIEW_MAX_BYTES: usize = 8192;

/// Decoded `/Info` metadata plus an XMP preview.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct DocumentInfo {
    /// `/Title`, decoded.
    pub title: Option<String>,
    /// `/Author`, decoded.
    pub author: Option<String>,
    /// `/Subject`, decoded.
    pub subject: Option<String>,
    /// `/Keywords`, decoded.
    pub keywords: Option<String>,
    /// `/Creator`, decoded.
    pub creator: Option<String>,
    /// `/Producer`, decoded.
    pub producer: Option<String>,
    /// `/CreationDate`, decoded (raw PDF date string, not parsed).
    pub creation_date: Option<String>,
    /// `/ModDate`, decoded (raw PDF date string, not parsed).
    pub mod_date: Option<String>,
    /// First [`XMP_PREVIEW_MAX_BYTES`] of the decoded XMP metadata
    /// stream, lossily UTF-8 decoded.
    pub xmp_preview: Option<String>,
}

/// Read [`DocumentInfo`] from an open document.
pub fn read_document_info(handle: &dyn DocumentHandle) -> DocumentInfo {
    let info = handle.info_dict();
    let s = |key: &[u8]| -> Option<String> {
        info.as_ref()
            .and_then(|d| d.get_string(key))
            .map(decode_pdf_text_string)
    };
    let xmp_preview = handle.xmp_metadata().map(|bytes| {
        let cut = bytes.len().min(XMP_PREVIEW_MAX_BYTES);
        String::from_utf8_lossy(&bytes[..cut]).into_owned()
    });
    DocumentInfo {
        title: s(b"Title"),
        author: s(b"Author"),
        subject: s(b"Subject"),
        keywords: s(b"Keywords"),
        creator: s(b"Creator"),
        producer: s(b"Producer"),
        creation_date: s(b"CreationDate"),
        mod_date: s(b"ModDate"),
        xmp_preview,
    }
}

/// Decode a PDF text string (PDF 1.7 §7.9.2).
///
/// Two encodings exist in the wild:
/// 1. PDFDocEncoding (byte ≈ Latin-1 with a few reassignments), no BOM.
/// 2. UTF-16 BE with a `FE FF` BOM — pd-lib emits this for /Info and
///    XMP whenever non-ASCII is present (sometimes even for ASCII).
///
/// Ported byte-for-byte from the shell's `decode_pdf_text_string`
/// so migrated consumers behave identically; also handles the
/// spec-legal UTF-8 BOM (PDF 2.0).
pub fn decode_pdf_text_string(b: &[u8]) -> String {
    if b.len() >= 2 && b[0] == 0xFE && b[1] == 0xFF {
        let tail = &b[2..];
        if tail.len() % 2 == 0 {
            let chars: Vec<u16> = tail
                .chunks_exact(2)
                .map(|c| u16::from_be_bytes([c[0], c[1]]))
                .collect();
            return String::from_utf16_lossy(&chars);
        }
    }
    // UTF-8 BOM (rarely used but spec-legal in PDF 2.0): EF BB BF
    if b.len() >= 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF {
        return String::from_utf8_lossy(&b[3..]).into_owned();
    }
    // Assume PDFDocEncoding ≈ Latin-1 (close enough for ASCII
    // content). from_utf8_lossy is wrong for high-bit PDFDoc bytes
    // but matches the shell's historical behavior exactly — fix in
    // both places together if it ever matters.
    String::from_utf8_lossy(b).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pdf::object::{PdfDict, PdfValue};

    struct FakeHandle {
        info: Option<PdfDict>,
        xmp: Option<Vec<u8>>,
    }

    impl DocumentHandle for FakeHandle {
        fn page_count(&self) -> u32 {
            1
        }
        fn info_dict(&self) -> Option<PdfDict> {
            self.info.clone()
        }
        fn xmp_metadata(&self) -> Option<Vec<u8>> {
            self.xmp.clone()
        }
        fn version(&self) -> String {
            "1.7".into()
        }
    }

    #[test]
    fn decodes_utf16be_bom_strings() {
        // "Hé" as UTF-16 BE with BOM
        let bytes = [0xFE, 0xFF, 0x00, 0x48, 0x00, 0xE9];
        assert_eq!(decode_pdf_text_string(&bytes), "Hé");
    }

    #[test]
    fn decodes_plain_ascii() {
        assert_eq!(decode_pdf_text_string(b"Plain Title"), "Plain Title");
    }

    #[test]
    fn decodes_utf8_bom() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice("ü".as_bytes());
        assert_eq!(decode_pdf_text_string(&bytes), "ü");
    }

    #[test]
    fn odd_length_utf16_tail_falls_back_to_lossy() {
        // BOM followed by an odd byte count — must not panic.
        let bytes = [0xFE, 0xFF, 0x00];
        let s = decode_pdf_text_string(&bytes);
        assert!(!s.is_empty());
    }

    #[test]
    fn reads_info_fields_and_caps_xmp() {
        let mut d = PdfDict::new();
        d.insert(b"Title".to_vec(), PdfValue::String(b"T".to_vec()));
        d.insert(b"Author".to_vec(), PdfValue::String(b"A".to_vec()));
        let handle = FakeHandle {
            info: Some(d),
            xmp: Some(vec![b'x'; XMP_PREVIEW_MAX_BYTES * 2]),
        };
        let info = read_document_info(&handle);
        assert_eq!(info.title.as_deref(), Some("T"));
        assert_eq!(info.author.as_deref(), Some("A"));
        assert_eq!(info.subject, None);
        assert_eq!(
            info.xmp_preview.as_ref().map(|s| s.len()),
            Some(XMP_PREVIEW_MAX_BYTES)
        );
    }

    #[test]
    fn missing_info_dict_yields_all_none() {
        let handle = FakeHandle {
            info: None,
            xmp: None,
        };
        let info = read_document_info(&handle);
        assert_eq!(info, DocumentInfo::default());
    }
}
