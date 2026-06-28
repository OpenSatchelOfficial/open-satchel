//! lopdf-backed implementation of the parser/store facade.
//!
//! lopdf is pinned at 0.32 workspace-wide (bump only on corpus
//! regression retest — see src-tauri/Cargo.toml). This module owns
//! every lopdf-typed expression in the core; the conversion boundary
//! into [`crate::pdf::object`] types is total — no lopdf type
//! escapes.

use crate::pdf::object::{PdfDict, PdfValue};
use crate::pdf::store::{DocumentHandle, DocumentStore};
use crate::{CoreError, Result};
use lopdf::{Document, Object};

/// Maximum reference-chase depth when converting lopdf objects into
/// core values. Caps cycles (PDF reference graphs may loop) and
/// keeps /Info-sized conversions cheap; anything deeper degrades to
/// [`PdfValue::Reference`] / [`PdfValue::Null`] rather than
/// recursing forever.
const MAX_CONVERT_DEPTH: u8 = 8;

/// [`DocumentStore`] over lopdf.
#[derive(Debug, Default, Clone, Copy)]
pub struct LopdfDocumentStore;

impl DocumentStore for LopdfDocumentStore {
    fn open(&self, bytes: &[u8]) -> Result<Box<dyn DocumentHandle>> {
        let doc = Document::load_mem(bytes)
            .map_err(|e| CoreError::Parse(format!("lopdf load: {e}")))?;
        Ok(Box::new(LopdfHandle { doc }))
    }
}

struct LopdfHandle {
    doc: Document,
}

impl DocumentHandle for LopdfHandle {
    fn page_count(&self) -> u32 {
        let pages = self.doc.get_pages().len() as u32;
        if pages == 0 && self.catalog_claims_pages() {
            // The catalog references a /Pages root, but the page tree
            // walk yielded nothing — the page-tree objects are
            // unreachable (corrupt or undecodable object stream, the
            // os-signed-L2-FP2.pdf pathology: catalog → /Pages 1 0 R,
            // but object 1 lives only inside an ObjStm lopdf can't
            // decode). lopdf "loads" the file and would silently
            // report 0 pages; record a fallback so strict callers see
            // this is a degraded open, not a genuinely empty document.
            // (pdfjs fails this case loudly with "Invalid Root
            // reference"; we keep the readable /Info metadata but flag
            // the structural loss.)
            crate::fallback::record(
                "lopdf.page_tree.unreachable",
                "catalog references a /Pages root but the page tree resolved to 0 pages",
            );
        }
        pages
    }

    fn info_dict(&self) -> Option<PdfDict> {
        let info_obj = self.doc.trailer.get(b"Info").ok()?;
        let dict = resolve_dict(&self.doc, info_obj)?;
        match convert_dict(&self.doc, dict, MAX_CONVERT_DEPTH) {
            PdfValue::Dictionary(d) => Some(d),
            _ => None,
        }
    }

    fn xmp_metadata(&self) -> Option<Vec<u8>> {
        let catalog = self.doc.catalog().ok()?;
        let meta = catalog.get(b"Metadata").ok()?;
        let stream = match meta {
            Object::Reference(r) => self
                .doc
                .get_object(*r)
                .ok()
                .and_then(|o| o.as_stream().ok())?,
            Object::Stream(s) => s,
            _ => return None,
        };
        // An XMP metadata stream with NO /Filter is normal and
        // correct — PDF/A even REQUIRES the metadata stream to be
        // uncompressed — so its raw bytes ARE the content. Only a
        // stream that declares a filter we then fail to decode is a
        // genuine degradation worth flagging.
        match stream.decompressed_content() {
            Ok(content) => Some(content),
            Err(_) if !stream.dict.has(b"Filter") => Some(stream.content.clone()),
            Err(e) => {
                crate::fallback::record(
                    "lopdf.xmp.raw_content",
                    format!("filtered XMP stream undecodable ({e}); serving raw bytes"),
                );
                Some(stream.content.clone())
            }
        }
    }

