//! Compact score book: sorted Pons `key3` values, binary search.
//!
//! `key3` is a mirrored base-3 encoding (smaller than the 49-bit bitboard key).
//!
//! File layout (little-endian), version 2:
//!   magic:     b"C4BK"
//!   version:   u8 = 2
//!   depth:     u8
//!   key_bytes: u8 = 4
//!   reserved:  u8 = 0
//!   count:     u32
//!   entries:   count × (u32 key3, i8 score)

use crate::position::Position;

const MAGIC: &[u8; 4] = b"C4BK";
const VERSION: u8 = 2;
const KEY_BYTES: u8 = 4;

#[derive(Clone, Debug, Default)]
pub struct ScoreBook {
    depth: u8,
    keys: Vec<u64>,
    scores: Vec<i8>,
}

impl ScoreBook {
    pub fn new() -> Self {
        Self::default()
    }

    /// Small default score book compiled into the engine; no network access needed.
    pub fn opening_4ply() -> Self {
        Self::load(include_bytes!("../../books/4ply.c4book"))
            .expect("embedded 4-ply score book must be valid")
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }

    pub fn depth(&self) -> u8 {
        self.depth
    }

    pub fn len(&self) -> usize {
        self.keys.len()
    }

    pub fn entries(&self) -> impl Iterator<Item = (u64, i32)> + '_ {
        self.keys
            .iter()
            .copied()
            .zip(self.scores.iter().map(|&s| s as i32))
    }

    /// Preserve fallback coverage without replacing entries in this book.
    pub(crate) fn fill_missing(&mut self, fallback: &Self) {
        if self.is_empty() {
            *self = fallback.clone();
            return;
        }
        for (&key, &score) in fallback.keys.iter().zip(&fallback.scores) {
            if let Err(i) = self.keys.binary_search(&key) {
                self.keys.insert(i, key);
                self.scores.insert(i, score);
            }
        }
        self.depth = self.depth.max(fallback.depth);
    }

    pub fn insert(&mut self, key: u64, score: i8, moves: u8) {
        if moves > self.depth {
            self.depth = moves;
        }
        match self.keys.binary_search(&key) {
            Ok(i) => self.scores[i] = score,
            Err(i) => {
                self.keys.insert(i, key);
                self.scores.insert(i, score);
            }
        }
    }

    pub fn contains(&self, pos: &Position) -> bool {
        self.keys.binary_search(&pos.key3()).is_ok()
    }

    pub fn get(&self, pos: &Position) -> Option<i32> {
        if self.keys.is_empty() || pos.moves() > self.depth {
            return None;
        }
        self.keys
            .binary_search(&pos.key3())
            .ok()
            .map(|i| self.scores[i] as i32)
    }

    pub fn load(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() < 12 {
            return Err("score book too small".into());
        }
        if &bytes[0..4] != MAGIC {
            return Err("bad magic".into());
        }
        if bytes[4] != VERSION {
            return Err(format!("unsupported score-book version {}", bytes[4]));
        }
        let depth = bytes[5];
        if bytes[6] != KEY_BYTES {
            return Err(format!("unsupported key size {}", bytes[6]));
        }
        let count = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
        let need = 12 + count * 5;
        if bytes.len() < need {
            return Err("truncated score book".into());
        }
        let mut score_book = Self::new();
        let mut off = 12;
        for _ in 0..count {
            let key = u32::from_le_bytes(bytes[off..off + 4].try_into().unwrap()) as u64;
            let score = bytes[off + 4] as i8;
            score_book.insert(key, score, 0);
            off += 5;
        }
        score_book.depth = depth;
        Ok(score_book)
    }

    pub fn save(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(12 + self.keys.len() * 5);
        out.extend_from_slice(MAGIC);
        out.push(VERSION);
        out.push(self.depth);
        out.push(KEY_BYTES);
        out.push(0);
        out.extend_from_slice(&(self.keys.len() as u32).to_le_bytes());
        for i in 0..self.keys.len() {
            let k = self.keys[i];
            debug_assert!(k <= u32::MAX as u64, "key3 does not fit in u32");
            out.extend_from_slice(&(k as u32).to_le_bytes());
            out.push(self.scores[i] as u8);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opening_folds_mirrors() {
        let b = ScoreBook::opening_4ply();
        assert_eq!(b.depth(), 4);
        assert_eq!(b.len(), 719);
        let mut left = Position::new();
        left.play_col(0);
        let mut right = Position::new();
        right.play_col(6);
        assert_eq!(b.get(&left), Some(2));
        assert_eq!(b.get(&right), Some(2));
        assert_eq!(left.key3(), right.key3());
    }

    #[test]
    fn embedded_score_book_covers_every_position_through_four_plies() {
        fn check(score_book: &ScoreBook, pos: Position) {
            assert!(score_book.get(&pos).is_some(), "missing key {}", pos.key3());
            if pos.moves() == 4 {
                return;
            }
            for col in 0..7 {
                let mut child = pos;
                child.play_col(col);
                check(score_book, child);
            }
        }
        check(&ScoreBook::opening_4ply(), Position::new());
    }

    #[test]
    fn roundtrip() {
        let mut b = ScoreBook::new();
        b.insert(1, 18, 0);
        b.insert(99, -3, 2);
        b.insert(5, 0, 1);
        let bytes = b.save();
        let b2 = ScoreBook::load(&bytes).unwrap();
        assert_eq!(b2.depth(), 2);
        assert_eq!(b2.len(), 3);
        let mut p = Position::new();
        // empty key is 0, not in book
        assert!(b2.get(&p).is_none());
        p.play_col(3);
        // just checks load/save integrity
        let b3 = ScoreBook::load(&bytes).unwrap();
        assert_eq!(b3.save(), bytes);
    }
}
