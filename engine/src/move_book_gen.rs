//! Native generation and exhaustive validation for `C4MV` move books.

use crate::book::Book;
use crate::move_book::{MoveBook, EXPECTED_SLOT_COUNTS, MAX_MOVE_BOOK_PLY};
use crate::position::{Position, AREA, WIDTH};
use crate::proven::ProvenTable;
use crate::solver::Solver;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const EXPECTED_CANONICAL_POSITIONS_10PLY: usize = 1_208_493;
pub const EXPECTED_CANONICAL_POSITIONS_AT_10: usize = 809_464;
pub const EXPECTED_INDEXED_POSITIONS_10PLY: u32 = 1_216_864;

const MOVE_ORDER: [usize; WIDTH] = [3, 4, 2, 5, 1, 6, 0];
const CHECKPOINT_EVERY: usize = 2_000;

#[derive(Clone, Debug)]
pub struct GenerateOptions {
    pub depth: u8,
    pub scores: PathBuf,
    pub out: PathBuf,
    pub threads: usize,
    pub tt_bits: u32,
    pub pilot_positions: Option<usize>,
    pub position_limit: Option<usize>,
    pub time_limit: Option<Duration>,
}

#[derive(Clone, Debug)]
pub struct GenerationReport {
    pub canonical_positions: usize,
    pub frontier_positions: usize,
    pub queued_frontier: usize,
    pub completed_frontier: usize,
    pub populated_slots: u32,
    pub total_slots: u32,
    pub nodes: u64,
    pub elapsed: Duration,
    pub complete: bool,
    pub checkpoint: PathBuf,
    pub progress: PathBuf,
    pub certifications: PathBuf,
}

#[derive(Clone, Debug)]
pub struct ValidationReport {
    pub canonical_positions: usize,
    pub frontier_positions: usize,
    pub indexed_positions: u32,
    pub populated_slots: u32,
    pub score_checks: usize,
    pub frontier_checks: usize,
    pub frontier_nodes: u64,
    pub elapsed: Duration,
}

