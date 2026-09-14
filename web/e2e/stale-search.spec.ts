import { expect, type Page, test } from "@playwright/test";

async function setPace(page: Page, ms: number): Promise<void> {
  await page.locator("#delay").evaluate((el, value) => {
    const input = el as HTMLInputElement;
    input.value = String(value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, ms);
  await expect(page.locator("#delay-label")).toHaveText(`${ms} ms`);
}

async function waitSolverReady(page: Page): Promise<void> {
  await expect(page.locator("#engine-line")).toHaveText(/Solver ready/i, { timeout: 60_000 });
}

test.describe("stale search restart", () => {
  test("New during in-flight 44444222 analysis returns a usable result without waiting out the search", async ({
    page,
  }) => {
    await page.goto("/connect4/#moves=44444222&DEBUG");
    await waitSolverReady(page);
    await setPace(page, 0);
    await page.locator("#analyze").check();
    await expect(page.locator("#engine-line")).toHaveText(/analyzing/i, { timeout: 5_000 });
    const t0 = Date.now();
    await page.locator("#new").click();
    await expect(page.locator("#status")).toHaveText(/Red to move/i);
    await expect(page.locator("#engine-line")).not.toHaveText(/analyzing/i);
    expect(Date.now() - t0).toBeLessThan(2500);
    await expect(page.locator(".disc")).toHaveCount(0);
  });

  test("Back during in-flight 44444222 analysis returns a usable result quickly", async ({
    page,
  }) => {
    await page.goto("/connect4/#moves=44444222&DEBUG");
    await waitSolverReady(page);
    await setPace(page, 0);
    await page.locator("#analyze").check();
    await expect(page.locator("#engine-line")).toHaveText(/analyzing/i, { timeout: 5_000 });
    const t0 = Date.now();
    await page.locator("#back").click();
    await expect(page.locator("#status")).toHaveText(/Yellow to move/i);
    await expect(page.locator("#engine-line")).not.toHaveText(/analyzing/i);
    expect(Date.now() - t0).toBeLessThan(2500);
    await expect(page.locator(".disc")).toHaveCount(7);
  });

  test("book-hit Perfect still moves immediately", async ({ page }) => {
    await page.goto("/connect4/#moves=44444222&DEBUG");
    await waitSolverReady(page);
    await setPace(page, 0);
    const t0 = Date.now();
    await page.locator('input[name="role0"][value="perfect"]').check();
    await expect(page.locator(".disc")).toHaveCount(9);
    expect(Date.now() - t0).toBeLessThan(1000);
    await expect(page.locator("#engine-line")).toHaveText(/instant \(move book\)/i);
  });
});
