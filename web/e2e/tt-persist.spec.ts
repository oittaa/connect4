import { expect, type Page, test } from "@playwright/test";

async function openApp(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = { requests: [] as { type: string }[], replies: [] as { type: string }[] };
    Object.assign(window, { ttTest: state });
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener("message", (event) => state.replies.push(event.data));
      }
      override postMessage(message: any): void {
        state.requests.push(message);
        super.postMessage(message);
      }
    };
  });
  await page.goto("/connect4/#DEBUG");
  await expect(page.locator("#engine-line")).toHaveText(/Solver ready/i, { timeout: 60_000 });
}

function saveRequestCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).ttTest.requests.filter((r: any) => r.type === "saveTT").length);
}

/** Resolves once the worker's `saveTT` handling (including the IndexedDB
 * transaction) has actually finished, not just once the request was sent. */
function saveCompletedCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).ttTest.replies.filter((r: any) => r.type === "ttSaved").length);
}

/** Quick vertical win for Red in column 0, never triggering any real search. */
async function playVerticalWin(page: Page): Promise<void> {
  const cols = [0, 1, 0, 1, 0, 1, 0];
  for (const col of cols) {
    await page.locator(`#board [data-col="${col}"]`).click();
  }
}

/**
 * 17-move game ending in the same column-0 vertical win, but padded with 10
 * harmless filler moves (columns 2-6, twice each, never 4-in-a-row) so play
 * runs past the score book's 8-ply coverage. With hints on, that forces a
 * real search that dirties the TT. Validated with `game.ts`'s own
 * `lastMoveWin`: no win before move 17.
 *
 * Waits for each move's hint analysis to finish before the next click: two
 * `analyze` calls in flight at once replace the worker (see
 * `stale-search.spec.ts`), which would throw away the very search progress
 * this helper exists to create.
 */
async function playPastScoreBookThenWin(page: Page): Promise<void> {
  const cols = [2, 3, 4, 5, 6, 2, 3, 4, 5, 6, 0, 1, 0, 1, 0, 1, 0];
  for (const col of cols) {
    await page.locator(`#board [data-col="${col}"]`).click();
    await expect(page.locator("#engine-line")).not.toContainText(/analyzing/i, { timeout: 10_000 });
  }
}

async function readPersistedTT(page: Page): Promise<number | null> {
  return page.evaluate(
    () =>
      new Promise<number | null>((resolve) => {
        const req = indexedDB.open("c4-tt");
        req.onerror = () => resolve(null);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("blob")) {
            db.close();
            resolve(null);
            return;
          }
          const tx = db.transaction("blob", "readonly");
          const getReq = tx.objectStore("blob").get("tt");
          getReq.onsuccess = () => {
            const v = getReq.result;
            db.close();
            if (v instanceof ArrayBuffer) resolve(v.byteLength);
            else if (v instanceof Uint8Array) resolve(v.byteLength);
            else resolve(null);
          };
          getReq.onerror = () => {
            db.close();
            resolve(null);
          };
        };
      }),
  );
}

test.describe("transposition-table persistence", () => {
  test("TT saves once on game end, not on every move", async ({ page }) => {
    await openApp(page);
    expect(await saveRequestCount(page)).toBe(0);

    // Hints on so real searches beyond the score book dirty the table;
    // otherwise this human-vs-human game never touches the TT at all.
    await page.locator("#analyze").check();
    await playPastScoreBookThenWin(page);
    await expect(page.locator("#status")).toContainText(/wins/i);
    await expect.poll(() => saveCompletedCount(page)).toBe(1);

    // No further saves from re-rendering the finished position (toggling
    // hints, resize, etc.).
    await page.locator("#analyze").uncheck();
    await page.locator("#analyze").check();
    expect(await saveRequestCount(page)).toBe(1);

    const bytes = await readPersistedTT(page);
    expect(bytes).not.toBeNull();
    expect(bytes as number).toBeGreaterThan(1_000_000);
  });

  test("no IndexedDB write when the game never searched", async ({ page }) => {
    await openApp(page);
    // Hints stay off (the default) and both seats stay human, so the WASM
    // engine is never asked to search and the TT never gets dirtied.
    await playVerticalWin(page);
    await expect(page.locator("#status")).toContainText(/wins/i);
    await expect.poll(() => saveCompletedCount(page)).toBe(1);

    expect(await readPersistedTT(page)).toBeNull();
  });

  test("starting a new game after a finish allows a fresh save on the next finish", async ({ page }) => {
    await openApp(page);
    await playVerticalWin(page);
    await expect.poll(() => saveRequestCount(page)).toBe(1);

    await page.locator("#new").click();
    await playVerticalWin(page);
    await expect.poll(() => saveRequestCount(page)).toBe(2);
  });

  test("a restart after a finished game still boots the solver from a persisted TT", async ({ page }) => {
    await openApp(page);
    await page.locator("#analyze").check();
    await playPastScoreBookThenWin(page);
    await expect.poll(() => saveCompletedCount(page)).toBe(1);
    expect(await readPersistedTT(page)).toBeGreaterThan(1_000_000);

    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // The URL still encodes the finished game, so the reloaded page replays
    // straight to "Game over." instead of "Solver ready.".
    await page.reload();
    await expect(page.locator("#engine-line")).toHaveText(/Game over/i, { timeout: 60_000 });
    await expect(page.locator("#solver-alert")).toBeHidden();
    expect(errors).toEqual([]);
  });
});
