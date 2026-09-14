//! Dense, packed best-move opening book (`C4MV` v1).
//!
//! Positions are indexed without storing board keys. Column heights are folded
//! by reflection, then the side-to-move stones are ranked with a combinadic.
//! Each slot stores one column in three bits; value 7 means unknown.

use crate::position::{Position, HEIGHT, WIDTH};

const MAGIC: &[u8; 4] = b"C4MV";
const VERSION: u8 = 1;
const INDEX_VERSION: u8 = 1;
const BITS_PER_SLOT: u8 = 3;
const CHECKSUM_CRC32: u8 = 1;
const FIXED_HEADER_LEN: usize = 20;
const DIRECTORY_ENTRY_LEN: usize = 16;
pub const MAX_MOVE_BOOK_PLY: u8 = 10;
pub const UNKNOWN_MOVE: u8 = 7;

pub const EXPECTED_SLOT_COUNTS: [u32; MAX_MOVE_BOOK_PLY as usize + 1] = [
    1, 4, 32, 132, 660, 2_360, 9_440, 30_240, 104_580, 304_920, 941_472,
];

const fn make_binomials() -> [[u32; 11]; 11] {
    let mut table = [[0u32; 11]; 11];
    let mut n = 0;
    while n <= 10 {
        table[n][0] = 1;
        table[n][n] = 1;
        let mut k = 1;
        while k < n {
            table[n][k] = table[n - 1][k - 1] + table[n - 1][k];
            k += 1;
        }
        n += 1;
    }
    table
}

const BINOMIALS: [[u32; 11]; 11] = make_binomials();

#[derive(Clone, Debug)]
struct Section {
    slots: u32,
    data: Vec<u8>,
}

/// A compact move-only book. The packed section data remains packed in memory.
#[derive(Clone, Debug)]
pub struct MoveBook {
    max_ply: u8,
    sections: Vec<Section>,
    height_tables: Vec<Vec<[u8; WIDTH]>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Location {
    ply: usize,
    slot: usize,
    heights_mirrored: bool,
}

impl Default for MoveBook {
    fn default() -> Self {
        Self::empty(0).expect("the empty-board move-book layout is valid")
    }
}

impl MoveBook {
    /// Construct an all-unknown book through `max_ply`.
    pub fn empty(max_ply: u8) -> Result<Self, String> {
        if max_ply > MAX_MOVE_BOOK_PLY {
            return Err(format!(
                "unsupported move-book depth {max_ply} (maximum {MAX_MOVE_BOOK_PLY})"
            ));
        }
        let height_tables = height_tables(max_ply);
        let mut sections = Vec::with_capacity(max_ply as usize + 1);
        for ply in 0..=max_ply as usize {
            let color_count = choose(ply, ply / 2);
            let slots = height_tables[ply].len() as u32 * color_count;
            debug_assert_eq!(slots, EXPECTED_SLOT_COUNTS[ply]);
            sections.push(Section {
                slots,
                data: vec![0xff; packed_len(slots)],
            });
        }
        Ok(Self {
            max_ply,
            sections,
            height_tables,
        })
    }

    pub fn max_ply(&self) -> u8 {
        self.max_ply
    }

    pub fn slots(&self) -> u32 {
        self.sections.iter().map(|section| section.slots).sum()
    }

    pub fn payload_bytes(&self) -> usize {
        self.sections.iter().map(|section| section.data.len()).sum()
    }

    pub fn populated(&self) -> u32 {
        let mut count = 0u32;
        for section in &self.sections {
            for slot in 0..section.slots as usize {
                if read_three_bits(&section.data, slot) != UNKNOWN_MOVE {
                    count += 1;
                }
            }
        }
        count
    }

    /// Look up a legal move in the caller's board orientation.
    pub fn get(&self, pos: &Position) -> Option<usize> {
        if pos.moves() > self.max_ply || pos.last_player_won() || pos.is_draw() {
            return None;
        }
        let location = self.location(pos)?;
        let stored = read_three_bits(&self.sections[location.ply].data, location.slot);
        if stored >= WIDTH as u8 {
            return None;
        }
        let col = if location.heights_mirrored {
            WIDTH - 1 - stored as usize
        } else {
            stored as usize
        };
        pos.can_play(col).then_some(col)
    }

