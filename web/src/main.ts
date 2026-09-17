import {
  computers,
  planComputer,
  resolveSolverColumn,
  seatFromFormValue,
  type ComputerPlan,
  type Seat,
} from "./computers/index.ts";
import {
  AREA,
  HEIGHT,
  INVALID,
  WIDTH,
  analysisReplyApplies,
  analysisScoreClass,
  formatHintScore,
  isActiveComputerTurn,
  lastMoveWin,
  planHintAndComputer,
  playMoves,
  provenBestColumns,
  shouldRequestAnalysis,
  shouldRequestAvailableScores,
  shouldShowHintDisplay,
  statusText,
  toMove,
  type HintSessionContext,
  type HintSessionEvent,
} from "./game";
import { isDebugMode, readMovesFromLocation, writeMovesToLocation } from "./url";
import { createEngineClient, isWorkerReplaced, type EngineRequest } from "./engineClient";
import { type WorkerRes } from "./engineProtocol";
import { restoreRetainedBooks, shouldStartBookDownload } from "./bookRestore";
import { fetchBookWithDeadline, isAbortError } from "./bookDownload";
import { createWorkerReplace } from "./workerReplace";

const history: number[] = [];
let cursor = 0;
let seats: [Seat, Seat] = [{ kind: "human" }, { kind: "human" }];
/** One hint view for both human analysis and computer turns. `bookCol` is an
 * uncertified move-book suggestion (`?`); `provenCol` is a certified optimum. */
type HintView = { scores: number[]; timedOut: boolean; bookCol?: number; provenCol?: number };

let analysis: HintView | null = null;
let analyzing = false;
let analysisGeneration = 0;
let computerHints: HintView | null = null;
let computerHintGeneration = 0;
let thinking = false;
let engineReady = false;
let engineFailed = false;
let downloadedBooksEnabled = true;
let booksGeneration = 0;
let booksState: Extract<WorkerRes, { type: "ready" }> | null = null;
let bookDownloads = { score: "", move: "" };
let retainedScoreBook: ArrayBuffer | null = null;
let retainedMoveBook: ArrayBuffer | null = null;
let scoreBookDownload: AbortController | null = null;
let moveBookDownload: AbortController | null = null;
let scoreBookAttempted = false;
let moveBookAttempted = false;
let delayMs = 400;
let paused = false;
let lastDropIndex = -1;
let ttSavedForThisGame = false;

const boardEl = document.getElementById("board")!;
const scoresEl = document.getElementById("scores")!;
const statusEl = document.getElementById("status")!;
const engineLine = document.getElementById("engine-line")!;
const booksLine = document.getElementById("books-line")!;
const engineDiagnostics = document.getElementById("engine-diagnostics")!;
const backBtn = document.getElementById("back") as HTMLButtonElement;
const fwdBtn = document.getElementById("forward") as HTMLButtonElement;
const newBtn = document.getElementById("new") as HTMLButtonElement;
const analyzeChk = document.getElementById("analyze") as HTMLInputElement;
const booksToggle = document.getElementById("books") as HTMLInputElement;
const downloadedBooksOption = document.getElementById("downloaded-books-option")!;
const delay = document.getElementById("delay") as HTMLInputElement;
const delayLabel = document.getElementById("delay-label")!;
const pauseBtn = document.getElementById("pause") as HTMLButtonElement;
const copyBtn = document.getElementById("copy-link") as HTMLButtonElement;
const copyLabel = document.getElementById("copy-label")!;
const gameStage = document.querySelector<HTMLElement>(".game-stage")!;
const moveCount = document.getElementById("move-count")!;
const solverAlert = document.getElementById("solver-alert")!;
const solverAlertText = document.getElementById("solver-alert-text")!;
const solverReload = document.getElementById("solver-reload") as HTMLButtonElement;

const SOLVER_FAILURE_TEXT = "The solver failed. Reload to try again.";

function syncDebugControls(): void {
  downloadedBooksOption.hidden = !isDebugMode();
  engineDiagnostics.hidden = !isDebugMode();
}

syncDebugControls();
window.addEventListener("hashchange", syncDebugControls);

