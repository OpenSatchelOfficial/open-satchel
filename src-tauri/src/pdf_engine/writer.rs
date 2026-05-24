//! Incremental-update writer (ISO 32000-1 §7.5.6).
//!
//! An incremental update appends bytes to an existing PDF that record
//! new/modified objects plus a fresh xref section and trailer. The
//! original bytes stay byte-identical, which is the only way to
//! preserve digital signatures across edits.
//!
//! # S2 — no-op increments
//!
//! Empty patch list produces a minimal but spec-valid update:
//!
//! ```text
//! xref
//! 0 1
//! 0000000000 65535 f
//! trailer
//! << /Size … /Prev … /Root … /Info … /ID … /Encrypt … >>
//! startxref
//! <byte offset>
//! %%EOF
//! ```
//!
//! # S5.5-P1 — overlay content-streams
//!
//! Non-empty patches append a new content-stream object per patch and
//! re-emit the target page dictionary with its `/Contents` array
//! extended to include the new stream reference. The new xref section
//! has multiple subsections: one for the free-list head, one per
//! superseded page dictionary (same object number), and contiguous
//! subsections for the newly-allocated overlay-stream objects. `/Size`
//! in the trailer bumps to `max_new_obj_id + 1`.
//!
//! Text emission in the overlay stream is S5.5-P2 (needs font resource
//! management + ToUnicode CMap reverse-mapping). P1 ships the pipeline
//! end-to-end with mask-only overlays as proof of life.

use crate::error::AppError;
use crate::Result;
use lopdf::{Dictionary, Document, Object, ObjectId, StringFormat};
use std::collections::BTreeMap;
use std::io::Cursor;

use super::types::{EmbeddedFontPayload, IncrementalPatch, WriteSummary};

/// Append a spec-valid incremental update to `original_bytes` and
/// return `(output_bytes, summary)`. An empty `patches` slice yields
/// a no-op increment (identity round-trip); non-empty patches emit
/// overlay streams and re-emit the affected page dictionaries.
pub fn write_incremental(
    original_bytes: &[u8],
    patches: &[IncrementalPatch],
) -> Result<(Vec<u8>, WriteSummary)> {
    // Primary path: let lopdf do the heavy lifting for classic-xref
    // documents we can fully parse. Fall back to a raw-bytes trailer
    // scanner for PDFs lopdf 0.32 chokes on — chiefly xref-stream
    // documents and signed PKCS#11 PDFs whose trailer layout
    // confuses the nom parser (see S7.5 note below).
    let prev_xref_offset = find_last_startxref_value(original_bytes)
        .ok_or_else(|| AppError::Pdf("original has no startxref".into()))?;

    let mut cursor = Cursor::new(original_bytes);
    let lopdf_doc = Document::load_from(&mut cursor).ok();

    if lopdf_doc.is_none() {
        // Non-empty patches require full doc access (page tree, max_id).
        // The fallback path handles empty-patches only — enough to
        // unblock signed-preservation (the crown jewel), but overlay
        // bakes on these docs still need a future upstream fix or a
        // hand-rolled full parser.
        if !patches.is_empty() {
            return Err(AppError::Pdf(
                "pdf_engine writer: source could not be parsed by lopdf \
                 and non-empty patches need full doc access. Empty-patches \
                 (identity round-trip) does work on these sources via the \
                 raw-trailer fallback. This is the S7.5 limitation: lopdf \
                 0.32 rejects some xref-stream + signed PDFs. Overlay \
                 bakes on these will land with a full parser migration."
                    .into(),
            ));
        }
        return write_incremental_raw_fallback(original_bytes, prev_xref_offset);
    }
    let doc = lopdf_doc.expect("checked is_some above");

    // Build the appended section.
    let mut out = Vec::with_capacity(original_bytes.len() + 512);
    out.extend_from_slice(original_bytes);

    // Per §7.5.6, the incremental update starts AFTER the original
    // %%EOF. The spec does not require a separator, but many parsers
    // are more reliable if each logical section sits on its own line.
    if !out.ends_with(b"\n") {
        out.push(b'\n');
    }

    // Emit any patch-driven objects first, collecting their
    // (obj_num, gen, offset) for the xref.
    let mut emitted: Vec<EmittedObject> = Vec::new();
    let mut next_new_id: u32 = doc.max_id + 1;

    if !patches.is_empty() {
        let pages: BTreeMap<u32, ObjectId> = doc.get_pages();

        for patch in patches {
            // Empty-overlay patches are a no-op in P1. Skipping them
            // keeps the writer idempotent against a frontend that
            // always sends a patch per page regardless of content.
            if patch.overlay_stream.is_empty() {
                continue;
            }
            if !patch.removed_object_ids.is_empty() {
                return Err(AppError::Pdf(format!(
                    "pdf_engine writer: patch.removed_object_ids is \
                     reserved for S5.5-P2 content-stream rewrite; \
                     page {} sent {} id(s)",
                    patch.page_index,
                    patch.removed_object_ids.len()
                )));
            }

            // lopdf indexes pages 1-based; our API uses 0-based.
            let page_num_1based = patch.page_index + 1;
            let page_id = *pages.get(&page_num_1based).ok_or_else(|| {
                AppError::Pdf(format!(
                    "page index {} out of range (document has {} pages)",
                    patch.page_index,
                    pages.len()
                ))
            })?;

            // 1. Emit the overlay content-stream as a new indirect object.
            let overlay_obj_num = next_new_id;
            next_new_id += 1;
            let overlay_offset = out.len();
            if patch.compress_overlay {
                emit_flate_stream_object(&mut out, overlay_obj_num, &patch.overlay_stream)?;
            } else {
                emit_stream_object(&mut out, overlay_obj_num, &patch.overlay_stream);
            }
            emitted.push(EmittedObject {
                obj_num: overlay_obj_num,
                generation: 0,
                offset: overlay_offset,
            });

            // 2. P2 / G3 text emission: emit one Type1 font dict per
            //    Standard 14 variant the patch needs. Two payload
            //    shapes are honored:
            //
            //      a. NEW (G3): `inject_standard14_fonts` is a map of
            //         resource_name → BaseFont. Multiple variants
            //         (Helvetica + Helvetica-Bold + Helvetica-Oblique
            //         + Helvetica-BoldOblique) coexist on the same
            //         page; each gets its own Type1 dict.
            //
            //      b. LEGACY (P2): `inject_helvetica_font_as` is a
            //         single resource_name with implied BaseFont
            //         "Helvetica". Only consulted when the new map
            //         is empty so callers that haven't migrated keep
            //         working.
            let mut font_refs: Vec<(String, (u32, u16))> = Vec::new();
            if !patch.inject_standard14_fonts.is_empty() {
                // Sort by resource_name for deterministic byte output —
                // makes diffs across runs stable for fixture tests.
                let mut entries: Vec<(&String, &String)> =
                    patch.inject_standard14_fonts.iter().collect();
                entries.sort_by(|a, b| a.0.cmp(b.0));
                for (resource_name, basefont) in entries {
                    let font_obj_num = next_new_id;
                    next_new_id += 1;
                    let font_offset = out.len();
                    emit_type1_font_object(&mut out, font_obj_num, basefont);
                    emitted.push(EmittedObject {
                        obj_num: font_obj_num,
                        generation: 0,
                        offset: font_offset,
                    });
                    font_refs.push((resource_name.to_string(), (font_obj_num, 0)));
                }
            } else if let Some(name) = patch.inject_helvetica_font_as.as_deref() {
                let font_obj_num = next_new_id;
                next_new_id += 1;
                let font_offset = out.len();
                emit_type1_font_object(&mut out, font_obj_num, "Helvetica");
                emitted.push(EmittedObject {
                    obj_num: font_obj_num,
                    generation: 0,
                    offset: font_offset,
                });
                font_refs.push((name.to_string(), (font_obj_num, 0)));
            }

            // G2: emit embedded TrueType font chain per resource.
            // Each entry produces FOUR new objects:
            //   N+0: /FontFile2 stream (the TTF bytes)
            //   N+1: /FontDescriptor (metrics + /FontFile2 ref)
            //   N+2: /CIDFontType2 (descendant CID font with widths)
            //   N+3: /Type0 (the public-facing /BaseFont entry,
            //                Identity-H encoded; this is what
            //                /Resources /Font /<resource> points at)
            // Sorted by resource_name for deterministic output.
            if !patch.inject_embedded_fonts.is_empty() {
                let mut entries: Vec<(&String, &EmbeddedFontPayload)> =
                    patch.inject_embedded_fonts.iter().collect();
                entries.sort_by(|a, b| a.0.cmp(b.0));
                for (resource_name, payload) in entries {
                    match emit_embedded_font_chain(&mut out, &mut next_new_id, payload) {
                        Ok((type0_ref, mut new_emitted)) => {
                            emitted.append(&mut new_emitted);
                            font_refs.push((resource_name.to_string(), type0_ref));
                        }
                        Err(e) => {
                            // Failed to parse the TTF or build the
                            // descriptor — skip the embed. The overlay
                            // text for this resource will fall back to
                            // a missing-font glyph block, but the page
                            // structure stays valid. (Frontend should
                            // catch this earlier via `font_subset`'s
                            // ttf-parser validation, so reaching this
                            // branch is unusual.)
                            eprintln!(
                                "[engine-bake] embedded-font emit failed for {}: {}",
                                resource_name, e
                            );
                        }
                    }
                }
            }

            // 3. Re-emit the page dictionary at its original object
            //    number. Always appends overlay to /Contents; if any
            //    fonts were injected, also merges them into /Resources.
            let original_page_dict = doc
                .get_dictionary(page_id)
                .map_err(|e| AppError::Pdf(format!("read page dict {}: {e}", page_id.0)))?;
            let mut patched_page_dict =
                clone_with_appended_contents(original_page_dict, (overlay_obj_num, 0));
            for (font_name, font_ref) in &font_refs {
                patched_page_dict = merge_font_into_resources(
                    patched_page_dict,
                    &doc,
                    page_id,
                    font_name,
                    *font_ref,
                );
            }
            let page_dict_offset = out.len();
            emit_dict_object(&mut out, page_id.0, page_id.1, &patched_page_dict);
            emitted.push(EmittedObject {
                obj_num: page_id.0,
                generation: page_id.1,
                offset: page_dict_offset,
            });
        }
    }

    // ── Xref ────────────────────────────────────────────────────────
    let new_xref_offset = out.len();
    out.extend_from_slice(b"xref\n");
    // Subsection 0 1: the free-list head is required in every xref.
    out.extend_from_slice(b"0 1\n0000000000 65535 f \n");

    // Group emitted objects by contiguous obj_num ranges so we can
    // emit multiple xref subsections rather than one huge sparse one.
    if !emitted.is_empty() {
        // Sort by obj_num so grouping is straightforward.
        emitted.sort_by_key(|e| e.obj_num);
        // Deduplicate — same obj_num emitted twice would be a bug,
        // but dedup keeps the xref emission defensive.
        emitted.dedup_by_key(|e| e.obj_num);

        let mut i = 0;
        while i < emitted.len() {
            // Find contiguous run.
            let mut j = i;
            while j + 1 < emitted.len() && emitted[j + 1].obj_num == emitted[j].obj_num + 1 {
                j += 1;
            }
            let start = emitted[i].obj_num;
            let count = j - i + 1;
            out.extend_from_slice(format!("{} {}\n", start, count).as_bytes());
            for entry in &emitted[i..=j] {
                out.extend_from_slice(
                    format!("{:010} {:05} n \n", entry.offset, entry.generation).as_bytes(),
                );
            }
            i = j + 1;
        }
    }

    // ── Trailer ─────────────────────────────────────────────────────
    out.extend_from_slice(b"trailer\n<<\n");

    // /Size: 1 + highest object number across ALL xrefs. If we emitted
    // any new objects, the highest is next_new_id - 1; otherwise it's
    // whatever the original trailer said.
    let orig_size = trailer_i64(&doc.trailer, b"Size").unwrap_or(0);
    let new_size = if emitted.is_empty() {
        orig_size
    } else {
        // max new id is next_new_id - 1 (next_new_id points at the next
        // available slot). /Size = max + 1 = next_new_id.
        std::cmp::max(orig_size, next_new_id as i64)
    };
    out.extend_from_slice(format!("  /Size {}\n", new_size).as_bytes());

    // /Prev: byte offset of the PREVIOUS xref section. This is what
    // makes the update "incremental" — readers walk /Prev pointers
    // backward to reconstruct the full xref chain.
    out.extend_from_slice(format!("  /Prev {}\n", prev_xref_offset).as_bytes());

    // /Root: required. Point at the same catalog as the original.
    if let Ok(root) = doc.trailer.get(b"Root") {
        let mut s = String::from("  /Root ");
        write_pdf_object(root, &mut s);
        s.push('\n');
        out.extend_from_slice(s.as_bytes());
    } else {
        return Err(AppError::Pdf("original trailer missing /Root".into()));
    }

    // /Info: optional but usually present. Copy if exists.
    if let Ok(info) = doc.trailer.get(b"Info") {
        let mut s = String::from("  /Info ");
        write_pdf_object(info, &mut s);
        s.push('\n');
        out.extend_from_slice(s.as_bytes());
    }

    // /ID: file identifier pair. Copy if exists; integrity-conscious
    // readers check this.
    if let Ok(id) = doc.trailer.get(b"ID") {
        let mut s = String::from("  /ID ");
        write_pdf_object(id, &mut s);
        s.push('\n');
        out.extend_from_slice(s.as_bytes());
    }

    // /Encrypt: preserve exactly if the source was encrypted.
    if let Ok(enc) = doc.trailer.get(b"Encrypt") {
        let mut s = String::from("  /Encrypt ");
        write_pdf_object(enc, &mut s);
        s.push('\n');
        out.extend_from_slice(s.as_bytes());
    }

    out.extend_from_slice(b">>\n");
    out.extend_from_slice(format!("startxref\n{}\n%%EOF\n", new_xref_offset).as_bytes());

    let summary = WriteSummary {
        total_bytes: out.len(),
        appended_bytes: out.len() - original_bytes.len(),
        new_xref_offset,
        previous_xref_offset: prev_xref_offset,
        new_objects_emitted: emitted.len(),
    };

    Ok((out, summary))
}

