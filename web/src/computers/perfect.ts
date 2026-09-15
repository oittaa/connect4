import type { CompleteColumnScores } from "../engineProtocol.ts";
import { bestCols } from "../game.ts";

/** Sample uniformly among complete best-column scores; otherwise keep the engine column. */
export function pickPerfect(
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
