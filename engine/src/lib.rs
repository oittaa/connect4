pub mod book;
pub mod position;
pub mod proven;
pub mod solver;
pub mod tt;

#[cfg(feature = "wasm")]
pub mod wasm;

pub use book::Book;
pub use position::{Position, AREA, HEIGHT, MAX_SCORE, MIN_SCORE, WIDTH};
pub use solver::{winning_move_number, SolveResult, Solver, INVALID_MOVE};
