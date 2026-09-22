use engine::book_io::write_atomic;
use engine::move_book::{MoveBook, MAX_MOVE_BOOK_PLY};
use engine::move_book_gen::{generate, GenerateOptions};
use engine::position::{Position, WIDTH};
use engine::score_book::{ScoreBook, MAX_SCORE_BOOK_PLY};
use engine::score_to_move::{convert_score_to_move, validate_against_score_book};
use engine::solver::{winning_move_number, Solver, INVALID_MOVE};
use std::env;
use std::fs;
use std::io::{self, BufRead, Write};
use std::path::Path;
use std::process;

const USAGE: &str = "\
c4solver — perfect Connect 4

Usage:
  c4solver solve [MOVES] [--no-book]
                                  score a position (1-based column digits)
  c4solver best-move [MOVES] [--no-book]
                                  first optimal move in center-first column order
  c4solver analyze [MOVES] [--no-book]
                                  score each legal column
  c4solver bench [--score-book FILE] [--limit N] [--no-book] FILE
                                  run a Pons-style test file (seq score)
  c4solver empty [--score-book FILE] [--write-score-book FILE] [--no-book]
                                  solve empty board (first winning move)
  c4solver gen-score-book --moves N --out FILE [--from-score-book FILE] [--threads N]
  c4solver convert-score-to-move --score-book FILE --out FILE
  c4solver gen-move-book --moves N --out FILE [--score-book FILE] [--from-move-book FILE]
                         [--threads N] [--max-jobs N]
  c4solver validate-move-book --score-book FILE --move-book FILE

For gen-score-book, if --out already exists, generation continues from it
(same as --from-score-book FILE). Already-scored positions are not re-solved.
gen-move-book searches missing frontier positions and derives earlier moves from
their scores. It resumes from FILE.checkpoint; --max-jobs bounds a run without
publishing an incomplete move book. The default score book covers four moves.
For both generators, --moves N means instant moves through move N.
Conversion preserves that coverage; validation needs a score book covering
at least as many moves as the move book.

MOVES is a string of digits 1-7, e.g. 444526. Empty string = empty board.
";

