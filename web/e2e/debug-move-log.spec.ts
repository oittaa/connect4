import { expect, type Page, test } from "@playwright/test";

const MOVE_LOG = /^(score book|move book|engine|tactical|forced|random|human)\b/;

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

test("DEBUG Perfect opening logs a score-book hit with ply and side", async ({ page }) => {
  const logs = collectMoveLogs(page);
  await page.goto("/connect4/#DEBUG");
  await waitSolver(page);
  await waitBooks(page);
  await expect(page.locator("#books-line")).toContainText(/Score book .*\(through move 8\)/);
  await setPace(page, 0);
  await page.locator('input[name="role0"][value="perfect"]').check();
  await expect(page.locator(".disc")).toHaveCount(1);
  expect(logs.join("\n")).toMatch(/^score book W1 \(ply 1, Red, column 4\)$/m);
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
  expect(logs.join("\n")).toMatch(/^move book \(ply 11, Red, column [1-7]\)$/m);
  expect(logs.join("\n")).not.toMatch(/^(engine|score book)\b/m);
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
  expect(logs.join("\n")).toMatch(/^engine .*hashes\/s.*\(ply 5, Red, column [1-7]\)$/m);
});

test("DEBUG Easy logs a random local drop", async ({ page }) => {
  const logs = collectMoveLogs(page);
  await page.goto("/connect4/#DEBUG");
  await waitSolver(page);
  await setPace(page, 0);
  await page.locator('input[name="role0"][value="easy"]').check();
  await expect(page.locator(".disc")).toHaveCount(1);
  expect(logs.join("\n")).toMatch(/^random \(ply 1, Red, column [1-7]\)$/m);
});

test("DEBUG Easy logs a forced win", async ({ page }) => {
  const logs = collectMoveLogs(page);
  await page.goto("/connect4/#moves=121314&DEBUG");
  await waitSolver(page);
  await setPace(page, 0);
  await page.locator('input[name="role0"][value="easy"]').check();
  await expect(page.locator(".disc")).toHaveCount(7);
  expect(logs.join("\n")).toMatch(/^forced \(ply 7, Red, column 1\)$/m);
});

test("DEBUG human drops log ply and side", async ({ page }) => {
  const logs = collectMoveLogs(page);
  await page.goto("/connect4/#DEBUG");
  await waitSolver(page);
  await page.locator('#board [data-col="3"]').click();
  await expect(page.locator(".disc")).toHaveCount(1);
  expect(logs.join("\n")).toMatch(/^human \(ply 1, Red, column 4\)$/m);
  await page.locator('#board [data-col="2"]').click();
  await expect(page.locator(".disc")).toHaveCount(2);
  expect(logs.join("\n")).toMatch(/^human \(ply 2, Yellow, column 3\)$/m);
});

test("without DEBUG neither computer nor human moves log selection", async ({ page }) => {
  const logs = collectMoveLogs(page);
  await page.goto("/connect4/");
  await setPace(page, 0);
  await page.locator('#board [data-col="3"]').click();
  await expect(page.locator(".disc")).toHaveCount(1);
  await page.locator('input[name="role1"][value="easy"]').check();
  await expect(page.locator(".disc")).toHaveCount(2);
  expect(logs).toEqual([]);
});
