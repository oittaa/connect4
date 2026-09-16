// Registry, seats, and generic computer execution. Run: npm test

import {
  computers,
  planComputer,
  resolveSolverColumn,
  seatFromFormValue,
  type ComputerPolicy,
  type SolverMove,
} from "./computers/index.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function same(got: unknown, expected: unknown, msg: string): void {
  assert(JSON.stringify(got) === JSON.stringify(expected), `${msg}: got ${JSON.stringify(got)}`);
}

function play(
  policy: ComputerPolicy,
  moves: number[],
  random: () => number,
  reply?: SolverMove,
): number | null {
  const plan = planComputer(policy, moves, random);
  if (plan === null) return null;
  if (plan.type === "local") return plan.col;
  if (!reply) return null;
  return resolveSolverColumn(plan.choose, reply, moves, random);
}

same(Object.keys(computers), ["easy", "medium", "perfect"], "registry order");
assert(computers.easy.label === "Easy", "Easy label");
assert(computers.medium.label === "Medium", "Medium label");
assert(computers.perfect.label === "Perfect", "Perfect label");

same(seatFromFormValue("human"), { kind: "human" }, "human form value");
same(seatFromFormValue("easy"), { kind: "computer", computerId: "easy" }, "Easy form value");
same(seatFromFormValue("medium"), { kind: "computer", computerId: "medium" }, "Medium form value");
same(seatFromFormValue("perfect"), { kind: "computer", computerId: "perfect" }, "Perfect form value");
assert(seatFromFormValue("Human") === null, "unknown casing is not Human");
assert(seatFromFormValue("nope") === null, "unknown id is not Human");
assert(seatFromFormValue("") === null, "empty value is not Human");

const alwaysCenter: ComputerPolicy = {
  label: "Test",
  plan() {
    return { type: "local", col: 3, origin: "random" };
  },
};
assert(play(alwaysCenter, [], () => 0) === 3, "unknown policy can play a local column");
assert(play(alwaysCenter, [0, 1, 0, 2, 0, 3, 0], () => 0) === null, "terminal position has no move");

const fromReply: ComputerPolicy = {
  label: "Test",
  plan() {
    return {
      type: "solver",
      choose: (reply: SolverMove) => reply.col,
    };
  },
};
assert(
  play(fromReply, [], () => 0, { col: 1, moveScores: null }) === 1,
  "solver test policy uses the reply column",
);
assert(
  play(fromReply, [], () => 0, { col: 255, moveScores: null }) === 0,
  "invalid solver column uses the shared fallback",
);
assert(play(fromReply, [], () => 0) === null, "solver policy without a reply does not invent a move");

assert(
  resolveSolverColumn(() => null, { col: 3, moveScores: null }, [], () => 0) === null,
  "choose: () => null must not become column 3",
);

console.log("computer registry checks ok");
