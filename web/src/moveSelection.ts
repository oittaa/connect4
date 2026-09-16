import type { WorkerRes } from "./engineProtocol.ts";
import { formatScore, INVALID, toMove } from "./game.ts";

export type Side = "Red" | "Yellow";

export type MoveFact = {
  origin: string;
  col: number;
  ply: number;
  side: Side;
  score?: number;
  nodes?: number;
  micros?: number;
  timedOut?: boolean;
};

const ORIGIN_LABEL: Record<string, string> = {
  human: "human",
  forced: "forced",
  random: "random",
  moveBook: "move book",
  scoreBook: "score book",
  tactical: "tactical",
  search: "engine",
};

function hashesPerSecond(nodes: number, micros: number): number {
  return micros > 0 ? Math.round((nodes / micros) * 1_000_000) : 0;
}

export function moverOf(moves: number[]): { ply: number; side: Side } {
  return {
    ply: moves.length + 1,
    side: toMove(moves) === 1 ? "Red" : "Yellow",
  };
}

export function moveFact(
  moves: number[],
  col: number,
  origin: string,
  extra: Omit<MoveFact, "origin" | "col" | "ply" | "side"> = {},
): MoveFact {
  return { origin, col, ...moverOf(moves), ...extra };
}

export function factFromSolverReply(
  moves: number[],
  col: number,
  reply: Pick<
    Extract<WorkerRes, { type: "moved" }>,
    "col" | "origin" | "score" | "nodes" | "micros" | "timedOut" | "moveScores"
  >,
): MoveFact {
  const book = reply.moveScores?.[col];
  const score =
    reply.origin === "moveBook"
      ? undefined
      : book !== undefined && book !== INVALID
        ? book
        : reply.col === col && reply.score !== null && reply.score !== INVALID
          ? reply.score
          : undefined;
  return moveFact(moves, col, reply.origin, {
    score,
    nodes: reply.nodes,
    micros: reply.micros,
    timedOut: reply.timedOut,
  });
}

export function formatMoveSelection(fact: MoveFact): string {
  const label = ORIGIN_LABEL[fact.origin] ?? fact.origin;
  const formatted =
    fact.origin === "moveBook" || fact.score === undefined ? "" : ` ${formatScore(fact.score)}`;
  const nps = hashesPerSecond(fact.nodes ?? 0, fact.micros ?? 0);
  const npsPart = nps > 0 ? ` · ${nps} hashes/s` : "";
  const timeout = fact.timedOut ? " timed out" : "";
  return `ply ${fact.ply} ${fact.side} ${label}${formatted}${npsPart}${timeout}, column ${fact.col + 1}`;
}

export function formatSearchReport(
  nodes: number,
  micros: number,
  timedOut: boolean,
  embeddedScoreBookOnly = false,
): string {
  const ms = micros / 1000;
  const nps = ms > 0 ? (nodes / ms) * 1000 : 0;
  if (nodes === 0 && !timedOut) return "instant (score book / tactical)";
  const src = embeddedScoreBookOnly ? "search (embedded score book only)" : "search";
  return timedOut
    ? `Timed out after ${ms.toFixed(0)} ms · ${nodes.toLocaleString()} nodes (result not proven)`
    : `${src}: ${nodes.toLocaleString()} nodes in ${ms < 10 ? ms.toFixed(1) : ms.toFixed(0)} ms` +
      (nps ? ` · ${(nps / 1000).toFixed(0)} kn/s` : "");
}

export function publishMoveSelection(
  enabled: boolean,
  fact: MoveFact,
  sinks: { status?: (line: string) => void; log?: (line: string) => void },
): string {
  const line = formatMoveSelection(fact);
  if (enabled) {
    sinks.status?.(line);
    sinks.log?.(line);
  }
  return line;
}
