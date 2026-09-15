// Hints vs computer-turn scheduling. Run: npm test

import {
  analysisReplyApplies,
  isActiveComputerTurn,
  planHintAndComputer,
  shouldRequestAnalysis,
  shouldRequestAvailableScores,
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
    computerToMove: false,
    hasAnalysis: false,
    ...over,
  };
}

const computer = ctx({ computerToMove: true });
const pausedComputer = ctx({ computerToMove: true, paused: true });
const human = ctx();
const analyzingHuman = ctx({ hasAnalysis: true });

assert(shouldRequestAnalysis(human), "human turn requests analysis");
assert(shouldRequestAnalysis(pausedComputer), "paused computer requests analysis");
assert(!shouldRequestAnalysis(computer), "active computer does not request analysis");
assert(!shouldRequestAnalysis(ctx({ hintsOn: false })), "hints off skips analysis");
assert(!shouldRequestAnalysis(ctx({ engineReady: false })), "engine not ready skips analysis");
assert(!shouldRequestAnalysis(ctx({ gameOver: true })), "game over skips analysis");

assert(shouldRequestAvailableScores(computer), "active computer can read available scores");
assert(!shouldRequestAvailableScores(ctx({ computerToMove: true, hintsOn: false })), "computer skips scores with hints off");
assert(!shouldRequestAvailableScores(ctx({ computerToMove: true, engineReady: false })), "computer waits for the engine");
assert(!shouldRequestAvailableScores(ctx({ computerToMove: true, gameOver: true })), "computer skips scores at game over");
assert(!shouldRequestAvailableScores(human), "human hints use full analysis");
assert(!shouldRequestAvailableScores(pausedComputer), "paused hints use full analysis");
assert(isActiveComputerTurn(computer), "computer to move is an active computer");
assert(!isActiveComputerTurn(pausedComputer), "paused computer is not active");
assert(!isActiveComputerTurn(human), "human turn is not an active computer");

assert(shouldShowHintDisplay(true, false), "show available hints regardless of player role or pause");
assert(!shouldShowHintDisplay(false, false), "hints off hides the strip");
assert(!shouldShowHintDisplay(true, true), "game over hides the strip");

same(
  planHintAndComputer("position", computer),
  { invalidateAnalysis: true, requestAnalyze: false, scheduleComputer: true },
  "active computer after a move: no analyze, schedule immediately",
);
same(
  planHintAndComputer("position", ctx({ hintsOn: false, computerToMove: true })),
  { invalidateAnalysis: true, requestAnalyze: false, scheduleComputer: true },
  "hints off still schedules the computer immediately",
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
  "seat change to an active computer invalidates in-flight analysis",
);
same(
  planHintAndComputer("role", human),
  { invalidateAnalysis: false, requestAnalyze: true, scheduleComputer: true },
  "seat change onto a human turn starts analysis",
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

console.log("hint scheduling checks ok");
