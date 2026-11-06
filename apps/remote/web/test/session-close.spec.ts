// SPDX-License-Identifier: Apache-2.0
// Close session from its view, against the fake host: one tap only arms
// the "Close?" confirm and nothing is sent; the confirm reverts after
// its window; a second tap sends kill{req,id}, the host's
// ok/exited/session_removed land the view on the sessions list with the
// session gone and a "Session closed" flash; a host error matching the
// kill's req re-arms the button with the message and keeps the view.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

async function killsSent(page: Page): Promise<{ req?: string; id?: string }[]> {
  return page.evaluate(() =>
    window.__fake
      .sent()
      .filter((frame) => (frame as { t?: string }).t === "kill")
      .map((frame) => {
        const { req, id } = frame as { req?: string; id?: string };
        return { req, id };
      }),
  );
}

const closeButton = (page: Page) => page.locator("#session-close");

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/fake.html");
  await page.locator('[data-session="smoke"]').click();
  await expect.poll(() => page.evaluate(() => window.__fake.terminalText())).toContain(
    "hello from the host",
  );
});

test("one tap only arms the confirm, which reverts after the window", async ({ page }) => {
  await closeButton(page).click();
  await expect(closeButton(page)).toHaveClass(/confirm/);
  await expect(closeButton(page)).toContainText("Close?");
  expect(await killsSent(page)).toEqual([]);
  // Past the four-second window the button is the plain icon again.
  await page.waitForTimeout(4100);
  await expect(closeButton(page)).not.toHaveClass(/confirm/);
  await expect(closeButton(page)).not.toContainText("Close?");
  expect(await killsSent(page)).toEqual([]);
});

test("two taps send kill and land on the list with the session gone", async ({ page }) => {
  await closeButton(page).click();
  await expect(closeButton(page)).toHaveClass(/confirm/);
  await closeButton(page).click();
  await expect.poll(() => killsSent(page).then((sent) => sent.length)).toBe(1);
  const [kill] = await killsSent(page);
  expect(kill!.id).toBe("smoke");
  expect(typeof kill!.req).toBe("string");
  // The host's session_removed leaves the view for the sessions home,
  // where the closed session is gone and the flash confirms it.
  await expect(page.locator("main.sessions")).toBeVisible();
  await expect(page.locator('[data-session="smoke"]')).toHaveCount(0);
  await expect(page.locator(".flash-ok")).toContainText("Session closed");
});

test("a host error re-arms the button and keeps the view", async ({ page }) => {
  await page.evaluate(() => window.__fake.failNextKill?.("internal", "kill refused by host"));
  await closeButton(page).click();
  await closeButton(page).click();
  await expect.poll(() => killsSent(page).then((sent) => sent.length)).toBe(1);
  // The error matching the kill's req lands on the exit badge; the view
  // stays and the button re-arms for another try.
  await expect(page.locator("#session-exit")).toHaveText("kill refused by host");
  await expect(page.locator(".session-view")).toBeVisible();
  await expect(closeButton(page)).toBeEnabled();
  await expect(closeButton(page)).not.toHaveClass(/confirm/);
});
