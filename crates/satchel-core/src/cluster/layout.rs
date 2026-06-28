//! Layout role classification — port of `classifyPdfParagraphLayouts`
//! (src/services/pdfLayoutIntelligence.ts), signal-for-signal.
//!
//! ONE deliberate difference from the TS implementation: there is no
//! rotated-page unsafe-gate here. The WebView clusterer's geometry is
//! rotation-blind, so TS gates `/Rotate ≠ 0` pages wholesale; in this
//! pipeline the extraction backend normalizes rotation into visual
//! space BEFORE clustering, so classification runs on correct
//! geometry instead (NATIVE-REWRITE-PLAN carry-forward fix; task
//! `task_6d7a7bae`).

use once_cell::sync::Lazy;
use regex::Regex;
use std::collections::HashMap;

use super::types::{DetectedAlign, LayoutRole, Line, PageContext, ParagraphBox, ParagraphLayout};

static LIST_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)^\s*(?:[•*_\-]|\d{1,3}[.)]|[A-Za-z][.)]|[ivxlcdm]{1,8}[.)])\s+\S").unwrap()
});
static PAGE_NUMBER_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^\s*(?:page\s*)?\d+(?:\s+of\s+\d+)?\s*$").unwrap());
static MONEY_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?:[$£€]\s*)?\(?\d{1,3}(?:,\d{3})*(?:\.\d{2})?\)?").unwrap());
static DATE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\b(?:\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4}|\d{4}-\d{2}-\d{2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+\d{4})\b").unwrap()
});
static INVOICE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\b(?:invoice|subtotal|total|balance|amount|qty|quantity|unit price|rate|due|bill to|ship to|tax|terms|payment|po\s*#?)\b").unwrap()
});
static FORM_LABEL_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\b(?:name|address|phone|email|date of birth|dob|ssn|account|policy|applicant|employer|employee|taxpayer|claim|id\s*#?|signature|initials)\b").unwrap()
});
static FORM_MARK_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?:_{3,}|-{4,}|□|☐|\[\s*\]|\(\s*\))").unwrap());
static SIGNATURE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\b(?:signature|signed by|sign here|authorized signer|certification|certify|docmdp|approval signature|initials)\b").unwrap()
});
static WORD_INVOICE_HINT_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\binvoice\b").unwrap());
static STRUCTURED_HINT_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\b(?:qty|amount|total|price|item|sku|hours|rate|date|invoice)\b").unwrap()
});
static PURE_NUMBER_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\d+(?:\.\d+)?%?$").unwrap());
/// Tight money/value token for the TABLE detector (Session 5). Mirrors
/// `STRICT_VALUE_RE` in pdfLayoutIntelligence.ts exactly — see the TS
/// comment for why the loose `MONEY_RE` stays on the invoice rules.
static STRICT_VALUE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"[$£€]\s*\d|\b\d{1,3}(?:,\d{3})+(?:\.\d{2})?\b|\b\d+\.\d{2}\b").unwrap()
});
static CODE_VALUE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Z]{1,6}[\- ]?\d{2,}").unwrap());
static LABEL_TRAIL_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r":?\s*$").unwrap());

fn role_priority(role: LayoutRole) -> u32 {
    match role {
        LayoutRole::SingleColumnBody => 10,
        LayoutRole::ListItem => 35,
        LayoutRole::MultiColumn => 40,
        LayoutRole::Ambiguous => 55,
        LayoutRole::FormField => 70,
        LayoutRole::TableCell => 78,
        LayoutRole::InvoicePair => 81,
        LayoutRole::RepeatedFurniture => 82,
        LayoutRole::Footer => 85,
        LayoutRole::Header => 85,
        LayoutRole::SignatureArea => 95,
    }
}

#[derive(Debug, Clone)]
struct Assignment {
    role: LayoutRole,
    safe: bool,
    confidence: f64,
    reasons: Vec<String>,
    priority: u32,
    flow_id: Option<String>,
    column_index: Option<usize>,
    row_index: Option<usize>,
    repeated_furniture: Option<bool>,
}

#[derive(Debug)]
struct RowGroup {
    index: usize,
    center_y: f64,
    members: Vec<usize>, // indices into paragraphs
}

fn clean_text(text: &str) -> String {
    let collapsed = text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    collapsed.trim().to_string()
}

fn text_of(p: &ParagraphBox) -> String {
    if !p.original_text.is_empty() {
        clean_text(&p.original_text)
    } else {
        clean_text(
            &p.lines
                .iter()
                .map(|l| l.text.as_str())
                .collect::<Vec<_>>()
                .join(" "),
        )
    }
}

fn center_y(p: &ParagraphBox) -> f64 {
    p.bbox.y + p.bbox.height / 2.0
}

fn median(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.total_cmp(b));
    let mid = sorted.len() >> 1;
    if sorted.len() % 2 == 0 {
        (sorted[mid - 1] + sorted[mid]) / 2.0
    } else {
        sorted[mid]
    }
}

/// Short, isolated text reads as page furniture.
fn is_furniture_like(p: &ParagraphBox, txt: &str) -> bool {
    PAGE_NUMBER_RE.is_match(txt) || (p.lines.len() <= 2 && txt.chars().count() <= 90)
}

/// Blank-field markers only signal a form when they dominate or the
/// text is label-sized.
fn has_form_mark(txt: &str) -> bool {
    let marks: Vec<&str> = FORM_MARK_RE.find_iter(txt).map(|m| m.as_str()).collect();
    if marks.is_empty() {
        return false;
    }
    if txt.chars().count() <= 80 {
        return true;
    }
    let mark_chars: usize = marks.iter().map(|m| m.chars().count()).sum();
    mark_chars as f64 >= txt.chars().count() as f64 * 0.2
}

fn is_short_structured_cell(p: &ParagraphBox) -> bool {
    let txt = text_of(p);
    txt.chars().count() <= 48
        && p.lines.len() <= 2
        && p.bbox.height <= 28f64.max(p.font_size * 2.5)
}

/// Prose discriminator for column-vs-table work (Session 5): wrapped
/// multi-line text or a sentence-length single line reads as editorial
/// prose, never as a table cell. The length floor matters — a 2-line
/// wrapped label/value cell ("Bill To:\nACME Corp") must NOT count as
/// prose or label stacks qualify column bands. Mirrors `isProseLike`
/// in pdfLayoutIntelligence.ts exactly.
fn is_prose_like(p: &ParagraphBox) -> bool {
    let txt = text_of(p);
    if txt.chars().count() < 50 {
        return false;
    }
    p.lines.len() >= 2 || txt.split_whitespace().count() >= 8
}

