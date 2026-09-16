// DEBUG-mode computer move selection logs. Run: npm test

import type { CompleteColumnScores } from "./engineProtocol.ts";
import { INVALID } from "./game.ts";
import {
  describeLocalMove,
  describeSolverMove,
  formatMoveSelection,
  hashesPerSecond,
  logMoveSelection,
  type SolverSelectionReply,
} from "./moveSelectionLog.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function same(got: unknown, expected: unknown, msg: string): void {
  assert(JSON.stringify(got) === JSON.stringify(expected), `${msg}: got ${JSON.stringify(got)}`);
}

const emptyBook: CompleteColumnScores = [-2, -1, 0, 1, 0, -1, -2];

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

same(describeLocalMove([], 3), { source: "random", col: 3 }, "empty board Easy is uniform/random");
same(
  describeLocalMove([0, 1, 0, 2, 0, 3], 0),
  { source: "forced", col: 0 },
  "mate-in-one is forced",
);
same(
  describeLocalMove([1, 0, 2, 0, 6, 0], 0),
  { source: "forced", col: 0 },
  "must-block is forced",
);

same(
  describeSolverMove(3, reply({ fromMoveBook: true, moveScores: emptyBook })),
  { source: "score book", col: 3, score: 1 },
  "complete score-book columns are a score-book pick even on a move-book hit",
);
same(
  describeSolverMove(4, reply({ fromMoveBook: true })),
  { source: "move book", col: 4 },
  "move-book hit without complete scores is a move-book pick",
);

same(
  describeSolverMove(3, reply({ moveScores: emptyBook })),
  { source: "score book", col: 3, score: 1 },
  "0-node complete columns are a score-book hit",
);
same(
  describeSolverMove(0, reply({ moveScores: emptyBook })),
  { source: "score book", col: 0, score: -2 },
  "score-book log uses the played column's score",
);

same(
  describeSolverMove(0, reply({ hintScores: [18, INVALID, INVALID, INVALID, INVALID, INVALID, INVALID] })),
  { source: "tactical", col: 0, score: 18 },
  "0-node reply without complete score-book columns is tactical",
);
same(
  describeSolverMove(2, reply()),
  { source: "tactical", col: 2 },
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
  ),
  { source: "engine", col: 3, score: 12, hashesPerSecond: 40_000_000, timedOut: false },
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
  ),
  { source: "engine", col: 1, score: 0, hashesPerSecond: 4_000_000, timedOut: true },
  "timed-out search is still the engine path",
);
same(
  describeSolverMove(4, reply({ nodes: 10, micros: 0, timedOut: true })),
  { source: "engine", col: 4, timedOut: true },
  "engine path without a measurable rate omits hashes/s",
);

same(formatMoveSelection({ source: "score book", col: 3, score: 1 }), "score book W1 (column 4)", "score book");
same(formatMoveSelection({ source: "move book", col: 3 }), "move book (column 4)", "move book");
same(
  formatMoveSelection({ source: "engine", col: 3, score: 12, hashesPerSecond: 40123 }),
  "engine W12 · 40123 hashes/s (column 4)",
  "engine",
);
same(
  formatMoveSelection({ source: "engine", col: 0, timedOut: true, hashesPerSecond: 9 }),
  "engine · 9 hashes/s timed out (column 1)",
  "engine timeout",
);
same(formatMoveSelection({ source: "tactical", col: 0, score: 18 }), "tactical W18 (column 1)", "tactical");
same(formatMoveSelection({ source: "forced", col: 0 }), "forced (column 1)", "forced");
same(formatMoveSelection({ source: "random", col: 6 }), "random (column 7)", "random");

{
  const logged: string[] = [];
  logMoveSelection(false, { source: "score book", col: 3, score: 1 }, (m) => logged.push(m));
  same(logged, [], "DEBUG off does not log");
  logMoveSelection(true, { source: "move book", col: 2 }, (m) => logged.push(m));
  same(logged, ["move book (column 3)"], "DEBUG on logs the formatted line");
}

console.log("move selection log checks ok");
