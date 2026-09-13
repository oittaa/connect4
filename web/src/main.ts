import {
  AREA,
  HEIGHT,
  WIDTH,
  analysisComplete,
  bestCols,
  easyMove,
  formatScore,
  isDraw,
  lastMoveWin,
  mediumMove,
  playMoves,
  statusText,
  toMove,
  type Role,
} from "./game";
import { readMovesFromLocation, writeMovesToLocation } from "./url";
import type { WorkerReq, WorkerRes } from "./worker";

const history: number[] = [];
let cursor = 0;
let roles: [Role, Role] = ["human", "human"];
let scores: number[] | null = null;
let analyzing = false;
let thinking = false;
let engineReady = false;
let bookOn = true;
let delayMs = 400;
let paused = false;
let lastDropIndex = -1;
let reqId = 1;
const pending = new Map<number, (r: WorkerRes) => void>();

const boardEl = document.getElementById("board")!;
const scoresEl = document.getElementById("scores")!;
const statusEl = document.getElementById("status")!;
const engineLine = document.getElementById("engine-line")!;
const backBtn = document.getElementById("back") as HTMLButtonElement;
const fwdBtn = document.getElementById("forward") as HTMLButtonElement;
const newBtn = document.getElementById("new") as HTMLButtonElement;
const analyzeChk = document.getElementById("analyze") as HTMLInputElement;
const bookChk = document.getElementById("book") as HTMLInputElement;
const delay = document.getElementById("delay") as HTMLInputElement;
const delayLabel = document.getElementById("delay-label")!;
const pauseBtn = document.getElementById("pause") as HTMLButtonElement;
const copyBtn = document.getElementById("copy-link") as HTMLButtonElement;

const mobile = matchMedia("(max-width: 700px), (pointer: coarse)").matches;
const timeoutMs = mobile ? 6_000 : 12_000;

const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
worker.onmessage = (ev: MessageEvent<WorkerRes>) => {
  const r = ev.data;
  const fn = pending.get(r.id);
  if (fn) {
    pending.delete(r.id);
    fn(r);
  }
};

type OmitId<T> = T extends unknown ? Omit<T, "id"> : never;

function send(msg: OmitId<WorkerReq>): Promise<WorkerRes> {
  const id = reqId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    worker.postMessage({ ...msg, id } as WorkerReq);
  });
}

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

