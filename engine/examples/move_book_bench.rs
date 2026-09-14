//! Compare cold move selection with and without the compact move book.
//! cargo run --release -p engine --example move_book_bench

use engine::{MoveBook, Position, ScoreBook, Solver};

fn main() {
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "books/10ply.c4move".into());
    let move_book = MoveBook::load(&std::fs::read(path).expect("read move book")).unwrap();
    let score_book = ScoreBook::load(include_bytes!("../../books/8ply.c4book")).unwrap();
    println!("moves,move_book,column,nodes,micros,timed_out,move_book_hit");
    for seq in ["44444222", "76316366", "123456712", "1234567123"] {
        let mut pos = Position::new();
        assert_eq!(pos.play_seq(seq), seq.len());
        for enabled in [false, true] {
            let mut solver = Solver::with_tt_log(22);
            solver.set_score_book(score_book.clone());
            solver.set_timeout_ms(5_000);
            if enabled {
                solver.set_move_book(move_book.clone());
            }
            let col = solver.select_move(pos).unwrap();
            let expected_hit = enabled && pos.moves() <= move_book.max_ply();
            assert_eq!(solver.move_book_hit(), expected_hit);
            if expected_hit {
                assert_eq!(solver.node_count(), 0);
                assert!(!solver.timed_out());
            }
            println!(
                "{seq},{enabled},{},{},{},{},{}",
                col + 1,
                solver.node_count(),
                solver.last_micros(),
                solver.timed_out(),
                solver.move_book_hit()
            );
        }
    }
}
