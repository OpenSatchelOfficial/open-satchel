//! Paragraph clustering — port of `clusterParagraphs`
//! (src/services/pdfParagraphs.ts, v2 column-aware) operating on
//! core [`TextItem`]s instead of pdfjs items.
//!
//! Algorithm (kept signal-for-signal with the TS oracle):
//! 1. Enrich items with geometry; carry hard-break flags from
//!    empty items with EOL.
//! 2. Group items into LINE SEGMENTS by baseline proximity; within
//!    a line, split on X-gaps > columnGapFactor × fontSize, wide
//!    whitespace items, "Label:"-gap pairs, and meaningful overlap.
//! 3. Cluster segments into PARAGRAPHS by column alignment,
//!    vertical adjacency, and font-size continuity.
//! 4. Emit paragraph boxes with union bboxes and position-based
//!    reproducible ids.

use std::collections::HashMap;

use super::types::{Line, PageContext, ParagraphBox, Rect, TextItem};

/// Tunables — defaults are IDENTICAL to the TS `DEFAULT_OPTS`.
#[derive(Debug, Clone, Copy)]
pub struct ClusteringOptions {
    /// Fraction of fontSize allowed as y-delta within a line.
    pub line_tolerance: f64,
    /// Fraction of fontSize allowed as a gap before paragraphs split.
    pub paragraph_gap_factor: f64,
    /// Multiple of fontSize that counts as a column break in a line.
    pub column_gap_factor: f64,
    /// Max x-offset (pt) between segments to share a column.
    pub column_alignment_tolerance: f64,
    /// Whitespace item ≥ this × fontSize wide = column separator.
    pub whitespace_item_split_factor: f64,
    /// "Label:" followed by ≥ this × fontSize gap forces a split.
    pub label_colon_gap_factor: f64,
}

impl Default for ClusteringOptions {
    fn default() -> Self {
        Self {
            line_tolerance: 0.4,
            paragraph_gap_factor: 1.8,
            column_gap_factor: 0.8,
            column_alignment_tolerance: 8.0,
            whitespace_item_split_factor: 0.8,
            label_colon_gap_factor: 0.3,
        }
    }
}

#[derive(Debug, Clone)]
struct ItemPlus {
    orig: usize,
    text: String,
    x: f64,
    y_top: f64,
    width: f64,
    height: f64,
    font_size: f64,
    baseline_y: f64,
    font_name: String,
    hard_break_before: bool,
}

#[derive(Debug, Clone)]
struct Segment {
    y_top: f64,
    baseline_y: f64,
    font_size: f64,
    items: Vec<ItemPlus>,
    x_left: f64,
    x_right: f64,
    hard_break_before: bool,
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

fn most_common<'a>(values: impl Iterator<Item = &'a str>) -> String {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    let mut best: &str = "";
    let mut best_count = 0usize;
    for v in values {
        let c = counts.entry(v).or_insert(0);
        *c += 1;
        if *c > best_count {
            best = v;
            best_count = *c;
        }
    }
    best.to_string()
}

fn is_whitespace_only(s: &str) -> bool {
    s.chars().all(char::is_whitespace)
}

fn is_bold_name(name: &str) -> bool {
    let l = name.to_lowercase();
    l.contains("bold") || l.contains("black") || l.contains("heavy") || l.contains("semibold")
}

fn is_italic_name(name: &str) -> bool {
    let l = name.to_lowercase();
    l.contains("italic") || l.contains("oblique")
}

/// Port of `normalizeFontFamily` — bare family → sensible stack.
fn normalize_font_family(family: Option<&str>) -> String {
    let Some(family) = family.filter(|f| !f.is_empty()) else {
        return "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif".to_string();
    };
    let f = family.to_lowercase();
    const SERIFISH: [&str; 7] = [
        "times", "serif", "garamond", "georgia", "book", "cambria", "palatino",
    ];
    const MONOISH: [&str; 6] = ["courier", "mono", "console", "consolas", "menlo", "cascadia"];
    if SERIFISH.iter().any(|k| f.contains(k)) {
        return format!("'{family}', 'Times New Roman', Times, serif");
    }
    if MONOISH.iter().any(|k| f.contains(k)) {
        return format!("'{family}', 'Cascadia Code', Consolas, monospace");
    }
    format!("'{family}', -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif")
}