/// Band-level prose evidence (Session 5). Mirrors
/// `bandHasProseEvidence` in pdfLayoutIntelligence.ts exactly — see
/// the TS comment: per-LINE segmented article columns must read as
/// prose via vertical density + aggregate text, while staggered
/// label/value stacks stay sparse and frozen.
fn band_has_prose_evidence(paragraphs: &[ParagraphBox], members: &[usize]) -> bool {
    if members.iter().any(|&i| is_prose_like(&paragraphs[i])) {
        return true;
    }
    if members.len() < 4 {
        return false;
    }
    let total_chars: usize = members
        .iter()
        .map(|&i| text_of(&paragraphs[i]).chars().count())
        .sum();
    if total_chars < 120 {
        return false;
    }
    let mut sorted: Vec<usize> = members.to_vec();
    sorted.sort_by(|&a, &b| paragraphs[a].bbox.y.total_cmp(&paragraphs[b].bbox.y));
    let gaps: Vec<f64> = sorted
        .windows(2)
        .map(|w| {
            paragraphs[w[1]].bbox.y - (paragraphs[w[0]].bbox.y + paragraphs[w[0]].bbox.height)
        })
        .collect();
    let font_sizes: Vec<f64> = members.iter().map(|&i| paragraphs[i].font_size).collect();
    median(&gaps) <= median(&font_sizes) * 1.9
}

fn is_likely_label(text: &str) -> bool {
    let t = clean_text(text);
    !t.is_empty()
        && t.chars().count() <= 42
        && t.chars().any(|c| c.is_ascii_alphabetic())
        && (t.ends_with(':') || FORM_LABEL_RE.is_match(&t) || INVOICE_RE.is_match(&t))
}

fn is_likely_value(text: &str) -> bool {
    let t = clean_text(text);
    MONEY_RE.is_match(&t)
        || DATE_RE.is_match(&t)
        || CODE_VALUE_RE.is_match(&t)
        || PURE_NUMBER_RE.is_match(&t)
}

fn add_reason(reasons: &mut Vec<String>, reason: &str) {
    if !reasons.iter().any(|r| r == reason) {
        reasons.push(reason.to_string());
    }
}

#[allow(clippy::too_many_arguments)]
fn assign(
    assignments: &mut HashMap<String, Assignment>,
    id: &str,
    role: LayoutRole,
    safe: bool,
    confidence: f64,
    reason: &str,
    flow_id: Option<String>,
    column_index: Option<usize>,
    row_index: Option<usize>,
    repeated_furniture: Option<bool>,
) {
    let priority = role_priority(role);
    match assignments.get_mut(id) {
        Some(existing) if priority <= existing.priority => {
            add_reason(&mut existing.reasons, reason);
            existing.confidence = existing.confidence.max(confidence);
            if !safe {
                existing.safe = false;
            }
            if flow_id.is_some() {
                existing.flow_id = flow_id;
            }
            if column_index.is_some() {
                existing.column_index = column_index;
            }
            if row_index.is_some() {
                existing.row_index = row_index;
            }
            if repeated_furniture.is_some() {
                existing.repeated_furniture = repeated_furniture;
            }
        }
        _ => {
            assignments.insert(
                id.to_string(),
                Assignment {
                    role,
                    safe,
                    confidence,
                    reasons: vec![reason.to_string()],
                    priority,
                    flow_id,
                    column_index,
                    row_index,
                    repeated_furniture,
                },
            );
        }
    }
}

fn row_groups(paragraphs: &[ParagraphBox]) -> Vec<RowGroup> {
    let mut order: Vec<usize> = (0..paragraphs.len()).collect();
    order.sort_by(|&a, &b| {
        let pa = &paragraphs[a];
        let pb = &paragraphs[b];
        center_y(pa)
            .partial_cmp(&center_y(pb))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(
                pa.bbox
                    .x
                    .total_cmp(&pb.bbox.x),
            )
    });
    let mut rows: Vec<RowGroup> = Vec::new();
    for idx in order {
        let p = &paragraphs[idx];
        let tol = 4f64.max(p.font_size * 0.55);
        if let Some(row) = rows
            .iter_mut()
            .find(|r| (r.center_y - center_y(p)).abs() <= tol)
        {
            row.members.push(idx);
            let centers: Vec<f64> = row.members.iter().map(|&i| center_y(&paragraphs[i])).collect();
            row.center_y = median(&centers);
        } else {
            rows.push(RowGroup {
                index: rows.len(),
                center_y: center_y(p),
                members: vec![idx],
            });
        }
    }
    for row in rows.iter_mut() {
        row.members.sort_by(|&a, &b| {
            paragraphs[a]
                .bbox
                .x
                .total_cmp(&paragraphs[b].bbox.x)
        });
    }
    rows
}

fn row_has_structured_signal(paragraphs: &[ParagraphBox], row: &RowGroup) -> bool {
    row.members.iter().any(|&i| {
        let txt = text_of(&paragraphs[i]);
        STRICT_VALUE_RE.is_match(&txt)
            || STRUCTURED_HINT_RE.is_match(&txt)
            || PURE_NUMBER_RE.is_match(&txt)
    })
}

fn row_looks_like_label_value(paragraphs: &[ParagraphBox], row: &RowGroup) -> bool {
    if row.members.len() != 2 {
        return false;
    }
    let left = &paragraphs[row.members[0]];
    let right = &paragraphs[row.members[1]];
    let gap = right.bbox.x - (left.bbox.x + left.bbox.width);
    gap >= 8f64.max(left.font_size * 0.7)
        && is_likely_label(&text_of(left))
        && is_likely_value(&text_of(right))
}

fn page_looks_like_invoice(paragraphs: &[ParagraphBox]) -> bool {
    let all_text = paragraphs
        .iter()
        .map(text_of)
        .collect::<Vec<_>>()
        .join(" ");
    let invoice_signals = paragraphs
        .iter()
        .filter(|p| INVOICE_RE.is_match(&text_of(p)))
        .count();
    let money_signals = paragraphs
        .iter()
        .filter(|p| MONEY_RE.is_match(&text_of(p)))
        .count();
    WORD_INVOICE_HINT_RE.is_match(&all_text) && (invoice_signals >= 2 || money_signals >= 2)
}

fn detect_recurring_grid_columns(paragraphs: &[ParagraphBox], rows: &[RowGroup]) -> Vec<f64> {
    struct Bucket {
        x: f64,
        rows: std::collections::HashSet<usize>,
    }
    let mut buckets: Vec<Bucket> = Vec::new();
    for row in rows {
        if row.members.len() < 2 {
            continue;
        }
        for &i in &row.members {
            let p = &paragraphs[i];
            if let Some(b) = buckets.iter_mut().find(|b| (b.x - p.bbox.x).abs() <= 14.0) {
                b.x = (b.x * b.rows.len() as f64 + p.bbox.x) / (b.rows.len() as f64 + 1.0);
                b.rows.insert(row.index);
            } else {
                let mut set = std::collections::HashSet::new();
                set.insert(row.index);
                buckets.push(Bucket { x: p.bbox.x, rows: set });
            }
        }
    }
    let mut xs: Vec<f64> = buckets
        .into_iter()
        .filter(|b| b.rows.len() >= 2)
        .map(|b| b.x)
        .collect();
    xs.sort_by(|a, b| a.total_cmp(b));
    xs
}

fn overlaps_recurring_column(p: &ParagraphBox, columns: &[f64]) -> bool {
    columns.iter().any(|&x| (x - p.bbox.x).abs() <= 16.0)
}

