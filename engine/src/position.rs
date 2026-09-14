//! 7×6 Connect 4 bitboard.
//!
//! Layout (Tromp / Pons): each column uses HEIGHT+1 bits, sentinel on top:
//!
//! ```text
//!  6 13 20 27 34 41 48
//!  5 12 19 26 33 40 47
//!  4 11 18 25 32 39 46
//!  3 10 17 24 31 38 45
//!  2  9 16 23 30 37 44
//!  1  8 15 22 29 36 43
//!  0  7 14 21 28 35 42
//! ```
//!
//! `current` is the side to move; `mask` is all stones. After a play the sides
//! swap by XOR so `current` is always the player about to move.

pub const WIDTH: usize = 7;
pub const HEIGHT: usize = 6;
pub const AREA: usize = WIDTH * HEIGHT;
pub const MIN_SCORE: i32 = -((AREA as i32) / 2) + 3;
pub const MAX_SCORE: i32 = ((AREA as i32) + 1) / 2 - 3;

const H1: u32 = (HEIGHT + 1) as u32;

const fn bottom_mask() -> u64 {
    let mut m = 0u64;
    let mut c = 0;
    while c < WIDTH {
        m |= 1u64 << (c as u32 * H1);
        c += 1;
    }
    m
}

const BOTTOM: u64 = bottom_mask();
const BOARD: u64 = BOTTOM * ((1u64 << HEIGHT) - 1);

#[inline]
pub const fn column_mask(col: usize) -> u64 {
    ((1u64 << HEIGHT) - 1) << (col as u32 * H1)
}

#[inline]
const fn top_mask(col: usize) -> u64 {
    1u64 << ((HEIGHT as u32 - 1) + col as u32 * H1)
}

#[inline]
const fn bottom_mask_col(col: usize) -> u64 {
    1u64 << (col as u32 * H1)
}

