import type { CompleteColumnScores } from "./engineProtocol.ts";
import { INVALID, forcedWinOrBlock, formatScore, toMove } from "./game.ts";

/** Engine/worker fields that decide how a solver move was chosen. */
export type SolverSelectionReply = {
  fromMoveBook: boolean;
  nodes: number;
  micros: number;
  timedOut: boolean;
  moveScores: CompleteColumnScores | null;
  hintScores: number[];
};

export type Side = "Red" | "Yellow";

export type MoveSelection = {
  source: "score book" | "move book" | "engine" | "tactical" | "forced" | "random" | "human";
  col: number;
  ply: number;
  side: Side;
  score?: number;
  hashesPerSecond?: number;
  timedOut?: boolean;
};

export function hashesPerSecond(nodes: number, micros: number): number {
  return micros > 0 ? Math.round((nodes / micros) * 1_000_000) : 0;
}

/** Who is about to drop, using the same Red/Yellow names as the status line. */
export function moverOf(moves: number[]): { ply: number; side: Side } {
  return {
    ply: moves.length + 1,
    side: toMove(moves) === 1 ? "Red" : "Yellow",
  };
}

function knownScore(col: number, scores: ArrayLike<number> | null | undefined): number | undefined {
  if (!scores || col < 0 || col >= scores.length) return undefined;
  const s = scores[col];
  return s === INVALID ? undefined : s;
}

function withMover(moves: number[], rest: Omit<MoveSelection, "ply" | "side">): MoveSelection {
  return { ...rest, ...moverOf(moves) };
}

/** Easy/Medium local plans: forced win or block, otherwise a uniform legal column. */
export function describeLocalMove(moves: number[], col: number): MoveSelection {
  return withMover(moves, {
    source: forcedWinOrBlock(moves) !== null ? "forced" : "random",
    col,
  });
}

export function describeHumanMove(moves: number[], col: number): MoveSelection {
  return withMover(moves, { source: "human", col });
}

/**
 * Classify a computer column from the solver reply.
 *
 * Complete score-book column scores are how Perfect/Medium pick among equals
 * (even when the engine also had a move-book hit). A move-book hit without
 * those scores is a compact-book column. Other 0-node replies are tactical
 * (immediate win / threat). Anything that searched is engine.
 */
export function describeSolverMove(
  col: number,
  reply: SolverSelectionReply,
  moves: number[],
): MoveSelection {
  const bookScore = knownScore(col, reply.moveScores);
  const searchScore = knownScore(col, reply.hintScores);

  if (reply.moveScores !== null) {
    return withMover(moves, { source: "score book", col, score: bookScore ?? searchScore });
  }
  if (reply.fromMoveBook) return withMover(moves, { source: "move book", col });
  if (reply.nodes === 0 && !reply.timedOut) {
    return withMover(moves, { source: "tactical", col, score: searchScore ?? bookScore });
  }

  const nps = hashesPerSecond(reply.nodes, reply.micros);
  return withMover(moves, {
    source: "engine",
    col,
    score: searchScore ?? bookScore,
    hashesPerSecond: nps > 0 ? nps : undefined,
    timedOut: reply.timedOut,
  });
}

function where(s: MoveSelection): string {
  return `ply ${s.ply}, ${s.side}, column ${s.col + 1}`;
}

export function formatMoveSelection(s: MoveSelection): string {
  const score = s.score === undefined ? "" : ` ${formatScore(s.score)}`;
  const at = `(${where(s)})`;
  switch (s.source) {
    case "move book":
      return `move book ${at}`;
    case "score book":
      return `score book${score} ${at}`;
    case "tactical":
      return `tactical${score} ${at}`;
    case "engine": {
      const nps = s.hashesPerSecond !== undefined ? ` · ${s.hashesPerSecond} hashes/s` : "";
      const timeout = s.timedOut ? " timed out" : "";
      return `engine${score}${nps}${timeout} ${at}`;
    }
    case "forced":
      return `forced ${at}`;
    case "random":
      return `random ${at}`;
    case "human":
      return `human ${at}`;
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
