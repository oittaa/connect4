import type { WorkerReq, WorkerRes } from "./engineProtocol";

type OmitId<T> = T extends unknown ? Omit<T, "id"> : never;
type ReplyReq = Exclude<WorkerReq, { type: "setTimeout" }>;

export type EngineRequest = OmitId<ReplyReq>;

export type EnginePort = {
  postMessage(message: WorkerReq): void;
  onmessage: ((ev: { data: WorkerRes }) => void) | null;
};

export type EngineClient = {
  request(msg: EngineRequest): Promise<WorkerRes>;
  setTimeoutMs(ms: number): void;
};

export function createEngineClient(port: { postMessage(message: WorkerReq): void }): EngineClient {
  let reqId = 1;
  const pending = new Map<number, (r: WorkerRes) => void>();
  const sink = port as EnginePort;

  sink.onmessage = (ev) => {
    const fn = pending.get(ev.data.id);
    if (!fn) return;
    pending.delete(ev.data.id);
    fn(ev.data);
  };

  return {
    request(msg) {
      const id = reqId++;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        sink.postMessage({ ...msg, id } as WorkerReq);
      });
    },
    setTimeoutMs(ms) {
      const id = reqId++;
      sink.postMessage({ id, type: "setTimeout", ms });
    },
  };
}