/// Strip a `ABCDEF+` subset prefix for family resolution.
fn base_font_family(font_name: &str) -> &str {
    match font_name.split_once('+') {
        Some((prefix, rest)) if prefix.len() == 6 && prefix.chars().all(|c| c.is_ascii_uppercase()) => rest,
        _ => font_name,
    }
}

/// Cluster extracted text items into paragraph boxes.
///
/// `items` must be in extraction order (the backend's char/run
/// order); geometry is visual page space per [`TextItem`] docs.
pub fn cluster_paragraphs(
    items: &[TextItem],
    ctx: PageContext,
    options: &ClusteringOptions,
) -> Vec<ParagraphBox> {
    let opts = options;

    // ---- 1. enrich + carry hard breaks (port of the items loop) ----
    let mut enriched: Vec<ItemPlus> = Vec::with_capacity(items.len());
    let mut pending_hard_break = false;
    for (i, it) in items.iter().enumerate() {
        if it.text.is_empty() {
            if it.has_eol {
                pending_hard_break = true;
            }
            continue;
        }
        let font_size = it.font_size;
        enriched.push(ItemPlus {
            orig: i,
            text: it.text.clone(),
            x: it.x,
            y_top: it.baseline_y - font_size,
            width: it.width.max(1.0),
            height: font_size * 1.2,
            font_size,
            baseline_y: it.baseline_y,
            font_name: it.font_name.clone(),
            hard_break_before: pending_hard_break,
        });
        pending_hard_break = false;
    }

    // ---- sort by y (top-down), ties by x ----
    // The TS comparator breaks y-ties within a font-size tolerance by
    // x; that relation is not a total order and Rust's sort PANICS on
    // such comparators (caught live on the rotated fixture). Strict
    // (y, x) lexicographic order is used instead — within-line x
    // order is re-established at flush time, so the only behavioral
    // difference is which item anchors a y-line group when baselines
    // differ sub-tolerance. The differential harness measures it.
    enriched.sort_by(|a, b| a.y_top.total_cmp(&b.y_top).then(a.x.total_cmp(&b.x)));

    // ---- 2. line segments ----
    let mut segments: Vec<Segment> = Vec::new();
    let mut current_y_line: Vec<ItemPlus> = Vec::new();
    let mut current_baseline: Option<f64> = None;

    let is_wide_ws = |it: &ItemPlus| -> bool {
        is_whitespace_only(&it.text)
            && it.width >= it.font_size * opts.whitespace_item_split_factor
    };

    let build_segment = |its: Vec<ItemPlus>| -> Segment {
        let x_left = its[0].x;
        let last = &its[its.len() - 1];
        let x_right = last.x + last.width;
        let y_top = its
            .iter()
            .map(|i| i.y_top)
            .fold(f64::INFINITY, f64::min);
        let baseline = median(&its.iter().map(|i| i.baseline_y).collect::<Vec<_>>());
        let font_size = median(&its.iter().map(|i| i.font_size).collect::<Vec<_>>());
        let hard_break_before = its[0].hard_break_before;
        Segment {
            y_top,
            baseline_y: baseline,
            font_size,
            items: its,
            x_left,
            x_right,
            hard_break_before,
        }
    };

    let flush_y_line = |line: &mut Vec<ItemPlus>, segments: &mut Vec<Segment>| {
        if line.is_empty() {
            return;
        }
        line.sort_by(|a, b| a.x.total_cmp(&b.x));

        let mut split_before: std::collections::HashSet<usize> = std::collections::HashSet::new();
        let mut drop_items: std::collections::HashSet<usize> = std::collections::HashSet::new();

        // Leading wide-whitespace = layout gap, not content.
        if !line.is_empty() && is_wide_ws(&line[0]) {
            drop_items.insert(0);
            split_before.insert(1);
        }

        for i in 1..line.len() {
            let prev = &line[i - 1];
            let cur = &line[i];
            let gap = cur.x - (prev.x + prev.width);
            let fs = prev.font_size.max(cur.font_size);

            // Signal 1 — visible x-gap between non-whitespace atoms.
            let gap_split = gap > fs * opts.column_gap_factor;

            // Signal 2 — synthetic wide-space items encode column gaps.
            let cur_wide = is_wide_ws(cur);
            let prev_wide = is_wide_ws(prev);

            // Signal 3 — "Label:" + nontrivial gap + value.
            let prev_str = prev.text.trim_end();
            let colon_split = prev_str.ends_with(':') && gap >= fs * opts.label_colon_gap_factor;

            // Signal 4 — meaningful overlap = overprinted text objects.
            let overlap_split = !cur_wide && !prev_wide && gap < -fs * 0.25;

            if cur_wide {
                split_before.insert(i + 1);
                drop_items.insert(i);
            } else if prev_wide
                || cur.hard_break_before
                || gap_split
                || colon_split
                || overlap_split
            {
                // (TS keeps prev_wide as a separate branch; the
                // action is identical, merged for clippy.)
                split_before.insert(i);
            }
        }

        let emit_segment =
            |from: usize, to: usize, line: &[ItemPlus], segments: &mut Vec<Segment>| {
                let its: Vec<ItemPlus> = (from..to)
                    .filter(|k| !drop_items.contains(k))
                    .map(|k| line[k].clone())
                    .collect();
                if its.is_empty() {
                    return;
                }
                if !its.iter().any(|it| !is_whitespace_only(&it.text)) {
                    return;
                }
                segments.push(build_segment(its));
            };

        let mut seg_start = 0usize;
        for i in 1..=line.len() {
            if i == line.len() || split_before.contains(&i) {
                emit_segment(seg_start, i, line, segments);
                seg_start = i;
            }
        }
        line.clear();
    };

    for it in enriched.into_iter() {
        let tol = it.font_size * opts.line_tolerance;
        match current_baseline {
            Some(b) if (it.baseline_y - b).abs() <= tol => {
                current_y_line.push(it);
            }
            _ => {
                flush_y_line(&mut current_y_line, &mut segments);
                current_baseline = Some(it.baseline_y);
                current_y_line.push(it);
            }
        }
    }
    flush_y_line(&mut current_y_line, &mut segments);

    // ---- sort segments top-down, left-right (strict total order,
    // same rationale as the item sort above) ----
    segments.sort_by(|a, b| a.y_top.total_cmp(&b.y_top).then(a.x_left.total_cmp(&b.x_left)));

    // ---- 3. cluster segments into paragraphs ----
    let mut paragraphs: Vec<ParagraphBox> = Vec::new();
    let mut current_para: Vec<Segment> = Vec::new();
    let mut paragraph_id_counts: HashMap<String, usize> = HashMap::new();

    let flush_para = |current_para: &mut Vec<Segment>,
                          paragraphs: &mut Vec<ParagraphBox>,
                          paragraph_id_counts: &mut HashMap<String, usize>| {
        if current_para.is_empty() {
            return;
        }
        let mut item_indices: Vec<usize> = Vec::new();
        let mut all_lines: Vec<Line> = Vec::new();
        let mut min_x = f64::INFINITY;
        let mut min_y = f64::INFINITY;
        let mut max_x = f64::NEG_INFINITY;
        let mut max_y = f64::NEG_INFINITY;
        let mut font_sizes: Vec<f64> = Vec::new();
        let mut font_names: Vec<String> = Vec::new();
        let mut texts: Vec<String> = Vec::new();

        for seg in current_para.iter() {
            let line_text: String = seg.items.iter().map(|i| i.text.as_str()).collect();
            let line_item_idx: Vec<usize> = seg.items.iter().map(|i| i.orig).collect();
            all_lines.push(Line {
                y: seg.y_top,
                font_size: seg.font_size,
                text: line_text.clone(),
                item_indices: line_item_idx,
                x: seg.x_left,
                width: seg.x_right - seg.x_left,
            });
            texts.push(line_text);
            for it in seg.items.iter() {
                item_indices.push(it.orig);
                font_sizes.push(it.font_size);
                font_names.push(it.font_name.clone());
                min_x = min_x.min(it.x);
                min_y = min_y.min(it.y_top);
                // Only glyph-bearing items extend the right edge —
                // wide layout whitespace must not balloon the mask.
                if !is_whitespace_only(&it.text) {
                    max_x = max_x.max(it.x + it.width);
                }
                max_y = max_y.max(it.y_top + it.height);
            }
        }
        if max_x == f64::NEG_INFINITY {
            for seg in current_para.iter() {
                max_x = max_x.max(seg.x_right);
            }
        }

        let font_name = most_common(font_names.iter().map(|s| s.as_str()));
        let med_font_size = median(&font_sizes);
        let resolved_family = base_font_family(&font_name);
        let bold =
            is_bold_name(&font_name) || is_bold_name(resolved_family) || med_font_size >= 20.0;
        let base_id = format!(
            "p_{}_{}_{}",
            ctx.page_index,
            min_x.round() as i64,
            min_y.round() as i64
        );
        let collision_count = *paragraph_id_counts.get(&base_id).unwrap_or(&0);
        paragraph_id_counts.insert(base_id.clone(), collision_count + 1);
        let first_item_index = item_indices.iter().min().copied().unwrap_or(paragraphs.len());
        let paragraph_id = if collision_count == 0 {
            base_id
        } else {
            format!("{base_id}_i{first_item_index}")
        };

        paragraphs.push(ParagraphBox {
            id: paragraph_id,
            item_indices,
            lines: all_lines,
            bbox: Rect {
                x: min_x,
                y: min_y,
                width: max_x - min_x,
                height: max_y - min_y,
            },
            original_text: texts.join("\n"),
            font_size: med_font_size,
            font_name: font_name.clone(),
            font_family: normalize_font_family(Some(resolved_family)),
            bold,
            italic: is_italic_name(&font_name) || is_italic_name(resolved_family),
            layout: None,
        });
        current_para.clear();
    };

    let mut prev: Option<Segment> = None;
    for seg in segments.into_iter() {
        let Some(p) = prev.as_ref() else {
            current_para = vec![seg.clone()];
            prev = Some(seg);
            continue;
        };
        let col_aligned = (seg.x_left - p.x_left).abs() <= opts.column_alignment_tolerance;
        let expected_gap = (p.font_size + seg.font_size) / 2.0;
        let baseline_gap = seg.baseline_y - p.baseline_y;
        let gap_ok = baseline_gap > 0.0 && baseline_gap <= expected_gap * opts.paragraph_gap_factor;
        let font_size_ratio =
            p.font_size.max(seg.font_size) / p.font_size.min(seg.font_size).max(1.0);
        let size_compat = font_size_ratio <= 1.5;
        if !seg.hard_break_before && col_aligned && gap_ok && size_compat {
            current_para.push(seg.clone());
        } else {
            flush_para(&mut current_para, &mut paragraphs, &mut paragraph_id_counts);
            current_para = vec![seg.clone()];
        }
        prev = Some(seg);
    }
    flush_para(&mut current_para, &mut paragraphs, &mut paragraph_id_counts);

    paragraphs
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(text: &str, x: f64, baseline_y: f64, width: f64, font_size: f64) -> TextItem {
        TextItem {
            text: text.to_string(),
            x,
            baseline_y,
            width,
            font_size,
            font_name: "Helvetica".to_string(),
            has_eol: false,
        }
    }

    fn ctx() -> PageContext {
        PageContext {
            page_index: 0,
            page_width: 612.0,
            page_height: 792.0,
        }
    }

    #[test]
    fn two_lines_same_column_become_one_paragraph() {
        let items = vec![
            item("First line of prose", 72.0, 112.0, 200.0, 12.0),
            item("second line continues.", 72.0, 126.0, 210.0, 12.0),
        ];
        let paras = cluster_paragraphs(&items, ctx(), &ClusteringOptions::default());
        assert_eq!(paras.len(), 1, "{paras:#?}");
        assert_eq!(paras[0].lines.len(), 2);
        assert_eq!(
            paras[0].original_text,
            "First line of prose\nsecond line continues."
        );
    }

    #[test]
    fn wide_gap_on_same_baseline_splits_columns() {
        let items = vec![
            item("Invoice", 72.0, 112.0, 60.0, 12.0),
            item("Date: 2026-06-11", 400.0, 112.0, 110.0, 12.0),
        ];
        let paras = cluster_paragraphs(&items, ctx(), &ClusteringOptions::default());
        assert_eq!(paras.len(), 2, "{paras:#?}");
    }

    #[test]
    fn wide_whitespace_item_splits_columns() {
        let items = vec![
            item("Invoice", 72.0, 112.0, 60.0, 12.0),
            item("   ", 132.0, 112.0, 239.0, 12.0),
            item("Date:", 371.0, 112.0, 40.0, 12.0),
        ];
        let paras = cluster_paragraphs(&items, ctx(), &ClusteringOptions::default());
        assert_eq!(paras.len(), 2, "{paras:#?}");
        // The wide whitespace must not balloon the left box's mask.
        let invoice = paras.iter().find(|p| p.original_text == "Invoice").unwrap();
        assert!(invoice.bbox.width <= 61.0, "{:?}", invoice.bbox);
    }

    #[test]
    fn label_colon_gap_splits() {
        let items = vec![
            item("Date:", 72.0, 112.0, 40.0, 12.0),
            item("2026-06-11", 118.0, 112.0, 70.0, 12.0),
        ];
        let paras = cluster_paragraphs(&items, ctx(), &ClusteringOptions::default());
        assert_eq!(paras.len(), 2, "{paras:#?}");
    }

    #[test]
    fn paragraph_gap_breaks_clusters() {
        let items = vec![
            item("Para one.", 72.0, 112.0, 100.0, 12.0),
            item("Para two after a large gap.", 72.0, 200.0, 200.0, 12.0),
        ];
        let paras = cluster_paragraphs(&items, ctx(), &ClusteringOptions::default());
        assert_eq!(paras.len(), 2);
    }

    #[test]
    fn heading_size_jump_breaks_cluster() {
        let items = vec![
            item("Big Heading", 72.0, 110.0, 160.0, 24.0),
            item("body text right under it", 72.0, 130.0, 180.0, 12.0),
        ];
        let paras = cluster_paragraphs(&items, ctx(), &ClusteringOptions::default());
        assert_eq!(paras.len(), 2, "{paras:#?}");
        assert!(paras[0].bold, "heading-size bold heuristic");
    }

    #[test]
    fn ids_are_reproducible_and_collision_safe() {
        let items = vec![
            item("Alpha", 72.0, 112.0, 50.0, 12.0),
            item("Beta", 400.0, 112.0, 50.0, 12.0),
        ];
        let a = cluster_paragraphs(&items, ctx(), &ClusteringOptions::default());
        let b = cluster_paragraphs(&items, ctx(), &ClusteringOptions::default());
        assert_eq!(
            a.iter().map(|p| p.id.clone()).collect::<Vec<_>>(),
            b.iter().map(|p| p.id.clone()).collect::<Vec<_>>()
        );
        assert!(a[0].id.starts_with("p_0_"));
    }

    #[test]
    fn empty_input_yields_no_paragraphs() {
        let paras = cluster_paragraphs(&[], ctx(), &ClusteringOptions::default());
        assert!(paras.is_empty());
    }
}