/// Emit an incremental update that supersedes specific content-stream
/// objects with rewritten bytes. Used by the true-text-edit path in
/// [`crate::pdf_engine::text_rewrite`]: we modify content streams in
/// place (rewrite Tj/TJ operands) and re-emit them at their original
/// object numbers, so readers see the rewritten text through the
/// `/Prev` chain without needing an overlay stream.
///
/// Unlike [`write_incremental`], no new object numbers are allocated
/// here — each rewritten stream keeps its original ID. The trailer's
/// `/Size` therefore doesn't change.
pub fn write_incremental_rewrite(
    original_bytes: &[u8],
    doc: &Document,
    rewritten: &[(ObjectId, Vec<u8>)],
) -> Result<(Vec<u8>, WriteSummary)> {
    let prev_xref_offset = find_last_startxref_value(original_bytes)
        .ok_or_else(|| AppError::Pdf("original has no startxref".into()))?;

    let mut out = Vec::with_capacity(original_bytes.len() + 512 + rewritten.len() * 256);
    out.extend_from_slice(original_bytes);
    if !out.ends_with(b"\n") {
        out.push(b'\n');
    }

    // Emit each rewritten stream as `N G obj\n<< /Length L >>\nstream\n...`.
    // Dict preserved from the original where possible (copy /Filter,
    // /DecodeParms, etc. from the in-memory doc's stream.dict) — but
    // for simplicity we emit uncompressed here, dropping /Filter, so
    // the new /Length matches the payload directly.
    let mut emitted: Vec<EmittedObject> = Vec::new();
    for (id, bytes) in rewritten {
        let offset = out.len();
        out.extend_from_slice(
            format!(
                "{} {} obj\n<< /Length {} >>\nstream\n",
                id.0,
                id.1,
                bytes.len()
            )
            .as_bytes(),
        );
        out.extend_from_slice(bytes);
        if !bytes.ends_with(b"\n") {
            out.push(b'\n');
        }
        out.extend_from_slice(b"endstream\nendobj\n");
        emitted.push(EmittedObject {
            obj_num: id.0,
            generation: id.1,
            offset,
        });
    }

    // Xref + trailer. Subsections are the free-list head + grouped
    // contiguous runs of the rewritten objects.
    let new_xref_offset = out.len();
    out.extend_from_slice(b"xref\n0 1\n0000000000 65535 f \n");

    emitted.sort_by_key(|e| e.obj_num);
    emitted.dedup_by_key(|e| e.obj_num);
    let mut i = 0;
    while i < emitted.len() {
        let mut j = i;
        while j + 1 < emitted.len() && emitted[j + 1].obj_num == emitted[j].obj_num + 1 {
            j += 1;
        }
        let start = emitted[i].obj_num;
        let count = j - i + 1;
        out.extend_from_slice(format!("{} {}\n", start, count).as_bytes());
        for e in &emitted[i..=j] {
            out.extend_from_slice(format!("{:010} {:05} n \n", e.offset, e.generation).as_bytes());
        }
        i = j + 1;
    }

    out.extend_from_slice(b"trailer\n<<\n");
    // /Size unchanged — we're only superseding existing objects.
    let size = trailer_i64(&doc.trailer, b"Size").unwrap_or(0);
    out.extend_from_slice(format!("  /Size {}\n", size).as_bytes());
    out.extend_from_slice(format!("  /Prev {}\n", prev_xref_offset).as_bytes());
    if let Ok(root) = doc.trailer.get(b"Root") {
        let mut s = String::from("  /Root ");
        write_pdf_object(root, &mut s);
        s.push('\n');
        out.extend_from_slice(s.as_bytes());
    } else {
        return Err(AppError::Pdf("original trailer missing /Root".into()));
    }
    if let Ok(info) = doc.trailer.get(b"Info") {
        let mut s = String::from("  /Info ");
        write_pdf_object(info, &mut s);
        s.push('\n');
        out.extend_from_slice(s.as_bytes());
    }
    if let Ok(id) = doc.trailer.get(b"ID") {
        let mut s = String::from("  /ID ");
        write_pdf_object(id, &mut s);
        s.push('\n');
        out.extend_from_slice(s.as_bytes());
    }
    if let Ok(enc) = doc.trailer.get(b"Encrypt") {
        let mut s = String::from("  /Encrypt ");
        write_pdf_object(enc, &mut s);
        s.push('\n');
        out.extend_from_slice(s.as_bytes());
    }
    out.extend_from_slice(b">>\n");
    out.extend_from_slice(format!("startxref\n{}\n%%EOF\n", new_xref_offset).as_bytes());

    let summary = WriteSummary {
        total_bytes: out.len(),
        appended_bytes: out.len() - original_bytes.len(),
        new_xref_offset,
        previous_xref_offset: prev_xref_offset,
        new_objects_emitted: emitted.len(),
    };
    Ok((out, summary))
}

// ── Helpers ─────────────────────────────────────────────────────────

/// Records a single emitted indirect object's xref coordinates.
#[derive(Debug)]
struct EmittedObject {
    obj_num: u32,
    generation: u16,
    offset: usize,
}

/// Fallback path for sources lopdf 0.32 can't load (xref streams, some
/// signed PDFs with PKCS#11 containers, documents with null-padded
/// trailers, etc). Emits an empty-patches incremental update by
/// copying the original trailer fields from raw bytes. The crucial
/// property we preserve: every byte of `original_bytes` appears
/// verbatim at the start of the output, so digital signatures
/// covering the whole-file byte range stay valid.
///
/// Only empty-patches are supported here — see the caller for why.
fn write_incremental_raw_fallback(
    original_bytes: &[u8],
    prev_xref_offset: usize,
) -> Result<(Vec<u8>, WriteSummary)> {
    let trailer_fields = scan_trailer_fields(original_bytes)?;

    let mut out = Vec::with_capacity(original_bytes.len() + 512);
    out.extend_from_slice(original_bytes);
    if !out.ends_with(b"\n") {
        out.push(b'\n');
    }

    let new_xref_offset = out.len();
    out.extend_from_slice(b"xref\n0 1\n0000000000 65535 f \n");
    out.extend_from_slice(b"trailer\n<<\n");

    // /Size is required. Use the scanned value, or a conservative
    // default. Readers treat /Size as "1 + highest object number
    // across all xrefs" and incremental updates that don't add new
    // objects can leave this unchanged.
    let size = trailer_fields.size.unwrap_or(1);
    out.extend_from_slice(format!("  /Size {}\n", size).as_bytes());
    out.extend_from_slice(format!("  /Prev {}\n", prev_xref_offset).as_bytes());

    // Copy the scanned trailer fields raw — they come straight from
    // the original bytes so any references, hex-strings, dates, etc.
    // are preserved without lossy re-encoding.
    for (key, raw) in &trailer_fields.raw_entries {
        out.extend_from_slice(b"  /");
        out.extend_from_slice(key);
        out.push(b' ');
        out.extend_from_slice(raw);
        out.push(b'\n');
    }
    out.extend_from_slice(b">>\n");
    out.extend_from_slice(format!("startxref\n{}\n%%EOF\n", new_xref_offset).as_bytes());

    let summary = WriteSummary {
        total_bytes: out.len(),
        appended_bytes: out.len() - original_bytes.len(),
        new_xref_offset,
        previous_xref_offset: prev_xref_offset,
        new_objects_emitted: 0,
    };
    Ok((out, summary))
}

