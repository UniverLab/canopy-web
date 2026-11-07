// SPDX-License-Identifier: Apache-2.0
// The resize is disabled: the size row is not offered, so the web never
// asserts a cols × rows of its own and stays a follower of the host's
// frame. These tests pin that: no toggle, no slider, no resize out, and
// a remembered toggle stays ignored after a reload.
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

test("offers no resize: no toggle, no slider, nothing asserted", async ({ page }) => {
  expect(await resizesSent(page)).toEqual([]);
  await expect(page.locator("#term-control-size")).toHaveCount(0);
  await expect(page.locator(".term-size-toggle")).toHaveCount(0);
  await expect(page.locator("#term-size-scale")).toHaveCount(0);
  await expect.poll(() => termState(page)).toEqual({ cols: 80, rows: 24, owner: false });
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
  // Zooming still magnifies the rendering, and asserts nothing.
  await page.locator("#term-zoom-in").click();
  await expect(page.locator(".term-fit")).not.toHaveAttribute("data-scale", "1");
  await page.waitForTimeout(400);
  expect(await resizesSent(page)).toEqual([]);
  // A reload keeps it that way: no toggle, no resize out.
  await page.reload();
  await page.locator('[data-session="smoke"]').click();
  await expect.poll(() => termState(page)).toEqual({ cols: 80, rows: 24, owner: false });
  await expect(page.locator("#term-control-size")).toHaveCount(0);
  expect(await resizesSent(page)).toEqual([]);
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

test("sends no release without a toggle to turn off", async ({ page }) => {
  await expect(page.locator("#term-control-size")).toHaveCount(0);
  await page.waitForTimeout(400);
  expect(await releasesSent(page)).toEqual([]);
  expect(await resizesSent(page)).toEqual([]);
  await expect.poll(() => termState(page)).toEqual({ cols: 80, rows: 24, owner: false });
});

test("follows another device's size without owning or fighting", async ({ page }) => {
  await page.evaluate(() => window.__fake.resizeFromElsewhere?.(120, 40));
  await expect(page.locator("#term-control-size")).toHaveCount(0);
  await expect.poll(() => termState(page)).toEqual({ cols: 120, rows: 40, owner: false });
  // Nothing goes back: the other device keeps the size.
  await page.setViewportSize({ width: 360, height: 640 });
  await page.waitForTimeout(400);
  expect(await resizesSent(page)).toEqual([]);
});
