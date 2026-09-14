// Hints vs computer-turn scheduling. Run: npm test

import {
  analysisReplyApplies,
  forcedWinOrBlock,
  isActiveComputerTurn,
  planComputerTurn,
  planHintAndComputer,
  shouldRequestAnalysis,
  shouldShowHintDisplay,
  type HintSessionContext,
} from "./game.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function same(got: unknown, expected: unknown, msg: string): void {
  assert(JSON.stringify(got) === JSON.stringify(expected), `${msg}: got ${JSON.stringify(got)}`);
}

function ctx(over: Partial<HintSessionContext> = {}): HintSessionContext {
  return {
    hintsOn: true,
    engineReady: true,
    gameOver: false,
    paused: false,
    role: "human",
    hasAnalysis: false,
    ...over,
  };
}

const computer = ctx({ role: "perfect" });
const easy = ctx({ role: "easy" });
const medium = ctx({ role: "medium" });
const pausedComputer = ctx({ role: "perfect", paused: true });
const human = ctx();
const analyzingHuman = ctx({ hasAnalysis: true });

assert(shouldRequestAnalysis(human), "human turn requests analysis");
assert(shouldRequestAnalysis(pausedComputer), "paused computer requests analysis");
assert(!shouldRequestAnalysis(computer), "active Perfect does not request analysis");
assert(!shouldRequestAnalysis(easy), "active Easy does not request analysis");
assert(!shouldRequestAnalysis(medium), "active Medium does not request analysis");
assert(!shouldRequestAnalysis(ctx({ hintsOn: false, role: "human" })), "hints off skips analysis");
assert(!shouldRequestAnalysis(ctx({ engineReady: false })), "engine not ready skips analysis");
assert(!shouldRequestAnalysis(ctx({ gameOver: true })), "game over skips analysis");
assert(isActiveComputerTurn(computer), "Perfect to move is an active computer");
assert(!isActiveComputerTurn(pausedComputer), "paused computer is not active");
assert(!isActiveComputerTurn(human), "human turn is not an active computer");

assert(shouldShowHintDisplay(true, false, false, "human"), "show hints on a human turn");
assert(shouldShowHintDisplay(true, false, true, "perfect"), "show hints while paused");
assert(!shouldShowHintDisplay(true, false, false, "perfect"), "hide the score strip on an active computer");
assert(!shouldShowHintDisplay(true, false, false, "easy"), "hide the score strip on active Easy");
assert(!shouldShowHintDisplay(false, false, false, "human"), "hints off hides the strip");
assert(!shouldShowHintDisplay(true, true, true, "perfect"), "game over hides the strip");

same(
  planHintAndComputer("position", computer),
  { invalidateAnalysis: true, requestAnalyze: false, scheduleComputer: true },
  "active computer after a move: no analyze, schedule immediately",
);
same(
  planHintAndComputer("position", ctx({ hintsOn: false, role: "perfect" })),
  { invalidateAnalysis: true, requestAnalyze: false, scheduleComputer: true },
  "hints off still schedules the computer immediately",
);
same(
  planHintAndComputer("position", easy),
  { invalidateAnalysis: true, requestAnalyze: false, scheduleComputer: true },
  "active Easy after a move: no analyze",
);
same(
  planHintAndComputer("position", human),
  { invalidateAnalysis: true, requestAnalyze: true, scheduleComputer: true },
  "human turn still analyzes",
);
same(
  planHintAndComputer("position", pausedComputer),
  { invalidateAnalysis: true, requestAnalyze: true, scheduleComputer: true },
  "Back/pause position still analyzes",
);
same(
  planHintAndComputer("position", ctx({ role: "easy" })),
  { invalidateAnalysis: true, requestAnalyze: false, scheduleComputer: true },
  "both-computer: first seat does not analyze",
);
same(
  planHintAndComputer("position", ctx({ role: "medium" })),
  { invalidateAnalysis: true, requestAnalyze: false, scheduleComputer: true },
  "both-computer: second seat does not analyze",
);

same(
  planHintAndComputer("engineReady", computer),
  { invalidateAnalysis: false, requestAnalyze: false, scheduleComputer: true },
  "engine ready on an active computer does not analyze",
);
same(
  planHintAndComputer("engineReady", human),
  { invalidateAnalysis: false, requestAnalyze: true, scheduleComputer: true },
  "engine ready on a human turn still analyzes",
);

same(
  planHintAndComputer("hintsOn", computer),
  { invalidateAnalysis: false, requestAnalyze: false, scheduleComputer: false },
  "turning hints on during an active computer does not analyze or restart it",
);
same(
  planHintAndComputer("hintsOn", human),
  { invalidateAnalysis: false, requestAnalyze: true, scheduleComputer: false },
  "turning hints on during a human turn analyzes without scheduling",
);
same(
  planHintAndComputer("hintsOff", analyzingHuman),
  { invalidateAnalysis: true, requestAnalyze: false, scheduleComputer: false },
  "turning hints off does not restart a computer turn",
);

same(
  planHintAndComputer("role", { ...computer, hasAnalysis: true }),
  { invalidateAnalysis: true, requestAnalyze: false, scheduleComputer: true },
  "role change to an active computer invalidates in-flight analysis",
);
same(
  planHintAndComputer("role", human),
  { invalidateAnalysis: false, requestAnalyze: true, scheduleComputer: true },
  "role change onto a human turn starts analysis",
);
same(
  planHintAndComputer("role", analyzingHuman),
  { invalidateAnalysis: false, requestAnalyze: false, scheduleComputer: true },
  "changing the other seat while analyzing does not restart analysis",
);

same(
  planHintAndComputer("pause", pausedComputer),
  { invalidateAnalysis: false, requestAnalyze: true, scheduleComputer: false },
  "pause analyzes the current computer position",
);
same(
  planHintAndComputer("resume", computer),
  { invalidateAnalysis: true, requestAnalyze: false, scheduleComputer: true },
  "resume onto an active computer clears the paused analysis display",
);
same(
  planHintAndComputer("resume", ctx({ hasAnalysis: true })),
  { invalidateAnalysis: false, requestAnalyze: false, scheduleComputer: true },
  "resume onto a human turn keeps displayed analysis",
);

assert(analysisReplyApplies(4, 4, human), "matching human analysis reply applies");
assert(analysisReplyApplies(4, 4, pausedComputer), "matching paused analysis reply applies");
assert(!analysisReplyApplies(4, 5, human), "stale analysis reply is ignored");
assert(!analysisReplyApplies(4, 4, computer), "late reply during an active computer does not apply");
assert(
  !analysisReplyApplies(4, 4, ctx({ hintsOn: false })),
  "late reply after hints off does not apply",
);

const winSeq = [0, 1, 0, 2, 0, 3];
assert(forcedWinOrBlock(winSeq) === 0, "tactical Medium fixture");
same(planComputerTurn("easy", [], () => 0), { type: "local", col: 3 }, "Easy is local with hints on");
same(
  planComputerTurn("easy", winSeq, () => 0),
  { type: "local", col: 0 },
  "Easy mate is local with hints on",
);
same(
  planComputerTurn("medium", winSeq, () => 0),
  { type: "local", col: 0 },
  "tactical Medium issues no solver request",
);
same(planComputerTurn("perfect", [], () => 0), { type: "engine" }, "Perfect still uses the engine");
same(
  planComputerTurn("perfect", [3, 3, 3, 3, 3, 1, 1, 1], () => 0),
  { type: "engine" },
  "Perfect at 44444222 still asks the engine (compact book is inside bestMove)",
);

console.log("hint scheduling checks ok");
