/// <reference lib="webworker" />
/// <reference types="vite/client" />

import { cacheLoad, cacheSave } from "./cache";
import type { WorkerReq, WorkerRes } from "./engineProtocol";
import { bestCols, completeMoveScores } from "./game";
import type { WasmEngine } from "./pkg/engine.js";

let engine: WasmEngine | null = null;

async function boot(): Promise<WasmEngine> {
  const wasm = await import("./pkg/engine.js");
  const wasmUrl = (await import("./pkg/engine_bg.wasm?url")).default;
  await wasm.default({ module_or_path: wasmUrl });
  return new wasm.WasmEngine();
}

function u8(moves: number[]): Uint8Array {
  return Uint8Array.from(moves);
}

let persistTimer = 0;
let persisting: Promise<void> = Promise.resolve();

function schedulePersist(eng: WasmEngine): void {
  self.clearTimeout(persistTimer);
  persistTimer = self.setTimeout(() => {
    persisting = persisting.then(() => flush(eng)).catch((e) => {
      console.error("proven cache save failed", e);
    });
  }, 500);
}

async function withCacheLock(fn: () => Promise<void>): Promise<void> {
  const locks = (self as DedicatedWorkerGlobalScope).navigator.locks;
  if (locks) await locks.request("c4-proven", fn);
  else await fn();
}

async function flush(eng: WasmEngine): Promise<void> {
  await withCacheLock(async () => {
    const disk = await cacheLoad();
    if (disk && disk.length >= 12) eng.cacheLoad(disk);
    if (eng.cacheLen() === 0) return;
    await cacheSave(new Uint8Array(eng.cacheSave()));
  });
}

async function loadPersisted(eng: WasmEngine): Promise<void> {
  // Startup is a pure read, so it must not take the "c4-proven" write lock:
  // locks.request() has no timeout, so another tab holding it mid-flush would
  // stall this worker's "ready" reply indefinitely. The IndexedDB open in
  // cacheLoad() is itself bounded (OPEN_MS), and a concurrent flush only ever
  // grows/merges the blob, so an unlocked read is safe.
  const buf = await cacheLoad();
  if (buf && buf.length >= 12) eng.cacheLoad(buf);
}

/** Proven cache hit with seven column scores (`[score, c0..c6]`). */
function readHit(hit: Int16Array): number[] | undefined {
  if (hit.length < 8) return;
  return Array.from(hit.subarray(1, 8));
}

function ready(id: number, eng: WasmEngine): WorkerRes {
  return {
    id,
    type: "ready",
    scoreBookLen: eng.scoreBookLen(),
    scoreBookMoves: eng.scoreBookMoves(),
    moveBookPopulated: eng.moveBookPopulated(),
    moveBookMoves: eng.moveBookMoves(),
  };
}

self.onmessage = async (ev: MessageEvent<WorkerReq>) => {
  const msg = ev.data;
  const reply = (r: WorkerRes) => (self as DedicatedWorkerGlobalScope).postMessage(r);
  try {
    if (msg.type === "init") {
      if (!engine) engine = await boot();
      engine.setTimeoutMs(msg.timeoutMs);
      await loadPersisted(engine);
      reply(ready(msg.id, engine));
      return;
    }
    if (!engine) {
      reply({ id: msg.id, type: "error", message: "engine not ready" });
      return;
    }
    switch (msg.type) {
      case "loadScoreBook":
        if (!engine.loadScoreBook(new Uint8Array(msg.bytes))) throw new Error("Invalid score book");
        reply(ready(msg.id, engine));
        break;
      case "loadMoveBook":
        if (!engine.loadMoveBook(new Uint8Array(msg.bytes))) throw new Error("Invalid move book");
        reply(ready(msg.id, engine));
        break;
      case "clearDownloadedBooks":
        engine.clearScoreBook();
        engine.clearMoveBook();
        reply(ready(msg.id, engine));
        break;
      case "availableScores": {
        // Read-only hints for active computers, including JS-only Easy moves.
        const moves = u8(msg.moves);
        const hit = readHit(engine.cacheGet(moves));
        const cached = hit ? completeMoveScores(hit, msg.moves) : null;
        reply({
          id: msg.id,
          type: "availableScores",
          scores: cached ?? Array.from(engine.knownColumnScores(moves)),
        });
        break;
      }
      case "analyze": {
        const moves = u8(msg.moves);
        const hit = readHit(engine.cacheGet(moves));
        if (hit) {
          reply({
            id: msg.id,
            type: "analyzed",
            scores: hit,
            nodes: 0,
            micros: 0,
            timedOut: false,
            fromCache: true,
          });
          break;
        }
        const raw = Array.from(engine.analyze(moves));
        const nodes = engine.nodeCount();
        const micros = engine.micros();
        const timedOut = engine.timedOut();
        schedulePersist(engine);
        reply({
          id: msg.id,
          type: "analyzed",
          scores: raw,
          nodes,
          micros,
          timedOut,
          fromCache: false,
        });
        break;
      }
      case "bestMove": {
        const moves = u8(msg.moves);
        const hit = readHit(engine.cacheGet(moves));
        const cached = hit ? completeMoveScores(hit, msg.moves) : null;
        if (cached) {
          reply({
            id: msg.id,
            type: "moved",
            col: bestCols(cached)[0] ?? 255,
            moveScores: cached,
            hintScores: cached,
            nodes: 0,
            micros: 0,
            timedOut: false,
            fromCache: true,
            fromMoveBook: false,
          });
          break;
        }
        const col = engine.bestMove(moves);
        const nodes = engine.nodeCount();
        const micros = nodes === 0 ? 0 : engine.micros();
        const timedOut = engine.timedOut();
        const fromMoveBook = engine.moveBookHit();
        if (!fromMoveBook) schedulePersist(engine);
        reply({
          id: msg.id,
          type: "moved",
          col,
          moveScores: completeMoveScores(engine.scoreBookColumnScores(moves), msg.moves),
          hintScores: Array.from(engine.knownColumnScores(moves)),
          nodes,
          micros,
          timedOut,
          fromCache: false,
          fromMoveBook,
        });
        break;
      }
    }
  } catch (e) {
    reply({
      id: msg.id,
      type: "error",
      message: e instanceof Error ? e.message : String(e),
    });
  }
};