    fn version(&self) -> String {
        self.doc.version.clone()
    }
}

impl LopdfHandle {
    /// True when the document catalog carries a `/Pages` entry — i.e.
    /// the file *claims* to have a page tree, so a 0-page walk is a
    /// structural failure rather than a legitimately empty document.
    fn catalog_claims_pages(&self) -> bool {
        self.doc
            .catalog()
            .ok()
            .map(|c| c.has(b"Pages"))
            .unwrap_or(false)
    }
}

fn resolve_dict<'a>(doc: &'a Document, obj: &'a Object) -> Option<&'a lopdf::Dictionary> {
    match obj {
        Object::Dictionary(d) => Some(d),
        Object::Reference(r) => doc.get_object(*r).ok().and_then(|o| o.as_dict().ok()),
        _ => None,
    }
}

/// Convert an lopdf dictionary into a core [`PdfValue::Dictionary`],
/// resolving references up to `depth` hops.
fn convert_dict(doc: &Document, dict: &lopdf::Dictionary, depth: u8) -> PdfValue {
    let mut out = PdfDict::new();
    for (key, value) in dict.iter() {
        out.insert(key.clone(), convert(doc, value, depth));
    }
    PdfValue::Dictionary(out)
}

fn convert(doc: &Document, obj: &Object, depth: u8) -> PdfValue {
    if depth == 0 {
        // Depth cap hit — degrade rather than recurse. References
        // stay inspectable; aggregates collapse to Null.
        crate::fallback::record(
            "lopdf.convert.depth_cap",
            "object conversion hit MAX_CONVERT_DEPTH; value degraded",
        );
        return match obj {
            Object::Reference((n, g)) => PdfValue::Reference(*n, *g),
            _ => PdfValue::Null,
        };
    }
    match obj {
        Object::Null => PdfValue::Null,
        Object::Boolean(b) => PdfValue::Boolean(*b),
        Object::Integer(i) => PdfValue::Integer(*i),
        Object::Real(r) => PdfValue::Real(f64::from(*r)),
        Object::String(bytes, _) => PdfValue::String(bytes.clone()),
        Object::Name(name) => PdfValue::Name(name.clone()),
        Object::Array(items) => {
            PdfValue::Array(items.iter().map(|o| convert(doc, o, depth - 1)).collect())
        }
        Object::Dictionary(d) => convert_dict(doc, d, depth - 1),
        // Stream payloads aren't modeled in the core object set yet;
        // surface the stream's dictionary (enough for every current
        // consumer — XMP goes through xmp_metadata()).
        Object::Stream(s) => convert_dict(doc, &s.dict, depth - 1),
        Object::Reference(r) => match doc.get_object(*r) {
            Ok(inner) => convert(doc, inner, depth - 1),
            Err(_) => PdfValue::Reference(r.0, r.1),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pdf::info::read_document_info;
    use lopdf::dictionary;

    /// Build a minimal 2-page PDF with an /Info dict in memory.
    fn sample_pdf() -> Vec<u8> {
        let mut doc = Document::with_version("1.7");
        let pages_id = doc.new_object_id();
        let font_id = doc.add_object(dictionary! {
            "Type" => "Font",
            "Subtype" => "Type1",
            "BaseFont" => "Helvetica",
        });
        let resources_id = doc.add_object(dictionary! {
            "Font" => dictionary! { "F1" => font_id },
        });
        let make_page = |doc: &mut Document| {
            let content_id = doc.add_object(lopdf::Object::Stream(lopdf::Stream::new(
                dictionary! {},
                b"BT /F1 12 Tf 72 720 Td (hi) Tj ET".to_vec(),
            )));
            doc.add_object(dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "Contents" => content_id,
            })
        };
        let page1 = make_page(&mut doc);
        let page2 = make_page(&mut doc);
        let pages = dictionary! {
            "Type" => "Pages",
            "Kids" => vec![page1.into(), page2.into()],
            "Count" => 2,
            "Resources" => resources_id,
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
        };
        doc.objects.insert(pages_id, lopdf::Object::Dictionary(pages));
        let catalog_id = doc.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        // /Title as UTF-16 BE with BOM ("Né"), /Author plain ASCII.
        let title_utf16: Vec<u8> = vec![0xFE, 0xFF, 0x00, 0x4E, 0x00, 0xE9];
        let info_id = doc.add_object(dictionary! {
            "Title" => lopdf::Object::String(title_utf16, lopdf::StringFormat::Hexadecimal),
            "Author" => lopdf::Object::string_literal("Storm Author"),
        });
        doc.trailer.set("Root", catalog_id);
        doc.trailer.set("Info", info_id);
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).expect("save sample pdf");
        bytes
    }

    /// Synthetic reproduction of the os-signed-L2-FP2.pdf pathology:
    /// the catalog references a /Pages root whose object is NOT
    /// present (in the real file it's trapped in an undecodable
    /// ObjStm; here we simply never register it). lopdf loads the
    /// trailer fine, but the page-tree walk yields 0 pages.
    fn pages_unreachable_pdf() -> Vec<u8> {
        let mut doc = Document::with_version("1.7");
        // /Pages points at object (999, 0), which we deliberately
        // never add — the page tree is unreachable.
        let catalog_id = doc.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => (999u32, 0u16),
        });
        let info_id = doc.add_object(dictionary! {
            "Title" => lopdf::Object::string_literal("Broken But Has Metadata"),
        });
        doc.trailer.set("Root", catalog_id);
        doc.trailer.set("Info", info_id);
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).expect("save");
        bytes
    }

    #[test]
    fn opens_counts_pages_and_reads_info() {
        let bytes = sample_pdf();
        let handle = LopdfDocumentStore.open(&bytes).expect("open");
        // A healthy document counts pages with ZERO fallbacks.
        let (count, events) =
            crate::fallback::capture(|| handle.page_count());
        assert_eq!(count, 2);
        assert!(events.is_empty(), "healthy doc must not record fallbacks: {events:?}");
        assert_eq!(handle.version(), "1.7");

        let info = read_document_info(handle.as_ref());
        assert_eq!(info.title.as_deref(), Some("Né"));
        assert_eq!(info.author.as_deref(), Some("Storm Author"));
        assert_eq!(info.producer, None);
        assert_eq!(info.xmp_preview, None);
    }

    /// The FP2 case: lopdf loads it (so /Info is still readable), but
    /// the unreachable page tree records a fallback instead of
    /// silently reporting a 0-page "success".
    #[test]
    fn unreachable_page_tree_records_fallback_but_keeps_metadata() {
        let bytes = pages_unreachable_pdf();
        let handle = LopdfDocumentStore
            .open(&bytes)
            .expect("lopdf loads the trailer even with a broken page tree");

        let (count, events) = crate::fallback::capture(|| handle.page_count());
        assert_eq!(count, 0, "page tree is unreachable");
        let areas: Vec<&str> = events.iter().map(|e| e.area.as_str()).collect();
        assert_eq!(
            areas,
            vec!["lopdf.page_tree.unreachable"],
            "0-page degraded open must be flagged, not silent"
        );

        // The readable /Info survives — flagging the page loss must
        // not throw away the metadata that IS recoverable.
        let info = read_document_info(handle.as_ref());
        assert_eq!(info.title.as_deref(), Some("Broken But Has Metadata"));
    }

    #[test]
    fn garbage_bytes_fail_with_parse_error() {
        let err = match LopdfDocumentStore.open(b"not a pdf") {
            Ok(_) => panic!("garbage bytes should not parse"),
            Err(e) => e,
        };
        assert!(matches!(err, CoreError::Parse(_)), "got {err:?}");
    }
}
