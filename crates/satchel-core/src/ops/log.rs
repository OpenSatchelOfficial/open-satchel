//! Append-only operation log with inversion-based undo/redo and
//! checkpointed replay — the core-owned history every UI history
//! eventually maps onto (see `docs/storm/UNDO-UNIFICATION.md`).
//!
//! Design:
//! - Every appended [`Op`] is applied to the materialized
//!   [`EditModel`] and stored together with its **inverse**,
//!   computed against the model state at apply time. Undo applies
//!   the inverse; redo re-applies the op. No snapshot diffing.
//! - `undo_boundary` marks the END of a logical undo unit (matches
//!   the shell's `live::model::LogEntry` semantics): [`OpLog::undo`]
//!   walks back one unit, [`OpLog::undo_entry`] one entry.
//! - Checkpoints capture the full model every `checkpoint_interval`
//!   entries; [`OpLog::state_at`] restores any version via nearest
//!   checkpoint + replay instead of replaying from genesis.
//! - Appending after undo truncates the redo tail (standard
//!   linear-history behavior).

use serde::{Deserialize, Serialize};

use super::model::{EditModel, Op};

/// One entry in the log: the op, its precomputed inverse, and the
/// boundary/bookkeeping the shell's log already carried.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpLogEntry {
    /// Monotonic version assigned at append (1-based).
    pub version: u64,
    /// The applied operation.
    pub op: Op,
    /// Inverse of `op` against the model state it was applied to.
    /// Absent in logs written by the pre-core shell; recomputable by
    /// replaying from genesis.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inverse: Option<Op>,
    /// Marks the end of a logical undo unit.
    #[serde(default, rename = "undoBoundary")]
    pub undo_boundary: bool,
    /// Unix epoch seconds.
    pub timestamp: u64,
}

/// A full-model snapshot at a version, for O(interval) restores.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Checkpoint {
    /// Version the snapshot was taken at.
    pub version: u64,
    /// The complete model state at that version.
    pub model: EditModel,
}

/// Default checkpoint cadence (entries between snapshots).
pub const DEFAULT_CHECKPOINT_INTERVAL: usize = 64;

/// The canonical operation log.
#[derive(Debug, Clone)]
pub struct OpLog {
    initial: EditModel,
    model: EditModel,
    entries: Vec<OpLogEntry>,
    /// Entries `[0, cursor)` are applied; `[cursor, len)` is the
    /// redo tail.
    cursor: usize,
    checkpoints: Vec<Checkpoint>,
    checkpoint_interval: usize,
}

impl OpLog {
    /// Start a log from an initial model with the default
    /// checkpoint cadence.
    pub fn new(initial: EditModel) -> Self {
        Self::with_checkpoint_interval(initial, DEFAULT_CHECKPOINT_INTERVAL)
    }

    /// Start a log with an explicit checkpoint cadence
    /// (`interval >= 1`).
    pub fn with_checkpoint_interval(initial: EditModel, interval: usize) -> Self {
        Self {
            model: initial.clone(),
            initial,
            entries: Vec::new(),
            cursor: 0,
            checkpoints: Vec::new(),
            checkpoint_interval: interval.max(1),
        }
    }

    /// The current materialized model.
    pub fn model(&self) -> &EditModel {
        &self.model
    }

    /// Version of the last applied entry (0 when none).
    pub fn version(&self) -> u64 {
        if self.cursor == 0 {
            0
        } else {
            self.entries[self.cursor - 1].version
        }
    }

    /// All entries (applied + redo tail), in version order.
    pub fn entries(&self) -> &[OpLogEntry] {
        &self.entries
    }

    /// Snapshots taken so far (only at versions ≤ the current
    /// cursor — truncated alongside the redo tail).
    pub fn checkpoints(&self) -> &[Checkpoint] {
        &self.checkpoints
    }

