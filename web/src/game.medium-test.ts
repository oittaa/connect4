// Deterministic Medium checks. Run: npm test

import { INVALID, forcedWinOrBlock, mediumMove, pickMedium } from "./game.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function seq(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)] ?? 0;
}

const emptyScores = [-2, -1, 0, 1, 0, -1, -2];
assert(mediumMove(emptyScores, seq([0.99, 0])) === 3, "keep unique best");
assert(mediumMove(emptyScores, seq([0, 0])) === 2, "second-best first tie (column 3)");
assert(mediumMove(emptyScores, seq([0, 0.99])) === 4, "second-best last tie (column 5)");
assert(mediumMove([], () => 0) === null, "no scores");

const tiedBest = [0, 1, 1, 0, -1, -2, -2];
assert(mediumMove(tiedBest, seq([0.99, 0])) === 1, "best-tier first tie");
assert(mediumMove(tiedBest, seq([0.99, 0.99])) === 2, "best-tier last tie");

const winSeq = [0, 1, 0, 2, 0, 3];
assert(forcedWinOrBlock(winSeq) === 0, "forced win");
assert(pickMedium(winSeq, 6, [], () => 0) === 0, "take the mate");

const blockSeq = [1, 0, 2, 0, 6, 0];
assert(forcedWinOrBlock(blockSeq) === 0, "forced block");
assert(forcedWinOrBlock([]) === null, "empty board is not forced");

assert(pickMedium([], 3, emptyScores, seq([0.99, 0])) === 3, "score-book best");
assert(pickMedium([], 3, emptyScores, seq([0, 0])) === 2, "score-book second first tie");
assert(pickMedium([], 3, emptyScores, seq([0, 0.99])) === 4, "score-book second last tie");

const leak = pickMedium([0, 1], 3, [], () => 0.5);
assert(leak === 3, `keep engine column, got ${leak}`);
const leaked = pickMedium([0, 1], 3, [], () => 0.9);
assert(leaked !== null && leaked !== 3, `leak away from engine, got ${leaked}`);
assert(
  pickMedium([0, 1], 3, [INVALID, INVALID, INVALID, 1, INVALID, INVALID, INVALID], () => 0) === 3,
  "one scored column",
);

// Playing column 3 fills the support for Yellow's row-1 three-in-a-row.
const hangSeq = [0, 0, 6, 1, 2, 1, 6, 2];
assert(forcedWinOrBlock(hangSeq) === null, "hang is not an immediate threat");
assert(pickMedium(hangSeq, 3, [], () => 0.5) !== 3, "fallback avoids hanging a win");

console.log("medium checks ok");
