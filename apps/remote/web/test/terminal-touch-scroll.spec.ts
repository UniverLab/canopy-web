// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";

// On a phone the remote terminal could not scroll its history: a
// one-finger swipe landed on .term-pane (nothing to scroll) while xterm
// only listened for wheel events. A vertical drag now scrolls the
// terminal through a synthetic wheel on .xterm (scrollback in the normal
// buffer, wheel reports in mouse mode), a horizontal drag still pans the
// zoomed pane natively, and a tap still focuses the keyboard.
//
// The WebGL renderer has no .xterm-rows text, so the viewport is asserted
// through the fake host's buffer reads, never the DOM.
test.use({ hasTouch: true });

async function terminalText(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(() => window.__fake.terminalText());
}

interface BufferState {
  type: string;
  rows: string[];
  viewportY: number;
  baseY: number;
}

async function bufferState(page: import("@playwright/test").Page): Promise<BufferState> {
  const state = await page.evaluate(() => window.__fake.bufferState?.() ?? null);
  if (!state) {
    throw new Error("no terminal buffer (xterm not open?)");
  }
  return state;
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/fake.html");
  await expect(page.locator('[data-session="smoke"]')).toBeVisible();
  await page.locator('[data-session="smoke"]').click();
  await expect.poll(() => terminalText(page)).toContain("hello from the host");
});

// Short numbered lines (no wrap) ending without a newline, so the last
// line sits on the viewport's own last row once the tail is followed.
async function pushScrollback(page: import("@playwright/test").Page, count: number): Promise<void> {
  await page.evaluate((n: number) => {
    const rows: string[] = [];
    for (let i = 1; i <= n; i += 1) {
      rows.push(`scroll-${String(i).padStart(3, "0")}`);
    }
    window.__fake.pushOut(rows.join("\r\n"));
  }, count);
  const last = `scroll-${String(count).padStart(3, "0")}`;
  await expect.poll(() => terminalText(page)).toContain(last);
  // Null-safe while xterm digests the burst: the tail row is on screen
  // and the viewport sits at the bottom.
  await expect
    .poll(async () => {
      const state = await page.evaluate(() => window.__fake.bufferState?.() ?? null);
      if (!state || state.viewportY !== state.baseY) {
        return "";
      }
      return state.rows[state.rows.length - 1] ?? "";
    })
    .toContain(last);
}

interface Point {
  x: number;
  y: number;
}

async function paneCenter(page: import("@playwright/test").Page): Promise<Point> {
  const box = await page.locator(".term-pane").boundingBox();
  if (!box) {
    throw new Error("no .term-pane box");
  }
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

// One finger from `from` to `to` through CDP touch events: slow steps
// (10 px per 50 ms) stay under the 0.3 px/ms fling gate, so the
// assertions below see the drag alone, never its momentum.
async function swipe(
  page: import("@playwright/test").Page,
  from: Point,
  to: Point,
): Promise<void> {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(2, Math.round(distance / 10));
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: from.x, y: from.y, id: 1 }],
    });
    for (let i = 1; i <= steps; i += 1) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          {
            x: from.x + ((to.x - from.x) * i) / steps,
            y: from.y + ((to.y - from.y) * i) / steps,
            id: 1,
          },
        ],
      });
      await page.waitForTimeout(50);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await cdp.detach().catch(() => {});
  }
}

test("one_finger_vertical_drag_scrolls_history", async ({ page }) => {
  await pushScrollback(page, 200);
  const before = await bufferState(page);
  expect(before.type).toBe("normal");
  expect(before.viewportY).toBe(before.baseY);
  const baseY = before.baseY;
  // The 200 lines really scrolled: the viewport sits far above line 1.
  expect(baseY).toBeGreaterThan(50);
  await expect(page.locator("#term-latest")).toBeHidden();

  // A downward drag reveals older lines: viewportY drops, latest shows.
  const down = await paneCenter(page);
  await swipe(page, down, { x: down.x, y: down.y + 200 });
  await expect
    .poll(async () => {
      const state = await page.evaluate(() => window.__fake.bufferState?.() ?? null);
      return state?.viewportY ?? baseY;
    })
    .toBeLessThan(baseY - 5);
  await expect(page.locator("#term-latest")).toBeVisible();

  // An upward drag scrolls back to the live tail: follow resumes.
  const up = await paneCenter(page);
  await swipe(page, up, { x: up.x, y: up.y - 300 });
  await expect
    .poll(async () => {
      const state = await page.evaluate(() => window.__fake.bufferState?.() ?? null);
      return state?.viewportY ?? -1;
    })
    .toBe(baseY);
  await expect(page.locator("#term-latest")).toBeHidden();
});

test("horizontal_drag_pans_zoomed_pane_not_history", async ({ page }) => {
  await pushScrollback(page, 200);
  const before = await bufferState(page);
  // Zoom to ~2x through the + button (1.25^3 ≈ 1.95): the pane gains a
  // horizontal scrollbar to pan.
  for (let i = 0; i < 3; i += 1) {
    await page.locator("#term-zoom-in").click();
  }
  await expect
    .poll(() =>
      page.evaluate(() => {
        const pane = document.querySelector(".term-pane") as HTMLElement;
        return pane.scrollWidth - pane.clientWidth;
      }),
    )
    .toBeGreaterThan(50);
  // The refit anchors the pane at the line start before the pan.
  expect(
    await page.evaluate(
      () => (document.querySelector(".term-pane") as HTMLElement).scrollLeft,
    ),
  ).toBeLessThanOrEqual(1);

  // A leftward drag pans right; the history never moves.
  const center = await paneCenter(page);
  await swipe(page, center, { x: center.x - 150, y: center.y });
  await expect
    .poll(() =>
      page.evaluate(
        () => (document.querySelector(".term-pane") as HTMLElement).scrollLeft,
      ),
    )
    .toBeGreaterThan(20);
  const after = await bufferState(page);
  expect(after.baseY).toBe(before.baseY);
  expect(after.viewportY).toBe(after.baseY);
  await expect(page.locator("#term-latest")).toBeHidden();
});

test("tap_focuses_terminal_keyboard", async ({ page }) => {
  const center = await paneCenter(page);
  await page.touchscreen.tap(center.x, center.y);
  // The tap lands xterm's hidden textarea: the phone keyboard opens.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const active = document.activeElement;
        return active ? `${active.tagName}.${active.className}` : "none";
      }),
    )
    .toBe("TEXTAREA.xterm-helper-textarea");
});