    /// Apply `op`, record it with its inverse, and return the new
    /// version. Discards any redo tail.
    pub fn append(&mut self, op: Op, undo_boundary: bool, timestamp: u64) -> u64 {
        // Truncate redo tail + any checkpoints past the cursor.
        self.entries.truncate(self.cursor);
        let cut = self.version();
        self.checkpoints.retain(|c| c.version <= cut);

        let inverse = invert(&self.model, &op);
        self.model.apply(&op);
        let version = self.entries.last().map(|e| e.version).unwrap_or(0) + 1;
        self.model.version = version;
        self.entries.push(OpLogEntry {
            version,
            op,
            inverse: Some(inverse),
            undo_boundary,
            timestamp,
        });
        self.cursor = self.entries.len();

        if self.cursor % self.checkpoint_interval == 0 {
            self.checkpoints.push(Checkpoint {
                version,
                model: self.model.clone(),
            });
        }
        version
    }

    /// Undo a single entry. Returns `false` at the beginning of
    /// history.
    pub fn undo_entry(&mut self) -> bool {
        if self.cursor == 0 {
            return false;
        }
        self.cursor -= 1;
        let entry = &self.entries[self.cursor];
        let inverse = entry
            .inverse
            .clone()
            .expect("entries appended through OpLog always carry an inverse");
        self.model.apply(&inverse);
        self.model.version = self.version();
        true
    }

    /// Redo a single entry. Returns `false` when the redo tail is
    /// empty.
    pub fn redo_entry(&mut self) -> bool {
        if self.cursor == self.entries.len() {
            return false;
        }
        let entry = self.entries[self.cursor].clone();
        self.model.apply(&entry.op);
        self.model.version = entry.version;
        self.cursor += 1;
        true
    }

    /// Undo one logical unit: entries back to (and including) the
    /// previous `undo_boundary`. Returns the number of entries
    /// undone.
    pub fn undo(&mut self) -> usize {
        let mut undone = 0;
        while self.undo_entry() {
            undone += 1;
            // Stop when the NEXT entry back ends an earlier unit —
            // i.e. we've fully unwound the current unit.
            if self.cursor == 0 || self.entries[self.cursor - 1].undo_boundary {
                break;
            }
        }
        undone
    }

    /// Redo one logical unit (through the next `undo_boundary`).
    /// Returns the number of entries redone.
    pub fn redo(&mut self) -> usize {
        let mut redone = 0;
        while self.redo_entry() {
            redone += 1;
            if self.entries[self.cursor - 1].undo_boundary {
                break;
            }
        }
        redone
    }

    /// Reconstruct the model as of `version` (0 = initial state)
    /// using the nearest checkpoint at-or-before it plus replay.
    /// Versions past the end clamp to the last entry.
    pub fn state_at(&self, version: u64) -> EditModel {
        let (mut model, from) = match self
            .checkpoints
            .iter()
            .rev()
            .find(|c| c.version <= version)
        {
            Some(c) => (c.model.clone(), c.version),
            None => (self.initial.clone(), 0),
        };
        for entry in &self.entries {
            if entry.version <= from {
                continue;
            }
            if entry.version > version {
                break;
            }
            model.apply(&entry.op);
            model.version = entry.version;
        }
        model
    }
}

