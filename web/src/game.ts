import type { CompleteColumnScores } from "./engineProtocol";

export const WIDTH = 7;
export const HEIGHT = 6;
export const AREA = WIDTH * HEIGHT;
export const INVALID = -1000;

export type Player = 1 | 2;

export interface Grid {
  cells: number[][]; // [row][col], row 0 = bottom, 0 empty, 1 red, 2 yellow
  height: number[];
}

function emptyGrid(): Grid {
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

function drop(g: Grid, col: number, player: Player): number {
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

/** Session flags that decide whether hints run or the computer should move. */
export type HintSessionContext = {
  hintsOn: boolean;
  engineReady: boolean;
  gameOver: boolean;
  paused: boolean;
  computerToMove: boolean;
  hasAnalysis: boolean;
};

export type HintSessionEvent =
  | "position"
  | "engineReady"
  | "hintsOn"
  | "hintsOff"
  | "role"
  | "pause"
  | "resume";

export type HintComputerPlan = {
  invalidateAnalysis: boolean;
  requestAnalyze: boolean;
  scheduleComputer: boolean;
};

export function isActiveComputerTurn(
  ctx: Pick<HintSessionContext, "gameOver" | "paused" | "computerToMove">,
): boolean {
  return !ctx.gameOver && !ctx.paused && ctx.computerToMove;
}

/** Full-column analysis is for human turns and paused positions, not active computers. */
export function shouldRequestAnalysis(ctx: HintSessionContext): boolean {
  return ctx.hintsOn && ctx.engineReady && !ctx.gameOver && (ctx.paused || !ctx.computerToMove);
}

export function shouldRequestAvailableScores(ctx: HintSessionContext): boolean {
  return ctx.hintsOn && ctx.engineReady && isActiveComputerTurn(ctx);
}

export function shouldShowHintDisplay(
  hintsOn: boolean,
  gameOver: boolean,
): boolean {
  return hintsOn && !gameOver;
}

export function analysisReplyApplies(
  token: number,
  generation: number,
  ctx: HintSessionContext,
): boolean {
  return token === generation && shouldRequestAnalysis(ctx);
}

/**
 * Keep computer scheduling independent of hint analysis. Active computers
 * never request `analyze`; leaving an analysis view invalidates its result.
 */
export function planHintAndComputer(
  event: HintSessionEvent,
  ctx: HintSessionContext,
): HintComputerPlan {
  const analyze = shouldRequestAnalysis(ctx);
  switch (event) {
    case "position":
      return { invalidateAnalysis: true, requestAnalyze: analyze, scheduleComputer: true };
    case "engineReady":
      return { invalidateAnalysis: false, requestAnalyze: analyze, scheduleComputer: true };
    case "hintsOn":
      return { invalidateAnalysis: false, requestAnalyze: analyze, scheduleComputer: false };
    case "hintsOff":
      return { invalidateAnalysis: true, requestAnalyze: false, scheduleComputer: false };
    case "role":
      return {
        invalidateAnalysis: !analyze,
        requestAnalyze: analyze && !ctx.hasAnalysis,
        scheduleComputer: true,
      };
    case "pause":
      return { invalidateAnalysis: false, requestAnalyze: analyze, scheduleComputer: false };
    case "resume":
      return {
        invalidateAnalysis: isActiveComputerTurn(ctx),
        requestAnalyze: analyze && !ctx.hasAnalysis,
        scheduleComputer: true,
      };
  }
}

/** True if every legal column has an exact score. Ignores timeout. */
function analysisComplete(scores: ArrayLike<number>, heights: number[]): boolean {
  if (scores.length < WIDTH) return false;
  for (let c = 0; c < WIDTH; c++) {
    if (heights[c] < HEIGHT && scores[c] === INVALID) return false;
  }
  return true;
}

/**
 * Highlighted hint columns. Complete exact scores win; otherwise an exact
 * `provenCol` (a certified preview, or a finished best-move search) still
 * certifies its equals — even past a background timeout, which cannot
 * unprove it. A timed-out search alone proves nothing. Whatever remains
 * falls back to the uncertified move-book suggestion.
 */
export function provenBestColumns(
  scores: number[] | null,
  heights: number[],
  timedOut: boolean,
  provenCol?: number,
  bookCol?: number,
): number[] {
  if (!scores) return legalBookCol(heights, bookCol);
  if (!timedOut && analysisComplete(scores, heights)) return bestCols(scores);
  if (provenCol !== undefined && heights[provenCol] < HEIGHT && scores[provenCol] !== INVALID) {
    return scores.map((s, c) => s === scores[provenCol] ? c : -1).filter((c) => c >= 0);
  }
  return legalBookCol(heights, bookCol);
}

/** Uncertified suggestion, kept through a timeout so `?` survives it. */
function legalBookCol(heights: number[], bookCol?: number): number[] {
  if (bookCol === undefined || bookCol < 0 || bookCol >= WIDTH) return [];
  if (heights[bookCol] >= HEIGHT) return [];
  return [bookCol];
}

export function analysisScoreClass(score: number, isBest: boolean): string | null {
  if (isBest) return "best";
  if (score === INVALID) return null;
  if (score > 0) return "win";
  if (score < 0) return "loss";
  return "draw";
}

/**
 * Worker-boundary complete move scores. Empty, short, or any legal column
 * still at `INVALID` becomes `null`. Seven entries alone are not enough.
 */
export function completeMoveScores(
  scores: ArrayLike<number>,
  moves: number[],
): CompleteColumnScores | null {
  if (scores.length !== WIDTH) return null;
  const cols: CompleteColumnScores = [
    scores[0],
    scores[1],
    scores[2],
    scores[3],
    scores[4],
    scores[5],
    scores[6],
  ];
  return analysisComplete(cols, playMoves(moves).height) ? cols : null;
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

/** Hint-strip label: exact W/D/L once known, `?` for the suggested column, `…` while analyzing. */
export function formatHintScore(score: number, analyzing: boolean, isBest: boolean): string {
  if (score !== INVALID) return formatScore(score);
  if (isBest) return "?";
  if (analyzing) return "…";
  return "";
}

export function statusText(
  moves: number[],
  scores: number[] | null,
  thinking: boolean,
  timedOut = false,
  provenCol?: number,
): string {
  const win = lastMoveWin(moves);
  if (win) {
    const winner = toMove(moves.slice(0, -1)) === 1 ? "Red" : "Yellow";
    return `${winner} wins`;
  }
  if (isDraw(moves)) return "Draw";
  const side = toMove(moves) === 1 ? "Red" : "Yellow";
  if (thinking) return `${side} thinking…`;
  // Only a proof reports win/loss/draw; a bare `?` suggestion never does.
  const best = provenBestColumns(scores, playMoves(moves).height, timedOut, provenCol);
  if (best.length && scores) {
    const s = scores[best[0]];
    if (s > 0) return `${side} to move · win`;
    if (s < 0) return `${side} to move · loss`;
    return `${side} to move · draw`;
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