/// Fields we want to copy from the original trailer into our
/// incremental update. Values are stored as raw byte slices so we
/// don't lossy-decode structured PDF objects; the writer just emits
/// them verbatim into its own trailer.
#[derive(Debug, Default)]
struct RawTrailerFields {
    /// Parsed integer if /Size was found. We need it typed because
    /// we might want to conservatively bump it on non-empty patches
    /// in the future.
    size: Option<i64>,
    /// Every `(key_name, raw_value_bytes)` pair we care about,
    /// EXCLUDING /Size (emitted separately by the caller so it can
    /// be overridden when new objects are added) and EXCLUDING
    /// /Prev (synthesized to point at the original xref).
    raw_entries: Vec<(Vec<u8>, Vec<u8>)>,
}

/// Scan `bytes` for the trailer dictionary's relevant fields. Handles
/// both classic trailers (`trailer\n<<...>>`) and xref-stream dicts
/// (`N G obj\n<<...>>stream`). Returns the fields we need to emit a
/// spec-valid incremental-update trailer on top.
///
/// Deliberately simple: it only extracts the keys we intend to copy
/// (/Root, /Info, /ID, /Encrypt, /Size). Everything else the
/// original trailer had (e.g. /DocChecksum, custom keys) is not
/// carried forward. Readers walking the /Prev chain still find the
/// original trailer with those keys intact.
fn scan_trailer_fields(bytes: &[u8]) -> Result<RawTrailerFields> {
    // Locate the dict bytes between `<<` and matching `>>` in the
    // region right before `startxref`. PDF trailers sit in the last
    // kilobyte or so; scanning backward from end is cheap.
    let dict_bytes = locate_trailer_dict_bytes(bytes).ok_or_else(|| {
        AppError::Pdf(
            "pdf_engine writer: raw trailer-dict scan could not find \
             a `<<...>>` block near startxref. Source is either \
             truncated or uses an unsupported trailer layout."
                .into(),
        )
    })?;

    let mut fields = RawTrailerFields::default();
    // Only scan for a small, fixed key set. Each key maps to a raw
    // value slice — we don't interpret structure beyond balancing
    // `<<`/`>>`, `[`/`]`, and `(`/`)` nesting.
    for key in [
        b"Root".as_ref(),
        b"Info".as_ref(),
        b"ID".as_ref(),
        b"Encrypt".as_ref(),
    ] {
        if let Some(raw) = extract_field_raw(&dict_bytes, key) {
            fields.raw_entries.push((key.to_vec(), raw));
        }
    }
    if let Some(raw) = extract_field_raw(&dict_bytes, b"Size") {
        // /Size is an integer literal. Parse it so the caller can
        // override with a bumped value when emitting new objects.
        let n: i64 = std::str::from_utf8(&raw)
            .ok()
            .and_then(|s| s.trim().parse().ok())
            .unwrap_or(0);
        if n > 0 {
            fields.size = Some(n);
        }
    }

    Ok(fields)
}

/// Find the byte range of the trailer dictionary `<<...>>` block by
/// searching backward from the end of the buffer. Accepts either:
///   1. Classic `trailer\n<<...>>` (common case)
///   2. XRef-stream `N G obj\n<<...>>stream` (PDF 1.5+)
///
/// The returned slice is JUST the dict payload (content between the
/// opening `<<` and the matching `>>`, exclusive).
fn locate_trailer_dict_bytes(bytes: &[u8]) -> Option<Vec<u8>> {
    // First, find the last "startxref" — our trailer is immediately
    // before it (classic) or the dict at the offset startxref points
    // at (xref-stream).
    let startxref_pos = rfind(bytes, b"startxref")?;

    // Case 1: classic trailer. Scan backward from startxref_pos for
    // "trailer" keyword; if found, the dict follows.
    if let Some(trailer_pos) = bytes[..startxref_pos]
        .windows(7)
        .rposition(|w| w == b"trailer")
    {
        let region = &bytes[trailer_pos + 7..startxref_pos];
        if let Some(inner) = extract_dict_inner(region) {
            return Some(inner.to_vec());
        }
    }

    // Case 2: xref stream. Read the offset after "startxref" and
    // find the object at that offset, then pull its dict.
    let after = &bytes[startxref_pos + b"startxref".len()..];
    let mut i = 0;
    while i < after.len() && matches!(after[i], b' ' | b'\t' | b'\r' | b'\n') {
        i += 1;
    }
    let mut offset: usize = 0;
    let mut any = false;
    while i < after.len() && after[i].is_ascii_digit() {
        offset = offset * 10 + (after[i] - b'0') as usize;
        any = true;
        i += 1;
    }
    if !any || offset >= bytes.len() {
        return None;
    }
    // Look for `obj\n<<...>>` starting at offset. Simple skip past
    // the object header (`N G obj`) to the first `<<`.
    let region = &bytes[offset..];
    if let Some(obj_end) = region.windows(3).position(|w| w == b"obj") {
        let after_obj = &region[obj_end + 3..];
        if let Some(inner) = extract_dict_inner(after_obj) {
            return Some(inner.to_vec());
        }
    }
    None
}

/// Given bytes that start shortly before a `<<...>>` dict (possibly
/// with leading whitespace), return a slice covering just the inside
/// of the first dict found. Properly balances nested dicts + arrays.
fn extract_dict_inner(bytes: &[u8]) -> Option<&[u8]> {
    // Find the opening `<<`.
    let mut i = 0;
    while i + 1 < bytes.len() && !(bytes[i] == b'<' && bytes[i + 1] == b'<') {
        i += 1;
    }
    if i + 1 >= bytes.len() {
        return None;
    }
    let start = i + 2;
    // Walk forward tracking nesting. We only need to balance `<<`/`>>`;
    // `[`/`]` and `(`/`)` don't contain `<<` tokens, so we can treat
    // them opaquely, BUT we have to skip over literal-string content
    // that might contain unescaped `>` bytes as part of text.
    let mut depth = 1usize;
    let mut j = start;
    while j + 1 < bytes.len() && depth > 0 {
        match (bytes[j], bytes[j + 1]) {
            (b'<', b'<') => {
                depth += 1;
                j += 2;
            }
            (b'>', b'>') => {
                depth -= 1;
                if depth == 0 {
                    return Some(&bytes[start..j]);
                }
                j += 2;
            }
            (b'(', _) => {
                // Literal string — skip until unescaped closing `)`,
                // honoring backslash escapes + nested parens.
                j += 1;
                let mut paren_depth = 1usize;
                while j < bytes.len() && paren_depth > 0 {
                    match bytes[j] {
                        b'\\' if j + 1 < bytes.len() => j += 2,
                        b'(' => {
                            paren_depth += 1;
                            j += 1;
                        }
                        b')' => {
                            paren_depth -= 1;
                            j += 1;
                        }
                        _ => j += 1,
                    }
                }
            }
            _ => j += 1,
        }
    }
    None
}

/// Extract the raw bytes of a single `/Key <value>` entry from a dict
/// body (just the inside — no outer `<<`/`>>`). The value is returned
/// without leading whitespace and covers one "atom" (a literal
/// number, reference, name, array, string, or nested dict).
fn extract_field_raw(dict_inner: &[u8], key: &[u8]) -> Option<Vec<u8>> {
    let needle = {
        let mut v = Vec::with_capacity(key.len() + 1);
        v.push(b'/');
        v.extend_from_slice(key);
        v
    };
    let mut i = 0;
    while i + needle.len() <= dict_inner.len() {
        if &dict_inner[i..i + needle.len()] == needle.as_slice() {
            // Ensure what follows is a name separator (space, /, <, [, (, digit, or `>`).
            let after = dict_inner.get(i + needle.len()).copied();
            let separator_ok = match after {
                Some(
                    b' ' | b'\t' | b'\r' | b'\n' | b'/' | b'<' | b'[' | b'(' | b'>' | b'+' | b'-',
                ) => true,
                Some(c) if c.is_ascii_digit() => true,
                _ => false,
            };
            if separator_ok {
                // Skip whitespace, then parse one atom.
                let mut j = i + needle.len();
                while j < dict_inner.len() && matches!(dict_inner[j], b' ' | b'\t' | b'\r' | b'\n')
                {
                    j += 1;
                }
                if let Some(end) = parse_atom_end(dict_inner, j) {
                    return Some(dict_inner[j..end].to_vec());
                }
                return None;
            }
        }
        i += 1;
    }
    None
}

/// Return the byte offset just past the end of a single PDF value
/// starting at `start` in `bytes`. Handles: names (`/Foo`), integers
/// & reals, references (`N G R`), literal strings (`(...)`), hex
/// strings (`<...>`), arrays (`[...]`), and nested dicts (`<<...>>`).
fn parse_atom_end(bytes: &[u8], start: usize) -> Option<usize> {
    if start >= bytes.len() {
        return None;
    }
    match bytes[start] {
        b'[' => {
            let mut depth = 1usize;
            let mut j = start + 1;
            while j < bytes.len() && depth > 0 {
                match bytes[j] {
                    b'[' => {
                        depth += 1;
                        j += 1;
                    }
                    b']' => {
                        depth -= 1;
                        j += 1;
                    }
                    b'(' => {
                        j += 1;
                        let mut p = 1usize;
                        while j < bytes.len() && p > 0 {
                            match bytes[j] {
                                b'\\' if j + 1 < bytes.len() => j += 2,
                                b'(' => {
                                    p += 1;
                                    j += 1;
                                }
                                b')' => {
                                    p -= 1;
                                    j += 1;
                                }
                                _ => j += 1,
                            }
                        }
                    }
                    _ => j += 1,
                }
            }
            Some(j)
        }
        b'<' if bytes.get(start + 1) == Some(&b'<') => {
            // Nested dict.
            let mut depth = 1usize;
            let mut j = start + 2;
            while j + 1 < bytes.len() && depth > 0 {
                match (bytes[j], bytes[j + 1]) {
                    (b'<', b'<') => {
                        depth += 1;
                        j += 2;
                    }
                    (b'>', b'>') => {
                        depth -= 1;
                        j += 2;
                    }
                    _ => j += 1,
                }
            }
            Some(j)
        }
        b'<' => {
            // Hex string.
            let mut j = start + 1;
            while j < bytes.len() && bytes[j] != b'>' {
                j += 1;
            }
            Some((j + 1).min(bytes.len()))
        }
        b'(' => {
            let mut j = start + 1;
            let mut p = 1usize;
            while j < bytes.len() && p > 0 {
                match bytes[j] {
                    b'\\' if j + 1 < bytes.len() => j += 2,
                    b'(' => {
                        p += 1;
                        j += 1;
                    }
                    b')' => {
                        p -= 1;
                        j += 1;
                    }
                    _ => j += 1,
                }
            }
            Some(j)
        }
        b'/' => {
            // Name — runs until whitespace or delimiter.
            let mut j = start + 1;
            while j < bytes.len() && !is_delimiter_or_ws(bytes[j]) {
                j += 1;
            }
            Some(j)
        }
        c if c.is_ascii_digit() || c == b'+' || c == b'-' || c == b'.' => {
            // Number, possibly followed by `G R` for an indirect ref.
            // Read the first token.
            let mut j = start;
            while j < bytes.len()
                && (bytes[j].is_ascii_digit() || matches!(bytes[j], b'+' | b'-' | b'.'))
            {
                j += 1;
            }
            // Peek ahead for the ref pattern: ws DIGITS ws 'R'.
            let mut k = j;
            while k < bytes.len() && matches!(bytes[k], b' ' | b'\t') {
                k += 1;
            }
            let gen_start = k;
            while k < bytes.len() && bytes[k].is_ascii_digit() {
                k += 1;
            }
            let gen_end = k;
            while k < bytes.len() && matches!(bytes[k], b' ' | b'\t') {
                k += 1;
            }
            if gen_end > gen_start && bytes.get(k) == Some(&b'R') {
                Some(k + 1)
            } else {
                Some(j)
            }
        }
        _ => Some(start + 1),
    }
}

