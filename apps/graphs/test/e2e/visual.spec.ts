// SPDX-License-Identifier: Apache-2.0
/**
 * The catalogue as a technical index, checked in a browser against the
 * fixture Worker: the Canopy surface, the three faces loaded from the kit,
 * the honeycomb mounted inside the header band only, the header banner as
 * an SVG on a fixed grid (about 160 px tall on desktop, 96 px on a phone,
 * no sideways scroll at 360 px) with its Publish/Source links, dense index
 * rows instead of cards, each document page as a plate beside its
 * datasheet — the vertical plate under 640 px, the horizontal one above —
 * and no horizontal page scroll at 390 px.
 * The datasheet INSTALL row shows its whole command wrapped in its box
 * while the home index rows keep their one-line command — the command a
 * raised field (command surface, visible outline, full ink) at the Copy
 * button's height.
 * Three pages (home, a graph, a node) at the two reference sizes, plus a
 * community page whose 300-character command proves the runs section wraps
 * inside its block at 390 px, and a missing document; a screenshot per page
 * is attached to the report for the operator's review, never compared.
 * The stage and the meaning tints are asserted as computed colours: the
 * plate and the datasheet on black panels, the community warning and runs
 * summary in warn, the 404 block in error — no body banner anywhere, and
 * the colophon links share one row at desktop width.
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
      // A refused inline style (or any CSP breach) logs here; the banner's
      // ink must arrive as fill attributes or banner.css, never `style=`.
      const refused: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") {
          refused.push(message.text());
        }
      });
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
        };
      });
      expect(faces.status).toBe("loaded");
      const kit = ["EB Garamond", "Old Standard TT", "Sometype Mono"];
      // All three are registered by the kit, and each has a face actually loaded.
      expect(faces.families).toEqual(expect.arrayContaining(kit));
      expect(faces.loaded).toEqual(expect.arrayContaining(kit));
      // And the page applies them by role: mono to the UI, the display face
      // only to document names, the body face to the text. The banner is an
      // SVG, so no face applies to it at all.
      expect(faces.body).toContain("Sometype Mono");
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

      // The header banner links home: the graphs art as an SVG on a fixed
      // grid, and no header link points at the Canopy landing any more.
      const home = page.locator("header .banner-home");
      await expect(home).toHaveAttribute("href", "/");
      await expect(home).toHaveAttribute("aria-label", "Canopy graphs, home");
      const art = home.locator("svg.look-banner-header");
      await expect(art).toBeVisible();
      await expect(art).toHaveAttribute("role", "img");
      await expect(art).toHaveAttribute("aria-label", "Canopy graphs");
      await expect(home.locator(".look-banner-line")).toHaveCount(11);
      await expect(page.locator("header a[href*='univerlab.org/canopy']")).toHaveCount(0);
      // About 160 px tall on desktop, 96 px on the phone, and never
      // wider than the header row.
      const box = await art.boundingBox();
      expect(box).not.toBeNull();
      expect(Math.abs((box?.height ?? 0) - (viewport.width < 640 ? 96 : 160))).toBeLessThanOrEqual(5);
      expect((box?.width ?? 0) + (box?.x ?? 0)).toBeLessThanOrEqual(viewport.width);
      // The teal gradient is a `fill` presentation attribute — never a
      // style attribute, which this page's CSP would refuse — so the art
      // is teal, not flat ink.
      const inks = await page
        .locator("header .look-banner-line")
        .evaluateAll((groups) => groups.map((group) => getComputedStyle(group).fill));
      expect(inks).toHaveLength(11);
      expect(inks[0]).toBe("rgb(82, 255, 246)");
      expect(inks[10]).toBe("rgb(0, 102, 97)");
      expect(refused.filter((text) => text.includes("Content Security Policy"))).toEqual([]);
      await expect(page.locator("header nav.site-nav a[href='/editor']")).toHaveText("Editor");
      await expect(page.locator("header nav.site-nav a[href='/publish']")).toHaveText("Publish");
      await expect(page.locator("header nav.site-nav a[href='/patterns']")).toHaveText("Patterns");
      await expect(page.locator("header nav.site-nav a[href='https://github.com/UniverLab/canopy-web']")).toHaveText("Source");
      // Every header link lies inside the viewport at both reference
      // sizes — the Source link was cut off at 390 px — and under 640 px
      // each is a 44 px target, icon only with the label as its name.
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
      // The header holds the banner and the nav only: the search form
      // lives in the page body on the home page, and nowhere else here.
      await expect(page.locator("header form")).toHaveCount(0);
      if (target.label === "home") {
        await expect(page.locator("main form.search input#q")).toBeVisible();
      } else {
        await expect(page.locator("main form.search")).toHaveCount(0);
      }
      const colophon = page.locator("footer.look-colophon");
      await expect(colophon).toBeVisible();
      await expect(colophon).toContainText("Canopy graphs");
      await expect(colophon).toContainText("EXP-001");

      // One page-level h1 (the README may repeat its own title inside .readme).
      const headings = page.locator("main.look-col > h1");
      await expect(headings).toHaveCount(1);
      await expect(headings).toHaveText(target.heading);

      // No body banner anywhere: the page starts directly under the header.
      await expect(page.locator("main.look-col .look-banner")).toHaveCount(0);

      // Listing pages render dense rows; document pages a plate beside a sheet.
      if (target.label === "home") {
        await expect(page.locator("ol.index > li.row")).toHaveCount(3);
        // The index rows keep their one-line command beside the Copy button.
        const indexCode = page.locator("ol.index > li.row .row-install code").first();
        await expect(indexCode).toBeVisible();
        const whiteSpace = await indexCode.evaluate((el) => getComputedStyle(el).whiteSpace);
        expect(whiteSpace).toBe("nowrap");
        // And the command reads as a field of its own: the raised command
        // surface, its visible outline, the command at full ink.
        const painted = await indexCode.evaluate((el) => {
          const style = getComputedStyle(el);
          return { background: style.backgroundColor, border: style.borderColor, ink: style.color };
        });
        expect(painted.background).toBe("rgb(69, 69, 69)");
        expect(painted.border).toBe("rgb(120, 120, 120)");
        expect(painted.ink).toBe("rgb(237, 255, 254)");
        // The field and its Copy button line up at one height.
        const heights = await page.evaluate(() => {
          const row = document.querySelector("ol.index > li.row .row-install");
          const box = (selector: string): number =>
            row?.querySelector(selector)?.getBoundingClientRect().height ?? 0;
          return { code: box("code"), copy: box(".copy") };
        });
        expect(Math.abs(heights.code - heights.copy)).toBeLessThanOrEqual(1);
      } else {
        // The plate is the black stage; the datasheet sits on the same panel.
        const painted = await page.evaluate(() => ({
          plate: getComputedStyle(document.querySelector("figure.plate") as HTMLElement)
            .backgroundColor,
          sheet: getComputedStyle(document.querySelector("dl.sheet") as HTMLElement)
            .backgroundColor,
        }));
        expect(painted.plate).toBe("rgb(5, 5, 5)");
        expect(painted.sheet).toBe("rgb(5, 5, 5)");
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

      // A visible focus outline on the first tabbable element: the home link.
      await page.keyboard.press("Tab");
      const focus = await page.evaluate(() => {
        const active = document.activeElement;
        const style = active === null ? null : getComputedStyle(active);
        return {
          name: (active as HTMLElement | null)?.getAttribute?.("aria-label") ?? "",
          outline: style?.outlineStyle ?? "none",
        };
      });
      expect(focus.name).toBe("Canopy graphs, home");
      expect(focus.outline).not.toBe("none");
    });
  }
}

for (const viewport of VIEWPORTS) {
  test(`icons and the Copy morph at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/", { waitUntil: "load" });

    // The page's icons are Lucide data drawn inline: currentColor, hidden
    // from readers, and no font or sprite request anywhere.
    const search = page.locator("main form.search button svg.icon");
    await expect(search).toHaveCount(1);
    await expect(search).toHaveAttribute("aria-hidden", "true");
    await expect(search).toHaveAttribute("stroke", "currentColor");
    await expect(search).toHaveAttribute("stroke-width", "1.75");
    await expect(page.locator("header nav.site-nav svg.icon")).toHaveCount(4);
    await expect(page.locator("link[rel='preload'][as='font']")).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        [...document.querySelectorAll("use")].filter((use) => use.getAttribute("href")?.startsWith("#")).length,
      ),
    ).toBe(0);

    // Every row's kind chip carries its icon, the official badge its own.
    await expect(page.locator("ol.index .kind svg.icon")).toHaveCount(3);
    await expect(page.locator("ol.index .badge-official svg.icon")).toHaveCount(2);
    await expect(page.locator("ol.index .row-meta svg.icon").first()).toBeVisible();

    // The Copy button: the icon becomes a check on a successful copy, then
    // goes back — and the icon's box never moves.
    const button = page.locator("ol.index li.row .copy").first();
    const icon = button.locator(".copy-icon");
    await expect(icon).toHaveAttribute("data-icon", "copy");
    const before = await icon.boundingBox();
    const buttonBefore = await button.boundingBox();
    expect(before).not.toBeNull();
    await button.click();
    await expect(icon).toHaveAttribute("data-icon", "check");
    const during = await icon.boundingBox();
    expect(during).toEqual(before);
    // The confirmation word does not resize the button either.
    expect(await button.boundingBox()).toEqual(buttonBefore);
    const copied = await page.screenshot({ path: testInfo.outputPath(`copy-check-${viewport.label}.png`) });
    await testInfo.attach(`copy-check-${viewport.label}`, { body: copied, contentType: "image/png" });
    await expect(icon).toHaveAttribute("data-icon", "copy", { timeout: 4000 });
    expect(await icon.boundingBox()).toEqual(before);

    // Touch targets hold on a phone.
    if (viewport.width < 640) {
      const box = await button.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }

    // No icon paints a colour of its own: all inherit currentColor, the
    // warning triangle alone takes the warn ink.
    const warning = await page.goto("/g/acme/evil/evil", { waitUntil: "load" });
    expect(warning?.status()).toBe(200);
    const warnIcon = page.locator("aside.community-warning svg.icon");
    await expect(warnIcon).toHaveCount(1);
    const warnInk = await warnIcon.evaluate((el) => getComputedStyle(el).color);
    expect(warnInk).toBe("rgb(255, 107, 107)");
    const follows = await page.evaluate(() =>
      [...document.querySelectorAll("svg.icon")]
        .filter((icon) => icon.closest("aside.community-warning") === null)
        .every(
          (icon) =>
            getComputedStyle(icon).stroke ===
            getComputedStyle(icon.parentElement ?? icon).color,
        ),
    );
    expect(follows).toBe(true);
    const shot = await page.screenshot({ fullPage: true, path: testInfo.outputPath(`icons-${viewport.label}.png`) });
    await testInfo.attach(`icons-${viewport.label}`, { body: shot, contentType: "image/png" });
  });
}

test("the copy morph jumps under prefers-reduced-motion", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/", { waitUntil: "load" });
  const button = page.locator("ol.index li.row .copy").first();
  const icon = button.locator(".copy-icon");
  await button.click();
  await expect(icon).toHaveAttribute("data-icon", "check");
  // No in-between shapes: the path is the check from the first frame and
  // stays byte-identical, where a spring would be repainting it.
  const path = icon.locator("path");
  const first = await path.getAttribute("d");
  await page.waitForTimeout(400);
  expect(await path.getAttribute("d")).toBe(first);
});

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

  // The warning and the runs summary share the warn tint: rgb(38, 1, 14).
  const warned = await page.evaluate(() => ({
    warning: getComputedStyle(document.querySelector("aside.community-warning") as HTMLElement)
      .backgroundColor,
    summary: getComputedStyle(document.querySelector("p.runs-summary") as HTMLElement)
      .backgroundColor,
  }));
  expect(warned.warning).toBe("rgb(38, 1, 14)");
  expect(warned.summary).toBe("rgb(38, 1, 14)");

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

test("the header banner resolves to the app home", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/g/hello-graph", { waitUntil: "load" });
  await page.locator("header .banner-home").click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator("main.look-col > h1")).toHaveText(
    "A catalogue of Canopy graphs and nodes.",
  );
});

test("the colophon links share one row at 1280x900", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/", { waitUntil: "load" });
  // The middot between links is decoration, never part of a link's name.
  await expect(page.getByRole("link", { name: "univerlab.org", exact: true })).toHaveCount(1);
  await expect(page.getByRole("link", { name: "Terms", exact: true })).toHaveCount(1);
  const tops = await page
    .locator("footer.look-colophon nav a")
    .evaluateAll((links) => links.map((link) => (link as HTMLElement).offsetTop));
  expect(tops).toHaveLength(5);
  expect(new Set(tops).size).toBe(1);
});

test("the home lists sit on dark panels with the search in the page at 1280x900", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/", { waitUntil: "load" });

  // The lists read on near-black panels over the green ground.
  const painted = await page.evaluate(() => ({
    body: getComputedStyle(document.body).backgroundColor,
    panel: getComputedStyle(document.querySelector("ol.index") as HTMLElement).backgroundColor,
  }));
  expect(painted.body).toBe("rgb(1, 38, 36)");
  expect(painted.panel).toBe("rgb(5, 5, 5)");

  // The search form renders in the page body, above the lists — and no
  // header descendant is a form.
  await expect(page.locator("main form.search")).toHaveCount(1);
  await expect(page.locator("header form")).toHaveCount(0);
  const order = await page.evaluate(() => {
    const form = document.querySelector("main form.search")?.getBoundingClientRect().top ?? -1;
    const list = document.querySelector("main ol.index")?.getBoundingClientRect().top ?? -1;
    return { form, list };
  });
  expect(order.form).toBeGreaterThan(-1);
  expect(order.form).toBeLessThan(order.list);

  // The sections name their standing and kind on both sides.
  await expect(page.locator("main h2.kicker", { hasText: "Official graphs" })).toHaveCount(1);
  await expect(page.locator("main h2.kicker", { hasText: "Official nodes" })).toHaveCount(1);
  await expect(page.locator("main h2.kicker", { hasText: "Community graphs" })).toHaveCount(1);

  // The search results page carries the same form, in the body too.
  await page.goto("/search?q=evil", { waitUntil: "load" });
  await expect(page.locator("main form.search input#q")).toHaveValue("evil");
  await expect(page.locator("header form")).toHaveCount(0);
});

test("the header fits the banner and its four links at 480x900", async ({ page }) => {
  // The tightest width for the band: just below the labelled nav's
  // threshold, where the row has the least room beside the banner.
  await page.setViewportSize({ width: 480, height: 900 });
  await page.goto("/", { waitUntil: "load" });
  const fit = await page.evaluate(() => {
    const header = document.querySelector(".site-header") as HTMLElement;
    const links = [...document.querySelectorAll(".site-nav a")];
    const last = links[links.length - 1] as HTMLElement;
    return {
      clipped: header.scrollWidth - header.clientWidth,
      lastRight: Math.round(last.getBoundingClientRect().right),
      view: window.innerWidth,
    };
  });
  expect(fit.clipped).toBeLessThanOrEqual(0);
  expect(fit.lastRight).toBeLessThanOrEqual(fit.view);
  // And nothing hangs below the band's clipped edge either.
  const hang = await page.evaluate(() => {
    const bottom = document.querySelector(".site-header")!.getBoundingClientRect().bottom;
    return [...document.querySelectorAll(".site-nav a")].map(
      (link) => link.getBoundingClientRect().bottom - bottom,
    );
  });
  for (const over of hang) {
    expect(over).toBeLessThanOrEqual(1);
  }
});

test("the banner fits a 360 px phone beside its four icons", async ({ page }) => {
  // The narrowest phone: the banner's 253 px plus the band's gutters, and
  // the four icon-only links under it — no sideways scroll.
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/", { waitUntil: "load" });
  const fit = await page.evaluate(() => {
    const banner = document.querySelector(".banner-home .look-banner-header") as HTMLElement;
    const box = banner.getBoundingClientRect();
    const el = document.scrollingElement ?? document.documentElement;
    return {
      overflow: el.scrollWidth - el.clientWidth,
      left: Math.round(box.left),
      right: Math.round(box.right),
      height: Math.round(box.height),
      view: window.innerWidth,
    };
  });
  expect(fit.overflow).toBeLessThanOrEqual(1);
  expect(fit.left).toBeGreaterThanOrEqual(0);
  expect(fit.right).toBeLessThanOrEqual(fit.view);
  expect(Math.abs(fit.height - 96)).toBeLessThanOrEqual(5);
  // The band holds the banner and the wrapped icon row: no link hangs
  // below the header's clipped edge.
  const hang = await page.evaluate(() => {
    const bottom = document.querySelector(".site-header")!.getBoundingClientRect().bottom;
    return [...document.querySelectorAll(".site-nav a")].map(
      (link) => link.getBoundingClientRect().bottom - bottom,
    );
  });
  expect(hang).toHaveLength(4);
  for (const over of hang) {
    expect(over).toBeLessThanOrEqual(1);
  }
});

test("the colophon wraps without sideways scroll at 390x844", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/", { waitUntil: "load" });
  const boxes = await page
    .locator("footer.look-colophon nav a")
    .evaluateAll((links) =>
      links.map((link) => {
        const box = link.getBoundingClientRect();
        return { left: box.left, right: box.right };
      }),
    );
  expect(boxes).toHaveLength(5);
  for (const box of boxes) {
    expect(box.left).toBeGreaterThanOrEqual(-1);
    expect(box.right).toBeLessThanOrEqual(391);
  }
  const width = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    view: window.innerWidth,
  }));
  expect(width.scroll).toBeLessThanOrEqual(width.view);
});

test("missing document at 390x844", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/g/nope", { waitUntil: "load" });

  // The calm 404 paints its error block in the error tint: rgb(38, 1, 3).
  await expect(page.locator("section.busy-error h1")).toHaveText("Not found");
  const error = await page.evaluate(
    () =>
      getComputedStyle(document.querySelector("section.busy-error") as HTMLElement).backgroundColor,
  );
  expect(error).toBe("rgb(38, 1, 3)");

  const width = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    view: window.innerWidth,
  }));
  expect(width.view).toBeLessThanOrEqual(390);
  expect(width.scroll).toBeLessThanOrEqual(width.view);

  const shot = await page.screenshot({
    fullPage: true,
    path: testInfo.outputPath("missing-mobile.png"),
  });
  await testInfo.attach("missing-mobile", {
    body: shot,
    contentType: "image/png",
  });
});