pub fn generate(options: &GenerateOptions) -> Result<GenerationReport, String> {
    if options.depth > MAX_MOVE_BOOK_PLY {
        return Err(format!("depth {} is not supported", options.depth));
    }
    if options.threads == 0 {
        return Err("thread count must be positive".into());
    }
    let started = Instant::now();
    let score_book = load_score_book(&options.scores)?;
    if score_book.depth() < options.depth {
        return Err(format!(
            "score book depth {} is shallower than requested depth {}",
            score_book.depth(),
            options.depth
        ));
    }
    let positions = collect_reachable(options.depth);
    verify_expected_source(&positions, &score_book, options.depth)?;

    let mut move_book = if options.out.is_file() {
        let bytes = fs::read(&options.out)
            .map_err(|error| format!("cannot read {}: {error}", options.out.display()))?;
        let book = MoveBook::load(&bytes)
            .map_err(|error| format!("bad checkpoint {}: {error}", options.out.display()))?;
        if book.max_ply() != options.depth {
            return Err(format!(
                "checkpoint depth {} does not match requested depth {}",
                book.max_ply(),
                options.depth
            ));
        }
        book
    } else {
        MoveBook::empty(options.depth)?
    };

    let progress_path = sidecar_path(&options.out, "progress");
    let certifications_path = sidecar_path(&options.out, "cert.tsv");
    let lower_depth = options.depth.min(9);
    let mut lower_added = 0usize;
    for ply in 0..=lower_depth as usize {
        for pos in &positions[ply] {
            if move_book.is_complete_for(pos) {
                continue;
            }
            if let Some(existing) = move_book.get(pos) {
                lower_added += move_book.insert(pos, existing)? as usize;
                continue;
            }
            let col = scored_optimal_move(&score_book, *pos)?;
            lower_added += move_book.insert(pos, col)? as usize;
        }
    }
    atomic_write(&options.out, &move_book.save())?;

    let frontier = &positions[options.depth as usize];
    let mut jobs: Vec<Position> = if options.depth == 10 {
        frontier
            .iter()
            .copied()
            .filter(|pos| !move_book.is_complete_for(pos))
            .collect()
    } else {
        Vec::new()
    };
    jobs.sort_unstable_by_key(Position::key3);
    if let Some(count) = options.pilot_positions {
        jobs = representative_sample(&jobs, count);
    } else if let Some(limit) = options.position_limit {
        jobs.truncate(limit);
    }
    let queued_frontier = jobs.len();
    let tt_bytes_per_worker = (1u64 << options.tt_bits.clamp(16, 27)) * 6;
    eprintln!(
        "reachable={} frontier={} lower_slots_added={} queued={} threads={} tt=2^{} (~{} MiB/worker, ~{} MiB total)",
        positions.iter().map(Vec::len).sum::<usize>(),
        frontier.len(),
        lower_added,
        queued_frontier,
        options.threads,
        options.tt_bits,
        tt_bytes_per_worker / (1024 * 1024),
        tt_bytes_per_worker * options.threads as u64 / (1024 * 1024)
    );

    let shared_book = Arc::new(Mutex::new(move_book));
    let jobs = Arc::new(jobs);
    let next = Arc::new(AtomicUsize::new(0));
    let completed = Arc::new(AtomicUsize::new(0));
    let populated = Arc::new(AtomicU32::new(shared_book.lock().unwrap().populated()));
    let nodes = Arc::new(AtomicU64::new(0));
    let stopped = Arc::new(AtomicBool::new(false));
    let error = Arc::new(Mutex::new(None::<String>));
    let checkpoint_lock = Arc::new(Mutex::new(()));
    let hard = Arc::new(Mutex::new(Vec::<(u64, u64)>::new()));
    let deadline = options.time_limit.map(|limit| started + limit);

    std::thread::scope(|scope| {
        for _ in 0..options.threads {
            let score_book = score_book.clone();
            let shared_book = Arc::clone(&shared_book);
            let jobs = Arc::clone(&jobs);
            let next = Arc::clone(&next);
            let completed = Arc::clone(&completed);
            let populated = Arc::clone(&populated);
            let nodes = Arc::clone(&nodes);
            let stopped = Arc::clone(&stopped);
            let error = Arc::clone(&error);
            let checkpoint_lock = Arc::clone(&checkpoint_lock);
            let hard = Arc::clone(&hard);
            let out = options.out.clone();
            let progress_path = progress_path.clone();
            let tt_bits = options.tt_bits;
            scope.spawn(move || {
                let mut solver = Solver::with_tt_log(tt_bits);
                solver.set_book(score_book.clone());
                loop {
                    if stopped.load(Ordering::Relaxed) {
                        break;
                    }
                    if deadline.is_some_and(|value| Instant::now() >= value) {
                        stopped.store(true, Ordering::Relaxed);
                        break;
                    }
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    let Some(&pos) = jobs.get(index) else {
                        break;
                    };
                    if let Some(deadline) = deadline {
                        let remaining = deadline.saturating_duration_since(Instant::now());
                        if remaining.is_zero() {
                            stopped.store(true, Ordering::Relaxed);
                            break;
                        }
                        solver.set_timeout_ms(remaining.as_millis().min(u32::MAX as u128) as u32);
                    } else {
                        solver.set_timeout_ms(0);
                    }
                    solver.reset();
                    let Some((col, result, _)) = solver.best_move(pos) else {
                        set_error(&error, "frontier position unexpectedly has no move".into());
                        stopped.store(true, Ordering::Relaxed);
                        break;
                    };
                    if result.timed_out {
                        stopped.store(true, Ordering::Relaxed);
                        break;
                    }
                    if !result.from_book {
                        set_error(
                            &error,
                            format!("missing exact parent score for key3 {}", pos.key3()),
                        );
                        stopped.store(true, Ordering::Relaxed);
                        break;
                    }
                    let target = match score_book.get(&pos) {
                        Some(value) => value,
                        None => {
                            set_error(
                                &error,
                                format!("score source missing key3 {}", pos.key3()),
                            );
                            stopped.store(true, Ordering::Relaxed);
                            break;
                        }
                    };
                    if result.score != target {
                        set_error(
                            &error,
                            format!(
                                "certification score mismatch for key3 {}: {} != {}",
                                pos.key3(),
                                result.score,
                                target
                            ),
                        );
                        stopped.store(true, Ordering::Relaxed);
                        break;
                    }
                    let changed = match shared_book.lock().unwrap().insert(&pos, col) {
                        Ok(value) => value,
                        Err(message) => {
                            set_error(&error, message);
                            stopped.store(true, Ordering::Relaxed);
                            break;
                        }
                    };
                    populated.fetch_add(changed, Ordering::Relaxed);
                    nodes.fetch_add(result.nodes, Ordering::Relaxed);
                    record_hard(&hard, pos.key3(), result.nodes);
                    let done = completed.fetch_add(1, Ordering::Relaxed) + 1;
                    if done % 250 == 0 || done == jobs.len() {
                        let elapsed = started.elapsed().as_secs_f64();
                        let rate = done as f64 / elapsed.max(0.001);
                        let remaining = (jobs.len() - done) as f64 / rate.max(0.001);
                        eprintln!(
                            "frontier {done}/{} ({:.1}%), slots={}, nodes={}, elapsed={:.1}s, remaining={:.1}s",
                            jobs.len(),
                            done as f64 * 100.0 / jobs.len().max(1) as f64,
                            populated.load(Ordering::Relaxed),
                            nodes.load(Ordering::Relaxed),
                            elapsed,
                            remaining
                        );
                    }
                    if done % CHECKPOINT_EVERY == 0 {
                        if let Ok(_checkpoint) = checkpoint_lock.try_lock() {
                            let bytes = shared_book.lock().unwrap().save();
                            if let Err(message) = atomic_write(&out, &bytes).and_then(|_| {
                                write_progress(
                                    &progress_path,
                                    false,
                                    populated.load(Ordering::Relaxed),
                                    done,
                                    jobs.len(),
                                    nodes.load(Ordering::Relaxed),
                                    started.elapsed(),
                                )
                            }) {
                                set_error(&error, message);
                                stopped.store(true, Ordering::Relaxed);
                                break;
                            }
                        }
                    }
                }
            });
        }
    });

    if let Some(message) = error.lock().unwrap().take() {
        return Err(message);
    }
    let completed_frontier = completed.load(Ordering::Relaxed);
    let final_book = Arc::try_unwrap(shared_book)
        .map_err(|_| "move-book worker references remain".to_string())?
        .into_inner()
        .map_err(|_| "move-book mutex was poisoned".to_string())?;
    atomic_write(&options.out, &final_book.save())?;
    let complete = positions
        .iter()
        .flatten()
        .all(|pos| final_book.is_complete_for(pos));
    write_progress(
        &progress_path,
        complete,
        final_book.populated(),
        completed_frontier,
        queued_frontier,
        nodes.load(Ordering::Relaxed),
        started.elapsed(),
    )?;
    write_certifications(
        &certifications_path,
        &hard.lock().unwrap(),
        completed_frontier,
        nodes.load(Ordering::Relaxed),
        started.elapsed(),
    )?;

    Ok(GenerationReport {
        canonical_positions: positions.iter().map(Vec::len).sum(),
        frontier_positions: frontier.len(),
        queued_frontier,
        completed_frontier,
        populated_slots: final_book.populated(),
        total_slots: final_book.slots(),
        nodes: nodes.load(Ordering::Relaxed),
        elapsed: started.elapsed(),
        complete,
        checkpoint: options.out.clone(),
        progress: progress_path,
        certifications: certifications_path,
    })
}

