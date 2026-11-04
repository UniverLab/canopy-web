// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";

// The symbols JetBrains Mono lacks come from the self-hosted Canopy
// Symbols face instead of a phone's missing fallback: the terminal buffer
// holds the characters, and the face that draws them is loaded before the
// first WebGL paint. Like the smoke spec, output is asserted through the
// fake host's recorded writes, never the DOM (WebGL has no text nodes).
async function terminalText(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(() => window.__fake.terminalText());
}

test.beforeEach(async ({ page }) => {
  await page.goto("/fake.html");
  await expect(page.locator('[data-session="smoke"]')).toBeVisible();
  await page.locator('[data-session="smoke"]').click();
  await expect.poll(() => terminalText(page)).toContain("hello from the host");
});

test("draws harness symbols from Canopy Symbols at 360x640", async ({ page }) => {
  await page.evaluate(() => window.__fake.pushOut("⏵⏵ ⏸ ✻ ⠋\n"));
  await expect.poll(() => terminalText(page)).toContain("⏵⏵ ⏸ ✻ ⠋");
  // The face is ready after the terminal mounts: the gate waited for a
  // sample from its own range before xterm's first paint.
  await expect
    .poll(() => page.evaluate(() => document.fonts.check('14px "Canopy Symbols"', "⏵")))
    .toBe(true);
  const faces = await page.evaluate(() =>
    Array.from(document.fonts).map((face) => ({
      family: face.family.replace(/"/g, ""),
      status: face.status,
    })),
  );
  expect(faces).toContainEqual({ family: "Canopy Symbols", status: "loaded" });
});
