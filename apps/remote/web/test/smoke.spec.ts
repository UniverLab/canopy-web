// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/fake.html");
  await expect(page.locator('[data-session="smoke"]')).toBeVisible();
  await page.locator('[data-session="smoke"]').click();
  await expect(page.locator(".xterm-rows")).toContainText("hello from the host");
});

test("renders the terminal and the key bar at 360x640", async ({ page }) => {
  await expect(page.locator(".xterm-rows")).toContainText("$ muse run");
  const keys = page.locator("#keybar .key");
  await expect(keys).toHaveCount(10);
  await expect(page.locator(".topbar .login")).toHaveText("smoke");
  await expect(page.locator(".topbar .host")).toHaveText("smoke host");
  // Live output flows into the terminal.
  await page.evaluate(() => window.__fake.pushOut("live line\n"));
  await expect(page.locator(".xterm-rows")).toContainText("live line");
  // No horizontal page scroll outside the terminal pane.
  const overflow = await page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);
});

test("fits the whole terminal to the pane at 390x844", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // The pane re-fits on resize: scale = pane width / terminal width. Wait
  // for that re-fit to settle — the fit left over from the 360 px start
  // also reports a scale > 0.5, so measuring straight away would race the
  // ResizeObserver (the visual box was still the old 326 px wide).
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const fit = document.querySelector(".term-fit") as HTMLElement;
        const scaler = document.querySelector(".term-scale") as HTMLElement;
        const rows = document.querySelector(".xterm-rows") as HTMLElement;
        if (innerWidth !== 390) {
          return Number.MAX_SAFE_INTEGER;
        }
        return Math.max(
          Math.abs(scaler.getBoundingClientRect().width - fit.clientWidth),
          Math.abs(rows.getBoundingClientRect().width - fit.clientWidth),
        );
      }),
    )
    .toBeLessThanOrEqual(2);
  const measured = await page.evaluate(() => {
    const pane = document.querySelector(".term-pane") as HTMLElement;
    const scaler = document.querySelector(".term-scale") as HTMLElement;
    const rows = document.querySelector(".xterm-rows") as HTMLElement;
    const fit = document.querySelector(".term-fit") as HTMLElement;
    return {
      pane: pane.getBoundingClientRect(),
      // The terminal's visual box: natural size × the fitted scale.
      visual: scaler.getBoundingClientRect(),
      // The text itself carries xterm's own font size (the .xterm box
      // inherits the page's), so this is the size the reader sees.
      text: rows.getBoundingClientRect(),
      fontPx: parseFloat(getComputedStyle(rows).fontSize),
      scale: Number(fit.dataset.scale),
      fitScroll: fit.scrollWidth,
      fitClient: fit.clientWidth,
    };
  });
  // The full 80-column terminal sits inside the pane and fills it,
  // scaled exactly once (no phantom horizontal scroll at the fit).
  expect(measured.visual.width).toBeLessThanOrEqual(measured.pane.width + 1);
  expect(measured.visual.right).toBeLessThanOrEqual(measured.pane.right + 1);
  expect(Math.abs(measured.visual.width - measured.fitClient)).toBeLessThanOrEqual(1);
  expect(measured.fitScroll - measured.fitClient).toBeLessThanOrEqual(1);
  // The text runs to the pane edge and no further: 80 columns inside 390 px.
  // Filling the pane (not merely sitting inside it) is what fails when the
  // terminal scales twice or not at all.
  expect(Math.abs(measured.text.width - measured.fitClient)).toBeLessThanOrEqual(2);
  expect(measured.text.width).toBeLessThanOrEqual(measured.pane.width + 1);
  expect(measured.text.right).toBeLessThanOrEqual(measured.pane.right + 1);
  // And the glyphs stay readable: at least 7 CSS px on a 390 px screen.
  expect(measured.fontPx).toBeGreaterThanOrEqual(10);
  expect(measured.fontPx * measured.scale).toBeGreaterThanOrEqual(7);
  const shot = await page.screenshot({ path: testInfo.outputPath("session-390x844.png") });
  await testInfo.attach("session-390x844", { body: shot, contentType: "image/png" });
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
  await page.locator("#term-zoom-in").click();
  await page.locator("#term-zoom-in").click();
  const pan = await page.evaluate(() => {
    const fit = document.querySelector(".term-fit") as HTMLElement;
    return {
      overflow: getComputedStyle(fit).overflowX,
      larger: fit.scrollWidth > fit.clientWidth,
    };
  });
  // Zoomed content exceeds the pane, and the pane lets the user pan it.
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
