import { fallbackColumn } from "./shared.ts";

export const easy = {
  label: "Easy",
  plan(moves: number[], random: () => number) {
    const col = fallbackColumn(moves, random);
    return col === null ? null : { type: "local" as const, col };
  },
};
