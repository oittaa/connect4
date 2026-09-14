// Book restore vs DEBUG toggle during replacement. Run: npm test

import type { EngineRequest } from "./engineClient.ts";
import type { WorkerRes } from "./engineProtocol.ts";
import {
  restoreRetainedBooks,
  shouldDownloadBooks,
  shouldStartBookDownload,
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
    scoreBookLen: 4,
    scoreBookDepth: 4,
    moveBookPopulated: 0,
    moveBookDepth: 0,
    ...extra,
  };
}

const ply8 = { scoreBookLen: 129_498, scoreBookDepth: 8, moveBookPopulated: 0, moveBookDepth: 0 };
const move9 = { scoreBookLen: 129_498, scoreBookDepth: 8, moveBookPopulated: 402_045, moveBookDepth: 9 };

type Session = {
  downloadedBooksEnabled: boolean;
  generation: number;
  retainedScoreBook: ArrayBuffer | null;
  retainedMoveBook: ArrayBuffer | null;
  applied: WorkerRes[];
};

function hostFor(session: Session): BookRestoreHost {
  return {
    downloadedBooksEnabled: () => session.downloadedBooksEnabled,
    generation: () => session.generation,
    retainedScoreBook: () => session.retainedScoreBook,
    retainedMoveBook: () => session.retainedMoveBook,
    report(r) {
      if (r) session.applied.push(r);
    },
    loaded(_kind, r) {
      session.applied.push(r);
    },
  };
}

function turnOff(session: Session): void {
  session.downloadedBooksEnabled = false;
  session.retainedScoreBook = null;
  session.retainedMoveBook = null;
  session.generation++;
}

function turnOn(session: Session): void {
  session.downloadedBooksEnabled = true;
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
    downloadedBooksEnabled: true,
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
  assert(last?.type === "ready" && last.scoreBookDepth === 4, "applied book state is the clear, not 8-ply");
  assert(
    !session.applied.some((r) => r.type === "ready" && r.scoreBookDepth === 8 && r.scoreBookLen === ply8.scoreBookLen),
    "superseded 8-ply ready is not applied",
  );
  assert(!shouldDownloadBooks(session), "Off does not restart downloads");
}

{
  const session: Session = {
    downloadedBooksEnabled: true,
    generation: 1,
    retainedScoreBook: new ArrayBuffer(8),
    retainedMoveBook: new ArrayBuffer(8),
    applied: [],
  };
  turnOff(session);
  turnOn(session);
  assert(session.retainedScoreBook === null && session.retainedMoveBook === null, "Off clears retained bytes");
  assert(session.downloadedBooksEnabled, "On is the latest preference");
  assert(shouldDownloadBooks(session), "On without retained bytes needs a download");

  const client = deferredClient();
  const done = restoreRetainedBooks(client, ready(1), hostFor(session));
  await done;
  same(types(client.posted), [], "init-time Off/On does not load the discarded retained bytes");
}

{
  const session: Session = {
    downloadedBooksEnabled: true,
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

{
  const timedOut = {
    downloadedBooksEnabled: true,
    retainedScoreBook: new ArrayBuffer(8),
    retainedMoveBook: null as ArrayBuffer | null,
    scoreBookAttempted: true,
    moveBookAttempted: true,
    scoreBookInFlight: false,
    moveBookInFlight: false,
  };
  assert(shouldStartBookDownload("score", timedOut) === false, "successful score book is not re-fetched");
  assert(shouldStartBookDownload("move", timedOut) === false, "timed-out move book is not auto-retried");
  assert(!shouldDownloadBooks(timedOut), "afterReady does not restart a timed-out attempt");

  const inFlight = {
    downloadedBooksEnabled: true,
    retainedScoreBook: null as ArrayBuffer | null,
    retainedMoveBook: null as ArrayBuffer | null,
    scoreBookAttempted: true,
    moveBookAttempted: true,
    scoreBookInFlight: true,
    moveBookInFlight: true,
  };
  assert(!shouldDownloadBooks(inFlight), "replacement does not start a second fetch while one is in flight");

  const offThenOn = {
    downloadedBooksEnabled: true,
    retainedScoreBook: null as ArrayBuffer | null,
    retainedMoveBook: null as ArrayBuffer | null,
    scoreBookAttempted: false,
    moveBookAttempted: false,
    scoreBookInFlight: false,
    moveBookInFlight: false,
  };
  assert(shouldDownloadBooks(offThenOn), "Off then On retries both books");
}

console.log("book restore checks ok");
