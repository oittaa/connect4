import type { CompleteColumnScores } from "../engineProtocol.ts";
import { WIDTH, forcedWinOrBlock, isDraw, lastMoveWin, legalCols, playMoves } from "../game.ts";

export type SolverMove = { col: number; moveScores: CompleteColumnScores | null };

export type LocalOrigin = "forced" | "random";

export type ComputerPlan =
  | { type: "local"; col: number; origin: LocalOrigin }
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

/** Immediate win/block, else uniform among legal columns. */
export function localMove(
  moves: number[],
  random: () => number,
): { col: number; origin: LocalOrigin } | null {
  const forced = forcedWinOrBlock(moves);
  if (forced !== null) return { col: forced, origin: "forced" };
  const legal = legalCols(playMoves(moves));
  if (legal.length === 0) return null;
  const col = legal[Math.floor(random() * legal.length)] ?? legal[0];
  return { col, origin: "random" };
}

export function fallbackColumn(moves: number[], random: () => number): number | null {
  return localMove(moves, random)?.col ?? null;
}
