import { localMove } from "./shared.ts";

export const easy = {
  label: "Easy",
  plan(moves: number[], random: () => number) {
    const local = localMove(moves, random);
    return local === null ? null : { type: "local" as const, ...local };
  },
};