    /// Insert a certified optimal move. Symmetric height vectors receive the
    /// reflected colour arrangement too. Duplicate writes choose the smaller
    /// indexing-orientation column, making fully symmetric ties deterministic.
    pub fn insert(&mut self, pos: &Position, col: usize) -> Result<u32, String> {
        if col >= WIDTH || !pos.can_play(col) {
            return Err(format!("column {col} is not legal"));
        }
        if pos.moves() > self.max_ply {
            return Err(format!(
                "position at ply {} exceeds depth {}",
                pos.moves(),
                self.max_ply
            ));
        }
        if pos.last_player_won() || pos.is_draw() {
            return Err("cannot insert a move for a terminal position".into());
        }
        let mut changed = 0;
        for (board, col) in [(*pos, col), (pos.mirrored(), WIDTH - 1 - col)] {
            let location = self.location(&board).ok_or("position is not indexable")?;
            let stored = if location.heights_mirrored {
                WIDTH - 1 - col
            } else {
                col
            };
            changed += write_three_bits_min(
                &mut self.sections[location.ply].data,
                location.slot,
                stored as u8,
            ) as u32;
        }
        Ok(changed)
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn index(&self, pos: &Position) -> Option<(u8, u32)> {
        let location = self.location(pos)?;
        Some((location.ply as u8, location.slot as u32))
    }

    pub fn load(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() < FIXED_HEADER_LEN {
            return Err("move book too small".into());
        }
        if &bytes[..4] != MAGIC {
            return Err("bad move-book magic".into());
        }
        if bytes[4] != VERSION {
            return Err(format!("unsupported move-book version {}", bytes[4]));
        }
        if bytes[5] as usize != WIDTH || bytes[6] as usize != HEIGHT {
            return Err(format!(
                "unsupported move-book board {}x{}",
                bytes[5], bytes[6]
            ));
        }
        if bytes[7] != INDEX_VERSION {
            return Err(format!("unsupported indexing version {}", bytes[7]));
        }
        let max_ply = bytes[8];
        if max_ply > MAX_MOVE_BOOK_PLY {
            return Err(format!("unsupported move-book depth {max_ply}"));
        }
        if bytes[9] != BITS_PER_SLOT {
            return Err(format!("unsupported bits per slot {}", bytes[9]));
        }
        if bytes[10] != CHECKSUM_CRC32 {
            return Err(format!("unsupported checksum kind {}", bytes[10]));
        }
        if bytes[11] != 0 {
            return Err("nonzero reserved header byte".into());
        }
        let directory_count = u32::from_le_bytes(bytes[12..16].try_into().unwrap()) as usize;
        if directory_count != max_ply as usize + 1 {
            return Err("directory count does not match depth".into());
        }
        let payload_start = FIXED_HEADER_LEN + directory_count * DIRECTORY_ENTRY_LEN;
        if bytes.len() < payload_start {
            return Err("truncated move-book directory".into());
        }

        let expected_checksum = u32::from_le_bytes(bytes[16..20].try_into().unwrap());
        if crc32(&bytes[payload_start..]) != expected_checksum {
            return Err("move-book checksum mismatch".into());
        }

        let height_tables = height_tables(max_ply);
        let mut sections = Vec::with_capacity(directory_count);
        let mut expected_offset = payload_start;
        for (ply, heights) in height_tables.iter().enumerate() {
            let off = FIXED_HEADER_LEN + ply * DIRECTORY_ENTRY_LEN;
            if bytes[off] as usize != ply || bytes[off + 1..off + 4] != [0, 0, 0] {
                return Err(format!("invalid directory entry for ply {ply}"));
            }
            let slots = u32::from_le_bytes(bytes[off + 4..off + 8].try_into().unwrap());
            let expected_slots = heights.len() as u32 * choose(ply, ply / 2);
            if slots != expected_slots || slots != EXPECTED_SLOT_COUNTS[ply] {
                return Err(format!("wrong slot count at ply {ply}: {slots}"));
            }
            let section_offset =
                u32::from_le_bytes(bytes[off + 8..off + 12].try_into().unwrap()) as usize;
            let length = u32::from_le_bytes(bytes[off + 12..off + 16].try_into().unwrap()) as usize;
            let expected_length = packed_len(slots);
            if section_offset != expected_offset || length != expected_length {
                return Err(format!("invalid offset or length at ply {ply}"));
            }
            let end = section_offset + length;
            if end > bytes.len() {
                return Err(format!("truncated section at ply {ply}"));
            }
            validate_padding(&bytes[section_offset..end], slots)?;
            sections.push(Section {
                slots,
                data: bytes[section_offset..end].to_vec(),
            });
            expected_offset = end;
        }
        if expected_offset != bytes.len() {
            return Err("trailing move-book bytes".into());
        }
        Ok(Self {
            max_ply,
            sections,
            height_tables,
        })
    }

    pub fn save(&self) -> Vec<u8> {
        let directory_count = self.sections.len();
        let payload_start = FIXED_HEADER_LEN + directory_count * DIRECTORY_ENTRY_LEN;
        let total_len = payload_start + self.payload_bytes();
        let mut out = Vec::with_capacity(total_len);
        out.extend_from_slice(MAGIC);
        out.push(VERSION);
        out.push(WIDTH as u8);
        out.push(HEIGHT as u8);
        out.push(INDEX_VERSION);
        out.push(self.max_ply);
        out.push(BITS_PER_SLOT);
        out.push(CHECKSUM_CRC32);
        out.push(0);
        out.extend_from_slice(&(directory_count as u32).to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());

        let mut section_offset = payload_start;
        for (ply, section) in self.sections.iter().enumerate() {
            out.push(ply as u8);
            out.extend_from_slice(&[0, 0, 0]);
            out.extend_from_slice(&section.slots.to_le_bytes());
            out.extend_from_slice(&(section_offset as u32).to_le_bytes());
            out.extend_from_slice(&(section.data.len() as u32).to_le_bytes());
            section_offset += section.data.len();
        }
        for section in &self.sections {
            out.extend_from_slice(&section.data);
        }
        let checksum = crc32(&out[payload_start..]);
        out[16..20].copy_from_slice(&checksum.to_le_bytes());
        out
    }

    fn location(&self, pos: &Position) -> Option<Location> {
        let ply = pos.moves() as usize;
        let heights = position_heights(pos);
        let reversed = reversed(heights);
        let heights_mirrored = reversed < heights;
        let oriented = if heights_mirrored { reversed } else { heights };
        let height_rank = self.height_tables.get(ply)?.binary_search(&oriented).ok()?;
        let colors_per_height = choose(ply, ply / 2) as usize;
        let primary_color_rank = color_rank(pos, heights_mirrored) as usize;
        let slot = height_rank * colors_per_height + primary_color_rank;
        Some(Location {
            ply,
            slot,
            heights_mirrored,
        })
    }
}

fn position_heights(pos: &Position) -> [u8; WIDTH] {
    let mut heights = [0u8; WIDTH];
    for (col, height) in heights.iter_mut().enumerate() {
        *height = pos.height(col);
    }
    heights
}

fn reversed(mut values: [u8; WIDTH]) -> [u8; WIDTH] {
    values.reverse();
    values
}

fn color_rank(pos: &Position, reflect_columns: bool) -> u32 {
    let side_to_move = if pos.moves() % 2 == 0 { 1 } else { 2 };
    let mut occupied_index = 0usize;
    let mut selected = 0usize;
    let mut rank = 0u32;
    for oriented_col in 0..WIDTH {
        let col = if reflect_columns {
            WIDTH - 1 - oriented_col
        } else {
            oriented_col
        };
        for row in 0..pos.height(col) as usize {
            if pos.cell(row, col) == side_to_move {
                selected += 1;
                rank += choose(occupied_index, selected);
            }
            occupied_index += 1;
        }
    }
    debug_assert_eq!(occupied_index, pos.moves() as usize);
    debug_assert_eq!(selected, pos.moves() as usize / 2);
    rank
}

fn choose(n: usize, k: usize) -> u32 {
    if k > n || n > 10 {
        0
    } else {
        BINOMIALS[n][k]
    }
}

#[cfg(test)]
fn unrank_color(mut rank: u32, n: usize, k: usize) -> Vec<usize> {
    let mut selected = vec![0usize; k];
    let mut upper = n;
    for j in (1..=k).rev() {
        let mut value = upper - 1;
        while choose(value, j) > rank {
            value -= 1;
        }
        selected[j - 1] = value;
        rank -= choose(value, j);
        upper = value;
    }
    debug_assert_eq!(rank, 0);
    selected
}

fn height_tables(max_ply: u8) -> Vec<Vec<[u8; WIDTH]>> {
    (0..=max_ply)
        .map(|ply| {
            let mut out = Vec::new();
            let mut heights = [0u8; WIDTH];
            enumerate_heights(0, ply, &mut heights, &mut out);
            out
        })
        .collect()
}

fn enumerate_heights(
    col: usize,
    remaining: u8,
    heights: &mut [u8; WIDTH],
    out: &mut Vec<[u8; WIDTH]>,
) {
    if col == WIDTH {
        if remaining == 0 && *heights <= reversed(*heights) {
            out.push(*heights);
        }
        return;
    }
    let max = remaining.min(HEIGHT as u8);
    for height in 0..=max {
        heights[col] = height;
        enumerate_heights(col + 1, remaining - height, heights, out);
    }
    heights[col] = 0;
}

fn packed_len(slots: u32) -> usize {
    (slots as usize * BITS_PER_SLOT as usize).div_ceil(8)
}

fn read_three_bits(data: &[u8], slot: usize) -> u8 {
    let bit = slot * 3;
    let byte = bit / 8;
    let shift = bit % 8;
    let mut word = data[byte] as u16;
    if shift > 5 {
        word |= (data[byte + 1] as u16) << 8;
    }
    ((word >> shift) & 7) as u8
}

fn write_three_bits_min(data: &mut [u8], slot: usize, value: u8) -> bool {
    debug_assert!(value < UNKNOWN_MOVE);
    let old = read_three_bits(data, slot);
    let newly_populated = old == UNKNOWN_MOVE;
    let value = old.min(value);
    if value == old {
        return false;
    }
    let bit = slot * 3;
    let byte = bit / 8;
    let shift = bit % 8;
    let mut word = data[byte] as u16;
    if shift > 5 {
        word |= (data[byte + 1] as u16) << 8;
    }
    word = (word & !(7u16 << shift)) | ((value as u16) << shift);
    data[byte] = word as u8;
    if shift > 5 {
        data[byte + 1] = (word >> 8) as u8;
    }
    newly_populated
}

fn validate_padding(data: &[u8], slots: u32) -> Result<(), String> {
    let used = slots as usize * 3;
    let remainder = used % 8;
    if remainder == 0 {
        return Ok(());
    }
    let padding_mask = !((1u8 << remainder) - 1);
    if data.last().copied().unwrap_or(0) & padding_mask != padding_mask {
        return Err("non-one section padding bits".into());
    }
    Ok(())
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = !0u32;
    for &byte in bytes {
        crc ^= byte as u32;
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb8_8320 & (0u32.wrapping_sub(crc & 1)));
        }
    }
    !crc
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn position(seq: &str) -> Position {
        let mut pos = Position::new();
        assert_eq!(pos.play_seq(seq), seq.len());
        pos
    }

