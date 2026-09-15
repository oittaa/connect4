import { forcedWinOrBlock, legalCols, playMoves } from "../game.ts";

/** Uniform among legal columns after tactical checks. */
export function easyMove(moves: number[], random: () => number = Math.random): number | null {
  const forced = forcedWinOrBlock(moves);
  if (forced !== null) return forced;
  const legal = legalCols(playMoves(moves));
  if (legal.length === 0) return null;
  // Uniform among legal columns; center-first order so random() === 0 maps to 3.
  const order = [3, 4, 2, 5, 1, 6, 0].filter((c) => legal.includes(c));
  return order[Math.floor(random() * order.length)] ?? legal[0];
}
