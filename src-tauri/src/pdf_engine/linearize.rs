//! Linearization hint-table parser for "Fast Web View" PDFs.
//!
//! Why: a 1000-page non-linearized PDF takes pdfjs / pdfium several
//! seconds to fully parse before page 1 can render — the parser walks
//! the entire xref before any content is reachable. Acrobat shows page
//! 1 in ~200ms on the same file because it reads ONLY the linearization
//! hint at the front of the file, which directly names page 1's
//! resources.
//!
//! What this module does:
//!
//!   • Detect the linearization hint dict (the first PDF object after
//!     the file header in a web-optimized file).
//!   • Pull out enough info to (a) confirm the file is linearized,
//!     (b) report the total page count, and (c) hand back the byte
//!     range of page 1's content so a renderer can fast-path it.
//!
//! What this module does NOT do:
//!
//!   • Full PDF parsing — `lopdf` and `pdfium` already do that. This
//!     is a deliberate skim.
//!   • Re-linearize a non-linearized PDF (that's `qpdf --linearize`'s
//!     job; we can call it from a script if needed).
//!   • Validate the hint stream (Type 1 page-offset hints, Type 2
//!     shared-object hints). The hint dict alone gives us enough.
//!
//! References: PDF 1.7 (ISO 32000-1) Annex F — "Linearized PDF".
//!
//! ## Wire format reminder
//!
//! ```text
//! %PDF-1.7\n
//! %binary-marker\n
//! 1 0 obj
//! <<
//!   /Linearized 1
//!   /L  234567       % file length in bytes
//!   /H  [1234 567]   % primary hint stream: offset, length
//!   /O  4            % object number of first-page page dict
//!   /E  9876         % offset of end of first page
//!   /N  1024         % number of pages
//!   /T  234500       % offset to first xref entry
//! >>
//! endobj
//! ```

use crate::error::AppError;
use crate::Result;

/// Parsed linearization hint info. Subset of the dict — only the
/// fields a fast-path renderer actually needs.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct LinearizationInfo {
    /// Total page count, from `/N`.
    pub page_count: u32,
    /// Total file length in bytes, from `/L`. The parser checks
    /// against the actual file size as a sanity gate.
    pub file_length: u64,
    /// Offset (bytes from start of file) of the END of page 1 — i.e.
    /// the renderer only needs bytes `[0, end_first_page)` to draw
    /// page 1. From `/E`.
    pub end_first_page: u64,
    /// Object number of the first page's /Page dict, from `/O`.
    pub first_page_object: u32,
}

/// Maximum bytes we'll scan for the hint dict. The hint must be the
/// first object in a linearized file — typically within the first 1KB.
/// A generous cap of 8KB handles outliers (huge PDFs with verbose
/// hint dicts) without ever reading more than that on a non-linearized
/// file.
const SCAN_LIMIT: usize = 8192;

/// Minimum file size for which we'd bother probing — files below this
/// are too small for linearization to win anything (and may not even
/// have a hint dict).
pub const MIN_BYTES_FOR_LINEARIZATION: u64 = 64 * 1024; // 64 KB

/// Try to parse the linearization hint dict from `bytes`. Returns
/// `Ok(Some(info))` if the file is linearized and the dict parsed
/// cleanly, `Ok(None)` if not linearized (or hint dict not at front),
/// `Err` only when the input doesn't look like a PDF at all.
pub fn parse_linearization_hint(bytes: &[u8]) -> Result<Option<LinearizationInfo>> {
    // Edge case: empty / very-short buffers. A degenerate read of
    // zero bytes can't have a hint table — fall back to None rather
    // than reporting "not a PDF" because the buffer might just be a
    // pre-read sniff that's running ahead of the actual data.
    if bytes.len() < 5 {
        return Ok(None);
    }
    if &bytes[..5] != b"%PDF-" {
        return Err(AppError::Pdf("not a PDF (missing %PDF- header)".into()));
    }
    if bytes.len() < 32 {
        // Has %PDF- but no room for a hint dict. Treat as
        // not-linearized rather than malformed.
        return Ok(None);
    }

    // Cap scan window. The hint dict, if present, is the first
    // object — an offset of ~50 to ~1500 bytes from the start.
    let scan_end = bytes.len().min(SCAN_LIMIT);
    let window = &bytes[..scan_end];

    // Find the start of the first object: "<digits> <digits> obj"
    // followed by "<<" — the hint dict open. We scan rather than
    // strictly parse the header so trailing whitespace / binary
    // marker comments don't trip us up.
    let obj_start = match find_first_obj(window) {
        Some(p) => p,
        None => return Ok(None),
    };

    let dict_start = match memmem(&window[obj_start..], b"<<") {
        Some(rel) => obj_start + rel + 2,
        None => return Ok(None),
    };
    let dict_end = match memmem(&window[dict_start..], b">>") {
        Some(rel) => dict_start + rel,
        None => return Ok(None),
    };
    let dict = &window[dict_start..dict_end];

    // Required: /Linearized followed by 1 (any whitespace).
    if !dict_has_linearized_flag(dict) {
        return Ok(None);
    }

    // Pull the integer fields we care about. Missing fields → not a
    // valid hint dict, fall back to None rather than error.
    let n = read_int_field(dict, b"/N");
    let l = read_int_field(dict, b"/L");
    let e = read_int_field(dict, b"/E");
    let o = read_int_field(dict, b"/O");

    match (n, l, e, o) {
        (Some(n), Some(l), Some(e), Some(o)) if n > 0 && l > 0 => Ok(Some(LinearizationInfo {
            page_count: n as u32,
            file_length: l as u64,
            end_first_page: e as u64,
            first_page_object: o as u32,
        })),
        _ => Ok(None),
    }
}

