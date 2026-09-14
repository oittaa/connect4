// Worker replace/send. Run: npm test
//
// Holds replacement `init` pending while the session navigates or changes
// roles, then checks that captured compute is discarded and the latest
// session is replanned after books are restored.

import { createEngineClient, WORKER_REPLACED, type EnginePort } from "./engineClient.ts";
import type { WorkerReq, WorkerRes } from "./engineProtocol.ts";
import { createWorkerReplace, type SpawnedWorker, type WorkerReplaceHost } from "./workerReplace.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function same(got: unknown, expected: unknown, msg: string): void {
  assert(JSON.stringify(got) === JSON.stringify(expected), `${msg}: got ${JSON.stringify(got)}`);
}

function ready(id: number): WorkerRes {
  return {
    id,
    type: "ready",
    bookLen: 8,
    bookDepth: 8,
    moveBookPopulated: 12,
    moveBookDepth: 8,
  };
}

type MockWorker = SpawnedWorker & {
  posted: WorkerReq[];
  terminateCount: number;
  pendingInit: number | null;
  releaseInit(): void;
};

type Session = {
  moves: number[];
  role: "human" | "perfect";
};

function mockWorkers(): { spawn: () => SpawnedWorker; workers: MockWorker[] } {
  const workers: MockWorker[] = [];
  return {
    workers,
    spawn(): SpawnedWorker {
      const posted: WorkerReq[] = [];
      let pendingInit: number | null = null;
      const port: EnginePort = {
        onmessage: null,
        onerror: null,
        onmessageerror: null,
        postMessage(message: WorkerReq) {
          posted.push(message);
          if (message.type === "init") {
            pendingInit = message.id;
            worker.pendingInit = message.id;
            return;
          }
          if (message.type === "loadScoreBook" || message.type === "loadMoveBook") {
            this.onmessage?.({ data: ready(message.id) });
          }
        },
      };
      const worker: MockWorker = {
        posted,
        terminateCount: 0,
        pendingInit: null,
        client: createEngineClient(port),
        terminate() {
          worker.terminateCount++;
        },
        releaseInit() {
          if (pendingInit === null) throw new Error("init is not pending");
          const id = pendingInit;
          pendingInit = null;
          worker.pendingInit = null;
          port.onmessage?.({ data: ready(id) });
        },
      };
      workers.push(worker);
      return worker;
    },
  };
}

