// SPDX-License-Identifier: Apache-2.0
// Scheduling a Prompt Builder draft against the fake host: open the
// builder, schedule the draft for later, see it listed under "Scheduled
// for this session", cancel it, see it gone — at a 360x640 phone viewport.
import { expect, test } from "@playwright/test";

function futureLocalValue(): string {
  const at = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `T${pad(at.getHours())}:${pad(at.getMinutes())}`
  );
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto("/fake.html");
  await page.locator('[data-session="smoke"]').click();
  await expect.poll(() => page.evaluate(() => window.__fake.terminalText())).toContain("hello from the host");
});

test("schedule a draft, see it listed, cancel it", async ({ page }) => {
  await page.locator("#term-builder").click();
  await expect(page.locator("#builder-form")).toBeVisible();
  await page.locator(".section-content").fill("water the plants");
  // A fresh host holds no schedules, so the block is absent, not empty.
  await expect(page.locator("#builder-scheduled")).toHaveCount(0);

  await page.locator("#builder-schedule").click();
  await expect(page.locator("#builder-schedule-row")).toBeVisible();
  // Every new target clears 44 px.
  for (const selector of ["#builder-schedule", "#builder-schedule-confirm", "#builder-schedule-dismiss"]) {
    const box = await page.locator(selector).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  await page.locator("#builder-schedule-at").fill(futureLocalValue());
  await page.evaluate(() => window.__fake.clearSent());
  await page.locator("#builder-schedule-confirm").click();

  // The sheet stays open with a status line and a cleared draft.
  await expect(page.locator("#builder-schedule-status")).toContainText("Scheduled for");
  await expect(page.locator("#builder-form")).toBeVisible();
  await expect(page.locator(".section-content")).toHaveValue("");
  const sent = await page.evaluate(() => window.__fake.sent());
  const scheduled = (sent as Record<string, unknown>[]).find((frame) => frame.t === "prompt_schedule");
  expect(scheduled).toMatchObject({ t: "prompt_schedule", id: "smoke" });
  expect(typeof scheduled?.fire_at).toBe("string");
  expect(Number.isNaN(Date.parse(scheduled?.fire_at as string))).toBe(false);

  // The new schedule lists with the local fire time and its preview.
  const row = page.locator(".scheduled-item");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("water the plants");
  const cancelBox = await row.locator("button[data-schedule-id]").boundingBox();
  expect(cancelBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  const overflow = await page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);

  // Cancelling drops the row once the host's ok lands.
  await row.locator("button[data-schedule-id]").click();
  await expect(page.locator(".scheduled-item")).toHaveCount(0);
  await expect(page.locator("#builder-scheduled")).toHaveCount(0);
});
