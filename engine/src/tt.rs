//! Pons-style transposition table: two arrays, compact value, prime modulus.
//!
//! - `K[i]`: truncated key (u32)
//! - `V[i]`: packed bound+score (u8)
//!
//! Index is `key % prime(2^log)`. Together with a 32-bit stub this is unique
//! for 49-bit Connect-4 keys (same CRT idea as Pons, who stores 25 bits and
//! indexes with ~24). Misses touch 4-byte keys, not an 8-byte struct.
//!
//! Always-replace. The table stays warm across searches; there is no generation
//! stamp and no production wipe.

use crate::position::{MAX_SCORE, MIN_SCORE};

pub const FLAG_UPPER: u8 = 1;
pub const FLAG_LOWER: u8 = 2;
/// Exact score (third pack band). `0` is empty, `1..=37` upper, `38..=74`
/// lower, `75..=111` exact. Snapshot bytes `1..=74` keep their old meaning.
pub const FLAG_EXACT: u8 = 3;

const RANGE: i32 = MAX_SCORE - MIN_SCORE + 1; // 37

/// `save`/`load` snapshot format: magic, version, reserved, then slot count
/// as a `u64`, so `load` can reject a blob sized for a different table.
/// Version 2 is required so a loader that only unpacks `1..=74` as bounds
/// cannot misread an exact byte (`75..=111`) as a lower bound.
const SNAPSHOT_MAGIC: &[u8; 4] = b"C4TT";
const SNAPSHOT_VERSION: u8 = 2;
/// Version 1 snapshots only contain empty/upper/lower bytes (`0..=74`).
const SNAPSHOT_VERSION_V1: u8 = 1;
const SNAPSHOT_HEADER: usize = 16;

pub struct Table {
    keys: Box<[u32]>,
    vals: Box<[u8]>,
    size: usize,
}

/// Solver clamps `--tt-bits` to 16..=27. `Table::new` also allows 12 for tests.
const MIN_LOG: u32 = 12;
const MAX_LOG: u32 = 27;
const PRIME_LEN: usize = (MAX_LOG - MIN_LOG + 1) as usize;

const PRIMES: [usize; PRIME_LEN] = {
    let mut t = [0usize; PRIME_LEN];
    let mut log = MIN_LOG;
    while log <= MAX_LOG {
        t[(log - MIN_LOG) as usize] = next_prime(1usize << log);
        log += 1;
    }
    t
};

impl Table {
    pub fn new(log_size: u32) -> Self {
        let log_size = log_size.clamp(MIN_LOG, MAX_LOG);
        let size = PRIMES[(log_size - MIN_LOG) as usize];
        let mut keys = vec![0u32; size].into_boxed_slice();
        let mut vals = vec![0u8; size].into_boxed_slice();
        advise_huge_pages(&mut keys);
        advise_huge_pages(&mut vals);
        Self { keys, vals, size }
    }

    #[inline]
    fn index(&self, key: u64) -> usize {
        (key % self.size as u64) as usize
    }

    #[inline]
    pub fn get(&self, key: u64) -> Option<(i32, u8)> {
        let i = self.index(key);
        if unsafe { *self.keys.get_unchecked(i) } != key as u32 {
            return None;
        }
        let packed = unsafe { *self.vals.get_unchecked(i) };
        if packed == 0 {
            return None;
        }
        Some(unpack(packed))
    }

    #[inline]
    pub fn put(&mut self, key: u64, score: i32, flag: u8) {
        let packed = pack(score, flag);
        if packed == 0 {
            return;
        }
        let i = self.index(key);
        unsafe {
            if *self.keys.get_unchecked(i) == key as u32 {
                let existing = *self.vals.get_unchecked(i);
                if existing != 0 {
                    let (_, old_flag) = unpack(existing);
                    if old_flag == FLAG_EXACT && flag != FLAG_EXACT {
                        return;
                    }
                }
            }
            *self.keys.get_unchecked_mut(i) = key as u32;
            *self.vals.get_unchecked_mut(i) = packed;
        }
    }

    /// Serialize as `magic(4) + version(1) + reserved(3) + slot count(u64) +
    /// keys (u32 each) + vals (u8 each)`, for persisting a warm table.
    pub fn save(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(SNAPSHOT_HEADER + self.size * 5);
        out.extend_from_slice(SNAPSHOT_MAGIC);
        out.push(SNAPSHOT_VERSION);
        out.extend_from_slice(&[0, 0, 0]);
        out.extend_from_slice(&(self.size as u64).to_le_bytes());
        for k in self.keys.iter() {
            out.extend_from_slice(&k.to_le_bytes());
        }
        out.extend_from_slice(&self.vals);
        out
    }

