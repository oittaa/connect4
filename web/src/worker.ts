/// <reference lib="webworker" />
/// <reference types="vite/client" />

import { loadTT, saveTT } from "./cache";
import { NO_COLUMN, type WorkerReq, type WorkerRes } from "./engineProtocol";
import { completeMoveScores } from "./game";
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

/** Best-effort restore; a miss or any failure just starts with an empty table. */
async function restoreTT(eng: WasmEngine): Promise<void> {
  try {
    const buf = await loadTT();
    if (buf) eng.ttLoad(buf);
  } catch (e) {
    console.error("TT restore failed", e);
  }
}

/** Called once per finished game, not after every search. */
async function persistTT(eng: WasmEngine): Promise<void> {
  try {
    await saveTT(eng.ttSave());
  } catch (e) {
    console.error("TT save failed", e);
  }
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
      await restoreTT(engine);
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
        // Read-only hints for active computers, including JS-only Easy moves:
        // one preview call holds the search-free scores, the move-book
        // suggestion, and a certified column (immediate win or scored book hit).
        const preview = Array.from(engine.previewScores(u8(msg.moves)));
        reply({
          id: msg.id,
          type: "availableScores",
          scores: preview.slice(0, 7),
          moveBookCol: preview[7] ?? NO_COLUMN,
          provenCol: preview[8] ?? NO_COLUMN,
        });
        break;
      }
      case "analyze": {
        // Always scores every legal column. The instant certified answer, if
        // any, already went out with the preview; this reply only fills in
        // the rest.
        const moves = u8(msg.moves);
        const raw = Array.from(engine.analyze(moves));
        reply({
          id: msg.id,
          type: "analyzed",
          scores: raw,
          nodes: engine.nodeCount(),
          micros: engine.micros(),
          timedOut: engine.timedOut(),
        });
        break;
      }
      case "bestMove": {
        const moves = u8(msg.moves);
        const col = engine.bestMove(moves);
        const nodes = engine.nodeCount();
        const micros = nodes === 0 ? 0 : engine.micros();
        reply({
          id: msg.id,
          type: "moved",
          col,
          moveScores: completeMoveScores(engine.scoreBookColumnScores(moves), msg.moves),
          hintScores: Array.from(engine.hintScores(moves)),
          nodes,
          micros,
          timedOut: engine.timedOut(),
          fromMoveBook: engine.moveBookHit(),
        });
        break;
      }
      case "saveTT":
        await persistTT(engine);
        reply({ id: msg.id, type: "ttSaved" });
        break;
    }
  } catch (e) {
    reply({
      id: msg.id,
      type: "error",
      message: e instanceof Error ? e.message : String(e),
    });
  }
};
