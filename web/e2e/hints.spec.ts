import { expect, type Page, test } from "@playwright/test";

async function openApp(page: Page, moves = ""): Promise<void> {
  await page.addInitScript(() => {
    const state = { requests: [] as { type: string; moves?: number[] }[], replies: [] as any[], hold: false, held: [] as (() => void)[] };
    Object.assign(window, { hintTest: state });
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener("message", (event) => {
          state.replies.push(event.data);
          if (event.data.type !== "availableScores" || !state.hold) return;
          event.stopImmediatePropagation();
          state.held.push(() => this.dispatchEvent(new MessageEvent("message", { data: event.data })));
        });
      }
      override postMessage(message: any): void {
        state.requests.push(message);
        super.postMessage(message);
      }
    };
  });
  await page.goto(`/connect4/#moves=${moves}&DEBUG`);
  await expect(page.locator("#engine-line")).toHaveText(/Solver ready/i, { timeout: 60_000 });
  await expect(page.locator("#books-line")).not.toContainText(/Downloading/, { timeout: 60_000 });
  await page.locator("#delay").evaluate((el) => {
    const input = el as HTMLInputElement;
    input.value = "1500";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function setRole(page: Page, seat: number, role: string): Promise<void> {
  await page.locator(`input[name="role${seat}"][value="${role}"]`).check();
}

async function boardBox(page: Page) {
  return page.locator("#board").evaluate((el) => {
    const box = el.getBoundingClientRect();
    return { x: box.x + scrollX, y: box.y + scrollY, width: box.width, height: box.height };
  });
}

async function expectScores(page: Page): Promise<void> {
  await expect(page.locator("#scores")).toBeVisible();
  await expect(page.locator("#scores span")).toHaveCount(7);
  await expect(page.locator("#scores span").first()).toHaveText(/^(W\d+|L\d+|D)$/);
  await expect(page.locator("#board .best-col").first()).toBeVisible();
}

test("book labels count moves supplied and reset after unloading", async ({ page }) => {
  await openApp(page);
  const books = page.locator("#books-line");
  await expect(books).toContainText(/Score book .*\(through move 8\)/);
  await expect(books).toContainText(/move book .*\(through move 12\)/);
  await expect(books).not.toContainText("depth");
  await page.locator("#books").uncheck();
  await expect(books).toContainText(/Score book .*\(through move 4\)/);
  await expect(books).toContainText("move book not loaded");
});

for (const moves of ["4444422234", "44444222345"]) {
  test(`move ${moves.length + 1} comes from the downloaded move book without search`, async ({ page }) => {
    await openApp(page, moves);
    await expect(page.locator("#books-line")).toContainText(/move book .*\(through move 12\)/);
    await setRole(page, moves.length % 2, "perfect");
    await expect(page.locator(".disc")).toHaveCount(moves.length + 1);
    const result = await page.evaluate(() => (window as any).hintTest.replies.find((r: any) => r.type === "moved"));
    expect(result.fromMoveBook).toBe(true);
    expect(result.nodes).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(await page.evaluate(() => (window as any).hintTest.requests.filter((r: any) => r.type === "analyze"))).toEqual([]);
  });
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`board stays fixed through hints and human/computer turns at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openApp(page);
    await page.addStyleTag({ content: ".disc.dropping { animation-duration: 2s; }" });
    const box = await boardBox(page);
    await setRole(page, 1, "perfect");
    await page.locator("#analyze").check();
    await expectScores(page);
    expect(await boardBox(page)).toEqual(box);
    await page.locator('#board [data-col="3"]').click();
    await expect(page.locator(".disc")).toHaveCount(1);
    await expectScores(page);
    await expect(page.locator(".disc")).toHaveClass(/dropping/);
    expect(await boardBox(page)).toEqual(box);
    await expect(page.locator(".disc")).toHaveCount(2);
    await expectScores(page);
    expect(await boardBox(page)).toEqual(box);
    await page.locator("#analyze").uncheck();
    await expect(page.locator("#scores")).toBeHidden();
    expect(await boardBox(page)).toEqual(box);
    await page.locator("#analyze").check();
    await page.locator("#back").click();
    await expect(page.locator("#status")).toContainText("Paused");
    await expectScores(page);
    expect(await boardBox(page)).toEqual(box);
  });
}

for (const role of ["easy", "medium", "perfect"]) {
  test(`${role} vs ${role} shows score-book scores on both turns without full analysis`, async ({ page }) => {
    await openApp(page);
    await setRole(page, 1, role);
    await setRole(page, 0, role);
    await page.locator("#analyze").check();
    await expectScores(page);
    await expect(page.locator("#scores span")).toHaveText(["L2", "L1", "D", "W1", "D", "L1", "L2"]);
    await expect(page.locator(".disc")).toHaveCount(1);
    await expectScores(page);
    await expect(page.locator(".disc")).toHaveCount(2);
    await expectScores(page);
    const requests = await page.evaluate(() => (window as any).hintTest.requests);
    expect(requests.filter((r: any) => r.type === "analyze")).toEqual([]);
    expect(requests.filter((r: any) => r.type === "availableScores").map((r: any) => r.moves.length)).toEqual(expect.arrayContaining([0, 1, 2]));
    if (role === "easy") expect(requests.filter((r: any) => r.type === "bestMove")).toEqual([]);
  });
}

for (const seats of [[0, 1], [1, 0]]) {
  test(`switching Humans to Medium at 452 keeps playing (seat order ${seats})`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openApp(page, "452");
    await page.locator("#delay").evaluate((el) => {
      (el as HTMLInputElement).value = "400";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.locator("#analyze").check();
    for (const seat of seats) await setRole(page, seat, "medium");
    await expect.poll(() => page.locator(".disc").count(), { timeout: 3000 }).toBeGreaterThanOrEqual(6);
    expect(errors).toEqual([]);
    const replies = await page.evaluate(() => (window as any).hintTest.replies);
    expect(replies.filter((r: any) => r.type === "error")).toEqual([]);
  });
}

test("switching a human seat to a computer during play does not request another analyze", async ({ page }) => {
  await openApp(page, "122435527534575161761");
  await page.locator("#analyze").check();
  await expectScores(page);
  await expect(page.locator("#engine-line")).not.toContainText(/analyzing/i);
  await setRole(page, 1, "perfect");
  await expect.poll(() => page.evaluate(() => (window as any).hintTest.replies.some((r: any) => r.type === "moved"))).toBe(true);
  expect(await page.evaluate(() => (window as any).hintTest.requests.filter((r: any) => r.type === "analyze").length)).toBe(1);
  // The bestMove search's own result (column 4, W10) reaches the UI instead
  // of being discarded.
  await expect(page.locator('#board [data-col="3"]')).toHaveClass(/best-col/);
});

test("fresh late-game search scores are visible before each computer drops its disc", async ({ page }) => {
  await openApp(page, "122435527534575161761");
  const box = await boardBox(page);
  await setRole(page, 0, "perfect");
  await setRole(page, 1, "perfect");
  await page.locator("#analyze").check();
  for (let turn = 0; turn < 2; turn++) {
    await expect.poll(() => page.evaluate(() => (window as any).hintTest.replies.filter((r: any) => r.type === "moved").length)).toBe(turn + 1);
    const result = await page.evaluate(() => (window as any).hintTest.replies.filter((r: any) => r.type === "moved").at(-1));
    expect(result.timedOut).toBe(false);
    if (turn === 0) {
      expect(result.nodes).toBeGreaterThan(0);
      expect(result.col).toBe(3);
      expect(result.hintScores[3]).toBe(10);
    }
    const scores = result.hintScores.map((s: number) => s === -1000 ? "" : s === 0 ? "D" : s > 0 ? `W${s}` : `L${-s}`);
    await expect(page.locator(".disc")).toHaveCount(21 + turn);
    await expect(page.locator("#scores span")).toHaveText(scores);
    await expect(page.locator(`#board [data-col="${result.col}"]`)).toHaveClass(/best-col/);
    expect(await boardBox(page)).toEqual(box);
    await expect(page.locator(".disc")).toHaveCount(22 + turn, { timeout: 2500 });
  }
  expect(await page.evaluate(() => (window as any).hintTest.requests.filter((r: any) => r.type === "analyze"))).toEqual([]);
});

