use engine::book::Book;
use engine::position::{Position, WIDTH};
use engine::solver::{winning_move_number, Solver, INVALID_MOVE};
use std::env;
use std::fs;
use std::io::{self, BufRead, Write};
use std::path::Path;
use std::process;

fn usage() -> ! {
    eprintln!(
        "\
c4solver — perfect Connect 4

Usage:
  c4solver solve [MOVES]          score a position (1-based column digits)
  c4solver analyze [MOVES]        score each legal column
  c4solver bench [--book FILE] [--limit N] [--no-mirror] FILE
                                  run a Pons-style test file (seq score)
  c4solver empty [--book FILE] [--no-mirror]
  c4solver gen-book --depth N --out FILE [--from FILE] [--tt-bits N] [--threads N]

If --out already exists, it is loaded and generation continues from it
(same as --from FILE). Already-scored positions are not re-solved.

MOVES is a string of digits 1-7, e.g. 444526. Empty string = empty board.
--no-mirror disables left-right TT canonicalization.
--tt-bits N  transposition table size 2^N (default 24). 25–26 can help on
             CPUs with a large L3 (e.g. Ryzen X3D).
"
    );
    process::exit(2);
}

fn parse_moves(s: &str) -> Position {
    let mut p = Position::new();
    let n = p.play_seq(s);
    if n != s.len() {
        eprintln!("warning: stopped at index {n} of {s:?}");
    }
    p
}

fn tt_bits(args: &[String]) -> u32 {
    args.windows(2)
        .find(|w| w[0] == "--tt-bits")
        .and_then(|w| w[1].parse().ok())
        .unwrap_or(24)
}

fn thread_count(args: &[String]) -> usize {
    args.windows(2)
        .find(|w| w[0] == "--threads")
        .and_then(|w| w[1].parse().ok())
        .unwrap_or_else(|| {
            std::thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(1)
        })
        .max(1)
}

fn make_solver(args: &[String]) -> Solver {
    let bits = tt_bits(args);
    eprintln!("TT 2^{bits}");
    let mut solver = Solver::with_tt_log(bits);
    if args.iter().any(|a| a == "--no-mirror") {
        solver.set_mirror(false);
        eprintln!("mirroring off");
    }
    solver
}

fn positional_seq(args: &[String]) -> &str {
    let mut skip_val = false;
    for a in args.iter().skip(1) {
        if skip_val {
            skip_val = false;
            continue;
        }
        if a == "--no-mirror" {
            continue;
        }
        if a == "--tt-bits"
            || a == "--book"
            || a == "--from"
            || a == "--out"
            || a == "--depth"
            || a == "--limit"
            || a == "--threads"
        {
            skip_val = true;
            continue;
        }
        if a.starts_with('-') {
            continue;
        }
        return a.as_str();
    }
    ""
}

