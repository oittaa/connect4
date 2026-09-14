// Book restore vs DEBUG toggle during replacement. Run: npm test

import type { EngineRequest } from "./engineClient.ts";
import type { WorkerRes } from "./engineProtocol.ts";
import {
  restoreRetainedBooks,
  shouldDownloadBooks,
  type BookRestoreHost,
} from "./bookRestore.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function same(got: unknown, expected: unknown, msg: string): void {
  assert(JSON.stringify(got) === JSON.stringify(expected), `${msg}: got ${JSON.stringify(got)}`);
}

function ready(id: number, extra: Partial<Extract<WorkerRes, { type: "ready" }>> = {}): WorkerRes {
  return {
    id,
    type: "ready",
    bookLen: 4,
    bookDepth: 4,
    moveBookPopulated: 0,
    moveBookDepth: 0,
    ...extra,
  };
}

const ply8 = { bookLen: 129_498, bookDepth: 8, moveBookPopulated: 0, moveBookDepth: 0 };
const move9 = { bookLen: 129_498, bookDepth: 8, moveBookPopulated: 402_045, moveBookDepth: 9 };

type Session = {
  bookOn: boolean;
  generation: number;
  retainedScoreBook: ArrayBuffer | null;
  retainedMoveBook: ArrayBuffer | null;
  applied: WorkerRes[];
};

function hostFor(session: Session): BookRestoreHost {
  return {
    bookOn: () => session.bookOn,
    generation: () => session.generation,
    retainedScore: () => session.retainedScoreBook,
    retainedMove: () => session.retainedMoveBook,
    report(r) {
      if (r) session.applied.push(r);
    },
    loaded(_kind, r) {
      session.applied.push(r);
    },
  };
}

function turnOff(session: Session): void {
  session.bookOn = false;
  session.retainedScoreBook = null;
  session.retainedMoveBook = null;
  session.generation++;
}

function turnOn(session: Session): void {
  session.bookOn = true;
}

type Pending = { msg: EngineRequest; resolve: (r: WorkerRes) => void };

function deferredClient() {
  const posted: EngineRequest[] = [];
  const pending: Pending[] = [];
  return {
    posted,
    request(msg: EngineRequest): Promise<WorkerRes> {
      posted.push(msg);
      if (msg.type === "clearDownloadedBooks") {
        return Promise.resolve(ready(posted.length));
      }
      return new Promise((resolve) => pending.push({ msg, resolve }));
    },
    release(type: EngineRequest["type"], res: WorkerRes): void {
      const i = pending.findIndex((p) => p.msg.type === type);
      assert(i >= 0, `pending ${type}`);
      const [p] = pending.splice(i, 1);
      p.resolve(res);
    },
  };
}

function types(posted: EngineRequest[]): EngineRequest["type"][] {
  return posted.map((m) => m.type);
}

{
  const session: Session = {
    bookOn: true,
    generation: 1,
    retainedScoreBook: new ArrayBuffer(8),
    retainedMoveBook: new ArrayBuffer(8),
    applied: [],
  };
  const client = deferredClient();
  const done = restoreRetainedBooks(client, ready(1), hostFor(session));
  await Promise.resolve();
  same(types(client.posted), ["loadScoreBook"], "score restore is pending");

  turnOff(session);
  client.release("loadScoreBook", ready(2, ply8));
  await done;

  same(types(client.posted), ["loadScoreBook", "clearDownloadedBooks"], "Off during restore clears the 8-ply load");
  const last = session.applied[session.applied.length - 1];
  assert(last?.type === "ready" && last.bookDepth === 4, "applied book state is the clear, not 8-ply");
  assert(
    !session.applied.some((r) => r.type === "ready" && r.bookDepth === 8 && r.bookLen === ply8.bookLen),
    "superseded 8-ply ready is not applied",
  );
  assert(!shouldDownloadBooks(session), "Off does not restart downloads");
}

{
  const session: Session = {
    bookOn: true,
    generation: 1,
    retainedScoreBook: new ArrayBuffer(8),
    retainedMoveBook: new ArrayBuffer(8),
    applied: [],
  };
  turnOff(session);
  turnOn(session);
  assert(session.retainedScoreBook === null && session.retainedMoveBook === null, "Off clears retained bytes");
  assert(session.bookOn, "On is the latest preference");
  assert(shouldDownloadBooks(session), "On without retained bytes needs a download");

  const client = deferredClient();
  const done = restoreRetainedBooks(client, ready(1), hostFor(session));
  await done;
  same(types(client.posted), [], "init-time Off/On does not load the discarded retained bytes");
}

{
  const session: Session = {
    bookOn: true,
    generation: 1,
    retainedScoreBook: new ArrayBuffer(8),
    retainedMoveBook: new ArrayBuffer(8),
    applied: [],
  };
  const client = deferredClient();
  const done = restoreRetainedBooks(client, ready(1), hostFor(session));
  await Promise.resolve();
  client.release("loadScoreBook", ready(2, ply8));
  await Promise.resolve();
  same(types(client.posted), ["loadScoreBook", "loadMoveBook"], "both retained books load when the toggle stays on");
  client.release("loadMoveBook", ready(3, move9));
  await done;
  assert(session.applied.some((r) => r.type === "ready" && r.moveBookPopulated === move9.moveBookPopulated), "move book applied");
  assert(!shouldDownloadBooks(session), "retained bytes still present, no refetch");
}

console.log("book restore checks ok");
