// SPDX-License-Identifier: Apache-2.0
// The header-band honeycomb: every remote screen paints the flat deep body
// with the honeycomb confined to the sticky header band — no fixed
// full-page canvas anywhere, logged out (sign-in, pair, hosts) or signed
// in (sessions, session, graphs, graph, metrics, guest list, guest
// session) alike.
import { expect, test, type Page } from "@playwright/test";

/** #011d1c, the flat deep surface every body paints. */
const FLAT_BODY = "rgb(1, 29, 28)";

async function headerBand(page: Page): Promise<{
  body: string;
  mounted: boolean;
  inHeader: boolean;
  position: string | null;
  inside: boolean;
  sticky: boolean;
  fixedCanvases: number;
}> {
  // The honeycomb mounts lazily after the header paints.
  await expect.poll(() => page.locator(".topbar > #fondo canvas").count()).toBeGreaterThan(0);
  return page.evaluate(() => {
    const host = document.getElementById("fondo");
    const bar = document.querySelector(".topbar") as HTMLElement | null;
    const hostBox = host?.getBoundingClientRect();
    const barBox = bar?.getBoundingClientRect();
    return {
      body: getComputedStyle(document.body).backgroundColor,
      mounted: (host?.querySelector("canvas") ?? null) !== null,
      inHeader: host?.parentElement?.classList.contains("topbar") ?? false,
      position: host ? getComputedStyle(host).position : null,
      inside:
        hostBox !== undefined &&
        barBox !== undefined &&
        hostBox.top >= barBox.top - 1 &&
        hostBox.bottom <= barBox.bottom + 1 &&
        hostBox.left >= barBox.left - 1 &&
        hostBox.right <= barBox.right + 1,
      sticky: bar ? getComputedStyle(bar).position === "sticky" : false,
      fixedCanvases: [...document.querySelectorAll("canvas")].filter(
        (canvas) => getComputedStyle(canvas).position === "fixed",
      ).length,
    };
  });
}

async function expectHeaderBand(page: Page): Promise<void> {
  const band = await headerBand(page);
  expect(band.body).toBe(FLAT_BODY);
  expect(band.mounted).toBe(true);
  expect(band.inHeader).toBe(true);
  expect(band.position).toBe("absolute");
  expect(band.inside).toBe(true);
  expect(band.sticky).toBe(true);
  expect(band.fixedCanvases).toBe(0);
}

test("confines the honeycomb on the logged-out screens", async ({ page }) => {
  await page.goto("/fake.html?screen=signin");
  await expect(page.locator("main.signin")).toBeVisible();
  await expectHeaderBand(page);

  await page.goto("/fake.html?screen=pair");
  await expect(page.locator("#pair-form")).toBeVisible();
  await expectHeaderBand(page);

  await page.goto("/fake.html?screen=hosts");
  await expect(page.locator("#host-list")).toBeVisible();
  await expectHeaderBand(page);
});

test("confines the honeycomb on the owner screens", async ({ page }) => {
  await page.goto("/fake.html");
  await expect(page.locator('[data-session="smoke"]')).toBeVisible();
  await expectHeaderBand(page);

  await page.locator('[data-session="smoke"]').click();
  await expect(page.locator("main.session-view")).toBeVisible();
  await expectHeaderBand(page);

  await page.locator("#session-back").click();
  await expect(page.locator('[data-session="smoke"]')).toBeVisible();
  await page.locator('[data-tab="graphs"]').click();
  await expect(page.locator(".graph-row")).toHaveCount(2);
  await expectHeaderBand(page);

  await page.locator('[data-graph="g-loop"]').click();
  await expect(page.locator("main.graph-view")).toBeVisible();
  await expectHeaderBand(page);

  await page.locator("#graph-back").click();
  await expect(page.locator(".graph-row")).toHaveCount(2);
  await page.locator("#metrics-strip").click();
  await expect(page.locator("main.metrics-view")).toBeVisible();
  await expectHeaderBand(page);
});

test("confines the honeycomb on the guest screens", async ({ page }) => {
  await page.goto("/fake.html?screen=guest");
  await expect(page.locator('[data-session="smoke"]')).toBeVisible();
  await expectHeaderBand(page);

  await page.locator('[data-session="smoke"]').click();
  await expect(page.locator("#term-pane .xterm-screen")).toBeVisible();
  await expectHeaderBand(page);
});

test("keeps the honeycomb in the sticky band while scrolling", async ({ page }) => {
  await page.goto("/fake.html");
  await expect(page.locator('[data-session="smoke"]')).toBeVisible();
  await page.locator('[data-session="smoke"]').click();
  await expect(page.locator("main.session-view")).toBeVisible();
  await expectHeaderBand(page);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const band = await headerBand(page);
  expect(band.inside).toBe(true);
  expect(band.sticky).toBe(true);
  // The host rides the band: both share the same scroll offset, so the
  // honeycomb never leaks onto the body while scrolling.
  const ride = await page.evaluate(() => ({
    host: document.getElementById("fondo")?.getBoundingClientRect().top ?? null,
    bar: document.querySelector(".topbar")?.getBoundingClientRect().top ?? null,
  }));
  expect(ride.host).not.toBeNull();
  expect(ride.bar).not.toBeNull();
  expect(Math.abs((ride.host ?? 1) - (ride.bar ?? 0))).toBeLessThanOrEqual(1);
});

test("mounts the honeycomb under prefers-reduced-motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/fake.html");
  await expect(page.locator('[data-session="smoke"]')).toBeVisible();
  await expectHeaderBand(page);
});

for (const viewport of [
  { label: "390x844", width: 390, height: 844 },
  { label: "1280x900", width: 1280, height: 900 },
] as const) {
  test(`paints the flat body on pair, sessions and session at ${viewport.label}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    await page.goto("/fake.html?screen=pair");
    await expect(page.locator("#pair-form")).toBeVisible();
    await expectHeaderBand(page);
    const pairShot = await page.screenshot({ path: testInfo.outputPath(`fondo-pair-${viewport.label}.png`) });
    await testInfo.attach(`fondo-pair-${viewport.label}`, { body: pairShot, contentType: "image/png" });

    await page.goto("/fake.html");
    await expect(page.locator('[data-session="smoke"]')).toBeVisible();
    await expectHeaderBand(page);
    const sessionsShot = await page.screenshot({
      path: testInfo.outputPath(`fondo-sessions-${viewport.label}.png`),
    });
    await testInfo.attach(`fondo-sessions-${viewport.label}`, {
      body: sessionsShot,
      contentType: "image/png",
    });

    await page.locator('[data-session="smoke"]').click();
    await expect(page.locator("main.session-view")).toBeVisible();
    await expectHeaderBand(page);
    const sessionShot = await page.screenshot({
      path: testInfo.outputPath(`fondo-session-${viewport.label}.png`),
    });
    await testInfo.attach(`fondo-session-${viewport.label}`, {
      body: sessionShot,
      contentType: "image/png",
    });
  });
}
