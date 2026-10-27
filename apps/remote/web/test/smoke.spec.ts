// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";

// The WebGL renderer has no .xterm-rows text, so output is asserted through
// the fake host's recorded writes, never the DOM.
async function terminalText(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(() => window.__fake.terminalText());
}

test.beforeEach(async ({ page }) => {
  await page.goto("/fake.html");
  await expect(page.locator('[data-session="smoke"]')).toBeVisible();
  await page.locator('[data-session="smoke"]').click();
  await expect.poll(() => terminalText(page)).toContain("hello from the host");
});

test("renders the terminal and the key bar at 360x640", async ({ page }) => {
  expect(await terminalText(page)).toContain("$ muse run");
  const keys = page.locator("#keybar .key");
  await expect(keys).toHaveCount(10);
  await expect(page.locator(".topbar .login")).toHaveText("smoke");
  await expect(page.locator(".topbar .host")).toHaveText("smoke host");
  // Live output flows into the terminal.
  await page.evaluate(() => window.__fake.pushOut("live line\n"));
  await expect.poll(() => terminalText(page)).toContain("live line");
  // No horizontal page scroll outside the terminal pane.
  const overflow = await page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);
});

test("renders a legible 80-column session at 390x844", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // The terminal opens only after the real face is loaded (or the 1.5 s
  // fallback fired), so this is the face the cell size was measured with.
  await expect
    .poll(() => page.evaluate(() => document.fonts.check('14px "JetBrains Mono"')))
    .toBe(true);
  // ...and it is the self-hosted face, not a family the browser made up.
  const faces = await page.evaluate(() =>
    Array.from(document.fonts).map((face) => ({
      family: face.family.replace(/"/g, ""),
      status: face.status,
    })),
  );
  expect(faces).toContainEqual({ family: "JetBrains Mono", status: "loaded" });
  // Fit off (the default): the readable floor keeps a row at 11 CSS px.
  await expect
    .poll(() =>
      page.evaluate(() => {
        if (innerWidth !== 390) {
          return 0;
        }
        const fit = document.querySelector(".term-fit") as HTMLElement | null;
        const screen = document.querySelector(".xterm-screen") as HTMLElement | null;
        if (!fit || !screen) {
          return 0;
        }
        return (screen.offsetHeight / 24) * Number(fit.dataset.scale);
      }),
    )
    .toBeGreaterThanOrEqual(11);
  const measured = await page.evaluate(() => {
    const pane = document.querySelector(".term-pane") as HTMLElement;
    const fit = document.querySelector(".term-fit") as HTMLElement;
    const screen = document.querySelector(".xterm-screen") as HTMLElement;
    const doc = document.scrollingElement ?? document.documentElement;
    const style = getComputedStyle(pane);
    return {
      fontOk: document.fonts.check('14px "JetBrains Mono"'),
      fit: fit.dataset.fit,
      rowHeight: (screen.offsetHeight / 24) * Number(fit.dataset.scale),
      pageOverflow: doc.scrollWidth - doc.clientWidth,
      paneScroll: pane.scrollWidth - pane.clientWidth,
      panePadding: parseFloat(style.paddingLeft),
    };
  });
  expect(measured.fontOk).toBe(true);
  expect(measured.fit).toBe("off");
  expect(measured.rowHeight).toBeGreaterThanOrEqual(11);
  // The session pans inside its card; the page itself never scrolls sideways.
  expect(measured.paneScroll).toBeGreaterThan(0);
  expect(measured.pageOverflow).toBeLessThanOrEqual(1);
  const shot = await page.screenshot({ path: testInfo.outputPath("session-390x844.png") });
  await testInfo.attach("session-390x844", { body: shot, contentType: "image/png" });
});

test("keeps the terminal text off its border at 1280x900", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const padding = await page.evaluate(() => {
    const pane = document.querySelector(".term-pane") as HTMLElement;
    const style = getComputedStyle(pane);
    return {
      top: parseFloat(style.paddingTop),
      left: parseFloat(style.paddingLeft),
      right: parseFloat(style.paddingRight),
      bottom: parseFloat(style.paddingBottom),
    };
  });
  expect(Math.min(padding.top, padding.left, padding.right, padding.bottom)).toBeGreaterThanOrEqual(
    8,
  );
});

