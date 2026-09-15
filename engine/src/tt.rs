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

pub const FLAG_EMPTY: u8 = 0;
pub const FLAG_UPPER: u8 = 1;
pub const FLAG_LOWER: u8 = 2;

const RANGE: i32 = MAX_SCORE - MIN_SCORE + 1; // 37

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
            *self.keys.get_unchecked_mut(i) = key as u32;
            *self.vals.get_unchecked_mut(i) = packed;
        }
    }
}

#[inline]
fn pack(score: i32, flag: u8) -> u8 {
    let s = score.clamp(MIN_SCORE, MAX_SCORE);
    match flag {
        FLAG_UPPER => (s - MIN_SCORE + 1) as u8,
        FLAG_LOWER => (s + MAX_SCORE - 2 * MIN_SCORE + 2) as u8,
        _ => 0,
    }
}

#[inline]
fn unpack(val: u8) -> (i32, u8) {
    let v = val as i32;
    if v > RANGE {
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

    #[test]
    fn put_get() {
        let mut t = Table::new(12);
        for s in [MIN_SCORE, -3, 0, 4, MAX_SCORE] {
            t.put(12345, s, FLAG_LOWER);
            assert_eq!(t.get(12345), Some((s, FLAG_LOWER)), "lower {s}");
            t.put(12345, s, FLAG_UPPER);
            assert_eq!(t.get(12345), Some((s, FLAG_UPPER)), "upper {s}");
        }
        assert_eq!(t.get(1), None);
        t.put(99, 0, FLAG_EMPTY);
        assert_eq!(t.get(99), None);
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