pub fn validate(
    score_path: &Path,
    move_path: &Path,
    sample_count: usize,
    tt_bits: u32,
) -> Result<ValidationReport, String> {
    let started = Instant::now();
    let score_book = load_score_book(score_path)?;
    let move_book = MoveBook::load(
        &fs::read(move_path)
            .map_err(|error| format!("cannot read {}: {error}", move_path.display()))?,
    )
    .map_err(|error| format!("bad move book {}: {error}", move_path.display()))?;
    let positions = collect_reachable(move_book.max_ply());
    verify_expected_source(&positions, &score_book, move_book.max_ply())?;

    let mut owners: Vec<Vec<u64>> = EXPECTED_SLOT_COUNTS[..=move_book.max_ply() as usize]
        .iter()
        .map(|&slots| vec![u64::MAX; slots as usize])
        .collect();
    let mut score_checks = 0usize;
    for positions_at_ply in &positions {
        for pos in positions_at_ply {
            let key = pos.key3();
            let (ply, primary, reflected) = move_book
                .index_slots(pos)
                .ok_or_else(|| format!("cannot index key3 {key}"))?;
            claim_slot(&mut owners[ply as usize], primary, key)?;
            if let Some(slot) = reflected {
                claim_slot(&mut owners[ply as usize], slot, key)?;
            }
            let col = move_book
                .get(pos)
                .ok_or_else(|| format!("missing move for key3 {key}"))?;
            let mirrored = pos.mirrored();
            move_book
                .get(&mirrored)
                .ok_or_else(|| format!("missing mirrored move for key3 {key}"))?;
            if pos.moves() <= 9 {
                let target = score_book
                    .get(pos)
                    .ok_or_else(|| format!("missing parent score for key3 {key}"))?;
                let actual = move_score_from_book(&score_book, *pos, col)?;
                if actual != target {
                    return Err(format!(
                        "non-optimal move {} for key3 {key}: score {actual}, target {target}",
                        col + 1
                    ));
                }
                score_checks += 1;
            }
        }
    }
    let indexed_positions: u32 = owners
        .iter()
        .map(|slots| slots.iter().filter(|&&owner| owner != u64::MAX).count() as u32)
        .sum();
    if move_book.populated() != indexed_positions {
        return Err(format!(
            "book has {} populated slots but reachability claims {indexed_positions}",
            move_book.populated()
        ));
    }
    if move_book.max_ply() == 10 && indexed_positions != EXPECTED_INDEXED_POSITIONS_10PLY {
        return Err(format!(
            "indexed position count {indexed_positions} != {EXPECTED_INDEXED_POSITIONS_10PLY}"
        ));
    }

    let frontier = &positions[move_book.max_ply() as usize];
    let mut sample = representative_sample(frontier, sample_count);
    let by_key: HashMap<u64, Position> = frontier.iter().map(|pos| (pos.key3(), *pos)).collect();
    for key in read_hard_keys(&sidecar_path(move_path, "cert.tsv"))? {
        if let Some(pos) = by_key.get(&key) {
            sample.push(*pos);
        }
    }
    sample.sort_unstable_by_key(Position::key3);
    sample.dedup_by_key(|pos| pos.key3());

    let empty_proven = ProvenTable::new().save();
    let mut solver = Solver::with_tt_log(tt_bits);
    solver.set_book(score_book.clone());
    solver.set_timeout_ms(0);
    let mut frontier_nodes = 0u64;
    for pos in &sample {
        let col = move_book
            .get(pos)
            .ok_or_else(|| format!("sample missing key3 {}", pos.key3()))?;
        let target = score_book
            .get(pos)
            .ok_or_else(|| format!("sample score missing key3 {}", pos.key3()))?;
        solver.reset();
        solver
            .load_proven(&empty_proven)
            .map_err(|error| format!("cannot clear validation cache: {error}"))?;
        if !solver.certify_move(*pos, col, target) {
            return Err(format!(
                "independent certification failed for key3 {}, column {}",
                pos.key3(),
                col + 1
            ));
        }
        frontier_nodes += solver.node_count();
    }

    Ok(ValidationReport {
        canonical_positions: positions.iter().map(Vec::len).sum(),
        frontier_positions: frontier.len(),
        indexed_positions,
        populated_slots: move_book.populated(),
        score_checks,
        frontier_checks: sample.len(),
        frontier_nodes,
        elapsed: started.elapsed(),
    })
}

