import { expect, type Page, test } from "@playwright/test";

async function setPace(page: Page, ms: number): Promise<void> {
  await page.locator("#delay").evaluate((el, value) => {
    const input = el as HTMLInputElement;
    input.value = String(value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, ms);
  await expect(page.locator("#delay-label")).toHaveText(`${ms} ms`);
}

async function waitSolverAndBooks(page: Page): Promise<void> {
  await expect(page.locator("#engine-line")).toHaveText(/Solver ready/i, { timeout: 60_000 });
  await expect(page.locator("#books-line")).not.toContainText(/Downloading/, { timeout: 60_000 });
  await expect(page.locator("#books-line")).toContainText(/move book [1-9]/, { timeout: 60_000 });
}

async function expectCurrentAnalysis(page: Page): Promise<void> {
  const scores = page.locator("#scores span");
  await expect(scores).toHaveCount(7);
  await expect(scores.first()).not.toHaveText("…");
  await expect(scores.first()).toHaveText(/^(W\d+|L\d+|D)$/);
  await expect(page.locator("#engine-line")).toHaveText(/instant|cache hit|search/i);
  await expect(page.locator("#engine-line")).not.toHaveText(/analyzing/i);
  await expect(page.locator("#engine-line")).not.toHaveText(/^Solver ready/i);
}

async function expectBooksStillLoaded(page: Page): Promise<void> {
  await expect(page.locator("#books-line")).toContainText(/move book [1-9]/);
  await expect(page.locator("#books-line")).not.toContainText(/Downloading/);
}

test.describe("stale search restart", () => {
  test("New during in-flight 44444222 analysis returns a usable result without waiting out the search", async ({
    page,
  }) => {
    await page.goto("/connect4/#moves=44444222&DEBUG");
    await waitSolverAndBooks(page);
    await setPace(page, 0);
    await page.locator("#analyze").check();
    await expect(page.locator("#engine-line")).toHaveText(/analyzing/i, { timeout: 5_000 });
    const t0 = Date.now();
    await page.locator("#new").click();
    await expect(page.locator("#status")).toHaveText(/Red to move/i);
    await expect(page.locator(".disc")).toHaveCount(0);
    await expectCurrentAnalysis(page);
    expect(Date.now() - t0).toBeLessThan(2500);
    await expect(page.locator("#status")).toHaveText(/Red to move · win/i);
    await expectBooksStillLoaded(page);
  });

  test("Back during in-flight 44444222 analysis returns a usable result quickly", async ({
    page,
  }) => {
    await page.goto("/connect4/#moves=44444222&DEBUG");
    await waitSolverAndBooks(page);
    await setPace(page, 0);
    await page.locator("#analyze").check();
    await expect(page.locator("#engine-line")).toHaveText(/analyzing/i, { timeout: 5_000 });
    const t0 = Date.now();
    await page.locator("#back").click();
    await expect(page.locator("#status")).toHaveText(/Yellow to move/i);
    await expect(page.locator(".disc")).toHaveCount(7);
    await expectCurrentAnalysis(page);
    expect(Date.now() - t0).toBeLessThan(2500);
    await expectBooksStillLoaded(page);
  });

  test("Perfect during in-flight 44444222 analysis places a disc without waiting out the search", async ({
    page,
  }) => {
    await page.goto("/connect4/#moves=44444222&DEBUG");
    await waitSolverAndBooks(page);
    await setPace(page, 0);
    await page.locator("#analyze").check();
    await expect(page.locator("#engine-line")).toHaveText(/analyzing/i, { timeout: 5_000 });
    const t0 = Date.now();
    await page.locator('input[name="role0"][value="perfect"]').check();
    await expect(page.locator(".disc")).toHaveCount(9);
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  test("Perfect after canceling in-flight analysis is an instant move-book hit", async ({ page }) => {
    await page.goto("/connect4/#moves=44444222&DEBUG");
    await waitSolverAndBooks(page);
    await setPace(page, 0);
    await page.locator("#analyze").check();
    await expect(page.locator("#engine-line")).toHaveText(/analyzing/i, { timeout: 5_000 });
    await page.locator("#analyze").uncheck();
    const t0 = Date.now();
    await page.locator('input[name="role0"][value="perfect"]').check();
    await expect(page.locator(".disc")).toHaveCount(9);
    await expect(page.locator("#engine-line")).toHaveText(/instant \(move book\)/i);
    expect(Date.now() - t0).toBeLessThan(1500);
    await expectBooksStillLoaded(page);
  });

  test("move-book-hit Perfect still moves immediately when no search is in flight", async ({ page }) => {
    await page.goto("/connect4/#moves=44444222&DEBUG");
    await waitSolverAndBooks(page);
    await setPace(page, 0);
    const t0 = Date.now();
    await page.locator('input[name="role0"][value="perfect"]').check();
    await expect(page.locator(".disc")).toHaveCount(9);
    expect(Date.now() - t0).toBeLessThan(1000);
    await expect(page.locator("#engine-line")).toHaveText(/instant \(move book\)/i);
  });
});
