import { expect, type Page, test } from "@playwright/test";

/** Played-disc DEBUG lines. Not origin-label clones — ply/column must match the URL. */
const PLAYED = /^ply (\d+) (Red|Yellow) .+, column ([1-7])$/;

function collectPlayedLogs(page: Page): string[] {
  const logs: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() !== "log") return;
    const text = msg.text();
    if (PLAYED.test(text)) logs.push(text);
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

test("Medium vs Medium from one disc plays, and DEBUG ply/column match the URL", async ({ page }) => {
  const logs = collectPlayedLogs(page);
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });

  await page.goto("/connect4/#moves=4&DEBUG");
  await expect(page.locator("#engine-line")).toHaveText(/Solver ready/i, { timeout: 60_000 });
  await setPace(page, 0);
  await page.locator('input[name="role0"][value="medium"]').check();
  await page.locator('input[name="role1"][value="medium"]').check();
  await expect(page.locator(".disc")).toHaveCount(8, { timeout: 60_000 });

  await expect(page.locator("#engine-line")).not.toHaveText(/is not a function/);
  expect(errors.join("\n")).not.toMatch(/setScore is not a function/);

  const seq = new URL(page.url()).hash.match(/moves=([1-7]+)/)?.[1] ?? "";
  expect(seq.length).toBeGreaterThanOrEqual(8);

  const plies = logs.map((line) => {
    const m = line.match(PLAYED);
    expect(m, line).not.toBeNull();
    return { ply: Number(m![1]), side: m![2], col: Number(m![3]), line };
  });
  expect(plies.length).toBeGreaterThanOrEqual(7);
  expect(new Set(plies.map((p) => p.ply)).size, logs.join("\n")).toBe(plies.length);
  for (const row of plies) {
    expect(seq[row.ply - 1], row.line).toBe(String(row.col));
    expect(row.side, row.line).toBe(row.ply % 2 === 1 ? "Red" : "Yellow");
  }
});
