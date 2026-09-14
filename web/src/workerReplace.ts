import {
  isBlockingCompute,
  WORKER_REPLACED,
  type EngineClient,
  type EngineRequest,
} from "./engineClient.ts";
import type { WorkerRes } from "./engineProtocol.ts";

export type SpawnedWorker = {
  client: EngineClient;
  terminate(): void;
};

export type WorkerReplaceHost = {
  spawn(): SpawnedWorker;
  initTimeoutMs(): number;
  onReplaceStart(): void;
  restoreBooks(client: EngineClient, ready: WorkerRes): Promise<void>;
  afterReady(): void;
  onInitFailure(detail: string): void;
  isEngineFailed(): boolean;
  downloadedBooksEnabled(): boolean;
  booksGeneration(): number;
};

function replacedResult(): WorkerRes {
  return { id: 0, type: "error", message: WORKER_REPLACED };
}

function isBookLoad(type: EngineRequest["type"]): boolean {
  return type === "loadScoreBook" || type === "loadMoveBook";
}

/**
 * Terminate a busy worker when a new blocking search would wait on it.
 * The request that triggered replacement is discarded; `afterReady` replans
 * the latest session after init and retained books are in place.
 */
export function createWorkerReplace(host: WorkerReplaceHost) {
  let current = host.spawn();
  let replacing: Promise<void> | null = null;
  let computePosted: Promise<void> = Promise.resolve();

  function replace(): Promise<void> {
    if (replacing) return replacing;
    host.onReplaceStart();
    replacing = (async () => {
      const old = current;
      old.client.fail(WORKER_REPLACED);
      old.terminate();
      current = host.spawn();
      const r = await current.client.request({ type: "init", timeoutMs: host.initTimeoutMs() });
      if (host.isEngineFailed()) return;
      if (r.type !== "ready") {
        current.client.fail();
        host.onInitFailure(r.type === "error" ? r.message : "Solver failed");
        return;
      }
      try {
        await host.restoreBooks(current.client, r);
      } catch {
        // Embedded fallback; do not block readiness on book restore.
      }
    })().finally(() => {
      replacing = null;
      if (!host.isEngineFailed()) host.afterReady();
    });
    return replacing;
  }

  async function send(msg: EngineRequest): Promise<WorkerRes> {
    if (!isBlockingCompute(msg.type)) {
      const bookGen = isBookLoad(msg.type) ? host.booksGeneration() : null;
      if (replacing) await replacing;
      if (bookGen !== null && (host.booksGeneration() !== bookGen || !host.downloadedBooksEnabled())) {
        return replacedResult();
      }
      return current.client.request(msg);
    }

    await computePosted;

    if (current.client.hasPendingCompute() || replacing) {
      await replace();
      return replacedResult();
    }

    let markPosted!: () => void;
    computePosted = new Promise<void>((resolve) => {
      markPosted = resolve;
    });
    try {
      const posted = current.client.request(msg);
      markPosted();
      return posted;
    } catch (e) {
      markPosted();
      throw e;
    }
  }

  return {
    send,
    client: () => current.client,
    isReplacing: () => replacing !== null,
  };
}