const mobile = matchMedia("(max-width: 700px), (pointer: coarse)").matches;
const timeoutMs = mobile ? 6_000 : 12_000;

function declareSolverFailed(detail: string): void {
  if (engineFailed) return;
  engineFailed = true;
  engineReady = false;
  analyzing = false;
  analysis = null;
  analysisGeneration++;
  computerHintGeneration++;
  computerHints = null;
  thinking = false;
  solverAlertText.textContent = SOLVER_FAILURE_TEXT;
  solverAlert.hidden = false;
  engineLine.textContent = detail || "Solver failed";
  renderBoard(false);
}

function spawnWorker(): Worker {
  return new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
}

function initTimeoutMs(): number {
  return new URLSearchParams(location.search).has("bench") ? 0 : timeoutMs;
}

function booksRestoreHost() {
  return {
    downloadedBooksEnabled: () => downloadedBooksEnabled,
    generation: () => booksGeneration,
    retainedScoreBook: () => retainedScoreBook,
    retainedMoveBook: () => retainedMoveBook,
    report: reportBooks,
    loaded(kind: "score" | "move" | "clear", r: WorkerRes) {
      if (kind === "score") bookDownloads.score = r.type === "error" ? r.message : "";
      if (kind === "move") bookDownloads.move = r.type === "error" ? r.message : "";
      if (kind === "clear") bookDownloads = { score: "", move: "" };
      reportBooks(r);
    },
  };
}

function booksSnapshot() {
  return {
    downloadedBooksEnabled,
    retainedScoreBook,
    retainedMoveBook,
    scoreBookAttempted,
    moveBookAttempted,
    scoreBookInFlight: scoreBookDownload !== null,
    moveBookInFlight: moveBookDownload !== null,
  };
}

function onReplacementReady(): void {
  if (engineFailed) return;
  engineReady = true;
  if (!gameOver()) engineLine.textContent = "Solver ready.";
  resumeBookDownloads();
  applyHintComputer("engineReady", false);
}

const workerSession = createWorkerReplace({
  spawn() {
    const worker = spawnWorker();
    return {
      client: createEngineClient(worker, { onFailure: declareSolverFailed }),
      terminate() {
        worker.terminate();
      },
    };
  },
  initTimeoutMs,
  onReplaceStart() {
    engineReady = false;
  },
  restoreBooks: (client, ready) => restoreRetainedBooks(client, ready, booksRestoreHost()),
  afterReady: onReplacementReady,
  onInitFailure: declareSolverFailed,
  isEngineFailed: () => engineFailed,
  downloadedBooksEnabled: () => downloadedBooksEnabled,
  booksGeneration: () => booksGeneration,
});

function send(msg: EngineRequest): Promise<WorkerRes> {
  return workerSession.send(msg);
}

solverReload.addEventListener("click", () => location.reload());

function played(): number[] {
  return history.slice(0, cursor);
}

function gameOver(): boolean {
  const m = played();
  return lastMoveWin(m) !== null || m.length >= AREA;
}

/** Persist the warm TT once per finished game, not on every turn or search. */
function saveTTOnceOnGameOver(over: boolean): void {
  if (!over) {
    ttSavedForThisGame = false;
    return;
  }
  if (ttSavedForThisGame || !engineReady) return;
  ttSavedForThisGame = true;
  void send({ type: "saveTT" });
}

function currentSeat(): Seat {
  return seats[toMove(played()) - 1];
}

function hasComputer(): boolean {
  return seats.some((seat) => seat.kind === "computer");
}

function initBoard(): void {
  for (let c = 0; c < WIDTH; c++) {
    const col = document.createElement("button");
    col.type = "button";
    col.className = "col";
    col.dataset.col = String(c);
    col.setAttribute("aria-label", `Column ${c + 1}`);
    for (let r = HEIGHT - 1; r >= 0; r--) {
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.dataset.row = String(r);
      col.appendChild(cell);
    }
    col.addEventListener("click", () => tryDrop(c));
    boardEl.appendChild(col);
  }
}