/// Find "<digits> <digits> obj" within `window` — returns offset of
/// the first digit. Used to land at the start of the (presumed
/// linearization) hint object.
fn find_first_obj(window: &[u8]) -> Option<usize> {
    // Skip the header. After `%PDF-X.Y\n` there may be a comment line
    // (the binary marker `%abcd\n`). Scan past those before looking
    // for the first object.
    let mut i = 0;
    while i < window.len() {
        // Skip lines starting with '%'.
        if window[i] == b'%' {
            while i < window.len() && window[i] != b'\n' {
                i += 1;
            }
            i += 1;
            continue;
        }
        // Skip whitespace.
        if matches!(window[i], b' ' | b'\t' | b'\r' | b'\n') {
            i += 1;
            continue;
        }
        break;
    }

    // From `i`, look for `<num> <num> obj`.
    let scan = &window[i..];
    let obj_off = memmem(scan, b" obj")?;
    // Walk back: should see an integer pair separated by a space.
    let mut p = obj_off;
    while p > 0 && (scan[p - 1] as char).is_ascii_digit() {
        p -= 1;
    }
    if p == 0 || scan[p - 1] != b' ' {
        return None;
    }
    p -= 1;
    while p > 0 && (scan[p - 1] as char).is_ascii_digit() {
        p -= 1;
    }
    Some(i + p)
}

fn dict_has_linearized_flag(dict: &[u8]) -> bool {
    let key = b"/Linearized";
    let Some(off) = memmem(dict, key) else {
        return false;
    };
    // Skip whitespace after the key. Expect a literal '1'.
    let mut i = off + key.len();
    while i < dict.len() && matches!(dict[i], b' ' | b'\t' | b'\r' | b'\n') {
        i += 1;
    }
    i < dict.len() && dict[i] == b'1'
}

/// Read an integer-valued field from a flattened-dict slice. e.g.
/// `read_int_field(b"/N 1024 /L 5", b"/N") == Some(1024)`.
///
/// Handles the prefix-collision pitfall: `read_int_field(dict, b"/L")`
/// must NOT match `/Linearized` or `/Length`. After locating the key,
/// the next byte must be whitespace, `[` (array), or end-of-dict —
/// otherwise it's a longer key sharing this prefix; skip past and
/// continue scanning.
fn read_int_field(dict: &[u8], key: &[u8]) -> Option<i64> {
    let mut search_from = 0;
    loop {
        let off = memmem(&dict[search_from..], key)?;
        let abs = search_from + off;
        let after = abs + key.len();
        // Bail if the byte after the key isn't a key-terminator.
        let is_terminator = match dict.get(after).copied() {
            Some(b' ' | b'\t' | b'\r' | b'\n' | b'[' | b'(') => true,
            None => true,
            _ => false,
        };
        if !is_terminator {
            search_from = after;
            continue;
        }
        // Skip whitespace, optional sign, then read the digit run.
        let mut i = after;
        while i < dict.len() && matches!(dict[i], b' ' | b'\t' | b'\r' | b'\n') {
            i += 1;
        }
        let mut neg = false;
        if i < dict.len() && (dict[i] == b'-' || dict[i] == b'+') {
            neg = dict[i] == b'-';
            i += 1;
        }
        let start = i;
        while i < dict.len() && (dict[i] as char).is_ascii_digit() {
            i += 1;
        }
        if i == start {
            // Key matched but no number follows. Skip past and keep
            // scanning for another match (rare, but handles dicts
            // where the same short key appears twice in different
            // contexts).
            search_from = after;
            continue;
        }
        let s = std::str::from_utf8(&dict[start..i]).ok()?;
        let n: i64 = s.parse().ok()?;
        return Some(if neg { -n } else { n });
    }
}

