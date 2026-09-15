//! Convert an existing score book to a packed move book. No solver searches are used.

use crate::move_book::{MoveBook, EXPECTED_SLOT_COUNTS};
use crate::position::{Position, AREA, WIDTH};
use crate::score_book::ScoreBook;

const MOVE_ORDER: [usize; WIDTH] = [3, 4, 2, 5, 1, 6, 0];

/// A depth-N score book supplies child scores for positions through depth N-1.
pub fn convert_score_to_move(score_book: &ScoreBook) -> Result<MoveBook, String> {
    let depth = score_book
        .depth()
        .checked_sub(1)
        .ok_or("score book must cover at least one move")?;
    let mut move_book = MoveBook::empty(depth)?;
    for (key, target) in score_book.entries() {
        let pos = decode(key, score_book.depth())?;
        if pos.moves() > depth {
            continue;
        }
        let mut best = None;
        for col in MOVE_ORDER {
            if pos.can_play(col) && move_score(score_book, pos, col)? == target {
                best = Some(col);
                break;
            }
        }
        move_book.insert(
            &pos,
            best.ok_or_else(|| format!("no optimal child for key3 {key}"))?,
        )?;
    }
    Ok(move_book)
}

/// Check every covered source position and its reflection against child scores.
/// Also reject dense-index collisions and entries absent from the source book.
pub fn validate_against_score_book(
    score_book: &ScoreBook,
    move_book: &MoveBook,
) -> Result<usize, String> {
    if score_book.moves_covered() < move_book.moves_covered() {
        return Err("score book must cover at least as many moves as the move book".into());
    }
    let mut owners: Vec<Vec<u64>> = EXPECTED_SLOT_COUNTS[..=move_book.max_ply() as usize]
        .iter()
        .map(|&slots| vec![0; slots as usize])
        .collect();
    let mut checked = 0;
    for (key, target) in score_book.entries() {
        let pos = decode(key, score_book.depth())?;
        if pos.moves() > move_book.max_ply() {
            continue;
        }
        for board in [pos, pos.mirrored()] {
            let (ply, slot) = move_book.index(&board).ok_or("cannot index board")?;
            let owner = &mut owners[ply as usize][slot as usize];
            if *owner != 0 && *owner != key + 1 {
                return Err(format!("dense-index collision for key3 {key}"));
            }
            *owner = key + 1;
            let col = move_book
                .get(&board)
                .ok_or_else(|| format!("missing move for key3 {key}"))?;
            if move_score(score_book, board, col)? != target {
                return Err(format!("non-optimal column {} for key3 {key}", col + 1));
            }
        }
        checked += 1;
    }
    let populated = owners.iter().flatten().filter(|&&key| key != 0).count();
    if populated != move_book.populated() as usize {
        return Err("move book contains positions absent from the score book".into());
    }
    Ok(checked)
}

fn decode(key: u64, depth: u8) -> Result<Position, String> {
    let pos = Position::from_key3(key).ok_or_else(|| format!("invalid score-book key3 {key}"))?;
    if pos.moves() > depth || pos.last_player_won() || pos.is_draw() {
        return Err(format!("invalid score-book position for key3 {key}"));
    }
    Ok(pos)
}

fn move_score(score_book: &ScoreBook, pos: Position, col: usize) -> Result<i32, String> {
    if pos.is_winning_move(col) {
        return Ok((AREA as i32 + 1 - pos.moves() as i32) / 2);
    }
    let mut child = pos;
    child.play_col(col);
    score_book
        .get(&child)
        .map(|score| -score)
        .ok_or_else(|| format!("missing child score for key3 {}", child.key3()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_existing_scores_without_search() {
        let score_book = ScoreBook::opening_4ply();
        let move_book = convert_score_to_move(&score_book).unwrap();
        assert_eq!(move_book.max_ply(), 3);
        assert_eq!(
            validate_against_score_book(&score_book, &move_book).unwrap(),
            151
        );
        assert_eq!(move_book.get(&Position::new()), Some(3));
    }

    #[test]
    fn missing_child_scores_fail_conversion() {
        let mut score_book = ScoreBook::new();
        score_book.insert(0, 1, 4);
        assert!(convert_score_to_move(&score_book)
            .unwrap_err()
            .contains("missing child score"));
        assert!(convert_score_to_move(&ScoreBook::new()).is_err());
    }

    #[test]
    fn validation_rejects_missing_and_inferior_moves() {
        let score_book = ScoreBook::opening_4ply();
        let mut move_book = MoveBook::empty(3).unwrap();
        assert!(validate_against_score_book(&score_book, &move_book).is_err());
        move_book.insert(&Position::new(), 0).unwrap();
        assert!(validate_against_score_book(&score_book, &move_book)
            .unwrap_err()
            .contains("non-optimal"));
    }

    #[test]
    fn ten_move_book_matches_every_source_position_and_its_mirror() {
        let score_book = ScoreBook::load(include_bytes!("../../books/10ply.c4book")).unwrap();
        let bytes = include_bytes!("../../books/10ply.c4move");
        let move_book = MoveBook::load(bytes).unwrap();
        assert_eq!(score_book.len(), 1_208_493);
        assert_eq!(move_book.max_ply(), 9);
        assert_eq!(move_book.populated(), 402_045);
        assert_eq!(bytes.len(), 169_821);
        assert_eq!(
            validate_against_score_book(&score_book, &move_book).unwrap(),
            399_029
        );
        assert_eq!(convert_score_to_move(&score_book).unwrap().save(), bytes);
    }
}