pub fn collect_reachable(max_depth: u8) -> Vec<Vec<Position>> {
    let mut positions = vec![Vec::new(); max_depth as usize + 1];
    let mut seen = HashSet::new();
    collect_reachable_rec(Position::new(), max_depth, &mut seen, &mut positions);
    for ply in &mut positions {
        ply.sort_unstable_by_key(Position::key3);
    }
    positions
}

fn collect_reachable_rec(
    pos: Position,
    max_depth: u8,
    seen: &mut HashSet<u64>,
    positions: &mut [Vec<Position>],
) {
    if pos.last_player_won() || !seen.insert(pos.key3()) {
        return;
    }
    positions[pos.moves() as usize].push(pos);
    if pos.moves() == max_depth {
        return;
    }
    for col in 0..WIDTH {
        if !pos.can_play(col) || pos.is_winning_move(col) {
            continue;
        }
        let mut child = pos;
        child.play_col(col);
        collect_reachable_rec(child, max_depth, seen, positions);
    }
}

fn verify_expected_source(
    positions: &[Vec<Position>],
    scores: &Book,
    depth: u8,
) -> Result<(), String> {
    for pos in positions.iter().flatten() {
        if scores.get(pos).is_none() {
            return Err(format!("score source is missing key3 {}", pos.key3()));
        }
    }
    if depth == 10 {
        let total: usize = positions.iter().map(Vec::len).sum();
        if total != EXPECTED_CANONICAL_POSITIONS_10PLY {
            return Err(format!(
                "reachable canonical count {total} != {EXPECTED_CANONICAL_POSITIONS_10PLY}"
            ));
        }
        if positions[10].len() != EXPECTED_CANONICAL_POSITIONS_AT_10 {
            return Err(format!(
                "ply-10 canonical count {} != {EXPECTED_CANONICAL_POSITIONS_AT_10}",
                positions[10].len()
            ));
        }
        if scores.len() != EXPECTED_CANONICAL_POSITIONS_10PLY {
            return Err(format!(
                "score source count {} != {EXPECTED_CANONICAL_POSITIONS_10PLY}",
                scores.len()
            ));
        }
    }
    Ok(())
}