fn load_book_opt(solver: &mut Solver, path: Option<&str>) {
    if let Some(p) = path {
        let bytes = fs::read(p).unwrap_or_else(|e| {
            eprintln!("cannot read book {p}: {e}");
            process::exit(1);
        });
        solver.load_book(&bytes).unwrap_or_else(|e| {
            eprintln!("bad book: {e}");
            process::exit(1);
        });
        eprintln!(
            "loaded book {p}: {} positions, depth {}",
            solver.book().len(),
            solver.book().depth()
        );
    }
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() {
        usage();
    }
    match args[0].as_str() {
        "solve" => {
            let seq = positional_seq(&args);
            let mut solver = make_solver(&args);
            let pos = parse_moves(seq);
            let r = solver.solve(pos);
            println!(
                "score {}  nodes {}  {:.3}s  book={} timeout={}",
                r.score,
                r.nodes,
                r.micros as f64 / 1e6,
                r.from_book,
                r.timed_out
            );
            if let Some(n) = winning_move_number(r.score) {
                println!("game ends on move {n} with perfect play");
            }
        }
        "analyze" => {
            let seq = positional_seq(&args);
            let mut solver = make_solver(&args);
            let pos = parse_moves(seq);
            let scores = solver.analyze(pos);
            for (i, s) in scores.iter().enumerate() {
                if *s == INVALID_MOVE {
                    print!("  col{}: --", i + 1);
                } else {
                    print!("  col{}: {s}", i + 1);
                }
            }
            println!();
            println!(
                "nodes {}  {:.3}s timeout={}",
                solver.node_count(),
                solver.last_micros() as f64 / 1e6,
                solver.timed_out()
            );
        }
        "empty" => {
            let mut book_path = None;
            let mut write_book: Option<&str> = None;
            let mut i = 1;
            while i < args.len() {
                if args[i] == "--book" {
                    book_path = Some(args[i + 1].as_str());
                    i += 2;
                } else if args[i] == "--write-book" {
                    write_book = Some(args[i + 1].as_str());
                    i += 2;
                } else {
                    i += 1;
                }
            }
            let mut solver = make_solver(&args);
            load_book_opt(&mut solver, book_path);
            let pos = Position::new();
            eprintln!("solving empty board (first winning move)…");
            let start = std::time::Instant::now();
            let (col, r, scores) = solver.best_move(pos).expect("empty board has a move");
            let dt = start.elapsed();
            println!("best_column {} (1-based {})", col, col + 1);
            println!(
                "score {}  nodes {}  {:.3}s  book={} timeout={}",
                r.score,
                r.nodes,
                dt.as_secs_f64(),
                r.from_book,
                r.timed_out
            );
            print!("columns:");
            for (i, s) in scores.iter().enumerate() {
                if *s == INVALID_MOVE {
                    print!("  {}:—", i + 1);
                } else {
                    print!("  {}:{s}", i + 1);
                }
            }
            println!();
            if let Some(path) = write_book {
                let mut book = Book::new();
                book.insert(pos.key(), r.score as i8, 0);
                for c in 0..WIDTH {
                    if scores[c] == INVALID_MOVE {
                        continue;
                    }
                    let mut child = pos;
                    child.play_col(c);
                    book.insert(child.key(), (-scores[c]) as i8, 1);
                }
                if let Some(dir) = Path::new(path).parent() {
                    fs::create_dir_all(dir).ok();
                }
                fs::write(path, book.save()).unwrap();
                eprintln!("wrote {path}: {} positions", book.len());
            }
        }
        "bench" => {
            let mut book_path = None;
            let mut limit = usize::MAX;
            let mut file = None;
            let mut i = 1;
            while i < args.len() {
                match args[i].as_str() {
                    "--book" => {
                        book_path = Some(args[i + 1].as_str());
                        i += 2;
                    }
                    "--limit" => {
                        limit = args[i + 1].parse().unwrap();
                        i += 2;
                    }
                    s if !s.starts_with('-') => {
                        file = Some(s);
                        i += 1;
                    }
                    _ => i += 1,
                }
            }
            let file = file.unwrap_or_else(|| usage());
            let mut solver = make_solver(&args);
            load_book_opt(&mut solver, book_path);
            run_bench(&mut solver, Path::new(file), limit);
        }
        "gen-book" => {
            let mut depth = 4u8;
            let mut out = "books/opening.c4book".to_string();
            let mut i = 1;
            while i < args.len() {
                match args[i].as_str() {
                    "--depth" => {
                        depth = args[i + 1].parse().unwrap();
                        i += 2;
                    }
                    "--out" => {
                        out = args[i + 1].clone();
                        i += 2;
                    }
                    _ => i += 1,
                }
            }
            let mut from: Option<String> = None;
            let mut j = 1;
            while j < args.len() {
                if args[j] == "--from" && j + 1 < args.len() {
                    from = Some(args[j + 1].clone());
                }
                j += 1;
            }
            let load_path = from.as_deref().unwrap_or(out.as_str());
            let mut book = Book::new();
            if Path::new(load_path).is_file() {
                let bytes = fs::read(load_path).unwrap_or_else(|e| {
                    eprintln!("cannot read {load_path}: {e}");
                    process::exit(1);
                });
                book = Book::load(&bytes).unwrap_or_else(|e| {
                    eprintln!("bad book {load_path}: {e}");
                    process::exit(1);
                });
                eprintln!(
                    "loaded {load_path}: {} positions, depth {}",
                    book.len(),
                    book.depth()
                );
                if book.depth() >= depth {
                    eprintln!(
                        "book is already depth {} (>= {depth}); nothing to do",
                        book.depth()
                    );
                    if load_path != out {
                        fs::create_dir_all(Path::new(&out).parent().unwrap_or(Path::new("."))).ok();
                        fs::write(&out, book.save()).unwrap();
                    }
                    return;
                }
            }
            let mut solver = make_solver(&args);
            solver.set_book(book.clone());
            let start_len = book.len();
            let threads = thread_count(&args);
            eprintln!(
                "generating to depth {depth} ({} already stored), {threads} threads. Checkpointing {out}",
                book.len()
            );
            if let Some(dir) = Path::new(&out).parent() {
                fs::create_dir_all(dir).ok();
            }
            let out_path = out.clone();
            let mut last_saved = start_len;
            solver.fill_book_with(Position::new(), depth, &mut book, threads, |b| {
                eprint!(
                    "\r{} positions (target depth {})\x1b[K",
                    b.len(),
                    depth
                );
                let _ = io::stderr().flush();
                if b.len().saturating_sub(last_saved) >= 10 {
                    if fs::write(&out_path, b.save()).is_ok() {
                        last_saved = b.len();
                    }
                }
            });
            eprintln!();
            fs::write(&out, book.save()).unwrap();
            eprintln!(
                "wrote {out}: {} positions ({} new), depth {}",
                book.len(),
                book.len().saturating_sub(start_len),
                book.depth()
            );
        }
        _ => usage(),
    }
}