test("shows all ten keys inside the viewport at 360x640", async ({ page }) => {
  const keys = page.locator("#keybar .key");
  await expect(keys).toHaveCount(10);
  const boxes = await keys.evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    }),
  );
  // Two rows of five equal-width keys, every one a touch target in view.
  const rows = new Set(boxes.map((box) => Math.round(box.y)));
  expect(rows.size).toBe(2);
  for (const rowY of rows) {
    const row = boxes.filter((box) => Math.round(box.y) === rowY);
    expect(row).toHaveLength(5);
    for (const box of row) {
      expect(Math.abs(box.width - row[0]!.width)).toBeLessThanOrEqual(1);
    }
  }
  for (const box of boxes) {
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.right).toBeLessThanOrEqual(360);
    expect(box.bottom).toBeLessThanOrEqual(640);
  }
});

test("dresses the page in the Canopy surface", async ({ page }) => {
  await expect(page.locator("html")).toHaveAttribute("data-surface", "tui");
  const look = await page.evaluate(() => ({
    body: getComputedStyle(document.body).backgroundColor,
    view: document.body.dataset.view ?? null,
    fondo: (() => {
      const host = document.getElementById("fondo");
      return {
        mounted: host?.querySelector("canvas") !== null,
        opacity: host === null ? null : getComputedStyle(host).opacity,
      };
    })(),
  }));
  // #012624, the Liquid Abyss canvas of the Canopy page.
  expect(look.body).toBe("rgb(1, 38, 36)");
  expect(look.view).toBe("session");
  // The honeycomb is behind the session, dimmed so the terminal stays legible.
  expect(look.fondo.mounted).toBe(true);
  expect(look.fondo.opacity).toBe("0.15");
});

test("puts the Content textarea full width in its card", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".composer-builder").click();
  await expect(page.locator("#builder-form")).toBeVisible();
  const measured = await page.evaluate(() => {
    const card = document.querySelector(".builder-section") as HTMLElement;
    const area = document.querySelector(".section-content") as HTMLTextAreaElement;
    const style = getComputedStyle(card);
    const contentWidth =
      card.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    return { contentWidth, areaWidth: area.getBoundingClientRect().width };
  });
  expect(Math.abs(measured.areaWidth - measured.contentWidth)).toBeLessThanOrEqual(1);
  const shot = await page.screenshot({ path: testInfo.outputPath("builder-390x844.png") });
  await testInfo.attach("builder-390x844", { body: shot, contentType: "image/png" });
});

test("terminal pans when zoomed", async ({ page }) => {
  const fit = page.locator("#term-fit");
  await expect(fit).toHaveAttribute("aria-pressed", "false");
  // Fit on: pure fit-to-width, so only the zoom makes it overflow.
  await fit.click();
  await expect(fit).toHaveAttribute("aria-pressed", "true");
  await page.locator("#term-zoom-in").click();
  await page.locator("#term-zoom-in").click();
  const pan = await page.evaluate(() => {
    const pane = document.querySelector(".term-pane") as HTMLElement;
    return {
      overflow: getComputedStyle(pane).overflowX,
      larger: pane.scrollWidth > pane.clientWidth,
      fit: (document.querySelector(".term-fit") as HTMLElement).dataset.fit,
    };
  });
  // Zoomed content exceeds the pane, and the pane lets the user pan it.
  expect(pan.fit).toBe("on");
  expect(pan.larger).toBe(true);
  expect(["auto", "scroll"]).toContain(pan.overflow);
});

test("sends key bar bytes as input", async ({ page }) => {
  await page.evaluate(() => window.__fake.clearSent());
  await page.locator('#keybar .key[data-key="y"]').click();
  await page.locator('#keybar .key[data-key="up"]').click();
  const sent = await page.evaluate(() => window.__fake.sent());
  expect(sent).toContainEqual({ t: "input", id: "smoke", data: "eQ==" });
  expect(sent).toContainEqual({ t: "input", id: "smoke", data: "G1tB" });
});

test("composer sends a prompt and clears on ok", async ({ page }) => {
  await page.locator(".composer-input").fill("do the thing");
  await page.locator(".composer-send").click();
  const sent = await page.evaluate(() => window.__fake.sent());
  const prompt = (sent as { t: string }[]).find((frame) => frame.t === "prompt");
  expect(prompt).toMatchObject({ t: "prompt", id: "smoke", text: "do the thing" });
  await expect(page.locator(".composer-input")).toHaveValue("");
});

test("composer keeps the text and shows the error", async ({ page }) => {
  await page.evaluate(() => window.__fake.failNextPrompt("delivery_failed", "host is gone"));
  await page.locator(".composer-input").fill("do the thing");
  await page.locator(".composer-send").click();
  await expect(page.locator(".composer-error")).toHaveText("host is gone");
  await expect(page.locator(".composer-input")).toHaveValue("do the thing");
});
