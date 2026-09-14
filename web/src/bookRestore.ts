import type { EngineRequest } from "./engineClient.ts";
import type { WorkerRes } from "./engineProtocol.ts";

export type BookRestoreHost = {
  bookOn(): boolean;
  generation(): number;
  retainedScore(): ArrayBuffer | null;
  retainedMove(): ArrayBuffer | null;
  report(r?: WorkerRes): void;
  loaded(kind: "score" | "move" | "clear", r: WorkerRes): void;
};

export type BookDownloadState = {
  bookOn: boolean;
  retainedScoreBook: ArrayBuffer | null;
  retainedMoveBook: ArrayBuffer | null;
};

/** After replacement, fetch only when the toggle is on and retained bytes are missing. */
export function shouldDownloadBooks(state: BookDownloadState): boolean {
  return state.bookOn && (!state.retainedScoreBook || !state.retainedMoveBook);
}

/**
 * Load retained opening-book bytes into a replacement worker, or clear them
 * if the toggle is off. Re-checks the latest preference after every await so
 * Off/On during a pending restore is not left on the worker.
 */
export async function restoreRetainedBooks(
  client: { request(msg: EngineRequest): Promise<WorkerRes> },
  ready: WorkerRes,
  host: BookRestoreHost,
): Promise<void> {
  host.report(ready);
  const gen = host.generation();
  const current = () => host.generation() === gen && host.bookOn();

  const score = host.retainedScore();
  if (host.bookOn() && score) {
    const r = await client.request({ type: "loadScoreBook", bytes: score.slice(0) });
    if (current()) host.loaded("score", r);
  }

  const move = host.retainedMove();
  if (current() && move) {
    const r = await client.request({ type: "loadMoveBook", bytes: move.slice(0) });
    if (current()) host.loaded("move", r);
  }

  if (!host.bookOn()) {
    const r = await client.request({ type: "clearDownloadedBooks" });
    host.loaded("clear", r);
  }
}
