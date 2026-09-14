// Opening-book download deadlines. Run: npm test

import {
  BOOK_DOWNLOAD_DEADLINE_MS,
  fetchBookWithDeadline,
  isAbortError,
  isBookDownloadTimeout,
  type BookFetch,
  type BookResponse,
} from "./bookDownload.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function createClock() {
  let nextId = 1;
  const timers = new Map<number, { delay: number; fn: () => void }>();
  const delays: number[] = [];
  return {
    delays,
    get pending() {
      return timers.size;
    },
    setTimeout(handler: () => void, ms: number) {
      const id = nextId++;
      delays.push(ms);
      timers.set(id, { delay: ms, fn: handler });
      return id;
    },
    clearTimeout(id: unknown) {
      timers.delete(id as number);
    },
    fireAll() {
      const due = [...timers.values()];
      timers.clear();
      for (const t of due) t.fn();
    },
  };
}

function hang(): Promise<never> {
  return new Promise(() => {});
}

function okBody(bytes: ArrayBuffer): BookResponse {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => bytes,
  };
}

function stalledHeaders(): BookFetch {
  return () => hang();
}

function stalledBody(): BookFetch {
  return async () => ({
    ok: true,
    status: 200,
    arrayBuffer: () => hang(),
  });
}

async function expectTimeout(p: Promise<ArrayBuffer>, label: string): Promise<void> {
  try {
    await p;
    throw new Error(`${label}: expected timeout`);
  } catch (error) {
    assert(isBookDownloadTimeout(error), `${label}: expected timeout, got ${String(error)}`);
    assert(
      error instanceof Error && error.message === `${label} download timed out`,
      `${label}: timeout message`,
    );
  }
}

{
  const timer = createClock();
  const p = fetchBookWithDeadline("score", {
    label: "Score book",
    fetch: stalledHeaders(),
    timer,
  });
  assert(timer.pending === 1, "stalled headers start a timer");
  assert(timer.delays[0] === BOOK_DOWNLOAD_DEADLINE_MS, "deadline is 60s");
  timer.fireAll();
  await expectTimeout(p, "Score book");
  assert(timer.pending === 0, "stalled-headers timer is cleared");
}

{
  const timer = createClock();
  const p = fetchBookWithDeadline("move", {
    label: "Move book",
    fetch: stalledBody(),
    timer,
  });
  await Promise.resolve();
  assert(timer.pending === 1, "stalled body keeps the timer through arrayBuffer");
  timer.fireAll();
  await expectTimeout(p, "Move book");
  assert(timer.pending === 0, "stalled-body timer is cleared");
}

{
  const timer = createClock();
  const scoreBytes = new ArrayBuffer(8);
  const score = fetchBookWithDeadline("score", {
    label: "Score book",
    fetch: async () => okBody(scoreBytes),
    timer,
  });
  const move = fetchBookWithDeadline("move", {
    label: "Move book",
    fetch: stalledHeaders(),
    timer,
  });
  const got = await score;
  assert(got === scoreBytes, "successful score book is retained");
  assert(timer.pending === 1, "only the stalled move-book timer remains");
  timer.fireAll();
  await expectTimeout(move, "Move book");
  assert(timer.pending === 0, "move-book timeout clears its timer");
}

{
  const timer = createClock();
  const user = new AbortController();
  const p = fetchBookWithDeadline("score", {
    label: "Score book",
    signal: user.signal,
    fetch: stalledHeaders(),
    timer,
  });
  user.abort();
  try {
    await p;
    throw new Error("Off should cancel");
  } catch (error) {
    assert(isAbortError(error), "Off is AbortError");
    assert(!isBookDownloadTimeout(error), "Off around expiry is not a timeout");
  }
  assert(timer.pending === 0, "Off clears the timer before expiry");
  timer.fireAll();
  assert(timer.pending === 0, "firing after Off is a no-op");
}

{
  const timer = createClock();
  const firstUser = new AbortController();
  const first = fetchBookWithDeadline("score", {
    label: "Score book",
    signal: firstUser.signal,
    fetch: stalledHeaders(),
    timer,
  });
  firstUser.abort();
  await first.catch((error) => {
    assert(isAbortError(error), "first Off/on attempt is cancelled");
    assert(!isBookDownloadTimeout(error), "first attempt is not a timeout");
  });
  assert(timer.pending === 0, "first attempt leaves no timer for the retry");

  const secondUser = new AbortController();
  const second = fetchBookWithDeadline("score", {
    label: "Score book",
    signal: secondUser.signal,
    fetch: stalledHeaders(),
    timer,
  });
  assert(timer.pending === 1, "Off then On starts a fresh 60s timer");
  assert(timer.delays[1] === BOOK_DOWNLOAD_DEADLINE_MS, "retry uses the same deadline");
  timer.fireAll();
  await expectTimeout(second, "Score book");
  assert(timer.pending === 0, "retry timeout clears its own timer");
}

{
  const timer = createClock();
  const user = new AbortController();
  const p = fetchBookWithDeadline("score", {
    label: "Score book",
    signal: user.signal,
    fetch: stalledBody(),
    timer,
  });
  await Promise.resolve();
  user.abort();
  timer.fireAll();
  try {
    await p;
    throw new Error("expected cancellation");
  } catch (error) {
    assert(isAbortError(error), "Off wins if it races the deadline");
    assert(!isBookDownloadTimeout(error), "deadline must not overwrite Off");
  }
  assert(timer.pending === 0, "Off/on around body expiry clears timers");
}

{
  const timer = createClock();
  try {
    await fetchBookWithDeadline("score", {
      label: "Score book",
      fetch: async () => ({
        ok: false,
        status: 404,
        arrayBuffer: async () => new ArrayBuffer(0),
      }),
      timer,
    });
    throw new Error("expected HTTP failure");
  } catch (error) {
    assert(!isBookDownloadTimeout(error), "HTTP failure is not a timeout");
    assert(
      error instanceof Error && error.message === "Score book download failed (404)",
      "HTTP failure keeps the existing DEBUG wording",
    );
  }
  assert(timer.pending === 0, "HTTP failure clears the timer");
}

{
  const timer = createClock();
  const bytes = new ArrayBuffer(4);
  const got = await fetchBookWithDeadline("score", {
    label: "Score book",
    fetch: async () => okBody(bytes),
    timer,
  });
  assert(got === bytes, "completed download returns the body");
  assert(timer.pending === 0, "success clears the timer");
  timer.fireAll();
}

console.log("book download deadline checks ok");
