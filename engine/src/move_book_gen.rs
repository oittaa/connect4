//! Generate optimal moves at the frontier, then reuse their scores for earlier plies.

use crate::book_io::write_atomic;
use crate::move_book::{crc32, MoveBook, MAX_MOVE_BOOK_PLY};
use crate::position::{Position, AREA, WIDTH};
use crate::score_book::ScoreBook;
use crate::solver::Solver;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::sync_channel;
use std::time::{Duration, Instant};

const MOVE_ORDER: [usize; WIDTH] = [3, 4, 2, 5, 1, 6, 0];
const CHECKPOINT_HEADER: usize = 28;

pub struct GenerateOptions {
    /// Stored position depth: 11 supplies the twelfth move.
    pub max_ply: u8,
    pub threads: usize,
    /// Optional bounded run. Unfinished output remains in the checkpoint only.
    pub max_jobs: Option<usize>,
}

pub struct Generation {
    pub move_book: Option<MoveBook>,
    pub searched: usize,
    pub nodes: u64,
    pub pending: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Record {
    score: i8,
    col: u8,
}

/// All reachable nonterminal boards, deduplicated by reflection and transposition.
fn layers(max_ply: u8) -> Vec<Vec<u64>> {
    let mut layers = vec![vec![Position::new().key3()]];
    for ply in 1..=max_ply as usize {
        let mut next = Vec::new();
        for &key in &layers[ply - 1] {
            let pos = Position::from_key3(key).unwrap();
            for col in 0..WIDTH {
                if !pos.can_play(col) || pos.is_winning_move(col) {
                    continue;
                }
                let mut child = pos;
                child.play_col(col);
                next.push(child.key3());
            }
        }
        next.sort_unstable();
        next.dedup();
        layers.push(next);
    }
    layers
}

fn child_score(pos: Position, col: usize, score: &impl Fn(u64) -> Option<i32>) -> Option<i32> {
    if pos.is_winning_move(col) {
        Some((AREA as i32 + 1 - pos.moves() as i32) / 2)
    } else {
        let mut child = pos;
        child.play_col(col);
        score(child.key3()).map(|s| -s)
    }
}

fn from_children(pos: Position, score: impl Fn(u64) -> Option<i32>) -> Option<Record> {
    // Immediate wins are optimal regardless of the unknown alternatives.
    if let Some(col) = MOVE_ORDER
        .into_iter()
        .find(|&c| pos.can_play(c) && pos.is_winning_move(c))
    {
        return Some(Record {
            score: ((AREA as i32 + 1 - pos.moves() as i32) / 2) as i8,
            col: col as u8,
        });
    }
    let mut best: Option<Record> = None;
    for col in MOVE_ORDER {
        if !pos.can_play(col) {
            continue;
        }
        let value = child_score(pos, col, &score)? as i8;
        if best.is_none_or(|b| value > b.score) {
            best = Some(Record {
                score: value,
                col: col as u8,
            });
        }
    }
    best
}

fn solve_frontier(solver: &mut Solver, key: u64) -> Result<(Record, u64), String> {
    let pos = Position::from_key3(key).ok_or("invalid frontier position")?;
    let (col, result, scores) = solver
        .best_move(pos)
        .ok_or("frontier position has no move")?;
    if result.timed_out || scores[col] != result.score {
        return Err(format!("no completed best-move proof for key3 {key}"));
    }
    Ok((
        Record {
            score: result.score as i8,
            col: col as u8,
        },
        result.nodes,
    ))
}

fn save_checkpoint(
    path: &Path,
    signature: [u8; 16],
    records: &HashMap<u64, Record>,
) -> Result<(), String> {
    let mut entries: Vec<_> = records.iter().collect();
    entries.sort_unstable_by_key(|&(key, _)| *key);
    let mut bytes = Vec::with_capacity(CHECKPOINT_HEADER + entries.len() * 10);
    bytes.extend_from_slice(&signature);
    bytes.extend_from_slice(&(entries.len() as u64).to_le_bytes());
    bytes.extend_from_slice(&[0; 4]);
    for (&key, record) in entries {
        bytes.extend_from_slice(&key.to_le_bytes());
        bytes.push(record.score as u8);
        bytes.push(record.col);
    }
    let checksum = crc32(&bytes[CHECKPOINT_HEADER..]);
    bytes[24..28].copy_from_slice(&checksum.to_le_bytes());
    write_atomic(path, &bytes).map_err(|e| format!("checkpoint {}: {e}", path.display()))
}

fn load_checkpoint(
    path: &Path,
    signature: [u8; 16],
    frontier: &[u64],
) -> Result<HashMap<u64, Record>, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(e) => return Err(e.to_string()),
    };
    if bytes.len() < CHECKPOINT_HEADER || bytes[..16] != signature {
        return Err("checkpoint belongs to different inputs or depth".into());
    }
    let count = u64::from_le_bytes(bytes[16..24].try_into().unwrap());
    let checksum = u32::from_le_bytes(bytes[24..28].try_into().unwrap());
    if count.checked_mul(10) != Some((bytes.len() - CHECKPOINT_HEADER) as u64)
        || crc32(&bytes[CHECKPOINT_HEADER..]) != checksum
    {
        return Err("truncated or corrupt move-book checkpoint".into());
    }
    let mut records = HashMap::new();
    for entry in bytes[CHECKPOINT_HEADER..].as_chunks::<10>().0 {
        let key = u64::from_le_bytes(entry[..8].try_into().unwrap());
        let record = Record {
            score: entry[8] as i8,
            col: entry[9],
        };
        if frontier.binary_search(&key).is_err()
            || record.col as usize >= WIDTH
            || !Position::from_key3(key)
                .unwrap()
                .can_play(record.col as usize)
            || !(-21..=21).contains(&record.score)
            || records.insert(key, record).is_some()
        {
            return Err("invalid checkpoint record".into());
        }
    }
    Ok(records)
}

