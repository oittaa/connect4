import { expect, type Page, test } from "@playwright/test";

const MOVE_LOG = /^(score book|move book|engine|tactical|forced|random)\b/;

function collectMoveLogs(page: Page): string[] {
  const logs: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() !== "log") return;
    const text = msg.text();
    if (MOVE_LOG.test(text)) logs.push(text);
  });
  return logs;
}

async function setPace(page: Page, ms: number): Promise<void> {
  await page.locator("#delay").evaluate((el, value) => {
    const input = el as HTMLInputElement;
    input.value = String(value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, ms);
  await expect(page.locator("#delay-label")).toHaveText(`${ms} ms`);
}

async function waitSolver(page: Page): Promise<void> {
  await expect(page.locator("#engine-line")).toHaveText(/Solver ready/i, { timeout: 60_000 });
}

async function waitBooks(page: Page): Promise<void> {
  await expect(page.locator("#books-line")).not.toContainText(/Downloading/, { timeout: 60_000 });
}

test("DEBUG Perfect opening logs a score-book hit with the score", async ({ page }) => {
  const logs = collectMoveLogs(page);
  await page.goto("/connect4/#DEBUG");
  await waitSolver(page);
  await waitBooks(page);
  await expect(page.locator("#books-line")).toContainText(/Score book .*\(through move 8\)/);
  await setPace(page, 0);
  await page.locator('input[name="role0"][value="perfect"]').check();
  await expect(page.locator(".disc")).toHaveCount(1);
  expect(logs.some((line) => /^score book W1 \(column 4\)$/.test(line))).toBe(true);
});

test("DEBUG Perfect at ply 10 logs a move-book hit", async ({ page }) => {
  const logs = collectMoveLogs(page);
  await page.goto("/connect4/#moves=4444422234&DEBUG");
  await waitSolver(page);
  await waitBooks(page);
  await expect(page.locator("#books-line")).toContainText(/move book .*\(through move 12\)/);
  await setPace(page, 0);
  await page.locator('input[name="role0"][value="perfect"]').check();
  await expect(page.locator(".disc")).toHaveCount(11);
  expect(logs.some((line) => /^move book \(column [1-7]\)$/.test(line))).toBe(true);
  expect(logs.some((line) => line.startsWith("engine") || line.startsWith("score book"))).toBe(false);
});

test("DEBUG Perfect past the embedded score book logs engine hashes/s", async ({ page }) => {
  const logs = collectMoveLogs(page);
  await page.goto("/connect4/#moves=4444&DEBUG");
  await waitSolver(page);
  await waitBooks(page);
  await page.locator("#books").uncheck();
  await expect(page.locator("#books-line")).toContainText(/Score book .*\(through move 4\)/);
  await expect(page.locator("#books-line")).toContainText("move book not loaded");
  await setPace(page, 0);
  await page.locator('input[name="role0"][value="perfect"]').check();
  await expect(page.locator(".disc")).toHaveCount(5);
  expect(logs.some((line) => /^engine .*hashes\/s/.test(line))).toBe(true);
});

test("DEBUG Easy logs random and forced local paths", async ({ page }) => {
  const logs = collectMoveLogs(page);
  await page.goto("/connect4/#DEBUG");
  await waitSolver(page);
  await setPace(page, 0);
  await page.locator('input[name="role0"][value="easy"]').check();
  await expect(page.locator(".disc")).toHaveCount(1);
  expect(logs.some((line) => /^random \(column [1-7]\)$/.test(line))).toBe(true);

  await page.locator("#new").click();
  await page.goto("/connect4/#moves=121314&DEBUG");
  await waitSolver(page);
  await setPace(page, 0);
  logs.length = 0;
  await page.locator('input[name="role0"][value="easy"]').check();
  await expect(page.locator(".disc")).toHaveCount(7);
  expect(logs.some((line) => line === "forced (column 1)")).toBe(true);
});

test("without DEBUG a computer move does not log selection", async ({ page }) => {
  const logs = collectMoveLogs(page);
  await page.goto("/connect4/");
  await setPace(page, 0);
  await page.locator('input[name="role0"][value="easy"]').check();
  await expect(page.locator(".disc")).toHaveCount(1);
  expect(logs).toEqual([]);
});
