import {
  AREA,
  HEIGHT,
  WIDTH,
  analysisReplyApplies,
  analysisScoreClass,
  chooseAfterEngine,
  formatScore,
  isDraw,
  lastMoveWin,
  planComputerTurn,
  planHintAndComputer,
  playMoves,
  provenBestColumns,
  shouldRequestAnalysis,
  shouldShowHintDisplay,
  statusText,
  toMove,
  type ComputerRole,
  type ComputerTurnPlan,
  type HintSessionContext,
  type HintSessionEvent,
  type Role,
} from "./game";
import { isDebugMode, readMovesFromLocation, writeMovesToLocation } from "./url";
import { createEngineClient, isBlockingCompute, WORKER_REPLACED, type EngineRequest } from "./engineClient";
import type { WorkerRes } from "./engineProtocol";

const history: number[] = [];
let cursor = 0;
let roles: [Role, Role] = ["human", "human"];
let analysis: { scores: number[]; timedOut: boolean } | null = null;
let analyzing = false;
let analysisGeneration = 0;
let thinking = false;
let engineReady = false;
let engineFailed = false;
let bookOn = true;
let bookGeneration = 0;
let bookState: Extract<WorkerRes, { type: "ready" }> | null = null;
let bookDownloads = { score: "", move: "" };
let delayMs = 400;
let paused = false;
let lastDropIndex = -1;

const boardEl = document.getElementById("board")!;
const scoresEl = document.getElementById("scores")!;
const statusEl = document.getElementById("status")!;
const engineLine = document.getElementById("engine-line")!;
const bookLine = document.getElementById("book-line")!;
const engineDiagnostics = document.getElementById("engine-diagnostics")!;
const backBtn = document.getElementById("back") as HTMLButtonElement;
const fwdBtn = document.getElementById("forward") as HTMLButtonElement;
const newBtn = document.getElementById("new") as HTMLButtonElement;
const analyzeChk = document.getElementById("analyze") as HTMLInputElement;
const bookChk = document.getElementById("book") as HTMLInputElement;
const openingBookOption = document.getElementById("opening-book-option")!;
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
  openingBookOption.hidden = !isDebugMode();
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
  thinking = false;
  solverAlertText.textContent = SOLVER_FAILURE_TEXT;
  solverAlert.hidden = false;
  engineLine.textContent = detail || "Solver failed";
  renderBoard(false);
}

function spawnWorker(): Worker {
  return new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
}

let worker = spawnWorker();
let engineClient = createEngineClient(worker, { onFailure: declareSolverFailed });
let replacing: Promise<void> | null = null;
let computeGate: Promise<void> = Promise.resolve();

function initTimeoutMs(): number {
  return new URLSearchParams(location.search).has("bench") ? 0 : timeoutMs;
}

function replaceWorker(): Promise<void> {
  if (!replacing) {
    replacing = (async () => {
      const oldClient = engineClient;
      const oldWorker = worker;
      oldClient.fail(WORKER_REPLACED);
      oldWorker.terminate();
      worker = spawnWorker();
      engineClient = createEngineClient(worker, { onFailure: declareSolverFailed });
      engineReady = false;
      const r = await engineClient.request({ type: "init", timeoutMs: initTimeoutMs() });
      if (r.type !== "ready") {
        engineClient.fail();
        declareSolverFailed(r.type === "error" ? r.message : "Solver failed");
        return;
      }
      if (engineFailed) return;
      engineReady = true;
      if (!gameOver()) engineLine.textContent = "Solver ready.";
      reportBook(r);
      if (bookOn) loadDownloadedBooks();
    })().finally(() => {
      replacing = null;
    });
  }
  return replacing;
}

function send(msg: EngineRequest): Promise<WorkerRes> {
  if (!isBlockingCompute(msg.type)) {
    if (replacing) return replacing.then(() => engineClient.request(msg));
    return engineClient.request(msg);
  }
  let posted!: () => void;
  const postedP = new Promise<void>((resolve) => {
    posted = resolve;
  });
  const result = computeGate.then(async () => {
    try {
      // A queued abort cannot stop synchronous WASM. Drop the worker only when
      // a new blocking search is posted while one is already running. Timer
      // cancels, book fetches, and idle book hits do not restart. The new
      // worker reloads persisted proven entries and books (HTTP cache); the
      // old TT and unflushed proofs are gone.
      if (engineClient.hasPendingCompute()) await replaceWorker();
      const p = engineClient.request(msg);
      posted();
      return p;
    } catch (e) {
      posted();
      throw e;
    }
  });
  computeGate = postedP;
  return result;
}

