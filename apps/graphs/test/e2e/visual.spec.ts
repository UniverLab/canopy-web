// SPDX-License-Identifier: Apache-2.0
/**
 * The catalogue's dress, checked in a browser against the fixture Worker:
 * the Canopy surface, the three faces loaded from the kit, the honeycomb
 * behind the content, the mono wordmark, the colophon footer, and no
 * horizontal page scroll at 390 px. Three pages (home, a graph, a node) at
 * the two reference sizes; a screenshot per page is attached to the report
 * for the operator, never compared.
 */
import { expect, test } from "@playwright/test";

const VIEWPORTS = [
  { label: "mobile", width: 390, height: 844 },
  { label: "desktop", width: 1280, height: 900 },
] as const;

const PAGES = [
  { label: "home", path: "/", heading: "A catalogue of Canopy graphs and nodes." },
  { label: "graph", path: "/g/hello-graph", heading: "hello-graph" },
  { label: "node", path: "/n/hello-node", heading: "hello-node" },
] as const;

/** #012624, the Liquid Abyss canvas of the Canopy page. */
const SURFACE_BG = "rgb(1, 38, 36)";

for (const viewport of VIEWPORTS) {
  for (const target of PAGES) {
    test(`${target.label} at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(target.path, { waitUntil: "load" });

      // The Canopy surface, named on <html> and painted on <body>.
      await expect(page.locator("html")).toHaveAttribute("data-surface", "tui");
      const surface = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(surface).toBe(SURFACE_BG);

      // The kit's three faces loaded for real (the unit tests only see the CSS).
      // `document.fonts.check()` alone would pass on the fallback stack, so
      // read the FontFaceSet itself: a stylesheet that never arrived leaves it
      // empty, and a broken woff2 leaves its face in "error".
      const faces = await page.evaluate(async () => {
        await document.fonts.ready;
        const registered = [...document.fonts].map((face) => ({
          family: face.family.replace(/^["']|["']$/g, ""),
          status: face.status,
        }));
        return {
          status: document.fonts.status,
          families: [...new Set(registered.map((face) => face.family))].sort(),
          loaded: [...new Set(registered.filter((face) => face.status === "loaded").map((face) => face.family))].sort(),
          heading: getComputedStyle(document.querySelector("h1") ?? document.body).fontFamily,
          body: getComputedStyle(document.body).fontFamily,
          wordmark: getComputedStyle(document.querySelector(".wordmark") ?? document.body).fontFamily,
        };
      });
      expect(faces.status).toBe("loaded");
      const kit = ["EB Garamond", "Old Standard TT", "Sometype Mono"];
      // All three are registered by the kit, and each has a face actually loaded.
      expect(faces.families).toEqual(expect.arrayContaining(kit));
      expect(faces.loaded).toEqual(expect.arrayContaining(kit));
      // And the page applies them: display to the heading, body to the text,
      // mono to the wordmark.
      expect(faces.heading).toContain("Old Standard TT");
      expect(faces.body).toContain("EB Garamond");
      expect(faces.wordmark).toContain("Sometype Mono");

      // The live honeycomb is mounted, hidden from assistive tech, unfocusable.
      const fondo = await page.evaluate(() => {
        const host = document.getElementById("fondo");
        const canvas = host?.querySelector("canvas");
        return {
          host: host !== null,
          ariaHidden: host?.getAttribute("aria-hidden") ?? null,
          canvas: canvas !== undefined && canvas !== null,
          tabIndex: canvas?.tabIndex ?? null,
          pointerEvents: canvas === null || canvas === undefined ? null : getComputedStyle(canvas).pointerEvents,
          sized: canvas === null || canvas === undefined ? false : canvas.clientWidth > 0,
        };
      });
      expect(fondo.host).toBe(true);
      expect(fondo.ariaHidden).toBe("true");
      expect(fondo.canvas).toBe(true);
      expect(fondo.tabIndex).toBe(-1);
      expect(fondo.pointerEvents).toBe("none");
      expect(fondo.sized).toBe(true);

      // The wordmark and the UniverLab colophon.
      const wordmark = page.locator("header .wordmark");
      await expect(wordmark).toHaveText("graphs");
      await expect(wordmark).toHaveAttribute("href", "https://univerlab.org/canopy/");
      const colophon = page.locator("footer.look-colophon");
      await expect(colophon).toBeVisible();
      await expect(colophon).toContainText("Canopy graphs");
      await expect(colophon).toContainText("EXP-001");

      // One page-level h1 (the README may repeat its own title inside .readme).
      const headings = page.locator("main.look-col > h1");
      await expect(headings).toHaveCount(1);
      await expect(headings).toHaveText(target.heading);

      // The plate scrolls inside itself; the page never scrolls sideways.
      if (target.label !== "home") {
        const plate = page.locator("figure.plate");
        await expect(plate).toHaveCount(1);
        const overflow = await plate.evaluate((el) => getComputedStyle(el).overflowX);
        expect(overflow).toBe("auto");
      }
      const width = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        view: window.innerWidth,
      }));
      expect(width.view).toBeLessThanOrEqual(viewport.width);
      expect(width.scroll).toBeLessThanOrEqual(width.view);

      // Kept beside the report for the operator's review (no baseline). Taken
      // before the Tab below, so no screenshot carries a focus ring.
      const shot = await page.screenshot({
        fullPage: true,
        path: testInfo.outputPath(`${target.label}-${viewport.label}.png`),
      });
      await testInfo.attach(`${target.label}-${viewport.label}`, {
        body: shot,
        contentType: "image/png",
      });

      // A visible focus outline on the first tabbable element.
      await page.keyboard.press("Tab");
      const focus = await page.evaluate(() => {
        const active = document.activeElement;
        const style = active === null ? null : getComputedStyle(active);
        return { label: active?.textContent ?? "", outline: style?.outlineStyle ?? "none" };
      });
      expect(focus.label).toContain("graphs");
      expect(focus.outline).not.toBe("none");
    });
  }
}
