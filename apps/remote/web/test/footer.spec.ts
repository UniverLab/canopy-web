// SPDX-License-Identifier: Apache-2.0
// Every remote view ends in the UniverLab footer: the sessions home (both
// tabs), the session shell, the graph and SysInfo views, and the guest
// list and session. The footer sits at the end of the scroll — after the
// main in the DOM and below it on the page — so it never overlays the
// terminal, the key bar, the composer or the session list, and the
// terminal keeps its size. Phone assertions run at 390 px, the reference
// width, with no sideways scroll.
import { expect, test, type Page } from "@playwright/test";

async function terminalText(page: Page): Promise<string> {
  return page.evaluate(() => window.__fake.terminalText());
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
}

/** The one footer: #app's child directly after the main, naming the product. */
async function expectFooterAfterMain(page: Page): Promise<void> {
  const footer = page.locator("#app > footer.look-colophon");
  await expect(footer).toHaveCount(1);
  await expect(footer).toContainText("Canopy remote");
  const order = await page.evaluate(() => {
    const foot = document.querySelector("#app > footer.look-colophon");
    return foot?.previousElementSibling?.tagName ?? null;
  });
  expect(order).toBe("MAIN");
}

interface VBox {
  top: number;
  bottom: number;
}

/** Page-coordinate vertical boxes; null when the selector is missing. */
async function vboxes(page: Page, selectors: string[]): Promise<(VBox | null)[]> {
  return page.evaluate((sels: string[]) =>
    sels.map((sel) => {
      const el = document.querySelector(sel);
      if (!el) {
        return null;
      }
      const box = el.getBoundingClientRect();
      return { top: box.top + window.scrollY, bottom: box.bottom + window.scrollY };
    }),
  selectors);
}

test("ends the sessions home, both tabs, in the footer at 390x844", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/fake.html");
  await expect(page.locator('[data-session="smoke"]')).toBeVisible();
  await expectFooterAfterMain(page);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  await page.locator('[data-tab="graphs"]').click();
  await expect(page.locator(".graph-row")).toHaveCount(2);
  await expectFooterAfterMain(page);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
});

test("keeps the session's terminal, key bar and composer above the footer at 390x844", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/fake.html");
  await expect(page.locator('[data-session="smoke"]')).toBeVisible();
  await page.locator('[data-session="smoke"]').click();
  await expect.poll(() => terminalText(page)).toContain("hello from the host");
  await expect(page.locator("#term-pane .xterm-screen")).toBeVisible();
  await expectFooterAfterMain(page);
  // Top to bottom: terminal, key bar, composer, then the footer — the
  // footer never overlays any of them, and the terminal keeps its height.
  const [term, keys, composer, footer] = await vboxes(page, [
    "#term-pane",
    "#keybar",
    ".composer",
    "footer.look-colophon",
  ]);
  expect(term).not.toBeNull();
  expect(keys).not.toBeNull();
  expect(composer).not.toBeNull();
  expect(footer).not.toBeNull();
  expect(term!.bottom).toBeLessThanOrEqual(keys!.top + 1);
  expect(keys!.bottom).toBeLessThanOrEqual(composer!.top + 1);
  expect(composer!.bottom).toBeLessThanOrEqual(footer!.top + 1);
  expect(term!.bottom - term!.top).toBeGreaterThan(200);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
});

test("ends the graph and SysInfo views in the footer at 390x844", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/fake.html");
  await page.locator('[data-tab="graphs"]').click();
  await expect(page.locator(".graph-row")).toHaveCount(2);
  await page.locator('[data-graph="g-loop"]').click();
  await expect(page.locator("main.graph-view")).toBeVisible();
  await expect(page.locator("#graph-stage .plate-svg")).toBeVisible();
  await expectFooterAfterMain(page);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  await page.locator("#graph-back").click();
  await page.locator('[data-tab="sessions"]').click();
  await expect(page.locator('[data-session="smoke"]')).toBeVisible();
  await page.locator("#metrics-strip").click();
  await expect(page.locator("main.metrics-view")).toBeVisible();
  await expectFooterAfterMain(page);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
});

test("ends the guest list and session in the footer at 390x844", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/fake.html?screen=guest");
  await expect(page.locator('[data-session="smoke"]')).toBeVisible();
  await expectFooterAfterMain(page);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  await page.locator('[data-session="smoke"]').click();
  await expect(page.locator("#term-pane .xterm-screen")).toBeVisible();
  await expect.poll(() => terminalText(page)).toContain("hello from the host");
  await expectFooterAfterMain(page);
  const [term, keys, composer, footer] = await vboxes(page, [
    "#term-pane",
    "#keybar",
    ".composer",
    "footer.look-colophon",
  ]);
  expect(term).not.toBeNull();
  expect(footer).not.toBeNull();
  expect(term!.bottom).toBeLessThanOrEqual(keys!.top + 1);
  expect(composer!.bottom).toBeLessThanOrEqual(footer!.top + 1);
  expect(term!.bottom - term!.top).toBeGreaterThan(200);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
});
