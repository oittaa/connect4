//! Exact scores from completed solves, distinct from the opening book and TT.
//!
//! - Book: dense, shallow, depth-gated binary search (`key3`).
//! - TT: bounds, always-replace, session-only.
//! - This table: sparse exact scores at any depth, O(1) in search, persisted
//!   as one blob. Uses the 49-bit canonical bitboard key (`key3` only fits in
//!   32 bits through 14 ply).
//!
//! File layout (little-endian):
//!   magic:    b"C4PC"
//!   version:  u8 = 1
//!   reserved: [u8; 3]
//!   count:    u32
//!   entries:  count × (u64 key, i8 score, u8 ncols, [i8; ncols])
//!   `ncols` is 0 or 7. Column `i8::MIN` means unplayable (`INVALID_MOVE`).

use crate::position::WIDTH;
use std::collections::{HashMap, VecDeque};

/// Unplayable column, packed as `i8::MIN`. Matches `solver::INVALID_MOVE`.
const COL_INVALID: i32 = -1000;

const MAGIC: &[u8; 4] = b"C4PC";
const VERSION: u8 = 1;
pub const DEFAULT_MAX: usize = 50_000;

#[derive(Clone, Copy, Debug)]
pub struct ProvenEntry {
    pub score: i8,
    pub cols: Option<[i8; WIDTH]>,
}

#[derive(Clone, Debug)]
pub struct ProvenTable {
    map: HashMap<u64, ProvenEntry>,
    /// Oldest-first insertion order for FIFO eviction.
    order: VecDeque<u64>,
    max: usize,
}

impl Default for ProvenTable {
    fn default() -> Self {
        Self::new()
    }
}

impl ProvenTable {
    pub fn new() -> Self {
        Self::with_max(DEFAULT_MAX)
    }