    /// Overwrite this table from a `save` snapshot. Rejects bad magic,
    /// version, or a slot count that does not match this table's size, so a
    /// native-sized or truncated blob cannot corrupt the table.
    pub fn load(&mut self, bytes: &[u8]) -> Result<(), String> {
        if bytes.len() < SNAPSHOT_HEADER {
            return Err("tt snapshot too small".into());
        }
        if &bytes[0..4] != SNAPSHOT_MAGIC {
            return Err("bad tt snapshot magic".into());
        }
        if bytes[4] != SNAPSHOT_VERSION && bytes[4] != SNAPSHOT_VERSION_V1 {
            return Err(format!("unsupported tt snapshot version {}", bytes[4]));
        }
        let slots = u64::from_le_bytes(bytes[8..16].try_into().unwrap()) as usize;
        if slots != self.size {
            return Err(format!(
                "tt size mismatch: table has {} slots, snapshot has {slots}",
                self.size
            ));
        }
        let keys_len = self.size * 4;
        if bytes.len() != SNAPSHOT_HEADER + keys_len + self.size {
            return Err("tt snapshot length mismatch".into());
        }
        let key_bytes = &bytes[SNAPSHOT_HEADER..SNAPSHOT_HEADER + keys_len];
        let (chunks, _) = key_bytes.as_chunks::<4>();
        for (dst, chunk) in self.keys.iter_mut().zip(chunks) {
            *dst = u32::from_le_bytes(*chunk);
        }
        self.vals
            .copy_from_slice(&bytes[SNAPSHOT_HEADER + keys_len..]);
        Ok(())
    }
}

#[inline]
fn pack(score: i32, flag: u8) -> u8 {
    let s = score.clamp(MIN_SCORE, MAX_SCORE);
    match flag {
        FLAG_UPPER => (s - MIN_SCORE + 1) as u8,
        FLAG_LOWER => (s + MAX_SCORE - 2 * MIN_SCORE + 2) as u8,
        FLAG_EXACT => (s - MIN_SCORE + 2 * RANGE + 1) as u8,
        _ => 0,
    }
}

#[inline]
fn unpack(val: u8) -> (i32, u8) {
    let v = val as i32;
    if v > 2 * RANGE {
        (v + MIN_SCORE - 2 * RANGE - 1, FLAG_EXACT)
    } else if v > RANGE {
        (v + 2 * MIN_SCORE - MAX_SCORE - 2, FLAG_LOWER)
    } else {
        (v + MIN_SCORE - 1, FLAG_UPPER)
    }
}

const fn next_prime(n: usize) -> usize {
    let mut x = n | 1;
    while !is_prime(x) {
        x += 2;
    }
    x
}

const fn is_prime(n: usize) -> bool {
    if n < 2 {
        return false;
    }
    if n.is_multiple_of(2) {
        return n == 2;
    }
    if n.is_multiple_of(3) {
        return n == 3;
    }
    // 6k±1 wheel: past 2 and 3, every prime is 6k+1 or 6k+5, so we only
    // need to trial-divide by d and d+2 each step, skipping multiples of 2 and 3.
    let mut d = 5;
    while d <= n / d {
        if n.is_multiple_of(d) || n.is_multiple_of(d + 2) {
            return false;
        }
        d += 6;
    }
    true
}

fn advise_huge_pages<T>(slice: &mut [T]) {
    #[cfg(all(unix, not(target_arch = "wasm32")))]
    {
        let ptr = slice.as_mut_ptr() as *mut libc::c_void;
        let len = std::mem::size_of_val(slice);
        unsafe {
            libc::madvise(ptr, len, libc::MADV_HUGEPAGE);
        }
    }
    let _ = slice;
}

