//! Types crossing the pdf_engine boundary.
//!
//! S2 scope: only [`IncrementalPatch`] (empty in practice) and
//! [`WriteSummary`]. S5.5-P1 extended `IncrementalPatch` to carry a
//! per-page overlay content-stream — the mask-blanking bake path.
//! S5.5-P2 adds the `inject_helvetica_font_as` option so the overlay
//! can draw text as well. G3 generalizes that single Helvetica slot
//! into a `HashMap<resource_name, basefont>` so a page that mixes
//! regular + bold + italic edits can carry up to four font variants.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// A single page-level patch to apply during an incremental write.
///
/// **S2:** empty patches were the only accepted value.
///
/// **S5.5-P1:** a non-empty `overlay_stream` appends a new
/// content-stream object to the page's `/Contents` array. The writer
/// allocates a new indirect-object number, emits the stream, and
/// re-emits the page dictionary under its original object number so
/// readers see the updated `/Contents`. Signatures on the original
/// byte range are untouched.
///
/// **S5.5-P2:** `inject_helvetica_font_as` causes the writer to
/// emit a Type1 Helvetica font object and wire it into the page's
/// `/Resources /Font` under the provided name, so the overlay stream
/// can draw text via `/<name> <size> Tf  (text) Tj`.
///
/// The overlay stream bytes are passed in UNCOMPRESSED; the writer
/// emits them as-is with a `/Length` equal to `overlay_stream.len()`.
/// Compression is a later optimization.
#[derive(Debug, Clone, Deserialize)]
pub struct IncrementalPatch {
    /// 0-based page index this patch targets.
    pub page_index: u32,

    /// Uncompressed content-stream bytes to append to the page's
    /// `/Contents` array as a new indirect object. Empty means no
    /// overlay (patch is effectively a no-op and the writer skips it).
    #[serde(default)]
    pub overlay_stream: Vec<u8>,

    /// When `Some(name)`, the writer injects a Type1 Helvetica font
    /// object and patches the page's `/Resources /Font` dict to
    /// include `name -> font_ref`, so the overlay stream can draw
    /// text via `/<name> <size> Tf  (text) Tj`.
    ///
    /// **Deprecated since G3:** prefer `inject_standard14_fonts`
    /// which supports multiple variants. This field is still honored
    /// for callers that haven't migrated; if both are populated, the
    /// HashMap takes precedence. When `inject_helvetica_font_as` is
    /// `Some(name)` and the HashMap is empty, the writer behaves
    /// exactly like pre-G3: emits a single `/Helvetica` Type1 font
    /// at that resource name.
    ///
    /// `None` → no font injection (mask-only overlay, P1 behavior).
    #[serde(default, rename = "injectHelveticaFontAs")]
    pub inject_helvetica_font_as: Option<String>,

    /// G3: resource-name → PostScript BaseFont name for every
    /// Standard 14 font variant the page needs. Each entry causes
    /// the writer to emit one Type1 font dict (with `WinAnsiEncoding`)
    /// at that BaseFont and register it under the resource name on
    /// the page's `/Resources /Font` dict.
    ///
    /// Example payload for a page with regular + bold + italic edits:
    /// ```text
    /// {"Ovl0": "Helvetica",
    ///  "Ovl1": "Helvetica-Bold",
    ///  "Ovl2": "Helvetica-Oblique"}
    /// ```
    /// The overlay stream picks per-edit between `/Ovl0`, `/Ovl1`,
    /// `/Ovl2` via `/<name> <size> Tf` switches.
    ///
    /// Standard 14 BaseFonts are universally recognized by PDF
    /// readers — no font bytes need to be embedded. Custom families
    /// (G2) will use a separate `inject_embedded_fonts` slot keyed
    /// on font_id with associated /FontFile2 streams.
    ///
    /// Empty map → fall through to `inject_helvetica_font_as`.
    #[serde(default, rename = "injectStandard14Fonts")]
    pub inject_standard14_fonts: HashMap<String, String>,