function renderBoard(animateLast: boolean): void {
  const m = played();
  const g = playMoves(m);
  const win = lastMoveWin(m);
  const winSet = new Set((win ?? []).map(([r, c]) => `${r},${c}`));
  const proven = !!(scores && analysisComplete(scores, g.height));
  const best = proven && analyzeChk.checked && scores ? bestCols(scores) : [];

  if (!boardEl.childElementCount) {
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

  const over = gameOver();
  const lastCol = m.length ? m[m.length - 1] : -1;
  const lastRow = lastCol >= 0 ? g.height[lastCol] - 1 : -1;
  boardEl.querySelectorAll<HTMLButtonElement>(".col").forEach((col, c) => {
    col.classList.toggle("best-col", best.includes(c) && !over);
    col.classList.toggle("disabled", over || g.height[c] >= HEIGHT);
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

  if (analyzeChk.checked && analyzing) {
    scoresEl.hidden = false;
    scoresEl.replaceChildren();
    for (let i = 0; i < WIDTH; i++) {
      const span = document.createElement("span");
      span.textContent = "…";
      scoresEl.appendChild(span);
    }
  } else if (analyzeChk.checked && scores) {
    scoresEl.hidden = false;
    scoresEl.replaceChildren();
    scores.forEach((s, i) => {
      const span = document.createElement("span");
      span.textContent = formatScore(s);
      if (best.includes(i)) span.classList.add("best");
      else if (s > 0) span.classList.add("win");
      else if (s < 0) span.classList.add("loss");
      else if (s === 0) span.classList.add("draw");
      scoresEl.appendChild(span);
    });
  } else {
    scoresEl.hidden = true;
    scoresEl.replaceChildren();
  }

  statusEl.textContent = statusText(
    m,
    analyzeChk.checked && !analyzing ? scores : null,
    thinking,
  );
  statusEl.classList.toggle("thinking", thinking || analyzing);
  backBtn.disabled = cursor === 0;
  fwdBtn.disabled = cursor >= history.length;
  const bothCpu = roles[0] !== "human" && roles[1] !== "human";
  pauseBtn.hidden = !bothCpu;
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
  history.splice(cursor);
  history.push(col);
  lastDropIndex = cursor;
  cursor++;
  scores = null;
  analyzing = analyzeChk.checked && engineReady;
  writeMovesToLocation(played());
  renderBoard(true);
  if (analyzing) engineLine.textContent = "analyzing…";
  afterChange();
}

function afterChange(): void {
  if (analyzeChk.checked && engineReady) void requestAnalyze();
  else scheduleComputer();
}

let cpuTimer = 0;
function scheduleComputer(): void {
  window.clearTimeout(cpuTimer);
  if (gameOver() || paused) return;
  const role = currentRole();
  if (role === "human") return;
  if (role === "easy") {
    cpuTimer = window.setTimeout(() => {
      const col = easyMove(played());
      if (col !== null) applyMove(col);
    }, delayMs);
    return;
  }
  if (!engineReady) {
    engineLine.textContent = "Waiting for solver…";
    return;
  }
  thinking = true;
  renderBoard(false);
  cpuTimer = window.setTimeout(() => {
    void requestMove(role);
  }, delayMs);
}

async function requestMove(role: Role): Promise<void> {
  const token = cursor;
  const r = await send({ type: "bestMove", moves: played() });
  if (token !== cursor) return;
  thinking = false;
  if (r.type !== "moved") {
    engineLine.textContent = r.type === "error" ? r.message : "solver error";
    renderBoard(false);
    return;
  }
  scores = r.scores;
  reportEngine(r.nodes, r.micros, r.timedOut, r.fromCache);
  let col = r.col;
  if (role === "medium") col = mediumMove(r.scores) ?? r.col;
  if (!(col >= 0 && col < WIDTH)) col = easyMove(played()) ?? 255;
  if (col >= 0 && col < WIDTH && !gameOver()) applyMove(col);
  else renderBoard(false);
}

async function requestAnalyze(): Promise<void> {
  if (!engineReady || gameOver()) {
    analyzing = false;
    renderBoard(false);
    return;
  }
  analyzing = true;
  engineLine.textContent = "analyzing…";
  renderBoard(false);
  const token = cursor;
  const r = await send({ type: "analyze", moves: played() });
  if (token !== cursor) return;
  analyzing = false;
  if (r.type === "analyzed") {
    scores = r.scores;
    reportEngine(r.nodes, r.micros, r.timedOut, r.fromCache);
  }
  renderBoard(false);
  scheduleComputer();
}

function reportEngine(nodes: number, micros: number, timedOut: boolean, fromCache: boolean): void {
  const ms = micros / 1000;
  const nps = ms > 0 ? (nodes / ms) * 1000 : 0;
  if (fromCache) {
    engineLine.textContent = "cache hit";
    return;
  }
  if (nodes === 0 && !timedOut) {
    engineLine.textContent = "instant (opening / book)";
    return;
  }
  const src = bookOn ? "search" : "search (no book)";
  engineLine.textContent = timedOut
    ? `Timed out after ${ms.toFixed(0)} ms · ${nodes.toLocaleString()} nodes (result not proven)`
    : `${src}: ${nodes.toLocaleString()} nodes in ${ms < 10 ? ms.toFixed(1) : ms.toFixed(0)} ms` +
      (nps ? ` · ${(nps / 1000).toFixed(0)} kn/s` : "");
}

backBtn.addEventListener("click", () => {
  if (cursor === 0) return;
  cursor--;
  scores = null;
  analyzing = analyzeChk.checked && engineReady;
  writeMovesToLocation(played());
  renderBoard(false);
  if (analyzing) engineLine.textContent = "analyzing…";
  afterChange();
});

fwdBtn.addEventListener("click", () => {
  if (cursor >= history.length) return;
  lastDropIndex = cursor;
  cursor++;
  scores = null;
  analyzing = analyzeChk.checked && engineReady;
  writeMovesToLocation(played());
  renderBoard(true);
  if (analyzing) engineLine.textContent = "analyzing…";
  afterChange();
});

newBtn.addEventListener("click", () => {
  history.length = 0;
  cursor = 0;
  scores = null;
  analyzing = analyzeChk.checked && engineReady;
  writeMovesToLocation([]);
  renderBoard(false);
  if (analyzing) engineLine.textContent = "analyzing…";
  afterChange();
});

analyzeChk.addEventListener("change", () => {
  if (analyzeChk.checked) void requestAnalyze();
  else {
    scoresEl.hidden = true;
    renderBoard(false);
  }
});

bookChk.addEventListener("change", () => {
  bookOn = bookChk.checked;
  if (!engineReady) return;
  if (bookOn) {
    void send({
      type: "init",
      bookUrl: new URL("books/opening.c4book", document.baseURI).href,
      timeoutMs,
    }).then(onReady);
  } else {
    void send({ type: "clearBook" });
    engineLine.textContent = "Opening book off. Deep positions will take longer.";
  }
});

delay.addEventListener("input", () => {
  delayMs = Number(delay.value);
  delayLabel.textContent = `${delayMs} ms`;
});

pauseBtn.addEventListener("click", () => {
  paused = !paused;
  renderBoard(false);
  if (!paused) scheduleComputer();
});

copyBtn.addEventListener("click", async () => {
  writeMovesToLocation(played());
  try {
    await navigator.clipboard.writeText(location.href);
    copyBtn.textContent = "Copied";
    setTimeout(() => (copyBtn.textContent = "Copy link"), 1200);
  } catch {
    copyBtn.textContent = "Copy the address bar";
  }
});

document.querySelectorAll<HTMLInputElement>('input[name="role0"]').forEach((el) => {
  el.addEventListener("change", () => {
    roles[0] = el.value as Role;
    scheduleComputer();
    renderBoard(false);
  });
});
document.querySelectorAll<HTMLInputElement>('input[name="role1"]').forEach((el) => {
  el.addEventListener("change", () => {
    roles[1] = el.value as Role;
    scheduleComputer();
    renderBoard(false);
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

function onReady(r: WorkerRes): void {
  if (r.type !== "ready") {
    engineLine.textContent = r.type === "error" ? `Solver failed: ${r.message}` : "Solver failed";
    return;
  }
  engineReady = true;
  engineLine.textContent =
    r.bookLen > 0
      ? `Solver ready · opening book ${r.bookLen} positions (depth ${r.bookDepth})`
      : "Solver ready · no opening book loaded";
  afterChange();
}

const fromUrl = readMovesFromLocation();
if (fromUrl) {
  history.push(...fromUrl);
  cursor = history.length;
}

renderBoard(false);

void send({
  type: "init",
  bookUrl: new URL("books/opening.c4book", document.baseURI).href,
  timeoutMs: new URLSearchParams(location.search).has("bench") ? 0 : timeoutMs,
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
