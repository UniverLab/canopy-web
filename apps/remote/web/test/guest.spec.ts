// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";

// The guest app against the fake host (?screen=guest): the grant the hub
// would enforce, played by fixtures — the list carries the granted subset,
// any other attach is forbidden, and the untrusted guest gets nothing.

async function guestOpen(page: import("@playwright/test").Page, id: string): Promise<void> {
  await page.evaluate((sessionId: string) => {
    const open = window.__fake.guestOpen;
    if (!open) {
      throw new Error("guest-only hook missing outside ?screen=guest");
    }
    open(sessionId);
  }, id);
}

test("a trusted guest sees the granted session only, and joins it read-only", async ({
  page,
}) => {
  await page.goto("/fake.html?screen=guest");
  await expect(page.locator(".sessions-head h2")).toHaveText("Shared sessions");
  await expect(page.locator('[data-session="smoke"]')).toBeVisible();
  // The owner holds secret too; the grant does not cover it.
  await expect(page.locator('[data-session="secret"]')).toHaveCount(0);
  await expect(page.locator("#session-new")).toHaveCount(0);
  await page.locator('[data-session="smoke"]').click();
  await expect(page.locator("#guest-output")).toContainText("hello from the host");
  await expect(page.locator("#guest-status")).toHaveCount(0);
  // Read-only: no composer, no key bar, no input anywhere.
  await expect(page.locator("textarea, input, #keybar")).toHaveCount(0);
});

test("joining outside the grant fails closed with unauthorized", async ({ page }) => {
  await page.goto("/fake.html?screen=guest");
  await expect(page.locator('[data-session="smoke"]')).toBeVisible();
  await guestOpen(page, "secret");
  await expect(page.locator("#guest-notice")).toContainText("not shared with you");
  // Back on the list, whose rows are untouched.
  await expect(page.locator(".sessions-head h2")).toHaveText("Shared sessions");
  await expect(page.locator('[data-session="smoke"]')).toBeVisible();
  const sent = await page.evaluate(() => window.__fake.sent());
  expect(sent).toContainEqual(expect.objectContaining({ t: "attach", id: "secret" }));
  expect(sent).toContainEqual(expect.objectContaining({ t: "detach", id: "secret" }));
});

test("an untrusted guest sees nothing and cannot join", async ({ page }) => {
  await page.goto("/fake.html?screen=guest&grant=none");
  await expect(page.locator("p.empty")).toHaveText("No sessions shared with you.");
  await guestOpen(page, "smoke");
  await expect(page.locator("#guest-notice")).toContainText("not shared with you");
  await expect(page.locator("[data-session]")).toHaveCount(0);
});

test("screenshots the guest list next to the owner list", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/fake.html?screen=guest");
  await expect(page.locator('[data-session="smoke"]')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("guest-list.png") });
  await page.goto("/fake.html");
  await expect(page.locator('[data-session="smoke"]')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("owner-list.png") });
});