solverReload.addEventListener("click", () => location.reload());

function played(): number[] {
  return history.slice(0, cursor);
}

function gameOver(): boolean {
  const m = played();
  return lastMoveWin(m) !== null || isDraw(m) || m.length >= AREA;
}

function currentRole(): Role {
  return roles[toMove(played()) - 1];
}

function hasComputer(): boolean {
  return roles.some((role) => role !== "human");
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
  const showHints = shouldShowHintDisplay(analyzeChk.checked, over, paused, currentRole());
  const best = showHints
    ? provenBestColumns(analysis?.scores ?? null, g.height, analysis?.timedOut ?? false)
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
      } else {
        disc.classList.remove("dropping");
      }
      disc.classList.toggle("win-glow", winSet.has(`${row},${c}`));
    });
  });

  if (showHints && analyzing) {
    scoresEl.hidden = false;
    scoresEl.replaceChildren();
    for (let i = 0; i < WIDTH; i++) {
      const span = document.createElement("span");
      span.textContent = "…";
      scoresEl.appendChild(span);
    }
  } else if (showHints && analysis) {
    scoresEl.hidden = false;
    scoresEl.replaceChildren();
    analysis.scores.forEach((s, i) => {
      const span = document.createElement("span");
      span.textContent = formatScore(s);
      const tone = analysisScoreClass(s, best.includes(i));
      if (tone) span.classList.add(tone);
      scoresEl.appendChild(span);
    });
  } else {
    scoresEl.hidden = true;
    scoresEl.replaceChildren();
  }

  statusEl.textContent = statusText(
    m,
    showHints && !analyzing ? analysis?.scores ?? null : null,
    thinking,
    analysis?.timedOut ?? false,
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
  if (currentRole() !== "human") return;
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
    role: currentRole(),
    hasAnalysis: analysis !== null || analyzing,
  };
}

function applyHintComputer(event: HintSessionEvent, animateLast: boolean): void {
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
}

let cpuTimer = 0;
let cpuGeneration = 0;

type PendingComputerTurn = {
  generation: number;
  role: ComputerRole;
  moves: number[];
  plan: ComputerTurnPlan;
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
  const role = currentRole();
  if (role === "human") return;
  const moves = played();
  const plan = planComputerTurn(role, moves);
  if (plan === null) return;
  if (plan.type === "engine" && !engineReady) {
    if (!engineFailed) engineLine.textContent = "Waiting for solver…";
    return;
  }
  if (plan.type === "engine") thinking = true;
  const turn: PendingComputerTurn = { generation: cpuGeneration, role, moves, plan };
  cpuTimer = window.setTimeout(() => {
    void executeComputerTurn(turn);
  }, delayMs);
}

async function executeComputerTurn(turn: PendingComputerTurn): Promise<void> {
  if (computerTurnStale(turn.generation)) return;
  if (turn.plan.type === "local") {
    if (!gameOver()) applyMove(turn.plan.col);
    return;
  }
  const r = await send({ type: "bestMove", moves: turn.moves });
  if (computerTurnStale(turn.generation)) return;
  thinking = false;
  if (r.type !== "moved") {
    if (!engineFailed) {
      engineLine.textContent = r.type === "error" ? r.message : "solver error";
    }
    renderBoard(false);
    return;
  }
  reportEngine(r.nodes, r.micros, r.timedOut, r.fromCache, r.fromMoveBook);
  const col = chooseAfterEngine(turn.role, turn.moves, r.col, r.moveScores);
  if (col !== null && !gameOver()) applyMove(col);
  else renderBoard(false);
}

