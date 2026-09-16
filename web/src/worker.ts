/// <reference lib="webworker" />
/// <reference types="vite/client" />

import { loadTT, saveTT } from "./cache";
import type { WorkerReq, WorkerRes } from "./engineProtocol";
import { completeMoveScores, INVALID } from "./game";
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

/** Column scores from the just-completed bestMove search, filled in with
 * known/immediate-win columns it did not need to visit. Neither call searches. */
function bestMoveHintScores(eng: WasmEngine, moves: Uint8Array): number[] {
  const known = Array.from(eng.knownColumnScores(moves));
  const last = eng.lastMoveScores();
  return known.map((k, i) => (last[i] !== INVALID ? last[i] : k));
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
        // Read-only hints for active computers, including JS-only Easy moves.
        const moves = u8(msg.moves);
        reply({
          id: msg.id,
          type: "availableScores",
          scores: Array.from(engine.knownColumnScores(moves)),
        });
        break;
      }
      case "analyze": {
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
        const last = engine.lastMoveScores();
        reply({
          id: msg.id,
          type: "moved",
          col,
          moveScores: completeMoveScores(engine.scoreBookColumnScores(moves), msg.moves),
          hintScores: bestMoveHintScores(engine, moves),
          nodes,
          micros,
          timedOut: engine.timedOut(),
          origin: engine.moveOrigin() || "search",
          score: col >= 0 && col < last.length && last[col] !== INVALID ? last[col] : null,
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