fn scored_optimal_move(scores: &Book, pos: Position) -> Result<usize, String> {
    let target = scores
        .get(&pos)
        .ok_or_else(|| format!("score source missing parent key3 {}", pos.key3()))?;
    for col in MOVE_ORDER {
        if !pos.can_play(col) {
            continue;
        }
        if move_score_from_book(scores, pos, col)? == target {
            return Ok(col);
        }
    }
    Err(format!(
        "no child matches exact parent score for key3 {}",
        pos.key3()
    ))
}

fn move_score_from_book(scores: &Book, pos: Position, col: usize) -> Result<i32, String> {
    if pos.is_winning_move(col) {
        return Ok((AREA as i32 + 1 - pos.moves() as i32) / 2);
    }
    let mut child = pos;
    child.play_col(col);
    scores
        .get(&child)
        .map(|score| -score)
        .ok_or_else(|| format!("score source missing child key3 {}", child.key3()))
}

fn representative_sample(positions: &[Position], count: usize) -> Vec<Position> {
    if count >= positions.len() {
        return positions.to_vec();
    }
    if count == 0 {
        return Vec::new();
    }
    if count == 1 {
        return vec![positions[positions.len() / 2]];
    }
    (0..count)
        .map(|index| positions[index * (positions.len() - 1) / (count - 1)])
        .collect()
}

fn claim_slot(owners: &mut [u64], slot: u32, key: u64) -> Result<(), String> {
    let owner = owners
        .get_mut(slot as usize)
        .ok_or_else(|| format!("dense index {slot} is out of range"))?;
    if *owner != u64::MAX && *owner != key {
        return Err(format!(
            "dense-index collision at slot {slot}: key3 {} and {key}",
            *owner
        ));
    }
    *owner = key;
    Ok(())
}

fn load_score_book(path: &Path) -> Result<Book, String> {
    let bytes =
        fs::read(path).map_err(|error| format!("cannot read {}: {error}", path.display()))?;
    Book::load(&bytes).map_err(|error| format!("bad score book {}: {error}", path.display()))
}

fn sidecar_path(path: &Path, suffix: &str) -> PathBuf {
    PathBuf::from(format!("{}.{}", path.display(), suffix))
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("cannot create {}: {error}", parent.display()))?;
    }
    let temporary = PathBuf::from(format!("{}.tmp", path.display()));
    fs::write(&temporary, bytes)
        .map_err(|error| format!("cannot write {}: {error}", temporary.display()))?;
    fs::rename(&temporary, path)
        .map_err(|error| format!("cannot replace {}: {error}", path.display()))
}

