#[cfg(not(target_arch = "wasm32"))]
pub mod book_io;
pub mod move_book;
#[cfg(not(target_arch = "wasm32"))]
pub mod move_book_gen;
pub mod position;
pub mod proven;
pub mod score_book;
#[cfg(not(target_arch = "wasm32"))]
pub mod score_to_move;
pub mod solver;
pub mod tt;

#[cfg(feature = "wasm")]
pub mod wasm;

pub use move_book::MoveBook;
pub use position::{Position, AREA, HEIGHT, MAX_SCORE, MIN_SCORE, WIDTH};
pub use score_book::ScoreBook;
pub use solver::{winning_move_number, SolveResult, Solver, INVALID_MOVE};
