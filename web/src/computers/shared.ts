import type { CompleteColumnScores } from "../engineProtocol.ts";
import { WIDTH, forcedWinOrBlock, isDraw, lastMoveWin, legalCols, playMoves } from "../game.ts";

export type SolverMove = { col: number; moveScores: CompleteColumnScores | null };

export type ComputerPlan =
  | { type: "local"; col: number }
  | { type: "solver"; choose: (reply: SolverMove) => number | null };

export type ComputerPolicy = {
  label: string;
  plan(moves: number[], random: () => number): ComputerPlan | null;
};

export function isTerminal(moves: number[]): boolean {
  return lastMoveWin(moves) !== null || isDraw(moves);
}

export function legalEngineColumn(col: number): boolean {
  return col >= 0 && col < WIDTH;
}

/**
 * Immediate win/block, else uniform among legal columns. Center-first order
 * `[3, 4, 2, 5, 1, 6, 0]` so `random() === 0` maps to column 3.
 */
export function fallbackColumn(moves: number[], random: () => number): number | null {
  const forced = forcedWinOrBlock(moves);
  if (forced !== null) return forced;
  const legal = legalCols(playMoves(moves));
  if (legal.length === 0) return null;
  const order = [3, 4, 2, 5, 1, 6, 0].filter((c) => legal.includes(c));
  return order[Math.floor(random() * order.length)] ?? legal[0];
}