fn write_progress(
    path: &Path,
    complete: bool,
    populated: u32,
    completed: usize,
    queued: usize,
    nodes: u64,
    elapsed: Duration,
) -> Result<(), String> {
    let text = format!(
        "status={}\npopulated_slots={populated}\ncompleted_frontier={completed}\nqueued_frontier={queued}\nnodes={nodes}\nelapsed_seconds={:.3}\n",
        if complete { "complete" } else { "partial" },
        elapsed.as_secs_f64()
    );
    atomic_write(path, text.as_bytes())
}

fn record_hard(hard: &Mutex<Vec<(u64, u64)>>, key: u64, nodes: u64) {
    let mut hard = hard.lock().unwrap();
    hard.push((key, nodes));
    hard.sort_unstable_by(|left, right| right.1.cmp(&left.1).then(left.0.cmp(&right.0)));
    hard.truncate(100);
}

fn write_certifications(
    path: &Path,
    hard: &[(u64, u64)],
    completed: usize,
    nodes: u64,
    elapsed: Duration,
) -> Result<(), String> {
    let mut text = format!(
        "# completed={completed} nodes={nodes} elapsed_seconds={:.3}\nkey3\tnodes\n",
        elapsed.as_secs_f64()
    );
    for &(key, position_nodes) in hard {
        text.push_str(&format!("{key}\t{position_nodes}\n"));
    }
    atomic_write(path, text.as_bytes())
}

fn read_hard_keys(path: &Path) -> Result<Vec<u64>, String> {
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(path)
        .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
    Ok(text
        .lines()
        .filter(|line| !line.starts_with('#') && !line.starts_with("key3"))
        .filter_map(|line| line.split('\t').next()?.parse().ok())
        .collect())
}

fn set_error(error: &Mutex<Option<String>>, message: String) {
    let mut error = error.lock().unwrap();
    if error.is_none() {
        *error = Some(message);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reachable_counts_match_score_books_through_eight() {
        let positions = collect_reachable(8);
        assert_eq!(
            positions.iter().map(Vec::len).sum::<usize>(),
            Book::load(include_bytes!("../../books/8ply.c4book"))
                .unwrap()
                .len()
        );
        assert_eq!(
            positions.iter().map(Vec::len).collect::<Vec<_>>(),
            vec![1, 4, 25, 121, 568, 2_144, 8_231, 27_109, 91_295]
        );
    }

    #[test]
    fn scored_moves_match_every_position_through_seven() {
        let scores = Book::load(include_bytes!("../../books/8ply.c4book")).unwrap();
        for pos in collect_reachable(7).into_iter().flatten() {
            let col = scored_optimal_move(&scores, pos).unwrap();
            assert_eq!(
                move_score_from_book(&scores, pos, col).unwrap(),
                scores.get(&pos).unwrap()
            );
        }
    }

    #[test]
    fn representative_samples_include_both_ends() {
        let positions = collect_reachable(3).pop().unwrap();
        let sample = representative_sample(&positions, 5);
        assert_eq!(
            sample.first().unwrap().key3(),
            positions.first().unwrap().key3()
        );
        assert_eq!(
            sample.last().unwrap().key3(),
            positions.last().unwrap().key3()
        );
        assert_eq!(sample.len(), 5);
    }

    #[test]
    fn dense_indices_are_unique_for_positions_and_mirrors_through_eight() {
        let book = MoveBook::empty(8).unwrap();
        let positions = collect_reachable(8);
        let mut owners: Vec<Vec<u64>> = EXPECTED_SLOT_COUNTS[..=8]
            .iter()
            .map(|&slots| vec![u64::MAX; slots as usize])
            .collect();
        for pos in positions.iter().flatten() {
            let key = pos.key3();
            let (ply, primary, reflected) = book.index_slots(pos).unwrap();
            claim_slot(&mut owners[ply as usize], primary, key).unwrap();
            if let Some(slot) = reflected {
                claim_slot(&mut owners[ply as usize], slot, key).unwrap();
            }
            let mirrored = pos.mirrored();
            let (_, mirror_primary, _) = book.index_slots(&mirrored).unwrap();
            assert!(primary == mirror_primary || reflected == Some(mirror_primary));
        }
    }
}
