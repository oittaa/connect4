//! Native generation and exhaustive validation for `C4MV` move books.

use crate::book::Book;
use crate::move_book::{MoveBook, EXPECTED_SLOT_COUNTS, MAX_MOVE_BOOK_PLY};
use crate::position::{Position, AREA, WIDTH};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub const EXPECTED_CANONICAL_POSITIONS_10PLY: usize = 1_208_493;
pub const EXPECTED_CANONICAL_POSITIONS_AT_10: usize = 809_464;
pub const EXPECTED_INDEXED_POSITIONS_10PLY: u32 = 1_216_864;
pub const EXPECTED_COVERED_SLOTS_THROUGH_9: u32 = 402_045;

const MOVE_ORDER: [usize; WIDTH] = [3, 4, 2, 5, 1, 6, 0];
#[derive(Clone, Debug)]
pub struct GenerateOptions {
    pub depth: u8,
    pub scores: PathBuf,
    pub out: PathBuf,
}

#[derive(Clone, Debug)]
pub struct GenerationReport {
    pub canonical_positions: usize,
    pub frontier_positions: usize,
    pub covered_ply: u8,
    pub populated_slots: u32,
    pub total_slots: u32,
    pub elapsed: Duration,
    pub complete: bool,
    pub output: PathBuf,
    pub progress: PathBuf,
}

#[derive(Clone, Debug)]
pub struct ValidationReport {
    pub canonical_positions: usize,
    pub frontier_positions: usize,
    pub indexed_positions: u32,
    pub populated_slots: u32,
    pub score_checks: usize,
    pub uncovered_frontier_slots: u32,
    pub elapsed: Duration,
}

/// Build a lookup-only book. Exact child scores certify plies 0-9; ply 10 is
/// deliberately all-unknown because its children are not in a 10-ply score book.
pub fn generate(options: &GenerateOptions) -> Result<GenerationReport, String> {
    if options.depth > MAX_MOVE_BOOK_PLY {
        return Err(format!("depth {} is not supported", options.depth));
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

    // Always rebuild from unknown bytes. In particular, this removes any
    // search-certified ply-10 entries from an older experimental checkpoint.
    let mut move_book = MoveBook::empty(options.depth)?;
    let covered_ply = options.depth.min(9);
    for ply in 0..=covered_ply as usize {
        for pos in &positions[ply] {
            let col = scored_optimal_move(&score_book, *pos)?;
            move_book.insert(pos, col)?;
        }
    }

    let populated_slots = move_book.populated();
    let complete = positions[..=covered_ply as usize]
        .iter()
        .flatten()
        .all(|pos| move_book.is_complete_for(pos))
        && (options.depth < 10 || move_book.populated_at(10) == 0);
    if !complete {
        return Err("lookup-only move book failed its generation coverage check".into());
    }
    atomic_write(&options.out, &move_book.save())?;
    let progress_path = sidecar_path(&options.out, "progress");
    write_progress(
        &progress_path,
        covered_ply,
        populated_slots,
        positions[options.depth as usize].len(),
        started.elapsed(),
    )?;
    let old_certifications = sidecar_path(&options.out, "cert.tsv");
    if old_certifications.is_file() {
        fs::remove_file(&old_certifications).map_err(|error| {
            format!(
                "cannot remove obsolete {}: {error}",
                old_certifications.display()
            )
        })?;
    }

    Ok(GenerationReport {
        canonical_positions: positions.iter().map(Vec::len).sum(),
        frontier_positions: positions[options.depth as usize].len(),
        covered_ply,
        populated_slots,
        total_slots: move_book.slots(),
        elapsed: started.elapsed(),
        complete,
        output: options.out.clone(),
        progress: progress_path,
    })
}

pub fn validate(score_path: &Path, move_path: &Path) -> Result<ValidationReport, String> {
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
            let mirrored = pos.mirrored();
            let (_, mirror_primary, _) = move_book
                .index_slots(&mirrored)
                .ok_or_else(|| format!("cannot index mirrored key3 {key}"))?;
            if primary != mirror_primary && reflected != Some(mirror_primary) {
                return Err(format!("mirror index mismatch for key3 {key}"));
            }

            if pos.moves() <= 9 {
                let col = move_book
                    .get(pos)
                    .ok_or_else(|| format!("missing move for key3 {key}"))?;
                move_book
                    .get(&mirrored)
                    .ok_or_else(|| format!("missing mirrored move for key3 {key}"))?;
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
            } else {
                if move_book.get(pos).is_some() || move_book.get(&mirrored).is_some() {
                    return Err(format!("ply-10 slot unexpectedly populated for key3 {key}"));
                }
            }
        }
    }

    let indexed_positions: u32 = owners
        .iter()
        .map(|slots| slots.iter().filter(|&&owner| owner != u64::MAX).count() as u32)
        .sum();
    if move_book.max_ply() == 10 && indexed_positions != EXPECTED_INDEXED_POSITIONS_10PLY {
        return Err(format!(
            "indexed position count {indexed_positions} != {EXPECTED_INDEXED_POSITIONS_10PLY}"
        ));
    }
    let covered_ply = move_book.max_ply().min(9) as usize;
    let expected_populated: u32 = owners[..=covered_ply]
        .iter()
        .map(|slots| slots.iter().filter(|&&owner| owner != u64::MAX).count() as u32)
        .sum();
    if move_book.max_ply() == 10 && expected_populated != EXPECTED_COVERED_SLOTS_THROUGH_9 {
        return Err(format!(
            "covered slot count {expected_populated} != {EXPECTED_COVERED_SLOTS_THROUGH_9}"
        ));
    }
    if move_book.populated() != expected_populated {
        return Err(format!(
            "book has {} populated slots but plies 0-{covered_ply} require {expected_populated}",
            move_book.populated()
        ));
    }
    let uncovered_frontier_slots = if move_book.max_ply() == 10 {
        if move_book.populated_at(10) != 0 {
            return Err("ply-10 section must be entirely unknown".into());
        }
        EXPECTED_SLOT_COUNTS[10]
    } else {
        0
    };

    Ok(ValidationReport {
        canonical_positions: positions.iter().map(Vec::len).sum(),
        frontier_positions: positions[move_book.max_ply() as usize].len(),
        indexed_positions,
        populated_slots: move_book.populated(),
        score_checks,
        uncovered_frontier_slots,
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
    covered_ply: u8,
    populated: u32,
    frontier_positions: usize,
    elapsed: Duration,
) -> Result<(), String> {
    let text = format!(
        "status=complete-through-ply-{covered_ply}\npopulated_slots={populated}\nply_10_populated=0\nply_10_fallback_positions={frontier_positions}\nsearch_nodes=0\nelapsed_seconds={:.3}\n",
        elapsed.as_secs_f64()
    );
    atomic_write(path, text.as_bytes())
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