fn detect_column_bands(
    paragraphs: &[ParagraphBox],
    candidates: &[usize],
    page_width: f64,
) -> Vec<(usize, Vec<usize>)> {
    struct Band {
        x: f64,
        members: Vec<usize>,
    }
    let mut sorted: Vec<usize> = candidates
        .iter()
        .copied()
        .filter(|&i| paragraphs[i].bbox.width < page_width * 0.68)
        .collect();
    sorted.sort_by(|&a, &b| {
        paragraphs[a]
            .bbox
            .x
            .total_cmp(&paragraphs[b].bbox.x)
    });
    let mut bands: Vec<Band> = Vec::new();
    for i in sorted {
        let p = &paragraphs[i];
        let tol = 20f64.max(page_width * 0.045);
        if let Some(band) = bands.iter_mut().find(|b| (b.x - p.bbox.x).abs() <= tol) {
            band.members.push(i);
            let xs: Vec<f64> = band.members.iter().map(|&j| paragraphs[j].bbox.x).collect();
            band.x = median(&xs);
        } else {
            bands.push(Band {
                x: p.bbox.x,
                members: vec![i],
            });
        }
    }
    let mut useful: Vec<Band> = bands.into_iter().filter(|b| b.members.len() >= 2).collect();
    useful.sort_by(|a, b| a.x.total_cmp(&b.x));
    if useful.len() < 2 {
        return Vec::new();
    }
    if useful[useful.len() - 1].x - useful[0].x < page_width * 0.22 {
        return Vec::new();
    }
    let vert = |band: &Band| -> (f64, f64) {
        let top = band
            .members
            .iter()
            .map(|&i| paragraphs[i].bbox.y)
            .fold(f64::INFINITY, f64::min);
        let bottom = band
            .members
            .iter()
            .map(|&i| paragraphs[i].bbox.y + paragraphs[i].bbox.height)
            .fold(f64::NEG_INFINITY, f64::max);
        (top, bottom)
    };
    let has_vertical_overlap = useful.iter().enumerate().any(|(i, a)| {
        useful.iter().enumerate().any(|(j, b)| {
            if i >= j {
                return false;
            }
            let (a_top, a_bottom) = vert(a);
            let (b_top, b_bottom) = vert(b);
            a_bottom.min(b_bottom) - a_top.max(b_top) > 40.0
        })
    });
    if !has_vertical_overlap {
        return Vec::new();
    }
    useful
        .into_iter()
        .enumerate()
        .map(|(index, b)| (index, b.members))
        .collect()
}

