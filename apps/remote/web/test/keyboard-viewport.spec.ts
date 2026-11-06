// SPDX-License-Identifier: Apache-2.0
// The phone keyboard open state against the fake host: with the visual
// viewport stubbed shorter than the layout viewport the session view
// pins itself above the keyboard — the terminal pane and the key bar
// end inside the visual viewport, the pane sits on top of the key bar,
// and the page never scrolls sideways. Closing the keyboard (the stub
// back to full height) drops data-keyboard and the layout returns.
import { expect, test } from "@playwright/test";

test.use({ hasTouch: true });

// A visualViewport the page can shrink and regrow: the stub replaces
// window.visualViewport before any app script runs, and __setVVHeight
// moves it and fires the resize followKeyboard listens to.
async function stubVisualViewport(
  page: import("@playwright/test").Page,
  height: number,
): Promise<void> {
  await page.addInitScript((initial) => {
    const listeners = new Map<string, Set<EventListener>>();
    const viewport = {
      height: initial,
      offsetTop: 0,
      width: window.innerWidth,
      pageTop: 0,
      pageLeft: 0,
      scale: 1,
      addEventListener(type: string, listener: EventListener): void {
        const set = listeners.get(type) ?? new Set<EventListener>();
        set.add(listener);
        listeners.set(type, set);
      },
      removeEventListener(type: string, listener: EventListener): void {
        listeners.get(type)?.delete(listener);
      },
      dispatchEvent(): boolean {
        return false;
      },
    };
    const fire = (type: string): void => {
      for (const listener of listeners.get(type) ?? []) {
        listener(new Event(type));
      }
    };
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: viewport,
    });
    Object.defineProperty(window, "__setVVHeight", {
      configurable: true,
      value: (height: number) => {
        viewport.height = height;
        fire("resize");
        fire("scroll");
      },
    });
  }, height);
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await stubVisualViewport(page, 340);
  // A fine pointer hides the key bar by default; pin it visible through
  // the stored preference. The Keys switch that toggles it lives inside
  // .term-controls, which the open keyboard hides, so it cannot be used
  // here.
  await page.addInitScript(() => {
    localStorage.setItem("canopy.remote.term.keybar", "1");
  });
  await page.goto("/fake.html");
  await page.locator('[data-session="smoke"]').click();
  await expect
    .poll(() => page.evaluate(() => window.__fake.terminalText()))
    .toContain("hello from the host");
  await expect(page.locator("#term-pane .xterm-screen")).toBeVisible();
  await expect(page.locator("#keybar")).toBeVisible();
  await expect(page.locator("main.session-view")).toHaveAttribute("data-keyboard", "");
});

test("the session view stays above the open phone keyboard", async ({ page }) => {
  const boxes = await page.evaluate(() => {
    const rect = (sel: string): { top: number; bottom: number } => {
      const el = document.querySelector(sel);
      if (el === null) {
        throw new Error(`missing ${sel}`);
      }
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    };
    return {
      pane: rect("#term-pane"),
      keybar: rect("#keybar"),
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    };
  });
  // Both end inside the 340 px visual viewport, the pane on top of the
  // key bar, and the page does not scroll sideways.
  expect(boxes.pane.bottom).toBeLessThanOrEqual(340);
  expect(boxes.keybar.bottom).toBeLessThanOrEqual(340);
  expect(boxes.pane.bottom).toBeLessThanOrEqual(boxes.keybar.top);
  expect(boxes.scrollWidth).toBeLessThanOrEqual(boxes.clientWidth);
});

test("restoring the visual viewport height drops data-keyboard", async ({ page }) => {
  await expect(page.locator("main.session-view")).toHaveAttribute("data-keyboard", "");
  await page.evaluate(() => {
    (window as unknown as { __setVVHeight(height: number): void }).__setVVHeight(640);
  });
  await expect(page.locator("main.session-view")).not.toHaveAttribute("data-keyboard", "");
  const height = await page.evaluate(() => {
    const main = document.querySelector<HTMLElement>("main.session-view");
    return main?.style.getPropertyValue("--vv-height") ?? "";
  });
  expect(height).toBe("");
});
