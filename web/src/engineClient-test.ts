// Worker transport checks. Run: npm test

import { createEngineClient, WORKER_REPLACED, isBlockingCompute, isWorkerReplaced, type EnginePort } from "./engineClient.ts";
import type { WorkerReq, WorkerRes } from "./engineProtocol.ts";

const SOLVER_TRANSPORT_ERROR = "The solver stopped unexpectedly.";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function same(got: unknown, expected: unknown, msg: string): void {
  assert(JSON.stringify(got) === JSON.stringify(expected), `${msg}: got ${JSON.stringify(got)}`);
}

function stub(): EnginePort & {
  posted: WorkerReq[];
  deliver(data: WorkerRes): void;
} {
  const port: EnginePort & { posted: WorkerReq[]; deliver(data: WorkerRes): void } = {
    posted: [],
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage(message) {
      this.posted.push(message);
    },
    deliver(data) {
      this.onmessage?.({ data });
    },
  };
  return port;
}

function ready(id: number): WorkerRes {
  return {
    id,
    type: "ready",
    scoreBookLen: 1,
    scoreBookMoves: 4,
    moveBookPopulated: 0,
    moveBookMoves: 0,
  };
}

{
  const port = stub();
  port.postMessage = function postMessage(message: WorkerReq): void {
    this.posted.push(message);
    this.deliver({ id: message.id, type: "error", message: "immediate" });
  };
  const client = createEngineClient(port);
  const r = await client.request({ type: "init", timeoutMs: 0 });
  same(r, { id: 1, type: "error", message: "immediate" }, "register pending before post");
}

{
  const port = stub();
  const client = createEngineClient(port);
  const scoreP = client.request({
    type: "loadScoreBook",
    bytes: new ArrayBuffer(0),
  });
  const moveP = client.request({
    type: "loadMoveBook",
    bytes: new ArrayBuffer(0),
  });
  same(
    port.posted.map((m) => [m.id, m.type]),
    [
      [1, "loadScoreBook"],
      [2, "loadMoveBook"],
    ],
    "both book requests stay pending",
  );
  port.deliver(ready(2));
  port.deliver(ready(1));
  const [score, move] = await Promise.all([scoreP, moveP]);
  assert(score.type === "ready" && score.id === 1, "score book matches id 1");
  assert(move.type === "ready" && move.id === 2, "move book matches id 2");
}

{
  const port = stub();
  const client = createEngineClient(port);
  const p = client.request({ type: "analyze", moves: [] });
  port.deliver({ id: port.posted[0].id, type: "error", message: "analysis failed" });
  const r = await p;
  same(r, { id: 1, type: "error", message: "analysis failed" }, "error replies resolve");
}

{
  const port = stub();
  const client = createEngineClient(port);
  const first = client.request({ type: "init", timeoutMs: 0 });
  const id = port.posted[0].id;
  port.deliver(ready(id));
  port.deliver({ id, type: "error", message: "duplicate" });
  const r = await first;
  assert(r.type === "ready", "first matching reply wins");
  const second = client.request({ type: "clearDownloadedBooks" });
  port.deliver({ id: 999, type: "error", message: "unknown" });
  port.deliver(ready(port.posted[1].id));
  const later = await second;
  assert(later.type === "ready" && later.id === 2, "unknown and duplicate ids are ignored");
}

{
  const port = stub();
  const failures: string[] = [];
  const client = createEngineClient(port, { onFailure: (d) => failures.push(d) });
  const initP = client.request({ type: "init", timeoutMs: 0 });
  const analyzeP = client.request({ type: "analyze", moves: [] });
  const scoreBookP = client.request({
    type: "loadScoreBook",
    bytes: new ArrayBuffer(0),
  });
  port.onerror?.({ message: "import failed" });
  port.onerror?.({ message: "second" });
  const [init, analyze, scoreBook] = await Promise.all([initP, analyzeP, scoreBookP]);
  same(init, { id: 1, type: "error", message: SOLVER_TRANSPORT_ERROR }, "error event settles init");
  same(analyze, { id: 2, type: "error", message: SOLVER_TRANSPORT_ERROR }, "error event settles analyze");
  same(scoreBook, { id: 3, type: "error", message: SOLVER_TRANSPORT_ERROR }, "error event settles score-book load");
  same(failures, ["import failed"], "onFailure runs once with the event detail");
  const posted = port.posted.length;
  const later = await client.request({ type: "bestMove", moves: [] });
  same(later, { id: 4, type: "error", message: SOLVER_TRANSPORT_ERROR }, "later request fails promptly");
  assert(port.posted.length === posted, "failed worker does not post again");
}

