import { easy } from "./easy.ts";
import { medium } from "./medium.ts";
import { perfect } from "./perfect.ts";
import {
  fallbackColumn,
  isTerminal,
  legalEngineColumn,
  type ComputerPlan,
  type ComputerPolicy,
  type SolverMove,
} from "./shared.ts";

export type { ComputerPlan, ComputerPolicy, SolverMove };
export { mediumMove, pickMedium } from "./medium.ts";

export const computers = {
  easy,
  medium,
  perfect,
} as const satisfies Record<string, ComputerPolicy>;

export type ComputerId = keyof typeof computers;

export type Seat = { kind: "human" } | { kind: "computer"; computerId: ComputerId };

export function seatFromFormValue(value: string): Seat | null {
  if (value === "human") return { kind: "human" };
  if (Object.hasOwn(computers, value)) return { kind: "computer", computerId: value as ComputerId };
  return null;
}

/** Terminal positions have no move to execute; otherwise use the policy's plan. */
export function planComputer(
  policy: ComputerPolicy,
  moves: number[],
  random: () => number = Math.random,
): ComputerPlan | null {
  if (isTerminal(moves)) return null;
  return policy.plan(moves, random);
}

/**
 * Turn a solver reply into a column. Out-of-range results fall back to a
 * legal tactical/uniform column. Does not treat a solver failure as a move.
 */
export function resolveSolverColumn(
  choose: (reply: SolverMove) => number | null,
  reply: SolverMove,
  moves: number[],
  random: () => number = Math.random,
): number | null {
  let col = choose(reply);
  if (col === null || !legalEngineColumn(col)) col = fallbackColumn(moves, random) ?? col;
  return col !== null && legalEngineColumn(col) ? col : null;
}

/** Generic executor for local plans or a solver reply. Independent of computer ids. */
export function executeComputer(
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
