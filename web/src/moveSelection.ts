import { toMove } from "./game.ts";

export type Side = "Red" | "Yellow";

export type MoveFact = {
  name: string;
  extra: string;
  col: number;
  ply: number;
  side: Side;
};

export function moverOf(moves: number[]): { ply: number; side: Side } {
  return {
    ply: moves.length + 1,
    side: toMove(moves) === 1 ? "Red" : "Yellow",
  };
}

export function moveFact(
  moves: number[],
  col: number,
  name: string,
  extra = "",
): MoveFact {
  return { name, extra, col, ...moverOf(moves) };
}

export function formatMoveSelection(fact: MoveFact): string {
  const tail = fact.extra ? `, ${fact.extra}` : "";
  return `ply ${fact.ply} ${fact.side} ${fact.name}, column ${fact.col + 1}${tail}`;
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