fn is_delimiter_or_ws(b: u8) -> bool {
    matches!(
        b,
        b' ' | b'\t' | b'\r' | b'\n' | b'/' | b'<' | b'>' | b'[' | b']' | b'(' | b')' | b'{' | b'}'
    )
}

fn rfind(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.len() > haystack.len() {
        return None;
    }
    haystack.windows(needle.len()).rposition(|w| w == needle)
}

/// Emit `N G obj\n<< /Length L >>\nstream\n<bytes>\nendstream\nendobj\n`.
fn emit_stream_object(out: &mut Vec<u8>, obj_num: u32, stream_bytes: &[u8]) {
    out.extend_from_slice(
        format!(
            "{} 0 obj\n<< /Length {} >>\nstream\n",
            obj_num,
            stream_bytes.len()
        )
        .as_bytes(),
    );
    out.extend_from_slice(stream_bytes);
    if !stream_bytes.ends_with(b"\n") {
        out.push(b'\n');
    }
    out.extend_from_slice(b"endstream\nendobj\n");
}

/// Emit a stream object whose body has been Flate-compressed. The
/// dict gets `/Filter /FlateDecode` so readers know to inflate. Real-
/// world PDF content streams are almost always compressed; this is
/// the production path for overlays emitted by `bake_edit_model`.
///
/// Errors if flate2's encoder fails (only on allocation issues in
/// practice — the algorithm itself can't fail on valid input).
/// Standalone Flate compressor — used by `emit_flate_stream_object`
/// AND by G2's `emit_embedded_font_chain` (which needs the compressed
/// bytes separately so it can write its own stream-dict prefix with
/// /Length1 = uncompressed size for the FontFile2 object).
fn flate_compress(bytes: &[u8]) -> std::io::Result<Vec<u8>> {
    use flate2::write::ZlibEncoder;
    use flate2::Compression;
    use std::io::Write;
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(bytes)?;
    encoder.finish()
}

fn emit_flate_stream_object(out: &mut Vec<u8>, obj_num: u32, stream_bytes: &[u8]) -> Result<()> {
    let compressed = flate_compress(stream_bytes)
        .map_err(|e| AppError::Pdf(format!("flate encode overlay: {e}")))?;

    out.extend_from_slice(
        format!(
            "{} 0 obj\n<< /Length {} /Filter /FlateDecode >>\nstream\n",
            obj_num,
            compressed.len()
        )
        .as_bytes(),
    );
    out.extend_from_slice(&compressed);
    if !compressed.ends_with(b"\n") {
        out.push(b'\n');
    }
    out.extend_from_slice(b"endstream\nendobj\n");
    Ok(())
}

/// Emit `N G obj\n<< ... >>\nendobj\n` for a Dictionary object.
fn emit_dict_object(out: &mut Vec<u8>, obj_num: u32, gen: u16, dict: &Dictionary) {
    out.extend_from_slice(format!("{} {} obj\n", obj_num, gen).as_bytes());
    let mut s = String::new();
    write_pdf_object(&Object::Dictionary(dict.clone()), &mut s);
    out.extend_from_slice(s.as_bytes());
    out.extend_from_slice(b"\nendobj\n");
}

/// Emit a Type1 Helvetica font object. Helvetica is a Standard 14
/// PDF font — readers have it built in, so no font-program bytes
/// need to be embedded. Encoding is WinAnsiEncoding (Latin-1
/// superset), which matches what the overlay stream writes with
/// `(text) Tj` operators for ASCII + common Western characters.
/// Emit a Type1 Standard 14 font object. The `basefont` arg is the
/// PostScript name as it must appear in `/BaseFont` — e.g. `Helvetica`,
/// `Helvetica-Bold`, `Times-Italic`, `Courier-BoldOblique`. PDF readers
/// recognize all 14 names and ship the corresponding glyph metrics +
/// renderings, so no font bytes need to be embedded. WinAnsiEncoding
/// is hardcoded; CJK/Arabic edits route through the pd-lib bake path.
fn emit_type1_font_object(out: &mut Vec<u8>, obj_num: u32, basefont: &str) {
    out.extend_from_slice(
        format!(
            "{} 0 obj\n\
             << /Type /Font /Subtype /Type1 \
             /BaseFont /{} \
             /Encoding /WinAnsiEncoding >>\nendobj\n",
            obj_num, basefont
        )
        .as_bytes(),
    );
}

/// G2: emit the four-object embedded TrueType font chain.
///
/// Output object layout (all sequentially allocated from `next_new_id`):
///
///   N+0: /FontFile2 stream (the TTF bytes, FlateDecode-compressed
///        with /Length1 = uncompressed size)
///   N+1: /FontDescriptor — metrics derived from the TTF tables
///        (head, hhea, OS/2) plus a reference to N+0
///   N+2: /CIDFontType2 — descendant CID font, /CIDToGIDMap /Identity,
///        /W width array, /FontDescriptor → N+1
///   N+3: /Type0 — public-facing font object, /Encoding /Identity-H,
///        /DescendantFonts → [N+2], /BaseFont matches the
///        FontDescriptor /FontName
///
/// Returns:
///   - `(N+3, 0)` — the Type0 object's xref id, which goes on the
///     page's /Resources /Font /<resource_name> entry.
///   - `Vec<EmittedObject>` — all four newly-emitted objects so the
///     caller appends them to its xref tracker.
///
/// On TTF parse failure, returns Err — caller should skip emission
/// of this font and let the overlay fall back. Frontend should have
/// validated the bytes via `font_subset` before reaching here.
fn emit_embedded_font_chain(
    out: &mut Vec<u8>,
    next_new_id: &mut u32,
    payload: &EmbeddedFontPayload,
) -> Result<((u32, u16), Vec<EmittedObject>)> {
    use ttf_parser::Face;

    let face = Face::parse(&payload.bytes, 0)
        .map_err(|e| AppError::Pdf(format!("embedded-font: parse TTF: {e}")))?;

    let units_per_em = face.units_per_em() as f32;
    if units_per_em <= 0.0 {
        return Err(AppError::Pdf(
            "embedded-font: TTF has zero units_per_em".into(),
        ));
    }
    let scale = 1000.0 / units_per_em;
    let bbox = face.global_bounding_box();
    let ascent = (face.ascender() as f32 * scale).round() as i32;
    let descent = (face.descender() as f32 * scale).round() as i32;
    let cap_height = face
        .capital_height()
        .map(|h| (h as f32 * scale).round() as i32)
        .unwrap_or(ascent);
    let x_height = face
        .x_height()
        .map(|h| (h as f32 * scale).round() as i32)
        .unwrap_or((ascent as f32 * 0.5).round() as i32);
    let italic_angle = face.italic_angle() as f32;
    let bbox_ll_x = (bbox.x_min as f32 * scale).round() as i32;
    let bbox_ll_y = (bbox.y_min as f32 * scale).round() as i32;
    let bbox_ur_x = (bbox.x_max as f32 * scale).round() as i32;
    let bbox_ur_y = (bbox.y_max as f32 * scale).round() as i32;

    // /Flags per PDF 32000-1 Table 123:
    //   bit 1 (0x0001): FixedPitch — set if monospace
    //   bit 6 (0x0020): Symbolic — non-Standard glyph set; set for
    //                   any embedded font that isn't Standard 14
    //                   per Adobe convention (avoids forcing the
    //                   reader to apply /Encoding semantics).
    //   bit 7 (0x0040): Italic — set when payload says so
    //   bit 18 (0x40000): ForceBold — set when payload says bold
    let mut flags: u32 = 0x0020; // Symbolic — embedded custom font
    if face.is_monospaced() {
        flags |= 0x0001;
    }
    if payload.italic || italic_angle.abs() > 0.5 {
        flags |= 0x0040;
    }
    if payload.bold {
        flags |= 0x40000;
    }

    // StemV is required by the spec but no TTF table exposes it
    // directly. Adobe's typical heuristic: regular ≈ 80, bold ≈ 140.
    // Acrobat tolerates approximate values; pdfjs / Foxit ignore it
    // entirely for rendering. We use 80 / 140 as a reasonable proxy.
    let stem_v = if payload.bold { 140 } else { 80 };

    // Build the /W width array — Identity-H means CID = glyph index,
    // so we walk every glyph in the face and emit its hmtx advance.
    // Format: [start_cid [w1 w2 ... wN]] groups; we use a single
    // group `[0 [w0 w1 w2 ...]]` for simplicity (compact, valid).
    let num_glyphs = face.number_of_glyphs() as u32;
    let mut widths: Vec<u32> = Vec::with_capacity(num_glyphs as usize);
    for gid in 0..num_glyphs {
        let g = ttf_parser::GlyphId(gid as u16);
        let advance = face
            .glyph_hor_advance(g)
            .map(|a| (a as f32 * scale).round() as u32)
            .unwrap_or(0);
        widths.push(advance);
    }

    // Subset prefix per PDF spec §9.6.4 (Embedded Font Programs):
    // "the value of BaseFont in both the font and the descendant
    // CIDFont is the same and is prefixed with a tag of six
    // uppercase letters followed by a + sign (e.g. EOODIA+...)".
    // If the caller already prefixed, use as-is.
    let basefont = if payload
        .postscript_name
        .as_bytes()
        .iter()
        .take(7)
        .enumerate()
        .all(|(i, b)| {
            if i == 6 {
                *b == b'+'
            } else {
                b.is_ascii_uppercase()
            }
        }) {
        payload.postscript_name.clone()
    } else {
        format!("AAAAAA+{}", payload.postscript_name)
    };

    // Reserve four object numbers up front.
    let fontfile_num = *next_new_id;
    let descriptor_num = *next_new_id + 1;
    let cidfont_num = *next_new_id + 2;
    let type0_num = *next_new_id + 3;
    *next_new_id += 4;

    let mut emitted = Vec::with_capacity(4);

    // ── 1. /FontFile2 stream (compressed TTF bytes) ──────────────
    let length1 = payload.bytes.len();
    let fontfile_offset = out.len();
    let compressed = flate_compress(&payload.bytes)
        .map_err(|e| AppError::Pdf(format!("embedded-font: flate compress: {e}")))?;
    out.extend_from_slice(
        format!(
            "{} 0 obj\n<< /Length {} /Length1 {} /Filter /FlateDecode >>\nstream\n",
            fontfile_num,
            compressed.len(),
            length1,
        )
        .as_bytes(),
    );
    out.extend_from_slice(&compressed);
    out.extend_from_slice(b"\nendstream\nendobj\n");
    emitted.push(EmittedObject {
        obj_num: fontfile_num,
        generation: 0,
        offset: fontfile_offset,
    });

    // ── 2. /FontDescriptor ───────────────────────────────────────
    let descriptor_offset = out.len();
    out.extend_from_slice(
        format!(
            "{} 0 obj\n\
             << /Type /FontDescriptor \
             /FontName /{} \
             /Flags {} \
             /FontBBox [{} {} {} {}] \
             /ItalicAngle {} \
             /Ascent {} \
             /Descent {} \
             /CapHeight {} \
             /XHeight {} \
             /StemV {} \
             /MissingWidth 500 \
             /FontFile2 {} 0 R >>\nendobj\n",
            descriptor_num,
            basefont,
            flags,
            bbox_ll_x,
            bbox_ll_y,
            bbox_ur_x,
            bbox_ur_y,
            italic_angle,
            ascent,
            descent,
            cap_height,
            x_height,
            stem_v,
            fontfile_num,
        )
        .as_bytes(),
    );
    emitted.push(EmittedObject {
        obj_num: descriptor_num,
        generation: 0,
        offset: descriptor_offset,
    });

    // ── 3. /CIDFontType2 ────────────────────────────────────────
    // Build the /W width array: `[0 [w0 w1 w2 ...]]`. PDF spec §9.7.4.3.
    let mut w_string = String::with_capacity(num_glyphs as usize * 5 + 8);
    w_string.push_str("[ 0 [");
    for w in &widths {
        w_string.push_str(&w.to_string());
        w_string.push(' ');
    }
    w_string.push_str("] ]");
    let cidfont_offset = out.len();
    out.extend_from_slice(
        format!(
            "{} 0 obj\n\
             << /Type /Font /Subtype /CIDFontType2 \
             /BaseFont /{} \
             /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> \
             /FontDescriptor {} 0 R \
             /CIDToGIDMap /Identity \
             /DW 500 \
             /W {} >>\nendobj\n",
            cidfont_num, basefont, descriptor_num, w_string,
        )
        .as_bytes(),
    );
    emitted.push(EmittedObject {
        obj_num: cidfont_num,
        generation: 0,
        offset: cidfont_offset,
    });

    // ── 4. /Type0 (public-facing font) ───────────────────────────
    let type0_offset = out.len();
    out.extend_from_slice(
        format!(
            "{} 0 obj\n\
             << /Type /Font /Subtype /Type0 \
             /BaseFont /{} \
             /Encoding /Identity-H \
             /DescendantFonts [{} 0 R] >>\nendobj\n",
            type0_num, basefont, cidfont_num,
        )
        .as_bytes(),
    );
    emitted.push(EmittedObject {
        obj_num: type0_num,
        generation: 0,
        offset: type0_offset,
    });

    Ok(((type0_num, 0), emitted))
}

