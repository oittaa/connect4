import type { WorkerReq, WorkerRes } from "./engineProtocol";

type OmitId<T> = T extends unknown ? Omit<T, "id"> : never;
type ReplyReq = Exclude<WorkerReq, { type: "setTimeout" }>;

export type EngineRequest = OmitId<ReplyReq>;

/** Settled into pending requests on `error` / `messageerror`. */
export const SOLVER_TRANSPORT_ERROR = "The solver stopped unexpectedly.";

export type EnginePort = {
  postMessage(message: WorkerReq): void;
  onmessage: ((ev: { data: WorkerRes }) => void) | null;
  onerror: ((ev: { message?: string }) => void) | null;
  onmessageerror: ((ev: unknown) => void) | null;
};

export type EngineClient = {
  request(msg: EngineRequest): Promise<WorkerRes>;
  setTimeoutMs(ms: number): void;
  /** Stop posting. Pending and future requests resolve as errors. Does not notify `onFailure`. */
  fail(message?: string): void;
};

export function createEngineClient(
  port: { postMessage(message: WorkerReq): void },
  options?: { onFailure?: (detail: string) => void },
): EngineClient {
  let reqId = 1;
  const pending = new Map<number, (r: WorkerRes) => void>();
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
      for (const [id, fn] of queued) fn({ id, type: "error", message });
    }
  }

  sink.onmessage = (ev) => {
    if (failed) return;
    const fn = pending.get(ev.data.id);
    if (!fn) return;
    pending.delete(ev.data.id);
    fn(ev.data);
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
        pending.set(id, resolve);
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
    setTimeoutMs(ms) {
      if (failed) return;
      const id = reqId++;
      try {
        sink.postMessage({ id, type: "setTimeout", ms });
      } catch {
        // One-way command: nothing is waiting on a reply.
      }
    },
    fail(message = SOLVER_TRANSPORT_ERROR) {
      failAll(message, false);
    },
  };
}
