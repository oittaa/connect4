import { expect, type Page, test } from "@playwright/test";

async function setPace(page: Page, ms: number): Promise<void> {
  await page.locator("#delay").evaluate((el, value) => {
    const input = el as HTMLInputElement;
    input.value = String(value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, ms);
  await expect(page.locator("#delay-label")).toHaveText(`${ms} ms`);
}

async function expectFatalSolver(page: Page): Promise<void> {
  const alert = page.locator("#solver-alert");
  await expect(alert).toBeVisible({ timeout: 20_000 });
  await expect(alert).toContainText(/The solver failed\. Reload to try again\./);
  await expect(page.locator("#solver-reload")).toBeVisible();
  await expect(page.locator("#engine-diagnostics")).toBeHidden();
  await expect(page.locator("#status")).not.toHaveClass(/thinking/);
}

test.describe("solver worker failures", () => {
  test("worker module load failure shows a reload action without DEBUG", async ({ page }) => {
    await page.route(/\/assets\/worker-[^/]+\.js$/, (route) => route.abort());
    await page.goto("/connect4/");
    await expectFatalSolver(page);

    await setPace(page, 0);
    await page.locator('input[name="role0"][value="perfect"]').check();
    await expect(page.locator('input[name="role0"][value="perfect"]')).toBeChecked();
    await page.waitForTimeout(400);
    await expect(page.locator(".disc")).toHaveCount(0);

    await page.locator('input[name="role0"][value="easy"]').check();
    await expect(page.locator(".disc.p1")).toHaveCount(1);

    await page.locator('input[name="role0"][value="human"]').check();
    await page.locator("#new").click();
    await page.locator(".col[data-col='3']").click();
    await expect(page.locator(".disc.p1")).toHaveCount(1);
    await expect(page).toHaveURL(/moves=4/);

    await page.locator("#solver-reload").click();
    await expectFatalSolver(page);
    await expect(page.locator(".disc.p1")).toHaveCount(1);
  });

  test("WASM initialization failure shows a reload action without DEBUG", async ({ page }) => {
    await page.route(/engine_bg-[^/]+\.wasm$/, (route) => route.abort());
    await page.goto("/connect4/");
    await expectFatalSolver(page);
    await page.locator(".col[data-col='2']").click();
    await expect(page.locator(".disc.p1")).toHaveCount(1);
    await expect(page.locator("#status")).toHaveText(/Yellow to move/i);
  });

  test("book download failure does not declare the solver broken", async ({ page }) => {
    await page.route(/opening\.c4(book|move)$/, (route) =>
      route.fulfill({ status: 404, body: "missing", contentType: "text/plain" }),
    );
    await page.goto("/connect4/#DEBUG");
    await expect(page.locator("#engine-line")).toHaveText(/Solver ready/i, { timeout: 60_000 });
    await expect(page.locator("#solver-alert")).toBeHidden();
    await expect(page.locator("#books-line")).toContainText(/failed/i);

    await setPace(page, 0);
    await page.locator('input[name="role0"][value="perfect"]').check();
    await expect(page.locator(".disc.p1")).toHaveCount(1);
    await expect(page.locator("#solver-alert")).toBeHidden();
  });
});