async function microtasks(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

function analyzeMoves(worker: MockWorker): number[][] {
  return worker.posted
    .filter((m): m is Extract<WorkerReq, { type: "analyze" }> => m.type === "analyze")
    .map((m) => m.moves);
}

function bestMoveMoves(worker: MockWorker): number[][] {
  return worker.posted
    .filter((m): m is Extract<WorkerReq, { type: "bestMove" }> => m.type === "bestMove")
    .map((m) => m.moves);
}

function computeTypes(worker: MockWorker): WorkerReq["type"][] {
  return worker.posted
    .filter((m) => m.type === "analyze" || m.type === "bestMove" || m.type === "solve")
    .map((m) => m.type);
}

function harness(replan: "session" | "none" = "session") {
  const mocks = mockWorkers();
  const session: Session = { moves: inflight.slice(), role: "human" };
  const order: string[] = [];
  const readySnapshots: Session[] = [];
  const box: { ctrl: ReturnType<typeof createWorkerReplace> | null } = { ctrl: null };
  const host: WorkerReplaceHost = {
    spawn: mocks.spawn,
    initTimeoutMs: () => 12_000,
    onReplaceStart() {
      order.push("unready");
    },
    async restoreBooks(client) {
      order.push("books-start");
      const score = await client.request({ type: "loadScoreBook", bytes: new ArrayBuffer(4) });
      const move = await client.request({ type: "loadMoveBook", bytes: new ArrayBuffer(4) });
      assert(score.type === "ready", "score book restored");
      assert(move.type === "ready", "move book restored");
      order.push("books-done");
    },
    afterReady() {
      order.push("ready");
      readySnapshots.push({ moves: session.moves.slice(), role: session.role });
      if (replan === "none" || !box.ctrl) return;
      if (session.role === "perfect") {
        void box.ctrl.send({ type: "bestMove", moves: session.moves });
      } else {
        void box.ctrl.send({ type: "analyze", moves: session.moves });
      }
    },
    onInitFailure() {
      order.push("fail");
    },
    isEngineFailed: () => false,
  };
  box.ctrl = createWorkerReplace(host);
  return { mocks, session, order, readySnapshots, ctrl: box.ctrl };
}

const inflight = [3, 3, 3, 3, 3, 1, 1, 1];
const afterBack = inflight.slice(0, -1);

{
  const { mocks, session, order, readySnapshots, ctrl } = harness();
  const first = ctrl.send({ type: "analyze", moves: inflight.slice() });
  await microtasks();
  assert(mocks.workers.length === 1, "first analyze uses the original worker");
  same(analyzeMoves(mocks.workers[0]), [inflight], "original analyze is posted");
  assert(ctrl.client().hasPendingCompute(), "original analyze is still pending");

  const back = ctrl.send({ type: "analyze", moves: afterBack });
  await microtasks();
  assert(mocks.workers.length === 2, "a second compute while busy replaces the worker");
  assert(mocks.workers[0].terminateCount === 1, "the busy worker is terminated");
  same(
    mocks.workers[1].posted.map((m) => m.type),
    ["init"],
    "replacement posts init and holds it",
  );
  assert(mocks.workers[1].pendingInit !== null, "replacement init is pending");
  same(order, ["unready"], "books and afterReady wait on init");

  session.moves = [];
  session.role = "perfect";
  mocks.workers[1].releaseInit();
  const backReply = await back;
  same(backReply, { id: 0, type: "error", message: WORKER_REPLACED }, "captured Back analyze is discarded");
  const firstReply = await first;
  assert(
    firstReply.type === "error" && firstReply.message === WORKER_REPLACED,
    "in-flight analyze settles as replaced",
  );

  await microtasks(20);
  same(order, ["unready", "books-start", "books-done", "ready"], "books restore before afterReady");
  same(readySnapshots, [{ moves: [], role: "perfect" }], "afterReady sees New + Perfect, not the Back position");
  same(analyzeMoves(mocks.workers[1]), [], "replacement does not post the captured analyze");
  same(bestMoveMoves(mocks.workers[1]), [[]], "afterReady posts Perfect for the latest session");
  same(
    mocks.workers[1].posted.map((m) => m.type),
    ["init", "loadScoreBook", "loadMoveBook", "bestMove"],
    "compute is posted only after init and retained books",
  );
}

{
  const { mocks, session, readySnapshots, ctrl } = harness();
  void ctrl.send({ type: "analyze", moves: inflight.slice() });
  await microtasks();
  const nav = ctrl.send({ type: "analyze", moves: afterBack });
  await microtasks();
  assert(mocks.workers[1].pendingInit !== null, "init held during navigation");
  session.moves = [];
  mocks.workers[1].releaseInit();
  const navReply = await nav;
  assert(navReply.type === "error" && navReply.message === WORKER_REPLACED, "New's captured analyze is discarded");
  await microtasks(20);
  same(readySnapshots, [{ moves: [], role: "human" }], "afterReady sees New after Back during held init");
  same(analyzeMoves(mocks.workers[1]), [[]], "replanned analyze is the empty board");
}

{
  const { mocks, order, ctrl } = harness("none");
  void ctrl.send({ type: "analyze", moves: inflight.slice() });
  await microtasks();
  const second = ctrl.send({ type: "bestMove", moves: inflight.slice() });
  const third = ctrl.send({ type: "analyze", moves: [] });
  await microtasks();
  assert(mocks.workers.length === 2, "rapid sends coalesce onto one replacement");
  mocks.workers[1].releaseInit();
  const [a, b] = await Promise.all([second, third]);
  assert(a.type === "error" && a.message === WORKER_REPLACED, "second send is discarded");
  assert(b.type === "error" && b.message === WORKER_REPLACED, "third send is discarded");
  await microtasks(10);
  same(computeTypes(mocks.workers[1]), [], "no-op afterReady posts no captured compute");
  same(order, ["unready", "books-start", "books-done", "ready"], "one replace cycle");
}

console.log("worker replace checks ok");
