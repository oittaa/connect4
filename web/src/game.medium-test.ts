// Deterministic Medium checks. Run:
// npx esbuild src/game.medium-test.ts --bundle --format=esm --platform=node --outfile=/tmp/game.medium-test.mjs && node /tmp/game.medium-test.mjs

import { INVALID, mediumMove, pickMedium } from "./game";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const emptyScores = [-2, -1, 0, 1, 0, -1, -2];
assert(mediumMove(emptyScores, () => 0.99) === 3, "keep unique best");
assert(mediumMove(emptyScores, () => 0) === 2, "second-best among ties after sort");
assert(mediumMove([], () => 0) === null, "no scores");

const winSeq = [0, 1, 0, 2, 0, 3];
assert(pickMedium(winSeq, 6, [], () => 0) === 0, "take the mate");

assert(pickMedium([], 3, emptyScores, () => 0.99) === 3, "score-book best");
assert(pickMedium([], 3, emptyScores, () => 0) === 2, "score-book second");

const leak = pickMedium([0, 1], 3, [], () => 0.5);
assert(leak === 3, `keep engine column, got ${leak}`);
const leaked = pickMedium([0, 1], 3, [], () => 0.9);
assert(leaked !== null && leaked !== 3, `leak away from engine, got ${leaked}`);
assert(pickMedium([0, 1], 3, [INVALID, INVALID, INVALID, 1, INVALID, INVALID, INVALID], () => 0) === 3, "one scored column");

console.log("medium checks ok");
