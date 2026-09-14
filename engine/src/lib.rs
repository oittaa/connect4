pub mod book;
pub mod move_book;
#[cfg(not(target_arch = "wasm32"))]
pub mod move_book_gen;
pub mod position;
pub mod proven;
pub mod solver;
pub mod tt;

#[cfg(feature = "wasm")]
pub mod wasm;

pub use book::Book;
pub use move_book::MoveBook;
pub use position::{Position, AREA, HEIGHT, MAX_SCORE, MIN_SCORE, WIDTH};
pub use solver::{winning_move_number, SolveResult, Solver, INVALID_MOVE};
