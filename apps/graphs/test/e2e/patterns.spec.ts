// SPDX-License-Identifier: Apache-2.0
/**
 * The pattern pages in a browser, against the fixture Worker: `/patterns`
 * as a grid of cards over the bundled set — each card its figure drawn
 * small above its title, badge and summary — and one pattern page, reached
 * through the first card's own link, opening with the figure's full plate,
 * one horizontal drawing at every size, on the black stage, ending on the
 * Implemented-by section. At the two reference sizes, 390x844 and 1280x900,
 * with a screenshot per page attached to the report for the operator's
 * review, never compared.
 */
import { expect, test } from "@playwright/test";

const VIEWPORTS = [
  { label: "mobile", width: 390, height: 844 },
  { label: "desktop", width: 1280, height: 900 },
] as const;

const STATUSES = ["standard", "in use", "experiment"] as const;

for (const viewport of VIEWPORTS) {
  test(`patterns list at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/patterns", { waitUntil: "load" });

    await expect(page.locator("html")).toHaveAttribute("data-surface", "tui");
    await expect(page.locator("main.look-col > h1")).toHaveCount(1);
    await expect(page.locator("main.look-col > h1")).toHaveText("Patterns");

    // One card per bundled pattern: the small plate, the title, the badge,
    // the summary — each card linked to its own page.
    const cards = page.locator("ol.cards > li.card");
    expect(await cards.count()).toBeGreaterThan(0);
    const card = cards.first();
    const href = await card.locator("a.card-link").getAttribute("href");
    expect(href).toMatch(/^\/patterns\/[a-z0-9-]{1,48}$/);
    await expect(card.locator(".card-title")).not.toBeEmpty();
    await expect(card.locator(".badge-status")).toHaveText(new RegExp(`^(${STATUSES.join("|")})$`));
    await expect(card.locator(".card-summary")).not.toBeEmpty();
    // The thumbnail shows the one horizontal drawing like a full plate.
    await expect(card.locator("figure.plate.thumb svg.plate-h")).toBeVisible();
    await expect(card.locator("figure.plate.thumb svg.plate-v")).toHaveCount(0);
    const thumbNodes = await card.locator("figure.plate.thumb svg.plate-h g.node").count();
    expect(thumbNodes).toBeGreaterThan(0);

    // The page never scrolls sideways, at either reference size.
    const width = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      view: window.innerWidth,
    }));
    expect(width.view).toBeLessThanOrEqual(viewport.width);
    expect(width.scroll).toBeLessThanOrEqual(width.view);

    const shot = await page.screenshot({
      fullPage: true,
      path: testInfo.outputPath(`patterns-${viewport.label}.png`),
    });
    await testInfo.attach(`patterns-${viewport.label}`, {
      body: shot,
      contentType: "image/png",
    });
  });

  test(`pattern page at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/patterns", { waitUntil: "load" });
    const href = await page.locator("ol.cards > li.card a.card-link").first().getAttribute("href");
    expect(href).toMatch(/^\/patterns\//);
    await page.goto(href as string, { waitUntil: "load" });

    await expect(page.locator("html")).toHaveAttribute("data-surface", "tui");
    const headings = page.locator("main.look-col > h1");
    await expect(headings).toHaveCount(1);
    await expect(headings).not.toBeEmpty();

    // Every header link lies inside the viewport at both reference sizes,
    // and under 640 px each is a 44 px target.
    const nav = await page.evaluate(() => ({
      view: window.innerWidth,
      boxes: [...document.querySelectorAll<HTMLElement>("header nav.site-nav a")].map((link) => {
        const box = link.getBoundingClientRect();
        return { left: box.left, right: box.right, width: box.width, height: box.height };
      }),
    }));
    expect(nav.boxes).toHaveLength(5);
    for (const box of nav.boxes) {
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(nav.view);
      if (viewport.width < 640) {
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
    }

    // The figure's plate opens the page, on the black stage: the one
    // horizontal drawing at every size.
    const painted = await page.evaluate(() =>
      getComputedStyle(document.querySelector("figure.plate") as HTMLElement).backgroundColor,
    );
    expect(painted).toBe("rgb(5, 5, 5)");
    const plate = page.locator("main.look-col > figure.plate");
    await expect(plate).toHaveCount(1);
    await expect(plate.locator("svg.plate-h")).toBeVisible();
    await expect(plate.locator("svg.plate-v")).toHaveCount(0);
    const nodes = await plate.locator("svg.plate-h g.node").count();
    expect(nodes).toBeGreaterThan(0);

    // Then the badge, the body, the sources, and Implemented-by: the
    // section every pattern page ends on, rows or the nothing-yet line.
    await expect(page.locator("h1 .badge-status")).toHaveText(new RegExp(`^(${STATUSES.join("|")})$`));
    await expect(page.locator("div.readme")).toHaveCount(1);
    expect(await page.locator("ul.sources a").count()).toBeGreaterThan(0);
    await expect(page.locator("h2.kicker", { hasText: "Implemented by" })).toBeVisible();
    const rows = await page.locator("ol.index > li.row").count();
    const nothingYet = await page.locator("p", { hasText: "No catalogue document implements" }).count();
    expect(rows > 0 || nothingYet > 0).toBe(true);

    // The page never scrolls sideways, at either reference size.
    const width = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      view: window.innerWidth,
    }));
    expect(width.view).toBeLessThanOrEqual(viewport.width);
    expect(width.scroll).toBeLessThanOrEqual(width.view);

    const shot = await page.screenshot({
      fullPage: true,
      path: testInfo.outputPath(`pattern-${viewport.label}.png`),
    });
    await testInfo.attach(`pattern-${viewport.label}`, {
      body: shot,
      contentType: "image/png",
    });
  });
}
