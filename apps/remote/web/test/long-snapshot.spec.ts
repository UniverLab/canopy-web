// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";
import { LONG_SNAPSHOT_END } from "./fixtures/long-snapshot.js";

// The fake host at ?snapshot=long attaches with a 32 KB body the host
// split into 12032-byte parts, each base64 encoded on its own (so every
// part ends in `=` padding). A terminal that stayed black — or threw at
// the interior padding — never paints the last line.
test("a snapshot over one host part paints to its last line at 360x640", async ({ page }) => {
  await page.goto("/fake.html?snapshot=long");
  await expect(page.locator('[data-session="smoke"]')).toBeVisible();
  await page.locator('[data-session="smoke"]').click();
  await expect(page.locator(".xterm-screen")).toBeVisible();
  const lastLine = () => page.evaluate(() => window.__fake.bufferLastLine?.() ?? null);
  // The snapshot's very last line is in the buffer only when every part
  // was decoded on its own and the bytes were joined as bytes.
  await expect.poll(lastLine).toBe(LONG_SNAPSHOT_END);
  // The session stays live after the snapshot: a following out frame
  // still reaches the terminal.
  await page.evaluate(() => window.__fake.pushOut("live after snapshot\n"));
  await expect.poll(lastLine).toBe("live after snapshot");
});