    #[test]
    fn generated_slot_counts_and_payload_match_the_spec() {
        let book = MoveBook::empty(10).unwrap();
        assert_eq!(book.slots(), 1_393_841);
        assert_eq!(book.payload_bytes(), 522_693);
        for (ply, &slots) in EXPECTED_SLOT_COUNTS.iter().enumerate() {
            assert_eq!(book.sections[ply].slots, slots);
        }
    }

    #[test]
    fn combinadic_rank_unrank_is_unique() {
        for n in 0..=10 {
            let k = n / 2;
            let mut ranks = HashSet::new();
            combinations(n, k, 0, &mut Vec::new(), &mut |selected| {
                let rank: u32 = selected
                    .iter()
                    .enumerate()
                    .map(|(j, &p)| choose(p, j + 1))
                    .sum();
                assert!(rank < choose(n, k));
                assert_eq!(unrank_color(rank, n, k), selected);
                ranks.insert(rank);
            });
            assert_eq!(ranks.len(), choose(n, k) as usize);
        }
    }

    fn combinations<F: FnMut(&[usize])>(
        n: usize,
        k: usize,
        start: usize,
        selected: &mut Vec<usize>,
        visit: &mut F,
    ) {
        if selected.len() == k {
            visit(selected);
            return;
        }
        for value in start..n {
            selected.push(value);
            combinations(n, k, value + 1, selected, visit);
            selected.pop();
        }
    }