test("partial computer hints do not suppress full analysis after switching to Human", async ({ page }) => {
  await openApp(page, "122435527534575161761");
  await setRole(page, 1, "perfect");
  await page.locator("#analyze").check();
  await expect(page.locator('#board [data-col="3"]')).toHaveClass(/best-col/);
  await setRole(page, 1, "human");
  await expect(page.locator(".disc")).toHaveCount(21);
  await expectScores(page);
  await expect(page.locator("#scores span")).toHaveText(["L1", "D", "W10", "W10", "L2", "L2", "L2"]);
  expect(await page.evaluate(() => (window as any).hintTest.requests.filter((r: any) => r.type === "analyze").length)).toBe(1);
});

test("a move-book computer turn shows the certified rank without delaying the move", async ({ page }) => {
  await openApp(page, "44444222");
  const box = await boardBox(page);
  await setRole(page, 1, "perfect");
  await setRole(page, 0, "perfect");
  await page.locator("#analyze").check();
  // The certified rank is exact from the preview on and never changes,
  // however the background fill later completes the other columns.
  await expect(page.locator("#scores span").nth(1)).toHaveText("W1");
  await expect(page.locator(".disc")).toHaveCount(9, { timeout: 2500 });
  expect(await boardBox(page)).toEqual(box);
  expect(await page.evaluate(() => (window as any).hintTest.requests.filter((r: any) => r.type === "analyze"))).toEqual([]);
});