/// Alignment test on one player's stones (Tromp: 8 shifts / ands).
#[inline]
pub fn has_won(bb: u64) -> bool {
    let x = bb & (bb >> 6);
    if x & (x >> 12) != 0 {
        return true;
    }
    let x = bb & (bb >> 7);
    if x & (x >> 14) != 0 {
        return true;
    }
    let x = bb & (bb >> 8);
    if x & (x >> 16) != 0 {
        return true;
    }
    let x = bb & (bb >> 1);
    x & (x >> 2) != 0
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Position {
    current: u64,
    mask: u64,
    moves: u8,
}

impl Position {
    pub fn new() -> Self {
        Self::default()
    }

    #[inline]
    pub fn moves(&self) -> u8 {
        self.moves
    }

    #[inline(always)]
    pub fn key(&self) -> u64 {
        self.current + self.mask
    }

    /// Reverse columns of a 7×(6+1) bitboard. Addition of `current+mask` never
    /// carries across columns (sentinel bit), so mirroring the key is valid.
    #[inline(always)]
    pub fn mirror_bitboard(bb: u64) -> u64 {
        const C: u64 = 0x7F;
        ((bb & C) << 42)
            | (((bb >> 7) & C) << 35)
            | (((bb >> 14) & C) << 28)
            | (((bb >> 21) & C) << 21)
            | (((bb >> 28) & C) << 14)
            | (((bb >> 35) & C) << 7)
            | ((bb >> 42) & C)
    }

    #[inline(always)]
    pub fn canonical_from_key(k: u64) -> u64 {
        k.min(Self::mirror_bitboard(k))
    }

    /// Left-right canonical key so a position and its mirror share a TT slot.
    #[inline(always)]
    pub fn canonical_key(&self) -> u64 {
        Self::canonical_from_key(self.key())
    }

    /// True when this board is the right-left image of the stored canonical key.
    /// Column scores stored under that key must be reversed for this position.
    #[inline]
    pub fn is_mirrored(&self) -> bool {
        self.key() != self.canonical_key()
    }

    /// Return the left-right reflection of this position.
    pub fn mirrored(&self) -> Self {
        Self {
            current: Self::mirror_bitboard(self.current),
            mask: Self::mirror_bitboard(self.mask),
            moves: self.moves,
        }
    }

    /// Pons base-3 key, already mirrored (`min` of L→R and R→L, last 0 dropped).
    /// Bit length ≈ (moves + 6) log2(3); fits in 32 bits through 14 ply.
    pub fn key3(&self) -> u64 {
        let mut fwd = 0u64;
        for i in 0..WIDTH {
            self.partial_key3(&mut fwd, i);
        }
        let mut rev = 0u64;
        for i in (0..WIDTH).rev() {
            self.partial_key3(&mut rev, i);
        }
        (if fwd < rev { fwd } else { rev }) / 3
    }

    fn partial_key3(&self, key: &mut u64, col: usize) {
        let mut bit = 1u64 << (col as u32 * H1);
        while self.mask & bit != 0 {
            *key = key.wrapping_mul(3);
            if self.current & bit != 0 {
                *key += 1;
            } else {
                *key += 2;
            }
            bit <<= 1;
        }
        *key = key.wrapping_mul(3);
    }

    /// Decode a score-book key into its canonical board orientation.
    /// This checks the encoding and piece counts, not game-history reachability.
    pub fn from_key3(mut key: u64) -> Option<Self> {
        let original = key;
        let mut pos = Self::new();
        for col in (0..WIDTH).rev() {
            let mut stones = 0u64;
            let mut height = 0;
            while !key.is_multiple_of(3) {
                if height == HEIGHT {
                    return None;
                }
                stones = (stones << 1) | u64::from(key % 3 == 1);
                height += 1;
                key /= 3;
            }
            key /= 3;
            let shift = col as u32 * H1;
            pos.current |= stones << shift;
            pos.mask |= ((1u64 << height) - 1) << shift;
            pos.moves += height as u8;
        }
        (key == 0 && pos.current.count_ones() == u32::from(pos.moves / 2) && pos.key3() == original)
            .then_some(pos)
    }

    #[inline(always)]
    pub fn can_play(&self, col: usize) -> bool {
        self.mask & top_mask(col) == 0
    }

    #[inline]
    pub fn is_draw(&self) -> bool {
        self.moves as usize >= AREA
    }

    /// Stones of the player who just moved (opponent of `current`).
    #[inline]
    pub fn last_player_won(&self) -> bool {
        self.moves > 0 && has_won(self.current ^ self.mask)
    }

    #[inline(always)]
    pub fn play_bits(&mut self, move_bit: u64) {
        self.current ^= self.mask;
        self.mask |= move_bit;
        self.moves += 1;
    }

    /// Play a 0-based column. Caller must ensure it is playable.
    #[inline]
    pub fn play_col(&mut self, col: usize) {
        let bit = (self.mask + bottom_mask_col(col)) & column_mask(col);
        self.play_bits(bit);
    }

    #[inline(always)]
    pub fn possible(&self) -> u64 {
        (self.mask + BOTTOM) & BOARD
    }

    #[inline(always)]
    pub fn can_win_next(&self) -> bool {
        self.winning_position() & self.possible() != 0
    }

    #[inline]
    pub fn is_winning_move(&self, col: usize) -> bool {
        self.winning_position() & self.possible() & column_mask(col) != 0
    }

    #[inline(always)]
    pub fn winning_position(&self) -> u64 {
        compute_winning_position(self.current, self.mask)
    }

    #[inline(always)]
    fn opponent_winning_position(&self) -> u64 {
        compute_winning_position(self.current ^ self.mask, self.mask)
    }

    /// Legal drops that do not give the opponent an immediate win.
    /// Assumes the side to move cannot win this turn (`!can_win_next`).
    pub fn possible_non_losing_moves(&self) -> u64 {
        debug_assert!(!self.can_win_next());
        let mut possible = self.possible();
        let opponent_win = self.opponent_winning_position();
        let forced = possible & opponent_win;
        if forced != 0 {
            if forced & (forced - 1) != 0 {
                return 0;
            }
            possible = forced;
        }
        possible & !(opponent_win >> 1)
    }

    /// Number of winning spots after playing `move_bit`.
    #[inline(always)]
    pub fn move_score(&self, move_bit: u64) -> i32 {
        (compute_winning_position(self.current | move_bit, self.mask)).count_ones() as i32
    }

    /// Play 1-based column digits (`"444526"`). Stops before an illegal or
    /// already-winning drop. Returns how many characters were consumed.
    pub fn play_seq(&mut self, seq: &str) -> usize {
        for (i, ch) in seq.chars().enumerate() {
            let col = match ch.to_digit(10) {
                Some(d) if (1..=WIDTH as u32).contains(&d) => (d - 1) as usize,
                _ => return i,
            };
            if !self.can_play(col) || self.is_winning_move(col) {
                return i;
            }
            self.play_col(col);
        }
        seq.len()
    }

    /// Play 0-based columns. Returns false if a move is illegal.
    pub fn play_moves(&mut self, cols: &[u8]) -> bool {
        for &c in cols {
            let col = c as usize;
            if self.last_player_won() || col >= WIDTH || !self.can_play(col) {
                return false;
            }
            self.play_col(col);
        }
        true
    }

    /// Height of a column (0..=6).
    pub fn height(&self, col: usize) -> u8 {
        let mut h = 0u8;
        let mut bit = bottom_mask_col(col);
        for _ in 0..HEIGHT {
            if self.mask & bit == 0 {
                break;
            }
            h += 1;
            bit <<= 1;
        }
        h
    }

    /// Occupant of (row, col): 0 empty, 1 first player, 2 second player.
    /// Row 0 is the bottom.
    pub fn cell(&self, row: usize, col: usize) -> u8 {
        let bit = 1u64 << (row as u32 + col as u32 * H1);
        if self.mask & bit == 0 {
            0
        } else {
            let first = if self.moves.is_multiple_of(2) {
                self.current
            } else {
                self.current ^ self.mask
            };
            if first & bit != 0 {
                1
            } else {
                2
            }
        }
    }
}

#[inline(always)]
fn compute_winning_position(position: u64, mask: u64) -> u64 {
    // vertical
    let mut r = (position << 1) & (position << 2) & (position << 3);

    // horizontal
    let mut p = (position << H1) & (position << (2 * H1));
    r |= p & (position << (3 * H1));
    r |= p & (position >> H1);
    p = (position >> H1) & (position >> (2 * H1));
    r |= p & (position << H1);
    r |= p & (position >> (3 * H1));

    // diagonal /
    p = (position << HEIGHT as u32) & (position << (2 * HEIGHT as u32));
    r |= p & (position << (3 * HEIGHT as u32));
    r |= p & (position >> HEIGHT as u32);
    p = (position >> HEIGHT as u32) & (position >> (2 * HEIGHT as u32));
    r |= p & (position << HEIGHT as u32);
    r |= p & (position >> (3 * HEIGHT as u32));

    // diagonal \
    let d = (HEIGHT + 2) as u32;
    p = (position << d) & (position << (2 * d));
    r |= p & (position << (3 * d));
    r |= p & (position >> d);
    p = (position >> d) & (position >> (2 * d));
    r |= p & (position << d);
    r |= p & (position >> (3 * d));

    r & (BOARD ^ mask)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_key3_preserves_board_and_side_to_move() {
        for seq in [
            "",
            "1",
            "7",
            "12",
            "21",
            "174",
            "111111",
            "44444222",
            "1234567123",
        ] {
            let mut pos = Position::new();
            assert_eq!(pos.play_seq(seq), seq.len());
            let decoded = Position::from_key3(pos.key3()).unwrap();
            assert!(decoded == pos || decoded == pos.mirrored(), "{seq}");
        }
        assert!(Position::from_key3(u64::MAX).is_none());
        assert!(Position::from_key3(1).is_none()); // one side-to-move disc at ply 1
    }

    #[test]
    fn key3_mirrors_and_transpositions() {
        let mut l = Position::new();
        l.play_col(0);
        let mut r = Position::new();
        r.play_col(6);
        assert_eq!(l.key3(), r.key3());
        assert_ne!(l.key(), r.key());
        let mut a = Position::new();
        a.play_seq("12");
        let mut b = Position::new();
        b.play_seq("76");
        assert_eq!(a.key3(), b.key3());
        let mut c = Position::new();
        c.play_seq("21");
        assert_ne!(a.key3(), c.key3());
        let mut d = Position::new();
        d.play_col(3);
        assert_ne!(l.key3(), d.key3());
        assert_eq!(Position::new().key3(), Position::new().key3());
    }

    #[test]
    fn mirror_swaps_edge_columns() {
        let mut left = Position::new();
        left.play_col(0);
        let mut right = Position::new();
        right.play_col(6);
        assert_eq!(left.canonical_key(), right.canonical_key());
        assert_ne!(left.key(), right.key());
        let mut l = Position::new();
        l.play_seq("12");
        let mut r = Position::new();
        r.play_seq("76");
        assert_eq!(l.canonical_key(), r.canonical_key());
        assert_ne!(l.is_mirrored(), r.is_mirrored());
        assert_eq!(Position::new().canonical_key(), Position::new().key());
    }

    #[test]
    fn empty_playable() {
        let p = Position::new();
        for c in 0..WIDTH {
            assert!(p.can_play(c));
            assert_eq!(p.height(c), 0);
        }
        assert_eq!(p.moves(), 0);
        assert!(!p.can_win_next());
    }

    #[test]
    fn vertical_win() {
        // 1 2 1 3 1 4 then 1 wins vertically.
        let mut p = Position::new();
        assert_eq!(p.play_seq("121314"), 6);
        assert!(p.is_winning_move(0));
        assert!(p.can_win_next());
        p.play_col(0);
        assert!(p.last_player_won());
    }

    #[test]
    fn horizontal_win() {
        let mut p = Position::new();
        // R: 1, Y: 1, R: 2, Y: 2, R: 3, Y: 3, R: 4 wins on bottom row.
        assert_eq!(p.play_seq("112233"), 6);
        assert!(p.is_winning_move(3));
        p.play_col(3);
        assert!(p.last_player_won());
        assert!(has_won(p.current ^ p.mask));
    }

    #[test]
    fn diagonal_win() {
        // A common rising diagonal for P1.
        let mut p = Position::new();
        assert_eq!(p.play_seq("1223434455"), 10);
        // After this, check whether someone already won — construct more carefully.
        let mut g = Grid::new();
        for ch in "1223434455".chars() {
            let col = (ch as u8 - b'1') as usize;
            assert!(g.drop(col));
        }
        // Independent grid agrees with bitboard cells.
        for col in 0..WIDTH {
            for row in 0..HEIGHT {
                assert_eq!(p.cell(row, col), g.cell(row, col), "r{row} c{col}");
            }
        }
    }

    #[test]
    fn random_games_match_grid() {
        let mut seed = 0xC0FFEE_u64;
        for _ in 0..200 {
            let mut p = Position::new();
            let mut g = Grid::new();
            while !g.over {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                let col = (seed as usize) % WIDTH;
                if !p.can_play(col) {
                    if (0..WIDTH).all(|c| !p.can_play(c)) {
                        break;
                    }
                    continue;
                }
                let win = p.is_winning_move(col);
                p.play_col(col);
                assert!(g.drop(col));
                assert_eq!(p.last_player_won(), win);
                assert_eq!(p.last_player_won(), g.winner != 0);
                if win {
                    break;
                }
            }
            for col in 0..WIDTH {
                for row in 0..HEIGHT {
                    assert_eq!(p.cell(row, col), g.cell(row, col));
                }
            }
        }
    }

    #[test]
    fn seq_stops_before_winning_drop() {
        let mut p = Position::new();
        // Winning drop is the 7th character; play_seq refuses it.
        assert_eq!(p.play_seq("1213141"), 6);
        assert_eq!(p.moves(), 6);
        assert!(p.is_winning_move(0));
    }

    #[test]
    fn full_column() {
        let mut p = Position::new();
        for i in 0..HEIGHT {
            assert!(p.can_play(0));
            p.play_col(0);
            if i + 1 < HEIGHT {
                p.play_col(1);
            }
        }
        assert!(!p.can_play(0));
        assert_eq!(p.height(0), HEIGHT as u8);
    }

    struct Grid {
        cells: [[u8; WIDTH]; HEIGHT],
        height: [usize; WIDTH],
        turn: u8,
        winner: u8,
        over: bool,
    }

    impl Grid {
        fn new() -> Self {
            Self {
                cells: [[0; WIDTH]; HEIGHT],
                height: [0; WIDTH],
                turn: 1,
                winner: 0,
                over: false,
            }
        }

        fn cell(&self, row: usize, col: usize) -> u8 {
            self.cells[row][col]
        }

        fn drop(&mut self, col: usize) -> bool {
            if self.over || self.height[col] >= HEIGHT {
                return false;
            }
            let row = self.height[col];
            self.cells[row][col] = self.turn;
            self.height[col] += 1;
            if self.check_win(row, col) {
                self.winner = self.turn;
                self.over = true;
            } else if self.height.iter().all(|&h| h >= HEIGHT) {
                self.over = true;
            }
            self.turn = 3 - self.turn;
            true
        }

        fn check_win(&self, row: usize, col: usize) -> bool {
            let t = self.cells[row][col];
            const DIRS: [(isize, isize); 4] = [(1, 0), (0, 1), (1, 1), (1, -1)];
            for (dr, dc) in DIRS {
                let mut n = 1;
                for sign in [1, -1] {
                    let mut r = row as isize + sign * dr;
                    let mut c = col as isize + sign * dc;
                    while r >= 0
                        && r < HEIGHT as isize
                        && c >= 0
                        && c < WIDTH as isize
                        && self.cells[r as usize][c as usize] == t
                    {
                        n += 1;
                        r += sign * dr;
                        c += sign * dc;
                    }
                }
                if n >= 4 {
                    return true;
                }
            }
            false
        }
    }
}