    #[test]
    fn three_bit_values_cross_bytes_and_sections_roundtrip() {
        let mut book = MoveBook::empty(3).unwrap();
        for (section_index, section) in book.sections.iter_mut().enumerate() {
            for slot in 0..section.slots as usize {
                let value = ((slot + section_index) % 7) as u8;
                assert!(write_three_bits_min(&mut section.data, slot, value));
                assert_eq!(read_three_bits(&section.data, slot), value);
            }
        }
        let bytes = book.save();
        let loaded = MoveBook::load(&bytes).unwrap();
        assert_eq!(loaded.save(), bytes);
    }

    #[test]
    fn asymmetric_heights_fold_and_map_the_move_back() {
        let left = position("112");
        let right = position("776");
        let mut book = MoveBook::empty(3).unwrap();
        book.insert(&left, 0).unwrap();
        assert_eq!(book.get(&left), Some(0));
        assert_eq!(book.get(&right), Some(6));
        assert_eq!(book.populated(), 1);
    }

    #[test]
    fn symmetric_heights_populate_both_color_orientations() {
        let left = position("174");
        let right = position("714");
        assert_eq!(position_heights(&left), reversed(position_heights(&left)));
        let mut book = MoveBook::empty(3).unwrap();
        assert_eq!(book.insert(&left, 2).unwrap(), 2);
        assert_eq!(book.get(&left), Some(2));
        assert_eq!(book.get(&right), Some(4));
    }

