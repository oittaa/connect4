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

/** Vertical win for Red in column 0: 1,2,1,2,1,2,1. */
async function playVerticalWin(page: Page): Promise<void> {
  const cols = [0, 1, 0, 1, 0, 1, 0];
  for (const col of cols) {
    await page.locator(`#board [data-col="${col}"]`).click();
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

    await playVerticalWin(page);
    await expect(page.locator("#status")).toContainText(/wins/i);
    await expect.poll(() => saveCompletedCount(page)).toBe(1);

    // No further saves from re-rendering the finished position (hints, resize, etc.).
    await page.locator("#analyze").check();
    await page.locator("#analyze").uncheck();
    expect(await saveRequestCount(page)).toBe(1);

    const bytes = await readPersistedTT(page);
    expect(bytes).not.toBeNull();
    expect(bytes as number).toBeGreaterThan(1_000_000);
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
    await playVerticalWin(page);
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
