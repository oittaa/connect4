export const WIDTH = 7;
export const HEIGHT = 6;
export const AREA = WIDTH * HEIGHT;
export const INVALID = -1000;

export type Role = "human" | "easy" | "medium" | "perfect";
export type ComputerRole = Exclude<Role, "human">;
export type Player = 1 | 2;

/** Local column, engine request, or `null` when the position is already over. */
export type ComputerTurnPlan = { type: "local"; col: number } | { type: "engine" };

export interface Grid {
  cells: number[][]; // [row][col], row 0 = bottom, 0 empty, 1 red, 2 yellow
  height: number[];
}

export function emptyGrid(): Grid {
  return {
    cells: Array.from({ length: HEIGHT }, () => Array(WIDTH).fill(0)),
    height: Array(WIDTH).fill(0),
  };
}

export function playMoves(moves: number[]): Grid {
  const g = emptyGrid();
  let p: Player = 1;
  for (const col of moves) {
    drop(g, col, p);
    p = (3 - p) as Player;
  }
  return g;
}

export function drop(g: Grid, col: number, player: Player): number {
  const row = g.height[col];
  if (row >= HEIGHT) return -1;
  g.cells[row][col] = player;
  g.height[col] = row + 1;
  return row;
}

export function legalCols(g: Grid): number[] {
  const out: number[] = [];
  for (let c = 0; c < WIDTH; c++) if (g.height[c] < HEIGHT) out.push(c);
  return out;
}

function countDir(g: Grid, row: number, col: number, dr: number, dc: number, p: number): number {
  let n = 0;
  let r = row + dr;
  let c = col + dc;
  while (r >= 0 && r < HEIGHT && c >= 0 && c < WIDTH && g.cells[r][c] === p) {
    n++;
    r += dr;
    c += dc;
  }
  return n;
}

export function winningCells(g: Grid, row: number, col: number): [number, number][] | null {
  const p = g.cells[row][col];
  if (!p) return null;
  const dirs: [number, number][] = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ];
  for (const [dr, dc] of dirs) {
    const a = countDir(g, row, col, dr, dc, p);
    const b = countDir(g, row, col, -dr, -dc, p);
    if (a + b >= 3) {
      const cells: [number, number][] = [[row, col]];
      for (const sign of [1, -1]) {
        let r = row + sign * dr;
        let c = col + sign * dc;
        while (r >= 0 && r < HEIGHT && c >= 0 && c < WIDTH && g.cells[r][c] === p) {
          cells.push([r, c]);
          r += sign * dr;
          c += sign * dc;
        }
      }
      return cells;
    }
  }
  return null;
}

export function lastMoveWin(moves: number[]): [number, number][] | null {
  if (moves.length === 0) return null;
  const g = playMoves(moves);
  const col = moves[moves.length - 1];
  const row = g.height[col] - 1;
  return winningCells(g, row, col);
}

export function isDraw(moves: number[]): boolean {
  return moves.length >= AREA && !lastMoveWin(moves);
}

export function toMove(moves: number[]): Player {
  return (moves.length % 2 === 0 ? 1 : 2) as Player;
}

/** Would `player` win by dropping in `col`? */
export function isWinningDrop(g: Grid, col: number, player: Player): boolean {
  const row = g.height[col];
  if (row >= HEIGHT) return false;
  g.cells[row][col] = player;
  const win = winningCells(g, row, col);
  g.cells[row][col] = 0;
  return win !== null;
}

/** Immediate win, or a mandatory block. Null if neither. */
export function forcedWinOrBlock(moves: number[]): number | null {
  const g = playMoves(moves);
  const p = toMove(moves);
  const opp = (3 - p) as Player;
  const legal = legalCols(g);
  if (legal.length === 0) return null;
  for (const c of legal) if (isWinningDrop(g, c, p)) return c;
  for (const c of legal) if (isWinningDrop(g, c, opp)) return c;
  return null;
}

export function easyMove(moves: number[], random: () => number = Math.random): number | null {
  const forced = forcedWinOrBlock(moves);
  if (forced !== null) return forced;
  const legal = legalCols(playMoves(moves));
  if (legal.length === 0) return null;
  // Prefer center-ish random.
  const order = [3, 4, 2, 5, 1, 6, 0].filter((c) => legal.includes(c));
  return order[Math.floor(random() * order.length)] ?? legal[0];
}

/** Probability Medium keeps the engine/book column when scores are unavailable. */
export const MEDIUM_KEEP_BEST = 0.82;
const MEDIUM_SECOND_BEST = 0.28;

/** True if playing `col` leaves the opponent an immediate winning drop. */
export function givesOpponentImmediateWin(g: Grid, col: number, player: Player): boolean {
  const opp = (3 - player) as Player;
  const row = g.height[col];
  if (row >= HEIGHT) return true;
  g.cells[row][col] = player;
  g.height[col] = row + 1;
  let hang = false;
  if (!winningCells(g, row, col)) {
    hang = legalCols(g).some((c) => isWinningDrop(g, c, opp));
  }
  g.cells[row][col] = 0;
  g.height[col] = row;
  return hang;
}

