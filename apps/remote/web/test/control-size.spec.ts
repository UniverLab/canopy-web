// SPDX-License-Identifier: Apache-2.0
// "This device controls the size" against the fake host: turning it on
// asserts the cols × rows that fit this phone's panel (never the host's
// own 80 × 24) and renders them unfitted; the host's resized frame then
// either moves a follower's terminal in place or, for an owner whose size
// another device replaced, turns the toggle off without fighting back.
import { expect, test } from "@playwright/test";

interface TermState {
  cols: number;
  rows: number;
  owner: boolean;
}

async function termState(page: import("@playwright/test").Page): Promise<TermState | null> {
  return page.evaluate(() => {
    const host = document.querySelector(".term-host") as
      | (HTMLElement & { __xterm?: { cols: number; rows: number } })
      | null;
    const term = host?.__xterm;
    if (!term) {
      return null;
    }
    return {
      cols: term.cols,
      rows: term.rows,
      owner: document.querySelector(".term-pane")?.hasAttribute("data-size-owner") ?? false,
    };
  });
}

async function resizesSent(page: import("@playwright/test").Page): Promise<{ cols: number; rows: number }[]> {
  return page.evaluate(() =>
    window.__fake
      .sent()
      .filter((frame) => (frame as { t?: string }).t === "resize")
      .map((frame) => {
        const { cols, rows } = frame as { cols: number; rows: number };
        return { cols, rows };
      }),
  );
}

async function releasesSent(page: import("@playwright/test").Page): Promise<unknown[]> {
  return page.evaluate(() =>
    window.__fake.sent().filter((frame) => (frame as { t?: string }).t === "resize_release"),
  );
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/fake.html");
  await page.locator('[data-session="smoke"]').click();
  await expect.poll(() => page.evaluate(() => window.__fake.terminalText())).toContain("hello from the host");
  await expect(page.locator(".term-fit")).toHaveAttribute("data-row-height", /\d/);
});

test("asserts the size that fits the phone's panel and renders it unfitted", async ({ page }) => {
  expect(await resizesSent(page)).toEqual([]);
  await page.locator(".term-size-toggle").click();
  await expect.poll(() => resizesSent(page).then((sent) => sent.length)).toBe(1);
  const [asserted] = await resizesSent(page);
  // A 390 px phone holds far fewer than the host's 80 columns.
  expect(asserted!.cols).toBeGreaterThanOrEqual(20);
  expect(asserted!.cols).toBeLessThan(80);
  expect(asserted!.rows).toBeGreaterThanOrEqual(5);
  // The local terminal took that grid and owns it, and it fits the pane.
  await expect.poll(() => termState(page)).toEqual({ ...asserted!, owner: true });
  const fits = await page.evaluate(() => {
    const pane = document.querySelector(".term-pane") as HTMLElement;
    const doc = document.scrollingElement ?? document.documentElement;
    return {
      paneOverflow: pane.scrollWidth - pane.clientWidth,
      pageOverflow: doc.scrollWidth - doc.clientWidth,
    };
  });
  expect(fits.paneOverflow).toBeLessThanOrEqual(1);
  expect(fits.pageOverflow).toBeLessThanOrEqual(1);
  // Zooming in fits fewer cells: re-asserted once the change settles.
  await page.locator("#term-zoom-in").click();
  await expect.poll(() => resizesSent(page).then((sent) => sent.length)).toBe(2);
  const zoomed = (await resizesSent(page))[1]!;
  expect(zoomed.cols).toBeLessThan(asserted!.cols);
  // The remembered toggle re-asserts after a reload.
  await page.reload();
  await page.locator('[data-session="smoke"]').click();
  await expect(page.locator("#term-control-size")).toBeChecked();
  await expect.poll(() => resizesSent(page).then((sent) => sent.length)).toBeGreaterThan(0);
  await expect.poll(() => termState(page).then((state) => state?.owner)).toBe(true);
});

test("follows a host resize in place while not the size owner", async ({ page }) => {
  await page.evaluate(() => window.__fake.resizeFromElsewhere?.(100, 30));
  await expect.poll(() => termState(page)).toEqual({ cols: 100, rows: 30, owner: false });
  // Fitted to the width again at the new grid: no sideways scroll.
  const paneOverflow = await page.evaluate(() => {
    const pane = document.querySelector(".term-pane") as HTMLElement;
    return pane.scrollWidth - pane.clientWidth;
  });
  expect(paneOverflow).toBeLessThanOrEqual(1);
  expect(await resizesSent(page)).toEqual([]);
});

test("gives the size back when the toggle turns off", async ({ page }) => {
  await page.locator(".term-size-toggle").click();
  await expect.poll(() => resizesSent(page).then((sent) => sent.length)).toBe(1);
  await page.evaluate(() => window.__fake.clearSent());
  await page.locator(".term-size-toggle").click();
  await expect(page.locator("#term-control-size")).not.toBeChecked();
  // Exactly one release goes out, and the host's own size comes back: the
  // terminal returns to the host's 80 columns and stops owning the size.
  await expect.poll(() => releasesSent(page).then((sent) => sent.length)).toBe(1);
  await expect.poll(() => termState(page)).toEqual({ cols: 80, rows: 24, owner: false });
  expect(await resizesSent(page)).toEqual([]);
});

test("lets another device take the size over without fighting", async ({ page }) => {
  await page.locator(".term-size-toggle").click();
  await expect.poll(() => resizesSent(page).then((sent) => sent.length)).toBe(1);
  await page.evaluate(() => window.__fake.resizeFromElsewhere?.(120, 40));
  await expect(page.locator("#term-control-size")).not.toBeChecked();
  await expect(page.locator(".term-size-note")).toHaveText("Size taken over by another device.");
  await expect.poll(() => termState(page)).toEqual({ cols: 120, rows: 40, owner: false });
  // Nothing goes back: the other device keeps the size.
  await page.setViewportSize({ width: 360, height: 640 });
  await page.waitForTimeout(400);
  expect(await resizesSent(page)).toHaveLength(1);
  // And the choice is remembered off.
  expect(await page.evaluate(() => localStorage.getItem("canopy.remote.term.controlSize.smoke"))).toBe("0");
});
