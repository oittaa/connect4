import type { CompleteColumnScores } from "../engineProtocol.ts";
import { bestCols } from "../game.ts";
import type { SolverMove } from "./shared.ts";

/** Sample uniformly among complete best-column scores; otherwise keep the engine column. */
function pickPerfect(
  engineCol: number,
  moveScores: CompleteColumnScores | null,
  random: () => number,
): number {
  if (moveScores !== null) {
    const pool = bestCols(moveScores);
    if (pool.length > 0) return pool[Math.floor(random() * pool.length)] ?? engineCol;
  }
  return engineCol;
}

export const perfect = {
  label: "Perfect",
  plan(_moves: number[], random: () => number) {
    return {
      type: "solver" as const,
      choose: (reply: SolverMove) => pickPerfect(reply.col, reply.moveScores, random),
    };
  },
};
