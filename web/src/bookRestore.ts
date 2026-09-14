import type { EngineRequest } from "./engineClient.ts";
import type { WorkerRes } from "./engineProtocol.ts";

export type BookRestoreHost = {
  downloadedBooksEnabled(): boolean;
  generation(): number;
  retainedScoreBook(): ArrayBuffer | null;
  retainedMoveBook(): ArrayBuffer | null;
  report(r?: WorkerRes): void;
  loaded(kind: "score" | "move" | "clear", r: WorkerRes): void;
};

export type BooksDownloadState = {
  downloadedBooksEnabled: boolean;
  retainedScoreBook: ArrayBuffer | null;
  retainedMoveBook: ArrayBuffer | null;
  scoreBookAttempted?: boolean;
  moveBookAttempted?: boolean;
  scoreBookInFlight?: boolean;
  moveBookInFlight?: boolean;
};

/** Start a book fetch only when On, bytes are missing, and this attempt is not already done or running. */
export function shouldStartBookDownload(kind: "score" | "move", state: BooksDownloadState): boolean {
  if (!state.downloadedBooksEnabled) return false;
  const retained = kind === "score" ? state.retainedScoreBook : state.retainedMoveBook;
  const inFlight = kind === "score" ? state.scoreBookInFlight : state.moveBookInFlight;
  const attempted = kind === "score" ? state.scoreBookAttempted : state.moveBookAttempted;
  return !retained && !inFlight && !attempted;
}

/**
 * After replacement, resume a fetch only for a missing book that has not already
 * been attempted this On period. In-flight fetches keep running; a timeout does
 * not start an automatic retry.
 */
export function shouldDownloadBooks(state: BooksDownloadState): boolean {
  return shouldStartBookDownload("score", state) || shouldStartBookDownload("move", state);
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
  const current = () => host.generation() === gen && host.downloadedBooksEnabled();

  const score = host.retainedScoreBook();
  if (host.downloadedBooksEnabled() && score) {
    const r = await client.request({ type: "loadScoreBook", bytes: score.slice(0) });
    if (current()) host.loaded("score", r);
  }

  const move = host.retainedMoveBook();
  if (current() && move) {
    const r = await client.request({ type: "loadMoveBook", bytes: move.slice(0) });
    if (current()) host.loaded("move", r);
  }

  if (!host.downloadedBooksEnabled()) {
    const r = await client.request({ type: "clearDownloadedBooks" });
    host.loaded("clear", r);
  }
}