impl Default for Table {
    fn default() -> Self {
        Self::new(24)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FLAG_EMPTY: u8 = 0;

    #[test]
    fn put_get() {
        let mut t = Table::new(12);
        for s in [MIN_SCORE, -3, 0, 4, MAX_SCORE] {
            t.put(12345, s, FLAG_LOWER);
            assert_eq!(t.get(12345), Some((s, FLAG_LOWER)), "lower {s}");
            t.put(12345, s, FLAG_UPPER);
            assert_eq!(t.get(12345), Some((s, FLAG_UPPER)), "upper {s}");
        }
        for s in [MIN_SCORE, -3, 0, 4, MAX_SCORE] {
            t.put(12345, s, FLAG_EXACT);
            assert_eq!(t.get(12345), Some((s, FLAG_EXACT)), "exact {s}");
        }
        assert_eq!(t.get(1), None);
        t.put(99, 0, FLAG_EMPTY);
        assert_eq!(t.get(99), None);
    }

    #[test]
    fn pack_bands_leave_one_through_seventy_four_unchanged() {
        for s in MIN_SCORE..=MAX_SCORE {
            let upper = pack(s, FLAG_UPPER);
            let lower = pack(s, FLAG_LOWER);
            let exact = pack(s, FLAG_EXACT);
            assert!((1..=37).contains(&upper), "upper {s} -> {upper}");
            assert!((38..=74).contains(&lower), "lower {s} -> {lower}");
            assert!((75..=111).contains(&exact), "exact {s} -> {exact}");
            assert_eq!(unpack(upper), (s, FLAG_UPPER));
            assert_eq!(unpack(lower), (s, FLAG_LOWER));
            assert_eq!(unpack(exact), (s, FLAG_EXACT));
        }
        assert_eq!(pack(0, FLAG_EMPTY), 0);
    }

    #[test]
    fn put_keeps_exact_when_a_bound_collides() {
        let mut t = Table::new(12);
        t.put(12345, 4, FLAG_EXACT);
        t.put(12345, 1, FLAG_LOWER);
        t.put(12345, 7, FLAG_UPPER);
        assert_eq!(t.get(12345), Some((4, FLAG_EXACT)));
        t.put(12345, -2, FLAG_EXACT);
        assert_eq!(t.get(12345), Some((-2, FLAG_EXACT)));
        t.put(999, 0, FLAG_LOWER);
        assert_eq!(t.get(999), Some((0, FLAG_LOWER)));
    }

    #[test]
    fn save_load_roundtrip() {
        let mut t = Table::new(12);
        t.put(12345, 4, FLAG_LOWER);
        t.put(999, -3, FLAG_UPPER);
        t.put(7, 2, FLAG_EXACT);
        let blob = t.save();
        assert_eq!(blob[4], SNAPSHOT_VERSION);

        let mut t2 = Table::new(12);
        t2.load(&blob).unwrap();
        assert_eq!(t2.get(12345), Some((4, FLAG_LOWER)));
        assert_eq!(t2.get(999), Some((-3, FLAG_UPPER)));
        assert_eq!(t2.get(7), Some((2, FLAG_EXACT)));
        assert_eq!(t2.get(1), None);

        let mut v1 = blob.clone();
        v1[4] = SNAPSHOT_VERSION_V1;
        // Bound-only bytes are the same in v1; an exact byte is a v2 addition.
        v1[SNAPSHOT_HEADER + t.size * 4 + t.index(7)] = pack(2, FLAG_LOWER);
        t2.load(&v1).unwrap();
        assert_eq!(t2.get(12345), Some((4, FLAG_LOWER)));
        assert_eq!(t2.get(7), Some((2, FLAG_LOWER)));
    }

    #[test]
    fn load_rejects_wrong_size_magic_version_and_truncation() {
        let mut t = Table::new(12);
        let blob = t.save();

        let mut wrong_size = Table::new(13);
        assert!(wrong_size.load(&blob).is_err());

        assert!(t.load(b"short").is_err());

        let mut bad_magic = blob.clone();
        bad_magic[0] = b'X';
        assert!(t.load(&bad_magic).is_err());

        let mut bad_version = blob.clone();
        bad_version[4] = 99;
        assert!(t.load(&bad_version).is_err());

        let truncated = &blob[..blob.len() - 1];
        assert!(t.load(truncated).is_err());
    }

    #[test]
    fn primes_table_unchanged() {
        // Next prime after each 2^log for log in MIN_LOG..=MAX_LOG (12..=27).
        const EXPECTED: [usize; PRIME_LEN] = [
            4099, 8209, 16411, 32771, 65537, 131101, 262147, 524309, 1048583, 2097169, 4194319,
            8388617, 16777259, 33554467, 67108879, 134217757,
        ];
        assert_eq!(PRIMES, EXPECTED);
    }
}
