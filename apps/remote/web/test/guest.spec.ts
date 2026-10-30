// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";

// The guest app against the fake host (?screen=guest): the grant the hub
// would enforce, played by fixtures — the list carries the granted subset,
// any other attach is forbidden, and the untrusted guest gets nothing.
// Inside a granted session the guest drives the owner's own terminal, key
// bar and composer over the one shared stream.

async function guestOpen(page: import("@playwright/test").Page, id: string): Promise<void> {
  await page.evaluate((sessionId: string) => {
    const open = window.__fake.guestOpen;
    if (!open) {
      throw new Error("guest-only hook missing outside ?screen=guest");
    }
    open(sessionId);
  }, id);
}

async function terminalText(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(() => window.__fake.terminalText());
}

test("a trusted guest sees the granted session only", async ({ page }) => {
  await page.goto("/fake.html?screen=guest");
  await expect(page.locator(".sessions-head h2")).toHaveText("Shared sessions");
  await expect(page.locator('[data-session="smoke"]')).toBeVisible();
  // The owner holds secret too; the grant does not cover it.
  await expect(page.locator('[data-session="secret"]')).toHaveCount(0);
  await expect(page.locator("#session-new")).toHaveCount(0);
});

test("a guest joins a granted session with the owner's terminal and composer", async ({
  page,
}) => {
  await page.goto("/fake.html?screen=guest");
  await page.locator('[data-session="smoke"]').click();
  await expect(page.locator("#term-pane .xterm-screen")).toBeVisible();
  await expect.poll(() => terminalText(page)).toContain("hello from the host");
  await expect(page.locator("#keybar .key")).toHaveCount(9);
  await expect(page.locator(".composer-input")).toBeVisible();
  await expect(page.locator(".composer-send")).toBeVisible();
  // The grant's boundary in the UI: no builder, no files, no new session.
  await expect(page.locator(".composer-builder")).toBeHidden();
  await expect(page.locator("#session-files")).toHaveCount(0);
  await expect(page.locator("#guest-exit")).toBeHidden();
});

test("a guest types and the shared stream answers, like the owner's", async ({ page }) => {
  await page.goto("/fake.html?screen=guest");
  await page.locator('[data-session="smoke"]').click();
  await expect(page.locator("#term-pane .xterm-screen")).toBeVisible();
  await page.evaluate(() => window.__fake.clearSent());
  await page.locator(".xterm-helper-textarea").press("l");
  await page.locator(".xterm-helper-textarea").press("s");
  await page.locator('#keybar .key[data-key="enter"]').click();
  const sent = await page.evaluate(() => window.__fake.sent());
  expect(sent).toContainEqual({ t: "input", id: "smoke", data: "bA==" });
  expect(sent).toContainEqual({ t: "input", id: "smoke", data: "cw==" });
  expect(sent).toContainEqual({ t: "input", id: "smoke", data: "DQ==" });
  // Whatever the host prints lands on the guest's terminal too: no
  // locking, one stream for the owner and every guest on the session.
  await page.evaluate(() => window.__fake.pushOut("live line\r\n"));
  await expect.poll(() => terminalText(page)).toContain("live line");
});

test("a guest sends prompts and the host answers ok and error", async ({ page }) => {
  await page.goto("/fake.html?screen=guest");
  await page.locator('[data-session="smoke"]').click();
  await expect(page.locator("#term-pane .xterm-screen")).toBeVisible();
  await page.locator(".composer-input").fill("do the thing");
  await page.locator(".composer-send").click();
  const sent = await page.evaluate(() => window.__fake.sent());
  const prompt = (sent as { t: string }[]).find((frame) => frame.t === "prompt");
  expect(prompt).toMatchObject({ t: "prompt", id: "smoke", text: "do the thing" });
  await expect(page.locator(".composer-input")).toHaveValue("");
  await expect(page.locator(".composer-ok")).toContainText("Sent");
  await page.evaluate(() =>
    window.__fake.failNextPrompt("busy", "host is busy"),
  );
  await page.locator(".composer-input").fill("do it again");
  await page.locator(".composer-send").click();
  await expect(page.locator(".composer-error")).toHaveText("host is busy");
  await expect(page.locator(".composer-input")).toHaveValue("do it again");
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

test("screenshots a guest inside a granted session", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/fake.html?screen=guest");
  await page.locator('[data-session="smoke"]').click();
  await expect(page.locator("#term-pane .xterm-screen")).toBeVisible();
  await expect.poll(() => terminalText(page)).toContain("hello from the host");
  await page.locator(".composer-input").fill("summarize the run");
  await page.screenshot({ path: testInfo.outputPath("guest-session.png") });
});