async function requestAnalyze(): Promise<void> {
  if (!shouldRequestAnalysis(hintContext())) {
    analyzing = false;
    renderBoard(false);
    return;
  }
  const token = ++analysisGeneration;
  analyzing = true;
  engineLine.textContent = "analyzing…";
  renderBoard(false);
  const r = await send({ type: "analyze", moves: played() });
  if (!analysisReplyApplies(token, analysisGeneration, hintContext())) return;
  analyzing = false;
  if (r.type === "analyzed") {
    analysis = { scores: r.scores, timedOut: r.timedOut };
    reportEngine(r.nodes, r.micros, r.timedOut, r.fromCache);
  } else {
    engineLine.textContent = r.type === "error" ? r.message : "Analysis unavailable.";
  }
  renderBoard(false);
}

function reportEngine(
  nodes: number,
  micros: number,
  timedOut: boolean,
  fromCache: boolean,
  fromMoveBook = false,
): void {
  const ms = micros / 1000;
  const nps = ms > 0 ? (nodes / ms) * 1000 : 0;
  if (fromCache) {
    engineLine.textContent = "cache hit";
    return;
  }
  if (fromMoveBook) {
    engineLine.textContent = "instant (move book)";
    return;
  }
  if (nodes === 0 && !timedOut) {
    engineLine.textContent = "instant (opening / book)";
    return;
  }
  const src = bookOn ? "search" : "search (embedded book only)";
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

bookChk.addEventListener("change", () => {
  bookOn = bookChk.checked;
  if (!engineReady || engineFailed) return;
  if (bookOn) {
    loadDownloadedBooks();
  } else {
    const generation = ++bookGeneration;
    bookDownloads = { score: "", move: "" };
    void engineClient.request({ type: "clearDownloadedBooks" }).then((r) => {
      if (generation === bookGeneration) reportBook(r);
    });
  }
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

document.querySelectorAll<HTMLInputElement>('input[name="role0"]').forEach((el) => {
  el.addEventListener("change", () => {
    roles[0] = el.value as Role;
    applyHintComputer("role", false);
  });
});
document.querySelectorAll<HTMLInputElement>('input[name="role1"]').forEach((el) => {
  el.addEventListener("change", () => {
    roles[1] = el.value as Role;
    applyHintComputer("role", false);
  });
});

document.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.key >= "1" && e.key <= "7") tryDrop(Number(e.key) - 1);
  else if (e.key === "z" && !e.shiftKey) backBtn.click();
  else if (e.key === "y" || (e.key === "z" && e.shiftKey)) fwdBtn.click();
  else if (e.key === "ArrowLeft") backBtn.click();
  else if (e.key === "ArrowRight") fwdBtn.click();
});

function reportBook(r?: WorkerRes): void {
  if (r?.type === "ready") bookState = r;
  if (!bookState) return;
  const move =
    bookState.moveBookPopulated > 0
      ? `move book ${bookState.moveBookPopulated.toLocaleString()} moves (depth ${bookState.moveBookDepth})`
      : "move book not loaded";
  bookLine.textContent = [
    `Score book ${bookState.bookLen.toLocaleString()} positions (depth ${bookState.bookDepth})`,
    move,
    bookDownloads.score,
    bookDownloads.move,
  ].filter(Boolean).join(" · ");
}

function loadDownloadedBooks(): void {
  const generation = ++bookGeneration;
  bookDownloads = { score: "Downloading score book…", move: "Downloading move book…" };
  reportBook();
  for (const [book, type, file] of [
    ["score", "fetchScoreBook", "opening.c4book"],
    ["move", "fetchMoveBook", "opening.c4move"],
  ] as const) {
    void engineClient.request({ type, url: new URL(`books/${file}`, document.baseURI).href }).then((r) => {
      if (generation !== bookGeneration || !bookOn || engineFailed) return;
      bookDownloads[book] = r.type === "error" ? r.message : "";
      reportBook(r);
    });
  }
}

function onReady(r: WorkerRes): void {
  if (r.type !== "ready") {
    engineClient.fail();
    declareSolverFailed(r.type === "error" ? r.message : "Solver failed");
    return;
  }
  if (engineFailed) return;
  engineReady = true;
  if (!gameOver()) engineLine.textContent = "Solver ready.";
  reportBook(r);
  applyHintComputer("engineReady", false);
  if (bookOn) loadDownloadedBooks();
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
        (res.timedOut ? " · TIMED OUT" : "") +
        (res.fromCache ? " · cache" : "");
    }
  }
});
