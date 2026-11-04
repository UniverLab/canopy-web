// SPDX-License-Identifier: Apache-2.0
// Copying terminal text out on a phone: the fake host prints known lines,
// the Copy sheet shows the buffer in a native textarea, Copy all lands on
// the clipboard, and the controls row still fits one row at 360x640 with
// no sideways scroll.
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto("/fake.html");
  await page.locator('[data-session="smoke"]').click();
  await expect.poll(() => page.evaluate(() => window.__fake.terminalText())).toContain("hello from the host");
});

test("copies the buffer through the sheet onto the clipboard", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(() => window.__fake.pushOut("copy-me one\r\ncopy-me two\r\n"));
  // The real xterm buffer holds the lines before the sheet snapshots it.
  await page.waitForFunction(
    () => (window.__fake.bufferState?.()?.rows.join("\n") ?? "").includes("copy-me two"),
  );
  await page.locator("#term-copy").click();
  const text = page.locator("#term-copy-text");
  await expect(text).toBeVisible();
  expect(await text.inputValue()).toContain("copy-me one");
  expect(await text.inputValue()).toContain("copy-me two");
  await page.locator("#term-copy-all").click();
  await expect(page.locator("#term-copy-status")).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("copy-me two");
  await page.locator("#term-copy-close").click();
  await expect(text).toBeHidden();
  // One controls row at 360x640: the Copy button did not wrap it, and the
  // page never scrolls sideways.
  const layout = await page.evaluate(() => {
    const doc = document.scrollingElement ?? document.documentElement;
    const controls = document.querySelector(".term-controls") as HTMLElement;
    const tops = new Set(
      [...controls.querySelectorAll("button")]
        .filter((el) => (el as HTMLElement).offsetParent !== null)
        .map((el) => Math.round(el.getBoundingClientRect().top)),
    );
    return { pageOverflow: doc.scrollWidth - doc.clientWidth, rows: tops.size };
  });
  expect(layout.pageOverflow).toBeLessThanOrEqual(1);
  expect(layout.rows).toBe(1);
});