/// Classify each paragraph's layout role + reflow safety, in place.
pub fn classify_layouts(paragraphs: &mut [ParagraphBox], ctx: PageContext) {
    if paragraphs.is_empty() {
        return;
    }

    let mut assignments: HashMap<String, Assignment> = HashMap::new();
    let rows = row_groups(paragraphs);
    let header_band = 44f64.max(72f64.min(ctx.page_height * 0.085));
    let footer_band = 44f64.max(72f64.min(ctx.page_height * 0.085));
    let is_invoice_page = page_looks_like_invoice(paragraphs);

    for row in &rows {
        for &i in &row.members {
            let p = &paragraphs[i];
            let txt = text_of(p);
            let top = p.bbox.y;
            let bottom = p.bbox.y + p.bbox.height;

            if SIGNATURE_RE.is_match(&txt) {
                assign(
                    &mut assignments,
                    &p.id,
                    LayoutRole::SignatureArea,
                    false,
                    0.96,
                    "signature or certification wording",
                    None,
                    None,
                    Some(row.index),
                    None,
                );
            }

            if top <= header_band && is_furniture_like(p, &txt) {
                let role = if PAGE_NUMBER_RE.is_match(&txt) {
                    LayoutRole::RepeatedFurniture
                } else {
                    LayoutRole::Header
                };
                assign(
                    &mut assignments,
                    &p.id,
                    role,
                    false,
                    0.86,
                    "inside page header band",
                    None,
                    None,
                    Some(row.index),
                    Some(true),
                );
            } else if bottom >= ctx.page_height - footer_band && is_furniture_like(p, &txt) {
                let role = if PAGE_NUMBER_RE.is_match(&txt) {
                    LayoutRole::RepeatedFurniture
                } else {
                    LayoutRole::Footer
                };
                assign(
                    &mut assignments,
                    &p.id,
                    role,
                    false,
                    0.86,
                    "inside page footer band",
                    None,
                    None,
                    Some(row.index),
                    Some(true),
                );
            }

            if LIST_RE.is_match(&txt) {
                assign(
                    &mut assignments,
                    &p.id,
                    LayoutRole::ListItem,
                    true,
                    0.82,
                    "list marker detected",
                    Some("body".to_string()),
                    None,
                    Some(row.index),
                    None,
                );
            }

            if has_form_mark(&txt)
                || (FORM_LABEL_RE.is_match(&txt)
                    && LABEL_TRAIL_RE.is_match(&txt)
                    && txt.chars().count() <= 50)
            {
                assign(
                    &mut assignments,
                    &p.id,
                    LayoutRole::FormField,
                    false,
                    0.78,
                    "form-like label or blank field marker",
                    None,
                    None,
                    Some(row.index),
                    None,
                );
            }
        }

        if row.members.len() >= 2
            && row
                .members
                .iter()
                .any(|&i| has_form_mark(&text_of(&paragraphs[i])))
        {
            for &i in &row.members {
                assign(
                    &mut assignments,
                    &paragraphs[i].id,
                    LayoutRole::FormField,
                    false,
                    0.82,
                    "shares a row with a blank form marker",
                    None,
                    None,
                    Some(row.index),
                    None,
                );
            }
        }

        if is_invoice_page
            && (row_looks_like_label_value(paragraphs, row)
                || row
                    .members
                    .iter()
                    .any(|&i| INVOICE_RE.is_match(&text_of(&paragraphs[i])))
                || (row.members.len() >= 2
                    && row
                        .members
                        .iter()
                        .any(|&i| MONEY_RE.is_match(&text_of(&paragraphs[i])))))
        {
            for &i in &row.members {
                assign(
                    &mut assignments,
                    &paragraphs[i].id,
                    LayoutRole::InvoicePair,
                    false,
                    0.88,
                    "invoice label/value or amount row",
                    None,
                    None,
                    Some(row.index),
                    None,
                );
            }
        }
    }

    let recurring_columns = detect_recurring_grid_columns(paragraphs, &rows);
    let structured_rows: Vec<&RowGroup> = rows
        .iter()
        .filter(|row| {
            if row.members.len() >= 3 {
                // Prose-vs-cell discrimination (Session 5): a wide row
                // is a table row only when most members read as short
                // structured cells. Genuine multi-column prose sharing
                // a baseline must not freeze as a table — but it does
                // not get a free pass to safety either (demotion pass
                // below).
                let short_cells = row
                    .members
                    .iter()
                    .filter(|&&i| is_short_structured_cell(&paragraphs[i]))
                    .count();
                return short_cells >= row.members.len().div_ceil(2);
            }
            if row.members.len() < 2 {
                return false;
            }
            let structured_cells = row
                .members
                .iter()
                .filter(|&&i| is_short_structured_cell(&paragraphs[i]))
                .count();
            let recurring_cells = row
                .members
                .iter()
                .filter(|&&i| overlaps_recurring_column(&paragraphs[i], &recurring_columns))
                .count();
            recurring_columns.len() >= 2
                && structured_cells == row.members.len()
                && recurring_cells >= 2
                && row_has_structured_signal(paragraphs, row)
        })
        .collect();

    if structured_rows.len() >= 2 || structured_rows.iter().any(|row| row.members.len() >= 3) {
        for row in &structured_rows {
            for &i in &row.members {
                assign(
                    &mut assignments,
                    &paragraphs[i].id,
                    LayoutRole::TableCell,
                    false,
                    0.88,
                    "aligned row/cell grid detected",
                    None,
                    None,
                    Some(row.index),
                    None,
                );
            }
        }
    }

    // Demotion floor (Session 5, preflight P0): a ≥3-member row that
    // did NOT qualify as a table row must never fall through to the
    // safe body default. Non-prose members are pinned ambiguous+frozen
    // HERE — authoritatively, so a list marker or a later column band
    // cannot re-claim them as safe. Prose members stay unassigned so a
    // genuine multi-column page can still claim them below. Mirrors
    // the TS demotion pass exactly.
    {
        let structured_indices: std::collections::HashSet<usize> =
            structured_rows.iter().map(|r| r.index).collect();
        for row in &rows {
            if row.members.len() < 3 || structured_indices.contains(&row.index) {
                continue;
            }
            for &i in &row.members {
                if is_prose_like(&paragraphs[i]) {
                    continue;
                }
                assign(
                    &mut assignments,
                    &paragraphs[i].id,
                    LayoutRole::Ambiguous,
                    false,
                    0.66,
                    "short cell in a wide row without table evidence",
                    None,
                    None,
                    Some(row.index),
                    None,
                );
            }
        }
    }

    let safe_column_candidates: Vec<usize> = (0..paragraphs.len())
        .filter(|&i| {
            assignments
                .get(&paragraphs[i].id)
                .map(|a| a.safe)
                .unwrap_or(true)
        })
        .collect();
    let column_bands = detect_column_bands(paragraphs, &safe_column_candidates, ctx.page_width);
    if column_bands.len() >= 2 {
        for (band_index, members) in &column_bands {
            // A band earns SAFE multi_column only with prose evidence
            // (Session 5): stacks of short label/value cells align by
            // x exactly like article columns do, but reflowing them is
            // a structured-data hazard — they freeze as ambiguous
            // instead. List items keep their own (safe) role either
            // way. Mirrors the TS band loop exactly.
            let band_has_prose = band_has_prose_evidence(paragraphs, members);
            for &i in members {
                let id = paragraphs[i].id.clone();
                let flow_id = format!("column:{}:{}", ctx.page_index, band_index);
                let is_list_item = assignments
                    .get(&id)
                    .map(|a| a.role == LayoutRole::ListItem)
                    .unwrap_or(false);
                if is_list_item {
                    if let Some(existing) = assignments.get_mut(&id) {
                        existing.flow_id = Some(flow_id);
                        existing.column_index = Some(*band_index);
                        add_reason(&mut existing.reasons, "inside multi-column region");
                    }
                } else if !band_has_prose {
                    assign(
                        &mut assignments,
                        &id,
                        LayoutRole::Ambiguous,
                        false,
                        0.62,
                        "column-like stack of short cells without prose evidence",
                        None,
                        Some(*band_index),
                        None,
                        None,
                    );
                } else {
                    assign(
                        &mut assignments,
                        &id,
                        LayoutRole::MultiColumn,
                        true,
                        0.82,
                        "inside multi-column region",
                        Some(flow_id),
                        Some(*band_index),
                        None,
                        None,
                    );
                }
            }
        }
    }

    for row in &rows {
        // Session 5: widened from exactly-2 to ≥2 — any same-baseline
        // multi-member row whose members no detector positively
        // claimed stays frozen instead of defaulting to the safe body
        // flow.
        if row.members.len() < 2 {
            continue;
        }
        for &i in &row.members {
            if assignments.contains_key(&paragraphs[i].id) {
                continue;
            }
            assign(
                &mut assignments,
                &paragraphs[i].id,
                LayoutRole::Ambiguous,
                false,
                0.62,
                "same-baseline peer without a safe flow structure",
                None,
                None,
                Some(row.index),
                None,
            );
        }
    }

    // Detected alignment (Session 5, R5a) — pure geometry, orthogonal
    // to roles. Computed once per page, attached when confidently
    // non-left. Mirrors the TS classifier exactly.
    let align_measure = derive_align_measure(paragraphs, ctx.page_width);
    let aligns: Vec<Option<DetectedAlign>> = paragraphs
        .iter()
        .map(|p| {
            align_measure
                .as_ref()
                .and_then(|m| infer_paragraph_align(p, m))
        })
        .collect();

    for (idx, p) in paragraphs.iter_mut().enumerate() {
        let layout = match assignments.get(&p.id) {
            Some(a) => ParagraphLayout {
                role: a.role,
                safe_for_auto_reflow: a.safe,
                confidence: a.confidence,
                reasons: a.reasons.clone(),
                flow_id: a.flow_id.clone(),
                column_index: a.column_index,
                row_index: a.row_index,
                repeated_furniture: a.repeated_furniture,
                align: aligns[idx],
            },
            None => ParagraphLayout {
                role: LayoutRole::SingleColumnBody,
                safe_for_auto_reflow: true,
                confidence: 0.74,
                reasons: vec!["default body-flow region".to_string()],
                flow_id: Some("body".to_string()),
                column_index: None,
                row_index: None,
                repeated_furniture: None,
                align: aligns[idx],
            },
        };
        p.layout = Some(layout);
    }
}

// ── Detected alignment (Session 5, R5a) ─────────────────────────────
//
// Port of `deriveAlignMeasure` / `inferParagraphAlign` in
// pdfLayoutIntelligence.ts, signal-for-signal — see the TS comments
// for the full rationale. Conservative contract: emit non-left ONLY on
// strong geometric evidence, and never let a paragraph corroborate its
// own right edge (the degenerate longest-first-line justify case).

const ALIGN_EDGE_TOL: f64 = 2.0;
const ALIGN_FLUSH_TOL: f64 = 1.5;

struct AlignMeasure {
    left: f64,
    right: f64,
    /// (paragraph id, right edge) for external corroboration.
    right_edges: Vec<(String, f64)>,
    /// True when maxRight ≈ pageWidth − modalLeft.
    symmetric: bool,
}

fn derive_align_measure(paragraphs: &[ParagraphBox], page_width: f64) -> Option<AlignMeasure> {
    if paragraphs.len() < 2 {
        return None;
    }
    let mut lefts: Vec<f64> = paragraphs.iter().map(|p| p.bbox.x).collect();
    lefts.sort_by(|a, b| a.total_cmp(b));
    let mut modal_left = lefts[0];
    let mut best_count = 1usize;
    for i in 0..lefts.len() {
        let mut count = 1usize;
        let mut sum = lefts[i];
        let mut j = i + 1;
        while j < lefts.len() && lefts[j] - lefts[i] <= ALIGN_EDGE_TOL {
            count += 1;
            sum += lefts[j];
            j += 1;
        }
        if count > best_count {
            best_count = count;
            modal_left = sum / count as f64;
        }
    }
    let right_edges: Vec<(String, f64)> = paragraphs
        .iter()
        .map(|p| (p.id.clone(), p.bbox.x + p.bbox.width))
        .collect();
    let max_right = right_edges
        .iter()
        .map(|(_, r)| *r)
        .fold(f64::NEG_INFINITY, f64::max);
    let measure = max_right - modal_left;
    // NaN-safe: a degenerate/NaN measure must bail (mirrors the TS
    // `!(measure > pageWidth * 0.3)` intent without the negated
    // partial-ord comparison the clippy gate denies).
    if !matches!(
        measure.partial_cmp(&(page_width * 0.3)),
        Some(std::cmp::Ordering::Greater)
    ) {
        return None;
    }
    let symmetric = (max_right - (page_width - modal_left)).abs() <= 3.0;
    Some(AlignMeasure {
        left: modal_left,
        right: max_right,
        right_edges,
        symmetric,
    })
}