function renderBoard(animateLast: boolean): void {
  const m = played();
  const g = playMoves(m);
  const win = lastMoveWin(m);
  const winSet = new Set((win ?? []).map(([r, c]) => `${r},${c}`));
  const over = gameOver();
  saveTTOnceOnGameOver(over);
  const showHints = shouldShowHintDisplay(analyzeChk.checked, over);
  const computerTurn = isActiveComputerTurn(hintContext());
  const hints = computerTurn ? computerHints : analysis;
  const provenCol = hints?.provenCol;
  const bookCol = computerTurn ? undefined : hints?.bookCol;
  const best = showHints
    ? provenBestColumns(hints?.scores ?? null, g.height, hints?.timedOut ?? false, provenCol, bookCol)
    : [];

  if (over) engineLine.textContent = "Game over.";
  gameStage.dataset.player = String(win ? 3 - toMove(m) : toMove(m));
  moveCount.textContent = over ? `${cursor} moves` : `Move ${cursor + 1}`;
  const lastCol = m.length ? m[m.length - 1] : -1;
  const lastRow = lastCol >= 0 ? g.height[lastCol] - 1 : -1;
  boardEl.querySelectorAll<HTMLButtonElement>(".col").forEach((col, c) => {
    col.classList.toggle("best-col", best.includes(c) && !over);
    col.classList.toggle("disabled", over || g.height[c] >= HEIGHT);
    col.disabled = over || g.height[c] >= HEIGHT;
    col.querySelectorAll(".cell").forEach((cellEl) => {
      const cell = cellEl as HTMLElement;
      const row = Number(cell.dataset.row);
      const occ = g.cells[row][c];
      let disc = cell.querySelector(".disc") as HTMLElement | null;
      if (!occ) {
        disc?.remove();
        return;
      }
      const isNew =
        animateLast && lastDropIndex === cursor - 1 && c === lastCol && row === lastRow;
      if (disc && !disc.classList.contains(`p${occ}`)) {
        disc.remove();
        disc = null;
      }
      if (!disc) {
        disc = document.createElement("div");
        disc.className = `disc p${occ}`;
        cell.appendChild(disc);
        if (isNew) {
          disc.classList.add("dropping");
          disc.addEventListener(
            "animationend",
            () => disc?.classList.remove("dropping"),
            { once: true },
          );
        }
      }
      disc.classList.toggle("win-glow", winSet.has(`${row},${c}`));
    });
  });

  if (showHints && (analyzing || hints)) {
    scoresEl.hidden = false;
    scoresEl.replaceChildren();
    for (let i = 0; i < WIDTH; i++) {
      const span = document.createElement("span");
      const score = hints?.scores[i] ?? INVALID;
      const isBest = best.includes(i);
      span.textContent = hints ? formatHintScore(score, analyzing, isBest) : "…";
      const tone = analysisScoreClass(score, isBest);
      if (tone) span.classList.add(tone);
      scoresEl.appendChild(span);
    }
  } else {
    scoresEl.hidden = true;
    scoresEl.replaceChildren();
  }

  // A certified preview already proves the result, so it reaches the status
  // line at once; a bare `?` preview reports nothing until scores arrive.
  const statusScores = showHints && (!analyzing || provenCol !== undefined) ? hints?.scores ?? null : null;
  statusEl.textContent = statusText(
    m,
    statusScores,
    thinking,
    hints?.timedOut ?? false,
    statusScores ? provenCol : undefined,
  );
  if (paused && !over) statusEl.textContent = `Paused · ${statusEl.textContent}`;
  statusEl.classList.toggle("thinking", !over && !paused && (thinking || analyzing));
  backBtn.disabled = cursor === 0;
  fwdBtn.disabled = cursor >= history.length;
  pauseBtn.hidden = !hasComputer();
  pauseBtn.textContent = paused ? "Resume" : "Pause";
}

function tryDrop(col: number): void {
  if (gameOver()) return;
  if (currentSeat().kind !== "human") return;
  const g = playMoves(played());
  if (g.height[col] >= HEIGHT) return;
  applyMove(col);
}

function applyMove(col: number): void {
  cancelComputerMove();
  history.splice(cursor);
  history.push(col);
  lastDropIndex = cursor;
  cursor++;
  positionChanged(true);
}