fn run_bench(solver: &mut Solver, path: &Path, limit: usize) {
    let f = fs::File::open(path).unwrap_or_else(|e| {
        eprintln!("cannot open {}: {e}", path.display());
        process::exit(1);
    });
    let mut ok = 0usize;
    let mut fail = 0usize;
    let mut total_nodes = 0u64;
    let mut total_us = 0u64;
    let start = std::time::Instant::now();
    for (n, line) in io::BufReader::new(f).lines().enumerate() {
        if n >= limit {
            break;
        }
        let line = line.unwrap();
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split_whitespace();
        let seq = parts.next().unwrap();
        let expect: i32 = parts.next().unwrap().parse().unwrap();
        let mut pos = Position::new();
        if pos.play_seq(seq) != seq.len() {
            eprintln!("line {}: cannot play {seq}", n + 1);
            fail += 1;
            continue;
        }
        solver.reset();
        let r = solver.solve(pos);
        total_nodes += r.nodes;
        total_us += r.micros;
        if r.score != expect {
            eprintln!(
                "FAIL {}: got {} want {}  seq={seq}  nodes={}",
                n + 1,
                r.score,
                expect,
                r.nodes
            );
            fail += 1;
        } else {
            ok += 1;
        }
        if (n + 1) % 100 == 0 {
            eprint!("\r{} ok, {fail} fail", n + 1);
            let _ = io::stderr().flush();
        }
    }
    let dt = start.elapsed().as_secs_f64();
    eprintln!();
    let n = ok + fail;
    println!(
        "{}: {ok}/{n} correct, {fail} fail, {} nodes, {:.3}s, {:.0} knodes/s",
        path.display(),
        total_nodes,
        dt,
        if dt > 0.0 {
            total_nodes as f64 / dt / 1000.0
        } else {
            0.0
        }
    );
    let _ = total_us;
    if fail > 0 {
        process::exit(1);
    }
}

#[allow(dead_code)]
fn _w() -> usize {
    WIDTH
}
