// SPDX-License-Identifier: Apache-2.0
// Host metrics against the fake host: the strip rides the header beside
// the host chip, tapping it opens the SysInfo view with every field and
// its sparklines, hiding the page unwatches, and a host that stays silent
// shows no strip at all.
import { expect, test, type Page } from "@playwright/test";

async function sent(page: Page): Promise<unknown[]> {
  return page.evaluate(() => window.__fake.sent());
}

async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((value) => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => value });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/fake.html");
  await expect(page.locator('[data-session="smoke"]')).toBeVisible();
});

test("shows the host-metrics strip beside the header at 360 px", async ({ page }) => {
  // Showing the home asked the host for a frame every 10 s.
  expect(await sent(page)).toContainEqual({ t: "host.metrics.watch", interval: 10 });
  const strip = page.locator(".topbar #metrics-strip");
  await expect(strip).toBeVisible();
  await expect(strip).toContainText("CPU");
  await expect(strip).toContainText("MEM");
  await expect(strip).toContainText("GPU");
  // Readable in place: inside the viewport, no page sideways scroll.
  const box = await strip.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(360);
  const overflow = await page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);
});

test("opens the SysInfo view with every field, sparklines and the age", async ({ page }) => {
  await page.evaluate(() => {
    window.__fake.pushMetrics({});
    window.__fake.pushMetrics({});
  });
  await page.locator("#metrics-strip").click();
  const view = page.locator("main.metrics-view");
  await expect(view).toBeVisible();
  await expect(view.locator(".metrics-title")).toHaveText("SysInfo");
  // Every field the wire carries.
  for (const label of ["Usage", "Temp", "Source", "Used", "Name", "VRAM", "Draw", "Limit"]) {
    await expect(view.locator(".metric-label", { hasText: label }).first()).toBeVisible();
  }
  await expect(view.locator(".metric-section[aria-label='CPU']")).toContainText("coretemp");
  await expect(view.locator(".metric-section[aria-label='GPU']")).toContainText("GeForce GTX");
  // One sparkline per charted metric, drawn as lines after three samples.
  await expect(view.locator("svg.spark")).toHaveCount(5);
  expect(await view.locator("svg.spark polyline").count()).toBeGreaterThan(0);
  // The sample age ticks with the frames.
  await expect(view.locator("#metrics-age")).toContainText("ago");
  // Back lands on the home tab it came from.
  await page.locator("#metrics-back").click();
  await expect(page.locator("main.sessions")).toBeVisible();
});

test("reads nulls as n/a with the temperature hint", async ({ page }) => {
  await page.evaluate(() => window.__fake.pushMetrics({ cpu_temperature_c: null, gpu: null, power: null }));
  await page.locator("#metrics-strip").click();
  const view = page.locator("main.metrics-view");
  await expect(view).toBeVisible();
  await expect(view.locator(".metric-section[aria-label='GPU']")).toContainText("n/a");
  await expect(view.locator(".metric-section[aria-label='Power']")).toContainText("n/a");
  await expect(view.locator(".metrics-hint")).toContainText("enable LibreHardwareMonitor on the host");
  // The strip drops the GPU segment it no longer has.
  await page.locator("#metrics-back").click();
  await expect(page.locator("#metrics-strip")).not.toContainText("GPU");
});

test("colours temperatures like the TUI", async ({ page }) => {
  const strip = page.locator("#metrics-strip");
  await page.evaluate(() => window.__fake.pushMetrics({ cpu_temperature_c: 91 }));
  await expect(strip.locator('[data-level="crit"]')).toBeVisible();
  await page.evaluate(() => window.__fake.pushMetrics({ cpu_temperature_c: 72 }));
  await expect(strip.locator('[data-level="warn"]')).toBeVisible();
  await expect(strip.locator('[data-level="crit"]')).toHaveCount(0);
});

test("unwatches while hidden and rewatches on show", async ({ page }) => {
  await page.evaluate(() => window.__fake.clearSent());
  await setHidden(page, true);
  await expect.poll(() => sent(page)).toContainEqual({ t: "host.metrics.unwatch" });
  await page.evaluate(() => window.__fake.clearSent());
  await setHidden(page, false);
  await expect.poll(() => sent(page)).toContainEqual({ t: "host.metrics.watch", interval: 10 });
});

test("drops the strip and the watch on the terminal, resumes on back", async ({ page }) => {
  await expect(page.locator("#metrics-strip")).toBeVisible();
  await page.evaluate(() => window.__fake.clearSent());
  await page.locator('[data-session="smoke"]').click();
  await expect(page.locator("main.session-view")).toBeVisible();
  // The terminal keeps the viewport: no strip, and the watch drops.
  await expect(page.locator("#metrics-strip")).toHaveCount(0);
  expect(await sent(page)).toContainEqual({ t: "host.metrics.unwatch" });
  await page.evaluate(() => window.__fake.clearSent());
  await page.locator("#session-back").click();
  await expect(page.locator("main.sessions")).toBeVisible();
  await expect(page.locator("#metrics-strip")).toBeVisible();
  expect(await sent(page)).toContainEqual({ t: "host.metrics.watch", interval: 10 });
});

test("hides the strip without noise when the host stays silent", async ({ page }) => {
  const noise: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      noise.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    noise.push(String(error));
  });
  await page.goto("/fake.html?metrics=silent");
  await expect(page.locator('[data-session="smoke"]')).toBeVisible();
  // The watch went out, nothing came back, and no strip appeared.
  expect(await sent(page)).toContainEqual({ t: "host.metrics.watch", interval: 10 });
  await expect(page.locator("#metrics-strip")).toHaveCount(0);
  expect(noise).toEqual([]);
});
