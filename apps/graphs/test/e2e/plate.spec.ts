// SPDX-License-Identifier: Apache-2.0
/**
 * The document plate viewport, in a browser against the fixture Worker:
 * one horizontal plate at every size, as tall as the datasheet beside it
 * on desktop (1440x900) and full width at 60svh on a phone (390x844),
 * panning under a drag, zooming under `+`, and restored whole by Fit —
 * with no vertical twin anywhere. A screenshot per test is attached to
 * the report for the operator's review, never compared.
 */
import { expect, test } from "@playwright/test";

/** The scale out of a `translate(xpx, ypx) scale(z)` paint. */
function scaleOf(transform: string): number {
  return Number(/scale\(([^)]+)\)/.exec(transform)?.[1] ?? Number.NaN);
}

test("the viewport stands as tall as the datasheet at 1440x900", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/g/hello-graph", { waitUntil: "load" });
  const figure = page.locator("figure.plate");
  await expect(figure).toHaveClass(/is-live/);

  // One horizontal drawing, no vertical twin on the page.
  await expect(page.locator("figure.plate svg.plate-h")).toHaveCount(1);
  await expect(page.locator("svg.plate-v")).toHaveCount(0);

  // The live viewport clips instead of scrolling, and owns its touches.
  const live = await page.evaluate(() => {
    const style = getComputedStyle(document.querySelector("figure.plate") as HTMLElement);
    return { overflow: style.overflow, touchAction: style.touchAction };
  });
  expect(live.overflow).toBe("hidden");
  expect(live.touchAction).toBe("none");

  // The stretched row: plate and datasheet share one height.
  const heights = await page.evaluate(() => ({
    plate: document.querySelector("figure.plate")!.getBoundingClientRect().height,
    sheet: document.querySelector("dl.sheet")!.getBoundingClientRect().height,
  }));
  expect(Math.abs(heights.plate - heights.sheet)).toBeLessThanOrEqual(1);
  expect(heights.plate).toBeGreaterThanOrEqual(420);

  const shot = await page.screenshot({
    fullPage: true,
    path: testInfo.outputPath("plate-desktop.png"),
  });
  await testInfo.attach("plate-desktop", { body: shot, contentType: "image/png" });
});

test("one horizontal plate in a 60svh viewport at 390x844", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/g/hello-graph", { waitUntil: "load" });
  const figure = page.locator("figure.plate");
  await expect(figure).toHaveClass(/is-live/);

  await expect(page.locator("figure.plate svg.plate-h")).toHaveCount(1);
  await expect(page.locator("figure.plate svg.plate-h")).toBeVisible();
  await expect(page.locator("svg.plate-v")).toHaveCount(0);

  // Full width of the content column, 60svh tall.
  const box = await page.evaluate(() => {
    const main = document.querySelector("main.look-col") as HTMLElement;
    const style = getComputedStyle(main);
    const fig = document.querySelector("figure.plate")!.getBoundingClientRect();
    return {
      width: fig.width,
      column: main.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      height: fig.height,
      svh: window.innerHeight * 0.6,
    };
  });
  expect(Math.abs(box.width - box.column)).toBeLessThanOrEqual(1);
  expect(Math.abs(box.height - box.svh)).toBeLessThanOrEqual(2);

  // The node page draws its one node the same way.
  await page.goto("/n/hello-node", { waitUntil: "load" });
  await expect(page.locator("figure.plate svg.plate-h")).toHaveCount(1);
  await expect(page.locator("svg.plate-v")).toHaveCount(0);

  const shot = await page.screenshot({
    fullPage: true,
    path: testInfo.outputPath("plate-mobile.png"),
  });
  await testInfo.attach("plate-mobile", { body: shot, contentType: "image/png" });
});

