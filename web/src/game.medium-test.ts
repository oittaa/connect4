// Deterministic Medium and computer-turn policy checks. Run: npm test

import { computers, planComputer, resolveSolverColumn, type ComputerId } from "./computers/index.ts";
import type { CompleteColumnScores } from "./engineProtocol.ts";
import {
  INVALID,
  analysisScoreClass,
  completeMoveScores,
  forcedWinOrBlock,
  formatScore,
  isDraw,
  lastMoveWin,
  playMoves,
  provenBestColumns,
  statusText,
} from "./game.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function same(got: unknown, expected: unknown, msg: string): void {
  assert(JSON.stringify(got) === JSON.stringify(expected), `${msg}: got ${JSON.stringify(got)}`);
}

function seq(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)] ?? 0;
}

function planOf(id: ComputerId, moves: number[], random: () => number = () => 0) {
  return planComputer(computers[id], moves, random);
}

function afterEngine(
  id: ComputerId,
  moves: number[],
  engineCol: number,
  moveScores: CompleteColumnScores | null,
  random: () => number,
): number | null {
  const plan = planComputer(computers[id], moves, random);
  if (plan === null) return null;
  if (plan.type === "local") return plan.col;
  return resolveSolverColumn(plan.choose, { col: engineCol, moveScores }, moves, random);
}

const emptyScores: CompleteColumnScores = [-2, -1, 0, 1, 0, -1, -2];
const tiedBest: CompleteColumnScores = [0, 1, 1, 0, -1, -2, -2];
const oneScored: CompleteColumnScores = [INVALID, INVALID, INVALID, 1, INVALID, INVALID, INVALID];

const winSeq = [0, 1, 0, 2, 0, 3];
assert(forcedWinOrBlock(winSeq) === 0, "forced win");

const blockSeq = [1, 0, 2, 0, 6, 0];
assert(forcedWinOrBlock(blockSeq) === 0, "forced block");
assert(forcedWinOrBlock([]) === null, "empty board is not forced");

// Playing column 3 fills the support for Yellow's row-1 three-in-a-row.
const hangSeq = [0, 0, 6, 1, 2, 1, 6, 2];
assert(forcedWinOrBlock(hangSeq) === null, "hang is not an immediate threat");

const winSeqPlayed = [...winSeq, 0];
assert(lastMoveWin(winSeqPlayed) !== null, "mate is terminal");
assert(planOf("easy", winSeqPlayed, () => 0) === null, "Easy skips a finished game");
assert(planOf("medium", winSeqPlayed, () => 0) === null, "Medium skips a finished game");
assert(planOf("perfect", winSeqPlayed, () => 0) === null, "Perfect skips a finished game");

same(planOf("easy", [], () => 0), { type: "local", col: 0 }, "Easy picks the first legal column");
same(planOf("easy", [], () => 0.99), { type: "local", col: 6 }, "Easy picks the last legal column");
same(planOf("easy", winSeq, () => 0), { type: "local", col: 0 }, "Easy forced mate is local");
same(planOf("easy", blockSeq, () => 0), { type: "local", col: 0 }, "Easy forced block is local");
same(planOf("medium", winSeq, () => 0), { type: "local", col: 0 }, "Medium mate is local");
same(planOf("medium", blockSeq, () => 0), { type: "local", col: 0 }, "Medium block is local");
same(planOf("medium", [], () => 0), { type: "solver" }, "Medium otherwise asks the engine");
same(planOf("medium", hangSeq, () => 0), { type: "solver" }, "Medium hang is not tactical");
same(planOf("perfect", [], () => 0), { type: "solver" }, "Perfect asks the engine");
same(planOf("perfect", winSeq, () => 0), { type: "solver" }, "Perfect does not take a local mate");

assert(afterEngine("medium", [], 2, emptyScores, seq([0.99, 0])) === 3, "Medium unique best ignores the engine column");
assert(afterEngine("medium", [], 3, emptyScores, seq([0, 0])) === 2, "Medium 28% second-best first tie");
assert(afterEngine("medium", [], 3, emptyScores, seq([0, 0.99])) === 4, "Medium 28% second-best last tie");
assert(afterEngine("medium", [], 0, tiedBest, seq([0.99, 0])) === 1, "Medium best-tier first tie");
assert(afterEngine("medium", [], 0, tiedBest, seq([0.99, 0.99])) === 2, "Medium best-tier last tie");
assert(afterEngine("medium", [], 0, oneScored, () => 0) === 3, "Medium one scored column");
assert(afterEngine("medium", hangSeq, 3, null, () => 0.5) !== 3, "Medium fallback avoids hanging a win");
assert(afterEngine("medium", [0, 1], 3, null, () => 0.5) === 3, "Medium keeps the engine column");
const leaked = afterEngine("medium", [0, 1], 3, null, () => 0.9);
assert(leaked !== null && leaked !== 3, `Medium can leak away from the engine column, got ${leaked}`);

assert(afterEngine("perfect", [], 3, emptyScores, () => 0) === 3, "Perfect unique best is the engine column");
assert(afterEngine("perfect", [], 2, emptyScores, seq([0.99, 0])) === 3, "Perfect unique best ignores the engine column");
assert(
  afterEngine("perfect", [], 2, emptyScores, seq([0, 0])) === 3,
  "Perfect unique best does not leak to second-best",
);
assert(afterEngine("perfect", [], 3, null, () => 0) === 3, "Perfect ignores missing scores");
assert(afterEngine("perfect", [], 255, null, () => 0) === 0, "invalid Perfect column falls back to a legal Easy pick");
assert(afterEngine("perfect", [], 0, tiedBest, seq([0])) === 1, "Perfect first best-tier tie");
assert(afterEngine("perfect", [], 0, tiedBest, seq([0.99])) === 2, "Perfect last best-tier tie");
const allTie: CompleteColumnScores = [-1, -1, -1, -1, -1, -1, -1];
assert(afterEngine("perfect", [], 0, allTie, () => 0) === 0, "Perfect all-tie first column");
assert(afterEngine("perfect", [], 0, allTie, () => 0.99) === 6, "Perfect all-tie last column");

