import { expect, type Page, test } from "@playwright/test";

/**
 * Leftover computer-status paint after the last computer seat becomes Human.
 * Serve the production build under /connect4/ so worker/WASM paths match hosting.
 */
async function openApp(page: Page): Promise<void> {
  await page.goto("/connect4/#DEBUG");
  const hints = page.locator("#analyze");
  await expect(hints).toBeVisible();
  if (await hints.isChecked()) await hints.uncheck();
}

async function setPace(page: Page, ms: number): Promise<void> {
  await page.locator("#delay").evaluate((el, value) => {
    const input = el as HTMLInputElement;
    input.value = String(value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, ms);
  await expect(page.locator("#delay-label")).toHaveText(`${ms} ms`);
}

async function setRedRole(page: Page, role: "human" | "easy" | "perfect"): Promise<void> {
  await page.locator(`input[name="role0"][value="${role}"]`).check();
}

test.describe("computer status after switching to Human", () => {
  test.describe.configure({ mode: "serial" });

  test("switching to Human while Perfect is thinking clears thinking status", async ({
    page,
  }) => {
    await openApp(page);
    await setPace(page, 1500);
    await expect(page.locator("#engine-line")).toHaveText(/Solver ready/i, { timeout: 60_000 });

    await setRedRole(page, "perfect");
    const status = page.locator("#status");
    await expect(status).toHaveText(/Red thinking/i);
    await expect(status).toHaveClass(/thinking/);

    await setRedRole(page, "human");
    await expect(status).not.toHaveText(/thinking/i);
    await expect(status).not.toHaveClass(/thinking/);
    await expect(status).toHaveText(/Red to move/i);
  });

  test("changing the last computer to Human while paused clears paused status", async ({
    page,
  }) => {
    await openApp(page);
    await setPace(page, 1500);
    await setRedRole(page, "easy");

    const pause = page.locator("#pause");
    await expect(pause).toBeVisible();
    await pause.click();
    const status = page.locator("#status");
    await expect(status).toHaveText(/Paused/i);
    await expect(pause).toHaveText(/Resume/i);

    await setRedRole(page, "human");
    await expect(pause).toBeHidden();
    await expect(status).not.toHaveText(/Paused/i);
    await expect(status).toHaveText(/Red to move/i);
  });
});
