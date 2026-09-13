//! Compact opening book: sorted Pons `key3` values, binary search.
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
pub struct Book {
    depth: u8,
    keys: Vec<u64>,
    scores: Vec<i8>,
}

impl Book {
    pub fn new() -> Self {
        Self::default()
    }

    /// Empty board and the seven first moves. Strong scores (Pons / this solver).
    /// Empty is a first-player win (+1) only from the centre.
    pub fn opening_1ply() -> Self {
        let mut b = Self::new();
        b.insert(Position::new().key3(), 1, 0);
        let child = [2i8, 1, 0, -1, 0, 1, 2];
        for col in 0..7 {
            let mut p = Position::new();
            p.play_col(col);
            b.insert(p.key3(), child[col], 1);
        }
        b
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
            return Err("book too small".into());
        }
        if &bytes[0..4] != MAGIC {
            return Err("bad magic".into());
        }
        if bytes[4] != VERSION {
            return Err(format!("unsupported book version {}", bytes[4]));
        }
        let depth = bytes[5];
        if bytes[6] != KEY_BYTES {
            return Err(format!("unsupported key size {}", bytes[6]));
        }
        let count = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
        let need = 12 + count * 5;
        if bytes.len() < need {
            return Err("truncated book".into());
        }
        let mut book = Self::new();
        let mut off = 12;
        for _ in 0..count {
            let key = u32::from_le_bytes(bytes[off..off + 4].try_into().unwrap()) as u64;
            let score = bytes[off + 4] as i8;
            book.insert(key, score, 0);
            off += 5;
        }
        book.depth = depth;
        Ok(book)
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
        let b = Book::opening_1ply();
        assert_eq!(b.len(), 5, "empty + 4 first-move classes");
        let mut left = Position::new();
        left.play_col(0);
        let mut right = Position::new();
        right.play_col(6);
        assert_eq!(b.get(&left), Some(2));
        assert_eq!(b.get(&right), Some(2));
        assert_eq!(left.key3(), right.key3());
    }

    #[test]
    fn roundtrip() {
        let mut b = Book::new();
        b.insert(1, 18, 0);
        b.insert(99, -3, 2);
        b.insert(5, 0, 1);
        let bytes = b.save();
        let b2 = Book::load(&bytes).unwrap();
        assert_eq!(b2.depth(), 2);
        assert_eq!(b2.len(), 3);
        let mut p = Position::new();
        // empty key is 0, not in book
        assert!(b2.get(&p).is_none());
        p.play_col(3);
        // just checks load/save integrity
        let b3 = Book::load(&bytes).unwrap();
        assert_eq!(b3.save(), bytes);
    }
}