// Full board from testdata/end_easy (41 ply, one safe drop left).
const draw = "71255763773133525731261364622167124446454".split("").map((ch) => Number(ch) - 1);
draw.push(4);
assert(isDraw(draw), "constructed full-board draw");
assert(planOf("easy", draw, () => 0) === null, "Easy skips a draw");
assert(planOf("medium", draw, () => 0) === null, "Medium skips a draw");
assert(planOf("perfect", draw, () => 0) === null, "Perfect skips a draw");

same(completeMoveScores(emptyScores, []), emptyScores, "empty-board book scores");
assert(completeMoveScores([], []) === null, "empty array is not complete");
assert(completeMoveScores([-2, -1, 0, 1, 0, -1], []) === null, "short array is not complete");
assert(
  completeMoveScores([-2, -1, 0, 1, 0, -1, -2, 99], []) === null,
  "extra entries are not complete",
);
assert(
  completeMoveScores([-2, -1, 0, 1, 0, -1, INVALID], []) === null,
  "missing child is not complete",
);
assert(
  completeMoveScores(Array(7).fill(INVALID), []) === null,
  "seven sentinels are not complete",
);

const cached: CompleteColumnScores = [-1, 0, 1, 2, 1, 0, -1];
same(completeMoveScores(cached, []), cached, "complete cached columns");
assert(afterEngine("medium", [], 0, cached, seq([0.99, 0])) === 3, "chooser uses cached columns");
assert(afterEngine("perfect", [], 0, cached, seq([0.99])) === 3, "Perfect uses cached unique best");

const fullCol = [0, 0, 0, 0, 0, 0];
const fullColScores: CompleteColumnScores = [INVALID, -1, 0, 1, 0, -1, -2];
same(completeMoveScores(fullColScores, fullCol), fullColScores, "full-column sentinel stays complete");
assert(
  completeMoveScores([INVALID, INVALID, 0, 1, 0, -1, -2], fullCol) === null,
  "legal missing child next to a full column",
);

const emptyHeights = playMoves([]).height;
const timeoutLookalike = [1, 0, 10, 10, -2, -2, -2];
const timeoutPartial = [INVALID, 0, 10, 10, -2, -2, -2];
same(provenBestColumns(timeoutLookalike, emptyHeights, true), [], "timedOut complete array has no best highlight");
same(provenBestColumns(timeoutPartial, emptyHeights, false), [], "partial array has no best highlight");
same(provenBestColumns(timeoutPartial, emptyHeights, false, 3), [2, 3], "a proven best-move column certifies equal exact scores");
same(provenBestColumns(timeoutPartial, emptyHeights, true, 3), [], "an aborted best-move search cannot certify an optimum");
same(provenBestColumns(timeoutPartial, emptyHeights, false, 0), [], "unknown scores cannot become best through a fallback column");
same(provenBestColumns(timeoutPartial, emptyHeights, false, 255), [], "invalid engine column cannot certify an optimum");
const bookFrontier = [INVALID, INVALID, INVALID, INVALID, INVALID, 1, INVALID];
same(provenBestColumns(bookFrontier, emptyHeights, false, 5), [5], "short-circuited analysis highlights the proven move-book column");
same(provenBestColumns(emptyScores, emptyHeights, false), [3], "completed analysis highlights the best");
same(provenBestColumns(emptyScores, emptyHeights, true), [], "timedOut book-looking array has no best highlight");
same(provenBestColumns(null, emptyHeights, false), [], "missing analysis has no best highlight");
assert(statusText([], timeoutLookalike, false, true) === "Red to move", "timedOut complete array is not a proven win");
assert(statusText([], timeoutPartial, false, false) === "Red to move", "partial array is not a proven status");
assert(statusText([], emptyScores, false, false) === "Red to move · win", "completed analysis reports a proven win");
assert(statusText([], bookFrontier, false, false, 5) === "Red to move · win", "short-circuited analysis reports a proven win");
assert(statusText([], emptyScores, false, true) === "Red to move", "timedOut completed-looking scores stay unproven");
assert(statusText([], [-1, -1, -1, -1, -1, -1, -1], false, false) === "Red to move · loss", "proven loss");
assert(statusText([], [0, 0, 0, 0, 0, 0, 0], false, false) === "Red to move · draw", "proven draw");
assert(formatScore(INVALID) === "", "unfinished columns stay blank");
assert(analysisScoreClass(INVALID, false) === null, "unfinished columns are not scored as a loss");
assert(analysisScoreClass(INVALID, true) === null, "unfinished columns are not best");
assert(analysisScoreClass(10, true) === "best", "proven best column");
assert(analysisScoreClass(10, false) === "win", "partial exact win still displays");
assert(analysisScoreClass(-2, false) === "loss", "partial exact loss still displays");
assert(analysisScoreClass(0, false) === "draw", "partial exact draw still displays");
same(
  completeMoveScores(timeoutLookalike, []),
  timeoutLookalike,
  "Medium still treats a full score array as complete move scores",
);

console.log("medium checks ok");