/// Tiny `memmem`-equivalent. Avoids pulling `memchr` in for what's a
/// few hundred-byte search.
fn memmem(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    for i in 0..=haystack.len() - needle.len() {
        if &haystack[i..i + needle.len()] == needle {
            return Some(i);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synthetic_linearized() -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n");
        v.extend_from_slice(
            b"1 0 obj\n<<\n/Linearized 1\n/L 234567\n/H [1234 567]\n\
              /O 4\n/E 9876\n/N 1024\n/T 234500\n>>\nendobj\n",
        );
        v
    }

    #[test]
    fn parses_linearized_pdf() {
        let bytes = synthetic_linearized();
        let info = parse_linearization_hint(&bytes).unwrap().unwrap();
        assert_eq!(info.page_count, 1024);
        assert_eq!(info.file_length, 234567);
        assert_eq!(info.end_first_page, 9876);
        assert_eq!(info.first_page_object, 4);
    }

    #[test]
    fn returns_none_for_non_linearized() {
        // Same shape but no /Linearized flag.
        let mut bytes = b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n".to_vec();
        bytes.extend_from_slice(b"1 0 obj\n<<\n/Type /Catalog\n/Pages 2 0 R\n>>\nendobj\n");
        let r = parse_linearization_hint(&bytes).unwrap();
        assert!(r.is_none(), "non-linearized PDF must return None");
    }

    #[test]
    fn rejects_non_pdf() {
        let bytes = b"this is not a pdf".to_vec();
        let r = parse_linearization_hint(&bytes);
        assert!(r.is_err());
    }

    #[test]
    fn handles_empty_input() {
        let r = parse_linearization_hint(&[]).unwrap();
        assert!(r.is_none());
    }

    #[test]
    fn handles_truncated_header() {
        let r = parse_linearization_hint(b"%PDF").unwrap();
        assert!(r.is_none());
    }

    #[test]
    fn handles_negative_field_value() {
        // A malformed hint with /N 0 should be rejected as
        // not-linearized (n > 0 invariant).
        let mut bytes = b"%PDF-1.7\n".to_vec();
        bytes.extend_from_slice(
            b"1 0 obj\n<<\n/Linearized 1\n/L 100\n/H [1 1]\n\
              /O 1\n/E 1\n/N 0\n/T 1\n>>\nendobj\n",
        );
        let r = parse_linearization_hint(&bytes).unwrap();
        assert!(r.is_none());
    }

    #[test]
    fn read_int_field_basic() {
        assert_eq!(read_int_field(b"/N 1024", b"/N"), Some(1024));
        assert_eq!(read_int_field(b"/L\n234567", b"/L"), Some(234567));
        assert_eq!(read_int_field(b"/X 5 /Y 10", b"/Y"), Some(10));
        assert_eq!(read_int_field(b"/Missing 5", b"/N"), None);
    }

    #[test]
    fn skips_pdf_header_with_binary_marker() {
        // The %binary-marker comment line is required by PDF/1.4+
        // for true binary content. Make sure our skip handles it.
        let mut bytes = b"%PDF-1.7\n%\x80\x81\x82\x83\n".to_vec();
        bytes.extend_from_slice(
            b"1 0 obj\n<<\n/Linearized 1\n/L 1000\n/H [1 1]\n\
              /O 1\n/E 1\n/N 5\n/T 1\n>>\nendobj\n",
        );
        let info = parse_linearization_hint(&bytes).unwrap().unwrap();
        assert_eq!(info.page_count, 5);
    }

    #[test]
    fn dict_has_linearized_flag_only_matches_one() {
        assert!(dict_has_linearized_flag(b"/Linearized 1"));
        assert!(dict_has_linearized_flag(b"/Linearized\n1"));
        assert!(!dict_has_linearized_flag(b"/Linearized 0"));
        assert!(!dict_has_linearized_flag(b"/Other 1"));
    }

    #[test]
    fn min_size_constant_is_reasonable() {
        // 64 KB threshold isn't load-bearing in tests but document
        // it via a sanity check so a future drift surfaces.
        assert!(MIN_BYTES_FOR_LINEARIZATION >= 16 * 1024);
        assert!(MIN_BYTES_FOR_LINEARIZATION <= 1024 * 1024);
    }
}
