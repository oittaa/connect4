import type { CompleteColumnScores } from "./engineProtocol.ts";
import { INVALID, forcedWinOrBlock, formatScore } from "./game.ts";

/** Engine/worker fields that decide how a solver move was chosen. */
export type SolverSelectionReply = {
  fromMoveBook: boolean;
  nodes: number;
  micros: number;
  timedOut: boolean;
  moveScores: CompleteColumnScores | null;
  hintScores: number[];
};

export type MoveSelection = {
  source: "score book" | "move book" | "engine" | "tactical" | "forced" | "random";
  col: number;
  score?: number;
  hashesPerSecond?: number;
  timedOut?: boolean;
};

export function hashesPerSecond(nodes: number, micros: number): number {
  return micros > 0 ? Math.round((nodes / micros) * 1_000_000) : 0;
}

function knownScore(col: number, scores: ArrayLike<number> | null | undefined): number | undefined {
  if (!scores || col < 0 || col >= scores.length) return undefined;
  const s = scores[col];
  return s === INVALID ? undefined : s;
}

/** Easy/Medium local plans: forced win or block, otherwise a uniform legal column. */
export function describeLocalMove(moves: number[], col: number): MoveSelection {
  if (forcedWinOrBlock(moves) !== null) return { source: "forced", col };
  return { source: "random", col };
}

/**
 * Classify a computer column from the solver reply. Move-book hits win even
 * when score-book column scores are also present (Perfect may resample).
 * Instant non-book replies with complete score-book columns are score-book
 * hits; other 0-node replies are tactical (immediate win / threat).
 */
export function describeSolverMove(col: number, reply: SolverSelectionReply): MoveSelection {
  if (reply.fromMoveBook) return { source: "move book", col };

  const bookScore = knownScore(col, reply.moveScores);
  const searchScore = knownScore(col, reply.hintScores);
  if (reply.nodes === 0 && !reply.timedOut) {
    if (reply.moveScores !== null) {
      return { source: "score book", col, score: bookScore ?? searchScore };
    }
    return { source: "tactical", col, score: searchScore ?? bookScore };
  }

  const nps = hashesPerSecond(reply.nodes, reply.micros);
  return {
    source: "engine",
    col,
    score: searchScore ?? bookScore,
    hashesPerSecond: nps > 0 ? nps : undefined,
    timedOut: reply.timedOut,
  };
}

export function formatMoveSelection(s: MoveSelection): string {
  const column = `column ${s.col + 1}`;
  const score = s.score === undefined ? "" : ` ${formatScore(s.score)}`;
  switch (s.source) {
    case "move book":
      return `move book (${column})`;
    case "score book":
      return `score book${score} (${column})`;
    case "tactical":
      return `tactical${score} (${column})`;
    case "engine": {
      const nps = s.hashesPerSecond !== undefined ? ` · ${s.hashesPerSecond} hashes/s` : "";
      const timeout = s.timedOut ? " timed out" : "";
      return `engine${score}${nps}${timeout} (${column})`;
    }
    case "forced":
      return `forced (${column})`;
    case "random":
      return `random (${column})`;
  }
}

export function logMoveSelection(
  enabled: boolean,
  selection: MoveSelection,
  log: (message: string) => void = console.log,
): void {
  if (!enabled) return;
  log(formatMoveSelection(selection));
}
