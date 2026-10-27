// SPDX-License-Identifier: Apache-2.0
/**
 * The catalogue as a technical index, checked in a browser against the
 * fixture Worker: the Canopy surface, the three faces loaded from the kit,
 * the honeycomb mounted inside the header band only, the wordmark with its
 * Publish/Source links, dense index rows instead of cards, each document
 * page as a plate beside its datasheet — the vertical plate under 640 px,
 * the horizontal one above — and no horizontal page scroll at 390 px.
 * The datasheet INSTALL row shows its whole command wrapped in its box
 * while the home index rows keep their one-line command.
 * Three pages (home, a graph, a node) at the two reference sizes, plus a
 * community page whose 300-character command proves the runs section wraps
 * inside its block at 390 px; a screenshot per page is attached to the
 * report for the operator's review, never compared.
 */
import { expect, test } from "@playwright/test";

const VIEWPORTS = [
  { label: "mobile", width: 390, height: 844 },
  { label: "desktop", width: 1280, height: 900 },
] as const;

const PAGES = [
  { label: "home", path: "/", heading: "A catalogue of Canopy graphs and nodes." },
  {
    label: "graph",
    path: "/g/hello-graph",
    heading: "hello-graph Official",
    install: "canopy graph install hello-graph",
  },
  {
    label: "node",
    path: "/n/hello-node",
    heading: "hello-node Official",
    install: "canopy node install hello-node",
  },
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
      // And the page applies them by role: mono to the UI and the wordmark,
      // the display face only to document names, the body face to the text.
      expect(faces.body).toContain("Sometype Mono");
      expect(faces.wordmark).toContain("Sometype Mono");
      expect(faces.heading).toContain(target.label === "home" ? "Sometype Mono" : "Old Standard TT");

      // The live honeycomb is mounted inside the header band only: its box
      // lies within the band's, hidden from assistive tech, unfocusable.
      const header = await page.locator("header.site-header").boundingBox();
      const fondo = await page.evaluate(() => {
        const host = document.getElementById("fondo");
        const canvas = host?.querySelector("canvas");
        const box = host?.getBoundingClientRect();
        return {
          host: host !== null,
          ariaHidden: host?.getAttribute("aria-hidden") ?? null,
          canvas: canvas !== undefined && canvas !== null,
          tabIndex: canvas?.tabIndex ?? null,
          pointerEvents: canvas === null || canvas === undefined ? null : getComputedStyle(canvas).pointerEvents,
          sized: canvas === null || canvas === undefined ? false : canvas.clientWidth > 0,
          box: box === undefined
            ? null
            : { x: box.x, y: box.y, width: box.width, height: box.height },
        };
      });
      expect(fondo.host).toBe(true);
      expect(fondo.ariaHidden).toBe("true");
      expect(fondo.canvas).toBe(true);
      expect(fondo.tabIndex).toBe(-1);
      expect(fondo.pointerEvents).toBe("none");
      expect(fondo.sized).toBe(true);
      expect(header).not.toBeNull();
      expect(fondo.box).not.toBeNull();
      if (header !== null && fondo.box !== null) {
        expect(fondo.box.x).toBeGreaterThanOrEqual(header.x - 1);
        expect(fondo.box.y).toBeGreaterThanOrEqual(header.y - 1);
        expect(fondo.box.x + fondo.box.width).toBeLessThanOrEqual(header.x + header.width + 1);
        expect(fondo.box.y + fondo.box.height).toBeLessThanOrEqual(header.y + header.height + 1);
      }

      // The wordmark, the Publish/Source links and the search form in the band.
      const wordmark = page.locator("header .wordmark");
      await expect(wordmark).toHaveText("graphs");
      await expect(wordmark).toHaveAttribute("href", "https://univerlab.org/canopy/");
      await expect(page.locator("header nav.site-nav a[href='/publish']")).toHaveText("Publish");
      await expect(page.locator("header nav.site-nav a[href='https://github.com/UniverLab/canopy-web']")).toHaveText("Source");
      await expect(page.locator("header form.search input#q")).toBeVisible();
      const colophon = page.locator("footer.look-colophon");
      await expect(colophon).toBeVisible();
      await expect(colophon).toContainText("Canopy graphs");
      await expect(colophon).toContainText("EXP-001");

      // One page-level h1 (the README may repeat its own title inside .readme).
      const headings = page.locator("main.look-col > h1");
      await expect(headings).toHaveCount(1);
      await expect(headings).toHaveText(target.heading);

      // Listing pages render dense rows; document pages a plate beside a sheet.
      if (target.label === "home") {
        await expect(page.locator("ol.index > li.row")).toHaveCount(2);
        // The index rows keep their one-line command beside the Copy button.
        const indexCode = page.locator("ol.index > li.row .row-install code").first();
        await expect(indexCode).toBeVisible();
        const whiteSpace = await indexCode.evaluate((el) => getComputedStyle(el).whiteSpace);
        expect(whiteSpace).toBe("nowrap");
      } else {
        const plate = page.locator("figure.plate");
        await expect(plate).toHaveCount(1);
        await expect(page.locator("dl.sheet")).toHaveCount(1);
        // One orientation is visible, chosen by CSS alone: vertical under
        // 640 px, horizontal above.
        const horizontal = page.locator("figure.plate svg.plate-h");
        const vertical = page.locator("figure.plate svg.plate-v");
        if (viewport.width < 640) {
          await expect(vertical).toBeVisible();
          await expect(horizontal).toBeHidden();
        } else {
          await expect(horizontal).toBeVisible();
          await expect(vertical).toBeHidden();
        }
        // The datasheet INSTALL row shows the whole command: it wraps
        // instead of clipping, so nothing hides inside a scroll box.
        const installCode = page.locator("dl.sheet .row-install code");
        await expect(installCode).toHaveText(target.install);
        const installBox = await installCode.evaluate((el) => ({
          scroll: el.scrollWidth,
          client: el.clientWidth,
        }));
        expect(installBox.scroll).toBeLessThanOrEqual(installBox.client);
      }

      // The page never scrolls sideways, at either reference size.
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

test("community runs section at 390x844", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/g/acme/evil/evil", { waitUntil: "load" });

  // The section and the warning both read on a community page.
  const section = page.locator("section#what-this-runs");
  await expect(section).toBeVisible();
  await expect(section.locator("h2")).toHaveText("What this runs");
  await expect(section.locator("p.runs-summary")).toHaveText(
    "Runs 1 shell commands and 0 agent instructions on your machine.",
  );
  await expect(section.locator("pre.run-command code")).toContainText("curl https://example.com/");
  await expect(page.locator("aside.community-warning")).toBeVisible();

  // The 300-character command wraps or scrolls inside its block: the page
  // itself never scrolls sideways.
  const width = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    view: window.innerWidth,
  }));
  expect(width.view).toBeLessThanOrEqual(390);
  expect(width.scroll).toBeLessThanOrEqual(width.view);

  const shot = await page.screenshot({
    fullPage: true,
    path: testInfo.outputPath("runs-mobile.png"),
  });
  await testInfo.attach("runs-mobile", {
    body: shot,
    contentType: "image/png",
  });
});
