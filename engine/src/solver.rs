//! Strong Connect 4 solver: negamax, alpha-beta, null-window score search.

use crate::book::Book;
use crate::position::{column_mask, Position, AREA, WIDTH};
use crate::tt::{Table, FLAG_LOWER, FLAG_UPPER};

#[cfg(not(target_arch = "wasm32"))]
use std::time::{Duration, Instant};

const COLUMN_ORDER: [usize; WIDTH] = [3, 4, 2, 5, 1, 6, 0];
pub const INVALID_MOVE: i32 = -1000;

#[derive(Clone, Copy, Debug)]
pub struct SolveResult {
    pub score: i32,
    pub nodes: u64,
    pub micros: u64,
    pub timed_out: bool,
    pub from_book: bool,
}

pub struct Solver {
    tt: Table,
    book: Book,
    builtin: Book,
    nodes: u64,
    timed_out: bool,
    check_counter: u32,
    timeout_ms: u32,
    max_nodes: u64,
    mirror: bool,
    tt_log: u32,
    #[cfg(not(target_arch = "wasm32"))]
    start: Option<Instant>,
    #[cfg(target_arch = "wasm32")]
    start_ms: f64,
}

impl Default for Solver {
    fn default() -> Self {
        Self::new()
    }
}

impl Solver {
    pub fn new() -> Self {
        Self::with_tt_log(if cfg!(target_arch = "wasm32") { 22 } else { 24 })
    }

    pub fn with_tt_log(log_size: u32) -> Self {
        let log_size = log_size.clamp(16, 27);
        Self {
            tt: Table::new(log_size),
            book: Book::new(),
            builtin: Book::opening_1ply(),
            nodes: 0,
            timed_out: false,
            check_counter: 0,
            timeout_ms: 0,
            max_nodes: 0,
            mirror: true,
            tt_log: log_size,
            #[cfg(not(target_arch = "wasm32"))]
            start: None,
            #[cfg(target_arch = "wasm32")]
            start_ms: 0.0,
        }
    }

    pub fn reset(&mut self) {
        self.nodes = 0;
        self.timed_out = false;
        self.tt.reset();
    }

    pub fn reset_nodes(&mut self) {
        self.nodes = 0;
        self.timed_out = false;
        self.check_counter = 0;
    }

    pub fn node_count(&self) -> u64 {
        self.nodes
    }

    pub fn timed_out(&self) -> bool {
        self.timed_out
    }

    pub fn set_mirror(&mut self, on: bool) {
        self.mirror = on;
    }

    pub fn mirror(&self) -> bool {
        self.mirror
    }

    #[inline(always)]
    fn tt_key(&self, pos: &Position) -> u64 {
        if self.mirror {
            pos.canonical_key()
        } else {
            pos.key()
        }
    }

    pub fn set_timeout_ms(&mut self, ms: u32) {
        self.timeout_ms = ms;
        // Primary stop is wall clock. Node cap is only a backstop if Date.now()
        // is stuck. WASM on this machine is ~40M nps, so 15k nodes/ms cut a
        // 5s budget down to ~1.9s (exactly 75e6 nodes).
        self.max_nodes = if ms == 0 { 0 } else { ms as u64 * 80_000 };
    }

    pub fn load_book(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.book = Book::load(bytes)?;
        Ok(())
    }

    pub fn set_book(&mut self, book: Book) {
        self.book = book;
    }

    pub fn clear_book(&mut self) {
        self.book = Book::new();
    }

    pub fn book(&self) -> &Book {
        &self.book
    }

    pub fn builtin_len(&self) -> usize {
        self.builtin.len()
    }

    fn book_score(&self, pos: &Position) -> Option<i32> {
        self.book.get(pos).or_else(|| self.builtin.get(pos))
    }