    /// G2: resource-name → embedded TrueType font payload for any
    /// non-Standard-14 fonts the page needs. Each entry causes the
    /// writer to emit a four-object chain:
    ///
    ///     /Type0 (with /Encoding /Identity-H, /DescendantFonts → CIDFont)
    ///       └─> /CIDFontType2 (with /CIDSystemInfo, /CIDToGIDMap /Identity,
    ///                          /W width array, /FontDescriptor → ↓)
    ///             └─> /FontDescriptor (with /Ascent /Descent /CapHeight
    ///                                  /ItalicAngle /StemV /Flags
    ///                                  /FontBBox /MissingWidth
    ///                                  /XHeight /FontFile2 → ↓)
    ///                   └─> stream object holding the (subsetted) TTF bytes
    ///
    /// The Type0 is registered on the page's `/Resources /Font` under
    /// the resource name; overlay streams switch to it via
    /// `/<name> <size> Tf` and emit text as 2-byte hex strings of CIDs
    /// (`<00410042…> Tj` for Identity-H — each glyph's CID is its
    /// glyph index in the font).
    ///
    /// Frontend pre-resolves + subsets each unique non-Standard-14
    /// font (via `pdfFontResolution.resolveSystemFont` then
    /// `font_subset` Tauri command) so the bytes here are already the
    /// minimum needed to render the edits' codepoints.
    ///
    /// Empty map → no embedded fonts (Standard 14 path only).
    #[serde(default, rename = "injectEmbeddedFonts")]
    pub inject_embedded_fonts: HashMap<String, EmbeddedFontPayload>,

    /// When true, the writer wraps `overlay_stream` bytes with
    /// `/Filter /FlateDecode` and emits the compressed form. Shrinks
    /// typical overlay streams ~2× (repetitive PDF operator tokens
    /// compress well). Default `false` so existing callers keep the
    /// raw, grep-friendly stream; `bake_edit_model` flips it on
    /// for the production path.
    #[serde(default, rename = "compressOverlay")]
    pub compress_overlay: bool,

    /// Indirect-object references `(object_number, generation)` that
    /// should be marked free in the new xref section. Reserved for
    /// full content-stream rewrite; unused currently.
    #[serde(default)]
    pub removed_object_ids: Vec<(u32, u16)>,
}

/// G2 embedded-font payload. Carried inside an [`IncrementalPatch`]'s
/// `inject_embedded_fonts` map; the writer parses the TTF via
/// `ttf-parser` to derive cmap + hmtx + bbox + style flags it needs
/// for the FontDescriptor and CIDFontType2 dicts.
///
/// Frontend builds these by:
///   1. Resolving the system font via `resolveSystemFont(family, bold,
///      italic)` (returns the .ttf bytes from the user's OS).
///   2. Sub-setting via `font_subset(bytes, codepoints)` Tauri command
///      so the embedded payload is the smallest valid font that still
///      maps every codepoint the edits touch.
///   3. Computing `subset_codepoints` from every edit using this font
///      (Set<u32> over `e.new_text.chars()`).
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct EmbeddedFontPayload {
    /// Subsetted TrueType bytes ready to drop into `/FontFile2`.
    /// Length is /Length1 in the FontFile2 stream dict. Marshals
    /// as `number[]` over the Tauri JSON IPC — same pattern as
    /// `pdf_decrypt_bytes`. ~1MB subsetted Latin-only fonts cross
    /// the bridge in ~10ms.
    pub bytes: Vec<u8>,

    /// PostScript-style font name to use as `/BaseFont`. Per the PDF
    /// spec, embedded subsets are conventionally prefixed with six
    /// uppercase letters + "+" (e.g. `AAAABB+OpenSans-Regular`); the
    /// writer adds the prefix automatically if `postscript_name`
    /// doesn't already include one. Without subsetting, the unprefixed
    /// name is acceptable.
    pub postscript_name: String,

    /// `bold` / `italic` style flags echoed from the resolved font's
    /// metadata. Used to set the corresponding `/Flags` bits on the
    /// FontDescriptor (bit 2 = Serif, bit 18 = Bold, bit 6 = Italic /
    /// Symbolic — actually we set bit 2 (Serif) only when known
    /// serif; we always set bit 6 (Symbolic) for non-Standard14 to
    /// signal a non-standard glyph set).
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub italic: bool,
}

/// Metadata returned alongside the byte output after a successful
/// incremental write. Used by tests and the future frontend bake
/// path to confirm the output shape without re-parsing.
#[derive(Debug, Clone, Serialize)]
pub struct WriteSummary {
    /// Total output size (original + appended increment).
    pub total_bytes: usize,

    /// Bytes appended to the original — never zero for a valid
    /// incremental update, even when no semantic edits are made
    /// (the xref + trailer + startxref + %%EOF are always emitted).
    pub appended_bytes: usize,

    /// Byte offset within the output where the new `xref` keyword
    /// starts — this is the value emitted after `startxref` in the
    /// new trailer.
    pub new_xref_offset: usize,

    /// Byte offset of the PREVIOUS xref (the original document's
    /// xref start), emitted as `/Prev` in the new trailer.
    pub previous_xref_offset: usize,

    /// Count of new indirect objects emitted in this increment
    /// (overlay streams + any replaced page dictionaries). Zero for
    /// the pure no-op empty-patches path.
    pub new_objects_emitted: usize,
}