/// True when the page's max-right evidence holds beyond paragraph `id`
/// itself: another paragraph shares the edge, or the margins are
/// symmetric.
fn right_edge_corroborated(measure: &AlignMeasure, id: &str) -> bool {
    if measure.symmetric {
        return true;
    }
    right_edge_shared_by_other(measure, id)
}

/// Strong corroboration: another PARAGRAPH ends at the measure's right
/// edge. Margin symmetry deliberately does NOT count here — justify
/// detection with a single evidence line needs a real second flush
/// edge, or any left paragraph whose longest line coincidentally hits
/// the symmetric margin would read as justified.
fn right_edge_shared_by_other(measure: &AlignMeasure, id: &str) -> bool {
    measure
        .right_edges
        .iter()
        .any(|(rid, r)| rid != id && (r - measure.right).abs() <= ALIGN_EDGE_TOL)
}

fn infer_paragraph_align(p: &ParagraphBox, measure: &AlignMeasure) -> Option<DetectedAlign> {
    let lines: Vec<&Line> = p.lines.iter().filter(|l| l.width > 0.0).collect();
    if lines.is_empty() {
        return None;
    }
    let var_min = 10f64.max(p.font_size);

    if lines.len() >= 2 {
        let ls: Vec<f64> = lines.iter().map(|l| l.x).collect();
        let rs: Vec<f64> = lines.iter().map(|l| l.x + l.width).collect();
        let cs: Vec<f64> = lines.iter().map(|l| l.x + l.width / 2.0).collect();
        let span = |v: &[f64]| {
            v.iter().fold(f64::NEG_INFINITY, |a, &b| a.max(b))
                - v.iter().fold(f64::INFINITY, |a, &b| a.min(b))
        };
        let l_var = span(&ls);
        let r_var = span(&rs);
        let c_var = span(&cs);

        if l_var <= ALIGN_FLUSH_TOL {
            // Shared left edge: left prose or justified. Justify needs
            // every NON-LAST line flush to the measure's right edge,
            // corroborated outside this paragraph when only one
            // non-last line exists.
            let min_left = ls.iter().fold(f64::INFINITY, |a, &b| a.min(b));
            if (min_left - measure.left).abs() <= ALIGN_EDGE_TOL {
                let non_last = &rs[..rs.len() - 1];
                let all_flush = !non_last.is_empty()
                    && non_last
                        .iter()
                        .all(|r| (r - measure.right).abs() <= ALIGN_FLUSH_TOL);
                if all_flush {
                    if non_last.len() >= 2 || right_edge_shared_by_other(measure, &p.id) {
                        return Some(DetectedAlign::Justify);
                    }
                    // Flush both edges but uncorroborated: genuinely
                    // ambiguous between left and justified — UNKNOWN.
                    return None;
                }
            }
            // Shared left edges with ragged right: POSITIVE left
            // evidence.
            return Some(DetectedAlign::Left);
        }
        if r_var <= ALIGN_FLUSH_TOL && l_var >= var_min {
            return Some(DetectedAlign::Right);
        }
        if c_var <= 3.0 && l_var >= var_min && r_var >= var_min {
            return Some(DetectedAlign::Center);
        }
        return None;
    }

    // Single line: measure-based, with the left-flush precedence rule —
    // a line anchored at the measure's left is left text no matter
    // where it ends.
    let line = lines[0];
    let l = line.x;
    let r = line.x + line.width;
    if (l - measure.left).abs() <= ALIGN_EDGE_TOL {
        return Some(DetectedAlign::Left);
    }
    let measure_width = measure.right - measure.left;
    let left_slack = l - measure.left;
    let right_slack = measure.right - r;
    let min_slack = 12f64.max(measure_width * 0.04);
    if (r - measure.right).abs() <= ALIGN_EDGE_TOL
        && left_slack >= min_slack
        && right_edge_corroborated(measure, &p.id)
    {
        return Some(DetectedAlign::Right);
    }
    let center = (l + r) / 2.0;
    let measure_center = (measure.left + measure.right) / 2.0;
    if (center - measure_center).abs() <= 2f64.max(measure_width * 0.01)
        && left_slack >= min_slack
        && right_slack >= min_slack
        && (left_slack - right_slack).abs() <= 3f64.max(measure_width * 0.02)
    {
        return Some(DetectedAlign::Center);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cluster::types::{Line, Rect};

    fn para(id: &str, x: f64, y: f64, width: f64, height: f64, text: &str) -> ParagraphBox {
        let font_size = 12.0;
        ParagraphBox {
            id: id.to_string(),
            item_indices: vec![],
            lines: vec![Line {
                y,
                font_size,
                text: text.to_string(),
                item_indices: vec![],
                x,
                width,
            }],
            bbox: Rect {
                x,
                y,
                width,
                height,
            },
            original_text: text.to_string(),
            font_size,
            font_name: "Helvetica".to_string(),
            font_family: "Helvetica".to_string(),
            bold: false,
            italic: false,
            layout: None,
        }
    }

    fn classify(mut paragraphs: Vec<ParagraphBox>) -> Vec<ParagraphBox> {
        classify_layouts(
            &mut paragraphs,
            PageContext {
                page_index: 0,
                page_width: 612.0,
                page_height: 792.0,
            },
        );
        paragraphs
    }

    fn role_of(ps: &[ParagraphBox], id: &str) -> LayoutRole {
        ps.iter()
            .find(|p| p.id == id)
            .and_then(|p| p.layout.as_ref())
            .map(|l| l.role)
            .unwrap()
    }

    fn safe_of(ps: &[ParagraphBox], id: &str) -> bool {
        ps.iter()
            .find(|p| p.id == id)
            .and_then(|p| p.layout.as_ref())
            .map(|l| l.safe_for_auto_reflow)
            .unwrap()
    }

    // Ports of the TS unit suite in
    // .test-mcp/test-pdf-layout-intelligence.mjs — same fixtures,
    // same expectations, so the two classifiers are pinned to the
    // same behavior at the unit level too.

    #[test]
    fn single_column_body_is_safe() {
        let body = classify(vec![
            para("b1", 72.0, 100.0, 420.0, 18.0, "A normal body paragraph with enough words to read as prose."),
            para("b2", 72.0, 130.0, 420.0, 18.0, "Another body paragraph follows in the same flow."),
            para("b3", 72.0, 160.0, 420.0, 18.0, "A final body paragraph stays in order."),
        ]);
        assert_eq!(role_of(&body, "b1"), LayoutRole::SingleColumnBody);
        assert!(safe_of(&body, "b1"));
    }

    #[test]
    fn multi_column_detected_with_distinct_flows() {
        let columns = classify(vec![
            para("l1", 72.0, 100.0, 210.0, 46.0, "Left column paragraph one has long editorial text that is not a table cell."),
            para("r1", 330.0, 100.0, 210.0, 46.0, "Right column paragraph one has long editorial text that is not a table cell."),
            para("l2", 72.0, 170.0, 210.0, 46.0, "Left column paragraph two continues below the first left paragraph."),
            para("r2", 330.0, 170.0, 210.0, 46.0, "Right column paragraph two continues below the first right paragraph."),
        ]);
        assert_eq!(role_of(&columns, "l1"), LayoutRole::MultiColumn);
        assert_eq!(role_of(&columns, "r1"), LayoutRole::MultiColumn);
        let flow = |id: &str| {
            columns
                .iter()
                .find(|p| p.id == id)
                .and_then(|p| p.layout.as_ref())
                .and_then(|l| l.flow_id.clone())
        };
        assert_ne!(flow("l1"), flow("r1"), "columns get distinct flows");
    }

    #[test]
    fn list_items_safe() {
        let list = classify(vec![
            para("li1", 90.0, 120.0, 360.0, 18.0, "1. Gather requirements"),
            para("li2", 90.0, 145.0, 360.0, 18.0, "2. Build the fixture"),
        ]);
        assert_eq!(role_of(&list, "li1"), LayoutRole::ListItem);
        assert!(safe_of(&list, "li1"));
    }

    #[test]
    fn table_cells_unsafe() {
        let table = classify(vec![
            para("h1", 72.0, 150.0, 90.0, 16.0, "Item"),
            para("h2", 190.0, 150.0, 70.0, 16.0, "Qty"),
            para("h3", 300.0, 150.0, 90.0, 16.0, "Amount"),
            para("c1", 72.0, 176.0, 90.0, 16.0, "Hosting"),
            para("c2", 190.0, 176.0, 70.0, 16.0, "2"),
            para("c3", 300.0, 176.0, 90.0, 16.0, "$40.00"),
        ]);
        assert_eq!(role_of(&table, "c3"), LayoutRole::TableCell);
        assert!(!safe_of(&table, "c3"));
    }

    #[test]
    fn invoice_pairs_unsafe() {
        let invoice = classify(vec![
            para("title", 72.0, 34.0, 120.0, 22.0, "Invoice"),
            para("bill", 72.0, 130.0, 80.0, 16.0, "Bill To:"),
            para("client", 230.0, 130.0, 120.0, 16.0, "ACME-1024"),
            para("total", 330.0, 620.0, 80.0, 16.0, "Total:"),
            para("amount", 470.0, 620.0, 90.0, 16.0, "$120.00"),
        ]);
        assert_eq!(role_of(&invoice, "amount"), LayoutRole::InvoicePair);
        assert!(!safe_of(&invoice, "amount"));
    }

    #[test]
    fn form_fields_and_signatures_unsafe() {
        let form = classify(vec![
            para("name", 72.0, 150.0, 70.0, 16.0, "Name:"),
            para("blank", 160.0, 150.0, 180.0, 16.0, "________________"),
            para("sig", 72.0, 690.0, 180.0, 16.0, "Signature: __________________"),
        ]);
        assert_eq!(role_of(&form, "name"), LayoutRole::FormField);
        assert!(!safe_of(&form, "name"));
        assert_eq!(role_of(&form, "sig"), LayoutRole::SignatureArea);
        assert!(!safe_of(&form, "sig"));
    }

    #[test]
    fn headers_and_page_numbers_are_furniture() {
        let furniture = classify(vec![
            para("header", 72.0, 30.0, 220.0, 14.0, "Quarterly Report"),
            para("body", 72.0, 120.0, 420.0, 18.0, "Body text starts below the header."),
            para("footer", 280.0, 744.0, 60.0, 14.0, "Page 1"),
        ]);
        assert_eq!(role_of(&furniture, "header"), LayoutRole::Header);
        assert!(!safe_of(&furniture, "header"));
        assert_eq!(role_of(&furniture, "footer"), LayoutRole::RepeatedFurniture);
        assert!(!safe_of(&furniture, "footer"));
    }

    #[test]
    fn ambiguous_same_row_pair_blocked() {
        let ambiguous = classify(vec![
            para("left", 72.0, 300.0, 120.0, 16.0, "Side note"),
            para("right", 280.0, 300.0, 120.0, 16.0, "Loose value"),
        ]);
        assert_eq!(role_of(&ambiguous, "left"), LayoutRole::Ambiguous);
        assert!(!safe_of(&ambiguous, "left"));
    }

    #[test]
    fn page_top_continuation_prose_stays_safe() {
        let mut cont = para(
            "cont",
            72.0,
            30.0,
            440.0,
            34.0,
            "This long continuation paragraph carries over from the previous page and keeps flowing as ordinary article prose.",
        );
        cont.lines = vec![
            Line {
                y: 30.0,
                font_size: 12.0,
                text: "This long continuation paragraph carries over from the previous".to_string(),
                item_indices: vec![],
                x: 72.0,
                width: 440.0,
            },
            Line {
                y: 48.0,
                font_size: 12.0,
                text: "page and keeps flowing as ordinary article prose.".to_string(),
                item_indices: vec![],
                x: 72.0,
                width: 440.0,
            },
        ];
        let page = classify(vec![
            cont,
            para("hdr", 480.0, 30.0, 60.0, 12.0, "CONFIDENTIAL"),
            para("body", 72.0, 120.0, 440.0, 18.0, "A body paragraph below the continuation keeps the page honest."),
        ]);
        assert_eq!(role_of(&page, "cont"), LayoutRole::SingleColumnBody);
        assert!(safe_of(&page, "cont"));
        assert_eq!(role_of(&page, "hdr"), LayoutRole::Header);
    }

    #[test]
    fn inline_blank_in_prose_stays_body() {
        let prose = classify(vec![
            para("q", 72.0, 200.0, 440.0, 18.0, "Which Barbadian author became the first to win the prize for her debut novel ____ in that year?"),
            para("blank", 72.0, 400.0, 180.0, 16.0, "________________"),
            para("body", 72.0, 300.0, 440.0, 18.0, "Plain body text keeps the page from looking like a pure form."),
        ]);
        assert_eq!(role_of(&prose, "q"), LayoutRole::SingleColumnBody);
        assert!(safe_of(&prose, "q"));
        assert_eq!(role_of(&prose, "blank"), LayoutRole::FormField);
    }

    // ── Session-5 D1 pins (mirrors of the TS unit driver cases) ──

    #[test]
    fn demoted_wide_row_members_stay_frozen() {
        // A ≥3-member row that FAILS the table test must not leak
        // members into safe roles — not via the body default, not via
        // a list marker.
        let demoted = classify(vec![
            para("p1", 72.0, 200.0, 150.0, 16.0, "The first prose cell in this wide row reads as ordinary editorial text."),
            para("p2", 240.0, 200.0, 150.0, 16.0, "The second prose cell also reads as ordinary editorial sentence text."),
            para("li", 410.0, 200.0, 120.0, 16.0, "1. Marker cell"),
        ]);
        assert_eq!(role_of(&demoted, "li"), LayoutRole::Ambiguous);
        assert!(!safe_of(&demoted, "li"));
        assert!(!safe_of(&demoted, "p1"));
        assert!(!safe_of(&demoted, "p2"));
    }

    #[test]
    fn table_row_with_prose_description_cell_stays_frozen() {
        let table = classify(vec![
            para("t1", 72.0, 150.0, 90.0, 16.0, "Hosting"),
            para("t2", 190.0, 150.0, 60.0, 16.0, "2"),
            para("t3", 280.0, 150.0, 240.0, 16.0, "A longer description cell that wraps with quite many words to read as prose."),
        ]);
        assert_eq!(role_of(&table, "t1"), LayoutRole::TableCell);
        assert!(!safe_of(&table, "t1"));
        assert!(!safe_of(&table, "t3"));
    }

    #[test]
    fn three_column_prose_page_becomes_safe_multi_column() {
        let cols3 = classify(vec![
            para("a1", 40.0, 100.0, 160.0, 46.0, "First column paragraph carries long editorial sentence text that wraps."),
            para("b1", 230.0, 100.0, 160.0, 46.0, "Second column paragraph carries long editorial sentence text that wraps."),
            para("c1", 420.0, 100.0, 160.0, 46.0, "Third column paragraph carries long editorial sentence text that wraps."),
            para("a2", 40.0, 170.0, 160.0, 46.0, "First column second paragraph continues the same editorial column flow."),
            para("b2", 230.0, 170.0, 160.0, 46.0, "Second column second paragraph continues the same editorial column flow."),
            para("c2", 420.0, 170.0, 160.0, 46.0, "Third column second paragraph continues the same editorial column flow."),
        ]);
        assert_eq!(role_of(&cols3, "b1"), LayoutRole::MultiColumn);
        assert!(safe_of(&cols3, "b1"));
        let flow = |id: &str| {
            cols3
                .iter()
                .find(|p| p.id == id)
                .and_then(|p| p.layout.as_ref())
                .and_then(|l| l.flow_id.clone())
        };
        assert_ne!(flow("a1"), flow("c1"));
    }

    #[test]
    fn short_label_value_stacks_freeze_as_ambiguous() {
        // Staggered stacks of short cells band geometrically like
        // columns but carry no prose — frozen, never safe.
        fn stack(id: &str, x: f64, y: f64, l1: &str, l2: &str) -> ParagraphBox {
            let mut p = para(id, x, y, 150.0, 30.0, &format!("{l1}\n{l2}"));
            p.lines = vec![
                Line {
                    y,
                    font_size: 12.0,
                    text: l1.to_string(),
                    item_indices: vec![],
                    x,
                    width: 150.0,
                },
                Line {
                    y: y + 15.0,
                    font_size: 12.0,
                    text: l2.to_string(),
                    item_indices: vec![],
                    x,
                    width: 150.0,
                },
            ];
            p
        }
        let kv = classify(vec![
            stack("k1", 72.0, 100.0, "Contact:", "Jane Smith"),
            stack("k2", 72.0, 160.0, "Office:", "Building 7"),
            stack("k3", 72.0, 220.0, "Region:", "Northeast"),
            stack("v1", 300.0, 130.0, "Status:", "Active"),
            stack("v2", 300.0, 190.0, "Tier:", "Gold"),
            stack("v3", 300.0, 250.0, "Owner:", "Ops desk"),
        ]);
        assert_eq!(role_of(&kv, "k1"), LayoutRole::Ambiguous);
        assert!(!safe_of(&kv, "k1"));
        assert!(!safe_of(&kv, "v1"));
    }

    #[test]
    fn bare_year_column_rows_are_not_table_frozen() {
        // The loose MONEY_RE substring froze short two-column prose
        // rows whenever they mentioned a bare number; the tight value
        // token lets them ride the bands to safe multi_column.
        let cols = classify(vec![
            para("a1", 72.0, 100.0, 200.0, 16.0, "Storm tides rose in 2026."),
            para("b1", 330.0, 100.0, 200.0, 16.0, "Crews patched the sea wall."),
            para("a2", 72.0, 126.0, 200.0, 16.0, "Three boats left the bay."),
            para("b2", 330.0, 126.0, 200.0, 16.0, "The harbor closed at dusk."),
            para("a3", 72.0, 160.0, 200.0, 16.0, "The closing paragraph for this column carries full sentences."),
            para("b3", 330.0, 160.0, 200.0, 16.0, "The mirrored closing paragraph carries full sentences as well."),
        ]);
        assert_eq!(role_of(&cols, "a1"), LayoutRole::MultiColumn);
        assert!(safe_of(&cols, "a1"));
    }

    #[test]
    fn currency_valued_rows_still_freeze_as_table_cells() {
        let money = classify(vec![
            para("m1", 72.0, 100.0, 200.0, 16.0, "Hosting"),
            para("m2", 330.0, 100.0, 200.0, 16.0, "$40.00"),
            para("m3", 72.0, 126.0, 200.0, 16.0, "Support"),
            para("m4", 330.0, 126.0, 200.0, 16.0, "$25.00"),
            para("m5", 72.0, 160.0, 200.0, 16.0, "The closing paragraph for this column carries full sentences."),
            para("m6", 330.0, 160.0, 200.0, 16.0, "The mirrored closing paragraph carries full sentences as well."),
        ]);
        assert_eq!(role_of(&money, "m2"), LayoutRole::TableCell);
        assert!(!safe_of(&money, "m2"));
    }

    // ── Session-5 R5a: detected alignment (mirrors of the TS cases) ──

    fn align_of(ps: &[ParagraphBox], id: &str) -> Option<DetectedAlign> {
        ps.iter()
            .find(|p| p.id == id)
            .and_then(|p| p.layout.as_ref())
            .and_then(|l| l.align)
    }

    fn with_lines(id: &str, y: f64, specs: &[(f64, f64, &str)]) -> ParagraphBox {
        let min_x = specs.iter().map(|s| s.0).fold(f64::INFINITY, f64::min);
        let max_r = specs
            .iter()
            .map(|s| s.0 + s.1)
            .fold(f64::NEG_INFINITY, f64::max);
        let text = specs
            .iter()
            .map(|s| s.2)
            .collect::<Vec<_>>()
            .join("\n");
        let mut p = para(id, min_x, y, max_r - min_x, specs.len() as f64 * 18.0, &text);
        p.lines = specs
            .iter()
            .enumerate()
            .map(|(i, s)| Line {
                y: y + i as f64 * 18.0,
                font_size: 12.0,
                text: s.2.to_string(),
                item_indices: vec![],
                x: s.0,
                width: s.1,
            })
            .collect();
        p
    }

    #[test]
    fn detected_align_alignment_variants_geometry() {
        let justify = with_lines(
            "jst",
            430.0,
            &[
                (72.0, 468.0, "ALIGN JUSTIFY spreads its words to fill the measure"),
                (72.0, 138.0, "with a natural final line."),
            ],
        );
        let page = classify(vec![
            para("title", 72.0, 50.0, 300.0, 18.0, "Alignment Variants Fixture"),
            para("left", 72.0, 670.0, 300.0, 16.0, "ALIGN LEFT hugs the left margin of the measure here."),
            para("center", 141.0, 590.0, 330.0, 16.0, "ALIGN CENTER floats centered between both margins."),
            para("right", 230.0, 510.0, 310.0, 16.0, "ALIGN RIGHT pushes against the right margin edge."),
            justify,
        ]);
        // Tri-state (gate-2 P1): left-anchored lines are POSITIVELY
        // Left, never a silent absence.
        assert_eq!(align_of(&page, "left"), Some(DetectedAlign::Left));
        assert_eq!(align_of(&page, "title"), Some(DetectedAlign::Left));
        assert_eq!(align_of(&page, "center"), Some(DetectedAlign::Center));
        assert_eq!(align_of(&page, "right"), Some(DetectedAlign::Right));
        assert_eq!(align_of(&page, "jst"), Some(DetectedAlign::Justify));
    }

    #[test]
    fn detected_align_longest_first_line_left_is_not_justify() {
        // Symmetry alone is not corroboration — a second paragraph must
        // share the flush edge for single-evidence-line justify.
        let longest = with_lines(
            "lg",
            200.0,
            &[
                (72.0, 468.0, "A left paragraph whose first rendered line is the longest"),
                (72.0, 160.0, "and the second is shorter."),
            ],
        );
        let degenerate = classify(vec![
            longest,
            para("b1", 72.0, 300.0, 400.0, 16.0, "A second body paragraph keeps the page measure honest here."),
            para("b2", 72.0, 340.0, 350.0, 16.0, "A third body paragraph stays well short of the margin."),
        ]);
        // Uncorroborated flush-both-edges is UNKNOWN — neither a
        // justify nor a left claim.
        assert_eq!(align_of(&degenerate, "lg"), None);
        // Ragged-right shared-left prose is positively Left.
        assert_eq!(align_of(&degenerate, "b1"), Some(DetectedAlign::Left));
    }

    #[test]
    fn detected_align_multi_line_variance_signals() {
        let page = classify(vec![
            with_lines(
                "mc",
                100.0,
                &[
                    (156.0, 300.0, "A centered block line one"),
                    (206.0, 200.0, "centered line two"),
                    (181.0, 250.0, "and centered line three"),
                ],
            ),
            with_lines(
                "mr",
                200.0,
                &[
                    (240.0, 300.0, "a right aligned line one"),
                    (340.0, 200.0, "right line two"),
                ],
            ),
            para("mb", 72.0, 300.0, 440.0, 16.0, "A plain body paragraph keeps the measure anchored at the left."),
        ]);
        assert_eq!(align_of(&page, "mc"), Some(DetectedAlign::Center));
        assert_eq!(align_of(&page, "mr"), Some(DetectedAlign::Right));
    }

    #[test]
    fn detected_align_uncorroborated_cases_stay_undetected() {
        // Page-centered footer over a short ragged body: max right is
        // backed by ONE paragraph and the margins are asymmetric.
        let footer_page = classify(vec![
            para("fb1", 72.0, 100.0, 320.0, 16.0, "Body text on this page ends well before the margin."),
            para("fb2", 72.0, 140.0, 290.0, 16.0, "A second body paragraph is shorter still."),
            para("pgnum", 290.0, 744.0, 33.0, 14.0, "Page 1"),
        ]);
        assert_eq!(align_of(&footer_page, "pgnum"), None);

        // Invoice amounts: flush only against their own right edge.
        let inv = classify(vec![
            para("ititle", 72.0, 34.0, 120.0, 22.0, "Invoice"),
            para("ibill", 72.0, 130.0, 80.0, 16.0, "Bill To:"),
            para("iclient", 230.0, 130.0, 120.0, 16.0, "ACME-1024"),
            para("itotal", 330.0, 620.0, 80.0, 16.0, "Total:"),
            para("iamount", 470.0, 620.0, 90.0, 16.0, "$120.00"),
        ]);
        assert_eq!(align_of(&inv, "iamount"), None);
    }

    #[test]
    fn per_line_segmented_two_column_article_stays_safe() {
        // Differential-caught regression pin: per-LINE segmented
        // article columns (dense short lines) are column prose, not
        // stacks of short cells. Mirrors the TS pin.
        fn line(id: &str, x: f64, y: f64, t: &str) -> ParagraphBox {
            para(id, x, y, 200.0, 14.4, t)
        }
        let per_line = classify(vec![
            line("l1", 72.0, 100.0, "LEFT BODY TARGET starts the"),
            line("l2", 72.0, 116.0, "column with prose, not cells,"),
            line("l3", 72.0, 132.0, "reflowing only on this side."),
            line("l4", 72.0, 170.0, "LEFT BODY FOLLOWER stays in"),
            line("l5", 72.0, 186.0, "the same left-column flow."),
            line("r1", 330.0, 100.0, "RIGHT COLUMN ANCHOR starts"),
            line("r2", 330.0, 116.0, "beside the target but is its"),
            line("r3", 330.0, 132.0, "own column; left edits must"),
            line("r4", 330.0, 170.0, "never pull it sideways at"),
            line("r5", 330.0, 186.0, "any point in the article."),
        ]);
        assert_eq!(role_of(&per_line, "l2"), LayoutRole::MultiColumn);
        assert!(safe_of(&per_line, "l2"));
        assert_eq!(role_of(&per_line, "r2"), LayoutRole::MultiColumn);
        assert!(safe_of(&per_line, "r2"));

        // Sparse label stacks still freeze — density discriminates.
        let sparse = classify(vec![
            line("s1", 72.0, 100.0, "Sector:"),
            line("s2", 72.0, 180.0, "Branch:"),
            line("s3", 72.0, 260.0, "Window:"),
            line("s4", 72.0, 340.0, "Locale:"),
            line("t1", 330.0, 100.0, "Region:"),
            line("t2", 330.0, 180.0, "Tier:"),
            line("t3", 330.0, 260.0, "Owner:"),
            line("t4", 330.0, 340.0, "Desk:"),
        ]);
        assert_eq!(role_of(&sparse, "s1"), LayoutRole::Ambiguous);
        assert!(!safe_of(&sparse, "s1"));
    }

    #[test]
    fn safety_consistency_only_safe_roles_safe() {
        // Mirrors the corpus-sweep invariant: only body, list and
        // multi-column may be safe.
        let mixed = classify(vec![
            para("intro", 72.0, 90.0, 440.0, 14.0, "Format note sits at the top of the body flow region here."),
            para("cell-a", 72.0, 130.0, 90.0, 14.0, "Hosting"),
            para("cell-b", 220.0, 130.0, 60.0, 14.0, "2"),
            para("cell-c", 340.0, 130.0, 90.0, 14.0, "$40.00"),
            para("note", 72.0, 210.0, 380.0, 14.0, "Answer key note explains the row above in plain prose form."),
        ]);
        for p in &mixed {
            let layout = p.layout.as_ref().unwrap();
            if layout.safe_for_auto_reflow {
                assert!(
                    matches!(
                        layout.role,
                        LayoutRole::SingleColumnBody | LayoutRole::ListItem | LayoutRole::MultiColumn
                    ),
                    "unsafe role marked safe: {:?} on {}",
                    layout.role,
                    p.id
                );
            }
        }
        assert!(!safe_of(&mixed, "cell-a"), "quiz-shape grid is unsafe");
    }
}
