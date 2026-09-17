use crate::position::Position;
use crate::solver::{Solver, INVALID_MOVE};
use wasm_bindgen::prelude::*;

/// "No column" sentinel for 0-based column results crossing the WASM
/// boundary (legal columns are 0-6). Mirrors `NO_COLUMN` in the web
/// `engineProtocol` module; the two must stay in sync.
const NO_COLUMN: u8 = 255;

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

    /// Instant hint preview in one call: seven search-free column scores
    /// (`INVALID_MOVE` where unknown), the move-book suggestion, and the
    /// certified column (`NO_COLUMN` where absent). An immediate winning
    /// drop is proved even without a book; a move-book suggestion is
    /// proved only when its score is known. Read-only: no search, stats
    /// unchanged.
    #[wasm_bindgen(js_name = previewScores)]
    pub fn preview_scores(&self, moves: &[u8]) -> Vec<i16> {
        let mut p = Position::new();
        if !p.play_moves(moves) {
            let mut out = vec![INVALID_MOVE as i16; 7];
            out.push(NO_COLUMN as i16);
            out.push(NO_COLUMN as i16);
            return out;
        }
        let (scores, book, proven) = self.solver.hint_preview(&p);
        let mut out: Vec<i16> = scores.iter().map(|&s| s as i16).collect();
        out.push(book.map(|c| c as i16).unwrap_or(NO_COLUMN as i16));
        out.push(proven.map(|c| c as i16).unwrap_or(NO_COLUMN as i16));
        out
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

    /// Copy the transposition table out as bytes, for IndexedDB persistence.
    #[wasm_bindgen(js_name = ttSave)]
    pub fn tt_save(&self) -> Vec<u8> {
        self.solver.tt().save()
    }

    /// Restore the transposition table from a snapshot produced by `ttSave`.
    /// Rejects a blob whose size or version does not match this table, so a
    /// native-sized or truncated blob cannot corrupt it.
    #[wasm_bindgen(js_name = ttLoad)]
    pub fn tt_load(&mut self, data: &[u8]) -> bool {
        self.solver.tt_mut().load(data).is_ok()
    }

    /// Hint scores after the most recent `bestMove`: the search's own scores
    /// overlaid on the search-free columns it did not visit. Does not search.
    #[wasm_bindgen(js_name = hintScores)]
    pub fn hint_scores(&self, moves: &[u8]) -> Vec<i16> {
        let mut p = Position::new();
        if !p.play_moves(moves) {
            return vec![INVALID_MOVE as i16; 7];
        }
        self.solver
            .search_hint_scores(&p)
            .iter()
            .map(|&s| s as i16)
            .collect()
    }

    /// 7 scores, `INVALID_MOVE` (-1000 as i16) for full or unfinished columns.
    pub fn analyze(&mut self, moves: &[u8]) -> Vec<i16> {
        let mut p = Position::new();
        if !p.play_moves(moves) {
            return vec![INVALID_MOVE as i16; 7];
        }
        self.solver.analyze(p).iter().map(|&s| s as i16).collect()
    }

    /// 0-based column, or `NO_COLUMN` if none.
    #[wasm_bindgen(js_name = bestMove)]
    pub fn best_move(&mut self, moves: &[u8]) -> u8 {
        self.solver.reset_nodes();
        let mut p = Position::new();
        if !p.play_moves(moves) {
            return NO_COLUMN;
        }
        self.solver
            .select_move(p)
            .map(|c| c as u8)
            .unwrap_or(NO_COLUMN)
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
