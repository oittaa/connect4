// Worker transport checks. Run: npm test

import { createEngineClient, type EnginePort } from "./engineClient.ts";
import type { WorkerReq, WorkerRes } from "./engineProtocol.ts";

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
    bookLen: 1,
    bookDepth: 4,
    moveBookPopulated: 0,
    moveBookDepth: 0,
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
    type: "fetchScoreBook",
    url: "books/opening.c4book",
  });
  const moveP = client.request({
    type: "fetchMoveBook",
    url: "books/opening.c4move",
  });
  same(
    port.posted.map((m) => [m.id, m.type]),
    [
      [1, "fetchScoreBook"],
      [2, "fetchMoveBook"],
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
  const client = createEngineClient(port);
  client.setTimeoutMs(50);
  same(port.posted[0], { id: 1, type: "setTimeout", ms: 50 }, "one-way setTimeout has an id");
  port.deliver({ id: 1, type: "error", message: "should ignore" });
  const p = client.request({ type: "init", timeoutMs: 12 });
  assert(port.posted[1].id === 2, "one-way command does not consume a pending slot");
  port.deliver(ready(2));
  const r = await p;
  assert(r.type === "ready" && r.id === 2, "later request still matches");
}

console.log("engine client checks ok");