pub fn generate(
    score_book: &ScoreBook,
    seed_move_book: Option<&MoveBook>,
    options: &GenerateOptions,
    checkpoint: &Path,
    mut progress: impl FnMut(usize, usize),
) -> Result<Generation, String> {
    if options.max_ply > MAX_MOVE_BOOK_PLY {
        return Err(format!(
            "maximum stored move-book ply is {MAX_MOVE_BOOK_PLY}"
        ));
    }
    let layers = layers(options.max_ply);
    let frontier = layers.last().unwrap();
    let mut signature = [0u8; 16];
    signature[..4].copy_from_slice(b"CMG1");
    signature[4] = options.max_ply;
    signature[8..12].copy_from_slice(&crc32(&score_book.save()).to_le_bytes());
    signature[12..16].copy_from_slice(
        &seed_move_book
            .map(|b| crc32(&b.save()))
            .unwrap_or(0)
            .to_le_bytes(),
    );
    let mut records = load_checkpoint(checkpoint, signature, frontier)?;
    let input_scores: HashMap<_, _> = score_book.entries().collect();
    let mut jobs = Vec::new();
    for &key in frontier {
        if records.contains_key(&key) {
            continue;
        }
        let pos = Position::from_key3(key).unwrap();
        let reused = seed_move_book
            .and_then(|b| b.get(&pos))
            .zip(score_book.get(&pos))
            .filter(|&(col, target)| {
                child_score(pos, col, &|child| input_scores.get(&child).copied()) == Some(target)
            })
            .map(|(col, score)| Record {
                score: score as i8,
                col: col as u8,
            });
        if let Some(record) =
            reused.or_else(|| from_children(pos, |child| input_scores.get(&child).copied()))
        {
            records.insert(key, record);
        } else {
            jobs.push(key);
        }
    }
    let scheduled = jobs.len().min(options.max_jobs.unwrap_or(usize::MAX));
    let jobs = &jobs[..scheduled];
    let next = AtomicUsize::new(0);
    let mut searched = 0;
    let mut nodes = 0;
    let mut saved_at = Instant::now();
    progress(records.len(), frontier.len());
    std::thread::scope(|scope| -> Result<(), String> {
        let workers = options.threads.max(1).min(jobs.len());
        let (sender, receiver) = sync_channel(workers.max(1) * 2);
        for _ in 0..workers {
            let sender = sender.clone();
            let next = &next;
            scope.spawn(move || {
                let mut solver = Solver::new();
                solver.set_score_book(score_book.clone());
                while let Some(&key) = jobs.get(next.fetch_add(1, Ordering::Relaxed)) {
                    if sender
                        .send(solve_frontier(&mut solver, key).map(|r| (key, r)))
                        .is_err()
                    {
                        break;
                    }
                }
            });
        }
        drop(sender);
        for result in receiver {
            let (key, (record, visited)) = result?;
            records.insert(key, record);
            searched += 1;
            nodes += visited;
            progress(records.len(), frontier.len());
            if saved_at.elapsed() >= Duration::from_secs(30) {
                save_checkpoint(checkpoint, signature, &records)?;
                saved_at = Instant::now();
            }
        }
        Ok(())
    })?;
    save_checkpoint(checkpoint, signature, &records)?;
    let pending = frontier.len() - records.len();
    if pending != 0 {
        return Ok(Generation {
            move_book: None,
            searched,
            nodes,
            pending,
        });
    }

    // Frontier solves also supply the exact child scores for all earlier layers.
    let mut move_book = MoveBook::empty(options.max_ply)?;
    for layer in layers.iter().rev() {
        for &key in layer {
            let pos = Position::from_key3(key).unwrap();
            let mut record = if let Some(&record) = records.get(&key) {
                record
            } else {
                from_children(pos, |child| records.get(&child).map(|r| r.score as i32))
                    .ok_or_else(|| format!("missing child score for key3 {key}"))?
            };
            if score_book
                .get(&pos)
                .is_some_and(|s| s != record.score as i32)
            {
                return Err(format!(
                    "generated score disagrees with score book at key3 {key}"
                ));
            }
            if pos.moves() < options.max_ply {
                if let Some(col) = seed_move_book.and_then(|b| b.get(&pos)) {
                    if child_score(pos, col, &|child| {
                        records.get(&child).map(|r| r.score as i32)
                    }) != Some(record.score as i32)
                    {
                        return Err(format!("seed move book is not optimal at key3 {key}"));
                    }
                    record.col = col as u8;
                }
            }
            move_book.insert(&pos, record.col as usize)?;
            records.insert(key, record);
        }
    }
    Ok(Generation {
        move_book: Some(move_book),
        searched,
        nodes,
        pending: 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::score_to_move::{convert_score_to_move, validate_against_score_book};
    use std::path::PathBuf;

    fn checkpoint() -> PathBuf {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        std::env::temp_dir().join(format!(
            "c4-move-gen-{}-{}.checkpoint",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn options(max_jobs: Option<usize>) -> GenerateOptions {
        GenerateOptions {
            max_ply: 3,
            threads: 2,
            max_jobs,
        }
    }

    #[test]
    fn generation_from_child_scores_matches_conversion_without_search() {
        let score_book = ScoreBook::opening_4ply();
        let expected = convert_score_to_move(&score_book).unwrap();
        let path = checkpoint();
        let result = generate(&score_book, None, &options(None), &path, |_, _| {}).unwrap();
        assert_eq!(result.searched, 0);
        assert_eq!(result.nodes, 0);
        let move_book = result.move_book.unwrap();
        assert_eq!(move_book.save(), expected.save());
        assert_eq!(
            validate_against_score_book(&score_book, &move_book).unwrap(),
            151
        );
        // Reuse the existing moves, including their deterministic tie choices.
        let seed_path = checkpoint();
        let seeded = generate(
            &score_book,
            Some(&expected),
            &options(None),
            &seed_path,
            |_, _| {},
        )
        .unwrap();
        assert_eq!(seeded.searched, 0);
        assert_eq!(seeded.move_book.unwrap().save(), expected.save());
        fs::remove_file(path).unwrap();
        fs::remove_file(seed_path).unwrap();
    }

    #[test]
    fn bounded_search_resumes_and_derives_all_earlier_moves() {
        let path = checkpoint();
        let score_book = ScoreBook::new();
        let partial = generate(&score_book, None, &options(Some(5)), &path, |_, _| {}).unwrap();
        assert!(partial.move_book.is_none());
        assert_eq!(partial.searched, 5);
        assert!(partial.pending > 0);
        let complete = generate(&score_book, None, &options(None), &path, |_, _| {}).unwrap();
        assert_eq!(complete.searched, partial.pending);
        assert_eq!(complete.pending, 0);
        let move_book = complete.move_book.unwrap();
        assert_eq!(
            move_book.save(),
            convert_score_to_move(&ScoreBook::opening_4ply())
                .unwrap()
                .save()
        );
        let resumed = generate(&score_book, None, &options(None), &path, |_, _| {}).unwrap();
        assert_eq!(resumed.searched, 0);
        assert_eq!(resumed.move_book.unwrap().save(), move_book.save());
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn generation_handles_wins_and_full_columns_like_score_conversion() {
        let score_book = ScoreBook::load(include_bytes!("../../books/8ply.c4book")).unwrap();
        let path = checkpoint();
        let mut config = options(None);
        config.max_ply = 7;
        let result = generate(&score_book, None, &config, &path, |_, _| {}).unwrap();
        assert_eq!(result.searched, 0);
        let move_book = result.move_book.unwrap();
        assert_eq!(
            move_book.save(),
            convert_score_to_move(&score_book).unwrap().save()
        );
        validate_against_score_book(&score_book, &move_book).unwrap();
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn a_seed_move_needs_a_child_score_proof_at_the_frontier() {
        let score_book = ScoreBook::opening_4ply();
        let pos = Position::new();
        let mut seed = MoveBook::empty(0).unwrap();
        seed.insert(&pos, 0).unwrap(); // Legal, but inferior to the centre.
        let path = checkpoint();
        let mut config = options(None);
        config.max_ply = 0;
        let result = generate(&score_book, Some(&seed), &config, &path, |_, _| {}).unwrap();
        assert_eq!(result.move_book.unwrap().get(&pos), Some(3));
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn checkpoint_rejects_changed_inputs_and_corruption() {
        let path = checkpoint();
        let score_book = ScoreBook::new();
        generate(&score_book, None, &options(Some(1)), &path, |_, _| {}).unwrap();
        assert!(generate(
            &ScoreBook::opening_4ply(),
            None,
            &options(None),
            &path,
            |_, _| {}
        )
        .is_err());
        let mut bytes = fs::read(&path).unwrap();
        bytes[16..24].copy_from_slice(&u64::MAX.to_le_bytes());
        fs::write(&path, &bytes).unwrap();
        assert!(generate(&score_book, None, &options(None), &path, |_, _| {}).is_err());
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn frontier_search_proves_a_move_and_rejects_timeout() {
        let mut solver = Solver::new();
        let mut pos = Position::new();
        assert_eq!(pos.play_seq("4455"), 4);
        let (record, nodes) = solve_frontier(&mut solver, pos.key3()).unwrap();
        assert_eq!(record.score, 18);
        assert!(nodes > 0);
        let mut child = Position::from_key3(pos.key3()).unwrap();
        child.play_col(record.col as usize);
        assert_eq!(Solver::new().solve(child).score, -18);
        solver.set_timeout_ms(1);
        let mut expensive = Position::new();
        assert_eq!(expensive.play_seq("4444"), 4);
        assert!(solve_frontier(&mut solver, expensive.key3()).is_err());
    }
}
