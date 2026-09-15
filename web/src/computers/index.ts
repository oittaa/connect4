import type { CompleteColumnScores } from "../engineProtocol.ts";
import { WIDTH, forcedWinOrBlock, isDraw, lastMoveWin } from "../game.ts";
import { easyMove } from "./easy.ts";
import { pickMedium } from "./medium.ts";
import { pickPerfect } from "./perfect.ts";

export type ComputerRole = "easy" | "medium" | "perfect";

/** Local column, engine request, or `null` when the position is already over. */
export type ComputerTurnPlan = { type: "local"; col: number } | { type: "engine" };

export { easyMove } from "./easy.ts";
export { MEDIUM_KEEP_BEST, mediumMove, pickMedium } from "./medium.ts";
export { pickPerfect } from "./perfect.ts";

function isTerminal(moves: number[]): boolean {
  return lastMoveWin(moves) !== null || isDraw(moves);
}

function legalEngineColumn(col: number): boolean {
  return col >= 0 && col < WIDTH;
}

/**
 * Decide how a computer seat should move. Easy is always local; Medium takes an
 * immediate win or block locally and otherwise asks the engine; Perfect always
 * asks the engine. The caller owns delay, pause, and request invalidation.
 */
export function planComputerTurn(
  role: ComputerRole,
  moves: number[],
  random: () => number = Math.random,
): ComputerTurnPlan | null {
  if (isTerminal(moves)) return null;
  if (role === "easy") {
    const col = easyMove(moves, random);
    return col === null ? null : { type: "local", col };
  }
  if (role === "medium") {
    const forced = forcedWinOrBlock(moves);
    if (forced !== null) return { type: "local", col: forced };
  }
  return { type: "engine" };
}

/**
 * Turn an engine reply into the column to play. Medium keeps its score-based
 * and fallback selection; Perfect samples uniformly among `bestCols` when
 * complete scores exist, otherwise keeps the engine column. An out-of-range
 * column falls back to Easy.
 */
export function chooseAfterEngine(
  role: ComputerRole,
  moves: number[],
  engineCol: number,
  moveScores: CompleteColumnScores | null,
  random: () => number = Math.random,
): number | null {
  let col = engineCol;
  if (role === "medium") col = pickMedium(moves, engineCol, moveScores, random) ?? engineCol;
  else if (role === "perfect") col = pickPerfect(engineCol, moveScores, random);
  if (!legalEngineColumn(col)) col = easyMove(moves, random) ?? col;
  return legalEngineColumn(col) ? col : null;
}