function positionChanged(animateLast: boolean): void {
  writeMovesToLocation(played());
  applyHintComputer("position", animateLast);
}

function hintContext(): HintSessionContext {
  return {
    hintsOn: analyzeChk.checked,
    engineReady,
    gameOver: gameOver(),
    paused,
    computerToMove: currentSeat().kind === "computer",
    hasAnalysis: analysis !== null || analyzing,
  };
}

function applyHintComputer(event: HintSessionEvent, animateLast: boolean): void {
  computerHintGeneration++;
  if (event === "position") computerHints = null;
  const plan = planHintAndComputer(event, hintContext());
  if (plan.invalidateAnalysis) {
    analysisGeneration++;
    analyzing = false;
    analysis = null;
  }
  if (plan.requestAnalyze) analyzing = true;
  // Apply computer cancel/pause/thinking before painting. Scheduling used to
  // run after render, so switching the last computer to Human left "thinking"
  // or "Paused" on screen after those flags were already cleared.
  if (plan.scheduleComputer) scheduleComputer();
  renderBoard(animateLast);
  if (plan.requestAnalyze) void requestAnalyze();
  else void requestAvailableScores();
}

let cpuTimer = 0;
let cpuGeneration = 0;

type PendingComputerTurn = {
  generation: number;
  moves: number[];
  plan: ComputerPlan;
};

function cancelComputerMove(): void {
  window.clearTimeout(cpuTimer);
  // A solver reply can arrive after pausing or navigating back to the same turn.
  cpuGeneration++;
  thinking = false;
}

function computerTurnStale(generation: number): boolean {
  return generation !== cpuGeneration || paused;
}

function scheduleComputer(): void {
  cancelComputerMove();
  if (!hasComputer()) paused = false;
  if (gameOver() || paused) return;
  const seat = currentSeat();
  if (seat.kind === "human") return;
  const moves = played();
  const plan = planComputer(computers[seat.computerId], moves);
  if (plan === null) return;
  if (plan.type === "solver" && !engineReady) {
    if (!engineFailed) engineLine.textContent = "Waiting for solver…";
    return;
  }
  if (plan.type === "solver") thinking = true;
  const turn: PendingComputerTurn = { generation: cpuGeneration, moves, plan };
  if (plan.type === "local") {
    cpuTimer = window.setTimeout(() => { void executeComputerTurn(turn); }, delayMs);
  } else {
    void executeComputerTurn(turn);
  }
}

async function executeComputerTurn(turn: PendingComputerTurn): Promise<void> {
  if (computerTurnStale(turn.generation)) return;
  if (turn.plan.type === "local") {
    if (!gameOver()) applyMove(turn.plan.col);
    return;
  }
  const r = await send({ type: "bestMove", moves: turn.moves });
  if (computerTurnStale(turn.generation) || isWorkerReplaced(r)) return;
  if (r.type !== "moved") {
    thinking = false;
    if (!engineFailed) {
      engineLine.textContent = r.type === "error" ? r.message : "solver error";
    }
    renderBoard(false);
    return;
  }
  reportEngine(r.nodes, r.micros, r.timedOut, r.fromMoveBook);
  const col = resolveSolverColumn(turn.plan.choose, { col: r.col, moveScores: r.moveScores }, turn.moves);
  computerHintGeneration++;
  computerHints = r.hintScores.some((s) => s !== INVALID)
    ? { scores: r.hintScores, timedOut: r.timedOut, provenCol: r.timedOut ? undefined : toLegalCol(r.col) }
    : null;
  if (col === null || gameOver()) thinking = false;
  renderBoard(false);
  // Let the current position's hints remain visible for the chosen pace.
  if (col !== null && !gameOver()) {
    cpuTimer = window.setTimeout(() => {
      if (!computerTurnStale(turn.generation) && !gameOver()) applyMove(col);
    }, delayMs);
  }
}