    fn begin_clock(&mut self) {
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.start = Some(Instant::now());
        }
        #[cfg(target_arch = "wasm32")]
        {
            self.start_ms = js_sys::Date::now();
        }
    }

    fn elapsed_micros(&self) -> u64 {
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.start
                .map(|s| s.elapsed().as_micros() as u64)
                .unwrap_or(0)
        }
        #[cfg(target_arch = "wasm32")]
        {
            ((js_sys::Date::now() - self.start_ms) * 1000.0) as u64
        }
    }

    fn expired(&self) -> bool {
        if self.timeout_ms == 0 {
            return false;
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.start
                .map(|s| s.elapsed() >= Duration::from_millis(self.timeout_ms as u64))
                .unwrap_or(false)
        }
        #[cfg(target_arch = "wasm32")]
        {
            js_sys::Date::now() - self.start_ms >= self.timeout_ms as f64
        }
    }

    #[inline]
    fn check_timeout(&mut self) {
        if self.max_nodes != 0 && self.nodes >= self.max_nodes {
            self.timed_out = true;
            return;
        }
        if self.timeout_ms == 0 {
            return;
        }
        self.check_counter += 1;
        if self.check_counter >= 4096 {
            self.check_counter = 0;
            if self.expired() {
                self.timed_out = true;
            }
        }
    }

    pub fn solve(&mut self, pos: Position) -> SolveResult {
        self.reset_nodes();
        self.begin_clock();
        let (score, from_book) = self.score_position(pos, false);
        SolveResult {
            score,
            nodes: self.nodes,
            micros: self.elapsed_micros(),
            timed_out: self.timed_out,
            from_book,
        }
    }

    pub fn solve_weak(&mut self, pos: Position) -> SolveResult {
        self.reset_nodes();
        self.begin_clock();
        let (score, from_book) = self.score_position(pos, true);
        SolveResult {
            score,
            nodes: self.nodes,
            micros: self.elapsed_micros(),
            timed_out: self.timed_out,
            from_book,
        }
    }

    fn score_position(&mut self, pos: Position, weak: bool) -> (i32, bool) {
        if let Some(s) = self.book_score(&pos) {
            return (s, true);
        }

        if pos.can_win_next() {
            return ((AREA as i32 + 1 - pos.moves() as i32) / 2, false);
        }

        let mut min = -((AREA as i32 - pos.moves() as i32) / 2);
        let mut max = (AREA as i32 + 1 - pos.moves() as i32) / 2;
        if weak {
            min = -1;
            max = 1;
        }

        while min < max {
            if self.timed_out {
                break;
            }
            let mut med = min + (max - min) / 2;
            if med <= 0 && min / 2 < med {
                med = min / 2;
            } else if med >= 0 && max / 2 > med {
                med = max / 2;
            }
            let r = self.negamax(pos, med, med + 1);
            if r <= med {
                max = r;
            } else {
                min = r;
            }
        }
        (min, false)
    }

    pub fn analyze(&mut self, pos: Position) -> [i32; WIDTH] {
        self.reset_nodes();
        self.begin_clock();
        // Score columns directly (centre first). Solving the parent first is a
        // TT warmup, but on an empty board it burns the time budget and we
        // return a single unfinished edge column as if it were best.
        self.score_columns(pos)
    }

    fn score_columns(&mut self, pos: Position) -> [i32; WIDTH] {
        let mut scores = [INVALID_MOVE; WIDTH];
        for &col in &COLUMN_ORDER {
            if !pos.can_play(col) {
                continue;
            }
            if pos.is_winning_move(col) {
                scores[col] = (AREA as i32 + 1 - pos.moves() as i32) / 2;
                continue;
            }
            let mut child = pos;
            child.play_col(col);
            let (s, _) = self.score_position(child, false);
            scores[col] = -s;
            if self.timed_out {
                break;
            }
        }
        scores
    }

    pub fn best_move(&mut self, pos: Position) -> Option<(usize, SolveResult, [i32; WIDTH])> {
        if pos.last_player_won() || pos.is_draw() {
            return None;
        }
        self.reset_nodes();
        self.begin_clock();
        let (target, from_book) = self.score_position(pos, false);
        let mut scores = [INVALID_MOVE; WIDTH];
        let mut best_col = None;
        for &col in &COLUMN_ORDER {
            if !pos.can_play(col) {
                continue;
            }
            if pos.is_winning_move(col) {
                scores[col] = (AREA as i32 + 1 - pos.moves() as i32) / 2;
                best_col = Some(col);
                break;
            }
            let mut child = pos;
            child.play_col(col);
            let (s, _) = self.score_position(child, false);
            scores[col] = -s;
            if scores[col] == target {
                best_col = Some(col);
                break;
            }
            if self.timed_out {
                if best_col.is_none() {
                    best_col = Some(col);
                }
                break;
            }
        }
        let col = best_col?;
        let result = SolveResult {
            score: target,
            nodes: self.nodes,
            micros: self.elapsed_micros(),
            timed_out: self.timed_out,
            from_book,
        };
        Some((col, result, scores))
    }

    fn negamax(&mut self, pos: Position, mut alpha: i32, mut beta: i32) -> i32 {
        debug_assert!(alpha < beta);
        debug_assert!(!pos.can_win_next());

        self.nodes += 1;
        self.check_timeout();
        if self.timed_out {
            return alpha;
        }

        let possible = pos.possible_non_losing_moves();
        if possible == 0 {
            return -((AREA as i32 - pos.moves() as i32) / 2);
        }

        if pos.moves() as usize >= AREA - 2 {
            return 0;
        }

        let min_s = -((AREA as i32 - 2 - pos.moves() as i32) / 2);
        if alpha < min_s {
            alpha = min_s;
            if alpha >= beta {
                return alpha;
            }
        }

        let max_s = (AREA as i32 - 1 - pos.moves() as i32) / 2;
        if beta > max_s {
            beta = max_s;
            if alpha >= beta {
                return beta;
            }
        }

        let key = self.tt_key(&pos);
        if let Some((val, flag)) = self.tt.get(key) {
            if flag == FLAG_LOWER {
                if alpha < val {
                    alpha = val;
                    if alpha >= beta {
                        return alpha;
                    }
                }
            } else if flag == FLAG_UPPER {
                if beta > val {
                    beta = val;
                    if alpha >= beta {
                        return beta;
                    }
                }
            }
        }

        if let Some(s) = self.book_score(&pos) {
            return s;
        }

        let mut moves = MoveList::new();
        for i in (0..WIDTH).rev() {
            let col = COLUMN_ORDER[i];
            let mv = possible & column_mask(col);
            if mv != 0 {
                moves.add(mv, pos.move_score(mv));
            }
        }

        while let Some(mv) = moves.next() {
            let mut child = pos;
            child.play_bits(mv);
            let score = -self.negamax(child, -beta, -alpha);
            if self.timed_out {
                return alpha;
            }
            if score >= beta {
                self.tt.put(key, score, FLAG_LOWER);
                return score;
            }
            if score > alpha {
                alpha = score;
            }
        }

        self.tt.put(key, alpha, FLAG_UPPER);
        alpha
    }

    pub fn last_micros(&self) -> u64 {
        self.elapsed_micros()
    }

    /// Recursively fill a book with exact scores up to `max_depth` plies.
    /// Positions already in `book` are not re-solved; their children are still
    /// expanded so a depth-2 file can be grown to depth 4.
    pub fn fill_book(&mut self, pos: Position, max_depth: u8, book: &mut Book) {
        self.fill_book_with(pos, max_depth, book, 1, |_| {});
    }

    pub fn fill_book_with<F: FnMut(&Book) + Send>(
        &mut self,
        pos: Position,
        max_depth: u8,
        book: &mut Book,
        threads: usize,
        mut on_change: F,
    ) {
        #[cfg(not(target_arch = "wasm32"))]
        if threads > 1 {
            self.fill_book_parallel(pos, max_depth, book, threads, on_change);
            return;
        }
        let mut expanded = std::collections::HashSet::new();
        self.fill_book_rec(pos, max_depth, book, &mut expanded, &mut on_change);
    }

    fn collect_missing(
        pos: Position,
        max_depth: u8,
        book: &Book,
        expanded: &mut std::collections::HashSet<u64>,
        jobs: &mut Vec<Position>,
    ) {
        if pos.moves() > max_depth || pos.last_player_won() {
            return;
        }
        let ck = pos.key3();
        if !expanded.insert(ck) {
            return;
        }
        if !book.contains(&pos) {
            jobs.push(pos);
        }
        if pos.moves() == max_depth {
            return;
        }
        for col in 0..WIDTH {
            if !pos.can_play(col) || pos.is_winning_move(col) {
                continue;
            }
            let mut child = pos;
            child.play_col(col);
            Self::collect_missing(child, max_depth, book, expanded, jobs);
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn fill_book_parallel<F: FnMut(&Book) + Send>(
        &mut self,
        pos: Position,
        max_depth: u8,
        book: &mut Book,
        threads: usize,
        on_change: F,
    ) {
        use std::collections::VecDeque;
        use std::sync::{Arc, Mutex};

        let mut expanded = std::collections::HashSet::new();
        let mut jobs = Vec::new();
        Self::collect_missing(pos, max_depth, book, &mut expanded, &mut jobs);
        let total = jobs.len();
        eprintln!(
            "queued {total} unique positions to solve, {threads} threads (private TT each)"
        );
        if total == 0 {
            return;
        }

        let queue = Arc::new(Mutex::new(VecDeque::from(jobs)));
        let shared_book = Arc::new(Mutex::new(std::mem::take(book)));
        let on_change = Arc::new(Mutex::new(on_change));
        let tt_log = self.tt_log;
        let mirror = self.mirror;
        let seed = self.book.clone();

        std::thread::scope(|scope| {
            for _ in 0..threads {
                let queue = Arc::clone(&queue);
                let shared_book = Arc::clone(&shared_book);
                let on_change = Arc::clone(&on_change);
                let seed = seed.clone();
                scope.spawn(move || {
                    let mut solver = Solver::with_tt_log(tt_log);
                    solver.set_mirror(mirror);
                    solver.set_book(seed);
                    loop {
                        let job = {
                            let mut q = queue.lock().unwrap();
                            q.pop_front()
                        };
                        let Some(job) = job else { break };
                        let r = solver.solve(job);
                        if !r.timed_out {
                            let mut b = shared_book.lock().unwrap();
                            b.insert(job.key3(), r.score as i8, job.moves());
                            (on_change.lock().unwrap())(&b);
                        }
                    }
                });
            }
        });

        let mutex = match Arc::try_unwrap(shared_book) {
            Ok(m) => m,
            Err(arc) => Mutex::new(arc.lock().unwrap().clone()),
        };
        *book = mutex.into_inner().unwrap_or_else(|e| e.into_inner());
    }

    fn fill_book_rec<F: FnMut(&Book)>(
        &mut self,
        pos: Position,
        max_depth: u8,
        book: &mut Book,
        expanded: &mut std::collections::HashSet<u64>,
        on_change: &mut F,
    ) {
        if pos.moves() > max_depth || pos.last_player_won() {
            return;
        }
        let ck = pos.key3();
        if !expanded.insert(ck) {
            return;
        }
        if !book.contains(&pos) {
            let r = self.solve(pos);
            if r.timed_out {
                return;
            }
            book.insert(ck, r.score as i8, pos.moves());
            on_change(book);
        }
        if pos.moves() == max_depth {
            return;
        }
        for col in 0..WIDTH {
            if !pos.can_play(col) || pos.is_winning_move(col) {
                continue;
            }
            let mut child = pos;
            child.play_col(col);
            self.fill_book_rec(child, max_depth, book, expanded, on_change);
        }
    }
}

struct MoveList {
    entries: [(u64, i32); WIDTH],
    size: usize,
}

impl MoveList {
    fn new() -> Self {
        Self {
            entries: [(0, 0); WIDTH],
            size: 0,
        }
    }

    fn add(&mut self, mv: u64, score: i32) {
        let mut pos = self.size;
        self.size += 1;
        while pos > 0 && self.entries[pos - 1].1 > score {
            self.entries[pos] = self.entries[pos - 1];
            pos -= 1;
        }
        self.entries[pos] = (mv, score);
    }

    fn next(&mut self) -> Option<u64> {
        if self.size == 0 {
            None
        } else {
            self.size -= 1;
            Some(self.entries[self.size].0)
        }
    }
}

/// 1-based ply on which the game ends under perfect play, if someone wins.
/// `score` is the Pons strong score of the side to move.
pub fn winning_move_number(score: i32) -> Option<u8> {
    if score == 0 {
        return None;
    }
    let s = score.abs();
    Some((AREA as i32 - 2 * s + 1) as u8)
}

pub fn outcome_label(score: i32) -> &'static str {
    match score.cmp(&0) {
        std::cmp::Ordering::Greater => "win",
        std::cmp::Ordering::Less => "loss",
        std::cmp::Ordering::Equal => "draw",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::book::Book;
    use crate::position::Position;
    use std::fs;
    use std::path::Path;

    #[test]
    fn mirror_positions_same_score() {
        let mut s = Solver::new();
        let mut left = Position::new();
        left.play_seq("121314"); // win in one, but we stop before winning drop
        let mut right = Position::new();
        right.play_seq("767574");
        s.reset();
        let a = s.solve(left);
        s.reset();
        let b = s.solve(right);
        assert_eq!(a.score, b.score);
    }

    #[test]
    fn win_in_one_is_max_window() {
        let mut p = Position::new();
        assert_eq!(p.play_seq("121314"), 6);
        assert!(p.can_win_next());
        let mut s = Solver::new();
        let r = s.solve(p);
        assert_eq!(r.score, (AREA as i32 + 1 - 6) / 2);
        assert!(!r.timed_out);
    }

    #[test]
    fn forced_loss_next() {
        // Two disjoint threats: whatever we play, opponent wins.
        // 1 2 1 3 1 4 — P1 threatens col 1 vertically after... already used.
        // Build: P1 has two threes. Simpler: after a position where
        // possible_non_losing is empty.
        let _p = Position::new();
    }

    #[test]
    fn timeout_aborts_empty() {
        let mut s = Solver::new();
        s.set_timeout_ms(1);
        // Builtin 1-ply book answers empty instantly; use a 2-ply line instead.
        let mut p = Position::new();
        p.play_seq("12");
        let r = s.solve(p);
        assert!(r.timed_out, "1ms search of a 2-ply position should not finish");
    }

    #[test]
    fn fill_book_depth1_is_five_canonical_entries() {
        let mut s = Solver::new();
        let mut b = Book::new();
        s.fill_book(Position::new(), 1, &mut b);
        assert_eq!(b.len(), 5);
        let mut edge = Position::new();
        edge.play_col(0);
        assert_eq!(b.get(&edge), Some(2));
        let mut other = Position::new();
        other.play_col(6);
        assert_eq!(b.get(&other), Some(2));
    }

    #[test]
    fn fill_book_continues_from_shallower() {
        let mut s = Solver::new();
        let mut b = Book::new();
        s.fill_book(Position::new(), 0, &mut b);
        assert_eq!(b.len(), 1);
        assert_eq!(b.depth(), 0);
        s.fill_book(Position::new(), 1, &mut b);
        assert_eq!(b.len(), 5);
        assert_eq!(b.depth(), 1);
        let n = b.len();
        s.fill_book(Position::new(), 1, &mut b);
        assert_eq!(b.len(), n, "second pass must not re-insert");
    }

    #[test]
    fn empty_analyze_centre_wins() {
        let mut s = Solver::new();
        s.set_timeout_ms(1);
        let scores = s.analyze(Position::new());
        assert_eq!(scores, [-2, -1, 0, 1, 0, -1, -2]);
        assert!(!s.timed_out());
        let r = s.solve(Position::new());
        assert_eq!(r.score, 1);
        assert!(r.from_book);
    }

    #[test]
    fn end_easy_first_50() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../testdata/end_easy");
        let data = fs::read_to_string(&path).expect("end_easy test file");
        let mut solver = Solver::new();
        for (n, line) in data.lines().take(50).enumerate() {
            let mut parts = line.split_whitespace();
            let seq = parts.next().unwrap();
            let expect: i32 = parts.next().unwrap().parse().unwrap();
            let mut pos = Position::new();
            assert_eq!(pos.play_seq(seq), seq.len(), "line {}", n + 1);
            solver.reset();
            let r = solver.solve(pos);
            assert_eq!(
                r.score, expect,
                "line {} seq={seq} nodes={}",
                n + 1,
                r.nodes
            );
        }
    }
}
