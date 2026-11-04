// SPDX-License-Identifier: Apache-2.0
/**
 * The catalogue home must not freeze after the text paints: at 4x CPU
 * throttle on a 390x844 phone, no long task above 250 ms in the 6 s
 * after load. (The header honeycomb used to build all 3696 cell sprites
 * up front — a 1121 ms task under this same throttle — and now builds
 * each sprite on first draw with the label map sliced off the hot path.)
 */
import { expect, test } from "@playwright/test";

declare global {
  interface Window {
    __longtasks?: number[];
  }
}

test("home has no long task above 250 ms at 4x throttle", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const client = await page.context().newCDPSession(page);
  await client.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.addInitScript(() => {
    window.__longtasks = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__longtasks?.push(entry.duration);
      }
    });
    observer.observe({ entryTypes: ["longtask"] });
  });

  await page.goto("/", { waitUntil: "load" });
  await page.waitForTimeout(6000);

  // The honeycomb really mounted: without it a quiet trace proves nothing.
  const fondo = await page.evaluate(() => {
    const host = document.getElementById("fondo");
    const canvas = host?.querySelector("canvas");
    return {
      canvas: canvas !== undefined && canvas !== null,
      sized: canvas === null || canvas === undefined ? false : canvas.clientWidth > 0,
    };
  });
  expect(fondo.canvas).toBe(true);
  expect(fondo.sized).toBe(true);

  const tasks = await page.evaluate(() => window.__longtasks ?? []);
  const longest = tasks.length === 0 ? 0 : Math.max(...tasks);
  expect(longest).toBeLessThanOrEqual(250);
});