    pub fn with_max(max: usize) -> Self {
        let max = max.max(1);
        Self {
            map: HashMap::with_capacity(max.min(1024)),
            order: VecDeque::with_capacity(max.min(1024)),
            max,
        }
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    pub fn get(&self, key: u64) -> Option<i32> {
        self.map.get(&key).map(|e| e.score as i32)
    }

    pub fn get_entry(&self, key: u64) -> Option<&ProvenEntry> {
        self.map.get(&key)
    }

    /// Insert or update. Existing column scores are kept unless `cols` is `Some`.
    pub fn insert(&mut self, key: u64, score: i8, cols: Option<[i8; WIDTH]>) {
        if let Some(e) = self.map.get_mut(&key) {
            e.score = score;
            if cols.is_some() {
                e.cols = cols;
            }
            return;
        }
        while self.map.len() >= self.max {
            if let Some(old) = self.order.pop_front() {
                self.map.remove(&old);
            } else {
                break;
            }
        }
        self.map.insert(key, ProvenEntry { score, cols });
        self.order.push_back(key);
    }

    pub fn insert_score(&mut self, key: u64, score: i8) {
        self.insert(key, score, None);
    }

    /// Union with another table. Existing keys keep their score; missing column
    /// scores are filled in. New keys append (and may FIFO-evict).
    pub fn merge(&mut self, other: &ProvenTable) {
        for &key in &other.order {
            let Some(incoming) = other.map.get(&key) else {
                continue;
            };
            if let Some(e) = self.map.get_mut(&key) {
                if e.cols.is_none() {
                    e.cols = incoming.cols;
                }
                continue;
            }
            self.insert(key, incoming.score, incoming.cols);
        }
    }

    pub fn save(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(12 + self.order.len() * 17);
        out.extend_from_slice(MAGIC);
        out.push(VERSION);
        out.extend_from_slice(&[0, 0, 0]);
        out.extend_from_slice(&0u32.to_le_bytes());
        let mut n = 0u32;
        for &key in &self.order {
            let Some(e) = self.map.get(&key) else {
                continue;
            };
            out.extend_from_slice(&key.to_le_bytes());
            out.push(e.score as u8);
            match e.cols {
                Some(c) => {
                    out.push(WIDTH as u8);
                    for x in c {
                        out.push(x as u8);
                    }
                }
                None => out.push(0),
            }
            n += 1;
        }
        out[8..12].copy_from_slice(&n.to_le_bytes());
        out
    }

    pub fn load(bytes: &[u8]) -> Result<Self, String> {
        Self::load_with_max(bytes, DEFAULT_MAX)
    }

    pub fn load_with_max(bytes: &[u8], max: usize) -> Result<Self, String> {
        if bytes.len() < 12 {
            return Err("proven cache too small".into());
        }
        if &bytes[0..4] != MAGIC {
            return Err("bad proven-cache magic".into());
        }
        if bytes[4] != VERSION {
            return Err(format!("unsupported proven-cache version {}", bytes[4]));
        }
        let count = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
        let mut table = Self::with_max(max);
        let mut off = 12;
        let skip = count.saturating_sub(max);
        for i in 0..count {
            if off + 10 > bytes.len() {
                return Err("truncated proven cache".into());
            }
            let key = u64::from_le_bytes(bytes[off..off + 8].try_into().unwrap());
            let score = bytes[off + 8] as i8;
            let ncols = bytes[off + 9] as usize;
            off += 10;
            let cols = if ncols == 0 {
                None
            } else if ncols == WIDTH {
                if off + WIDTH > bytes.len() {
                    return Err("truncated proven cache columns".into());
                }
                let mut c = [0i8; WIDTH];
                for (j, slot) in c.iter_mut().enumerate() {
                    *slot = bytes[off + j] as i8;
                }
                off += WIDTH;
                Some(c)
            } else {
                return Err(format!("bad column count {ncols}"));
            };
            if i < skip {
                continue;
            }
            table.insert(key, score, cols);
        }
        Ok(table)
    }
}

/// Reverse columns when the board is the mirror of the canonical key.
pub fn orient_cols(mut cols: [i8; WIDTH], mirrored: bool) -> [i8; WIDTH] {
    if mirrored {
        cols.reverse();
    }
    cols
}

pub fn pack_cols(scores: &[i32; WIDTH]) -> [i8; WIDTH] {
    let mut out = [0i8; WIDTH];
    for (i, &s) in scores.iter().enumerate() {
        out[i] = if s == COL_INVALID { i8::MIN } else { s as i8 };
    }
    out
}

pub fn unpack_cols(cols: &[i8; WIDTH]) -> [i32; WIDTH] {
    let mut out = [0i32; WIDTH];
    for (i, &s) in cols.iter().enumerate() {
        out[i] = if s == i8::MIN { COL_INVALID } else { s as i32 };
    }
    out
}

pub fn best_of(scores: &[i32; WIDTH]) -> Option<i32> {
    scores.iter().copied().filter(|&s| s != COL_INVALID).max()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_blob() {
        let mut t = ProvenTable::with_max(8);
        t.insert(1, 4, None);
        t.insert(2, -3, Some([1, i8::MIN, 0, -1, 2, 1, 0]));
        t.insert_score(1, 5); // keep cols (none) and update score
        let bytes = t.save();
        let t2 = ProvenTable::load_with_max(&bytes, 8).unwrap();
        assert_eq!(t2.len(), 2);
        assert_eq!(t2.get(1), Some(5));
        let e = t2.get_entry(2).unwrap();
        assert_eq!(e.score, -3);
        assert_eq!(unpack_cols(&e.cols.unwrap())[1], COL_INVALID);
        assert_eq!(COL_INVALID, crate::solver::INVALID_MOVE);
    }

    #[test]
    fn fifo_eviction() {
        let mut t = ProvenTable::with_max(2);
        t.insert_score(10, 1);
        t.insert_score(20, 2);
        t.insert_score(30, 3);
        assert_eq!(t.len(), 2);
        assert!(t.get(10).is_none());
        assert_eq!(t.get(20), Some(2));
        assert_eq!(t.get(30), Some(3));
        t.insert_score(20, 9); // update must not duplicate / shuffle FIFO
        t.insert_score(40, 4);
        assert!(t.get(20).is_none(), "20 was still oldest after update");
        assert_eq!(t.get(30), Some(3));
        assert_eq!(t.get(40), Some(4));
    }

    #[test]
    fn update_keeps_columns() {
        let mut t = ProvenTable::new();
        t.insert(7, 1, Some([0; WIDTH]));
        t.insert_score(7, 2);
        assert_eq!(t.get_entry(7).unwrap().cols, Some([0; WIDTH]));
        assert_eq!(t.get(7), Some(2));
    }

    #[test]
    fn rejects_bad_magic() {
        assert!(ProvenTable::load(b"XXXX").is_err());
        assert!(ProvenTable::load(&[]).is_err());
    }

    #[test]
    fn merge_keeps_both_and_fills_columns() {
        let mut a = ProvenTable::with_max(8);
        a.insert_score(1, 4);
        a.insert_score(2, 0);
        let mut b = ProvenTable::with_max(8);
        b.insert(1, 4, Some([1; WIDTH]));
        b.insert_score(3, -2);
        a.merge(&b);
        assert_eq!(a.len(), 3);
        assert_eq!(a.get(1), Some(4));
        assert_eq!(a.get_entry(1).unwrap().cols, Some([1; WIDTH]));
        assert_eq!(a.get(2), Some(0));
        assert_eq!(a.get(3), Some(-2));
    }

    #[test]
    fn orient_reverses_when_mirrored() {
        let cols = [0i8, 1, 2, 3, 4, 5, 6];
        assert_eq!(orient_cols(cols, false), cols);
        assert_eq!(orient_cols(cols, true), [6, 5, 4, 3, 2, 1, 0]);
    }
}
