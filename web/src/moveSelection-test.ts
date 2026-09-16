// DEBUG move-selection facts and formatter. Run: npm test

import { INVALID } from "./game.ts";
import {
  factFromSolverReply,
  formatMoveSelection,
  formatSearchReport,
  hashesPerSecond,
  moveFact,
  moverOf,
  publishMoveSelection,
} from "./moveSelection.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function same(got: unknown, expected: unknown, msg: string): void {
  assert(JSON.stringify(got) === JSON.stringify(expected), `${msg}: got ${JSON.stringify(got)}`);
}

const redOpen = { ply: 1, side: "Red" as const };
const yellowPly2 = { ply: 2, side: "Yellow" as const };

same(hashesPerSecond(1_000, 1_000), 1_000_000, "1000 nodes in 1ms is 1e6 hashes/s");
same(hashesPerSecond(40_000, 1_000), 40_000_000, "40k nodes in 1ms");
same(hashesPerSecond(100, 0), 0, "zero duration has no rate");

same(moverOf([]), redOpen, "empty board is Red ply 1");
same(moverOf([3]), yellowPly2, "one disc is Yellow ply 2");
same(moverOf([0, 1, 0, 2, 0, 3]), { ply: 7, side: "Red" }, "six discs is Red ply 7");

same(moveFact([], 3, "human"), { origin: "human", col: 3, ...redOpen }, "human opening fact");
same(moveFact([3], 2, "human"), { origin: "human", col: 2, ...yellowPly2 }, "human Yellow fact");
same(moveFact([], 0, "forced"), { origin: "forced", col: 0, ...redOpen }, "forced fact");
same(moveFact([], 6, "random"), { origin: "random", col: 6, ...redOpen }, "random fact");

same(
  factFromSolverReply([], 3, {
    origin: "scoreBook",
    score: 1,
    nodes: 0,
    micros: 0,
    timedOut: false,
  }),
  { origin: "scoreBook", col: 3, ply: 1, side: "Red", score: 1, nodes: 0, micros: 0, timedOut: false },
  "solver score-book fact",
);
same(
  factFromSolverReply([3, 3, 3, 3, 4, 2, 2, 2, 3, 4], 4, {
    origin: "moveBook",
    score: null,
    nodes: 0,
    micros: 0,
    timedOut: false,
  }),
  {
    origin: "moveBook",
    col: 4,
    ply: 11,
    side: "Red",
    nodes: 0,
    micros: 0,
    timedOut: false,
  },
  "solver move-book fact does not invent a score",
);
same(
  factFromSolverReply([3, 3, 3, 3], 3, {
    origin: "search",
    score: 12,
    nodes: 40_000,
    micros: 1_000,
    timedOut: false,
  }),
  {
    origin: "search",
    col: 3,
    ply: 5,
    side: "Red",
    score: 12,
    nodes: 40_000,
    micros: 1_000,
    timedOut: false,
  },
  "solver search fact",
);

same(
  formatMoveSelection({ origin: "scoreBook", col: 3, score: 1, ...redOpen }),
  "score book W1 (ply 1, Red, column 4)",
  "score book",
);
same(
  formatMoveSelection({ origin: "moveBook", col: 3, ply: 11, side: "Red" }),
  "move book (ply 11, Red, column 4)",
  "move book",
);
same(
  formatMoveSelection({
    origin: "search",
    col: 3,
    score: 12,
    nodes: 40_000,
    micros: 1_000,
    ply: 5,
    side: "Red",
  }),
  "engine W12 · 40000000 hashes/s (ply 5, Red, column 4)",
  "engine",
);
same(
  formatMoveSelection({
    origin: "search",
    col: 0,
    timedOut: true,
    nodes: 9,
    micros: 1_000,
    ...yellowPly2,
  }),
  "engine · 9000 hashes/s timed out (ply 2, Yellow, column 1)",
  "engine timeout",
);
same(
  formatMoveSelection({ origin: "tactical", col: 0, score: 18, ply: 7, side: "Red" }),
  "tactical W18 (ply 7, Red, column 1)",
  "tactical",
);
same(
  formatMoveSelection({ origin: "forced", col: 0, ply: 7, side: "Red" }),
  "forced (ply 7, Red, column 1)",
  "forced",
);
same(formatMoveSelection({ origin: "random", col: 6, ...redOpen }), "random (ply 1, Red, column 7)", "random");
same(formatMoveSelection({ origin: "human", col: 3, ...redOpen }), "human (ply 1, Red, column 4)", "human Red");
same(
  formatMoveSelection({ origin: "openingBook", col: 3, score: 1, ...redOpen }),
  "openingBook W1 (ply 1, Red, column 4)",
  "unknown origin is not remapped",
);

same(
  formatSearchReport(0, 0, false),
  "instant (score book / tactical)",
  "analyze 0-node",
);
assert(formatSearchReport(1000, 1000, false).includes("search:"), "analyze search prefix");
assert(formatSearchReport(1000, 1000, false, true).includes("embedded score book only"), "embedded note");
assert(formatSearchReport(8, 12_000_000, true).includes("Timed out"), "analyze timeout");

{
  const status: string[] = [];
  const log: string[] = [];
  publishMoveSelection(false, moveFact([], 3, "human"), {
    status: (l) => status.push(l),
    log: (l) => log.push(l),
  });
  same(status, [], "DEBUG off does not paint");
  same(log, [], "DEBUG off does not log");
  publishMoveSelection(true, moveFact([], 3, "scoreBook", { score: 1 }), {
    status: (l) => status.push(l),
    log: (l) => log.push(l),
  });
  same(status, ["score book W1 (ply 1, Red, column 4)"], "DEBUG on paints the footer");
  same(log, ["score book W1 (ply 1, Red, column 4)"], "DEBUG on console.logs the same line");
}

assert(INVALID === -1000, "INVALID still used by engines");

console.log("move selection checks ok");