/// Compute the inverse of `op` against the model state it is about
/// to be applied to.
fn invert(model: &EditModel, op: &Op) -> Op {
    match op {
        Op::UpsertEdit { page, edit } => match model.find_edit(*page, &edit.paragraph_id) {
            Some(prior) => Op::UpsertEdit {
                page: *page,
                edit: Box::new(prior.clone()),
            },
            None => Op::DropEdit {
                page: *page,
                paragraph_id: edit.paragraph_id.clone(),
            },
        },
        Op::DropEdit { page, paragraph_id } => match model.find_edit(*page, paragraph_id) {
            // Re-upserting the dropped edit would push it at the END
            // of the page's list, losing its original position (found
            // by the apply_then_invert_is_identity property test).
            // Snapshot the whole page instead — position-exact.
            Some(_) => Op::ReplacePage {
                page: *page,
                edits: model
                    .pages
                    .get(page)
                    .map(|p| p.paragraphs.clone())
                    .unwrap_or_default(),
            },
            // Dropping a nonexistent edit is a no-op; its inverse is
            // the same no-op.
            None => Op::DropEdit {
                page: *page,
                paragraph_id: paragraph_id.clone(),
            },
        },
        Op::ReplacePage { page, .. } => Op::ReplacePage {
            page: *page,
            edits: model
                .pages
                .get(page)
                .map(|p| p.paragraphs.clone())
                .unwrap_or_default(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::model::{Bbox, ParagraphEdit};
    use proptest::prelude::*;

    fn edit(id: &str, text: &str) -> ParagraphEdit {
        ParagraphEdit {
            paragraph_id: id.to_string(),
            bbox: Bbox {
                x: 1.0,
                y: 2.0,
                width: 30.0,
                height: 10.0,
            },
            original_text: "orig".into(),
            new_text: text.into(),
            font_size: 11.0,
            ..Default::default()
        }
    }

    #[test]
    fn undo_redo_single_entries() {
        let mut log = OpLog::new(EditModel::default());
        log.append(
            Op::UpsertEdit {
                page: 0,
                edit: Box::new(edit("p1", "a")),
            },
            true,
            1,
        );
        log.append(
            Op::UpsertEdit {
                page: 0,
                edit: Box::new(edit("p1", "b")),
            },
            true,
            2,
        );
        assert_eq!(log.model().find_edit(0, "p1").unwrap().new_text, "b");

        assert!(log.undo_entry());
        assert_eq!(log.model().find_edit(0, "p1").unwrap().new_text, "a");
        assert!(log.undo_entry());
        assert!(log.model().is_empty());
        assert!(!log.undo_entry());

        assert!(log.redo_entry());
        assert_eq!(log.model().find_edit(0, "p1").unwrap().new_text, "a");
        assert!(log.redo_entry());
        assert_eq!(log.model().find_edit(0, "p1").unwrap().new_text, "b");
        assert!(!log.redo_entry());
    }

    #[test]
    fn append_after_undo_truncates_redo_tail() {
        let mut log = OpLog::new(EditModel::default());
        log.append(
            Op::UpsertEdit {
                page: 0,
                edit: Box::new(edit("p1", "a")),
            },
            true,
            1,
        );
        log.append(
            Op::UpsertEdit {
                page: 0,
                edit: Box::new(edit("p1", "b")),
            },
            true,
            2,
        );
        log.undo_entry();
        log.append(
            Op::UpsertEdit {
                page: 0,
                edit: Box::new(edit("p1", "c")),
            },
            true,
            3,
        );
        assert_eq!(log.entries().len(), 2);
        assert_eq!(log.model().find_edit(0, "p1").unwrap().new_text, "c");
        assert!(!log.redo_entry());
    }

    #[test]
    fn boundary_undo_unwinds_whole_unit() {
        let mut log = OpLog::new(EditModel::default());
        // Unit 1: two entries, boundary on the second.
        log.append(
            Op::UpsertEdit {
                page: 0,
                edit: Box::new(edit("p1", "a")),
            },
            false,
            1,
        );
        log.append(
            Op::UpsertEdit {
                page: 0,
                edit: Box::new(edit("p2", "b")),
            },
            true,
            2,
        );
        // Unit 2: one entry.
        log.append(
            Op::UpsertEdit {
                page: 0,
                edit: Box::new(edit("p3", "c")),
            },
            true,
            3,
        );

        assert_eq!(log.undo(), 1, "undo unit 2");
        assert!(log.model().find_edit(0, "p3").is_none());
        assert_eq!(log.undo(), 2, "undo unit 1 (both entries)");
        assert!(log.model().is_empty());
        assert_eq!(log.redo(), 2, "redo unit 1");
        assert!(log.model().find_edit(0, "p2").is_some());
    }

    #[test]
    fn state_at_uses_checkpoints() {
        let mut log = OpLog::with_checkpoint_interval(EditModel::default(), 2);
        for (i, id) in ["p1", "p2", "p3", "p4", "p5"].iter().enumerate() {
            log.append(
                Op::UpsertEdit {
                    page: 0,
                    edit: Box::new(edit(id, "t")),
                },
                true,
                i as u64,
            );
        }
        assert_eq!(log.checkpoints().len(), 2, "checkpoints at v2 and v4");
        let at3 = log.state_at(3);
        assert_eq!(at3.pages.get(&0).unwrap().paragraphs.len(), 3);
        assert_eq!(at3.version, 3);
        let at0 = log.state_at(0);
        assert!(at0.is_empty());
    }

    // ---- property tests --------------------------------------------------

    fn arb_edit() -> impl Strategy<Value = ParagraphEdit> {
        (
            prop::sample::select(vec!["p1", "p2", "p3", "p4"]),
            "[a-z]{0,6}",
            0.0f32..500.0,
        )
            .prop_map(|(id, text, x)| {
                let mut e = edit(id, &text);
                e.bbox.x = x;
                e
            })
    }

    fn arb_op() -> impl Strategy<Value = Op> {
        prop_oneof![
            (0u32..3, arb_edit()).prop_map(|(page, edit)| Op::UpsertEdit { page, edit: Box::new(edit) }),
            (0u32..3, prop::sample::select(vec!["p1", "p2", "p3", "p4"])).prop_map(
                |(page, id)| Op::DropEdit {
                    page,
                    paragraph_id: id.to_string(),
                }
            ),
            (0u32..3, prop::collection::vec(arb_edit(), 0..3)).prop_map(|(page, edits)| {
                Op::ReplacePage { page, edits }
            }),
        ]
    }

    /// Build a non-trivial starting model from ops (keeps the
    /// identity property covering non-empty initial states).
    fn arb_initial() -> impl Strategy<Value = EditModel> {
        prop::collection::vec(arb_op(), 0..6).prop_map(|ops| {
            let mut m = EditModel::default();
            for op in &ops {
                m.apply(op);
            }
            m
        })
    }

    proptest! {
        /// apply-all → undo-all returns exactly the initial model.
        #[test]
        fn apply_then_invert_is_identity(
            initial in arb_initial(),
            ops in prop::collection::vec(arb_op(), 1..40),
        ) {
            let mut log = OpLog::new(initial.clone());
            for (i, op) in ops.iter().enumerate() {
                log.append(op.clone(), true, i as u64);
            }
            while log.undo_entry() {}
            let mut unwound = log.model().clone();
            // version bookkeeping aside, the state must match.
            unwound.version = initial.version;
            prop_assert_eq!(unwound, initial);
        }

        /// undo-all → redo-all returns the final model.
        #[test]
        fn undo_then_redo_restores_final_state(
            ops in prop::collection::vec(arb_op(), 1..40),
        ) {
            let mut log = OpLog::new(EditModel::default());
            for (i, op) in ops.iter().enumerate() {
                log.append(op.clone(), true, i as u64);
            }
            let final_state = log.model().clone();
            while log.undo_entry() {}
            while log.redo_entry() {}
            prop_assert_eq!(log.model().clone(), final_state);
        }

        /// checkpoint + replay (state_at) equals direct application
        /// at every version.
        #[test]
        fn state_at_equals_direct_apply(
            ops in prop::collection::vec(arb_op(), 1..40),
            interval in 1usize..8,
        ) {
            let mut log = OpLog::with_checkpoint_interval(EditModel::default(), interval);
            for (i, op) in ops.iter().enumerate() {
                log.append(op.clone(), true, i as u64);
            }
            // Direct apply, no checkpoints involved.
            let mut direct = EditModel::default();
            for (i, op) in ops.iter().enumerate() {
                direct.apply(op);
                direct.version = i as u64 + 1;
                prop_assert_eq!(log.state_at(i as u64 + 1), direct.clone());
            }
        }
    }
}
