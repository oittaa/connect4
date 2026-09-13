use crate::position::Position;
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

    #[wasm_bindgen(js_name = loadBook)]
    pub fn load_book(&mut self, data: &[u8]) -> bool {
        self.solver.load_book(data).is_ok()
    }

    #[wasm_bindgen(js_name = clearBook)]
    pub fn clear_book(&mut self) {
        self.solver.clear_book();
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

    #[wasm_bindgen(js_name = bookDepth)]
    pub fn book_depth(&self) -> u8 {
        self.solver.book().depth().max(1)
    }

    #[wasm_bindgen(js_name = bookLen)]
    pub fn book_len(&self) -> u32 {
        (self.solver.book().len() + self.solver.builtin_len()) as u32
    }

    /// Unique 49-bit key as a string (safe for IndexedDB / JS).
    pub fn key(&self, moves: &[u8]) -> Option<String> {
        let mut p = Position::new();
        if !p.play_moves(moves) {
            return None;
        }
        Some(p.canonical_key().to_string())
    }

    pub fn solve(&mut self, moves: &[u8]) -> i8 {
        let mut p = Position::new();
        if !p.play_moves(moves) {
            return INVALID_MOVE as i8;
        }
        self.solver.solve(p).score as i8
    }

    /// 7 scores, `INVALID_MOVE` (-1000 as i16) for full columns.
    pub fn analyze(&mut self, moves: &[u8]) -> Vec<i16> {
        let mut p = Position::new();
        if !p.play_moves(moves) {
            return vec![INVALID_MOVE as i16; 7];
        }
        self.solver
            .analyze(p)
            .iter()
            .map(|&s| s as i16)
            .collect()
    }

    /// 0-based column, or 255 if none.
    /// The empty 7×6 board has a unique winning first move (center).
    /// Return it immediately so a computer seat does not wait on a full solve.
    #[wasm_bindgen(js_name = bestMove)]
    pub fn best_move(&mut self, moves: &[u8]) -> u8 {
        if moves.is_empty() {
            return 3;
        }
        let mut p = Position::new();
        if !p.play_moves(moves) {
            return 255;
        }
        self.solver
            .best_move(p)
            .map(|(c, _, _)| c as u8)
            .unwrap_or(255)
    }

    pub fn micros(&self) -> f64 {
        self.solver.last_micros() as f64
    }
}
