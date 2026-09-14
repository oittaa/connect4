//! Convert an existing score book to packed moves. No solver searches are used.

use crate::book::Book;
use crate::move_book::{MoveBook, EXPECTED_SLOT_COUNTS};
use crate::position::{Position, AREA, WIDTH};

const MOVE_ORDER: [usize; WIDTH] = [3, 4, 2, 5, 1, 6, 0];

/// A depth-N score book supplies child scores for positions through depth N-1.
pub fn from_scores(scores: &Book) -> Result<MoveBook, String> {
    let depth = scores
        .depth()
        .checked_sub(1)
        .ok_or("score book needs child positions")?;
    let mut moves = MoveBook::empty(depth)?;
    for (key, target) in scores.entries() {
        let pos = decode(key, scores.depth())?;
        if pos.moves() > depth {
            continue;
        }
        let mut best = None;
        for col in MOVE_ORDER {
            if pos.can_play(col) && move_score(scores, pos, col)? == target {
                best = Some(col);
                break;
            }
        }
        moves.insert(
            &pos,
            best.ok_or_else(|| format!("no optimal child for key3 {key}"))?,
        )?;
    }
    Ok(moves)
}

/// Check every covered source position and its reflection against child scores.
/// Also reject dense-index collisions and entries absent from the source book.
pub fn validate(scores: &Book, moves: &MoveBook) -> Result<usize, String> {
    if scores.depth() <= moves.max_ply() {
        return Err("score book must include the move book's child positions".into());
    }
    let mut owners: Vec<Vec<u64>> = EXPECTED_SLOT_COUNTS[..=moves.max_ply() as usize]
        .iter()
        .map(|&slots| vec![0; slots as usize])
        .collect();
    let mut checked = 0;
    for (key, target) in scores.entries() {
        let pos = decode(key, scores.depth())?;
        if pos.moves() > moves.max_ply() {
            continue;
        }
        for board in [pos, pos.mirrored()] {
            let (ply, slot) = moves.index(&board).ok_or("cannot index board")?;
            let owner = &mut owners[ply as usize][slot as usize];
            if *owner != 0 && *owner != key + 1 {
                return Err(format!("dense-index collision for key3 {key}"));
            }
            *owner = key + 1;
            let col = moves
                .get(&board)
                .ok_or_else(|| format!("missing move for key3 {key}"))?;
            if move_score(scores, board, col)? != target {
                return Err(format!("non-optimal column {} for key3 {key}", col + 1));
            }
        }
        checked += 1;
    }
    let populated = owners.iter().flatten().filter(|&&key| key != 0).count();
    if populated != moves.populated() as usize {
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

fn move_score(scores: &Book, pos: Position, col: usize) -> Result<i32, String> {
    if pos.is_winning_move(col) {
        return Ok((AREA as i32 + 1 - pos.moves() as i32) / 2);
    }
    let mut child = pos;
    child.play_col(col);
    scores
        .get(&child)
        .map(|score| -score)
        .ok_or_else(|| format!("missing child score for key3 {}", child.key3()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_existing_scores_without_search() {
        let scores = Book::opening_4ply();
        let moves = from_scores(&scores).unwrap();
        assert_eq!(moves.max_ply(), 3);
        assert_eq!(validate(&scores, &moves).unwrap(), 151);
        assert_eq!(moves.get(&Position::new()), Some(3));
    }

    #[test]
    fn missing_child_scores_fail_conversion() {
        let mut scores = Book::new();
        scores.insert(0, 1, 4);
        assert!(from_scores(&scores)
            .unwrap_err()
            .contains("missing child score"));
        assert!(from_scores(&Book::new()).is_err());
    }

    #[test]
    fn validation_rejects_missing_and_inferior_moves() {
        let scores = Book::opening_4ply();
        let mut moves = MoveBook::empty(3).unwrap();
        assert!(validate(&scores, &moves).is_err());
        moves.insert(&Position::new(), 0).unwrap();
        assert!(validate(&scores, &moves)
            .unwrap_err()
            .contains("non-optimal"));
    }

    #[test]
    fn shipped_book_matches_every_source_position_and_its_mirror() {
        let scores = Book::load(include_bytes!("../../books/10ply.c4book")).unwrap();
        let bytes = include_bytes!("../../books/9ply.c4move");
        let moves = MoveBook::load(bytes).unwrap();
        assert_eq!(scores.len(), 1_208_493);
        assert_eq!(moves.max_ply(), 9);
        assert_eq!(moves.populated(), 402_045);
        assert_eq!(bytes.len(), 169_821);
        assert_eq!(validate(&scores, &moves).unwrap(), 399_029);
        assert_eq!(from_scores(&scores).unwrap().save(), bytes);
        assert_eq!(
            include_bytes!("../../web/public/books/opening.c4move"),
            bytes
        );
    }
}