/** Computer hints only read already-known scores; they never delay the move for a search. */
async function requestAvailableScores(): Promise<void> {
  if (!shouldRequestAvailableScores(hintContext())) return;
  const token = ++computerHintGeneration;
  const r = await send({ type: "availableScores", moves: played() });
  if (token !== computerHintGeneration || r.type !== "availableScores" || !shouldRequestAvailableScores(hintContext())) return;
  if (r.scores.some((s) => s !== INVALID)) {
    computerHints = {
      scores: r.scores,
      timedOut: computerHints?.timedOut ?? false,
      // A proof-less peek must not erase the proof a bestMove reply proved
      // for this same position (the token guard rules out anything older).
      provenCol: toLegalCol(r.provenCol) ?? computerHints?.provenCol,
    };
  }
  renderBoard(false);
}

/** Engine column bounds: anything outside 0-6 (including NO_COLUMN) is none. */
function toLegalCol(c: number | undefined): number | undefined {
  return c !== undefined && c >= 0 && c < WIDTH ? c : undefined;
}

/** Store a search-free preview: known scores, the book suggestion, and its
 * proof if the suggestion is already exact. */
function applyAnalysisPreview(scores: number[], moveBookCol: number, provenCol: number): void {
  analysis = { scores, timedOut: false, bookCol: toLegalCol(moveBookCol), provenCol: toLegalCol(provenCol) };
}

async function requestAnalyze(): Promise<void> {
  if (!shouldRequestAnalysis(hintContext())) {
    analyzing = false;
    renderBoard(false);
    return;
  }
  const token = ++analysisGeneration;
  const moves = played();
  analyzing = true;
  engineLine.textContent = "analyzing…";
  renderBoard(false);
  // Peek known scores and the move-book suggestion before the blocking search
  // so the strip highlights `?` immediately. Skip the peek when a search is
  // already occupying the worker; a new analyze will replace it instead.
  if (!workerSession.client().hasPendingCompute()) {
    const preview = await send({ type: "availableScores", moves });
    if (!analysisReplyApplies(token, analysisGeneration, hintContext())) return;
    if (preview.type === "availableScores") {
      applyAnalysisPreview(preview.scores, preview.moveBookCol, preview.provenCol);
      renderBoard(false);
    }
  }
  if (!analysisReplyApplies(token, analysisGeneration, hintContext())) return;
  const r = await send({ type: "analyze", moves });
  if (!analysisReplyApplies(token, analysisGeneration, hintContext()) || isWorkerReplaced(r)) return;
  analyzing = false;
  if (r.type === "analyzed") {
    analysis = {
      scores: r.scores,
      timedOut: r.timedOut,
      // A timeout proves nothing, but the preview's suggestion and proof
      // stay valid behind `?` and the exact rank.
      bookCol: r.timedOut ? analysis?.bookCol : undefined,
      provenCol: analysis?.provenCol,
    };
    reportEngine(r.nodes, r.micros, r.timedOut);
  } else {
    engineLine.textContent = r.type === "error" ? r.message : "Analysis unavailable.";
  }
  renderBoard(false);
}

function reportEngine(
  nodes: number,
  micros: number,
  timedOut: boolean,
  fromMoveBook = false,
): void {
  const ms = micros / 1000;
  const nps = ms > 0 ? (nodes / ms) * 1000 : 0;
  if (fromMoveBook) {
    engineLine.textContent = "instant (move book)";
    return;
  }
  if (nodes === 0 && !timedOut) {
    engineLine.textContent = "instant (score book / tactical)";
    return;
  }
  const src = downloadedBooksEnabled ? "search" : "search (embedded score book only)";
  engineLine.textContent = timedOut
    ? `Timed out after ${ms.toFixed(0)} ms · ${nodes.toLocaleString()} nodes (result not proven)`
    : `${src}: ${nodes.toLocaleString()} nodes in ${ms < 10 ? ms.toFixed(1) : ms.toFixed(0)} ms` +
      (nps ? ` · ${(nps / 1000).toFixed(0)} kn/s` : "");
}

backBtn.addEventListener("click", () => {
  if (cursor === 0) return;
  if (hasComputer()) paused = true;
  cancelComputerMove();
  cursor--;
  positionChanged(false);
});

fwdBtn.addEventListener("click", () => {
  if (cursor >= history.length) return;
  cancelComputerMove();
  lastDropIndex = cursor;
  cursor++;
  positionChanged(true);
});

