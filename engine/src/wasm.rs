use crate::position::Position;
use crate::proven::{orient_cols, unpack_cols};
use crate::solver::{Solver, INVALID_MOVE};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct WasmEngine {
    solver: Solver,
}

#[wasm_bindgen]
impl WasmEngine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> WasmEngine {
        WasmEngine {
            solver: Solver::new(),
        }
    }

    #[wasm_bindgen(js_name = setTimeoutMs)]
    pub fn set_timeout_ms(&mut self, ms: u32) {
        self.solver.set_timeout_ms(ms);
    }

    #[wasm_bindgen(js_name = loadScoreBook)]
    pub fn load_score_book(&mut self, data: &[u8]) -> bool {
        self.solver.load_score_book(data).is_ok()
    }

    #[wasm_bindgen(js_name = clearScoreBook)]
    pub fn clear_score_book(&mut self) {
        self.solver.clear_score_book();
    }

    #[wasm_bindgen(js_name = loadMoveBook)]
    pub fn load_move_book(&mut self, data: &[u8]) -> bool {
        self.solver.load_move_book(data).is_ok()
    }

    #[wasm_bindgen(js_name = clearMoveBook)]
    pub fn clear_move_book(&mut self) {
        self.solver.clear_move_book();
    }

    #[wasm_bindgen(js_name = resetTt)]
    pub fn reset_tt(&mut self) {
        self.solver.reset();
    }

    #[wasm_bindgen(js_name = nodeCount)]
    pub fn node_count(&self) -> f64 {
        self.solver.node_count() as f64
    }

    #[wasm_bindgen(js_name = timedOut)]
    pub fn timed_out(&self) -> bool {
        self.solver.timed_out()
    }

    #[wasm_bindgen(js_name = scoreBookMoves)]
    pub fn score_book_moves(&self) -> u8 {
        self.solver.score_book().moves_covered()
    }

    #[wasm_bindgen(js_name = scoreBookLen)]
    pub fn score_book_len(&self) -> u32 {
        self.solver.score_book().len() as u32
    }

    /// Seven column scores from the score book, or empty if any child is missing.
    /// Does not reset search stats; call after `bestMove`.
    #[wasm_bindgen(js_name = scoreBookColumnScores)]
    pub fn score_book_column_scores(&self, moves: &[u8]) -> Vec<i16> {
        let mut p = Position::new();
        if !p.play_moves(moves) {
            return Vec::new();
        }
        match self.solver.column_scores_from_score_book(&p) {
            Some(scores) => scores.iter().map(|&s| s as i16).collect(),
            None => Vec::new(),
        }
    }

    /// Read-only hint scores, including children proved by the latest search.
    /// Unknown and full columns are `INVALID_MOVE`; search stats are unchanged.
    #[wasm_bindgen(js_name = knownColumnScores)]
    pub fn known_column_scores(&self, moves: &[u8]) -> Vec<i16> {
        let mut p = Position::new();
        if !p.play_moves(moves) {
            return vec![INVALID_MOVE as i16; 7];
        }
        self.solver
            .known_column_scores(&p)
            .iter()
            .map(|&s| s as i16)
            .collect()
    }

    #[wasm_bindgen(js_name = moveBookMoves)]
    pub fn move_book_moves(&self) -> u8 {
        self.solver
            .move_book()
            .map(|move_book| move_book.moves_covered())
            .unwrap_or(0)
    }

    #[wasm_bindgen(js_name = moveBookPopulated)]
    pub fn move_book_populated(&self) -> u32 {
        self.solver
            .move_book()
            .map(|move_book| move_book.populated())
            .unwrap_or(0)
    }

    #[wasm_bindgen(js_name = moveBookHit)]
    pub fn move_book_hit(&self) -> bool {
        self.solver.move_book_hit()
    }

    /// Unique 49-bit key as a string.
    pub fn key(&self, moves: &[u8]) -> Option<String> {
        let mut p = Position::new();
        if !p.play_moves(moves) {
            return None;
        }
        Some(p.canonical_key().to_string())
    }

    /// Miss: empty. Hit: `[score]` or `[score, c0..c6]` (`-1000` = unplayable).
    #[wasm_bindgen(js_name = cacheGet)]
    pub fn cache_get(&self, moves: &[u8]) -> Vec<i16> {
        let mut p = Position::new();
        if !p.play_moves(moves) {
            return Vec::new();
        }
        let Some(e) = self.solver.proven().get_entry(p.canonical_key()) else {
            return Vec::new();
        };
        let mut out = vec![e.score as i16];
        if let Some(cols) = e.cols {
            let cols = orient_cols(cols, p.is_mirrored());
            out.extend(unpack_cols(&cols).iter().map(|&s| s as i16));
        }
        out
    }

    /// Merge a persisted blob into the in-memory table (does not replace).
    #[wasm_bindgen(js_name = cacheLoad)]
    pub fn cache_load(&mut self, data: &[u8]) -> bool {
        self.solver.merge_proven(data).is_ok()
    }

    #[wasm_bindgen(js_name = cacheSave)]
    pub fn cache_save(&self) -> Vec<u8> {
        self.solver.proven().save()
    }

    #[wasm_bindgen(js_name = cacheLen)]
    pub fn cache_len(&self) -> u32 {
        self.solver.proven().len() as u32
    }

    pub fn solve(&mut self, moves: &[u8]) -> i8 {
        let mut p = Position::new();
        if !p.play_moves(moves) {
            return INVALID_MOVE as i8;
        }
        self.solver.solve(p).score as i8
    }

    /// 7 scores, `INVALID_MOVE` (-1000 as i16) for full or unfinished columns.
    pub fn analyze(&mut self, moves: &[u8]) -> Vec<i16> {
        let mut p = Position::new();
        if !p.play_moves(moves) {
            return vec![INVALID_MOVE as i16; 7];
        }
        self.solver.analyze(p).iter().map(|&s| s as i16).collect()
    }

    /// 0-based column, or 255 if none.
    #[wasm_bindgen(js_name = bestMove)]
    pub fn best_move(&mut self, moves: &[u8]) -> u8 {
        self.solver.reset_nodes();
        let mut p = Position::new();
        if !p.play_moves(moves) {
            return 255;
        }
        self.solver.select_move(p).map(|c| c as u8).unwrap_or(255)
    }

    pub fn micros(&self) -> f64 {
        self.solver.last_micros() as f64
    }
}

impl Default for WasmEngine {
    fn default() -> Self {
        Self::new()
    }
}
