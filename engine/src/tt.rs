//! Pons-style transposition table: two arrays, compact value, prime modulus.
//!
//! - `K[i]`: truncated key (u32)
//! - `V[i]`: packed bound+score in the low 8 bits, generation in the high 8
//!
//! Index is `key % prime(2^log)`. Together with a 32-bit stub this is unique
//! for 49-bit Connect-4 keys (same CRT idea as Pons, who stores 25 bits and
//! indexes with ~24). Misses touch 4-byte keys, not an 8-byte struct.
//!
//! Always-replace. Generation makes reset O(1) (no 80MB memset).

use crate::position::{MAX_SCORE, MIN_SCORE};

pub const FLAG_EMPTY: u8 = 0;
pub const FLAG_UPPER: u8 = 1;
pub const FLAG_LOWER: u8 = 2;

const RANGE: i32 = MAX_SCORE - MIN_SCORE + 1; // 37

pub struct Table {
    keys: Box<[u32]>,
    vals: Box<[u16]>,
    size: usize,
    gen: u8,
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
        let mut vals = vec![0u16; size].into_boxed_slice();
        advise_huge_pages(&mut keys);
        advise_huge_pages(&mut vals);
        Self {
            keys,
            vals,
            size,
            gen: 1,
        }
    }

    pub fn reset(&mut self) {
        self.gen = self.gen.wrapping_add(1);
        if self.gen == 0 {
            self.keys.fill(0);
            self.vals.fill(0);
            self.gen = 1;
        }
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
        let v = unsafe { *self.vals.get_unchecked(i) };
        if (v >> 8) as u8 != self.gen {
            return None;
        }
        let packed = v as u8;
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
            *self.vals.get_unchecked_mut(i) = packed as u16 | ((self.gen as u16) << 8);
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
    let mut d = 3;
    while d <= n / d {
        if n.is_multiple_of(d) {
            return false;
        }
        d += 2;
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
    fn pack_roundtrip() {
        for s in MIN_SCORE..=MAX_SCORE {
            let (u, f) = unpack(pack(s, FLAG_UPPER));
            assert_eq!((u, f), (s, FLAG_UPPER), "upper {s}");
            let (u, f) = unpack(pack(s, FLAG_LOWER));
            assert_eq!((u, f), (s, FLAG_LOWER), "lower {s}");
        }
        assert_eq!(pack(0, FLAG_EMPTY), 0);
    }

    #[test]
    fn put_get() {
        let mut t = Table::new(12);
        t.put(12345, 4, FLAG_LOWER);
        assert_eq!(t.get(12345), Some((4, FLAG_LOWER)));
        assert_eq!(t.get(1), None);
        t.reset();
        assert_eq!(t.get(12345), None);
        t.put(12345, -3, FLAG_UPPER);
        assert_eq!(t.get(12345), Some((-3, FLAG_UPPER)));
    }

    #[test]
    fn primes_are_compile_time() {
        assert_eq!(PRIMES[16 - MIN_LOG as usize], 65_537);
        for log in MIN_LOG..=MAX_LOG {
            let p = PRIMES[(log - MIN_LOG) as usize];
            assert_eq!(p, next_prime(1usize << log));
            assert!(p >= 1usize << log);
            assert!(is_prime(p));
        }
    }
}