newBtn.addEventListener("click", () => {
  cancelComputerMove();
  history.length = 0;
  cursor = 0;
  positionChanged(false);
});

analyzeChk.addEventListener("change", () => {
  if (analyzeChk.checked) applyHintComputer("hintsOn", false);
  else {
    if (!engineFailed) {
      engineLine.textContent = engineReady ? "Solver ready." : "Getting the solver ready…";
    }
    applyHintComputer("hintsOff", false);
  }
});

booksToggle.addEventListener("change", () => {
  downloadedBooksEnabled = booksToggle.checked;
  if (!downloadedBooksEnabled) {
    retainedScoreBook = null;
    retainedMoveBook = null;
    const generation = ++booksGeneration;
    scoreBookAttempted = false;
    moveBookAttempted = false;
    abortBookDownloads();
    bookDownloads = { score: "", move: "" };
    reportBooks();
    if (!engineReady || engineFailed) return;
    void send({ type: "clearDownloadedBooks" }).then((r) => {
      if (generation === booksGeneration) reportBooks(r);
    });
    return;
  }
  if (!engineReady || engineFailed) return;
  loadDownloadedBooks();
});

delay.addEventListener("input", () => {
  delayMs = Number(delay.value);
  delayLabel.textContent = `${delayMs} ms`;
  delay.style.setProperty("--range-progress", `${(delayMs / Number(delay.max)) * 100}%`);
});

pauseBtn.addEventListener("click", () => {
  paused = !paused;
  if (paused) cancelComputerMove();
  applyHintComputer(paused ? "pause" : "resume", false);
});

copyBtn.addEventListener("click", async () => {
  writeMovesToLocation(played());
  try {
    await navigator.clipboard.writeText(location.href);
    copyLabel.textContent = "Link copied!";
    setTimeout(() => (copyLabel.textContent = "Copy game link"), 1200);
  } catch {
    copyLabel.textContent = "Copy the address bar";
  }
});

function bindSeat(seat: 0 | 1): void {
  document.querySelectorAll<HTMLInputElement>(`input[name="role${seat}"]`).forEach((el) => {
    el.addEventListener("change", () => {
      const next = seatFromFormValue(el.value);
      if (next === null) return;
      seats[seat] = next;
      applyHintComputer("role", false);
    });
  });
}

function radioOption(name: string, value: string, label: string, checked: boolean): HTMLLabelElement {
  const wrap = document.createElement("label");
  const input = document.createElement("input");
  input.type = "radio";
  input.name = name;
  input.value = value;
  if (checked) input.checked = true;
  const span = document.createElement("span");
  span.textContent = label;
  wrap.append(input, span);
  return wrap;
}

function fillSeatRadios(): void {
  document.querySelectorAll<HTMLElement>(".roles").forEach((group, seat) => {
    const name = `role${seat}`;
    group.replaceChildren(radioOption(name, "human", "Human", true));
    for (const [id, policy] of Object.entries(computers)) {
      group.append(radioOption(name, id, policy.label, false));
    }
  });
}

fillSeatRadios();
bindSeat(0);
bindSeat(1);

document.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.key >= "1" && e.key <= "7") tryDrop(Number(e.key) - 1);
  else if (e.key === "z" && !e.shiftKey) backBtn.click();
  else if (e.key === "y" || (e.key === "z" && e.shiftKey)) fwdBtn.click();
  else if (e.key === "ArrowLeft") backBtn.click();
  else if (e.key === "ArrowRight") fwdBtn.click();
});

function reportBooks(r?: WorkerRes): void {
  if (r?.type === "ready") booksState = r;
  if (!booksState) return;
  const move =
    booksState.moveBookPopulated > 0
      ? `move book ${booksState.moveBookPopulated.toLocaleString()} moves (through move ${booksState.moveBookMoves})`
      : "move book not loaded";
  booksLine.textContent = [
    `Score book ${booksState.scoreBookLen.toLocaleString()} positions (through move ${booksState.scoreBookMoves})`,
    move,
    bookDownloads.score,
    bookDownloads.move,
  ].filter(Boolean).join(" · ");
}

function abortBookDownloads(): void {
  scoreBookDownload?.abort();
  moveBookDownload?.abort();
  scoreBookDownload = null;
  moveBookDownload = null;
}

