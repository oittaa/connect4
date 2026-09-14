#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import init, { WasmEngine } from "../web/src/pkg/engine.js";

const moveBookPath = process.argv[2] ?? "books/10ply.c4move";
const wasmPath = "web/src/pkg/engine_bg.wasm";
const wasm = await init({ module_or_path: await readFile(wasmPath) });
const engine = new WasmEngine();
const beforeBytes = wasm.memory.buffer.byteLength;
const moveBook = new Uint8Array(await readFile(moveBookPath));
const loadStarted = performance.now();
if (!engine.loadMoveBook(moveBook)) throw new Error("move book was rejected");
const loadMillis = performance.now() - loadStarted;
const afterBytes = wasm.memory.buffer.byteLength;

const cases = [
  ["44444222", [3, 3, 3, 3, 3, 1, 1, 1]],
  ["76316366", [6, 5, 2, 0, 5, 2, 5, 5]],
  ["123456712", [0, 1, 2, 3, 4, 5, 6, 0, 1]],
  ["1234567123", [0, 1, 2, 3, 4, 5, 6, 0, 1, 2]],
];
const iterations = 100_000;
let checksum = 0;
const lookupStarted = performance.now();
for (let index = 0; index < iterations; index++) {
  const [, moves] = cases[index % cases.length];
  checksum += engine.bestMove(Uint8Array.from(moves));
  if (!engine.moveBookHit() || engine.nodeCount() !== 0 || engine.timedOut()) {
    throw new Error(`non-instant move-book result at iteration ${index}`);
  }
}
const lookupMillis = performance.now() - lookupStarted;

console.log(
  JSON.stringify(
    {
      fileBytes: moveBook.byteLength,
      populated: engine.moveBookPopulated(),
      depth: engine.moveBookDepth(),
      loadMillis,
      wasmMemoryBeforeBytes: beforeBytes,
      wasmMemoryAfterBytes: afterBytes,
      wasmMemoryGrowthBytes: afterBytes - beforeBytes,
      lookupIterations: iterations,
      lookupMillis,
      lookupMicrosEach: (lookupMillis * 1000) / iterations,
      checksum,
    },
    null,
    2,
  ),
);
