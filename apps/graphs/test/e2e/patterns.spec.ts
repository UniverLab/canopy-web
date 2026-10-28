// SPDX-License-Identifier: Apache-2.0
/**
 * The pattern pages in a browser, against the fixture Worker: `/patterns`
 * as a grid of cards — each card its figure drawn small above its title,
 * badge and summary — and one pattern page opening with the figure's full
 * plate, the vertical plate under 640 px and the horizontal one above, on
 * the black stage, ending on the Implemented-by rows with the graph's own
 * plate and install command. At the two reference sizes, 390x844 and
 * 1280x900, with a screenshot per page attached to the report for the
 * operator's review, never compared.
 */
import { expect, test } from "@playwright/test";

const VIEWPORTS = [
  { label: "mobile", width: 390, height: 844 },
  { label: "desktop", width: 1280, height: 900 },
] as const;

for (const viewport of VIEWPORTS) {
  test(`patterns list at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/patterns", { waitUntil: "load" });

    await expect(page.locator("html")).toHaveAttribute("data-surface", "tui");
    await expect(page.locator("main.look-col > h1")).toHaveCount(1);
    await expect(page.locator("main.look-col > h1")).toHaveText("Patterns");

    // The one fixture card: the small plate, the title, the badge, the summary.
    const cards = page.locator("ol.cards > li.card");
    await expect(cards).toHaveCount(1);
    const card = cards.first();
    await expect(card.locator("a.card-link")).toHaveAttribute("href", "/patterns/gated-check");
    // The thumbnail shows its orientation like a full plate: vertical under
    // 640 px, horizontal above.
    const thumbHorizontal = card.locator("figure.plate.thumb svg.plate-h");
    const thumbVertical = card.locator("figure.plate.thumb svg.plate-v");
    if (viewport.width < 640) {
      await expect(thumbVertical).toBeVisible();
      await expect(thumbHorizontal).toBeHidden();
    } else {
      await expect(thumbHorizontal).toBeVisible();
      await expect(thumbVertical).toBeHidden();
    }
    await expect(card.locator(".card-title")).toHaveText("Gated check");
    await expect(card.locator(".badge-status")).toHaveText("standard");
    await expect(card.locator(".card-summary")).toContainText("Shell checks decide pass or fail");
    // One shape per figure node in each orientation, the fail edge dashed.
    await expect(card.locator("figure.plate.thumb g.node")).toHaveCount(6);
    await expect(card.locator("figure.plate.thumb path.edge.fail")).toHaveCount(2);
    const dash = await card.locator("figure.plate.thumb path.edge.fail").first().evaluate(
      (el) => getComputedStyle(el).strokeDasharray,
    );
    expect(dash).not.toBe("none");

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
    await page.goto("/patterns/gated-check", { waitUntil: "load" });

    await expect(page.locator("html")).toHaveAttribute("data-surface", "tui");
    const headings = page.locator("main.look-col > h1");
    await expect(headings).toHaveCount(1);
    await expect(headings).toContainText("Gated check");

    // Every header link lies inside the viewport at both reference sizes,
    // and under 640 px each is a 44 px target.
    const nav = await page.evaluate(() => ({
      view: window.innerWidth,
      boxes: [...document.querySelectorAll<HTMLElement>("header nav.site-nav a")].map((link) => {
        const box = link.getBoundingClientRect();
        return { left: box.left, right: box.right, width: box.width, height: box.height };
      }),
    }));
    expect(nav.boxes).toHaveLength(4);
    for (const box of nav.boxes) {
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(nav.view);
      if (viewport.width < 640) {
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
    }

    // The figure's plate opens the page, on the black stage: one
    // orientation visible, chosen by CSS alone — vertical under 640 px,
    // horizontal above.
    const painted = await page.evaluate(() =>
      getComputedStyle(document.querySelector("figure.plate") as HTMLElement).backgroundColor,
    );
    expect(painted).toBe("rgb(5, 5, 5)");
    const plate = page.locator("main.look-col > figure.plate");
    await expect(plate).toHaveCount(1);
    const horizontal = plate.locator("svg.plate-h");
    const vertical = plate.locator("svg.plate-v");
    if (viewport.width < 640) {
      await expect(vertical).toBeVisible();
      await expect(horizontal).toBeHidden();
    } else {
      await expect(horizontal).toBeVisible();
      await expect(vertical).toBeHidden();
    }
    // Both orientations stay in the document; the check above proves which shows.
    await expect(plate.locator("g.node")).toHaveCount(6);

    // Then the badge, the body, the sources, and Implemented-by: the two
    // catalogue rows with their install commands, the graph's own plate.
    await expect(page.locator("h1 .badge-status")).toHaveText("standard");
    await expect(page.locator("div.readme")).toContainText("one fail edge");
    // The fixture body opens with "# Gated check", which repeats the
    // front-matter title: the page drops that heading, so the readme
    // carries the title exactly once — in the page heading above it.
    await expect(page.locator("div.readme h1")).toHaveCount(0);
    await expect(page.locator("ul.sources a")).toHaveAttribute("href", "https://example.com/agents");
    const rows = page.locator("ol.index > li.row");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0).locator(".row-name")).toHaveAttribute("href", "/g/hello-graph");
    await expect(rows.nth(0).locator("code")).toHaveText("canopy graph install hello-graph");
    const rowThumb = viewport.width < 640 ? "svg.plate-v" : "svg.plate-h";
    await expect(rows.nth(0).locator(`figure.plate.thumb ${rowThumb}`)).toBeVisible();
    await expect(rows.nth(1).locator(".row-name")).toHaveAttribute("href", "/n/hello-node");
    await expect(rows.nth(1).locator("code")).toHaveText("canopy node install hello-node");

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
