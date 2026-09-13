/// <reference lib="webworker" />
/// <reference types="vite/client" />

import { cacheLoad, cacheSave } from "./cache";

export type WorkerReq =
  | { id: number; type: "init"; bookUrl?: string; timeoutMs: number }
  | { id: number; type: "loadBook"; bytes: ArrayBuffer }
  | { id: number; type: "clearBook" }
  | { id: number; type: "setTimeout"; ms: number }
  | { id: number; type: "solve"; moves: number[] }
  | { id: number; type: "analyze"; moves: number[] }
  | { id: number; type: "bestMove"; moves: number[] };

export type WorkerRes =
  | { id: number; type: "ready"; bookLen: number; bookDepth: number }
  | {
      id: number;
      type: "solved";
      score: number;
      nodes: number;
      micros: number;
      timedOut: boolean;
      fromCache: boolean;
      key: string;
    }
  | {
      id: number;
      type: "analyzed";
      scores: number[];
      nodes: number;
      micros: number;
      timedOut: boolean;
      fromCache: boolean;
      key: string;
    }
  | {
      id: number;
      type: "moved";
      col: number;
      scores: number[];
      nodes: number;
      micros: number;
      timedOut: boolean;
      fromCache: boolean;
      key: string;
    }
  | { id: number; type: "error"; message: string };

type Engine = {
  solve(moves: Uint8Array): number;
  analyze(moves: Uint8Array): Int16Array;
  bestMove(moves: Uint8Array): number;
  key(moves: Uint8Array): string | undefined;
  nodeCount(): number;
  timedOut(): boolean;
  micros(): number;
  loadBook(data: Uint8Array): boolean;
  clearBook(): void;
  setTimeoutMs(ms: number): void;
  resetTt(): void;
  bookLen(): number;
  bookDepth(): number;
  cacheGet(moves: Uint8Array): Int16Array;
  cacheLoad(data: Uint8Array): boolean;
  cacheSave(): Uint8Array;
  cacheLen(): number;
};

let engine: Engine | null = null;
let bookEnabled = true;

async function boot(): Promise<Engine> {
  const wasm = await import("./pkg/engine.js");
  const wasmUrl = (await import("./pkg/engine_bg.wasm?url")).default;
  await wasm.default({ module_or_path: wasmUrl });
  return new wasm.WasmEngine() as unknown as Engine;
}

function u8(moves: number[]): Uint8Array {
  return Uint8Array.from(moves);
}

let persistTimer = 0;
let persisting: Promise<void> = Promise.resolve();

function schedulePersist(eng: Engine): void {
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

async function flush(eng: Engine): Promise<void> {
  await withCacheLock(async () => {
    const disk = await cacheLoad();
    if (disk && disk.length >= 12) eng.cacheLoad(disk);
    if (eng.cacheLen() === 0) return;
    await cacheSave(new Uint8Array(eng.cacheSave()));
  });
}

async function loadPersisted(eng: Engine): Promise<void> {
  await withCacheLock(async () => {
    const buf = await cacheLoad();
    if (buf && buf.length >= 12) eng.cacheLoad(buf);
  });
}

function readHit(
  hit: Int16Array,
  needCols: boolean,
): { score: number; scores?: number[] } | undefined {
  if (hit.length < 1) return;
  if (needCols && hit.length < 8) return;
  return {
    score: hit[0],
    scores: hit.length >= 8 ? Array.from(hit.subarray(1, 8)) : undefined,
  };
}

async function maybeLoadDefaultBook(eng: Engine, url?: string): Promise<void> {
  if (!url) return;
  try {
    const res = await fetch(url);
    if (!res.ok) return;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (!eng.loadBook(buf)) {
      console.error("opening book failed to load", url, buf.length);
    }
  } catch (e) {
    console.error("opening book fetch failed", url, e);
  }
}

self.onmessage = async (ev: MessageEvent<WorkerReq>) => {
  const msg = ev.data;
  const reply = (r: WorkerRes) => (self as DedicatedWorkerGlobalScope).postMessage(r);
  try {
    if (msg.type === "init") {
      if (!engine) engine = await boot();
      engine.setTimeoutMs(msg.timeoutMs);
      await Promise.all([loadPersisted(engine), maybeLoadDefaultBook(engine, msg.bookUrl)]);
      bookEnabled = true;
      reply({
        id: msg.id,
        type: "ready",
        bookLen: engine.bookLen(),
        bookDepth: engine.bookDepth(),
      });
      return;
    }
    if (!engine) {
      reply({ id: msg.id, type: "error", message: "engine not ready" });
      return;
    }
    switch (msg.type) {
      case "loadBook":
        engine.loadBook(new Uint8Array(msg.bytes));
        reply({
          id: msg.id,
          type: "ready",
          bookLen: engine.bookLen(),
          bookDepth: engine.bookDepth(),
        });
        break;
      case "clearBook":
        engine.clearBook();
        bookEnabled = false;
        reply({
          id: msg.id,
          type: "ready",
          bookLen: engine.bookLen(),
          bookDepth: engine.bookDepth(),
        });
        break;
      case "setTimeout":
        engine.setTimeoutMs(msg.ms);
        break;
      case "solve": {
        const moves = u8(msg.moves);
        const key = engine.key(moves) ?? "";
        const hit = readHit(engine.cacheGet(moves), false);
        if (hit) {
          reply({
            id: msg.id,
            type: "solved",
            score: hit.score,
            nodes: 0,
            micros: 0,
            timedOut: false,
            fromCache: true,
            key,
          });
          break;
        }
        const score = engine.solve(moves);
        const nodes = engine.nodeCount();
        const micros = engine.micros();
        const timedOut = engine.timedOut();
        schedulePersist(engine);
        reply({
          id: msg.id,
          type: "solved",
          score,
          nodes,
          micros,
          timedOut,
          fromCache: false,
          key,
        });
        break;
      }
      case "analyze": {
        const moves = u8(msg.moves);
        const key = engine.key(moves) ?? "";
        const hit = readHit(engine.cacheGet(moves), true);
        if (hit?.scores) {
          reply({
            id: msg.id,
            type: "analyzed",
            scores: hit.scores,
            nodes: 0,
            micros: 0,
            timedOut: false,
            fromCache: true,
            key,
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
          key,
        });
        break;
      }
      case "bestMove": {
        const moves = u8(msg.moves);
        const key = engine.key(moves) ?? "";
        const hit = readHit(engine.cacheGet(moves), true);
        if (hit?.scores) {
          let col = 255;
          let best = -Infinity;
          hit.scores.forEach((s, i) => {
            if (s !== -1000 && s > best) {
              best = s;
              col = i;
            }
          });
          reply({
            id: msg.id,
            type: "moved",
            col,
            scores: hit.scores,
            nodes: 0,
            micros: 0,
            timedOut: false,
            fromCache: true,
            key,
          });
          break;
        }
        const col = engine.bestMove(moves);
        const nodes = engine.nodeCount();
        const micros = nodes === 0 ? 0 : engine.micros();
        const timedOut = engine.timedOut();
        schedulePersist(engine);
        reply({
          id: msg.id,
          type: "moved",
          col,
          scores: [],
          nodes,
          micros,
          timedOut,
          fromCache: false,
          key,
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

void bookEnabled;
