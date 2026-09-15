import type { CompleteColumnScores } from "../engineProtocol.ts";
import {
  HEIGHT,
  INVALID,
  forcedWinOrBlock,
  isWinningDrop,
  legalCols,
  playMoves,
  toMove,
  winningCells,
  type Grid,
  type Player,
} from "../game.ts";

/** Probability Medium keeps the engine/book column when scores are unavailable. */
export const MEDIUM_KEEP_BEST = 0.82;
const MEDIUM_SECOND_BEST = 0.28;

/** True if playing `col` leaves the opponent an immediate winning drop. */
export function givesOpponentImmediateWin(g: Grid, col: number, player: Player): boolean {
  const opp = (3 - player) as Player;
  const row = g.height[col];
  if (row >= HEIGHT) return true;
  g.cells[row][col] = player;
  g.height[col] = row + 1;
  let hang = false;
  if (!winningCells(g, row, col)) {
    hang = legalCols(g).some((c) => isWinningDrop(g, c, opp));
  }
  g.cells[row][col] = 0;
  g.height[col] = row;
  return hang;
}

export function mediumMove(scores: number[], random: () => number = Math.random): number | null {
  const valid: { s: number; c: number }[] = [];
  for (let c = 0; c < scores.length; c++) {
    if (scores[c] !== INVALID) valid.push({ s: scores[c], c });
  }
  if (valid.length === 0) return null;
  const distinct = [...new Set(valid.map((x) => x.s))].sort((a, b) => b - a);
  const target = distinct.length > 1 && random() < MEDIUM_SECOND_BEST ? distinct[1] : distinct[0];
  const pool = valid.filter((x) => x.s === target).map((x) => x.c);
  return pool[Math.floor(random() * pool.length)] ?? pool[0];
}

/**
 * Medium: take wins/blocks, then rank from complete move scores, else
 * keep the engine column most of the time or leak to a non-losing legal drop.
 */
export function pickMedium(
  moves: number[],
  engineCol: number,
  moveScores: CompleteColumnScores | null,
  random: () => number = Math.random,
): number | null {
  const forced = forcedWinOrBlock(moves);
  if (forced !== null) return forced;

  const ranked = moveScores === null ? null : mediumMove(moveScores, random);
  if (ranked !== null) return ranked;

  const g = playMoves(moves);
  const p = toMove(moves);
  const legal = legalCols(g);
  if (legal.length === 0) return null;
  const safe = legal.filter((c) => !givesOpponentImmediateWin(g, c, p));
  const pool = safe.length > 0 ? safe : legal;
  if (pool.length === 1) return pool[0];
  if (pool.includes(engineCol) && random() < MEDIUM_KEEP_BEST) return engineCol;
  const rest = pool.filter((c) => c !== engineCol);
  const pickFrom = rest.length > 0 ? rest : pool;
  return pickFrom[Math.floor(random() * pickFrom.length)] ?? engineCol;
}