function startBookDownload(kind: "score" | "move", generation: number): void {
  const ac = new AbortController();
  const asset =
    kind === "score"
      ? { path: "books/opening.c4book", label: "Score book" as const, load: "loadScoreBook" as const }
      : { path: "books/opening.c4move", label: "Move book" as const, load: "loadMoveBook" as const };
  if (kind === "score") {
    scoreBookDownload = ac;
    scoreBookAttempted = true;
    bookDownloads.score = "Downloading score book…";
  } else {
    moveBookDownload = ac;
    moveBookAttempted = true;
    bookDownloads.move = "Downloading move book…";
  }
  reportBooks();
  void (async () => {
    try {
      const bytes = await fetchBookWithDeadline(new URL(asset.path, document.baseURI).href, {
        label: asset.label,
        signal: ac.signal,
      });
      if (generation !== booksGeneration || !downloadedBooksEnabled || engineFailed) return;
      if (kind === "score") retainedScoreBook = bytes.slice(0);
      else retainedMoveBook = bytes.slice(0);
      const r = await send({ type: asset.load, bytes: bytes.slice(0) });
      if (generation !== booksGeneration || !downloadedBooksEnabled || engineFailed) return;
      if (isWorkerReplaced(r)) return;
      if (kind === "score") bookDownloads.score = r.type === "error" ? r.message : "";
      else bookDownloads.move = r.type === "error" ? r.message : "";
      reportBooks(r);
      if (kind === "score" && r.type === "ready") void requestAvailableScores();
    } catch (e) {
      if (generation !== booksGeneration || !downloadedBooksEnabled || engineFailed) return;
      if (isAbortError(e)) return;
      if (kind === "score") bookDownloads.score = e instanceof Error ? e.message : String(e);
      else bookDownloads.move = e instanceof Error ? e.message : String(e);
      reportBooks();
    } finally {
      if (kind === "score") {
        if (scoreBookDownload === ac) scoreBookDownload = null;
      } else if (moveBookDownload === ac) moveBookDownload = null;
    }
  })();
}

/** User On: new attempts for both books. Aborts any previous fetch as cancellation, not a timeout. */
function loadDownloadedBooks(): void {
  const generation = ++booksGeneration;
  abortBookDownloads();
  startBookDownload("score", generation);
  startBookDownload("move", generation);
}

/**
 * After init/replacement: start only missing books that have not already been
 * attempted. Does not bump generation or abort an in-flight fetch.
 */
function resumeBookDownloads(): void {
  if (!downloadedBooksEnabled || engineFailed) return;
  const state = booksSnapshot();
  if (shouldStartBookDownload("score", state)) startBookDownload("score", booksGeneration);
  if (shouldStartBookDownload("move", state)) startBookDownload("move", booksGeneration);
}

function onReady(r: WorkerRes): void {
  if (r.type !== "ready") {
    workerSession.client().fail();
    declareSolverFailed(r.type === "error" ? r.message : "Solver failed");
    return;
  }
  if (engineFailed) return;
  engineReady = true;
  if (!gameOver()) engineLine.textContent = "Solver ready.";
  reportBooks(r);
  applyHintComputer("engineReady", false);
  resumeBookDownloads();
}

initBoard();

const fromUrl = readMovesFromLocation();
if (fromUrl) {
  history.push(...fromUrl);
  cursor = history.length;
  writeMovesToLocation(played());
}

renderBoard(false);

void send({
  type: "init",
  timeoutMs: initTimeoutMs(),
}).then(async (r) => {
  onReady(r);
  if (new URLSearchParams(location.search).has("bench") && engineReady) {
    engineLine.textContent = "Benchmark: empty-board first winning move…";
    const t0 = performance.now();
    const res = await send({ type: "bestMove", moves: [] });
    const dt = performance.now() - t0;
    if (res.type === "moved") {
      engineLine.textContent =
        `Empty board: column ${res.col + 1} in ${dt.toFixed(0)} ms · ` +
        `${res.nodes.toLocaleString()} nodes` +
        (res.timedOut ? " · TIMED OUT" : "");
    }
  }
});