export function mediumMove(scores: number[], random: () => number = Math.random): number | null {
  const valid: { s: number; c: number }[] = [];
  for (let c = 0; c < scores.length; c++) {
    if (scores[c] !== INVALID) valid.push({ s: scores[c], c });
  }
  if (valid.length === 0) return null;
  const distinct = [...new Set(valid.map((x) => x.s))].sort((a, b) => b - a);
  const target = distinct.length > 1 && random() < MEDIUM_SECOND_BEST ? distinct[1] : distinct[0];
  const pool = valid.filter((x) => x.s === target).map((x) => x.c);
  return pool[Math.floor(random() * pool.length)] ?? pool[0];
}

/**
 * Medium: take wins/blocks, then rank from complete score-book columns, else
 * keep the engine column most of the time or leak to a non-losing legal drop.
 */
export function pickMedium(
  moves: number[],
  engineCol: number,
  scores: number[],
  random: () => number = Math.random,
): number | null {
  const forced = forcedWinOrBlock(moves);
  if (forced !== null) return forced;

  const ranked = mediumMove(scores, random);
  if (ranked !== null) return ranked;

  const g = playMoves(moves);
  const p = toMove(moves);
  const legal = legalCols(g);
  if (legal.length === 0) return null;
  const safe = legal.filter((c) => !givesOpponentImmediateWin(g, c, p));
  const pool = safe.length > 0 ? safe : legal;
  if (pool.length === 1) return pool[0];
  if (pool.includes(engineCol) && random() < MEDIUM_KEEP_BEST) return engineCol;
  const rest = pool.filter((c) => c !== engineCol);
  const pickFrom = rest.length > 0 ? rest : pool;
  return pickFrom[Math.floor(random() * pickFrom.length)] ?? engineCol;
}

function isTerminal(moves: number[]): boolean {
  return lastMoveWin(moves) !== null || isDraw(moves);
}

function legalEngineColumn(col: number): boolean {
  return col >= 0 && col < WIDTH;
}

/**
 * Decide how a computer seat should move. Easy is always local; Medium takes an
 * immediate win or block locally and otherwise asks the engine; Perfect always
 * asks the engine. The caller owns delay, pause, and request invalidation.
 */
export function planComputerTurn(
  role: ComputerRole,
  moves: number[],
  random: () => number = Math.random,
): ComputerTurnPlan | null {
  if (isTerminal(moves)) return null;
  if (role === "easy") {
    const col = easyMove(moves, random);
    return col === null ? null : { type: "local", col };
  }
  if (role === "medium") {
    const forced = forcedWinOrBlock(moves);
    if (forced !== null) return { type: "local", col: forced };
  }
  return { type: "engine" };
}

/**
 * Turn an engine reply into the column to play. Medium keeps its score-based
 * and fallback selection; Perfect keeps the engine column. An out-of-range
 * column falls back to Easy.
 */
export function chooseAfterEngine(
  role: ComputerRole,
  moves: number[],
  engineCol: number,
  scores: number[],
  random: () => number = Math.random,
): number | null {
  let col = engineCol;
  if (role === "medium") col = pickMedium(moves, engineCol, scores, random) ?? engineCol;
  if (!legalEngineColumn(col)) col = easyMove(moves, random) ?? col;
  return legalEngineColumn(col) ? col : null;
}

export function analysisComplete(scores: number[], heights: number[]): boolean {
  if (scores.length < WIDTH) return false;
  for (let c = 0; c < WIDTH; c++) {
    if (heights[c] < HEIGHT && scores[c] === INVALID) return false;
  }
  return true;
}

export function bestCols(scores: number[]): number[] {
  let best = -Infinity;
  for (const s of scores) if (s !== INVALID && s > best) best = s;
  if (best === -Infinity) return [];
  return scores.map((s, i) => (s === best ? i : -1)).filter((i) => i >= 0);
}

export function formatScore(s: number): string {
  if (s === INVALID) return "";
  if (s === 0) return "D";
  return s > 0 ? `W${s}` : `L${-s}`;
}

export function statusText(moves: number[], scores: number[] | null, thinking: boolean): string {
  const win = lastMoveWin(moves);
  if (win) {
    const winner = toMove(moves.slice(0, -1)) === 1 ? "Red" : "Yellow";
    return `${winner} wins`;
  }
  if (isDraw(moves)) return "Draw";
  const side = toMove(moves) === 1 ? "Red" : "Yellow";
  if (thinking) return `${side} thinking…`;
  if (scores && analysisComplete(scores, playMoves(moves).height)) {
    const b = bestCols(scores);
    if (b.length) {
      const s = scores[b[0]];
      if (s > 0) return `${side} to move · win`;
      if (s < 0) return `${side} to move · loss`;
      return `${side} to move · draw`;
    }
  }
  return `${side} to move`;
}

export function parseMoveString(s: string): number[] | null {
  if (!s) return [];
  const moves: number[] = [];
  for (const ch of s) {
    if (ch < "1" || ch > "7") return null;
    moves.push(ch.charCodeAt(0) - 49);
  }
  const g = emptyGrid();
  let p: Player = 1;
  for (const [i, col] of moves.entries()) {
    if (g.height[col] >= HEIGHT) return null;
    const row = drop(g, col, p);
    if (winningCells(g, row, col)) return moves.slice(0, i + 1);
    p = (3 - p) as Player;
  }
  return moves;
}

export function toMoveString(moves: number[]): string {
  return moves.map((c) => String(c + 1)).join("");
}