{
  const port = stub();
  const failures: string[] = [];
  const client = createEngineClient(port, { onFailure: (d) => failures.push(d) });
  const p = client.request({ type: "bestMove", moves: [3] });
  const id = port.posted[0].id;
  port.onmessageerror?.({});
  const r = await p;
  same(r, { id: 1, type: "error", message: SOLVER_TRANSPORT_ERROR }, "messageerror settles pending");
  same(failures, [SOLVER_TRANSPORT_ERROR], "messageerror notifies onFailure once");
  port.deliver({
    id,
    type: "moved",
    col: 3,
    moveScores: null,
    hintScores: [],
    nodes: 0,
    micros: 0,
    timedOut: false,
    fromMoveBook: false,
  });
  const late = await client.request({ type: "analyze", moves: [] });
  assert(late.type === "error", "late moved after messageerror does not revive the client");
  assert(failures.length === 1, "obsolete worker callback does not notify again");
}

{
  const port = stub();
  const failures: string[] = [];
  const client = createEngineClient(port, { onFailure: (d) => failures.push(d) });
  port.postMessage = () => {
    throw new Error("DataCloneError");
  };
  const r = await client.request({ type: "init", timeoutMs: 0 });
  same(r, { id: 1, type: "error", message: "DataCloneError" }, "postMessage throw settles that request");
  assert(failures.length === 0, "a posting failure is not a worker-wide crash");
  port.postMessage = function postMessage(message: WorkerReq): void {
    this.posted.push(message);
  };
  const p = client.request({ type: "analyze", moves: [] });
  assert(port.posted[0]?.type === "analyze", "later request still posts after a clone error");
  port.deliver({ id: port.posted[0].id, type: "error", message: "analysis failed" });
  const later = await p;
  assert(later.type === "error" && later.message === "analysis failed", "worker still usable");
}

{
  const port = stub();
  const failures: string[] = [];
  const client = createEngineClient(port, { onFailure: (d) => failures.push(d) });
  client.fail("init failed");
  assert(failures.length === 0, "fail() does not treat an ordinary init error as transport failure");
  const r = await client.request({ type: "analyze", moves: [] });
  same(r, { id: 1, type: "error", message: "init failed" }, "fail() makes future requests fail without posting");
  assert(port.posted.length === 0, "fail() does not post");
}

assert(isWorkerReplaced({ id: 0, type: "error", message: WORKER_REPLACED }), "replaced error is recognized");
assert(!isWorkerReplaced({ id: 1, type: "error", message: SOLVER_TRANSPORT_ERROR }), "transport error is not a replace");

assert(isBlockingCompute("analyze"), "analyze blocks the worker");
assert(isBlockingCompute("bestMove"), "bestMove blocks the worker");
assert(!isBlockingCompute("init"), "init is not a blocking search");
assert(!isBlockingCompute("loadScoreBook"), "score-book load is not a blocking search");
assert(!isBlockingCompute("availableScores"), "score peek is not a blocking search");

{
  const port = stub();
  const client = createEngineClient(port);
  const p = client.request({ type: "analyze", moves: [] });
  assert(client.hasPendingCompute(), "analyze is pending compute");
  port.deliver({ id: port.posted[0].id, type: "error", message: "analysis failed" });
  await p;
  assert(!client.hasPendingCompute(), "compute pending clears after reply");
}

{
  const port = stub();
  const client = createEngineClient(port);
  const scoreBookP = client.request({
    type: "loadScoreBook",
    bytes: new ArrayBuffer(0),
  });
  assert(!client.hasPendingCompute(), "book load is not pending compute");
  const analyzeP = client.request({ type: "analyze", moves: [] });
  assert(client.hasPendingCompute(), "analyze behind a book fetch is still pending compute");
  client.fail(WORKER_REPLACED);
  const [scoreBook, analyze] = await Promise.all([scoreBookP, analyzeP]);
  assert(scoreBook.type === "error" && scoreBook.message === WORKER_REPLACED, "replace settles book");
  assert(analyze.type === "error" && analyze.message === WORKER_REPLACED, "replace settles analyze");
  assert(!client.hasPendingCompute(), "failed client has no pending compute");
}

console.log("engine client checks ok");
