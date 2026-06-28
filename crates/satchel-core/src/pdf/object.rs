//! Core-owned PDF object model.
//!
//! A deliberately minimal mirror of the PDF object system (ISO 32000
//! §7.3) owned by the core so that no backend type ever crosses the
//! facade. Backends convert their native objects into these; core
//! logic only ever sees these. Grows per consumer — tonight it
//! carries what the /Info + metadata reader needs; it is NOT yet a
//! complete object model.

/// A PDF object value, backend-independent.
#[derive(Debug, Clone, PartialEq)]
pub enum PdfValue {
    /// The PDF `null` object.
    Null,
    /// Boolean.
    Boolean(bool),
    /// Integer number.
    Integer(i64),
    /// Real number.
    Real(f64),
    /// String object — RAW bytes as stored in the file
    /// (PDFDocEncoding or UTF-16BE with BOM; see
    /// [`crate::pdf::info::decode_pdf_text_string`]).
    String(Vec<u8>),
    /// Name object, without the leading `/`.
    Name(Vec<u8>),
    /// Array of values.
    Array(Vec<PdfValue>),
    /// Dictionary.
    Dictionary(PdfDict),
    /// Indirect reference `(object number, generation)` that the
    /// backend did not resolve (cycle guard or depth cap).
    Reference(u32, u16),
}

/// A PDF dictionary with core-owned keys/values.
///
/// Key order is preserved as encountered; PDF dictionary semantics
/// don't depend on order, but stable iteration keeps diagnostics and
/// tests deterministic.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PdfDict {
    entries: Vec<(Vec<u8>, PdfValue)>,
}

impl PdfDict {
    /// Empty dictionary.
    pub fn new() -> Self {
        Self::default()
    }

    /// Append an entry. Last write wins on duplicate keys (matches
    /// reader behavior of every mainstream PDF parser).
    pub fn insert(&mut self, key: impl Into<Vec<u8>>, value: PdfValue) {
        let key = key.into();
        if let Some(slot) = self.entries.iter_mut().find(|(k, _)| *k == key) {
            slot.1 = value;
        } else {
            self.entries.push((key, value));
        }
    }

    /// Look up a value by key.
    pub fn get(&self, key: &[u8]) -> Option<&PdfValue> {
        self.entries
            .iter()
            .find(|(k, _)| k.as_slice() == key)
            .map(|(_, v)| v)
    }

    /// Raw string bytes for `key`, if present and a string.
    pub fn get_string(&self, key: &[u8]) -> Option<&[u8]> {
        match self.get(key) {
            Some(PdfValue::String(b)) => Some(b.as_slice()),
            _ => None,
        }
    }

    /// Number of entries.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// True when the dictionary has no entries.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Iterate entries in insertion order.
    pub fn iter(&self) -> impl Iterator<Item = (&[u8], &PdfValue)> {
        self.entries.iter().map(|(k, v)| (k.as_slice(), v))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dict_insert_get_and_last_write_wins() {
        let mut d = PdfDict::new();
        d.insert(b"Title".to_vec(), PdfValue::String(b"one".to_vec()));
        d.insert(b"Title".to_vec(), PdfValue::String(b"two".to_vec()));
        assert_eq!(d.len(), 1);
        assert_eq!(d.get_string(b"Title"), Some(b"two".as_slice()));
        assert_eq!(d.get(b"Missing"), None);
    }
}
