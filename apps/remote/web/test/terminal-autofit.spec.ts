// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";

// Audit finding U4 (2026-11-01, second pass): terminal text clipped on the
// right (`.../univerlab/sandbo`) until the terminal was refitted by hand,
// and on the left at zoom. The terminal must fit its panel by itself, on
// open, on panel resize and on zoom change.
//
// The WebGL renderer has no .xterm-rows text, so output is asserted through
// the fake host's recorded writes, never the DOM — while geometry proves
// nothing is clipped.
async function terminalText(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(() => window.__fake.terminalText());
}

// An 80-column line with unmistakable ends, in the audit's clipped-path
// shape: it fills the smoke session's 80×24 PTY exactly.
const WIDE_LINE = `/u/univerlab/sandbox/${"f".repeat(55)}|END`;

test.beforeEach(async ({ page }) => {
  await page.goto("/fake.html");
  await expect(page.locator('[data-session="smoke"]')).toBeVisible();
  await page.locator('[data-session="smoke"]').click();
  await expect.poll(() => terminalText(page)).toContain("hello from the host");
});

interface FitGeometry {
  scale: number;
  paneScroll: number;
  pageOverflow: number;
  scrollLeft: number;
  scalerLeft: number;
  scalerRight: number;
  contentLeft: number;
  contentRight: number;
}

async function fitGeometry(page: import("@playwright/test").Page): Promise<FitGeometry> {
  return page.evaluate(() => {
    const pane = document.querySelector(".term-pane") as HTMLElement;
    const fit = document.querySelector(".term-fit") as HTMLElement;
    const scaler = document.querySelector(".term-scale") as HTMLElement;
    const doc = document.scrollingElement ?? document.documentElement;
    const style = getComputedStyle(pane);
    const paneBox = pane.getBoundingClientRect();
    const scalerBox = scaler.getBoundingClientRect();
    return {
      scale: Number(fit.dataset.scale),
      paneScroll: pane.scrollWidth - pane.clientWidth,
      pageOverflow: doc.scrollWidth - doc.clientWidth,
      scrollLeft: pane.scrollLeft,
      scalerLeft: scalerBox.left,
      scalerRight: scalerBox.right,
      contentLeft:
        paneBox.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft),
      contentRight:
        paneBox.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight),
    };
  });
}

/** The terminal's zoom factor: fitted scale over pure fit-to-width. */
async function terminalZoom(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => {
    const fit = document.querySelector(".term-fit") as HTMLElement;
    const host = document.querySelector(".term-host") as HTMLElement;
    const content = host.firstElementChild ?? host;
    const fitScale = fit.clientWidth / (content as HTMLElement).scrollWidth;
    return Number(fit.dataset.scale) / fitScale;
  });
}

for (const viewport of [
  { label: "390x844", width: 390, height: 844 },
  { label: "1280x800", width: 1280, height: 800 },
] as const) {
  test(`terminal_autofits_panel at ${viewport.label}`, async ({ page }) => {
    expect(WIDE_LINE.length).toBe(80);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.evaluate((line) => window.__fake.pushOut(`${line}\r\n`), WIDE_LINE);
    await expect.poll(() => terminalText(page)).toContain("|END");
    // The refit lands through the resize observer after the viewport (and
    // hence the panel) settles: wait for a fitted scale with no overflow.
    await expect
      .poll(async () => {
        if (await page.evaluate(() => window.innerWidth) !== viewport.width) {
          return 99;
        }
        const measured = await fitGeometry(page);
        if (!(measured.scale > 0)) {
          return 99;
        }
        return measured.paneScroll;
      })
      .toBeLessThanOrEqual(1);
    const measured = await fitGeometry(page);
    // The full wide line arrived (start and end markers both recorded)…
    expect(await terminalText(page)).toContain(WIDE_LINE);
    // …and it fits: no pane overflow, no page overflow, line start at the
    // left edge, the visual box inside the pane's content box.
    expect(measured.paneScroll).toBeLessThanOrEqual(1);
    expect(measured.pageOverflow).toBeLessThanOrEqual(1);
    expect(measured.scrollLeft).toBeLessThanOrEqual(1);
    expect(measured.scalerLeft).toBeGreaterThanOrEqual(measured.contentLeft - 1);
    expect(measured.scalerRight).toBeLessThanOrEqual(measured.contentRight + 1);
  });
}

test("terminal_autofits_panel keeps the line start visible at 200% zoom", async ({ page }) => {
  expect(WIDE_LINE.length).toBe(80);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate((line) => window.__fake.pushOut(`${line}\r\n`), WIDE_LINE);
  await expect.poll(() => terminalText(page)).toContain("|END");
  // Let the panel settle after the viewport change before zooming: the zoom
  // ratio reads live layout, and a mid-settle refit can inflate it ~2 % and
  // end a read-then-click loop a step early (1.25³ = 1.953 < 1.99).
  await expect
    .poll(async () => {
      if (await page.evaluate(() => window.innerWidth) !== 390) {
        return 99;
      }
      const settled = await fitGeometry(page);
      if (!(settled.scale > 0)) {
        return 99;
      }
      return settled.paneScroll;
    })
    .toBeLessThanOrEqual(1);
  // Zoom to 200 % through the + button: four fixed 1.25× steps land at
  // 2.44 (below MAX_ZOOM 3), with no mid-loop reads to break early on
  // layout noise. Fit-to-width wins over zoom fidelity only at the left
  // anchor — the zoom still overflows to the right, where the pane pans.
  for (let i = 0; i < 4; i += 1) {
    await page.locator("#term-zoom-in").click();
  }
  await expect.poll(() => terminalZoom(page)).toBeGreaterThanOrEqual(1.99);
  const measured = await fitGeometry(page);
  // The zoomed line overflows to the right by design…
  expect(measured.scalerRight).toBeGreaterThan(measured.contentRight + 1);
  // …but the line start stays visible: the pane is anchored left.
  expect(measured.scrollLeft).toBeLessThanOrEqual(1);
  expect(measured.scalerLeft).toBeGreaterThanOrEqual(measured.contentLeft - 1);
});
