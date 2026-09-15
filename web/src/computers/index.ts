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
 * Turn a solver reply into a column. `null` from `choose` means no move.
 * Out-of-range results fall back to a legal tactical/uniform column. Does not
 * treat a solver failure as a move.
 */
export function resolveSolverColumn(
  choose: (reply: SolverMove) => number | null,
  reply: SolverMove,
  moves: number[],
  random: () => number = Math.random,
): number | null {
  const col = choose(reply);
  if (col === null) return null;
  if (legalEngineColumn(col)) return col;
  const fallback = fallbackColumn(moves, random);
  return fallback !== null && legalEngineColumn(fallback) ? fallback : null;
}