    #[test]
    fn fully_symmetric_duplicate_is_deterministic() {
        let pos = position("44");
        let mut a = MoveBook::empty(2).unwrap();
        let mut b = MoveBook::empty(2).unwrap();
        a.insert(&pos, 2).unwrap();
        a.insert(&pos, 4).unwrap();
        b.insert(&pos, 4).unwrap();
        b.insert(&pos, 2).unwrap();
        assert_eq!(a.save(), b.save());
        assert_eq!(a.get(&pos), Some(2));
    }

    #[test]
    fn unknown_depth_full_and_terminal_positions_miss() {
        let mut book = MoveBook::empty(2).unwrap();
        let pos = position("12");
        assert_eq!(book.get(&pos), None);
        book.insert(&pos, 3).unwrap();
        assert_eq!(book.get(&pos), Some(3));
        assert_eq!(book.get(&position("123")), None);

        let terminal = {
            let mut pos = position("121314");
            pos.play_col(0);
            pos
        };
        assert!(terminal.last_player_won());
        assert_eq!(MoveBook::empty(10).unwrap().get(&terminal), None);

        let full = position("111111");
        assert!(!full.can_play(0));
        let mut malformed_entry = MoveBook::empty(6).unwrap();
        let location = malformed_entry.location(&full).unwrap();
        write_three_bits_min(
            &mut malformed_entry.sections[location.ply].data,
            location.slot,
            6,
        );
        assert_eq!(malformed_entry.get(&full), None);
    }

    #[test]
    fn malformed_files_are_rejected() {
        let valid = MoveBook::empty(10).unwrap().save();
        for index in [0usize, 4, 5, 6, 7, 9, 10, 11] {
            let mut bad = valid.clone();
            bad[index] ^= 0x55;
            assert!(MoveBook::load(&bad).is_err(), "byte {index}");
        }
        let mut bad_count = valid.clone();
        bad_count[24] ^= 1;
        assert!(MoveBook::load(&bad_count).is_err());
        let mut bad_payload = valid.clone();
        *bad_payload.last_mut().unwrap() ^= 1;
        assert!(MoveBook::load(&bad_payload).is_err());
        let payload_start = FIXED_HEADER_LEN + 11 * DIRECTORY_ENTRY_LEN;
        let mut bad_padding = valid.clone();
        bad_padding[payload_start] &= !(1 << 3);
        let checksum = crc32(&bad_padding[payload_start..]);
        bad_padding[16..20].copy_from_slice(&checksum.to_le_bytes());
        assert!(MoveBook::load(&bad_padding).is_err());
        assert!(MoveBook::load(&valid[..valid.len() - 1]).is_err());
        let mut trailing = valid;
        trailing.push(0);
        assert!(MoveBook::load(&trailing).is_err());
    }
}
