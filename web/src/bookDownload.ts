/** Independent opening-book download deadline, including the response body. */

const BOOK_DOWNLOAD_DEADLINE_MS = 60_000;

class BookDownloadTimeoutError extends Error {
  readonly timedOut = true as const;

  constructor(label: string) {
    super(`${label} download timed out`);
    this.name = "BookDownloadTimeoutError";
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export type BookResponse = {
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
};

export type BookFetch = (url: string, init?: { signal?: AbortSignal }) => Promise<BookResponse>;

export type BookDownloadTimer = {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
};

export type FetchBookOptions = {
  label: string;
  deadlineMs?: number;
  signal?: AbortSignal;
  fetch?: BookFetch;
  timer?: BookDownloadTimer;
};

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}

function whenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => reject(abortError(signal));
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener("abort", fail, { once: true });
  });
}

/** Combine timeout and Off/cancellation without requiring AbortSignal.any. */
function combineAbortSignals(signals: AbortSignal[]): AbortSignal {
  const live = signals.filter((signal) => signal);
  if (live.length === 1) return live[0];
  const controller = new AbortController();
  const onAbort = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  for (const signal of live) {
    if (signal.aborted) {
      controller.abort();
      return controller.signal;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }
  return controller.signal;
}

/**
 * Fetch one book with a 60s bound that covers headers and the body.
 * Off/cancellation (`signal`) is not reported as a timeout.
 */
export async function fetchBookWithDeadline(url: string, options: FetchBookOptions): Promise<ArrayBuffer> {
  const deadlineMs = options.deadlineMs ?? BOOK_DOWNLOAD_DEADLINE_MS;
  const fetchFn: BookFetch = options.fetch ?? ((href, init) => fetch(href, init));
  const setTimeoutFn = options.timer?.setTimeout ?? ((handler, ms) => setTimeout(handler, ms));
  const clearTimeoutFn = options.timer?.clearTimeout ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  const userSignal = options.signal;
  const label = options.label;

  if (userSignal?.aborted) throw abortError(userSignal);

  const timeout = new AbortController();
  let timedOut = false;
  let completed = false;
  const timer = setTimeoutFn(() => {
    if (completed) return;
    timedOut = true;
    if (!timeout.signal.aborted) timeout.abort();
  }, deadlineMs);

  const combined = combineAbortSignals(userSignal ? [timeout.signal, userSignal] : [timeout.signal]);

  try {
    const response = await Promise.race([fetchFn(url, { signal: combined }), whenAborted(combined)]);
    if (userSignal?.aborted) throw abortError(userSignal);
    if (timedOut) throw new BookDownloadTimeoutError(label);
    if (!response.ok) throw new Error(`${label} download failed (${response.status})`);
    const bytes = await Promise.race([response.arrayBuffer(), whenAborted(combined)]);
    if (userSignal?.aborted) throw abortError(userSignal);
    completed = true;
    return bytes;
  } catch (error) {
    if (userSignal?.aborted) throw abortError(userSignal);
    if (timedOut) throw new BookDownloadTimeoutError(label);
    throw error;
  } finally {
    completed = true;
    clearTimeoutFn(timer);
  }
}