/// Produce a copy of `page_dict` with the given `font_name -> font_ref`
/// entry merged into `/Resources /Font`. Handles the two common
/// shapes for the `/Resources` value:
///
/// 1. **Inline dict on the page** — clone it, modify its `/Font`
///    sub-dict, re-emit inline.
/// 2. **Indirect reference** — follow the reference via lopdf,
///    clone the referenced dict, inline it on the page with our
///    font added.
///
/// Case 2 loses any sharing with other pages that referenced the
/// same Resources object, but the original reference is left in
/// the original xref so other pages are unaffected (they resolve
/// via the /Prev chain). Only the page we're editing gets an
/// inlined Resources copy.
///
/// If the page has no `/Resources` at all (resources are inherited
/// from an ancestor /Pages node), we still add an inline
/// `/Resources << /Font << ... >> >>` — that loses inheritance for
/// this page. That's a known limitation of P2; real PDFs almost
/// always have per-page Resources or a directly-referenced dict.
fn merge_font_into_resources(
    page_dict: Dictionary,
    doc: &Document,
    page_id: ObjectId,
    font_name: &str,
    font_ref: (u32, u16),
) -> Dictionary {
    let mut new_dict = page_dict;

    // Start with a fresh Resources dict that we'll populate.
    let mut resources_dict: Dictionary = match new_dict.get(b"Resources") {
        Ok(Object::Dictionary(d)) => d.clone(),
        Ok(Object::Reference(id)) => {
            // Dereference; if it resolves to a dict, clone it.
            match doc.get_dictionary(*id) {
                Ok(d) => d.clone(),
                Err(_) => Dictionary::new(),
            }
        }
        _ => {
            // No per-page Resources or reference we can't follow.
            // Walk up the Pages tree for inherited Resources and
            // clone whatever we find. Covers the inheritance case
            // without us needing to understand the full tree shape.
            inherited_resources(doc, page_id).unwrap_or_default()
        }
    };

    // Merge our font into the /Font sub-dict, preserving any
    // existing entries.
    let mut font_dict: Dictionary = match resources_dict.get(b"Font") {
        Ok(Object::Dictionary(d)) => d.clone(),
        Ok(Object::Reference(id)) => match doc.get_dictionary(*id) {
            Ok(d) => d.clone(),
            Err(_) => Dictionary::new(),
        },
        _ => Dictionary::new(),
    };
    font_dict.set(font_name.as_bytes().to_vec(), Object::Reference(font_ref));
    resources_dict.set(b"Font".to_vec(), Object::Dictionary(font_dict));
    new_dict.set(b"Resources".to_vec(), Object::Dictionary(resources_dict));
    new_dict
}

/// Walk up the /Pages tree starting at `page_id` to find the nearest
/// inherited /Resources dict. Returns a clone of that dict, or
/// `None` if no ancestor has /Resources.
fn inherited_resources(doc: &Document, page_id: ObjectId) -> Option<Dictionary> {
    let mut cur_id = page_id;
    // Guard against malformed docs with cyclic /Parent references.
    for _ in 0..16 {
        let dict = doc.get_dictionary(cur_id).ok()?;
        if let Ok(Object::Dictionary(d)) = dict.get(b"Resources") {
            return Some(d.clone());
        }
        if let Ok(Object::Reference(id)) = dict.get(b"Resources") {
            if let Ok(d) = doc.get_dictionary(*id) {
                return Some(d.clone());
            }
        }
        match dict.get(b"Parent") {
            Ok(Object::Reference(parent_id)) => cur_id = *parent_id,
            _ => return None,
        }
    }
    None
}

/// Produce a copy of `page_dict` with the given overlay-stream
/// reference appended to its `/Contents` value. Handles all three
/// legal /Contents shapes: single reference, array of references,
/// and missing (spec-legal for empty pages).
fn clone_with_appended_contents(page_dict: &Dictionary, overlay_ref: (u32, u16)) -> Dictionary {
    let mut new_dict = page_dict.clone();
    let new_contents: Vec<Object> = match page_dict.get(b"Contents") {
        Ok(Object::Reference(id)) => {
            vec![Object::Reference(*id), Object::Reference(overlay_ref)]
        }
        Ok(Object::Array(arr)) => {
            let mut v = arr.clone();
            v.push(Object::Reference(overlay_ref));
            v
        }
        _ => vec![Object::Reference(overlay_ref)],
    };
    new_dict.set(b"Contents".to_vec(), Object::Array(new_contents));
    new_dict
}

/// Pull an integer out of a trailer dict by key. Returns `None` if
/// the key is missing or the value isn't an integer.
fn trailer_i64(trailer: &Dictionary, key: &[u8]) -> Option<i64> {
    trailer.get(key).ok().and_then(|o| o.as_i64().ok())
}

/// Scan `bytes` from the end for the last `startxref` line and return
/// the byte offset that follows it. PDF spec allows multiple xref
/// sections; we want the most recent one (furthest from file start)
/// since that's what the /Prev chain extends from.
fn find_last_startxref_value(bytes: &[u8]) -> Option<usize> {
    let needle = b"startxref";
    let mut pos = bytes.len();
    // Scan backward in chunks to avoid O(n²). The last occurrence is
    // normally within the final 100 bytes anyway.
    while pos > 0 {
        let start = pos.saturating_sub(256);
        let slice = &bytes[start..pos];
        if let Some(idx) = slice.windows(needle.len()).rposition(|w| w == needle) {
            // idx is relative to slice start; convert to absolute.
            let abs_idx = start + idx + needle.len();
            // Skip whitespace after "startxref".
            let mut i = abs_idx;
            while i < bytes.len() && matches!(bytes[i], b' ' | b'\t' | b'\r' | b'\n') {
                i += 1;
            }
            // Parse ASCII number.
            let mut n: usize = 0;
            let mut seen_digit = false;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                n = n * 10 + (bytes[i] - b'0') as usize;
                seen_digit = true;
                i += 1;
            }
            return if seen_digit { Some(n) } else { None };
        }
        if start == 0 {
            break;
        }
        pos = start + needle.len(); // overlap window so we don't miss across chunk boundary
    }
    None
}

