// DEBUG-mode computer move selection logs. Run: npm test

import type { CompleteColumnScores } from "./engineProtocol.ts";
import { INVALID } from "./game.ts";
import {
  describeHumanMove,
  describeLocalMove,
  describeSolverMove,
  formatMoveSelection,
  hashesPerSecond,
  logMoveSelection,
  moverOf,
  type SolverSelectionReply,
} from "./moveSelectionLog.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function same(got: unknown, expected: unknown, msg: string): void {
  assert(JSON.stringify(got) === JSON.stringify(expected), `${msg}: got ${JSON.stringify(got)}`);
}

const emptyBook: CompleteColumnScores = [-2, -1, 0, 1, 0, -1, -2];
const redOpen = { ply: 1, side: "Red" as const };
const yellowPly2 = { ply: 2, side: "Yellow" as const };

function reply(over: Partial<SolverSelectionReply> = {}): SolverSelectionReply {
  return {
    fromMoveBook: false,
    nodes: 0,
    micros: 0,
    timedOut: false,
    moveScores: null,
    hintScores: [],
    ...over,
  };
}

same(hashesPerSecond(1_000, 1_000), 1_000_000, "1000 nodes in 1ms is 1e6 hashes/s");
same(hashesPerSecond(40_000, 1_000), 40_000_000, "40k nodes in 1ms");
same(hashesPerSecond(100, 0), 0, "zero duration has no rate");

same(moverOf([]), redOpen, "empty board is Red ply 1");
same(moverOf([3]), yellowPly2, "one disc is Yellow ply 2");
same(moverOf([0, 1, 0, 2, 0, 3]), { ply: 7, side: "Red" }, "six discs is Red ply 7");

same(describeLocalMove([], 3), { source: "random", col: 3, ...redOpen }, "empty board Easy is uniform/random");
same(
  describeLocalMove([0, 1, 0, 2, 0, 3], 0),
  { source: "forced", col: 0, ply: 7, side: "Red" },
  "mate-in-one is forced",
);
same(
  describeLocalMove([1, 0, 2, 0, 6, 0], 0),
  { source: "forced", col: 0, ply: 7, side: "Red" },
  "must-block is forced",
);
same(describeHumanMove([], 3), { source: "human", col: 3, ...redOpen }, "human opening");
same(describeHumanMove([3], 2), { source: "human", col: 2, ...yellowPly2 }, "human Yellow reply");

same(
  describeSolverMove(3, reply({ fromMoveBook: true, moveScores: emptyBook }), []),
  { source: "score book", col: 3, score: 1, ...redOpen },
  "complete score-book columns are a score-book pick even on a move-book hit",
);
same(
  describeSolverMove(4, reply({ fromMoveBook: true }), [3, 3, 3, 3, 4, 2, 2, 2, 3, 4]),
  { source: "move book", col: 4, ply: 11, side: "Red" },
  "move-book hit without complete scores is a move-book pick",
);

same(
  describeSolverMove(3, reply({ moveScores: emptyBook }), []),
  { source: "score book", col: 3, score: 1, ...redOpen },
  "0-node complete columns are a score-book hit",
);
same(
  describeSolverMove(0, reply({ moveScores: emptyBook }), []),
  { source: "score book", col: 0, score: -2, ...redOpen },
  "score-book log uses the played column's score",
);

same(
  describeSolverMove(0, reply({ hintScores: [18, INVALID, INVALID, INVALID, INVALID, INVALID, INVALID] }), [
    0, 1, 0, 2, 0, 3,
  ]),
  { source: "tactical", col: 0, score: 18, ply: 7, side: "Red" },
  "0-node reply without complete score-book columns is tactical",
);
same(
  describeSolverMove(2, reply(), [3]),
  { source: "tactical", col: 2, ...yellowPly2 },
  "tactical without a known score still names the path",
);

same(
  describeSolverMove(
    3,
    reply({
      nodes: 40_000,
      micros: 1_000,
      hintScores: [INVALID, INVALID, INVALID, 12, INVALID, INVALID, INVALID],
    }),
    [3, 3, 3, 3],
  ),
  { source: "engine", col: 3, score: 12, hashesPerSecond: 40_000_000, timedOut: false, ply: 5, side: "Red" },
  "search logs engine score and hashes/s",
);
same(
  describeSolverMove(
    1,
    reply({
      nodes: 8_000,
      micros: 2_000,
      timedOut: true,
      hintScores: [INVALID, 0],
    }),
    [3],
  ),
  { source: "engine", col: 1, score: 0, hashesPerSecond: 4_000_000, timedOut: true, ...yellowPly2 },
  "timed-out search is still the engine path",
);
same(
  describeSolverMove(4, reply({ nodes: 10, micros: 0, timedOut: true }), [3, 3, 3, 3]),
  { source: "engine", col: 4, timedOut: true, ply: 5, side: "Red" },
  "engine path without a measurable rate omits hashes/s",
);

same(
  formatMoveSelection({ source: "score book", col: 3, score: 1, ...redOpen }),
  "score book W1 (ply 1, Red, column 4)",
  "score book",
);
same(
  formatMoveSelection({ source: "move book", col: 3, ply: 11, side: "Red" }),
  "move book (ply 11, Red, column 4)",
  "move book",
);
same(
  formatMoveSelection({ source: "engine", col: 3, score: 12, hashesPerSecond: 40123, ply: 5, side: "Red" }),
  "engine W12 · 40123 hashes/s (ply 5, Red, column 4)",
  "engine",
);
same(
  formatMoveSelection({ source: "engine", col: 0, timedOut: true, hashesPerSecond: 9, ...yellowPly2 }),
  "engine · 9 hashes/s timed out (ply 2, Yellow, column 1)",
  "engine timeout",
);
same(
  formatMoveSelection({ source: "tactical", col: 0, score: 18, ply: 7, side: "Red" }),
  "tactical W18 (ply 7, Red, column 1)",
  "tactical",
);
same(formatMoveSelection({ source: "forced", col: 0, ply: 7, side: "Red" }), "forced (ply 7, Red, column 1)", "forced");
same(formatMoveSelection({ source: "random", col: 6, ...redOpen }), "random (ply 1, Red, column 7)", "random");
same(formatMoveSelection({ source: "human", col: 3, ...redOpen }), "human (ply 1, Red, column 4)", "human Red");
same(
  formatMoveSelection({ source: "human", col: 2, ...yellowPly2 }),
  "human (ply 2, Yellow, column 3)",
  "human Yellow",
);

{
  const logged: string[] = [];
  logMoveSelection(false, { source: "score book", col: 3, score: 1, ...redOpen }, (m) => logged.push(m));
  same(logged, [], "DEBUG off does not log");
  logMoveSelection(true, { source: "move book", col: 2, ply: 11, side: "Red" }, (m) => logged.push(m));
  same(logged, ["move book (ply 11, Red, column 3)"], "DEBUG on logs the formatted line");
  logMoveSelection(true, { source: "human", col: 3, ...redOpen }, (m) => logged.push(m));
  same(logged, ["move book (ply 11, Red, column 3)", "human (ply 1, Red, column 4)"], "DEBUG on logs human drops");
}

console.log("move selection log checks ok");
