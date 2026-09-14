//! Cold gameplay-selection and packed-lookup benchmark for a generated C4MV book.
//! Run with:
//! `cargo run --release -p engine --example move_book_bench -- books/10ply.c4move 3`

use engine::{Book, MoveBook, Position, Solver};
use std::hint::black_box;
use std::time::Instant;

fn position(sequence: &str) -> Position {
    let mut pos = Position::new();
    assert_eq!(pos.play_seq(sequence), sequence.len(), "{sequence}");
    pos
}

fn main() {
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "books/10ply.c4move".into());
    let repeats: usize = std::env::args()
        .nth(2)
        .map(|value| value.parse().expect("repetitions must be an integer"))
        .unwrap_or(3);
    let bytes_started = Instant::now();
    let bytes = std::fs::read(&path).expect("read move book");
    let read_micros = bytes_started.elapsed().as_micros();
    let load_started = Instant::now();
    let move_book = MoveBook::load(&bytes).expect("load move book");
    let load_micros = load_started.elapsed().as_micros();
    assert_eq!(move_book.max_ply(), 10);
    println!(
        "load,file_bytes={},payload_bytes={},populated={},read_micros={},parse_micros={}",
        bytes.len(),
        move_book.payload_bytes(),
        move_book.populated(),
        read_micros,
        load_micros
    );

    let book8 = Book::load(include_bytes!("../../books/8ply.c4book")).unwrap();
    let cases = [
        ("covered-8-a", "44444222"),
        ("covered-8-b", "76316366"),
        ("covered-9", "123456712"),
        ("covered-10", "1234567123"),
        ("beyond-10", "12345671234"),
    ];
    println!("round,case,moves,variant,column,nodes,micros,timed_out,move_book_hit");
    for round in 1..=repeats {
        for (name, sequence) in cases {
            let pos = position(sequence);
            for variant in ["score-search", "move-book"] {
                let mut solver = Solver::with_tt_log(22);
                solver.set_book(book8.clone());
                if variant == "move-book" {
                    solver.set_move_book(move_book.clone());
                }
                solver.reset();
                let col = solver.select_move(pos).expect("position has a move");
                println!(
                    "{round},{name},{sequence},{variant},{},{},{},{},{}",
                    col + 1,
                    solver.node_count(),
                    solver.last_micros(),
                    solver.timed_out(),
                    solver.move_book_hit()
                );
            }
        }

        let pos = position("1234567123");
        let mut solver = Solver::with_tt_log(22);
        solver.set_book(book8.clone());
        solver.set_move_book(MoveBook::empty(10).unwrap());
        solver.reset();
        let col = solver.select_move(pos).expect("position has a move");
        println!(
            "{round},missing-10,1234567123,empty-move-book,{},{},{},{},{}",
            col + 1,
            solver.node_count(),
            solver.last_micros(),
            solver.timed_out(),
            solver.move_book_hit()
        );
    }

    let lookup_positions: Vec<Position> = cases
        .iter()
        .map(|(_, sequence)| position(sequence))
        .collect();
    let lookup_iterations = 2_000_000usize;
    let lookup_started = Instant::now();
    let mut hits = 0usize;
    for index in 0..lookup_iterations {
        hits += move_book
            .get(black_box(&lookup_positions[index % lookup_positions.len()]))
            .is_some() as usize;
    }
    let lookup_nanos = lookup_started.elapsed().as_nanos();
    println!(
        "lookup,iterations={lookup_iterations},hits={hits},total_nanos={lookup_nanos},nanos_each={:.2}",
        lookup_nanos as f64 / lookup_iterations as f64
    );
}
