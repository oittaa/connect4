// Deterministic Medium and computer-turn policy checks. Run: npm test

import {
  INVALID,
  chooseAfterEngine,
  forcedWinOrBlock,
  isDraw,
  lastMoveWin,
  mediumMove,
  pickMedium,
  planComputerTurn,
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

const winSeqPlayed = [...winSeq, 0];
assert(lastMoveWin(winSeqPlayed) !== null, "mate is terminal");
assert(planComputerTurn("easy", winSeqPlayed, () => 0) === null, "Easy skips a finished game");
assert(planComputerTurn("medium", winSeqPlayed, () => 0) === null, "Medium skips a finished game");
assert(planComputerTurn("perfect", winSeqPlayed, () => 0) === null, "Perfect skips a finished game");

same(planComputerTurn("easy", [], seq([0])), { type: "local", col: 3 }, "Easy is always local");
same(planComputerTurn("easy", winSeq, () => 0), { type: "local", col: 0 }, "Easy forced mate is local");
same(planComputerTurn("easy", blockSeq, () => 0), { type: "local", col: 0 }, "Easy forced block is local");
same(planComputerTurn("medium", winSeq, () => 0), { type: "local", col: 0 }, "Medium mate is local");
same(planComputerTurn("medium", blockSeq, () => 0), { type: "local", col: 0 }, "Medium block is local");
same(planComputerTurn("medium", [], () => 0), { type: "engine" }, "Medium otherwise asks the engine");
same(planComputerTurn("medium", hangSeq, () => 0), { type: "engine" }, "Medium hang is not tactical");
same(planComputerTurn("perfect", [], () => 0), { type: "engine" }, "Perfect asks the engine");
same(planComputerTurn("perfect", winSeq, () => 0), { type: "engine" }, "Perfect does not take a local mate");

assert(chooseAfterEngine("perfect", [], 3, emptyScores, () => 0) === 3, "Perfect keeps the engine column");
assert(chooseAfterEngine("perfect", [], 2, emptyScores, seq([0.99, 0])) === 2, "Perfect does not use Medium ranks");
assert(chooseAfterEngine("medium", [], 2, emptyScores, seq([0.99, 0])) === 3, "Medium can ignore the engine column");
assert(chooseAfterEngine("perfect", [], 3, [], () => 0) === 3, "Perfect ignores missing scores");
assert(chooseAfterEngine("perfect", [], 255, [], seq([0])) === 3, "invalid Perfect column falls back to Easy");
assert(
  chooseAfterEngine("medium", [], 3, emptyScores, seq([0.99, 0])) === 3,
  "Medium score-book best after engine",
);
assert(
  chooseAfterEngine("medium", [], 3, emptyScores, seq([0, 0])) === 2,
  "Medium second-best first tie after engine",
);
assert(
  chooseAfterEngine("medium", hangSeq, 3, [], () => 0.5) !== 3,
  "Medium fallback still avoids hanging a win",
);
assert(chooseAfterEngine("medium", winSeq, 6, [], () => 0) === 0, "chooser still takes the mate");

// Full board from testdata/end_easy (41 ply, one safe drop left).
const draw = "71255763773133525731261364622167124446454".split("").map((ch) => Number(ch) - 1);
draw.push(4);
assert(isDraw(draw), "constructed full-board draw");
assert(planComputerTurn("easy", draw, () => 0) === null, "Easy skips a draw");
assert(planComputerTurn("medium", draw, () => 0) === null, "Medium skips a draw");
assert(planComputerTurn("perfect", draw, () => 0) === null, "Perfect skips a draw");

console.log("medium checks ok");