test("enabling hints during a computer move keeps its proven highlight", async ({ page }) => {
  await openApp(page, "35273425116235");
  await setRole(page, 0, "perfect");
  // Wait for Perfect's calculated move, then enable hints inside its delay.
  await expect
    .poll(
      () => page.evaluate(() => (window as any).hintTest.replies.some((r: any) => r.type === "moved" && !r.timedOut)),
      { timeout: 30_000 },
    )
    .toBe(true);
  await page.locator("#analyze").check();
  // The late score peek must not erase the proof the search just proved.
  await expect(page.locator("#scores span").nth(2)).toHaveText("W14");
  await expect(page.locator('#board [data-col="2"]')).toHaveClass(/best-col/);
});

async function openHoldingAnalyze(page: Page, moves: string): Promise<void> {
  await page.addInitScript(() => {
    const state = { requests: [] as { type: string }[], held: [] as (() => void)[], release: false };
    Object.assign(window, { hintTest: state });
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener("message", (event) => {
          if (event.data.type !== "analyzed" || state.release || state.held.length > 0) return;
          event.stopImmediatePropagation();
          state.held.push(() => this.dispatchEvent(new MessageEvent("message", { data: event.data })));
        });
      }
      override postMessage(message: any): void {
        state.requests.push(message);
        super.postMessage(message);
      }
    };
  });
  await page.goto(`/connect4/#moves=${moves}&DEBUG`);
  await expect(page.locator("#engine-line")).toHaveText(/Solver ready/i, { timeout: 60_000 });
  await expect(page.locator("#books-line")).not.toContainText(/Downloading/, { timeout: 60_000 });
  await expect(page.locator("#books-line")).toContainText(/move book [1-9]/, { timeout: 60_000 });
  await page.locator("#analyze").check();
  // The search-free preview goes out before the blocking search. Poll: the
  // analyze post waits on the preview round-trip, so a one-shot read races it.
  await expect.poll(() =>
    page.evaluate(() =>
      (window as any).hintTest.requests
        .filter((r: any) => r.type === "availableScores" || r.type === "analyze")
        .map((r: any) => r.type),
    ),
  ).toEqual(["availableScores", "analyze"]);
}