test("drag pans, + zooms, Fit restores the whole graph", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/g/hello-graph", { waitUntil: "load" });
  const figure = page.locator("figure.plate");
  await expect(figure).toHaveClass(/is-live/);
  const transform = (): Promise<string> =>
    page.evaluate(() => (document.querySelector("figure.plate svg") as SVGSVGElement).style.transform);

  // Mounted at Fit: the whole drawing inside the viewport.
  const fits = async (): Promise<boolean> =>
    page.evaluate(() => {
      const fig = document.querySelector("figure.plate")!.getBoundingClientRect();
      const svg = document.querySelector("figure.plate svg")!.getBoundingClientRect();
      return (
        svg.left >= fig.left - 1 &&
        svg.top >= fig.top - 1 &&
        svg.right <= fig.right + 1 &&
        svg.bottom <= fig.bottom + 1
      );
    });
  expect(await fits()).toBe(true);

  // A drag moves the view.
  await figure.scrollIntoViewIfNeeded();
  const box = await figure.boundingBox();
  const cx = (box?.x ?? 0) + (box?.width ?? 0) / 2;
  const cy = (box?.y ?? 0) + (box?.height ?? 0) / 2;
  const before = await transform();
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 120, cy + 60, { steps: 8 });
  await page.mouse.up();
  expect(await transform()).not.toBe(before);

  // `+` zooms from the focused viewport; arrows pan it.
  await figure.focus();
  const zoomedOut = scaleOf(await transform());
  await page.keyboard.press("+");
  const zoomed = scaleOf(await transform());
  expect(zoomed).toBeGreaterThan(zoomedOut);
  const panned = await transform();
  await page.keyboard.press("ArrowRight");
  expect(await transform()).not.toBe(panned);

  // Fit restores the whole graph, centred in the viewport.
  await page.getByRole("button", { name: "Fit the graph" }).click();
  expect(await fits()).toBe(true);
  expect(await transform()).toBe(before);

  const shot = await page.screenshot({
    fullPage: true,
    path: testInfo.outputPath("plate-fit.png"),
  });
  await testInfo.attach("plate-fit", { body: shot, contentType: "image/png" });
});

test("without JavaScript the viewport scrolls at scale 1", async ({ browser }) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  await page.goto("/g/hello-graph", { waitUntil: "load" });
  await expect(page.locator("figure.plate svg.plate-h")).toHaveCount(1);
  const fallback = await page.evaluate(() => {
    const figure = document.querySelector("figure.plate") as HTMLElement;
    return {
      live: figure.classList.contains("is-live"),
      overflow: getComputedStyle(figure).overflow,
      transform: (document.querySelector("figure.plate svg") as SVGSVGElement).style.transform,
      controls: document.querySelectorAll(".plate-controls").length,
    };
  });
  expect(fallback.live).toBe(false);
  expect(fallback.overflow).toBe("auto");
  expect(fallback.transform).toBe("");
  expect(fallback.controls).toBe(0);
  await context.close();
});

test("the zoom controls are 44 px targets, and plain wheel scrolls the page", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/g/hello-graph", { waitUntil: "load" });
  const figure = page.locator("figure.plate");
  await expect(figure).toHaveClass(/is-live/);

  const out = page.getByRole("button", { name: "Zoom out" });
  const zoom = page.getByRole("button", { name: "Zoom in" });
  const fit = page.getByRole("button", { name: "Fit the graph" });
  for (const button of [out, zoom, fit]) {
    await expect(button).toBeVisible();
    const target = await button.boundingBox();
    expect(target?.width).toBe(44);
    expect(target?.height).toBe(44);
  }

  // The buttons zoom around the centre.
  const scale = (): Promise<number> =>
    page.evaluate(() => {
      const painted = (document.querySelector("figure.plate svg") as SVGSVGElement).style.transform;
      return Number(/scale\(([^)]+)\)/.exec(painted)?.[1] ?? Number.NaN);
    });
  const resting = await scale();
  await zoom.click();
  expect(await scale()).toBeGreaterThan(resting);
  await out.click();
  expect(await scale()).toBeCloseTo(resting, 8);

  // A plain wheel over the plate scrolls the page and never the plate.
  await figure.scrollIntoViewIfNeeded();
  const box = await figure.boundingBox();
  await page.mouse.move((box?.x ?? 0) + (box?.width ?? 0) / 2, (box?.y ?? 0) + (box?.height ?? 0) / 2);
  const state = (): Promise<{ y: number; view: string }> =>
    page.evaluate(() => ({
      y: window.scrollY,
      view: (document.querySelector("figure.plate svg") as SVGSVGElement).style.transform,
    }));
  const scrolled = await state();
  await page.mouse.wheel(0, 300);
  await page.waitForFunction((y) => window.scrollY !== y, scrolled.y);
  expect((await state()).view).toBe(scrolled.view);
});

