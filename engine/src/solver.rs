//! Strong Connect 4 solver: negamax, alpha-beta, null-window score search.

use crate::move_book::MoveBook;
use crate::position::{column_mask, Position, AREA, WIDTH};
use crate::proven::{best_of, orient_cols, pack_cols, ProvenTable};
use crate::score_book::ScoreBook;
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
    pub from_score_book: bool,
}

pub struct Solver {
    tt: Table,
    score_book: ScoreBook,
    move_book: Option<MoveBook>,
    proven: ProvenTable,
    nodes: u64,
    timed_out: bool,
    check_counter: u32,
    timeout_ms: u32,
    max_nodes: u64,
    mirror: bool,
    #[cfg(not(target_arch = "wasm32"))]
    tt_log: u32,
    move_book_hit: bool,
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
            score_book: ScoreBook::opening_4ply(),
            move_book: None,
            proven: ProvenTable::new(),
            nodes: 0,
            timed_out: false,
            check_counter: 0,
            timeout_ms: 0,
            max_nodes: 0,
            mirror: true,
            #[cfg(not(target_arch = "wasm32"))]
            tt_log: log_size,
            move_book_hit: false,
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
        self.move_book_hit = false;
    }

    pub fn node_count(&self) -> u64 {
        self.nodes
    }

    pub fn timed_out(&self) -> bool {
        self.timed_out
    }

    pub fn move_book_hit(&self) -> bool {
        self.move_book_hit
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

    pub fn load_score_book(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.set_score_book(ScoreBook::load(bytes)?);
        Ok(())
    }

    pub fn set_score_book(&mut self, mut score_book: ScoreBook) {
        score_book.fill_missing(&ScoreBook::opening_4ply());
        self.score_book = score_book;
    }

    pub fn clear_score_book(&mut self) {
        // Unload the downloaded score book and restore the embedded fallback.
        self.score_book = ScoreBook::opening_4ply();
    }

    pub fn score_book(&self) -> &ScoreBook {
        &self.score_book
    }

    pub fn load_move_book(&mut self, bytes: &[u8]) -> Result<(), String> {
        let move_book = MoveBook::load(bytes)?;
        self.move_book = Some(move_book);
        Ok(())
    }

    pub fn set_move_book(&mut self, move_book: MoveBook) {
        self.move_book = Some(move_book);
    }

    pub fn clear_move_book(&mut self) {
        self.move_book = None;
    }

    pub fn move_book(&self) -> Option<&MoveBook> {
        self.move_book.as_ref()
    }

    /// Exact column scores from the score book only (no search).
    ///
    /// `None` unless every legal non-winning child is in the book, so Medium
    /// never ranks a partial set. Immediate wins use the closed-form score.
    pub fn column_scores_from_score_book(&self, pos: &Position) -> Option<[i32; WIDTH]> {
        if pos.last_player_won() || pos.is_draw() {
            return None;
        }
        let mut scores = [INVALID_MOVE; WIDTH];
        let mut playable = false;
        for (col, score) in scores.iter_mut().enumerate() {
            if !pos.can_play(col) {
                continue;
            }
            playable = true;
            *score = if pos.is_winning_move(col) {
                (AREA as i32 + 1 - pos.moves() as i32) / 2
            } else {
                let mut child = *pos;
                child.play_col(col);
                -self.score_book.get(&child)?
            };
        }
        playable.then_some(scores)
    }

    /// Scores already known from the score book, proven child positions, or immediate
    /// wins/losses. Unknown columns stay invalid; this never searches.
    pub fn known_column_scores(&self, pos: &Position) -> [i32; WIDTH] {
        let mut scores = [INVALID_MOVE; WIDTH];
        if pos.last_player_won() || pos.is_draw() {
            return scores;
        }
        for (col, score) in scores.iter_mut().enumerate() {
            if !pos.can_play(col) {
                continue;
            }
            if pos.is_winning_move(col) {
                *score = (AREA as i32 + 1 - pos.moves() as i32) / 2;
                continue;
            }
            let mut child = *pos;
            child.play_col(col);
            if let Some(s) = self.exact_score(&child) {
                *score = -s;
            } else if child.can_win_next() {
                *score = -((AREA as i32 + 1 - child.moves() as i32) / 2);
            }
        }
        scores
    }

    pub fn proven(&self) -> &ProvenTable {
        &self.proven
    }

    pub fn load_proven(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.proven = ProvenTable::load(bytes)?;
        Ok(())
    }

    pub fn merge_proven(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.proven.merge(&ProvenTable::load(bytes)?);
        Ok(())
    }

    fn score_book_score(&self, pos: &Position) -> Option<i32> {
        self.score_book.get(pos)
    }

    fn proven_score(&self, pos: &Position) -> Option<i32> {
        if self.proven.is_empty() {
            None
        } else {
            self.proven.get(self.tt_key(pos))
        }
    }

    fn exact_score(&self, pos: &Position) -> Option<i32> {
        self.score_book_score(pos)
            .or_else(|| self.proven_score(pos))
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
        let (score, from_score_book) = self.score_position(pos);
        SolveResult {
            score,
            nodes: self.nodes,
            micros: self.elapsed_micros(),
            timed_out: self.timed_out,
            from_score_book,
        }
    }

    fn score_position(&mut self, pos: Position) -> (i32, bool) {
        if let Some(s) = self.score_book_score(&pos) {
            return (s, true);
        }
        if let Some(s) = self.proven_score(&pos) {
            return (s, false);
        }

        if pos.can_win_next() {
            return ((AREA as i32 + 1 - pos.moves() as i32) / 2, false);
        }

        let mut min = -((AREA as i32 - pos.moves() as i32) / 2);
        let mut max = (AREA as i32 + 1 - pos.moves() as i32) / 2;

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
        if !self.timed_out {
            self.proven.insert_score(self.tt_key(&pos), min as i8);
        }
        (min, false)
    }

    pub fn analyze(&mut self, pos: Position) -> [i32; WIDTH] {
        self.reset_nodes();
        self.begin_clock();
        // Score columns directly (centre first). Solving the parent first is a
        // TT warmup, but on an empty board it burns the time budget and we
        // return a single unfinished edge column as if it were best.
        let scores = self.score_columns(pos);
        if !self.timed_out {
            if let Some(s) = best_of(&scores) {
                let cols = orient_cols(pack_cols(&scores), pos.is_mirrored());
                self.proven.insert(self.tt_key(&pos), s as i8, Some(cols));
            }
        }
        scores
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
            // Aborted search returns a bound, not an exact child score. Leave
            // this column and later ones invalid instead of displaying that
            // bound as a proven win, loss, or draw.
            let (s, _) = self.score_position(child);
            if self.timed_out {
                break;
            }
            scores[col] = -s;
        }
        scores
    }

    /// Find the first optimal move in column order. Returned column scores are
    /// exact where known; `INVALID_MOVE` also marks candidates whose exact
    /// scores were not needed. Use `analyze` for complete column scores.
    pub fn best_move(&mut self, pos: Position) -> Option<(usize, SolveResult, [i32; WIDTH])> {
        if pos.last_player_won() || pos.is_draw() {
            return None;
        }
        self.reset_nodes();
        self.begin_clock();
        let (target, from_score_book) = self.score_position(pos);
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
            // A timed-out parent solve has not established an exact target.
            // Return a legal fallback without certifying any column score.
            if self.timed_out {
                best_col = Some(col);
                break;
            }
            let mut child = pos;
            child.play_col(col);
            let (s, exact) = if let Some(s) = self.exact_score(&child) {
                (s, true)
            } else if child.can_win_next() {
                // negamax requires that the side to move cannot win in one.
                ((AREA as i32 + 1 - child.moves() as i32) / 2, true)
            } else {
                // The exact parent value implies every child is >= -target.
                // Proving child <= -target therefore certifies an optimal move;
                // we do not need the full score of an inferior candidate.
                (self.negamax(child, -target, -target + 1), false)
            };
            // Aborted negamax returns alpha, which could otherwise look like
            // a successful threshold proof. Never expose or cache that value.
            if self.timed_out {
                best_col = Some(col);
                break;
            }
            if exact {
                scores[col] = -s;
            }
            if s <= -target {
                scores[col] = target;
                if !exact {
                    self.proven
                        .insert_score(self.tt_key(&child), (-target) as i8);
                }
                best_col = Some(col);
                break;
            }
        }
        let col = best_col?;
        let result = SolveResult {
            score: target,
            nodes: self.nodes,
            micros: self.elapsed_micros(),
            timed_out: self.timed_out,
            from_score_book,
        };
        Some((col, result, scores))
    }

    /// Select a move for gameplay. A move-book hit performs no score search and
    /// does not add an entry to either the transposition or proven tables.
    pub fn select_move(&mut self, pos: Position) -> Option<usize> {
        self.reset_nodes();
        self.begin_clock();
        if pos.last_player_won() || pos.is_draw() {
            return None;
        }
        if let Some(col) = self
            .move_book
            .as_ref()
            .and_then(|move_book| move_book.get(&pos))
        {
            self.move_book_hit = true;
            return Some(col);
        }
        self.best_move(pos).map(|(col, _, _)| col)
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

        if let Some(s) = self.exact_score(&pos) {
            return s;
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
            } else if flag == FLAG_UPPER && beta > val {
                beta = val;
                if alpha >= beta {
                    return beta;
                }
            }
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

    /// Recursively fill a score book with exact scores up to `max_depth` plies.
    /// Positions already in `score_book` are not re-solved; their children are still
    /// expanded so a depth-2 file can be grown to depth 4.
    pub fn fill_score_book(&mut self, pos: Position, max_depth: u8, score_book: &mut ScoreBook) {
        self.fill_score_book_with(pos, max_depth, score_book, 1, |_| {});
    }

    pub fn fill_score_book_with<F: FnMut(&ScoreBook) + Send>(
        &mut self,
        pos: Position,
        max_depth: u8,
        score_book: &mut ScoreBook,
        threads: usize,
        mut on_change: F,
    ) {
        #[cfg(target_arch = "wasm32")]
        let _ = threads;
        #[cfg(not(target_arch = "wasm32"))]
        if threads > 1 {
            self.fill_score_book_parallel(pos, max_depth, score_book, threads, on_change);
            return;
        }
        let mut expanded = std::collections::HashSet::new();
        self.fill_score_book_rec(pos, max_depth, score_book, &mut expanded, &mut on_change);
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn collect_missing(
        pos: Position,
        max_depth: u8,
        score_book: &ScoreBook,
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
        if !score_book.contains(&pos) {
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
            Self::collect_missing(child, max_depth, score_book, expanded, jobs);
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn fill_score_book_parallel<F: FnMut(&ScoreBook) + Send>(
        &mut self,
        pos: Position,
        max_depth: u8,
        score_book: &mut ScoreBook,
        threads: usize,
        on_change: F,
    ) {
        use std::collections::VecDeque;
        use std::sync::{Arc, Mutex};

        let mut expanded = std::collections::HashSet::new();
        let mut jobs = Vec::new();
        Self::collect_missing(pos, max_depth, score_book, &mut expanded, &mut jobs);
        let total = jobs.len();
        eprintln!("queued {total} unique positions to solve, {threads} threads (private TT each)");
        if total == 0 {
            return;
        }

        let queue = Arc::new(Mutex::new(VecDeque::from(jobs)));
        let shared_score_book = Arc::new(Mutex::new(std::mem::take(score_book)));
        let on_change = Arc::new(Mutex::new(on_change));
        let tt_log = self.tt_log;
        let mirror = self.mirror;
        let seed = self.score_book.clone();

        std::thread::scope(|scope| {
            for _ in 0..threads {
                let queue = Arc::clone(&queue);
                let shared_score_book = Arc::clone(&shared_score_book);
                let on_change = Arc::clone(&on_change);
                let seed = seed.clone();
                scope.spawn(move || {
                    let mut solver = Solver::with_tt_log(tt_log);
                    solver.set_mirror(mirror);
                    solver.set_score_book(seed);
                    loop {
                        let job = {
                            let mut q = queue.lock().unwrap();
                            q.pop_front()
                        };
                        let Some(job) = job else { break };
                        let r = solver.solve(job);
                        if !r.timed_out {
                            let mut b = shared_score_book.lock().unwrap();
                            b.insert(job.key3(), r.score as i8, job.moves());
                            (on_change.lock().unwrap())(&b);
                        }
                    }
                });
            }
        });

        let mutex = match Arc::try_unwrap(shared_score_book) {
            Ok(m) => m,
            Err(arc) => Mutex::new(arc.lock().unwrap().clone()),
        };
        *score_book = mutex.into_inner().unwrap_or_else(|e| e.into_inner());
    }

    fn fill_score_book_rec<F: FnMut(&ScoreBook)>(
        &mut self,
        pos: Position,
        max_depth: u8,
        score_book: &mut ScoreBook,
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
        if !score_book.contains(&pos) {
            let r = self.solve(pos);
            if r.timed_out {
                return;
            }
            score_book.insert(ck, r.score as i8, pos.moves());
            on_change(score_book);
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
            self.fill_score_book_rec(child, max_depth, score_book, expanded, on_change);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::move_book::MoveBook;
    use crate::position::Position;
    use crate::score_book::ScoreBook;
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
    fn best_move_proves_the_four_ply_frontier_without_scoring_every_child() {
        let mut solver = Solver::with_tt_log(20);
        let mut pos = Position::new();
        pos.play_seq("4455");
        assert_eq!(solver.score_book().depth(), 4);
        // An ordinary full child solve exceeds this budget. The known parent
        // score proves the fork with only a few threshold-search nodes.
        solver.max_nodes = 100;
        let (col, result, scores) = solver.best_move(pos).unwrap();
        assert_eq!(col, 2);
        assert_eq!(result.score, 18);
        assert!(!result.timed_out);
        assert!(result.from_score_book);
        assert_eq!(scores[2], 18);
        assert_eq!(scores[3], INVALID_MOVE);
        assert_eq!(scores[4], INVALID_MOVE);

        let mut chosen = pos;
        chosen.play_col(col);
        // The completed proof remains usable after the session TT is cleared.
        solver.reset();
        let cached = solver.solve(chosen);
        assert_eq!(cached.score, -18);
        assert_eq!(cached.nodes, 0);
        assert!(!cached.timed_out);
    }

    #[test]
    fn best_move_does_not_accept_a_timed_out_child_probe() {
        let mut solver = Solver::with_tt_log(20);
        let mut pos = Position::new();
        pos.play_seq("4444");
        solver.max_nodes = 1;
        let (col, result, scores) = solver.best_move(pos).unwrap();
        assert!(pos.can_play(col));
        assert!(result.from_score_book);
        assert!(result.timed_out);
        assert_eq!(result.nodes, 1);
        assert_eq!(scores, [INVALID_MOVE; WIDTH]);
    }

    #[test]
    fn best_move_does_not_probe_against_an_unfinished_parent_score() {
        let mut solver = Solver::with_tt_log(20);
        let mut pos = Position::new();
        pos.play_seq("123456");
        solver.max_nodes = 1;
        let (col, result, scores) = solver.best_move(pos).unwrap();
        assert!(pos.can_play(col));
        assert!(!result.from_score_book);
        assert!(result.timed_out);
        // Only the interrupted parent search should visit a node.
        assert_eq!(result.nodes, 1);
        assert_eq!(scores, [INVALID_MOVE; WIDTH]);
    }

    #[test]
    fn best_move_matches_full_analysis_for_wins_draws_and_losses() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../testdata/end_easy");
        let data = fs::read_to_string(path).unwrap();
        let mut reference = Solver::with_tt_log(20);
        let mut solver = Solver::with_tt_log(20);
        let mut outcomes = [false; 3];
        for (n, line) in data.lines().take(50).enumerate() {
            let fields: Vec<_> = line.split_whitespace().collect();
            let expected: i32 = fields[1].parse().unwrap();
            outcomes[(expected.signum() + 1) as usize] = true;
            for seq in [fields[0].to_owned(), mirror_seq(fields[0])] {
                let mut pos = Position::new();
                assert_eq!(pos.play_seq(&seq), seq.len());
                reference.reset();
                let full = reference.analyze(pos);
                assert!(!reference.timed_out());
                assert_eq!(best_of(&full), Some(expected));
                let expected_col = COLUMN_ORDER
                    .iter()
                    .copied()
                    .find(|&c| full[c] == expected)
                    .unwrap();

                solver.reset();
                solver.proven = ProvenTable::new();
                // Exercise both a persisted exact parent and a fresh solve.
                if n % 2 == 0 {
                    solver
                        .proven
                        .insert_score(pos.canonical_key(), expected as i8);
                }
                let (col, result, partial) = solver.best_move(pos).unwrap();
                assert!(!result.timed_out, "{seq}");
                assert_eq!(result.score, expected, "{seq}");
                assert_eq!(col, expected_col, "{seq}");
                assert_eq!(partial[col], expected, "{seq}");
                let nodes = solver.node_count();
                let known = solver.known_column_scores(&pos);
                assert_eq!(
                    known[col], expected,
                    "selected column must remain available: {seq}"
                );
                assert_eq!(solver.node_count(), nodes, "reading hints must not search");
                for c in 0..WIDTH {
                    if partial[c] != INVALID_MOVE {
                        assert_eq!(partial[c], full[c], "{seq}, column {c}");
                    }
                    if known[c] != INVALID_MOVE {
                        assert_eq!(known[c], full[c], "known hint: {seq}, column {c}");
                    }
                }
            }
        }
        assert_eq!(outcomes, [true; 3]);
    }

    #[test]
    fn best_move_handles_immediate_wins_and_terminal_positions() {
        let mut solver = Solver::with_tt_log(20);
        let mut pos = Position::new();
        pos.play_seq("121314");
        let (col, result, scores) = solver.best_move(pos).unwrap();
        assert_eq!(col, 0);
        assert_eq!(result.score, 18);
        assert_eq!(scores[col], 18);
        assert!(!result.timed_out);
        pos.play_col(col);
        assert!(solver.best_move(pos).is_none());
    }

    #[test]
    fn timeout_aborts_search_beyond_embedded_score_book() {
        let mut s = Solver::new();
        s.set_timeout_ms(1);
        // Search beyond the embedded 4-ply score book.
        let mut p = Position::new();
        p.play_seq("123456");
        let r = s.solve(p);
        assert!(
            r.timed_out,
            "1ms search of a 6-ply position should not finish"
        );
    }

    #[test]
    fn downloaded_score_book_replaces_embedded_score_book_and_clear_restores_it() {
        let mut solver = Solver::with_tt_log(16);
        let mut pos = Position::new();
        pos.play_seq("1234");
        let initial = solver.solve(pos);
        assert!(initial.from_score_book);
        assert_eq!(initial.nodes, 0);
        assert_eq!(solver.score_book().depth(), 4);
        assert_eq!(solver.score_book().len(), 719);

        solver
            .load_score_book(include_bytes!("../../books/8ply.c4book"))
            .unwrap();
        assert_eq!(solver.score_book().depth(), 8);
        assert_eq!(solver.score_book().len(), 129_498);
        assert_eq!(solver.solve(pos).score, initial.score);
        assert!(solver.load_score_book(b"invalid").is_err());
        assert_eq!(
            solver.score_book().depth(),
            8,
            "bad downloads must not replace a valid score book"
        );

        solver.clear_score_book();
        assert_eq!(solver.score_book().depth(), 4);
        assert_eq!(solver.score_book().len(), 719);
        assert_eq!(solver.solve(pos).score, initial.score);
    }

    #[test]
    fn empty_download_keeps_embedded_opening_coverage() {
        let mut solver = Solver::with_tt_log(16);
        let embedded = solver.score_book().save();
        let mut empty = ScoreBook::new().save();
        // Even an empty file declaring a deeper score book must retain the fallback.
        empty[5] = 12;
        solver.load_score_book(&empty).unwrap();
        assert_eq!(solver.score_book().save(), embedded);
        let scores = solver.analyze(Position::new());
        assert_eq!(scores, [-2, -1, 0, 1, 0, -1, -2]);
        assert_eq!(solver.node_count(), 0);
    }

    #[test]
    fn shallow_download_keeps_embedded_opening_coverage() {
        let mut solver = Solver::with_tt_log(16);
        let embedded = solver.score_book().save();
        solver
            .load_score_book(include_bytes!("../../books/2ply.c4book"))
            .unwrap();
        assert_eq!(solver.score_book().save(), embedded);
        let mut pos = Position::new();
        pos.play_seq("1234");
        let result = solver.solve(pos);
        assert!(result.from_score_book);
        assert_eq!(result.nodes, 0);
    }

    #[test]
    fn sparse_deep_score_book_keeps_its_entries_and_embedded_coverage() {
        let embedded = ScoreBook::opening_4ply();
        let deeper = ScoreBook::load(include_bytes!("../../books/8ply.c4book")).unwrap();
        let mut pos = Position::new();
        pos.play_seq("12345");
        let score = deeper.get(&pos).unwrap();
        let mut sparse = ScoreBook::new();
        sparse.insert(pos.key3(), score as i8, pos.moves());

        let mut solver = Solver::with_tt_log(16);
        solver.set_score_book(sparse);
        assert_eq!(solver.score_book().depth(), 5);
        assert_eq!(solver.score_book().len(), embedded.len() + 1);
        let extra = solver.solve(pos);
        assert_eq!(extra.score, score);
        assert_eq!(extra.nodes, 0);
        let mut opening = Position::new();
        opening.play_seq("1234");
        let embedded_hit = solver.solve(opening);
        assert!(embedded_hit.from_score_book);
        assert_eq!(embedded_hit.nodes, 0);
    }

    #[test]
    fn fill_score_book_depth1_is_five_canonical_entries() {
        let mut s = Solver::new();
        let mut b = ScoreBook::new();
        s.fill_score_book(Position::new(), 1, &mut b);
        assert_eq!(b.len(), 5);
        let mut edge = Position::new();
        edge.play_col(0);
        assert_eq!(b.get(&edge), Some(2));
        let mut other = Position::new();
        other.play_col(6);
        assert_eq!(b.get(&other), Some(2));
    }

    #[test]
    fn fill_score_book_continues_from_shallower() {
        let mut s = Solver::new();
        let mut b = ScoreBook::new();
        s.fill_score_book(Position::new(), 0, &mut b);
        assert_eq!(b.len(), 1);
        assert_eq!(b.depth(), 0);
        s.fill_score_book(Position::new(), 1, &mut b);
        assert_eq!(b.len(), 5);
        assert_eq!(b.depth(), 1);
        let n = b.len();
        s.fill_score_book(Position::new(), 1, &mut b);
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
        assert!(r.from_score_book);
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
                r.score,
                expect,
                "line {} seq={seq} nodes={}",
                n + 1,
                r.nodes
            );
        }
    }

    fn end_easy_first() -> Position {
        let mut pos = Position::new();
        let seq = "2252576253462244111563365343671351441";
        assert_eq!(pos.play_seq(seq), seq.len());
        pos
    }

    #[test]
    fn proven_hit_after_tt_reset_is_zero_nodes() {
        let mut solver = Solver::new();
        let pos = end_easy_first();
        let r1 = solver.solve(pos);
        assert!(!r1.timed_out);
        assert_eq!(r1.score, -1);
        assert!(
            r1.nodes > 0 || solver.proven().get(pos.canonical_key()) == Some(-1),
            "search or trivial prove should populate the table"
        );
        solver.reset();
        let r2 = solver.solve(pos);
        assert_eq!(r2.score, -1);
        assert_eq!(r2.nodes, 0);
        assert!(!r2.from_score_book);
    }

    #[test]
    fn proven_blob_reloads_into_fresh_solver() {
        let mut solver = Solver::new();
        let pos = end_easy_first();
        let r1 = solver.solve(pos);
        assert!(!r1.timed_out);
        let blob = solver.proven().save();
        let mut s2 = Solver::new();
        s2.load_proven(&blob).unwrap();
        let r2 = s2.solve(pos);
        assert_eq!(r2.score, r1.score);
        assert_eq!(r2.nodes, 0);
    }

    fn mirror_seq(seq: &str) -> String {
        seq.chars()
            .map(|c| {
                let d = (c as u8).saturating_sub(b'1');
                char::from(b'1' + (6 - d))
            })
            .collect()
    }

    #[test]
    fn cached_columns_follow_the_board_not_the_canonical_key() {
        let seq = "2252576253462244111563365343671351441";
        let mut left = Position::new();
        assert_eq!(left.play_seq(seq), seq.len());
        let mir = mirror_seq(seq);
        let mut right = Position::new();
        assert_eq!(right.play_seq(&mir), mir.len());
        assert_eq!(left.canonical_key(), right.canonical_key());
        assert_ne!(left.key(), right.key(), "fixture must not be symmetric");

        let mut solver = Solver::new();
        let scores_l = solver.analyze(left);
        assert!(!solver.timed_out());
        assert_eq!(solver.known_column_scores(&left), scores_l);
        let mut expected_r = scores_l;
        expected_r.reverse();
        assert_eq!(solver.known_column_scores(&right), expected_r);
    }

    #[test]
    fn merge_proven_keeps_local_and_disk_entries() {
        let mut a = Solver::new();
        let pos = end_easy_first();
        let r = a.solve(pos);
        let blob = a.proven().save();

        let mut b = Solver::new();
        let mut other = Position::new();
        other.play_seq("7422341735647741166133573473242566");
        let r2 = b.solve(other);
        b.merge_proven(&blob).unwrap();
        assert_eq!(b.proven().get(pos.canonical_key()), Some(r.score));
        assert_eq!(b.proven().get(other.canonical_key()), Some(r2.score));
    }

    #[test]
    fn select_move_book_hit_resets_stats_and_does_not_pollute_proven_cache() {
        let mut covered = Position::new();
        covered.play_seq("12345");
        let mut move_book = MoveBook::empty(10).unwrap();
        move_book.insert(&covered, 3).unwrap();

        let mut solver = Solver::with_tt_log(16);
        solver.set_timeout_ms(1);
        let mut expensive = Position::new();
        expensive.play_seq("123456");
        let previous = solver.solve(expensive);
        assert!(previous.timed_out);
        let proven_before = solver.proven().save();

        solver.set_move_book(move_book);
        assert_eq!(solver.select_move(covered), Some(3));
        assert_eq!(solver.node_count(), 0);
        assert!(!solver.timed_out());
        assert!(solver.move_book_hit());
        assert_eq!(solver.proven().save(), proven_before);
    }

    #[test]
    fn select_move_miss_falls_back_and_terminal_resets_stats() {
        let mut solver = Solver::with_tt_log(16);
        solver.set_move_book(MoveBook::empty(10).unwrap());
        let pos = Position::new();
        assert_eq!(solver.select_move(pos), Some(3));
        assert!(!solver.move_book_hit());

        let mut terminal = Position::new();
        terminal.play_seq("121314");
        terminal.play_col(0);
        assert_eq!(solver.select_move(terminal), None);
        assert_eq!(solver.node_count(), 0);
        assert!(!solver.timed_out());
        assert!(!solver.move_book_hit());
    }

    #[test]
    fn malformed_move_book_does_not_replace_active_move_book() {
        let mut pos = Position::new();
        pos.play_seq("1234");
        let mut move_book = MoveBook::empty(10).unwrap();
        move_book.insert(&pos, 2).unwrap();
        let mut solver = Solver::with_tt_log(16);
        solver.load_move_book(&move_book.save()).unwrap();
        assert_eq!(solver.select_move(pos), Some(2));
        assert!(solver.load_move_book(b"invalid").is_err());
        assert_eq!(solver.select_move(pos), Some(2));
        solver.clear_move_book();
        assert!(solver.move_book().is_none());
    }

    #[test]
    fn column_scores_from_embedded_score_book_match_empty_board_analysis() {
        let solver = Solver::new();
        let scores = solver
            .column_scores_from_score_book(&Position::new())
            .expect("empty board children are in the 4-ply score book");
        assert_eq!(scores, [-2, -1, 0, 1, 0, -1, -2]);
        assert_eq!(solver.node_count(), 0);
    }

    #[test]
    fn column_scores_from_score_book_require_every_child() {
        let solver = Solver::new();
        let mut pos = Position::new();
        pos.play_seq("4444");
        assert_eq!(pos.moves(), 4);
        assert!(solver.column_scores_from_score_book(&pos).is_none());

        let mut shallower = Position::new();
        shallower.play_seq("444");
        let scores = solver
            .column_scores_from_score_book(&shallower)
            .expect("ply-3 children are in the 4-ply score book");
        assert_eq!(scores.iter().filter(|&&s| s != INVALID_MOVE).count(), 7);
    }

    #[test]
    fn eight_ply_score_book_scores_ply_seven_but_not_ply_eight() {
        let mut solver = Solver::with_tt_log(16);
        solver
            .load_score_book(include_bytes!("../../books/8ply.c4book"))
            .unwrap();
        let mut ply7 = Position::new();
        ply7.play_seq("1234567");
        assert_eq!(ply7.moves(), 7);
        assert!(solver.column_scores_from_score_book(&ply7).is_some());
        let mut ply8 = Position::new();
        ply8.play_seq("12345671");
        assert_eq!(ply8.moves(), 8);
        assert!(solver.column_scores_from_score_book(&ply8).is_none());
    }

    #[test]
    fn column_scores_from_score_book_leave_select_move_stats_alone() {
        let mut solver = Solver::new();
        let pos = Position::new();
        assert_eq!(solver.select_move(pos), Some(3));
        let nodes = solver.node_count();
        let hit = solver.move_book_hit();
        let _ = solver.column_scores_from_score_book(&pos);
        assert_eq!(solver.node_count(), nodes);
        assert_eq!(solver.move_book_hit(), hit);
    }

    #[test]
    fn known_columns_keep_unsearched_and_aborted_children_unknown() {
        let mut solver = Solver::with_tt_log(20);
        let mut pos = Position::new();
        pos.play_seq("4455");
        assert_eq!(solver.known_column_scores(&pos), [INVALID_MOVE; WIDTH]);
        solver.max_nodes = 100;
        let (col, result, _) = solver.best_move(pos).unwrap();
        assert!(!result.timed_out);
        let cache = solver.proven.save();
        let known = solver.known_column_scores(&pos);
        assert_eq!(known[col], 18);
        assert_eq!(known[3], INVALID_MOVE);
        assert_eq!(known[4], INVALID_MOVE);
        assert_eq!(solver.node_count(), result.nodes);
        assert_eq!(solver.proven.save(), cache);
        assert!(solver.column_scores_from_score_book(&pos).is_none());

        let mut interrupted = Solver::with_tt_log(20);
        let mut pos = Position::new();
        pos.play_seq("4444");
        interrupted.max_nodes = 1;
        interrupted.best_move(pos).unwrap();
        assert!(interrupted.timed_out());
        assert_eq!(interrupted.known_column_scores(&pos), [INVALID_MOVE; WIDTH]);
        assert_eq!(interrupted.node_count(), 1);
        assert!(interrupted.timed_out());
    }

    fn analysis_timeout_pos() -> Position {
        let mut pos = Position::new();
        assert_eq!(pos.play_seq("122435527534575161761"), 21);
        pos
    }

    fn complete_analysis_timeout_pos() -> (Position, [i32; WIDTH]) {
        let pos = analysis_timeout_pos();
        let mut reference = Solver::with_tt_log(20);
        let full = reference.analyze(pos);
        assert!(!reference.timed_out());
        assert_eq!(full, [-1, 0, 10, 10, -2, -2, -2]);
        (pos, full)
    }

    #[test]
    fn analyze_timeout_during_an_early_child_leaves_columns_invalid() {
        let pos = analysis_timeout_pos();
        let mut solver = Solver::with_tt_log(20);
        solver.max_nodes = 1;
        let scores = solver.analyze(pos);
        assert!(solver.timed_out());
        assert_eq!(scores, [INVALID_MOVE; WIDTH]);
        assert_eq!(solver.known_column_scores(&pos), [INVALID_MOVE; WIDTH]);
    }

    #[test]
    fn analyze_timeout_during_the_last_child_keeps_prior_exact_scores() {
        let (pos, full) = complete_analysis_timeout_pos();
        let mut solver = Solver::with_tt_log(20);
        // Enough nodes to finish columns 3,4,2,5,1,6; not enough for column 0.
        solver.max_nodes = 30_000;
        let scores = solver.analyze(pos);
        assert!(solver.timed_out());
        assert_eq!(scores[0], INVALID_MOVE);
        for col in 1..WIDTH {
            assert_eq!(scores[col], full[col], "column {col}");
        }
        assert_eq!(solver.known_column_scores(&pos), scores);
        assert!(solver.proven().get_entry(pos.canonical_key()).is_none());

        solver.max_nodes = 0;
        let again = solver.analyze(pos);
        assert!(!solver.timed_out());
        assert_eq!(again, full);
        assert_eq!(solver.known_column_scores(&pos), full);
    }
}
