import type { WorkerReq, WorkerRes } from "./engineProtocol";

type OmitId<T> = T extends unknown ? Omit<T, "id"> : never;

export type EngineRequest = OmitId<WorkerReq>;

/** Settled into pending requests on `error` / `messageerror`. */
const SOLVER_TRANSPORT_ERROR = "The solver stopped unexpectedly.";

/** Settled into pending requests when the worker is terminated for a replacement. */
export const WORKER_REPLACED = "worker replaced";

export function isWorkerReplaced(r: WorkerRes): boolean {
  return r.type === "error" && r.message === WORKER_REPLACED;
}

export type EnginePort = {
  postMessage(message: WorkerReq): void;
  onmessage: ((ev: { data: WorkerRes }) => void) | null;
  onerror: ((ev: { message?: string }) => void) | null;
  onmessageerror: ((ev: unknown) => void) | null;
};

export type EngineClient = {
  request(msg: EngineRequest): Promise<WorkerRes>;
  /** Stop posting. Pending and future requests resolve as errors. Does not notify `onFailure`. */
  fail(message?: string): void;
  hasPendingCompute(): boolean;
};

export function isBlockingCompute(type: EngineRequest["type"]): boolean {
  return type === "analyze" || type === "bestMove";
}

export function createEngineClient(
  port: { postMessage(message: WorkerReq): void },
  options?: { onFailure?: (detail: string) => void },
): EngineClient {
  let reqId = 1;
  const pending = new Map<number, { resolve: (r: WorkerRes) => void; type: EngineRequest["type"] }>();
  let failed: string | null = null;
  const sink = port as EnginePort;

  function failAll(message: string, notify: boolean, detail?: string): void {
    if (failed) return;
    failed = message;
    const queued = [...pending.entries()];
    pending.clear();
    try {
      if (notify) options?.onFailure?.(detail || message);
    } finally {
      for (const [id, p] of queued) p.resolve({ id, type: "error", message });
    }
  }

  sink.onmessage = (ev) => {
    if (failed) return;
    const p = pending.get(ev.data.id);
    if (!p) return;
    pending.delete(ev.data.id);
    p.resolve(ev.data);
  };

  sink.onerror = (ev) => {
    failAll(SOLVER_TRANSPORT_ERROR, true, ev.message);
  };
  sink.onmessageerror = () => {
    failAll(SOLVER_TRANSPORT_ERROR, true);
  };

  return {
    request(msg) {
      const id = reqId++;
      if (failed) {
        return Promise.resolve({ id, type: "error", message: failed });
      }
      return new Promise((resolve) => {
        pending.set(id, { resolve, type: msg.type });
        try {
          sink.postMessage({ ...msg, id } as WorkerReq);
        } catch (e) {
          pending.delete(id);
          resolve({
            id,
            type: "error",
            message: e instanceof Error ? e.message : String(e),
          });
        }
      });
    },
    fail(message = SOLVER_TRANSPORT_ERROR) {
      failAll(message, false);
    },
    hasPendingCompute() {
      if (failed) return false;
      for (const p of pending.values()) {
        if (isBlockingCompute(p.type)) return true;
      }
      return false;
    },
  };
}