/// Serialize a [`lopdf::Object`] into PDF syntax suitable for the
/// trailer dict. Covers all object types that legitimately appear in
/// trailers: Integer, Reference, Name, String (literal + hex), Array,
/// nested Dictionary, Boolean, Null. Streams are invalid in trailers
/// and fall through to a safe stringification.
fn write_pdf_object(obj: &Object, out: &mut String) {
    match obj {
        Object::Null => out.push_str("null"),
        Object::Boolean(b) => out.push_str(if *b { "true" } else { "false" }),
        Object::Integer(n) => out.push_str(&n.to_string()),
        Object::Real(r) => {
            // PDF reals shouldn't use exponential notation.
            let s = format!("{:.6}", r);
            // Trim trailing zeros but keep at least one digit after "."
            let s = s.trim_end_matches('0').trim_end_matches('.');
            out.push_str(if s.is_empty() { "0" } else { s });
        }
        Object::Name(bytes) => {
            out.push('/');
            for &b in bytes {
                // Per PDF spec §7.3.5: # escape for chars outside the
                // regular name characters.
                if b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b'+' | b',') {
                    out.push(b as char);
                } else {
                    out.push_str(&format!("#{:02X}", b));
                }
            }
        }
        Object::String(bytes, StringFormat::Literal) => {
            out.push('(');
            for &b in bytes {
                match b {
                    b'(' | b')' | b'\\' => {
                        out.push('\\');
                        out.push(b as char);
                    }
                    b'\n' => out.push_str("\\n"),
                    b'\r' => out.push_str("\\r"),
                    b'\t' => out.push_str("\\t"),
                    b'\x08' => out.push_str("\\b"),
                    b'\x0c' => out.push_str("\\f"),
                    _ if b >= 0x20 && b < 0x7f => out.push(b as char),
                    _ => out.push_str(&format!("\\{:03o}", b)),
                }
            }
            out.push(')');
        }
        Object::String(bytes, StringFormat::Hexadecimal) => {
            out.push('<');
            for &b in bytes {
                out.push_str(&format!("{:02X}", b));
            }
            out.push('>');
        }
        Object::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(' ');
                }
                write_pdf_object(item, out);
            }
            out.push(']');
        }
        Object::Dictionary(d) => {
            out.push_str("<<");
            for (k, v) in d.iter() {
                out.push(' ');
                out.push('/');
                for &b in k.iter() {
                    if b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b'+' | b',') {
                        out.push(b as char);
                    } else {
                        out.push_str(&format!("#{:02X}", b));
                    }
                }
                out.push(' ');
                write_pdf_object(v, out);
            }
            out.push_str(" >>");
        }
        Object::Reference((num, gen)) => {
            out.push_str(&format!("{} {} R", num, gen));
        }
        Object::Stream(_) => {
            // Shouldn't appear in a trailer. Emit a null to avoid
            // producing invalid bytes if it ever does.
            out.push_str("null");
        }
    }
}

// ── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal hand-crafted PDF for round-trip testing. Has a catalog,
    /// one blank page, and a real xref. Under 400 bytes so test-case
    /// bytes stay inline.
    fn minimal_pdf() -> Vec<u8> {
        // Offsets are computed by hand; keep this in sync if you edit.
        // Object 1: catalog -> pages obj 2
        // Object 2: pages node with one kid, obj 3
        // Object 3: blank page
        let body = b"%PDF-1.4\n\
1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n\
2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n\
3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n";
        let mut pdf = body.to_vec();
        let xref_start = pdf.len();
        // Each xref entry: 10-digit offset, space, 5-digit generation,
        // space, marker (n=in-use, f=free), space+newline (20 bytes).
        // We need offsets of objects 1, 2, 3 in the body.
        let obj1_offset = find_obj_offset(&pdf, b"\n1 0 obj\n").unwrap() + 1;
        let obj2_offset = find_obj_offset(&pdf, b"\n2 0 obj\n").unwrap() + 1;
        let obj3_offset = find_obj_offset(&pdf, b"\n3 0 obj\n").unwrap() + 1;
        pdf.extend_from_slice(b"xref\n0 4\n");
        pdf.extend_from_slice(b"0000000000 65535 f \n");
        pdf.extend_from_slice(format!("{:010} 00000 n \n", obj1_offset).as_bytes());
        pdf.extend_from_slice(format!("{:010} 00000 n \n", obj2_offset).as_bytes());
        pdf.extend_from_slice(format!("{:010} 00000 n \n", obj3_offset).as_bytes());
        pdf.extend_from_slice(b"trailer\n<< /Size 4 /Root 1 0 R /ID [<d0d0d0> <d0d0d0>] >>\n");
        pdf.extend_from_slice(format!("startxref\n{}\n%%EOF\n", xref_start).as_bytes());
        pdf
    }

    fn find_obj_offset(bytes: &[u8], needle: &[u8]) -> Option<usize> {
        bytes.windows(needle.len()).position(|w| w == needle)
    }

    #[test]
    fn empty_patches_produce_valid_increment() {
        let pdf = minimal_pdf();
        let original_len = pdf.len();
        let (out, summary) = write_incremental(&pdf, &[]).expect("write succeeded");

        // Original bytes preserved verbatim at the start of output.
        assert_eq!(
            &out[..original_len],
            pdf.as_slice(),
            "original bytes must not be touched",
        );

        // Summary fields are self-consistent.
        assert_eq!(summary.total_bytes, out.len());
        assert_eq!(summary.appended_bytes, out.len() - original_len);
        assert!(
            summary.appended_bytes > 0,
            "must emit at least xref+trailer+startxref"
        );
        assert!(summary.new_xref_offset >= original_len);
        assert_eq!(summary.new_objects_emitted, 0);

        // Output ends with an %%EOF line.
        assert!(
            out.ends_with(b"%%EOF\n"),
            "output must end with %%EOF (got: {:?})",
            std::str::from_utf8(&out[out.len().saturating_sub(24)..]).unwrap_or("<non-utf8>"),
        );

        // The new xref section contains at least the free-list head.
        let out_str = std::str::from_utf8(&out).expect("ascii-only output");
        assert!(out_str.contains("xref\n0 1\n0000000000 65535 f"));

        // /Prev pointer references the original startxref value.
        let orig_str = std::str::from_utf8(&pdf).expect("minimal pdf is ascii");
        let orig_startxref_line = orig_str.rfind("startxref\n").unwrap();
        let orig_xref_offset: usize = orig_str[orig_startxref_line + "startxref\n".len()..]
            .split('\n')
            .next()
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert_eq!(summary.previous_xref_offset, orig_xref_offset);
        assert!(out_str.contains(&format!("/Prev {}", orig_xref_offset)));

        // /Root reference copied (minimal pdf uses 1 0 R).
        assert!(out_str.contains("/Root 1 0 R"));
    }

    #[test]
    fn roundtrip_parses_with_lopdf() {
        let pdf = minimal_pdf();
        let (out, _) = write_incremental(&pdf, &[]).expect("write succeeded");

        // Output must parse cleanly with lopdf — this is the first
        // "is it a valid PDF?" check before we run veraPDF.
        let mut cursor = Cursor::new(&out);
        let doc = Document::load_from(&mut cursor).expect("lopdf parses output");
        // /Size unchanged (still 4 objects).
        let size = doc.trailer.get(b"Size").unwrap().as_i64().unwrap();
        assert_eq!(size, 4);
    }

    #[test]
    fn overlay_patch_emits_two_new_objects() {
        let pdf = minimal_pdf();
        let original_len = pdf.len();
        let overlay = b"q 0.9 0.9 0.9 rg 10 10 100 20 re f Q\n".to_vec();
        let patch = IncrementalPatch {
            page_index: 0,
            overlay_stream: overlay.clone(),
            inject_helvetica_font_as: None,
            inject_standard14_fonts: Default::default(),
            inject_embedded_fonts: Default::default(),
            compress_overlay: false,
            removed_object_ids: vec![],
        };
        let (out, summary) =
            write_incremental(&pdf, std::slice::from_ref(&patch)).expect("write succeeded");

        // Original bytes preserved verbatim.
        assert_eq!(&out[..original_len], pdf.as_slice());
        // Emitted: overlay stream (obj 4) + superseded page dict (obj 3).
        assert_eq!(summary.new_objects_emitted, 2);
        // /Size bumps to max_new + 1 = 4 + 1 = 5.
        let out_str = std::str::from_utf8(&out).expect("ascii-only output");
        assert!(out_str.contains("/Size 5"));
        // New xref has subsections: free-list (0 1), then a contiguous
        // range covering the superseded page dict (obj 3) + new overlay
        // (obj 4). Our grouping collapses adjacent obj numbers into a
        // single subsection header, so "3 2" covers both.
        assert!(
            out_str.contains("3 2\n"),
            "expected combined xref subsection header '3 2' for obj 3 + obj 4"
        );
        // Page dict re-emitted with /Contents array referencing obj 4.
        assert!(
            out_str.contains("/Contents [ 4 0 R ]") || out_str.contains("/Contents [4 0 R]"),
            "page dict should point at overlay object\noutput tail: {}",
            &out_str[out_str.len().saturating_sub(600)..]
        );
        // Overlay bytes appear verbatim inside a stream object.
        let overlay_str = std::str::from_utf8(&overlay).unwrap();
        assert!(
            out_str.contains(overlay_str),
            "overlay bytes must be in output"
        );
    }

    #[test]
    fn overlay_patch_output_parses_with_lopdf() {
        let pdf = minimal_pdf();
        let patch = IncrementalPatch {
            page_index: 0,
            overlay_stream: b"q 1 0 0 rg 0 0 10 10 re f Q\n".to_vec(),
            inject_helvetica_font_as: None,
            inject_standard14_fonts: Default::default(),
            inject_embedded_fonts: Default::default(),
            compress_overlay: false,
            removed_object_ids: vec![],
        };
        let (out, _) = write_incremental(&pdf, std::slice::from_ref(&patch)).expect("write");

        let mut cursor = Cursor::new(&out);
        let doc = Document::load_from(&mut cursor).expect("lopdf parses output");
        // Page 1 (1-indexed in lopdf) should now have Contents that is
        // an array of two refs: original (none pre-existing in this
        // fixture) … well, minimal_pdf has no original Contents, so
        // the array has exactly one entry — the new overlay.
        let pages = doc.get_pages();
        let page_id = *pages.get(&1).expect("has page 1");
        let page_dict = doc.get_dictionary(page_id).expect("page dict");
        let contents = page_dict.get(b"Contents").expect("has Contents");
        match contents {
            Object::Array(arr) => assert!(!arr.is_empty(), "Contents must be non-empty"),
            other => panic!("expected Contents to be an array, got {other:?}"),
        }
    }

    #[test]
    fn removed_object_ids_rejected_in_p1() {
        let pdf = minimal_pdf();
        let patch = IncrementalPatch {
            page_index: 0,
            overlay_stream: b"q Q\n".to_vec(),
            inject_helvetica_font_as: None,
            inject_standard14_fonts: Default::default(),
            inject_embedded_fonts: Default::default(),
            compress_overlay: false,
            removed_object_ids: vec![(5, 0)],
        };
        let err = write_incremental(&pdf, std::slice::from_ref(&patch))
            .expect_err("writer must still reject removed_object_ids");
        assert!(err.to_string().contains("S5.5-P2"));
    }

    #[test]
    fn helvetica_injection_adds_font_object_and_resources_entry() {
        let pdf = minimal_pdf();
        let patch = IncrementalPatch {
            page_index: 0,
            overlay_stream: b"q BT /Ovl0 12 Tf 100 720 Td (Hi) Tj ET Q\n".to_vec(),
            inject_helvetica_font_as: Some("Ovl0".into()),
            inject_standard14_fonts: Default::default(),
            inject_embedded_fonts: Default::default(),
            compress_overlay: false,
            removed_object_ids: vec![],
        };
        let (out, summary) = write_incremental(&pdf, std::slice::from_ref(&patch)).expect("write");

        // Three new objects: overlay stream, Helvetica font, page dict.
        assert_eq!(summary.new_objects_emitted, 3);

        let out_str = std::str::from_utf8(&out).expect("ascii");
        // Helvetica font object signature.
        assert!(
            out_str.contains("/BaseFont /Helvetica"),
            "Type1 Helvetica must be emitted"
        );
        assert!(out_str.contains("/Encoding /WinAnsiEncoding"));
        // Page dict's Resources must reference the font under the
        // requested name (/Ovl0). Exact object number depends on
        // allocation order, so we just check the name appears as a
        // key in a Font sub-dict somewhere.
        assert!(
            out_str.contains("/Ovl0 "),
            "page Resources must reference /Ovl0\noutput tail: {}",
            &out_str[out_str.len().saturating_sub(400)..]
        );

        // Parses cleanly with lopdf and the font is reachable through
        // /Resources /Font.
        let mut cursor = Cursor::new(&out);
        let doc = Document::load_from(&mut cursor).expect("lopdf parses");
        let pages = doc.get_pages();
        let page_id = *pages.get(&1).expect("page 1");
        let page_dict = doc.get_dictionary(page_id).expect("page dict");
        // Resources is either an inline dict or an indirect ref;
        // either way we can walk to /Font.
        let resources = match page_dict.get(b"Resources") {
            Ok(Object::Dictionary(d)) => d.clone(),
            Ok(Object::Reference(id)) => doc.get_dictionary(*id).expect("resources").clone(),
            other => panic!("unexpected Resources shape: {other:?}"),
        };
        let font = match resources.get(b"Font") {
            Ok(Object::Dictionary(d)) => d.clone(),
            Ok(Object::Reference(id)) => doc.get_dictionary(*id).expect("font dict").clone(),
            other => panic!("unexpected Font shape: {other:?}"),
        };
        let ovl0 = font.get(b"Ovl0").expect("/Ovl0 entry present");
        let font_ref = match ovl0 {
            Object::Reference(id) => *id,
            other => panic!("expected indirect ref, got {other:?}"),
        };
        let font_obj = doc.get_dictionary(font_ref).expect("font obj resolves");
        assert_eq!(
            font_obj.get(b"Subtype").and_then(|o| o.as_name()).ok(),
            Some(b"Type1".as_ref())
        );
        assert_eq!(
            font_obj.get(b"BaseFont").and_then(|o| o.as_name()).ok(),
            Some(b"Helvetica".as_ref())
        );
    }

    #[test]
    fn find_startxref_parses_number() {
        let bytes = b"...pdf bytes...\nstartxref\n12345\n%%EOF\n";
        let offset = find_last_startxref_value(bytes).unwrap();
        assert_eq!(offset, 12345);
    }

    #[test]
    fn find_startxref_returns_last_occurrence() {
        // Two startxrefs: older at 100, newer at 250 (as would happen
        // after an incremental update chain). We want the newer one.
        let bytes = b"...\nstartxref\n100\n%%EOF\n...\nstartxref\n250\n%%EOF\n";
        let offset = find_last_startxref_value(bytes).unwrap();
        assert_eq!(offset, 250);
    }

    #[test]
    fn scan_trailer_extracts_classic_fields() {
        // Fake trailer block that mimics the signed-pkcs11 fixture.
        let bytes = b"%PDF-1.7\n...body bytes...\nxref\n0 4\n\
0000000000 65535 f \n0000000010 00000 n \n\
trailer\n<<\n/Size 59\n/Root 2 0 R\n/Info 3 0 R\n/ID [<abc> <def>]\n>>\n\
startxref\n30\n%%EOF\n";
        let fields = scan_trailer_fields(bytes).expect("scan");
        assert_eq!(fields.size, Some(59));
        let keys: Vec<&[u8]> = fields
            .raw_entries
            .iter()
            .map(|(k, _)| k.as_slice())
            .collect();
        assert!(keys.contains(&b"Root".as_ref()));
        assert!(keys.contains(&b"Info".as_ref()));
        assert!(keys.contains(&b"ID".as_ref()));

        let root = fields
            .raw_entries
            .iter()
            .find(|(k, _)| k == b"Root")
            .map(|(_, v)| std::str::from_utf8(v).unwrap().trim())
            .unwrap();
        assert_eq!(root, "2 0 R");

        let id = fields
            .raw_entries
            .iter()
            .find(|(k, _)| k == b"ID")
            .map(|(_, v)| std::str::from_utf8(v).unwrap().trim())
            .unwrap();
        assert_eq!(id, "[<abc> <def>]");
    }

    #[test]
    fn fallback_round_trip_with_null_padded_trailer() {
        // The signed-pkcs11 fixture ends with null bytes after %%EOF,
        // which trips lopdf's trailer parser. The fallback path
        // should handle it.
        let mut pdf = b"%PDF-1.7\n\
1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n\
2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n\
3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n"
            .to_vec();
        let xref_start = pdf.len();
        let obj1 = find_obj_offset(&pdf, b"\n1 0 obj\n").unwrap() + 1;
        let obj2 = find_obj_offset(&pdf, b"\n2 0 obj\n").unwrap() + 1;
        let obj3 = find_obj_offset(&pdf, b"\n3 0 obj\n").unwrap() + 1;
        pdf.extend_from_slice(b"xref\n0 4\n");
        pdf.extend_from_slice(b"0000000000 65535 f \n");
        pdf.extend_from_slice(format!("{:010} 00000 n \n", obj1).as_bytes());
        pdf.extend_from_slice(format!("{:010} 00000 n \n", obj2).as_bytes());
        pdf.extend_from_slice(format!("{:010} 00000 n \n", obj3).as_bytes());
        pdf.extend_from_slice(b"trailer\n<< /Size 4 /Root 1 0 R /ID [<d0d0d0> <d0d0d0>] >>\n");
        pdf.extend_from_slice(format!("startxref\n{}\n%%EOF\n", xref_start).as_bytes());
        // Append trailing nulls — the thing lopdf chokes on.
        pdf.extend_from_slice(&[0u8; 12]);

        // With nulls present, lopdf may or may not succeed depending on
        // version. The KEY behavior we test: write_incremental must
        // succeed regardless (via fallback path if needed) AND preserve
        // every original byte.
        let (out, summary) = write_incremental(&pdf, &[]).expect("write");
        assert_eq!(
            &out[..pdf.len()],
            pdf.as_slice(),
            "original bytes (including trailing nulls) must be verbatim"
        );
        assert!(summary.appended_bytes > 0);
        assert!(out.ends_with(b"%%EOF\n"));
    }

    #[test]
    fn fallback_rejects_nonempty_patches() {
        // Signed-PDF path only supports empty-patches today. Non-empty
        // must error with a clear message so callers can fall back
        // to pd-lib.
        let mut pdf = b"%PDF-1.7\n\
1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n\
2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n\
3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n"
            .to_vec();
        let xref_start = pdf.len();
        let obj1 = find_obj_offset(&pdf, b"\n1 0 obj\n").unwrap() + 1;
        let obj2 = find_obj_offset(&pdf, b"\n2 0 obj\n").unwrap() + 1;
        let obj3 = find_obj_offset(&pdf, b"\n3 0 obj\n").unwrap() + 1;
        pdf.extend_from_slice(b"xref\n0 4\n");
        pdf.extend_from_slice(b"0000000000 65535 f \n");
        pdf.extend_from_slice(format!("{:010} 00000 n \n", obj1).as_bytes());
        pdf.extend_from_slice(format!("{:010} 00000 n \n", obj2).as_bytes());
        pdf.extend_from_slice(format!("{:010} 00000 n \n", obj3).as_bytes());
        pdf.extend_from_slice(b"trailer\n<< /Size 4 /Root 1 0 R >>\n");
        pdf.extend_from_slice(format!("startxref\n{}\n%%EOF\n", xref_start).as_bytes());
        // Append nulls to force the fallback path.
        pdf.extend_from_slice(&[0u8; 8]);

        // Only matters if the primary path (lopdf) rejects our input.
        // We can't assert that from here portably, so we instead
        // assert that the success path is either (a) no error with
        // full support, or (b) an error explicitly citing S7.5.
        let patch = IncrementalPatch {
            page_index: 0,
            overlay_stream: b"q Q\n".to_vec(),
            inject_helvetica_font_as: None,
            inject_standard14_fonts: Default::default(),
            inject_embedded_fonts: Default::default(),
            compress_overlay: false,
            removed_object_ids: vec![],
        };
        match write_incremental(&pdf, std::slice::from_ref(&patch)) {
            Ok(_) => {
                // lopdf parsed despite the nulls — our primary path
                // handled it. That's fine.
            }
            Err(e) => {
                let msg = e.to_string();
                assert!(
                    msg.contains("S7.5") || msg.contains("raw-trailer"),
                    "fallback error must cite S7.5 limitation, got: {msg}",
                );
            }
        }
    }

    // ── G2 embedded-font chain tests ──────────────────────────────

    fn load_test_ttf() -> Vec<u8> {
        // NotoSans-Regular.ttf ships in `scripts/fonts/`; resolved
        // relative to the cargo manifest dir.
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("scripts")
            .join("fonts")
            .join("NotoSans-Regular.ttf");
        std::fs::read(&path).unwrap_or_else(|e| {
            panic!(
                "test fixture missing: {path:?}: {e}. Run from repo root \
                 — `scripts/fonts/NotoSans-Regular.ttf` is checked in."
            )
        })
    }

    #[test]
    fn embedded_font_chain_emits_four_objects() {
        let ttf = load_test_ttf();
        let payload = EmbeddedFontPayload {
            bytes: ttf,
            postscript_name: "NotoSans-Regular".into(),
            bold: false,
            italic: false,
        };
        let mut buf = Vec::new();
        let mut next_id: u32 = 100;
        let ((type0_num, type0_gen), emitted) =
            emit_embedded_font_chain(&mut buf, &mut next_id, &payload).expect("emit succeeds");
        assert_eq!(emitted.len(), 4, "FontFile2 + Descriptor + CIDFont + Type0");
        assert_eq!(type0_gen, 0);
        // Type0 is the LAST of the four (most-recent obj_num).
        assert_eq!(type0_num, 103);
        assert_eq!(next_id, 104, "next_id advances by exactly 4");
        // All four obj_nums are sequential.
        let nums: Vec<u32> = emitted.iter().map(|e| e.obj_num).collect();
        assert_eq!(nums, vec![100, 101, 102, 103]);
    }

    #[test]
    fn embedded_font_emits_required_descriptor_fields() {
        let ttf = load_test_ttf();
        let payload = EmbeddedFontPayload {
            bytes: ttf,
            postscript_name: "NotoSans-Regular".into(),
            bold: false,
            italic: false,
        };
        let mut buf = Vec::new();
        let mut next_id: u32 = 1;
        let _ = emit_embedded_font_chain(&mut buf, &mut next_id, &payload).unwrap();
        // Buffer mixes ASCII PDF dict syntax with FlateDecode-compressed
        // TTF bytes; lossy conversion lets us search for the textual
        // dict fields without panicking on binary slots.
        let s = String::from_utf8_lossy(&buf);
        // FontDescriptor must carry every field veraPDF / Acrobat
        // Preflight check for. Missing any of these flags PDF/A.
        for field in &[
            "/Type /FontDescriptor",
            "/FontName /AAAAAA+NotoSans-Regular",
            "/Flags ",
            "/FontBBox ",
            "/ItalicAngle ",
            "/Ascent ",
            "/Descent ",
            "/CapHeight ",
            "/StemV ",
            "/MissingWidth ",
            "/FontFile2 ",
        ] {
            assert!(s.contains(field), "missing {field} in:\n{s}");
        }
    }

    #[test]
    fn embedded_font_type0_uses_identity_h_encoding() {
        let ttf = load_test_ttf();
        let payload = EmbeddedFontPayload {
            bytes: ttf,
            postscript_name: "NotoSans-Regular".into(),
            bold: false,
            italic: false,
        };
        let mut buf = Vec::new();
        let mut next_id: u32 = 10;
        let _ = emit_embedded_font_chain(&mut buf, &mut next_id, &payload).unwrap();
        let s = String::from_utf8_lossy(&buf);
        assert!(s.contains("/Subtype /Type0"));
        assert!(s.contains("/Encoding /Identity-H"));
        assert!(s.contains("/DescendantFonts [12 0 R]"));
    }

    #[test]
    fn embedded_font_cidfont_uses_identity_cid_to_gid_map() {
        let ttf = load_test_ttf();
        let payload = EmbeddedFontPayload {
            bytes: ttf,
            postscript_name: "NotoSans-Regular".into(),
            bold: false,
            italic: false,
        };
        let mut buf = Vec::new();
        let mut next_id: u32 = 1;
        let _ = emit_embedded_font_chain(&mut buf, &mut next_id, &payload).unwrap();
        let s = String::from_utf8_lossy(&buf);
        assert!(s.contains("/Subtype /CIDFontType2"));
        assert!(s.contains("/CIDToGIDMap /Identity"));
        assert!(s.contains("/Registry (Adobe)"));
        assert!(s.contains("/Ordering (Identity)"));
        // Width array opens with `[0 [` (Identity-H means CID=glyph
        // index, so we list every glyph's width starting at CID 0).
        assert!(
            s.contains("/W [ 0 ["),
            "width array layout: {}",
            &s[s.find("/W").unwrap()..s.find("/W").unwrap() + 80]
        );
    }

    #[test]
    fn embedded_font_fontfile2_is_flate_compressed() {
        let ttf = load_test_ttf();
        let length1 = ttf.len();
        let payload = EmbeddedFontPayload {
            bytes: ttf,
            postscript_name: "NotoSans-Regular".into(),
            bold: false,
            italic: false,
        };
        let mut buf = Vec::new();
        let mut next_id: u32 = 1;
        let _ = emit_embedded_font_chain(&mut buf, &mut next_id, &payload).unwrap();
        let s = String::from_utf8_lossy(&buf);
        // /Length1 = uncompressed TTF size; /Filter = FlateDecode.
        assert!(
            s.contains(&format!("/Length1 {}", length1)),
            "FontFile2 must declare /Length1 = uncompressed TTF size",
        );
        assert!(s.contains("/Filter /FlateDecode"));
        // Compressed bytes are smaller than the uncompressed payload
        // for any typical TTF (NotoSans-Regular compresses ~50%).
        assert!(buf.len() < length1 + 4096, "expected compression to shrink");
    }

    #[test]
    fn embedded_font_bold_sets_force_bold_flag() {
        let ttf = load_test_ttf();
        let payload = EmbeddedFontPayload {
            bytes: ttf,
            postscript_name: "NotoSans-Bold".into(),
            bold: true,
            italic: false,
        };
        let mut buf = Vec::new();
        let mut next_id: u32 = 1;
        let _ = emit_embedded_font_chain(&mut buf, &mut next_id, &payload).unwrap();
        let s = String::from_utf8_lossy(&buf);
        // Find the /Flags value and assert bit 18 (ForceBold = 0x40000) is set.
        let idx = s.find("/Flags ").expect("/Flags present");
        let tail = &s[idx + "/Flags ".len()..];
        let end = tail
            .find(|c: char| !c.is_ascii_digit())
            .unwrap_or(tail.len());
        let flags: u32 = tail[..end].parse().expect("/Flags is u32");
        assert!(flags & 0x40000 != 0, "ForceBold bit 18 set, got {flags:#x}");
    }

    #[test]
    fn embedded_font_italic_sets_italic_flag() {
        let ttf = load_test_ttf();
        let payload = EmbeddedFontPayload {
            bytes: ttf,
            postscript_name: "NotoSans-Italic".into(),
            bold: false,
            italic: true,
        };
        let mut buf = Vec::new();
        let mut next_id: u32 = 1;
        let _ = emit_embedded_font_chain(&mut buf, &mut next_id, &payload).unwrap();
        let s = String::from_utf8_lossy(&buf);
        let idx = s.find("/Flags ").expect("/Flags present");
        let tail = &s[idx + "/Flags ".len()..];
        let end = tail
            .find(|c: char| !c.is_ascii_digit())
            .unwrap_or(tail.len());
        let flags: u32 = tail[..end].parse().expect("/Flags is u32");
        // bit 7 (Italic) = 0x40
        assert!(flags & 0x40 != 0, "Italic bit 7 set, got {flags:#x}");
    }

    #[test]
    fn embedded_font_basefont_carries_subset_prefix() {
        let ttf = load_test_ttf();
        // No prefix in input → writer should add AAAAAA+
        let payload = EmbeddedFontPayload {
            bytes: ttf.clone(),
            postscript_name: "MyFont".into(),
            bold: false,
            italic: false,
        };
        let mut buf = Vec::new();
        let mut next_id: u32 = 1;
        let _ = emit_embedded_font_chain(&mut buf, &mut next_id, &payload).unwrap();
        let s = String::from_utf8_lossy(&buf);
        assert!(
            s.contains("/BaseFont /AAAAAA+MyFont"),
            "auto-prefix expected: {s}"
        );

        // Already-prefixed input → kept verbatim.
        let payload2 = EmbeddedFontPayload {
            bytes: ttf,
            postscript_name: "ZZZZZZ+AlreadyPrefixed".into(),
            bold: false,
            italic: false,
        };
        let mut buf2 = Vec::new();
        let mut next_id: u32 = 1;
        let _ = emit_embedded_font_chain(&mut buf2, &mut next_id, &payload2).unwrap();
        let s2 = String::from_utf8_lossy(&buf2);
        assert!(
            s2.contains("/BaseFont /ZZZZZZ+AlreadyPrefixed"),
            "pre-prefixed name kept verbatim: {s2}",
        );
    }

    #[test]
    fn embedded_font_chain_in_full_incremental_update_lopdf_parses() {
        // End-to-end: the four-object chain emitted inside a real
        // incremental update must be parseable by lopdf and reachable
        // through the page's /Resources /Font dict.
        let ttf = load_test_ttf();
        let pdf = minimal_pdf();
        let mut embedded = std::collections::HashMap::new();
        embedded.insert(
            "Cu0".to_string(),
            EmbeddedFontPayload {
                bytes: ttf,
                postscript_name: "NotoSans-Regular".into(),
                bold: false,
                italic: false,
            },
        );
        let patch = IncrementalPatch {
            page_index: 0,
            overlay_stream: b"q BT /Cu0 12 Tf 100 720 Td <0001> Tj ET Q\n".to_vec(),
            inject_helvetica_font_as: None,
            inject_standard14_fonts: Default::default(),
            inject_embedded_fonts: embedded,
            compress_overlay: false,
            removed_object_ids: vec![],
        };
        let (out, _) =
            write_incremental(&pdf, std::slice::from_ref(&patch)).expect("write succeeds");

        let mut cursor = Cursor::new(&out);
        let doc = Document::load_from(&mut cursor).expect("lopdf re-parses output");
        let pages = doc.get_pages();
        let page_id = *pages.get(&1).expect("has page 1");
        let page_dict = doc.get_dictionary(page_id).expect("page dict");
        // Resolve /Resources/Font (it may be an inline dict or a ref).
        let resources_obj = page_dict.get(b"Resources").expect("has Resources");
        let resources_dict = match resources_obj {
            Object::Dictionary(d) => d.clone(),
            Object::Reference(r) => doc.get_dictionary(*r).expect("Resources ref").clone(),
            other => panic!("unexpected Resources shape: {other:?}"),
        };
        let font_obj = resources_dict.get(b"Font").expect("has Font");
        let font_dict = match font_obj {
            Object::Dictionary(d) => d.clone(),
            Object::Reference(r) => doc.get_dictionary(*r).expect("Font ref").clone(),
            other => panic!("unexpected Font shape: {other:?}"),
        };
        let cu0_ref = font_dict.get(b"Cu0").expect("has /Cu0 entry");
        let cu0_id = match cu0_ref {
            Object::Reference(r) => *r,
            other => panic!("/Cu0 should be a reference, got {other:?}"),
        };
        let type0_dict = doc.get_dictionary(cu0_id).expect("Type0 dict");
        // /Subtype /Type0 + /Encoding /Identity-H confirms it's the
        // composite font we emitted.
        let subtype = type0_dict.get(b"Subtype").unwrap().as_name().unwrap();
        assert_eq!(subtype, b"Type0", "expected /Type0, got {subtype:?}");
        let encoding = type0_dict.get(b"Encoding").unwrap().as_name().unwrap();
        assert_eq!(encoding, b"Identity-H");
        // /DescendantFonts must be an array of one CIDFont reference.
        let desc_fonts = type0_dict
            .get(b"DescendantFonts")
            .unwrap()
            .as_array()
            .unwrap();
        assert_eq!(desc_fonts.len(), 1);
    }
}