test("a resize keeps the zoom, refits a view at Fit, and never strands it past 4x", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/g/hello-graph", { waitUntil: "load" });
  const figure = page.locator("figure.plate");
  await expect(figure).toHaveClass(/is-live/);
  const view = (): Promise<{ scale: number; fits: boolean }> =>
    page.evaluate(() => {
      const fig = document.querySelector("figure.plate")!;
      const svg = fig.querySelector("svg") as SVGSVGElement;
      const painted = svg.style.transform;
      const fret = fig.getBoundingClientRect();
      const sret = svg.getBoundingClientRect();
      return {
        scale: Number(/scale\(([^)]+)\)/.exec(painted)?.[1] ?? Number.NaN),
        fits:
          sret.left >= fret.left - 1 &&
          sret.top >= fret.top - 1 &&
          sret.right <= fret.right + 1 &&
          sret.bottom <= fret.bottom + 1,
      };
    });

  // Zoomed off Fit, a resize keeps the current zoom.
  await figure.focus();
  await page.keyboard.press("+");
  await page.keyboard.press("+");
  const zoomed = (await view()).scale;
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(async () => (await view()).scale).toBeCloseTo(zoomed, 10);

  // At Fit, a resize refits: the whole graph stays visible.
  await page.getByRole("button", { name: "Fit the graph" }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(async () => (await view()).fits).toBe(true);

  // Zoomed to the stop, then narrowed across the breakpoint (the figure
  // keeps full width but loses most of it, so the new fit is far smaller):
  // the kept zoom re-clamps to 4x of the new fit instead of stranding.
  await figure.focus();
  for (let step = 0; step < 20; step += 1) {
    await page.keyboard.press("+");
  }
  await page.setViewportSize({ width: 500, height: 800 });
  // Polled: the ResizeObserver re-clamps on the next frame, not synchronously.
  const inRange = (): Promise<boolean> =>
    page.evaluate(() => {
      const fig = document.querySelector("figure.plate") as HTMLElement;
      const svg = fig.querySelector("svg") as SVGSVGElement;
      const painted = svg.style.transform;
      const fit = Math.min(
        fig.clientWidth / Number(svg.getAttribute("width")),
        fig.clientHeight / Number(svg.getAttribute("height")),
      );
      const scale = Number(/scale\(([^)]+)\)/.exec(painted)?.[1] ?? Number.NaN);
      return scale <= fit * 4 + 1e-9 && scale >= fit * 0.25 - 1e-9;
    });
  await expect.poll(inRange).toBe(true);
});

test("a modified key leaves the viewport alone for the browser", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/g/hello-graph", { waitUntil: "load" });
  const figure = page.locator("figure.plate");
  await expect(figure).toHaveClass(/is-live/);
  await figure.focus();
  // A synthetic modified keydown: trusted Ctrl+`+` would zoom the page
  // itself, so the handler's guard is what this pins.
  const untouched = await page.evaluate(() => {
    const svg = document.querySelector("figure.plate svg") as SVGSVGElement;
    const before = svg.style.transform;
    for (const init of [
      { key: "+", ctrlKey: true },
      { key: "+", metaKey: true },
      { key: "ArrowRight", altKey: true },
    ]) {
      document.querySelector("figure.plate")!.dispatchEvent(
        new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true }),
      );
    }
    return { before, after: svg.style.transform };
  });
  expect(untouched.after).toBe(untouched.before);
});
