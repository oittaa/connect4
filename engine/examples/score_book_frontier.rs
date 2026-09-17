//! Benchmark choosing the first move beyond the active score book.
//!
//! Each repetition constructs a **fresh Solver** so nodes/times are
//! first-encounter cost. Reusing one table would collapse later rounds to
//! leftover TT hits. Score books are cloned onto each solver.
//!
//! Run with `cargo run --release -p engine --example score_book_frontier -- 3`.
//! The optional argument is the number of cold repetitions (default: 3).
//! After the last cold sample of each case, one extra `warm` row reuses that
//! Solver (cheap leftover-TT contrast, not an independent timed sample).

use engine::{Position, ScoreBook, Solver};

fn main() {
    let repeats: usize = std::env::args()
        .nth(1)
        .map(|s| s.parse().expect("repetitions must be a positive integer"))
        .unwrap_or(3);
    assert!(repeats > 0);
    let score_book8 = ScoreBook::load(include_bytes!("../../books/8ply.c4book")).unwrap();
    // Known exact parent scores and the first optimal column in solver order.
    // No deeper score book is loaded to answer the child searches.
    let cases = [
        ("44444222", 8, 1, 2),
        ("76316366", 8, 2, 7),
        ("4444", 4, 1, 4),
        ("4545", 4, 5, 4),
        ("4455", 4, 18, 3),
    ];
    println!("kind,round,moves,score_book_depth,column,score,nodes,micros");
    for (seq, depth, expected, expected_col) in cases {
        let mut pos = Position::new();
        assert_eq!(pos.play_seq(seq), seq.len());
        for round in 1..=repeats {
            // Match the browser's roughly 20 MiB TT budget on native builds.
            let mut solver = Solver::new();
            if depth == 8 {
                solver.set_score_book(score_book8.clone());
            }
            assert_eq!(solver.score_book().depth(), depth);
            assert_eq!(solver.score_book().get(&pos), Some(expected));
            let sample = |kind: &str, solver: &mut Solver| {
                let (col, result, _) = solver.best_move(pos).unwrap();
                assert!(!result.timed_out);
                assert_eq!(result.score, expected, "{seq}");
                assert_eq!(col + 1, expected_col, "{seq}");
                println!(
                    "{kind},{round},{seq},{depth},{},{},{},{}",
                    col + 1,
                    result.score,
                    result.nodes,
                    result.micros
                );
            };
            sample("cold", &mut solver);
            if round == repeats {
                sample("warm", &mut solver);
            }
        }
    }
}