fn usage() -> ! {
    eprint!("{USAGE}");
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
    let mut solver = Solver::new();
    if args.iter().any(|a| a == "--no-book") {
        eprintln!("books disabled (pure search)");
        solver.clear_all_books();
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
        if a == "--score-book"
            || a == "--from-score-book"
            || a == "--out"
            || a == "--moves"
            || a == "--limit"
            || a == "--threads"
            || a == "--move-book"
            || a == "--from-move-book"
            || a == "--max-jobs"
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

fn load_score_book_opt(solver: &mut Solver, path: Option<&str>) {
    if let Some(p) = path {
        let bytes = fs::read(p).unwrap_or_else(|e| {
            eprintln!("cannot read score book {p}: {e}");
            process::exit(1);
        });
        solver.load_score_book(&bytes).unwrap_or_else(|e| {
            eprintln!("bad score book: {e}");
            process::exit(1);
        });
        eprintln!(
            "loaded score book {p}: {} positions, instant moves through {}",
            solver.score_book().len(),
            solver.score_book().moves_covered()
        );
    }
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() {
        usage();
    }
    if args.iter().any(|a| a == "-h" || a == "--help") {
        print!("{USAGE}");
        process::exit(0);
    }
    if let Err(err) = validate_args(&args) {
        eprintln!("error: {err}\n");
        usage();
    }
    match args[0].as_str() {
        "solve" => {
            let seq = positional_seq(&args);
            let mut solver = make_solver(&args);
            let pos = parse_moves(seq);
            let r = solver.solve(pos);
            println!(
                "score {}  nodes {}  {:.3}s  score_book={} timeout={}",
                r.score,
                r.nodes,
                r.micros as f64 / 1e6,
                r.from_score_book,
                r.timed_out
            );
            if let Some(n) = winning_move_number(r.score) {
                println!("game ends on move {n} with perfect play");
            }
        }
        "best-move" => {
            let seq = positional_seq(&args);
            let mut solver = make_solver(&args);
            let pos = parse_moves(seq);
            let start = std::time::Instant::now();
            let Some((col, r, scores)) = solver.best_move(pos) else {
                eprintln!("no legal moves or game already over");
                process::exit(1);
            };
            let dt = start.elapsed();
            let secs = dt.as_secs_f64();
            let kns = if secs > 0.0 {
                r.nodes as f64 / (secs * 1000.0)
            } else {
                0.0
            };
            println!("best_move: {}", col + 1);
            println!("score: {}", r.score);
            println!("nodes: {}", r.nodes);
            println!("time: {:.3}s ({:.1} kn/s)", secs, kns);
            print!("columns:");
            for (i, s) in scores.iter().enumerate() {
                if *s == INVALID_MOVE {
                    print!("  {}:—", i + 1);
                } else {
                    print!("  {}:{s}", i + 1);
                }
            }
            println!();
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
            let mut score_book_path = None;
            let mut write_score_book: Option<&str> = None;
            let mut i = 1;
            while i < args.len() {
                if args[i] == "--score-book" {
                    score_book_path = Some(args[i + 1].as_str());
                    i += 2;
                } else if args[i] == "--write-score-book" {
                    write_score_book = Some(args[i + 1].as_str());
                    i += 2;
                } else {
                    i += 1;
                }
            }
            let mut solver = make_solver(&args);
            load_score_book_opt(&mut solver, score_book_path);
            let pos = Position::new();
            eprintln!("solving empty board (first winning move)…");
            let start = std::time::Instant::now();
            let (col, r, scores) = solver.best_move(pos).expect("empty board has a move");
            let dt = start.elapsed();
            println!("best_column {} (1-based {})", col, col + 1);
            println!(
                "score {}  nodes {}  {:.3}s  score_book={} timeout={}",
                r.score,
                r.nodes,
                dt.as_secs_f64(),
                r.from_score_book,
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
            if let Some(path) = write_score_book {
                let mut score_book = ScoreBook::new();
                score_book.insert(pos.key3(), r.score as i8, 0);
                for (c, &score) in scores.iter().enumerate() {
                    if score == INVALID_MOVE {
                        continue;
                    }
                    let mut child = pos;
                    child.play_col(c);
                    score_book.insert(child.key3(), (-score) as i8, 1);
                }
                write_atomic(Path::new(path), &score_book.save()).unwrap();
                eprintln!("wrote {path}: {} positions", score_book.len());
            }
        }
        "bench" => {
            let mut score_book_path = None;
            let mut limit = usize::MAX;
            let mut file = None;
            let mut i = 1;
            while i < args.len() {
                match args[i].as_str() {
                    "--score-book" => {
                        score_book_path = Some(args[i + 1].as_str());
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
            load_score_book_opt(&mut solver, score_book_path);
            run_bench(&mut solver, Path::new(file), limit);
        }
        "gen-score-book" | "gen-move-book" | "convert-score-to-move" | "validate-move-book" => {
            let result = if args[0] == "gen-score-book" {
                run_score_book(&args)
            } else {
                run_move_book(&args)
            };
            result.unwrap_or_else(|error| {
                eprintln!("{}: {error}", args[0]);
                process::exit(1);
            });
        }
        _ => usage(),
    }
}

fn arg_value<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.windows(2)
        .find(|window| window[0] == name)
        .map(|window| window[1].as_str())
}

fn required_arg<'a>(args: &'a [String], name: &str) -> Result<&'a str, String> {
    arg_value(args, name)
        .filter(|value| !value.starts_with("--"))
        .ok_or_else(|| format!("missing {name}; run c4solver for usage"))
}

fn requested_moves(args: &[String], maximum: u8) -> Result<u8, String> {
    required_arg(args, "--moves")?
        .parse::<u8>()
        .ok()
        .filter(|&moves| (1..=maximum).contains(&moves))
        .ok_or_else(|| format!("--moves must be between 1 and {maximum}"))
}

fn run_score_book(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let moves = requested_moves(args, MAX_SCORE_BOOK_PLY)?;
    let out = required_arg(args, "--out")?;
    let source = arg_value(args, "--from-score-book");
    let load_path = source.unwrap_or(out);
    let mut score_book = if source.is_some() || Path::new(load_path).is_file() {
        ScoreBook::load(&fs::read(load_path)?)?
    } else {
        ScoreBook::new()
    };
    let mut solver = make_solver(args);
    solver.set_score_book(score_book.clone());
    let start_len = score_book.len();
    let threads = thread_count(args);
    eprintln!(
        "generating score book for moves through {moves}, {start_len} existing positions, {threads} threads"
    );
    let mut saved_at = std::time::Instant::now();
    let mut reported_at = saved_at;
    solver.fill_score_book_with(
        Position::new(),
        moves,
        &mut score_book,
        threads,
        |score_book| {
            if reported_at.elapsed().as_secs() >= 1 {
                eprintln!("{} scored positions", score_book.len());
                reported_at = std::time::Instant::now();
            }
            if saved_at.elapsed().as_secs() >= 30 {
                if let Err(error) = write_atomic(Path::new(out), &score_book.save()) {
                    eprintln!("cannot checkpoint {out}: {error}");
                }
                saved_at = std::time::Instant::now();
            }
        },
    );
    write_atomic(Path::new(out), &score_book.save())?;
    println!(
        "wrote {out}: {} positions ({} new), instant moves through {}",
        score_book.len(),
        score_book.len().saturating_sub(start_len),
        score_book.moves_covered()
    );
    Ok(())
}

fn run_move_book(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let started = std::time::Instant::now();
    let generating = args[0] == "gen-move-book";
    let validating = args[0] == "validate-move-book";
    let path = required_arg(args, if validating { "--move-book" } else { "--out" })?;
    let score_book = if let Some(source) = arg_value(args, "--score-book") {
        ScoreBook::load(&fs::read(source)?)?
    } else if generating {
        ScoreBook::opening_4ply()
    } else {
        return Err("missing --score-book".into());
    };
    let move_book = if generating {
        let moves = requested_moves(args, MAX_MOVE_BOOK_PLY + 1)?;
        let options = GenerateOptions {
            max_ply: moves - 1,
            threads: thread_count(args),
            max_jobs: arg_value(args, "--max-jobs").map(str::parse).transpose()?,
        };
        let seed_move_book = arg_value(args, "--from-move-book")
            .map(|source| -> Result<_, Box<dyn std::error::Error>> {
                Ok(MoveBook::load(&fs::read(source)?)?)
            })
            .transpose()?;
        let checkpoint = format!("{path}.checkpoint");
        eprintln!(
            "generating move book for moves through {moves}, {} threads",
            options.threads
        );
        let mut reported_at = started;
        let result = generate(
            &score_book,
            seed_move_book.as_ref(),
            &options,
            Path::new(&checkpoint),
            |done, total| {
                if reported_at.elapsed().as_secs() >= 1 || done == total {
                    eprintln!("{done}/{total} frontier positions complete");
                    reported_at = std::time::Instant::now();
                }
            },
        )?;
        eprintln!(
            "{} frontier positions searched, {} nodes",
            result.searched, result.nodes
        );
        let Some(move_book) = result.move_book else {
            println!("{} positions remain; resume with the same command. Saved {checkpoint}; no move book written.", result.pending);
            return Ok(());
        };
        move_book
    } else if validating {
        MoveBook::load(&fs::read(path)?)?
    } else {
        convert_score_to_move(&score_book)?
    };
    if !generating {
        let checked = validate_against_score_book(&score_book, &move_book)?;
        eprintln!("verified {checked} source positions and their mirrors");
    }
    let bytes = move_book.save();
    if !validating {
        write_atomic(Path::new(path), &bytes)?;
    }
    println!(
        "{} {path}: {} bytes, instant moves through {}, {} populated slots, {:.3}s",
        if validating { "verified" } else { "wrote" },
        bytes.len(),
        move_book.moves_covered(),
        move_book.populated(),
        started.elapsed().as_secs_f64()
    );
    Ok(())
}

fn validate_args(args: &[String]) -> Result<(), String> {
    let cmd = args[0].as_str();
    let allowed: &[&str] = match cmd {
        "solve" | "best-move" | "analyze" => &["--no-book"],
        "empty" => &["--score-book", "--write-score-book", "--no-book"],
        "bench" => &["--score-book", "--limit", "--no-book"],
        "gen-score-book" => &["--moves", "--out", "--from-score-book", "--threads"],
        "convert-score-to-move" => &["--score-book", "--out"],
        "gen-move-book" => &[
            "--moves",
            "--out",
            "--score-book",
            "--from-move-book",
            "--threads",
            "--max-jobs",
        ],
        "validate-move-book" => &["--score-book", "--move-book"],
        _ => return Err(format!("unknown command '{cmd}'")),
    };
    let mut i = 1;
    while i < args.len() {
        let a = &args[i];
        if a == "--depth" {
            return Err("use --moves N for instant moves through move N".into());
        }
        if a.starts_with('-') {
            if !allowed.contains(&a.as_str()) {
                return Err(format!("unknown option '{a}' for {cmd}"));
            }
            if a != "--no-book" {
                i += 1;
                if i >= args.len() || args[i].starts_with("--") {
                    return Err(format!("missing value for {a}"));
                }
                if a == "--threads" && args[i].parse::<usize>().ok().filter(|&n| n > 0).is_none() {
                    return Err("--threads must be a positive integer".into());
                }
            }
        }
        i += 1;
    }
    Ok(())
}

/// Play a bench sequence the way `c4solver-go bench` does.
///
/// A winning drop is played and consumed, so a win on the final character is
/// a legal line. `Position::play_seq` still stops before that drop.
fn play_bench_seq(pos: &mut Position, seq: &str) -> usize {
    for (i, ch) in seq.chars().enumerate() {
        let col = match ch.to_digit(10) {
            Some(d) if (1..=WIDTH as u32).contains(&d) => (d - 1) as usize,
            _ => return i,
        };
        if !pos.can_play(col) || pos.is_winning_move(col) {
            pos.play_col(col);
            return i + 1;
        }
        pos.play_col(col);
    }
    seq.len()
}

fn run_bench(solver: &mut Solver, path: &Path, limit: usize) {
    let f = fs::File::open(path).unwrap_or_else(|e| {
        eprintln!("cannot open {}: {e}", path.display());
        process::exit(1);
    });
    let mut ok = 0usize;
    let mut fail = 0usize;
    let mut total_nodes = 0u64;
    let mut seen = 0usize;
    let start = std::time::Instant::now();
    for (n, line) in io::BufReader::new(f).lines().enumerate() {
        let line = line.unwrap();
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if seen >= limit {
            break;
        }
        seen += 1;
        let mut parts = line.split_whitespace();
        let first = parts.next().unwrap();
        let second = parts.next();
        if second.is_some() && parts.next().is_some() {
            eprintln!("line {}: expected sequence score, got {line:?}", n + 1);
            process::exit(1);
        }
        // A lone score is the empty board. Every other line is `sequence score`.
        let (seq, expect_tok) = match second {
            Some(score) => (first, score),
            None => ("", first),
        };
        let expect: i32 = expect_tok.parse().unwrap_or_else(|_| {
            eprintln!("line {}: expected a score, got {line:?}", n + 1);
            process::exit(1);
        });
        let mut pos = Position::new();
        if play_bench_seq(&mut pos, seq) != seq.len() {
            eprintln!("line {}: cannot play {seq}", n + 1);
            fail += 1;
            continue;
        }
        solver.reset_nodes();
        let r = solver.solve(pos);
        total_nodes += r.nodes;
        let label = if seq.is_empty() { "-" } else { seq };
        println!("{label} {} {} {}", r.score, r.nodes, r.micros);
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
    eprintln!(
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
    if fail > 0 {
        process::exit(1);
    }
}