async function releaseAnalyze(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => (window as any).hintTest.held.length), { timeout: 60_000 }).toBe(1);
  await page.evaluate(() => {
    const state = (window as any).hintTest;
    state.release = true;
    state.held.splice(0).forEach((release: () => void) => release());
  });
}

test("a certified preview shows the exact rank instantly, then fills every column", async ({ page }) => {
  await openHoldingAnalyze(page, "44444156");
  // Certified preview: exact rank and proven status with no search at all.
  await expect(page.locator("#scores span")).toHaveText(["…", "…", "…", "…", "…", "W1", "…"]);
  await expect(page.locator("#board .best-col")).toHaveCount(1);
  await expect(page.locator("#status")).toContainText("win");
  await expect(page.locator("#engine-line")).toHaveText(/analyzing/i);
  await releaseAnalyze(page);
  // Background scoring filled every legal column; the proof never flickered.
  await expect(page.locator("#scores span")).toHaveText(["L2", "L2", "D", "L2", "D", "W1", "D"]);
  await expect(page.locator("#scores span", { hasText: "?" })).toHaveCount(0);
  await expect(page.locator("#board .best-col")).toHaveCount(1);
  await expect(page.locator("#status")).toContainText("win");
  await expect(page.locator("#engine-line")).not.toHaveText(/analyzing/i);
  await expect(page.locator("#engine-line")).not.toContainText(/Timed out/i);
});

test("analysis keeps scoring past a certified frontier column", async ({ page }) => {
  await openHoldingAnalyze(page, "44444666");
  // Certified preview only: exact rank, everything else pending.
  await expect(page.locator("#scores span")).toHaveText(["…", "…", "…", "…", "…", "W1", "…"]);
  const preview = await page.locator("#scores span").allTextContents();
  await expect(page.locator("#status")).toContainText("win");
  await releaseAnalyze(page);
  // The background search landed more exact scores instead of stopping.
  await expect
    .poll(() => page.locator("#scores span").allTextContents(), { timeout: 60_000 })
    .not.toEqual(preview);
  await expect(page.locator("#scores span", { hasText: "?" })).toHaveCount(0);
  await expect(page.locator('#board [data-col="5"]')).toHaveClass(/best-col/);
  await expect(page.locator("#status")).toContainText("win");
  await expect(page.locator("#engine-line")).not.toHaveText(/analyzing/i);
});

test("analysis scores every column past a bare move-book hit", async ({ page }) => {
  await openHoldingAnalyze(page, "4444422234");
  // Bare suggestion first: `?` on column 2, everything else pending.
  await expect(page.locator("#scores span")).toHaveText(["…", "?", "…", "…", "…", "…", "…"]);
  await expect(page.locator('#board [data-col="1"]')).toHaveClass(/best-col/);
  await releaseAnalyze(page);
  // No short-circuit: every legal column gets its exact score.
  await expect(page.locator("#scores span")).toHaveText(["L3", "D", "L2", "", "L1", "D", "L2"]);
  await expect(page.locator("#board .best-col")).toHaveCount(2);
  await expect(page.locator("#status")).toContainText("draw");
  await expect(page.locator("#engine-line")).not.toContainText(/Timed out/i);
});

test("a late score-book reply cannot restore hints after switching them off", async ({ page }) => {
  await openApp(page);
  await setRole(page, 0, "perfect");
  await page.evaluate(() => { (window as any).hintTest.hold = true; });
  await page.locator("#analyze").check();
  await expect.poll(() => page.evaluate(() => (window as any).hintTest.held.length)).toBeGreaterThan(0);
  await page.locator("#analyze").uncheck();
  await page.evaluate(() => {
    const state = (window as any).hintTest;
    state.hold = false;
    state.held.splice(0).forEach((release: () => void) => release());
  });
  await expect(page.locator("#scores")).toBeHidden();
  await expect(page.locator("#board .best-col")).toHaveCount(0);
});
